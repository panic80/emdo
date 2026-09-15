import { FinanceImportPosting } from './finance-import-posting.js';
import { saveMemoryFile } from '../../downloads/save-memory-file.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  FinanceNormalizedImportPostingSchema,
  FinanceCurrencySchema,
  FinanceDecimalSchema,
  UuidSchema,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { useAuth } from '../auth/auth-context.js';
import { FinanceStructuredInvoices } from './finance-structured-invoices.js';
import { FinancePdfOriginals } from './finance-pdf-originals.js';
import { downloadBinaryBookOriginal } from './finance-book-evidence-files.js';
import type { AnalyzeBookReport } from './finance-report-mappings.js';

const FinancialAccount = z.object({
  id: UuidSchema,
  name: z.string(),
  currency: FinanceCurrencySchema,
  ledgerAccountId: UuidSchema,
});
const Batch = z.object({
  id: UuidSchema,
  status: z.string(),
  revision: z.number().int(),
  evidence_id: UuidSchema,
});
const ImportRow = z
  .object({
    id: UuidSchema,
    source_row: z.number().int(),
    date: z.string().nullable(),
    amount: FinanceDecimalSchema.nullable(),
    description: z.string(),
    external_id: z.string().nullable(),
    issues: z.array(z.string()),
    status: z.string(),
    revision: z.number().int(),
    counter_account_id: UuidSchema.nullable(),
    match_journal_id: UuidSchema.nullable(),
    fxRate: FinanceDecimalSchema.nullable(),
    fx_source: z.string().nullable(),
    source_facts: z.unknown(),
    economic_transaction_id: UuidSchema.nullable().optional(),
    posting: FinanceNormalizedImportPostingSchema.nullable().optional(),
  })
  .superRefine((row, context) => {
    if (
      row.posting &&
      (row.posting.economicTransactionId !== row.economic_transaction_id ||
        new Set(row.posting.lines.map((line) => line.lineNumber)).size !==
          row.posting.lines.length)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Saved posting does not match this import row or contains duplicate journal lines.',
      });
    }
  });
const Review = z.object({ batch: Batch, rows: z.array(ImportRow) });
const ImportSummary = z.object({
  id: UuidSchema,
  filename: z.string(),
  status: z.string(),
  revision: z.number().int(),
});
interface LedgerAccount {
  id: string;
  name: string;
  code: string;
  kind: string;
}
const field = (data: FormData, name: string) => String(data.get(name) ?? '');

