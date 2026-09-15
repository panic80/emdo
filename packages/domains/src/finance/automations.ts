import {
  FinanceAutomationCurrentAuthoritySchema,
  FinanceAutomationGrantSchema,
  FinanceAutomationRunSchema,
  FinanceAutomationUsageSchema,
  IsoDateTimeSchema,
  UuidSchema,
  deepFreeze,
  type FinanceAutomationRun,
  type DeepReadonly,
} from '@emdo/contracts';
import { boundedFinanceParse } from './guard.js';
import { moneyValue } from './decimal.js';

export type FinanceAutomationDenial =
  | 'invalid-input'
  | 'scope-mismatch'
  | 'grant-revoked'
  | 'grant-revised'
  | 'grant-not-yet-valid'
  | 'grant-expired'
  | 'authority-not-fresh'
  | 'membership-inactive'
  | 'book-unavailable'
  | 'entitlement-disabled'
  | 'authority-changed'
  | 'capability-forbidden'
  | 'limit-exceeded'
  | 'run-not-runnable'
  | 'attempts-exhausted';
export type FinanceAutomationExecutionDecision =
  | { readonly status: 'denied'; readonly reason: FinanceAutomationDenial }
  | { readonly status: 'duplicate'; readonly outcomeReference: string }
  | {
      readonly status: 'authorized';
      readonly operationId: string;
      readonly requestHash: string;
      readonly grantRevision: number;
      readonly nextAttempt: number;
    };

/** Pure policy decision, NOT a minted worker/capability permit. The trusted
 * execution store must load canonical run/grant/current authority, lock usage,
 * evaluate with transaction time, reserve limits, and CAS the run in the SAME
 * transaction immediately before dispatch. Existing WorkerExecutionPermit and
 * lease/payload binding remain required. Do not construct a browser principal.
 */
export function evaluateFinanceAutomationExecution(input: {
  readonly now: unknown;
  readonly run: unknown;
  readonly grant: unknown;
  readonly authority: unknown;
  readonly usage: unknown;
}): FinanceAutomationExecutionDecision {
  const deny = (
    reason: FinanceAutomationDenial,
  ): FinanceAutomationExecutionDecision =>
    deepFreeze({ status: 'denied', reason });
  const time = boundedFinanceParse(IsoDateTimeSchema, input.now);
  const r = boundedFinanceParse(FinanceAutomationRunSchema, input.run);
  const g = boundedFinanceParse(FinanceAutomationGrantSchema, input.grant);
  const a = boundedFinanceParse(
    FinanceAutomationCurrentAuthoritySchema,
    input.authority,
  );
  const u = boundedFinanceParse(FinanceAutomationUsageSchema, input.usage);
  if (!time.success || !r.success || !g.success || !a.success || !u.success)
    return deny('invalid-input');
  const run = r.data,
    grant = g.data,
    authority = a.data,
    usage = u.data;
  const request = run.request;
  if (
    request.grantId !== grant.id ||
    usage.grantId !== grant.id ||
    request.workspaceId !== grant.workspaceId ||
    request.bookId !== grant.bookId ||
    authority.workspaceId !== grant.workspaceId ||
    authority.bookId !== grant.bookId ||
    authority.userId !== grant.grantedByUserId
  )
    return deny('scope-mismatch');
  if (grant.status !== 'active') return deny('grant-revoked');
  if (request.grantRevision !== grant.revision) return deny('grant-revised');
  const now = Date.parse(time.data);
  if (now < Date.parse(grant.validFrom)) return deny('grant-not-yet-valid');
  if (now >= Date.parse(grant.expiresAt)) return deny('grant-expired');
  if (Date.parse(authority.checkedAt) !== now)
    return deny('authority-not-fresh');
  if (authority.membershipStatus !== 'active')
    return deny('membership-inactive');
  if (authority.bookStatus !== 'active' || authority.bookRole === null)
    return deny('book-unavailable');
  if (!authority.automationEntitled) return deny('entitlement-disabled');
  for (const key of ['membership', 'bookAccess', 'entitlement'] as const) {
    if (authority.authorityRevision[key] !== grant.authorityRevision[key])
      return deny('authority-changed');
  }
  if (
    !grant.allowedCapabilities.includes(request.capability) ||
    !authority.allowedCapabilities.includes(request.capability) ||
    (request.capability !== 'finance.reports.generate' &&
      authority.bookRole !== 'administrator' &&
      authority.bookRole !== 'preparer' &&
      authority.bookRole !== 'approver')
  ) {
    return deny('capability-forbidden');
  }
  // Return only the canonical stored outcome, after current access checks.
  if (run.status === 'completed')
    return deepFreeze({
      status: 'duplicate',
      outcomeReference: run.outcomeReference!,
    });
  if (run.status !== 'queued' && run.status !== 'retryable')
    return deny('run-not-runnable');
  if (run.attempts >= grant.limits.maxAttemptsPerRun)
    return deny('attempts-exhausted');
  const limits = grant.limits;
  const amount = moneyValue(request.amount, request.currency);
  if (
    request.currency !== limits.currency ||
    usage.currency !== limits.currency ||
    request.itemCount > limits.maxItemsPerRun ||
    BigInt(usage.runs) + 1n > BigInt(limits.maxRuns) ||
    BigInt(usage.items) + BigInt(request.itemCount) >
      BigInt(limits.maxTotalItems) ||
    amount > moneyValue(limits.maxAmountPerRun, limits.currency) ||
    moneyValue(usage.amount, usage.currency) + amount >
      moneyValue(limits.maxTotalAmount, limits.currency)
  )
    return deny('limit-exceeded');
  return deepFreeze({
    status: 'authorized',
    operationId: request.operationId,
    requestHash: request.requestHash,
    grantRevision: grant.revision,
    nextAttempt: run.attempts + 1,
  });
}

