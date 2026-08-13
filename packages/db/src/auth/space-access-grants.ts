import {
  EffectiveAuthorizationScopeFingerprintSchema,
  UuidSchema,
  deepFreeze,
} from '@emdo/contracts';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import {
  firstResultRow,
  parseDurablePrincipal,
  withClaimedTransaction,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';

const RoleSchema = z.enum(['owner', 'member']);
const ActivePrincipalScopeInputSchema = z.strictObject({
  activeMembershipId: UuidSchema,
  householdId: UuidSchema,
  requestId: UuidSchema,
  role: RoleSchema,
  sessionId: UuidSchema,
  userId: UuidSchema,
});
const VerifyInputSchema = z.strictObject({
  grantId: UuidSchema,
  householdId: UuidSchema,
  requestId: UuidSchema,
  sessionId: UuidSchema,
  spaceId: UuidSchema,
  userId: UuidSchema,
});
const ActivePrincipalScopeRowSchema = z.strictObject({
  user_id: UuidSchema,
  session_id: UuidSchema,
  request_id: UuidSchema,
  household_id: UuidSchema,
  membership_id: UuidSchema,
  role: RoleSchema,
  email_verified: z.literal(true),
  space_access_grant_id: UuidSchema,
  collection_authorization_scope_fingerprint:
    EffectiveAuthorizationScopeFingerprintSchema,
});
const ReadinessRowSchema = z.strictObject({ ready: z.boolean() });
const GrantRowSchema = z
  .strictObject({
    schema_version: z.literal(1),
    version: z.number().int().positive().safe(),
    grant_id: UuidSchema,
    household_id: UuidSchema,
    original_owner_user_id: UuidSchema,
    session_id: UuidSchema,
    request_id: UuidSchema,
    membership_id: UuidSchema,
    role: RoleSchema,
    private_space_id: UuidSchema,
    writable_space_ids: z.array(UuidSchema).min(1).max(256),
    issued_at: z.coerce.date(),
    expires_at: z.coerce.date(),
  })
  .superRefine((value, context) => {
    if (
      new Set(value.writable_space_ids).size !== value.writable_space_ids.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['writable_space_ids'],
        message: 'Writable spaces must be unique',
      });
    }
    if (!value.writable_space_ids.includes(value.private_space_id)) {
      context.addIssue({
        code: 'custom',
        path: ['private_space_id'],
        message: 'Private space must be writable',
      });
    }
    if (value.expires_at.getTime() <= value.issued_at.getTime()) {
      context.addIssue({
        code: 'custom',
        path: ['expires_at'],
        message: 'Grant must expire after issuance',
      });
    }
  });

export class SpaceAccessGrantError extends Error {
  constructor(
    readonly code: 'authorization-revoked' | 'invalid-input' | 'invalid-result',
    message: string,
  ) {
    super(message);
    this.name = 'SpaceAccessGrantError';
  }
}

export interface ActiveSpaceAccessGrant {
  readonly schemaVersion: 1;
  readonly version: number;
  readonly grantId: string;
  readonly householdId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly membershipId: string;
  readonly role: 'owner' | 'member';
  readonly privateSpaceId: string;
  readonly writableSpaceIds: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface SpaceAccessGrantVerifier {
  verify(input: {
    readonly grantId: string;
    readonly householdId: string;
    readonly requestId: string;
    readonly sessionId: string;
    readonly spaceId: string;
    readonly userId: string;
  }): Promise<Readonly<ActiveSpaceAccessGrant>>;
}

const parseGrantRow = (
  row: Record<string, unknown>,
): Readonly<ActiveSpaceAccessGrant> => {
  const parsed = GrantRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new SpaceAccessGrantError(
      'invalid-result',
      'Database returned a malformed space access grant',
    );
  }
  return deepFreeze({
    schemaVersion: 1 as const,
    version: parsed.data.version,
    grantId: parsed.data.grant_id,
    householdId: parsed.data.household_id,
    userId: parsed.data.original_owner_user_id,
    sessionId: parsed.data.session_id,
    requestId: parsed.data.request_id,
    membershipId: parsed.data.membership_id,
    role: parsed.data.role,
    privateSpaceId: parsed.data.private_space_id,
    writableSpaceIds: [...parsed.data.writable_space_ids],
    issuedAt: parsed.data.issued_at.toISOString(),
    expiresAt: parsed.data.expires_at.toISOString(),
  });
};

