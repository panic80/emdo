import { createHash } from 'node:crypto';
import {
  ExtractedFinanceReportTableSchema,
  FinanceImageOcrFactsSchema,
  ReviewedFinanceImageSelectionSchema,
  type FinanceImageCellProvenanceSchema,
} from '@emdo/contracts';
import type { z } from 'zod';

const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
function fail(reason: string): never {
  throw new Error(`finance-reviewed-image-${reason}`);
}
type Box = { x: number; y: number; width: number; height: number };
const contains = (outer: Box, inner: Box) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;
const overlaps = (a: Box, b: Box) =>
  Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
  Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);

/** Materializes only explicit human-reviewed strings. The caller must load this
 * envelope from immutable storage under current book authority; a self-consistent
 * digest on caller-provided OCR is not an attestation of extraction authority. */
export function extractReviewedFinanceImageTable(
  bytes: Uint8Array,
  selectionInput: unknown,
  saved: {
    standardizationRunId: string;
    extractionRevision: number;
    extractionDigest: string;
    factsJson: string;
  },
  source: Pick<
    z.infer<typeof ExtractedFinanceReportTableSchema>,
    'documentId' | 'extractionRevision' | 'providerKey' | 'reportType'
  >,
) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 2097152)
    fail('source-bytes-limit');
  if (Buffer.byteLength(JSON.stringify(selectionInput) ?? '') > 4 * 1024 * 1024)
    fail('selection-bytes-limit');
  if (Buffer.byteLength(saved.factsJson) > 262144)
    fail('extraction-bytes-limit');
  const selection = ReviewedFinanceImageSelectionSchema.parse(selectionInput);
  const sourceDigest = hash(bytes);
  if (sourceDigest !== selection.expectedSourceDigest)
    fail('source-digest-mismatch');
  if (
    saved.standardizationRunId !== selection.standardizationRunId ||
    saved.extractionRevision !== selection.extractionRevision ||
    saved.extractionDigest !== selection.expectedExtractionDigest ||
    hash(saved.factsJson) !== saved.extractionDigest
  )
    fail('saved-extraction-binding-mismatch');
  const facts = FinanceImageOcrFactsSchema.parse(JSON.parse(saved.factsJson));
  if (facts.sourceDigest !== sourceDigest) fail('extraction-source-mismatch');
  if (
    facts.width !== selection.width ||
    facts.height !== selection.height ||
    facts.coordinateSpace !== selection.coordinateSpace
  )
    fail('image-geometry-mismatch');
  if (
    hash(JSON.stringify(facts.words)) !== selection.reviewedWordInventoryDigest
  )
    fail('word-inventory-mismatch');
  const inventory = new Map(facts.words.map((word) => [word.id, word]));
  const used = new Set<string>();
  const regions: Box[] = [];
  const cellProvenance: z.infer<typeof FinanceImageCellProvenanceSchema>[] = [];
  type Cell = (typeof selection.headerCells)[number];
  const valueOf = (
    cell: Cell,
    role: (typeof cellProvenance)[number]['role'],
    logicalRow: number | null,
    column: number | null,
  ) => {
    if (
      !contains(
        { x: 0, y: 0, width: facts.width, height: facts.height },
        cell.region,
      )
    )
      fail('region-outside-image');
    if (regions.some((other) => overlaps(other, cell.region)))
      fail('selected-regions-overlap');
    regions.push(cell.region);
    const words = cell.words.map((expected) => {
      const actual = inventory.get(expected.id);
      if (!actual || JSON.stringify(expected) !== JSON.stringify(actual))
        fail('word-facts-mismatch');
      if (used.has(actual.id)) fail('word-used-more-than-once');
      if (!contains(cell.region, actual.box))
        fail('word-outside-selected-region');
      used.add(actual.id);
      return actual;
    });
    // A region cannot hide an intersecting OCR word. Reviewer must either select
    // the whole word (and record a correction) or use a disjoint region.
    if (
      facts.words.some(
        (word) =>
          overlaps(cell.region, word.box) &&
          !words.some((selected) => selected.id === word.id),
      )
    )
      fail('region-has-unselected-ocr-word');
    if (!cell.reviewedText.trim()) fail('reviewed-text-missing');
    const sourceAnchor = `image-page-1:pixel-box-${cell.region.x},${cell.region.y},${cell.region.width},${cell.region.height}`;
    cellProvenance.push({
      role,
      logicalRow,
      column,
      sourceAnchor,
      region: cell.region,
      ocrWords: words,
      ocrText: words.map((word) => word.text).join(cell.joiner),
      reviewedText: cell.reviewedText,
      correctionReason: cell.correctionReason,
      textBasis: 'human-reviewed-visual-transcription',
    });
    return { value: cell.reviewedText, sourceAnchor };
  };
  const headers = selection.headerCells.map(
    (cell, index) => valueOf(cell, 'header', 0, index + 1).value,
  );
  if (
    headers.some((header) => header.length > 200) ||
    new Set(headers).size !== headers.length
  )
    fail('headings-ambiguous');
  const rows = selection.rows.map((row, index) => ({
    sourceRow: index + 1,
    cells: row.cells.map(
      (cell, column) => valueOf(cell, 'data', index + 1, column + 1).value,
    ),
  }));
  const context = {
    asOf: selection.context.asOf
      ? valueOf(selection.context.asOf, 'context-asOf', null, null)
      : null,
    currency: selection.context.currency
      ? valueOf(selection.context.currency, 'context-currency', null, null)
      : null,
  };
  const selectionDigest = hash(JSON.stringify(selection));
  const extractionReview = {
    version: 'reviewed-image.v1' as const,
    sourceDigest,
    selectionDigest,
    standardizationRunId: saved.standardizationRunId,
    ocrExtractionRevision: saved.extractionRevision,
    ocrExtractionDigest: saved.extractionDigest,
    coverage: 'selected-regions-only' as const,
    rowNumbering: 'logical-selection-order-not-image-row-numbers' as const,
    textBasis: 'human-reviewed-visual-transcription' as const,
  };
  const table = ExtractedFinanceReportTableSchema.parse({
    ...source,
    tableId: `image-reviewed-${selectionDigest.slice(0, 32)}`,
    page: 1,
    sheet: null,
    headers,
    rows,
    context,
    extractionReview,
    imageCellProvenance: cellProvenance,
  });
  return {
    table,
    cellProvenance,
    reviewFacts: {
      ...extractionReview,
      selection,
      engine: facts.engine,
      sourceIssues: facts.issues,
      unselectedWordInventory: facts.words.filter((word) => !used.has(word.id)),
    },
  };
}