/** Book and session keyed by the parent; no original document is retained in browser storage. */
export function FinanceBookDocuments({
  bookId,
  currency,
  role,
  accounts,
  onSaved,
  onAnalyze,
}: {
  bookId: string;
  currency: string;
  role: string;
  accounts: readonly LedgerAccount[];
  onSaved: () => void;
  onAnalyze?: AnalyzeBookReport;
}) {
  const auth = useAuth();
  const uploadDetails = useRef<HTMLDetailsElement | null>(null);
  const [opened, setOpened] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [financial, setFinancial] = useState<
      z.infer<typeof FinancialAccount>[]
    >([]),
    [imports, setImports] = useState<z.infer<typeof ImportSummary>[]>([]),
    [review, setReview] = useState<z.infer<typeof Review>>();
  const [privateSources, setPrivateSources] = useState<
    Array<{ sourceSpaceId: string; name: string }>
  >([]);
  const [privateSourceId, setPrivateSourceId] = useState('');
  const [accountKind, setAccountKind] = useState('bank');
  const [format, setFormat] = useState('csv'),
    [split, setSplit] = useState(false);
  const alive = useRef(true),
    working = useRef(false),
    readController = useRef<AbortController | undefined>(undefined);
  const pending = useRef<
    { path: string; body: string; key: string } | undefined
  >(undefined);
  const base = `/api/v2/finance/books/${bookId}`,
    canPrepare = role !== 'viewer',
    canCommit = ['administrator', 'approver'].includes(role);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      readController.current?.abort();
    };
  }, []);
  async function request(path: string, init: RequestInit = {}) {
    if (!alive.current)
      throw new Error('The active book changed. Reopen its documents.');
    const response = await fetch(base + path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
    });
    if (!response.ok) {
      if ([401, 403].includes(response.status)) {
        setReview(undefined);
        setImports([]);
        setFinancial([]);
      }
      throw new Error(
        response.status === 403
          ? 'Current book access does not permit this operation.'
          : response.status === 503
            ? 'Encrypted import storage is not available in this environment.'
            : response.status === 409
              ? 'The records changed or require further review. Refresh and check revisions, duplicate evidence, dates, and posting accounts.'
              : 'Unable to process this statement. Check its format, mapping, amounts, and selected accounts.',
      );
    }
    return response.json() as Promise<unknown>;
  }
  useEffect(() => {
    const controller = new AbortController();
    setPrivateSources([]);
    setPrivateSourceId('');
    if (opened && canCommit) {
      void request('/financial-account-sources', { signal: controller.signal })
        .then((result) => {
          if (!controller.signal.aborted && alive.current)
            setPrivateSources(
              z
                .object({
                  sources: z.array(
                    z.object({ sourceSpaceId: UuidSchema, name: z.string() }),
                  ),
                })
                .parse(result).sources,
            );
        })
        .catch(() => {
          if (!controller.signal.aborted && alive.current)
            setPrivateSources([]);
        });
    }
    return () => controller.abort();
  }, [bookId, opened, canCommit]);
  async function load(id?: string) {
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    setReview(undefined);
    const [a, b, c] = await Promise.all([
      request('/financial-accounts', { signal: controller.signal }),
      request('/imports', { signal: controller.signal }),
      id
        ? request(`/imports/${id}`, { signal: controller.signal })
        : Promise.resolve(undefined),
    ]);
    if (alive.current && !controller.signal.aborted) {
      setFinancial(
        z.object({ accounts: z.array(FinancialAccount) }).parse(a).accounts,
      );
      setImports(
        z.object({ imports: z.array(ImportSummary) }).parse(b).imports,
      );
      const savedReview = c ? Review.parse(c) : undefined;
      setReview(savedReview);
      return savedReview;
    }
  }
  async function action(work: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'Unable to save.');
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function post(path: string, data: unknown) {
    if (!auth.csrfToken) throw new Error('Sign in again before saving.');
    const body = JSON.stringify(data);
    if (pending.current?.path !== path || pending.current.body !== body)
      pending.current = { path, body, key: crypto.randomUUID() };
    const result = await request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': auth.csrfToken,
        'idempotency-key': pending.current.key,
      },
      body,
    });
    pending.current = undefined;
    return z.object({ id: UuidSchema }).passthrough().parse(result);
  }
  function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void action(async () => {
      const file = data.get('file');
      if (!(file instanceof File) || !file.size || file.size > 2_097_152)
        throw new Error(
          'Choose a nonempty CSV, OFX, or QFX file no larger than 2 MiB.',
        );
      const columns = {
        date: field(data, 'dateColumn'),
        description: field(data, 'descriptionColumn'),
        ...(split
          ? {
              debit: field(data, 'debitColumn'),
              credit: field(data, 'creditColumn'),
            }
          : { amount: field(data, 'amountColumn') }),
        ...(field(data, 'externalIdColumn')
          ? { externalId: field(data, 'externalIdColumn') }
          : {}),
      };
      const result = await post('/imports', {
        financialAccountId: field(data, 'financialAccountId'),
        filename: file.name,
        format,
        sourceText: await file.text(),
        ...(format === 'csv'
          ? {
              mapping: {
                dateFormat: field(data, 'dateFormat'),
                decimalSeparator: field(data, 'decimalSeparator'),
                groupingSeparator: field(data, 'groupingSeparator'),
                columns,
              },
            }
          : {}),
      });
      await load(result.id);
      if (alive.current && uploadDetails.current)
        uploadDetails.current.open = false;
      if (alive.current)
        setNotice(
          'Original encrypted and review saved. No journal has been posted.',
        );
    });
  }
  function saveRow(
    event: FormEvent<HTMLFormElement>,
    row: z.infer<typeof ImportRow>,
  ) {
    event.preventDefault();
    const data = new FormData(event.currentTarget),
      batchId = review!.batch.id;
    void action(async () => {
      const choice = field(data, 'action');
      const correction = {
        ...(field(data, 'date') !== row.date && field(data, 'date')
          ? { date: field(data, 'date') }
          : {}),
        ...(field(data, 'amount') !== row.amount && field(data, 'amount')
          ? { amount: field(data, 'amount') }
          : {}),
        ...(field(data, 'description') !== row.description
          ? { description: field(data, 'description') }
          : {}),
        ...(field(data, 'externalId') !== (row.external_id ?? '')
          ? { externalId: field(data, 'externalId') || null }
          : {}),
      };
      await post(`/import-rows/${row.id}/review`, {
        expectedRevision: row.revision,
        action: choice,
        counterAccountId:
          choice === 'post' ? field(data, 'counterAccountId') : null,
        matchJournalId:
          choice === 'match' ? field(data, 'matchJournalId') : null,
        fxRate: field(data, 'fxRate') || null,
        fxSource: field(data, 'fxSource') || null,
        reason: field(data, 'reason'),
        acknowledgePossibleDuplicate: data.get('duplicate') === 'on',
        correction,
      });
      await load(batchId);
      if (alive.current) setNotice('Review revision saved.');
    });
  }
  async function download() {
    const data = z
      .union([
        z.object({
          filename: z.string(),
          format: z.enum(['xlsx', 'pdf']),
          sourceBase64: z.string(),
        }),
        z.object({ filename: z.string(), sourceText: z.string() }),
      ])
      .parse(await request(`/evidence/${review!.batch.evidence_id}`));
    if (!alive.current) return;
    if ('sourceBase64' in data) {
      downloadBinaryBookOriginal(data, data.format);
    } else
      saveMemoryFile(
        data.filename,
        data.sourceText,
        'text/plain;charset=utf-8',
      );
  }
  return (
    <section className="finance-documents" aria-label="Book documents">
      <h3>Documents</h3>
      <p>
        Upload statements into this book. Saved reviews survive refreshes.
        Commit posts approved rows or links existing journals.
      </p>
      <Button
        variant="quiet"
        disabled={busy}
        onClick={() => {
          setOpened(true);
          void action(async () => {
            await load(review?.batch.id);
          });
        }}
      >
        {opened ? 'Refresh documents' : 'Open documents'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {opened && (
        <>
          <FinancePdfOriginals
            bookId={bookId}
            role={role}
            {...(onAnalyze ? { onAnalyze } : {})}
          />
          <FinanceStructuredInvoices
            bookId={bookId}
            currency={currency}
            role={role}
            accounts={accounts}
            onSaved={onSaved}
          />
          {canPrepare && (
            <details>
              <summary>Add a financial account</summary>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  void action(async () => {
                    await post('/financial-accounts', {
                      name: field(data, 'name'),
                      kind: field(data, 'kind'),
                      currency: field(data, 'currency'),
                      ledgerAccountId: field(data, 'ledgerAccountId'),
                      ...(privateSourceId
                        ? {
                            privateSourceAssignment: {
                              sourceSpaceId: privateSourceId,
                              compatibilityAccountKind: field(
                                data,
                                'compatibilityAccountKind',
                              ),
                              reason: field(data, 'assignmentReason'),
                            },
                          }
                        : {}),
                    });
                    await load();
                  });
                }}
              >
                {privateSources.length > 0 && (
                  <>
                    <label>
                      Private finance view
                      <select
                        value={privateSourceId}
                        onChange={(event) =>
                          setPrivateSourceId(event.target.value)
                        }
                      >
                        <option value="">Keep in this book only</option>
                        {privateSources.map((source) => (
                          <option
                            key={source.sourceSpaceId}
                            value={source.sourceSpaceId}
                          >
                            {source.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {privateSourceId && (
                      <>
                        <label>
                          Account classification
                          <select
                            key={accountKind}
                            name="compatibilityAccountKind"
                            required
                            defaultValue=""
                          >
                            <option value="" disabled>
                              Choose a classification
                            </option>
                            {(accountKind === 'bank'
                              ? [
                                  ['chequing', 'Chequing'],
                                  ['savings', 'Savings'],
                                  ['other', 'Other bank account'],
                                ]
                              : accountKind === 'cash'
                                ? [['cash', 'Cash']]
                                : accountKind === 'credit-card'
                                  ? [['credit', 'Credit card']]
                                  : [['other', 'Brokerage']]
                            ).map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Reason for inclusion
                          <input
                            name="assignmentReason"
                            required
                            minLength={3}
                            maxLength={500}
                          />
                        </label>
                        <p>
                          The opening balance must be reviewed before this
                          account appears in the private finance view.
                        </p>
                      </>
                    )}
                  </>
                )}
                <label>
                  Account name
                  <input name="name" required maxLength={200} />
                </label>
                <label>
                  Account type
                  <select
                    name="kind"
                    value={accountKind}
                    onChange={(event) => setAccountKind(event.target.value)}
                  >
                    <option value="bank">Bank</option>
                    <option value="brokerage">Brokerage</option>
                    <option value="credit-card">Credit card</option>
                    <option value="cash">Cash</option>
                  </select>
                </label>
                <label>
                  Account currency
                  <select name="currency" defaultValue={currency}>
                    {FinanceCurrencySchema.options.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Ledger account
                  <select name="ledgerAccountId" required>
                    <option value="">
                      Choose an asset or liability account
                    </option>
                    {accounts
                      .filter((a) => ['asset', 'liability'].includes(a.kind))
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                  </select>
                </label>
                <Button disabled={busy}>Save account</Button>
              </form>
            </details>
          )}
          {canPrepare && (
            <details ref={uploadDetails}>
              <summary>Upload a statement</summary>
              <form onSubmit={upload}>
                <label>
                  Financial account
                  <select name="financialAccountId" required>
                    <option value="">Choose account</option>
                    {financial.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} · {a.currency}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Statement format
                  <select
                    value={format}
                    onChange={(e) => setFormat(e.target.value)}
                  >
                    <option value="csv">CSV</option>
                    <option value="ofx">OFX</option>
                    <option value="qfx">QFX</option>
                  </select>
                </label>
                <label>
                  Original statement
                  <input
                    name="file"
                    type="file"
                    accept=".csv,.ofx,.qfx"
                    required
                  />
                </label>
                {format === 'csv' && (
                  <fieldset>
                    <legend>Explicit CSV mapping</legend>
                    <p>
                      Enter exact column headings. Amounts remain in the
                      financial account’s currency.
                    </p>
                    <label>
                      Date column
                      <input name="dateColumn" defaultValue="Date" required />
                    </label>
                    <label>
                      Description column
                      <input
                        name="descriptionColumn"
                        defaultValue="Description"
                        required
                      />
                    </label>
                    <label>
                      Amount layout
                      <select
                        value={split ? 'split' : 'signed'}
                        onChange={(e) => setSplit(e.target.value === 'split')}
                      >
                        <option value="signed">
                          Signed amount (inflow positive)
                        </option>
                        <option value="split">Separate debit and credit</option>
                      </select>
                    </label>
                    {split ? (
                      <>
                        <label>
                          Debit column
                          <input
                            name="debitColumn"
                            defaultValue="Debit"
                            required
                          />
                        </label>
                        <label>
                          Credit column
                          <input
                            name="creditColumn"
                            defaultValue="Credit"
                            required
                          />
                        </label>
                      </>
                    ) : (
                      <label>
                        Amount column
                        <input
                          name="amountColumn"
                          defaultValue="Amount"
                          required
                        />
                      </label>
                    )}
                    <label>
                      External transaction ID column (optional)
                      <input name="externalIdColumn" />
                    </label>
                    <label>
                      Date format
                      <select name="dateFormat">
                        <option value="yyyy-mm-dd">YYYY-MM-DD</option>
                        <option value="mm/dd/yyyy">MM/DD/YYYY</option>
                        <option value="dd/mm/yyyy">DD/MM/YYYY</option>
                        <option value="dd.mm.yyyy">DD.MM.YYYY</option>
                        <option value="yyyy/mm/dd">YYYY/MM/DD</option>
                      </select>
                    </label>
                    <label>
                      Decimal separator
                      <select name="decimalSeparator">
                        <option value=".">Period</option>
                        <option value=",">Comma</option>
                      </select>
                    </label>
                    <label>
                      Grouping separator
                      <select name="groupingSeparator">
                        <option value="">None</option>
                        <option value=",">Comma</option>
                        <option value=".">Period</option>
                        <option value=" ">Space</option>
                      </select>
                    </label>
                  </fieldset>
                )}
                <Button disabled={busy || !financial.length}>
                  Upload for review
                </Button>
              </form>
            </details>
          )}
          <ul>
            {imports.map((item) => (
              <li key={item.id}>
                <Button
                  variant="quiet"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await load(item.id);
                    })
                  }
                >
                  {item.filename} · {item.status} · revision {item.revision}
                </Button>
              </li>
            ))}
          </ul>
          {review && (
            <div>
              <h4>Statement review · revision {review.batch.revision}</h4>
              <Button
                variant="quiet"
                disabled={busy}
                onClick={() => void action(download)}
              >
                Download original
              </Button>
              {review.rows.map((row) => (
                <details key={`${row.id}:${row.revision}`}>
                  <summary>
                    Row {row.source_row}:{' '}
                    {row.description || 'Missing description'} ·{' '}
                    {row.amount ?? 'Missing amount'} · {row.status}
                  </summary>
                  {(['committed', 'matched'].includes(row.status) ||
                    row.posting !== undefined) && (
                    <FinanceImportPosting
                      posting={row.posting}
                      status={row.status}
                      functionalCurrency={currency}
                      accounts={accounts}
                      evidenceId={review.batch.evidence_id}
                    />
                  )}
                  {row.issues.length > 0 && (
                    <p>Needs correction: {row.issues.join(', ')}</p>
                  )}
                  <details>
                    <summary>Original extracted fields and provenance</summary>
                    <pre className="finance-provenance">
                      {JSON.stringify(row.source_facts, null, 2)}
                    </pre>
                  </details>
                  {review.batch.status === 'review' &&
                  canPrepare &&
                  !['committed', 'matched'].includes(row.status) ? (
                    <form onSubmit={(e) => saveRow(e, row)}>
                      <label>
                        Date
                        <input
                          name="date"
                          type="date"
                          defaultValue={row.date ?? ''}
                        />
                      </label>
                      <label>
                        Signed native amount
                        <input
                          name="amount"
                          inputMode="decimal"
                          defaultValue={row.amount ?? ''}
                        />
                      </label>
                      <label>
                        Description
                        <input
                          name="description"
                          defaultValue={row.description}
                          maxLength={500}
                        />
                      </label>
                      <label>
                        External ID
                        <input
                          name="externalId"
                          defaultValue={row.external_id ?? ''}
                        />
                      </label>
                      <label>
                        Decision
                        <select
                          name="action"
                          defaultValue={
                            row.status === 'ignored'
                              ? 'ignore'
                              : row.match_journal_id
                                ? 'match'
                                : 'post'
                          }
                        >
                          <option value="post">Post a new transaction</option>
                          <option value="match">
                            Match an existing journal
                          </option>
                          <option value="ignore">Ignore with reason</option>
                        </select>
                      </label>
                      <label>
                        Counter ledger account (new postings)
                        <select
                          name="counterAccountId"
                          defaultValue={row.counter_account_id ?? ''}
                        >
                          <option value="">Choose account</option>
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.code} · {a.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Existing journal ID (matching)
                        <input
                          name="matchJournalId"
                          defaultValue={row.match_journal_id ?? ''}
                        />
                      </label>
                      <label>
                        FX rate into {currency} (foreign currency only)
                        <input
                          name="fxRate"
                          defaultValue={row.fxRate ?? ''}
                          inputMode="decimal"
                        />
                      </label>
                      <label>
                        FX source (foreign currency only)
                        <input
                          name="fxSource"
                          defaultValue={row.fx_source ?? ''}
                        />
                      </label>
                      <label>
                        Review reason
                        <input
                          name="reason"
                          required
                          minLength={3}
                          maxLength={500}
                        />
                      </label>
                      <label>
                        <input type="checkbox" name="duplicate" />I verified
                        this is distinct even if another transaction has similar
                        facts.
                      </label>
                      <Button disabled={busy}>Save row review</Button>
                    </form>
                  ) : (
                    <p>
                      {row.date} · {row.amount} · {row.status}
                    </p>
                  )}
                </details>
              ))}
              {review.batch.status === 'review' && canCommit && (
                <Button
                  disabled={
                    busy ||
                    !review.rows.length ||
                    review.rows.some(
                      (r) => !['ready', 'ignored'].includes(r.status),
                    )
                  }
                  onClick={() =>
                    void action(async () => {
                      const id = review.batch.id;
                      await post(`/imports/${id}/commit`, {
                        expectedRevision: review.batch.revision,
                      });
                      const savedReview = await load(id);
                      if (
                        alive.current &&
                        savedReview?.batch.id === id &&
                        savedReview.batch.status === 'committed'
                      ) {
                        setNotice(
                          'Statement committed. Expand each row to review its saved accounting trail.',
                        );
                        onSaved();
                      }
                    })
                  }
                >
                  Commit reviewed statement
                </Button>
              )}
              {review.batch.status === 'committed' && (
                <Button variant="quiet" onClick={onSaved}>
                  Refresh accounting reports
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
