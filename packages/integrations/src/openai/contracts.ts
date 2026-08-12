export const OPENAI_AUDIO_MODELS = Object.freeze({
  transcriptionDefault: 'gpt-4o-mini-transcribe' as const,
  transcriptionAccuracyRetry: 'gpt-4o-transcribe' as const,
  speechDefault: 'tts-1' as const,
});

export const OPENAI_AUDIO_ENDPOINTS = Object.freeze({
  transcription: '/v1/audio/transcriptions' as const,
  speech: '/v1/audio/speech' as const,
});

export const OPENAI_AUDIO_LIMITS = Object.freeze({
  maxTranscriptionBytes: 25 * 1024 * 1024,
  maxTranscriptionDurationMs: 60_000,
  maxTranscriptionResponseBytes: 1024 * 1024,
  maxTranscriptCharacters: 32_000,
  maxSpeechCharacters: 4_096,
  maxSpeechInstructionCharacters: 4_096,
  maxSpeechBytes: 25 * 1024 * 1024,
  defaultTimeoutMs: 60_000,
});

export const OPENAI_PRIVATE_NO_STORE_HEADERS = Object.freeze({
  'cache-control': 'no-store, private' as const,
  pragma: 'no-cache' as const,
  expires: '0' as const,
  'x-content-type-options': 'nosniff' as const,
});

export const OPENAI_TRANSCRIPTION_MODELS = Object.freeze([
  OPENAI_AUDIO_MODELS.transcriptionDefault,
  OPENAI_AUDIO_MODELS.transcriptionAccuracyRetry,
] as const);

/**
 * Models currently accepted by POST /v1/audio/speech.
 *
 * `gpt-4o-mini-tts` remains endpoint-compatible but is catalog-deprecated as
 * of the 2026-08-09 verification. It is therefore opt-in only and must pass a
 * credentialed deployment endpoint smoke test before being enabled. `tts-1`
 * is the conservative default. The nonexistent `gpt-4o-tts` ID is never
 * accepted.
 */
export const OPENAI_ENDPOINT_SPEECH_MODELS = Object.freeze([
  'tts-1',
  'tts-1-hd',
  'gpt-4o-mini-tts',
  'gpt-4o-mini-tts-2025-12-15',
] as const);

export type OpenAiTranscriptionModel =
  (typeof OPENAI_TRANSCRIPTION_MODELS)[number];
export type OpenAiSpeechModel = (typeof OPENAI_ENDPOINT_SPEECH_MODELS)[number];
export type OpenAiAudioModel = OpenAiTranscriptionModel | OpenAiSpeechModel;

export const OPENAI_SPEECH_VOICES = Object.freeze([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const);

export const OPENAI_SPEECH_FORMATS = Object.freeze([
  'mp3',
  'opus',
  'aac',
  'flac',
  'wav',
  'pcm',
] as const);

export type OpenAiSpeechVoice = (typeof OPENAI_SPEECH_VOICES)[number];
export type OpenAiSpeechFormat = (typeof OPENAI_SPEECH_FORMATS)[number];

export const OPENAI_TRANSCRIPTION_MIME_TYPES = Object.freeze([
  'audio/flac',
  'audio/mpeg',
  'audio/mp4',
  'video/mp4',
  'audio/x-m4a',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'video/webm',
] as const);

export type OpenAiTranscriptionMimeType =
  (typeof OPENAI_TRANSCRIPTION_MIME_TYPES)[number];

export const transcriptionFileExtension = (
  mimeType: OpenAiTranscriptionMimeType,
): string => {
  switch (mimeType) {
    case 'audio/flac':
      return 'flac';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/mp4':
    case 'video/mp4':
    case 'audio/x-m4a':
      return 'mp4';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/webm':
    case 'video/webm':
      return 'webm';
  }
};

export const speechContentType = (format: OpenAiSpeechFormat): string => {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg';
    case 'opus':
      return 'audio/ogg';
    case 'aac':
      return 'audio/aac';
    case 'flac':
      return 'audio/flac';
    case 'wav':
      return 'audio/wav';
    case 'pcm':
      return 'audio/pcm';
  }
};

export type OpenAiTokenUsage = Readonly<{
  type: 'tokens';
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  audioInputTokens?: number;
  textInputTokens?: number;
}>;

export type OpenAiDurationUsage = Readonly<{
  type: 'duration';
  seconds: number;
}>;

export type OpenAiAudioUsage = OpenAiTokenUsage | OpenAiDurationUsage;

export interface OpenAiTranscriptionTransportRequest {
  readonly model: OpenAiTranscriptionModel;
  readonly audio: Uint8Array;
  readonly mimeType: OpenAiTranscriptionMimeType;
  readonly fileName: string;
  readonly language?: string;
  readonly prompt?: string;
  readonly responseFormat: 'json';
  readonly signal: AbortSignal;
  /** Must be awaited exactly once immediately before the first network call. */
  readonly onDispatch: () => Promise<void>;
}

export interface OpenAiTranscriptionTransportResponse {
  readonly body: unknown;
  readonly providerRequestId?: string;
}

export interface OpenAiSpeechTransportRequest {
  readonly model: OpenAiSpeechModel;
  readonly input: string;
  readonly voice: OpenAiSpeechVoice;
  readonly instructions?: string;
  readonly responseFormat: OpenAiSpeechFormat;
  readonly speed?: number;
  readonly signal: AbortSignal;
  /** Must be awaited exactly once immediately before the first network call. */
  readonly onDispatch: () => Promise<void>;
}

export interface OpenAiSpeechTransportResponse {
  /**
   * Ownership transfers to the adapter. The adapter must copy and zero these
   * bytes on normal resolution, and zero them if resolution arrives late.
   */
  readonly audio: Uint8Array;
  readonly contentType: string;
  readonly providerRequestId?: string;
}

