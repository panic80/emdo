import { describe, expect, it } from 'vitest';

import {
  OPENAI_AUDIO_LIMITS,
  OPENAI_AUDIO_MODELS,
  OPENAI_AUDIO_SMOKE_CONTRACT,
  OpenAiAudioAdapter,
  OpenAiAudioTransportError,
  type OpenAiAudioCostCalculator,
  type OpenAiAudioSpendGuard,
  type OpenAiAudioTransport,
  type OpenAiModelAvailabilityTransportResult,
  type OpenAiSpeechTransportRequest,
  type OpenAiSpeechTransportResponse,
  type OpenAiTranscriptionTransportRequest,
  type OpenAiTranscriptionTransportResponse,
} from './index.js';

const spendContext = {
  executionId: 'voice-execution-0001',
  reservationId: 'voice-reservation-0001',
};

class RecordingSpendGuard implements OpenAiAudioSpendGuard {
  readonly events: string[] = [];
  reserveStatus: 'reserved' | 'blocked' | 'invalid' | 'throw' = 'reserved';
  markDispatchedHook?: () => Promise<unknown>;
  settleHook?: () => Promise<unknown>;
  releaseHook?: () => Promise<unknown>;
  reserveHook?: () => Promise<unknown>;

  async reserve(input: {
    readonly executionId: string;
    readonly reservationId: string;
    readonly estimatedCadMinor: number;
  }): Promise<unknown> {
    this.events.push(`reserve:${input.estimatedCadMinor}`);
    if (this.reserveHook !== undefined) return this.reserveHook();
    if (this.reserveStatus === 'throw') {
      throw new Error('reserve committed before response was lost');
    }
    if (this.reserveStatus === 'invalid') {
      return { status: 'unknown-provider-state' };
    }
    if (this.reserveStatus === 'blocked') {
      return {
        status: 'blocked',
        safeError: {
          code: 'provider-message-must-not-escape',
          message: 'secret provider detail',
          retryable: false,
        },
      };
    }
    return { status: 'reserved' };
  }

  async markDispatched(): Promise<unknown> {
    this.events.push('dispatched');
    if (this.markDispatchedHook !== undefined) {
      return this.markDispatchedHook();
    }
    return { status: 'dispatched' };
  }

  async settle(input: {
    readonly executionId: string;
    readonly reservationId: string;
    readonly actualCadMinor: number;
  }): Promise<unknown> {
    this.events.push(`settled:${input.actualCadMinor}`);
    if (this.settleHook !== undefined) return this.settleHook();
    return { status: 'settled' };
  }

  async release(): Promise<unknown> {
    this.events.push('released');
    if (this.releaseHook !== undefined) return this.releaseHook();
    return { status: 'released' };
  }
}

class FixedCostCalculator implements OpenAiAudioCostCalculator {
  readonly version = 'openai-audio-test-v1';
  readonly estimates: unknown[] = [];
  readonly actuals: unknown[] = [];
  estimateValue = 7;
  actualValue = 5;
  actualHook?: (input: unknown) => number | Promise<number>;
  estimateHook?: (input: unknown) => number | Promise<number>;

  estimateCadMinor(input: unknown): number | Promise<number> {
    this.estimates.push(input);
    return this.estimateHook?.(input) ?? this.estimateValue;
  }

  actualCadMinor(input: unknown): number | Promise<number> {
    this.actuals.push(input);
    return this.actualHook?.(input) ?? this.actualValue;
  }
}

class RecordingTransport implements OpenAiAudioTransport {
  readonly transcriptionRequests: OpenAiTranscriptionTransportRequest[] = [];
  readonly speechRequests: OpenAiSpeechTransportRequest[] = [];
  readonly modelRequests: string[] = [];
  retainedTranscriptionAudio?: Uint8Array;
  transcriptionPreDispatchFailure?: unknown;
  transcriptionFailure?: unknown;
  speechFailure?: unknown;
  unavailableModel?: string;
  invalidActualCost = false;
  waitForTranscriptionAbort = false;
  hangTranscriptionAfterDispatch = false;
  hangSpeechAfterDispatch = false;
  transcriptionResponse: OpenAiTranscriptionTransportResponse = {
    body: {
      text: 'Book the dentist next Tuesday.',
      usage: {
        type: 'tokens',
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        input_token_details: { audio_tokens: 10, text_tokens: 1 },
      },
    },
    providerRequestId: 'req_transcription_1',
  };
  speechResponse: OpenAiSpeechTransportResponse = {
    audio: new Uint8Array([1, 2, 3, 4]),
    contentType: 'audio/mpeg',
    providerRequestId: 'req_speech_1',
  };

