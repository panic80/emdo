import { z } from 'zod';

import {
  OPENAI_AUDIO_LIMITS,
  OPENAI_AUDIO_MODELS,
  OPENAI_ENDPOINT_SPEECH_MODELS,
  OPENAI_PRIVATE_NO_STORE_HEADERS,
  OPENAI_SPEECH_FORMATS,
  OPENAI_SPEECH_VOICES,
  OPENAI_TRANSCRIPTION_MIME_TYPES,
  createOpenAiAudioSmokeContract,
  speechContentType,
  transcriptionFileExtension,
  type OpenAiAudioActualCostInput,
  type OpenAiAudioCostCalculator,
  type OpenAiAudioResponseMetadata,
  type OpenAiAudioSafeError,
  type OpenAiAudioSpendContext,
  type OpenAiAudioSpendGuard,
  type OpenAiAudioTransport,
  type OpenAiAudioUsage,
  type OpenAiModelAvailabilityTransportResult,
  type OpenAiModelUnavailableReason,
  type OpenAiSpeechFormat,
  type OpenAiSpeechModel,
  type OpenAiSpeechVoice,
  type OpenAiTranscriptionMimeType,
  type OpenAiTranscriptionModel,
} from './contracts.js';
import {
  bindDataMethod,
  isAbortSignal,
  isBoundedAcyclicPlainData,
  isPositiveCadMinor,
  isSafeIdentifier,
  isSafeProviderRequestId,
  readDataProperty,
  snapshotPlainRecord,
} from './safety.js';
import {
  createLateReservationReleaseCallback,
  createReserveSpendOperation,
} from './spend-lifecycle.js';
import { OpenAiAudioTransportError } from './transport-error.js';

const ProviderTokenUsageSchema = z
  .strictObject({
    type: z.literal('tokens'),
    input_tokens: z.number().int().safe().nonnegative(),
    output_tokens: z.number().int().safe().nonnegative(),
    total_tokens: z.number().int().safe().nonnegative(),
    input_token_details: z
      .strictObject({
        audio_tokens: z.number().int().safe().nonnegative().optional(),
        text_tokens: z.number().int().safe().nonnegative().optional(),
      })
      .optional(),
  })
  .superRefine((usage, context) => {
    if (usage.total_tokens !== usage.input_tokens + usage.output_tokens) {
      context.addIssue({
        code: 'custom',
        path: ['total_tokens'],
        message: 'Total token usage is inconsistent',
      });
    }
  });

const ProviderTranscriptionSchema = z.strictObject({
  text: z.string().max(OPENAI_AUDIO_LIMITS.maxTranscriptCharacters),
  usage: ProviderTokenUsageSchema,
});

const safeErrors = Object.freeze({
  invalid: Object.freeze({
    code: 'audio-request-invalid' as const,
    message: 'The audio request is invalid.',
    retryable: false,
  }),
  spendBlocked: Object.freeze({
    code: 'monthly-ai-spend-limit-reached' as const,
    message: 'The monthly AI spend limit has been reached.',
    retryable: false,
  }),
  accounting: Object.freeze({
    code: 'audio-spend-accounting-failed' as const,
    message: 'Audio usage could not be safely accounted for.',
    retryable: false,
  }),
  unavailable: Object.freeze({
    code: 'audio-provider-unavailable' as const,
    message: 'Audio service is temporarily unavailable.',
    retryable: true,
  }),
  rejected: Object.freeze({
    code: 'audio-provider-rejected' as const,
    message: 'The audio service rejected this request.',
    retryable: false,
  }),
  timeout: Object.freeze({
    code: 'audio-provider-timeout' as const,
    message: 'The audio service timed out.',
    retryable: true,
  }),
  cancelled: Object.freeze({
    code: 'audio-request-cancelled' as const,
    message: 'The audio request was cancelled.',
    retryable: true,
  }),
  invalidResponse: Object.freeze({
    code: 'audio-provider-response-invalid' as const,
    message: 'The audio service returned an invalid response.',
    retryable: true,
  }),
});

type TranscriptionAttempt = 'initial' | 'accuracy-retry';

interface ParsedTranscriptionInput {
  readonly audio: Uint8Array;
  readonly mimeType: OpenAiTranscriptionMimeType;
  readonly durationMs: number;
  readonly language?: string;
  readonly prompt?: string;
  readonly attempt: TranscriptionAttempt;
  readonly spend: OpenAiAudioSpendContext;
}

interface ParsedSpeechInput {
  readonly text: string;
  readonly voice: OpenAiSpeechVoice;
  readonly instructions?: string;
  readonly format: OpenAiSpeechFormat;
  readonly speed?: number;
  readonly spend: OpenAiAudioSpendContext;
}

export interface OpenAiTranscriptionInput {
  readonly audio: Uint8Array;
  readonly mimeType: OpenAiTranscriptionMimeType;
  readonly durationMs: number;
  readonly language?: string;
  readonly prompt?: string;
  readonly attempt?: TranscriptionAttempt;
  readonly spend: OpenAiAudioSpendContext;
}

