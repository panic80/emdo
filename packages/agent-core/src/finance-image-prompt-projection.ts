import { createHash } from 'node:crypto';
import {
  FinanceImageOcrFactsSchema,
  FinanceImagePromptProjectionReceiptSchema,
} from '@emdo/contracts';
/** A deterministic prefix of whole OCR lines, not a table or a completeness claim. */
export function projectFinanceImagePrompt(
  factsInput: unknown,
  extractionDigest: string,
  maximumBytes = 12000,
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) return null;
  // Callers may tighten the historical cap; never silently enlarge it.
  const byteCeiling = Math.min(maximumBytes, 12000);
  const facts = FinanceImageOcrFactsSchema.parse(factsInput);
  const lines = new Map<string, typeof facts.words>();
  for (const word of facts.words) {
    const key = `${word.page}/${word.block}/${word.paragraph}/${word.line}`;
    const line = lines.get(key);
    if (line) line.push(word);
    else lines.set(key, [word]);
  }
  const fullLines = [...lines.values()];
  let words: typeof facts.words = [];
  let selectedLineCount = 0;
  const build = () => ({
    version: 'finance-image-lines-prefix.v1' as const,
    extractionDigest,
    sourceDigest: facts.sourceDigest,
    complete: false as const,
    width: facts.width,
    height: facts.height,
    coordinateSpace: facts.coordinateSpace,
    textBasis: facts.textBasis,
    engine: facts.engine,
    words,
    selectedWordCount: words.length,
    omittedWordCount: facts.words.length - words.length,
    selectedLineCount,
    omittedLineCount: fullLines.length - selectedLineCount,
    selectedTextCharacterCount: words.reduce((n, w) => n + w.text.length, 0),
    omittedTextCharacterCount:
      facts.words.reduce((n, w) => n + w.text.length, 0) -
      words.reduce((n, w) => n + w.text.length, 0),
    textCounting: 'sum-of-raw-word-text-utf16-units' as const,
  });
  for (const line of fullLines) {
    const previous = words;
    words = [...words, ...line];
    selectedLineCount++;
    if (Buffer.byteLength(JSON.stringify(build()), 'utf8') > byteCeiling) {
      words = previous;
      selectedLineCount--;
      break;
    }
  }
  if (facts.words.length && !words.length) return null;
  const projection = build();
  const json = JSON.stringify(projection);
  if (Buffer.byteLength(json, 'utf8') > byteCeiling) return null;
  const {
    version,
    selectedWordCount,
    omittedWordCount,
    selectedLineCount: finalSelectedLineCount,
    omittedLineCount,
    selectedTextCharacterCount,
    omittedTextCharacterCount,
    textCounting,
  } = projection;
  const receipt = FinanceImagePromptProjectionReceiptSchema.parse({
    version,
    extractionDigest,
    digest: createHash('sha256').update(json).digest('hex'),
    selectedWordCount,
    omittedWordCount,
    selectedLineCount: finalSelectedLineCount,
    omittedLineCount,
    selectedTextCharacterCount,
    omittedTextCharacterCount,
    textCounting,
  });
  return { projection, receipt };
}
