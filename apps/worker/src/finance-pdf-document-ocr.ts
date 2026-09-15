import { createHash } from 'node:crypto';
import {
  FinancePdfOcrInventorySchema,
  type FinancePdfOcrInventory,
} from '@emdo/contracts';
import {
  extractFinancePdfReport,
  verifyFinancePdfOcrEvidence,
} from '@emdo/integrations/finance-documents';
import { extractFinancePdfPageOcr } from './finance-pdf-page-ocr.js';

/** Candidate-only mixed-document extraction. Persistence must save the embedded
 * extraction alongside its digest before these page references can be reviewed. */
export async function extractFinancePdfDocumentOcr(
  input: {
    bytes: Uint8Array;
    expectedSourceDigest: string;
    signal: AbortSignal;
  },
  dependencies: Parameters<typeof extractFinancePdfPageOcr>[1],
) {
  if (input.bytes.byteLength > 2 * 1024 * 1024)
    return { status: 'unavailable' as const, reason: 'bytes-limit' };
  if (
    createHash('sha256').update(input.bytes).digest('hex') !==
    input.expectedSourceDigest
  )
    throw new Error('finance-pdf-original-digest-mismatch');
  const embedded = await extractFinancePdfReport(input.bytes, {
    signal: input.signal,
    limits: { maxBytes: 2 * 1024 * 1024 },
  });
  if (embedded.status === 'unavailable') return embedded;
  const embeddedJson = JSON.stringify(embedded);
  if (Buffer.byteLength(embeddedJson, 'utf8') > 262144)
    return { status: 'unavailable' as const, reason: 'output-limit' };
  const extractionDigest = createHash('sha256')
    .update(embeddedJson)
    .digest('hex');
  const pages: FinancePdfOcrInventory['pages'] = [];
  for (const page of embedded.pages) {
    if (input.signal.aborted) {
      pages.push({
        kind: 'unresolved',
        pageNumber: page.page,
        reason: 'aborted',
      });
      continue;
    }
    if (page.textStatus === 'text-extracted') {
      pages.push({
        kind: 'embedded-text',
        pageNumber: page.page,
        extractionDigest,
      });
      continue;
    }
    const result = await extractFinancePdfPageOcr(
      {
        ...input,
        pageNumber: page.page,
        expectedPageCount: embedded.totalPages,
      },
      dependencies,
    );
    if (result.status === 'unavailable') {
      pages.push({
        kind: 'unresolved',
        pageNumber: page.page,
        reason: result.reason,
      });
      continue;
    }
    pages.push({ kind: 'ocr', pageNumber: page.page, result: result.result });
    // Reserve space for the complete inventory. Never drop a source page or
    // silently truncate words to fit the proposal input.
    if (
      Buffer.byteLength(JSON.stringify(pages), 'utf8') +
        Buffer.byteLength(embeddedJson, 'utf8') >
      250000
    )
      pages[pages.length - 1] = {
        kind: 'unresolved',
        pageNumber: page.page,
        reason: 'output-limit',
      };
  }
  const inventory = FinancePdfOcrInventorySchema.parse({
    sourceDigest: input.expectedSourceDigest,
    pageCount: embedded.totalPages,
    complete: false,
    pages,
  });
  if (
    Buffer.byteLength(JSON.stringify({ inventory, embedded }), 'utf8') > 262144
  )
    return { status: 'unavailable' as const, reason: 'output-limit' };
  const factsJson = JSON.stringify({ inventory, embedded, extractionDigest });
  if (Buffer.byteLength(factsJson, 'utf8') > 262144)
    return { status: 'unavailable' as const, reason: 'output-limit' };
  const verified = verifyFinancePdfOcrEvidence({
    factsJson,
    expectedExtractionDigest: createHash('sha256')
      .update(factsJson)
      .digest('hex'),
    expectedSourceDigest: input.expectedSourceDigest,
  });
  return { status: 'extracted' as const, ...verified };
}
