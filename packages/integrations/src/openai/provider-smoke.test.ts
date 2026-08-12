import { describe, expect, it } from 'vitest';

import {
  runOpenAiAudioEndpointSmoke,
  type OpenAiAudioSmokeAdapter,
  type OpenAiTranscriptionInput,
} from './index.js';

const spend = {
  transcriptionDefault: {
    executionId: 'smoke-transcribe-mini-0001',
    reservationId: 'smoke-reservation-mini-0001',
  },
  transcriptionAccuracyRetry: {
    executionId: 'smoke-transcribe-full-0001',
    reservationId: 'smoke-reservation-full-0001',
  },
  speech: {
    executionId: 'smoke-speech-00000000001',
    reservationId: 'smoke-reservation-speech-001',
  },
};

describe('runOpenAiAudioEndpointSmoke', () => {
  it('exercises all endpoint/model pairs and retains only safe metadata', async () => {
    let retainedWav: Uint8Array | undefined;
    let disposed = false;
    const adapter: OpenAiAudioSmokeAdapter = {
      speechModel: 'tts-1',
      async transcribe(input: OpenAiTranscriptionInput) {
        retainedWav = input.audio;
        return {
          status: 'completed' as const,
          model:
            input.attempt === 'accuracy-retry'
              ? 'gpt-4o-transcribe'
              : 'gpt-4o-mini-transcribe',
        };
      },
      async createSpeech() {
        return {
          status: 'completed' as const,
          model: 'tts-1',
          audio: {
            dispose() {
              disposed = true;
            },
          },
        };
      },
    };
    let monotonic = 100;

    const result = await runOpenAiAudioEndpointSmoke({
      adapter,
      spend,
      clock: () => new Date('2026-08-09T18:00:00.000Z'),
      monotonicNowMs: () => {
        monotonic += 3;
        return monotonic;
      },
    });

    expect(result).toEqual({
      schemaVersion: 1,
      status: 'ready',
      checkedAt: '2026-08-09T18:00:00.000Z',
      checks: [
        {
          operation: 'transcription',
          endpoint: '/v1/audio/transcriptions',
          model: 'gpt-4o-mini-transcribe',
          status: 'available',
          latencyMs: 3,
        },
        {
          operation: 'transcription-accuracy-retry',
          endpoint: '/v1/audio/transcriptions',
          model: 'gpt-4o-transcribe',
          status: 'available',
          latencyMs: 3,
        },
        {
          operation: 'speech',
          endpoint: '/v1/audio/speech',
          model: 'tts-1',
          status: 'available',
          latencyMs: 3,
        },
      ],
    });
    expect(disposed).toBe(true);
    expect(retainedWav).toBeDefined();
    expect(retainedWav!.every((byte) => byte === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('RIFF');
    expect(Object.keys(result).sort()).toEqual([
      'checkedAt',
      'checks',
      'schemaVersion',
      'status',
    ]);
    for (const check of result.checks) {
      expect(check).not.toHaveProperty('text');
      expect(check).not.toHaveProperty('audio');
      expect(check).not.toHaveProperty('body');
      expect(check).not.toHaveProperty('prompt');
      expect(check).not.toHaveProperty('transcript');
    }
  });

  it('redacts thrown provider failures and still runs independent checks', async () => {
    let transcriptionCalls = 0;
    const adapter: OpenAiAudioSmokeAdapter = {
      speechModel: 'gpt-4o-mini-tts',
      async transcribe() {
        transcriptionCalls += 1;
        throw new Error('sk-proj-secret raw synthetic audio');
      },
      async createSpeech() {
        return {
          status: 'failed' as const,
          safeError: { code: 'audio-provider-unavailable' as const },
        };
      },
    };

    const result = await runOpenAiAudioEndpointSmoke({ adapter, spend });

    expect(result.status).toBe('unavailable');
    expect(transcriptionCalls).toBe(2);
    expect(result.checks.map((check) => check.safeErrorCode)).toEqual([
      'smoke-run-failed',
      'smoke-run-failed',
      'audio-provider-unavailable',
    ]);
    expect(JSON.stringify(result)).not.toContain('sk-proj-secret');
    expect(JSON.stringify(result)).not.toContain('synthetic audio');
  });
});
