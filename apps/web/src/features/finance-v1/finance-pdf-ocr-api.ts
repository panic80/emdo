import {
  FinancePdfOcrInspectionSchema,
  UuidSchema,
} from '@emdo/contracts/browser';

export async function readFinancePdfOcrInspection(
  source: {
    bookId: string;
    evidenceId: string;
    standardizationRunId: string;
    extractionRevision: number;
    sourceDigest: string;
    extractionDigest: string;
  },
  signal: AbortSignal,
) {
  for (const id of [
    source.bookId,
    source.evidenceId,
    source.standardizationRunId,
  ])
    UuidSchema.parse(id);
  if (
    !Number.isInteger(source.extractionRevision) ||
    source.extractionRevision < 1 ||
    source.extractionRevision > 3
  )
    throw new Error('Invalid saved PDF extraction revision.');
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const query = new URLSearchParams({
    standardizationRunId: source.standardizationRunId,
    extractionRevision: String(source.extractionRevision),
  });
  const response = await fetch(
    `/api/v2/finance/books/${source.bookId}/evidence/${source.evidenceId}/pdf-ocr-inspection?${query}`,
    { credentials: 'same-origin', cache: 'no-store', signal },
  );
  if (!response.ok)
    throw new Error(
      [401, 403].includes(response.status)
        ? 'Current book access does not permit PDF review.'
        : 'Saved PDF inspection is unavailable. Reopen the analysis and retry.',
    );
  const inspection = FinancePdfOcrInspectionSchema.parse(await response.json());
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (
    inspection.evidenceId !== source.evidenceId ||
    inspection.standardizationRunId !== source.standardizationRunId ||
    inspection.extractionRevision !== source.extractionRevision ||
    inspection.sourceDigest !== source.sourceDigest ||
    inspection.extractionDigest !== source.extractionDigest
  )
    throw new Error(
      'PDF inspection does not match this saved source and revision.',
    );
  return inspection;
}
