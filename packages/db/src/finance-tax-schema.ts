import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { authUsers } from './schema.js';
import { workspaces, financeBooks } from './finance-v2-schema.js';
const schema = pgSchema('emdo');
const time = () =>
  timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const scope = () => ({
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  caseId: uuid('case_id').notNull(),
  taxSubjectId: uuid('tax_subject_id').notNull(),
});
export const financeTaxSubjects = schema.table(
  'finance_tax_subjects',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    displayName: text('display_name').notNull(),
    taxpayerType: text('taxpayer_type').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => authUsers.id),
    createdAt: time(),
  },
  (t) => [
    unique('tax_subject_scope').on(t.workspaceId, t.id),
    check(
      'tax_subject_type',
      sql`${t.taxpayerType} in ('individual','sole-proprietor','corporation')`,
    ),
  ],
);
export const financeTaxCases = schema.table(
  'finance_tax_cases',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    taxSubjectId: uuid('tax_subject_id').notNull(),
    title: text('title').notNull(),
    currentRevision: integer('current_revision').notNull().default(0),
    status: text('status').notNull().default('incomplete'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => authUsers.id),
    createdAt: time(),
  },
  (t) => [
    unique('tax_case_identity').on(t.workspaceId, t.id, t.taxSubjectId),
    foreignKey({
      name: 'tax_case_subject',
      columns: [t.workspaceId, t.taxSubjectId],
      foreignColumns: [financeTaxSubjects.workspaceId, financeTaxSubjects.id],
    }),
    check(
      'tax_case_no_complete',
      sql`${t.status}='incomplete' and ${t.currentRevision}>=0`,
    ),
  ],
);
const caseKey = (t: {
  workspaceId: AnyPgColumn;
  caseId: AnyPgColumn;
  taxSubjectId: AnyPgColumn;
}) =>
  foreignKey({
    columns: [t.workspaceId, t.caseId, t.taxSubjectId],
    foreignColumns: [
      financeTaxCases.workspaceId,
      financeTaxCases.id,
      financeTaxCases.taxSubjectId,
    ],
  });
export const financeTaxCaseGrants = schema.table(
  'finance_tax_case_grants',
  {
    ...scope(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id),
    role: text('role').notNull(),
    revision: integer('revision').notNull().default(1),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.caseId, t.userId] }),
    caseKey(t),
    check(
      'tax_case_grant_role',
      sql`${t.role} in ('owner','preparer','reviewer','viewer') and ${t.revision}>0`,
    ),
  ],
);
export const financeTaxCaseSnapshots = schema.table(
  'finance_tax_case_snapshots',
  {
    ...scope(),
    revision: integer('revision').notNull(),
    questionnaire: jsonb('questionnaire').notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    previousSnapshotHash: text('previous_snapshot_hash'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => authUsers.id),
    createdAt: time(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.caseId, t.revision] }),
    caseKey(t),
    check(
      'tax_snapshot_bounds',
      sql`${t.revision}>0 and ${t.snapshotHash} ~ '^[0-9a-f]{64}$' and (${t.previousSnapshotHash} is null or ${t.previousSnapshotHash} ~ '^[0-9a-f]{64}$') and jsonb_typeof(${t.questionnaire})='object' and octet_length(${t.questionnaire}::text)<=8000000`,
    ),
  ],
);
export const financeTaxBookSources = schema.table(
  'finance_tax_book_sources',
  {
    id: uuid('id').primaryKey(),
    ...scope(),
    bookId: uuid('book_id').notNull(),
    authorizationRevision: integer('authorization_revision')
      .notNull()
      .default(1),
    authorizedBy: uuid('authorized_by')
      .notNull()
      .references(() => authUsers.id),
    bookGrantRevision: integer('book_grant_revision').notNull(),
    snapshotRevision: integer('snapshot_revision').notNull().default(1),
    snapshotHash: text('snapshot_hash').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: time(),
  },
  (t) => [
    unique('tax_book_source_snapshot_version').on(
      t.workspaceId,
      t.caseId,
      t.bookId,
      t.snapshotRevision,
    ),
    caseKey(t),
    foreignKey({
      columns: [t.workspaceId, t.bookId],
      foreignColumns: [financeBooks.workspaceId, financeBooks.id],
    }),
    check(
      'tax_book_source_version',
      sql`${t.authorizationRevision}>0 and ${t.bookGrantRevision}>0 and ${t.snapshotRevision}>0 and ${t.snapshotHash} ~ '^[0-9a-f]{64}$' and octet_length(${t.snapshot}::text)<=8000000`,
    ),
  ],
);
export const financeTaxFactSources = schema.table(
  'finance_tax_fact_sources',
  {
    id: uuid('id').notNull(),
    ...scope(),
    revision: integer('revision').notNull(),
    factKey: text('fact_key').notNull(),
    category: text('category').notNull(),
    value: jsonb('value').notNull(),
    contentHash: text('content_hash').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => authUsers.id),
    createdAt: time(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.caseId, t.id, t.revision] }),
    caseKey(t),
    check(
      'tax_fact_source_bounds',
      sql`${t.revision}>0 and ${t.contentHash} ~ '^[0-9a-f]{64}$' and jsonb_typeof(${t.value})='object' and octet_length(${t.value}::text)<=10000`,
    ),
  ],
);
export const financeTaxReceipts = schema.table(
  'finance_tax_receipts',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id),
    idempotencyKey: text('idempotency_key').notNull(),
    caseId: uuid('case_id').notNull(),
    commandHash: text('command_hash').notNull(),
    response: jsonb('response').notNull(),
    createdAt: time(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId, t.idempotencyKey] }),
    check('tax_receipt_hash', sql`${t.commandHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
