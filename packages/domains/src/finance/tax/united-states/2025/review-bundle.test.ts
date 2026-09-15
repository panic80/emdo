import {
  prepareNyIt2Bundle,
  type NyReviewedWageSupplement,
} from './new-york/it2.js';
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  prepareUs2025ReviewBundle,
  usReviewContentHash,
  type UsReviewedWageArtifact,
} from './review-bundle.js';
import { us2025TestFixture } from './test-fixtures.js';
const bytes = new TextEncoder().encode(
  'Synthetic reviewed wage statement; NOT actual taxpayer data.',
);
function fixture() {
  const input = us2025TestFixture({
    'business.receipts': '40000',
    'w2.box1': '20000',
    'w2.box3': '20000',
    'w2.box5': '20000',
    'w2.box2': '5000',
    'w2.box6': '290',
  });
  const artifact: UsReviewedWageArtifact = {
    artifactId: '10000000-0000-4000-8000-000000000001',
    workspaceId: input.workspaceId,
    caseId: input.caseId,
    taxSubjectId: input.taxSubjectId,
    revision: 1,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    form: 'W-2',
    taxYear: 2025,
    originalArtifactId: null,
    reviewedBy: 'synthetic-independent-reviewer',
    reviewedAt: '2026-02-01T00:00:00Z',
    boxes: {
      box1: '20000',
      box2: '5000',
      box3: '20000',
      box5: '20000',
      box6: '290',
      box7: '0',
    },
    bytes,
  };
  const { bytes: artifactBytes, ...metadata } = artifact;
  expect(artifactBytes).toBe(bytes);
  const manifest = {
    reference: 'wage-manifest-1',
    revision: 1,
    artifacts: [metadata],
  };
  for (const fact of input.facts.filter((entry) => entry.key.startsWith('w2.')))
    fact.source = {
      kind: 'evidence',
      reference: manifest.reference,
      revision: 1,
      contentHash: usReviewContentHash(manifest),
    };
  const snapshot = {
    workspaceId: input.workspaceId,
    caseId: input.caseId,
    taxSubjectId: input.taxSubjectId,
    snapshotRevision: input.revision,
    snapshotHash: 'b'.repeat(64),
    intakeHash: usReviewContentHash(input),
    wageManifestReference: manifest.reference,
    wageManifestRevision: 1,
  };
  return { input, artifact, snapshot };
}
describe('US immutable scoped review bundle', () => {
  it('binds full calculated schedules, evidence bytes and independent mixed-return checkpoints', () => {
    const f = fixture();
    const bundle = prepareUs2025ReviewBundle(f.input, f.snapshot, [f.artifact]);
    expect(bundle.attachmentBindingsComplete).toBe(true);
    expect(bundle.complete).toBe(false);
    const fields = Object.fromEntries(
      bundle.generated.flatMap((form) =>
        form.content.fields.map((field) => [
          `${form.formId}.${field.key}`,
          field.value.value,
        ]),
      ),
    );
    // Independent: 40000*.9235*.153=5651.82; deduction2825.91;
    // AGI57174.09; QBI=min(7434.818,41424.09*.2)=7434.818;
    // TI33989.272 -> IRS33950–34000 single tax3839; total9491.
    expect(fields).toMatchObject({
      'SE.12': '5652',
      'F1040.11a': '57174',
      'F8995.15': '7435',
      'F1040.15': '33989',
      'F1040.16': '3839',
      'F1040.24': '9491',
      'F1040.25a': '5000',
    });
    expect(
      bundle.generated.every((form) => form.contentHash.length === 64),
    ).toBe(true);
    expect(
      prepareUs2025ReviewBundle(f.input, f.snapshot, [f.artifact]).bundleHash,
    ).toBe(bundle.bundleHash);
    expect(() => {
      (bundle.generated as unknown[]).push({});
    }).toThrow();
  });
  it('rejects cross-case artifacts, byte changes and stale snapshot input', () => {
    const f = fixture();
    expect(() =>
      prepareUs2025ReviewBundle(f.input, f.snapshot, [
        { ...f.artifact, caseId: '10000000-0000-4000-8000-000000000002' },
      ]),
    ).toThrow('scope');
    expect(() =>
      prepareUs2025ReviewBundle(f.input, f.snapshot, [
        { ...f.artifact, bytes: new Uint8Array([1]) },
      ]),
    ).toThrow('content');
    expect(() =>
      prepareUs2025ReviewBundle(
        f.input,
        { ...f.snapshot, intakeHash: 'c'.repeat(64) },
        [f.artifact],
      ),
    ).toThrow('input');
  });
  it('blocks missing, unbound or mismatched wage evidence instead of declaring export complete', () => {
    const f = fixture();
    expect(
      prepareUs2025ReviewBundle(f.input, f.snapshot, []).blockers,
    ).toContain('required-w2-artifact-missing');
    f.input.facts.find((fact) => fact.key === 'w2.box1')!.source.kind =
      'declaration';
    f.snapshot.intakeHash = usReviewContentHash(f.input);
    expect(
      prepareUs2025ReviewBundle(f.input, f.snapshot, [f.artifact]).blockers,
    ).toContain('w2-box1-source-binding-mismatch');
    expect(
      prepareUs2025ReviewBundle(f.input, f.snapshot, [
        { ...f.artifact, boxes: { ...f.artifact.boxes, box1: '20001' } },
      ]).blockers,
    ).toContain('w2-box1-artifact-total-mismatch');
  });
  it('reconciles a corrected chain once, retaining both original and correction artifacts', () => {
    const f = fixture();
    const corrected: UsReviewedWageArtifact = {
      ...f.artifact,
      artifactId: '10000000-0000-4000-8000-000000000002',
      form: 'W-2c',
      originalArtifactId: f.artifact.artifactId,
      supersedesArtifactId: f.artifact.artifactId,
      corrections: [{ box: 'box1', previous: '20000', correct: '21000' }],
      boxes: { ...f.artifact.boxes, box1: '21000' },
    };
    const documents = [f.artifact, corrected].map(
      ({ bytes: artifactBytes, ...metadata }) => {
        expect(artifactBytes.byteLength).toBeGreaterThan(0);
        return metadata;
      },
    );
    const manifest = {
      reference: f.snapshot.wageManifestReference,
      revision: f.snapshot.wageManifestRevision,
      artifacts: documents,
    };
    for (const fact of f.input.facts.filter((entry) =>
      entry.key.startsWith('w2.'),
    )) {
      fact.source.contentHash = usReviewContentHash(manifest);
      if (fact.key === 'w2.box1')
        fact.value = { type: 'decimal', value: '21000' };
    }
    f.snapshot.intakeHash = usReviewContentHash(f.input);
    const result = prepareUs2025ReviewBundle(f.input, f.snapshot, [
      corrected,
      f.artifact,
    ]);
    expect(result.attachmentBindingsComplete).toBe(true);
    expect(result.wageManifest.artifacts).toHaveLength(2);
    expect(result.effectiveWageArtifactIds).toEqual([corrected.artifactId]);
    expect(() =>
      prepareUs2025ReviewBundle(f.input, f.snapshot, [
        f.artifact,
        {
          ...corrected,
          corrections: [{ box: 'box1', previous: '19999', correct: '21000' }],
        },
      ]),
    ).toThrow('previous-mismatch');
    expect(() =>
      prepareUs2025ReviewBundle(f.input, f.snapshot, [
        f.artifact,
        corrected,
        { ...corrected, artifactId: '10000000-0000-4000-8000-000000000003' },
      ]),
    ).toThrow('branch-ambiguous');
  });
  it('builds source-bound IT2 continuation records without duplicating wages or withholding', () => {
    const f = fixture();
    const supplement: NyReviewedWageSupplement = {
      artifactId: f.artifact.artifactId,
      contentHash: f.artifact.contentHash,
      reviewedBy: 'synthetic-reviewer',
      reviewedAt: '2026-02-01T00:00:00Z',
      employeeSsn: '123456789',
      employerEin: '123456789',
      employer: {
        name: 'Example employer',
        street: '10 Test Street',
        city: 'Albany',
        state: 'NY',
        zip: '12207',
        country: 'US',
      },
      box8: '0',
      box10: '0',
      box11: '0',
      box12: [],
      box14: Array.from({ length: 6 }, (_, index) => ({
        description: `Reviewed item${index + 1}`,
        amount: '1.50',
      })),
      box13: {
        statutoryEmployee: false,
        retirementPlan: false,
        thirdPartySickPay: false,
      },
      newYork: { wages: '20000', withheld: '100.49' },
      otherState: null,
      localities: [],
    };
    const result = prepareNyIt2Bundle(
      f.input,
      f.snapshot,
      [f.artifact],
      [supplement],
    );
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.physicalFields).toHaveLength(99);
    const physical = result.pages[0]!.physicalFields;
    expect(physical.find((field) => field.fieldId === 'LN1_AMT.0')?.value).toBe(
      '20000',
    );
    expect(
      physical.find((field) => field.fieldId === 'LN1_AMT.1')?.status,
    ).toBe('inapplicable');
    expect(
      physical.find((field) => field.fieldId === 'LN14a_AMTNEG.1')?.value,
    ).toBe('2');
    expect(physical.find((field) => field.fieldId === 'TP_SSN.1')?.value).toBe(
      '123456789',
    );
    expect(
      physical.every((field) =>
        ['populated', 'inapplicable'].includes(field.status),
      ),
    ).toBe(true);
    expect(() =>
      prepareNyIt2Bundle(
        f.input,
        f.snapshot,
        [f.artifact],
        [
          {
            ...supplement,
            employer: { ...supplement.employer, city: 'A'.repeat(23) },
          },
        ],
      ),
    ).toThrow();
    expect(() =>
      prepareNyIt2Bundle(
        f.input,
        f.snapshot,
        [f.artifact],
        [
          {
            ...supplement,
            box14: [{ description: 'A'.repeat(21), amount: '1' }],
          },
        ],
      ),
    ).toThrow();

    expect(result.pages[0]!.records).toHaveLength(2);
    expect(result.pages[0]!.records[0]!.box14).toHaveLength(4);
    expect(result.pages[0]!.records[1]!.box14).toHaveLength(2);
    expect(result.pages[0]!.records[1]!.main).toBeNull();
    expect(result.totals.stateWithholding).toBe('100');
    expect(result.pages[0]!.records[0]!.box14[0]!.amount).toBe('2');
    expect(() =>
      prepareNyIt2Bundle(f.input, f.snapshot, [f.artifact], []),
    ).toThrow('missing-or-unselected');
    expect(() =>
      prepareNyIt2Bundle(
        f.input,
        f.snapshot,
        [f.artifact],
        [{ ...supplement, employeeSsn: '999999999' }],
      ),
    ).toThrow('identity');
  });
  it('rejects duplicate artifacts and incomplete corrected chains', () => {
    const f = fixture();
    expect(() =>
      prepareUs2025ReviewBundle(f.input, f.snapshot, [f.artifact, f.artifact]),
    ).toThrow('duplicate');
    expect(() =>
      prepareUs2025ReviewBundle(f.input, f.snapshot, [
        { ...f.artifact, form: 'W-2c' },
      ]),
    ).toThrow('correction-chain');
  });
});
