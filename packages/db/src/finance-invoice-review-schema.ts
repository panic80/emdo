import { sql } from 'drizzle-orm';
import {
  pgSchema,
  uuid,
  integer,
  jsonb,
  timestamp,
  unique,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { financeBookEvidence } from './finance-v2-schema.js';
import { authUsers } from './schema.js';
const schema = pgSchema('emdo');
export const financeInvoiceReviewDrafts = schema.table(
  'finance_invoice_review_drafts',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    bookId: uuid('book_id').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id),
    revision: integer('revision').notNull(),
    draft: jsonb('draft').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('invoice_review_source_user_revision').on(
      t.workspaceId,
      t.bookId,
      t.evidenceId,
      t.userId,
      t.revision,
    ),
    foreignKey({
      name: 'invoice_review_evidence_fk',
      columns: [t.workspaceId, t.bookId, t.evidenceId],
      foreignColumns: [
        financeBookEvidence.workspaceId,
        financeBookEvidence.bookId,
        financeBookEvidence.id,
      ],
    }),
    check(
      'invoice_review_draft_bounds',
      sql`${t.revision}>0 and jsonb_typeof(${t.draft})='object' and octet_length(${t.draft}::text)<=524288`,
    ),
  ],
);
