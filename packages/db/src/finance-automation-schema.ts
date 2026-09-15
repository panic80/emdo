import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  index,
  jsonb,
  numeric,
  primaryKey,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  financeBookEvidence,
  financeBooks,
  financeNormalizedImports,
  workspaces,
} from './finance-v2-schema.js';
import { authUsers } from './schema.js';
const schema = pgSchema('emdo');
const at = (name: string) => timestamp(name, { withTimezone: true });
export const financeAutomationAuthorityEpochs = schema.table(
  'finance_automation_authority_epochs',
  {
    workspaceId: uuid('workspace_id')
      .primaryKey()
      .references(() => workspaces.id),
    revision: integer('revision').default(1).notNull(),
  },
  (t) => [check('automation_epoch_positive', sql`${t.revision} > 0`)],
);
/** Deployment/operator-owned readiness; all capabilities start disabled. */
export const financeAutomationCapabilities = schema.table(
  'finance_automation_capabilities',
  {
    capability: text('capability').primaryKey(),
    ready: boolean('ready').default(false).notNull(),
  },
  (t) => [
    check(
      'automation_capability_closed',
      sql`${t.capability} in ('finance.documents.extract','finance.reports.generate','finance.journals.draft','finance.planning.budget-vs-actuals','finance.planning.forecast')`,
    ),
  ],
);
export const financeAutomationGrants = schema.table(
  'finance_automation_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    grantedByUserId: uuid('granted_by_user_id')
      .notNull()
      .references(() => authUsers.id),
    revision: integer('revision').default(1).notNull(),
    authorityEpoch: integer('authority_epoch').notNull(),
    status: text('status').default('active').notNull(),
    capabilities: jsonb('capabilities').notNull(),
    limits: jsonb('limits').notNull(),
    validFrom: at('valid_from').notNull(),
    expiresAt: at('expires_at').notNull(),
    createdAt: at('created_at').defaultNow().notNull(),
  },
  (t) => [
    unique('automation_grant_scope').on(t.workspaceId, t.bookId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    check(
      'automation_grant_state',
      sql`${t.status} in ('active','revoked') and ${t.revision}>0 and ${t.authorityEpoch}>0 and ${t.expiresAt}>${t.validFrom}`,
    ),
  ],
);
export const financeAutomationRuns = schema.table(
  'finance_automation_runs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    grantId: uuid('grant_id').notNull(),
    grantRevision: integer('grant_revision').notNull(),
    capability: text('capability').notNull(),
    intent: jsonb('intent').notNull(),
    requestHash: text('request_hash').notNull(),
    itemCount: integer('item_count').notNull(),
    currency: text('currency').notNull(),
    amount: numeric('amount', { precision: 38, scale: 12 }).notNull(),
    revision: integer('revision').default(1).notNull(),
    attempts: integer('attempts').default(0).notNull(),
    status: text('status').default('queued').notNull(),
    reserved: boolean('reserved').default(false).notNull(),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: at('lease_expires_at'),
    outcomeReference: uuid('outcome_reference'),
    blockedReason: text('blocked_reason'),
    createdAt: at('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('automation_run_expired_execution')
      .on(t.leaseExpiresAt, t.id)
      .where(sql`${t.status}='executing'`),
    index('automation_run_delivery_deadline')
      .on(t.createdAt, t.id)
      .where(sql`${t.status} in ('queued','retryable')`),
    unique('automation_run_scope').on(t.workspaceId, t.bookId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.bookId, t.grantId],
      foreignColumns: [
        financeAutomationGrants.workspaceId,
        financeAutomationGrants.bookId,
        financeAutomationGrants.id,
      ],
    }),
    check(
      'automation_run_state',
      sql`${t.status} in ('queued','executing','retryable','completed','blocked','requires-reconciliation') and ${t.revision}>0 and ${t.attempts}>=0 and ${t.itemCount}>0 and ${t.amount}>=0`,
    ),
    check(
      'automation_run_outcome',
      sql`(${t.status}='completed') = (${t.outcomeReference} is not null)`,
    ),
    check('automation_run_hash', sql`${t.requestHash} ~ '^[a-f0-9]{64}$'`),
  ],
);

/** Immutable extraction receipt; canonical facts remain in standardization_extractions. */
export const financeAutomationExtractionResults = schema.table(
  'finance_automation_extraction_results',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    operationId: uuid('operation_id')
      .notNull()
      .unique()
      .references(() => financeAutomationRuns.id),
    result: jsonb('result').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    check(
      'automation_extraction_result_bound',
      sql`jsonb_typeof(${t.result})='object' and octet_length(${t.result}::text)<=262144`,
    ),
  ],
);

