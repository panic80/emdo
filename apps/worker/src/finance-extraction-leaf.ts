import { financeStandardizationAdapter } from '@emdo/domains/finance';
import { createHash } from 'node:crypto';
import { FinanceExtractionNotAppliedError } from '@emdo/db/worker';
import {
  FinanceAutomationExtractionIntentSchema,
  FinanceImageOcrFactsSchema,
} from '@emdo/contracts';
import { verifyFinancePdfOcrEvidence } from '@emdo/integrations/finance-documents';
import { extractFinanceStandardizationSource } from './finance-standardization-extraction.js';
import type { PostgresFinanceExtractionExecutionRepository } from '@emdo/db/worker';
import type { FinanceAutomationLeaf } from './finance-automation-worker.js';
export function createFinanceExtractionLeaf(
  store: Pick<PostgresFinanceExtractionExecutionRepository, 'read' | 'save'>,
  dependencies: Parameters<typeof extractFinanceStandardizationSource>[1],
): FinanceAutomationLeaf {
  return {
    capability: 'finance.documents.extract',
    readiness: 'implemented',
    async execute(input) {
      if (input.signal.aborted) return { application: 'not-applied' };
      const parsed = FinanceAutomationExtractionIntentSchema.safeParse(
        input.run.request.extraction,
      );
      if (
        !parsed.success ||
        input.run.request.capability !== 'finance.documents.extract' ||
        input.targets.length !== 1 ||
        input.targets[0] !== parsed.data.evidenceId
      )
        return {
          application: 'blocked',
          reason: 'finance-extraction-invalid-intent',
        };
      const extraction = parsed.data;
      const binding = {
        operationId: input.run.request.operationId,
        expectedRevision: input.run.revision,
        leaseToken: input.leaseToken,
      };
      let saving = false;
      try {
        const source = await store.read({
          ...binding,
          workspaceId: input.run.request.workspaceId,
          bookId: input.run.request.bookId,
          extraction,
        });
        if (input.signal.aborted) return { application: 'not-applied' };
        if (
          createHash('sha256').update(source.bytes).digest('hex') !==
          extraction.expectedSourceDigest
        )
          return {
            application: 'blocked',
            reason: 'finance-extraction-source-invalid',
          };
        // No local native OCR fallback is permitted in automation.
        if (
          !source.envelope &&
          ['png', 'jpeg', 'webp'].includes(source.format) &&
          !dependencies?.imageOcr
        )
          return {
            application: 'blocked',
            reason: 'finance-extraction-ocr-unavailable',
          };
        const adapter = financeStandardizationAdapter(source.format);
        if (
          !adapter ||
          adapter.availability !== 'implemented' ||
          adapter.workflow !== 'dynamic-mapping'
        )
          return {
            application: 'blocked',
            reason: 'finance-extraction-format-unsupported',
          };
        if (source.bytes.length > adapter.maxBytes)
          return {
            application: 'blocked',
            reason: 'finance-extraction-source-limit',
          };
        const result =
          source.summary && source.envelope
            ? {
                status: 'extracted' as const,
                summary: source.summary,
                envelope: source.envelope,
              }
            : await extractFinanceStandardizationSource(
                {
                  format: source.format,
                  bytes: source.bytes,
                  expectedSourceDigest: extraction.expectedSourceDigest,
                  revision: 1,
                  signal: input.signal,
                },
                dependencies,
              );
        if (input.signal.aborted) return { application: 'not-applied' };
        if (result.status !== 'extracted') {
          if (
            result.reason ===
            'This PDF contains pages without embedded text. Isolated PDF rendering and image OCR must both be explicitly enabled.'
          )
            return {
              application: 'blocked',
              reason: 'finance-extraction-pdf-ocr-unavailable',
            };
          if (
            result.reason ===
            'The full extraction exceeds the bounded proposal input. No truncated sample will be mapped.'
          )
            return {
              application: 'blocked',
              reason: 'finance-extraction-source-limit',
            };
          return { application: 'not-applied' };
        }
        if (
          createHash('sha256')
            .update(result.envelope.factsJson)
            .digest('hex') !== result.envelope.extractionDigest
        )
          throw new FinanceExtractionNotAppliedError('extraction-integrity');
        if (
          result.envelope.kind === 'image-ocr' &&
          FinanceImageOcrFactsSchema.parse(
            JSON.parse(result.envelope.factsJson),
          ).sourceDigest !== extraction.expectedSourceDigest
        )
          throw new FinanceExtractionNotAppliedError(
            'extraction-image-binding',
          );
        if (result.envelope.kind === 'pdf-ocr')
          verifyFinancePdfOcrEvidence({
            factsJson: result.envelope.factsJson,
            expectedExtractionDigest: result.envelope.extractionDigest,
            expectedSourceDigest: extraction.expectedSourceDigest,
          });
        saving = true;
        const saved = await store.save({
          ...binding,
          summary: result.summary,
          envelope: result.envelope,
        });
        return { application: 'applied', outcomeReference: saved.resultId };
      } catch (error) {
        if (!saving && input.signal.aborted)
          return { application: 'not-applied' };
        if (error instanceof FinanceExtractionNotAppliedError) {
          if (
            [
              'extraction-source-binding',
              'extraction-original-integrity',
              'extraction-integrity',
              'extraction-image-binding',
            ].includes(error.message)
          )
            return {
              application: 'blocked',
              reason: 'finance-extraction-source-invalid',
            };
          if (error.message === 'extraction-not-applied')
            return {
              application: 'blocked',
              reason: 'finance-extraction-source-or-authority-invalid',
            };
          return { application: 'not-applied' };
        }
        if (!saving) return { application: 'not-applied' };
        return { application: 'indeterminate' };
      }
    },
  };
}
