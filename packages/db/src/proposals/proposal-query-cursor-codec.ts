import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  IsoDateTimeSchema,
  Sha256Schema,
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
const StateSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'prepared',
  'executing',
  'executed',
  'not-applied',
  'indeterminate',
  'expired',
  'failed',
]);
const ExpectedBindingSchema = z.strictObject({
  userId: UuidSchema,
  sessionId: UuidSchema,
  householdId: UuidSchema,
  authorizationScopeFingerprint: Sha256Schema,
  state: StateSchema.optional(),
});
const IssueBindingSchema = ExpectedBindingSchema.extend({
  position: z.strictObject({
    createdAt: IsoDateTimeSchema,
    id: UuidSchema,
  }),
});
const UuidHexSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const AuthenticationCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

// Principal, scope, and filter material are deliberately absent. Those values
// are authenticated as out-of-band MAC inputs supplied by the trusted request
// context, so decoding a cursor reveals only its necessary keyset position and
// bounded lifetime.
const CursorEnvelopeSchema = z.tuple([
  z.literal(2),
  KeyIdSchema,
  z.literal(1),
  z.number().int().nonnegative().safe(),
  UuidHexSchema,
  z.number().int().nonnegative().safe(),
  z.number().int().positive().safe(),
  AuthenticationCodeSchema,
]);

export interface ProposalQueryCursorHmacKey {
  readonly keyId: string;
  readonly secret: Uint8Array;
}

export interface ProposalQueryCursorPreviousHmacKey extends ProposalQueryCursorHmacKey {
  readonly issueUntil: string;
  readonly verifyUntil: string;
}

export interface ProposalQueryCursorExpectedBinding {
  readonly userId: string;
  readonly sessionId: string;
  readonly householdId: string;
  readonly authorizationScopeFingerprint: string;
  readonly state?: z.infer<typeof StateSchema>;
}

export interface ProposalQueryCursorBinding extends ProposalQueryCursorExpectedBinding {
  readonly position: {
    readonly createdAt: string;
    readonly id: string;
  };
}

export class ProposalQueryCursorCodecError extends Error {
  constructor(
    readonly code:
      | 'invalid-config'
      | 'invalid-input'
      | 'integrity-check-failed'
      | 'binding-mismatch'
      | 'expired'
      | 'key-unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ProposalQueryCursorCodecError';
  }
}

interface InternalKey {
  readonly keyId: string;
  readonly secret: Uint8Array;
  readonly issueUntil?: number;
  readonly verifyUntil?: number;
}

const parseKey = (
  input: ProposalQueryCursorHmacKey,
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
    throw new ProposalQueryCursorCodecError(
      'invalid-config',
      'Proposal cursor HMAC key is malformed',
    );
  }
  return {
    keyId: keyId.data,
    secret: new Uint8Array(input.secret),
    ...(retirement === undefined ? {} : retirement),
  };
};

