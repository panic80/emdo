import { describe, expect, it } from 'vitest';
import type { FinanceTaxIntake } from '@emdo/contracts';
import { usReviewContentHash } from '@emdo/domains/finance';
import { us2025TestFixture } from '../../domains/src/finance/tax/united-states/2025/test-fixtures.js';
import {
  NY_2025_REQUIRED_FACTS,
  runPrivateNewYorkWorkingPapers,
  exportPrivateNewYorkWorkingPapers,
  NY_PRIVATE_PACKAGE_HASH,
  NY_PRIVATE_PACKAGE_VERSION,
  NY_PRIVATE_SCOPE,
} from './finance-tax-ny-adapter.js';

const sha = 'a'.repeat(64);

function fixture(
  nyOverrides: Record<string, string | boolean> = {},
  federalOverrides: Record<string, string | boolean> = {},
) {
  const federal = us2025TestFixture({
    'business.receipts': '40000',
    'identity.city': 'Albany',
    'identity.zip': '12207',
    ...federalOverrides,
  });
  const formDefaults: Record<string, string | boolean> = {
    'penalty.method': 'short-method',
    'penalty.returnFiledOn': 'not-filed',
    'penalty.returnBalancePaidOn': 'unpaid',
    'identity.firstName': 'Alex',
    'identity.middleInitial': 'Q',
    'identity.county': 'Albany',
    'identity.schoolDistrict': 'Albany',
    'identity.schoolDistrictCode': '005',
    'identity.homeSameAsMailing': true,
    'identity.homeStreet': 'none',
    'identity.homeApartment': 'none',
    'identity.homeCity': 'none',
    'identity.homeZip': 'none',
    'identity.nycQuarters': false,
    'identity.yonkersQuarters': false,
    'refund.method': 'check',
    'refund.routing': 'none',
    'refund.account': 'none',
  };
  const ny: FinanceTaxIntake = {
    ...federal,
    scope: { ...NY_PRIVATE_SCOPE },
    facts: NY_2025_REQUIRED_FACTS.map((required) => ({
      key: required.key,
      reviewState: 'reviewed',
      value: {
        type: required.type,
        value:
          nyOverrides[required.key] ??
          formDefaults[required.key] ??
          ('equals' in required
            ? required.equals
            : required.key === 'federalInputHash'
              ? usReviewContentHash(federal)
              : required.key === 'localResidence'
                ? 'outside-NYC-Yonkers'
                : required.key === 'penalty.paymentLedger'
                  ? '[]'
                  : required.key === 'penalty.balancePaidOn'
                    ? 'unpaid'
                    : required.key === 'businessLocation'
                      ? 'outside-MCTD'
                      : required.type === 'boolean'
                        ? false
                        : '0'),
      } as FinanceTaxIntake['facts'][number]['value'],
      source: {
        kind: 'declaration',
        reference: 'independently-reviewed-NY-fixture',
        revision: 1,
        contentHash: sha,
      },
    })),
  };
  return { federal, ny };
}

