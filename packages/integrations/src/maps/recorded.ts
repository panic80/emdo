import { deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

const SafeLocationSchema = z.string().trim().min(1).max(512);
export const MapsTravelQuerySchema = z.strictObject({
  origin: SafeLocationSchema,
  destination: SafeLocationSchema,
  mode: z.enum(['driving', 'transit', 'walking']),
  departureAt: z.iso.datetime({ offset: true }),
});

export const MapsTravelResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    durationSeconds: z.number().int().safe().min(0).max(604_800),
    fetchedAt: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum(['no-route', 'provider-unavailable', 'timeout']),
  }),
]);

const RecordedTravelFixtureSchema = z.strictObject({
  query: MapsTravelQuerySchema,
  response: MapsTravelResponseSchema,
});

export type MapsTravelQuery = z.infer<typeof MapsTravelQuerySchema>;
export type MapsTravelResponse = z.infer<typeof MapsTravelResponseSchema>;

const exactQueryKey = (query: MapsTravelQuery): string =>
  JSON.stringify([
    query.origin,
    query.destination,
    query.mode,
    query.departureAt,
  ]);

const isBoundedPlainData = (input: unknown): boolean => {
  const pending: Array<{ value: unknown; depth: number; exit?: true }> = [
    { value: input, depth: 0 },
  ];
  const active = new WeakSet<object>();
  let count = 0;
  try {
    while (pending.length > 0) {
      const item = pending.pop()!;
      count += 1;
      if (count > 50_000 || item.depth > 32) return false;
      if (item.exit) {
        if (item.value !== null && typeof item.value === 'object') {
          active.delete(item.value);
        }
        continue;
      }
      if (item.value === null || typeof item.value !== 'object') continue;
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
      for (const key of Reflect.ownKeys(
        Object.getOwnPropertyDescriptors(item.value),
      )) {
        if (typeof key === 'symbol') return false;
        const descriptor = Object.getOwnPropertyDescriptor(item.value, key);
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

/**
 * Offline adapter for deterministic tests and evals. It has no transport and
 * returns unavailable for every query not present in the recorded evidence.
 */
export class RecordedMapsTravelTimeClient {
  readonly #responses = new Map<string, MapsTravelResponse>();
  #lookupCount = 0;

  constructor(fixtures: readonly unknown[]) {
    if (!isBoundedPlainData(fixtures) || fixtures.length > 10_000) {
      throw new Error('Recorded Maps fixture limit exceeded');
    }
    for (const rawFixture of fixtures) {
      if (!isBoundedPlainData(rawFixture)) {
        throw new Error('Invalid recorded Maps fixture');
      }
      const fixture = RecordedTravelFixtureSchema.parse(rawFixture);
      const key = exactQueryKey(fixture.query);
      if (this.#responses.has(key)) {
        throw new Error('Duplicate recorded Maps query');
      }
      this.#responses.set(key, deepFreeze(fixture.response));
    }
  }

  get lookupCount(): number {
    return this.#lookupCount;
  }

  async lookup(input: unknown): Promise<
    | MapsTravelResponse
    | {
        readonly status: 'unavailable';
        readonly reason: 'not-recorded';
      }
  > {
    this.#lookupCount += 1;
    if (!isBoundedPlainData(input)) {
      return deepFreeze({ status: 'unavailable', reason: 'not-recorded' });
    }
    const parsed = MapsTravelQuerySchema.safeParse(input);
    if (!parsed.success) {
      return deepFreeze({ status: 'unavailable', reason: 'not-recorded' });
    }
    return (
      this.#responses.get(exactQueryKey(parsed.data)) ??
      deepFreeze({ status: 'unavailable', reason: 'not-recorded' as const })
    );
  }
}
