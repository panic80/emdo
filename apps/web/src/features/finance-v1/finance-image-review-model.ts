import {
  CanonicalReportFieldSchema,
  FinanceImageBoxSchema,
  ReviewedFinanceImageSelectionSchema,
  SaveReviewedFinanceImageMappingSchema,
  type FinanceImageInspectionSchema,
  type FinanceReportMappingDefinition,
  type ReviewedFinanceImageSelection,
} from '@emdo/contracts/browser';
import type { z } from 'zod';

export type ImageInspection = z.infer<typeof FinanceImageInspectionSchema>;
export type ImageWord = ImageInspection['facts']['words'][number];
export type ImageBox = z.infer<typeof FinanceImageBoxSchema>;
export type ImageCell = {
  region: ImageBox | null;
  wordIds: string[];
  joiner: '' | ' ';
  reviewedText: string;
  correctionReason: string;
  confirmed: boolean;
};
export type ImageDraft = {
  headers: ImageCell[];
  rows: ImageCell[][];
  context: { asOf: ImageCell | null; currency: ImageCell | null };
};
export const emptyImageCell = (): ImageCell => ({
  region: null,
  wordIds: [],
  joiner: ' ',
  reviewedText: '',
  correctionReason: '',
  confirmed: false,
});
export function blankImageDraft(columns = 0): ImageDraft {
  return {
    headers: Array.from({ length: columns }, emptyImageCell),
    rows: columns ? [Array.from({ length: columns }, emptyImageCell)] : [],
    context: { asOf: null, currency: null },
  };
}
export function imageCells(draft: ImageDraft) {
  return [
    ...draft.headers.map((cell, i) => ({ key: `h:${i}`, cell })),
    ...draft.rows.flatMap((row, r) =>
      row.map((cell, c) => ({ key: `r:${r}:${c}`, cell })),
    ),
    ...(['asOf', 'currency'] as const).flatMap((field) =>
      draft.context[field]
        ? [{ key: `c:${field}`, cell: draft.context[field]! }]
        : [],
    ),
  ];
}
export function imageTargetLabel(key: string) {
  const [kind, row, column] = key.split(':');
  return kind === 'h'
    ? `Heading ${Number(row) + 1}`
    : kind === 'r'
      ? `Row ${Number(row) + 1}, column ${Number(column) + 1}`
      : row === 'asOf'
        ? 'As-of date context'
        : 'Currency context';
}
export function updateImageCell(
  draft: ImageDraft,
  key: string,
  cell: ImageCell,
): ImageDraft {
  const [kind, row, column] = key.split(':');
  if (kind === 'h')
    return {
      ...draft,
      headers: draft.headers.map((old, i) => (i === Number(row) ? cell : old)),
    };
  if (kind === 'r')
    return {
      ...draft,
      rows: draft.rows.map((old, r) =>
        r === Number(row)
          ? old.map((value, c) => (c === Number(column) ? cell : value))
          : old,
      ),
    };
  return { ...draft, context: { ...draft.context, [row!]: cell } };
}
export const imageBoxesOverlap = (a: ImageBox, b: ImageBox) =>
  Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
  Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
export const imageBoxContains = (a: ImageBox, b: ImageBox) =>
  b.x >= a.x &&
  b.y >= a.y &&
  b.x + b.width <= a.x + a.width &&
  b.y + b.height <= a.y + a.height;