export interface OpenAiSpeechInput {
  readonly text: string;
  readonly voice?: OpenAiSpeechVoice;
  readonly instructions?: string;
  readonly format?: OpenAiSpeechFormat;
  readonly speed?: number;
  readonly spend: OpenAiAudioSpendContext;
}

interface OpenAiAudioSpendSummary {
  readonly pricingVersion: string;
  readonly estimatedCadMinor: number;
  readonly actualCadMinor?: number;
}

export type OpenAiTranscriptionResult =
  | Readonly<{
      status: 'completed';
      model: OpenAiTranscriptionModel;
      attempt: TranscriptionAttempt;
      text: string;
      usage: OpenAiAudioUsage;
      providerRequestId?: string;
      spend: OpenAiAudioSpendSummary;
      response: OpenAiAudioResponseMetadata;
    }>
  | Readonly<{
      status: 'failed';
      model?: OpenAiTranscriptionModel;
      attempt?: TranscriptionAttempt;
      safeError: OpenAiAudioSafeError;
      reconciliationRequired: boolean;
      response: OpenAiAudioResponseMetadata;
    }>;

const ephemeralAudioConstructorToken = Symbol('ephemeral-speech-audio');

/**
 * A one-owner response body. It is deliberately non-serializable: callers
 * must take the bytes exactly once for the HTTP response, or dispose them.
 */
export class EphemeralSpeechAudio {
  #audio: Uint8Array | undefined;

  constructor(token: symbol, audio: Uint8Array) {
    if (token !== ephemeralAudioConstructorToken) {
      throw new Error('Ephemeral speech audio construction is private');
    }
    this.#audio = audio;
  }

  get byteLength(): number {
    return this.#audio?.byteLength ?? 0;
  }

  take(): Uint8Array {
    const audio = this.#audio;
    if (audio === undefined) {
      throw new Error('Speech audio was already taken');
    }
    this.#audio = undefined;
    return audio;
  }

  dispose(): void {
    this.#audio?.fill(0);
    this.#audio = undefined;
  }
}

export type OpenAiSpeechResult =
  | Readonly<{
      status: 'completed';
      model: OpenAiSpeechModel;
      voice: OpenAiSpeechVoice;
      format: OpenAiSpeechFormat;
      audio: EphemeralSpeechAudio;
      providerRequestId?: string;
      spend: OpenAiAudioSpendSummary;
      response: OpenAiAudioResponseMetadata;
    }>
  | Readonly<{
      status: 'failed';
      model?: OpenAiSpeechModel;
      safeError: OpenAiAudioSafeError;
      reconciliationRequired: boolean;
      response: OpenAiAudioResponseMetadata;
    }>;

export interface OpenAiAudioModelAvailabilityResult {
  readonly schemaVersion: 1;
  /** GET /models access only; never claim this proves endpoint behavior. */
  readonly scope: 'catalog-access-only';
  readonly status: 'ready' | 'unavailable';
  readonly checkedAt: string;
  readonly models: readonly Readonly<
    | {
        purpose:
          | 'transcription-default'
          | 'transcription-accuracy-retry'
          | 'speech-default';
        model: string;
        status: 'available';
      }
    | {
        purpose:
          | 'transcription-default'
          | 'transcription-accuracy-retry'
          | 'speech-default';
        model: string;
        status: 'unavailable';
        reason: OpenAiModelUnavailableReason | 'invalid-response';
      }
  >[];
}

class SpendBoundaryError extends Error {
  constructor() {
    super('audio-spend-boundary-failed');
  }
}

const readStatus = (input: unknown): string | undefined => {
  try {
    if (input === null || typeof input !== 'object') return undefined;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const descriptor of Object.values(descriptors)) {
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        return undefined;
      }
    }
    const status = descriptors.status?.value as unknown;
    return typeof status === 'string' ? status : undefined;
  } catch {
    return undefined;
  }
};

const parseSpendContext = (
  input: unknown,
): OpenAiAudioSpendContext | undefined => {
  const snapshot = snapshotPlainRecord(input, ['executionId', 'reservationId']);
  if (
    snapshot === undefined ||
    !isSafeIdentifier(snapshot.executionId) ||
    !isSafeIdentifier(snapshot.reservationId)
  ) {
    return undefined;
  }
  return Object.freeze({
    executionId: snapshot.executionId,
    reservationId: snapshot.reservationId,
  });
};

const isNormalOwnedUint8Array = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array &&
  Object.getPrototypeOf(value) === Uint8Array.prototype &&
  value.buffer instanceof ArrayBuffer;

