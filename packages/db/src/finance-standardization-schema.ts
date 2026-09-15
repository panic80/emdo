import { sql } from 'drizzle-orm';
import {
  pgSchema,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  boolean,
  unique,
  foreignKey,
  check,
  index,
} from 'drizzle-orm/pg-core';
import {
  financeBookEvidence,
  financeReportMappingVersions,
} from './finance-v2-schema.js';
import { authUsers } from './schema.js';
const schema = pgSchema('emdo');
const at = (name: string) => timestamp(name, { withTimezone: true });
export const financeStandardizationRuns = schema.table(
  'finance_standardization_runs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    authorizedBy: uuid('authorized_by')
      .notNull()
      .references(() => authUsers.id),
    sourceDigest: text('source_digest').notNull(),
    authorityEpoch: integer('authority_epoch').notNull(),
    authorizationExpiresAt: at('authorization_expires_at').notNull(),
    revision: integer('revision').notNull().default(1),
    attempt: integer('attempt').notNull().default(0),
    status: text('status').notNull().default('queued'),
    executionMode: text('execution_mode').notNull().default('proposal'),
    reviewedMappingId: uuid('reviewed_mapping_id').references(
      () => financeReportMappingVersions.id,
    ),
    extraction: jsonb('extraction'),
    proposal: jsonb('proposal'),
    modelProvenance: jsonb('model_provenance'),
    blockers: jsonb('blockers').notNull().default([]),
    deliveryRevision: integer('delivery_revision').notNull().default(1),
    deliveryToken: uuid('delivery_token'),
    deliveryExpiresAt: at('delivery_expires_at'),
    deliveryPending: boolean('delivery_pending').notNull().default(true),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: at('lease_expires_at'),
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('standardization_source_author').on(
      t.workspaceId,
      t.bookId,
      t.evidenceId,
      t.sourceDigest,
      t.authorizedBy,
    ),
    unique('standardization_run_scope').on(t.workspaceId, t.bookId, t.id),
    foreignKey({
      name: 'standardization_evidence_scope',
      columns: [t.workspaceId, t.bookId, t.evidenceId],
      foreignColumns: [
        financeBookEvidence.workspaceId,
        financeBookEvidence.bookId,
        financeBookEvidence.id,
      ],
    }),
    check(
      'standardization_run_bounds',
      sql`${t.revision}>0 and ${t.authorityEpoch}>0 and ${t.attempt} between 0 and 3 and ${t.deliveryRevision}>0 and ${t.sourceDigest} ~ '^[a-f0-9]{64}$' and ${t.status} in ('queued','extracting','proposing','needs-review','blocked','authority-revoked','cancelled','indeterminate','extracted') and jsonb_typeof(${t.blockers})='array' and octet_length(${t.blockers}::text)<=65536 and coalesce(octet_length(${t.extraction}::text),0)<=131072 and coalesce(octet_length(${t.proposal}::text),0)<=131072 and coalesce(octet_length(${t.modelProvenance}::text),0)<=8192`,
    ),
    check(
      'standardization_execution_mode',
      sql`${t.executionMode} in ('proposal','extraction-only') and (${t.executionMode}<>'extraction-only' or (${t.deliveryPending}=false and ${t.proposal} is null and ${t.modelProvenance} is null)) and (${t.status}<>'extracted' or (${t.executionMode}='extraction-only' and ${t.extraction} is not null))`,
    ),
    index('standardization_delivery_due')
      .on(t.deliveryExpiresAt)
      .where(sql`${t.deliveryPending} and ${t.status}='queued'`),
  ],
);
export const financeStandardizationExtractions = schema.table(
  'finance_standardization_extractions',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => financeStandardizationRuns.id),
    revision: integer('revision').notNull(),
    sourceDigest: text('source_digest').notNull(),
    extractionDigest: text('extraction_digest').notNull(),
    envelope: jsonb('envelope').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('standardization_extraction_revision').on(t.runId, t.revision),
    check(
      'standardization_extraction_bounds',
      sql`${t.revision}>0 and octet_length(${t.envelope}::text)<=1048576 and ${t.sourceDigest} ~ '^[a-f0-9]{64}$' and ${t.extractionDigest} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
export const financeStandardizationSpend = schema.table(
  'finance_standardization_spend',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => financeStandardizationRuns.id),
    attempt: integer('attempt').notNull(),
    requestKey: text('request_key').notNull(),
    claimToken: uuid('claim_token').notNull(),
    claimRevision: integer('claim_revision').notNull(),
    pricingVersion: text('pricing_version').notNull(),
    pricing: jsonb('pricing'),
    dispatchPhase: text('dispatch_phase').notNull().default('unknown'),
    dispatchStartedAt: at('dispatch_started_at'),
    lineage: jsonb('lineage').notNull(),
    inputTokenCeiling: integer('input_token_ceiling').notNull(),
    outputTokenCeiling: integer('output_token_ceiling').notNull(),
    reservedCadMinor: integer('reserved_cad_minor').notNull(),
    actualCadMinor: integer('actual_cad_minor'),
    status: text('status').notNull().default('reserved'),
    providerResponseId: text('provider_response_id'),
    createdAt: at('created_at').notNull().defaultNow(),
    settledAt: at('settled_at'),
  },
  (t) => [
    unique('standardization_spend_attempt').on(t.runId, t.attempt),
    check(
      'standardization_spend_pricing_bounds',
      sql`${t.pricing} is null or (jsonb_typeof(${t.pricing})='object' and octet_length(${t.pricing}::text)<=256)`,
    ),
    check(
      'standardization_dispatch_phase',
      sql`${t.dispatchPhase} in ('unknown','not-dispatched','dispatch-started')`,
    ),
    check(
      'standardization_spend_bounds',
      sql`${t.attempt} between 1 and 3 and ${t.inputTokenCeiling} between 1 and 20000 and ${t.outputTokenCeiling} between 1 and 4000 and ${t.reservedCadMinor}>0 and (${t.actualCadMinor} is null or ${t.actualCadMinor}>=0) and ${t.status} in ('reserved','completed','not-sent','indeterminate') and length(${t.requestKey}) between 1 and 200 and length(${t.pricingVersion}) between 1 and 128`,
    ),
  ],
);
/** Deployment-owned ceilings; no runtime role can enable processing or raise budgets. */
export const financeStandardizationConfiguration = schema.table(
  'finance_standardization_configuration',
  {
    id: text('id').primaryKey(),
    ready: boolean('ready').notNull().default(false),
    maxRunCadMinor: integer('max_run_cad_minor').notNull().default(0),
    maxWorkspaceDayCadMinor: integer('max_workspace_day_cad_minor')
      .notNull()
      .default(0),
  },
  (t) => [
    check(
      'standardization_configuration_bounds',
      sql`${t.id}='v1' and ${t.maxRunCadMinor}>=0 and ${t.maxWorkspaceDayCadMinor}>=0 and (not ${t.ready} or (${t.maxRunCadMinor}>0 and ${t.maxWorkspaceDayCadMinor}>0))`,
    ),
  ],
);

export const financeStandardizationReconciliations = schema.table(
  'finance_standardization_reconciliations',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => financeStandardizationRuns.id),
    reservationId: uuid('reservation_id').references(
      () => financeStandardizationSpend.id,
    ),
    kind: text('kind').notNull(),
    lookupToken: uuid('lookup_token'),
    lookupExpiresAt: at('lookup_expires_at'),
    observedAt: at('observed_at'),
    runRevision: integer('run_revision').notNull(),
    sourceDigest: text('source_digest').notNull(),
    facts: jsonb('facts').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => authUsers.id),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('standardization_reconciliation_run').on(
      t.runId,
      t.kind,
      t.createdAt,
    ),
    index('standardization_receipt_pending')
      .on(t.createdAt)
      .where(sql`${t.kind}='receipt' and ${t.facts}->>'status'='pending'`),
    check(
      'standardization_reconciliation_bounds',
      sql`${t.kind} in ('receipt','resolution') and ${t.runRevision}>0 and ${t.sourceDigest} ~ '^[a-f0-9]{64}$' and octet_length(${t.facts}::text)<=8192`,
    ),
  ],
);