export type OpenAiModelUnavailableReason =
  'not-found' | 'access-denied' | 'rate-limited' | 'provider-unavailable';

export type OpenAiModelAvailabilityTransportResult =
  | Readonly<{ status: 'available'; resolvedModel: string }>
  | Readonly<{
      status: 'unavailable';
      reason: OpenAiModelUnavailableReason;
    }>;

export interface OpenAiAudioTransport {
  transcribe(
    request: OpenAiTranscriptionTransportRequest,
  ): Promise<OpenAiTranscriptionTransportResponse>;
  createSpeech(
    request: OpenAiSpeechTransportRequest,
  ): Promise<OpenAiSpeechTransportResponse>;
  /** Catalog/access lookup only. Endpoint compatibility requires live smoke. */
  checkModel(
    model: string,
    signal: AbortSignal,
  ): Promise<OpenAiModelAvailabilityTransportResult>;
}

export interface OpenAiAudioSpendGuard {
  reserve(input: {
    readonly executionId: string;
    readonly reservationId: string;
    readonly estimatedCadMinor: number;
  }): Promise<unknown>;
  markDispatched(input: {
    readonly executionId: string;
    readonly reservationId: string;
  }): Promise<unknown>;
  settle(input: {
    readonly executionId: string;
    readonly reservationId: string;
    readonly actualCadMinor: number;
  }): Promise<unknown>;
  release(input: {
    readonly executionId: string;
    readonly reservationId: string;
  }): Promise<unknown>;
}

export type OpenAiAudioCostEstimateInput =
  | Readonly<{
      operation: 'transcription';
      model: OpenAiTranscriptionModel;
      durationMs: number;
      inputBytes: number;
    }>
  | Readonly<{
      operation: 'speech';
      model: OpenAiSpeechModel;
      inputCharacters: number;
      responseFormat: OpenAiSpeechFormat;
    }>;

export type OpenAiAudioActualCostInput =
  | Readonly<{
      operation: 'transcription';
      model: OpenAiTranscriptionModel;
      durationMs: number;
      inputBytes: number;
      usage: OpenAiAudioUsage;
    }>
  | Readonly<{
      operation: 'speech';
      model: OpenAiSpeechModel;
      inputCharacters: number;
      outputBytes: number;
      responseFormat: OpenAiSpeechFormat;
    }>;

/**
 * Pricing is injected because model prices and CAD FX are deployment data.
 * Implementations must use deterministic integer minor units and an explicit
 * conservative rounding/accumulation policy; they must never round sub-cent
 * spend down silently.
 */
export interface OpenAiAudioCostCalculator {
  readonly version: string;
  estimateCadMinor(
    input: OpenAiAudioCostEstimateInput,
  ): number | Promise<number>;
  actualCadMinor(input: OpenAiAudioActualCostInput): number | Promise<number>;
}

export interface OpenAiAudioSpendContext {
  readonly executionId: string;
  readonly reservationId: string;
}

export type OpenAiAudioSafeErrorCode =
  | 'audio-request-invalid'
  | 'monthly-ai-spend-limit-reached'
  | 'audio-spend-accounting-failed'
  | 'audio-provider-unavailable'
  | 'audio-provider-rejected'
  | 'audio-provider-timeout'
  | 'audio-request-cancelled'
  | 'audio-provider-response-invalid';

export interface OpenAiAudioSafeError {
  readonly code: OpenAiAudioSafeErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface OpenAiAudioResponseMetadata {
  readonly headers: Readonly<Record<string, string>>;
}

export type OpenAiAudioSmokeOperation =
  'transcription' | 'transcription-accuracy-retry' | 'speech';

export interface OpenAiAudioSmokeContract {
  readonly schemaVersion: 1;
  readonly liveProviderRequired: true;
  readonly fixturePolicy: 'synthetic-nonsensitive-memory-only';
  readonly persist: readonly [
    'model',
    'operation',
    'checkedAt',
    'status',
    'latencyMs',
  ];
  readonly checks: readonly Readonly<{
    operation: OpenAiAudioSmokeOperation;
    endpoint:
      | typeof OPENAI_AUDIO_ENDPOINTS.transcription
      | typeof OPENAI_AUDIO_ENDPOINTS.speech;
    model: OpenAiAudioModel;
  }>[];
}

export const createOpenAiAudioSmokeContract = (
  speechModel: OpenAiSpeechModel = OPENAI_AUDIO_MODELS.speechDefault,
): OpenAiAudioSmokeContract =>
  Object.freeze({
    schemaVersion: 1 as const,
    liveProviderRequired: true as const,
    fixturePolicy: 'synthetic-nonsensitive-memory-only' as const,
    persist: Object.freeze([
      'model',
      'operation',
      'checkedAt',
      'status',
      'latencyMs',
    ] as const),
    checks: Object.freeze([
      Object.freeze({
        operation: 'transcription' as const,
        endpoint: OPENAI_AUDIO_ENDPOINTS.transcription,
        model: OPENAI_AUDIO_MODELS.transcriptionDefault,
      }),
      Object.freeze({
        operation: 'transcription-accuracy-retry' as const,
        endpoint: OPENAI_AUDIO_ENDPOINTS.transcription,
        model: OPENAI_AUDIO_MODELS.transcriptionAccuracyRetry,
      }),
      Object.freeze({
        operation: 'speech' as const,
        endpoint: OPENAI_AUDIO_ENDPOINTS.speech,
        model: speechModel,
      }),
    ]),
  });

export const OPENAI_AUDIO_SMOKE_CONTRACT = createOpenAiAudioSmokeContract();