const parseTranscriptionInput = (
  input: unknown,
): ParsedTranscriptionInput | undefined => {
  const snapshot = snapshotPlainRecord(
    input,
    [
      'audio',
      'mimeType',
      'durationMs',
      'language',
      'prompt',
      'attempt',
      'spend',
    ],
    ['audio', 'mimeType', 'durationMs', 'spend'],
  );
  if (snapshot === undefined) return undefined;
  if (
    !isNormalOwnedUint8Array(snapshot.audio) ||
    snapshot.audio.byteLength < 1 ||
    snapshot.audio.byteLength > OPENAI_AUDIO_LIMITS.maxTranscriptionBytes ||
    typeof snapshot.durationMs !== 'number' ||
    !Number.isSafeInteger(snapshot.durationMs) ||
    snapshot.durationMs < 1 ||
    snapshot.durationMs > OPENAI_AUDIO_LIMITS.maxTranscriptionDurationMs ||
    typeof snapshot.mimeType !== 'string' ||
    !(OPENAI_TRANSCRIPTION_MIME_TYPES as readonly string[]).includes(
      snapshot.mimeType,
    )
  ) {
    return undefined;
  }
  if (
    snapshot.language !== undefined &&
    (typeof snapshot.language !== 'string' ||
      !/^[a-z]{2}$/.test(snapshot.language))
  ) {
    return undefined;
  }
  if (
    snapshot.prompt !== undefined &&
    (typeof snapshot.prompt !== 'string' ||
      snapshot.prompt.length > 1_000 ||
      snapshot.prompt.includes('\u0000'))
  ) {
    return undefined;
  }
  const attempt = snapshot.attempt ?? 'initial';
  if (attempt !== 'initial' && attempt !== 'accuracy-retry') return undefined;
  const spend = parseSpendContext(snapshot.spend);
  if (spend === undefined) return undefined;
  return {
    audio: snapshot.audio,
    mimeType: snapshot.mimeType as OpenAiTranscriptionMimeType,
    durationMs: snapshot.durationMs,
    ...(snapshot.language === undefined
      ? {}
      : { language: snapshot.language as string }),
    ...(snapshot.prompt === undefined
      ? {}
      : { prompt: snapshot.prompt as string }),
    attempt,
    spend,
  };
};

const parseSpeechInput = (input: unknown): ParsedSpeechInput | undefined => {
  const snapshot = snapshotPlainRecord(
    input,
    ['text', 'voice', 'instructions', 'format', 'speed', 'spend'],
    ['text', 'spend'],
  );
  if (
    snapshot === undefined ||
    typeof snapshot.text !== 'string' ||
    snapshot.text.trim().length < 1 ||
    snapshot.text.length > OPENAI_AUDIO_LIMITS.maxSpeechCharacters ||
    snapshot.text.includes('\u0000')
  ) {
    return undefined;
  }
  const voice = snapshot.voice ?? 'alloy';
  const format = snapshot.format ?? 'mp3';
  if (
    typeof voice !== 'string' ||
    !(OPENAI_SPEECH_VOICES as readonly string[]).includes(voice) ||
    typeof format !== 'string' ||
    !(OPENAI_SPEECH_FORMATS as readonly string[]).includes(format)
  ) {
    return undefined;
  }
  if (
    snapshot.instructions !== undefined &&
    (typeof snapshot.instructions !== 'string' ||
      snapshot.instructions.length >
        OPENAI_AUDIO_LIMITS.maxSpeechInstructionCharacters ||
      snapshot.instructions.includes('\u0000'))
  ) {
    return undefined;
  }
  if (
    snapshot.speed !== undefined &&
    (typeof snapshot.speed !== 'number' ||
      !Number.isFinite(snapshot.speed) ||
      snapshot.speed < 0.25 ||
      snapshot.speed > 4)
  ) {
    return undefined;
  }
  const spend = parseSpendContext(snapshot.spend);
  if (spend === undefined) return undefined;
  return {
    text: snapshot.text.trim(),
    voice: voice as OpenAiSpeechVoice,
    format: format as OpenAiSpeechFormat,
    ...(snapshot.instructions === undefined
      ? {}
      : { instructions: snapshot.instructions as string }),
    ...(snapshot.speed === undefined
      ? {}
      : { speed: snapshot.speed as number }),
    spend,
  };
};

const normalizeUsage = (
  value: z.infer<typeof ProviderTokenUsageSchema>,
): OpenAiAudioUsage => {
  return Object.freeze({
    type: 'tokens' as const,
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    totalTokens: value.total_tokens,
    ...(value.input_token_details?.audio_tokens === undefined
      ? {}
      : { audioInputTokens: value.input_token_details.audio_tokens }),
    ...(value.input_token_details?.text_tokens === undefined
      ? {}
      : { textInputTokens: value.input_token_details.text_tokens }),
  });
};

const responseMetadata = (contentType: string): OpenAiAudioResponseMetadata =>
  Object.freeze({
    headers: Object.freeze({
      ...OPENAI_PRIVATE_NO_STORE_HEADERS,
      'content-type': contentType,
    }),
  });

const transcriptionResponseMetadata = responseMetadata(
  'application/json; charset=utf-8',
);

const mapThrownError = (error: unknown): OpenAiAudioSafeError => {
  if (error instanceof SpendBoundaryError) return safeErrors.accounting;
  if (error instanceof OpenAiAudioTransportError) {
    switch (error.kind) {
      case 'request-aborted':
        return safeErrors.cancelled;
      case 'timeout':
        return safeErrors.timeout;
      case 'provider-rejected':
      case 'invalid-request':
        return safeErrors.rejected;
      case 'response-invalid':
      case 'response-too-large':
        return safeErrors.invalidResponse;
      case 'credential-unavailable':
      case 'network':
      case 'provider-unavailable':
        return safeErrors.unavailable;
    }
  }
  return safeErrors.unavailable;
};

