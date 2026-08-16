import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  EffectiveAuthorizationScopeFingerprintSchema,
  IdempotencyKeySchema,
  UuidSchema,
  deepFreeze,
  type EffectiveAuthorizationScopeFingerprint,
} from '@emdo/contracts';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import {
  firstResultRow,
  parseDurablePrincipal,
  withClaimedTransaction,
} from '../durable/scoped-transaction.js';

const RoleSchema = z.enum(['owner', 'member']);
const PrincipalSchema = z.strictObject({
  userId: UuidSchema,
  sessionId: UuidSchema,
  householdId: UuidSchema,
  role: RoleSchema,
  emailVerified: z.literal(true),
  spaceAccessGrantId: UuidSchema,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema,
});
const ContextSchema = z.strictObject({
  principal: PrincipalSchema,
  requestId: UuidSchema,
});
const IssueSchema = ContextSchema.extend({
  email: z.string().trim().toLowerCase().email().max(320),
  role: RoleSchema,
  expiresInSeconds: z.number().int().safe().min(60).max(604_800),
  idempotencyKey: IdempotencyKeySchema,
});
const RevokeSchema = ContextSchema.extend({
  invitationId: UuidSchema,
  expectedVersion: z.number().int().safe().positive(),
  idempotencyKey: IdempotencyKeySchema,
});
const ChangeRoleSchema = ContextSchema.extend({
  membershipId: UuidSchema,
  expectedVersion: z.number().int().safe().positive(),
  role: RoleSchema,
  idempotencyKey: IdempotencyKeySchema,
});
const DeactivateSchema = ContextSchema.extend({
  membershipId: UuidSchema,
  expectedVersion: z.number().int().safe().positive(),
  idempotencyKey: IdempotencyKeySchema,
});

const InvitationRowSchema = z.object({
  schema_version: z.literal(1),
  invitation_id: UuidSchema,
  household_id: UuidSchema,
  email: z.email().max(320),
  role: RoleSchema,
  state: z.enum(['pending', 'consumed', 'revoked', 'expired']),
  version: z.number().int().safe().positive(),
  created_at: z.coerce.date(),
  expires_at: z.coerce.date(),
  replayed: z.boolean().optional(),
  delivery_queued: z.boolean().optional(),
});
const MembershipRowSchema = z.object({
  schema_version: z.literal(1),
  membership_id: UuidSchema,
  household_id: UuidSchema,
  user_id: UuidSchema,
  email: z.email().max(320),
  role: RoleSchema,
  status: z.enum(['active', 'inactive']),
  version: z.number().int().safe().positive(),
  joined_at: z.coerce.date(),
  ended_at: z.coerce.date().nullable(),
  replayed: z.boolean().optional(),
});
const InvitationDeliveryEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  algorithm: z.literal('RSA-OAEP-256'),
  keyId: z.string().trim().min(1).max(128),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]{64,16384}$/u),
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
const ReadinessRowSchema = z.strictObject({
  ready: z.literal(true),
});

export type HouseholdAdministrationErrorCode =
  | 'authorization-revoked'
  | 'conflict'
  | 'invalid-input'
  | 'invalid-result'
  | 'last-owner-required'
  | 'self-lockout';

export class HouseholdAdministrationError extends Error {
  constructor(
    readonly code: HouseholdAdministrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HouseholdAdministrationError';
  }
}

export interface HouseholdAdministrationPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly householdId: string;
  readonly role: 'owner' | 'member';
  readonly emailVerified: true;
  readonly spaceAccessGrantId: string;
  readonly collectionAuthorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
}

export interface InvitationDeliverySecretSealer {
  seal(input: {
    readonly secret: Uint8Array;
    readonly binding: {
      readonly invitationId: string;
      readonly recipient: string;
      readonly role: 'owner' | 'member';
      readonly tokenHash: string;
      readonly templateVersion: 'invitation-redemption.v1';
    };
  }): Promise<unknown>;
}

