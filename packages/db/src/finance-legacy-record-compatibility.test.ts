import { expect, it } from 'vitest';
import { validateFinanceRecordCreate } from '@emdo/domains/finance';
import {
  legacyTransactionReadRecord,
  legacyAccountReadRecord,
} from './finance-legacy-record-compatibility.js';
import type { LegacyFinanceCompatibilityTransaction } from './finance-legacy-activation-projection.js';
const id = '11111111-1111-4111-8111-111111111111';
const scope = { workspaceId: id, sourceSpaceId: id, sourceOwnerUserId: id };
const tx: LegacyFinanceCompatibilityTransaction = {
  id: 'normalized:' + id,
  legacyEntityId: null,
  economicTransactionId: id,
  journalId: id,
  financialAccountId: id,
  legacyAccountId: 'old-account',
  categoryId: 'groceries',
  effectiveOn: '2026-09-14',
  description: 'Posted purchase',
  createdAt: '2026-09-14T12:00:00Z',
  updatedAt: '2026-09-14T12:00:00Z',
  nativeAmount: '-42.05',
  currency: 'CAD',
  amountCadMinor: -4205,
  originalFingerprint: null,
  originalSourceHash: null,
  originalSourceRow: null,
  externalId: null,
};
it('creates an explicit normalized read record using persisted amounts and timestamps', () => {
  const record = legacyTransactionReadRecord(tx, scope, id);
  expect(record).toMatchObject({
    id: tx.id,
    createdAt: tx.createdAt,
    effectiveAmountCadMinor: -4205,
    categoryId: 'groceries',
    source: { kind: 'normalized-ledger', bookId: id, journalId: id },
  });
  expect(validateFinanceRecordCreate(record).status).toBe('rejected');
});
it('preserves original import provenance without presenting it as the authoritative ledger', () => {
  const record = legacyTransactionReadRecord(
    {
      ...tx,
      id: 'old-tx',
      legacyEntityId: 'old-tx',
      originalFingerprint: 'a'.repeat(64),
      originalSourceHash: 'b'.repeat(64),
      originalSourceRow: 7,
    },
    scope,
    id,
  );
  expect(record).toMatchObject({
    id: 'old-tx',
    source: {
      kind: 'normalized-ledger',
      originalImport: {
        sourceRow: 7,
        fingerprint: 'a'.repeat(64),
        sourceHash: 'b'.repeat(64),
      },
    },
  });
});
it('rejects inconsistent monetary projections', () => {
  expect(() =>
    legacyTransactionReadRecord({ ...tx, amountCadMinor: -4204 }, scope, id),
  ).toThrow('amount-mismatch');
});

it('preserves inactive normalized accounts as read-only book projections', () => {
  const record = legacyAccountReadRecord(
    {
      id: 'old-account',
      financialAccountId: id,
      name: 'Cash',
      accountKind: 'cash',
      active: false,
      currency: 'CAD',
      openingBalanceCadMinor: 0,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
    },
    scope,
    id,
  );
  expect(record).toMatchObject({
    source: { kind: 'normalized-ledger', financialAccountId: id },
    active: false,
    openingBalanceCadMinor: 0,
  });
  expect(validateFinanceRecordCreate(record).status).toBe('rejected');
});
