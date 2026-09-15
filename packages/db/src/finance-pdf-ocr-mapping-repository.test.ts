import { PostgresFinanceV2Repository } from './finance-v2-repository.js';
import type { DatabasePool } from './scoped-repository.js';
import { verifyFinancePdfOcrEvidence } from '../../integrations/src/finance-documents/pdf-ocr-evidence.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FinanceImageOcrFactsSchema } from '@emdo/contracts';
import { extractReviewedFinancePdfOcrTable } from '../../integrations/src/finance-documents/reviewed-pdf-ocr-table.js';
const hash = (v: string | Uint8Array) =>
  createHash('sha256').update(v).digest('hex');
const bytes = Buffer.from('original-image-bytes');
const runId = '10000000-0000-4000-8000-000000000001';
const source = {
  documentId: '10000000-0000-4000-8000-000000000002',
  extractionRevision: 1,
  providerKey: 'reviewed',
  reportType: 'bank-transactions' as const,
};
function imageFixture() {
  const word = (id: number, text: string, y: number) => ({
    id: `image-page-1-word-${id}`,
    text,
    page: 1 as const,
    block: 1,
    paragraph: 1,
    line: id,
    word: 1,
    coordinateSpace: 'image-pixels-top-left' as const,
    confidence: 0.61,
    confidenceStatus: 'uncertain' as const,
    sourceAnchor: `word-${id}`,
    box: { x: 10, y, width: 60, height: 10 },
  });
  const facts = FinanceImageOcrFactsSchema.parse({
    status: 'extracted',
    qualityStatus: 'uncertain',
    sourceDigest: hash(bytes),
    format: 'png',
    width: 200,
    height: 200,
    coordinateSpace: 'image-pixels-top-left',
    engine: {
      id: 'tesseract',
      version: '5.5',
      languages: ['eng'],
      trainedData: [{ language: 'eng', sha256: 'a'.repeat(64) }],
    },
    text: 'Amount\n1O.00',
    words: [word(1, 'Amount', 10), word(2, '1O.00', 30)],
    issues: ['OCR requires review'],
    truncated: false,
    textBasis: 'machine-transcription-requires-review',
  });
  const cell = (word: (typeof facts.words)[number]) => ({
    region: word.box,
    words: [word],
    joiner: ' ' as const,
    reviewedText: word.text,
    correctionReason: null as string | null,
    confirmedAgainstOriginal: true as const,
  });
  const factsJson = JSON.stringify(facts);
  const saved = {
    standardizationRunId: runId,
    extractionRevision: 1,
    extractionDigest: hash(factsJson),
    factsJson,
  };
  const selection = {
    expectedSourceDigest: hash(bytes),
    standardizationRunId: runId,
    extractionRevision: 1,
    expectedExtractionDigest: saved.extractionDigest,
    width: 200,
    height: 200,
    coordinateSpace: 'image-pixels-top-left' as const,
    reviewedWordInventoryDigest: hash(JSON.stringify(facts.words)),
    headerCells: [cell(facts.words[0]!)],
    rows: [
      {
        cells: [
          {
            ...cell(facts.words[1]!),
            reviewedText: '10.00',
            correctionReason:
              'The original image has a zero, not a letter O.' as string | null,
          },
        ],
      },
    ],
    context: { asOf: null, currency: null },
    acknowledgeOcrUncertainty: true,
    acknowledgeUnselectedContent: true,
    confirmedHeaderAndContext: true,
  };
  return { facts, saved, selection };
}

const pdfBytes = Buffer.from('%PDF-original-scanned-two-page-document');
function fixture() {
  const image = imageFixture();
  const embedded = {
    status: 'needs-ocr',
    format: 'pdf',
    totalPages: 2,
    issues: [],
    pages: [1, 2].map((page) => ({
      page,
      width: 100,
      height: 100,
      rotation: 0,
      viewportTransform: [1, 0, 0, -1, 0, 100],
      text: '',
      spans: [],
      textStatus: 'no-extractable-text',
    })),
  };
  const render = {
    sourceDigest: hash(pdfBytes),
    pageCount: 2,
    pageNumber: 2,
    rotation: 0,
    scale: 2,
    width: 200,
    height: 200,
    renderedImageDigest: hash(bytes),
    renderer: { id: 'pdfjs-dist', version: 'fixture' },
  };
  const factsJson = JSON.stringify({
    embedded,
    extractionDigest: hash(JSON.stringify(embedded)),
    inventory: {
      sourceDigest: hash(pdfBytes),
      pageCount: 2,
      complete: false,
      pages: [
        { kind: 'unresolved', pageNumber: 1, reason: 'render-failed' },
        { kind: 'ocr', pageNumber: 2, result: { render, ocr: image.facts } },
      ],
    },
  });
  const saved = {
    ...image.saved,
    factsJson,
    extractionDigest: hash(factsJson),
  };
  const selection = {
    expectedSourceDigest: hash(pdfBytes),
    standardizationRunId: runId,
    extractionRevision: 1,
    expectedExtractionDigest: saved.extractionDigest,
    pageNumber: 2,
    acknowledgeOtherPages: true,
    imageSelection: image.selection,
  };
  return { saved, selection };
}

