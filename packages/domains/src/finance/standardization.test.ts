import { describe, it, expect } from 'vitest';
import {
  FINANCE_EXTRACTION_REGISTRY,
  financeStandardizationAdapter,
  standardizationAllowedActions,
} from './standardization.js';
describe('truthful extraction adapter registry and review-only lifecycle', () => {
  it('distinguishes implemented layout extraction, native review, and locally bounded OCR', () => {
    expect(financeStandardizationAdapter('pdf')).toMatchObject({
      availability: 'implemented',
      workflow: 'dynamic-mapping',
      facts: ['page-spans'],
    });
    expect(
      FINANCE_EXTRACTION_REGISTRY.adapters.find(
        (a) => a.id === 'finance.pdf-ocr',
      ),
    ).toMatchObject({
      formats: ['pdf'],
      availability: 'implemented',
      facts: ['page-spans', 'machine-transcription', 'pixel-regions'],
    });
    expect(financeStandardizationAdapter('png')).toMatchObject({
      availability: 'implemented',
      workflow: 'dynamic-mapping',
      facts: ['machine-transcription', 'pixel-regions'],
    });
    expect(
      financeStandardizationAdapter('png')?.limitations.join(' '),
    ).toContain('Requires installed local');
    for (const format of ['ofx', 'qfx', 'ubl', 'cii'])
      expect(financeStandardizationAdapter(format)?.workflow).toBe(
        'native-review',
      );
    expect(
      new Set(FINANCE_EXTRACTION_REGISTRY.adapters.map((a) => a.id)).size,
    ).toBe(FINANCE_EXTRACTION_REGISTRY.adapters.length);
  });
  it('never offers automatic approval/post or retries unknown/revoked outcomes', () => {
    for (const status of [
      'indeterminate',
      'authority-revoked',
      'cancelled',
    ] as const)
      expect(
        standardizationAllowedActions(
          { status, attempt: 1, proposal: null },
          true,
        ),
      ).toEqual([]);
    expect(
      standardizationAllowedActions(
        { status: 'blocked', attempt: 3, proposal: null },
        true,
      ),
    ).toEqual([]);
    expect(
      standardizationAllowedActions(
        { status: 'blocked', attempt: 1, proposal: null },
        false,
      ),
    ).toEqual([]);
    expect(
      standardizationAllowedActions(
        { status: 'blocked', attempt: 1, proposal: null },
        true,
      ),
    ).toEqual(['retry']);
    expect(
      standardizationAllowedActions(
        { status: 'queued', attempt: 0, proposal: null },
        true,
      ),
    ).toEqual(['cancel']);
  });
  it('keeps saved blocked PDF OCR available for explicit source review without model approval', () => {
    const run = {
      status: 'blocked' as const,
      attempt: 3,
      proposal: null,
      format: 'pdf' as const,
      extraction: {
        revision: 1,
        adapterId: 'finance.pdf-ocr',
        adapterVersion: '1',
        sourceDigest: 'a'.repeat(64),
        extractionDigest: 'b'.repeat(64),
        status: 'needs-source-review' as const,
        tableCount: 0,
        sheetCount: 0,
        pageCount: 2,
        truncated: false,
        issues: [],
      },
    };
    expect(standardizationAllowedActions(run, false)).toEqual([
      'review-source',
    ]);
    expect(
      standardizationAllowedActions({ ...run, extraction: null }, true),
    ).toEqual([]);
    expect(
      standardizationAllowedActions({ ...run, format: 'csv' }, true),
    ).toEqual([]);
    expect(
      standardizationAllowedActions(
        { ...run, status: 'authority-revoked' },
        true,
      ),
    ).toEqual([]);
  });
});
