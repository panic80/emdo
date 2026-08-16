import { Worker } from 'node:worker_threads';

import { z } from 'zod';

import type { VoiceGateway } from '../services/contracts.js';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const DEFAULT_INSPECTION_TIMEOUT_MS = 2_000;

const DeclaredContentTypeSchema = z.enum([
  'audio/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
]);

type DeclaredContentType = z.output<typeof DeclaredContentTypeSchema>;

const detectedFamilies = Object.freeze({
  'audio/webm': new Set(['audio/webm', 'video/webm']),
  'audio/mpeg': new Set(['audio/mpeg']),
  'audio/mp4': new Set(['audio/mp4', 'video/mp4']),
  'audio/ogg': new Set([
    'application/ogg',
    'audio/ogg',
    'audio/opus',
    'video/ogg',
  ]),
  'audio/wav': new Set(['audio/vnd.wave', 'audio/wav', 'audio/x-wav']),
  'audio/x-wav': new Set(['audio/vnd.wave', 'audio/wav', 'audio/x-wav']),
} satisfies Readonly<Record<DeclaredContentType, ReadonlySet<string>>>);

const WorkerResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('parsed'),
    detectedMimeType: z.string().min(1).max(128),
    durationMs: z.number().int().safe().positive(),
  }),
  z.strictObject({
    status: z.literal('rejected'),
    code: z.enum(['container', 'duration']),
  }),
]);

export type AudioInspectionWorkerRunner = (
  ownedAudio: Uint8Array,
  signal: AbortSignal,
) => Promise<unknown>;

const runAudioInspectionWorker: AudioInspectionWorkerRunner = (
  ownedAudio,
  signal,
) =>
  new Promise((resolve, reject) => {
    const transferBuffer = ownedAudio.buffer;
    if (signal.aborted || !(transferBuffer instanceof ArrayBuffer)) {
      reject(new Error('audio-inspector-aborted'));
      return;
    }
    const worker = new Worker(
      new URL('./audio-inspector-worker.js', import.meta.url),
      {
        workerData: { audio: ownedAudio },
        transferList: [transferBuffer],
      },
    );
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      worker.removeAllListeners();
      void worker.terminate().catch(() => undefined);
      callback();
    };
    const onAbort = () =>
      settle(() => reject(new Error('audio-inspector-aborted')));
    signal.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (message: unknown) =>
      settle(() => resolve(message)),
    );
    worker.once('error', () =>
      settle(() => reject(new Error('audio-inspector-worker-failed'))),
    );
    worker.once('exit', (code) => {
      if (code !== 0) {
        settle(() => reject(new Error('audio-inspector-worker-failed')));
      }
    });
  });

const rejected = (
  code:
    | 'audio-container-invalid'
    | 'audio-duration-invalid'
    | 'audio-inspector-unavailable',
) => Object.freeze({ status: 'rejected' as const, code });

const snapshotInspectionInput = (input: unknown) => {
  try {
    if (
      input === null ||
      typeof input !== 'object' ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const expected = [
      'audio',
      'declaredContentType',
      'durationHintMs',
      'maximumDurationMs',
    ];
    if (
      Object.keys(descriptors).length !== expected.length ||
      expected.some((name) => {
        const descriptor = descriptors[name];
        return (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        );
      })
    ) {
      return undefined;
    }
    return Object.freeze({
      audio: descriptors.audio!.value as unknown,
      declaredContentType: descriptors.declaredContentType!.value as unknown,
      durationHintMs: descriptors.durationHintMs!.value as unknown,
      maximumDurationMs: descriptors.maximumDurationMs!.value as unknown,
    });
  } catch {
    return undefined;
  }
};

export const createProductionAudioInspector = (input?: {
  readonly runWorker?: AudioInspectionWorkerRunner;
  readonly timeoutMs?: number;
}): Pick<VoiceGateway, 'inspectRecording'> => {
  const runWorker = input?.runWorker ?? runAudioInspectionWorker;
  const timeoutMs = input?.timeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS;
  if (
    typeof runWorker !== 'function' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 10_000
  ) {
    throw new Error('invalid-audio-inspector-configuration');
  }

  return Object.freeze({
    inspectRecording: async (rawInput) => {
      const snapshot = snapshotInspectionInput(rawInput);
      if (snapshot === undefined) return rejected('audio-container-invalid');
      const declared = DeclaredContentTypeSchema.safeParse(
        snapshot.declaredContentType,
      );
      if (
        !declared.success ||
        !(snapshot.audio instanceof Uint8Array) ||
        Object.getPrototypeOf(snapshot.audio) !== Uint8Array.prototype ||
        !(snapshot.audio.buffer instanceof ArrayBuffer) ||
        snapshot.audio.byteLength < 1 ||
        snapshot.audio.byteLength > MAX_AUDIO_BYTES
      ) {
        return rejected('audio-container-invalid');
      }
      if (
        !Number.isSafeInteger(snapshot.durationHintMs) ||
        (snapshot.durationHintMs as number) < 1 ||
        snapshot.maximumDurationMs !== 60_000
      ) {
        return rejected('audio-duration-invalid');
      }

      const ownedAudio = new Uint8Array(snapshot.audio);
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, rejectDeadline) => {
        timeout = setTimeout(() => {
          controller.abort();
          rejectDeadline(new Error('audio-inspector-timeout'));
        }, timeoutMs);
        timeout.unref();
      });
      let rawResult: unknown;
      try {
        rawResult = await Promise.race([
          Promise.resolve().then(() =>
            runWorker(ownedAudio, controller.signal),
          ),
          deadline,
        ]);
      } catch {
        return rejected('audio-inspector-unavailable');
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        controller.abort();
        // The production runner transfers this buffer to the worker, which
        // becomes its sole owner and zeroes it there. Injected/in-process
        // runners leave the view attached, so erase it here as well.
        if (ownedAudio.byteLength > 0) ownedAudio.fill(0);
      }

      const result = WorkerResultSchema.safeParse(rawResult);
      if (!result.success) return rejected('audio-inspector-unavailable');
      if (result.data.status === 'rejected') {
        return rejected(
          result.data.code === 'duration'
            ? 'audio-duration-invalid'
            : 'audio-container-invalid',
        );
      }
      if (!detectedFamilies[declared.data].has(result.data.detectedMimeType)) {
        return rejected('audio-container-invalid');
      }
      if (result.data.durationMs > snapshot.maximumDurationMs) {
        return rejected('audio-duration-invalid');
      }
      const hintToleranceMs = Math.max(
        1_000,
        Math.ceil(result.data.durationMs * 0.1),
      );
      if (
        Math.abs(result.data.durationMs - (snapshot.durationHintMs as number)) >
        hintToleranceMs
      ) {
        return rejected('audio-duration-invalid');
      }
      return Object.freeze({
        status: 'verified' as const,
        verifiedContentType: declared.data,
        durationMs: result.data.durationMs,
      });
    },
  });
};
