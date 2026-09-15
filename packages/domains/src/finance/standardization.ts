import {
  FinanceExtractionRegistrySchema,
  FinanceStandardizationRunSchema,
  type FinanceStandardizationRun,
} from '@emdo/contracts';

/** This registry describes shipped extractors, not legal conformance or deployment readiness. */
export const FINANCE_EXTRACTION_REGISTRY =
  FinanceExtractionRegistrySchema.parse({
    version: 'finance-extraction-registry.v1',
    adapters: [
      {
        id: 'finance.csv-table',
        version: '1',
        formats: ['csv'],
        availability: 'implemented',
        workflow: 'dynamic-mapping',
        facts: ['source-rows'],
        maxBytes: 2097152,
        limitations: [
          'Header, date locale, separators and financial field meanings require review.',
        ],
      },
      {
        id: 'finance.xlsx-regions',
        version: '1',
        formats: ['xlsx'],
        availability: 'implemented',
        workflow: 'dynamic-mapping',
        facts: [
          'source-rows',
          'source-cells',
          'sheet-names',
          'cached-formulas',
        ],
        maxBytes: 2097152,
        limitations: [
          'Table regions and headers are tentative until source review.',
          'Excel date serials and cached formulas are source facts, not confirmed canonical values.',
          'Macros, formulas and external links are never executed.',
        ],
      },
      {
        id: 'finance.pdf-layout',
        version: '1',
        formats: ['pdf'],
        availability: 'implemented',
        workflow: 'dynamic-mapping',
        facts: ['page-spans'],
        maxBytes: 2097152,
        limitations: [
          'Embedded text and layout only; scanned pages use the separately enabled isolated PDF OCR adapter.',
          'Whole-span selection cannot reconstruct columns inside a single span.',
          'Page and span selections and omitted content require source review.',
        ],
      },
      {
        id: 'finance.pdf-ocr',
        version: '1',
        formats: ['pdf'],
        availability: 'implemented',
        workflow: 'dynamic-mapping',
        facts: ['page-spans', 'machine-transcription', 'pixel-regions'],
        maxBytes: 2097152,
        limitations: [
          'Requires explicitly enabled isolated PDF rendering and image OCR; implementation availability does not imply runtime readiness.',
          'Retains embedded-text, OCR and unresolved pages separately; OCR coordinates refer to a raster bound to the original PDF page.',
          'Page regions, transcription corrections and omitted pages require explicit review; no whole-document completeness is inferred.',
        ],
      },
      {
        id: 'finance.ofx-native',
        version: '1',
        formats: ['ofx', 'qfx'],
        availability: 'implemented',
        workflow: 'native-review',
        facts: ['structured-fields'],
        maxBytes: 2097152,
        limitations: [
          'Use the existing native statement import and explicit row review; no learned mapping is required.',
        ],
      },
      {
        id: 'finance.structured-invoice',
        version: 'structured-invoice.v1',
        formats: ['ubl', 'cii'],
        availability: 'implemented',
        workflow: 'native-review',
        facts: ['structured-fields'],
        maxBytes: 2097152,
        limitations: [
          'Use the source-bound invoice review workflow.',
          'Extraction does not validate full EN16931 or XRechnung conformance.',
        ],
      },
      {
        id: 'finance.image-ocr',
        version: 'tesseract-local-pixel-words.v1',
        formats: ['png', 'jpeg', 'webp'],
        availability: 'implemented',
        workflow: 'dynamic-mapping',
        facts: ['machine-transcription', 'pixel-regions'],
        maxBytes: 2097152,
        limitations: [
          'Requires installed local ImageMagick/Tesseract and pinned traineddata provenance; unavailable runtimes produce no OCR facts.',
          'Single-frame PNG/JPEG/WebP only; non-default orientation is unsupported.',
          'OCR words and layout remain uncertain until explicit original-image region review and corrections.',
        ],
      },
    ],
  });
export function financeStandardizationAdapter(format: string) {
  return FINANCE_EXTRACTION_REGISTRY.adapters.find((adapter) =>
    (adapter.formats as readonly string[]).includes(format),
  );
}
export function standardizationAllowedActions(
  run: Pick<FinanceStandardizationRun, 'status' | 'attempt' | 'proposal'> &
    Partial<Pick<FinanceStandardizationRun, 'format' | 'extraction'>>,
  canManage: boolean,
): FinanceStandardizationRun['allowedActions'] {
  const actions: FinanceStandardizationRun['allowedActions'] = [];
  if (
    run.status === 'needs-review' ||
    run.status === 'extracted' ||
    (run.status === 'blocked' &&
      ((['png', 'jpeg', 'webp'].includes(run.format ?? '') &&
        run.extraction?.adapterId === 'finance.image-ocr') ||
        (run.format === 'pdf' &&
          run.extraction?.adapterId === 'finance.pdf-ocr')))
  )
    actions.push('review-source');
  if (run.proposal?.mappingId) actions.push('open-mapping');
  if (canManage && ['queued', 'extracting', 'proposing'].includes(run.status))
    actions.push('cancel');
  if (canManage && run.status === 'blocked' && run.attempt < 3)
    actions.push('retry');
  return actions;
}
export function assertStandardizationRunInvariant(
  raw: unknown,
): FinanceStandardizationRun {
  const run = FinanceStandardizationRunSchema.parse(raw);
  if (
    run.status === 'extracted' &&
    (run.executionMode !== 'extraction-only' ||
      !run.extraction ||
      run.proposal ||
      run.modelProvenance)
  )
    throw new Error('standardization-extracted-invariant');
  if (run.extraction && run.extraction.sourceDigest !== run.sourceDigest)
    throw new Error('standardization-source-binding-mismatch');
  if (
    run.status === 'needs-review' &&
    (!run.extraction || !run.proposal || !run.modelProvenance)
  )
    throw new Error('standardization-review-provenance-missing');
  if (run.proposal && !run.modelProvenance)
    throw new Error('standardization-model-provenance-missing');
  if (
    run.status === 'proposing' &&
    (!run.extraction ||
      run.extraction.truncated ||
      ['needs-ocr', 'unsupported'].includes(run.extraction.status))
  )
    throw new Error('standardization-extraction-not-proposable');
  return run;
}
