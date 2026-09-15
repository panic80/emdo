import { z } from 'zod';
import { UploadFinanceBookEvidenceSchema } from '@emdo/contracts/browser';
import { saveMemoryFile } from '../../downloads/save-memory-file.js';

const MAX_BYTES = 2097152;
const BinaryOriginal = z.object({
  filename: z.string().min(1).max(200),
  format: z.enum(['pdf', 'xlsx']),
  sourceBase64: z
    .string()
    .min(4)
    .max(2796204)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
});

export async function binaryBookOriginal(file: File, format: 'pdf' | 'xlsx') {
  if (
    !file.size ||
    file.size > MAX_BYTES ||
    !file.name.toLowerCase().endsWith(`.${format}`)
  )
    throw new Error(
      `Choose a nonempty ${format.toUpperCase()} original no larger than 2 MiB.`,
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES)
    throw new Error('The original must be no larger than 2 MiB.');
  if (
    format === 'pdf' &&
    new TextDecoder('ascii').decode(bytes.subarray(0, 5)) !== '%PDF-'
  )
    throw new Error(
      'This file does not have a PDF header. Choose the original PDF.',
    );
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return UploadFinanceBookEvidenceSchema.parse({
    filename: file.name,
    format,
    sourceBase64: btoa(chunks.join('')),
  });
}

/** Call only after a current, authorized evidence read. No browser persistence. */
export function downloadBinaryBookOriginal(
  raw: unknown,
  expected: 'pdf' | 'xlsx',
) {
  const original = BinaryOriginal.parse(raw);
  if (original.format !== expected)
    throw new Error('The original format changed. Refresh the document list.');
  const binary = atob(original.sourceBase64);
  if (
    !binary.length ||
    binary.length > MAX_BYTES ||
    btoa(binary) !== original.sourceBase64
  )
    throw new Error('The original download could not be verified.');
  saveMemoryFile(
    original.filename,
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    expected === 'pdf'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
}