export type FinanceAutomationRunEvent =
  | {
      readonly type: 'execute';
      readonly grant: unknown;
      readonly authority: unknown;
      readonly usage: unknown;
      readonly now: unknown;
    }
  | { readonly type: 'applied'; readonly outcomeReference: string }
  | { readonly type: 'not-applied' }
  | { readonly type: 'indeterminate' };

/** Store owns lease validation and compare-and-swap of expected revision; only
 * trusted executor settlement may emit applied/not-applied/indeterminate.
 * Lease loss/unknown effects require reconciliation, NEVER an automatic retry.
 */
export function transitionFinanceAutomationRun(
  rawRun: unknown,
  expectedRevision: number,
  event: FinanceAutomationRunEvent,
):
  | {
      readonly status: 'changed' | 'unchanged';
      readonly run: DeepReadonly<FinanceAutomationRun>;
    }
  | { readonly status: 'rejected'; readonly reason: string } {
  const parsed = boundedFinanceParse(FinanceAutomationRunSchema, rawRun);
  if (!parsed.success) return { status: 'rejected', reason: 'invalid-input' };
  const run = parsed.data;
  if (
    run.revision !== expectedRevision ||
    run.revision >= Number.MAX_SAFE_INTEGER
  )
    return { status: 'rejected', reason: 'revision-conflict' };
  const change = (patch: Partial<FinanceAutomationRun>) =>
    deepFreeze({
      status: 'changed' as const,
      run: { ...run, ...patch, revision: run.revision + 1 },
    });
  if (event.type === 'execute') {
    const decision = evaluateFinanceAutomationExecution({ ...event, run });
    if (decision.status === 'duplicate')
      return deepFreeze({ status: 'unchanged', run });
    if (decision.status === 'denied') {
      if (run.status !== 'queued' && run.status !== 'retryable')
        return { status: 'rejected', reason: decision.reason };
      return change({ status: 'blocked' });
    }
    return change({ status: 'executing', attempts: decision.nextAttempt });
  }
  if (event.type === 'applied') {
    if (!UuidSchema.safeParse(event.outcomeReference).success)
      return { status: 'rejected', reason: 'invalid-outcome' };
    if (
      run.status === 'completed' &&
      run.outcomeReference === event.outcomeReference
    )
      return deepFreeze({ status: 'unchanged', run });
    if (run.status !== 'executing')
      return { status: 'rejected', reason: 'invalid-transition' };
    return change({
      status: 'completed',
      outcomeReference: event.outcomeReference,
    });
  }
  if (run.status !== 'executing')
    return { status: 'rejected', reason: 'invalid-transition' };
  if (event.type === 'not-applied') return change({ status: 'retryable' });
  if (event.type === 'indeterminate')
    return change({ status: 'requires-reconciliation' });
  return { status: 'rejected', reason: 'invalid-transition' };
}
