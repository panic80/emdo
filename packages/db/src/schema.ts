import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { JsonValue } from '@emdo/contracts';

export const emdoSchema = pgSchema('emdo');

const vector1536 = customType<{
  data: readonly number[];
  driverData: string;
}>({
  dataType: () => 'vector(1536)',
  fromDriver: (value) => {
    const inner = value.slice(1, -1);
    return inner.length === 0 ? [] : inner.split(',').map(Number);
  },
  toDriver: (value) => `[${value.join(',')}]`,
});

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const authUsers = emdoSchema.table(
  'auth_users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    image: text('image'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('auth_users_email_unique').on(sql`lower(${table.email})`),
    check(
      'auth_users_email_normalized',
      sql`${table.email} = lower(${table.email})`,
    ),
  ],
);

export const authSessions = emdoSchema.table(
  'auth_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, {
        onDelete: 'cascade',
        onUpdate: 'restrict',
      }),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    activeHouseholdId: uuid('active_household_id').references(
      (): AnyPgColumn => households.id,
      {
        onDelete: 'set null',
        onUpdate: 'restrict',
      },
    ),
    ...timestamps,
  },
  (table) => [
    unique('auth_sessions_token_unique').on(table.token),
    index('auth_sessions_user_id_idx').on(table.userId),
    index('auth_sessions_expires_at_idx').on(table.expiresAt),
    index('auth_sessions_active_household_id_idx').on(table.activeHouseholdId),
  ],
);

export const authAccounts = emdoSchema.table(
  'auth_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, {
        onDelete: 'cascade',
        onUpdate: 'restrict',
      }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
    }),
    scope: text('scope'),
    password: text('password'),
    ...timestamps,
  },
  (table) => [
    unique('auth_accounts_provider_account_unique').on(
      table.providerId,
      table.accountId,
    ),
    index('auth_accounts_user_id_idx').on(table.userId),
  ],
);

export const authVerifications = emdoSchema.table(
  'auth_verifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    index('auth_verifications_identifier_idx').on(table.identifier),
    index('auth_verifications_expires_at_idx').on(table.expiresAt),
  ],
);

export const authPasskeys = emdoSchema.table(
  'auth_passkeys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, {
        onDelete: 'cascade',
        onUpdate: 'restrict',
      }),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    credentialID: text('credential_id').notNull(),
    counter: bigint('counter', { mode: 'number' }).default(0).notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').default(false).notNull(),
    transports: text('transports'),
    aaguid: text('aaguid'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('auth_passkeys_credential_id_unique').on(table.credentialID),
    index('auth_passkeys_user_id_idx').on(table.userId),
    check('auth_passkeys_counter_nonnegative', sql`${table.counter} >= 0`),
  ],
);

export const authRateLimits = emdoSchema.table(
  'auth_rate_limits',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    key: text('key').notNull(),
    count: integer('count').notNull(),
    lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
  },
  (table) => [
    unique('auth_rate_limits_key_unique').on(table.key),
    check('auth_rate_limits_count_nonnegative', sql`${table.count} >= 0`),
    check(
      'auth_rate_limits_last_request_nonnegative',
      sql`${table.lastRequest} >= 0`,
    ),
  ],
);

export const households = emdoSchema.table(
  'households',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    logo: text('logo'),
    metadata: text('metadata'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => authUsers.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    ...timestamps,
  },
  (table) => [
    unique('households_slug_unique').on(table.slug),
    index('households_created_by_user_id_idx').on(table.createdByUserId),
  ],
);

