import { createHash } from 'node:crypto';
import {
  FinanceAutomationCapabilitySchema,
  FinanceAutomationExtractionIntentSchema,
  FinanceAutomationPlanningIntentSchema,
  FinanceAutomationJournalDraftIntentSchema,
  FinanceAutomationRunSchema,
  FinanceMoneySchema,
  FinanceReportSelectionSchema,
  IsoDateTimeSchema,
  UuidSchema,
  deepFreeze,
  isFinanceAutomationPlanningCapability,
  type FinanceAutomationRun,
} from '@emdo/contracts';
import { moneyValue } from '@emdo/domains/finance';
import { z } from 'zod';
import type { PgBossCompatible, PgBossJob } from './jobs.js';

export const FINANCE_AUTOMATION_QUEUE = 'emdo.finance.automation.v1';
const DeliveryRevisionSchema = z.number().int().min(1).max(2147483647);
export const FinanceAutomationJobSchema = z.strictObject({
  schemaVersion: z.literal(1),
  origin: z.literal('emdo-managed'),
  operationId: UuidSchema,
  deliveryRevision: DeliveryRevisionSchema,
});
const PlanningReviewSchema = z.strictObject({
  itemCount: z.number().int().positive().safe(),
  currency: FinanceMoneySchema.shape.currency,
  reviewForecastId: UuidSchema.nullable(),
  reviewForecastRevision: z.number().int().positive().safe().nullable(),
});
const IntentSchema = z
  .strictObject({
    workspaceId: UuidSchema,
    bookId: UuidSchema,
    grantId: UuidSchema,
    grantRevision: z.number().int().safe().positive(),
    capability: FinanceAutomationCapabilitySchema,
    targets: z.array(UuidSchema).min(1).max(10000),
    currency: FinanceMoneySchema.shape.currency,
    amount: z.string().max(40),
    report: FinanceReportSelectionSchema.optional(),
    planning: FinanceAutomationPlanningIntentSchema.optional(),
    extraction: FinanceAutomationExtractionIntentSchema.optional(),
    journal: FinanceAutomationJournalDraftIntentSchema.optional(),
    journalReview: z
      .strictObject({
        itemCount: z.number().int().positive().safe(),
        currency: FinanceMoneySchema.shape.currency,
        amount: z.string().max(40),
      })
      .optional(),
    /** Server-derived reviewed-input binding retained in the canonical intent. */
    planningReview: PlanningReviewSchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      (value.capability === 'finance.documents.extract') !==
        (value.extraction !== undefined) ||
      (value.extraction &&
        (value.targets.length !== 1 ||
          value.targets[0] !== value.extraction.evidenceId ||
          !/^0(?:\.0+)?$/.test(value.amount) ||
          value.report !== undefined ||
          value.planning !== undefined))
    )
      context.addIssue({
        code: 'custom',
        path: ['extraction'],
        message: 'Invalid exact extraction intent',
      });
    const journal = value.capability === 'finance.journals.draft';
    if (
      journal !== (value.journal !== undefined) ||
      journal !== (value.journalReview !== undefined) ||
      (value.journal &&
        (value.targets.length !== 1 ||
          value.targets[0] !== value.journal.batchId ||
          value.report !== undefined ||
          value.planning !== undefined ||
          value.extraction !== undefined ||
          value.planningReview !== undefined)) ||
      (value.journalReview &&
        (value.journalReview.currency !== value.currency ||
          value.journalReview.amount !== value.amount))
    )
      context.addIssue({
        code: 'custom',
        path: ['journal'],
        message: 'Invalid exact journal draft intent',
      });
    const planning = isFinanceAutomationPlanningCapability(value.capability);
    if (planning !== (value.planning !== undefined))
      context.addIssue({
        code: 'custom',
        path: ['planning'],
        message: planning
          ? 'Planning capability requires a versioned planning intent'
          : 'Planning intent is only valid for a planning capability',
      });
    if (planning && value.report !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['report'],
        message: 'Planning runs cannot carry a report selection',
      });
    if (value.planning !== undefined) {
      if (value.planning.capability !== value.capability)
        context.addIssue({
          code: 'custom',
          path: ['planning', 'capability'],
          message: 'Planning capability does not match the run capability',
        });
      if (value.planning.currency !== value.currency)
        context.addIssue({
          code: 'custom',
          path: ['planning', 'currency'],
          message: 'Planning currency does not match the run currency',
        });
      if (
        value.targets.length !== 1 ||
        value.targets[0] !== value.planning.budgetId
      )
        context.addIssue({
          code: 'custom',
          path: ['targets'],
          message: 'Planning runs must target exactly the planning budget',
        });
      if (!/^0(?:\.0+)?$/.test(value.amount))
        context.addIssue({
          code: 'custom',
          path: ['amount'],
          message: 'Planning runs cannot reserve a nonzero amount',
        });
    }
  })
  .refine(
    (v) =>
      FinanceMoneySchema.safeParse({ currency: v.currency, amount: v.amount })
        .success &&
      !v.amount.startsWith('-') &&
      new Set(v.targets).size === v.targets.length,
  );
const ClaimSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unavailable') }),
  z.strictObject({
    status: z.literal('denied'),
    reason: z.string().min(1).max(100),
  }),
  z.strictObject({
    status: z.literal('duplicate'),
    outcomeReference: UuidSchema,
  }),
  z.strictObject({
    status: z.literal('claimed'),
    run: FinanceAutomationRunSchema,
    intent: IntentSchema,
    leaseToken: UuidSchema,
    leaseExpiresAt: IsoDateTimeSchema,
  }),
]);
const LeafResultSchema = z.discriminatedUnion('application', [
  z.strictObject({
    application: z.literal('applied'),
    outcomeReference: UuidSchema,
  }),
  z.strictObject({ application: z.literal('not-applied') }),
  z.strictObject({
    application: z.literal('blocked'),
    reason: z.string().trim().min(1).max(200),
  }),
  z.strictObject({ application: z.literal('indeterminate') }),
]);
export interface FinanceAutomationExecutionStore {
  claimDelivery(
    operationId: string,
    deliveryRevision: number,
  ): Promise<unknown>;
  settle(input: {
    operationId: string;
    expectedRevision: number;
    leaseToken: string;
    result: 'applied' | 'not-applied' | 'indeterminate' | 'blocked';
    outcomeReference?: string;
    blockedReason?: string;
  }): Promise<unknown>;
}
export type FinanceAutomationLeafResult = z.infer<typeof LeafResultSchema>;
export interface FinanceAutomationLeafInput {
  readonly run: FinanceAutomationRun;
  readonly targets: readonly string[];
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly signal: AbortSignal;
}
/** Code-owned deterministic leaf; readiness must follow concrete implementation
 * review. DB readiness/entitlements remain independent and default disabled.
 * Each leaf resolves target IDs inside run.request.workspaceId/bookId and binds
 * its durable outcome to operationId/requestHash. No sibling lookup/dispatch,
 * browser principal or permission-minting API is provided to this function.
 */
export interface FinanceAutomationLeaf {
  readonly capability: z.infer<typeof FinanceAutomationCapabilitySchema>;
  readonly readiness: 'implemented';
  execute(
    input: FinanceAutomationLeafInput,
  ): Promise<FinanceAutomationLeafResult>;
}
export type FinanceAutomationDispatchResult =
  | {
      readonly status: 'completed' | 'duplicate';
      readonly outcomeReference: string;
    }
  | { readonly status: 'retryable'; readonly nextDeliveryRevision: number }
  | { readonly status: 'unavailable' | 'denied' | 'requires-reconciliation' }
  | { readonly status: 'blocked'; readonly reason: string };

