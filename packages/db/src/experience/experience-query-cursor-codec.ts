import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  EffectiveAuthorizationScopeFingerprintSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  UuidSchema,
  deepFreeze,
} from '@emdo/contracts';
import { z } from 'zod';

const MAXIMUM_CURSOR_LIFETIME_MS = 300_000;
const MAXIMUM_PREVIOUS_KEYS = 2;
const PREVIOUS_KEY_CLOCK_SKEW_MS = 30_000;
const KeyIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);
const KindSchema = z.enum(['activity', 'schedule', 'finance', 'shopping']);
const ExpectedBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    userId: UuidSchema,
    sessionId: UuidSchema,
    householdId: UuidSchema,
    collectionAuthorizationScopeFingerprint:
      EffectiveAuthorizationScopeFingerprintSchema,
    kind: z.literal('activity'),
  }),
  z.strictObject({
    userId: UuidSchema,
    sessionId: UuidSchema,
    householdId: UuidSchema,
    collectionAuthorizationScopeFingerprint:
      EffectiveAuthorizationScopeFingerprintSchema,
    kind: z.literal('schedule'),
    from: z.iso.date(),
    to: z.iso.date(),
  }),
  z.strictObject({
    userId: UuidSchema,
    sessionId: UuidSchema,
    householdId: UuidSchema,
    collectionAuthorizationScopeFingerprint:
      EffectiveAuthorizationScopeFingerprintSchema,
    kind: z.literal('finance'),
  }),
  z.strictObject({
    userId: UuidSchema,
    sessionId: UuidSchema,
    householdId: UuidSchema,
    collectionAuthorizationScopeFingerprint:
      EffectiveAuthorizationScopeFingerprintSchema,
    kind: z.literal('shopping'),
  }),
]);
const IssueBindingSchema = z.discriminatedUnion('kind', [
  ExpectedBindingSchema.options[0].extend({
    position: z.strictObject({
      occurredAt: IsoDateTimeSchema,
      id: OpaqueReferenceSchema,
    }),
  }),
  ExpectedBindingSchema.options[1].extend({
    position: z.strictObject({
      at: IsoDateTimeSchema,
      id: OpaqueReferenceSchema,
    }),
  }),
  ExpectedBindingSchema.options[2].extend({
    position: z.strictObject({
      at: IsoDateTimeSchema,
      id: OpaqueReferenceSchema,
      entityType: IdentifierSchema,
    }),
  }),
  ExpectedBindingSchema.options[3].extend({
    position: z.strictObject({
      at: IsoDateTimeSchema,
      id: OpaqueReferenceSchema,
    }),
  }),
]);
const AuthenticationCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const CursorEnvelopeSchema = z.tuple([
  z.literal(2),
  KeyIdSchema,
  z.number().int().min(0).max(3),
  z.number().int().nonnegative().safe(),
  OpaqueReferenceSchema,
  IdentifierSchema.nullable(),
  z.number().int().nonnegative().safe(),
  z.number().int().positive().safe(),
  AuthenticationCodeSchema,
]);

export interface ExperienceQueryCursorHmacKey {
  readonly keyId: string;
  readonly secret: Uint8Array;
}

export interface ExperienceQueryCursorPreviousHmacKey extends ExperienceQueryCursorHmacKey {
  readonly issueUntil: string;
  readonly verifyUntil: string;
}

export type ExperienceQueryCursorExpectedBinding = z.input<
  typeof ExpectedBindingSchema
>;
export type ExperienceQueryCursorBinding = z.input<typeof IssueBindingSchema>;

export class ExperienceQueryCursorCodecError extends Error {
  constructor(
    readonly code:
      | 'invalid-config'
      | 'invalid-input'
      | 'integrity-check-failed'
      | 'expired'
      | 'key-unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ExperienceQueryCursorCodecError';
  }
}

interface InternalKey {
  readonly keyId: string;
  readonly secret: Uint8Array;
  readonly issueUntil?: number;
  readonly verifyUntil?: number;
}

const parseKey = (
  input: ExperienceQueryCursorHmacKey,
  retirement?: {
    readonly issueUntil: number;
    readonly verifyUntil: number;
  },
): InternalKey => {
  const keyId = KeyIdSchema.safeParse(input.keyId);
  if (
    !keyId.success ||
    !(input.secret instanceof Uint8Array) ||
    input.secret.byteLength < 32 ||
    input.secret.byteLength > 64
  ) {
    throw new ExperienceQueryCursorCodecError(
      'invalid-config',
      'Experience cursor HMAC key is malformed',
    );
  }
  return {
    keyId: keyId.data,
    secret: new Uint8Array(input.secret),
    ...(retirement === undefined ? {} : retirement),
  };
};

