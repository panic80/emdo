import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  FinanceStockSplitActionSchema,
  FinanceStockSplitPlanSchema,
} from '@emdo/contracts/browser';
import { planInvestmentStockSplit } from '@emdo/domains/finance/corporate-actions';
import { Button } from '../../components/button.js';
import { useAuth } from '../auth/auth-context.js';
import {
  financeCorporateActionApi,
  type CorporateActionApiInput,
  type CorporateActionSource,
  type FinancialAccount,
  type InvestmentCatalog,
  type InvestmentEvidence,
  type InvestmentLotView,
  type InvestmentStockSplitCommit,
} from './finance-corporate-action-api.js';
import './finance-corporate-actions.css';
import { FinanceStockSplitSettlementReview } from './finance-settlement-review.js';

type ActionType = 'split' | 'reverse-split';
type FractionalTreatment = 'unknown' | 'retain' | 'cash-in-lieu';
type Plan = z.infer<typeof FinanceStockSplitPlanSchema>;

type Draft = {
  actionType: ActionType;
  numerator: string;
  denominator: string;
  effectiveOn: string;
  financialAccountId: string;
  instrumentId: string;
  evidenceId: string;
  sourceReference: string;
  fractionalTreatment: FractionalTreatment;
};

const emptyDraft: Draft = {
  actionType: 'split',
  numerator: '2',
  denominator: '1',
  effectiveOn: '',
  financialAccountId: '',
  instrumentId: '',
  evidenceId: '',
  sourceReference: '',
  fractionalTreatment: 'unknown',
};

const blockedReasonCopy: Record<Plan['blockedReasons'][number], string> = {
  'fractional-entitlement-review-required':
    'A fractional share entitlement needs an explicit supported policy.',
  'fractional-quantity-not-representable':
    'The resulting fractional quantity cannot be represented at the system precision.',
  'fractional-policy-required':
    'Choose a supported fractional-share policy before committing.',
  'cash-in-lieu-consideration-missing':
    'Cash-in-lieu consideration and evidence are missing.',
  'cash-in-lieu-basis-treatment-unsupported':
    'Review the settlement and posting accounts below before posting cash in lieu.',
};

const readableError = (error: unknown): string => {
  if (error instanceof z.ZodError)
    return 'The server returned an unsupported source shape. Refresh the book and try again.';
  return error instanceof Error
    ? error.message
    : 'Unable to finish this investment action.';
};

const makeUuid = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function')
    return globalThis.crypto.randomUUID();
  // This branch is only for older test/browser runtimes. The server validates
  // the UUID shape; no financial value is derived from this identifier.
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  const hex = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
};

const shortId = (value: string): string =>
  value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;

const recordLabel = (
  record: Record<string, unknown>,
  fallback: string,
): string => {
  const values = [
    record.name,
    record.symbol,
    record.ticker,
    record.kind,
    record.currency,
    record.id,
  ].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return values.length ? values.join(' · ') : fallback;
};

const evidenceDate = (value: string): string => value.slice(0, 10);

const fractionLabel = (effect: Plan['effects'][number]): string => {
  const fraction = effect.fractionalEntitlement;
  if (!fraction) return 'None';
  return `${fraction.wholeShareQuantity} whole + ${fraction.remainderNumerator}/${fraction.remainderDenominator} share${fraction.representable ? ' · representable' : ' · unavailable'}`;
};

/**
 * A reviewed stock-split workflow for the investment book. The browser only
 * selects evidence and source identifiers, invokes the shared deterministic
 * planner, and submits the exact reviewed snapshot to the CAS-protected API.
 */
