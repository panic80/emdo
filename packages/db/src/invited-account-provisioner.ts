import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';

import type { DatabasePool } from './scoped-repository.js';

const ValidDateSchema = z
  .date()
  .refine((value) => Number.isFinite(value.getTime()));
const ProvisionInputSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(100),
  email: z.string().trim().min(3).max(320),
  invitationId: z.uuid(),
  invitationTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  now: ValidDateSchema,
  password: z.string().min(12).max(128),
});
const ProvisionedAccountRowSchema = z.strictObject({
  status: z.literal('provisioned'),
  user_id: z.uuid(),
  household_id: z.uuid(),
  role: z.enum(['owner', 'member']),
  email: z.string().min(3).max(320),
  email_verified: z.literal(true),
});

export type PasswordHasher = (password: string) => Promise<string>;

/**
 * Unauthenticated onboarding boundary. The only accepted scope is a locked,
 * email-bound invitation row; household and role are read from that row.
 */
export class PostgresInvitedAccountProvisioner {
  private readonly hash: PasswordHasher;

  constructor(
    private readonly pool: DatabasePool,
    passwordHasher: PasswordHasher = hashPassword,
  ) {
    this.hash = passwordHasher;
  }

  async provisionInvitedAccount(input: {
    readonly displayName: string;
    readonly email: string;
    readonly invitationId: string;
    readonly invitationTokenHash: string;
    readonly now: Date;
    readonly password: string;
  }): Promise<
    | { readonly status: 'rejected' }
    | {
        readonly status: 'provisioned';
        readonly userId: string;
        readonly email: string;
        readonly emailVerified: true;
        readonly householdId: string;
        readonly role: 'owner' | 'member';
      }
  > {
    const parsed = ProvisionInputSchema.parse(input);
    const email = parsed.email.toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return { status: 'rejected' };

    // Password hashing is intentionally completed before the row lock. Only
    // the derived Better Auth credential hash crosses the SQL boundary.
    const passwordHash = await this.hash(parsed.password);
    if (passwordHash.length === 0) {
      throw new Error('Password hashing did not produce a credential');
    }

    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('begin');
      began = true;
      const provisionedResult = await client.query(
        `select status, user_id, email, email_verified, household_id, role
           from emdo.provision_invited_account(
             $1::uuid, $2::text, $3::text, $4::text, $5::text
           )`,
        [
          parsed.invitationId,
          parsed.invitationTokenHash,
          email,
          parsed.displayName,
          passwordHash,
        ],
      );
      if (provisionedResult.rows[0] === undefined) {
        await client.query('commit');
        began = false;
        return { status: 'rejected' };
      }
      const provisioned = ProvisionedAccountRowSchema.parse(
        provisionedResult.rows[0],
      );
      if (provisioned.email !== email) {
        throw new Error('Onboarding routine returned a mismatched identity');
      }

      await client.query('commit');
      began = false;
      return Object.freeze({
        status: 'provisioned' as const,
        userId: provisioned.user_id,
        email: provisioned.email,
        emailVerified: true as const,
        householdId: provisioned.household_id,
        role: provisioned.role,
      });
    } catch (error) {
      if (began) {
        try {
          await client.query('rollback');
        } catch {
          // Preserve the original transaction failure.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