describe('private New York working-paper adapter', () => {
  it('binds federal and state outputs to the exact scope, revisions, books and rule sources', () => {
    const f = fixture();
    const run = runPrivateNewYorkWorkingPapers(f.federal, f.ny, sha);
    expect(run.status).toBe('review-calculation-produced');
    expect(run.complete).toBe(false);
    expect(run.enabled).toBe(false);
    expect(run.reportable).toBe(false);
    expect(run.jurisdiction).toEqual(NY_PRIVATE_SCOPE);
    expect(run.packageVersion).toBe(NY_PRIVATE_PACKAGE_VERSION);
    expect(run.packageHash).toBe(NY_PRIVATE_PACKAGE_HASH);
    expect(run.inputBinding).toMatchObject({
      workspaceId: f.ny.workspaceId,
      caseId: f.ny.caseId,
      taxSubjectId: f.ny.taxSubjectId,
      federalRevision: 1,
      newYorkRevision: 1,
      snapshotRevision: 1,
      snapshotHash: sha,
      federalSnapshotHash: sha,
      newYorkSnapshotHash: sha,
      sourceBooks: { federal: [], newYork: [] },
    });
    expect(run.ruleSet.sourceHashes.length).toBeGreaterThan(10);
    expect(run.fields.length).toBeGreaterThan(100);
    expect(run.fields.find((field) => field.id === 'IT-201.39')).toMatchObject({
      reportableAmount: '1440',
      sourceId: 'ny-2025-tables',
      reporting: { rounding: 'none-lossless' },
    });
    expect(run.physicalFields.length).toBeGreaterThan(100);
    expect(run.attachmentForms.map((form) => form.formId)).toEqual([
      'IT-215',
      'IT-2105.9',
      'IT-270',
    ]);
    expect(run.releaseBlockers).toContain(
      'new-york-full-return-validation-not-complete',
    );
    expect(exportPrivateNewYorkWorkingPapers(run).content).toContain(
      'state and local filing disabled',
    );
  });

  it('requires an explicit reviewed federal wage evidence dependency', () => {
    const f = fixture({}, { 'w2.box2': '100' });
    const run = runPrivateNewYorkWorkingPapers(f.federal, f.ny, sha);
    expect(run.status).toBe('blocked');
    expect(run.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'federal-working-papers-blocked' }),
      ]),
    );
    expect(() => exportPrivateNewYorkWorkingPapers(run)).toThrow();
  });

  it('blocks missing and unreviewed state facts without constructing guessed state fields', () => {
    const missing = fixture();
    missing.ny.facts = missing.ny.facts.filter(
      (fact) => fact.key !== 'identity.county',
    );
    const missingRun = runPrivateNewYorkWorkingPapers(
      missing.federal,
      missing.ny,
      sha,
    );
    expect(missingRun.status).toBe('blocked');
    expect(missingRun.fields).toEqual([]);

    const unreviewed = fixture();
    unreviewed.ny.facts.find(
      (fact) => fact.key === 'localResidence',
    )!.reviewState = 'unreviewed';
    const unreviewedRun = runPrivateNewYorkWorkingPapers(
      unreviewed.federal,
      unreviewed.ny,
      sha,
    );
    expect(unreviewedRun.status).toBe('blocked');
    expect(unreviewedRun.newYorkResult?.status).toBe('blocked-input');
  });

  it('blocks mismatched subject, revision, book snapshot, jurisdiction and invalid package snapshot hashes', () => {
    const f = fixture();
    const changed = fixture();
    changed.ny.caseId = '00000000-0000-4000-8000-000000000099';
    changed.ny.revision = 2;
    changed.ny.sourceBooks = [
      {
        bookId: '00000000-0000-4000-8000-000000000010',
        snapshotRevision: 1,
        snapshotHash: sha,
      },
    ];
    changed.ny.scope.formVersion = 'IT201-2024';
    const run = runPrivateNewYorkWorkingPapers(
      f.federal,
      changed.ny,
      'not-a-hash',
    );
    expect(run.status).toBe('blocked');
    expect(run.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'federal-new-york-binding-mismatch',
        'federal-new-york-book-snapshot-mismatch',
        'unsupported-new-york-scope',
        'invalid-snapshot-hash',
      ]),
    );
    expect(run.inputBinding.federalRevision).toBe(1);
    expect(run.inputBinding.newYorkRevision).toBe(2);
  });

  it('rejects tampered output and preserves deterministic export bytes', () => {
    const f = fixture();
    const run = runPrivateNewYorkWorkingPapers(f.federal, f.ny, sha);
    const first = exportPrivateNewYorkWorkingPapers(run);
    const second = exportPrivateNewYorkWorkingPapers(run);
    expect(second).toEqual(first);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      exportPrivateNewYorkWorkingPapers({
        ...run,
        fields: run.fields.map((field, index) =>
          index === 0 ? { ...field, reportableAmount: '999' } : field,
        ),
      }),
    ).toThrow('integrity');
  });

  it('keeps a state output incomplete even when all currently implemented fields calculate', () => {
    const f = fixture();
    const run = runPrivateNewYorkWorkingPapers(f.federal, f.ny, {
      snapshotHash: sha,
      federalSnapshotHash: 'b'.repeat(64),
      newYorkSnapshotHash: 'c'.repeat(64),
    });
    expect(run.complete).toBe(false);
    expect(run.finalAmounts).toEqual({ refund: null, balanceOwing: null });
    expect(run.releaseBlockers).toEqual(
      expect.arrayContaining([
        'new-york-full-return-validation-not-complete',
        'new-york-state-and-local-return-not-enabled',
      ]),
    );
    expect(run.inputBinding.federalSnapshotHash).toBe('b'.repeat(64));
    expect(run.inputBinding.newYorkSnapshotHash).toBe('c'.repeat(64));
  });
});
