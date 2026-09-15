import { createHash, randomUUID } from 'node:crypto';
import {
  usReviewContentHash,
  type UsReviewedWageArtifact,
} from '@emdo/domains/finance';
import { describe, it, expect } from 'vitest';
import { us2025TestFixture } from '../../domains/src/finance/tax/united-states/2025/test-fixtures.js';
import {
  runPrivateUsWorkingPapers,
  exportPrivateUsWorkingPapers,
} from './finance-tax-us-adapter.js';
import {
  FinanceTaxRunFieldSchema,
  FinanceTaxWageExtractionSchema,
} from '@emdo/contracts';
const sha = 'a'.repeat(64);
describe('private US working-paper adapter', () => {
  it('normalizes reviewed federal forms without claiming state coverage', () => {
    const run = runPrivateUsWorkingPapers(
      us2025TestFixture({ 'business.receipts': '50000' }),
      sha,
    );
    expect(run.fields.length).toBeGreaterThan(100);
    expect(run.fields.find((f) => f.id === 'C.31')?.reportableAmount).toBe(
      '50000',
    );
    expect(run.fields.find((f) => f.id === 'SE.12')?.reportableAmount).toBe(
      '7065',
    );
    expect(run.fields.find((f) => f.id === 'SE.13')?.reportableAmount).toBe(
      '3533',
    );
    expect(run.fields.find((f) => f.id === 'S1.15')?.reportableAmount).toBe(
      '3533',
    );
    expect(run.fields.find((f) => f.id === 'F1040.11a')?.reportableAmount).toBe(
      '46467',
    );
    for (const f of run.fields) FinanceTaxRunFieldSchema.parse(f);
    expect(run.complete).toBe(false);
    expect(run.releaseBlockers).toContain(
      'state-and-local-returns-not-included',
    );
    expect(JSON.stringify(run.fields)).not.toContain('123456789');
    expect(run.status).toBe('review-calculation-produced');
    expect(exportPrivateUsWorkingPapers(run).content).toContain(
      'state and local returns not included',
    );
  });
  it('blocks unreviewed inputs and withholding without originals even when wages are zero', () => {
    const input = us2025TestFixture({ 'w2.box2': '100' }),
      run = runPrivateUsWorkingPapers(input, sha);
    expect(run.status).toBe('blocked');
    expect(
      run.issues.some((i) => i.code === 'required-w2-artifact-missing'),
    ).toBe(true);
    expect(() => exportPrivateUsWorkingPapers(run)).toThrow();
    input.facts[0]!.reviewState = 'unreviewed';
    expect(runPrivateUsWorkingPapers(input, sha).fields).toHaveLength(0);
  });
  it('does not silently omit a saved unreviewed wage extraction when wages are zero', () => {
    const input = us2025TestFixture({ 'business.receipts': '50000' });
    input.facts.push({
      key: 'wageEvidence.documents',
      reviewState: 'unreviewed',
      value: { type: 'text', value: '{"schemaVersion":1,"documents":[]}' },
      source: {
        kind: 'declaration',
        reference: 'declaration:unreviewed-wage-fixture',
        revision: 1,
        contentHash: sha,
      },
    });
    const run = runPrivateUsWorkingPapers(input, sha);
    expect(run.status).toBe('blocked');
    expect(
      run.issues.some(
        (i) => i.code === 'saved-wage-extraction-review-required',
      ),
    ).toBe(true);
    expect(() => exportPrivateUsWorkingPapers(run)).toThrow();
  });
  it('uses entered whole-dollar Schedule SE dependencies at the independent10000 profit boundary', () => {
    const run = runPrivateUsWorkingPapers(
      us2025TestFixture({ 'business.receipts': '10000' }),
      sha,
    );
    const amount = (id: string) =>
      run.fields.find((f) => f.id === id)?.reportableAmount;
    expect([
      amount('SE.10'),
      amount('SE.11'),
      amount('SE.12'),
      amount('SE.13'),
      amount('S1.15'),
      amount('F1040.11a'),
    ]).toEqual(['1145', '268', '1413', '707', '707', '9293']);
  });
  it('preserves corrected originals and exports only terminal effective wage aggregation', () => {
    const input = us2025TestFixture({
      'business.receipts': '10000',
      'w2.box1': '1200',
      'w2.box2': '100',
      'w2.box3': '1200',
      'w2.box5': '1200',
      'w2.box6': '17.4',
    });
    const bytes = new TextEncoder().encode('original W2');
    const base: UsReviewedWageArtifact = {
      artifactId: randomUUID(),
      workspaceId: input.workspaceId,
      caseId: input.caseId,
      taxSubjectId: input.taxSubjectId,
      revision: 1,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      form: 'W-2',
      taxYear: 2025,
      originalArtifactId: null,
      reviewedBy: randomUUID(),
      reviewedAt: '2026-09-14T12:00:00.000Z',
      boxes: {
        box1: '1000',
        box2: '100',
        box3: '1200',
        box5: '1200',
        box6: '17.4',
        box7: '0',
      },
      bytes,
    };
    const correctedBytes = new TextEncoder().encode('W2c correction');
    const correction: UsReviewedWageArtifact = {
      ...base,
      artifactId: randomUUID(),
      form: 'W-2c',
      originalArtifactId: base.artifactId,
      supersedesArtifactId: base.artifactId,
      corrections: [{ box: 'box1', previous: '1000', correct: '1200' }],
      boxes: { ...base.boxes, box1: '1200' },
      bytes: correctedBytes,
      contentHash: createHash('sha256').update(correctedBytes).digest('hex'),
    };
    const wages = {
      reference: 'tax-wage-review:fixture',
      revision: 1,
      artifacts: [base, correction],
    };
    const run = runPrivateUsWorkingPapers(input, sha, wages);
    expect(run.status).toBe('review-calculation-produced');
    expect(run.usReviewBundle.effectiveWageArtifactIds).toEqual([
      correction.artifactId,
    ]);
    expect(run.usReviewBundle.wageManifest.artifacts).toHaveLength(2);
    expect(run.fields.find((f) => f.id === 'F1040.1a')?.reportableAmount).toBe(
      '1200',
    );
    const csv = exportPrivateUsWorkingPapers(run).content;
    expect(csv).toContain('retained history');
    expect(csv).toContain('effective terminal');
    expect(csv).toContain('Correction');
    for (const invalid of [
      { ...correction, supersedesArtifactId: randomUUID() },
      {
        ...correction,
        corrections: [
          { box: 'box1' as const, previous: '999', correct: '1200' },
        ],
      },
      { ...correction, boxes: { ...correction.boxes, box2: '101' } },
      { ...correction, supersedesArtifactId: correction.artifactId },
    ])
      expect(() =>
        runPrivateUsWorkingPapers(input, sha, {
          ...wages,
          artifacts: [base, invalid],
        }),
      ).toThrow();
    expect(() =>
      runPrivateUsWorkingPapers(input, sha, {
        ...wages,
        artifacts: [
          base,
          correction,
          { ...correction, artifactId: randomUUID() },
        ],
      }),
    ).toThrow();
  });
  it('keeps v1 decoding stable and bounds explicit v2 correction declarations', () => {
    const boxes = {
      box1: '0',
      box2: '0',
      box3: '0',
      box5: '0',
      box6: '0',
      box7: '0',
    };
    const original = {
      bookId: randomUUID(),
      evidenceId: randomUUID(),
      form: 'W-2' as const,
      originalEvidenceId: null,
      boxes,
    };
    const v1 = { schemaVersion: 1, documents: [original] };
    expect(FinanceTaxWageExtractionSchema.parse(v1)).toEqual(v1);
    const corrected = {
      ...original,
      evidenceId: randomUUID(),
      form: 'W-2c',
      originalEvidenceId: original.evidenceId,
      supersedesEvidenceId: original.evidenceId,
      corrections: [],
    };
    expect(
      FinanceTaxWageExtractionSchema.parse({
        schemaVersion: 2,
        documents: [original, corrected],
      }).schemaVersion,
    ).toBe(2);
    expect(
      FinanceTaxWageExtractionSchema.safeParse({
        schemaVersion: 1,
        documents: [corrected],
      }).success,
    ).toBe(false);
    expect(
      FinanceTaxWageExtractionSchema.safeParse({
        schemaVersion: 2,
        documents: [{ ...corrected, corrections: undefined }],
      }).success,
    ).toBe(false);
  });
  it('exports immutable historical adapter1 bodies without injecting new chain sections', () => {
    const current = runPrivateUsWorkingPapers(
      us2025TestFixture({ 'business.receipts': '10000' }),
      sha,
    );
    const { runHash: ignored, ...body } = current;
    void ignored;
    const historicalBody = {
      ...body,
      adapterVersion: '2025-private-federal-output.1',
      packageVersion: '2025.4-federal-working-papers',
      packageHash: 'b'.repeat(64),
    };
    const historical = {
      ...historicalBody,
      runHash: usReviewContentHash(historicalBody),
    };
    const first = exportPrivateUsWorkingPapers(historical);
    expect(first.content).toContain(
      'Package version,2025.4-federal-working-papers\n',
    );
    expect(first.content).toContain(`Package hash,${'b'.repeat(64)}`);
    expect(first.content).not.toContain(
      'Private reviewed wage correction chain',
    );
    expect(exportPrivateUsWorkingPapers(historical)).toEqual(first);
    expect(() =>
      exportPrivateUsWorkingPapers({
        ...historical,
        packageHash: current.packageHash,
      }),
    ).toThrow('integrity');
  });
});
