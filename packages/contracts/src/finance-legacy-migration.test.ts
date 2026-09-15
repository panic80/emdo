import { describe, expect, it } from 'vitest';

import {
  FinanceLegacyMigrationMappingSchema,
  FinanceLegacyMigrationPlanSchema,
  FinanceLegacyMigrationReviewDecisionSchema,
  FinanceLegacyMigrationReviewSchema,
  FinanceLegacyMigrationInspectInputSchema,
} from './finance-legacy-migration.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = 'a'.repeat(64);
const source = {
  householdId: id(1),
  privateSpaceId: id(2),
  originalOwnerUserId: id(3),
};
const target = {
  workspaceId: source.householdId,
  bookId: id(4),
  ownerUserId: source.originalOwnerUserId,
};

const mapping = {
  source,
  target,
  financialAccounts: [
    { legacyAccountId: 'legacy-account', targetFinancialAccountId: id(10) },
  ],
  categories: [
    { legacyCategoryId: 'legacy-category', targetLedgerAccountId: id(11) },
  ],
  evidence: [
    { legacyEntityId: 'legacy-transaction', targetEvidenceId: id(12) },
  ],
  openings: [],
};

describe('legacy Finance migration contracts', () => {
  it('requires explicit target ownership and rejects duplicate mappings', () => {
    expect(() =>
      FinanceLegacyMigrationMappingSchema.parse({
        ...mapping,
        target: { ...target, ownerUserId: id(99) },
      }),
    ).toThrow(/Target owner/);
    expect(() =>
      FinanceLegacyMigrationMappingSchema.parse({
        ...mapping,
        financialAccounts: [
          ...mapping.financialAccounts,
          mapping.financialAccounts[0],
        ],
      }),
    ).toThrow(/unique/);
  });

  it('reads historical explicit openings without dates but rejects new undated commands', () => {
    const decision = {
      openingDisposition: 'explicit-opening',
      openingLedgerAccountId: id(20),
      openingEvidenceId: id(21),
      reason: 'Historical review',
    };
    const historical = FinanceLegacyMigrationReviewSchema.parse({
      id: id(22),
      migrationId: id(23),
      recordId: id(24),
      revision: 1,
      decision,
      previousState: {},
      reviewedBy: id(3),
      createdAt: '2026-09-14T00:00:00.000Z',
    });
    expect(historical.decision.openingEffectiveOn).toBeNull();
    expect(
      FinanceLegacyMigrationReviewDecisionSchema.safeParse(decision).success,
    ).toBe(false);
    const oldMapping = {
      ...mapping,
      openings: [
        {
          legacyAccountId: 'legacy-account',
          disposition: 'explicit-opening',
          targetLedgerAccountId: id(20),
          targetEvidenceId: id(21),
        },
      ],
    };
    expect(
      FinanceLegacyMigrationMappingSchema.parse(oldMapping).openings[0]
        ?.openingEffectiveOn,
    ).toBeNull();
    expect(
      FinanceLegacyMigrationInspectInputSchema.safeParse({
        mapping: oldMapping,
        idempotencyKey: 'new-undated',
      }).success,
    ).toBe(false);
    expect(
      FinanceLegacyMigrationReviewDecisionSchema.safeParse({
        ...decision,
        openingEffectiveOn: '2026-01-01',
      }).success,
    ).toBe(true);
  });
  it('requires complete explicit opening mappings and keeps queued openings empty', () => {
    expect(() =>
      FinanceLegacyMigrationMappingSchema.parse({
        ...mapping,
        openings: [
          {
            legacyAccountId: 'legacy-account',
            disposition: 'explicit-opening',
            targetLedgerAccountId: null,
            targetEvidenceId: null,
          },
        ],
      }),
    ).toThrow(/explicit opening/);
    expect(() =>
      FinanceLegacyMigrationMappingSchema.parse({
        ...mapping,
        openings: [
          {
            legacyAccountId: 'legacy-account',
            disposition: 'queue',
            targetLedgerAccountId: id(20),
            targetEvidenceId: null,
          },
        ],
      }),
    ).toThrow(/Queued openings/);
  });

  it('does not accept a plan whose counts or readiness disagree with candidates', () => {
    expect(() =>
      FinanceLegacyMigrationPlanSchema.parse({
        schemaVersion: 1,
        calculationVersion: 'finance-legacy-migration.v1',
        mapping,
        sourceSnapshotHash: hash,
        mappingHash: hash,
        status: 'ready',
        candidates: [
          {
            entityType: 'finance.transaction',
            entityId: 'legacy-transaction',
            sourceRevision: 1,
            targetRecordId: id(21),
            targetBatchId: id(22),
            targetRowId: id(23),
            status: 'blocked',
            disposition: 'unresolved',
            normalized: {
              recordType: 'transaction',
              nativeAmount: null,
              currency: null,
              sourceRow: null,
              externalId: null,
              sourceHash: null,
              fingerprint: null,
            },
            classification: {
              targetFinancialAccountId: null,
              targetLedgerAccountId: null,
              targetEvidenceId: null,
            },
            blockers: ['manual-review'],
          },
        ],
        counts: {
          source: 1,
          ready: 1,
          blocked: 0,
          preserved: 0,
          unresolved: 0,
        },
      }),
    ).toThrow(/counts|readiness/);
  });

  it('requires review reasons and validates explicit review openings', () => {
    expect(() =>
      FinanceLegacyMigrationReviewDecisionSchema.parse({}),
    ).toThrow();
    expect(() =>
      FinanceLegacyMigrationReviewDecisionSchema.parse({
        reason: 'approved',
        openingDisposition: 'explicit-opening',
        openingLedgerAccountId: null,
        openingEvidenceId: null,
      }),
    ).toThrow(/explicit opening/);
    expect(
      FinanceLegacyMigrationReviewDecisionSchema.parse({
        reason: 'map transaction after review',
        targetFinancialAccountId: id(10),
        targetLedgerAccountId: id(11),
        targetEvidenceId: id(12),
      }),
    ).toMatchObject({
      openingDisposition: 'queue',
      classificationConfirmed: false,
    });
  });
});