const kindCode = (kind: z.infer<typeof KindSchema>): number =>
  ['activity', 'schedule', 'finance', 'shopping'].indexOf(kind);
const codeKind = (code: number): z.infer<typeof KindSchema> =>
  KindSchema.parse(['activity', 'schedule', 'finance', 'shopping'][code]);

const expectedBindingFor = (
  binding: z.output<typeof IssueBindingSchema>,
): z.output<typeof ExpectedBindingSchema> => {
  const common = {
    userId: binding.userId,
    sessionId: binding.sessionId,
    householdId: binding.householdId,
    collectionAuthorizationScopeFingerprint:
      binding.collectionAuthorizationScopeFingerprint,
    kind: binding.kind,
  };
  return ExpectedBindingSchema.parse(
    binding.kind === 'schedule'
      ? { ...common, from: binding.from, to: binding.to }
      : common,
  );
};

const unsignedEnvelope = (
  keyId: string,
  binding: z.output<typeof IssueBindingSchema>,
  issuedAt: number,
  expiresAt: number,
) => {
  const positionTime =
    binding.kind === 'activity'
      ? binding.position.occurredAt
      : binding.position.at;
  const entityType =
    binding.kind === 'finance' ? binding.position.entityType : null;
  return [
    2,
    keyId,
    kindCode(binding.kind),
    Date.parse(positionTime),
    binding.position.id,
    entityType,
    issuedAt,
    expiresAt,
  ] as const;
};

const authenticationCode = (
  key: InternalKey,
  unsigned: readonly unknown[],
  binding: z.output<typeof ExpectedBindingSchema>,
): string =>
  createHmac('sha256', key.secret)
    .update('emdo.experience-query-cursor.v2\0', 'utf8')
    .update(
      JSON.stringify([
        ...unsigned,
        binding.userId,
        binding.sessionId,
        binding.householdId,
        binding.collectionAuthorizationScopeFingerprint,
        binding.kind,
        binding.kind === 'schedule' ? binding.from : '',
        binding.kind === 'schedule' ? binding.to : '',
      ]),
      'utf8',
    )
    .digest('base64url');

export class ExperienceQueryCursorCodec {
  readonly #current: InternalKey;
  readonly #previous: ReadonlyMap<string, InternalKey>;
  readonly #clock: () => Date;
  readonly #cursorLifetimeMs: number;

