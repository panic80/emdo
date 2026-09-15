import { createHash } from 'node:crypto';
import {
  FinancePdfOcrInventorySchema,
  ReviewedFinancePdfOcrSelectionSchema,
} from '@emdo/contracts';
import { FinancePdfReportExtractionSchema } from './pdf-report-extraction.js';

/** Verifies saved machine facts. Callers separately enforce current book access
 * and bind expected digests to the immutable extraction and original records. */
export function verifyFinancePdfOcrEvidence(input: {
  factsJson: string;
  expectedExtractionDigest: string;
  expectedSourceDigest: string;
}) {
  if (
    Buffer.byteLength(input.factsJson, 'utf8') > 262144 ||
    createHash('sha256').update(input.factsJson).digest('hex') !==
      input.expectedExtractionDigest
  )
    throw new Error('finance-pdf-ocr-extraction-integrity-failed');
  const raw: unknown = JSON.parse(input.factsJson);
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('inventory' in raw) ||
    !('embedded' in raw) ||
    !('extractionDigest' in raw)
  )
    throw new Error('finance-pdf-ocr-facts-invalid');
  const inventory = FinancePdfOcrInventorySchema.parse(raw.inventory);
  const embedded = FinancePdfReportExtractionSchema.parse(raw.embedded);
  if (
    embedded.status === 'unavailable' ||
    inventory.sourceDigest !== input.expectedSourceDigest ||
    embedded.totalPages !== inventory.pageCount ||
    embedded.pages.length !== inventory.pageCount ||
    new Set(embedded.pages.map((page) => page.page)).size !==
      inventory.pageCount
  )
    throw new Error('finance-pdf-ocr-original-binding-mismatch');
  const embeddedDigest = createHash('sha256')
    .update(JSON.stringify(raw.embedded))
    .digest('hex');
  if (raw.extractionDigest !== embeddedDigest)
    throw new Error('finance-pdf-ocr-embedded-digest-mismatch');
  for (const page of inventory.pages) {
    const originalPage = embedded.pages.find(
      (item) => item.page === page.pageNumber,
    );
    if (
      !originalPage ||
      (page.kind === 'embedded-text' &&
        (originalPage.textStatus !== 'text-extracted' ||
          page.extractionDigest !== embeddedDigest)) ||
      (page.kind === 'ocr' && originalPage.textStatus !== 'no-extractable-text')
    )
      throw new Error('finance-pdf-ocr-page-binding-mismatch');
  }
  return { inventory, embedded, extractionDigest: embeddedDigest };
}

/** Resolves a requested page only from the verified stored document. Cell/region
 * materialization still uses the existing reviewed-image validator afterward. */
export function resolveReviewedFinancePdfOcrPage(
  input: Parameters<typeof verifyFinancePdfOcrEvidence>[0] & {
    standardizationRunId: string;
    extractionRevision: number;
  },
  selectionInput: unknown,
) {
  const selection = ReviewedFinancePdfOcrSelectionSchema.parse(selectionInput);
  if (
    selection.expectedSourceDigest !== input.expectedSourceDigest ||
    selection.expectedExtractionDigest !== input.expectedExtractionDigest ||
    selection.standardizationRunId !== input.standardizationRunId ||
    selection.extractionRevision !== input.extractionRevision
  )
    throw new Error('finance-pdf-ocr-review-binding-mismatch');
  const saved = verifyFinancePdfOcrEvidence(input);
  const page = saved.inventory.pages.find(
    (value) => value.pageNumber === selection.pageNumber,
  );
  if (page?.kind !== 'ocr')
    throw new Error('finance-pdf-ocr-review-page-unavailable');
  const rasterFactsJson = JSON.stringify(page.result.ocr);
  const rasterExtractionDigest = createHash('sha256')
    .update(rasterFactsJson)
    .digest('hex');
  const image = selection.imageSelection;
  if (
    image.expectedSourceDigest !== page.result.render.renderedImageDigest ||
    image.expectedExtractionDigest !== rasterExtractionDigest ||
    image.width !== page.result.render.width ||
    image.height !== page.result.render.height ||
    image.reviewedWordInventoryDigest !==
      createHash('sha256')
        .update(JSON.stringify(page.result.ocr.words))
        .digest('hex')
  )
    throw new Error('finance-pdf-ocr-review-raster-mismatch');
  return {
    selection,
    page: page.result,
    rasterFactsJson,
    rasterExtractionDigest,
  };
}
