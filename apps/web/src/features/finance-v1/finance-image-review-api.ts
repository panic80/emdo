import {
  FinanceImageInspectionSchema,
  UploadFinanceBookEvidenceSchema,
  type FinanceStandardizationRun,
} from '@emdo/contracts/browser';
import { saveMemoryFile } from '../../downloads/save-memory-file.js';
import type { ImageInspection } from './finance-image-review-model.js';

export const isFinanceImage = (format: string) =>
  ['png', 'jpeg', 'webp'].includes(format);
export const financeImageMime = (format: string) =>
  format === 'png'
    ? 'image/png'
    : format === 'jpeg'
      ? 'image/jpeg'
      : 'image/webp';
export class ImageReviewApiError extends Error {
  constructor(public status: number) {
    super(
      [401, 403].includes(status)
        ? 'Current book access does not permit this image review. Loaded private details have been cleared.'
        : status === 503
          ? 'Saved image inspection is not available right now. The original remains saved; retry when inspection is available.'
          : [404, 409].includes(status)
            ? 'This exact saved OCR revision is no longer available for review. Reopen the saved analysis to check its current state.'
            : 'The image inspection could not be loaded. Retry the saved source.',
    );
    this.name = 'ImageReviewApiError';
  }
}
async function json(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new ImageReviewApiError(response.status);
  const result: unknown = await response.json();
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return result;
}
async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
export type ImageReviewSource = Pick<
  FinanceStandardizationRun,
  'bookId' | 'evidenceId' | 'id' | 'format' | 'sourceDigest'
> & { extraction: NonNullable<FinanceStandardizationRun['extraction']> };
export async function readImageReviewOriginal(
  source: ImageReviewSource,
  signal: AbortSignal,
) {
  const original = UploadFinanceBookEvidenceSchema.parse(
    await json(
      `/api/v2/finance/books/${source.bookId}/evidence/${source.evidenceId}`,
      signal,
    ),
  );
  if (
    !('sourceBase64' in original) ||
    !isFinanceImage(original.format) ||
    original.format !== source.format
  )
    throw new Error(
      'The saved original is not the image attached to this extraction.',
    );
  const binary = atob(original.sourceBase64);
  if (
    !binary.length ||
    binary.length > 2097152 ||
    btoa(binary) !== original.sourceBase64
  )
    throw new Error('The original image bytes could not be verified.');
  const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
  if ((await sha256(bytes)) !== source.sourceDigest)
    throw new Error(
      'The original image does not match the saved extraction fingerprint.',
    );
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return {
    filename: original.filename,
    bytes,
    mime: financeImageMime(original.format),
    imageUrl: `data:${financeImageMime(original.format)};base64,${original.sourceBase64}`,
  };
}
export async function readImageReview(
  source: ImageReviewSource,
  signal: AbortSignal,
) {
  if (source.extraction.sourceDigest !== source.sourceDigest)
    throw new Error('The saved analysis and extraction do not reference the same original.');
  const [raw, original] = await Promise.all([
    json(
      `/api/v2/finance/books/${source.bookId}/evidence/${source.evidenceId}/image-inspection?standardizationRunId=${source.id}&extractionRevision=${source.extraction.revision}`,
      signal,
    ),
    readImageReviewOriginal(source, signal),
  ]);
  const inspection: ImageInspection = FinanceImageInspectionSchema.parse(raw);
  if (
    inspection.evidenceId !== source.evidenceId ||
    inspection.standardizationRunId !== source.id ||
    inspection.extractionRevision !== source.extraction.revision ||
    inspection.sourceDigest !== source.sourceDigest ||
    inspection.extractionDigest !== source.extraction.extractionDigest ||
    inspection.facts.format !== source.format ||
    (await sha256(
      new TextEncoder().encode(JSON.stringify(inspection.facts.words)),
    )) !== inspection.wordInventoryDigest
  )
    throw new Error(
      'The complete OCR inventory does not match this exact original and saved extraction. Reopen the analysis before reviewing.',
    );
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return { inspection, original };
}
export async function downloadImageReviewOriginal(
  source: ImageReviewSource,
  signal: AbortSignal,
) {
  const original = await readImageReviewOriginal(source, signal);
  if (!signal.aborted)
    saveMemoryFile(original.filename, original.bytes, original.mime);
}
export async function imageStandardizationUpload(
  file: File,
  format: 'png' | 'jpeg' | 'webp',
) {
  if (!file.size || file.size > 2097152)
    throw new Error(
      'Choose a nonempty PNG, JPEG or WebP image no larger than 2 MiB.',
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return UploadFinanceBookEvidenceSchema.parse({
    filename: file.name,
    format,
    sourceBase64: btoa(chunks.join('')),
  });
}