  constructor(options: {
    readonly current: ExperienceQueryCursorHmacKey;
    readonly previous?: readonly ExperienceQueryCursorPreviousHmacKey[];
    readonly clock?: () => Date;
    readonly cursorLifetimeMs?: number;
  }) {
    this.#clock = options.clock ?? (() => new Date());
    this.#cursorLifetimeMs =
      options.cursorLifetimeMs ?? MAXIMUM_CURSOR_LIFETIME_MS;
    const now = this.#clock().getTime();
    if (
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(this.#cursorLifetimeMs) ||
      this.#cursorLifetimeMs < 1 ||
      this.#cursorLifetimeMs > MAXIMUM_CURSOR_LIFETIME_MS
    ) {
      throw new ExperienceQueryCursorCodecError(
        'invalid-config',
        'Experience cursor clock or lifetime is invalid',
      );
    }
    this.#current = parseKey(options.current);
    const previous = options.previous ?? [];
    if (previous.length > MAXIMUM_PREVIOUS_KEYS) {
      throw new ExperienceQueryCursorCodecError(
        'invalid-config',
        'Experience cursor key ring has too many previous keys',
      );
    }
    const parsedPrevious = new Map<string, InternalKey>();
    for (const candidate of previous) {
      const issueUntil = Date.parse(candidate.issueUntil);
      const verifyUntil = Date.parse(candidate.verifyUntil);
      const parsed = parseKey(candidate, { issueUntil, verifyUntil });
      const minimumVerifyUntil =
        issueUntil + this.#cursorLifetimeMs + PREVIOUS_KEY_CLOCK_SKEW_MS;
      if (
        parsed.keyId === this.#current.keyId ||
        parsedPrevious.has(parsed.keyId) ||
        !Number.isSafeInteger(issueUntil) ||
        !Number.isSafeInteger(verifyUntil) ||
        !Number.isSafeInteger(minimumVerifyUntil) ||
        verifyUntil <= now ||
        verifyUntil < minimumVerifyUntil
      ) {
        throw new ExperienceQueryCursorCodecError(
          'invalid-config',
          'Experience cursor previous key is ambiguous or under grace',
        );
      }
      parsedPrevious.set(parsed.keyId, parsed);
    }
    this.#previous = parsedPrevious;
  }

  issue(bindingInput: ExperienceQueryCursorBinding): string {
    const binding = IssueBindingSchema.safeParse(bindingInput);
    const issuedAt = this.#runtimeNow('issue');
    if (!binding.success) {
      throw new ExperienceQueryCursorCodecError(
        'invalid-input',
        'Experience cursor binding is malformed',
      );
    }
    const expiresAt = issuedAt + this.#cursorLifetimeMs;
    const unsigned = unsignedEnvelope(
      this.#current.keyId,
      binding.data,
      issuedAt,
      expiresAt,
    );
    const cursor = Buffer.from(
      JSON.stringify([
        ...unsigned,
        authenticationCode(
          this.#current,
          unsigned,
          expectedBindingFor(binding.data),
        ),
      ]),
      'utf8',
    ).toString('base64url');
    if (cursor.length < 32 || cursor.length > 512) {
      throw new ExperienceQueryCursorCodecError(
        'invalid-input',
        'Experience cursor exceeds its public bound',
      );
    }
    return cursor;
  }

  verify(
    cursor: string,
    expectedInput: ExperienceQueryCursorExpectedBinding,
  ): Readonly<{
    position:
      | { readonly occurredAt: string; readonly id: string }
      | {
          readonly at: string;
          readonly id: string;
          readonly entityType?: string;
        };
  }> {
    const expected = ExpectedBindingSchema.safeParse(expectedInput);
    if (!expected.success || !/^[A-Za-z0-9_-]{32,512}$/u.test(cursor)) {
      throw new ExperienceQueryCursorCodecError(
        'invalid-input',
        'Experience cursor or expected binding is malformed',
      );
    }
    let decoded: unknown;
    try {
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.toString('base64url') !== cursor)
        throw new Error('noncanonical');
      decoded = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new ExperienceQueryCursorCodecError(
        'invalid-input',
        'Experience cursor encoding is malformed',
      );
    }
    const envelope = CursorEnvelopeSchema.safeParse(decoded);
    if (!envelope.success) {
      throw new ExperienceQueryCursorCodecError(
        'invalid-input',
        'Experience cursor envelope is malformed',
      );
    }
    const value = envelope.data;
    const now = this.#runtimeNow('verify');
    const key = this.#resolveKey(value[1], now);
    const unsigned = value.slice(0, 8);
    const expectedCode = Buffer.from(
      authenticationCode(key, unsigned, expected.data),
      'base64url',
    );
    const actualCode = Buffer.from(value[8], 'base64url');
    if (
      expectedCode.byteLength !== actualCode.byteLength ||
      !timingSafeEqual(expectedCode, actualCode)
    ) {
      throw new ExperienceQueryCursorCodecError(
        'integrity-check-failed',
        'Experience cursor authentication failed',
      );
    }
    if (codeKind(value[2]) !== expected.data.kind) {
      throw new ExperienceQueryCursorCodecError(
        'integrity-check-failed',
        'Experience cursor kind is invalid',
      );
    }
    if (key.issueUntil !== undefined && value[6] > key.issueUntil) {
      throw new ExperienceQueryCursorCodecError(
        'key-unavailable',
        'Experience cursor was issued after its HMAC key retired',
      );
    }
    if (
      value[6] > now ||
      value[7] <= now ||
      value[7] - value[6] > this.#cursorLifetimeMs
    ) {
      throw new ExperienceQueryCursorCodecError(
        'expired',
        'Experience cursor is expired or outside its lifetime',
      );
    }
    const at = new Date(value[3]).toISOString();
    return deepFreeze({
      position:
        expected.data.kind === 'activity'
          ? { occurredAt: at, id: value[4] }
          : {
              at,
              id: value[4],
              ...(expected.data.kind === 'finance' && value[5] !== null
                ? { entityType: value[5] }
                : {}),
            },
    });
  }

  #runtimeNow(operation: 'issue' | 'verify'): number {
    const now = this.#clock().getTime();
    if (!Number.isSafeInteger(now)) {
      throw new ExperienceQueryCursorCodecError(
        operation === 'issue' ? 'invalid-input' : 'expired',
        'Experience cursor clock is unavailable',
      );
    }
    return now;
  }

  #resolveKey(keyId: string, now: number): InternalKey {
    const key =
      keyId === this.#current.keyId ? this.#current : this.#previous.get(keyId);
    if (
      key === undefined ||
      (key.verifyUntil !== undefined && now >= key.verifyUntil)
    ) {
      throw new ExperienceQueryCursorCodecError(
        'key-unavailable',
        'Experience cursor HMAC key is unavailable or retired',
      );
    }
    return key;
  }
}
