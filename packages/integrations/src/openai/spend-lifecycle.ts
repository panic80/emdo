import type {
  OpenAiAudioSpendContext,
  OpenAiAudioSpendGuard,
} from './contracts.js';

type ReleaseReservation = (
  context: OpenAiAudioSpendContext,
) => Promise<boolean>;

const cloneSpendContext = (
  context: OpenAiAudioSpendContext,
): OpenAiAudioSpendContext =>
  Object.freeze({
    executionId: context.executionId,
    reservationId: context.reservationId,
  });

const safeSpendStatus = (input: unknown): string => {
  try {
    if (input === null || typeof input !== 'object') return 'invalid';
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return 'invalid';
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Object.values(descriptors).some(
        (descriptor) =>
          descriptor.get !== undefined || descriptor.set !== undefined,
      )
    ) {
      return 'invalid';
    }
    const status = descriptors.status?.value as unknown;
    return typeof status === 'string' ? status : 'invalid';
  } catch {
    return 'invalid';
  }
};

/**
 * Builds a pending reserve operation in this helper's lexical environment so
 * no request object or caller-owned audio can be retained by a hung promise.
 */
export const createReserveSpendOperation = (
  context: OpenAiAudioSpendContext,
  estimatedCadMinor: number,
  reserve: OpenAiAudioSpendGuard['reserve'],
): (() => Promise<string>) => {
  const detachedContext = cloneSpendContext(context);
  const reservation = Object.freeze({
    ...detachedContext,
    estimatedCadMinor,
  });
  return async () => {
    try {
      return safeSpendStatus(await reserve(reservation));
    } catch {
      return 'invalid';
    }
  };
};

/**
 * Builds the late-resolution callback outside the request frame. Its closure
 * owns only cloned spend IDs and an already-bound release function.
 */
export const createLateReservationReleaseCallback = (
  context: OpenAiAudioSpendContext,
  releaseReservation: ReleaseReservation,
): ((status: string) => void) => {
  const detachedContext = cloneSpendContext(context);
  const release = releaseReservation;
  return (status) => {
    if (status !== 'reserved') return;
    try {
      void release(detachedContext).catch(() => undefined);
    } catch {
      // Reconciliation remains required when best-effort release cannot start.
    }
  };
};
