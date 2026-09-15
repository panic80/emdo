import { createHash } from 'node:crypto';
import {
  FinancePdfPageOcrSchema,
  FinancePdfPageRenderSchema,
  type FinancePdfPageRender,
} from '@emdo/contracts';
import type { FinanceImageOcrWorkerAdapter } from './finance-image-ocr.js';

/** Trusted release wiring supplies the isolated renderer. No local fallback. */
export interface FinancePdfPageRenderer {
  render(input: {
    bytes: Uint8Array;
    expectedSourceDigest: string;
    pageNumber: number;
    signal: AbortSignal;
  }): Promise<
    | { status: 'rendered'; render: FinancePdfPageRender; png: Uint8Array }
    | { status: 'unavailable'; reason: string }
  >;
}
/** One candidate page; never grants review or asserts whole-document coverage. */
export async function extractFinancePdfPageOcr(
  input: {
    bytes: Uint8Array;
    expectedSourceDigest: string;
    pageNumber: number;
    expectedPageCount?: number;
    signal: AbortSignal;
  },
  dependencies: {
    renderer: FinancePdfPageRenderer;
    imageOcr: FinanceImageOcrWorkerAdapter;
  },
) {
  if (input.signal.aborted)
    return { status: 'unavailable' as const, reason: 'aborted' as const };
  if (
    input.bytes.byteLength > 2 * 1024 * 1024 ||
    !Number.isInteger(input.pageNumber) ||
    input.pageNumber < 1 ||
    input.pageNumber > 25
  )
    throw new Error('finance-pdf-page-input-invalid');
  if (
    createHash('sha256').update(input.bytes).digest('hex') !==
    input.expectedSourceDigest
  )
    throw new Error('finance-pdf-original-digest-mismatch');
  const rendered = await dependencies.renderer.render(input);
  if (input.signal.aborted)
    return { status: 'unavailable' as const, reason: 'aborted' as const };
  if (rendered.status === 'unavailable')
    return { status: 'unavailable' as const, reason: 'render-failed' as const };
  const render = FinancePdfPageRenderSchema.parse(rendered.render);
  if (
    render.sourceDigest !== input.expectedSourceDigest ||
    render.pageNumber !== input.pageNumber ||
    (input.expectedPageCount !== undefined &&
      render.pageCount !== input.expectedPageCount) ||
    rendered.png.byteLength > 2 * 1024 * 1024 ||
    createHash('sha256').update(rendered.png).digest('hex') !==
      render.renderedImageDigest
  )
    throw new Error('finance-pdf-render-binding-mismatch');
  if (input.signal.aborted)
    return { status: 'unavailable' as const, reason: 'aborted' as const };
  const image = await dependencies.imageOcr.extract({
    format: 'png',
    bytes: rendered.png,
    expectedSourceDigest: render.renderedImageDigest,
    signal: input.signal,
    limits: {
      maxDimension: 8192,
      maxPixels: 16000000,
      maxWords: 5000,
      maxTextCharacters: 65536,
    },
  });
  if (input.signal.aborted)
    return { status: 'unavailable' as const, reason: 'aborted' as const };
  if (image.status === 'unavailable' || !image.engine)
    return {
      status: 'unavailable' as const,
      reason: 'ocr-unavailable' as const,
    };
  const {
    status,
    qualityStatus,
    sourceDigest,
    format,
    width,
    height,
    coordinateSpace,
    engine,
    text,
    words,
    issues,
    truncated,
    textBasis,
  } = image;
  const result = FinancePdfPageOcrSchema.parse({
    render,
    ocr: {
      status,
      qualityStatus,
      sourceDigest,
      format,
      width,
      height,
      coordinateSpace,
      engine,
      text,
      words,
      issues,
      truncated,
      textBasis,
    },
  });
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 262144)
    return { status: 'unavailable' as const, reason: 'output-limit' as const };
  return { status: 'extracted' as const, result };
}