const principalFrom = (input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly householdId: string;
}): Readonly<DurableRepositoryPrincipal> =>
  parseDurablePrincipal({
    userId: input.userId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    householdId: input.householdId,
  });

const assertExactBinding = (
  grant: Readonly<ActiveSpaceAccessGrant>,
  input: {
    readonly grantId?: string;
    readonly householdId: string;
    readonly membershipId?: string;
    readonly requestId: string;
    readonly role?: 'owner' | 'member';
    readonly sessionId: string;
    readonly spaceId?: string;
    readonly userId: string;
  },
): void => {
  if (
    (input.grantId !== undefined && grant.grantId !== input.grantId) ||
    grant.householdId !== input.householdId ||
    (input.membershipId !== undefined &&
      grant.membershipId !== input.membershipId) ||
    grant.requestId !== input.requestId ||
    (input.role !== undefined && grant.role !== input.role) ||
    grant.sessionId !== input.sessionId ||
    grant.userId !== input.userId ||
    (input.spaceId !== undefined &&
      !grant.writableSpaceIds.includes(input.spaceId))
  ) {
    throw new SpaceAccessGrantError(
      'authorization-revoked',
      'Space access grant binding is no longer authorized',
    );
  }
};

export class PostgresSpaceAccessGrantService implements SpaceAccessGrantVerifier {
  constructor(private readonly pool: DatabasePool) {}

  async checkReady(): Promise<boolean> {
    const client = await this.pool.connect().catch(() => undefined);
    if (client === undefined) return false;
    let destroy = false;
    try {
      const result = await client.query(
        `/* space_access_grant_ready */
         select (
           session_user = 'emdo_api_login'
           and current_user = session_user
           and pg_catalog.pg_has_role(session_user, 'emdo_app', 'USAGE')
           and not pg_catalog.pg_has_role(
             session_user, 'emdo_space_grant_executor', 'USAGE'
           )
           and exists (
             select 1
               from pg_catalog.pg_roles as role
              where role.rolname = session_user
                and role.rolcanlogin is true
                and role.rolinherit is true
                and role.rolsuper is false
                and role.rolbypassrls is false
                and role.rolcreatedb is false
                and role.rolcreaterole is false
                and role.rolreplication is false
           )
           and pg_catalog.has_schema_privilege(
             session_user, 'emdo', 'USAGE'
           )
           and pg_catalog.has_function_privilege(
             session_user,
             pg_catalog.to_regprocedure(
               'emdo.issue_active_principal_scope(uuid,uuid,text)'
             ),
             'EXECUTE'
           )
           and pg_catalog.has_function_privilege(
             session_user,
             pg_catalog.to_regprocedure(
               'emdo.resolve_space_access_grant(uuid,uuid,uuid,uuid,uuid,uuid)'
             ),
             'EXECUTE'
           )
           and pg_catalog.has_function_privilege(
             session_user,
             pg_catalog.to_regprocedure(
               'emdo.lock_active_request_scope(uuid,uuid,uuid)'
             ),
             'EXECUTE'
           )
         ) as ready`,
      );
      const ready =
        result.rows.length === 1 &&
        ReadinessRowSchema.safeParse(result.rows[0]).data?.ready === true;
      destroy = !ready;
      return ready;
    } catch {
      destroy = true;
      return false;
    } finally {
      client.release(destroy ? true : undefined);
    }
  }

