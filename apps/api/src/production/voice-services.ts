import { createHash } from 'node:crypto';

import {
  PostgresSpendLedger,
  checkPostgresAudioSpendReadiness,
  type DurableRepositoryPrincipal,
  type EmdoDatabaseClient,
} from '@emdo/db/api';
import {
  OPENAI_AUDIO_LIMITS,
  OPENAI_ENDPOINT_SPEECH_MODELS,
  OpenAiAudioAdapter,
  OpenAiFetchAudioTransport,
  ProductionOpenAiAudioCostCalculator,
  parseOpenAiAudioPricing,
  type OpenAiAudioCostCalculator,
  type OpenAiAudioSafeError,
  type OpenAiAudioSpendGuard,
  type OpenAiAudioTransport,
  type OpenAiFetch,
  type OpenAiSpeechModel,
} from '@emdo/integrations/openai';
import { z } from 'zod';

import { AuthenticatedPrincipalSchema } from '../schemas.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
  VoiceGateway,
  VoiceGatewaySafeError,
} from '../services/contracts.js';
import { createProductionAudioInspector } from './audio-inspector.js';
import type { ProductionApiServiceBinding } from './unavailable-services.js';

type DatabasePool = EmdoDatabaseClient['scopedPool'];
export type ProductionVoiceSpendLedger = Pick<
  PostgresSpendLedger,
  'reserve' | 'markDispatched' | 'settle' | 'release'
>;

const DEFAULT_READINESS_TTL_MS = 30_000;
const DEFAULT_READINESS_TIMEOUT_MS = 2_000;
const SPEND_THRESHOLDS = Object.freeze({
  warningCadMinor: 5_000,
  limitCadMinor: 7_500,
});

const ApiKeySchema = z
  .string()
  .min(16)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u);
const SpeechModelSchema = z.enum(OPENAI_ENDPOINT_SPEECH_MODELS);
const EnvironmentSchema = z.strictObject({
  apiKey: ApiKeySchema,
  speechModel: SpeechModelSchema,
  encodedPricing: z.string().min(1).max(32_768),
});
const SafeIdentifierSchema = z
  .string()
  .min(16)
  .max(200)
  .regex(/^[A-Za-z0-9:._-]+$/u);
const AudioSchema = z
  .instanceof(Uint8Array)
  .refine(
    (audio) =>
      Object.getPrototypeOf(audio) === Uint8Array.prototype &&
      audio.buffer instanceof ArrayBuffer,
  )
  .refine(
    (audio) =>
      audio.byteLength >= 1 &&
      audio.byteLength <= OPENAI_AUDIO_LIMITS.maxTranscriptionBytes,
  );
const TranscriptionContentTypeSchema = z.enum([
  'audio/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
]);
const TranscriptionInputSchema = z
  .strictObject({
    audio: AudioSchema,
    contentType: TranscriptionContentTypeSchema,
    durationMs: z.number().int().safe().min(1).max(60_000),
    attempt: z.enum(['default', 'accuracy-retry']),
    model: z.enum(['gpt-4o-mini-transcribe', 'gpt-4o-transcribe']),
    principal: AuthenticatedPrincipalSchema,
    requestId: z.uuid(),
    executionId: SafeIdentifierSchema,
    reservationId: SafeIdentifierSchema,
  })
  .superRefine((value, context) => {
    const expected =
      value.attempt === 'accuracy-retry'
        ? 'gpt-4o-transcribe'
        : 'gpt-4o-mini-transcribe';
    if (value.model !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'Transcription model does not match the selected attempt',
      });
    }
  });
const SpeechVoiceSchema = z.enum([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
]);
const SpeechInputSchema = z.strictObject({
  text: z
    .string()
    .trim()
    .min(1)
    .max(OPENAI_AUDIO_LIMITS.maxSpeechCharacters)
    .refine((value) => !value.includes('\0')),
  voice: SpeechVoiceSchema,
  principal: AuthenticatedPrincipalSchema,
  requestId: z.uuid(),
  executionId: SafeIdentifierSchema,
  reservationId: SafeIdentifierSchema,
});

