import { extractFinancePdfDocumentOcr } from './finance-pdf-document-ocr.js';
import type { FinancePdfPageRenderer } from './finance-pdf-page-ocr.js';
import {
  type FinanceImageOcrWorkerAdapter,
  extractFinanceImageOcrForWorker,
} from './finance-image-ocr.js';
import { createHash } from 'node:crypto';
import {
  FinanceStandardizationExtractionEnvelopeSchema,
  FinanceStandardizationExtractionSchema,
  FinanceImageOcrFactsSchema,
} from '@emdo/contracts';
import {
  extractFinanceCsvTable,
  financeStandardizationAdapter,
} from '@emdo/domains/finance';
import {
  extractFinanceXlsxTables,
  extractFinancePdfReport,
} from '@emdo/integrations/finance-documents';

/** Exact original bytes only. Document text cannot configure execution or grants. */
export async function extractFinanceStandardizationSource(
  input: {
    format: string;
    bytes: Uint8Array;
    expectedSourceDigest: string;
    revision: number;
    signal: AbortSignal;
  },
  dependencies: {
    imageOcr?: FinanceImageOcrWorkerAdapter;
    pdfRenderer?: FinancePdfPageRenderer;
  } = {},
) {
  const sourceDigest = createHash('sha256').update(input.bytes).digest('hex');
  if (sourceDigest !== input.expectedSourceDigest)
    throw new Error('standardization-original-digest-mismatch');
  const adapter = financeStandardizationAdapter(input.format);
  if (
    !adapter ||
    adapter.availability !== 'implemented' ||
    adapter.workflow !== 'dynamic-mapping'
  )
    return {
      status: 'blocked' as const,
      reason:
        adapter?.limitations.join(' ') ??
        'This evidence format has no supported standardization adapter.',
    };
  if (input.bytes.length > adapter.maxBytes)
    return {
      status: 'blocked' as const,
      reason: 'The original exceeds the bounded extraction limit.',
    };
  if (input.signal.aborted) throw new Error('standardization-aborted');
  let facts: unknown,
    kind: 'csv-table' | 'xlsx-regions' | 'pdf-layout' | 'image-ocr' | 'pdf-ocr',
    issues: string[] = [],
    tableCount = 0,
    sheetCount = 0,
    pageCount = 0;
  const complete = false;
  let adapterId = adapter.id;
  if (input.format === 'csv') {
    facts = extractFinanceCsvTable(
      new TextDecoder('utf-8', { fatal: true }).decode(input.bytes),
    );
    kind = 'csv-table';
    tableCount = 1;
    issues = [
      'CSV headings, field meanings, date locale and number separators require explicit review.',
    ];
  } else if (input.format === 'xlsx') {
    const workbook = extractFinanceXlsxTables(input.bytes);
    facts = workbook;
    kind = 'xlsx-regions';
    tableCount = workbook.tables.length;
    sheetCount = workbook.sheets.length;
    issues = [
      ...workbook.issues,
      'Workbook regions, headers, dates and formula caches require source review.',
    ];
  } else if (['png', 'jpeg', 'webp'].includes(input.format)) {
    const imageInput = {
      ...input,
      limits: {
        maxDimension: 8192,
        maxPixels: 16000000,
        maxWords: 5000,
        maxTextCharacters: 65536,
      },
    };
    const image = dependencies.imageOcr
      ? await dependencies.imageOcr.extract(imageInput)
      : await extractFinanceImageOcrForWorker(imageInput);
    if (image.status === 'unavailable' || !image.engine)
      return {
        status: 'blocked' as const,
        reason: `Local image OCR is unavailable: ${image.status === 'unavailable' ? image.reason : 'engine-provenance-missing'}.`,
      };
    facts = FinanceImageOcrFactsSchema.parse({
      status: image.status,
      qualityStatus: image.qualityStatus,
      sourceDigest: image.sourceDigest,
      format: image.format,
      width: image.width,
      height: image.height,
      coordinateSpace: image.coordinateSpace,
      engine: image.engine,
      text: image.text,
      words: image.words,
      issues: image.issues,
      truncated: image.truncated,
      textBasis: image.textBasis,
    });
    kind = 'image-ocr';
    pageCount = 1;
    issues = [
      ...image.issues,
      'Machine text may be wrong or missing. Human original-image review and correction are required; coverage is selected regions only.',
    ];
  } else {
    const pdf = await extractFinancePdfReport(input.bytes, {
      signal: input.signal,
    });
    if (pdf.status === 'unavailable')
      return {
        status: 'blocked' as const,
        reason: `PDF embedded text extraction is unavailable: ${pdf.reason}.`,
      };
    if (
      pdf.status === 'needs-ocr' ||
      pdf.pages.some((page) => page.textStatus === 'no-extractable-text')
    ) {
      if (!dependencies.pdfRenderer || !dependencies.imageOcr)
        return {
          status: 'blocked' as const,
          reason:
            'This PDF contains pages without embedded text. Isolated PDF rendering and image OCR must both be explicitly enabled.',
        };
      const document = await extractFinancePdfDocumentOcr(input, {
        renderer: dependencies.pdfRenderer,
        imageOcr: dependencies.imageOcr,
      });
      if (document.status !== 'extracted')
        return {
          status: 'blocked' as const,
          reason: `Isolated PDF page extraction is unavailable: ${document.reason}.`,
        };
      facts = {
        inventory: document.inventory,
        embedded: document.embedded,
        extractionDigest: document.extractionDigest,
      };
      kind = 'pdf-ocr';
      adapterId = 'finance.pdf-ocr';
      pageCount = document.inventory.pageCount;
      issues = [
        'PDF OCR is machine transcription requiring original-page review and correction; coverage is selected regions only.',
        ...document.inventory.pages.flatMap((page) =>
          page.kind === 'unresolved'
            ? [`Page ${page.pageNumber} remains unresolved: ${page.reason}.`]
            : [],
        ),
      ];
    } else {
      facts = pdf;
      kind = 'pdf-layout';
      pageCount = pdf.totalPages;
      issues = [
        ...pdf.issues,
        'PDF whole-span table selection and omitted content require explicit source review.',
      ];
    }
  }
  const factsJson = JSON.stringify(facts);
  const maxFactsBytes = kind === 'pdf-layout' ? 2097152 : 262144;
  if (Buffer.byteLength(factsJson, 'utf8') > maxFactsBytes)
    return {
      status: 'blocked' as const,
      reason:
        'The full extraction exceeds the bounded proposal input. No truncated sample will be mapped.',
    };
  const extractionDigest = createHash('sha256').update(factsJson).digest('hex');
  const envelope = FinanceStandardizationExtractionEnvelopeSchema.parse({
    revision: input.revision,
    adapterId,
    adapterVersion: adapter.version,
    sourceDigest,
    extractionDigest,
    kind,
    factsJson,
    issues,
    complete,
    documentInstructions: 'untrusted-source-data',
  });
  const summary = FinanceStandardizationExtractionSchema.parse({
    revision: input.revision,
    adapterId,
    adapterVersion: adapter.version,
    sourceDigest,
    extractionDigest,
    status: 'needs-source-review',
    tableCount,
    sheetCount,
    pageCount,
    truncated: false,
    issues,
  });
  return { status: 'extracted' as const, envelope, summary };
}
