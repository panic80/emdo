import type { z } from 'zod';

const MAX_DEPTH = 32;
const MAX_NODES = 50_000;

/** Rejects accessors, exotic prototypes, cycles, and oversized untrusted input. */
export const isBoundedPlainData = (input: unknown): boolean => {
  const pending: Array<{
    value: unknown;
    depth: number;
    exiting?: boolean;
  }> = [{ value: input, depth: 0 }];
  const active = new WeakSet<object>();
  let nodes = 0;

  try {
    while (pending.length > 0) {
      const current = pending.pop()!;
      nodes += 1;
      if (nodes > MAX_NODES || current.depth > MAX_DEPTH) return false;
      const value = current.value;

      if (current.exiting) {
        if (value !== null && typeof value === 'object') active.delete(value);
        continue;
      }
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === undefined
      ) {
        continue;
      }
      if (typeof value !== 'object' || active.has(value)) return false;
      const prototype = Object.getPrototypeOf(value);
      if (
        !Array.isArray(value) &&
        prototype !== Object.prototype &&
        prototype !== null
      ) {
        return false;
      }

      active.add(value);
      pending.push({ value, depth: current.depth, exiting: true });
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === 'symbol') return false;
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

export const boundedSafeParse = <Output>(
  schema: z.ZodType<Output>,
  input: unknown,
): { success: true; data: Output } | { success: false } => {
  if (!isBoundedPlainData(input)) return { success: false };
  try {
    const parsed = schema.safeParse(input);
    return parsed.success
      ? { success: true, data: parsed.data }
      : { success: false };
  } catch {
    return { success: false };
  }
};
