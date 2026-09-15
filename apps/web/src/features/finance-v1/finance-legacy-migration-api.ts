import { z } from 'zod';
import {
  FinanceLegacyMigrationInspectInputSchema,
  FinanceLegacyMigrationInspectionSchema,
  FinanceLegacyMigrationRunSchema,
  FinanceLegacyMigrationReviewInputSchema,
  FinanceLegacyMigrationReviewSchema,
  FinanceLegacyMigrationPlanSchema,
  FinanceLegacyMigrationRecordSchema,
  FinanceLegacyMigrationBackfillInputSchema,
  FinanceLegacyMigrationBackfillResultSchema,
  FinanceLegacyMigrationCompareInputSchema,
  FinanceLegacyMigrationComparisonSchema,
  FinanceLegacyMigrationCutoverInputSchema,
  FinanceLegacyMigrationCutoverSchema,
  FinanceLegacyOpeningPostRequestSchema,
  FinanceOpeningProofSchema,
  FinanceLegacySourceScopeSchema,
  type FinanceLegacyMigrationMapping,
} from '@emdo/contracts/browser';
export type MigrationInspection = z.output<
  typeof FinanceLegacyMigrationInspectionSchema
>;
export const MigrationSources = z.strictObject({
  sources: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        source: FinanceLegacySourceScopeSchema,
      }),
    )
    .max(1000),
});
const Accounts = z.object({
  accounts: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        active: z.boolean(),
        currency: z.string(),
      }),
    )
    .max(10000),
});
export const MigrationEvidence = z.object({
  documents: z
    .array(
      z.object({
        id: z.uuid(),
        filename: z.string(),
        sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(100),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export class MigrationRequestError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 403
        ? 'Your current private source or book access does not permit this action.'
        : status === 409
          ? 'The migration changed or has unresolved review items. Refresh it before continuing.'
          : status === 503
            ? 'Migration is not enabled or ready in this environment.'
            : 'The migration request failed. Review the inputs and retry.',
    );
  }
}
async function json(
  bookId: string,
  path: string,
  signal: AbortSignal,
  init: RequestInit = {},
) {
  const response = await fetch(
    `/api/v2/finance/books/${encodeURIComponent(bookId)}/${path}`,
    { credentials: 'same-origin', cache: 'no-store', ...init, signal },
  );
  if (!response.ok) throw new MigrationRequestError(response.status);
  return response.json() as Promise<unknown>;
}
const checkMapping = (
  mapping: FinanceLegacyMigrationMapping,
  bookId: string,
) => {
  if (
    mapping.target.bookId !== bookId ||
    mapping.target.workspaceId !== mapping.source.householdId ||
    mapping.target.ownerUserId !== mapping.source.originalOwnerUserId
  )
    throw new Error('Migration scope could not be verified.');
};
export function checkInspection(
  raw: unknown,
  bookId: string,
  migrationId?: string,
) {
  const value = FinanceLegacyMigrationInspectionSchema.parse(raw);
  checkMapping(value.run.mapping, bookId);
  checkMapping(value.plan.mapping, bookId);
  if (
    (migrationId && value.run.id !== migrationId) ||
    value.records.some(
      (record) =>
        record.migrationId !== value.run.id ||
        record.bookId !== bookId ||
        record.workspaceId !== value.run.mapping.target.workspaceId ||
        record.source.originalOwnerUserId !==
          value.run.mapping.source.originalOwnerUserId ||
        record.source.privateSpaceId !==
          value.run.mapping.source.privateSpaceId,
    )
  )
    throw new Error('Migration records could not be verified.');
  return value;
}
export async function readMigrationSources(
  bookId: string,
  signal: AbortSignal,
) {
  return MigrationSources.parse(
    await json(bookId, 'legacy-migrations/sources', signal),
  );
}
export async function readMigrationAccounts(
  bookId: string,
  signal: AbortSignal,
) {
  return Accounts.parse(await json(bookId, 'financial-accounts', signal));
}
export async function readMigrations(bookId: string, signal: AbortSignal) {
  const value = z
    .strictObject({ runs: z.array(FinanceLegacyMigrationRunSchema).max(1000) })
    .parse(await json(bookId, 'legacy-migrations', signal));
  value.runs.forEach((run) => checkMapping(run.mapping, bookId));
  return value;
}
export async function readMigration(
  bookId: string,
  migrationId: string,
  signal: AbortSignal,
) {
  return checkInspection(
    await json(
      bookId,
      `legacy-migrations/${encodeURIComponent(migrationId)}`,
      signal,
    ),
    bookId,
    migrationId,
  );
}
export async function readMigrationEvidence(
  bookId: string,
  offset: number,
  signal: AbortSignal,
) {
  const value = MigrationEvidence.parse(
    await json(bookId, `evidence?offset=${offset}`, signal),
  );
  if (value.nextOffset !== null && value.nextOffset <= offset)
    throw new Error('Evidence pagination could not be verified.');
  return value;
}
export type MigrationOperation =
  'inspect' | 'review' | 'backfill' | 'compare' | 'approve-cutover' | 'opening';
const ReviewResult = z.strictObject({
  run: FinanceLegacyMigrationRunSchema,
  plan: FinanceLegacyMigrationPlanSchema,
  records: z.array(FinanceLegacyMigrationRecordSchema).max(100000),
  review: FinanceLegacyMigrationReviewSchema,
});
/** Keep the exact key for ambiguous retries of the same command, including lost responses. */
export function migrationMutation() {
  let pending: { signature: string; key: string } | undefined;
  return async (
    bookId: string,
    operation: MigrationOperation,
    input: Record<string, unknown>,
    csrf: string | undefined,
    signal: AbortSignal,
    migrationId?: string,
    recordId?: string,
  ) => {
    if (!csrf) throw new Error('Sign in again before saving.');
    const signature = JSON.stringify({
      bookId,
      operation,
      input,
      migrationId,
      recordId,
    });
    if (pending?.signature !== signature)
      pending = { signature, key: crypto.randomUUID() };
    const withKey = { ...input, idempotencyKey: pending.key };
    const body =
      operation === 'inspect'
        ? FinanceLegacyMigrationInspectInputSchema.parse(withKey)
        : operation === 'review'
          ? FinanceLegacyMigrationReviewInputSchema.parse(input)
          : operation === 'backfill'
            ? FinanceLegacyMigrationBackfillInputSchema.parse(withKey)
            : operation === 'compare'
              ? FinanceLegacyMigrationCompareInputSchema.parse(input)
              : operation === 'approve-cutover'
                ? FinanceLegacyMigrationCutoverInputSchema.parse(withKey)
                : FinanceLegacyOpeningPostRequestSchema.parse(withKey);
    if (operation !== 'inspect' && !migrationId)
      throw new Error('Select a migration first.');
    if (operation === 'opening' && !recordId)
      throw new Error('Select a reviewed account first.');
    if ('migrationId' in body && body.migrationId !== migrationId)
      throw new Error('Migration identity mismatch.');
    const path =
      operation === 'inspect'
        ? 'legacy-migrations/inspect'
        : operation === 'opening'
          ? `legacy-migrations/${migrationId}/records/${recordId}/opening`
          : `legacy-migrations/${migrationId}/${operation}`;
    const raw = await json(bookId, path, signal, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        'idempotency-key': pending.key,
      },
      body: JSON.stringify(body),
    });
    let result: unknown;
    if (operation === 'inspect') result = checkInspection(raw, bookId);
    else if (operation === 'review') {
      const value = ReviewResult.parse(raw);
      const { review: _review, ...inspection } = value;
      checkInspection(inspection, bookId, migrationId);
      if (
        value.review.recordId !== input.recordId ||
        value.review.migrationId !== migrationId
      )
        throw new Error('Reviewed record identity mismatch.');
      result = value;
    } else if (operation === 'opening') {
      const value = FinanceOpeningProofSchema.parse(raw);
      if (
        value.bookId !== bookId ||
        value.migrationId !== migrationId ||
        value.sourceRecordId !== recordId
      )
        throw new Error('Opening proof identity mismatch.');
      result = value;
    } else if (operation === 'compare') {
      const value = FinanceLegacyMigrationComparisonSchema.parse(raw);
      if (value.migrationId !== migrationId)
        throw new Error('Comparison identity mismatch.');
      result = value;
    } else if (operation === 'backfill') {
      const value = FinanceLegacyMigrationBackfillResultSchema.parse(raw);
      if (value.migrationId !== migrationId)
        throw new Error('Backfill identity mismatch.');
      result = value;
    } else {
      const value = FinanceLegacyMigrationCutoverSchema.parse(raw);
      if (
        value.migrationId !== migrationId ||
        value.target.bookId !== bookId ||
        value.comparisonId !== input.comparisonId
      )
        throw new Error('Approval identity mismatch.');
      result = value;
    }
    pending = undefined;
    return result;
  };
}
