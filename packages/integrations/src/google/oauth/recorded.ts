import {
  JsonValueSchema,
  deepFreeze,
  type DeepReadonly,
  type JsonValue,
} from '@emdo/contracts';
import { z } from 'zod';

import {
  GoogleOAuthTransportFailure,
  type GoogleOAuthTransport,
  type GoogleOAuthTransportFailureReason,
} from './service.js';

const SafeTextSchema = z.string().min(1).max(8_192);
const ExchangeRequestSchema = z.strictObject({
  code: z.string().min(1).max(512),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  clientId: z.string().trim().min(1).max(512),
  clientSecret: SafeTextSchema,
  redirectUri: z.url().refine((value) => new URL(value).protocol === 'https:'),
});
const RefreshRequestSchema = z.strictObject({
  refreshToken: z.string().min(1).max(2_048),
  clientId: z.string().trim().min(1).max(512),
  clientSecret: SafeTextSchema,
});
const RevokeRequestSchema = z.strictObject({
  token: z.string().min(1).max(8_192),
});
const OutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('success'), response: JsonValueSchema }),
  z.strictObject({
    status: z.literal('failure'),
    reason: z.enum([
      'invalid-grant',
      'temporarily-unavailable',
      'provider-rejected',
    ]),
  }),
]);
const FixtureSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('exchange'),
    request: ExchangeRequestSchema,
    outcome: OutcomeSchema,
  }),
  z.strictObject({
    operation: z.literal('refresh'),
    request: RefreshRequestSchema,
    outcome: OutcomeSchema,
  }),
  z.strictObject({
    operation: z.literal('revoke'),
    request: RevokeRequestSchema,
    outcome: OutcomeSchema,
  }),
]);

type FrozenJsonValue = DeepReadonly<JsonValue>;

type RecordedOutcome =
  | { readonly status: 'success'; readonly response: FrozenJsonValue }
  | {
      readonly status: 'failure';
      readonly reason: GoogleOAuthTransportFailureReason;
    };

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
      for (const descriptor of Object.values(
        Object.getOwnPropertyDescriptors(item.value),
      )) {
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
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

const cloneJson = (value: JsonValue): FrozenJsonValue =>
  deepFreeze(JSON.parse(JSON.stringify(value)) as JsonValue);

const exchangeKey = (request: z.infer<typeof ExchangeRequestSchema>): string =>
  JSON.stringify([
    'exchange',
    request.code,
    request.codeVerifier,
    request.clientId,
    request.clientSecret,
    request.redirectUri,
  ]);

const refreshKey = (request: z.infer<typeof RefreshRequestSchema>): string =>
  JSON.stringify([
    'refresh',
    request.refreshToken,
    request.clientId,
    request.clientSecret,
  ]);

const revokeKey = (request: z.infer<typeof RevokeRequestSchema>): string =>
  JSON.stringify(['revoke', request.token]);

export class RecordedGoogleOAuthTransport implements GoogleOAuthTransport {
  readonly #outcomes = new Map<string, RecordedOutcome>();
  readonly #counts = { exchange: 0, refresh: 0, revoke: 0 };

  constructor(fixtures: readonly unknown[]) {
    if (!isBoundedPlainData(fixtures) || fixtures.length > 10_000) {
      throw new Error(
        'Recorded Google OAuth fixtures must be bounded plain data',
      );
    }
    for (const rawFixture of fixtures) {
      if (!isBoundedPlainData(rawFixture)) {
        throw new Error('Recorded Google OAuth fixture must be plain data');
      }
      const fixture = FixtureSchema.parse(rawFixture);
      const key =
        fixture.operation === 'exchange'
          ? exchangeKey(fixture.request)
          : fixture.operation === 'refresh'
            ? refreshKey(fixture.request)
            : revokeKey(fixture.request);
      if (this.#outcomes.has(key)) {
        throw new Error('Duplicate recorded Google OAuth fixture');
      }
      this.#outcomes.set(
        key,
        fixture.outcome.status === 'success'
          ? deepFreeze({
              status: 'success' as const,
              response: cloneJson(fixture.outcome.response),
            })
          : deepFreeze({
              status: 'failure' as const,
              reason: fixture.outcome.reason,
            }),
      );
    }
  }

  get counts() {
    return deepFreeze({ ...this.#counts });
  }

  async exchangeAuthorizationCode(input: unknown) {
    this.#counts.exchange += 1;
    const request = this.#parseInput(ExchangeRequestSchema, input);
    return this.#take(exchangeKey(request));
  }

  async refreshAccessToken(input: unknown) {
    this.#counts.refresh += 1;
    const request = this.#parseInput(RefreshRequestSchema, input);
    return this.#take(refreshKey(request));
  }

  async revokeToken(input: unknown) {
    this.#counts.revoke += 1;
    const request = this.#parseInput(RevokeRequestSchema, input);
    return this.#take(revokeKey(request));
  }

  #parseInput<Output>(schema: z.ZodType<Output>, input: unknown): Output {
    if (!isBoundedPlainData(input)) {
      throw new GoogleOAuthTransportFailure('temporarily-unavailable');
    }
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new GoogleOAuthTransportFailure('temporarily-unavailable');
    }
    return parsed.data;
  }

  #take(key: string): FrozenJsonValue {
    const outcome = this.#outcomes.get(key);
    if (outcome === undefined) {
      throw new GoogleOAuthTransportFailure('temporarily-unavailable');
    }
    this.#outcomes.delete(key);
    if (outcome.status === 'failure') {
      throw new GoogleOAuthTransportFailure(outcome.reason);
    }
    return outcome.response;
  }
}
