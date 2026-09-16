import { useEffect, useRef, useState } from 'react';
import {
  FinanceStandardizationReconciliationSchema,
  LookupFinanceStandardizationReceiptSchema,
  ResolveFinanceStandardizationSchema,
  type FinanceStandardizationRun,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { useAuth } from '../auth/auth-context.js';
import {
  StandardizationRequestError,
  standardizationMutation,
} from './finance-standardization-api.js';
import {
  cadMinorText,
  readReconciliation,
  reconciliationChoices,
  reconciliationError,
  reconciliationPath,
  verifyReconciliation,
  type StandardizationReconciliation,
} from './finance-standardization-reconciliation-api.js';
import './finance-standardization-reconciliation.css';

type Decision =
  'confirm-not-sent' | 'accept-actual-cost' | 'retain-reserved-cost';
const eligible = (status: string) =>
  ['indeterminate', 'cancelled', 'authority-revoked'].includes(status);
const statusCopy: Record<string, string> = {
  reserved: 'Cost reserved',
  completed: 'Actual cost recorded',
  'not-sent': 'Not sent',
  indeterminate: 'Outcome not established',
  pending: 'Receipt requested',
  verified: 'Receipt verified',
  unavailable: 'Receipt unavailable',
  mismatch: 'Receipt does not match',
  blocked: 'Analysis blocked',
  cancelled: 'Cancelled',
  'authority-revoked': 'Authorization changed',
};
const dispatchCopy = {
  unknown: 'Sending status not established',
  'not-dispatched': 'Saved proof: request was not sent',
  'dispatch-started': 'Analysis attempt started; cost needs evidence',
};
const observedTime = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
export function FinanceStandardizationReconciliation({
  run,
  role,
  onUpdated,
}: {
  run: FinanceStandardizationRun;
  role: string;
  onUpdated: () => Promise<void>;
}) {
  const auth = useAuth();
  if (role !== 'administrator')
    return eligible(run.status) ? (
      <p className="finance-standardization-boundary">
        An administrator can review the saved outcome and any reserved analysis
        cost.
      </p>
    ) : null;
  return (
    <ReconciliationWorkspace
      key={`${auth.sessionBinding}:${auth.state}:${run.id}`}
      run={run}
      onUpdated={onUpdated}
      {...(auth.csrfToken ? { csrfToken: auth.csrfToken } : {})}
      authenticated={!auth.state || auth.state === 'authenticated'}
    />
  );
}
function ReconciliationWorkspace({
  run,
  onUpdated,
  csrfToken,
  authenticated,
}: {
  run: FinanceStandardizationRun;
  onUpdated: () => Promise<void>;
  csrfToken?: string;
  authenticated: boolean;
}) {
  const [opened, setOpened] = useState(false),
    [record, setRecord] = useState<StandardizationReconciliation>();
  const [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [reservationId, setReservationId] = useState(''),
    [receiptId, setReceiptId] = useState('');
  const [decision, setDecision] = useState<Decision>(),
    [confirmed, setConfirmed] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const alive = useRef(true),
    working = useRef(false),
    readController = useRef<AbortController | undefined>(undefined),
    actionController = useRef<AbortController | undefined>(undefined);
  const post = useRef(standardizationMutation()).current;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      readController.current?.abort();
      actionController.current?.abort();
    };
  }, []);
  function failed(cause: unknown) {
    setError(reconciliationError(cause));
    if (
      cause instanceof StandardizationRequestError &&
      [401, 403].includes(cause.status)
    ) {
      setRecord(undefined);
      setDecision(undefined);
      setConfirmed(false);
    }
  }
  async function load(quiet = false) {
    if (!authenticated) return;
    readController.current?.abort();
    const control = new AbortController();
    readController.current = control;
    if (!quiet) {
      setBusy(true);
      setError('');
      setDecision(undefined);
      setConfirmed(false);
    }
    try {
      const value = await readReconciliation(run, control.signal);
      if (alive.current && !control.signal.aborted) {
        setRecord(value);
        setOpened(true);
        setUncertain(false);
      }
    } catch (cause) {
      if (alive.current && !control.signal.aborted) {
        setRecord(undefined);
        failed(cause);
      }
    } finally {
      if (alive.current && !control.signal.aborted) setBusy(false);
      if (readController.current === control)
        readController.current = undefined;
    }
  }
  const pending = !!record?.receipts.some(
    (receipt) => receipt.status === 'pending',
  );
  useEffect(() => {
    if (!opened || !pending || !authenticated) return;
    const tick = () => {
      if (
        document.visibilityState !== 'hidden' &&
        !working.current &&
        !readController.current
      )
        void load(true);
    };
    const timer = window.setInterval(tick, 5000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [opened, pending, authenticated]);
  const selected = record
    ? reconciliationChoices(record, reservationId, receiptId)
    : undefined;
  useEffect(() => {
    setConfirmed(false);
    setDecision(undefined);
  }, [
    record?.revision,
    reservationId,
    receiptId,
    selected?.receipt?.status,
    selected?.receipt?.receiptDigest,
    selected?.reservation?.status,
    selected?.reservation?.dispatchPhase,
  ]);
  const locked = busy || saving || uncertain || !authenticated || !csrfToken;
  async function mutate(kind: 'lookup' | 'resolve') {
    if (!record || locked || working.current || !selected) return;
    if (kind === 'lookup' && !selected.canRequestReceipt) return;
    if (
      kind === 'resolve' &&
      (!confirmed ||
        !decision ||
        (decision === 'confirm-not-sent'
          ? !selected.canConfirmNotSent
          : decision === 'retain-reserved-cost'
            ? !selected.canRetainReservation
            : !selected.canAcceptActual))
    )
      return;
    working.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    readController.current?.abort();
    const control = new AbortController();
    actionController.current = control;
    try {
      const payload =
        kind === 'lookup'
          ? LookupFinanceStandardizationReceiptSchema.parse({
              expectedRevision: record.revision,
              reservationId,
            })
          : ResolveFinanceStandardizationSchema.parse({
              expectedRevision: record.revision,
              reservationId: selected.reservation?.id ?? null,
              decision,
              receiptId:
                decision === 'accept-actual-cost' &&
                selected.reservation?.status !== 'completed'
                  ? (selected.receipt?.id ?? null)
                  : null,
              acknowledgeNoApproval: true,
            });
      const raw = await post(
        `${reconciliationPath(run)}/${kind}`,
        payload,
        FinanceStandardizationReconciliationSchema.refine(
          (value) =>
            value.bookId === run.bookId &&
            value.runId === run.id &&
            value.sourceDigest === run.sourceDigest,
          'Outcome receipt does not match the selected analysis.',
        ),
        control.signal,
        csrfToken,
      );
      const result = verifyReconciliation(raw, run);
      if (!alive.current || control.signal.aborted) return;
      setRecord(result);
      setDecision(undefined);
      setConfirmed(false);
      setUncertain(false);
      setNotice(
        kind === 'lookup'
          ? 'Receipt lookup saved. Its verified result will appear here when available; missing provider data does not establish that no request was sent.'
          : 'Outcome resolution saved. No mapping was approved or imported. Earlier unresolved reservations may still prevent a retry; any retry remains a separate action with current permission checks.',
      );
      if (kind === 'resolve') await onUpdated();
    } catch (cause) {
      if (alive.current && !control.signal.aborted) {
        failed(cause);
        setUncertain(true);
      }
    } finally {
      working.current = false;
      if (alive.current && !control.signal.aborted) {
        setSaving(false);
        setBusy(false);
      }
    }
  }
  if (!eligible(run.status) && !opened) return null;
  const receipts =
    record?.receipts
      .filter((receipt) => receipt.reservationId === reservationId)
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt)) ??
    [];
  return (
    <section
      className="finance-outcome"
      aria-label="Analysis outcome reconciliation"
    >
      <div className="finance-outcome-heading">
        <div>
          <span className="finance-standardization-eyebrow">
            Administrator review
          </span>
          <h6>Reconcile the saved outcome</h6>
          <p>
            Review saved sending evidence and analysis costs before resolving an
            uncertain outcome. This cannot approve a report mapping or import
            financial records.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={busy || saving || !authenticated}
          onClick={() => void load()}
        >
          {opened ? 'Refresh outcome evidence' : 'Review outcome evidence'}
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {uncertain && (
        <p className="finance-outcome-notice">
          The last action needs a status check. Refresh outcome evidence before
          trying another action.
        </p>
      )}
      {record && (
        <>
          <div className="finance-outcome-summary">
            <span>
              {statusCopy[record.status] ?? record.status.replaceAll('-', ' ')}
            </span>
            <span>Saved revision {record.revision}</span>
          </div>
          {record.hasLiveLease && (
            <p className="finance-outcome-notice">
              The analysis is still being processed. Outcome resolution remains
              unavailable until that work stops.
            </p>
          )}
          {!!record.spend.length && (
            <fieldset
              className="finance-outcome-attempts"
              disabled={busy || saving}
            >
              <legend>Choose the saved attempt to review</legend>
              {record.spend.map((spend) => (
                <label
                  key={spend.id}
                  data-selected={reservationId === spend.id}
                >
                  <input
                    type="radio"
                    name={`outcome-attempt-${run.id}`}
                    value={spend.id}
                    checked={reservationId === spend.id}
                    onChange={() => {
                      setReservationId(spend.id);
                      setReceiptId('');
                    }}
                  />
                  <span>
                    <strong>
                      Attempt {spend.attempt} · {statusCopy[spend.status]}
                    </strong>
                    <span>
                      Reserved {cadMinorText(spend.reservedCadMinor)} · Actual{' '}
                      {cadMinorText(spend.actualCadMinor)}
                    </span>
                    <small>{dispatchCopy[spend.dispatchPhase]}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {!record.spend.length && (
            <p className="finance-outcome-notice">
              No provider cost reservation is saved for this analysis. An
              explicit outcome decision is still required.
            </p>
          )}
          {selected?.reservation && (
            <div className="finance-outcome-evidence">
              <h6>
                Saved receipt evidence · attempt {selected.reservation.attempt}
              </h6>
              {!selected.isLatest && (
                <p className="finance-outcome-notice">
                  This is an earlier attempt. Its saved receipts remain
                  reviewable, but only the latest attempt can receive an outcome
                  resolution here.
                </p>
              )}
              {!selected.reservation.providerResponseId && (
                <p>
                  No provider response reference is saved. A lookup cannot
                  establish an outcome for this attempt.
                </p>
              )}
              {!!selected.reservation.providerResponseId &&
                !receipts.length && (
                  <p>No receipt lookup is saved for this attempt.</p>
                )}
              {receipts.map((receipt) => (
                <article key={receipt.id} className="finance-outcome-receipt">
                  <strong>{statusCopy[receipt.status]}</strong>
                  <p>
                    {receipt.status === 'verified'
                      ? `Recorded cost ${cadMinorText(receipt.actualCadMinor)}. Observed ${observedTime(receipt.observedAt)}.`
                      : receipt.status === 'unavailable'
                        ? 'The provider did not supply a usable receipt. This is not proof that no request was sent; the reserved cost stays unresolved.'
                        : receipt.status === 'mismatch'
                          ? 'The returned evidence does not match this attempt. It cannot be used to establish actual cost.'
                          : 'The lookup is saved and waiting for verification. This page refreshes while visible.'}
                  </p>
                  {receipt.status === 'verified' && (
                    <label>
                      <input
                        type="radio"
                        name={`outcome-receipt-${run.id}`}
                        value={receipt.id}
                        checked={receiptId === receipt.id}
                        disabled={locked}
                        onChange={() => setReceiptId(receipt.id)}
                      />
                      Use this verified receipt for the cost review
                    </label>
                  )}
                  <details>
                    <summary>Receipt reference</summary>
                    <dl>
                      <div>
                        <dt>Exact observation time</dt>
                        <dd>
                          <time dateTime={receipt.observedAt}>
                            {receipt.observedAt}
                          </time>
                        </dd>
                      </div>
                      <div>
                        <dt>Provider reference</dt>
                        <dd>
                          <code>{receipt.providerResponseId}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Receipt fingerprint</dt>
                        <dd>
                          <code>
                            {receipt.receiptDigest ?? 'Not established'}
                          </code>
                        </dd>
                      </div>
                      <div>
                        <dt>Observed usage</dt>
                        <dd>
                          {receipt.inputTokens === null
                            ? 'Not established'
                            : `${receipt.inputTokens} input tokens / ${receipt.outputTokens ?? 'unknown'} output tokens`}
                        </dd>
                      </div>
                    </dl>
                  </details>
                </article>
              ))}
              {selected.canRequestReceipt && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={locked}
                  onClick={() => void mutate('lookup')}
                >
                  {receipts.length
                    ? 'Request another receipt lookup'
                    : 'Request provider receipt'}
                </Button>
              )}
              {!!receipts.length && selected.canRequestReceipt && (
                <p>
                  A new lookup may recover provider evidence that was
                  temporarily unavailable. Existing reservations remain held
                  until a separate evidence-supported resolution.
                </p>
              )}
              <details className="finance-outcome-audit">
                <summary>Saved cost basis and provenance</summary>
                <dl>
                  <div>
                    <dt>Reservation reference</dt>
                    <dd>
                      <code>{selected.reservation.id}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Pricing version</dt>
                    <dd>{selected.reservation.pricingVersion}</dd>
                  </div>
                  <div>
                    <dt>Saved rate per million tokens</dt>
                    <dd>
                      {selected.reservation.pricing
                        ? `${cadMinorText(selected.reservation.pricing.inputCadMinorPerMillionTokens)} input / ${cadMinorText(selected.reservation.pricing.outputCadMinorPerMillionTokens)} output`
                        : 'Not established'}
                    </dd>
                  </div>
                  <div>
                    <dt>Original fingerprint</dt>
                    <dd>
                      <code>{record.sourceDigest}</code>
                    </dd>
                  </div>
                </dl>
              </details>
            </div>
          )}
          {selected?.canConfirmNotSent ||
          selected?.canAcceptActual ||
          selected?.canRetainReservation ? (
            <div className="finance-outcome-resolution">
              <h6>Review the saved outcome and cost</h6>
              <div className="finance-standardization-actions">
                {selected.canConfirmNotSent && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={locked}
                    onClick={() => {
                      setDecision('confirm-not-sent');
                      setConfirmed(false);
                    }}
                  >
                    Review not-sent resolution
                  </Button>
                )}
                {selected.canRetainReservation && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={locked}
                    onClick={() => {
                      setDecision('retain-reserved-cost');
                      setConfirmed(false);
                    }}
                  >
                    Retain{' '}
                    {cadMinorText(selected.reservation!.reservedCadMinor)} for
                    separate retry
                  </Button>
                )}
                {selected.canAcceptActual && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={locked}
                    onClick={() => {
                      setDecision('accept-actual-cost');
                      setConfirmed(false);
                    }}
                  >
                    Review recorded cost
                  </Button>
                )}
              </div>
              {decision && (
                <section
                  aria-label="Confirm analysis outcome resolution"
                  className="finance-outcome-confirm"
                >
                  <strong>
                    {decision === 'confirm-not-sent'
                      ? 'Confirm the saved request was not sent'
                      : decision === 'retain-reserved-cost'
                        ? `Keep the full ${cadMinorText(selected.reservation!.reservedCadMinor)} reserved`
                        : `Accept the evidenced actual cost: ${cadMinorText(selected.actualCost)}`}
                  </strong>
                  <p>
                    {decision === 'confirm-not-sent'
                      ? record.spend.length
                        ? 'The saved dispatch record states that this request was not sent. This is the evidence for releasing the unused reservation.'
                        : 'No provider cost reservation exists for this analysis.'
                      : decision === 'retain-reserved-cost'
                        ? 'The actual provider charge remains unknown. The full reservation stays counted against the existing budget. A separate retry uses the same saved original and may incur another charge, subject to current authorization and limits.'
                        : 'The actual cost comes from saved settlement or verified provider evidence. No amount can be entered or overridden here.'}
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={locked}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    {decision === 'retain-reserved-cost'
                      ? 'I reviewed this exact attempt and acknowledge that the actual charge is uncertain and the full reserved cost remains held. This does not approve, import, post, or retry the report.'
                      : 'I reviewed this exact saved evidence and understand that this resolves the analysis outcome only. It does not approve, import, or retry the report.'}
                  </label>
                  <Button
                    type="button"
                    disabled={locked || !confirmed}
                    onClick={() => void mutate('resolve')}
                  >
                    Save outcome resolution
                  </Button>
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={saving}
                    onClick={() => {
                      setDecision(undefined);
                      setConfirmed(false);
                    }}
                  >
                    Keep unresolved
                  </Button>
                </section>
              )}
            </div>
          ) : (
            eligible(record.status) &&
            !record.hasLiveLease && (
              <p className="finance-outcome-notice">
                The selected evidence does not yet support a resolution. Unknown
                sending status or an unavailable receipt cannot release a
                reserved cost. Select an attempt or a verified receipt when
                available.
              </p>
            )
          )}
          {!!record.resolutions.length && (
            <details className="finance-outcome-audit">
              <summary>
                Saved resolution history · {record.resolutions.length}
              </summary>
              <ul>
                {record.resolutions.map((resolution) => (
                  <li key={resolution.id}>
                    <strong>
                      {resolution.decision === 'confirm-not-sent'
                        ? 'Confirmed not sent'
                        : resolution.decision === 'retain-reserved-cost'
                          ? 'Retained full reserved cost; retry requires a separate action'
                          : 'Accepted evidenced actual cost'}
                    </strong>
                    <span>
                      {resolution.reviewedAt} · reviewed by{' '}
                      {resolution.reviewedBy}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
