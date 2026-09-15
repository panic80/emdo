import { z } from 'zod';
import {
  FinanceTaxCalculationRunDetailSchema,
  FinanceTaxCalculationRunSummarySchema,
  FinanceTaxWorkingPaperPreparationSchema,
  FinanceTaxWorkingInputReviewReceiptSchema as TaxWorkingInputReceiptSchema,
  FinanceTaxRunReviewReceiptSchema as TaxRunReviewReceiptSchema,
  FinanceTaxRunExportSchema as TaxRunExportSchema,
  type FinanceTaxCalculationRunSummary,
} from '@emdo/contracts/browser';
import type { TaxCaseDetail } from './finance-tax-model.js';

export {
  TaxWorkingInputReceiptSchema,
  TaxRunReviewReceiptSchema,
  TaxRunExportSchema,
};
export type TaxWorkingPreparation = z.infer<
  typeof FinanceTaxWorkingPaperPreparationSchema
>;
export type TaxWorkingQuestion = TaxWorkingPreparation['questions'][number];
export type TaxRunDetail = z.infer<typeof FinanceTaxCalculationRunDetailSchema>;
export const taxRunLabel = (
  status: FinanceTaxCalculationRunSummary['status'],
) =>
  status === 'blocked-input' ? 'Input blockers' : 'Incomplete working papers';
export const taxWorkingBinding = (preparation: TaxWorkingPreparation) => ({
  expectedCaseRevision: preparation.snapshotRevision,
  expectedSnapshotHash: preparation.snapshotHash,
  workflowId: preparation.workflowId,
  expectedPackageVersion: preparation.packageVersion,
});
export const taxInputBinding = (
  input: TaxCaseDetail['declaredInputs'][number],
) => ({
  sourceId: input.sourceId,
  sourceRevision: input.sourceRevision,
  contentHash: input.contentHash,
});
export function taxWorkingInputs(
  preparation: TaxWorkingPreparation,
  detail: TaxCaseDetail,
) {
  return preparation.questions.map((question) => {
    const matches = detail.declaredInputs.filter(
      (input) => input.factKey === question.key,
    );
    const input = matches.length === 1 ? matches[0] : undefined;
    const review = input
      ? preparation.inputReviews.find(
          (item) =>
            item.sourceId === input.sourceId &&
            item.sourceRevision === input.sourceRevision &&
            item.contentHash === input.contentHash,
        )
      : undefined;
    return {
      question,
      input,
      review,
      ambiguous: matches.length > 1,
      wrongType: !!input && input.value.type !== question.type,
    };
  });
}
export function verifyTaxPreparation(raw: unknown, detail: TaxCaseDetail) {
  const value = FinanceTaxWorkingPaperPreparationSchema.parse(raw);
  if (
    value.caseId !== detail.caseId ||
    value.taxSubjectId !== detail.taxSubjectId ||
    value.snapshotRevision !== detail.currentRevision ||
    value.snapshotHash !== detail.snapshotHash ||
    new Set(value.questions.map((question) => question.key)).size !==
      value.questions.length ||
    new Set(value.inputReviews.map((review) => review.sourceId)).size !==
      value.inputReviews.length ||
    value.inputReviews.some(
      (review) =>
        !detail.declaredInputs.some(
          (input) =>
            review.sourceId === input.sourceId &&
            review.sourceRevision === input.sourceRevision &&
            review.contentHash === input.contentHash,
        ),
    )
  )
    throw new Error(
      'Working-paper preparation does not match the current saved inputs. Refresh this case.',
    );
  return value;
}
export function verifyTaxRunList(raw: unknown, detail: TaxCaseDetail) {
  const { runs } = z
    .strictObject({
      runs: z.array(FinanceTaxCalculationRunSummarySchema).max(100),
    })
    .parse(raw);
  if (
    new Set(runs.map((run) => run.runId)).size !== runs.length ||
    runs.some(
      (run) =>
        run.caseId !== detail.caseId ||
        run.taxSubjectId !== detail.taxSubjectId,
    )
  )
    throw new Error('The saved runs do not match this private case.');
  return runs;
}
export function verifyTaxRun(
  raw: unknown,
  expectedRunId: string,
  detail: TaxCaseDetail,
) {
  const value = FinanceTaxCalculationRunDetailSchema.parse(raw),
    { summary, inputBinding, output, schedules, reviews } = value;
  const fields = schedules.flatMap((schedule) => schedule.content);
  if (
    summary.runId !== expectedRunId ||
    summary.caseId !== detail.caseId ||
    summary.taxSubjectId !== detail.taxSubjectId ||
    inputBinding.snapshotRevision !== summary.snapshotRevision ||
    inputBinding.snapshotHash !== summary.snapshotHash ||
    (summary.status === 'blocked-input') !== (output.status === 'blocked') ||
    (output.formAudit !== undefined &&
      (output.formAudit.runHash !== output.runHash ||
        output.formAudit.packageVersion !== summary.packageVersion)) ||
    new Set(schedules.map((schedule) => schedule.formId)).size !==
      schedules.length ||
    new Set(fields.map((item) => item.ordinal)).size !== fields.length ||
    new Set(fields.map((item) => item.field.id)).size !== fields.length ||
    schedules.some((schedule) =>
      schedule.content.some((item) => item.field.form !== schedule.formId),
    ) ||
    reviews.some((review) => review.outputHash !== summary.outputHash) ||
    inputBinding.inputReviews.some(
      (review) =>
        !inputBinding.declarations.some(
          (input) =>
            input.sourceId === review.sourceId &&
            input.sourceRevision === review.sourceRevision &&
            input.contentHash === review.contentHash,
        ),
    )
  )
    throw new Error(
      'The saved run and its source bindings could not be verified.',
    );
  return value;
}
export async function verifyTaxExport(
  raw: unknown,
  run: TaxRunDetail,
  reviewId: string,
) {
  const value = TaxRunExportSchema.parse(raw);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value.content),
  );
  const actualHash = [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('');
  if (
    value.caseId !== run.summary.caseId ||
    value.runId !== run.summary.runId ||
    value.reviewId !== reviewId ||
    value.outputHash !== run.summary.outputHash ||
    value.snapshotHash !== run.summary.snapshotHash ||
    value.sha256 !== actualHash ||
    run.summary.status !== 'incomplete-working-papers' ||
    !run.reviews.some((review) => review.reviewId === reviewId)
  )
    throw new Error(
      'The reviewed export could not be verified. No file was downloaded.',
    );
  return value;
}