/** Stable queue reference only; it does not attest current execution authority. */
export function financeAutomationQueueJobId(
  operationId: string,
  deliveryRevision: number,
): string {
  UuidSchema.parse(operationId);
  DeliveryRevisionSchema.parse(deliveryRevision);
  const bytes = createHash('sha256')
    .update(
      `emdo.finance.automation.queue.v1:${operationId}:${deliveryRevision}`,
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Bounds orchestration waiting; a timed-out database call can still commit,
 * so callers treat it as unknown and never dispatch/replay on that assumption. */
async function boundedPersistence<T>(
  work: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('automation-persistence-timeout')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createFinanceAutomationDispatcher(options: {
  readonly executions: FinanceAutomationExecutionStore;
  readonly leaves: readonly FinanceAutomationLeaf[];
  /** Trusted host clock, injectable for deterministic lease boundary tests. */
  readonly now: () => string;
  readonly maxExecutionMs?: number;
}): (
  operationId: string,
  deliveryRevision: number,
  signal: AbortSignal,
) => Promise<FinanceAutomationDispatchResult> {
  const maximum = options.maxExecutionMs ?? 90000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 90000)
    throw new Error('automation-invalid-timeout');
  const leaves = new Map<string, FinanceAutomationLeaf['execute']>();
  for (const leaf of options.leaves) {
    const capability = FinanceAutomationCapabilitySchema.parse(leaf.capability);
    if (
      leaf.readiness !== 'implemented' ||
      typeof leaf.execute !== 'function' ||
      leaves.has(capability)
    )
      throw new Error('automation-invalid-leaf-registration');
    leaves.set(capability, leaf.execute.bind(leaf));
  }
  return async (operationId, deliveryRevision, signal) => {
    UuidSchema.parse(operationId);
    DeliveryRevisionSchema.parse(deliveryRevision);
    if (!(signal instanceof AbortSignal))
      throw new Error('automation-invalid-signal');
    if (signal.aborted)
      return { status: 'retryable', nextDeliveryRevision: deliveryRevision };
    let raw: unknown;
    try {
      raw = await boundedPersistence(
        options.executions.claimDelivery(operationId, deliveryRevision),
        10000,
      );
    } catch {
      throw new Error('automation-claim-unavailable');
    }
    const parsed = ClaimSchema.safeParse(raw);
    if (!parsed.success) throw new Error('automation-invalid-claim');
    const claim = parsed.data;
    if (claim.status === 'duplicate') return deepFreeze(claim);
    if (claim.status === 'unavailable' || claim.status === 'denied')
      return { status: claim.status };
    const { run, intent } = claim;
    const request = run.request;
    if (
      run.status !== 'executing' ||
      run.revision !== deliveryRevision + 1 ||
      run.attempts < 1 ||
      request.operationId !== operationId ||
      request.workspaceId !== intent.workspaceId ||
      request.bookId !== intent.bookId ||
      request.grantId !== intent.grantId ||
      request.grantRevision !== intent.grantRevision ||
      request.capability !== intent.capability ||
      request.currency !== intent.currency ||
      JSON.stringify(request.extraction) !==
        JSON.stringify(intent.extraction) ||
      JSON.stringify(request.journal) !== JSON.stringify(intent.journal) ||
      (request.capability === 'finance.journals.draft'
        ? request.itemCount !== intent.journalReview?.itemCount
        : isFinanceAutomationPlanningCapability(request.capability)
          ? request.itemCount !== intent.planning?.itemCount
          : request.itemCount !== intent.targets.length) ||
      moneyValue(request.amount, request.currency) !==
        moneyValue(intent.amount, intent.currency) ||
      (isFinanceAutomationPlanningCapability(request.capability)
        ? JSON.stringify(request.planning) !== JSON.stringify(intent.planning)
        : JSON.stringify(
            request.report ?? { kind: 'posted-ledger-trial-balance' },
          ) !==
          JSON.stringify(
            intent.report ?? { kind: 'posted-ledger-trial-balance' },
          ))
    ) {
      // Corrupt binding: never settle some other operation with a forged lease.
      throw new Error('automation-claim-binding-invalid');
    }
    const settle = async (
      result: FinanceAutomationLeafResult,
    ): Promise<FinanceAutomationDispatchResult> => {
      try {
        const rawSettlement = await boundedPersistence(
          options.executions.settle({
            operationId,
            expectedRevision: run.revision,
            leaseToken: claim.leaseToken,
            result: result.application,
            ...(result.application === 'applied'
              ? { outcomeReference: result.outcomeReference }
              : {}),
            ...(result.application === 'blocked'
              ? { blockedReason: result.reason }
              : {}),
          }),
          5000,
        );
        const settled = FinanceAutomationRunSchema.safeParse(rawSettlement);
        if (!settled.success) return { status: 'requires-reconciliation' };
        const final = settled.data;
        if (
          JSON.stringify(final.request) !== JSON.stringify(request) ||
          final.revision !== run.revision + 1 ||
          final.attempts !== run.attempts
        )
          return { status: 'requires-reconciliation' };
        if (
          result.application === 'applied' &&
          final.status === 'completed' &&
          final.outcomeReference === result.outcomeReference
        )
          return {
            status: 'completed',
            outcomeReference: result.outcomeReference,
          };
        if (
          result.application === 'not-applied' &&
          final.status === 'retryable'
        )
          return { status: 'retryable', nextDeliveryRevision: final.revision };
        if (
          result.application === 'blocked' &&
          final.status === 'blocked' &&
          final.outcomeReference === null
        )
          return { status: 'blocked', reason: result.reason };
        return { status: 'requires-reconciliation' };
      } catch {
        return { status: 'requires-reconciliation' };
      }
    };
    const leaf = leaves.get(request.capability);
    if (!leaf || signal.aborted) return settle({ application: 'not-applied' });
    let remaining: number;
    try {
      remaining =
        Date.parse(claim.leaseExpiresAt) -
        Date.parse(IsoDateTimeSchema.parse(options.now()));
    } catch {
      return settle({ application: 'not-applied' });
    }
    if (remaining <= 0) return settle({ application: 'indeterminate' });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    const interrupted = new Promise<FinanceAutomationLeafResult>((resolve) => {
      abort = () => {
        controller.abort();
        resolve({ application: 'indeterminate' });
      };
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, Math.min(maximum, remaining));
    });
    let result: FinanceAutomationLeafResult;
    try {
      if (signal.aborted) {
        return await settle({ application: 'not-applied' });
      }
      // Crossing this invocation boundary makes thrown/invalid outcomes unknown.
      const work = Promise.resolve()
        .then(() =>
          controller.signal.aborted
            ? { application: 'not-applied' as const }
            : leaf({
                // The runtime object is deeply frozen before crossing the leaf
                // boundary; the contract remains the parsed mutable schema
                // type for existing leaf implementations.
                run: deepFreeze(run) as FinanceAutomationRun,
                targets: deepFreeze(intent.targets),
                leaseToken: claim.leaseToken,
                leaseExpiresAt: claim.leaseExpiresAt,
                signal: controller.signal,
              }),
        )
        .then((value) => {
          const checked = LeafResultSchema.safeParse(value);
          return checked.success
            ? checked.data
            : { application: 'indeterminate' as const };
        })
        .catch(() => ({ application: 'indeterminate' as const }));
      result = await Promise.race([work, interrupted]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
    return settle(result);
  };
}

/** Explicit composition hook. Existing worker startup does NOT call this; the
 * production composition must supply reviewed deterministic leaves first.
 * Retry ownership remains the canonical run store; pg-boss never blindly retries.
 */
export async function registerFinanceAutomationWorker(input: {
  readonly boss: Pick<PgBossCompatible, 'createQueue' | 'work'>;
  readonly dispatch: ReturnType<typeof createFinanceAutomationDispatcher>;
}): Promise<string> {
  await input.boss.createQueue(FINANCE_AUTOMATION_QUEUE, {
    retryLimit: 0,
    expireInSeconds: 120,
    retentionSeconds: 2592000,
    deleteAfterSeconds: 604800,
  });
  return input.boss.work(
    FINANCE_AUTOMATION_QUEUE,
    { batchSize: 1, localConcurrency: 1 },
    async (jobs: readonly PgBossJob[]) => {
      if (
        jobs.length !== 1 ||
        !jobs[0] ||
        jobs[0].name !== FINANCE_AUTOMATION_QUEUE ||
        !(jobs[0].signal instanceof AbortSignal)
      )
        throw new Error('automation-invalid-job');
      const payload = FinanceAutomationJobSchema.safeParse(jobs[0].data);
      if (
        !payload.success ||
        jobs[0].id !==
          financeAutomationQueueJobId(
            payload.data.operationId,
            payload.data.deliveryRevision,
          )
      )
        throw new Error('automation-invalid-job');
      return input.dispatch(
        payload.data.operationId,
        payload.data.deliveryRevision,
        jobs[0].signal,
      );
    },
  );
}