  async resolveActivePrincipalScope(input: {
    readonly activeMembershipId: string;
    readonly householdId: string;
    readonly requestId: string;
    readonly role: 'owner' | 'member';
    readonly sessionId: string;
    readonly userId: string;
  }): Promise<{
    readonly collectionAuthorizationScopeFingerprint: string;
    readonly emailVerified: true;
    readonly householdId: string;
    readonly membershipId: string;
    readonly requestId: string;
    readonly role: 'owner' | 'member';
    readonly sessionId: string;
    readonly spaceAccessGrantId: string;
    readonly userId: string;
  }> {
    const parsed = ActivePrincipalScopeInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new SpaceAccessGrantError(
        'invalid-input',
        'Active principal scope input is malformed',
      );
    }
    const principal = principalFrom(parsed.data);
    return withClaimedTransaction(this.pool, principal, async (client) => {
      const row = firstResultRow(
        await client.query(
          `select user_id, session_id, request_id, household_id,
                  membership_id, role, email_verified, space_access_grant_id,
                  collection_authorization_scope_fingerprint
             from emdo.issue_active_principal_scope($1, $2, $3)`,
          [
            parsed.data.householdId,
            parsed.data.activeMembershipId,
            parsed.data.role,
          ],
        ),
      );
      if (row === undefined) {
        throw new SpaceAccessGrantError(
          'authorization-revoked',
          'Canonical membership could not issue a space access grant',
        );
      }
      const scope = ActivePrincipalScopeRowSchema.safeParse(row);
      if (!scope.success) {
        throw new SpaceAccessGrantError(
          'invalid-result',
          'Database returned a malformed active principal scope',
        );
      }
      if (
        scope.data.user_id !== parsed.data.userId ||
        scope.data.session_id !== parsed.data.sessionId ||
        scope.data.request_id !== parsed.data.requestId ||
        scope.data.household_id !== parsed.data.householdId ||
        scope.data.membership_id !== parsed.data.activeMembershipId ||
        scope.data.role !== parsed.data.role
      ) {
        throw new SpaceAccessGrantError(
          'authorization-revoked',
          'Active principal scope binding is no longer authorized',
        );
      }
      return deepFreeze({
        collectionAuthorizationScopeFingerprint:
          scope.data.collection_authorization_scope_fingerprint,
        emailVerified: scope.data.email_verified,
        householdId: scope.data.household_id,
        membershipId: scope.data.membership_id,
        requestId: scope.data.request_id,
        role: scope.data.role,
        sessionId: scope.data.session_id,
        spaceAccessGrantId: scope.data.space_access_grant_id,
        userId: scope.data.user_id,
      });
    });
  }

  async verify(input: {
    readonly grantId: string;
    readonly householdId: string;
    readonly requestId: string;
    readonly sessionId: string;
    readonly spaceId: string;
    readonly userId: string;
  }): Promise<Readonly<ActiveSpaceAccessGrant>> {
    const parsed = VerifyInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new SpaceAccessGrantError(
        'invalid-input',
        'Space access grant verification input is malformed',
      );
    }
    const principal = principalFrom(parsed.data);
    return withClaimedTransaction(this.pool, principal, async (client) => {
      const row = firstResultRow(
        await client.query(
          `select schema_version, version, grant_id, household_id,
                  original_owner_user_id, session_id, request_id,
                  membership_id, role, private_space_id, writable_space_ids,
                  issued_at, expires_at
             from emdo.resolve_space_access_grant($1, $2, $3, $4, $5, $6)`,
          [
            parsed.data.grantId,
            parsed.data.householdId,
            parsed.data.userId,
            parsed.data.sessionId,
            parsed.data.requestId,
            parsed.data.spaceId,
          ],
        ),
      );
      if (row === undefined) {
        throw new SpaceAccessGrantError(
          'authorization-revoked',
          'Space access grant is absent, expired, or no longer authorized',
        );
      }
      const grant = parseGrantRow(row);
      assertExactBinding(grant, parsed.data);
      return grant;
    });
  }
}