/** Immutable generated proposal; review and posting state live separately. */
export const financeAutomationJournalDraftResults = schema.table(
  'finance_automation_journal_draft_results',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    automationRunId: uuid('automation_run_id').notNull(),
    schemaVersion: integer('schema_version').default(1).notNull(),
    sourceBatchId: uuid('source_batch_id').notNull(),
    sourceBatchRevision: integer('source_batch_revision').notNull(),
    sourceSnapshotHash: text('source_snapshot_hash').notNull(),
    sourceEvidenceId: uuid('source_evidence_id').notNull(),
    sourceDigest: text('source_digest').notNull(),
    sourceMappingHash: text('source_mapping_hash').notNull(),
    currency: text('currency').notNull(),
    itemCount: integer('item_count').notNull(),
    amount: numeric('amount', { precision: 38, scale: 12 }).notNull(),
    source: jsonb('source').notNull(),
    proposal: jsonb('proposal').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('journal_draft_result_run').on(t.automationRunId),
    unique('journal_draft_result_scope').on(t.workspaceId, t.bookId, t.id),
    foreignKey({
      name: 'journal_draft_result_run_scope',
      columns: [t.workspaceId, t.bookId, t.automationRunId],
      foreignColumns: [
        financeAutomationRuns.workspaceId,
        financeAutomationRuns.bookId,
        financeAutomationRuns.id,
      ],
    }),
    foreignKey({
      name: 'journal_draft_result_batch_scope',
      columns: [t.workspaceId, t.bookId, t.sourceBatchId],
      foreignColumns: [
        financeNormalizedImports.workspaceId,
        financeNormalizedImports.bookId,
        financeNormalizedImports.id,
      ],
    }),
    foreignKey({
      name: 'journal_draft_result_evidence_scope',
      columns: [t.workspaceId, t.bookId, t.sourceEvidenceId],
      foreignColumns: [
        financeBookEvidence.workspaceId,
        financeBookEvidence.bookId,
        financeBookEvidence.id,
      ],
    }),
    check(
      'journal_draft_result_version',
      sql`${t.schemaVersion}=1 and ${t.sourceBatchRevision}>0 and ${t.itemCount}>0 and ${t.currency} in ('CAD','USD','MXN','EUR','KRW','JPY') and ${t.amount}>=0 and ${t.amount}=round(${t.amount},case when ${t.currency} in ('JPY','KRW') then 0 else 2 end)`,
    ),
    check(
      'journal_draft_result_hashes',
      sql`${t.sourceSnapshotHash} ~ '^[a-f0-9]{64}$' and ${t.sourceDigest} ~ '^[a-f0-9]{64}$' and ${t.sourceMappingHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'journal_draft_result_payload',
      sql`jsonb_typeof(${t.source})='object' and jsonb_typeof(${t.proposal})='object' and octet_length(${t.source}::text)<=8000000 and octet_length(${t.proposal}::text)<=8000000`,
    ),
  ],
);

export const financeAutomationJournalDraftStates = schema.table(
  'finance_automation_journal_draft_states',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    draftId: uuid('draft_id').notNull(),
    revision: integer('revision').default(0).notNull(),
    status: text('status').default('review_required').notNull(),
    reviewDecision: text('review_decision'),
    reviewReason: text('review_reason'),
    reviewActorId: uuid('review_actor_id'),
    reviewAt: at('review_at'),
    postedJournalIds: jsonb('posted_journal_ids').notNull().default([]),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.bookId, t.draftId] }),
    foreignKey({
      name: 'journal_draft_state_result_scope',
      columns: [t.workspaceId, t.bookId, t.draftId],
      foreignColumns: [
        financeAutomationJournalDraftResults.workspaceId,
        financeAutomationJournalDraftResults.bookId,
        financeAutomationJournalDraftResults.id,
      ],
    }),
    foreignKey({
      name: 'journal_draft_state_actor',
      columns: [t.reviewActorId],
      foreignColumns: [authUsers.id],
    }),
    check(
      'journal_draft_state_shape',
      sql`${t.revision}>=0 and ${t.status} in ('review_required','approved','rejected','posted','discarded') and ((${t.status}='review_required' and ${t.reviewDecision} is null and ${t.reviewActorId} is null and ${t.reviewAt} is null) or (${t.status} in ('approved','rejected','posted') and ${t.reviewDecision} is not null and ${t.reviewActorId} is not null and ${t.reviewAt} is not null) or (${t.status}='discarded' and ((${t.reviewDecision} is null and ${t.reviewActorId} is null and ${t.reviewAt} is null) or (${t.reviewDecision} is not null and ${t.reviewActorId} is not null and ${t.reviewAt} is not null)))) and ((${t.status}='posted') = (jsonb_array_length(${t.postedJournalIds})>0)) and ((${t.status}<>'posted') = (jsonb_array_length(${t.postedJournalIds})=0))`,
    ),
  ],
);

export const financeAutomationJournalDraftEvents = schema.table(
  'finance_automation_journal_draft_events',
  {
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    draftId: uuid('draft_id').notNull(),
    revision: integer('revision').notNull(),
    kind: text('kind').notNull(),
    event: jsonb('event').notNull(),
    actorId: uuid('actor_id').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.draftId, t.revision] }),
    foreignKey({
      name: 'journal_draft_event_state_scope',
      columns: [t.workspaceId, t.bookId, t.draftId],
      foreignColumns: [
        financeAutomationJournalDraftStates.workspaceId,
        financeAutomationJournalDraftStates.bookId,
        financeAutomationJournalDraftStates.draftId,
      ],
    }),
    foreignKey({
      name: 'journal_draft_event_actor',
      columns: [t.actorId],
      foreignColumns: [authUsers.id],
    }),
    check(
      'journal_draft_event_shape',
      sql`${t.revision}>0 and ${t.kind} in ('reviewed','posted','discarded') and jsonb_typeof(${t.event})='object' and octet_length(${t.event}::text)<=65536`,
    ),
  ],
);
