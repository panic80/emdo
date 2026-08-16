import { describe, expect, it, vi } from 'vitest';

import {
  createProductionAudioInspector,
  type AudioInspectionWorkerRunner,
} from './audio-inspector.js';
import { inspectOwnedAudioBytes } from './audio-inspector-worker.js';

const createMonoPcmWav = (durationMs: number): Uint8Array => {
  const sampleRate = 8_000;
  const sampleCount = Math.floor((sampleRate * durationMs) / 1_000);
  const dataBytes = sampleCount * 2;
  const output = new Uint8Array(44 + dataBytes);
  const view = new DataView(output.buffer);
  const ascii = (offset: number, text: string) => {
    for (const [index, character] of [...text].entries()) {
      output[offset + index] = character.charCodeAt(0);
    }
  };
  ascii(0, 'RIFF');
  view.setUint32(4, output.byteLength - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return output;
};

const parsedRunner = (
  detectedMimeType: string,
  durationMs = 1_000,
): AudioInspectionWorkerRunner =>
  vi.fn(async () => ({
    status: 'parsed' as const,
    detectedMimeType,
    durationMs,
  }));

describe('production audio inspector worker', () => {
  it('derives duration and detected type from real in-memory WAV bytes', async () => {
    const audio = createMonoPcmWav(250);

    await expect(inspectOwnedAudioBytes(audio)).resolves.toEqual({
      status: 'parsed',
      detectedMimeType: 'audio/wav',
      durationMs: 250,
    });
    expect(audio.every((byte) => byte === 0)).toBe(true);
  });

  it('rejects malformed bytes and still zeroes the worker-owned view', async () => {
    const audio = new Uint8Array([1, 2, 3, 4]);

    await expect(inspectOwnedAudioBytes(audio)).resolves.toEqual({
      status: 'rejected',
      code: 'container',
    });
    expect([...audio]).toEqual([0, 0, 0, 0]);
  });
});

describe('production audio inspector boundary', () => {
  it.each([
    ['audio/webm', 'video/webm'],
    ['audio/mpeg', 'audio/mpeg'],
    ['audio/mp4', 'video/mp4'],
    ['audio/ogg', 'application/ogg'],
    ['audio/wav', 'audio/wav'],
    ['audio/x-wav', 'audio/vnd.wave'],
  ] as const)(
    'accepts declared %s only for its detected family %s',
    async (declaredContentType, detectedMimeType) => {
      const inspector = createProductionAudioInspector({
        runWorker: parsedRunner(detectedMimeType),
      });

      await expect(
        inspector.inspectRecording({
          audio: new Uint8Array([1, 2, 3]),
          declaredContentType,
          durationHintMs: 1_000,
          maximumDurationMs: 60_000,
        }),
      ).resolves.toEqual({
        status: 'verified',
        verifiedContentType: declaredContentType,
        durationMs: 1_000,
      });
    },
  );

  it('copies bytes before delegating and preserves the caller-owned view', async () => {
    const audio = new Uint8Array([9, 8, 7]);
    const runWorker: AudioInspectionWorkerRunner = vi.fn(async (ownedAudio) => {
      ownedAudio.fill(0);
      return {
        status: 'parsed',
        detectedMimeType: 'video/webm',
        durationMs: 1_000,
      };
    });
    const inspector = createProductionAudioInspector({ runWorker });

    await inspector.inspectRecording({
      audio,
      declaredContentType: 'audio/webm',
      durationHintMs: 1_000,
      maximumDurationMs: 60_000,
    });

    expect([...audio]).toEqual([9, 8, 7]);
    expect(runWorker).toHaveBeenCalledTimes(1);
    expect(runWorker).not.toHaveBeenCalledWith(audio);
  });

  it('accepts successful worker ownership transfer without touching the detached sender view', async () => {
    const inspector = createProductionAudioInspector({
      runWorker: async (ownedAudio) => {
        const transferred = structuredClone(ownedAudio, {
          transfer: [ownedAudio.buffer],
        });
        transferred.fill(0);
        return {
          status: 'parsed' as const,
          detectedMimeType: 'video/webm',
          durationMs: 1_000,
        };
      },
    });

    await expect(
      inspector.inspectRecording({
        audio: new Uint8Array([1, 2, 3]),
        declaredContentType: 'audio/webm',
        durationHintMs: 1_000,
        maximumDurationMs: 60_000,
      }),
    ).resolves.toEqual({
      status: 'verified',
      verifiedContentType: 'audio/webm',
      durationMs: 1_000,
    });
  });

  it('rejects MIME mismatch, missing duration, implausible hint, and over-duration', async () => {
    const inspect = async (
      runWorker: AudioInspectionWorkerRunner,
      durationHintMs = 1_000,
    ) =>
      createProductionAudioInspector({ runWorker }).inspectRecording({
        audio: new Uint8Array([1]),
        declaredContentType: 'audio/webm',
        durationHintMs,
        maximumDurationMs: 60_000 as const,
      });

    await expect(inspect(parsedRunner('audio/mpeg'))).resolves.toEqual({
      status: 'rejected',
      code: 'audio-container-invalid',
    });
    await expect(
      inspect(async () => ({ status: 'rejected', code: 'duration' })),
    ).resolves.toEqual({
      status: 'rejected',
      code: 'audio-duration-invalid',
    });
    await expect(
      inspect(parsedRunner('video/webm', 10_000), 1_000),
    ).resolves.toEqual({
      status: 'rejected',
      code: 'audio-duration-invalid',
    });
    await expect(
      inspect(parsedRunner('video/webm', 60_001), 60_000),
    ).resolves.toEqual({
      status: 'rejected',
      code: 'audio-duration-invalid',
    });
  });

  it('maps malformed results, worker errors, and deadline expiry to unavailable', async () => {
    const inspect = (runWorker: AudioInspectionWorkerRunner) =>
      createProductionAudioInspector({
        runWorker,
        timeoutMs: 10,
      }).inspectRecording({
        audio: new Uint8Array([1]),
        declaredContentType: 'audio/webm',
        durationHintMs: 1_000,
        maximumDurationMs: 60_000,
      });

    await expect(
      inspect(async () => ({
        status: 'parsed',
        detectedMimeType: 'video/webm',
      })),
    ).resolves.toEqual({
      status: 'rejected',
      code: 'audio-inspector-unavailable',
    });
    await expect(
      inspect(async () => {
        throw new Error('private parser detail');
      }),
    ).resolves.toEqual({
      status: 'rejected',
      code: 'audio-inspector-unavailable',
    });
    await expect(
      inspect(async () => new Promise(() => undefined)),
    ).resolves.toEqual({
      status: 'rejected',
      code: 'audio-inspector-unavailable',
    });
  });

  it('rejects accessor-backed inputs before worker execution', async () => {
    const runWorker = parsedRunner('video/webm');
    const inspector = createProductionAudioInspector({ runWorker });
    const input = Object.defineProperty(
      {
        audio: new Uint8Array([1]),
        declaredContentType: 'audio/webm',
        durationHintMs: 1_000,
        maximumDurationMs: 60_000 as const,
      },
      'audio',
      { get: () => new Uint8Array([1]) },
    );

    await expect(inspector.inspectRecording(input)).resolves.toEqual({
      status: 'rejected',
      code: 'audio-container-invalid',
    });
    expect(runWorker).not.toHaveBeenCalled();
  });
});
