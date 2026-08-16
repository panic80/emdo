import { createHash } from 'node:crypto';

import {
  ProductionOpenAiAudioCostCalculator,
  type OpenAiAudioTransport,
} from '@emdo/integrations/openai';
import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { VoiceGateway } from '../services/contracts.js';
import {
  createProductionVoiceProviderBinding,
  type ProductionVoiceProviderDependencies,
  type ProductionVoiceSpendLedger,
} from './voice-services.js';

const ids = Object.freeze({
  user: '87500000-0000-4000-8000-000000000001',
  session: '87500000-0000-4000-8000-000000000002',
  request: '87500000-0000-4000-8000-000000000003',
  household: '87500000-0000-4000-8000-000000000004',
  grant: '87500000-0000-4000-8000-000000000005',
});
const principal = Object.freeze({
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  role: 'owner' as const,
  emailVerified: true as const,
  spaceAccessGrantId: ids.grant,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('a'.repeat(64)),
});
const pricing = Object.freeze({
  schemaVersion: 1 as const,
  pricingVersion: 'openai-audio-2026-08-15',
  transcriptionCadMicrosPerMinute: Object.freeze({
    'gpt-4o-mini-transcribe': 600_000,
    'gpt-4o-transcribe': 1_200_000,
  }),
  speechCadMicrosPerMillionCharacters: Object.freeze({
    'tts-1': 10_000_000,
    'tts-1-hd': 20_000_000,
    'gpt-4o-mini-tts': 30_000_000,
    'gpt-4o-mini-tts-2025-12-15': 40_000_000,
  }),
});
const validEnvironment = Object.freeze({
  EMDO_OPENAI_AUDIO_API_KEY: `sk-proj-${'x'.repeat(40)}`,
  EMDO_OPENAI_SPEECH_MODEL: 'tts-1',
  EMDO_OPENAI_AUDIO_PRICING_B64URL: Buffer.from(
    JSON.stringify(pricing),
    'utf8',
  ).toString('base64url'),
});
const pool = Object.freeze({}) as Parameters<
  ProductionVoiceProviderDependencies['checkSpendReady']
>[0];

const sha256Json = (input: readonly unknown[]) =>
  createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const makeLedger = (): ProductionVoiceSpendLedger => ({
  reserve: vi.fn(async (request) => ({
    status: 'reserved' as const,
    warning: true,
    period: request.period,
    projectedCadMinor: request.estimatedCadMinor,
    reservationId: request.reservationId,
  })),
  markDispatched: vi.fn(async ({ reservationId }) => ({
    status: 'dispatched' as const,
    period: '2026-08',
    reservationId,
  })),
  release: vi.fn(async ({ reservationId }) => ({
    status: 'released' as const,
    period: '2026-08',
    reservationId,
  })),
  settle: vi.fn(async ({ reservationId, actualCadMinor }) => ({
    status: 'settled' as const,
    period: '2026-08',
    reservationId,
    actualCadMinor,
    reservationExceeded: false,
  })),
});

const makeTransport = (): OpenAiAudioTransport => ({
  transcribe: vi.fn(async (request) => {
    await request.onDispatch();
    return {
      body: {
        text: 'Buy milk',
        usage: {
          type: 'tokens',
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12,
        },
      },
      providerRequestId: 'openai-transcription-request-0001',
    };
  }),
  createSpeech: vi.fn(async (request) => {
    await request.onDispatch();
    return {
      audio: new Uint8Array([1, 2, 3, 4]),
      contentType: 'audio/mpeg',
      providerRequestId: 'openai-speech-request-0000001',
    };
  }),
  checkModel: vi.fn(async (model) => ({
    status: 'available' as const,
    resolvedModel: model,
  })),
});

