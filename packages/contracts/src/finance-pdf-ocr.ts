import { z } from 'zod';
import { Sha256Schema, UuidSchema } from './primitives.js';
import {
  FinanceImageOcrFactsSchema,
  ReviewedFinanceImageSelectionSchema,
} from './finance-image.js';

/** Derived raster identity never replaces the original PDF evidence identity. */
export const FinancePdfPageRenderSchema = z
  .strictObject({
    sourceDigest: Sha256Schema,
    pageCount: z.number().int().min(1).max(25),
    pageNumber: z.number().int().min(1).max(25),
    rotation: z.union([
      z.literal(0),
      z.literal(90),
      z.literal(180),
      z.literal(270),
    ]),
    scale: z.number().finite().positive().max(4),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    renderedImageDigest: Sha256Schema,
    renderer: z.strictObject({
      id: z.literal('pdfjs-dist'),
      version: z.string().min(1).max(100),
    }),
  })
  .superRefine((value, context) => {
    if (value.pageNumber > value.pageCount)
      context.addIssue({
        code: 'custom',
        message: 'Rendered page is outside original PDF inventory',
      });
    if (value.width * value.height > 16000000)
      context.addIssue({
        code: 'custom',
        message: 'Rendered page exceeds pixel limit',
      });
  });

/** Words use raster-local coordinates and page1 inside ocr. The enclosing render
 * supplies the original PDF page. These observations confer no review authority. */
export const FinancePdfPageOcrSchema = z
  .strictObject({
    render: FinancePdfPageRenderSchema,
    ocr: FinanceImageOcrFactsSchema,
  })
  .superRefine(({ render, ocr }, context) => {
    if (
      ocr.sourceDigest !== render.renderedImageDigest ||
      ocr.format !== 'png' ||
      ocr.width !== render.width ||
      ocr.height !== render.height
    )
      context.addIssue({
        code: 'custom',
        message: 'OCR must bind the exact rendered PNG digest and dimensions',
      });
  });
export type FinancePdfPageRender = z.infer<typeof FinancePdfPageRenderSchema>;
export type FinancePdfPageOcr = z.infer<typeof FinancePdfPageOcrSchema>;

/** Every original page remains present, including extraction failures. Embedded
 * text stays in its separately hashed extraction; OCR never impersonates spans. */
export const FinancePdfOcrInventorySchema = z
  .strictObject({
    sourceDigest: Sha256Schema,
    pageCount: z.number().int().min(1).max(25),
    complete: z.literal(false),
    pages: z
      .array(
        z.discriminatedUnion('kind', [
          z.strictObject({
            kind: z.literal('ocr'),
            pageNumber: z.number().int().min(1).max(25),
            result: FinancePdfPageOcrSchema,
          }),
          z.strictObject({
            kind: z.literal('embedded-text'),
            pageNumber: z.number().int().min(1).max(25),
            extractionDigest: Sha256Schema,
          }),
          z.strictObject({
            kind: z.literal('unresolved'),
            pageNumber: z.number().int().min(1).max(25),
            reason: z.enum([
              'render-failed',
              'ocr-unavailable',
              'output-limit',
              'aborted',
              'not-extracted',
            ]),
          }),
        ]),
      )
      .min(1)
      .max(25),
  })
  .superRefine((value, context) => {
    if (
      value.pages.length !== value.pageCount ||
      new Set(value.pages.map((page) => page.pageNumber)).size !==
        value.pageCount ||
      value.pages.some((page) => page.pageNumber > value.pageCount)
    )
      context.addIssue({
        code: 'custom',
        message: 'Every original PDF page must appear exactly once',
      });
    for (const page of value.pages)
      if (
        page.kind === 'ocr' &&
        (page.result.render.sourceDigest !== value.sourceDigest ||
          page.result.render.pageCount !== value.pageCount ||
          page.result.render.pageNumber !== page.pageNumber)
      )
        context.addIssue({
          code: 'custom',
          message: 'OCR page belongs to a different original PDF inventory',
        });
  });
export type FinancePdfOcrInventory = z.infer<
  typeof FinancePdfOcrInventorySchema
>;

/** Outer identity is the saved original PDF extraction. Inner image selection
 * identifies the exact derived page raster and its OCR word inventory. */
export const ReviewedFinancePdfOcrSelectionSchema = z
  .strictObject({
    expectedSourceDigest: Sha256Schema,
    standardizationRunId: UuidSchema,
    extractionRevision: z.number().int().min(1).max(3),
    expectedExtractionDigest: Sha256Schema,
    pageNumber: z.number().int().min(1).max(25),
    acknowledgeOtherPages: z.literal(true),
    imageSelection: ReviewedFinanceImageSelectionSchema,
  })
  .superRefine((selection, context) => {
    if (
      selection.imageSelection.standardizationRunId !==
        selection.standardizationRunId ||
      selection.imageSelection.extractionRevision !==
        selection.extractionRevision
    )
      context.addIssue({
        code: 'custom',
        message: 'Page selection must use the same saved extraction revision',
      });
  });
export type ReviewedFinancePdfOcrSelection = z.infer<
  typeof ReviewedFinancePdfOcrSelectionSchema
>;

/** Authenticated inspection of saved observations, never review approval. */
export const FinancePdfOcrInspectionSchema = z
  .strictObject({
    evidenceId: UuidSchema,
    standardizationRunId: UuidSchema,
    extractionRevision: z.number().int().min(1).max(3),
    sourceDigest: Sha256Schema,
    extractionDigest: Sha256Schema,
    inventory: FinancePdfOcrInventorySchema,
  })
  .superRefine((value, context) => {
    if (value.sourceDigest !== value.inventory.sourceDigest)
      context.addIssue({
        code: 'custom',
        message: 'Inspection must bind the saved original PDF digest',
      });
  });
export type FinancePdfOcrInspection = z.infer<
  typeof FinancePdfOcrInspectionSchema
>;
