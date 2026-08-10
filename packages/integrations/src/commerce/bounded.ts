const MAX_INPUT_DEPTH = 32;
const MAX_INPUT_NODES = 20_000;
const MAX_STRING_LENGTH = 20_000;

/** Rejects cycles, accessors, exotic prototypes, and oversized input graphs. */
export const isBoundedAcyclicData = (input: unknown): boolean => {
  const pending: Array<{
    readonly value: unknown;
    readonly depth: number;
    readonly exiting?: boolean;
  }> = [{ value: input, depth: 0 }];
  const activePath = new WeakSet<object>();
  let nodes = 0;

  try {
    while (pending.length > 0) {
      const current = pending.pop()!;
      nodes += 1;
      if (nodes > MAX_INPUT_NODES || current.depth > MAX_INPUT_DEPTH) {
        return false;
      }

      const value = current.value;
      if (current.exiting) {
        if (value !== null && typeof value === 'object') {
          activePath.delete(value);
        }
        continue;
      }
      if (value === null || typeof value === 'boolean') continue;
      if (typeof value === 'string') {
        if (value.length > MAX_STRING_LENGTH) return false;
        continue;
      }
      if (typeof value === 'number' && Number.isFinite(value)) continue;
      if (typeof value !== 'object' || activePath.has(value)) return false;

      const prototype = Object.getPrototypeOf(value);
      if (
        !Array.isArray(value) &&
        prototype !== Object.prototype &&
        prototype !== null
      ) {
        return false;
      }

      activePath.add(value);
      pending.push({ value, depth: current.depth, exiting: true });
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === 'symbol' || key === '__proto__') return false;
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          return false;
        }
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    }
  } catch {
    return false;
  }

  return true;
};
