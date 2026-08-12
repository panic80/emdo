import {
  OPENAI_AUDIO_ENDPOINTS,
  OPENAI_AUDIO_MODELS,
  type OpenAiAudioSafeErrorCode,
  type OpenAiAudioSpendContext,
  type OpenAiSpeechModel,
} from './contracts.js';
import type {
  OpenAiSpeechInput,
  OpenAiTranscriptionInput,
} from './audio-adapter.js';

interface SmokeCompletedTranscription {
  readonly status: 'completed';
  readonly model: string;
}

interface SmokeCompletedSpeech {
  readonly status: 'completed';
  readonly model: string;
  readonly audio: { dispose(): void };
}

interface SmokeFailedResult {
  readonly status: 'failed';
  readonly safeError: { readonly code: OpenAiAudioSafeErrorCode };
}

export interface OpenAiAudioSmokeAdapter {
  readonly speechModel: OpenAiSpeechModel;
  transcribe(
    input: OpenAiTranscriptionInput,
  ): Promise<SmokeCompletedTranscription | SmokeFailedResult>;
  createSpeech(
    input: OpenAiSpeechInput,
  ): Promise<SmokeCompletedSpeech | SmokeFailedResult>;
}

export interface OpenAiAudioEndpointSmokeInput {
  readonly adapter: OpenAiAudioSmokeAdapter;
  readonly spend: Readonly<{
    transcriptionDefault: OpenAiAudioSpendContext;
    transcriptionAccuracyRetry: OpenAiAudioSpendContext;
    speech: OpenAiAudioSpendContext;
  }>;
  readonly clock?: () => Date;
  readonly monotonicNowMs?: () => number;
}

export interface OpenAiAudioEndpointSmokeCheck {
  readonly operation:
    'transcription' | 'transcription-accuracy-retry' | 'speech';
  readonly endpoint:
    | typeof OPENAI_AUDIO_ENDPOINTS.transcription
    | typeof OPENAI_AUDIO_ENDPOINTS.speech;
  readonly model: string;
  readonly status: 'available' | 'unavailable';
  readonly latencyMs: number;
  readonly safeErrorCode?:
    OpenAiAudioSafeErrorCode | 'smoke-run-failed' | 'smoke-model-mismatch';
}

export interface OpenAiAudioEndpointSmokeResult {
  readonly schemaVersion: 1;
  readonly status: 'ready' | 'unavailable';
  readonly checkedAt: string;
  readonly checks: readonly OpenAiAudioEndpointSmokeCheck[];
}

const setAscii = (bytes: Uint8Array, offset: number, value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
};

/** Generates a short valid, non-sensitive PCM WAV signal entirely in memory. */
const createSyntheticWav = (): Uint8Array => {
  const sampleRate = 16_000;
  const durationMs = 250;
  const sampleCount = (sampleRate * durationMs) / 1_000;
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  setAscii(bytes, 0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  setAscii(bytes, 8, 'WAVE');
  setAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  setAscii(bytes, 36, 'data');
  view.setUint32(40, sampleCount * 2, true);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const value = Math.round(
      Math.sin((2 * Math.PI * 440 * sample) / sampleRate) * 2_000,
    );
    view.setInt16(44 + sample * 2, value, true);
  }
  return bytes;
};

const safeLatency = (start: number, end: number): number => {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round(end - start));
};

/**
 * Runs the actual endpoint/model pairs with synthetic, non-sensitive input.
 * It never returns transcript, prompt, or audio bytes; the WAV and speech
 * response are disposed before the function returns.
 */