const context = {
  workspaceId: runId,
  userId: runId,
  sessionId: runId,
  requestId: runId,
};
function setup(withRenderer = true) {
  const f = fixture();
  const cell = (text: string, y: number) => ({
    region: { x: 10, y, width: 60, height: 10 },
    words: [],
    joiner: '' as const,
    reviewedText: text,
    correctionReason: 'Read directly from original PDF',
    confirmedAgainstOriginal: true as const,
  });
  const imageSelection = {
    ...f.selection.imageSelection,
    headerCells: [
      ...f.selection.imageSelection.headerCells,
      cell('Date', 50),
      cell('Description', 90),
      cell('Currency', 130),
    ],
    rows: [
      {
        cells: [
          ...f.selection.imageSelection.rows[0]!.cells,
          cell('2026-09-13', 70),
          cell('Source item', 110),
          cell('CAD', 150),
        ],
      },
    ],
  };
  const selection = { ...f.selection, imageSelection };
  const payload = {
    evidenceId: source.documentId,
    proposal: {
      rationale: 'Reviewed source regions',
      unresolvedQuestions: [],
      definition: {
        providerKey: 'reviewed',
        reportName: 'PDF activity',
        reportType: 'bank-transactions',
        layoutVersion: '1',
        headers: ['Amount', 'Date', 'Description', 'Currency'],
        bindings: [
          { field: 'amount', column: 'Amount', context: null },
          { field: 'transactionDate', column: 'Date', context: null },
          { field: 'description', column: 'Description', context: null },
          { field: 'currency', column: 'Currency', context: null },
        ],
        dateFormat: 'yyyy-mm-dd',
        decimalSeparator: '.',
        groupingSeparator: '',
        quantityUnit: null,
        valuationMultiplier: null,
        identifierScheme: null,
        identifierNamespace: null,
        pdfOcrSelection: selection,
      },
    },
  };
  const outer = JSON.parse(f.saved.factsJson);
  const renderer = vi.fn(async () => ({
    status: 'rendered' as const,
    render: outer.inventory.pages[1].result.render,
    png: bytes,
  }));
  let role = 'preparer';
  let receipt: { payload_hash: string; result: unknown } | undefined;
  const query = vi.fn(async (sql: string, args?: unknown[]) => {
    if (sql.includes('lock_active_request_scope'))
      return { rows: [{ authorized: true }] };
    if (sql.includes('lock_finance_book_grant'))
      return { rows: [{ allowed: role !== 'revoked' }] };
    if (sql.includes('select b.*,g.role')) return { rows: [{ role }] };
    if (sql.includes('select payload_hash,result'))
      return { rows: receipt ? [receipt] : [] };
    if (sql.includes('insert into emdo.finance_command_receipts'))
      receipt = {
        payload_hash: args![4] as string,
        result: JSON.parse(args![5] as string),
      };
    if (sql.includes('select * from emdo.finance_book_evidence'))
      return {
        rows: [
          {
            format: 'pdf',
            byte_size: pdfBytes.length,
            plaintext_sha256: hash(pdfBytes),
            encrypted_original: {},
          },
        ],
      };
    if (sql.includes('read_finance_pdf_ocr_extraction'))
      return {
        rows: [
          {
            value: {
              factsJson: f.saved.factsJson,
              sourceDigest: hash(pdfBytes),
              extractionDigest: f.saved.extractionDigest,
            },
          },
        ],
      };
    if (sql.includes('max(version)')) return { rows: [{ version: 1 }] };
    return { rows: [] };
  });
  const pool = {
    connect: async () => ({ query, release: vi.fn() }),
  } as unknown as DatabasePool;
  const repository = new PostgresFinanceV2Repository(pool, {
    evidenceCipher: {
      decrypt: async () => ({ sourceBase64: pdfBytes.toString('base64') }),
      encrypt: async () => ({}),
    },
    pdfOcrEvidenceVerifier: verifyFinancePdfOcrEvidence,
    reviewedPdfOcrExtractor: extractReviewedFinancePdfOcrTable,
    ...(withRenderer ? { pdfOcrPageRenderer: renderer } : {}),
  });
  return {
    repository,
    payload,
    renderer,
    query,
    setRole: (value: string) => {
      role = value;
    },
  };
}
describe('reviewed PDF OCR mapping repository', () => {
  it('regenerates exact saved raster, saves candidate and replays idempotently', async () => {
    const f = setup();
    const result = await f.repository.saveReportMapping(
      context,
      runId,
      'pdf-review',
      f.payload,
    );
    expect(result.status).toBe('candidate');
    expect(f.renderer).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSourceDigest: hash(pdfBytes),
        pageNumber: 2,
        scale: 2,
      }),
    );
    const insert = f.query.mock.calls.find(([sql]) =>
      sql.includes('insert into emdo.finance_report_mapping_versions'),
    )!;
    const example = JSON.parse(insert[1]![11] as string);
    expect(example.extractionReview.version).toBe('reviewed-pdf-ocr.v1');
    expect(example.rows[0].cells).toEqual([
      '10.00',
      '2026-09-13',
      'Source item',
      'CAD',
    ]);
    expect(
      await f.repository.saveReportMapping(
        context,
        runId,
        'pdf-review',
        f.payload,
      ),
    ).toEqual(result);
    expect(f.renderer).toHaveBeenCalledTimes(1);
    f.payload.proposal.rationale = 'Changed';
    await expect(
      f.repository.saveReportMapping(context, runId, 'pdf-review', f.payload),
    ).rejects.toThrow('idempotency');
  });
  it.each(['viewer', 'revoked'])(
    'rejects current %s authority before rendering',
    async (role) => {
      const f = setup();
      f.setRole(role);
      await expect(
        f.repository.saveReportMapping(context, runId, 'pdf-review', f.payload),
      ).rejects.toThrow('forbidden');
      expect(f.renderer).not.toHaveBeenCalled();
    },
  );
  it('fails closed when isolated renderer is unavailable', async () => {
    const f = setup(false);
    await expect(
      f.repository.saveReportMapping(context, runId, 'pdf-review', f.payload),
    ).rejects.toThrow('unavailable');
    expect(
      f.query.mock.calls.some(([sql]) =>
        sql.includes('insert into emdo.finance_report_mapping_versions'),
      ),
    ).toBe(false);
  });
  it('rechecks revoked permission even for an idempotent replay', async () => {
    const f = setup();
    await f.repository.saveReportMapping(
      context,
      runId,
      'pdf-review',
      f.payload,
    );
    f.setRole('revoked');
    await expect(
      f.repository.saveReportMapping(context, runId, 'pdf-review', f.payload),
    ).rejects.toThrow('forbidden');
    expect(f.renderer).toHaveBeenCalledTimes(1);
  });
  it('rejects altered regeneration recipe and bytes', async () => {
    for (const change of ['recipe', 'bytes']) {
      const f = setup();
      const actual = await f.renderer();
      f.renderer.mockResolvedValue(
        change === 'recipe'
          ? { ...actual, render: { ...actual.render, scale: 1 } }
          : { ...actual, png: Buffer.from('substituted') },
      );
      await expect(
        f.repository.saveReportMapping(context, runId, 'pdf-review', f.payload),
      ).rejects.toThrow('raster-mismatch');
    }
  });
  it('rejects caller examples and changed saved selection digest', async () => {
    const f = setup();
    expect(() =>
      f.repository.saveReportMapping(context, runId, 'pdf-review', {
        ...f.payload,
        example: {},
      }),
    ).toThrow();
    f.payload.proposal.definition.pdfOcrSelection.expectedExtractionDigest =
      'f'.repeat(64);
    await expect(
      f.repository.saveReportMapping(context, runId, 'pdf-review', f.payload),
    ).rejects.toThrow('binding');
    expect(f.renderer).not.toHaveBeenCalled();
  });
});
