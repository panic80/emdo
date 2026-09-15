import {
  validateFinanceRecord,
  normalizedAmountToLegacyCadMinor,
  type FinanceRecord,
} from '@emdo/domains/finance';
import type {
  LegacyFinanceCompatibilityTransaction,
  LegacyFinanceSourceScope,
} from './finance-legacy-activation-projection.js';

/** Produces a read record only; normalized writes always use the book services. */
export function legacyTransactionReadRecord(
  transaction: LegacyFinanceCompatibilityTransaction,
  scope: LegacyFinanceSourceScope,
  bookId: string,
  timestamps: { createdAt: string; updatedAt: string } = transaction,
): FinanceRecord {
  if (
    normalizedAmountToLegacyCadMinor(
      transaction.nativeAmount,
      transaction.currency,
    ) !== transaction.amountCadMinor
  )
    throw new Error('legacy-normalized-amount-mismatch');
  const originalImport =
    transaction.originalFingerprint !== null &&
    transaction.originalSourceHash !== null &&
    transaction.originalSourceRow !== null
      ? {
          fingerprint: transaction.originalFingerprint,
          sourceHash: transaction.originalSourceHash,
          sourceRow: transaction.originalSourceRow,
          externalId: transaction.externalId,
        }
      : undefined;
  const parsed = validateFinanceRecord({
    schemaVersion: 1,
    id: transaction.id,
    spaceId: scope.sourceSpaceId,
    ownerUserId: scope.sourceOwnerUserId,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
    recordType: 'transaction',
    accountId: transaction.legacyAccountId,
    categoryId: transaction.categoryId,
    postedOn: transaction.effectiveOn,
    description: transaction.description,
    currency: 'CAD',
    originalAmountCadMinor: transaction.amountCadMinor,
    effectiveAmountCadMinor: transaction.amountCadMinor,
    adjustments: [],
    reversal: null,
    appliedOperationIds: [],
    source: {
      kind: 'normalized-ledger',
      bookId,
      economicTransactionId: transaction.economicTransactionId,
      journalId: transaction.journalId,
      ...(originalImport ? { originalImport } : {}),
    },
  });
  if (parsed.status !== 'accepted')
    throw new Error('legacy-normalized-record-unrepresentable');
  return parsed.record;
}

export function legacyAccountReadRecord(
  account: {
    id: string;
    financialAccountId: string;
    name: string;
    accountKind: string;
    active: boolean;
    currency: 'CAD';
    openingBalanceCadMinor: number;
    createdAt: string;
    updatedAt: string;
  },
  scope: LegacyFinanceSourceScope,
  bookId: string,
): FinanceRecord {
  const parsed = validateFinanceRecord({
    schemaVersion: 1,
    id: account.id,
    spaceId: scope.sourceSpaceId,
    ownerUserId: scope.sourceOwnerUserId,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    recordType: 'account',
    name: account.name,
    accountKind: account.accountKind,
    currency: account.currency,
    openingBalanceCadMinor: account.openingBalanceCadMinor,
    active: account.active,
    source: {
      kind: 'normalized-ledger',
      bookId,
      financialAccountId: account.financialAccountId,
    },
  });
  if (parsed.status !== 'accepted')
    throw new Error('legacy-normalized-account-unrepresentable');
  return parsed.record;
}