export interface HouseholdInvitationView {
  readonly id: string;
  readonly email: string;
  readonly role: 'owner' | 'member';
  readonly status: 'pending' | 'consumed' | 'revoked' | 'expired';
  readonly version: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface HouseholdMembershipView {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly role: 'owner' | 'member';
  readonly status: 'active' | 'inactive';
  readonly version: number;
  readonly joinedAt: string;
  readonly endedAt?: string;
}

type MembershipRoleChangeReceipt = Readonly<{
  schemaVersion: 1;
  membership: Readonly<
    HouseholdMembershipView & {
      status: 'active';
    }
  >;
  replayed: boolean;
}>;

type MembershipDeactivationReceipt = Readonly<{
  schemaVersion: 1;
  membership: Readonly<
    HouseholdMembershipView & {
      status: 'inactive';
      endedAt: string;
    }
  >;
  replayed: boolean;
}>;

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
};

const requestHash = (value: Readonly<Record<string, unknown>>): string =>
  sha256(canonicalJson(value));

const invitationDeliveryPayload = (
  operationId: string,
  invitationId: string,
  deliverySecretId: string,
) =>
  deepFreeze({
    schemaVersion: 1 as const,
    origin: 'deterministic-worker' as const,
    operationId,
    invitationId,
    deliverySecretId,
  });

const invitationDeliveryPayloadHash = (
  operationId: string,
  invitationId: string,
  deliverySecretId: string,
): string =>
  sha256(
    `emdo.invitation.delivery.v1\0${canonicalJson(
      invitationDeliveryPayload(operationId, invitationId, deliverySecretId),
    )}`,
  );

const ownerContext = (input: z.output<typeof ContextSchema>) => {
  if (input.principal.role !== 'owner') {
    throw new HouseholdAdministrationError(
      'authorization-revoked',
      'A current household owner is required',
    );
  }
  return parseDurablePrincipal({
    userId: input.principal.userId,
    sessionId: input.principal.sessionId,
    requestId: input.requestId,
    householdId: input.principal.householdId,
  });
};

const invalidInput = (): HouseholdAdministrationError =>
  new HouseholdAdministrationError(
    'invalid-input',
    'Household administration input is invalid',
  );

const parseInput = <Output>(
  schema: z.ZodType<Output>,
  input: unknown,
): Output => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalidInput();
  return parsed.data;
};

const assertExactHousehold = (
  householdId: string,
  expectedHouseholdId: string,
): void => {
  if (householdId !== expectedHouseholdId) {
    throw new HouseholdAdministrationError(
      'authorization-revoked',
      'Household administration authority changed during the request',
    );
  }
};

const invitationView = (
  row: z.output<typeof InvitationRowSchema>,
): Readonly<HouseholdInvitationView> =>
  deepFreeze({
    id: row.invitation_id,
    email: row.email,
    role: row.role,
    status: row.state,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  });

const membershipView = (
  row: z.output<typeof MembershipRowSchema>,
): Readonly<HouseholdMembershipView> =>
  deepFreeze({
    id: row.membership_id,
    userId: row.user_id,
    email: row.email,
    role: row.role,
    status: row.status,
    version: row.version,
    joinedAt: row.joined_at.toISOString(),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at.toISOString() }),
  });

const databaseErrorCode = (
  error: unknown,
):
  | 'authorization-revoked'
  | 'conflict'
  | 'last-owner-required'
  | 'self-lockout'
  | undefined => {
  if (error === null || typeof error !== 'object') return undefined;
  let message: unknown;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return undefined;
    }
    message = descriptor.value;
  } catch {
    return undefined;
  }
  if (typeof message !== 'string') return undefined;
  if (message === 'EMDO:authorization-revoked') {
    return 'authorization-revoked';
  }
  if (message === 'EMDO:administration-conflict') return 'conflict';
  if (message === 'EMDO:last-owner-required') return 'last-owner-required';
  if (message === 'EMDO:self-lockout') return 'self-lockout';
  return undefined;
};

const runDatabaseOperation = async <Result>(
  operation: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HouseholdAdministrationError) throw error;
    const code = databaseErrorCode(error);
    if (code !== undefined) {
      const message =
        code === 'authorization-revoked'
          ? 'Household administration authority is no longer active'
          : code === 'conflict'
            ? 'Household administration conflicted with durable state'
            : code === 'self-lockout'
              ? 'Owners cannot remove their own active authority'
              : 'At least one active household owner is required';
      throw new HouseholdAdministrationError(code, message);
    }
    throw error;
  }
};

