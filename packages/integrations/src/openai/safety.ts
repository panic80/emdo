export const snapshotPlainRecord = (
  input: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = allowedKeys,
): Readonly<Record<string, unknown>> | undefined => {
  try {
    if (input === null || typeof input !== 'object') return undefined;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(input);
    if (
      keys.some(
        (key) => typeof key !== 'string' || !allowedKeys.includes(key),
      ) ||
      requiredKeys.some((key) => !keys.includes(key))
    ) {
      return undefined;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== 'string') return undefined;
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        return undefined;
      }
      snapshot[key] = descriptor.value as unknown;
    }
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
};

export const isBoundedAcyclicPlainData = (
  input: unknown,
  limits: Readonly<{ maxDepth: number; maxNodes: number }>,
): boolean => {
  const pending: Array<{ value: unknown; depth: number; exit?: true }> = [
    { value: input, depth: 0 },
  ];
  const active = new WeakSet<object>();
  let nodes = 0;
  try {
    while (pending.length > 0) {
      const item = pending.pop()!;
      nodes += 1;
      if (nodes > limits.maxNodes || item.depth > limits.maxDepth) return false;
      if (item.exit) {
        if (item.value !== null && typeof item.value === 'object') {
          active.delete(item.value);
        }
        continue;
      }
      if (item.value === null || typeof item.value !== 'object') {
        if (
          item.value === undefined ||
          typeof item.value === 'bigint' ||
          typeof item.value === 'function' ||
          typeof item.value === 'symbol'
        ) {
          return false;
        }
        continue;
      }
      if (active.has(item.value)) return false;
      const prototype = Object.getPrototypeOf(item.value);
      if (
        !Array.isArray(item.value) &&
        prototype !== Object.prototype &&
        prototype !== null
      ) {
        return false;
      }
      active.add(item.value);
      pending.push({ value: item.value, depth: item.depth, exit: true });
      const descriptors = Object.getOwnPropertyDescriptors(item.value);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') return false;
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          return false;
        }
        pending.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    }
  } catch {
    return false;
  }
  return true;
};

export const bindDataMethod = <T extends (...args: never[]) => unknown>(
  target: object,
  name: string,
): T => {
  let cursor: object | null = target;
  while (cursor !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
    if (descriptor !== undefined) {
      if (
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        typeof descriptor.value !== 'function'
      ) {
        throw new Error('invalid-openai-audio-dependency');
      }
      return descriptor.value.bind(target) as T;
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  throw new Error('invalid-openai-audio-dependency');
};

export const readDataProperty = (target: object, name: string): unknown => {
  let cursor: object | null = target;
  while (cursor !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
    if (descriptor !== undefined) {
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new Error('invalid-openai-audio-dependency');
      }
      return descriptor.value as unknown;
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return undefined;
};

export const isSafeIdentifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 16 &&
  value.length <= 200 &&
  /^[A-Za-z0-9:._-]+$/.test(value);

export const isSafeProviderRequestId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= 200 &&
  /^[A-Za-z0-9:._-]+$/.test(value);

export const isPositiveCadMinor = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export const isAbortSignal = (value: unknown): value is AbortSignal =>
  value instanceof AbortSignal;
