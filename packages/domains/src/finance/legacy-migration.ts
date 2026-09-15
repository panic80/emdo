import { createHash } from 'node:crypto';

import {
  FinanceLegacyMigrationCandidateSchema,
  FinanceLegacyMigrationComparisonCalculationSchema,
  FinanceLegacyMigrationComparisonInputSchema,
  FinanceLegacyMigrationCutoverDecisionSchema,
  FinanceLegacyMigrationPlanSchema,
  FinanceLegacyMigrationPlanningInputSchema,
  FinanceLegacySourceRecordSchema,
  type FinanceLegacyMigrationCandidate,
  type FinanceLegacyMigrationComparisonCalculation,
  type FinanceLegacyMigrationPlan,
  type FinanceLegacyNormalizedRecordType,
} from '@emdo/contracts';
import { z } from 'zod';

import { formatFinanceDecimal, parseFinanceDecimal } from './decimal.js';
import { FinanceRecordSchema } from './records.js';

const DECIMAL_CAD_MINOR_MULTIPLIER = 10_000_000_000n;

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
};

const digest = (value: unknown): string =>
  createHash('sha256').update(stableJson(value), 'utf8').digest('hex');

const sourceKey = (entityType: string, entityId: string): string =>
  `${entityType}\u0000${entityId}`;

const expectedRecordType = (
  entityType: string,
): FinanceLegacyNormalizedRecordType =>
  entityType.slice('finance.'.length) as FinanceLegacyNormalizedRecordType;

/** Converts a safe legacy CAD integer into an exact two-place decimal string. */
export const legacyCadMinorToDecimal = (minorUnits: number): string => {
  if (!Number.isSafeInteger(minorUnits))
    throw new Error('legacy-cad-minor-out-of-range');
  return formatFinanceDecimal(
    BigInt(minorUnits) * DECIMAL_CAD_MINOR_MULTIPLIER,
  );
};

/** Legacy clients accept CAD safe integers only; never round or relabel currency. */
export const normalizedAmountToLegacyCadMinor = (
  amount: string,
  currency: string,
): number => {
  if (currency !== 'CAD') throw new Error('legacy-currency-unrepresentable');
  const exact = parseFinanceDecimal(amount);
  if (exact % DECIMAL_CAD_MINOR_MULTIPLIER !== 0n)
    throw new Error('legacy-cad-precision-unrepresentable');
  const minor = exact / DECIMAL_CAD_MINOR_MULTIPLIER;
  if (
    minor > BigInt(Number.MAX_SAFE_INTEGER) ||
    minor < BigInt(Number.MIN_SAFE_INTEGER)
  )
    throw new Error('legacy-cad-minor-out-of-range');
  return Number(minor);
};

const sourceSnapshotHash = (
  records: readonly z.input<typeof FinanceLegacySourceRecordSchema>[],
): string =>
  digest(
    records
      .map((record) => ({
        source: record.source,
        entityType: record.entityType,
        entityId: record.entityId,
        legacyRowId: record.legacyRowId,
        revision: record.revision,
        tombstoned: record.tombstoned,
        payloadHash: record.payloadHash,
      }))
      .sort(
        (left, right) =>
          sourceKey(left.entityType, left.entityId).localeCompare(
            sourceKey(right.entityType, right.entityId),
          ) || left.legacyRowId.localeCompare(right.legacyRowId),
      ),
  );

const mappingHash = (mapping: unknown): string => digest(mapping);

const mapBy = <Value>(
  entries: readonly { readonly key: string; readonly value: Value }[],
): ReadonlyMap<string, Value> =>
  new Map(entries.map((entry) => [entry.key, entry.value]));

const candidateTarget = (
  input: z.output<typeof FinanceLegacyMigrationPlanningInputSchema>,
  record: z.output<typeof FinanceLegacySourceRecordSchema>,
): {
  readonly targetRecordId: string;
  readonly targetBatchId: string | null;
  readonly targetRowId: string | null;
} => {
  const stable = input.stableTargetIds.find(
    (candidate) =>
      candidate.entityType === record.entityType &&
      candidate.entityId === record.entityId,
  );
  return {
    targetRecordId: stable?.targetRecordId ?? record.legacyRowId,
    targetBatchId: stable?.targetBatchId ?? null,
    targetRowId: stable?.targetRowId ?? null,
  };
};