export function imageCellWords(cell: ImageCell, inspection: ImageInspection) {
  const words = new Map(inspection.facts.words.map((word) => [word.id, word]));
  return cell.wordIds.map((id) => {
    const word = words.get(id);
    if (!word)
      throw new Error(
        'A selected word is absent from this saved extraction. Reopen the image review.',
      );
    return word;
  });
}
export function imageRegionCell(
  region: ImageBox,
  inspection: ImageInspection,
): ImageCell {
  FinanceImageBoxSchema.parse(region);
  if (
    !imageBoxContains(
      {
        x: 0,
        y: 0,
        width: inspection.facts.width,
        height: inspection.facts.height,
      },
      region,
    )
  )
    throw new Error('Keep the selected region inside the original image.');
  const words = inspection.facts.words.filter((word) =>
    imageBoxesOverlap(region, word.box),
  );
  if (words.length > 40)
    throw new Error(
      'A cell can contain at most 40 OCR words. Select a smaller region.',
    );
  if (words.some((word) => !imageBoxContains(region, word.box)))
    throw new Error(
      'This region cuts through an OCR word. Include the whole word or use a disjoint region.',
    );
  return {
    region,
    wordIds: words.map((word) => word.id),
    joiner: ' ',
    reviewedText: words.map((word) => word.text).join(' '),
    correctionReason: '',
    confirmed: false,
  };
}
/** Geometric closure includes every intersecting whole word; it assigns no financial meaning. */
export function imageCellFromWords(ids: string[], inspection: ImageInspection) {
  if (!ids.length) return emptyImageCell();
  const selected = imageCellWords(
    { ...emptyImageCell(), wordIds: ids },
    inspection,
  );
  const bounds = (words: ImageWord[]): ImageBox => {
    const x = Math.min(...words.map((word) => word.box.x)),
      y = Math.min(...words.map((word) => word.box.y));
    return {
      x,
      y,
      width: Math.max(...words.map((word) => word.box.x + word.box.width)) - x,
      height:
        Math.max(...words.map((word) => word.box.y + word.box.height)) - y,
    };
  };
  let region = bounds(selected);
  for (let i = 0; i <= inspection.facts.words.length; i++) {
    const intersecting = inspection.facts.words.filter((word) =>
      imageBoxesOverlap(region, word.box),
    );
    const expanded = bounds(intersecting);
    if (JSON.stringify(expanded) === JSON.stringify(region))
      return imageRegionCell(region, inspection);
    region = expanded;
  }
  throw new Error('The selected word region could not be established.');
}
export function imageCellIssue(cell: ImageCell, inspection: ImageInspection) {
  try {
    if (!cell.region) return 'Select a source region.';
    const selected = imageRegionCell(cell.region, inspection);
    if (
      new Set(cell.wordIds).size !== cell.wordIds.length ||
      selected.wordIds.length !== cell.wordIds.length ||
      selected.wordIds.some((id) => !cell.wordIds.includes(id))
    )
      return 'Include every whole OCR word intersecting this region exactly once.';
    const raw = imageCellWords(cell, inspection)
      .map((word) => word.text)
      .join(cell.joiner);
    if (!cell.reviewedText.trim())
      return 'Enter the text visible in this region.';
    if (cell.reviewedText.length > 10000)
      return 'This cell exceeds the supported text length.';
    if (
      (!cell.wordIds.length || raw !== cell.reviewedText) &&
      !cell.correctionReason.trim()
    )
      return 'Explain the visual correction or text missed by OCR.';
    return undefined;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'The source region could not be verified.';
  }
}
export function verifyImageSelection(
  raw: unknown,
  inspection: ImageInspection,
) {
  const selection = ReviewedFinanceImageSelectionSchema.parse(raw);
  if (
    selection.expectedSourceDigest !== inspection.sourceDigest ||
    selection.standardizationRunId !== inspection.standardizationRunId ||
    selection.extractionRevision !== inspection.extractionRevision ||
    selection.expectedExtractionDigest !== inspection.extractionDigest ||
    selection.reviewedWordInventoryDigest !== inspection.wordInventoryDigest ||
    selection.width !== inspection.facts.width ||
    selection.height !== inspection.facts.height
  )
    throw new Error(
      'The selection does not match this exact original and saved OCR revision.',
    );
  const regions: ImageBox[] = [];
  const inventory = new Map(
    inspection.facts.words.map((word) => [word.id, word]),
  );
  for (const cell of [
    ...selection.headerCells,
    ...selection.rows.flatMap((row) => row.cells),
    ...[selection.context.asOf, selection.context.currency].filter(
      (cell) => cell !== null,
    ),
  ]) {
    const issue = imageCellIssue(
      {
        ...cell,
        wordIds: cell.words.map((word) => word.id),
        correctionReason: cell.correctionReason ?? '',
        confirmed: true,
      },
      inspection,
    );
    if (issue) throw new Error(issue);
    if (regions.some((region) => imageBoxesOverlap(region, cell.region)))
      throw new Error(
        'Selected cell regions overlap. Use each source region only once.',
      );
    if (
      cell.words.some(
        (word) =>
          JSON.stringify(inventory.get(word.id)) !== JSON.stringify(word),
      )
    )
      throw new Error(
        'A selected word does not exactly match the saved OCR inventory.',
      );
    regions.push(cell.region);
  }
  const headings = selection.headerCells.map((cell) => cell.reviewedText);
  if (
    new Set(headings).size !== headings.length ||
    headings.some((heading) => heading.length > 200)
  )
    throw new Error(
      'Use distinct source headings no longer than 200 characters.',
    );
  return selection;
}
export function imageDraftFromSelection(
  selection: ReviewedFinanceImageSelection,
): ImageDraft {
  const cell = (
    value: ReviewedFinanceImageSelection['headerCells'][number],
  ): ImageCell => ({
    region: { ...value.region },
    wordIds: value.words.map((word) => word.id),
    joiner: value.joiner,
    reviewedText: value.reviewedText,
    correctionReason: value.correctionReason ?? '',
    confirmed: false,
  });
  return {
    headers: selection.headerCells.map(cell),
    rows: selection.rows.map((row) => row.cells.map(cell)),
    context: {
      asOf: selection.context.asOf ? cell(selection.context.asOf) : null,
      currency: selection.context.currency
        ? cell(selection.context.currency)
        : null,
    },
  };
}
export function imageSelectionFromDraft(
  draft: ImageDraft,
  inspection: ImageInspection,
) {
  const cell = (value: ImageCell) => {
    const issue = imageCellIssue(value, inspection);
    if (issue) throw new Error(issue);
    if (!value.confirmed)
      throw new Error(
        'Confirm every selected cell against the visible original.',
      );
    return {
      region: value.region!,
      words: imageCellWords(value, inspection),
      joiner: value.joiner,
      reviewedText: value.reviewedText,
      correctionReason: value.correctionReason.trim() || null,
      confirmedAgainstOriginal: true as const,
    };
  };
  return verifyImageSelection(
    {
      expectedSourceDigest: inspection.sourceDigest,
      standardizationRunId: inspection.standardizationRunId,
      extractionRevision: inspection.extractionRevision,
      expectedExtractionDigest: inspection.extractionDigest,
      width: inspection.facts.width,
      height: inspection.facts.height,
      coordinateSpace: 'image-pixels-top-left',
      reviewedWordInventoryDigest: inspection.wordInventoryDigest,
      headerCells: draft.headers.map(cell),
      rows: draft.rows.map((row) => ({ cells: row.map(cell) })),
      context: {
        asOf: draft.context.asOf ? cell(draft.context.asOf) : null,
        currency: draft.context.currency ? cell(draft.context.currency) : null,
      },
      acknowledgeOcrUncertainty: true,
      acknowledgeUnselectedContent: true,
      confirmedHeaderAndContext: true,
    },
    inspection,
  );
}

