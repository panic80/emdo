import { createHash } from 'node:crypto';
import {
  FinanceTaxCalculationRunDetailSchema,
  FinanceTaxWorkingPaperPreparationSchema,
  type FinanceTaxCalculationRunDetail,
  type FinanceTaxWorkingInputReviewSchema,
} from '@emdo/contracts/browser';
import type { z } from 'zod';
import {
  CANADA_ON_2025_PERSONAL_CANDIDATE,
  CANADA_ON_2025_PERSONAL_PACKAGE_VERSION,
  CANADA_ON_2025_PERSONAL_QUESTIONS,
  exportCanadaOntario2025PersonalSchedules,
  runCanadaOntario2025PersonalWorkflow,
} from '../../../packages/domains/src/finance/tax/canada/2025/personal-package.js';
import { taxFixture, taxCaseId, taxOwnerId } from './finance-tax-fixture.js';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = (index: number) =>
  `71000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
export const taxWorkingRunId = id(100);
export const taxWorkingReviewId = id(200);
export function taxWorkingFixture() {
  const fixture = taxFixture();
  const { detail, declarations } = fixture;
  const scope = {
    ...CANADA_ON_2025_PERSONAL_CANDIDATE.scopes[0]!,
    taxpayerType: 'individual' as const,
  };
  detail.questionnaire.intake.scope = scope;
  detail.questionnaire.binding.scope = scope;
  detail.questionnaire.intake.domesticResident = true;
  detail.questionnaire.intake.hasCrossBorderActivity = false;
  const amounts: Record<string, string> = {
    't4.box14': '50000.00',
    't4.box26': '50000.00',
    't4.box24': '50000.00',
    't4.box16': '2766.75',
    't4.box18': '820.00',
    't4.box22': '8000.00',
    interest: '123.45',
  };
  detail.declaredInputs = CANADA_ON_2025_PERSONAL_QUESTIONS.map(
    (question, index) => ({
      sourceId: id(index + 1),
      sourceRevision: 1,
      contentHash: hash(question.key),
      factKey: question.key,
      category: 'general',
      reviewState: 'unreviewed',
      value:
        question.type === 'boolean'
          ? { type: 'boolean', value: true }
          : question.type === 'date'
            ? { type: 'date', value: '1990-01-01' }
            : { type: 'decimal', value: amounts[question.key] ?? '0.00' },
    }),
  );
  declarations.splice(0, declarations.length, ...detail.declaredInputs);
  detail.questionnaire.declarationSourceBindings = detail.declaredInputs.map(
    ({ sourceId, sourceRevision, contentHash }) => ({
      sourceId,
      sourceRevision,
      contentHash,
    }),
  );
  let inputReviews: z.infer<typeof FinanceTaxWorkingInputReviewSchema>[] = [];
  const runs: FinanceTaxCalculationRunDetail[] = [];
  const outputs = new Map<
    string,
    ReturnType<typeof runCanadaOntario2025PersonalWorkflow>
  >();
  const state = {
    status: 200,
    blocked: false,
    exportStatus: 200,
    scopeSupported: true,
  };
  function preparation() {
    return FinanceTaxWorkingPaperPreparationSchema.parse({
      caseId: taxCaseId,
      taxSubjectId: detail.taxSubjectId,
      snapshotRevision: detail.currentRevision,
      snapshotHash: detail.snapshotHash,
      workflowId: 'ca-on-2025-personal-working-papers',
      packageVersion: CANADA_ON_2025_PERSONAL_PACKAGE_VERSION,
      packageHash: hash(CANADA_ON_2025_PERSONAL_CANDIDATE),
      complete: false,
      questions: CANADA_ON_2025_PERSONAL_QUESTIONS,
      inputReviews,
      scopeSupported: state.scopeSupported,
      supportedScopes: CANADA_ON_2025_PERSONAL_CANDIDATE.scopes,
    });
  }
  function approveInputs() {
    inputReviews = detail.declaredInputs.map(
      ({ sourceId, sourceRevision, contentHash }) => ({
        sourceId,
        sourceRevision,
        contentHash,
        reviewedBy: taxOwnerId,
        reviewedAt: '2026-09-14T12:00:00.000Z',
      }),
    );
  }
  function leaveInputUnreviewed(sourceId: string) {
    inputReviews = inputReviews.filter(
      (review) => review.sourceId !== sourceId,
    );
  }
  function createRun() {
    const intake = structuredClone(detail.questionnaire.intake);
    intake.facts = detail.declaredInputs.map((input) => ({
      key: input.factKey,
      value: input.value,
      reviewState: inputReviews.some(
        (review) =>
          review.sourceId === input.sourceId &&
          review.sourceRevision === input.sourceRevision &&
          review.contentHash === input.contentHash,
      )
        ? 'reviewed'
        : 'unreviewed',
      source: {
        kind: 'declaration',
        reference: `declaration:${input.sourceId}`,
        revision: input.sourceRevision,
        contentHash: input.contentHash,
      },
    }));
    const calculated = runCanadaOntario2025PersonalWorkflow(intake);
    const scheduleMap = new Map<
      string,
      Array<{ ordinal: number; field: (typeof calculated.fields)[number] }>
    >();
    calculated.fields.forEach((field, ordinal) => {
      const entries = scheduleMap.get(field.form) ?? [];
      entries.push({ ordinal, field });
      scheduleMap.set(field.form, entries);
    });
    const summary = {
      runId: id(100 + runs.length),
      caseId: taxCaseId,
      taxSubjectId: detail.taxSubjectId,
      snapshotRevision: detail.currentRevision,
      snapshotHash: detail.snapshotHash,
      workflowId: 'ca-on-2025-personal-working-papers' as const,
      packageVersion: CANADA_ON_2025_PERSONAL_PACKAGE_VERSION,
      packageHash: preparation().packageHash,
      inputHash: hash(intake),
      outputHash: hash(calculated),
      status:
        calculated.status === 'blocked'
          ? ('blocked-input' as const)
          : ('incomplete-working-papers' as const),
      complete: false as const,
      createdBy: taxOwnerId,
      createdAt: '2026-09-14T12:30:00.000Z',
    };
    const run = FinanceTaxCalculationRunDetailSchema.parse({
      summary,
      inputBinding: {
        snapshotRevision: summary.snapshotRevision,
        snapshotHash: summary.snapshotHash,
        declarations: detail.questionnaire.declarationSourceBindings,
        inputReviews,
        sourceBooks: detail.questionnaire.sourceAuthorizationBindings,
      },
      authorities: calculated.sources.map(
        ({ id: sourceId, url, formVersion, documentHash, retrievedAt }) => ({
          id: sourceId,
          url,
          formVersion,
          documentHash,
          retrievedAt,
        }),
      ),
      output: {
        status: calculated.status,
        complete: false,
        enabled: false,
        reportable: false,
        runHash: calculated.runHash,
        reportingPolicyVersion: calculated.reportingPolicyVersion,
        issues: calculated.issues,
        releaseBlockers: calculated.releaseBlockers,
        finalAmounts: calculated.finalAmounts,
      },
      schedules: [...scheduleMap].map(([formId, content]) => ({
        formId,
        content,
        contentHash: hash(content),
      })),
      reviews: [],
    });
    runs.unshift(run);
    outputs.set(run.summary.runId, calculated);
    return run;
  }
  function reviewRun(run = runs[0]!) {
    const review = {
      reviewId: id(200 + run.reviews.length),
      outputHash: run.summary.outputHash,
      acknowledgement:
        'reviewed-incomplete-working-papers-not-fileable' as const,
      reviewedBy: taxOwnerId,
      reviewedAt: '2026-09-14T13:00:00.000Z',
    };
    run.reviews.push(review);
    return review;
  }
  function exportRun(run = runs[0]!, reviewId = run.reviews[0]!.reviewId) {
    const exported = exportCanadaOntario2025PersonalSchedules(
      outputs.get(run.summary.runId)!,
    );
    const content = `Private incomplete working papers; NOT FILEABLE\nDurable run,${run.summary.runId}\nCase snapshot,${run.summary.snapshotHash}\nPackage hash,${run.summary.packageHash}\nReviewed by,${taxOwnerId}\nReview ID,${reviewId}\n${exported.content}`;
    return {
      caseId: taxCaseId,
      runId: run.summary.runId,
      reviewId,
      outputHash: run.summary.outputHash,
      snapshotHash: run.summary.snapshotHash,
      filename: exported.filename,
      mimeType: exported.mimeType,
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      complete: false,
    };
  }
  function handle(
    url: string,
    method = 'GET',
    body: Record<string, unknown> = {},
  ): { status: number; json: unknown } {
    const parsed = new URL(url, 'http://localhost'),
      path = parsed.pathname;
    const ok = (json: unknown) => ({ status: 200, json });
    if (path.endsWith('/tax/cases')) return ok({ cases: [fixture.summary()] });
    if (state.blocked)
      return { status: 409, json: { code: 'finance-tax-source-revoked' } };
    if (state.status !== 200) return { status: state.status, json: {} };
    if (method === 'POST') {
      if (path.endsWith('/input-reviews')) {
        const bindings = body.inputs as Array<{
          sourceId: string;
          sourceRevision: number;
          contentHash: string;
        }>;
        inputReviews = [
          ...inputReviews.filter(
            (review) =>
              !bindings.some((input) => input.sourceId === review.sourceId),
          ),
          ...bindings.map((binding) => ({
            ...binding,
            reviewedBy: taxOwnerId,
            reviewedAt: '2026-09-14T12:00:00.000Z',
          })),
        ];
        return ok({
          caseId: taxCaseId,
          snapshotRevision: detail.currentRevision,
          snapshotHash: detail.snapshotHash,
          reviewedInputCount: bindings.length,
          complete: false,
        });
      }
      if (path.endsWith('/declarations')) {
        const source = declarations.find(
          (item) => item.sourceId === body.sourceId,
        );
        const updated = {
          sourceId: source?.sourceId ?? id(50),
          sourceRevision: (source?.sourceRevision ?? 0) + 1,
          contentHash: hash(body),
          factKey: String(body.factKey),
          category: body.category as (typeof declarations)[number]['category'],
          value: body.value as (typeof declarations)[number]['value'],
          reviewState: 'unreviewed' as const,
        };
        const index = declarations.findIndex(
          (item) => item.sourceId === updated.sourceId,
        );
        if (index < 0) declarations.push(updated);
        else declarations[index] = updated;
        detail.declaredInputs = [...declarations];
        detail.questionnaire.declarationSourceBindings = declarations.map(
          ({ sourceId, sourceRevision, contentHash }) => ({
            sourceId,
            sourceRevision,
            contentHash,
          }),
        );
        fixture.advance();
        detail.snapshotHash = hash(detail.currentRevision);
        inputReviews = [];
        return ok(fixture.receipt());
      }
      if (path.endsWith('/runs')) return ok(createRun().summary);
      const run = runs.find((item) => path.includes(item.summary.runId));
      if (run && path.endsWith('/reviews')) {
        const reviewed = reviewRun(run);
        return ok({
          caseId: taxCaseId,
          runId: run.summary.runId,
          reviewId: reviewed.reviewId,
          outputHash: run.summary.outputHash,
          complete: false,
        });
      }
      throw new Error(`Unexpected working-paper mutation: ${path}`);
    }
    if (path.endsWith('/working-papers')) return ok(preparation());
    if (path.endsWith('/runs')) {
      const offset = Number(parsed.searchParams.get('offset') ?? '0'),
        limit = Number(parsed.searchParams.get('limit') ?? '50');
      return ok({
        runs: runs.slice(offset, offset + limit).map((run) => run.summary),
      });
    }
    if (path.endsWith('/assessment')) return ok(fixture.assessment());
    if (path.endsWith('/declarations')) return ok(declarations);
    if (path.endsWith('/grants')) return ok(fixture.grants);
    if (path.endsWith('/export'))
      return state.exportStatus === 200
        ? ok(
            exportRun(
              runs.find((run) => path.includes(run.summary.runId)),
              parsed.searchParams.get('reviewId')!,
            ),
          )
        : { status: state.exportStatus, json: {} };
    const run = runs.find((item) => path.endsWith(item.summary.runId));
    return ok(run ?? detail);
  }
  return {
    ...fixture,
    state,
    preparation,
    approveInputs,
    leaveInputUnreviewed,
    createRun,
    reviewRun,
    exportRun,
    handle,
    runs,
  };
}