const equalScope = (
  left: z.output<typeof FinanceLegacySourceRecordSchema>['source'],
  right: z.output<typeof FinanceLegacySourceRecordSchema>['source'],
): boolean =>
  left.householdId === right.householdId &&
  left.privateSpaceId === right.privateSpaceId &&
  left.originalOwnerUserId === right.originalOwnerUserId;

const normalizedEmpty = (recordType: FinanceLegacyNormalizedRecordType) => ({
  recordType,
  nativeAmount: null as string | null,
  currency: null as 'CAD' | 'USD' | 'MXN' | 'EUR' | 'KRW' | 'JPY' | null,
  sourceRow: null as number | null,
  externalId: null as string | null,
  sourceHash: null as string | null,
  fingerprint: null as string | null,
});

type CandidateClassification = {
  targetFinancialAccountId: string | null;
  targetLedgerAccountId: string | null;
  targetEvidenceId: string | null;
};

const classificationEmpty = (): CandidateClassification => ({
  targetFinancialAccountId: null,
  targetLedgerAccountId: null,
  targetEvidenceId: null,
});

/**
 * Builds a deterministic migration review plan. The planner is deliberately
 * conservative: a source row is ready only when the operator supplied every
 * target mapping needed for its supported normalized representation.
 */
export const planLegacyFinanceMigration = (
  input: unknown,
): FinanceLegacyMigrationPlan => {
  const parsed = FinanceLegacyMigrationPlanningInputSchema.parse(input);
  const accountMappings = mapBy(
    parsed.mapping.financialAccounts.map((entry) => ({
      key: entry.legacyAccountId,
      value: entry.targetFinancialAccountId,
    })),
  );
  const categoryMappings = mapBy(
    parsed.mapping.categories.map((entry) => ({
      key: entry.legacyCategoryId,
      value: entry.targetLedgerAccountId,
    })),
  );
  const evidenceMappings = mapBy(
    parsed.mapping.evidence.map((entry) => ({
      key: entry.legacyEntityId,
      value: entry.targetEvidenceId,
    })),
  );
  const openingMappings = mapBy(
    parsed.mapping.openings.map((entry) => ({
      key: entry.legacyAccountId,
      value: entry,
    })),
  );

  const candidates = parsed.sourceRecords.map((record) => {
    const target = candidateTarget(parsed, record);
    const blockers: string[] = [];
    const classification = classificationEmpty();
    let normalized = normalizedEmpty(expectedRecordType(record.entityType));
    let disposition: 'backfill' | 'preserve-only' | 'unresolved' = 'unresolved';

    // Tombstones remain represented by the migration source record but are not
    // replayed into the active normalized book.
    if (record.tombstoned) {
      return FinanceLegacyMigrationCandidateSchema.parse({
        entityType: record.entityType,
        entityId: record.entityId,
        sourceRevision: record.revision,
        ...target,
        status: 'preserved',
        disposition: 'preserve-only',
        normalized,
        classification,
        blockers: [],
      });
    }

    if (!equalScope(record.source, parsed.mapping.source))
      blockers.push('source-scope-mismatch');

    const parsedRecord = FinanceRecordSchema.safeParse(record.payload);
    const expected = expectedRecordType(record.entityType);
    if (!parsedRecord.success) blockers.push('legacy-payload-invalid');
    else {
      if (parsedRecord.data.recordType !== expected)
        blockers.push('legacy-record-type-mismatch');
      if (parsedRecord.data.id !== record.entityId)
        blockers.push('legacy-entity-id-mismatch');
      if (
        parsedRecord.data.spaceId !== record.source.privateSpaceId ||
        parsedRecord.data.ownerUserId !== record.source.originalOwnerUserId
      )
        blockers.push('legacy-payload-scope-mismatch');
    }

    if (record.entityType === 'finance.account') {
      const targetFinancialAccountId = accountMappings.get(record.entityId);
      classification.targetFinancialAccountId =
        targetFinancialAccountId ?? null;
      if (targetFinancialAccountId === undefined)
        blockers.push('financial-account-mapping-required');
      if (parsedRecord.success && parsedRecord.data.recordType === 'account') {
        const opening = openingMappings.get(record.entityId);
        if (parsedRecord.data.openingBalanceCadMinor !== 0) {
          if (opening === undefined || opening.disposition === 'queue')
            blockers.push('opening-balance-review-required');
          // An explicit reviewed mapping may be backfilled; activation separately
          // requires an immutable, unreversed posted opening proof.
          else if (!opening.openingEffectiveOn)
            blockers.push('opening-posting-review-required');
        }
      }
      // Accounts and categories are mapped to existing normalized targets; no
      // new target account is invented by a migration.
      if (blockers.length === 0) disposition = 'backfill';
    } else if (record.entityType === 'finance.category') {
      const targetLedgerAccountId = categoryMappings.get(record.entityId);
      classification.targetLedgerAccountId = targetLedgerAccountId ?? null;
      if (targetLedgerAccountId === undefined)
        blockers.push('category-mapping-required');
      if (blockers.length === 0) disposition = 'backfill';
    } else if (record.entityType === 'finance.transaction') {
      if (
        parsedRecord.success &&
        parsedRecord.data.recordType === 'transaction'
      ) {
        const targetFinancialAccountId = accountMappings.get(
          parsedRecord.data.accountId,
        );
        classification.targetFinancialAccountId =
          targetFinancialAccountId ?? null;
        if (targetFinancialAccountId === undefined)
          blockers.push('financial-account-mapping-required');

        if (parsedRecord.data.categoryId === null)
          blockers.push('classification-mapping-required');
        else {
          const targetLedgerAccountId = categoryMappings.get(
            parsedRecord.data.categoryId,
          );
          classification.targetLedgerAccountId = targetLedgerAccountId ?? null;
          if (targetLedgerAccountId === undefined)
            blockers.push('category-mapping-required');
        }

        const targetEvidenceId = evidenceMappings.get(record.entityId);
        classification.targetEvidenceId = targetEvidenceId ?? null;
        if (targetEvidenceId === undefined)
          blockers.push('evidence-mapping-required');
        if (target.targetBatchId === null || target.targetRowId === null)
          blockers.push('stable-target-id-missing');
        if (parsedRecord.data.reversal !== null)
          blockers.push('reversal-history-review-required');
        if (parsedRecord.data.effectiveAmountCadMinor === 0)
          blockers.push('zero-amount-review-required');

        const provenance = record.provenance;
        if (provenance?.kind === 'import') {
          normalized = {
            recordType: expected,
            nativeAmount: legacyCadMinorToDecimal(
              parsedRecord.data.effectiveAmountCadMinor,
            ),
            currency: 'CAD',
            sourceRow: provenance.sourceRow,
            externalId: provenance.externalId,
            sourceHash: provenance.sourceHash,
            fingerprint: provenance.fingerprint,
          };
        } else if (provenance?.kind === 'manual') {
          normalized = {
            recordType: expected,
            nativeAmount: legacyCadMinorToDecimal(
              parsedRecord.data.effectiveAmountCadMinor,
            ),
            currency: 'CAD',
            sourceRow: null,
            externalId: null,
            sourceHash: null,
            fingerprint: null,
          };
        } else blockers.push('legacy-source-provenance-missing');
      }
      if (blockers.length === 0) disposition = 'backfill';
    } else {
      blockers.push('unsupported-legacy-record-type');
    }

    return FinanceLegacyMigrationCandidateSchema.parse({
      entityType: record.entityType,
      entityId: record.entityId,
      sourceRevision: record.revision,
      ...target,
      status: blockers.length === 0 ? 'ready' : 'blocked',
      disposition,
      normalized,
      classification,
      blockers,
    });
  });

  const ready = candidates.filter((candidate) => candidate.status === 'ready');
  const blocked = candidates.filter(
    (candidate) => candidate.status === 'blocked',
  );
  const preserved = candidates.filter(
    (candidate) => candidate.status === 'preserved',
  );
  const unresolved = candidates.filter(
    (candidate) => candidate.disposition === 'unresolved',
  );
  return FinanceLegacyMigrationPlanSchema.parse({
    schemaVersion: 1,
    calculationVersion: 'finance-legacy-migration.v1',
    mapping: parsed.mapping,
    sourceSnapshotHash: sourceSnapshotHash(parsed.sourceRecords),
    mappingHash: mappingHash(parsed.mapping),
    status: blocked.length === 0 ? 'ready' : 'blocked',
    candidates,
    counts: {
      source: candidates.length,
      ready: ready.length,
      blocked: blocked.length,
      preserved: preserved.length,
      unresolved: unresolved.length,
    },
  });
};