const makeDependencies = (
  input: Readonly<{
    ledger?: ProductionVoiceSpendLedger;
    transport?: OpenAiAudioTransport;
    nowMs?: number;
    checkSpendReady?: () => Promise<boolean>;
    inspectRecording?: VoiceGateway['inspectRecording'];
  }> = {},
) => {
  const ledger = input.ledger ?? makeLedger();
  const transport = input.transport ?? makeTransport();
  let nowMs = input.nowMs ?? Date.parse('2026-08-15T16:00:00.000Z');
  let capturedGetApiKey: (() => string) | undefined;
  const dependencies: ProductionVoiceProviderDependencies = {
    createAudioInspector: () => ({
      inspectRecording:
        input.inspectRecording ??
        (vi.fn(async ({ declaredContentType, durationHintMs }) => ({
          status: 'verified' as const,
          verifiedContentType: declaredContentType as
            | 'audio/webm'
            | 'audio/mpeg'
            | 'audio/mp4'
            | 'audio/ogg'
            | 'audio/wav'
            | 'audio/x-wav',
          durationMs: durationHintMs,
        })) as VoiceGateway['inspectRecording']),
    }),
    createCostCalculator: (parsedPricing) =>
      new ProductionOpenAiAudioCostCalculator(parsedPricing),
    createTransport: ({ getApiKey }) => {
      capturedGetApiKey = getApiKey;
      return transport;
    },
    createSpendLedger: vi.fn(() => ledger),
    checkSpendReady: vi.fn(input.checkSpendReady ?? (async () => true)),
    fetch: vi.fn(),
    clock: () => nowMs,
    readinessTtlMs: 30_000,
    readinessTimeoutMs: 2_000,
  };
  return {
    dependencies,
    ledger,
    transport,
    advanceClock: (milliseconds: number) => {
      nowMs += milliseconds;
    },
    getCapturedApiKey: () => capturedGetApiKey,
  };
};

const createBinding = (dependencies: ProductionVoiceProviderDependencies) => {
  const composition = createProductionVoiceProviderBinding(
    { environment: validEnvironment, pool },
    dependencies,
  );
  if (composition.binding === undefined) {
    throw new Error('Expected the test voice binding to be available');
  }
  return { composition, binding: composition.binding };
};

