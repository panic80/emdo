import { z } from 'zod';
import type { DatabaseClient } from './scoped-repository.js';
export const FinanceAccountSourceAssignmentInputSchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  sourceSpaceId: z.string().uuid(),
  compatibilityAccountKind: z.enum([
    'cash',
    'chequing',
    'savings',
    'credit',
    'other',
  ]),
  reason: z.string().trim().min(1).max(1000),
});
export const FinanceAccountSourceAssignmentSchema = z
  .object({
    workspace_id: z.string().uuid(),
    book_id: z.string().uuid(),
    account_id: z.string().uuid(),
    source_space_id: z.string().uuid(),
    source_owner_user_id: z.string().uuid(),
    revision: z.number().int().positive(),
    status: z.enum(['active', 'revoked']),
    compatibility_account_kind: z.enum([
      'cash',
      'chequing',
      'savings',
      'credit',
      'other',
    ]),
    migration_id: z.string().uuid().nullable(),
    legacy_entity_id: z.string().nullable(),
    reason: z.string(),
    changed_by: z.string().uuid(),
    changed_at: z.union([z.date(), z.string()]),
  })
  .transform((row) => ({
    workspaceId: row.workspace_id,
    bookId: row.book_id,
    accountId: row.account_id,
    sourceSpaceId: row.source_space_id,
    sourceOwnerUserId: row.source_owner_user_id,
    revision: row.revision,
    status: row.status,
    compatibilityAccountKind: row.compatibility_account_kind,
    migrationId: row.migration_id,
    legacyEntityId: row.legacy_entity_id,
    reason: row.reason,
    changedBy: row.changed_by,
    changedAt: new Date(row.changed_at).toISOString(),
  }));
export type FinanceAccountAssignmentScope = {
  workspaceId: string;
  bookId: string;
  accountId: string;
};
/** Authenticated transaction required; assignment never manufactures an opening proof. */
export async function upsertLegacyFinanceAccountAssignment(
  client: DatabaseClient,
  scope: FinanceAccountAssignmentScope,
  input: z.input<typeof FinanceAccountSourceAssignmentInputSchema>,
) {
  const value = FinanceAccountSourceAssignmentInputSchema.parse(input);
  const result = await client.query(
    'select emdo.set_legacy_finance_account_assignment($1,$2,$3,$4,$5,$6,$7,false) as assignment',
    [
      scope.workspaceId,
      scope.bookId,
      scope.accountId,
      value.expectedRevision,
      value.sourceSpaceId,
      value.compatibilityAccountKind,
      value.reason,
    ],
  );
  return FinanceAccountSourceAssignmentSchema.parse(result.rows[0]?.assignment);
}
export async function revokeLegacyFinanceAccountAssignment(
  client: DatabaseClient,
  scope: FinanceAccountAssignmentScope,
  input: { expectedRevision: number; reason: string },
) {
  const value = z
    .strictObject({
      expectedRevision: z.number().int().positive(),
      reason: z.string().trim().min(1).max(1000),
    })
    .parse(input);
  const result = await client.query(
    'select emdo.set_legacy_finance_account_assignment($1,$2,$3,$4,null,null,$5,true) as assignment',
    [
      scope.workspaceId,
      scope.bookId,
      scope.accountId,
      value.expectedRevision,
      value.reason,
    ],
  );
  return FinanceAccountSourceAssignmentSchema.parse(result.rows[0]?.assignment);
}
export async function listLegacyFinanceAccountAssignments(
  client: DatabaseClient,
  scope: { workspaceId: string; bookId: string; sourceSpaceId: string },
) {
  const result = await client.query(
    'select * from emdo.finance_account_source_assignments where workspace_id=$1 and book_id=$2 and source_space_id=$3 order by account_id limit 10001',
    [scope.workspaceId, scope.bookId, scope.sourceSpaceId],
  );
  if (result.rows.length > 10000) throw new Error('account-source-list-limit');
  return result.rows.map((row) =>
    FinanceAccountSourceAssignmentSchema.parse(row),
  );
}
/** Only active, current-user private sources already routed to this authorized book. */
export async function listLegacyFinanceAssignmentSources(
  client: DatabaseClient,
  scope: { workspaceId: string; bookId: string },
) {
  const result = await client.query(
    `select source_space_id as "sourceSpaceId",source_owner_user_id as "sourceOwnerUserId",name from emdo.list_legacy_finance_assignment_sources($1,$2)`,
    [scope.workspaceId, scope.bookId],
  );
  if (result.rows.length > 1000)
    throw new Error('account-source-options-limit');
  return z
    .array(
      z.object({
        sourceSpaceId: z.string().uuid(),
        sourceOwnerUserId: z.string().uuid(),
        name: z.string(),
      }),
    )
    .parse(result.rows);
}
