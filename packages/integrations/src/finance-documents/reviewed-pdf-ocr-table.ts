import { createHash } from 'node:crypto';
import { ExtractedFinanceReportTableSchema } from '@emdo/contracts';
import {
  resolveReviewedFinancePdfOcrPage,
  verifyFinancePdfOcrEvidence,
} from './pdf-ocr-evidence.js';
import { extractReviewedFinanceImageTable } from './reviewed-image-table.js';
const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
/** Caller must load saved facts under current book authority and regenerate the
 * raster using the saved renderer recipe. Digests prove identity, not authority
 * or approval. Only explicitly reviewed cells are materialized. */
export function extractReviewedFinancePdfOcrTable(
  originalPdfBytes: Uint8Array,
  regeneratedRasterBytes: Uint8Array,
  selectionInput: unknown,
  saved: Parameters<typeof extractReviewedFinanceImageTable>[2],
  source: Parameters<typeof extractReviewedFinanceImageTable>[3],
) {
  if (
    !(originalPdfBytes instanceof Uint8Array) ||
    !originalPdfBytes.length ||
    originalPdfBytes.length > 2 * 1024 * 1024
  )
    throw new Error('finance-reviewed-pdf-ocr-source-bytes-limit');
  if (Buffer.byteLength(JSON.stringify(selectionInput) ?? '') > 4 * 1024 * 1024)
    throw new Error('finance-reviewed-pdf-ocr-selection-bytes-limit');
  if (source.extractionRevision !== saved.extractionRevision)
    throw new Error('finance-reviewed-pdf-ocr-source-revision-mismatch');
  const binding = {
    factsJson: saved.factsJson,
    expectedExtractionDigest: saved.extractionDigest,
    expectedSourceDigest: hash(originalPdfBytes),
    standardizationRunId: saved.standardizationRunId,
    extractionRevision: saved.extractionRevision,
  };
  const resolved = resolveReviewedFinancePdfOcrPage(binding, selectionInput);
  const raster = extractReviewedFinanceImageTable(
    regeneratedRasterBytes,
    resolved.selection.imageSelection,
    {
      ...saved,
      factsJson: resolved.rasterFactsJson,
      extractionDigest: resolved.rasterExtractionDigest,
    },
    source,
  );
  const pageNumber = resolved.page.render.pageNumber;
  const originalAnchor = (anchor: string) =>
    anchor.replace(/^image-page-1:/, `pdf-page-${pageNumber}:ocr-raster:`);
  const cellProvenance = raster.cellProvenance.map((rasterCell) => ({
    originalPageNumber: pageNumber,
    sourceAnchor: originalAnchor(rasterCell.sourceAnchor),
    rasterCell,
  }));
  const selectionDigest = hash(JSON.stringify(resolved.selection));
  const extractionReview = {
    version: 'reviewed-pdf-ocr.v1' as const,
    sourceDigest: binding.expectedSourceDigest,
    selectionDigest,
    standardizationRunId: saved.standardizationRunId,
    ocrExtractionRevision: saved.extractionRevision,
    ocrExtractionDigest: saved.extractionDigest,
    render: resolved.page.render,
    coverage: 'selected-page-regions-only' as const,
    rowNumbering: 'logical-selection-order-not-pdf-row-numbers' as const,
    textBasis: 'human-reviewed-visual-transcription' as const,
  };
  const context = Object.fromEntries(
    Object.entries(raster.table.context).map(([key, value]) => [
      key,
      value
        ? { ...value, sourceAnchor: originalAnchor(value.sourceAnchor) }
        : null,
    ]),
  );
  const table = ExtractedFinanceReportTableSchema.parse({
    ...source,
    headers: raster.table.headers,
    rows: raster.table.rows,
    sheet: null,
    tableId: `pdf-ocr-reviewed-${selectionDigest.slice(0, 32)}`,
    page: pageNumber,
    context,
    extractionReview,
    pdfOcrCellProvenance: cellProvenance,
  });
  const inventory = verifyFinancePdfOcrEvidence(binding).inventory;
  return {
    table,
    cellProvenance,
    reviewFacts: {
      ...extractionReview,
      selection: resolved.selection,
      omittedPages: inventory.pages.filter(
        (page) => page.pageNumber !== pageNumber,
      ),
      derivedRasterReview: raster.reviewFacts,
    },
  };
}