const safeProviderRequestId = (value: unknown): string | undefined =>
  isSafeProviderRequestId(value) ? value : undefined;

const matchesSpeechContentType = (
  format: OpenAiSpeechFormat,
  rawContentType: string,
): boolean => {
  const normalized = rawContentType.split(';', 1)[0]?.trim().toLowerCase();
  const expected = speechContentType(format);
  if (normalized === expected) return true;
  if (format === 'mp3' && normalized === 'audio/mp3') return true;
  if (format === 'opus' && normalized === 'audio/opus') return true;
  if (format === 'wav' && normalized === 'audio/x-wav') return true;
  if (format === 'pcm' && normalized === 'application/octet-stream') {
    return true;
  }
  return false;
};

const createAbortScope = (
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
) => {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort();
  if (externalSignal?.aborted === true) controller.abort();
  else externalSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    isTimedOut: () => timedOut,
    close: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', forwardAbort);
    },
  };
};

type AbortScope = ReturnType<typeof createAbortScope>;

const awaitWithinAbortScope = async <Value>(
  scope: AbortScope,
  operation: () => Promise<Value>,
  onLateResolve?: (value: Value) => void,
): Promise<Value> => {
  if (scope.signal.aborted) throw abortedError(scope.isTimedOut());
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      scope.signal.removeEventListener('abort', rejectAborted);
      callback();
    };
    const rejectAborted = () =>
      finish(() => reject(abortedError(scope.isTimedOut())));
    scope.signal.addEventListener('abort', rejectAborted, { once: true });
    if (scope.signal.aborted) {
      rejectAborted();
      return;
    }
    Promise.resolve()
      .then(() => {
        if (scope.signal.aborted) {
          throw abortedError(scope.isTimedOut());
        }
        return operation();
      })
      .then(
        (value) => {
          if (settled) {
            try {
              onLateResolve?.(value);
            } catch {
              // Late provider values are disposal-only and never re-enter flow.
            }
            return;
          }
          finish(() => resolve(value));
        },
        (error: unknown) => finish(() => reject(error)),
      );
  });
};

const disposeLateSpeechResponse = (input: unknown): void => {
  try {
    if (input === null || typeof input !== 'object') return;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return;
    const descriptor = Object.getOwnPropertyDescriptor(input, 'audio');
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return;
    }
    const audio = descriptor.value as unknown;
    if (isNormalOwnedUint8Array(audio)) audio.fill(0);
  } catch {
    // Disposal is best effort and must never expose or revive late data.
  }
};

const abortedError = (timedOut: boolean): OpenAiAudioTransportError =>
  new OpenAiAudioTransportError({
    kind: timedOut ? 'timeout' : 'request-aborted',
    retryable: true,
  });

const scopedSafeError = (
  scope: AbortScope,
  fallback: OpenAiAudioSafeError,
): OpenAiAudioSafeError =>
  scope.isTimedOut()
    ? safeErrors.timeout
    : scope.signal.aborted
      ? safeErrors.cancelled
      : fallback;

export class OpenAiAudioAdapter {
  readonly #transportTranscribe: OpenAiAudioTransport['transcribe'];
  readonly #transportCreateSpeech: OpenAiAudioTransport['createSpeech'];
  readonly #transportCheckModel: OpenAiAudioTransport['checkModel'];
  readonly #reserveSpend: OpenAiAudioSpendGuard['reserve'];
  readonly #markSpendDispatched: OpenAiAudioSpendGuard['markDispatched'];
  readonly #settleSpend: OpenAiAudioSpendGuard['settle'];
  readonly #releaseSpend: OpenAiAudioSpendGuard['release'];
  readonly #estimateCost: OpenAiAudioCostCalculator['estimateCadMinor'];
  readonly #actualCost: OpenAiAudioCostCalculator['actualCadMinor'];
  readonly #pricingVersion: string;
  readonly #speechModel: OpenAiSpeechModel;
  readonly #clock: () => Date;
  readonly #timeoutMs: number;

