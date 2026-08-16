import { deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

const MAX_INPUT_DEPTH = 64;
const MAX_INPUT_NODES = 100_000;

export interface FinanceSafeError {
  readonly code: string;
  readonly message: string;
}

export const financeSafeError = (
  code: string,
  message: string,
): FinanceSafeError => deepFreeze({ code, message });

/**
 * Rejects cycles, accessors, exotic prototypes, and unreasonably large graphs
 * before a schema is allowed to inspect untrusted input.
 */
export const isBoundedAcyclicFinanceInput = (input: unknown): boolean => {
  const pending: {
    readonly value: unknown;
    readonly depth: number;
    readonly exiting?: boolean;
  }[] = [{ value: input, depth: 0 }];
  const activePath = new WeakSet<object>();
  let visited = 0;

  try {
    while (pending.length > 0) {
      const entry = pending.pop()!;
      visited += 1;
      if (visited > MAX_INPUT_NODES || entry.depth > MAX_INPUT_DEPTH) {
        return false;
      }

      const value = entry.value;
      if (entry.exiting) {
        if (value !== null && typeof value === 'object') {
          activePath.delete(value);
        }
        continue;
      }

      if (
        value === null ||
        value === undefined ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        continue;
      }
      if (typeof value !== 'object' || activePath.has(value)) return false;

      const prototype = Object.getPrototypeOf(value);
      if (Array.isArray(value)) {
        if (prototype !== Array.prototype) return false;
      } else if (prototype !== Object.prototype && prototype !== null) {
        return false;
      }

      activePath.add(value);
      pending.push({ value, depth: entry.depth, exiting: true });
      for (const key of Reflect.ownKeys(
        Object.getOwnPropertyDescriptors(value),
      )) {
        if (typeof key === 'symbol') return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          return false;
        }
        pending.push({ value: descriptor.value, depth: entry.depth + 1 });
      }
    }
  } catch {
    return false;
  }

  return true;
};

export type BoundedParseResult<Output> =
  | { readonly success: true; readonly data: Output }
  | { readonly success: false };

export const boundedFinanceParse = <Output>(
  schema: z.ZodType<Output>,
  input: unknown,
): BoundedParseResult<Output> => {
  if (!isBoundedAcyclicFinanceInput(input)) return { success: false };
  try {
    const parsed = schema.safeParse(input);
    return parsed.success
      ? { success: true, data: parsed.data }
      : { success: false };
  } catch {
    return { success: false };
  }
};