/**
 * Compares active legacy transaction facts with the rows created by a
 * migration. Comparison is exact in CAD minor units after decimal conversion.
 */
export const compareLegacyFinanceMigration = (
  input: unknown,
): FinanceLegacyMigrationComparisonCalculation => {
  const parsed = FinanceLegacyMigrationComparisonInputSchema.parse(input);
  const activeSources = parsed.sourceRecords.filter(
    (record) =>
      !record.tombstoned && record.entityType === 'finance.transaction',
  );
  const targets = parsed.targetTransactions.filter(
    (transaction) => transaction.status === 'backfilled',
  );
  const sourceById = new Map(
    activeSources.map((record) => [
      sourceKey(record.entityType, record.entityId),
      record,
    ]),
  );
  const targetById = new Map(
    targets.map((record) => [
      sourceKey(record.entityType, record.entityId),
      record,
    ]),
  );
  const mismatches = new Set<string>();
  let sourceCadMinorTotal = 0n;
  let targetCadDecimalTotal = 0n;

  for (const source of activeSources) {
    const legacy = FinanceRecordSchema.safeParse(source.payload);
    if (!legacy.success || legacy.data.recordType !== 'transaction') {
      mismatches.add('legacy-transaction-invalid');
      continue;
    }
    sourceCadMinorTotal += BigInt(legacy.data.effectiveAmountCadMinor);
    const target = targetById.get(
      sourceKey(source.entityType, source.entityId),
    );
    if (target === undefined) {
      mismatches.add('target-transaction-missing');
      continue;
    }
    if (target.currency !== 'CAD' || target.nativeAmount === null) {
      mismatches.add('target-transaction-currency-or-amount-mismatch');
      continue;
    }
    try {
      targetCadDecimalTotal += parseFinanceDecimal(target.nativeAmount);
      if (
        parseFinanceDecimal(target.nativeAmount) !==
        parseFinanceDecimal(
          legacyCadMinorToDecimal(legacy.data.effectiveAmountCadMinor),
        )
      )
        mismatches.add('target-transaction-amount-mismatch');
    } catch {
      mismatches.add('target-transaction-amount-invalid');
    }
  }

  for (const target of targets)
    if (!sourceById.has(sourceKey(target.entityType, target.entityId)))
      mismatches.add('target-transaction-extra');

  const unresolvedCount = parsed.candidates.filter(
    (candidate) => candidate.disposition === 'unresolved',
  ).length;
  if (unresolvedCount > 0) mismatches.add('unresolved-records');
  if (activeSources.length !== targets.length)
    mismatches.add('transaction-count-mismatch');

  const sourceSnapshot = sourceSnapshotHash(parsed.sourceRecords);
  const targetSnapshot = digest(
    targets
      .map((target) => ({
        entityType: target.entityType,
        entityId: target.entityId,
        targetRowId: target.targetRowId,
        status: target.status,
        nativeAmount: target.nativeAmount,
        currency: target.currency,
      }))
      .sort((left, right) => left.entityId.localeCompare(right.entityId)),
  );
  return FinanceLegacyMigrationComparisonCalculationSchema.parse({
    sourceSnapshotHash: sourceSnapshot,
    targetSnapshotHash: targetSnapshot,
    status: mismatches.size === 0 ? 'passed' : 'failed',
    sourceTransactionCount: activeSources.length,
    targetTransactionCount: targets.length,
    sourceCadMinorTotal: sourceCadMinorTotal.toString(),
    targetCadDecimalTotal: formatFinanceDecimal(targetCadDecimalTotal),
    unresolvedCount,
    mismatches: [...mismatches].sort(),
  });
};

export const evaluateLegacyFinanceCutover = (input: unknown) => {
  const parsed = z
    .strictObject({
      plan: FinanceLegacyMigrationPlanSchema,
      comparison: FinanceLegacyMigrationComparisonCalculationSchema,
    })
    .parse(input);
  const blockers = new Set<string>();
  if (parsed.plan.status !== 'ready') blockers.add('migration-plan-not-ready');
  if (parsed.comparison.status !== 'passed')
    blockers.add('comparison-not-passed');
  if (parsed.comparison.unresolvedCount !== 0)
    blockers.add('unresolved-records');
  if (
    parsed.plan.candidates.some((candidate) => candidate.status === 'blocked')
  )
    blockers.add('blocked-records');
  return FinanceLegacyMigrationCutoverDecisionSchema.parse({
    ready: blockers.size === 0,
    blockers: [...blockers].sort(),
  });
};

export type LegacyFinanceMigrationPlan = FinanceLegacyMigrationPlan;
export type LegacyFinanceMigrationCandidate = FinanceLegacyMigrationCandidate;
