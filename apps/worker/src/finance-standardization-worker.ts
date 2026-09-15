import { verifyFinancePdfOcrEvidence } from '@emdo/integrations/finance-documents';
import type { FinancePdfPageRenderer } from './finance-pdf-page-ocr.js';
import type { FinanceImageOcrWorkerAdapter } from './finance-image-ocr.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  FinanceStandardizationClaimSchema,
  FinanceStandardizationModelProvenanceSchema,
  ProposedFinanceReportMappingSchema,
  ExtractedFinanceReportTableSchema,
  type FinanceStandardizationClaim,
  type FinanceImagePromptProjectionReceiptSchema,
  type FinanceStandardizationExtractionEnvelope,
} from '@emdo/contracts';
import {
  extractFinanceCsvTable,
  normalizeExtractedReport,
} from '@emdo/domains/finance';
import { extractFinanceStandardizationSource } from './finance-standardization-extraction.js';
export const FINANCE_STANDARDIZATION_QUEUE = 'emdo.finance.standardization.v1';
export const FinanceStandardizationJobSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.uuid(),
  deliveryRevision: z.number().int().positive(),
  // Added after the initial queue payload. Legacy jobs without a token remain
  // readable, while new deliveries get a fresh broker identity whenever the
  // database delivery lease is reclaimed.
  deliveryToken: z.uuid().optional(),
});
export type StandardizationProposalResult =
  | {
      status: 'proposed';
      proposal: z.infer<typeof ProposedFinanceReportMappingSchema>;
      provenance: z.infer<typeof FinanceStandardizationModelProvenanceSchema>;
    }
  | { status: 'blocked' | 'indeterminate'; reason: string };