  async transcribe(
    request: OpenAiTranscriptionTransportRequest,
  ): Promise<OpenAiTranscriptionTransportResponse> {
    this.transcriptionRequests.push(request);
    this.retainedTranscriptionAudio = request.audio;
    if (this.transcriptionPreDispatchFailure !== undefined) {
      throw this.transcriptionPreDispatchFailure;
    }
    await request.onDispatch();
    if (this.hangTranscriptionAfterDispatch) {
      await new Promise<never>(() => undefined);
    }
    if (this.transcriptionFailure !== undefined) {
      throw this.transcriptionFailure;
    }
    if (this.waitForTranscriptionAbort) {
      await new Promise<void>((_resolve, reject) => {
        const rejectAborted = () =>
          reject(
            new OpenAiAudioTransportError({
              kind: 'request-aborted',
              retryable: true,
            }),
          );
        if (request.signal.aborted) rejectAborted();
        else
          request.signal.addEventListener('abort', rejectAborted, {
            once: true,
          });
      });
    }
    return this.transcriptionResponse;
  }

  async createSpeech(
    request: OpenAiSpeechTransportRequest,
  ): Promise<OpenAiSpeechTransportResponse> {
    this.speechRequests.push(request);
    await request.onDispatch();
    if (this.hangSpeechAfterDispatch) {
      await new Promise<never>(() => undefined);
    }
    if (this.speechFailure !== undefined) throw this.speechFailure;
    return this.speechResponse;
  }

  async checkModel(
    model: string,
  ): Promise<OpenAiModelAvailabilityTransportResult> {
    this.modelRequests.push(model);
    if (model === this.unavailableModel) {
      throw new Error('sk-proj-secret model lookup detail');
    }
    return { status: 'available', resolvedModel: model };
  }
}

const createHarness = () => {
  const transport = new RecordingTransport();
  const spend = new RecordingSpendGuard();
  const costs = new FixedCostCalculator();
  const adapter = new OpenAiAudioAdapter({
    transport,
    spendGuard: spend,
    costCalculator: costs,
    clock: () => new Date('2026-08-09T15:00:00.000Z'),
    timeoutMs: 10_000,
  });
  return { adapter, costs, spend, transport };
};

const validTranscriptionInput = () => ({
  audio: new Uint8Array([10, 20, 30, 40]),
  mimeType: 'audio/webm' as const,
  durationMs: 3_000,
  language: 'en',
  attempt: 'initial' as const,
  spend: spendContext,
});