describe('production voice provider composition', () => {
  it('fails closed for absent, partial, malformed, or unsupported configuration', () => {
    const { dependencies } = makeDependencies();
    for (const environment of [
      {},
      { EMDO_OPENAI_AUDIO_API_KEY: validEnvironment.EMDO_OPENAI_AUDIO_API_KEY },
      { ...validEnvironment, EMDO_OPENAI_AUDIO_API_KEY: 'private key text' },
      { ...validEnvironment, EMDO_OPENAI_SPEECH_MODEL: 'gpt-4o-tts' },
      { ...validEnvironment, EMDO_OPENAI_AUDIO_PRICING_B64URL: 'not-json' },
    ]) {
      expect(
        createProductionVoiceProviderBinding(
          { environment, pool },
          dependencies,
        ),
      ).toEqual({});
    }
  });

  it('constructs provider-free and exposes the exact speech configuration', async () => {
    const harness = makeDependencies();
    const { composition, binding } = createBinding(harness.dependencies);

    expect(harness.transport.transcribe).not.toHaveBeenCalled();
    expect(harness.transport.createSpeech).not.toHaveBeenCalled();
    expect(harness.transport.checkModel).not.toHaveBeenCalled();
    await expect(binding.service.getSpeechConfiguration()).resolves.toEqual({
      model: 'tts-1',
      configurationVersion: sha256Json([
        'emdo.openai-speech-configuration.v1',
        'tts-1',
        pricing.pricingVersion,
      ]),
    });
    expect(harness.getCapturedApiKey()?.()).toBe(
      validEnvironment.EMDO_OPENAI_AUDIO_API_KEY,
    );
    await composition.close?.();
    expect(() => harness.getCapturedApiKey()?.()).toThrow(
      'voice-provider-closed',
    );
  });

  it('derives exact request-bound spend hashes and uses verified media duration', async () => {
    const audio = new Uint8Array([11, 22, 33, 44]);
    const harness = makeDependencies({
      inspectRecording: vi.fn(async () => ({
        status: 'verified' as const,
        verifiedContentType: 'audio/webm' as const,
        durationMs: 1_250,
      })),
    });
    const { binding } = createBinding(harness.dependencies);

    await expect(
      binding.service.transcribe({
        audio,
        contentType: 'audio/webm',
        durationMs: 1_300,
        attempt: 'default',
        model: 'gpt-4o-mini-transcribe',
        principal,
        requestId: ids.request,
        executionId: 'voice-transcription-execution-0001',
        reservationId: 'voice-transcription-reservation-0001',
      }),
    ).resolves.toEqual({
      status: 'completed',
      transcript: 'Buy milk',
      model: 'gpt-4o-mini-transcribe',
      spendWarning: true,
    });

    const audioDigest = createHash('sha256').update(audio).digest('hex');
    const requestHash = sha256Json([
      'emdo.openai-audio-request.v1',
      'transcription',
      'gpt-4o-mini-transcribe',
      'default',
      1_250,
      'audio/webm',
      audio.byteLength,
      audioDigest,
      pricing.pricingVersion,
    ]);
    const authorizationHash = sha256Json([
      'emdo.openai-audio-authorization.v1',
      'transcription',
      ids.household,
      ids.user,
      ids.session,
      ids.request,
      ids.grant,
      principal.collectionAuthorizationScopeFingerprint,
      'voice-transcription-execution-0001',
      'voice-transcription-reservation-0001',
      requestHash,
    ]);
    expect(harness.dependencies.createSpendLedger).toHaveBeenCalledWith(pool, {
      userId: ids.user,
      sessionId: ids.session,
      requestId: ids.request,
      householdId: ids.household,
    });
    expect(harness.ledger.reserve).toHaveBeenCalledWith(
      {
        authorizationHash,
        category: 'audio',
        estimatedCadMinor: 2,
        executionId: 'voice-transcription-execution-0001',
        householdId: ids.household,
        period: '2026-08',
        requestHash,
        reservationId: 'voice-transcription-reservation-0001',
      },
      { warningCadMinor: 5_000, limitCadMinor: 7_500 },
    );
    expect(harness.ledger.markDispatched).toHaveBeenCalledWith({
      authorizationHash,
      reservationId: 'voice-transcription-reservation-0001',
    });
    expect(harness.ledger.settle).toHaveBeenCalledWith({
      actualCadMinor: 2,
      executionId: 'voice-transcription-execution-0001',
      reservationId: 'voice-transcription-reservation-0001',
    });
    expect(audio).toEqual(new Uint8Array([11, 22, 33, 44]));
  });

  it('releases a known-undispatched reservation and fences an unknown provider outcome', async () => {
    const beforeDispatchLedger = makeLedger();
    const beforeDispatch = makeDependencies({
      ledger: beforeDispatchLedger,
      transport: {
        ...makeTransport(),
        transcribe: vi.fn(async () => {
          throw new Error('private network failure');
        }),
      },
    });
    const { binding: beforeDispatchBinding } = createBinding(
      beforeDispatch.dependencies,
    );
    await expect(
      beforeDispatchBinding.service.transcribe({
        audio: new Uint8Array([1, 2, 3]),
        contentType: 'audio/webm',
        durationMs: 1_000,
        attempt: 'default',
        model: 'gpt-4o-mini-transcribe',
        principal,
        requestId: ids.request,
        executionId: 'voice-release-execution-0000001',
        reservationId: 'voice-release-reservation-0000001',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      reconciliationRequired: false,
      safeError: { code: 'audio-provider-unavailable' },
    });
    expect(beforeDispatchLedger.release).toHaveBeenCalledOnce();

    const afterDispatchLedger = makeLedger();
    const afterDispatch = makeDependencies({
      ledger: afterDispatchLedger,
      transport: {
        ...makeTransport(),
        transcribe: vi.fn(async (request) => {
          await request.onDispatch();
          throw new Error('private provider outcome');
        }),
      },
    });
    const { binding: afterDispatchBinding } = createBinding(
      afterDispatch.dependencies,
    );
    await expect(
      afterDispatchBinding.service.transcribe({
        audio: new Uint8Array([1, 2, 3]),
        contentType: 'audio/webm',
        durationMs: 1_000,
        attempt: 'default',
        model: 'gpt-4o-mini-transcribe',
        principal,
        requestId: ids.request,
        executionId: 'voice-fenced-execution-0000001',
        reservationId: 'voice-fenced-reservation-0000001',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      reconciliationRequired: true,
      safeError: { code: 'audio-provider-unavailable' },
    });
    expect(afterDispatchLedger.markDispatched).toHaveBeenCalledOnce();
    expect(afterDispatchLedger.release).not.toHaveBeenCalled();
  });

  it('transfers speech bytes exactly once after spend settlement', async () => {
    const providerAudio = new Uint8Array([9, 8, 7, 6]);
    const transport = makeTransport();
    transport.createSpeech = vi.fn(async (request) => {
      await request.onDispatch();
      return { audio: providerAudio, contentType: 'audio/mpeg' };
    });
    const harness = makeDependencies({ transport });
    const { binding } = createBinding(harness.dependencies);

    const result = await binding.service.speak({
      text: 'Hello',
      voice: 'alloy',
      principal,
      requestId: ids.request,
      executionId: 'voice-speech-execution-0000001',
      reservationId: 'voice-speech-reservation-0000001',
    });

    expect(result).toEqual({
      status: 'completed',
      audio: new Uint8Array([9, 8, 7, 6]),
      contentType: 'audio/mpeg',
      model: 'tts-1',
      spendWarning: true,
    });
    expect(providerAudio).toEqual(new Uint8Array(4));
    expect(harness.ledger.settle).toHaveBeenCalledOnce();
  });

  it('coalesces and briefly caches the complete readiness check', async () => {
    const spendReady = deferred<boolean>();
    const harness = makeDependencies({
      checkSpendReady: () => spendReady.promise,
    });
    const { binding } = createBinding(harness.dependencies);

    const first = binding.check();
    const second = binding.check();
    expect(first).toBe(second);
    expect(harness.dependencies.checkSpendReady).toHaveBeenCalledOnce();
    spendReady.resolve(true);
    await expect(first).resolves.toBe(true);
    expect(harness.transport.checkModel).toHaveBeenCalledTimes(3);

    await expect(binding.check()).resolves.toBe(true);
    expect(harness.dependencies.checkSpendReady).toHaveBeenCalledOnce();
    harness.advanceClock(30_001);
    await expect(binding.check()).resolves.toBe(true);
    expect(harness.dependencies.checkSpendReady).toHaveBeenCalledTimes(2);
    expect(harness.transport.checkModel).toHaveBeenCalledTimes(6);
  });

  it('rejects new work and drains an active request before disposing configuration', async () => {
    const response = deferred<{
      body: unknown;
      providerRequestId?: string;
    }>();
    const transport = makeTransport();
    transport.transcribe = vi.fn(async (request) => {
      await request.onDispatch();
      return response.promise;
    });
    const harness = makeDependencies({ transport });
    const { composition, binding } = createBinding(harness.dependencies);
    const active = binding.service.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      contentType: 'audio/webm',
      durationMs: 1_000,
      attempt: 'default',
      model: 'gpt-4o-mini-transcribe',
      principal,
      requestId: ids.request,
      executionId: 'voice-drain-execution-00000001',
      reservationId: 'voice-drain-reservation-00000001',
    });
    await vi.waitFor(() =>
      expect(harness.ledger.markDispatched).toHaveBeenCalledOnce(),
    );

    let closed = false;
    const close = composition.close?.().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(
      binding.service.transcribe({
        audio: new Uint8Array([4]),
        contentType: 'audio/webm',
        durationMs: 1_000,
        attempt: 'default',
        model: 'gpt-4o-mini-transcribe',
        principal,
        requestId: ids.request,
        executionId: 'voice-closed-execution-0000001',
        reservationId: 'voice-closed-reservation-0000001',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      safeError: { code: 'audio-provider-unavailable' },
    });

    response.resolve({
      body: {
        text: 'Drained',
        usage: {
          type: 'tokens',
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        },
      },
    });
    await expect(active).resolves.toMatchObject({ status: 'completed' });
    await close;
    expect(closed).toBe(true);
  });
});
