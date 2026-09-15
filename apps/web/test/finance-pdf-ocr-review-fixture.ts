import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  FinanceImageInspectionSchema,
  FinanceImageOcrFactsSchema,
  FinanceReportMappingDefinitionSchema,
  SaveReviewedFinancePdfOcrMappingSchema,
  UploadFinanceBookEvidenceSchema,
  type FinanceStandardizationRun,
} from '@emdo/contracts/browser';
// eslint-disable-next-line no-restricted-imports -- Node-only fixture validates real server materialization; no UI runtime imports this fixture.
import { extractReviewedFinancePdfOcrTable } from '../../../packages/integrations/src/finance-documents/reviewed-pdf-ocr-table.js';
import { normalizeExtractedReport } from '../../../packages/domains/src/finance/report-mappings.js';
import {
  standardizationFixture,
  standardizationBookId,
  standardizationEvidenceId,
  standardizationMappingId,
  standardizationRunId,
} from './finance-standardization-fixture.js';

export const imageReviewIds = {
  book: standardizationBookId,
  evidence: standardizationEvidenceId,
  mapping: standardizationMappingId,
  run: standardizationRunId,
  account: '73000000-0000-4000-8000-000000000011',
  imported: '73000000-0000-4000-8000-000000000012',
};
export const imageReviewBytes = readFileSync(
  resolve(
    process.cwd(),
    basename(process.cwd()) === 'web' ? '../..' : '.',
    'packages/integrations/src/finance-documents/test-fixtures/image-statement.png',
  ),
);
// Synthetic scanned PDF only: the source statement bitmap is embedded on page2.
const native = createRequire(
  new URL('../../../packages/integrations/package.json', import.meta.url),
)('@napi-rs/canvas') as {
  loadImage: (bytes: Uint8Array) => Promise<unknown>;
  createCanvas: (
    width: number,
    height: number,
  ) => {
    getContext: (kind: string) => {
      drawImage: (image: unknown, x: number, y: number) => void;
    };
    toBuffer: (mime: string) => Buffer;
  };
};
async function makePdf() {
  const bitmap = await native.loadImage(imageReviewBytes);
  const canvas = native.createCanvas(1100, 160);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const jpeg = canvas.toBuffer('image/jpeg');
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 550 80] /Resources << >> >>',
    ),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 550 80] /Resources << /XObject << /Scan 5 0 R >> >> /Contents 6 0 R >>',
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 1100 /Height 160 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      Buffer.from('\nendstream'),
    ]),
    Buffer.from(
      '<< /Length 31 >>\nstream\nq 550 0 0 80 0 0 cm /Scan Do Q\nendstream',
    ),
  ];
  const chunks = [Buffer.from('%PDF-1.4\n')],
    offsets = [0];
  let size = chunks[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(size);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      body,
      Buffer.from('\nendobj\n'),
    ]);
    chunks.push(chunk);
    size += chunk.length;
  });
  chunks.push(
    Buffer.from(
      `xref\n0 7\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, '0')} 00000 n `)
        .join(
          '\n',
        )}\ntrailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${size}\n%%EOF`,
    ),
  );
  return Buffer.concat(chunks);
}
export let pdfOcrReviewBytes: Buffer;
const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export const imageReviewCorrection =
  'The original shows 12.50. OCR read the final zero as the letter O.';
export async function pdfOcrReviewFixture() {
  pdfOcrReviewBytes = await makePdf();
  const standardization = standardizationFixture();
  const sourceDigest = hash(imageReviewBytes);
  const wordData: [string, number, number, number, number][] = [
    ['Date', 20, 24, 74, 26],
    ['Description', 290, 24, 200, 26],
    ['Amount', 560, 24, 110, 26],
    ['Currency', 740, 24, 146, 26],
    ['2026-09-01', 20, 83, 184, 28],
    ['Coffee', 290, 83, 113, 28],
    ['12.5O', 560, 83, 94, 28],
    ['CAD', 740, 83, 58, 28],
  ];
  const facts = FinanceImageOcrFactsSchema.parse({
    status: 'extracted',
    qualityStatus: 'uncertain',
    sourceDigest,
    format: 'png',
    width: 1100,
    height: 160,
    coordinateSpace: 'image-pixels-top-left',
    engine: {
      id: 'tesseract',
      version: '5.5.1',
      languages: ['eng'],
      trainedData: [{ language: 'eng', sha256: 'c'.repeat(64) }],
    },
    text: wordData.map(([text]) => text).join(' '),
    words: wordData.map(([text, x, y, width, height], i) => ({
      id: `word-${i + 1}`,
      text,
      page: 1,
      block: 1,
      paragraph: 1,
      line: i < 4 ? 1 : 2,
      word: (i % 4) + 1,
      coordinateSpace: 'image-pixels-top-left',
      confidence: i === 6 ? 0.62 : 0.97,
      confidenceStatus: i === 6 ? 'uncertain' : 'high',
      sourceAnchor: `image-page-1:pixel-box-${x},${y},${width},${height}:word-${i + 1}`,
      box: { x, y, width, height },
    })),
    issues: ['Machine transcription requires visual review.'],
    truncated: false,
    textBasis: 'machine-transcription-requires-review',
  });
  const inspection = FinanceImageInspectionSchema.parse({
    evidenceId: imageReviewIds.evidence,
    standardizationRunId: imageReviewIds.run,
    extractionRevision: 1,
    extractionDigest: hash(JSON.stringify(facts)),
    sourceDigest,
    wordInventoryDigest: hash(JSON.stringify(facts.words)),
    facts,
  });
  const cell = (index: number) => ({
    region: facts.words[index]!.box,
    words: [facts.words[index]!],
    joiner: ' ' as const,
    reviewedText: facts.words[index]!.text,
    correctionReason: null,
    confirmedAgainstOriginal: true as const,
  });
  const definition = FinanceReportMappingDefinitionSchema.parse({
    providerKey: 'Example Bank',
    reportName: 'Account activity',
    reportType: 'bank-transactions',
    layoutVersion: '2026-09',
    headers: ['Date', 'Description', 'Amount'],
    bindings: [
      { field: 'transactionDate', column: 'Date', context: null },
      { field: 'description', column: 'Description', context: null },
      { field: 'amount', column: 'Amount', context: null },
      { field: 'currency', column: null, context: 'currency' },
    ],
    dateFormat: 'yyyy-mm-dd',
    decimalSeparator: '.',
    groupingSeparator: ',',
    quantityUnit: null,
    valuationMultiplier: null,
    identifierScheme: null,
    identifierNamespace: null,
    imageSelection: {
      expectedSourceDigest: sourceDigest,
      standardizationRunId: imageReviewIds.run,
      extractionRevision: 1,
      expectedExtractionDigest: inspection.extractionDigest,
      width: facts.width,
      height: facts.height,
      coordinateSpace: facts.coordinateSpace,
      reviewedWordInventoryDigest: inspection.wordInventoryDigest,
      headerCells: [cell(0), cell(1), cell(2)],
      rows: [{ cells: [cell(4), cell(5), cell(6)] }],
      context: { asOf: null, currency: cell(7) },
      acknowledgeOcrUncertainty: true,
      acknowledgeUnselectedContent: true,
      confirmedHeaderAndContext: true,
    },
  });
  const render = {
    sourceDigest: hash(pdfOcrReviewBytes),
    pageCount: 2,
    pageNumber: 2,
    rotation: 0,
    scale: 2,
    width: 1100,
    height: 160,
    renderedImageDigest: sourceDigest,
    renderer: { id: 'pdfjs-dist', version: '5.4.296' },
  };
  const embedded = {
    status: 'needs-ocr',
    format: 'pdf',
    totalPages: 2,
    issues: [],
    pages: [1, 2].map((page) => ({
      page,
      width: 550,
      height: 80,
      rotation: 0,
      viewportTransform: [1, 0, 0, -1, 0, 80],
      text: '',
      spans: [],
      textStatus: 'no-extractable-text',
    })),
  };
  const inventory = {
    sourceDigest: hash(pdfOcrReviewBytes),
    pageCount: 2,
    complete: false,
    pages: [
      { kind: 'unresolved', pageNumber: 1, reason: 'ocr-unavailable' },
      { kind: 'ocr', pageNumber: 2, result: { render, ocr: facts } },
    ],
  };
  const outerJson = JSON.stringify({
    embedded,
    extractionDigest: hash(JSON.stringify(embedded)),
    inventory,
  });
  const pdfSelection = {
    expectedSourceDigest: hash(pdfOcrReviewBytes),
    standardizationRunId: imageReviewIds.run,
    extractionRevision: 1,
    expectedExtractionDigest: hash(outerJson),
    pageNumber: 2,
    acknowledgeOtherPages: true as const,
    imageSelection: definition.imageSelection!,
  };
  const pdfDefinition = {
    ...definition,
    imageSelection: undefined,
    pdfOcrSelection: pdfSelection,
  };
  const pdfInspection = {
    evidenceId: imageReviewIds.evidence,
    standardizationRunId: imageReviewIds.run,
    extractionRevision: 1,
    sourceDigest: hash(pdfOcrReviewBytes),
    extractionDigest: hash(outerJson),
    inventory,
  };
  const run = standardization.createRun('needs-review', 'pdf');
  run.filename = 'scanned-statement.pdf';
  run.sourceDigest = hash(pdfOcrReviewBytes);
  run.extraction = {
    revision: 1,
    adapterId: 'finance.pdf-ocr',
    adapterVersion: '1',
    sourceDigest: hash(pdfOcrReviewBytes),
    extractionDigest: hash(outerJson),
    status: 'needs-source-review',
    tableCount: 0,
    sheetCount: 0,
    pageCount: 2,
    truncated: false,
    issues: facts.issues,
  };
  run.proposal = {
    mappingId: null,
    mappingVersion: 1,
    definition: pdfDefinition,
    rationale: 'Proposed source regions require human visual review.',
    status: 'candidate',
    unresolvedQuestions: [],
  };
  run.allowedActions = ['review-source'];
  const original = {
    filename: run.filename,
    format: 'pdf' as const,
    sourceBase64: pdfOcrReviewBytes.toString('base64'),
  };
  const state = {
    inspectionStatus: 200,
    originalStatus: 200,
    hasRun: true,
    hasOriginal: true,
    loseSaveResponse: false,
    role: 'administrator',
    deniedSave: false,
  };
  const writes: { path: string; body: unknown; key: string }[] = [];
  const makeMapping = (
    payload: ReturnType<typeof SaveReviewedFinancePdfOcrMappingSchema.parse>,
  ) => {
    const result = extractReviewedFinancePdfOcrTable(
      pdfOcrReviewBytes,
      imageReviewBytes,
      payload.proposal.definition.pdfOcrSelection,
      {
        standardizationRunId: run.id,
        extractionRevision: 1,
        extractionDigest: hash(outerJson),
        factsJson: outerJson,
      },
      {
        documentId: run.evidenceId,
        extractionRevision: 1,
        providerKey: payload.proposal.definition.providerKey,
        reportType: payload.proposal.definition.reportType,
      },
    );
    return {
      id: imageReviewIds.mapping,
      evidence_id: run.evidenceId,
      evidence_format: 'pdf',
      evidence_filename: run.filename,
      providerKey: payload.proposal.definition.providerKey,
      reportName: payload.proposal.definition.reportName,
      version: 1,
      revision: 1,
      status: 'candidate' as 'candidate' | 'approved',
      validationStatus: 'normalized',
      proposed_by_model: null,
      rationale: payload.proposal.rationale,
      unresolved_questions: payload.proposal.unresolvedQuestions,
      definition: payload.proposal.definition,
      example: result.table,
      validation: normalizeExtractedReport(
        payload.proposal.definition,
        result.table,
      ),
    };
  };
  let mapping: ReturnType<typeof makeMapping> | undefined;
  const receipts = new Map<string, unknown>();
  const ok = (json: unknown) => ({ status: 200, json });
  function handle(
    url: string,
    method = 'GET',
    body: unknown = {},
    key = '',
  ): { status: number; json: unknown } {
    const parsed = new URL(url, 'http://localhost'),
      path = parsed.pathname,
      base = `/api/v2/finance/books/${run.bookId}`;
    if (method === 'POST') {
      writes.push({ path, body, key });
      if (state.deniedSave) return { status: 403, json: { code: 'forbidden' } };
      if (path === `${base}/evidence`) {
        const saved = UploadFinanceBookEvidenceSchema.parse(body);
        if (
          !('sourceBase64' in saved) ||
          saved.sourceBase64 !== original.sourceBase64
        )
          throw new Error('Wrong original bytes');
        state.hasOriginal = true;
        return ok({ id: run.evidenceId, sourceDigest });
      }
      if (path === `${base}/standardizations`) {
        if (
          JSON.stringify(body) !==
          JSON.stringify({
            evidenceId: run.evidenceId,
            expectedSourceDigest: sourceDigest,
          })
        )
          throw new Error('Wrong durable source authorization');
        state.hasRun = true;
        return ok(run);
      }
      if (path === `${base}/report-mappings`) {
        const prior = receipts.get(key);
        if (prior) return ok(prior);
        const payload = SaveReviewedFinancePdfOcrMappingSchema.parse(body);
        if (payload.evidenceId !== run.evidenceId)
          throw new Error('Wrong image evidence');
        mapping = makeMapping(payload);
        const result = { id: mapping.id, status: 'candidate' };
        receipts.set(key, result);
        if (state.loseSaveResponse) {
          state.loseSaveResponse = false;
          throw new TypeError('Image candidate response was lost');
        }
        return ok(result);
      }
      if (path === `${base}/standardizations/${run.id}/reviewed-mapping`) {
        const value = body as { expectedRevision: number; mappingId: string };
        if (
          !mapping ||
          value.mappingId !== mapping.id ||
          value.expectedRevision !== run.revision
        )
          return { status: 409, json: {} };
        run.reviewedMapping = {
          mappingId: mapping.id,
          mappingVersion: mapping.version,
          status: mapping.status,
        };
        run.revision++;
        run.allowedActions = ['review-source', 'open-mapping'];
        return ok(run);
      }
      if (path === `${base}/report-mappings/${imageReviewIds.mapping}/review`) {
        const value = body as {
          expectedRevision: number;
          decision: string;
          reason: string;
        };
        if (
          !mapping ||
          !['administrator', 'approver'].includes(state.role) ||
          value.expectedRevision !== mapping.revision ||
          value.decision !== 'approve' ||
          !value.reason ||
          mapping.validation.status !== 'normalized' ||
          mapping.unresolved_questions.length
        )
          throw new Error('Invalid approval boundary');
        mapping.status = 'approved';
        mapping.revision++;
        if (run.reviewedMapping) run.reviewedMapping.status = 'approved';
        return ok({ id: mapping.id });
      }
      if (path === `${base}/report-mappings/${imageReviewIds.mapping}/import`) {
        const value = body as {
          evidenceId: string;
          expectedMappingVersion: number;
          providerKey: string;
          financialAccountId: string;
        };
        if (
          !mapping ||
          mapping.status !== 'approved' ||
          value.evidenceId !== run.evidenceId ||
          value.expectedMappingVersion !== mapping.version ||
          value.providerKey !== mapping.definition.providerKey ||
          value.financialAccountId !== imageReviewIds.account
        )
          throw new Error('Wrong reviewed image import');
        return ok({ id: imageReviewIds.imported, status: 'review' });
      }
      throw new Error(`Unexpected image write ${path}`);
    }
    if (path.endsWith('/pdf-ocr-inspection')) {
      if (
        parsed.searchParams.get('standardizationRunId') !== run.id ||
        parsed.searchParams.get('extractionRevision') !== '1'
      )
        throw new Error('Wrong immutable inspection request');
      return {
        status: state.inspectionStatus,
        json: state.inspectionStatus === 200 ? pdfInspection : {},
      };
    }
    if (path === `${base}/evidence/${run.evidenceId}`)
      return {
        status: state.originalStatus,
        json: state.originalStatus === 200 ? original : {},
      };
    if (path === '/api/v2/finance/books')
      return ok({
        books: [
          {
            id: run.bookId,
            name: 'Operations',
            entityName: 'Example Company',
            country: 'CA',
            functionalCurrency: 'CAD',
            role: state.role,
          },
        ],
      });
    if (path === `${base}/evidence`)
      return ok({
        documents: state.hasOriginal
          ? [
              {
                id: run.evidenceId,
                filename: run.filename,
                format: 'pdf',
                sourceDigest: hash(pdfOcrReviewBytes),
              },
            ]
          : [],
        nextOffset: null,
      });
    if (path === `${base}/standardizations/options`)
      return ok(standardization.options());
    if (path === `${base}/standardizations`)
      return ok({ runs: state.hasRun ? [run] : [], nextOffset: null });
    if (path === `${base}/standardizations/${run.id}`) return ok(run);
    if (path === `${base}/report-mappings`)
      return ok({ mappings: mapping ? [mapping] : [], nextOffset: null });
    if (path === `${base}/report-mappings/${imageReviewIds.mapping}`)
      return mapping ? ok({ mapping, reviews: [] }) : { status: 404, json: {} };
    if (path === `${base}/financial-accounts`)
      return ok({
        accounts: [
          {
            id: imageReviewIds.account,
            name: 'Operating bank',
            currency: 'CAD',
          },
        ],
      });
    if (path === base)
      return ok({
        book: { id: run.bookId, role: state.role, functional_currency: 'CAD' },
        accounts: [],
        trialBalance: [],
        journals: [],
        periods: [],
      });
    return ok({
      trialBalance: [],
      journals: [],
      periods: [],
      imports: [],
      entries: [],
      invoices: [],
      bills: [],
    });
  }
  return {
    inspection,
    definition: pdfDefinition,
    run,
    source: {
      ...run,
      extraction: run.extraction,
    } as FinanceStandardizationRun & {
      extraction: NonNullable<FinanceStandardizationRun['extraction']>;
    },
    original,
    state,
    writes,
    handle,
    getMapping: () => mapping,
  };
}
