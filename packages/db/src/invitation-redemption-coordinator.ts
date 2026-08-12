import { createHash, scrypt } from 'node:crypto';

import { z } from 'zod';

import type { DatabaseClient, DatabasePool } from './scoped-repository.js';

const RedemptionRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  displayName: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  invitationId: z.uuid(),
  invitationToken: z.string().min(20).max(512),
  password: z.string().min(12).max(128),
});
const RedemptionInputSchema = z.strictObject({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:._-]{16,200}$/),
  request: RedemptionRequestSchema,
  requestId: z.uuid(),
});
const RedemptionResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  userId: z.uuid(),
  householdId: z.uuid(),
  role: z.enum(['owner', 'member']),
  emailVerified: z.literal(true),
});
const RoutineRowSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.enum(['provisioned', 'replay']),
    result: RedemptionResultSchema,
  }),
  z.strictObject({ status: z.literal('invalid'), result: z.null() }),
  z.strictObject({ status: z.literal('conflict'), result: z.null() }),
]);
const ReadinessRowSchema = z.strictObject({ ready: z.boolean() });
const PasswordHashSchema = z.string().regex(/^[a-f0-9]{32}:[a-f0-9]{128}$/);

export type InvitationRedemptionResult =
  | Readonly<{
      status: 'provisioned' | 'replay';
      result: Readonly<z.output<typeof RedemptionResultSchema>>;
    }>
  | Readonly<{ status: 'invalid' | 'conflict' }>;

export type InvitationPasswordHasher = (input: {
  readonly invitationId: string;
  readonly invitationTokenHash: string;
  readonly password: string;
}) => Promise<string>;

export const deriveInvitationPasswordHash: InvitationPasswordHasher = async (
  input,
) => {
  const salt = createHash('sha256')
    .update('emdo.invitation-password-salt.v1', 'utf8')
    .update('\0', 'utf8')
    .update(input.invitationId, 'utf8')
    .update('\0', 'utf8')
    .update(input.invitationTokenHash, 'utf8')
    .digest('hex')
    .slice(0, 32);
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      input.password.normalize('NFKC'),
      salt,
      64,
      {
        N: 16_384,
        r: 16,
        p: 1,
        maxmem: 128 * 16_384 * 16 * 2,
      },
      (error, derivedKey) => {
        if (error !== null) reject(error);
        else resolve(derivedKey);
      },
    );
  });
  return `${salt}:${key.toString('hex')}`;
};

const callRedemptionRoutine = async (
  client: DatabaseClient,
  values: readonly unknown[],
): Promise<z.output<typeof RoutineRowSchema>> => {
  const result = await client.query(
    `select status, result
       from emdo.redeem_household_invitation(
         $1::integer, $2::uuid, $3::text, $4::text,
         $5::text, $6::text, $7::text, $8::uuid
       )`,
    values,
  );
  if (result.rows.length !== 1) {
    throw new Error('Invitation redemption routine returned no exact result');
  }
  return RoutineRowSchema.parse(result.rows[0]);
};

const publicResult = (
  row: z.output<typeof RoutineRowSchema>,
): InvitationRedemptionResult => {
  if (row.status === 'invalid' || row.status === 'conflict') {
    return Object.freeze({ status: row.status });
  }
  return Object.freeze({
    status: row.status,
    result: Object.freeze({ ...row.result }),
  });
};

const sameResult = (
  left: z.output<typeof RedemptionResultSchema>,
  right: z.output<typeof RedemptionResultSchema>,
): boolean =>
  left.schemaVersion === right.schemaVersion &&
  left.userId === right.userId &&
  left.householdId === right.householdId &&
  left.role === right.role &&
  left.emailVerified === right.emailVerified;

const ambiguousRecoveryIsValid = (
  original: z.output<typeof RoutineRowSchema>,
  recovered: z.output<typeof RoutineRowSchema>,
): boolean => {
  if (original.status === 'invalid' || original.status === 'conflict') {
    return recovered.status === original.status;
  }
  if (recovered.status === 'provisioned') {
    return original.status === 'provisioned';
  }
  return (
    recovered.status === 'replay' &&
    sameResult(original.result, recovered.result)
  );
};

/**
 * Invite-only onboarding boundary. Password hashing completes before any row
 * lock, while the database atomically validates, provisions, consumes, audits,
 * and stores the exact non-secret replay receipt.
 */
export class PostgresInvitationRedemptionCoordinator {
  constructor(
    private readonly pool: DatabasePool,
    private readonly passwordHasher: InvitationPasswordHasher = deriveInvitationPasswordHash,
  ) {}

  async redeem(input: {
    readonly idempotencyKey: string;
    readonly request: z.input<typeof RedemptionRequestSchema>;
    readonly requestId: string;
  }): Promise<InvitationRedemptionResult> {
    const parsed = RedemptionInputSchema.parse(input);
    const invitationTokenHash = createHash('sha256')
      .update(parsed.request.invitationToken, 'utf8')
      .digest('hex');
    const passwordHash = PasswordHashSchema.parse(
      await this.passwordHasher({
        invitationId: parsed.request.invitationId,
        invitationTokenHash,
        password: parsed.request.password,
      }),
    );
    const values = Object.freeze([
      parsed.request.schemaVersion,
      parsed.request.invitationId,
      invitationTokenHash,
      parsed.request.email,
      parsed.request.displayName,
      passwordHash,
      parsed.idempotencyKey,
      parsed.requestId,
    ]);

    const firstClient = await this.pool.connect();
    let firstOpen = false;
    let firstReleased = false;
    try {
      await firstClient.query('begin');
      firstOpen = true;
      const original = await callRedemptionRoutine(firstClient, values);
      try {
        await firstClient.query('commit');
        firstOpen = false;
        return publicResult(original);
      } catch {
        firstOpen = false;
        firstClient.release(true);
        firstReleased = true;
        return await this.recoverAmbiguousCommit(values, original);
      }
    } catch (error) {
      if (firstOpen) {
        await firstClient.query('rollback').catch(() => undefined);
      }
      throw error;
    } finally {
      if (!firstReleased) firstClient.release();
    }
  }

  private async recoverAmbiguousCommit(
    values: readonly unknown[],
    original: z.output<typeof RoutineRowSchema>,
  ): Promise<InvitationRedemptionResult> {
    const client = await this.pool.connect();
    let open = false;
    let released = false;
    try {
      await client.query('begin');
      open = true;
      const recovered = await callRedemptionRoutine(client, values);
      if (!ambiguousRecoveryIsValid(original, recovered)) {
        throw new Error('Invitation redemption readback did not match');
      }
      try {
        await client.query('commit');
        open = false;
      } catch {
        open = false;
        client.release(true);
        released = true;
        throw new Error('Invitation redemption commit remained ambiguous');
      }
      return publicResult(recovered);
    } catch (error) {
      if (open) await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      if (!released) client.release();
    }
  }

  async checkReady(): Promise<boolean> {
    const client = await this.pool.connect();
    let destroy = false;
    try {
      const result = await client.query(
        'select emdo.invitation_redemption_ready() as ready',
      );
      return (
        result.rows.length === 1 &&
        ReadinessRowSchema.parse(result.rows[0]).ready
      );
    } catch {
      destroy = true;
      return false;
    } finally {
      client.release(destroy);
    }
  }
}
