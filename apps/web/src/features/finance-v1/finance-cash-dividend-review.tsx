import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CommitInvestmentCashDividendSchema,
  FinanceCurrencySchema,
  type FinanceCashDividendSourceSnapshot,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import {
  DividendApiError,
  dividendApi,
  dividendError,
  savedDividendMatchesCommit,
  type DividendCatalog,
  type DividendCommitInput,
  type DividendPlan,
  type DividendReceipt,
} from './finance-cash-dividend-api.js';
import {
  dividendAmountKinds,
  dividendAmountLabels,
  dividendBlockedCopy,
  dividendDraftFromReview,
  dividendFunctionalAmount,
  emptyDividendReview,
  type DividendAmountEntry,
  type DividendReviewEntry,
} from './finance-cash-dividend-fields.js';
import {
  DividendJournalPreview,
  dividendLedgerLabel,
} from './finance-cash-dividend-detail.js';

export function DividendReview({
  bookId,
  source,
  catalog,
  role,
  csrfToken,
  onClose,
  onRefreshSource,
  onViewSaved,
  onDenied,
}: {
  bookId: string;
  source: FinanceCashDividendSourceSnapshot;
  catalog: DividendCatalog;
  role: string;
  csrfToken?: string;
  onClose: () => void;
  onRefreshSource: () => void;
  onViewSaved: (id: string) => void;
  onDenied: () => void;
}) {
  const [entry, setEntry] = useState(() => emptyDividendReview(source));
  const [plan, setPlan] = useState<DividendPlan>(),
    [receipt, setReceipt] = useState<DividendReceipt>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [confirmed, setConfirmed] = useState(false),
    [stale, setStale] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [missing, setMissing] = useState(false);
  const alive = useRef(true),
    working = useRef(false),
    control = useRef<AbortController | undefined>(undefined);
  const actionId = useRef(crypto.randomUUID()),
    pending = useRef<DividendCommitInput | undefined>(undefined),
    previewHeading = useRef<HTMLHeadingElement>(null);
  const canPost = ['administrator', 'approver'].includes(role) && !!csrfToken;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      control.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (plan || receipt || uncertain) previewHeading.current?.focus();
  }, [plan, receipt, uncertain]);
  function fail(cause: unknown) {
    setError(dividendError(cause));
    if (
      cause instanceof DividendApiError &&
      [401, 403].includes(cause.status)
    ) {
      setPlan(undefined);
      setReceipt(undefined);
      pending.current = undefined;
      onDenied();
    }
  }
  async function act(work: (signal: AbortSignal) => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    control.current?.abort();
    const next = new AbortController();
    control.current = next;
    try {
      await work(next.signal);
    } catch (cause) {
      if (alive.current && !next.signal.aborted) fail(cause);
    } finally {
      working.current = false;
      if (alive.current && !next.signal.aborted) setBusy(false);
    }
  }
  const live = (signal: AbortSignal) => alive.current && !signal.aborted;
  function change<K extends keyof DividendReviewEntry>(
    key: K,
    value: DividendReviewEntry[K],
  ) {
    setEntry((current) => ({ ...current, [key]: value }));
    setConfirmed(false);
    setError('');
  }
  function amountChange(
    kind: (typeof dividendAmountKinds)[number],
    key: keyof DividendAmountEntry,
    value: string,
  ) {
    setEntry((current) => ({
      ...current,
      amounts: {
        ...current.amounts,
        [kind]: {
          ...current.amounts[kind],
          [key]: value,
          ...(key === 'currency'
            ? {
                fxRate: value === source.functionalCurrency ? '1' : '',
                fxSource: value === source.functionalCurrency ? 'identity' : '',
              }
            : {}),
        },
      },
    }));
    setConfirmed(false);
    setError('');
  }
  function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void act(async (signal) => {
      const action = dividendDraftFromReview(entry, source, actionId.current);
      try {
        const value = await dividendApi.preview(
          bookId,
          {
            action,
            expectedSourceRevision: source.sourceRevision,
            sourceSnapshotHash: source.sourceSnapshotHash,
          },
          signal,
        );
        if (live(signal)) {
          setPlan(value);
          setConfirmed(false);
          pending.current = undefined;
        }
      } catch (cause) {
        if (
          cause instanceof DividendApiError &&
          cause.status === 409 &&
          live(signal)
        )
          setStale(true);
        throw cause;
      }
    });
  }
  function post(retry = false) {
    if (
      !canPost ||
      (!retry && (!confirmed || plan?.commitReadiness !== 'ready')) ||
      (retry && (!uncertain || !missing || !pending.current))
    )
      return;
    void act(async (signal) => {
      const command = retry
        ? pending.current!
        : CommitInvestmentCashDividendSchema.parse({
            action: plan!.action,
            expectedSourceRevision: plan!.source.sourceRevision,
            sourceSnapshotHash: plan!.source.sourceSnapshotHash,
            idempotencyKey: crypto.randomUUID(),
          });
      pending.current = command;
      try {
        const value = await dividendApi.commit(
          bookId,
          command,
          csrfToken,
          signal,
        );
        if (live(signal)) {
          setReceipt(value);
          setUncertain(false);
          setMissing(false);
          setConfirmed(false);
          pending.current = undefined;
        }
      } catch (cause) {
        if (live(signal)) {
          if (
            cause instanceof DividendApiError &&
            [401, 403, 409, 400, 422].includes(cause.status)
          ) {
            pending.current = undefined;
            setPlan(undefined);
            setConfirmed(false);
            setStale(true);
          } else {
            setUncertain(true);
            setMissing(false);
            setConfirmed(false);
          }
        }
        throw cause;
      }
    });
  }
  function checkSaved() {
    const command = pending.current;
    if (!command) return;
    void act(async (signal) => {
      try {
        const saved = await dividendApi.detail(
          bookId,
          command.action.id,
          signal,
        );
        if (!savedDividendMatchesCommit(saved, command))
          throw new Error(
            'The saved action does not match this exact review. Keep the posting unresolved and refresh saved dividends.',
          );
        if (live(signal)) onViewSaved(saved.id);
      } catch (cause) {
        if (
          cause instanceof DividendApiError &&
          cause.status === 404 &&
          cause.code === 'finance-dividend-not-found'
        ) {
          if (live(signal)) {
            setMissing(true);
            setNotice(
              'No saved action was returned for this exact review. You may retry the identical posting request; its saved request key prevents a second posting.',
            );
          }
        } else throw cause;
      }
    });
  }
  const canEdit = !busy && !stale && !uncertain && !receipt;
  return (
    <section
      className="finance-dividend-review"
      aria-label="Cash dividend review"
    >
      <div className="finance-dividend-heading">
        <div>
          <span className="finance-dividend-eyebrow">
            {receipt
              ? 'Posting receipt'
              : plan
                ? 'Review before posting'
                : 'Amounts and source evidence'}
          </span>
          <h5 ref={previewHeading} tabIndex={-1}>
            {receipt
              ? 'Dividend posting confirmed'
              : uncertain
                ? 'Check this posting outcome'
                : plan
                  ? 'Review the dividend journal'
                  : 'Prepare a cash dividend'}
          </h5>
          <p>
            {source.description} · row {source.sourceRow} · source revision{' '}
            {source.sourceRevision}
          </p>
        </div>
        {!uncertain && (
          <Button
            type="button"
            variant="quiet"
            disabled={busy}
            onClick={onClose}
          >
            {receipt ? 'Close posting receipt' : 'Close dividend review'}
          </Button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {stale && (
        <div className="finance-dividend-notice">
          <p>
            Refresh the statement source before continuing. This replaces the
            unsaved review so its values can be checked against the new
            revision.
          </p>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onRefreshSource}
          >
            Refresh statement source
          </Button>
        </div>
      )}
      {uncertain ? (
        <div className="finance-dividend-notice">
          <p>
            The posting response was not confirmed. Its exact amounts and
            request key are retained while this review is open. Check the saved
            action before any retry.
          </p>
          <div className="finance-dividend-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={checkSaved}
            >
              Check saved dividend
            </Button>
            {missing && (
              <Button
                type="button"
                disabled={busy || !canPost}
                onClick={() => post(true)}
              >
                Retry exact posting
              </Button>
            )}
          </div>
        </div>
      ) : receipt ? (
        <div className="finance-dividend-confirmed">
          <p role="status">
            {receipt.replayed
              ? 'The existing dividend posting was returned. No second posting was made.'
              : 'The dividend was posted and the statement receipt was claimed.'}
          </p>
          <div className="finance-dividend-amount-summary">
            <div>
              <span>Gross dividend</span>
              <strong>
                {receipt.grossFunctionalAmount} {source.functionalCurrency}
              </strong>
            </div>
            <div>
              <span>Withholding tax</span>
              <strong>
                {receipt.withholdingFunctionalAmount}{' '}
                {source.functionalCurrency}
              </strong>
            </div>
            <div>
              <span>Net cash received</span>
              <strong>
                {receipt.netFunctionalAmount} {source.functionalCurrency}
              </strong>
            </div>
          </div>
          <p>
            Source revision {receipt.sourceRevision} →{' '}
            {receipt.nextSourceRevision}
          </p>
          <Button
            type="button"
            disabled={busy}
            onClick={() => onViewSaved(receipt.actionId)}
          >
            View saved dividend and evidence
          </Button>
          <details className="finance-dividend-provenance">
            <summary>Posting references</summary>
            <dl>
              <div>
                <dt>Journal</dt>
                <dd>
                  <code>{receipt.journalId}</code>
                </dd>
              </div>
              <div>
                <dt>Economic transaction</dt>
                <dd>
                  <code>{receipt.economicTransactionId}</code>
                </dd>
              </div>
              <div>
                <dt>Source fingerprint</dt>
                <dd>
                  <code>{receipt.sourceSnapshotHash}</code>
                </dd>
              </div>
            </dl>
          </details>
        </div>
      ) : plan ? (
        <>
          <div className="finance-dividend-amount-summary">
            {dividendAmountKinds.map((kind) => (
              <div key={kind}>
                <span>{dividendAmountLabels[kind]}</span>
                <strong>
                  {plan.action[kind]
                    ? `${plan.action[kind]!.functionalAmount} ${source.functionalCurrency}`
                    : 'Not established'}
                </strong>
                <small>
                  {plan.action[kind]
                    ? `${plan.action[kind]!.nativeAmount} ${plan.action[kind]!.currency}`
                    : 'Missing source amount'}
                </small>
              </div>
            ))}
          </div>
          <p>
            Declared {plan.action.declaredOn} · ex-dividend{' '}
            {plan.action.exDate ?? 'Not supplied'} · paid{' '}
            {plan.action.payableOn}
          </p>
          <p>{plan.action.reviewReason}</p>
          {plan.blockedReasons.length > 0 ? (
            <div className="finance-dividend-notice" role="status">
              <strong>This dividend needs further review</strong>
              <ul>
                {plan.blockedReasons.map((reason) => (
                  <li key={reason}>{dividendBlockedCopy[reason]}</li>
                ))}
              </ul>
            </div>
          ) : (
            <DividendJournalPreview plan={plan} catalog={catalog} />
          )}
          <details className="finance-dividend-provenance">
            <summary>
              Reviewed amounts, exchange rates and source locations
            </summary>
            <dl>
              {dividendAmountKinds.map((kind) => {
                const amount = plan.action[kind];
                return (
                  <div key={kind}>
                    <dt>{dividendAmountLabels[kind]}</dt>
                    <dd>
                      {amount ? (
                        <>
                          {amount.nativeAmount} {amount.currency} ×{' '}
                          {amount.fxRate} · {amount.fxSource}
                          <br />
                          Row {amount.provenance.sourceRow} ·{' '}
                          {amount.provenance.column ??
                            amount.provenance.contextAnchor}
                          <br />
                          Original value: {amount.provenance.raw}
                        </>
                      ) : (
                        'Not supplied'
                      )}
                    </dd>
                  </div>
                );
              })}
              <div>
                <dt>Source fingerprint</dt>
                <dd>
                  <code>{source.sourceSnapshotHash}</code>
                </dd>
              </div>
            </dl>
          </details>
          {plan.commitReadiness === 'ready' && (
            <div className="finance-dividend-confirm">
              <p>
                Posting creates this journal and claims this exact statement
                receipt. It does not change the investment quantity.
              </p>
              {canPost ? (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={!canEdit}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    <span>
                      I reviewed the original, all three amounts, exchange rates
                      and posting accounts. Post this dividend against source
                      revision {source.sourceRevision}.
                    </span>
                  </label>
                  <Button
                    type="button"
                    disabled={!canEdit || !confirmed}
                    onClick={() => post()}
                  >
                    Post reviewed dividend
                  </Button>
                </>
              ) : (
                <p>
                  An administrator or approver must review and post this
                  dividend.
                </p>
              )}
            </div>
          )}
          <Button
            type="button"
            variant="quiet"
            disabled={busy || stale}
            onClick={() => {
              setPlan(undefined);
              setConfirmed(false);
            }}
          >
            Return to amount review
          </Button>
        </>
      ) : (
        !stale && (
          <form className="finance-dividend-form" onSubmit={preview}>
            <fieldset disabled={busy}>
              <legend>1. Confirm the dividend and payment dates</legend>
              <div className="finance-dividend-fields">
                <label>
                  Declared date
                  <input
                    type="date"
                    required
                    value={entry.declaredOn}
                    onChange={(event) =>
                      change('declaredOn', event.target.value)
                    }
                  />
                </label>
                <label>
                  Ex-dividend date · optional
                  <input
                    type="date"
                    value={entry.exDate}
                    onChange={(event) => change('exDate', event.target.value)}
                  />
                </label>
                <label>
                  Payment date
                  <input
                    type="date"
                    required
                    value={entry.payableOn}
                    onChange={(event) =>
                      change('payableOn', event.target.value)
                    }
                  />
                </label>
                <label>
                  Dividend reference
                  <input
                    required
                    maxLength={500}
                    value={entry.sourceReference}
                    onChange={(event) =>
                      change('sourceReference', event.target.value)
                    }
                    placeholder="Statement or issuer reference"
                  />
                </label>
              </div>
            </fieldset>
            <fieldset disabled={busy}>
              <legend>2. Review all three source amounts</legend>
              <p>
                Transcribe each amount and its labelled source location from the
                original. Gross and withholding are not inferred from net cash.
                Record zero withholding only when supported by the original.
              </p>
              <div className="finance-dividend-amounts">
                {dividendAmountKinds.map((kind) => {
                  const amount = entry.amounts[kind],
                    fixed = kind === 'net',
                    functional = dividendFunctionalAmount(
                      amount,
                      source.functionalCurrency,
                    );
                  return (
                    <fieldset className="finance-dividend-amount" key={kind}>
                      <legend>{dividendAmountLabels[kind]}</legend>
                      {fixed && (
                        <p>
                          Amount, currency and exchange rate come from the
                          selected statement receipt.
                        </p>
                      )}
                      <div className="finance-dividend-fields">
                        <label>
                          Original currency amount
                          <input
                            inputMode="decimal"
                            value={amount.nativeAmount}
                            readOnly={fixed}
                            onChange={(event) =>
                              amountChange(
                                kind,
                                'nativeAmount',
                                event.target.value,
                              )
                            }
                            placeholder="Not established"
                          />
                        </label>
                        <label>
                          Original currency
                          <select
                            value={amount.currency}
                            disabled={fixed}
                            onChange={(event) =>
                              amountChange(kind, 'currency', event.target.value)
                            }
                          >
                            <option value="">Choose currency</option>
                            {FinanceCurrencySchema.options.map((currency) => (
                              <option key={currency}>{currency}</option>
                            ))}
                          </select>
                        </label>
                        {amount.currency !== source.functionalCurrency && (
                          <>
                            <label>
                              Exchange rate to {source.functionalCurrency}
                              <input
                                inputMode="decimal"
                                readOnly={fixed}
                                value={amount.fxRate}
                                onChange={(event) =>
                                  amountChange(
                                    kind,
                                    'fxRate',
                                    event.target.value,
                                  )
                                }
                              />
                            </label>
                            <label>
                              Exchange-rate source
                              <input
                                readOnly={fixed}
                                maxLength={200}
                                value={amount.fxSource}
                                onChange={(event) =>
                                  amountChange(
                                    kind,
                                    'fxSource',
                                    event.target.value,
                                  )
                                }
                              />
                            </label>
                          </>
                        )}
                        <label>
                          Exact value as printed
                          <input
                            maxLength={10_000}
                            value={amount.raw}
                            onChange={(event) =>
                              amountChange(kind, 'raw', event.target.value)
                            }
                          />
                        </label>
                        <label>
                          Source location type
                          <select
                            value={amount.locationKind}
                            onChange={(event) =>
                              amountChange(
                                kind,
                                'locationKind',
                                event.target.value,
                              )
                            }
                          >
                            <option value="column">Column heading</option>
                            <option value="section">Labelled section</option>
                          </select>
                        </label>
                        <label className="finance-dividend-span">
                          {amount.locationKind === 'column'
                            ? 'Exact source column heading'
                            : 'Exact source section label'}
                          <input
                            maxLength={
                              amount.locationKind === 'column' ? 200 : 300
                            }
                            value={amount.location}
                            onChange={(event) =>
                              amountChange(kind, 'location', event.target.value)
                            }
                          />
                        </label>
                      </div>
                      <p className="finance-dividend-conversion">
                        <span>Book amount</span>
                        <strong>
                          {functional === null
                            ? 'Not established'
                            : `${functional} ${source.functionalCurrency}`}
                        </strong>
                        {amount.currency === source.functionalCurrency && (
                          <small>Same currency · rate 1 (identity)</small>
                        )}
                      </p>
                    </fieldset>
                  );
                })}
              </div>
            </fieldset>
            <fieldset disabled={busy}>
              <legend>3. Confirm posting accounts and review notes</legend>
              <p>
                Cash account:{' '}
                <strong>
                  {dividendLedgerLabel(
                    catalog,
                    source.financialAccountLedgerId,
                  )}
                </strong>
              </p>
              <div className="finance-dividend-fields">
                <label>
                  Dividend income account
                  <select
                    required
                    value={entry.incomeAccountId}
                    onChange={(event) =>
                      change('incomeAccountId', event.target.value)
                    }
                  >
                    <option value="">Choose income account</option>
                    {catalog.ledger
                      .filter(
                        (account) =>
                          account.active &&
                          account.kind === 'income' &&
                          account.id !== source.financialAccountLedgerId,
                      )
                      .map((account) => (
                        <option value={account.id} key={account.id}>
                          {account.code} · {account.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Withholding account
                  <select
                    required
                    value={entry.withholdingAccountId}
                    onChange={(event) =>
                      change('withholdingAccountId', event.target.value)
                    }
                  >
                    <option value="">Choose withholding account</option>
                    {catalog.ledger
                      .filter(
                        (account) =>
                          account.active &&
                          ![
                            source.financialAccountLedgerId,
                            entry.incomeAccountId,
                          ].includes(account.id),
                      )
                      .map((account) => (
                        <option value={account.id} key={account.id}>
                          {account.code} · {account.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="finance-dividend-span">
                  Source review notes
                  <textarea
                    required
                    maxLength={2000}
                    value={entry.reviewReason}
                    onChange={(event) =>
                      change('reviewReason', event.target.value)
                    }
                    placeholder="Explain how the original supports these amounts and accounts."
                  />
                </label>
              </div>
            </fieldset>
            <div className="finance-dividend-actions">
              <Button type="submit" disabled={busy}>
                Preview dividend journal
              </Button>
              <span>Preview checks the current source. It does not post.</span>
            </div>
          </form>
        )
      )}
    </section>
  );
}