export interface StandardizationStore {
  claim(runId: string, deliveryRevision: number): Promise<unknown>;
  readOriginal(
    claim: FinanceStandardizationClaim,
  ): Promise<{ format: string; bytes: Uint8Array }>;
  verifyAuthority(
    claim: FinanceStandardizationClaim,
    binding?: { extractionRevision: number; extractionDigest: string },
  ): Promise<boolean>;
  saveExtraction(
    claim: FinanceStandardizationClaim,
    summary: unknown,
    envelope: FinanceStandardizationExtractionEnvelope,
  ): Promise<void>;
  reserveModelSpend(
    claim: FinanceStandardizationClaim,
    input: {
      requestKey: string;
      inputTokenCeiling: number;
      outputTokenCeiling: number;
      estimatedCadMinor: number;
      pricingVersion: string;
      pricing: {
        inputCadMinorPerMillionTokens: number;
        outputCadMinorPerMillionTokens: number;
      };
      lineage: {
        managerInvocationId: string;
        financeInvocationId: string;
        orchestrationMode: 'registered-workflow';
        promptVersion:
          | 'finance-standardization-proposal.v1'
          | 'finance-standardization-proposal.v2'
          | 'finance-standardization-proposal.v3'
          | 'finance-standardization-proposal.v4';
        promptProjection?: z.infer<
          typeof FinanceImagePromptProjectionReceiptSchema
        >;
      };
    },
  ): Promise<{ reservationId: string }>;
  markModelDispatch(
    claim: FinanceStandardizationClaim,
    input: { reservationId: string },
  ): Promise<void>;
  settleModelSpend(
    claim: FinanceStandardizationClaim,
    input: {
      reservationId: string;
      outcome: 'completed' | 'not-sent' | 'indeterminate';
      actualCadMinor?: number;
      providerResponseId?: string;
    },
  ): Promise<void>;
  finish(
    claim: FinanceStandardizationClaim,
    result: unknown,
    candidate: unknown | null,
  ): Promise<void>;
  block(
    claim: FinanceStandardizationClaim,
    status: 'blocked' | 'indeterminate' | 'authority-revoked',
    reason: string,
  ): Promise<void>;
}
export function standardizationQueueId(
  runId: string,
  revision: number,
  deliveryToken?: string,
) {
  const bytes = createHash('sha256')
    .update(
      deliveryToken === undefined
        ? `finance.standardization.v1:${runId}:${revision}`
        : `finance.standardization.v1:${runId}:${revision}:${deliveryToken}`,
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128;
  bytes[8] = (bytes[8]! & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** The only model port is EMDO's registered Finance workflow; no peer tools or posting port exists. */
export function createFinanceStandardizationWorker(dependencies: {
  store: StandardizationStore;
  imageOcr?: FinanceImageOcrWorkerAdapter;
  pdfRenderer?: FinancePdfPageRenderer;
  propose(
    input: {
      claim: FinanceStandardizationClaim;
      extraction: FinanceStandardizationExtractionEnvelope;
    },
    controls: {
      signal: AbortSignal;
      verifyAuthority(
        claim: FinanceStandardizationClaim,
        binding?: { extractionRevision: number; extractionDigest: string },
      ): Promise<boolean>;
      reserveModelSpend(input: {
        requestKey: string;
        inputTokenCeiling: number;
        outputTokenCeiling: number;
        estimatedCadMinor: number;
        pricingVersion: string;
        pricing: {
          inputCadMinorPerMillionTokens: number;
          outputCadMinorPerMillionTokens: number;
        };
        lineage: {
          managerInvocationId: string;
          financeInvocationId: string;
          orchestrationMode: 'registered-workflow';
          promptVersion:
            | 'finance-standardization-proposal.v1'
            | 'finance-standardization-proposal.v2'
            | 'finance-standardization-proposal.v3'
            | 'finance-standardization-proposal.v4';
          promptProjection?: z.infer<
            typeof FinanceImagePromptProjectionReceiptSchema
          >;
        };
      }): Promise<{ reservationId: string }>;
      markModelDispatch(input: { reservationId: string }): Promise<void>;
      settleModelSpend(input: {
        reservationId: string;
        outcome: 'completed' | 'not-sent' | 'indeterminate';
        actualCadMinor?: number;
        providerResponseId?: string;
      }): Promise<void>;
    },
  ): Promise<StandardizationProposalResult>;
}) {
  return async (
    raw: unknown,
    parentSignal?: AbortSignal,
  ): Promise<'needs-review' | 'blocked' | 'duplicate' | 'indeterminate'> => {
    const job = FinanceStandardizationJobSchema.parse(raw);
    const outcome = z
      .discriminatedUnion('status', [
        z.strictObject({ status: z.enum(['duplicate', 'denied']) }),
        z.strictObject({
          status: z.literal('claimed'),
          claim: FinanceStandardizationClaimSchema,
        }),
      ])
      .parse(await dependencies.store.claim(job.runId, job.deliveryRevision));
    if (outcome.status !== 'claimed') return 'duplicate';
    const claim = outcome.claim;
    if (claim.runId !== job.runId)
      throw new Error('standardization-claim-scope-mismatch');
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 120000);
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, controller.signal])
      : controller.signal;
    let providerStarted = false;
    try {
      const source = await dependencies.store.readOriginal(claim);
      const extracted = await extractFinanceStandardizationSource(
        {
          ...source,
          expectedSourceDigest: claim.sourceDigest,
          revision: job.deliveryRevision,
          signal,
        },
        {
          imageOcr: dependencies.imageOcr,
          pdfRenderer: dependencies.pdfRenderer,
        },
      );
      if (extracted.status === 'blocked') {
        await dependencies.store.block(claim, 'blocked', extracted.reason);
        return 'blocked';
      }
      await dependencies.store.saveExtraction(
        claim,
        extracted.summary,
        extracted.envelope,
      );
      if (
        !(await dependencies.store.verifyAuthority(claim, {
          extractionRevision: extracted.envelope.revision,
          extractionDigest: extracted.envelope.extractionDigest,
        }))
      ) {
        await dependencies.store.block(
          claim,
          'authority-revoked',
          'Current authority no longer permits this saved analysis.',
        );
        return 'blocked';
      }
      if (extracted.envelope.kind === 'pdf-ocr') {
        const saved = verifyFinancePdfOcrEvidence({
          factsJson: extracted.envelope.factsJson,
          expectedExtractionDigest: extracted.envelope.extractionDigest,
          expectedSourceDigest: claim.sourceDigest,
        });
        const usableText =
          saved.embedded.pages.some((page) => page.text.trim().length > 0) ||
          saved.inventory.pages.some(
            (page) =>
              page.kind === 'ocr' &&
              page.result.ocr.words.some((word) => word.text.trim().length > 0),
          );
        if (!usableText) {
          await dependencies.store.block(
            claim,
            'blocked',
            'PDF page observations were saved for source review, but no usable text is available for a mapping proposal. Review the original pages and unresolved coverage.',
          );
          return 'blocked';
        }
        // The registered proposal hook receives every verified page fact. Its
        // existing input/spend ceilings reject oversized prompts; never sample
        // pages or convert machine observations into a materialized CSV.
      }
      providerStarted = true;
      const result = await dependencies.propose(
        { claim, extraction: extracted.envelope },
        {
          signal,
          verifyAuthority: (c, binding) =>
            dependencies.store.verifyAuthority(c, binding),
          reserveModelSpend: (input) =>
            dependencies.store.reserveModelSpend(claim, input),
          markModelDispatch: (input) =>
            dependencies.store.markModelDispatch(claim, input),
          settleModelSpend: (input) =>
            dependencies.store.settleModelSpend(claim, input),
        },
      );
      if (result.status !== 'proposed') {
        await dependencies.store.block(
          claim,
          result.status,
          result.reason.slice(0, 500),
        );
        return result.status;
      }
      const proposal = ProposedFinanceReportMappingSchema.parse(
          result.proposal,
        ),
        provenance = FinanceStandardizationModelProvenanceSchema.parse(
          result.provenance,
        );
      let candidate: unknown | null = null;
      const questions = [
        ...new Set([
          ...proposal.unresolvedQuestions,
          ...extracted.envelope.issues,
        ]),
      ];
      if (source.format === 'csv') {
        const table = extractFinanceCsvTable(
          new TextDecoder('utf-8', { fatal: true }).decode(source.bytes),
        );
        if (
          JSON.stringify(table.headers) ===
            JSON.stringify(proposal.definition.headers) &&
          !proposal.definition.pdfSelection &&
          !proposal.definition.xlsxSelection &&
          !proposal.definition.imageSelection
        ) {
          const example = ExtractedFinanceReportTableSchema.parse({
            documentId: claim.evidenceId,
            extractionRevision: extracted.envelope.revision,
            tableId: 'csv-table-1',
            page: null,
            sheet: null,
            providerKey: proposal.definition.providerKey,
            reportType: proposal.definition.reportType,
            headers: table.headers,
            context: { asOf: null, currency: null },
            rows: table.rows,
          });
          candidate = {
            example,
            validation: normalizeExtractedReport(proposal.definition, example),
          };
        } else
          questions.push(
            'The proposed headers or source selection do not match the original CSV. Review the original before saving a mapping.',
          );
      } else
        questions.push(
          'A human must select and review the exact source cells or PDF spans before this proposal becomes a reusable mapping. Model acknowledgement flags are not source review.',
        );
      if (questions.length > 30) {
        await dependencies.store.block(
          claim,
          'blocked',
          'Too many unresolved source questions to save a bounded proposal.',
        );
        return 'blocked';
      }
      if (
        !(await dependencies.store.verifyAuthority(claim, {
          extractionRevision: extracted.envelope.revision,
          extractionDigest: extracted.envelope.extractionDigest,
        }))
      ) {
        await dependencies.store.block(
          claim,
          'authority-revoked',
          'Current authority no longer permits saving this proposal.',
        );
        return 'blocked';
      }
      await dependencies.store.finish(
        claim,
        {
          proposal: { ...proposal, unresolvedQuestions: questions },
          provenance,
        },
        candidate,
      );
      return 'needs-review';
    } catch {
      const status = providerStarted ? 'indeterminate' : 'blocked';
      await dependencies.store
        .block(
          claim,
          status,
          providerStarted
            ? 'The model or persistence result is unconfirmed. No approval or posting was performed.'
            : 'Extraction could not complete safely. Review the saved original or retry within the saved authorization.',
        )
        .catch(() => {});
      return status;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  };
}
