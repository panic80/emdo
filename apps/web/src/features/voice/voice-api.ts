export type TranscriptionAttempt = 'default' | 'accuracy-retry';

export type TranscriptionModel = 'gpt-4o-mini-transcribe' | 'gpt-4o-transcribe';

export type SpeechVoice =
  | 'alloy'
  | 'ash'
  | 'ballad'
  | 'coral'
  | 'echo'
  | 'fable'
  | 'nova'
  | 'onyx'
  | 'sage'
  | 'shimmer';

interface VoiceApiDependencies {
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
}

interface VoiceRequestAuthority {
  readonly csrfToken: string;
  readonly idempotencyKey: string;
}

export interface TranscriptionResult {
  readonly schemaVersion: 1;
  readonly transcript: string;
  readonly model: TranscriptionModel;
  readonly attempt: TranscriptionAttempt;
  readonly spendWarning: boolean;
  readonly replayed: boolean;
}

export class VoiceApiError extends Error {
  public constructor(
    public readonly code:
      'invalid-request' | 'request-failed' | 'unsafe-response',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'VoiceApiError';
  }
}

const AUDIO_REQUEST_CONTENT_TYPES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/x-wav',
]);

const AUDIO_RESPONSE_CONTENT_TYPES = new Set([
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
]);

const TRANSCRIPTION_RESPONSE_KEYS = new Set([
  'schemaVersion',
  'transcript',
  'model',
  'attempt',
  'spendWarning',
  'replayed',
]);

function hasDirective(value: string | null, directive: string): boolean {
  return Boolean(
    value
      ?.toLowerCase()
      .split(',')
      .map((item) => item.trim())
      .includes(directive),
  );
}

function hasSafeEphemeralHeaders(response: Response): boolean {
  return (
    hasDirective(response.headers.get('cache-control'), 'no-store') &&
    hasDirective(response.headers.get('cache-control'), 'private') &&
    response.headers.get('pragma')?.toLowerCase() === 'no-cache' &&
    response.headers.get('expires') === '0' &&
    response.headers.get('x-content-type-options')?.toLowerCase() ===
      'nosniff' &&
    !response.headers.has('etag')
  );
}

function baseContentType(value: string): string {
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

function isTranscriptionResult(
  value: unknown,
  requestedAttempt: TranscriptionAttempt,
): value is TranscriptionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== TRANSCRIPTION_RESPONSE_KEYS.size ||
    keys.some((key) => !TRANSCRIPTION_RESPONSE_KEYS.has(key))
  ) {
    return false;
  }

  const expectedModel =
    requestedAttempt === 'accuracy-retry'
      ? 'gpt-4o-transcribe'
      : 'gpt-4o-mini-transcribe';
  return (
    record.schemaVersion === 1 &&
    typeof record.transcript === 'string' &&
    record.transcript.length <= 50_000 &&
    record.model === expectedModel &&
    record.attempt === requestedAttempt &&
    typeof record.spendWarning === 'boolean' &&
    typeof record.replayed === 'boolean'
  );
}

function assertRequestAuthority(request: VoiceRequestAuthority): void {
  if (!request.csrfToken.trim() || !request.idempotencyKey.trim()) {
    throw new VoiceApiError(
      'invalid-request',
      'The authenticated request context is unavailable.',
    );
  }
}

export async function transcribeVoice(
  request: VoiceRequestAuthority & {
    readonly audio: Blob;
    readonly durationMs: number;
    readonly attempt: TranscriptionAttempt;
  },
  dependencies: VoiceApiDependencies = {},
): Promise<TranscriptionResult> {
  assertRequestAuthority(request);
  const contentType = request.audio.type.trim().toLowerCase();
  if (
    request.audio.size === 0 ||
    !AUDIO_REQUEST_CONTENT_TYPES.has(baseContentType(contentType)) ||
    !Number.isInteger(request.durationMs) ||
    request.durationMs < 1 ||
    request.durationMs > 60_000
  ) {
    throw new VoiceApiError(
      'invalid-request',
      'Record between one and sixty seconds in a supported audio format.',
    );
  }

  const query = new URLSearchParams({
    durationMs: String(request.durationMs),
    attempt: request.attempt,
  });
  const response = await (dependencies.fetcher ?? fetch)(
    `/api/v1/voice/transcribe?${query.toString()}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: dependencies.signal,
      headers: {
        accept: 'application/json',
        'content-type': contentType,
        'idempotency-key': request.idempotencyKey,
        'x-csrf-token': request.csrfToken,
      },
      body: request.audio,
    },
  );
  if (!response.ok) {
    throw new VoiceApiError(
      'request-failed',
      'EMDO could not transcribe that recording. Try again or type your request.',
      response.status,
    );
  }
  if (
    !response.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json') ||
    !hasSafeEphemeralHeaders(response)
  ) {
    throw new VoiceApiError(
      'unsafe-response',
      'EMDO rejected an unsafe transcription response.',
    );
  }

  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    throw new VoiceApiError(
      'unsafe-response',
      'EMDO returned an invalid transcription.',
    );
  }
  if (!isTranscriptionResult(payload, request.attempt)) {
    throw new VoiceApiError(
      'unsafe-response',
      'EMDO returned an invalid transcription.',
    );
  }
  return payload;
}

export async function speakSummary(
  request: VoiceRequestAuthority & {
    readonly text: string;
    readonly voice?: SpeechVoice;
  },
  dependencies: VoiceApiDependencies = {},
): Promise<Response> {
  assertRequestAuthority(request);
  const text = request.text.trim();
  if (!text || text.length > 4_096) {
    throw new VoiceApiError(
      'invalid-request',
      'There is no valid summary to speak.',
    );
  }

  const response = await (dependencies.fetcher ?? fetch)(
    '/api/v1/voice/speak',
    {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: dependencies.signal,
      headers: {
        accept: 'audio/*',
        'content-type': 'application/json',
        'idempotency-key': request.idempotencyKey,
        'x-csrf-token': request.csrfToken,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        voice: request.voice ?? 'alloy',
        text,
      }),
    },
  );
  const contentType = baseContentType(
    response.headers.get('content-type') ?? '',
  );
  if (!response.ok || !AUDIO_RESPONSE_CONTENT_TYPES.has(contentType)) {
    throw new VoiceApiError(
      'request-failed',
      'EMDO could not create the spoken summary. The full text is still available.',
      response.status,
    );
  }
  if (!hasSafeEphemeralHeaders(response)) {
    throw new VoiceApiError(
      'unsafe-response',
      'EMDO rejected an unsafe speech response.',
    );
  }
  return response;
}
