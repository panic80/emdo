import { createHash } from 'node:crypto';
import { FinancePdfPromptProjectionReceiptSchema } from '@emdo/contracts';
import { z } from 'zod';

// Only positional metadata is removed. Text remains the exact saved extraction,
// including whitespace, empty pages and any embedded untrusted instructions.
const PdfTextFactsSchema = z.object({
  status: z.enum(['extracted', 'needs-ocr']),
  format: z.literal('pdf'),
  totalPages: z.number().int().positive().max(25),
  issues: z.array(z.string()),
  pages: z
    .array(
      z.object({
        page: z.number().int().positive(),
        textStatus: z.enum(['text-extracted', 'no-extractable-text']),
        text: z.string(),
        spans: z.array(z.unknown()),
      }),
    )
    .max(25),
});

/** Complete extracted text or no projection: never sample, trim or truncate. */
export function projectFinancePdfPrompt(
  factsInput: unknown,
  extractionDigest: string,
  sourceDigest: string,
  maximumBytes: number,
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) return null;
  if (
    !/^[a-f0-9]{64}$/.test(extractionDigest) ||
    !/^[a-f0-9]{64}$/.test(sourceDigest)
  )
    return null;
  const parsed = PdfTextFactsSchema.safeParse(factsInput);
  if (!parsed.success) return null;
  const facts = parsed.data;
  if (
    facts.pages.length !== facts.totalPages ||
    facts.pages.some((page, index) => page.page !== index + 1)
  )
    return null;
  const projection = {
    kind: 'pdf-text.v1' as const,
    extractionDigest,
    sourceDigest,
    status: facts.status,
    format: facts.format,
    totalPages: facts.totalPages,
    issues: facts.issues,
    pages: facts.pages.map(({ page, textStatus, text }) => ({
      page,
      textStatus,
      text,
    })),
  };
  const json = JSON.stringify(projection);
  if (Buffer.byteLength(json, 'utf8') > maximumBytes) return null;
  const receipt = FinancePdfPromptProjectionReceiptSchema.safeParse({
    kind: 'pdf-text.v1',
    extractionDigest,
    projectionDigest: createHash('sha256').update(json, 'utf8').digest('hex'),
    pageCount: facts.totalPages,
    spanCount: facts.pages.reduce(
      (count, page) => count + page.spans.length,
      0,
    ),
    textCharacters: facts.pages.reduce(
      (count, page) => count + page.text.length,
      0,
    ),
    omittedPages: 0,
  });
  if (!receipt.success) return null;
  return { projection, receipt: receipt.data };
}
