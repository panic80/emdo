import { z } from 'zod';
import type { DatabaseClient } from './scoped-repository.js';

export const LegacyFinanceActivationReadinessSchema = z.strictObject({
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  targetHash: z.string().regex(/^[a-f0-9]{64}$/u),
  bookId: z.string().uuid(),
  sourceSpaceId: z.string().uuid(),
  sourceOwnerUserId: z.string().uuid(),
});
export async function inspectLegacyFinanceActivation(
  client: DatabaseClient,
  workspaceId: string,
  migrationId: string,
) {
  const result = await client.query(
    'select emdo.legacy_finance_activation_readiness($1,$2) as readiness',
    [workspaceId, migrationId],
  );
  return LegacyFinanceActivationReadinessSchema.parse(
    result.rows[0]?.readiness,
  );
}
/** Not wired to a service. SQL intentionally withholds emdo_app INSERT pending coordinated routing release. */
export async function activateLegacyFinance(
  client: DatabaseClient,
  workspaceId: string,
  migrationId: string,
  expected: z.infer<typeof LegacyFinanceActivationReadinessSchema>,
) {
  const value = LegacyFinanceActivationReadinessSchema.parse(expected);
  const result = await client.query(
    `insert into emdo.finance_legacy_activations(workspace_id,source_space_id,source_owner_user_id,book_id,migration_id,source_hash,target_hash,activated_by) values($1,$2,$3,$4,$5,$6,$7,emdo.current_user_id()) returning activated_at`,
    [
      workspaceId,
      value.sourceSpaceId,
      value.sourceOwnerUserId,
      value.bookId,
      migrationId,
      value.sourceHash,
      value.targetHash,
    ],
  );
  return {
    migrationId,
    activatedAt: new Date(String(result.rows[0]?.activated_at)).toISOString(),
  };
}