const captureSecretSealer = (
  sealer: InvitationDeliverySecretSealer,
): InvitationDeliverySecretSealer['seal'] => {
  try {
    if (sealer === null || typeof sealer !== 'object')
      throw new Error('invalid');
    let current: object | null = sealer;
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'seal');
      if (descriptor !== undefined) {
        if (
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          typeof descriptor.value !== 'function'
        ) {
          throw new Error('invalid');
        }
        return descriptor.value.bind(
          sealer,
        ) as InvitationDeliverySecretSealer['seal'];
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    throw new Error('invalid');
  } catch {
    throw new HouseholdAdministrationError(
      'invalid-input',
      'Invitation delivery sealer is invalid',
    );
  }
};

/**
 * Structural implementation of the API household-administration gateway.
 * Every SQL routine derives household scope from the transaction claims and
 * current locked session; no caller-supplied household is passed to SQL.
 */
export class PostgresHouseholdAdministrationService {
  readonly #sealSecret: InvitationDeliverySecretSealer['seal'];

  constructor(
    private readonly pool: DatabasePool,
    sealer: InvitationDeliverySecretSealer,
  ) {
    this.#sealSecret = captureSecretSealer(sealer);
  }

  async issueInvitation(input: {
    readonly email: string;
    readonly role: 'owner' | 'member';
    readonly expiresInSeconds: number;
    readonly principal: HouseholdAdministrationPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }) {
    const request = parseInput(IssueSchema, input);
    const principal = ownerContext(request);
    const invitationId = randomUUID();
    const deliverySecretId = randomUUID();
    const operationId = `invitation:${invitationId}`;
    const semanticHash = requestHash({
      schemaVersion: 1,
      command: 'issue-invitation',
      email: request.email,
      role: request.role,
      expiresInSeconds: request.expiresInSeconds,
    });
    const payloadHash = invitationDeliveryPayloadHash(
      operationId,
      invitationId,
      deliverySecretId,
    );
    const randomTokenBytes = randomBytes(32);
    let secretBytes: Buffer;
    try {
      secretBytes = Buffer.from(
        randomTokenBytes.toString('base64url'),
        'ascii',
      );
    } finally {
      randomTokenBytes.fill(0);
    }
    let tokenHash: string;
    let rawEnvelope: unknown;
    try {
      tokenHash = createHash('sha256').update(secretBytes).digest('hex');
      rawEnvelope = await this.#sealSecret({
        secret: secretBytes,
        binding: {
          invitationId,
          recipient: request.email,
          role: request.role,
          tokenHash,
          templateVersion: 'invitation-redemption.v1',
        },
      });
    } catch {
      throw new HouseholdAdministrationError(
        'invalid-result',
        'Invitation delivery sealer failed',
      );
    } finally {
      secretBytes.fill(0);
    }
    const envelope = InvitationDeliveryEnvelopeSchema.safeParse(rawEnvelope);
    if (!envelope.success) {
      throw new HouseholdAdministrationError(
        'invalid-result',
        'Invitation delivery sealer returned a malformed envelope',
      );
    }

    return runDatabaseOperation(() =>
      withClaimedTransaction(this.pool, principal, async (client) => {
        const row = firstResultRow(
          await client.query(
            `select schema_version, invitation_id, household_id, email, role,
                    state, version, created_at, expires_at, replayed,
                    delivery_queued
               from emdo.issue_household_invitation(
                 $1::text, $2::text, $3::integer, $4::text, $5::text,
                 $6::text, $7::uuid, $8::text, $9::uuid, $10::text,
                 $11::jsonb, $12::text
               )`,
            [
              request.email,
              request.role,
              request.expiresInSeconds,
              tokenHash,
              request.idempotencyKey,
              semanticHash,
              invitationId,
              operationId,
              deliverySecretId,
              'invitation-redemption.v1',
              envelope.data,
              payloadHash,
            ],
          ),
        );
        if (row === undefined) {
          throw new HouseholdAdministrationError(
            'conflict',
            'Invitation issuance conflicted with current authority or idempotency',
          );
        }
        const parsed = InvitationRowSchema.safeParse(row);
        if (
          !parsed.success ||
          parsed.data.state !== 'pending' ||
          parsed.data.delivery_queued !== true
        ) {
          throw new HouseholdAdministrationError(
            'invalid-result',
            'Database returned malformed invitation metadata',
          );
        }
        assertExactHousehold(
          parsed.data.household_id,
          request.principal.householdId,
        );
        return deepFreeze({
          schemaVersion: 1 as const,
          invitation: deepFreeze({
            ...invitationView(parsed.data),
            status: 'pending' as const,
            deliveryStatus: 'queued' as const,
          }),
          replayed: parsed.data.replayed ?? false,
        });
      }),
    );
  }

  async listInvitations(input: {
    readonly principal: HouseholdAdministrationPrincipal;
    readonly requestId: string;
  }) {
    const request = parseInput(ContextSchema, input);
    const principal = ownerContext(request);
    return runDatabaseOperation(() =>
      withClaimedTransaction(this.pool, principal, async (client) => {
        const result = await client.query(
          `select schema_version, invitation_id, household_id, email, role,
                  state, version, created_at, expires_at
             from emdo.list_household_invitations()`,
          [],
        );
        const rows = z.array(InvitationRowSchema).safeParse(result.rows);
        if (!rows.success) {
          throw new HouseholdAdministrationError(
            'invalid-result',
            'Database returned malformed invitation metadata',
          );
        }
        for (const row of rows.data) {
          assertExactHousehold(row.household_id, request.principal.householdId);
        }
        return deepFreeze({
          schemaVersion: 1 as const,
          invitations: rows.data.map(invitationView),
        });
      }),
    );
  }

  async revokeInvitation(input: {
    readonly invitationId: string;
    readonly expectedVersion: number;
    readonly principal: HouseholdAdministrationPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }) {
    const request = parseInput(RevokeSchema, input);
    const principal = ownerContext(request);
    const semanticHash = requestHash({
      schemaVersion: 1,
      command: 'revoke-invitation',
      invitationId: request.invitationId,
      expectedVersion: request.expectedVersion,
    });
    return runDatabaseOperation(() =>
      withClaimedTransaction(this.pool, principal, async (client) => {
        const row = firstResultRow(
          await client.query(
            `select schema_version, invitation_id, household_id, email, role,
                    state, version, created_at, expires_at, replayed
               from emdo.revoke_household_invitation(
                 $1::uuid, $2::integer, $3::text, $4::text
               )`,
            [
              request.invitationId,
              request.expectedVersion,
              request.idempotencyKey,
              semanticHash,
            ],
          ),
        );
        if (row === undefined) {
          throw new HouseholdAdministrationError(
            'conflict',
            'Invitation state or idempotency changed before revocation',
          );
        }
        const parsed = InvitationRowSchema.safeParse(row);
        if (
          !parsed.success ||
          parsed.data.state !== 'revoked' ||
          parsed.data.version !== request.expectedVersion + 1
        ) {
          throw new HouseholdAdministrationError(
            'invalid-result',
            'Database returned malformed invitation metadata',
          );
        }
        assertExactHousehold(
          parsed.data.household_id,
          request.principal.householdId,
        );
        return deepFreeze({
          schemaVersion: 1 as const,
          invitation: deepFreeze({
            ...invitationView(parsed.data),
            status: 'revoked' as const,
          }),
          replayed: parsed.data.replayed ?? false,
        });
      }),
    );
  }

  async listMemberships(input: {
    readonly principal: HouseholdAdministrationPrincipal;
    readonly requestId: string;
  }) {
    const request = parseInput(ContextSchema, input);
    const principal = ownerContext(request);
    return runDatabaseOperation(() =>
      withClaimedTransaction(this.pool, principal, async (client) => {
        const result = await client.query(
          `select schema_version, membership_id, household_id, user_id, email,
                  role, status, version, joined_at, ended_at
             from emdo.list_household_memberships()`,
          [],
        );
        const rows = z.array(MembershipRowSchema).safeParse(result.rows);
        if (!rows.success) {
          throw new HouseholdAdministrationError(
            'invalid-result',
            'Database returned malformed membership metadata',
          );
        }
        for (const row of rows.data) {
          assertExactHousehold(row.household_id, request.principal.householdId);
        }
        return deepFreeze({
          schemaVersion: 1 as const,
          memberships: rows.data.map(membershipView),
        });
      }),
    );
  }

  async changeMembershipRole(input: {
    readonly membershipId: string;
    readonly expectedVersion: number;
    readonly role: 'owner' | 'member';
    readonly principal: HouseholdAdministrationPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }) {
    const request = parseInput(ChangeRoleSchema, input);
    return this.mutateMembership(
      request,
      'change_household_membership_role',
      [request.membershipId, request.expectedVersion, request.role],
      {
        schemaVersion: 1,
        command: 'change-membership-role',
        membershipId: request.membershipId,
        expectedVersion: request.expectedVersion,
        role: request.role,
      },
    );
  }

  async deactivateMembership(input: {
    readonly membershipId: string;
    readonly expectedVersion: number;
    readonly principal: HouseholdAdministrationPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }) {
    const request = parseInput(DeactivateSchema, input);
    return this.mutateMembership(
      request,
      'deactivate_household_membership',
      [request.membershipId, request.expectedVersion],
      {
        schemaVersion: 1,
        command: 'deactivate-membership',
        membershipId: request.membershipId,
        expectedVersion: request.expectedVersion,
      },
    );
  }

  async checkReady(): Promise<boolean> {
    const client = await this.pool.connect().catch(() => undefined);
    if (client === undefined) return false;
    let ready = false;
    try {
      const row = firstResultRow(
        await client.query(
          'select emdo.household_administration_ready() as ready',
          [],
        ),
      );
      ready = ReadinessRowSchema.safeParse(row).success;
    } catch {
      ready = false;
    }
    try {
      client.release();
    } catch {
      return false;
    }
    return ready;
  }

  private mutateMembership(
    request: z.output<typeof ChangeRoleSchema>,
    routine: 'change_household_membership_role',
    routineArguments: readonly unknown[],
    semanticRequest: Readonly<Record<string, unknown>>,
  ): Promise<MembershipRoleChangeReceipt>;

  private mutateMembership(
    request: z.output<typeof DeactivateSchema>,
    routine: 'deactivate_household_membership',
    routineArguments: readonly unknown[],
    semanticRequest: Readonly<Record<string, unknown>>,
  ): Promise<MembershipDeactivationReceipt>;

  private async mutateMembership(
    request:
      z.output<typeof ChangeRoleSchema> | z.output<typeof DeactivateSchema>,
    routine:
      'change_household_membership_role' | 'deactivate_household_membership',
    routineArguments: readonly unknown[],
    semanticRequest: Readonly<Record<string, unknown>>,
  ): Promise<MembershipRoleChangeReceipt | MembershipDeactivationReceipt> {
    const principal = ownerContext(request);
    const semanticHash = requestHash(semanticRequest);
    const parameters = [
      ...routineArguments,
      request.idempotencyKey,
      semanticHash,
    ];
    const placeholders = parameters
      .map((_, index) => `$${index + 1}`)
      .join(', ');
    return runDatabaseOperation(() =>
      withClaimedTransaction(this.pool, principal, async (client) => {
        const row = firstResultRow(
          await client.query(
            `select schema_version, membership_id, household_id, user_id,
                    email, role, status, version, joined_at, ended_at, replayed
               from emdo.${routine}(${placeholders})`,
            parameters,
          ),
        );
        if (row === undefined) {
          throw new HouseholdAdministrationError(
            'conflict',
            'Membership state or idempotency changed before administration',
          );
        }
        const parsed = MembershipRowSchema.safeParse(row);
        if (
          !parsed.success ||
          parsed.data.version !== request.expectedVersion + 1
        ) {
          throw new HouseholdAdministrationError(
            'invalid-result',
            'Database returned malformed membership metadata',
          );
        }
        assertExactHousehold(
          parsed.data.household_id,
          request.principal.householdId,
        );
        if (routine === 'change_household_membership_role') {
          if (
            !('role' in request) ||
            parsed.data.status !== 'active' ||
            parsed.data.ended_at !== null ||
            parsed.data.role !== request.role
          ) {
            throw new HouseholdAdministrationError(
              'invalid-result',
              'Database returned malformed active membership metadata',
            );
          }
          return deepFreeze({
            schemaVersion: 1 as const,
            membership: deepFreeze({
              ...membershipView(parsed.data),
              status: 'active' as const,
            }),
            replayed: parsed.data.replayed ?? false,
          });
        }
        if (
          parsed.data.status !== 'inactive' ||
          parsed.data.ended_at === null
        ) {
          throw new HouseholdAdministrationError(
            'invalid-result',
            'Database returned malformed inactive membership metadata',
          );
        }
        return deepFreeze({
          schemaVersion: 1 as const,
          membership: deepFreeze({
            ...membershipView(parsed.data),
            status: 'inactive' as const,
            endedAt: parsed.data.ended_at.toISOString(),
          }),
          replayed: parsed.data.replayed ?? false,
        });
      }),
    );
  }
}
