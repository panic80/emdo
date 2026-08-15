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
    administrationVersion: integer('administration_version')
      .default(1)
      .notNull(),
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
    check(
      'household_memberships_administration_version_positive',
      sql`${table.administrationVersion} > 0`,
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
    retainUntil: timestamp('retain_until', { withTimezone: true })
      .default(sql`now() + interval '90 days'`)
      .notNull(),
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
    check(
      'agent_runs_retention_check',
      sql`${table.retainUntil} > ${table.createdAt} and ${table.retainUntil} <= ${table.createdAt} + interval '90 days'`,
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
    phasePurpose: text('phase_purpose')
      .default('specialist-execution')
      .notNull(),
    provider: text('provider').notNull(),
    recordAllowlist: jsonb('record_allowlist').$type<JsonValue>().notNull(),
    grantHash: text('grant_hash').notNull(),
    oneRunOnly: boolean('one_run_only').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    administrationVersion: integer('administration_version')
      .default(1)
      .notNull(),
  },
  (table) => [
    unique('disclosure_grants_scope_id_unique').on(
      table.householdId,
      table.spaceId,
      table.userId,
      table.id,
    ),
    unique('disclosure_grants_run_phase_agent_unique').on(
      table.householdId,
      table.spaceId,
      table.userId,
      table.runId,
      table.agentId,
      table.phasePurpose,
      table.provider,
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
      'disclosure_grants_phase_purpose_check',
      sql`${table.phasePurpose} in ('manager-plan', 'specialist-execution', 'manager-synthesis')`,
    ),
    check(
      'disclosure_grants_lifetime_check',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      'disclosure_grants_terminal_check',
      sql`(${table.consumedAt} is null or (${table.consumedAt} >= ${table.createdAt} and ${table.consumedAt} < ${table.expiresAt})) and (${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt})`,
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
    approvalDisplay: jsonb('approval_display').$type<JsonValue>().notNull(),
    providerPreconditions: jsonb('provider_preconditions')
      .$type<JsonValue>()
      .notNull(),
    providerAuthorityBindingHash: text(
      'provider_authority_binding_hash',
    ).notNull(),
    authorizationScopeFingerprint: text(
      'authorization_scope_fingerprint',
    ).notNull(),
    providerSdkCallId: text('provider_sdk_call_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    approvalHash: text('approval_hash').notNull(),
    disclosureGrant: jsonb('disclosure_grant').$type<JsonValue>().notNull(),
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
    unique('action_proposals_provider_sdk_call_unique').on(
      table.householdId,
      table.originalOwnerUserId,
      table.runId,
      table.capabilityId,
      table.providerSdkCallId,
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
    check(
      'action_proposals_provider_authority_binding_hash_check',
      sql`${table.providerAuthorityBindingHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'action_proposals_authorization_scope_fingerprint_check',
      sql`${table.authorizationScopeFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'action_proposals_provider_sdk_call_id_check',
      sql`length(${table.providerSdkCallId}) between 1 and 512 and btrim(${table.providerSdkCallId}) = ${table.providerSdkCallId} and ${table.providerSdkCallId} !~ '[[:cntrl:]]'`,
    ),
    check(
      'action_proposals_disclosure_grant_check',
      sql`jsonb_typeof(${table.disclosureGrant}) = 'object' and octet_length(${table.disclosureGrant}::text) <= 262144 and ${table.disclosureGrant} ->> 'id' = ${table.disclosureGrantId}::text and ${table.disclosureGrant} ->> 'runId' = ${table.runId}::text and ${table.disclosureGrant} ->> 'householdId' = ${table.householdId}::text and ${table.disclosureGrant} ->> 'userId' = ${table.originalOwnerUserId}::text`,
    ),
    check(
      'action_proposals_approval_display_check',
      sql`jsonb_typeof(${table.approvalDisplay}) = 'object' and octet_length(${table.approvalDisplay}::text) <= 131072 and ${table.approvalDisplay} ?& array['schemaVersion','title','summary','beforeSummary','afterSummary','fields']::text[] and ${table.approvalDisplay} - array['schemaVersion','title','summary','beforeSummary','afterSummary','fields']::text[] = '{}'::jsonb and ${table.approvalDisplay} -> 'schemaVersion' = '1'::jsonb and jsonb_typeof(${table.approvalDisplay} -> 'title') = 'string' and length(${table.approvalDisplay} ->> 'title') <= 200 and jsonb_typeof(${table.approvalDisplay} -> 'summary') = 'string' and length(${table.approvalDisplay} ->> 'summary') <= 1000 and jsonb_typeof(${table.approvalDisplay} -> 'beforeSummary') = 'string' and length(${table.approvalDisplay} ->> 'beforeSummary') <= 2000 and jsonb_typeof(${table.approvalDisplay} -> 'afterSummary') = 'string' and length(${table.approvalDisplay} ->> 'afterSummary') <= 2000 and jsonb_typeof(${table.approvalDisplay} -> 'fields') = 'array' and jsonb_array_length(${table.approvalDisplay} -> 'fields') <= 32`,
    ),
  ],
);

export const proposalPreparations = emdoSchema.table(
  'proposal_preparations',
  {
    proposalId: uuid('proposal_id').primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    preparationBinding: jsonb('preparation_binding')
      .$type<JsonValue>()
      .notNull(),
    preparationBindingHash: text('preparation_binding_hash').notNull(),
    abandonmentReason: text('abandonment_reason'),
    abandonedAt: timestamp('abandoned_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'proposal_preparations_proposal_fk',
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
    index('proposal_preparations_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    check(
      'proposal_preparations_binding_hash_check',
      sql`${table.preparationBindingHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'proposal_preparations_binding_check',
      sql`jsonb_typeof(${table.preparationBinding}) = 'object' and octet_length(${table.preparationBinding}::text) <= 65536 and ${table.preparationBinding} ->> 'proposalId' = ${table.proposalId}::text and ${table.preparationBinding} ->> 'householdId' = ${table.householdId}::text and ${table.preparationBinding} ->> 'userId' = ${table.originalOwnerUserId}::text`,
    ),
    check(
      'proposal_preparations_abandonment_check',
      sql`(${table.abandonmentReason} is null and ${table.abandonedAt} is null) or (${table.abandonmentReason} in ('multiple-provider-writes-require-separate-turns', 'execution-ended-before-checkpoint') and ${table.abandonedAt} is not null)`,
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
      table.proposalId,
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

export const visualDecisionProofs = emdoSchema.table(
  'visual_decision_proofs',
  {
    proofId: uuid('proof_id').primaryKey(),
    nonce: text('nonce').notNull(),
    keyId: text('key_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    bindingVersion: integer('binding_version').default(1).notNull(),
    issuanceFingerprint: text('issuance_fingerprint').notNull(),
    authorizationScopeFingerprint: text(
      'authorization_scope_fingerprint',
    ).notNull(),
    userId: uuid('user_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    proposalId: uuid('proposal_id').notNull(),
    proposalVersion: integer('proposal_version').notNull(),
    payloadHash: text('payload_hash').notNull(),
    approvalHash: text('approval_hash').notNull(),
    channel: text('channel').default('authenticated-visual').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    initialRequestId: uuid('initial_request_id').notNull(),
    latestRequestId: uuid('latest_request_id').notNull(),
    initialIssuedAt: timestamp('initial_issued_at', {
      withTimezone: true,
    }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    decisionId: uuid('decision_id'),
    rowVersion: integer('row_version').default(1).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'visual_decision_proofs_proposal_fk',
      columns: [
        table.householdId,
        table.spaceId,
        table.userId,
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
      name: 'visual_decision_proofs_owner_membership_fk',
      columns: [table.householdId, table.userId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'visual_decision_proofs_session_fk',
      columns: [table.sessionId],
      foreignColumns: [authSessions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    unique('visual_decision_proofs_token_hash_unique').on(table.tokenHash),
    unique('visual_decision_proofs_decision_unique').on(table.decisionId),
    unique('visual_decision_proofs_idempotency_unique').on(
      table.userId,
      table.proposalId,
      table.idempotencyKey,
    ),
    index('visual_decision_proofs_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('visual_decision_proofs_proposal_idx').on(
      table.proposalId,
      table.expiresAt,
    ),
    check(
      'visual_decision_proofs_token_material_check',
      sql`${table.nonce} ~ '^[A-Za-z0-9_-]{32,128}$' and ${table.keyId} ~ '^[a-z0-9]+([._-][a-z0-9]+)*$' and length(${table.keyId}) between 2 and 64 and ${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'visual_decision_proofs_binding_check',
      sql`${table.bindingVersion} = 1 and ${table.issuanceFingerprint} ~ '^[a-f0-9]{64}$' and ${table.authorizationScopeFingerprint} ~ '^[a-f0-9]{64}$' and ${table.payloadHash} ~ '^[a-f0-9]{64}$' and ${table.approvalHash} ~ '^[a-f0-9]{64}$' and ${table.channel} = 'authenticated-visual'`,
    ),
    check(
      'visual_decision_proofs_version_check',
      sql`${table.proposalVersion} > 0 and ${table.rowVersion} > 0`,
    ),
    check(
      'visual_decision_proofs_lifetime_check',
      sql`${table.initialIssuedAt} = ${table.issuedAt} and ${table.expiresAt} > ${table.issuedAt} and ${table.expiresAt} <= ${table.issuedAt} + interval '120 seconds' and ${table.retainUntil} >= ${table.expiresAt}`,
    ),
    check(
      'visual_decision_proofs_terminal_check',
      sql`(${table.consumedAt} is null and ${table.decisionId} is null) or (${table.consumedAt} is not null and ${table.decisionId} is not null and ${table.consumedAt} >= ${table.issuedAt})`,
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
    authorization: jsonb('authorization').$type<JsonValue>().notNull(),
    approvalBinding: jsonb('approval_binding').$type<JsonValue>().notNull(),
    providerAuthorityBindingHash: text(
      'provider_authority_binding_hash',
    ).notNull(),
    providerSdkCallId: text('provider_sdk_call_id').notNull(),
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
      sql`${table.attemptState} in ('prepared', 'executing', 'executed', 'not-applied', 'indeterminate')`,
    ),
    check(
      'provider_attempts_dispatch_time_check',
      sql`(${table.attemptState} = 'prepared' and ${table.dispatchedAt} is null) or (${table.attemptState} = 'not-applied') or (${table.attemptState} in ('executing', 'executed', 'indeterminate') and ${table.dispatchedAt} is not null)`,
    ),
    check(
      'provider_attempts_idempotency_lifetime_check',
      sql`${table.idempotencyExpiresAt} > ${table.issuedAt}`,
    ),
    check(
      'provider_attempts_hash_check',
      sql`${table.bindingHash} ~ '^[a-f0-9]{64}$' and ${table.capabilityFingerprint} ~ '^[a-f0-9]{64}$' and ${table.approvalHash} ~ '^[a-f0-9]{64}$' and ${table.disclosureGrantHash} ~ '^[a-f0-9]{64}$' and ${table.providerIdempotencyKey} ~ '^[a-f0-9]{64}$' and ${table.targetSetHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'provider_attempts_provider_authority_binding_hash_check',
      sql`${table.providerAuthorityBindingHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'provider_attempts_authorization_check',
      sql`jsonb_typeof(${table.authorization}) = 'object' and octet_length(${table.authorization}::text) <= 262144 and ${table.authorization} ->> 'proposalId' = ${table.proposalId}::text and ${table.authorization} ->> 'attemptId' = ${table.id}::text and (${table.authorization} ->> 'attemptVersion')::integer = ${table.attemptVersion} and ${table.authorization} ->> 'approvalBindingHash' = ${table.bindingHash} and ${table.authorization} ->> 'capabilityFingerprint' = ${table.capabilityFingerprint} and ${table.authorization} ->> 'approvalHash' = ${table.approvalHash} and ${table.authorization} ->> 'disclosureGrantId' = ${table.disclosureGrantId}::text and ${table.authorization} ->> 'disclosureGrantHash' = ${table.disclosureGrantHash} and ${table.authorization} ->> 'providerIdempotencyKey' = ${table.providerIdempotencyKey} and ${table.authorization} -> 'approvalBinding' = ${table.approvalBinding}`,
    ),
    check(
      'provider_attempts_approval_binding_check',
      sql`jsonb_typeof(${table.approvalBinding}) = 'object' and octet_length(${table.approvalBinding}::text) <= 131072 and ${table.approvalBinding} ->> 'decisionId' = ${table.decisionId}::text`,
    ),
    check(
      'provider_attempts_provider_sdk_call_id_check',
      sql`length(${table.providerSdkCallId}) between 1 and 512 and btrim(${table.providerSdkCallId}) = ${table.providerSdkCallId} and ${table.providerSdkCallId} !~ '[[:cntrl:]]'`,
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
    completion: jsonb('completion').$type<JsonValue>().notNull(),
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
    check(
      'provider_outcomes_completion_check',
      sql`jsonb_typeof(${table.completion}) = 'object' and octet_length(${table.completion}::text) <= 131072 and ${table.completion} ->> 'application' = ${table.application} and ${table.completion} ->> 'reason' is not distinct from ${table.reason} and ${table.completion} ->> 'outputStatus' is not distinct from ${table.outputStatus} and ${table.completion} ->> 'resultHash' is not distinct from ${table.resultHash} and ${table.completion} ->> 'evidenceHash' is not distinct from ${table.evidenceHash} and ${table.completion} ->> 'safeErrorCode' is not distinct from ${table.safeErrorCode}`,
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
    completion: jsonb('completion').$type<JsonValue>().notNull(),
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
    check(
      'proposal_reconciliations_completion_check',
      sql`jsonb_typeof(${table.completion}) = 'object' and octet_length(${table.completion}::text) <= 131072 and ${table.completion} ->> 'application' = ${table.application} and ${table.completion} ->> 'resultHash' is not distinct from ${table.resultHash} and ${table.completion} ->> 'evidenceHash' is not distinct from ${table.evidenceHash}`,
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
    administrationVersion: integer('administration_version')
      .default(1)
      .notNull(),
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
    check(
      'invitations_administration_version_positive',
      sql`${table.administrationVersion} > 0`,
    ),
  ],
);

/** Durable, non-secret replay receipts for owner administration commands. */
export const householdAdministrationCommands = emdoSchema.table(
  'household_administration_commands',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    householdId: uuid('household_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    actorSessionId: uuid('actor_session_id').notNull(),
    commandKind: text('command_kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    targetId: uuid('target_id').notNull(),
    result: jsonb('result').$type<JsonValue>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('household_administration_commands_idempotency_unique').on(
      table.householdId,
      table.actorUserId,
      table.actorSessionId,
      table.commandKind,
      table.idempotencyKey,
    ),
    foreignKey({
      name: 'household_administration_commands_actor_membership_fk',
      columns: [table.householdId, table.actorUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('household_administration_commands_household_created_idx').on(
      table.householdId,
      table.createdAt,
    ),
    check(
      'household_administration_commands_kind_check',
      sql`${table.commandKind} in ('issue-invitation', 'revoke-invitation', 'change-membership-role', 'deactivate-membership')`,
    ),
    check(
      'household_administration_commands_idempotency_check',
      sql`${table.idempotencyKey} ~ '^[A-Za-z0-9:._-]{16,200}$'`,
    ),
    check(
      'household_administration_commands_request_hash_check',
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'household_administration_commands_result_size_check',
      sql`pg_catalog.octet_length(${table.result}::text) between 2 and 4096`,
    ),
  ],
);

/** Exact non-secret replay receipt for one atomic invite-only onboarding command. */
export const invitationRedemptionCommands = emdoSchema.table(
  'invitation_redemption_commands',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    requestHash: text('request_hash').notNull(),
    originRequestId: uuid('origin_request_id').notNull().unique(),
    invitationId: uuid('invitation_id')
      .notNull()
      .references(() => invitations.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    result: jsonb('result').$type<JsonValue>().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('invitation_redemption_commands_retention_idx').on(table.retainUntil),
    check(
      'invitation_redemption_commands_idempotency_check',
      sql`${table.idempotencyKey} ~ '^[A-Za-z0-9:._-]{16,200}$'`,
    ),
    check(
      'invitation_redemption_commands_request_hash_check',
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'invitation_redemption_commands_result_check',
      sql`"emdo"."is_safe_invitation_redemption_result"(${table.result})`,
    ),
    check(
      'invitation_redemption_commands_retention_check',
      sql`${table.retainUntil} > ${table.completedAt} and ${table.retainUntil} <= ${table.completedAt} + interval '90 days'`,
    ),
  ],
);

/** Worker-public-key envelope; plaintext invitation tokens are never stored. */
export const invitationDeliverySecrets = emdoSchema.table(
  'invitation_delivery_secrets',
  {
    id: uuid('id').primaryKey(),
    invitationId: uuid('invitation_id')
      .notNull()
      .references(() => invitations.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    householdId: uuid('household_id').notNull(),
    recipient: text('recipient').notNull(),
    role: text('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    templateVersion: text('template_version').notNull(),
    algorithm: text('algorithm').notNull(),
    keyId: text('key_id').notNull(),
    bindingHash: text('binding_hash').notNull(),
    envelope: jsonb('envelope').$type<JsonValue>(),
    state: text('state').default('pending').notNull(),
    operationId: text('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    indeterminateAt: timestamp('indeterminate_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    erasedAt: timestamp('erased_at', { withTimezone: true }),
  },
  (table) => [
    unique('invitation_delivery_secrets_invitation_unique').on(
      table.invitationId,
    ),
    unique('invitation_delivery_secrets_operation_unique').on(
      table.operationId,
    ),
    index('invitation_delivery_secrets_expiry_idx').on(
      table.state,
      table.expiresAt,
    ),
    check(
      'invitation_delivery_secrets_email_normalized',
      sql`${table.recipient} = lower(${table.recipient})`,
    ),
    check(
      'invitation_delivery_secrets_role_check',
      sql`${table.role} in ('owner', 'member')`,
    ),
    check(
      'invitation_delivery_secrets_token_hash_check',
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'invitation_delivery_secrets_binding_hash_check',
      sql`${table.bindingHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'invitation_delivery_secrets_envelope_check',
      sql`${table.algorithm} = 'RSA-OAEP-256' and ${table.templateVersion} = 'invitation-redemption.v1' and pg_catalog.char_length(${table.keyId}) between 1 and 128 and ${table.operationId} = 'invitation:' || ${table.invitationId}::text`,
    ),
    check(
      'invitation_delivery_secrets_state_check',
      sql`${table.state} in ('pending', 'indeterminate', 'confirmed', 'expired', 'cancelled')`,
    ),
    check(
      'invitation_delivery_secrets_lifecycle_check',
      sql`(
        ${table.state} in ('pending', 'indeterminate')
        and ${table.envelope} is not null
        and ${table.erasedAt} is null
        and ${table.settledAt} is null
      ) or (
        ${table.state} in ('confirmed', 'expired', 'cancelled')
        and ${table.envelope} is null
        and ${table.erasedAt} is not null
        and ${table.settledAt} is not null
      )`,
    ),
    check(
      'invitation_delivery_secrets_expiry_check',
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '7 days'`,
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

/** Household-wide AI spend reservations. Amounts are integer CAD minor units. */
export const aiSpendReservations = emdoSchema.table(
  'ai_spend_reservations',
  {
    reservationId: text('reservation_id').primaryKey(),
    householdId: uuid('household_id').notNull(),
    authorizedUserId: uuid('authorized_user_id').notNull(),
    period: text('period').notNull(),
    category: text('category').notNull(),
    executionId: text('execution_id').notNull(),
    authorizationHash: text('authorization_hash').notNull(),
    requestHash: text('request_hash').notNull(),
    estimatedCadMinor: bigint('estimated_cad_minor', {
      mode: 'number',
    }).notNull(),
    actualCadMinor: bigint('actual_cad_minor', { mode: 'number' }),
    decisionCadMinor: bigint('decision_cad_minor', {
      mode: 'number',
    }).notNull(),
    warning: boolean('warning').notNull(),
    state: text('state').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true })
      .default(sql`clock_timestamp() + interval '90 days'`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ai_spend_reservations_user_membership_fk',
      columns: [table.householdId, table.authorizedUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    unique('ai_spend_reservations_request_unique').on(
      table.householdId,
      table.period,
      table.requestHash,
    ),
    index('ai_spend_reservations_household_period_idx').on(
      table.householdId,
      table.period,
      table.state,
    ),
    check(
      'ai_spend_reservations_period_check',
      sql`${table.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    check(
      'ai_spend_reservations_category_check',
      sql`${table.category} in ('model', 'audio')`,
    ),
    check(
      'ai_spend_reservations_state_check',
      sql`${table.state} in ('blocked', 'reserved', 'dispatched', 'released', 'settled')`,
    ),
    check(
      'ai_spend_reservations_amount_check',
      sql`${table.estimatedCadMinor} > 0 and ${table.decisionCadMinor} >= 0 and (${table.actualCadMinor} is null or ${table.actualCadMinor} >= 0)`,
    ),
    check(
      'ai_spend_reservations_terminal_shape_check',
      sql`(${table.state} = 'blocked' and ${table.actualCadMinor} is null and ${table.dispatchedAt} is null and ${table.releasedAt} is null and ${table.settledAt} is null) or (${table.state} = 'reserved' and ${table.actualCadMinor} is null and ${table.dispatchedAt} is null and ${table.releasedAt} is null and ${table.settledAt} is null) or (${table.state} = 'dispatched' and ${table.actualCadMinor} is null and ${table.dispatchedAt} is not null and ${table.releasedAt} is null and ${table.settledAt} is null) or (${table.state} = 'released' and ${table.actualCadMinor} is null and ${table.dispatchedAt} is null and ${table.releasedAt} is not null and ${table.settledAt} is null) or (${table.state} = 'settled' and ${table.actualCadMinor} is not null and ${table.settledAt} is not null)`,
    ),
    check(
      'ai_spend_reservations_hash_check',
      sql`${table.authorizationHash} ~ '^[a-f0-9]{64}$' and ${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'ai_spend_reservations_retention_check',
      sql`${table.retainUntil} > ${table.createdAt} and ${table.retainUntil} <= ${table.createdAt} + interval '90 days'`,
    ),
  ],
);

/** AES-GCM sealed, single-use human-in-the-loop agent state. */
export const approvalCheckpoints = emdoSchema.table(
  'approval_checkpoints',
  {
    checkpointId: uuid('checkpoint_id').primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    userId: uuid('user_id').notNull(),
    runId: uuid('run_id').notNull(),
    formatVersion: smallint('format_version').notNull(),
    revision: integer('revision').notNull(),
    state: text('state').notNull(),
    agentGraphHash: text('agent_graph_hash').notNull(),
    sdkVersion: text('sdk_version').notNull(),
    sealedState: text('sealed_state').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true })
      .default(sql`clock_timestamp() + interval '90 days'`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'approval_checkpoints_run_fk',
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
    index('approval_checkpoints_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('approval_checkpoints_user_expiry_idx').on(
      table.userId,
      table.expiresAt,
    ),
    check(
      'approval_checkpoints_state_check',
      sql`${table.state} in ('pending', 'resumed', 'cancelled', 'expired')`,
    ),
    check(
      'approval_checkpoints_format_revision_check',
      sql`${table.formatVersion} = 1 and ${table.revision} > 0`,
    ),
    check(
      'approval_checkpoints_sealed_state_size_check',
      sql`octet_length(${table.sealedState}) between 1 and 1400000`,
    ),
    check(
      'approval_checkpoints_lifetime_check',
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '10 minutes'`,
    ),
    check(
      'approval_checkpoints_hash_check',
      sql`${table.agentGraphHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'approval_checkpoints_retention_check',
      sql`${table.retainUntil} > ${table.createdAt} and ${table.retainUntil} <= ${table.createdAt} + interval '90 days'`,
    ),
  ],
);

/** Persisted, replayable SSE events for one agent run. */
export const agentRunEvents = emdoSchema.table(
  'agent_run_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    runId: uuid('run_id').notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<JsonValue>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true })
      .default(sql`clock_timestamp() + interval '90 days'`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'agent_run_events_run_fk',
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
    unique('agent_run_events_run_sequence_unique').on(
      table.runId,
      table.sequence,
    ),
    index('agent_run_events_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('agent_run_events_run_idx').on(table.runId, table.sequence),
    check('agent_run_events_sequence_positive', sql`${table.sequence} > 0`),
    check(
      'agent_run_events_retention_check',
      sql`${table.retainUntil} > ${table.occurredAt} and ${table.retainUntil} <= ${table.occurredAt} + interval '90 days'`,
    ),
  ],
);

/** A server-registered local device; unregistered UUIDs never gain sync scope. */
export const syncClients = emdoSchema.table(
  'sync_clients',
  {
    id: uuid('id').primaryKey(),
    householdId: uuid('household_id').notNull(),
    userId: uuid('user_id').notNull(),
    displayName: text('display_name').notNull(),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    unique('sync_clients_scope_id_unique').on(
      table.householdId,
      table.userId,
      table.id,
    ),
    foreignKey({
      name: 'sync_clients_user_membership_fk',
      columns: [table.householdId, table.userId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('sync_clients_user_active_idx').on(table.userId, table.revokedAt),
  ],
);

/** Opaque, request-current authorization minted from canonical session scope. */
export const spaceAccessGrants = emdoSchema.table(
  'space_access_grants',
  {
    grantId: uuid('grant_id').defaultRandom().primaryKey(),
    schemaVersion: smallint('schema_version').default(1).notNull(),
    version: integer('version').default(1).notNull(),
    householdId: uuid('household_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    requestId: uuid('request_id').notNull(),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => householdMemberships.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    role: text('role').notNull(),
    privateSpaceId: uuid('private_space_id').notNull(),
    writableSpaceIds: uuid('writable_space_ids').array().notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('space_access_grants_request_unique').on(
      table.originalOwnerUserId,
      table.sessionId,
      table.requestId,
    ),
    foreignKey({
      name: 'space_access_grants_user_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'space_access_grants_private_space_fk',
      columns: [table.householdId, table.privateSpaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('space_access_grants_owner_request_idx').on(
      table.originalOwnerUserId,
      table.requestId,
    ),
    index('space_access_grants_expiry_idx').on(table.expiresAt),
    check(
      'space_access_grants_schema_version_check',
      sql`${table.schemaVersion} = 1 and ${table.version} = 1`,
    ),
    check(
      'space_access_grants_role_check',
      sql`${table.role} in ('owner', 'member')`,
    ),
    check(
      'space_access_grants_spaces_check',
      sql`pg_catalog.cardinality(${table.writableSpaceIds}) between 1 and 256 and pg_catalog.array_position(${table.writableSpaceIds}, ${table.privateSpaceId}) is not null`,
    ),
    check(
      'space_access_grants_lifetime_check',
      sql`${table.expiresAt} > ${table.issuedAt} and ${table.expiresAt} <= ${table.issuedAt} + interval '15 minutes'`,
    ),
    check(
      'space_access_grants_retention_check',
      sql`${table.retainUntil} > ${table.issuedAt} and ${table.retainUntil} <= ${table.issuedAt} + interval '90 days'`,
    ),
  ],
);

/** Durable paused-agent work linked atomically to one visual proposal decision. */
export const approvalResumeJobs = emdoSchema.table(
  'approval_resume_jobs',
  {
    jobId: uuid('job_id').primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    userId: uuid('user_id').notNull(),
    runId: uuid('run_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    checkpointId: uuid('checkpoint_id').notNull(),
    interruptionId: text('interruption_id').notNull(),
    proposalId: uuid('proposal_id').notNull(),
    capabilityId: text('capability_id').notNull(),
    originSessionId: uuid('origin_session_id').notNull(),
    originTurnRequestId: uuid('origin_turn_request_id').notNull(),
    originSpaceAccessGrantId: uuid('origin_space_access_grant_id').notNull(),
    authorizationScopeFingerprint: text(
      'authorization_scope_fingerprint',
    ).notNull(),
    disclosureGrantId: uuid('disclosure_grant_id').notNull(),
    disclosureGrantVersion: integer('disclosure_grant_version').notNull(),
    disclosurePolicyVersion: text('disclosure_policy_version').notNull(),
    payloadHash: text('payload_hash').notNull(),
    approvalHash: text('approval_hash').notNull(),
    approvalEventSequence: bigint('approval_event_sequence', {
      mode: 'number',
    }),
    state: text('state').default('awaiting-decision').notNull(),
    revision: integer('revision').default(1).notNull(),
    claimId: uuid('claim_id'),
    ownershipTokenDigest: text('ownership_token_digest'),
    decisionId: uuid('decision_id'),
    decisionType: text('decision_type'),
    authenticatedSessionId: uuid('authenticated_session_id'),
    resumeRequestId: uuid('resume_request_id'),
    resumeSpaceAccessGrantId: uuid('resume_space_access_grant_id'),
    collectionAuthorizationScopeFingerprint: text(
      'collection_authorization_scope_fingerprint',
    ),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    terminalEventSequence: bigint('terminal_event_sequence', {
      mode: 'number',
    }),
    terminalReasonCode: text('terminal_reason_code'),
    terminalResultHash: text('terminal_result_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('approval_resume_jobs_checkpoint_unique').on(table.checkpointId),
    unique('approval_resume_jobs_proposal_unique').on(table.proposalId),
    unique('approval_resume_jobs_claim_unique').on(table.claimId),
    unique('approval_resume_jobs_ownership_digest_unique').on(
      table.ownershipTokenDigest,
    ),
    unique('approval_resume_jobs_decision_unique').on(table.decisionId),
    unique('approval_resume_jobs_resume_request_unique').on(
      table.resumeRequestId,
    ),
    unique('approval_resume_jobs_resume_grant_unique').on(
      table.resumeSpaceAccessGrantId,
    ),
    foreignKey({
      name: 'approval_resume_jobs_proposal_fk',
      columns: [
        table.householdId,
        table.spaceId,
        table.userId,
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
      name: 'approval_resume_jobs_run_fk',
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
    foreignKey({
      name: 'approval_resume_jobs_disclosure_grant_fk',
      columns: [
        table.householdId,
        table.spaceId,
        table.userId,
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
    foreignKey({
      name: 'approval_resume_jobs_checkpoint_fk',
      columns: [table.checkpointId],
      foreignColumns: [approvalCheckpoints.checkpointId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'approval_resume_jobs_origin_session_fk',
      columns: [table.originSessionId],
      foreignColumns: [authSessions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'approval_resume_jobs_origin_grant_fk',
      columns: [table.originSpaceAccessGrantId],
      foreignColumns: [spaceAccessGrants.grantId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'approval_resume_jobs_decision_fk',
      columns: [table.decisionId],
      foreignColumns: [actionDecisions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'approval_resume_jobs_authenticated_session_fk',
      columns: [table.authenticatedSessionId],
      foreignColumns: [authSessions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'approval_resume_jobs_resume_grant_fk',
      columns: [table.resumeSpaceAccessGrantId],
      foreignColumns: [spaceAccessGrants.grantId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'approval_resume_jobs_approval_event_fk',
      columns: [table.runId, table.approvalEventSequence],
      foreignColumns: [agentRunEvents.runId, agentRunEvents.sequence],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'approval_resume_jobs_terminal_event_fk',
      columns: [table.runId, table.terminalEventSequence],
      foreignColumns: [agentRunEvents.runId, agentRunEvents.sequence],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('approval_resume_jobs_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('approval_resume_jobs_state_expiry_idx').on(
      table.state,
      table.expiresAt,
      table.jobId,
    ),
    check(
      'approval_resume_jobs_binding_check',
      sql`${table.authorizationScopeFingerprint} ~ '^[a-f0-9]{64}$' and (${table.collectionAuthorizationScopeFingerprint} is null or ${table.collectionAuthorizationScopeFingerprint} ~ '^[a-f0-9]{64}$') and ${table.payloadHash} ~ '^[a-f0-9]{64}$' and ${table.approvalHash} ~ '^[a-f0-9]{64}$' and ${table.disclosureGrantVersion} > 0 and length(${table.interruptionId}) between 1 and 512 and ${table.interruptionId} !~ '[[:cntrl:]]' and length(${table.capabilityId}) between 1 and 200 and ${table.capabilityId} !~ '[[:cntrl:]]'`,
    ),
    check(
      'approval_resume_jobs_disclosure_policy_version_check',
      sql`length(${table.disclosurePolicyVersion}) between 5 and 64 and ${table.disclosurePolicyVersion} ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'`,
    ),
    check('approval_resume_jobs_revision_check', sql`${table.revision} > 0`),
    check(
      'approval_resume_jobs_decision_check',
      sql`(${table.decisionId} is null and ${table.decisionType} is null) or (${table.decisionId} is not null and ${table.decisionType} in ('approved','rejected'))`,
    ),
    check(
      'approval_resume_jobs_state_check',
      sql`(${table.state} = 'awaiting-decision' and ${table.decisionId} is null and ${table.authenticatedSessionId} is null and ${table.claimId} is null and ${table.ownershipTokenDigest} is null and ${table.resumeRequestId} is null and ${table.resumeSpaceAccessGrantId} is null and ${table.collectionAuthorizationScopeFingerprint} is null and ${table.claimedAt} is null and ${table.claimExpiresAt} is null and ${table.terminalEventSequence} is null and ${table.terminalReasonCode} is null and ${table.terminalResultHash} is null) or (${table.state} = 'ready' and ${table.decisionId} is not null and ${table.authenticatedSessionId} is not null and ${table.claimId} is null and ${table.ownershipTokenDigest} is null and ${table.resumeRequestId} is null and ${table.resumeSpaceAccessGrantId} is null and ${table.collectionAuthorizationScopeFingerprint} is null and ${table.claimedAt} is null and ${table.claimExpiresAt} is null and ${table.terminalEventSequence} is null and ${table.terminalReasonCode} is null and ${table.terminalResultHash} is null) or (${table.state} = 'claimed' and ${table.decisionId} is not null and ${table.authenticatedSessionId} is not null and ${table.claimId} is not null and ${table.ownershipTokenDigest} ~ '^[a-f0-9]{64}$' and ${table.resumeRequestId} is not null and ${table.resumeSpaceAccessGrantId} is not null and ${table.collectionAuthorizationScopeFingerprint} ~ '^[a-f0-9]{64}$' and ${table.claimedAt} is not null and ${table.claimExpiresAt} is not null and ${table.terminalEventSequence} is null and ${table.terminalReasonCode} is null and ${table.terminalResultHash} is null) or (${table.state} = 'terminal' and ${table.decisionId} is not null and ${table.authenticatedSessionId} is not null and ${table.claimId} is not null and ${table.ownershipTokenDigest} ~ '^[a-f0-9]{64}$' and ${table.resumeRequestId} is not null and ${table.resumeSpaceAccessGrantId} is not null and ${table.collectionAuthorizationScopeFingerprint} ~ '^[a-f0-9]{64}$' and ${table.claimedAt} is not null and ${table.claimExpiresAt} is not null and ${table.terminalEventSequence} > 0 and (${table.terminalReasonCode} is null or ${table.terminalReasonCode} = 'approval-resume-binding-invalid') and ${table.terminalResultHash} ~ '^[a-f0-9]{64}$') or (${table.state} = 'indeterminate' and ${table.decisionId} is not null and ${table.authenticatedSessionId} is not null and ${table.claimId} is not null and ${table.ownershipTokenDigest} ~ '^[a-f0-9]{64}$' and ${table.resumeRequestId} is not null and ${table.resumeSpaceAccessGrantId} is not null and ${table.collectionAuthorizationScopeFingerprint} ~ '^[a-f0-9]{64}$' and ${table.claimedAt} is not null and ${table.claimExpiresAt} is not null and ${table.terminalEventSequence} > 0 and ${table.terminalReasonCode} = 'approval-resume-failed' and ${table.terminalResultHash} ~ '^[a-f0-9]{64}$')`,
    ),
    check(
      'approval_resume_jobs_claim_lifetime_check',
      sql`(${table.claimedAt} is null and ${table.claimExpiresAt} is null) or (${table.claimedAt} is not null and ${table.claimExpiresAt} > ${table.claimedAt} and ${table.claimExpiresAt} <= ${table.claimedAt} + interval '10 minutes')`,
    ),
    check(
      'approval_resume_jobs_lifetime_check',
      sql`${table.updatedAt} >= ${table.createdAt} and ${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '10 minutes' and ${table.retainUntil} > ${table.createdAt} and ${table.retainUntil} <= ${table.createdAt} + interval '90 days'`,
    ),
  ],
);

/** Durable manager-owned user turn with immutable origin authority. */
export const managerTurns = emdoSchema.table(
  'manager_turns',
  {
    runId: uuid('run_id').primaryKey(),
    schemaVersion: smallint('schema_version').default(1).notNull(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    userId: uuid('user_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    originSessionId: uuid('origin_session_id').notNull(),
    originRequestId: uuid('origin_request_id').notNull(),
    originSpaceAccessGrantId: uuid('origin_space_access_grant_id').notNull(),
    originCollectionAuthorizationScopeFingerprint: text(
      'origin_collection_authorization_scope_fingerprint',
    ).notNull(),
    originOperationAuthorizationScopeFingerprint: text(
      'origin_operation_authorization_scope_fingerprint',
    ).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestPayload: jsonb('request_payload').$type<JsonValue>().notNull(),
    requestHash: text('request_hash').notNull(),
    managerAgentVersion: text('manager_agent_version').notNull(),
    requestedModel: text('requested_model').notNull(),
    claimId: uuid('claim_id').notNull(),
    ownershipTokenHash: text('ownership_token_hash').notNull(),
    state: text('state').default('claimed').notNull(),
    revision: bigint('revision', { mode: 'number' }).default(1).notNull(),
    result: jsonb('result').$type<JsonValue>(),
    resultHash: text('result_hash'),
    terminalEventSequence: bigint('terminal_event_sequence', {
      mode: 'number',
    }),
    approvalCheckpointId: uuid('approval_checkpoint_id'),
    reasonCode: text('reason_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('manager_turns_household_user_idempotency_unique').on(
      table.householdId,
      table.userId,
      table.idempotencyKey,
    ),
    unique('manager_turns_claim_unique').on(table.claimId),
    foreignKey({
      name: 'manager_turns_run_fk',
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
    foreignKey({
      name: 'manager_turns_origin_session_fk',
      columns: [table.originSessionId],
      foreignColumns: [authSessions.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'manager_turns_origin_grant_fk',
      columns: [table.originSpaceAccessGrantId],
      foreignColumns: [spaceAccessGrants.grantId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'manager_turns_terminal_event_fk',
      columns: [table.runId, table.terminalEventSequence],
      foreignColumns: [agentRunEvents.runId, agentRunEvents.sequence],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'manager_turns_approval_checkpoint_fk',
      columns: [table.approvalCheckpointId],
      foreignColumns: [approvalCheckpoints.checkpointId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('manager_turns_household_user_created_idx').on(
      table.householdId,
      table.userId,
      table.createdAt,
    ),
    index('manager_turns_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    check(
      'manager_turns_schema_revision_check',
      sql`${table.schemaVersion} = 1 and ${table.revision} > 0`,
    ),
    check(
      'manager_turns_authority_check',
      sql`${table.originCollectionAuthorizationScopeFingerprint} ~ '^[a-f0-9]{64}$' and ${table.originOperationAuthorizationScopeFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'manager_turns_idempotency_check',
      sql`length(${table.idempotencyKey}) between 16 and 200 and ${table.idempotencyKey} ~ '^[A-Za-z0-9:._-]+$'`,
    ),
    check(
      'manager_turns_request_check',
      sql`pg_catalog.jsonb_typeof(${table.requestPayload}) = 'object' and pg_catalog.octet_length(${table.requestPayload}::text) <= 131072 and ${table.requestHash} ~ '^[a-f0-9]{64}$' and ${table.requestHash} = emdo.canonical_json_hash(${table.requestPayload})`,
    ),
    check(
      'manager_turns_runtime_check',
      sql`length(${table.managerAgentVersion}) between 5 and 64 and ${table.managerAgentVersion} ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' and ${table.requestedModel} in ('gpt-5.6-luna', 'gpt-5.6-terra') and ${table.ownershipTokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'manager_turns_state_check',
      sql`(${table.state} = 'claimed' and ${table.result} is null and ${table.resultHash} is null and ${table.terminalEventSequence} is null and ${table.approvalCheckpointId} is null and ${table.reasonCode} is null) or (${table.state} in ('completed', 'failed', 'needs-approval') and pg_catalog.jsonb_typeof(${table.result}) = 'object' and pg_catalog.octet_length(${table.result}::text) <= 1400000 and ${table.resultHash} ~ '^[a-f0-9]{64}$' and ${table.resultHash} = emdo.canonical_json_hash(${table.result}) and ${table.terminalEventSequence} > 0 and ((${table.state} = 'needs-approval' and ${table.approvalCheckpointId} is not null) or (${table.state} in ('completed', 'failed') and ${table.approvalCheckpointId} is null)) and ${table.reasonCode} is null) or (${table.state} = 'indeterminate' and pg_catalog.jsonb_typeof(${table.result}) = 'object' and pg_catalog.octet_length(${table.result}::text) <= 1400000 and ${table.resultHash} ~ '^[a-f0-9]{64}$' and ${table.resultHash} = emdo.canonical_json_hash(${table.result}) and ${table.terminalEventSequence} > 0 and ${table.approvalCheckpointId} is null and ${table.reasonCode} = 'agent-runtime-failed')`,
    ),
    check(
      'manager_turns_retention_check',
      sql`${table.updatedAt} >= ${table.createdAt} and ${table.retainUntil} > ${table.createdAt} and ${table.retainUntil} <= ${table.createdAt} + interval '90 days'`,
    ),
  ],
);

/** Append-only exact command outcomes for manager turn commit readback. */
export const managerTurnOperations = emdoSchema.table(
  'manager_turn_operations',
  {
    operationId: uuid('operation_id').primaryKey(),
    runId: uuid('run_id').notNull(),
    householdId: uuid('household_id').notNull(),
    userId: uuid('user_id').notNull(),
    requestClaimId: uuid('request_claim_id').notNull(),
    requestOwnershipTokenHash: text('request_ownership_token_hash').notNull(),
    operationKind: text('operation_kind').notNull(),
    operationHash: text('operation_hash').notNull(),
    resultHash: text('result_hash'),
    storedResult: jsonb('stored_result').$type<JsonValue>().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'manager_turn_operations_turn_fk',
      columns: [table.runId],
      foreignColumns: [managerTurns.runId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('manager_turn_operations_run_recorded_idx').on(
      table.runId,
      table.recordedAt,
    ),
    check(
      'manager_turn_operations_kind_check',
      sql`${table.operationKind} in ('claim', 'complete', 'indeterminate')`,
    ),
    check(
      'manager_turn_operations_hash_check',
      sql`${table.requestOwnershipTokenHash} ~ '^[a-f0-9]{64}$' and ${table.operationHash} ~ '^[a-f0-9]{64}$' and (${table.resultHash} is null or ${table.resultHash} ~ '^[a-f0-9]{64}$')`,
    ),
    check(
      'manager_turn_operations_result_check',
      sql`pg_catalog.jsonb_typeof(${table.storedResult}) = 'object' and pg_catalog.octet_length(${table.storedResult}::text) <= 65536`,
    ),
    check(
      'manager_turn_operations_retention_check',
      sql`${table.retainUntil} > ${table.recordedAt} and ${table.retainUntil} <= ${table.recordedAt} + interval '90 days'`,
    ),
  ],
);

/** Durable, payload-bound ownership and settlement state for audio requests. */
export const audioRequestReceipts = emdoSchema.table(
  'audio_request_receipts',
  {
    receiptId: uuid('receipt_id').defaultRandom().primaryKey(),
    schemaVersion: smallint('schema_version').default(1).notNull(),
    householdId: uuid('household_id').notNull(),
    userId: uuid('user_id').notNull(),
    authenticatedSessionId: uuid('authenticated_session_id').notNull(),
    originRequestId: uuid('origin_request_id').notNull(),
    originSpaceAccessGrantId: uuid('origin_space_access_grant_id').notNull(),
    originRole: text('origin_role').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    kind: text('kind').notNull(),
    model: text('model').notNull(),
    inputUnits: bigint('input_units', { mode: 'number' }).notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    state: text('state').notNull(),
    version: bigint('version', { mode: 'bigint' }).notNull(),
    claimGeneration: integer('claim_generation').notNull(),
    claimId: uuid('claim_id').notNull(),
    ownershipTokenHash: text('ownership_token_hash').notNull(),
    executionId: uuid('execution_id').notNull(),
    reservationId: uuid('reservation_id').notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    transcript: text('transcript'),
    resultModel: text('result_model'),
    resultContentType: text('result_content_type'),
    spendWarning: boolean('spend_warning'),
    reasonCode: text('reason_code'),
    reconciliationStatus: text('reconciliation_status')
      .default('not-required')
      .notNull(),
    reconciliationResolution: text('reconciliation_resolution'),
    operatorReference: text('operator_reference'),
    reconciliationMarkedAt: timestamp('reconciliation_marked_at', {
      withTimezone: true,
    }),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('audio_request_receipts_principal_key_unique').on(
      table.householdId,
      table.userId,
      table.idempotencyKey,
    ),
    unique('audio_request_receipts_claim_id_unique').on(table.claimId),
    foreignKey({
      name: 'audio_request_receipts_membership_fk',
      columns: [table.householdId, table.userId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('audio_request_receipts_reconciliation_idx').on(
      table.reconciliationStatus,
      table.reconciliationMarkedAt,
      table.receiptId,
    ),
    index('audio_request_receipts_owner_idx').on(
      table.householdId,
      table.userId,
      table.updatedAt,
    ),
    check(
      'audio_request_receipts_schema_check',
      sql`${table.schemaVersion} = 1`,
    ),
    check(
      'audio_request_receipts_key_check',
      sql`pg_catalog.length(${table.idempotencyKey}) between 16 and 200 and ${table.idempotencyKey} ~ '^[A-Za-z0-9:._-]+$'`,
    ),
    check(
      'audio_request_receipts_kind_model_check',
      sql`(${table.kind} = 'transcription' and ${table.model} in ('gpt-4o-mini-transcribe', 'gpt-4o-transcribe')) or (${table.kind} = 'speech' and ${table.model} in ('tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'))`,
    ),
    check(
      'audio_request_receipts_units_check',
      sql`${table.inputUnits} between 1 and 26214400`,
    ),
    check(
      'audio_request_receipts_hash_check',
      sql`${table.requestFingerprint} ~ '^[a-f0-9]{64}$' and ${table.ownershipTokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'audio_request_receipts_role_check',
      sql`${table.originRole} in ('owner', 'member')`,
    ),
    check(
      'audio_request_receipts_state_check',
      sql`${table.state} in ('claimed', 'released', 'completed-transcription', 'completed-speech', 'completed-nonreplayable', 'indeterminate')`,
    ),
    check(
      'audio_request_receipts_revision_check',
      sql`${table.version} > 0 and ${table.claimGeneration} > 0`,
    ),
    check(
      'audio_request_receipts_reason_check',
      sql`${table.reasonCode} is null or ${table.reasonCode} in ('transcription-provider-not-dispatched', 'speech-provider-not-dispatched', 'claim-lease-expired', 'transcription-provider-state-unknown', 'speech-provider-state-unknown', 'transcription-settlement-state-unknown', 'speech-settlement-state-unknown')`,
    ),
    check(
      'audio_request_receipts_reconciliation_check',
      sql`${table.reconciliationStatus} in ('not-required', 'pending', 'resolved') and (${table.reconciliationResolution} is null or ${table.reconciliationResolution} in ('confirmed-not-dispatched', 'confirmed-dispatched')) and (${table.operatorReference} is null or (pg_catalog.length(${table.operatorReference}) between 8 and 200 and ${table.operatorReference} ~ '^[A-Za-z0-9:._-]+$'))`,
    ),
    check(
      'audio_request_receipts_transcript_check',
      sql`${table.transcript} is null or (pg_catalog.length(${table.transcript}) between 1 and 50000 and pg_catalog.octet_length(${table.transcript}) <= 200000)`,
    ),
    check(
      'audio_request_receipts_result_shape_check',
      sql`(${table.state} = 'completed-transcription' and ${table.kind} = 'transcription' and ${table.transcript} is not null and ${table.resultModel} is not null and ${table.resultModel} = ${table.model} and ${table.resultContentType} is null and ${table.spendWarning} is not null and ${table.completedAt} is not null) or (${table.state} = 'completed-speech' and ${table.kind} = 'speech' and ${table.transcript} is null and ${table.resultModel} is not null and ${table.resultModel} = ${table.model} and ${table.resultContentType} is not null and ${table.resultContentType} in ('audio/mpeg', 'audio/wav', 'audio/ogg') and ${table.spendWarning} is null and ${table.completedAt} is not null) or (${table.state} = 'completed-nonreplayable' and ${table.transcript} is null and ${table.resultModel} is null and ${table.resultContentType} is null and ${table.spendWarning} is null and ${table.completedAt} is not null and ${table.reconciliationStatus} = 'resolved') or (${table.state} not in ('completed-transcription', 'completed-speech', 'completed-nonreplayable') and ${table.transcript} is null and ${table.resultModel} is null and ${table.resultContentType} is null and ${table.spendWarning} is null and ${table.completedAt} is null)`,
    ),
    check(
      'audio_request_receipts_lifecycle_shape_check',
      sql`(${table.state} = 'claimed' and ${table.leaseExpiresAt} is not null) or (${table.state} <> 'claimed')`,
    ),
    check(
      'audio_request_receipts_reconciliation_shape_check',
      sql`(${table.state} = 'indeterminate' and ${table.reasonCode} is not null and ${table.reconciliationStatus} = 'pending' and ${table.reconciliationMarkedAt} is not null and ${table.reconciliationResolution} is null and ${table.operatorReference} is null and ${table.reconciledAt} is null) or (${table.state} <> 'indeterminate' and ${table.reconciliationStatus} <> 'pending')`,
    ),
    check(
      'audio_request_receipts_retention_check',
      sql`${table.retainUntil} > ${table.createdAt} and ${table.retainUntil} <= ${table.createdAt} + interval '90 days'`,
    ),
  ],
);

/** Append-only command acknowledgements for exact post-COMMIT readback. */
export const audioRequestReceiptOperations = emdoSchema.table(
  'audio_request_receipt_operations',
  {
    operationId: uuid('operation_id').primaryKey(),
    receiptId: uuid('receipt_id').notNull(),
    householdId: uuid('household_id').notNull(),
    userId: uuid('user_id').notNull(),
    receiptRevision: bigint('receipt_revision', { mode: 'bigint' }).notNull(),
    claimId: uuid('claim_id').notNull(),
    ownershipTokenHash: text('ownership_token_hash'),
    claimGeneration: integer('claim_generation').notNull(),
    generationClaimId: uuid('generation_claim_id').notNull(),
    generationOwnershipTokenHash: text(
      'generation_ownership_token_hash',
    ).notNull(),
    executionId: uuid('execution_id').notNull(),
    reservationId: uuid('reservation_id').notNull(),
    operationKind: text('operation_kind').notNull(),
    operationHash: text('operation_hash').notNull(),
    stateAfter: text('state_after').notNull(),
    safeCode: text('safe_code'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('audio_request_receipt_operations_receipt_revision_unique').on(
      table.receiptId,
      table.receiptRevision,
    ),
    foreignKey({
      name: 'audio_request_receipt_operations_receipt_fk',
      columns: [table.receiptId],
      foreignColumns: [audioRequestReceipts.receiptId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('audio_request_receipt_operations_owner_idx').on(
      table.householdId,
      table.userId,
      table.recordedAt,
    ),
    check(
      'audio_request_receipt_operations_kind_check',
      sql`${table.operationKind} in ('claim', 'transcription-complete', 'speech-complete', 'release', 'indeterminate', 'operator-release', 'operator-close')`,
    ),
    check(
      'audio_request_receipt_operations_state_check',
      sql`${table.stateAfter} in ('claimed', 'released', 'completed-transcription', 'completed-speech', 'completed-nonreplayable', 'indeterminate')`,
    ),
    check(
      'audio_request_receipt_operations_safe_code_check',
      sql`${table.safeCode} is null or ${table.safeCode} in ('transcription-provider-not-dispatched', 'speech-provider-not-dispatched', 'claim-lease-expired', 'transcription-provider-state-unknown', 'speech-provider-state-unknown', 'transcription-settlement-state-unknown', 'speech-settlement-state-unknown', 'confirmed-not-dispatched', 'confirmed-dispatched')`,
    ),
    check(
      'audio_request_receipt_operations_hash_check',
      sql`${table.operationHash} ~ '^[a-f0-9]{64}$' and (${table.ownershipTokenHash} is null or ${table.ownershipTokenHash} ~ '^[a-f0-9]{64}$') and ${table.generationOwnershipTokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'audio_request_receipt_operations_token_shape_check',
      sql`(${table.operationKind} in ('operator-release', 'operator-close') and ${table.ownershipTokenHash} is null) or (${table.operationKind} not in ('operator-release', 'operator-close') and ${table.ownershipTokenHash} is not null)`,
    ),
    check(
      'audio_request_receipt_operations_generation_shape_check',
      sql`(${table.operationKind} = 'claim' and ${table.stateAfter} = 'indeterminate' and ${table.safeCode} = 'claim-lease-expired') or (${table.claimId} = ${table.generationClaimId} and (${table.ownershipTokenHash} is null or ${table.ownershipTokenHash} = ${table.generationOwnershipTokenHash}))`,
    ),
    check(
      'audio_request_receipt_operations_revision_check',
      sql`${table.receiptRevision} > 0 and ${table.claimGeneration} > 0`,
    ),
    check(
      'audio_request_receipt_operations_retention_check',
      sql`${table.retainUntil} > ${table.recordedAt} and ${table.retainUntil} <= ${table.recordedAt} + interval '90 days'`,
    ),
  ],
);

/** Immutable exact outcomes for claim commands that do not advance a receipt. */
export const audioRequestClaimOutcomes = emdoSchema.table(
  'audio_request_claim_outcomes',
  {
    operationId: uuid('operation_id').primaryKey(),
    operationHash: text('operation_hash').notNull(),
    householdId: uuid('household_id').notNull(),
    userId: uuid('user_id').notNull(),
    originSessionId: uuid('origin_session_id').notNull(),
    originRequestId: uuid('origin_request_id').notNull(),
    originSpaceAccessGrantId: uuid('origin_space_access_grant_id').notNull(),
    originRole: text('origin_role').notNull(),
    receiptId: uuid('receipt_id').notNull(),
    requestClaimId: uuid('request_claim_id').notNull(),
    requestOwnershipTokenHash: text('request_ownership_token_hash').notNull(),
    generationClaimId: uuid('generation_claim_id').notNull(),
    generationOwnershipTokenHash: text(
      'generation_ownership_token_hash',
    ).notNull(),
    claimGeneration: integer('claim_generation').notNull(),
    receiptRevision: bigint('receipt_revision', { mode: 'bigint' }).notNull(),
    storedResult: jsonb('stored_result').$type<JsonValue>().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'audio_request_claim_outcomes_receipt_fk',
      columns: [table.receiptId],
      foreignColumns: [audioRequestReceipts.receiptId],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('audio_request_claim_outcomes_owner_idx').on(
      table.householdId,
      table.userId,
      table.recordedAt,
    ),
    check(
      'audio_request_claim_outcomes_hash_check',
      sql`${table.operationHash} ~ '^[a-f0-9]{64}$' and ${table.requestOwnershipTokenHash} ~ '^[a-f0-9]{64}$' and ${table.generationOwnershipTokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'audio_request_claim_outcomes_role_check',
      sql`${table.originRole} in ('owner', 'member')`,
    ),
    check(
      'audio_request_claim_outcomes_revision_check',
      sql`${table.claimGeneration} > 0 and ${table.receiptRevision} > 0`,
    ),
    check(
      'audio_request_claim_outcomes_result_check',
      sql`"emdo"."is_safe_audio_claim_outcome"(${table.storedResult})`,
    ),
    check(
      'audio_request_claim_outcomes_retention_check',
      sql`${table.retainUntil} > ${table.recordedAt} and ${table.retainUntil} <= ${table.recordedAt} + interval '90 days'`,
    ),
  ],
);

/** Canonical local-only entity state mutated by PowerSync uploads. */
export const syncEntities = emdoSchema.table(
  'sync_entities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    payload: jsonb('payload').$type<JsonValue>().notNull(),
    actorIntent: text('actor_intent').notNull(),
    revision: integer('revision').notNull(),
    tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'sync_entities_household_space_fk',
      columns: [table.householdId, table.spaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'sync_entities_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    unique('sync_entities_scope_entity_unique').on(
      table.householdId,
      table.spaceId,
      table.entityType,
      table.entityId,
    ),
    index('sync_entities_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    check('sync_entities_revision_positive', sql`${table.revision} > 0`),
    check(
      'sync_entities_entity_type_check',
      sql`${table.entityType} in ('conversation.event', 'scheduler.item', 'scheduler.task', 'scheduler.reminder', 'scheduler.chore', 'scheduler.routine', 'finance.account', 'finance.transaction', 'finance.category', 'finance.budget', 'finance.bill', 'finance.subscription', 'finance.goal', 'shopping.list', 'shopping.item', 'shopping.preference')`,
    ),
    check(
      'sync_entities_entity_id_check',
      sql`pg_catalog.length(${table.entityId}) between 1 and 512 and ${table.entityId} !~ '[[:cntrl:]]'`,
    ),
    check(
      'sync_entities_actor_intent_check',
      sql`pg_catalog.length(${table.actorIntent}) between 3 and 1000 and pg_catalog.btrim(${table.actorIntent}) = ${table.actorIntent}`,
    ),
    check(
      'sync_entities_payload_size_check',
      sql`pg_catalog.octet_length(${table.payload}::text) between 2 and 1048576`,
    ),
  ],
);

/** Server-owned, short-lived canonical plan; imported statement bytes are never stored. */
export const financeImportPlans = emdoSchema.table(
  'finance_import_plans',
  {
    planId: uuid('plan_id').primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    ownerUserId: uuid('owner_user_id').notNull(),
    accountId: text('account_id').notNull(),
    sourceHash: text('source_hash').notNull(),
    planHash: text('plan_hash').notNull(),
    canonicalPlan: jsonb('canonical_plan').$type<JsonValue>().notNull(),
    diagnostics: jsonb('diagnostics').$type<JsonValue>().notNull(),
    mappingMetadata: jsonb('mapping_metadata').$type<JsonValue>().notNull(),
    scopeFingerprint: text('scope_fingerprint').notNull(),
    originSessionId: uuid('origin_session_id').notNull(),
    originRequestId: uuid('origin_request_id').notNull(),
    originSpaceAccessGrantId: uuid('origin_space_access_grant_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'finance_import_plans_household_space_fk',
      columns: [table.householdId, table.spaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'finance_import_plans_owner_membership_fk',
      columns: [table.householdId, table.ownerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('finance_import_plans_scope_expiry_idx').on(
      table.householdId,
      table.ownerUserId,
      table.expiresAt,
    ),
    uniqueIndex('finance_import_plans_scope_hash_unique').on(
      table.householdId,
      table.ownerUserId,
      table.planHash,
    ),
    check(
      'finance_import_plans_source_hash_check',
      sql`${table.sourceHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'finance_import_plans_plan_hash_check',
      sql`${table.planHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'finance_import_plans_scope_hash_check',
      sql`${table.scopeFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'finance_import_plans_account_id_check',
      sql`octet_length(${table.accountId}) between 1 and 512 and ${table.accountId} !~ '[[:cntrl:]]'`,
    ),
    check(
      'finance_import_plans_expiry_check',
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '30 minutes'`,
    ),
    check(
      'finance_import_plans_plan_size_check',
      sql`octet_length(${table.canonicalPlan}::text) between 2 and 1048576`,
    ),
    check(
      'finance_import_plans_diagnostics_size_check',
      sql`octet_length(${table.diagnostics}::text) between 2 and 1048576`,
    ),
    check(
      'finance_import_plans_mapping_size_check',
      sql`octet_length(${table.mappingMetadata}::text) between 2 and 4096`,
    ),
  ],
);

/** Uniqueness boundary for imported transaction fingerprints within an account. */
export const financeImportFingerprints = emdoSchema.table(
  'finance_import_fingerprints',
  {
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    ownerUserId: uuid('owner_user_id').notNull(),
    accountId: text('account_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    transactionEntityId: uuid('transaction_entity_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'finance_import_fingerprints_scope_primary',
      columns: [
        table.householdId,
        table.spaceId,
        table.accountId,
        table.fingerprint,
      ],
    }),
    unique('finance_import_fingerprints_transaction_unique').on(
      table.transactionEntityId,
    ),
    check(
      'finance_import_fingerprints_hash_check',
      sql`${table.fingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'finance_import_fingerprints_account_id_check',
      sql`octet_length(${table.accountId}) between 1 and 512 and ${table.accountId} !~ '[[:cntrl:]]'`,
    ),
  ],
);

/** Immutable receipt for exactly one server-held plan and client idempotency key. */
export const financeImportReceipts = emdoSchema.table(
  'finance_import_receipts',
  {
    receiptId: uuid('receipt_id').defaultRandom().primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    ownerUserId: uuid('owner_user_id').notNull(),
    accountId: text('account_id').notNull(),
    planId: uuid('plan_id').notNull(),
    planHash: text('plan_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    scopeFingerprint: text('scope_fingerprint').notNull(),
    originSpaceAccessGrantId: uuid('origin_space_access_grant_id').notNull(),
    transactionCount: integer('transaction_count').notNull(),
    committedAt: timestamp('committed_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('finance_import_receipts_owner_idempotency_unique').on(
      table.householdId,
      table.ownerUserId,
      table.idempotencyKey,
    ),
    unique('finance_import_receipts_plan_unique').on(table.planId),
    check(
      'finance_import_receipts_plan_hash_check',
      sql`${table.planHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'finance_import_receipts_scope_hash_check',
      sql`${table.scopeFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'finance_import_receipts_account_id_check',
      sql`octet_length(${table.accountId}) between 1 and 512 and ${table.accountId} !~ '[[:cntrl:]]'`,
    ),
    check(
      'finance_import_receipts_key_check',
      sql`length(${table.idempotencyKey}) between 16 and 200 and ${table.idempotencyKey} ~ '^[A-Za-z0-9:._-]+$'`,
    ),
    check(
      'finance_import_receipts_transaction_count_check',
      sql`${table.transactionCount} between 1 and 100000`,
    ),
  ],
);

/** Append-only, exact canonical snapshots captured from sync entity writes. */
export const syncEntityRevisions = emdoSchema.table(
  'sync_entity_revisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    revision: integer('revision').notNull(),
    payloadHash: text('payload_hash').notNull(),
    payload: jsonb('payload').$type<JsonValue>().notNull(),
    tombstoned: boolean('tombstoned').notNull(),
    actorIntent: text('actor_intent').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
    compactionAfter: timestamp('compaction_after', {
      withTimezone: true,
    }).notNull(),
    compactionPolicy: text('compaction_policy').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'sync_entity_revisions_household_space_fk',
      columns: [table.householdId, table.spaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'sync_entity_revisions_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    unique('sync_entity_revisions_scope_revision_unique').on(
      table.householdId,
      table.spaceId,
      table.entityType,
      table.entityId,
      table.revision,
    ),
    index('sync_entity_revisions_household_space_idx').on(
      table.householdId,
      table.spaceId,
      table.entityType,
      table.entityId,
      table.revision,
    ),
    index('sync_entity_revisions_compaction_idx').on(
      table.compactionPolicy,
      table.compactionAfter,
    ),
    check(
      'sync_entity_revisions_revision_positive',
      sql`${table.revision} > 0`,
    ),
    check(
      'sync_entity_revisions_entity_type_check',
      sql`${table.entityType} in ('conversation.event', 'scheduler.item', 'scheduler.task', 'scheduler.reminder', 'scheduler.chore', 'scheduler.routine', 'finance.account', 'finance.transaction', 'finance.category', 'finance.budget', 'finance.bill', 'finance.subscription', 'finance.goal', 'shopping.list', 'shopping.item', 'shopping.preference')`,
    ),
    check(
      'sync_entity_revisions_entity_id_check',
      sql`pg_catalog.length(${table.entityId}) between 1 and 512 and ${table.entityId} !~ '[[:cntrl:]]'`,
    ),
    check(
      'sync_entity_revisions_actor_intent_check',
      sql`pg_catalog.length(${table.actorIntent}) between 3 and 1000 and pg_catalog.btrim(${table.actorIntent}) = ${table.actorIntent}`,
    ),
    check(
      'sync_entity_revisions_payload_size_check',
      sql`pg_catalog.octet_length(${table.payload}::text) between 2 and 1048576`,
    ),
    check(
      'sync_entity_revisions_payload_safety_check',
      sql`"emdo"."is_safe_sync_snapshot_payload"(${table.payload})`,
    ),
    check(
      'sync_entity_revisions_payload_hash_check',
      sql`${table.payloadHash} ~ '^[a-f0-9]{64}$' and ${table.payloadHash} = "emdo"."sync_entity_revision_hash"(${table.householdId}, ${table.spaceId}, ${table.originalOwnerUserId}, ${table.entityType}, ${table.entityId}, ${table.revision}, ${table.payload}, ${table.tombstoned}, ${table.actorIntent})`,
    ),
    check(
      'sync_entity_revisions_retention_check',
      sql`${table.retainUntil} > ${table.recordedAt} and ${table.retainUntil} <= ${table.recordedAt} + interval '365 days' and ${table.compactionAfter} = ${table.retainUntil}`,
    ),
    check(
      'sync_entity_revisions_compaction_policy_check',
      sql`${table.compactionPolicy} = 'manual-review-required'`,
    ),
  ],
);

/** Immutable terminal operation outcomes providing durable upload idempotency. */
export const syncOperationReceipts = emdoSchema.table(
  'sync_operation_receipts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    clientId: uuid('client_id').notNull(),
    operationId: uuid('operation_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    mutationKind: text('mutation_kind').notNull(),
    baseRevision: integer('base_revision').notNull(),
    outcomeStatus: text('outcome_status').notNull(),
    outcomeCode: text('outcome_code'),
    outcomeContractVersion: smallint('outcome_contract_version')
      .default(1)
      .notNull(),
    outcomeResolution: text('outcome_resolution'),
    outcomeDisposition: text('outcome_disposition'),
    conflictDetails: jsonb('conflict_details')
      .$type<
        readonly { readonly field: string; readonly material: boolean }[]
      >()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    currentRevision: integer('current_revision'),
    resultingRevision: integer('resulting_revision'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true })
      .default(sql`clock_timestamp() + interval '90 days'`)
      .notNull(),
    compactionAfter: timestamp('compaction_after', { withTimezone: true })
      .default(sql`clock_timestamp() + interval '91 days'`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'sync_operation_receipts_client_fk',
      columns: [table.householdId, table.originalOwnerUserId, table.clientId],
      foreignColumns: [
        syncClients.householdId,
        syncClients.userId,
        syncClients.id,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'sync_operation_receipts_household_space_fk',
      columns: [table.householdId, table.spaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    unique('sync_operation_receipts_client_operation_unique').on(
      table.clientId,
      table.operationId,
    ),
    index('sync_operation_receipts_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('sync_operation_receipts_client_recorded_idx').on(
      table.clientId,
      table.recordedAt,
    ),
    check(
      'sync_operation_receipts_fingerprint_check',
      sql`${table.fingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'sync_operation_receipts_outcome_check',
      sql`${table.outcomeStatus} in ('applied', 'conflict')`,
    ),
    check(
      'sync_operation_receipts_contract_version_check',
      sql`${table.outcomeContractVersion} in (0, 1)`,
    ),
    check(
      'sync_operation_receipts_conflict_details_check',
      sql`pg_catalog.jsonb_typeof(${table.conflictDetails}) = 'array' and pg_catalog.jsonb_array_length(${table.conflictDetails}) <= 32 and pg_catalog.octet_length(${table.conflictDetails}::text) <= 8192 and "emdo"."is_bounded_sync_conflict_details"(${table.conflictDetails})`,
    ),
    check(
      'sync_operation_receipts_outcome_shape_check',
      sql`(${table.outcomeContractVersion} = 0 and ${table.outcomeResolution} is null and ${table.outcomeDisposition} is null and ${table.conflictDetails} = '[]'::jsonb) or (${table.outcomeContractVersion} = 1 and ((${table.outcomeStatus} = 'applied' and ${table.outcomeCode} is null and ${table.outcomeResolution} in ('created', 'applied', 'merged', 'ignored', 'duplicate') and ${table.outcomeDisposition} is null and ${table.conflictDetails} = '[]'::jsonb and ${table.resultingRevision} > 0 and (${table.currentRevision} is null or ${table.currentRevision} > 0)) or (${table.outcomeStatus} = 'conflict' and ${table.outcomeCode} in ('entity-exists', 'entity-not-found', 'revision-mismatch', 'tombstoned', 'mutation-invalid', 'repository-rejected', 'domain-operation-invalid', 'domain-operation-unsupported', 'base-revision-unavailable', 'base-state-mismatch', 'material-conflict') and ${table.outcomeResolution} is null and ${table.outcomeDisposition} = 'terminal' and ${table.resultingRevision} is null and (${table.currentRevision} is null or ${table.currentRevision} > 0))))`,
    ),
    check(
      'sync_operation_receipts_retention_check',
      sql`${table.retainUntil} > ${table.recordedAt} and ${table.retainUntil} <= ${table.recordedAt} + interval '90 days'`,
    ),
    check(
      'sync_operation_receipts_compaction_check',
      sql`(${table.outcomeContractVersion} = 0 and ${table.compactionAfter} = 'infinity'::timestamptz) or (${table.outcomeContractVersion} = 1 and ${table.compactionAfter} >= ${table.retainUntil} and ${table.compactionAfter} <= ${table.recordedAt} + interval '365 days')`,
    ),
  ],
);

/** Payload-bound gateway idempotency with one-way pending completion. */
export const syncApiRequestReceipts = emdoSchema.table(
  'sync_api_request_receipts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    householdId: uuid('household_id').notNull(),
    userId: uuid('user_id').notNull(),
    clientId: uuid('client_id').notNull(),
    requestKind: text('request_kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    initialRequestId: uuid('initial_request_id').notNull(),
    latestRequestId: uuid('latest_request_id').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    response: jsonb('response').$type<JsonValue>(),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .default(sql`statement_timestamp()`)
      .notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    retainUntil: timestamp('retain_until', { withTimezone: true })
      .default(sql`statement_timestamp() + interval '90 days'`)
      .notNull(),
    compactionAfter: timestamp('compaction_after', { withTimezone: true })
      .default(sql`statement_timestamp() + interval '91 days'`)
      .notNull(),
    compactionPolicy: text('compaction_policy')
      .default('manual-review-required')
      .notNull(),
  },
  (table) => [
    unique('sync_api_request_receipts_scope_key_unique').on(
      table.householdId,
      table.userId,
      table.clientId,
      table.requestKind,
      table.idempotencyKey,
    ),
    index('sync_api_request_receipts_scope_recorded_idx').on(
      table.householdId,
      table.userId,
      table.clientId,
      table.recordedAt,
    ),
    index('sync_api_request_receipts_compaction_idx').on(
      table.compactionPolicy,
      table.compactionAfter,
    ),
    check(
      'sync_api_request_receipts_kind_check',
      sql`${table.requestKind} in ('register-client', 'apply-operations')`,
    ),
    check(
      'sync_api_request_receipts_idempotency_key_check',
      sql`${table.idempotencyKey} ~ '^[A-Za-z0-9:._-]{16,200}$'`,
    ),
    check(
      'sync_api_request_receipts_fingerprint_check',
      sql`${table.requestFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'sync_api_request_receipts_response_check',
      sql`${table.response} is null or "emdo"."is_safe_sync_api_response"(${table.requestKind}, ${table.clientId}, ${table.response})`,
    ),
    check(
      'sync_api_request_receipts_completion_check',
      sql`(${table.response} is null and ${table.completedAt} is null and ${table.latestRequestId} = ${table.initialRequestId}) or (${table.response} is not null and ${table.completedAt} is not null and ${table.completedAt} >= ${table.recordedAt})`,
    ),
    check(
      'sync_api_request_receipts_retention_check',
      sql`${table.retainUntil} > ${table.recordedAt} and ${table.retainUntil} <= ${table.recordedAt} + interval '90 days' and ${table.compactionAfter} >= ${table.retainUntil} and ${table.compactionAfter} <= ${table.recordedAt} + interval '365 days'`,
    ),
    check(
      'sync_api_request_receipts_compaction_policy_check',
      sql`${table.compactionPolicy} = 'manual-review-required'`,
    ),
  ],
);

/** Google Calendar executor idempotency receipt and reconciliation marker. */
export const schedulerExecutionReceipts = emdoSchema.table(
  'scheduler_execution_receipts',
  {
    receiptKey: text('receipt_key').primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    runId: uuid('run_id').notNull(),
    providerId: text('provider_id').notNull(),
    commandHash: text('command_hash').notNull(),
    state: text('state').notNull(),
    result: jsonb('result').$type<JsonValue>(),
    reconciliationRequired: boolean('reconciliation_required')
      .default(false)
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
    }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true })
      .default(sql`clock_timestamp() + interval '90 days'`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'scheduler_execution_receipts_run_fk',
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
    index('scheduler_execution_receipts_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('scheduler_execution_receipts_reconciliation_idx').on(
      table.householdId,
      table.reconciliationRequired,
      table.updatedAt,
    ),
    check(
      'scheduler_execution_receipts_hash_check',
      sql`${table.receiptKey} ~ '^[a-f0-9]{64}$' and ${table.commandHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'scheduler_execution_receipts_state_check',
      sql`${table.state} in ('pending', 'completed')`,
    ),
    check(
      'scheduler_execution_receipts_retention_check',
      sql`${table.retainUntil} > ${table.createdAt} and ${table.retainUntil} <= ${table.createdAt} + interval '90 days'`,
    ),
  ],
);

/** Canonical, tenant-scoped handoff from application commits to pg-boss. */
export const workerOperationOutbox = emdoSchema.table(
  'worker_operation_outbox',
  {
    outboxId: uuid('outbox_id').defaultRandom().primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    requestId: uuid('request_id').notNull(),
    jobName: text('job_name').notNull(),
    operationId: text('operation_id').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    targetRevision: integer('target_revision'),
    relatedOperationId: text('related_operation_id'),
    retrySequence: integer('retry_sequence'),
    payload: jsonb('payload').$type<JsonValue>().notNull(),
    payloadHash: text('payload_hash').notNull(),
    state: text('state').default('pending').notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
    leaseToken: uuid('lease_token'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    queueJobId: uuid('queue_job_id'),
    safeCode: text('safe_code'),
    dispatchAttempts: integer('dispatch_attempts').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    retainUntil: timestamp('retain_until', { withTimezone: true })
      .default(sql`clock_timestamp() + interval '90 days'`)
      .notNull(),
  },
  (table) => [
    unique('worker_operation_outbox_job_operation_unique').on(
      table.jobName,
      table.operationId,
    ),
    unique('worker_operation_outbox_scope_id_unique').on(
      table.householdId,
      table.spaceId,
      table.originalOwnerUserId,
      table.outboxId,
    ),
    unique('worker_operation_outbox_execution_binding_unique').on(
      table.householdId,
      table.spaceId,
      table.originalOwnerUserId,
      table.outboxId,
      table.jobName,
      table.operationId,
      table.payloadHash,
    ),
    foreignKey({
      name: 'worker_operation_outbox_household_space_fk',
      columns: [table.householdId, table.spaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'worker_operation_outbox_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('worker_operation_outbox_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('worker_operation_outbox_due_idx').on(
      table.state,
      table.availableAt,
      table.createdAt,
    ),
    check(
      'worker_operation_outbox_state_check',
      sql`${table.state} in ('pending', 'leased', 'enqueued', 'completed', 'dispatch-failed', 'quarantined')`,
    ),
    check(
      'worker_operation_outbox_job_check',
      sql`${table.jobName} in ('emdo.reminder.delivery.v1', 'emdo.calendar.sync.v1', 'emdo.calendar.retry.v1', 'emdo.calendar.reconciliation.v1', 'emdo.notification.delivery.v1', 'emdo.invitation.delivery.v1')`,
    ),
    check(
      'worker_operation_outbox_target_revision_check',
      sql`${table.targetRevision} is null or ${table.targetRevision} >= 0`,
    ),
    check(
      'worker_operation_outbox_retry_sequence_check',
      sql`${table.retrySequence} is null or ${table.retrySequence} between 1 and 20`,
    ),
    check(
      'worker_operation_outbox_dispatch_attempts_nonnegative',
      sql`${table.dispatchAttempts} between 0 and 20`,
    ),
    check(
      'worker_operation_outbox_payload_hash_check',
      sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'worker_operation_outbox_safe_code_check',
      sql`${table.safeCode} is null or ${table.safeCode} in ('queue-unavailable', 'invalid-operation', 'attempt-exhausted', 'execution-indeterminate')`,
    ),
    check(
      'worker_operation_outbox_retention_check',
      sql`${table.retainUntil} > ${table.createdAt} and ${table.retainUntil} <= ${table.createdAt} + interval '90 days'`,
    ),
  ],
);

/** At-most-once callback claim; a crash remains explicitly indeterminate. */
export const workerJobExecutions = emdoSchema.table(
  'worker_job_executions',
  {
    executionId: uuid('execution_id').defaultRandom().primaryKey(),
    outboxId: uuid('outbox_id').notNull(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    jobId: uuid('job_id').notNull(),
    jobName: text('job_name').notNull(),
    operationId: text('operation_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    state: text('state').notNull(),
    attemptCount: integer('attempt_count').default(1).notNull(),
    leaseToken: uuid('lease_token').notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
    }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true })
      .default(sql`clock_timestamp() + interval '90 days'`)
      .notNull(),
  },
  (table) => [
    unique('worker_job_executions_job_operation_unique').on(
      table.jobName,
      table.operationId,
    ),
    foreignKey({
      name: 'worker_job_executions_outbox_fk',
      columns: [
        table.householdId,
        table.spaceId,
        table.originalOwnerUserId,
        table.outboxId,
        table.jobName,
        table.operationId,
        table.payloadHash,
      ],
      foreignColumns: [
        workerOperationOutbox.householdId,
        workerOperationOutbox.spaceId,
        workerOperationOutbox.originalOwnerUserId,
        workerOperationOutbox.outboxId,
        workerOperationOutbox.jobName,
        workerOperationOutbox.operationId,
        workerOperationOutbox.payloadHash,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('worker_job_executions_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('worker_job_executions_state_lease_idx').on(
      table.state,
      table.leaseExpiresAt,
    ),
    index('worker_job_executions_exhausted_idx')
      .on(table.updatedAt, table.jobName, table.operationId)
      .where(sql`${table.state} = 'failed' and ${table.attemptCount} = 5`),
    check(
      'worker_job_executions_state_check',
      sql`${table.state} in ('leased', 'completed', 'failed', 'indeterminate')`,
    ),
    check(
      'worker_job_executions_attempt_count_check',
      sql`${table.attemptCount} between 1 and 5`,
    ),
    check(
      'worker_job_executions_payload_hash_check',
      sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'worker_job_executions_retention_check',
      sql`${table.retainUntil} > ${table.startedAt} and ${table.retainUntil} <= ${table.startedAt} + interval '90 days'`,
    ),
  ],
);

/** User-created, EMDO-native one-shot reminder state. */
export const schedulerReminders = emdoSchema.table(
  'scheduler_reminders',
  {
    reminderId: text('reminder_id').primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    dueRevision: integer('due_revision').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    state: text('state').default('scheduled').notNull(),
    sensitivity: text('sensitivity').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    inApp: boolean('in_app').notNull(),
    emailRecipient: text('email_recipient'),
    pushSubscriptionReference: text('push_subscription_reference'),
    deliveredRevision: integer('delivered_revision'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
  },
  (table) => [
    unique('scheduler_reminders_scope_id_unique').on(
      table.householdId,
      table.spaceId,
      table.originalOwnerUserId,
      table.reminderId,
    ),
    foreignKey({
      name: 'scheduler_reminders_household_space_fk',
      columns: [table.householdId, table.spaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'scheduler_reminders_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('scheduler_reminders_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('scheduler_reminders_due_idx').on(table.state, table.dueAt),
    check(
      'scheduler_reminders_due_revision_positive',
      sql`${table.dueRevision} > 0`,
    ),
    check(
      'scheduler_reminders_state_check',
      sql`${table.state} in ('scheduled', 'cancelled', 'delivered')`,
    ),
    check(
      'scheduler_reminders_sensitivity_check',
      sql`${table.sensitivity} in ('standard', 'sensitive')`,
    ),
    check(
      'scheduler_reminders_channel_check',
      sql`${table.inApp} or ${table.emailRecipient} is not null or ${table.pushSubscriptionReference} is not null`,
    ),
  ],
);

/** Canonical notification content; external adapters receive redacted previews. */
export const notifications = emdoSchema.table(
  'notifications',
  {
    notificationId: uuid('notification_id').defaultRandom().primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    sourceRevision: integer('source_revision').notNull(),
    revision: integer('revision').default(1).notNull(),
    sensitivity: text('sensitivity').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    inApp: boolean('in_app').notNull(),
    emailRecipient: text('email_recipient'),
    pushSubscriptionReference: text('push_subscription_reference'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
  },
  (table) => [
    unique('notifications_scope_id_unique').on(
      table.householdId,
      table.spaceId,
      table.originalOwnerUserId,
      table.notificationId,
    ),
    unique('notifications_source_revision_unique').on(
      table.householdId,
      table.spaceId,
      table.originalOwnerUserId,
      table.sourceType,
      table.sourceId,
      table.sourceRevision,
    ),
    foreignKey({
      name: 'notifications_household_space_fk',
      columns: [table.householdId, table.spaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'notifications_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('notifications_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    check(
      'notifications_source_revision_positive',
      sql`${table.sourceRevision} > 0 and ${table.revision} > 0`,
    ),
    check(
      'notifications_sensitivity_check',
      sql`${table.sensitivity} in ('standard', 'sensitive')`,
    ),
    check(
      'notifications_channel_check',
      sql`${table.inApp} or ${table.emailRecipient} is not null or ${table.pushSubscriptionReference} is not null`,
    ),
  ],
);

/** Versioned, user-scoped delivery and spoken-reply preferences. */
export const notificationPreferences = emdoSchema.table(
  'notification_preferences',
  {
    householdId: uuid('household_id').notNull(),
    userId: uuid('user_id').notNull(),
    inApp: boolean('in_app').default(true).notNull(),
    push: boolean('push').default(false).notNull(),
    email: boolean('email').default(false).notNull(),
    spokenReplies: boolean('spoken_replies').default(false).notNull(),
    version: integer('version').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: 'notification_preferences_pk',
      columns: [table.householdId, table.userId],
    }),
    foreignKey({
      name: 'notification_preferences_membership_fk',
      columns: [table.householdId, table.userId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'notification_preferences_version_positive',
      sql`${table.version} > 0`,
    ),
  ],
);

/** Exact idempotency receipts for notification preference mutations. */
export const notificationPreferenceCommands = emdoSchema.table(
  'notification_preference_commands',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    householdId: uuid('household_id').notNull(),
    userId: uuid('user_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    initialRequestId: uuid('initial_request_id').notNull(),
    latestRequestId: uuid('latest_request_id').notNull(),
    response: jsonb('response').$type<JsonValue>(),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    retainUntil: timestamp('retain_until', { withTimezone: true })
      .default(sql`clock_timestamp() + interval '90 days'`)
      .notNull(),
  },
  (table) => [
    unique('notification_preference_commands_idempotency_unique').on(
      table.householdId,
      table.userId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: 'notification_preference_commands_membership_fk',
      columns: [table.householdId, table.userId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'notification_preference_commands_key_check',
      sql`pg_catalog.length(${table.idempotencyKey}) between 16 and 200 and ${table.idempotencyKey} ~ '^[A-Za-z0-9:._-]+$'`,
    ),
    check(
      'notification_preference_commands_hash_check',
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'notification_preference_commands_completion_check',
      sql`(${table.response} is null and ${table.completedAt} is null) or (${table.response} is not null and ${table.completedAt} is not null)`,
    ),
    check(
      'notification_preference_commands_retention_check',
      sql`${table.retainUntil} > ${table.recordedAt} and ${table.retainUntil} <= ${table.recordedAt} + interval '90 days'`,
    ),
  ],
);

/** Idempotent in-app delivery or sanitized external channel outcome. */
export const notificationDeliveries = emdoSchema.table(
  'notification_deliveries',
  {
    deliveryId: text('delivery_id').primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    notificationId: uuid('notification_id').notNull(),
    operationId: text('operation_id').notNull(),
    revision: integer('revision').notNull(),
    channel: text('channel').notNull(),
    status: text('status').notNull(),
    sensitivity: text('sensitivity'),
    title: text('title'),
    body: text('body'),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true })
      .default(sql`clock_timestamp() + interval '90 days'`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'notification_deliveries_notification_fk',
      columns: [
        table.householdId,
        table.spaceId,
        table.originalOwnerUserId,
        table.notificationId,
      ],
      foreignColumns: [
        notifications.householdId,
        notifications.spaceId,
        notifications.originalOwnerUserId,
        notifications.notificationId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('notification_deliveries_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('notification_deliveries_notification_idx').on(
      table.notificationId,
      table.revision,
    ),
    index('notification_deliveries_reconciliation_idx')
      .on(
        table.householdId,
        table.spaceId,
        table.originalOwnerUserId,
        table.attemptedAt,
      )
      .where(sql`${table.status} = 'indeterminate'`),
    check(
      'notification_deliveries_channel_check',
      sql`${table.channel} in ('in-app', 'email', 'push')`,
    ),
    check(
      'notification_deliveries_status_check',
      sql`${table.status} in ('created', 'sent', 'duplicate', 'gone', 'not-applied', 'indeterminate')`,
    ),
    check(
      'notification_deliveries_external_payload_check',
      sql`(${table.channel} = 'in-app' and ${table.sensitivity} in ('standard', 'sensitive') and ${table.title} is not null and ${table.body} is not null) or (${table.channel} in ('email', 'push') and ${table.sensitivity} is null and ${table.title} is null and ${table.body} is null)`,
    ),
    check(
      'notification_deliveries_revision_positive',
      sql`${table.revision} > 0`,
    ),
    check(
      'notification_deliveries_retention_check',
      sql`${table.retainUntil} > ${table.attemptedAt} and ${table.retainUntil} <= ${table.attemptedAt} + interval '90 days'`,
    ),
  ],
);

/** Encrypted Calendar sync cursor and deterministic generation CAS. */
export const calendarSyncStates = emdoSchema.table(
  'calendar_sync_states',
  {
    connectionId: text('connection_id').primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    providerId: text('provider_id').default('google-calendar').notNull(),
    syncGeneration: integer('sync_generation').default(0).notNull(),
    sealedCursor: text('sealed_cursor'),
    providerVersion: text('provider_version'),
    state: text('state').default('ready').notNull(),
    retrySequence: integer('retry_sequence').default(0).notNull(),
    lastSafeCode: text('last_safe_code'),
    lastEvidenceHash: text('last_evidence_hash'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
  },
  (table) => [
    unique('calendar_sync_states_scope_id_unique').on(
      table.householdId,
      table.spaceId,
      table.originalOwnerUserId,
      table.connectionId,
    ),
    foreignKey({
      name: 'calendar_sync_states_household_space_fk',
      columns: [table.householdId, table.spaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'calendar_sync_states_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('calendar_sync_states_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    check(
      'calendar_sync_states_generation_nonnegative',
      sql`${table.syncGeneration} >= 0 and ${table.retrySequence} between 0 and 20`,
    ),
    check(
      'calendar_sync_states_state_check',
      sql`${table.state} in ('ready', 'syncing', 'retry-pending', 'disconnected')`,
    ),
    check(
      'calendar_sync_states_hash_check',
      sql`${table.lastEvidenceHash} is null or ${table.lastEvidenceHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/** Bounded metadata for sync/retry/readback outcomes; no provider bodies. */
export const calendarMaintenanceReceipts = emdoSchema.table(
  'calendar_maintenance_receipts',
  {
    receiptId: uuid('receipt_id').defaultRandom().primaryKey(),
    householdId: uuid('household_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    operationId: text('operation_id').notNull(),
    kind: text('kind').notNull(),
    targetId: text('target_id').notNull(),
    relatedOperationId: text('related_operation_id'),
    retrySequence: integer('retry_sequence'),
    status: text('status').notNull(),
    safeCode: text('safe_code'),
    providerVersion: text('provider_version'),
    resultHash: text('result_hash'),
    evidenceHash: text('evidence_hash'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true })
      .default(sql`clock_timestamp() + interval '90 days'`)
      .notNull(),
  },
  (table) => [
    unique('calendar_maintenance_receipts_operation_unique').on(
      table.operationId,
    ),
    foreignKey({
      name: 'calendar_maintenance_receipts_household_space_fk',
      columns: [table.householdId, table.spaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'calendar_maintenance_receipts_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('calendar_maintenance_receipts_household_space_idx').on(
      table.householdId,
      table.spaceId,
    ),
    index('calendar_maintenance_receipts_target_idx').on(
      table.targetId,
      table.recordedAt,
    ),
    check(
      'calendar_maintenance_receipts_kind_check',
      sql`${table.kind} in ('sync', 'retry', 'reconciliation')`,
    ),
    check(
      'calendar_maintenance_receipts_status_check',
      sql`${table.status} in ('completed', 'failed', 'indeterminate')`,
    ),
    check(
      'calendar_maintenance_receipts_safe_code_check',
      sql`${table.safeCode} is null or ${table.safeCode} in ('provider-unavailable', 'cursor-invalid', 'generation-conflict', 'readback-indeterminate')`,
    ),
    check(
      'calendar_maintenance_receipts_hash_check',
      sql`(${table.resultHash} is null or ${table.resultHash} ~ '^[a-f0-9]{64}$') and (${table.evidenceHash} is null or ${table.evidenceHash} ~ '^[a-f0-9]{64}$')`,
    ),
    check(
      'calendar_maintenance_receipts_retention_check',
      sql`${table.retainUntil} > ${table.recordedAt} and ${table.retainUntil} <= ${table.recordedAt} + interval '90 days'`,
    ),
  ],
);

/** Ten-minute, single-use PKCE state bound to one verified private-space session. */
export const googleOAuthFlows = emdoSchema.table(
  'google_oauth_flows',
  {
    id: text('id').primaryKey(),
    householdId: uuid('household_id').notNull(),
    privateSpaceId: uuid('private_space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    purpose: text('purpose').notNull(),
    requestedScopes: jsonb('requested_scopes')
      .$type<readonly string[]>()
      .notNull(),
    credentialRevisionAtStart: integer('credential_revision_at_start'),
    authorizationEpochAtStart: integer(
      'authorization_epoch_at_start',
    ).notNull(),
    codeVerifier: text('code_verifier').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'google_oauth_flows_household_space_fk',
      columns: [table.householdId, table.privateSpaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'google_oauth_flows_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('google_oauth_flows_household_space_idx').on(
      table.householdId,
      table.privateSpaceId,
    ),
    index('google_oauth_flows_actor_expiry_idx').on(
      table.originalOwnerUserId,
      table.expiresAt,
    ),
    check(
      'google_oauth_flows_state_id_check',
      sql`${table.id} ~ '^[A-Za-z0-9_-]{43}$'`,
    ),
    check(
      'google_oauth_flows_purpose_check',
      sql`${table.purpose} in ('calendar-read', 'calendar-event-write')`,
    ),
    check(
      'google_oauth_flows_revision_epoch_check',
      sql`(${table.credentialRevisionAtStart} is null or ${table.credentialRevisionAtStart} > 0) and ${table.authorizationEpochAtStart} >= 0`,
    ),
    check(
      'google_oauth_flows_lifetime_check',
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '10 minutes'`,
    ),
    check(
      'google_oauth_flows_verifier_size_check',
      sql`pg_catalog.octet_length(${table.codeVerifier}) between 43 and 128`,
    ),
  ],
);

/** Exact replay receipt for one authenticated Google OAuth start command. */
export const googleOAuthAuthorizationStarts = emdoSchema.table(
  'google_oauth_authorization_starts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    householdId: uuid('household_id').notNull(),
    privateSpaceId: uuid('private_space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    purpose: text('purpose').notNull(),
    result: jsonb('result').$type<JsonValue>().notNull(),
    flowId: text('flow_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('google_oauth_authorization_starts_scope_key_unique').on(
      table.householdId,
      table.privateSpaceId,
      table.originalOwnerUserId,
      table.sessionId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: 'google_oauth_authorization_starts_household_space_fk',
      columns: [table.householdId, table.privateSpaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'google_oauth_authorization_starts_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'google_oauth_authorization_starts_flow_fk',
      columns: [table.flowId],
      foreignColumns: [googleOAuthFlows.id],
    })
      .onDelete('set null')
      .onUpdate('restrict'),
    index('google_oauth_authorization_starts_expiry_idx').on(table.retainUntil),
    check(
      'google_oauth_authorization_starts_key_check',
      sql`pg_catalog.length(${table.idempotencyKey}) between 16 and 200 and ${table.idempotencyKey} ~ '^[A-Za-z0-9:._-]+$'`,
    ),
    check(
      'google_oauth_authorization_starts_fingerprint_check',
      sql`${table.requestFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'google_oauth_authorization_starts_purpose_check',
      sql`${table.purpose} in ('calendar-read', 'calendar-event-write')`,
    ),
    check(
      'google_oauth_authorization_starts_result_check',
      sql`pg_catalog.jsonb_typeof(${table.result}) = 'object' and pg_catalog.octet_length(${table.result}::text) between 1 and 8192`,
    ),
    check(
      'google_oauth_authorization_starts_retention_check',
      sql`${table.retainUntil} > ${table.createdAt} and ${table.retainUntil} <= ${table.createdAt} + interval '24 hours'`,
    ),
  ],
);

/** Monotonic grant tombstone that survives credential deletion/reconnect ABA. */
export const googleOAuthAuthorizationEpochs = emdoSchema.table(
  'google_oauth_authorization_epochs',
  {
    householdId: uuid('household_id').notNull(),
    privateSpaceId: uuid('private_space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    authorizationEpoch: integer('authorization_epoch').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'google_oauth_authorization_epochs_pk',
      columns: [
        table.householdId,
        table.privateSpaceId,
        table.originalOwnerUserId,
      ],
    }),
    foreignKey({
      name: 'google_oauth_authorization_epochs_household_space_fk',
      columns: [table.householdId, table.privateSpaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'google_oauth_authorization_epochs_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('google_oauth_authorization_epochs_household_space_idx').on(
      table.householdId,
      table.privateSpaceId,
    ),
    check(
      'google_oauth_authorization_epochs_nonnegative',
      sql`${table.authorizationEpoch} >= 0`,
    ),
  ],
);

/** Separately encrypted Calendar authorization grant; never stores plaintext tokens. */
export const encryptedGoogleCalendarGrants = emdoSchema.table(
  'encrypted_google_calendar_grants',
  {
    recordId: text('record_id').primaryKey(),
    householdId: uuid('household_id').notNull(),
    privateSpaceId: uuid('private_space_id').notNull(),
    originalOwnerUserId: uuid('original_owner_user_id').notNull(),
    provider: text('provider').notNull(),
    grantType: text('grant_type').notNull(),
    revision: integer('revision').notNull(),
    authorizationEpoch: integer('authorization_epoch').notNull(),
    providerGrantReference: text('provider_grant_reference').notNull(),
    encryptedPayload: jsonb('encrypted_payload').$type<JsonValue>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('encrypted_google_calendar_grants_scope_unique').on(
      table.householdId,
      table.privateSpaceId,
      table.originalOwnerUserId,
      table.provider,
      table.grantType,
    ),
    unique('encrypted_google_calendar_grants_reference_unique').on(
      table.provider,
      table.providerGrantReference,
    ),
    foreignKey({
      name: 'encrypted_google_calendar_grants_household_space_fk',
      columns: [table.householdId, table.privateSpaceId],
      foreignColumns: [spaces.householdId, spaces.id],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      name: 'encrypted_google_calendar_grants_owner_membership_fk',
      columns: [table.householdId, table.originalOwnerUserId],
      foreignColumns: [
        householdMemberships.householdId,
        householdMemberships.userId,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('encrypted_google_calendar_grants_household_space_idx').on(
      table.householdId,
      table.privateSpaceId,
    ),
    check(
      'encrypted_google_calendar_grants_binding_check',
      sql`${table.provider} = 'google' and ${table.grantType} = 'calendar-authorization' and ${table.revision} > 0 and ${table.authorizationEpoch} >= 0 and pg_catalog.length(${table.providerGrantReference}) between 16 and 160 and pg_catalog.btrim(${table.providerGrantReference}) = ${table.providerGrantReference} and ${table.providerGrantReference} !~ '[[:cntrl:]]'`,
    ),
    check(
      'encrypted_google_calendar_grants_payload_size_check',
      sql`pg_catalog.octet_length(${table.encryptedPayload}::text) between 1 and 65536`,
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
  agent_run_events: agentRunEvents,
  agent_runs: agentRuns,
  ai_spend_reservations: aiSpendReservations,
  audio_request_claim_outcomes: audioRequestClaimOutcomes,
  audio_request_receipt_operations: audioRequestReceiptOperations,
  audio_request_receipts: audioRequestReceipts,
  approval_checkpoints: approvalCheckpoints,
  approval_resume_jobs: approvalResumeJobs,
  audit_events: auditEvents,
  auth_accounts: authAccounts,
  auth_passkeys: authPasskeys,
  auth_rate_limits: authRateLimits,
  auth_sessions: authSessions,
  auth_users: authUsers,
  auth_verifications: authVerifications,
  conversation_events: conversationEvents,
  disclosure_grants: disclosureGrants,
  encrypted_google_calendar_grants: encryptedGoogleCalendarGrants,
  finance_import_fingerprints: financeImportFingerprints,
  finance_import_plans: financeImportPlans,
  finance_import_receipts: financeImportReceipts,
  deployment_bootstraps: deploymentBootstraps,
  household_memberships: householdMemberships,
  households,
  google_oauth_authorization_epochs: googleOAuthAuthorizationEpochs,
  google_oauth_authorization_starts: googleOAuthAuthorizationStarts,
  google_oauth_flows: googleOAuthFlows,
  household_administration_commands: householdAdministrationCommands,
  invitations,
  invitation_delivery_secrets: invitationDeliverySecrets,
  invitation_redemption_commands: invitationRedemptionCommands,
  manager_turn_operations: managerTurnOperations,
  manager_turns: managerTurns,
  memory_chunks: memoryChunks,
  proposal_events: proposalEvents,
  proposal_preparations: proposalPreparations,
  proposal_reconciliations: proposalReconciliations,
  proposal_states: proposalStates,
  provider_attempts: providerAttempts,
  provider_outcomes: providerOutcomes,
  visual_decision_proofs: visualDecisionProofs,
  rotating_sessions: rotatingSessions,
  calendar_maintenance_receipts: calendarMaintenanceReceipts,
  calendar_sync_states: calendarSyncStates,
  notification_deliveries: notificationDeliveries,
  notification_preference_commands: notificationPreferenceCommands,
  notification_preferences: notificationPreferences,
  notifications,
  scheduler_reminders: schedulerReminders,
  scheduler_execution_receipts: schedulerExecutionReceipts,
  space_records: spaceRecords,
  spaces,
  sync_api_request_receipts: syncApiRequestReceipts,
  sync_clients: syncClients,
  space_access_grants: spaceAccessGrants,
  sync_entities: syncEntities,
  sync_entity_revisions: syncEntityRevisions,
  sync_operation_receipts: syncOperationReceipts,
  worker_job_executions: workerJobExecutions,
  worker_operation_outbox: workerOperationOutbox,
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
