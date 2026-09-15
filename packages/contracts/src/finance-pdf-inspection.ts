import { z } from 'zod';
import { UuidSchema, Sha256Schema } from './primitives.js';
import {
  ReviewedFinancePdfSpanSchema,
  ReviewedFinancePdfPageInventorySchema,
} from './finance-pdf.js';
/** Complete source spans for review. Oversized/blank spans can be inspected but
 * the stricter reviewed-selection schema determines whether they are selectable. */
export const FinancePdfInspectionSpanSchema =
  ReviewedFinancePdfSpanSchema.extend({
    text: z.string().max(262144),
    textLength: z.number().int().min(0).max(262144),
  });
export const FinancePdfInspectionSchema = z.strictObject({
  bookId: UuidSchema,
  evidenceId: UuidSchema,
  filename: z.string().min(1).max(200),
  sourceDigest: Sha256Schema,
  status: z.enum(['extracted', 'needs-ocr', 'unavailable']),
  reason: z.string().max(200).nullable(),
  totalPages: z.number().int().min(1).max(25).nullable(),
  pages: z.array(ReviewedFinancePdfPageInventorySchema).max(25),
  selectedPage: z
    .strictObject({
      width: z.number().finite().positive(),
      height: z.number().finite().positive(),
      rotation: z.number().finite(),
      viewportTransform: z.array(z.number().finite()).length(6),
      textStatus: z.enum(['text-extracted', 'no-extractable-text']),
      page: z.number().int().min(1).max(25),
      text: z.string().max(262144),
      spans: z.array(FinancePdfInspectionSpanSchema).max(20000),
    })
    .nullable(),
  issues: z.array(z.string().max(500)).max(100),
});
export type FinancePdfInspection = z.infer<typeof FinancePdfInspectionSchema>;
