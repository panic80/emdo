import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { z } from 'zod';
import {
  FinanceCurrencySchema,
  FinanceDecimalSchema,
  UuidSchema,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { useAuth } from '../auth/auth-context.js';

const CommercialView = z.object({
  currency: FinanceCurrencySchema,
  parties: z.array(
    z.object({
      id: UuidSchema,
      name: z.string(),
      kind: z.string(),
      reference: z.string(),
    }),
  ),
  documents: z.array(
    z.object({
      id: UuidSchema,
      kind: z.enum(['sales-invoice', 'supplier-bill']),
      partyId: UuidSchema,
      partyName: z.string(),
      reference: z.string(),
      issuedOn: z.string(),
      dueOn: z.string(),
      status: z.enum(['draft', 'issued', 'void']),
      total: FinanceDecimalSchema,
      paid: FinanceDecimalSchema,
      outstanding: FinanceDecimalSchema,
      journalId: UuidSchema.nullable(),
      voidJournalId: UuidSchema.nullable(),
      sourceReference: z.string(),
    }),
  ),
  payments: z.array(
    z.object({
      id: UuidSchema,
      direction: z.string(),
      status: z.enum(['posted', 'void']),
      voidJournalId: UuidSchema.nullable(),
      reference: z.string(),
      total: FinanceDecimalSchema,
      effectiveOn: z.string(),
      journalId: UuidSchema,
      sourceReference: z.string(),
    }),
  ),
});
interface Account {
  id: string;
  name: string;
  code: string;
  kind: string;
}
export const displayDecimal = (value: string) =>
  value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
const field = (data: FormData, name: string) => String(data.get(name) ?? '');
export function FinanceCommercial({
  bookId,
  role,
  accounts,
  onSaved,
}: {
  bookId: string;
  role: string;
  accounts: readonly Account[];
  onSaved: () => void;
}) {
  const auth = useAuth();
  const [view, setView] = useState<z.infer<typeof CommercialView>>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<'sales-invoice' | 'supplier-bill'>(
    'sales-invoice',
  );
  const [lineCount, setLineCount] = useState(1);
  const [paymentParty, setPaymentParty] = useState('');
  const [direction, setDirection] = useState('receipt');
  const mounted = useRef(true);
  const pending = useRef<
    { body: string; path: string; key: string } | undefined
  >(undefined);
  const canPrepare = role !== 'viewer',
    canPost = role === 'administrator' || role === 'approver';
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(
        `/api/v2/finance/books/${bookId}/commercial`,
        {
          credentials: 'same-origin',
          cache: 'no-store',
          ...(signal ? { signal } : {}),
        },
      );
      if (!response.ok)
        throw new Error(
          'Unable to load invoices and payments. Refresh your access and try again.',
        );
      const result = CommercialView.parse(await response.json());
      if (mounted.current && !signal?.aborted) setView(result);
    },
    [bookId],
  );
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal).catch((e) => {
      if (!controller.signal.aborted && mounted.current)
        setError(e instanceof Error ? e.message : 'Unable to load records.');
    });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [load]);
  async function command(path: string, payload: unknown) {
    if (busy || !auth.csrfToken) return;
    const body = JSON.stringify(payload);
    if (pending.current?.path !== path || pending.current.body !== body)
      pending.current = { path, body, key: crypto.randomUUID() };
    const key = pending.current.key;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/v2/finance/books/${bookId}/${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': auth.csrfToken,
          'idempotency-key': key,
        },
        body,
      });
      if (!response.ok) {
        const problem = z
          .object({ detail: z.string() })
          .safeParse(await response.json());
        throw new Error(
          problem.success
            ? problem.data.detail
            : 'The operation was not completed. Check dates, accounts, and outstanding amounts.',
        );
      }
      if (!mounted.current) return;
      pending.current = undefined;
      setNotice('Saved to the book.');
      await load();
      if (mounted.current) onSaved();
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error
            ? e.message
            : 'The result could not be confirmed. Retry the same request to avoid duplication.',
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function submit(
    event: FormEvent<HTMLFormElement>,
    path: string,
    build: (data: FormData) => unknown,
  ) {
    event.preventDefault();
    void command(path, build(new FormData(event.currentTarget)));
  }
  const accountOptions = (kinds: readonly string[]) =>
    accounts
      .filter((account) => kinds.includes(account.kind))
      .map((account) => (
        <option key={account.id} value={account.id}>
          {account.code} · {account.name}
        </option>
      ));
  const partyOptions = view?.parties.map((party) => (
    <option key={party.id} value={party.id}>
      {party.name} · {party.reference}
    </option>
  ));
  return (
    <section
      aria-label="Receivables and payables"
      className="open-section finance-commercial"
    >
      <h3>Receivables and payables</h3>
      <p>
        Record invoices, bills, and payments in{' '}
        {view?.currency ?? 'the book currency'}. Tax amounts come from the
        source document.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {view ? (
        <>
          <div
            className="finance-table-scroll"
            tabIndex={0}
            aria-label="Financial records table"
          >
            <table>
              <caption>Invoices and bills ({view.currency})</caption>
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Outstanding</th>
                  <th>Party</th>
                  <th>Due</th>
                  <th>Total</th>
                  <th>Paid</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {view.documents.map((doc) => (
                  <tr key={doc.id}>
                    <th scope="row">
                      <details>
                        <summary>{doc.reference}</summary>
                        <p>{doc.kind}</p>
                        <p>Source: {doc.sourceReference}</p>
                        <p>Journal: {doc.journalId ?? 'Not posted'}</p>
                        {doc.voidJournalId ? (
                          <p>Reversal: {doc.voidJournalId}</p>
                        ) : null}
                        {canPost &&
                        doc.status === 'issued' &&
                        /^0(?:\.0+)?$/.test(doc.paid) ? (
                          <form
                            onSubmit={(event) =>
                              submit(
                                event,
                                `commercial-documents/${doc.id}/void`,
                                (data) => ({
                                  effectiveOn: field(data, 'date'),
                                  reason: field(data, 'reason'),
                                }),
                              )
                            }
                          >
                            <label>
                              Reversal date{' '}
                              <input
                                type="date"
                                name="date"
                                required
                                min={doc.issuedOn}
                              />
                            </label>
                            <label>
                              Reason for voiding{' '}
                              <input
                                name="reason"
                                required
                                minLength={3}
                                maxLength={500}
                              />
                            </label>
                            <Button
                              type="submit"
                              disabled={busy || !auth.csrfToken}
                            >
                              Void unpaid document
                            </Button>
                          </form>
                        ) : null}
                      </details>
                    </th>
                    <td>{displayDecimal(doc.outstanding)}</td>
                    <td>{doc.partyName}</td>
                    <td>{doc.dueOn}</td>
                    <td>{displayDecimal(doc.total)}</td>
                    <td>{displayDecimal(doc.paid)}</td>
                    <td>{doc.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!view.documents.length ? (
            <p>No invoices or bills recorded.</p>
          ) : null}
          <h4>Recorded payments</h4>
          {view.payments.length ? (
            <ul>
              {view.payments.map((payment) => (
                <li key={payment.id}>
                  <details>
                    <summary>
                      {payment.effectiveOn} · {payment.reference} ·{' '}
                      {displayDecimal(payment.total)} {view.currency}
                    </summary>
                    <p>{payment.direction}</p>
                    <p>Source: {payment.sourceReference}</p>
                    <p>Journal: {payment.journalId}</p>
                    <p>Status: {payment.status}</p>
                    {payment.voidJournalId ? (
                      <p>Reversal: {payment.voidJournalId}</p>
                    ) : null}
                    {canPost && payment.status === 'posted' ? (
                      <form
                        onSubmit={(event) =>
                          submit(
                            event,
                            `payments/${payment.id}/void`,
                            (data) => ({
                              effectiveOn: field(data, 'date'),
                              reason: field(data, 'reason'),
                            }),
                          )
                        }
                      >
                        <label>
                          Payment reversal date{' '}
                          <input
                            name="date"
                            type="date"
                            required
                            min={payment.effectiveOn}
                          />
                        </label>
                        <label>
                          Reason for payment reversal{' '}
                          <input
                            name="reason"
                            required
                            minLength={3}
                            maxLength={500}
                          />
                        </label>
                        <Button
                          type="submit"
                          disabled={busy || !auth.csrfToken}
                        >
                          Void recorded payment
                        </Button>
                      </form>
                    ) : null}
                  </details>
                </li>
              ))}
            </ul>
          ) : (
            <p>No payments recorded.</p>
          )}
        </>
      ) : null}
      {canPrepare ? (
        <details>
          <summary>Set up accounts, periods, and parties</summary>
          <form
            onSubmit={(event) =>
              submit(event, 'accounts', (data) => ({
                code: field(data, 'code'),
                name: field(data, 'name'),
                kind: field(data, 'kind'),
              }))
            }
          >
            <h4>Add ledger account</h4>
            <label>
              Account code <input name="code" required maxLength={32} />
            </label>
            <label>
              Account name <input name="name" required maxLength={200} />
            </label>
            <label>
              Account type{' '}
              <select name="kind">
                {['asset', 'liability', 'equity', 'income', 'expense'].map(
                  (value) => (
                    <option key={value}>{value}</option>
                  ),
                )}
              </select>
            </label>
            <Button type="submit" disabled={busy || !auth.csrfToken}>
              Add account
            </Button>
          </form>
          <form
            onSubmit={(event) =>
              submit(event, 'periods', (data) => ({
                startsOn: field(data, 'start'),
                endsOn: field(data, 'end'),
              }))
            }
          >
            <h4>Open fiscal period</h4>
            <label>
              Period start <input type="date" name="start" required />
            </label>
            <label>
              Period end <input type="date" name="end" required />
            </label>
            <Button type="submit" disabled={busy || !auth.csrfToken}>
              Create period
            </Button>
          </form>
          <form
            onSubmit={(event) =>
              submit(event, 'parties', (data) => ({
                name: field(data, 'name'),
                kind: field(data, 'kind'),
                reference: field(data, 'reference'),
              }))
            }
          >
            <h4>Add customer or supplier</h4>
            <label>
              Party name <input name="name" required maxLength={200} />
            </label>
            <label>
              Party reference{' '}
              <input name="reference" required maxLength={200} />
            </label>
            <label>
              Party type{' '}
              <select name="kind">
                <option value="organization">Organization</option>
                <option value="person">Person</option>
              </select>
            </label>
            <Button type="submit" disabled={busy || !auth.csrfToken}>
              Add party
            </Button>
          </form>
        </details>
      ) : null}
      {canPost && view ? (
        <>
          <details>
            <summary>Issue an invoice or bill</summary>
            <form
              onSubmit={(event) =>
                submit(event, 'commercial-documents', (data) => ({
                  kind,
                  partyId: field(data, 'party'),
                  reference: field(data, 'reference'),
                  issuedOn: field(data, 'issued'),
                  dueOn: field(data, 'due'),
                  controlAccountId: field(data, 'control'),
                  sourceReference: field(data, 'source'),
                  lines: Array.from({ length: lineCount }, (_, i) => ({
                    description: field(data, `description-${i}`),
                    accountId: field(data, `account-${i}`),
                    netAmount: field(data, `net-${i}`),
                    taxAmount: field(data, `tax-${i}`) || '0',
                    taxAccountId: field(data, `taxAccount-${i}`) || null,
                  })),
                }))
              }
            >
              <label>
                Document type{' '}
                <select
                  value={kind}
                  onChange={(event) =>
                    setKind(event.target.value as typeof kind)
                  }
                >
                  <option value="sales-invoice">Sales invoice</option>
                  <option value="supplier-bill">Supplier bill</option>
                </select>
              </label>
              <label>
                Customer or supplier{' '}
                <select name="party" required>
                  <option value="">Select party</option>
                  {partyOptions}
                </select>
              </label>
              <label>
                Document reference{' '}
                <input name="reference" required maxLength={200} />
              </label>
              <label>
                Source reference{' '}
                <input name="source" required maxLength={200} />
              </label>
              <label>
                Issue date <input name="issued" type="date" required />
              </label>
              <label>
                Due date <input name="due" type="date" required />
              </label>
              <label>
                {kind === 'sales-invoice' ? 'Receivable' : 'Payable'} control
                account{' '}
                <select name="control" required key={kind}>
                  <option value="">Select account</option>
                  {accountOptions([
                    kind === 'sales-invoice' ? 'asset' : 'liability',
                  ])}
                </select>
              </label>
              {Array.from({ length: lineCount }, (_, i) => (
                <fieldset key={i}>
                  <legend>Line {i + 1}</legend>
                  <label>
                    Description{' '}
                    <input name={`description-${i}`} required maxLength={500} />
                  </label>
                  <label>
                    {kind === 'sales-invoice' ? 'Income' : 'Expense or asset'}{' '}
                    account{' '}
                    <select name={`account-${i}`} required key={kind}>
                      <option value="">Select account</option>
                      {accountOptions(
                        kind === 'sales-invoice'
                          ? ['income']
                          : ['expense', 'asset'],
                      )}
                    </select>
                  </label>
                  <label>
                    Net amount{' '}
                    <input name={`net-${i}`} inputMode="decimal" required />
                  </label>
                  <label>
                    Tax amount{' '}
                    <input
                      name={`tax-${i}`}
                      inputMode="decimal"
                      defaultValue="0"
                    />
                  </label>
                  <label>
                    Tax account{' '}
                    <select name={`taxAccount-${i}`} key={kind}>
                      <option value="">No tax</option>
                      {accountOptions([
                        kind === 'sales-invoice' ? 'liability' : 'asset',
                      ])}
                    </select>
                  </label>
                </fieldset>
              ))}
              <Button
                type="button"
                variant="quiet"
                disabled={lineCount >= 250 || busy}
                onClick={() => setLineCount((value) => value + 1)}
              >
                Add line
              </Button>
              {lineCount > 1 ? (
                <Button
                  type="button"
                  variant="quiet"
                  disabled={busy}
                  onClick={() => setLineCount((value) => value - 1)}
                >
                  Remove last line
                </Button>
              ) : null}
              <Button type="submit" disabled={busy || !auth.csrfToken}>
                Issue and post document
              </Button>
            </form>
          </details>
          <details>
            <summary>Record a payment</summary>
            <form
              onSubmit={(event) =>
                submit(event, 'payments', (data) => ({
                  direction,
                  partyId: paymentParty,
                  cashAccountId: field(data, 'cash'),
                  effectiveOn: field(data, 'date'),
                  reference: field(data, 'reference'),
                  sourceReference: field(data, 'source'),
                  allocations: view.documents
                    .filter((doc) => field(data, `allocation-${doc.id}`) !== '')
                    .map((doc) => ({
                      documentId: doc.id,
                      amount: field(data, `allocation-${doc.id}`),
                    })),
                }))
              }
            >
              <label>
                Payment direction{' '}
                <select
                  value={direction}
                  onChange={(event) => setDirection(event.target.value)}
                >
                  <option value="receipt">Receipt from customer</option>
                  <option value="disbursement">Payment to supplier</option>
                </select>
              </label>
              <label>
                Payment party{' '}
                <select
                  value={paymentParty}
                  required
                  onChange={(event) => setPaymentParty(event.target.value)}
                >
                  <option value="">Select party</option>
                  {partyOptions}
                </select>
              </label>
              <label>
                Cash ledger account{' '}
                <select name="cash" required>
                  <option value="">Select account</option>
                  {accountOptions(['asset'])}
                </select>
              </label>
              <label>
                Payment date <input name="date" type="date" required />
              </label>
              <label>
                Payment reference{' '}
                <input name="reference" required maxLength={200} />
              </label>
              <label>
                Payment source <input name="source" required maxLength={200} />
              </label>
              <fieldset key={`${paymentParty}:${direction}`}>
                <legend>Allocate payment</legend>
                {view.documents
                  .filter(
                    (doc) =>
                      doc.partyId === paymentParty &&
                      doc.status === 'issued' &&
                      doc.kind ===
                        (direction === 'receipt'
                          ? 'sales-invoice'
                          : 'supplier-bill') &&
                      !/^0(?:\.0+)?$/.test(doc.outstanding),
                  )
                  .map((doc) => (
                    <label key={doc.id}>
                      {doc.reference} — outstanding{' '}
                      {displayDecimal(doc.outstanding)} {view.currency}
                      <input
                        name={`allocation-${doc.id}`}
                        inputMode="decimal"
                        placeholder="Amount to allocate"
                      />
                    </label>
                  ))}
              </fieldset>
              <Button type="submit" disabled={busy || !auth.csrfToken}>
                Record and post payment
              </Button>
            </form>
          </details>
        </>
      ) : null}
    </section>
  );
}
