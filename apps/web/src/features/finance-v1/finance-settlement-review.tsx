import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { FinanceSettlementPosting } from './finance-settlement-posting.js';
import {
  FinanceStockSplitSettlementPlanSchema,
  PreviewInvestmentStockSplitSettlementSchema,
  PreviewInvestmentStockSplitSettlementResultSchema,
  type FinanceStockSplitAction,
} from '@emdo/contracts/browser';
import {
  parseFinanceDecimal,
  formatFinanceDecimal,
} from '@emdo/domains/finance/decimal';
import { useAuth } from '../auth/auth-context.js';
import { Button } from '../../components/button.js';
import type { CorporateActionSource } from './finance-corporate-action-api.js';

export type FinanceStockSplitSettlementReviewProps = {
  bookId: string;
  role: string;
  source: CorporateActionSource & { action: FinanceStockSplitAction };
  evidence: Array<{ id: string; filename: string }>;
};
const Input = PreviewInvestmentStockSplitSettlementSchema;
const ResponseSchema = PreviewInvestmentStockSplitSettlementResultSchema;
type Plan = z.infer<typeof FinanceStockSplitSettlementPlanSchema>;

export function FinanceStockSplitSettlementReview(
  props: FinanceStockSplitSettlementReviewProps,
) {
  const auth = useAuth();
  if (auth.state && auth.state !== 'authenticated')
    return <p>Sign in to review and post settlements.</p>;
  return (
    <SettlementForm
      key={JSON.stringify([
        props.bookId,
        props.role,
        auth.sessionBinding,
        auth.state,
        props.source,
        props.evidence,
      ])}
      {...props}
    />
  );
}
function SettlementForm({
  bookId,
  role,
  source,
  evidence,
}: FinanceStockSplitSettlementReviewProps) {
  const [plan, setPlan] = useState<Plan>();
  const [postingLocked, setPostingLocked] = useState(false);
  const [reviewedInput, setReviewedInput] = useState<z.infer<typeof Input>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  const lots = source.sourceLots.filter(
    (lot) =>
      parseFinanceDecimal(lot.originalQuantity) >
      parseFinanceDecimal(lot.disposedQuantity),
  );
  const native = lots[0]?.nativeCurrency;
  const functional = lots[0]?.functionalCurrency;
  const field = (label: string, name: string, type = 'text') => (
    <label>
      {label}
      <input
        name={name}
        type={type}
        autoComplete="off"
        required
        inputMode={
          type === 'text' &&
          /(?:numerator|denominator|Cost|Cash|fxRate)$/.test(name)
            ? 'decimal'
            : undefined
        }
      />
    </label>
  );
  const rational = (label: string, name: string) => (
    <div className="finance-corporate-action__fields">
      {field(`${label} numerator`, `${name}.numerator`)}
      {field(`${label} denominator`, `${name}.denominator`)}
    </div>
  );
  const evidenceField = (label: string, name: string) => (
    <label>
      {label}
      <select name={name} defaultValue="" required>
        <option value="" disabled>
          Select evidence
        </option>
        {evidence.map((document) => (
          <option key={document.id} value={document.id}>
            {document.filename}
          </option>
        ))}
      </select>
    </label>
  );
  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || blocked || postingLocked) return;
    setPlan(undefined);
    setReviewedInput(undefined);
    setError('');
    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? '').trim();
    const quantity = (name: string) => ({
      numerator: value(`${name}.numerator`),
      denominator: value(`${name}.denominator`),
    });
    let input: z.infer<typeof Input>;
    try {
      input = Input.parse({
        action: source.action,
        expectedSourceRevision: source.sourceRevision,
        sourceSnapshotHash: source.sourceSnapshotHash,
        deliveredQuantity: quantity('delivered'),
        cashDisposedQuantity: quantity('cash'),
        allocations: lots.map((lot, i) => ({
          sourceLotId: lot.id,
          retainedQuantity: quantity(`lot${i}.retained`),
          cashDisposedQuantity: quantity(`lot${i}.cash`),
          retainedNativeCost: value(`lot${i}.retainedNativeCost`),
          disposedNativeCost: value(`lot${i}.disposedNativeCost`),
          retainedFunctionalCost: value(`lot${i}.retainedFunctionalCost`),
          disposedFunctionalCost: value(`lot${i}.disposedFunctionalCost`),
        })),
        allocationReview: {
          evidenceId: value('allocationEvidence'),
          sourceReference: value('allocationReference'),
        },
        cashConsideration: {
          native: { amount: value('nativeCash'), currency: native },
          functional: { amount: value('functionalCash'), currency: functional },
          settledOn: value('settledOn'),
          evidenceId: value('cashEvidence'),
          sourceReference: value('cashReference'),
          fx:
            native === functional
              ? null
              : { rate: value('fxRate'), source: value('fxSource') },
        },
      });
      if (
        ![
          input.allocationReview.evidenceId,
          input.cashConsideration.evidenceId,
        ].every((id) => evidence.some((document) => document.id === id))
      )
        throw new Error('evidence');
    } catch {
      setError(
        'Complete every settlement field with valid exact quantities, decimal amounts, dates and evidence. Denominators must be positive integers.',
      );
      return;
    }
    const next = new AbortController();
    controller.current = next;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v2/finance/books/${bookId}/investments/corporate-actions/stock-splits/settlement-preview`,
        {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
          signal: next.signal,
        },
      );
      if (next.signal.aborted) return;
      if (!response.ok) {
        if ([401, 403, 409].includes(response.status)) setBlocked(true);
        throw new Error(
          response.status === 409
            ? 'The source lots changed. Refresh the stock split source before reviewing again.'
            : [401, 403].includes(response.status)
              ? 'Book access changed. Refresh this book to continue.'
              : response.status === 503
                ? 'Settlement preview is unavailable. Try again when accounting is ready.'
                : 'The settlement could not be validated. Check quantities, cost conservation, cash and evidence.',
        );
      }
      const result = ResponseSchema.parse(await response.json());
      if (next.signal.aborted) return;
      if (
        result.sourceRevision !== source.sourceRevision ||
        result.sourceSnapshotHash !== source.sourceSnapshotHash ||
        result.plan.actionId !== source.action.id ||
        result.plan.financialAccountId !== source.action.financialAccountId ||
        result.plan.instrumentId !== source.action.instrumentId ||
        result.plan.effectiveOn !== source.action.effectiveOn
      )
        throw new Error(
          'The preview does not match this source. Refresh the stock split source.',
        );
      setPlan(result.plan);
      setReviewedInput(input);
    } catch (cause) {
      if (!next.signal.aborted)
        setError(
          cause instanceof z.ZodError
            ? 'The settlement response could not be verified. Refresh the source.'
            : cause instanceof Error
              ? cause.message
              : 'Unable to preview settlement.',
        );
    } finally {
      if (!next.signal.aborted) setBusy(false);
    }
  }
  if (!['administrator', 'approver'].includes(role))
    return (
      <p>
        Settlement reviews are available to administrators and approvers for
        this book.
      </p>
    );
  return (
    <section
      className="finance-corporate-action finance-surface"
      aria-label="Cash-in-lieu settlement review"
    >
      <h4>Review cash-in-lieu settlement</h4>
      <p>
        Enter the broker-delivered shares, cash settlement and reviewed
        allocation for each remaining lot. Quantities use exact
        numerator/denominator pairs; costs are never allocated automatically.
      </p>
      <p>
        Source date {source.sourceAsOf} · revision {source.sourceRevision}. This
        preview does not save or post a settlement. Tax treatment is not
        assessed.
      </p>
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={preview}
        noValidate
        className="finance-corporate-action__form"
        onChange={() => {
          setPlan(undefined);
          setReviewedInput(undefined);
          setError('');
        }}
      >
        <fieldset disabled={busy || blocked || postingLocked || !lots.length}>
          <legend>Account settlement quantities</legend>
          {rational('Delivered shares', 'delivered')}
          {rational('Cash-disposed shares', 'cash')}
        </fieldset>
        {lots.map((lot, i) => (
          <fieldset key={lot.id} disabled={busy || blocked || postingLocked}>
            <legend>
              Lot {i + 1} · acquired {lot.acquiredOn}
            </legend>
            <p>
              {lot.sourceReference} · {lot.id}
            </p>
            <p>
              Remaining quantity{' '}
              {formatFinanceDecimal(
                parseFinanceDecimal(lot.originalQuantity) -
                  parseFinanceDecimal(lot.disposedQuantity),
              )}
              ; remaining basis{' '}
              {formatFinanceDecimal(
                parseFinanceDecimal(lot.originalNativeCost) -
                  parseFinanceDecimal(lot.allocatedNativeCost),
              )}{' '}
              {lot.nativeCurrency} /{' '}
              {formatFinanceDecimal(
                parseFinanceDecimal(lot.originalFunctionalCost) -
                  parseFinanceDecimal(lot.allocatedFunctionalCost),
              )}{' '}
              {lot.functionalCurrency}.
            </p>
            {rational(`Lot ${i + 1} retained shares`, `lot${i}.retained`)}
            {rational(`Lot ${i + 1} cash-disposed shares`, `lot${i}.cash`)}
            <div className="finance-corporate-action__fields">
              {field(
                `Lot ${i + 1} retained native cost (${lot.nativeCurrency})`,
                `lot${i}.retainedNativeCost`,
              )}
              {field(
                `Lot ${i + 1} disposed native cost (${lot.nativeCurrency})`,
                `lot${i}.disposedNativeCost`,
              )}
              {field(
                `Lot ${i + 1} retained functional cost (${lot.functionalCurrency})`,
                `lot${i}.retainedFunctionalCost`,
              )}
              {field(
                `Lot ${i + 1} disposed functional cost (${lot.functionalCurrency})`,
                `lot${i}.disposedFunctionalCost`,
              )}
            </div>
          </fieldset>
        ))}
        <fieldset disabled={busy || blocked || postingLocked}>
          <legend>Allocation review evidence</legend>
          {evidenceField('Allocation evidence', 'allocationEvidence')}
          {field('Allocation reference', 'allocationReference')}
        </fieldset>
        <fieldset disabled={busy || blocked || postingLocked}>
          <legend>Cash settlement evidence</legend>
          <div className="finance-corporate-action__fields">
            {field(
              `Native cash (${native ?? 'native currency'})`,
              'nativeCash',
            )}
            {field(
              `Functional cash (${functional ?? 'book currency'})`,
              'functionalCash',
            )}
            {field('Settlement date', 'settledOn', 'date')}
            {evidenceField('Cash evidence', 'cashEvidence')}
            {field('Cash reference', 'cashReference')}
            {native !== functional && (
              <>
                {field('Cash FX rate', 'fxRate')}
                {field('Cash FX source', 'fxSource')}
              </>
            )}
          </div>
          {native === functional && (
            <p>
              Cash currencies match; native and functional amounts must be
              equal.
            </p>
          )}
        </fieldset>
        <Button
          type="submit"
          disabled={busy || blocked || postingLocked || !lots.length}
        >
          {busy ? 'Validating settlement…' : 'Preview settlement'}
        </Button>
      </form>
      {plan && (
        <section aria-label="Validated settlement plan" role="status">
          <h5>Validated settlement plan</h5>
          <p>Settlement date: {plan.settledOn}</p>
          <p>
            Account entitlement: {plan.accountEntitlement.numerator}/
            {plan.accountEntitlement.denominator} shares. Delivered:{' '}
            {plan.deliveredQuantity.numerator}/
            {plan.deliveredQuantity.denominator}. Cash-disposed:{' '}
            {plan.cashDisposedQuantity.numerator}/
            {plan.cashDisposedQuantity.denominator}.
          </p>
          <p>
            Native basis conserved: {plan.sourceNativeCost} ={' '}
            {plan.retainedNativeCost} retained + {plan.disposedNativeCost}{' '}
            disposed ({plan.nativeCurrency}).
          </p>
          <p>
            Functional basis conserved: {plan.sourceFunctionalCost} ={' '}
            {plan.retainedFunctionalCost} retained +{' '}
            {plan.disposedFunctionalCost} disposed ({plan.functionalCurrency}).
          </p>
          <p>
            Receipt-value difference: {plan.nativeBookGainLoss}{' '}
            {plan.nativeCurrency} / {plan.functionalBookGainLoss}{' '}
            {plan.functionalCurrency}.
          </p>
          <p>
            Validated quantities and cost allocation. Posting status appears
            below. Action-date book gain/loss and settlement FX are separated
            when posted. Tax treatment is not assessed.
          </p>
        </section>
      )}
      {plan && reviewedInput && (
        <FinanceSettlementPosting
          key={JSON.stringify(reviewedInput)}
          bookId={bookId}
          onLockChange={setPostingLocked}
          sourceRevision={source.sourceRevision}
          sourceSnapshotHash={source.sourceSnapshotHash}
          settlement={{
            source: {
              action: reviewedInput.action,
              sourceAsOf: source.sourceAsOf,
              sourceBoundary: source.sourceBoundary,
              sourceLots: source.sourceLots,
            },
            deliveredQuantity: reviewedInput.deliveredQuantity,
            cashDisposedQuantity: reviewedInput.cashDisposedQuantity,
            allocations: reviewedInput.allocations,
            cashConsideration: reviewedInput.cashConsideration,
            allocationReview: reviewedInput.allocationReview,
          }}
        />
      )}
    </section>
  );
}