describe('OpenAiAudioAdapter transcription', () => {
  it('uses mini transcribe initially, settles spend, and wipes its bounded audio copy', async () => {
    const { adapter, costs, spend, transport } = createHarness();
    const input = validTranscriptionInput();

    await expect(adapter.transcribe(input)).resolves.toMatchObject({
      status: 'completed',
      model: OPENAI_AUDIO_MODELS.transcriptionDefault,
      attempt: 'initial',
      text: 'Book the dentist next Tuesday.',
      response: {
        headers: {
          'cache-control': 'no-store, private',
          'content-type': 'application/json; charset=utf-8',
        },
      },
    });

    expect(transport.transcriptionRequests).toHaveLength(1);
    expect(transport.transcriptionRequests[0]).toMatchObject({
      model: 'gpt-4o-mini-transcribe',
      mimeType: 'audio/webm',
      fileName: 'voice.webm',
      responseFormat: 'json',
    });
    expect(transport.retainedTranscriptionAudio).not.toBe(input.audio);
    expect([...transport.retainedTranscriptionAudio!]).toEqual([0, 0, 0, 0]);
    expect([...input.audio]).toEqual([10, 20, 30, 40]);
    expect(spend.events).toEqual(['reserve:7', 'dispatched', 'settled:5']);
    expect(costs.estimates).toHaveLength(1);
    expect(costs.actuals).toHaveLength(1);
  });

  it('settles an actual charge above the reservation without rounding it down', async () => {
    const { adapter, costs, spend } = createHarness();
    costs.actualValue = 11;

    const result = await adapter.transcribe(validTranscriptionInput());

    expect(result).toMatchObject({
      status: 'completed',
      spend: { estimatedCadMinor: 7, actualCadMinor: 11 },
    });
    expect(spend.events).toEqual(['reserve:7', 'dispatched', 'settled:11']);
  });

  it('uses gpt-4o-transcribe only for an explicit accuracy retry', async () => {
    const { adapter, transport } = createHarness();

    const result = await adapter.transcribe({
      ...validTranscriptionInput(),
      attempt: 'accuracy-retry',
      spend: {
        executionId: 'voice-execution-0002',
        reservationId: 'voice-reservation-0002',
      },
    });

    expect(result).toMatchObject({
      status: 'completed',
      model: OPENAI_AUDIO_MODELS.transcriptionAccuracyRetry,
      attempt: 'accuracy-retry',
    });
    expect(transport.transcriptionRequests[0]?.model).toBe('gpt-4o-transcribe');
  });

  it.each([
    [{ ...validTranscriptionInput(), durationMs: 60_001 }, 'duration'],
    [{ ...validTranscriptionInput(), durationMs: 0 }, 'duration'],
    [{ ...validTranscriptionInput(), audio: new Uint8Array() }, 'empty'],
    [{ ...validTranscriptionInput(), mimeType: 'text/plain' }, 'media type'],
  ])(
    'rejects invalid bounded input before spend or transport (%s)',
    async (input) => {
      const { adapter, spend, transport } = createHarness();

      await expect(adapter.transcribe(input)).resolves.toMatchObject({
        status: 'failed',
        safeError: { code: 'audio-request-invalid', retryable: false },
      });
      expect(spend.events).toEqual([]);
      expect(transport.transcriptionRequests).toEqual([]);
    },
  );

  it('rejects audio above the in-memory byte limit before copying or spending', async () => {
    const { adapter, spend, transport } = createHarness();
    const audio = new Uint8Array(OPENAI_AUDIO_LIMITS.maxTranscriptionBytes + 1);

    await expect(
      adapter.transcribe({ ...validTranscriptionInput(), audio }),
    ).resolves.toMatchObject({
      status: 'failed',
      safeError: { code: 'audio-request-invalid' },
    });
    expect(spend.events).toEqual([]);
    expect(transport.transcriptionRequests).toEqual([]);
  });

  it('does not dispatch when the shared monthly spend guard blocks audio', async () => {
    const { adapter, spend, transport } = createHarness();
    spend.reserveStatus = 'blocked';

    const result = await adapter.transcribe(validTranscriptionInput());

    expect(result).toMatchObject({
      status: 'failed',
      safeError: {
        code: 'monthly-ai-spend-limit-reached',
        message: 'The monthly AI spend limit has been reached.',
        retryable: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret provider detail');
    expect(spend.events).toEqual(['reserve:7']);
    expect(transport.transcriptionRequests).toEqual([]);
  });

  it.each(['throw', 'invalid'] as const)(
    'marks an ambiguous reserve outcome for reconciliation (%s)',
    async (reserveStatus) => {
      const { adapter, spend, transport } = createHarness();
      spend.reserveStatus = reserveStatus;

      const result = await adapter.transcribe(validTranscriptionInput());

      expect(result).toMatchObject({
        status: 'failed',
        reconciliationRequired: true,
        safeError: { code: 'audio-spend-accounting-failed' },
      });
      expect(spend.events).toEqual(['reserve:7']);
      expect(transport.transcriptionRequests).toEqual([]);
    },
  );

  it('leaves ambiguous dispatched spend for reconciliation and redacts provider failures', async () => {
    const { adapter, spend, transport } = createHarness();
    transport.transcriptionFailure = new Error(
      'sk-proj-secret raw-audio-content Book the dentist',
    );

    const result = await adapter.transcribe(validTranscriptionInput());

    expect(result).toMatchObject({
      status: 'failed',
      safeError: {
        code: 'audio-provider-unavailable',
        retryable: true,
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sk-proj-secret');
    expect(serialized).not.toContain('Book the dentist');
    expect(result).toMatchObject({ reconciliationRequired: true });
    expect(spend.events).toEqual(['reserve:7', 'dispatched']);
    expect([...transport.retainedTranscriptionAudio!]).toEqual([0, 0, 0, 0]);
  });

  it('releases a reservation when transport fails conclusively before dispatch', async () => {
    const { adapter, spend, transport } = createHarness();
    transport.transcriptionPreDispatchFailure = new Error(
      'credential lookup failed with sk-proj-secret',
    );

    const result = await adapter.transcribe(validTranscriptionInput());

    expect(result).toMatchObject({
      status: 'failed',
      reconciliationRequired: false,
      safeError: { code: 'audio-provider-unavailable' },
    });
    expect(spend.events).toEqual(['reserve:7', 'released']);
  });

  it('does not estimate, reserve, or dispatch when cancellation is already known', async () => {
    const { adapter, spend, transport } = createHarness();
    const controller = new AbortController();
    controller.abort();

    const result = await adapter.transcribe(
      validTranscriptionInput(),
      controller.signal,
    );

    expect(result).toMatchObject({
      status: 'failed',
      reconciliationRequired: false,
      safeError: { code: 'audio-request-cancelled' },
    });
    expect(spend.events).toEqual([]);
    expect(transport.transcriptionRequests).toEqual([]);
  });

  it('hard-times out a hung pre-dispatch estimate without retaining the request', async () => {
    const transport = new RecordingTransport();
    const spend = new RecordingSpendGuard();
    const costs = new FixedCostCalculator();
    costs.estimateHook = async () => new Promise<number>(() => undefined);
    const adapter = new OpenAiAudioAdapter({
      transport,
      spendGuard: spend,
      costCalculator: costs,
      timeoutMs: 5,
    });
    const input = validTranscriptionInput();

    const result = await Promise.race([
      adapter.transcribe(input),
      new Promise<'did-not-settle'>((resolve) =>
        setTimeout(() => resolve('did-not-settle'), 100),
      ),
    ]);

    expect(result).not.toBe('did-not-settle');
    expect(result).toMatchObject({
      status: 'failed',
      reconciliationRequired: false,
      safeError: { code: 'audio-provider-timeout' },
    });
    expect([...input.audio]).toEqual([10, 20, 30, 40]);
    expect(spend.events).toEqual([]);
    expect(transport.transcriptionRequests).toEqual([]);
  });

  it('hard-times out an ambiguous reserve and releases it if it resolves late', async () => {
    let resolveReserve!: (value: unknown) => void;
    const lateReserve = new Promise<unknown>((resolve) => {
      resolveReserve = resolve;
    });
    const transport = new RecordingTransport();
    const spend = new RecordingSpendGuard();
    spend.reserveHook = async () => lateReserve;
    const adapter = new OpenAiAudioAdapter({
      transport,
      spendGuard: spend,
      costCalculator: new FixedCostCalculator(),
      timeoutMs: 5,
    });

    const result = await adapter.transcribe(validTranscriptionInput());

    expect(result).toMatchObject({
      status: 'failed',
      reconciliationRequired: true,
      safeError: { code: 'audio-provider-timeout' },
    });
    expect(spend.events).toEqual(['reserve:7']);
    expect(transport.transcriptionRequests).toEqual([]);

    resolveReserve({ status: 'reserved' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(spend.events).toEqual(['reserve:7', 'released']);
  });

  it('reports timeout and leaves an ambiguous post-dispatch reservation for reconciliation', async () => {
    const transport = new RecordingTransport();
    transport.waitForTranscriptionAbort = true;
    const spend = new RecordingSpendGuard();
    const costs = new FixedCostCalculator();
    const adapter = new OpenAiAudioAdapter({
      transport,
      spendGuard: spend,
      costCalculator: costs,
      timeoutMs: 5,
    });

    const result = await adapter.transcribe(validTranscriptionInput());

    expect(result).toMatchObject({
      status: 'failed',
      reconciliationRequired: true,
      safeError: { code: 'audio-provider-timeout' },
    });
    expect(spend.events).toEqual(['reserve:7', 'dispatched']);
  });

  it('hard-times out a transport that ignores abort and wipes the owned raw audio', async () => {
    const transport = new RecordingTransport();
    transport.hangTranscriptionAfterDispatch = true;
    const spend = new RecordingSpendGuard();
    const adapter = new OpenAiAudioAdapter({
      transport,
      spendGuard: spend,
      costCalculator: new FixedCostCalculator(),
      timeoutMs: 5,
    });

    const result = await Promise.race([
      adapter.transcribe(validTranscriptionInput()),
      new Promise<'did-not-settle'>((resolve) =>
        setTimeout(() => resolve('did-not-settle'), 100),
      ),
    ]);

    expect(result).not.toBe('did-not-settle');
    expect(result).toMatchObject({
      status: 'failed',
      reconciliationRequired: true,
      safeError: { code: 'audio-provider-timeout' },
    });
    expect(
      transport.retainedTranscriptionAudio?.every((byte) => byte === 0),
    ).toBe(true);
    expect(spend.events).toEqual(['reserve:7', 'dispatched']);
  });

  it('bounds post-dispatch actual-cost accounting and releases the raw audio copy', async () => {
    const transport = new RecordingTransport();
    const spend = new RecordingSpendGuard();
    const costs = new FixedCostCalculator();
    costs.actualHook = async () => new Promise<number>(() => undefined);
    const adapter = new OpenAiAudioAdapter({
      transport,
      spendGuard: spend,
      costCalculator: costs,
      timeoutMs: 5,
    });

    const result = await Promise.race([
      adapter.transcribe(validTranscriptionInput()),
      new Promise<'did-not-settle'>((resolve) =>
        setTimeout(() => resolve('did-not-settle'), 100),
      ),
    ]);

    expect(result).not.toBe('did-not-settle');
    expect(result).toMatchObject({
      status: 'failed',
      reconciliationRequired: true,
      safeError: { code: 'audio-provider-timeout' },
    });
    expect(
      transport.retainedTranscriptionAudio?.every((byte) => byte === 0),
    ).toBe(true);
    expect(spend.events).toEqual(['reserve:7', 'dispatched']);
  });

  it('rejects accessor and shared-memory input without invoking untrusted accessors', async () => {
    const { adapter, spend, transport } = createHarness();
    let getterInvoked = false;
    const accessorInput = { ...validTranscriptionInput() } as Record<
      string,
      unknown
    >;
    Object.defineProperty(accessorInput, 'audio', {
      enumerable: true,
      get() {
        getterInvoked = true;
        throw new Error('must not execute');
      },
    });

    await expect(adapter.transcribe(accessorInput)).resolves.toMatchObject({
      status: 'failed',
      safeError: { code: 'audio-request-invalid' },
    });
    await expect(
      adapter.transcribe({
        ...validTranscriptionInput(),
        audio: new Uint8Array(new SharedArrayBuffer(16)),
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      safeError: { code: 'audio-request-invalid' },
    });
    expect(getterInvoked).toBe(false);
    expect(spend.events).toEqual([]);
    expect(transport.transcriptionRequests).toEqual([]);
  });

  it('binds injected methods at construction and rejects accessor-bearing provider output', async () => {
    const { adapter, transport } = createHarness();
    Object.defineProperty(transport, 'transcribe', {
      value: async () => {
        throw new Error('mutated transport method');
      },
    });
    let getterInvoked = false;
    const body = { usage: { type: 'duration', seconds: 1 } } as Record<
      string,
      unknown
    >;
    Object.defineProperty(body, 'text', {
      enumerable: true,
      get() {
        getterInvoked = true;
        throw new Error('must not execute');
      },
    });
    transport.transcriptionResponse = { body };

    const result = await adapter.transcribe(validTranscriptionInput());

    expect(result).toMatchObject({
      status: 'failed',
      reconciliationRequired: true,
      safeError: { code: 'audio-provider-response-invalid' },
    });
    expect(getterInvoked).toBe(false);
  });

  it('rejects an accessor-bearing outer transcription envelope without invoking it', async () => {
    const { adapter, transport } = createHarness();
    let getterInvoked = false;
    const response = {} as Record<string, unknown>;
    Object.defineProperty(response, 'body', {
      enumerable: true,
      get() {
        getterInvoked = true;
        throw new Error('provider accessor must not execute');
      },
    });
    transport.transcriptionResponse = response as never;

    await expect(
      adapter.transcribe(validTranscriptionInput()),
    ).resolves.toMatchObject({
      status: 'failed',
      reconciliationRequired: true,
      safeError: { code: 'audio-provider-response-invalid' },
    });
    expect(getterInvoked).toBe(false);
  });

  it.each([
    {
      type: 'duration',
      seconds: 3,
    },
    {
      type: 'tokens',
      input_tokens: 2,
      output_tokens: 1,
      total_tokens: 4,
    },
  ])('rejects impossible transcription usage %#', async (usage) => {
    const { adapter, spend, transport } = createHarness();
    transport.transcriptionResponse = {
      body: { text: 'Untrusted transcript', usage },
    };

    await expect(
      adapter.transcribe(validTranscriptionInput()),
    ).resolves.toMatchObject({
      status: 'failed',
      reconciliationRequired: true,
      safeError: { code: 'audio-provider-response-invalid' },
    });
    expect(spend.events).toEqual(['reserve:7', 'dispatched']);
  });

  it('maps structured transport rejections without exposing their internals', async () => {
    const { adapter, transport } = createHarness();
    transport.transcriptionFailure = new OpenAiAudioTransportError({
      kind: 'provider-rejected',
      httpStatus: 400,
      retryable: false,
      providerRequestId: 'req_safe_400',
    });

    await expect(
      adapter.transcribe(validTranscriptionInput()),
    ).resolves.toMatchObject({
      status: 'failed',
      safeError: { code: 'audio-provider-rejected', retryable: false },
    });
  });
});

describe('OpenAiAudioAdapter speech', () => {
  it('defaults to the non-deprecated endpoint-valid tts-1 speech model', async () => {
    const { adapter, spend, transport } = createHarness();

    const result = await adapter.createSpeech({
      text: 'Here is your concise household update.',
      spend: spendContext,
    });

    expect(result).toMatchObject({
      status: 'completed',
      model: OPENAI_AUDIO_MODELS.speechDefault,
      voice: 'alloy',
      format: 'mp3',
      response: {
        headers: {
          'cache-control': 'no-store, private',
          'content-type': 'audio/mpeg',
          'x-content-type-options': 'nosniff',
        },
      },
    });
    expect(transport.speechRequests[0]).toMatchObject({
      model: 'tts-1',
      voice: 'alloy',
      responseFormat: 'mp3',
    });
    expect(spend.events).toEqual(['reserve:7', 'dispatched', 'settled:5']);

    if (result.status !== 'completed') throw new Error('expected speech');
    expect(result.audio.byteLength).toBe(4);
    expect([...result.audio.take()]).toEqual([1, 2, 3, 4]);
    expect(() => result.audio.take()).toThrow('Speech audio was already taken');
    expect(result.response.headers).not.toHaveProperty('etag');
  });

  it('zeroes an untaken ephemeral speech response on disposal', async () => {
    const { adapter } = createHarness();
    const result = await adapter.createSpeech({
      text: 'Disposable summary',
      spend: spendContext,
    });
    if (result.status !== 'completed') throw new Error('expected speech');

    result.audio.dispose();

    expect(result.audio.byteLength).toBe(0);
    expect(() => result.audio.take()).toThrow('Speech audio was already taken');
  });

  it('allows an endpoint-valid speech model by server configuration and rejects gpt-4o-tts', async () => {
    const { costs, spend, transport } = createHarness();
    const configured = new OpenAiAudioAdapter({
      transport,
      spendGuard: spend,
      costCalculator: costs,
      speechModel: 'gpt-4o-mini-tts',
    });
    await configured.createSpeech({ text: 'Summary', spend: spendContext });
    expect(transport.speechRequests[0]?.model).toBe('gpt-4o-mini-tts');

    expect(
      () =>
        new OpenAiAudioAdapter({
          transport,
          spendGuard: spend,
          costCalculator: costs,
          // Compile-time invalid on purpose; runtime config must also fail closed.
          speechModel: 'gpt-4o-tts' as never,
        }),
    ).toThrow('invalid-openai-speech-model');
  });

  it('bounds speech input before spend and provider dispatch', async () => {
    const { adapter, spend, transport } = createHarness();

    await expect(
      adapter.createSpeech({
        text: 'x'.repeat(OPENAI_AUDIO_LIMITS.maxSpeechCharacters + 1),
        spend: spendContext,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      safeError: { code: 'audio-request-invalid' },
    });
    expect(spend.events).toEqual([]);
    expect(transport.speechRequests).toEqual([]);
  });

  it('hard-times out pre-dispatch speech accounting that ignores abort', async () => {
    const transport = new RecordingTransport();
    const spend = new RecordingSpendGuard();
    const costs = new FixedCostCalculator();
    costs.estimateHook = async () => new Promise<number>(() => undefined);
    const adapter = new OpenAiAudioAdapter({
      transport,
      spendGuard: spend,
      costCalculator: costs,
      timeoutMs: 5,
    });

    const result = await Promise.race([
      adapter.createSpeech({ text: 'Summary', spend: spendContext }),
      new Promise<'did-not-settle'>((resolve) =>
        setTimeout(() => resolve('did-not-settle'), 100),
      ),
    ]);

    expect(result).not.toBe('did-not-settle');
    expect(result).toMatchObject({
      status: 'failed',
      reconciliationRequired: false,
      safeError: { code: 'audio-provider-timeout' },
    });
    expect(spend.events).toEqual([]);
    expect(transport.speechRequests).toEqual([]);
  });

  it('rejects mismatched provider media without returning untrusted bytes', async () => {
    const { adapter, spend, transport } = createHarness();
    const untrustedAudio = new Uint8Array([9, 8, 7]);
    transport.speechResponse = {
      audio: untrustedAudio,
      contentType: 'text/html',
      providerRequestId: 'req_bad_media',
    };

    const result = await adapter.createSpeech({
      text: 'Summary',
      spend: spendContext,
    });

    expect(result).toMatchObject({
      status: 'failed',
      safeError: { code: 'audio-provider-response-invalid' },
    });
    expect(untrustedAudio).toEqual(new Uint8Array([0, 0, 0]));
    expect(spend.events).toEqual(['reserve:7', 'dispatched', 'settled:5']);
  });

  it('snapshots bounded provider audio before any asynchronous cost or spend work', async () => {
    const { adapter, costs, transport } = createHarness();
    const mutableResponse = {
      audio: new Uint8Array([1, 2, 3, 4]),
      contentType: 'audio/mpeg',
      providerRequestId: 'req_mutable_speech',
    };
    transport.speechResponse = mutableResponse;
    let signalActualStarted!: () => void;
    let releaseActual!: () => void;
    const actualStarted = new Promise<void>((resolve) => {
      signalActualStarted = resolve;
    });
    const allowActual = new Promise<void>((resolve) => {
      releaseActual = resolve;
    });
    costs.actualHook = async () => {
      signalActualStarted();
      await allowActual;
      return 5;
    };

    const pending = adapter.createSpeech({
      text: 'Summary',
      spend: spendContext,
    });
    await actualStarted;
    mutableResponse.audio = new Uint8Array(
      OPENAI_AUDIO_LIMITS.maxSpeechBytes + 1,
    );
    releaseActual();
    const result = await pending;

    expect(result).toMatchObject({ status: 'completed' });
    if (result.status !== 'completed') throw new Error('expected speech');
    expect(result.audio.byteLength).toBe(4);
    expect([...result.audio.take()]).toEqual([1, 2, 3, 4]);
    expect(costs.actuals).toContainEqual(
      expect.objectContaining({ outputBytes: 4 }),
    );
    mutableResponse.audio.fill(0);
  });

  it('rejects an accessor-bearing speech envelope without invoking it', async () => {
    const { adapter, transport } = createHarness();
    let getterInvoked = false;
    const response = {
      contentType: 'audio/mpeg',
    } as Record<string, unknown>;
    Object.defineProperty(response, 'audio', {
      enumerable: true,
      get() {
        getterInvoked = true;
        throw new Error('provider accessor must not execute');
      },
    });
    transport.speechResponse = response as never;

    await expect(
      adapter.createSpeech({ text: 'Summary', spend: spendContext }),
    ).resolves.toMatchObject({
      status: 'failed',
      reconciliationRequired: true,
      safeError: { code: 'audio-provider-response-invalid' },
    });
    expect(getterInvoked).toBe(false);
  });

  it('hard-times out speech transport that ignores abort', async () => {
    const transport = new RecordingTransport();
    transport.hangSpeechAfterDispatch = true;
    const spend = new RecordingSpendGuard();
    const adapter = new OpenAiAudioAdapter({
      transport,
      spendGuard: spend,
      costCalculator: new FixedCostCalculator(),
      timeoutMs: 5,
    });

    const result = await Promise.race([
      adapter.createSpeech({ text: 'Summary', spend: spendContext }),
      new Promise<'did-not-settle'>((resolve) =>
        setTimeout(() => resolve('did-not-settle'), 100),
      ),
    ]);

    expect(result).not.toBe('did-not-settle');
    expect(result).toMatchObject({
      status: 'failed',
      reconciliationRequired: true,
      safeError: { code: 'audio-provider-timeout' },
    });
    expect(spend.events).toEqual(['reserve:7', 'dispatched']);
  });

  it('bounds post-dispatch settlement and zeroes transferred provider audio', async () => {
    const transport = new RecordingTransport();
    const providerAudio = new Uint8Array([9, 8, 7, 6]);
    transport.speechResponse = {
      audio: providerAudio,
      contentType: 'audio/mpeg',
    };
    const spend = new RecordingSpendGuard();
    spend.settleHook = async () => new Promise<unknown>(() => undefined);
    const adapter = new OpenAiAudioAdapter({
      transport,
      spendGuard: spend,
      costCalculator: new FixedCostCalculator(),
      timeoutMs: 5,
    });

    const result = await Promise.race([
      adapter.createSpeech({ text: 'Summary', spend: spendContext }),
      new Promise<'did-not-settle'>((resolve) =>
        setTimeout(() => resolve('did-not-settle'), 100),
      ),
    ]);

    expect(result).not.toBe('did-not-settle');
    expect(result).toMatchObject({
      status: 'failed',
      reconciliationRequired: true,
      safeError: { code: 'audio-provider-timeout' },
    });
    expect([...providerAudio]).toEqual([0, 0, 0, 0]);
    expect(spend.events).toEqual(['reserve:7', 'dispatched', 'settled:5']);
  });

  it('zeroes a speech response that resolves only after the adapter timeout', async () => {
    let resolveLate!: (response: OpenAiSpeechTransportResponse) => void;
    const lateResponse = new Promise<OpenAiSpeechTransportResponse>(
      (resolve) => {
        resolveLate = resolve;
      },
    );
    const baseTransport = new RecordingTransport();
    const transport: OpenAiAudioTransport = {
      transcribe: baseTransport.transcribe.bind(baseTransport),
      async createSpeech(request) {
        await request.onDispatch();
        return lateResponse;
      },
      checkModel: baseTransport.checkModel.bind(baseTransport),
    };
    const adapter = new OpenAiAudioAdapter({
      transport,
      spendGuard: new RecordingSpendGuard(),
      costCalculator: new FixedCostCalculator(),
      timeoutMs: 5,
    });

    const result = await adapter.createSpeech({
      text: 'Summary',
      spend: spendContext,
    });
    expect(result).toMatchObject({
      status: 'failed',
      reconciliationRequired: true,
      safeError: { code: 'audio-provider-timeout' },
    });

    const lateAudio = new Uint8Array([4, 3, 2, 1]);
    resolveLate({ audio: lateAudio, contentType: 'audio/mpeg' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect([...lateAudio]).toEqual([0, 0, 0, 0]);
  });
});

describe('OpenAiAudioAdapter model smoke contract', () => {
  it('declares live endpoint-compatible checks for all three configured models', () => {
    expect(OPENAI_AUDIO_SMOKE_CONTRACT).toEqual({
      schemaVersion: 1,
      liveProviderRequired: true,
      fixturePolicy: 'synthetic-nonsensitive-memory-only',
      persist: ['model', 'operation', 'checkedAt', 'status', 'latencyMs'],
      checks: [
        {
          operation: 'transcription',
          endpoint: '/v1/audio/transcriptions',
          model: 'gpt-4o-mini-transcribe',
        },
        {
          operation: 'transcription-accuracy-retry',
          endpoint: '/v1/audio/transcriptions',
          model: 'gpt-4o-transcribe',
        },
        {
          operation: 'speech',
          endpoint: '/v1/audio/speech',
          model: 'tts-1',
        },
      ],
    });
  });

  it('checks the exact configured transcription and speech models without a model run', async () => {
    const { adapter, spend, transport } = createHarness();

    const result = await adapter.checkModelAvailability();

    expect(result).toEqual({
      schemaVersion: 1,
      scope: 'catalog-access-only',
      status: 'ready',
      checkedAt: '2026-08-09T15:00:00.000Z',
      models: [
        {
          purpose: 'transcription-default',
          model: 'gpt-4o-mini-transcribe',
          status: 'available',
        },
        {
          purpose: 'transcription-accuracy-retry',
          model: 'gpt-4o-transcribe',
          status: 'available',
        },
        {
          purpose: 'speech-default',
          model: 'tts-1',
          status: 'available',
        },
      ],
    });
    expect(transport.modelRequests).toEqual([
      'gpt-4o-mini-transcribe',
      'gpt-4o-transcribe',
      'tts-1',
    ]);
    expect(spend.events).toEqual([]);
  });

  it('reports safe unavailable state when a model lookup leaks a secret', async () => {
    const { adapter, transport } = createHarness();
    transport.unavailableModel = 'gpt-4o-transcribe';

    const result = await adapter.checkModelAvailability();

    expect(result).toMatchObject({
      status: 'unavailable',
      models: [
        { status: 'available' },
        {
          purpose: 'transcription-accuracy-retry',
          model: 'gpt-4o-transcribe',
          status: 'unavailable',
          reason: 'provider-unavailable',
        },
        { status: 'available' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('sk-proj-secret');
  });
});