const sha256Json = (input: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');

const safeErrors = Object.freeze({
  invalid: Object.freeze({
    code: 'audio-request-invalid' as const,
    message: 'The audio request is invalid.',
    retryable: false,
  }),
  unavailable: Object.freeze({
    code: 'audio-provider-unavailable' as const,
    message: 'Audio service is temporarily unavailable.',
    retryable: true,
  }),
  failed: Object.freeze({
    code: 'audio-provider-failed' as const,
    message: 'The audio service could not complete the request.',
    retryable: false,
  }),
  limit: Object.freeze({
    code: 'ai-spend-limit-reached' as const,
    message: 'The monthly AI spend limit has been reached.',
    retryable: false,
  }),
});

const failed = (
  safeError: VoiceGatewaySafeError,
  reconciliationRequired = false,
) =>
  Object.freeze({
    status: 'failed' as const,
    safeError,
    reconciliationRequired,
  });

const mapAdapterError = (
  input: OpenAiAudioSafeError,
): VoiceGatewaySafeError => {
  switch (input.code) {
    case 'monthly-ai-spend-limit-reached':
      return safeErrors.limit;
    case 'audio-request-invalid':
      return safeErrors.invalid;
    case 'audio-provider-unavailable':
    case 'audio-provider-timeout':
    case 'audio-request-cancelled':
      return safeErrors.unavailable;
    case 'audio-spend-accounting-failed':
      return Object.freeze({
        code: 'audio-provider-failed' as const,
        message: 'Audio usage could not be safely accounted for.',
        retryable: false,
      });
    case 'audio-provider-rejected':
    case 'audio-provider-response-invalid':
      return Object.freeze({
        ...safeErrors.failed,
        retryable: input.retryable,
      });
  }
};

const torontoPeriod = (nowMs: number): string => {
  const date = new Date(nowMs);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('voice-provider-clock-invalid');
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = parts.find(({ type }) => type === 'year')?.value;
  const month = parts.find(({ type }) => type === 'month')?.value;
  if (year === undefined || month === undefined) {
    throw new Error('voice-provider-clock-invalid');
  }
  return `${year}-${month}`;
};

const createInspectorSelfTestWav = (): Uint8Array => {
  const sampleRate = 8_000;
  const samples = 800;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      bytes[offset + index] = text.charCodeAt(index);
    }
  };
  writeText(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, samples * 2, true);
  return bytes;
};

export interface ProductionVoiceProviderDependencies {
  readonly createAudioInspector: () => Pick<VoiceGateway, 'inspectRecording'>;
  readonly createCostCalculator: (
    pricing: ReturnType<typeof parseOpenAiAudioPricing>,
  ) => OpenAiAudioCostCalculator;
  readonly createTransport: (input: {
    readonly fetch: OpenAiFetch;
    readonly getApiKey: () => string;
  }) => OpenAiAudioTransport;
  readonly createSpendLedger: (
    pool: DatabasePool,
    principal: DurableRepositoryPrincipal,
  ) => ProductionVoiceSpendLedger;
  readonly checkSpendReady: (pool: DatabasePool) => Promise<boolean>;
  readonly fetch: OpenAiFetch;
  readonly clock: () => number;
  readonly readinessTtlMs: number;
  readonly readinessTimeoutMs: number;
}

const defaultDependencies: ProductionVoiceProviderDependencies = Object.freeze({
  createAudioInspector: () => createProductionAudioInspector(),
  createCostCalculator: (pricing: ReturnType<typeof parseOpenAiAudioPricing>) =>
    new ProductionOpenAiAudioCostCalculator(pricing),
  createTransport: (transportInput: {
    readonly fetch: OpenAiFetch;
    readonly getApiKey: () => string;
  }) => new OpenAiFetchAudioTransport(transportInput),
  createSpendLedger: (
    pool: DatabasePool,
    principal: DurableRepositoryPrincipal,
  ) => new PostgresSpendLedger(pool, principal),
  checkSpendReady: (pool: DatabasePool) =>
    checkPostgresAudioSpendReadiness(pool),
  fetch: globalThis.fetch.bind(globalThis),
  clock: () => Date.now(),
  readinessTtlMs: DEFAULT_READINESS_TTL_MS,
  readinessTimeoutMs: DEFAULT_READINESS_TIMEOUT_MS,
});