const uuidToHex = (value: string): string => value.replaceAll('-', '');
const hexToUuid = (value: string): string =>
  `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;

const unsignedEnvelope = (
  keyId: string,
  position: z.output<typeof IssueBindingSchema>['position'],
  issuedAt: number,
  expiresAt: number,
) =>
  [
    2,
    keyId,
    1,
    Date.parse(position.createdAt),
    uuidToHex(position.id),
    issuedAt,
    expiresAt,
  ] as const;

const authenticationCode = (
  key: InternalKey,
  unsigned: readonly unknown[],
  binding: z.output<typeof ExpectedBindingSchema>,
): string =>
  createHmac('sha256', key.secret)
    .update('emdo.proposal-query-cursor.v2\0', 'utf8')
    .update(
      JSON.stringify([
        ...unsigned,
        binding.userId,
        binding.sessionId,
        binding.householdId,
        binding.authorizationScopeFingerprint,
        binding.state ?? '',
      ]),
      'utf8',
    )
    .digest('base64url');

export class ProposalQueryCursorCodec {
  readonly #current: InternalKey;
  readonly #previous: ReadonlyMap<string, InternalKey>;
  readonly #clock: () => Date;
  readonly #cursorLifetimeMs: number;

  constructor(options: {
    readonly current: ProposalQueryCursorHmacKey;
    readonly previous?: readonly ProposalQueryCursorPreviousHmacKey[];
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
      throw new ProposalQueryCursorCodecError(
        'invalid-config',
        'Proposal cursor clock or lifetime is invalid',
      );
    }
    this.#current = parseKey(options.current);
    const previous = options.previous ?? [];
    if (previous.length > MAXIMUM_PREVIOUS_KEYS) {
      throw new ProposalQueryCursorCodecError(
        'invalid-config',
        'Proposal cursor key ring has too many previous keys',
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
        throw new ProposalQueryCursorCodecError(
          'invalid-config',
          'Proposal cursor previous key is ambiguous or under grace',
        );
      }
      parsedPrevious.set(parsed.keyId, parsed);
    }
    this.#previous = parsedPrevious;
  }

  issue(bindingInput: ProposalQueryCursorBinding): string {
    const binding = IssueBindingSchema.safeParse(bindingInput);
    const issuedAt = this.#clock().getTime();
    if (!binding.success || !Number.isSafeInteger(issuedAt)) {
      throw new ProposalQueryCursorCodecError(
        'invalid-input',
        'Proposal cursor binding is malformed',
      );
    }
    const expiresAt = issuedAt + this.#cursorLifetimeMs;
    const unsigned = unsignedEnvelope(
      this.#current.keyId,
      binding.data.position,
      issuedAt,
      expiresAt,
    );
    const expectedBinding = ExpectedBindingSchema.parse({
      userId: binding.data.userId,
      sessionId: binding.data.sessionId,
      householdId: binding.data.householdId,
      authorizationScopeFingerprint: binding.data.authorizationScopeFingerprint,
      ...(binding.data.state === undefined
        ? {}
        : { state: binding.data.state }),
    });
    const cursor = Buffer.from(
      JSON.stringify([
        ...unsigned,
        authenticationCode(this.#current, unsigned, expectedBinding),
      ]),
      'utf8',
    ).toString('base64url');
    if (cursor.length < 32 || cursor.length > 512) {
      throw new ProposalQueryCursorCodecError(
        'invalid-input',
        'Proposal cursor exceeds its public bound',
      );
    }
    return cursor;
  }

  verify(
    cursor: string,
    expectedInput: ProposalQueryCursorExpectedBinding,
  ): Readonly<{
    position: { readonly createdAt: string; readonly id: string };
  }> {
    const expected = ExpectedBindingSchema.safeParse(expectedInput);
    if (!expected.success || !/^[A-Za-z0-9_-]{32,512}$/u.test(cursor)) {
      throw new ProposalQueryCursorCodecError(
        'invalid-input',
        'Proposal cursor or expected binding is malformed',
      );
    }
    let decoded: unknown;
    try {
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.toString('base64url') !== cursor)
        throw new Error('noncanonical');
      decoded = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new ProposalQueryCursorCodecError(
        'invalid-input',
        'Proposal cursor encoding is malformed',
      );
    }
    const envelope = CursorEnvelopeSchema.safeParse(decoded);
    if (!envelope.success) {
      throw new ProposalQueryCursorCodecError(
        'invalid-input',
        'Proposal cursor envelope is malformed',
      );
    }
    const value = envelope.data;
    const now = this.#runtimeNow('verify');
    const key = this.#resolveKey(value[1], now);
    const unsigned = value.slice(0, 7);
    const expectedCode = Buffer.from(
      authenticationCode(key, unsigned, expected.data),
      'base64url',
    );
    const actualCode = Buffer.from(value[7], 'base64url');
    if (
      expectedCode.byteLength !== actualCode.byteLength ||
      !timingSafeEqual(expectedCode, actualCode)
    ) {
      throw new ProposalQueryCursorCodecError(
        'integrity-check-failed',
        'Proposal cursor authentication failed',
      );
    }
    if (key.issueUntil !== undefined && value[5] > key.issueUntil) {
      throw new ProposalQueryCursorCodecError(
        'key-unavailable',
        'Proposal cursor was issued after its HMAC key retired',
      );
    }
    if (
      value[5] > now ||
      value[6] <= now ||
      value[6] - value[5] > this.#cursorLifetimeMs
    ) {
      throw new ProposalQueryCursorCodecError(
        'expired',
        'Proposal cursor is expired or outside its lifetime',
      );
    }
    return deepFreeze({
      position: {
        createdAt: new Date(value[3]).toISOString(),
        id: hexToUuid(value[4]),
      },
    });
  }

  #runtimeNow(operation: 'issue' | 'verify'): number {
    const now = this.#clock().getTime();
    if (!Number.isSafeInteger(now)) {
      throw new ProposalQueryCursorCodecError(
        operation === 'issue' ? 'invalid-input' : 'expired',
        'Proposal cursor clock is unavailable',
      );
    }
    return now;
  }

  #resolveKey(keyId: string, now: number): InternalKey {
    const key =
      keyId === this.#current.keyId ? this.#current : this.#previous.get(keyId);
    if (
      key === undefined ||
      (key.issueUntil !== undefined && !Number.isSafeInteger(key.issueUntil)) ||
      (key.verifyUntil !== undefined &&
        !Number.isSafeInteger(key.verifyUntil)) ||
      (key.verifyUntil !== undefined && now >= key.verifyUntil)
    ) {
      throw new ProposalQueryCursorCodecError(
        'key-unavailable',
        'Proposal cursor HMAC key is unavailable or retired',
      );
    }
    return key;
  }
}