  constructor(input: {
    readonly transport: OpenAiAudioTransport;
    readonly spendGuard: OpenAiAudioSpendGuard;
    readonly costCalculator: OpenAiAudioCostCalculator;
    readonly speechModel?: OpenAiSpeechModel;
    readonly clock?: () => Date;
    readonly timeoutMs?: number;
  }) {
    const options = snapshotPlainRecord(
      input,
      [
        'transport',
        'spendGuard',
        'costCalculator',
        'speechModel',
        'clock',
        'timeoutMs',
      ],
      ['transport', 'spendGuard', 'costCalculator'],
    );
    if (
      options === undefined ||
      options.transport === null ||
      typeof options.transport !== 'object' ||
      options.spendGuard === null ||
      typeof options.spendGuard !== 'object' ||
      options.costCalculator === null ||
      typeof options.costCalculator !== 'object'
    ) {
      throw new Error('invalid-openai-audio-dependency');
    }
    const speechModel =
      options.speechModel ?? OPENAI_AUDIO_MODELS.speechDefault;
    if (
      typeof speechModel !== 'string' ||
      !(OPENAI_ENDPOINT_SPEECH_MODELS as readonly string[]).includes(
        speechModel,
      )
    ) {
      throw new Error('invalid-openai-speech-model');
    }
    const pricingVersion = readDataProperty(options.costCalculator, 'version');
    if (
      typeof pricingVersion !== 'string' ||
      pricingVersion.length < 1 ||
      pricingVersion.length > 100 ||
      !/^[A-Za-z0-9._-]+$/.test(pricingVersion)
    ) {
      throw new Error('invalid-openai-audio-cost-version');
    }
    const timeoutMs = options.timeoutMs ?? OPENAI_AUDIO_LIMITS.defaultTimeoutMs;
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120_000
    ) {
      throw new Error('invalid-openai-audio-timeout');
    }
    if (options.clock !== undefined && typeof options.clock !== 'function') {
      throw new Error('invalid-openai-audio-dependency');
    }
    this.#transportTranscribe = bindDataMethod<
      OpenAiAudioTransport['transcribe']
    >(options.transport, 'transcribe');
    this.#transportCreateSpeech = bindDataMethod<
      OpenAiAudioTransport['createSpeech']
    >(options.transport, 'createSpeech');
    this.#transportCheckModel = bindDataMethod<
      OpenAiAudioTransport['checkModel']
    >(options.transport, 'checkModel');
    this.#reserveSpend = bindDataMethod<OpenAiAudioSpendGuard['reserve']>(
      options.spendGuard,
      'reserve',
    );
    this.#markSpendDispatched = bindDataMethod<
      OpenAiAudioSpendGuard['markDispatched']
    >(options.spendGuard, 'markDispatched');
    this.#settleSpend = bindDataMethod<OpenAiAudioSpendGuard['settle']>(
      options.spendGuard,
      'settle',
    );
    this.#releaseSpend = bindDataMethod<OpenAiAudioSpendGuard['release']>(
      options.spendGuard,
      'release',
    );
    this.#estimateCost = bindDataMethod<
      OpenAiAudioCostCalculator['estimateCadMinor']
    >(options.costCalculator, 'estimateCadMinor');
    this.#actualCost = bindDataMethod<
      OpenAiAudioCostCalculator['actualCadMinor']
    >(options.costCalculator, 'actualCadMinor');
    this.#pricingVersion = pricingVersion;
    this.#speechModel = speechModel as OpenAiSpeechModel;
    this.#clock =
      (options.clock as (() => Date) | undefined) ?? (() => new Date());
    this.#timeoutMs = timeoutMs;
  }

  get speechModel(): OpenAiSpeechModel {
    return this.#speechModel;
  }

  get smokeContract() {
    return createOpenAiAudioSmokeContract(this.#speechModel);
  }

  async transcribe(
    input: unknown,
    externalSignal?: AbortSignal,
  ): Promise<OpenAiTranscriptionResult> {
    if (externalSignal !== undefined && !isAbortSignal(externalSignal)) {
      return this.#failedTranscription(safeErrors.invalid, false);
    }
    const parsed = parseTranscriptionInput(input);
    if (parsed === undefined) {
      return this.#failedTranscription(safeErrors.invalid, false);
    }
    const model =
      parsed.attempt === 'accuracy-retry'
        ? OPENAI_AUDIO_MODELS.transcriptionAccuracyRetry
        : OPENAI_AUDIO_MODELS.transcriptionDefault;
    const abortScope = createAbortScope(externalSignal, this.#timeoutMs);
    let ownedAudio: Uint8Array | undefined;
    let estimatedCadMinor: number;
    try {
      const estimate = await awaitWithinAbortScope(abortScope, async () =>
        this.#estimateCost(
          Object.freeze({
            operation: 'transcription' as const,
            model,
            durationMs: parsed.durationMs,
            inputBytes: parsed.audio.byteLength,
          }),
        ),
      );
      if (!isPositiveCadMinor(estimate)) throw new SpendBoundaryError();
      estimatedCadMinor = estimate;
    } catch {
      abortScope.close();
      return this.#failedTranscription(
        scopedSafeError(abortScope, safeErrors.accounting),
        false,
        model,
        parsed.attempt,
      );
    }

    const reserveOperation = createReserveSpendOperation(
      parsed.spend,
      estimatedCadMinor,
      this.#reserveSpend,
    );
    const releaseLateReservation = createLateReservationReleaseCallback(
      parsed.spend,
      this.#releaseReservation.bind(this),
    );
    let reserveStatus: string;
    try {
      reserveStatus = await awaitWithinAbortScope(
        abortScope,
        reserveOperation,
        releaseLateReservation,
      );
    } catch {
      abortScope.close();
      return this.#failedTranscription(
        scopedSafeError(abortScope, safeErrors.accounting),
        true,
        model,
        parsed.attempt,
      );
    }
    if (reserveStatus === 'blocked') {
      abortScope.close();
      return this.#failedTranscription(
        safeErrors.spendBlocked,
        false,
        model,
        parsed.attempt,
      );
    }
    if (reserveStatus !== 'reserved') {
      abortScope.close();
      return this.#failedTranscription(
        safeErrors.accounting,
        true,
        model,
        parsed.attempt,
      );
    }

    let dispatched = false;
    let dispatchAttempted = false;
    const onDispatch = async () => {
      if (dispatchAttempted) throw new SpendBoundaryError();
      dispatchAttempted = true;
      if (abortScope.signal.aborted) {
        throw abortedError(abortScope.isTimedOut());
      }
      const status = await awaitWithinAbortScope(abortScope, () =>
        this.#safeSpendCall(() => this.#markSpendDispatched(parsed.spend)),
      );
      if (status !== 'dispatched') throw new SpendBoundaryError();
      dispatched = true;
    };

    try {
      if (abortScope.signal.aborted) {
        throw abortedError(abortScope.isTimedOut());
      }
      ownedAudio = new Uint8Array(parsed.audio);
      const response = await awaitWithinAbortScope(abortScope, () =>
        this.#transportTranscribe({
          model,
          audio: ownedAudio!,
          mimeType: parsed.mimeType,
          fileName: `voice.${transcriptionFileExtension(parsed.mimeType)}`,
          ...(parsed.language === undefined
            ? {}
            : { language: parsed.language }),
          ...(parsed.prompt === undefined ? {} : { prompt: parsed.prompt }),
          responseFormat: 'json',
          signal: abortScope.signal,
          onDispatch,
        }),
      );
      if (!dispatched) throw new SpendBoundaryError();
      const responseSnapshot = snapshotPlainRecord(
        response,
        ['body', 'providerRequestId'],
        ['body'],
      );
      if (
        responseSnapshot === undefined ||
        !isBoundedAcyclicPlainData(responseSnapshot.body, {
          maxDepth: 8,
          maxNodes: 50_000,
        })
      ) {
        return this.#failedTranscription(
          safeErrors.invalidResponse,
          true,
          model,
          parsed.attempt,
        );
      }
      const providerResult = ProviderTranscriptionSchema.safeParse(
        responseSnapshot.body,
      );
      if (!providerResult.success) {
        return this.#failedTranscription(
          safeErrors.invalidResponse,
          true,
          model,
          parsed.attempt,
        );
      }
      const usage = normalizeUsage(providerResult.data.usage);
      const actualInput: OpenAiAudioActualCostInput = Object.freeze({
        operation: 'transcription' as const,
        model,
        durationMs: parsed.durationMs,
        inputBytes: parsed.audio.byteLength,
        usage,
      });
      const actualCadMinor = await awaitWithinAbortScope(abortScope, async () =>
        this.#actualCost(actualInput),
      );
      if (!isPositiveCadMinor(actualCadMinor)) {
        throw new SpendBoundaryError();
      }
      if (
        (await awaitWithinAbortScope(abortScope, () =>
          this.#safeSpendCall(() =>
            this.#settleSpend({ ...parsed.spend, actualCadMinor }),
          ),
        )) !== 'settled'
      ) {
        throw new SpendBoundaryError();
      }
      return Object.freeze({
        status: 'completed' as const,
        model,
        attempt: parsed.attempt,
        text: providerResult.data.text,
        usage,
        ...(safeProviderRequestId(responseSnapshot.providerRequestId) ===
        undefined
          ? {}
          : {
              providerRequestId: safeProviderRequestId(
                responseSnapshot.providerRequestId,
              )!,
            }),
        spend: Object.freeze({
          pricingVersion: this.#pricingVersion,
          estimatedCadMinor,
          actualCadMinor,
        }),
        response: transcriptionResponseMetadata,
      });
    } catch (error) {
      let reconciliationRequired = dispatched;
      if (!dispatched) {
        reconciliationRequired = !(await this.#releaseReservation(
          parsed.spend,
        ));
      }
      return this.#failedTranscription(
        abortScope.isTimedOut() ? safeErrors.timeout : mapThrownError(error),
        reconciliationRequired,
        model,
        parsed.attempt,
      );
    } finally {
      abortScope.close();
      ownedAudio?.fill(0);
    }
  }

  async createSpeech(
    input: unknown,
    externalSignal?: AbortSignal,
  ): Promise<OpenAiSpeechResult> {
    if (externalSignal !== undefined && !isAbortSignal(externalSignal)) {
      return this.#failedSpeech(safeErrors.invalid, false);
    }
    const parsed = parseSpeechInput(input);
    if (
      parsed === undefined ||
      (parsed.instructions !== undefined &&
        (this.#speechModel === 'tts-1' || this.#speechModel === 'tts-1-hd'))
    ) {
      return this.#failedSpeech(safeErrors.invalid, false, this.#speechModel);
    }
    const abortScope = createAbortScope(externalSignal, this.#timeoutMs);
    let ownedResponseAudio: Uint8Array | undefined;
    let estimatedCadMinor: number;
    try {
      const estimate = await awaitWithinAbortScope(abortScope, async () =>
        this.#estimateCost(
          Object.freeze({
            operation: 'speech' as const,
            model: this.#speechModel,
            inputCharacters: parsed.text.length,
            responseFormat: parsed.format,
          }),
        ),
      );
      if (!isPositiveCadMinor(estimate)) throw new SpendBoundaryError();
      estimatedCadMinor = estimate;
    } catch {
      abortScope.close();
      return this.#failedSpeech(
        scopedSafeError(abortScope, safeErrors.accounting),
        false,
        this.#speechModel,
      );
    }
    const reserveOperation = createReserveSpendOperation(
      parsed.spend,
      estimatedCadMinor,
      this.#reserveSpend,
    );
    const releaseLateReservation = createLateReservationReleaseCallback(
      parsed.spend,
      this.#releaseReservation.bind(this),
    );
    let reserveStatus: string;
    try {
      reserveStatus = await awaitWithinAbortScope(
        abortScope,
        reserveOperation,
        releaseLateReservation,
      );
    } catch {
      abortScope.close();
      return this.#failedSpeech(
        scopedSafeError(abortScope, safeErrors.accounting),
        true,
        this.#speechModel,
      );
    }
    if (reserveStatus === 'blocked') {
      abortScope.close();
      return this.#failedSpeech(
        safeErrors.spendBlocked,
        false,
        this.#speechModel,
      );
    }
    if (reserveStatus !== 'reserved') {
      abortScope.close();
      return this.#failedSpeech(safeErrors.accounting, true, this.#speechModel);
    }

    let dispatched = false;
    let dispatchAttempted = false;
    const onDispatch = async () => {
      if (dispatchAttempted) throw new SpendBoundaryError();
      dispatchAttempted = true;
      if (abortScope.signal.aborted) {
        throw abortedError(abortScope.isTimedOut());
      }
      const status = await awaitWithinAbortScope(abortScope, () =>
        this.#safeSpendCall(() => this.#markSpendDispatched(parsed.spend)),
      );
      if (status !== 'dispatched') throw new SpendBoundaryError();
      dispatched = true;
    };

    try {
      if (abortScope.signal.aborted) {
        throw abortedError(abortScope.isTimedOut());
      }
      const response = await awaitWithinAbortScope(
        abortScope,
        () =>
          this.#transportCreateSpeech({
            model: this.#speechModel,
            input: parsed.text,
            voice: parsed.voice,
            ...(parsed.instructions === undefined
              ? {}
              : { instructions: parsed.instructions }),
            responseFormat: parsed.format,
            ...(parsed.speed === undefined ? {} : { speed: parsed.speed }),
            signal: abortScope.signal,
            onDispatch,
          }),
        disposeLateSpeechResponse,
      );
      if (!dispatched) throw new SpendBoundaryError();
      const responseSnapshot = snapshotPlainRecord(
        response,
        ['audio', 'contentType', 'providerRequestId'],
        ['audio', 'contentType'],
      );
      if (responseSnapshot === undefined) {
        return this.#failedSpeech(
          safeErrors.invalidResponse,
          true,
          this.#speechModel,
        );
      }
      const sourceAudio = responseSnapshot.audio;
      const hasBoundedAudio =
        isNormalOwnedUint8Array(sourceAudio) &&
        sourceAudio.byteLength >= 1 &&
        sourceAudio.byteLength <= OPENAI_AUDIO_LIMITS.maxSpeechBytes;
      if (!hasBoundedAudio) {
        return this.#failedSpeech(
          safeErrors.invalidResponse,
          true,
          this.#speechModel,
        );
      }
      try {
        ownedResponseAudio = new Uint8Array(sourceAudio);
      } finally {
        sourceAudio.fill(0);
      }
      const providerRequestId = safeProviderRequestId(
        responseSnapshot.providerRequestId,
      );
      const providerContentType = responseSnapshot.contentType;

      const actualCadMinor = await awaitWithinAbortScope(abortScope, async () =>
        this.#actualCost(
          Object.freeze({
            operation: 'speech' as const,
            model: this.#speechModel,
            inputCharacters: parsed.text.length,
            outputBytes: ownedResponseAudio!.byteLength,
            responseFormat: parsed.format,
          }),
        ),
      );
      if (!isPositiveCadMinor(actualCadMinor)) {
        throw new SpendBoundaryError();
      }
      if (
        (await awaitWithinAbortScope(abortScope, () =>
          this.#safeSpendCall(() =>
            this.#settleSpend({ ...parsed.spend, actualCadMinor }),
          ),
        )) !== 'settled'
      ) {
        throw new SpendBoundaryError();
      }
      if (
        typeof providerContentType !== 'string' ||
        !matchesSpeechContentType(parsed.format, providerContentType)
      ) {
        return this.#failedSpeech(
          safeErrors.invalidResponse,
          false,
          this.#speechModel,
        );
      }

      const audio = new EphemeralSpeechAudio(
        ephemeralAudioConstructorToken,
        ownedResponseAudio,
      );
      ownedResponseAudio = undefined;
      return Object.freeze({
        status: 'completed' as const,
        model: this.#speechModel,
        voice: parsed.voice,
        format: parsed.format,
        audio,
        ...(providerRequestId === undefined ? {} : { providerRequestId }),
        spend: Object.freeze({
          pricingVersion: this.#pricingVersion,
          estimatedCadMinor,
          actualCadMinor,
        }),
        response: responseMetadata(speechContentType(parsed.format)),
      });
    } catch (error) {
      let reconciliationRequired = dispatched;
      if (!dispatched) {
        reconciliationRequired = !(await this.#releaseReservation(
          parsed.spend,
        ));
      }
      return this.#failedSpeech(
        abortScope.isTimedOut() ? safeErrors.timeout : mapThrownError(error),
        reconciliationRequired,
        this.#speechModel,
      );
    } finally {
      abortScope.close();
      ownedResponseAudio?.fill(0);
    }
  }

  async checkModelAvailability(
    externalSignal?: AbortSignal,
  ): Promise<OpenAiAudioModelAvailabilityResult> {
    const checkedAtDate = new Date(this.#clock());
    if (!Number.isFinite(checkedAtDate.getTime())) {
      throw new Error('invalid-openai-audio-clock');
    }
    const checks = [
      {
        purpose: 'transcription-default' as const,
        model: OPENAI_AUDIO_MODELS.transcriptionDefault,
      },
      {
        purpose: 'transcription-accuracy-retry' as const,
        model: OPENAI_AUDIO_MODELS.transcriptionAccuracyRetry,
      },
      { purpose: 'speech-default' as const, model: this.#speechModel },
    ];
    const abortScope = createAbortScope(externalSignal, this.#timeoutMs);
    try {
      const models = await Promise.all(
        checks.map(async (check) => {
          try {
            const result = await this.#transportCheckModel(
              check.model,
              abortScope.signal,
            );
            return this.#modelAvailability(check, result);
          } catch (error) {
            const reason: OpenAiModelUnavailableReason =
              error instanceof OpenAiAudioTransportError &&
              error.kind === 'provider-rejected' &&
              error.httpStatus === 404
                ? 'not-found'
                : error instanceof OpenAiAudioTransportError &&
                    error.kind === 'provider-rejected' &&
                    (error.httpStatus === 401 || error.httpStatus === 403)
                  ? 'access-denied'
                  : error instanceof OpenAiAudioTransportError &&
                      error.httpStatus === 429
                    ? 'rate-limited'
                    : 'provider-unavailable';
            return Object.freeze({
              ...check,
              status: 'unavailable' as const,
              reason,
            });
          }
        }),
      );
      return Object.freeze({
        schemaVersion: 1 as const,
        scope: 'catalog-access-only' as const,
        status: models.every((model) => model.status === 'available')
          ? ('ready' as const)
          : ('unavailable' as const),
        checkedAt: checkedAtDate.toISOString(),
        models: Object.freeze(models),
      });
    } finally {
      abortScope.close();
    }
  }

  #modelAvailability(
    check: Readonly<{
      purpose:
        | 'transcription-default'
        | 'transcription-accuracy-retry'
        | 'speech-default';
      model: string;
    }>,
    result: OpenAiModelAvailabilityTransportResult,
  ) {
    const snapshot = snapshotPlainRecord(
      result,
      ['status', 'resolvedModel', 'reason'],
      ['status'],
    );
    if (
      snapshot?.status === 'available' &&
      snapshot.resolvedModel === check.model
    ) {
      return Object.freeze({ ...check, status: 'available' as const });
    }
    const allowedReasons: readonly OpenAiModelUnavailableReason[] = [
      'not-found',
      'access-denied',
      'rate-limited',
      'provider-unavailable',
    ];
    if (
      snapshot?.status === 'unavailable' &&
      typeof snapshot.reason === 'string' &&
      allowedReasons.includes(snapshot.reason as OpenAiModelUnavailableReason)
    ) {
      return Object.freeze({
        ...check,
        status: 'unavailable' as const,
        reason: snapshot.reason as OpenAiModelUnavailableReason,
      });
    }
    return Object.freeze({
      ...check,
      status: 'unavailable' as const,
      reason: 'invalid-response' as const,
    });
  }

  async #safeSpendCall(operation: () => Promise<unknown>): Promise<string> {
    try {
      return readStatus(await operation()) ?? 'invalid';
    } catch {
      return 'invalid';
    }
  }

  async #releaseReservation(
    context: OpenAiAudioSpendContext,
  ): Promise<boolean> {
    const releaseScope = createAbortScope(
      undefined,
      Math.min(this.#timeoutMs, 5_000),
    );
    try {
      return (
        (await awaitWithinAbortScope(releaseScope, () =>
          this.#safeSpendCall(() => this.#releaseSpend(context)),
        )) === 'released'
      );
    } catch {
      return false;
    } finally {
      releaseScope.close();
    }
  }

  #failedTranscription(
    safeError: OpenAiAudioSafeError,
    reconciliationRequired: boolean,
    model?: OpenAiTranscriptionModel,
    attempt?: TranscriptionAttempt,
  ): OpenAiTranscriptionResult {
    return Object.freeze({
      status: 'failed' as const,
      ...(model === undefined ? {} : { model }),
      ...(attempt === undefined ? {} : { attempt }),
      safeError,
      reconciliationRequired,
      response: transcriptionResponseMetadata,
    });
  }

  #failedSpeech(
    safeError: OpenAiAudioSafeError,
    reconciliationRequired: boolean,
    model?: OpenAiSpeechModel,
  ): OpenAiSpeechResult {
    return Object.freeze({
      status: 'failed' as const,
      ...(model === undefined ? {} : { model }),
      safeError,
      reconciliationRequired,
      response: responseMetadata('application/problem+json'),
    });
  }
}