export const imageFieldNames: Record<string, string> = {
  transactionDate: 'Transaction date',
  description: 'Description',
  amount: 'Amount',
  currency: 'Currency',
  externalId: 'External reference',
  asOf: 'As-of date',
  instrumentIdentifier: 'Instrument identifier',
  quantity: 'Quantity',
  bookCost: 'Book cost',
  marketValue: 'Market value',
  price: 'Price',
  accruedInterest: 'Accrued interest',
  fee: 'Fee',
  commission: 'Commission',
  tax: 'Tax',
  principal: 'Principal',
  interest: 'Interest',
};
export const imageRequiredFields = (type: string) =>
  type === 'bank-transactions'
    ? ['transactionDate', 'description', 'amount', 'currency']
    : ['asOf', 'instrumentIdentifier', 'quantity', 'currency'];
export const imageAllowedFields = (type: string) =>
  CanonicalReportFieldSchema.options.filter((field) =>
    (type === 'bank-transactions'
      ? [
          'transactionDate',
          'description',
          'amount',
          'currency',
          'externalId',
          'fee',
          'commission',
          'tax',
          'principal',
          'interest',
        ]
      : [
          'asOf',
          'instrumentIdentifier',
          'quantity',
          'currency',
          'description',
          'bookCost',
          'marketValue',
          'price',
          'accruedInterest',
        ]
    ).includes(field),
  );
export type ImageMappingSettings = Omit<
  FinanceReportMappingDefinition,
  'headers' | 'bindings' | 'imageSelection' | 'pdfSelection' | 'xlsxSelection'
>;
export function imageMappingSettings(
  definition?: FinanceReportMappingDefinition,
): ImageMappingSettings {
  return {
    providerKey: definition?.providerKey ?? '',
    reportName: definition?.reportName ?? '',
    layoutVersion: definition?.layoutVersion ?? '',
    reportType: definition?.reportType ?? 'bank-transactions',
    dateFormat: definition?.dateFormat ?? 'yyyy-mm-dd',
    decimalSeparator: definition?.decimalSeparator ?? '.',
    groupingSeparator: definition?.groupingSeparator ?? ',',
    quantityUnit: definition?.quantityUnit ?? null,
    valuationMultiplier: definition?.valuationMultiplier ?? null,
    identifierScheme: definition?.identifierScheme ?? null,
    identifierNamespace: definition?.identifierNamespace ?? null,
  };
}
export function imageMappingPayload(input: {
  evidenceId: string;
  draft: ImageDraft;
  inspection: ImageInspection;
  settings: ImageMappingSettings;
  bindings: Record<string, string>;
  notes: string;
  questions: string[];
}) {
  const selection = imageSelectionFromDraft(input.draft, input.inspection);
  const headers = selection.headerCells.map((cell) => cell.reviewedText);
  const bindings: FinanceReportMappingDefinition['bindings'] = [];
  for (const field of imageAllowedFields(input.settings.reportType)) {
    const value = input.bindings[field];
    if (!value) continue;
    if (value === 'context') {
      if (
        (field !== 'asOf' && field !== 'currency') ||
        !selection.context[field]
      )
        throw new Error(
          `Select original ${imageFieldNames[field]} context before mapping it.`,
        );
      bindings.push({ field, column: null, context: field });
      continue;
    }
    bindings.push({
      field,
      column: headers[Number(value)] ?? '',
      context: null,
    });
  }
  return SaveReviewedFinanceImageMappingSchema.parse({
    evidenceId: input.evidenceId,
    proposal: {
      definition: {
        ...input.settings,
        headers,
        bindings,
        imageSelection: selection,
      },
      rationale: input.notes.trim(),
      unresolvedQuestions: input.questions,
    },
  });
}