export const runOpenAiAudioEndpointSmoke = async (
  input: OpenAiAudioEndpointSmokeInput,
): Promise<OpenAiAudioEndpointSmokeResult> => {
  const clock = input.clock ?? (() => new Date());
  const monotonicNowMs = input.monotonicNowMs ?? (() => performance.now());
  const checkedAtDate = new Date(clock());
  if (!Number.isFinite(checkedAtDate.getTime())) {
    throw new Error('invalid-openai-audio-smoke-clock');
  }
  const wav = createSyntheticWav();
  const checks: OpenAiAudioEndpointSmokeCheck[] = [];
  const runTranscription = async (
    operation: 'transcription' | 'transcription-accuracy-retry',
    attempt: 'initial' | 'accuracy-retry',
    expectedModel: string,
    spend: OpenAiAudioSpendContext,
  ) => {
    const start = monotonicNowMs();
    try {
      const result = await input.adapter.transcribe({
        audio: wav,
        mimeType: 'audio/wav',
        durationMs: 250,
        language: 'en',
        attempt,
        spend,
      });
      const latencyMs = safeLatency(start, monotonicNowMs());
      if (result.status === 'completed' && result.model === expectedModel) {
        checks.push(
          Object.freeze({
            operation,
            endpoint: OPENAI_AUDIO_ENDPOINTS.transcription,
            model: expectedModel,
            status: 'available' as const,
            latencyMs,
          }),
        );
      } else {
        checks.push(
          Object.freeze({
            operation,
            endpoint: OPENAI_AUDIO_ENDPOINTS.transcription,
            model: expectedModel,
            status: 'unavailable' as const,
            latencyMs,
            safeErrorCode:
              result.status === 'failed'
                ? result.safeError.code
                : ('smoke-model-mismatch' as const),
          }),
        );
      }
    } catch {
      checks.push(
        Object.freeze({
          operation,
          endpoint: OPENAI_AUDIO_ENDPOINTS.transcription,
          model: expectedModel,
          status: 'unavailable' as const,
          latencyMs: safeLatency(start, monotonicNowMs()),
          safeErrorCode: 'smoke-run-failed' as const,
        }),
      );
    }
  };

  try {
    await runTranscription(
      'transcription',
      'initial',
      OPENAI_AUDIO_MODELS.transcriptionDefault,
      input.spend.transcriptionDefault,
    );
    await runTranscription(
      'transcription-accuracy-retry',
      'accuracy-retry',
      OPENAI_AUDIO_MODELS.transcriptionAccuracyRetry,
      input.spend.transcriptionAccuracyRetry,
    );

    const speechStart = monotonicNowMs();
    try {
      const result = await input.adapter.createSpeech({
        text: 'EMDO provider smoke test.',
        spend: input.spend.speech,
      });
      const latencyMs = safeLatency(speechStart, monotonicNowMs());
      if (
        result.status === 'completed' &&
        result.model === input.adapter.speechModel
      ) {
        result.audio.dispose();
        checks.push(
          Object.freeze({
            operation: 'speech' as const,
            endpoint: OPENAI_AUDIO_ENDPOINTS.speech,
            model: input.adapter.speechModel,
            status: 'available' as const,
            latencyMs,
          }),
        );
      } else {
        if (result.status === 'completed') result.audio.dispose();
        checks.push(
          Object.freeze({
            operation: 'speech' as const,
            endpoint: OPENAI_AUDIO_ENDPOINTS.speech,
            model: input.adapter.speechModel,
            status: 'unavailable' as const,
            latencyMs,
            safeErrorCode:
              result.status === 'failed'
                ? result.safeError.code
                : ('smoke-model-mismatch' as const),
          }),
        );
      }
    } catch {
      checks.push(
        Object.freeze({
          operation: 'speech' as const,
          endpoint: OPENAI_AUDIO_ENDPOINTS.speech,
          model: input.adapter.speechModel,
          status: 'unavailable' as const,
          latencyMs: safeLatency(speechStart, monotonicNowMs()),
          safeErrorCode: 'smoke-run-failed' as const,
        }),
      );
    }
  } finally {
    wav.fill(0);
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    status: checks.every((check) => check.status === 'available')
      ? ('ready' as const)
      : ('unavailable' as const),
    checkedAt: checkedAtDate.toISOString(),
    checks: Object.freeze(checks),
  });
};