export function FinanceStockSplitReview({
  bookId,
  role,
}: {
  bookId: string;
  role: string;
}) {
  const auth = useAuth();
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [catalog, setCatalog] = useState<InvestmentCatalog>();
  const [evidence, setEvidence] = useState<InvestmentEvidence[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [source, setSource] = useState<CorporateActionSource>();
  const [plan, setPlan] = useState<Plan>();
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [commitResult, setCommitResult] =
    useState<InvestmentStockSplitCommit>();
  const [currentLots, setCurrentLots] = useState<InvestmentLotView[]>([]);
  const alive = useRef(true);
  const working = useRef(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const actionId = useRef(makeUuid());
  const pendingCommit = useRef<
    { body: string; input: CorporateActionApiInput } | undefined
  >(undefined);

  const canReview = ['administrator', 'approver'].includes(role);
  const canCommit = canReview;
  const brokerageAccounts = accounts.filter(
    (account) => account.kind === 'brokerage' && account.active !== false,
  );
  const instruments = catalog?.instruments ?? [];
  const readyForPreview = Boolean(
    draft.effectiveOn &&
    draft.financialAccountId &&
    draft.instrumentId &&
    draft.evidenceId &&
    draft.sourceReference.trim(),
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);

  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    try {
      await work(next.signal);
    } catch (failure) {
      if (alive.current && !next.signal.aborted)
        setError(readableError(failure));
    } finally {
      working.current = false;
      if (alive.current && !next.signal.aborted) setBusy(false);
    }
  }

  function resetReview() {
    actionId.current = makeUuid();
    pendingCommit.current = undefined;
    setSource(undefined);
    setPlan(undefined);
    setCommitResult(undefined);
    setReviewConfirmed(false);
    setNotice('');
  }

  function changeDraft<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    resetReview();
  }

  function openReview() {
    void run(async (signal) => {
      resetReview();
      const [nextAccounts, nextCatalog, nextEvidence] = await Promise.all([
        financeCorporateActionApi.readAccounts(bookId, signal),
        financeCorporateActionApi.readInvestments(bookId, signal),
        financeCorporateActionApi.readEvidence(bookId, signal),
      ]);
      if (!alive.current || signal.aborted) return;
      setAccounts(nextAccounts);
      setCatalog(nextCatalog);
      setEvidence(nextEvidence);
      setOpened(true);
      setNotice(
        `${nextEvidence.length} evidence document${nextEvidence.length === 1 ? '' : 's'} available for review.`,
      );
    });
  }

  function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async (signal) => {
      const action = FinanceStockSplitActionSchema.parse({
        id: actionId.current,
        actionType: draft.actionType,
        financialAccountId: draft.financialAccountId,
        instrumentId: draft.instrumentId,
        effectiveOn: draft.effectiveOn,
        numerator: draft.numerator,
        denominator: draft.denominator,
        fractionalTreatment: draft.fractionalTreatment,
        evidenceId: draft.evidenceId,
        sourceReference: draft.sourceReference,
        cashInLieu: null,
      });
      const nextSource = await financeCorporateActionApi.readSource(
        bookId,
        action,
        signal,
      );
      const nextPlan = FinanceStockSplitPlanSchema.parse(
        planInvestmentStockSplit({
          action,
          sourceAsOf: nextSource.sourceAsOf,
          sourceBoundary: nextSource.sourceBoundary,
          sourceLots: nextSource.sourceLots,
        }),
      );
      if (!alive.current || signal.aborted) return;
      setSource(nextSource);
      setPlan(nextPlan);
      setReviewConfirmed(false);
      setCommitResult(undefined);
      pendingCommit.current = undefined;
      setNotice('Deterministic source snapshot is ready for review.');
    });
  }

  function commit() {
    if (
      !plan ||
      !source ||
      plan.commitReadiness !== 'ready' ||
      !reviewConfirmed
    )
      return;
    void run(async (signal) => {
      const candidate: CorporateActionApiInput = {
        action: plan.action,
        sourceAsOf: source.sourceAsOf,
        sourceBoundary: source.sourceBoundary,
        sourceLots: source.sourceLots,
        expectedSourceRevision: source.sourceRevision,
        idempotencyKey: makeUuid(),
      };
      const body = JSON.stringify(candidate);
      // Keep the original command and idempotency key across transport
      // retries. Form changes clear this ref through resetReview().
      if (!pendingCommit.current)
        pendingCommit.current = { body, input: candidate };
      const pending = pendingCommit.current;
      const result = await financeCorporateActionApi.commit(
        bookId,
        pending.input,
        auth.csrfToken,
        signal,
      );
      if (!alive.current || signal.aborted) return;
      setCommitResult(result);
      pendingCommit.current = undefined;
      setReviewConfirmed(false);
      try {
        const lots = await financeCorporateActionApi.readLots(bookId, signal);
        if (alive.current && !signal.aborted) setCurrentLots(lots);
        setNotice(
          `${result.replayed ? 'Commit replay confirmed' : 'Stock split committed'}; successor lots refreshed from the book.`,
        );
      } catch (refreshFailure) {
        setError(
          `${result.replayed ? 'Commit replay confirmed' : 'Stock split committed'}, but successor lots could not be refreshed: ${readableError(refreshFailure)}`,
        );
      }
    });
  }

  if (!canReview)
    return (
      <section
        className="finance-corporate-action finance-surface"
        aria-label="Stock split review"
      >
        <div className="finance-corporate-action__heading">
          <div>
            <p className="finance-corporate-action__eyebrow">
              Investment operations
            </p>
            <h4>Stock split review</h4>
          </div>
        </div>
        <p>
          Stock split reviews are available to administrators and approvers for
          this book.
        </p>
      </section>
    );

  return (
    <section
      className="finance-corporate-action finance-surface"
      aria-label="Stock split review"
    >
      <div className="finance-corporate-action__heading">
        <div>
          <p className="finance-corporate-action__eyebrow">
            Investment operations
          </p>
          <h4>Review a stock split</h4>
          <p>
            Select the broker evidence and exact ratio. EMDO will show the
            source lots, unchanged cost basis, and successor lots before an
            authorized commit.
          </p>
        </div>
        <Button variant="quiet" disabled={busy} onClick={openReview}>
          {opened ? 'Refresh sources' : 'Review a stock split'}
        </Button>
      </div>

      {error && (
        <div className="finance-corporate-action__error" role="alert">
          <span>{error}</span>
          {opened && (
            <Button variant="quiet" disabled={busy} onClick={openReview}>
              Refresh sources
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p
          className="finance-corporate-action__notice"
          role="status"
          aria-live="polite"
        >
          {notice}
        </p>
      )}

      {!opened && !error && (
        <p className="finance-corporate-action__empty">
          This review requires a book snapshot and an evidence document. Open
          the sources when you are ready to prepare the action.
        </p>
      )}

      {opened && catalog && (
        <>
          <form
            className="finance-corporate-action__form"
            onSubmit={preview}
            noValidate
          >
            <fieldset disabled={busy}>
              <legend>Action details</legend>
              <div className="finance-corporate-action__fields">
                <label>
                  Action type
                  <select
                    value={draft.actionType}
                    onChange={(event) =>
                      changeDraft(
                        'actionType',
                        event.target.value as ActionType,
                      )
                    }
                  >
                    <option value="split">Forward split</option>
                    <option value="reverse-split">Reverse split</option>
                  </select>
                </label>
                <label>
                  Split ratio numerator
                  <input
                    value={draft.numerator}
                    onChange={(event) =>
                      changeDraft('numerator', event.target.value)
                    }
                    inputMode="decimal"
                    autoComplete="off"
                    required
                    aria-describedby="finance-split-ratio-help"
                  />
                </label>
                <label>
                  Split ratio denominator
                  <input
                    value={draft.denominator}
                    onChange={(event) =>
                      changeDraft('denominator', event.target.value)
                    }
                    inputMode="decimal"
                    autoComplete="off"
                    required
                    aria-describedby="finance-split-ratio-help"
                  />
                </label>
                <label>
                  Effective date
                  <input
                    type="date"
                    value={draft.effectiveOn}
                    onChange={(event) =>
                      changeDraft('effectiveOn', event.target.value)
                    }
                    required
                  />
                </label>
              </div>
              <p
                id="finance-split-ratio-help"
                className="finance-corporate-action__hint"
              >
                Use 2:1 for a forward split (2 new shares for each old share)
                and 1:2 for a reverse split (1 new share for each 2 old shares).
                Enter the exact share ratio; EMDO preserves both values for the
                accounting preview.
              </p>
            </fieldset>

            <fieldset disabled={busy}>
              <legend>Book sources</legend>
              <div className="finance-corporate-action__fields">
                <label>
                  Brokerage account
                  <select
                    value={draft.financialAccountId}
                    onChange={(event) =>
                      changeDraft('financialAccountId', event.target.value)
                    }
                    required
                  >
                    <option value="" disabled>
                      Select account
                    </option>
                    {brokerageAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {recordLabel(
                          account as unknown as Record<string, unknown>,
                          account.id,
                        )}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Instrument
                  <select
                    value={draft.instrumentId}
                    onChange={(event) =>
                      changeDraft('instrumentId', event.target.value)
                    }
                    required
                  >
                    <option value="" disabled>
                      Select instrument
                    </option>
                    {instruments.map((instrument) => (
                      <option key={instrument.id} value={instrument.id}>
                        {recordLabel(instrument, instrument.id)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Evidence document
                  <select
                    value={draft.evidenceId}
                    onChange={(event) =>
                      changeDraft('evidenceId', event.target.value)
                    }
                    required
                  >
                    <option value="" disabled>
                      Select evidence
                    </option>
                    {evidence.map((document) => (
                      <option key={document.id} value={document.id}>
                        {document.filename} · {document.format} ·{' '}
                        {evidenceDate(document.createdAt)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Source reference
                  <input
                    value={draft.sourceReference}
                    onChange={(event) =>
                      changeDraft('sourceReference', event.target.value)
                    }
                    placeholder="Broker notice or statement reference"
                    autoComplete="off"
                    required
                  />
                </label>
              </div>
            </fieldset>

            <fieldset disabled={busy}>
              <legend>Fractional shares</legend>
              <label>
                Fractional-share policy
                <select
                  value={draft.fractionalTreatment}
                  onChange={(event) =>
                    changeDraft(
                      'fractionalTreatment',
                      event.target.value as FractionalTreatment,
                    )
                  }
                >
                  <option value="unknown">Require review</option>
                  <option value="retain">
                    Retain supported fractional shares
                  </option>
                  <option value="cash-in-lieu">
                    Review cash-in-lieu settlement
                  </option>
                </select>
              </label>
              <p className="finance-corporate-action__hint">
                Cash-in-lieu can be reviewed and posted in the settlement
                workflow below. Unresolved fractional results cannot use the
                stock-split-only commit.
              </p>
            </fieldset>

            <Button type="submit" disabled={busy || !readyForPreview}>
              {plan ? 'Refresh preview' : 'Preview deterministic result'}
            </Button>
          </form>

          {plan && source && (
            <div className="finance-corporate-action__review">
              <div className="finance-corporate-action__review-heading">
                <div>
                  <p className="finance-corporate-action__eyebrow">
                    Review checkpoint
                  </p>
                  <h4>Split preview</h4>
                </div>
                <span
                  className={`finance-corporate-action__status finance-corporate-action__status--${
                    commitResult ? 'committed' : plan.commitReadiness
                  }`}
                >
                  {commitResult
                    ? commitResult.replayed
                      ? 'Commit replayed'
                      : 'Committed'
                    : plan.commitReadiness === 'ready'
                      ? 'Ready to commit'
                      : 'Blocked'}
                </span>
              </div>
              <dl className="finance-corporate-action__summary">
                <div>
                  <dt>Source revision</dt>
                  <dd>{source.sourceRevision}</dd>
                </div>
                <div>
                  <dt>Snapshot boundary</dt>
                  <dd>{source.sourceBoundary}</dd>
                </div>
                <div>
                  <dt>Source lots</dt>
                  <dd>{plan.sourceLotCount}</dd>
                </div>
                {plan.accountEntitlement && (
                  <div>
                    <dt>Account share entitlement</dt>
                    <dd>
                      {plan.accountEntitlement.decimalQuantity ??
                        `${plan.accountEntitlement.numerator}/${plan.accountEntitlement.denominator}`}
                      {' shares'}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Successor lots</dt>
                  <dd>{plan.successorLotCount}</dd>
                </div>
                <div>
                  <dt>Native basis carried</dt>
                  <dd>{plan.successorNativeCostBasis}</dd>
                </div>
                <div>
                  <dt>Functional basis carried</dt>
                  <dd>{plan.successorFunctionalCostBasis}</dd>
                </div>
              </dl>
              {plan.accountEntitlement && (
                <p>
                  This is the exact total across source lots. Individual lot
                  fractions do not determine the broker’s cash settlement.
                </p>
              )}
              <p className="finance-corporate-action__hash">
                Snapshot {source.sourceAsOf} · {source.sourceSnapshotHash}
              </p>

              {plan.commitReadiness === 'blocked' && (
                <div
                  className="finance-corporate-action__blocked"
                  role="status"
                >
                  <strong>Commit remains blocked</strong>
                  <ul>
                    {plan.blockedReasons.map((reason) => (
                      <li key={reason}>{blockedReasonCopy[reason]}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div
                className="finance-table-scroll finance-corporate-action__table-wrap"
                tabIndex={0}
              >
                <table>
                  <caption>Source lots and proposed successor lots</caption>
                  <thead>
                    <tr>
                      <th>Source lot</th>
                      <th>Remaining quantity</th>
                      <th>Successor quantity</th>
                      <th>Cost basis carried</th>
                      <th>Fractional entitlement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.effects.map((effect) => (
                      <tr key={effect.sourceLotId}>
                        <th scope="row">{shortId(effect.sourceLotId)}</th>
                        <td>{effect.sourceRemainingQuantity}</td>
                        <td>{effect.successorQuantity ?? 'Unavailable'}</td>
                        <td>
                          {effect.successorNativeCostBasis}{' '}
                          {effect.successorLot?.nativeCurrency ?? ''}
                          <br />
                          {effect.successorFunctionalCostBasis}{' '}
                          {effect.successorLot?.functionalCurrency ?? ''}
                        </td>
                        <td>{fractionLabel(effect)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <label className="finance-corporate-action__confirm">
                <input
                  type="checkbox"
                  checked={reviewConfirmed}
                  onChange={(event) => setReviewConfirmed(event.target.checked)}
                  disabled={
                    busy ||
                    plan.commitReadiness !== 'ready' ||
                    Boolean(commitResult)
                  }
                />
                I reviewed the source snapshot and proposed successor lots.
              </label>

              {canCommit ? (
                <Button
                  disabled={
                    busy ||
                    plan.commitReadiness !== 'ready' ||
                    !reviewConfirmed ||
                    Boolean(commitResult)
                  }
                  onClick={commit}
                >
                  {commitResult
                    ? commitResult.replayed
                      ? 'Commit replay confirmed'
                      : 'Stock split committed'
                    : pendingCommit.current
                      ? 'Retry commit'
                      : 'Commit reviewed stock split'}
                </Button>
              ) : (
                <p className="finance-corporate-action__hint">
                  An administrator or approver must commit this reviewed action.
                </p>
              )}
            </div>
          )}

          {source && plan?.action.fractionalTreatment === 'cash-in-lieu' && (
            <FinanceStockSplitSettlementReview
              bookId={bookId}
              role={role}
              source={{ ...source, action: plan.action }}
              evidence={evidence}
            />
          )}

          {commitResult && (
            <div className="finance-corporate-action__committed" role="status">
              <strong>
                {commitResult.replayed
                  ? 'Commit replay confirmed'
                  : 'Stock split committed'}
              </strong>
              <span>
                {commitResult.effectCount} lot effect
                {commitResult.effectCount === 1 ? '' : 's'} recorded; source
                revision advanced from {commitResult.sourceRevision} to{' '}
                {commitResult.nextSourceRevision}.
              </span>
            </div>
          )}

          {commitResult && (
            <div className="finance-corporate-action__lots">
              <div className="finance-corporate-action__review-heading">
                <div>
                  <p className="finance-corporate-action__eyebrow">
                    Post-commit readback
                  </p>
                  <h4>Current successor lots</h4>
                </div>
                <span className="finance-corporate-action__count">
                  {currentLots.length} active
                </span>
              </div>
              {!currentLots.length ? (
                <p>No active lot positions were returned after the commit.</p>
              ) : (
                <div
                  className="finance-table-scroll finance-corporate-action__table-wrap"
                  tabIndex={0}
                >
                  <table>
                    <caption>
                      Current lot positions after the stock split
                    </caption>
                    <thead>
                      <tr>
                        <th>Lot</th>
                        <th>Acquired</th>
                        <th>Quantity</th>
                        <th>Remaining native basis</th>
                        <th>Remaining functional basis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentLots.map((lot) => (
                        <tr key={lot.id}>
                          <th scope="row">{shortId(lot.id)}</th>
                          <td>{lot.acquiredOn}</td>
                          <td>{lot.remainingQuantity}</td>
                          <td>
                            {lot.remainingNativeCost} {lot.nativeCurrency}
                          </td>
                          <td>
                            {lot.remainingFunctionalCost}{' '}
                            {lot.functionalCurrency}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