export const householdMemberships = emdoSchema.table(
  'household_memberships',
  {
    id: uuid('id').defaultRandom().notNull(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    role: text('role').notNull(),
    status: text('status').default('active').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('household_memberships_id_unique').on(table.id),
    primaryKey({
      name: 'household_memberships_pk',
      columns: [table.householdId, table.userId],
    }),
    index('household_memberships_user_id_idx').on(table.userId),
    index('household_memberships_active_idx').on(
      table.householdId,
      table.userId,
      table.status,
    ),
    check(
      'household_memberships_role_check',
      sql`${table.role} in ('owner', 'member')`,
    ),
    check(
      'household_memberships_status_check',
      sql`${table.status} in ('active', 'inactive')`,
    ),
    check(
      'household_memberships_ended_status_check',
      sql`(${table.status} = 'active' and ${table.endedAt} is null) or (${table.status} = 'inactive' and ${table.endedAt} is not null)`,
    ),
  ],
);

/**
 * Better Auth organization reads must never turn a tombstoned membership back
 * into authorization. The security-barrier projection is owned by a dedicated
 * no-login reader and remains read-only to the auth runtime role.
 */
export const activeHouseholdMemberships = emdoSchema
  .view('active_household_memberships', {
    id: uuid('id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  })
  .with({ securityBarrier: true })
  .as(sql`select id, household_id as organization_id, user_id, role,
                 joined_at as created_at
            from emdo.household_memberships
           where status = 'active'`);

export const betterAuthOrganizations = emdoSchema
  .view('better_auth_organizations', {
    id: uuid('id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    logo: text('logo'),
    metadata: text('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  })
  .with({ securityBarrier: true })
  .as(sql`select id, name, slug, logo, metadata, created_at
            from emdo.households`);

export const spaces = emdoSchema.table(
  'spaces',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    householdId: uuid('household_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    name: text('name').notNull(),
    visibility: text('visibility').notNull(),
    revision: integer('revision').default(1).notNull(),
    tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique('spaces_household_id_id_unique').on(table.householdId, table.id),
    foreignKey({
      name: 'spaces_original_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('spaces_household_owner_idx').on(
      table.householdId,
      table.originalOwnerUserId,
    ),
    index('spaces_household_visibility_idx').on(
      table.householdId,
      table.visibility,
    ),
    check(
      'spaces_visibility_check',
      sql`${table.visibility} in ('private', 'shared')`,
    ),
    check('spaces_revision_positive', sql`${table.revision} > 0`),
  ],
);

export const spaceRecords = emdoSchema.table(
  'space_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    recordKind: text('record_kind').notNull(),
    payload: jsonb('payload').$type<JsonValue>().notNull(),
    actorIntent: text('actor_intent').notNull(),
    revision: integer('revision').default(1).notNull(),
    tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique('space_records_household_space_id_unique').on(
      table.householdId,
      table.spaceId,
      table.id,
    ),
    foreignKey({
      name: 'space_records_household_space_fk',
      columns: [table.householdId, table.spaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'space_records_original_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('space_records_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('space_records_household_owner_idx').on(
      table.householdId,
      table.originalOwnerUserId,
    ),
    index('space_records_kind_created_idx').on(
      table.recordKind,
      table.createdAt,
    ),
    check('space_records_revision_positive', sql`${table.revision} > 0`),
  ],
);

export const conversationEvents = emdoSchema.table(
  'conversation_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    clientEventId: text('client_event_id').notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<JsonValue>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    purgeAfter: timestamp('purge_after', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'conversation_events_household_space_fk',
      columns: [table.householdId, table.spaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'conversation_events_original_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    unique('conversation_events_conversation_sequence_unique').on(
      table.conversationId,
      table.sequence,
    ),
    unique('conversation_events_client_event_unique').on(
      table.householdId,
      table.originalOwnerUserId,
      table.clientEventId,
    ),
    index('conversation_events_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('conversation_events_conversation_idx').on(
      table.conversationId,
      table.sequence,
    ),
    check('conversation_events_sequence_positive', sql`${table.sequence} > 0`),
  ],
);

export const auditEvents = emdoSchema.table(
  'audit_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    actorUserId: uuid('actor_user_id'),
    sessionId: uuid('session_id'),
    requestId: uuid('request_id'),
    runId: uuid('run_id'),
    proposalId: uuid('proposal_id'),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<JsonValue>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '12 months'`),
  },
  (table) => [
    foreignKey({
      name: 'audit_events_household_space_fk',
      columns: [table.householdId, table.spaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'audit_events_original_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('audit_events_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('audit_events_household_occurred_idx').on(
      table.householdId,
      table.occurredAt,
    ),
    index('audit_events_proposal_id_idx').on(table.proposalId),
  ],
);

export const agentRuns = emdoSchema.table(
  'agent_runs',
  {
    id: uuid('id').primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    parentRunId: uuid('parent_run_id'),
    agentId: text('agent_id').notNull(),
    agentVersion: text('agent_version').notNull(),
    requestedModel: text('requested_model').notNull(),
    resolvedModel: text('resolved_model'),
    modelReason: text('model_reason'),
    status: text('status').notNull(),
    localTraceReference: text('local_trace_reference'),
    safeError: jsonb('safe_error').$type<JsonValue>(),
    usage: jsonb('usage').$type<JsonValue>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    unique('agent_runs_scope_id_unique').on(
      table.householdId,
      table.spaceId,
      table.originalOwnerUserId,
      table.id,
    ),
    foreignKey({
      name: 'agent_runs_household_space_fk',
      columns: [table.householdId, table.spaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'agent_runs_original_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('agent_runs_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('agent_runs_household_owner_created_idx').on(
      table.householdId,
      table.originalOwnerUserId,
      table.createdAt,
    ),
    check(
      'agent_runs_status_check',
      sql`${table.status} in ('queued', 'running', 'completed', 'failed', 'blocked')`,
    ),
  ],
);

export const disclosureGrants = emdoSchema.table(
  'disclosure_grants',
  {
    id: uuid('id').primaryKey(),
    schemaVersion: smallint('schema_version').default(1).notNull(),
    version: integer('version').notNull(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    userId: uuid('user_id').notNull(),
    runId: uuid('run_id').notNull(),
    agentId: text('agent_id').notNull(),
    purpose: text('purpose').notNull(),
    provider: text('provider').notNull(),
    recordAllowlist: jsonb('record_allowlist').$type<JsonValue>().notNull(),
    grantHash: text('grant_hash').notNull(),
    oneRunOnly: boolean('one_run_only').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    unique('disclosure_grants_scope_id_unique').on(
      table.householdId,
      table.spaceId,
      table.userId,
      table.id,
    ),
    foreignKey({
      name: 'disclosure_grants_household_space_fk',
      columns: [table.householdId, table.spaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'disclosure_grants_user_membership_fk',
      columns: [table.householdId, table.userId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'disclosure_grants_run_fk',
      columns: [table.householdId, table.spaceId, table.userId, table.runId],
      foreignColumns: [
        agentRuns.householdId,
        agentRuns.spaceId,
        agentRuns.originalOwnerUserId,
        agentRuns.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('disclosure_grants_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('disclosure_grants_user_expiry_idx').on(
      table.userId,
      table.expiresAt,
    ),
    check(
      'disclosure_grants_schema_version_check',
      sql`${table.schemaVersion} = 1`,
    ),
    check('disclosure_grants_version_positive', sql`${table.version} > 0`),
    check('disclosure_grants_one_run_only', sql`${table.oneRunOnly} = true`),
    check(
      'disclosure_grants_lifetime_check',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      'disclosure_grants_terminal_check',
      sql`not (${table.consumedAt} is not null and ${table.revokedAt} is not null)`,
    ),
    check(
      'disclosure_grants_hash_check',
      sql`${table.grantHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const actionProposals = emdoSchema.table(
  'action_proposals',
  {
    id: uuid('id').primaryKey(),
    schemaVersion: smallint('schema_version').default(1).notNull(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    runId: uuid('run_id').notNull(),
    disclosureGrantId: uuid('disclosure_grant_id').notNull(),
    capabilityId: text('capability_id').notNull(),
    capabilityFingerprint: text('capability_fingerprint').notNull(),
    canonicalArguments: jsonb('canonical_arguments')
      .$type<JsonValue>()
      .notNull(),
    targets: jsonb('targets').$type<JsonValue>().notNull(),
    beforePreview: jsonb('before_preview').$type<JsonValue>().notNull(),
    afterPreview: jsonb('after_preview').$type<JsonValue>().notNull(),
    providerPreconditions: jsonb('provider_preconditions')
      .$type<JsonValue>()
      .notNull(),
    payloadHash: text('payload_hash').notNull(),
    approvalHash: text('approval_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('action_proposals_scope_id_unique').on(
      table.householdId,
      table.spaceId,
      table.originalOwnerUserId,
      table.id,
    ),
    foreignKey({
      name: 'action_proposals_household_space_fk',
      columns: [table.householdId, table.spaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'action_proposals_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'action_proposals_run_fk',
      columns: [
        table.householdId,
        table.spaceId,
        table.originalOwnerUserId,
        table.runId,
      ],
      foreignColumns: [
        agentRuns.householdId,
        agentRuns.spaceId,
        agentRuns.originalOwnerUserId,
        agentRuns.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'action_proposals_disclosure_grant_fk',
      columns: [
        table.householdId,
        table.spaceId,
        table.originalOwnerUserId,
        table.disclosureGrantId,
      ],
      foreignColumns: [
        disclosureGrants.householdId,
        disclosureGrants.spaceId,
        disclosureGrants.userId,
        disclosureGrants.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    unique('action_proposals_idempotency_unique').on(
      table.householdId,
      table.originalOwnerUserId,
      table.capabilityId,
      table.idempotencyKey,
    ),
    index('action_proposals_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('action_proposals_grant_idx').on(
      table.householdId,
      table.disclosureGrantId,
    ),
    check(
      'action_proposals_schema_version_check',
      sql`${table.schemaVersion} = 1`,
    ),
    check(
      'action_proposals_lifetime_check',
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '10 minutes'`,
    ),
    check(
      'action_proposals_hash_check',
      sql`${table.payloadHash} ~ '^[a-f0-9]{64}$' and ${table.approvalHash} ~ '^[a-f0-9]{64}$' and ${table.capabilityFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const proposalStates = emdoSchema.table(
  'proposal_states',
  {
    proposalId: uuid('proposal_id').primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    version: integer('version').default(1).notNull(),
    state: text('state').default('pending').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'proposal_states_proposal_fk',
      columns: [
        table.householdId,
        table.spaceId,
        table.originalOwnerUserId,
        table.proposalId,
      ],
      foreignColumns: [
        actionProposals.householdId,
        actionProposals.spaceId,
        actionProposals.originalOwnerUserId,
        actionProposals.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('proposal_states_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    check('proposal_states_version_positive', sql`${table.version} > 0`),
    check(
      'proposal_states_state_check',
      sql`${table.state} in ('pending', 'approved', 'rejected', 'prepared', 'executing', 'executed', 'not-applied', 'indeterminate', 'expired', 'failed')`,
    ),
  ],
);

export const actionDecisions = emdoSchema.table(
  'action_decisions',
  {
    id: uuid('id').primaryKey(),
    schemaVersion: smallint('schema_version').default(1).notNull(),
    proposalId: uuid('proposal_id').notNull(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    authenticatedSessionId: uuid('authenticated_session_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    approvalHash: text('approval_hash').notNull(),
    decision: text('decision').notNull(),
    channel: text('channel').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'action_decisions_proposal_fk',
      columns: [
        table.householdId,
        table.spaceId,
        table.originalOwnerUserId,
        table.proposalId,
      ],
      foreignColumns: [
        actionProposals.householdId,
        actionProposals.spaceId,
        actionProposals.originalOwnerUserId,
        actionProposals.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    unique('action_decisions_proposal_unique').on(table.proposalId),
    unique('action_decisions_scope_id_unique').on(
      table.householdId,
      table.spaceId,
      table.originalOwnerUserId,
      table.id,
    ),
    unique('action_decisions_idempotency_unique').on(
      table.householdId,
      table.originalOwnerUserId,
      table.idempotencyKey,
    ),
    index('action_decisions_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    check(
      'action_decisions_schema_version_check',
      sql`${table.schemaVersion} = 1`,
    ),
    check(
      'action_decisions_decision_check',
      sql`${table.decision} in ('approved', 'rejected')`,
    ),
    check(
      'action_decisions_channel_check',
      sql`${table.channel} = 'authenticated-visual'`,
    ),
  ],
);

export const providerAttempts = emdoSchema.table(
  'provider_attempts',
  {
    id: uuid('id').primaryKey(),
    proposalId: uuid('proposal_id').notNull(),
    decisionId: uuid('decision_id').notNull(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    attemptVersion: integer('attempt_version').notNull(),
    attemptState: text('attempt_state').default('prepared').notNull(),
    bindingHash: text('binding_hash').notNull(),
    capabilityFingerprint: text('capability_fingerprint').notNull(),
    approvalHash: text('approval_hash').notNull(),
    disclosureGrantId: uuid('disclosure_grant_id').notNull(),
    disclosureGrantHash: text('disclosure_grant_hash').notNull(),
    providerId: text('provider_id').notNull(),
    providerIdempotencyKey: text('provider_idempotency_key').notNull(),
    idempotencyExpiresAt: timestamp('idempotency_expires_at', {
      withTimezone: true,
    }).notNull(),
    targetSetHash: text('target_set_hash').notNull(),
    targets: jsonb('targets').$type<JsonValue>().notNull(),
    providerPreconditions: jsonb('provider_preconditions')
      .$type<JsonValue>()
      .notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'provider_attempts_proposal_fk',
      columns: [
        table.householdId,
        table.spaceId,
        table.originalOwnerUserId,
        table.proposalId,
      ],
      foreignColumns: [
        actionProposals.householdId,
        actionProposals.spaceId,
        actionProposals.originalOwnerUserId,
        actionProposals.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'provider_attempts_decision_fk',
      columns: [
        table.householdId,
        table.spaceId,
        table.originalOwnerUserId,
        table.decisionId,
      ],
      foreignColumns: [
        actionDecisions.householdId,
        actionDecisions.spaceId,
        actionDecisions.originalOwnerUserId,
        actionDecisions.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    unique('provider_attempts_proposal_unique').on(table.proposalId),
    unique('provider_attempts_decision_unique').on(table.decisionId),
    unique('provider_attempts_scope_id_unique').on(
      table.householdId,
      table.spaceId,
      table.originalOwnerUserId,
      table.id,
    ),
    unique('provider_attempts_provider_key_unique').on(
      table.providerId,
      table.providerIdempotencyKey,
    ),
    index('provider_attempts_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('provider_attempts_decision_idx').on(table.decisionId),
    check(
      'provider_attempts_version_positive',
      sql`${table.attemptVersion} > 0`,
    ),
    check(
      'provider_attempts_state_check',
      sql`${table.attemptState} in ('prepared', 'dispatching', 'executed', 'not-applied', 'indeterminate')`,
    ),
    check(
      'provider_attempts_dispatch_time_check',
      sql`(${table.attemptState} = 'prepared' and ${table.dispatchedAt} is null) or (${table.attemptState} <> 'prepared' and ${table.dispatchedAt} is not null)`,
    ),
    check(
      'provider_attempts_idempotency_lifetime_check',
      sql`${table.idempotencyExpiresAt} > ${table.issuedAt}`,
    ),
    check(
      'provider_attempts_hash_check',
      sql`${table.bindingHash} ~ '^[a-f0-9]{64}$' and ${table.capabilityFingerprint} ~ '^[a-f0-9]{64}$' and ${table.approvalHash} ~ '^[a-f0-9]{64}$' and ${table.disclosureGrantHash} ~ '^[a-f0-9]{64}$' and ${table.providerIdempotencyKey} ~ '^[a-f0-9]{64}$' and ${table.targetSetHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const providerOutcomes = emdoSchema.table(
  'provider_outcomes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    attemptId: uuid('attempt_id').notNull(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    completionHash: text('completion_hash').notNull(),
    application: text('application').notNull(),
    reason: text('reason'),
    outputStatus: text('output_status'),
    resultHash: text('result_hash'),
    evidenceHash: text('evidence_hash'),
    safeErrorCode: text('safe_error_code'),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'provider_outcomes_attempt_fk',
      columns: [
        table.householdId,
        table.spaceId,
        table.originalOwnerUserId,
        table.attemptId,
      ],
      foreignColumns: [
        providerAttempts.householdId,
        providerAttempts.spaceId,
        providerAttempts.originalOwnerUserId,
        providerAttempts.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    unique('provider_outcomes_attempt_unique').on(table.attemptId),
    index('provider_outcomes_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    check(
      'provider_outcomes_application_check',
      sql`${table.application} in ('applied', 'not-applied', 'indeterminate')`,
    ),
    check(
      'provider_outcomes_completion_hash_check',
      sql`${table.completionHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const proposalReconciliations = emdoSchema.table(
  'proposal_reconciliations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    attemptId: uuid('attempt_id').notNull(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    completionHash: text('completion_hash').notNull(),
    application: text('application').notNull(),
    resultHash: text('result_hash'),
    evidenceHash: text('evidence_hash'),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'proposal_reconciliations_attempt_fk',
      columns: [
        table.householdId,
        table.spaceId,
        table.originalOwnerUserId,
        table.attemptId,
      ],
      foreignColumns: [
        providerAttempts.householdId,
        providerAttempts.spaceId,
        providerAttempts.originalOwnerUserId,
        providerAttempts.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    unique('proposal_reconciliations_attempt_unique').on(table.attemptId),
    index('proposal_reconciliations_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    check(
      'proposal_reconciliations_application_check',
      sql`${table.application} in ('applied', 'not-applied')`,
    ),
    check(
      'proposal_reconciliations_completion_hash_check',
      sql`${table.completionHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const proposalEvents = emdoSchema.table(
  'proposal_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    proposalId: uuid('proposal_id').notNull(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    proposalVersion: integer('proposal_version').notNull(),
    sequence: integer('sequence').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<JsonValue>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'proposal_events_proposal_fk',
      columns: [
        table.householdId,
        table.spaceId,
        table.originalOwnerUserId,
        table.proposalId,
      ],
      foreignColumns: [
        actionProposals.householdId,
        actionProposals.spaceId,
        actionProposals.originalOwnerUserId,
        actionProposals.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    unique('proposal_events_sequence_unique').on(
      table.proposalId,
      table.sequence,
    ),
    index('proposal_events_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    check(
      'proposal_events_version_positive',
      sql`${table.proposalVersion} > 0`,
    ),
    check('proposal_events_sequence_positive', sql`${table.sequence} > 0`),
  ],
);

export const invitations = emdoSchema.table(
  'invitations',
  {
    id: uuid('id').primaryKey(),
    householdId: uuid('household_id').notNull(),
    invitedByUserId: uuid('invited_by_user_id').notNull(),
    email: text('email').notNull(),
    role: text('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumedByUserId: uuid('consumed_by_user_id'),
    consumedSessionId: uuid('consumed_session_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'invitations_issuer_membership_fk',
      columns: [table.householdId, table.invitedByUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    unique('invitations_token_hash_unique').on(table.tokenHash),
    index('invitations_household_email_idx').on(table.householdId, table.email),
    index('invitations_expires_at_idx').on(table.expiresAt),
    check(
      'invitations_email_normalized',
      sql`${table.email} = lower(${table.email})`,
    ),
    check('invitations_role_check', sql`${table.role} in ('owner', 'member')`),
    check(
      'invitations_lifetime_check',
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '7 days'`,
    ),
    check(
      'invitations_terminal_check',
      sql`not (${table.consumedAt} is not null and ${table.revokedAt} is not null)`,
    ),
    check(
      'invitations_token_hash_check',
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/** Better Auth may inspect pending invitations but never receives token_hash. */
export const betterAuthInvitations = emdoSchema
  .view('better_auth_invitations', {
    id: uuid('id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    email: text('email').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    inviterId: uuid('inviter_id').notNull(),
  })
  .with({ securityBarrier: true })
  .as(sql`select id, household_id as organization_id, email, role,
                 'pending'::text as status,
                 expires_at, created_at, invited_by_user_id as inviter_id
            from emdo.invitations
           where consumed_at is null
             and revoked_at is null
             and expires_at > clock_timestamp()`);

export const rotatingSessions = emdoSchema.table(
  'rotating_sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, {
        onDelete: 'cascade',
        onUpdate: 'restrict',
      }),
    tokenHash: text('token_hash').notNull(),
    rotation: integer('rotation').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    unique('rotating_sessions_token_hash_unique').on(table.tokenHash),
    index('rotating_sessions_user_id_idx').on(table.userId),
    index('rotating_sessions_expires_at_idx').on(table.expiresAt),
    check(
      'rotating_sessions_rotation_nonnegative',
      sql`${table.rotation} >= 0`,
    ),
    check(
      'rotating_sessions_lifetime_check',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      'rotating_sessions_token_hash_check',
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const memoryChunks = emdoSchema.table(
  'memory_chunks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    sourceRecordId: uuid('source_record_id'),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    embedding: vector1536('embedding'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'memory_chunks_household_space_fk',
      columns: [table.householdId, table.spaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'memory_chunks_original_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('memory_chunks_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('memory_chunks_source_record_idx').on(table.sourceRecordId),
    check(
      'memory_chunks_content_hash_check',
      sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/** Deployment-only singleton state; never exposed through runtime repositories. */
export const deploymentBootstraps = emdoSchema.table(
  'deployment_bootstraps',
  {
    bootstrapKey: text('bootstrap_key').primaryKey(),
    state: text('state').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    userId: uuid('user_id'),
    householdId: uuid('household_id'),
    membershipId: uuid('membership_id'),
    privateSpaceId: uuid('private_space_id'),
  },
  (table) => [
    check(
      'deployment_bootstraps_key_check',
      sql`${table.bootstrapKey} = 'initial-owner-v1'`,
    ),
    check(
      'deployment_bootstraps_state_check',
      sql`${table.state} in ('in_progress', 'complete')`,
    ),
    check(
      'deployment_bootstraps_terminal_check',
      sql`(
        ${table.state} = 'in_progress'
        and ${table.completedAt} is null
        and ${table.userId} is null
        and ${table.householdId} is null
        and ${table.membershipId} is null
        and ${table.privateSpaceId} is null
      ) or (
        ${table.state} = 'complete'
        and ${table.completedAt} is not null
        and ${table.completedAt} >= ${table.startedAt}
        and ${table.userId} is not null
        and ${table.householdId} is not null
        and ${table.membershipId} is not null
        and ${table.privateSpaceId} is not null
      )`,
    ),
    unique('deployment_bootstraps_user_unique').on(table.userId),
    unique('deployment_bootstraps_household_unique').on(table.householdId),
    unique('deployment_bootstraps_membership_unique').on(table.membershipId),
    unique('deployment_bootstraps_private_space_unique').on(
      table.privateSpaceId,
    ),
    foreignKey({
      name: 'deployment_bootstraps_user_fk',
      columns: [table.userId],
      foreignColumns: [authUsers.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'deployment_bootstraps_household_fk',
      columns: [table.householdId],
      foreignColumns: [households.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'deployment_bootstraps_membership_fk',
      columns: [table.membershipId],
      foreignColumns: [householdMemberships.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'deployment_bootstraps_private_space_fk',
      columns: [table.privateSpaceId],
      foreignColumns: [spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  ],
);

export const foundationTables = Object.freeze({
  action_decisions: actionDecisions,
  action_proposals: actionProposals,
  agent_runs: agentRuns,
  audit_events: auditEvents,
  auth_accounts: authAccounts,
  auth_passkeys: authPasskeys,
  auth_rate_limits: authRateLimits,
  auth_sessions: authSessions,
  auth_users: authUsers,
  auth_verifications: authVerifications,
  conversation_events: conversationEvents,
  disclosure_grants: disclosureGrants,
  deployment_bootstraps: deploymentBootstraps,
  household_memberships: householdMemberships,
  households,
  invitations,
  memory_chunks: memoryChunks,
  proposal_events: proposalEvents,
  proposal_reconciliations: proposalReconciliations,
  proposal_states: proposalStates,
  provider_attempts: providerAttempts,
  provider_outcomes: providerOutcomes,
  rotating_sessions: rotatingSessions,
  space_records: spaceRecords,
  spaces,
});

/**
 * Exact Better Auth organization field mapping. The plugin is read/session
 * context only for MVP; EMDO owns every household, membership, and invitation
 * mutation through its scoped services and onboarding routine.
 */
export const betterAuthOrganizationPluginSchema = Object.freeze({
  session: {
    fields: { activeOrganizationId: 'activeHouseholdId' },
  },
});

/** Exact Better Auth model keys; physical table names remain namespaced. */
export const betterAuthSchema = Object.freeze({
  user: authUsers,
  session: authSessions,
  account: authAccounts,
  verification: authVerifications,
  passkey: authPasskeys,
  rateLimit: authRateLimits,
  organization: betterAuthOrganizations,
  member: activeHouseholdMemberships,
  invitation: betterAuthInvitations,
});
