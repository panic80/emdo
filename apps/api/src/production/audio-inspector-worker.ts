import { isMainThread, parentPort, workerData } from 'node:worker_threads';

import { fileTypeFromBuffer } from 'file-type';
import { parseBuffer } from 'music-metadata';

export type AudioInspectionWorkerResult = Readonly<
  | {
      status: 'parsed';
      detectedMimeType: string;
      durationMs: number;
    }
  | { status: 'rejected'; code: 'container' | 'duration' }
>;

const containerRejected = Object.freeze({
  status: 'rejected' as const,
  code: 'container' as const,
});
const durationRejected = Object.freeze({
  status: 'rejected' as const,
  code: 'duration' as const,
});

const isOwnedUint8Array = (input: unknown): input is Uint8Array =>
  input instanceof Uint8Array &&
  Object.getPrototypeOf(input) === Uint8Array.prototype &&
  input.buffer instanceof ArrayBuffer;

/** The caller transfers sole ownership of `audio` to this function. */
export const inspectOwnedAudioBytes = async (
  audio: Uint8Array,
): Promise<AudioInspectionWorkerResult> => {
  if (!isOwnedUint8Array(audio) || audio.byteLength < 1) {
    return containerRejected;
  }
  try {
    const [detected, metadata] = await Promise.all([
      fileTypeFromBuffer(audio),
      parseBuffer(
        audio,
        { size: audio.byteLength },
        { duration: true, skipCovers: true },
      ),
    ]);
    const durationSeconds = metadata.format.duration;
    if (
      detected === undefined ||
      typeof detected.mime !== 'string' ||
      detected.mime.length < 1 ||
      detected.mime.length > 128 ||
      typeof metadata.format.codec !== 'string' ||
      metadata.format.codec.length < 1
    ) {
      return containerRejected;
    }
    if (
      typeof durationSeconds !== 'number' ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0
    ) {
      return durationRejected;
    }
    const durationMs = Math.round(durationSeconds * 1_000);
    if (!Number.isSafeInteger(durationMs) || durationMs < 1) {
      return durationRejected;
    }
    return Object.freeze({
      status: 'parsed' as const,
      detectedMimeType: detected.mime,
      durationMs,
    });
  } catch {
    return containerRejected;
  } finally {
    audio.fill(0);
  }
};

const readWorkerAudio = (input: unknown): Uint8Array | undefined => {
  if (input === null || typeof input !== 'object') return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.keys(descriptors).length !== 1) return undefined;
  const descriptor = descriptors.audio;
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !isOwnedUint8Array(descriptor.value)
  ) {
    return undefined;
  }
  return descriptor.value;
};

if (!isMainThread) {
  const ownedAudio = readWorkerAudio(workerData);
  void (
    ownedAudio === undefined
      ? Promise.resolve(containerRejected)
      : inspectOwnedAudioBytes(ownedAudio)
  ).then(
    (result) => parentPort?.postMessage(result),
    () => parentPort?.postMessage(containerRejected),
  );
}
