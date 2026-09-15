import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FinanceStandardizationExtractionEnvelopeSchema } from '@emdo/contracts';
import { extractFinancePdfReport } from '@emdo/integrations/finance-documents';
import { extractFinanceStandardizationSource } from './finance-standardization-extraction.js';

vi.mock('@emdo/integrations/finance-documents', async (original) => ({
  ...(await original<typeof import('@emdo/integrations/finance-documents')>()),
  extractFinancePdfReport: vi.fn(),
}));

const digest = (text: string | Uint8Array) =>
  createHash('sha256').update(text).digest('hex');
const envelope = (kind: string, factsJson: string) => ({
  revision: 1,
  adapterId: 'fixture',
  adapterVersion: '1',
  sourceDigest: 'a'.repeat(64),
  extractionDigest: digest(factsJson),
  kind,
  factsJson,
  issues: [],
  complete: false,
  documentInstructions: 'untrusted-source-data',
});

describe('full PDF extraction capacity', () => {
  it('retains all nine synthetic pages, complete text and spans above the former limit', async () => {
    const facts = {
      status: 'extracted',
      totalPages: 9,
      issues: [],
      pages: Array.from({ length: 9 }, (_, page) => ({
        pageNumber: page + 1,
        textStatus: 'embedded-text',
        text: `page ${page + 1} ` + 'synthetic text '.repeat(150),
        spans: Array.from({ length: 250 }, (_, span) => ({
          text: `page ${page + 1} span ${span} synthetic transaction`,
          bbox: [40, span, 500, span + 1],
          fontName: 'Synthetic',
          fontSize: 12,
        })),
      })),
    };
    vi.mocked(extractFinancePdfReport).mockResolvedValue(facts as never);
    const bytes = Buffer.from('synthetic PDF original');
    const result = await extractFinanceStandardizationSource({
      format: 'pdf',
      bytes,
      expectedSourceDigest: digest(bytes),
      revision: 1,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('extracted');
    if (result.status !== 'extracted') throw Error('expected extraction');
    expect(Buffer.byteLength(result.envelope.factsJson)).toBeGreaterThan(
      262144,
    );
    expect(JSON.parse(result.envelope.factsJson)).toEqual(facts);
    expect(result.envelope.extractionDigest).toBe(
      digest(JSON.stringify(facts)),
    );
    expect(result.summary).toMatchObject({ pageCount: 9, truncated: false });
    facts.pages[0]!.text = 'x'.repeat(2097152);
    expect(
      await extractFinanceStandardizationSource({
        format: 'pdf',
        bytes,
        expectedSourceDigest: digest(bytes),
        revision: 1,
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('No truncated sample'),
    });
  });

  it('enforces byte boundaries for PDF and retains every other kind at 256 KiB', () => {
    for (const kind of [
      'csv-table',
      'xlsx-regions',
      'image-ocr',
      'pdf-ocr',
      'pdf-layout',
    ]) {
      const limit = kind === 'pdf-layout' ? 2097152 : 262144;
      const exact = '"' + 'é'.repeat((limit - 2) / 2) + '"';
      expect(Buffer.byteLength(exact)).toBe(limit);
      expect(
        FinanceStandardizationExtractionEnvelopeSchema.safeParse(
          envelope(kind, exact),
        ).success,
      ).toBe(true);
      expect(
        FinanceStandardizationExtractionEnvelopeSchema.safeParse(
          envelope(kind, exact + ' '),
        ).success,
      ).toBe(false);
    }
  });
});
