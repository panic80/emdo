import { describe, expect, it } from 'vitest';
import {
  FinanceTaxReadInputSchema,
  FinanceTaxReadOutputSchema,
} from './finance-tax-read.js';
const caseId = '00000000-0000-4000-8000-000000000001';
describe('private tax read contracts', () => {
  it('requires explicit case scope and rejects book or rule arguments', () => {
    const input = {
      schemaVersion: 1,
      view: 'assess',
      caseId,
      offset: 0,
      limit: 50,
    };
    expect(FinanceTaxReadInputSchema.safeParse(input).success).toBe(true);
    for (const invalid of [
      { ...input, caseId: null },
      { ...input, view: 'list' },
      { ...input, bookId: caseId },
      { ...input, rules: [] },
    ])
      expect(FinanceTaxReadInputSchema.safeParse(invalid).success).toBe(false);
  });
  it('requires an explicit run only for run detail and forbids revision substitution', () => {
    const input = { schemaVersion: 1, view: 'run', caseId, runId: caseId };
    expect(FinanceTaxReadInputSchema.safeParse(input).success).toBe(true);
    for (const invalid of [
      { ...input, runId: null },
      { ...input, caseId: null },
      { ...input, view: 'runs' },
      { ...input, revision: 1 },
    ])
      expect(FinanceTaxReadInputSchema.safeParse(invalid).success).toBe(false);
  });
  it('cannot represent a completed tax return', () => {
    const output = {
      schemaVersion: 1,
      view: 'assess',
      caseId,
      status: 'ready-for-calculation',
      complete: false,
      records: [],
      nextOffset: null,
      sourceReferences: [],
      coverage: 'private-tax-case-snapshot',
      truncated: false,
      snapshotRevision: null,
      snapshotHash: null,
    };
    expect(FinanceTaxReadOutputSchema.safeParse(output).success).toBe(true);
    expect(
      FinanceTaxReadOutputSchema.safeParse({ ...output, complete: true })
        .success,
    ).toBe(false);
    expect(
      FinanceTaxReadOutputSchema.safeParse({ ...output, status: 'complete' })
        .success,
    ).toBe(false);
  });
});