export interface ProductionVoiceProviderComposition {
  readonly binding?: ProductionApiServiceBinding<ApiServices['voice']>;
  readonly close?: () => Promise<void>;
}

const principalForLedger = (
  principal: AuthenticatedPrincipal,
  requestId: string,
): Readonly<DurableRepositoryPrincipal> =>
  Object.freeze({
    userId: principal.userId,
    sessionId: principal.sessionId,
    requestId,
    householdId: principal.householdId,
  });

export const createProductionVoiceProviderBinding = (
  input: {
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly pool: DatabasePool;
  },
  dependencies: ProductionVoiceProviderDependencies = defaultDependencies,
): ProductionVoiceProviderComposition => {
  const parsedEnvironment = EnvironmentSchema.safeParse({
    apiKey: input.environment.EMDO_OPENAI_AUDIO_API_KEY,
    speechModel: input.environment.EMDO_OPENAI_SPEECH_MODEL,
    encodedPricing: input.environment.EMDO_OPENAI_AUDIO_PRICING_B64URL,
  });
  if (!parsedEnvironment.success) return Object.freeze({});
  if (
    !Number.isSafeInteger(dependencies.readinessTtlMs) ||
    dependencies.readinessTtlMs < 1 ||
    dependencies.readinessTtlMs > 300_000 ||
    !Number.isSafeInteger(dependencies.readinessTimeoutMs) ||
    dependencies.readinessTimeoutMs < 100 ||
    dependencies.readinessTimeoutMs > 10_000
  ) {
    return Object.freeze({});
  }

  let apiKeyBytes: Buffer | undefined;
  let transport: OpenAiAudioTransport | undefined;
  let inspector: Pick<VoiceGateway, 'inspectRecording'> | undefined;
  let costCalculator: OpenAiAudioCostCalculator | undefined;
  let pricingVersion: string;
  const speechModel: OpenAiSpeechModel = parsedEnvironment.data.speechModel;
  try {
    const parsedPricing = parseOpenAiAudioPricing(
      parsedEnvironment.data.encodedPricing,
    );
    pricingVersion = parsedPricing.pricingVersion;
    apiKeyBytes = Buffer.from(parsedEnvironment.data.apiKey, 'utf8');
    const getApiKey = () => {
      if (apiKeyBytes === undefined) throw new Error('voice-provider-closed');
      return apiKeyBytes.toString('utf8');
    };
    transport = dependencies.createTransport({
      fetch: dependencies.fetch,
      getApiKey,
    });
    inspector = dependencies.createAudioInspector();
    costCalculator = dependencies.createCostCalculator(parsedPricing);
  } catch {
    apiKeyBytes?.fill(0);
    return Object.freeze({});
  }

  const configurationVersion = sha256Json([
    'emdo.openai-speech-configuration.v1',
    speechModel,
    pricingVersion,
  ]);
  let closing = false;
  let activeOperations = 0;
  let resolveDrain: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;
  let readinessInFlight: Promise<boolean> | undefined;
  let cachedReadiness:
    { readonly checkedAtMs: number; readonly ready: boolean } | undefined;

  const beginOperation = (): (() => void) | undefined => {
    if (closing) return undefined;
    activeOperations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeOperations -= 1;
      if (closing && activeOperations === 0) {
        const resolve = resolveDrain;
        resolveDrain = undefined;
        resolve?.();
      }
    };
  };

  const runOperation = <Value>(
    operation: () => Promise<Value>,
    unavailableValue: Value,
  ): Promise<Value> => {
    const release = beginOperation();
    if (release === undefined) return Promise.resolve(unavailableValue);
    return Promise.resolve().then(operation).finally(release);
  };

  const currentDependencies = () => {
    if (
      closing ||
      transport === undefined ||
      inspector === undefined ||
      costCalculator === undefined
    ) {
      throw new Error('voice-provider-closed');
    }
    return { transport, inspector, costCalculator };
  };

  const createSpendGuard = (scope: {
    readonly operation: 'transcription' | 'speech';
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly executionId: string;
    readonly reservationId: string;
    readonly requestHash: string;
  }) => {
    const ledger = dependencies.createSpendLedger(
      input.pool,
      principalForLedger(scope.principal, scope.requestId),
    );
    const authorizationHash = sha256Json([
      'emdo.openai-audio-authorization.v1',
      scope.operation,
      scope.principal.householdId,
      scope.principal.userId,
      scope.principal.sessionId,
      scope.requestId,
      scope.principal.spaceAccessGrantId,
      scope.principal.collectionAuthorizationScopeFingerprint,
      scope.executionId,
      scope.reservationId,
      scope.requestHash,
    ]);
    let spendWarning = false;
    const assertContext = (context: {
      readonly executionId: string;
      readonly reservationId: string;
    }) => {
      if (
        context.executionId !== scope.executionId ||
        context.reservationId !== scope.reservationId
      ) {
        throw new Error('voice-spend-context-mismatch');
      }
    };
    const guard: OpenAiAudioSpendGuard = Object.freeze({
      reserve: async (
        request: Parameters<OpenAiAudioSpendGuard['reserve']>[0],
      ) => {
        assertContext(request);
        const result = await ledger.reserve(
          {
            authorizationHash,
            category: 'audio',
            estimatedCadMinor: request.estimatedCadMinor,
            executionId: scope.executionId,
            householdId: scope.principal.householdId,
            period: torontoPeriod(dependencies.clock()),
            requestHash: scope.requestHash,
            reservationId: scope.reservationId,
          },
          SPEND_THRESHOLDS,
        );
        if (result.status === 'reserved') spendWarning = result.warning;
        return result;
      },
      markDispatched: async (
        request: Parameters<OpenAiAudioSpendGuard['markDispatched']>[0],
      ) => {
        assertContext(request);
        return ledger.markDispatched({
          reservationId: scope.reservationId,
          authorizationHash,
        });
      },
      settle: async (
        request: Parameters<OpenAiAudioSpendGuard['settle']>[0],
      ) => {
        assertContext(request);
        return ledger.settle({
          reservationId: scope.reservationId,
          executionId: scope.executionId,
          actualCadMinor: request.actualCadMinor,
        });
      },
      release: async (
        request: Parameters<OpenAiAudioSpendGuard['release']>[0],
      ) => {
        assertContext(request);
        return ledger.release({
          reservationId: scope.reservationId,
          authorizationHash,
        });
      },
    });
    return Object.freeze({
      guard,
      spendWarning: () => spendWarning,
    });
  };

  const transcribe = async (
    rawInput: Parameters<VoiceGateway['transcribe']>[0],
  ): Promise<Awaited<ReturnType<VoiceGateway['transcribe']>>> => {
    const parsed = TranscriptionInputSchema.safeParse(rawInput);
    if (!parsed.success) return failed(safeErrors.invalid);
    const current = currentDependencies();
    let inspection: Awaited<ReturnType<VoiceGateway['inspectRecording']>>;
    try {
      inspection = await current.inspector.inspectRecording({
        audio: parsed.data.audio,
        declaredContentType: parsed.data.contentType,
        durationHintMs: parsed.data.durationMs,
        maximumDurationMs: 60_000,
      });
    } catch {
      return failed(safeErrors.unavailable);
    }
    if (inspection.status === 'rejected') {
      return failed(
        inspection.code === 'audio-inspector-unavailable'
          ? safeErrors.unavailable
          : safeErrors.invalid,
      );
    }
    const audioDigest = createHash('sha256')
      .update(parsed.data.audio)
      .digest('hex');
    const requestHash = sha256Json([
      'emdo.openai-audio-request.v1',
      'transcription',
      parsed.data.model,
      parsed.data.attempt,
      inspection.durationMs,
      inspection.verifiedContentType,
      parsed.data.audio.byteLength,
      audioDigest,
      pricingVersion,
    ]);
    try {
      const spend = createSpendGuard({
        operation: 'transcription',
        principal: parsed.data.principal,
        requestId: parsed.data.requestId,
        executionId: parsed.data.executionId,
        reservationId: parsed.data.reservationId,
        requestHash,
      });
      const adapter = new OpenAiAudioAdapter({
        transport: current.transport,
        spendGuard: spend.guard,
        costCalculator: current.costCalculator,
        speechModel,
        clock: () => new Date(dependencies.clock()),
      });
      const result = await adapter.transcribe({
        audio: parsed.data.audio,
        mimeType: inspection.verifiedContentType,
        durationMs: inspection.durationMs,
        attempt:
          parsed.data.attempt === 'accuracy-retry'
            ? 'accuracy-retry'
            : 'initial',
        spend: {
          executionId: parsed.data.executionId,
          reservationId: parsed.data.reservationId,
        },
      });
      if (result.status === 'failed') {
        return failed(
          mapAdapterError(result.safeError),
          result.reconciliationRequired,
        );
      }
      if (result.model !== parsed.data.model) {
        return failed(safeErrors.failed, true);
      }
      return Object.freeze({
        status: 'completed' as const,
        transcript: result.text,
        model: result.model,
        spendWarning: spend.spendWarning(),
      });
    } catch {
      return failed(safeErrors.unavailable);
    }
  };

  const speak = async (
    rawInput: Parameters<VoiceGateway['speak']>[0],
  ): Promise<Awaited<ReturnType<VoiceGateway['speak']>>> => {
    const parsed = SpeechInputSchema.safeParse(rawInput);
    if (!parsed.success) return failed(safeErrors.invalid);
    const current = currentDependencies();
    const requestHash = sha256Json([
      'emdo.openai-audio-request.v1',
      'speech',
      speechModel,
      parsed.data.voice,
      parsed.data.text,
      parsed.data.text.length,
      'mp3',
      pricingVersion,
    ]);
    try {
      const spend = createSpendGuard({
        operation: 'speech',
        principal: parsed.data.principal,
        requestId: parsed.data.requestId,
        executionId: parsed.data.executionId,
        reservationId: parsed.data.reservationId,
        requestHash,
      });
      const adapter = new OpenAiAudioAdapter({
        transport: current.transport,
        spendGuard: spend.guard,
        costCalculator: current.costCalculator,
        speechModel,
        clock: () => new Date(dependencies.clock()),
      });
      const result = await adapter.createSpeech({
        text: parsed.data.text,
        voice: parsed.data.voice,
        format: 'mp3',
        spend: {
          executionId: parsed.data.executionId,
          reservationId: parsed.data.reservationId,
        },
      });
      if (result.status === 'failed') {
        return failed(
          mapAdapterError(result.safeError),
          result.reconciliationRequired,
        );
      }
      let audio: Uint8Array | undefined;
      try {
        audio = result.audio.take();
        if (
          Object.getPrototypeOf(audio) !== Uint8Array.prototype ||
          !(audio.buffer instanceof ArrayBuffer) ||
          audio.byteLength < 1 ||
          audio.byteLength > OPENAI_AUDIO_LIMITS.maxSpeechBytes ||
          result.model !== speechModel ||
          result.format !== 'mp3'
        ) {
          audio.fill(0);
          return failed(safeErrors.failed, true);
        }
        const completed = Object.freeze({
          status: 'completed' as const,
          audio,
          contentType: 'audio/mpeg' as const,
          model: result.model,
          spendWarning: spend.spendWarning(),
        });
        audio = undefined;
        return completed;
      } finally {
        audio?.fill(0);
        result.audio.dispose();
      }
    } catch {
      return failed(safeErrors.unavailable);
    }
  };

  const service: ApiServices['voice'] = Object.freeze({
    inspectRecording: (
      rawInput: Parameters<VoiceGateway['inspectRecording']>[0],
    ) =>
      runOperation(
        () => currentDependencies().inspector.inspectRecording(rawInput),
        Object.freeze({
          status: 'rejected' as const,
          code: 'audio-inspector-unavailable' as const,
        }),
      ),
    getSpeechConfiguration: () => {
      const release = beginOperation();
      if (release === undefined) {
        return Promise.reject(new Error('voice-provider-closed'));
      }
      return Promise.resolve()
        .then(() => {
          currentDependencies();
          return Object.freeze({
            model: speechModel,
            configurationVersion,
          });
        })
        .finally(release);
    },
    transcribe: (rawInput: Parameters<VoiceGateway['transcribe']>[0]) =>
      runOperation(() => transcribe(rawInput), failed(safeErrors.unavailable)),
    speak: (rawInput: Parameters<VoiceGateway['speak']>[0]) =>
      runOperation(() => speak(rawInput), failed(safeErrors.unavailable)),
  });

  const runReadiness = async (): Promise<boolean> => {
    const current = currentDependencies();
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const wav = createInspectorSelfTestWav();
    const neverSpend: OpenAiAudioSpendGuard = Object.freeze({
      reserve: async () => {
        throw new Error('readiness-spend-unreachable');
      },
      markDispatched: async () => {
        throw new Error('readiness-spend-unreachable');
      },
      settle: async () => {
        throw new Error('readiness-spend-unreachable');
      },
      release: async () => {
        throw new Error('readiness-spend-unreachable');
      },
    });
    const adapter = new OpenAiAudioAdapter({
      transport: current.transport,
      spendGuard: neverSpend,
      costCalculator: current.costCalculator,
      speechModel,
      clock: () => new Date(dependencies.clock()),
      timeoutMs: dependencies.readinessTimeoutMs,
    });
    try {
      const checks = Promise.all([
        current.inspector.inspectRecording({
          audio: wav,
          declaredContentType: 'audio/wav',
          durationHintMs: 100,
          maximumDurationMs: 60_000,
        }),
        dependencies.checkSpendReady(input.pool),
        adapter.checkModelAvailability(controller.signal),
      ]);
      const deadline = new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, dependencies.readinessTimeoutMs);
        timeout.unref();
      });
      const result = await Promise.race([checks, deadline]);
      if (result === undefined || closing) return false;
      const [inspection, spendReady, availability] = result;
      return (
        inspection.status === 'verified' &&
        (inspection.verifiedContentType === 'audio/wav' ||
          inspection.verifiedContentType === 'audio/x-wav') &&
        inspection.durationMs >= 1 &&
        inspection.durationMs <= 60_000 &&
        spendReady === true &&
        availability.status === 'ready' &&
        availability.scope === 'catalog-access-only'
      );
    } catch {
      return false;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      controller.abort();
      wav.fill(0);
    }
  };

  const check = (): Promise<boolean> => {
    if (closing) return Promise.resolve(false);
    const nowMs = dependencies.clock();
    if (
      cachedReadiness !== undefined &&
      Number.isFinite(nowMs) &&
      nowMs >= cachedReadiness.checkedAtMs &&
      nowMs - cachedReadiness.checkedAtMs <= dependencies.readinessTtlMs
    ) {
      return Promise.resolve(cachedReadiness.ready);
    }
    if (readinessInFlight !== undefined) return readinessInFlight;
    const release = beginOperation();
    if (release === undefined) return Promise.resolve(false);
    readinessInFlight = runReadiness()
      .then((ready) => {
        const result = ready === true && !closing;
        cachedReadiness = Object.freeze({
          checkedAtMs: dependencies.clock(),
          ready: result,
        });
        return result;
      })
      .catch(() => false)
      .finally(() => {
        release();
        readinessInFlight = undefined;
      });
    return readinessInFlight;
  };

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true;
      cachedReadiness = undefined;
      if (activeOperations > 0) {
        await new Promise<void>((resolve) => {
          resolveDrain = resolve;
        });
      }
      apiKeyBytes?.fill(0);
      apiKeyBytes = undefined;
      transport = undefined;
      inspector = undefined;
      costCalculator = undefined;
    })();
    return closePromise;
  };

  return Object.freeze({
    binding: Object.freeze({ service, check }),
    close,
  });
};
