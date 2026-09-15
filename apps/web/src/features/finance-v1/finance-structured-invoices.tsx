import { useEffect, useRef, useState, type FormEvent } from 'react';
import { PostReviewedStructuredInvoiceSchema } from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { useAuth } from '../auth/auth-context.js';
import {
  InvoiceRequestError,
  readInvoiceLibrary,
  uploadInvoice,
  inspectInvoice,
  postInvoice,
  readInvoiceDraft,
  saveInvoiceDraft,
  type InvoiceDraft,
  type InvoiceSource,
  type InvoiceReview,
} from './finance-structured-invoice-api.js';
import './finance-structured-invoices.css';
type Account = { id: string; code: string; name: string; kind: string };
type Mapping = {
  partyId: string;
  controlAccountId: string;
  kind: 'supplier-bill' | 'sales-invoice';
  groups: Record<string, { accountId: string; taxAccountId: string }>;
  parties: boolean;
  aggregation: boolean;
  conformance: boolean;
};
const blank = (): Mapping => ({
  partyId: '',
  controlAccountId: '',
  kind: 'supplier-bill',
  groups: {},
  parties: false,
  aggregation: false,
  conformance: false,
});
export function FinanceStructuredInvoices(props: {
  bookId: string;
  currency: string;
  role: string;
  accounts: readonly Account[];
  onSaved: () => void;
}) {
  const auth = useAuth();
  return (
    <InvoiceLibrary
      key={`${auth.sessionBinding}:${props.bookId}:${props.role}`}
      {...props}
      {...(auth.csrfToken ? { csrfToken: auth.csrfToken } : {})}
    />
  );
}
function InvoiceLibrary({
  bookId,
  currency,
  role,
  accounts,
  onSaved,
  csrfToken,
}: {
  bookId: string;
  currency: string;
  role: string;
  accounts: readonly Account[];
  onSaved: () => void;
  csrfToken?: string;
}) {
  const [page, setPage] =
      useState<Awaited<ReturnType<typeof readInvoiceLibrary>>>(),
    [offset, setOffset] = useState(0),
    [source, setSource] = useState<InvoiceSource>(),
    [selected, setSelected] = useState(''),
    [mapping, setMapping] = useState<Mapping>(blank),
    [savedRevision, setSavedRevision] = useState(0),
    [savedSignature, setSavedSignature] = useState(''),
    [format, setFormat] = useState<'ubl' | 'cii'>('ubl'),
    [file, setFile] = useState<File>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [confirm, setConfirm] = useState(false),
    [factPage, setFactPage] = useState(0),
    [posted, setPosted] = useState<{
      id: string;
      journalId: string;
      total: string;
      currency: string;
    }>(),
    [uncertain, setUncertain] = useState(false);
  const alive = useRef(true),
    working = useRef(false),
    controller = useRef<AbortController | undefined>(undefined),
    pendingUpload = useRef<{ signature: string; key: string } | undefined>(
      undefined,
    ),
    pendingSave = useRef<{ signature: string; key: string } | undefined>(
      undefined,
    ),
    pendingPost = useRef<
      { id: string; review: InvoiceReview; key: string } | undefined
    >(undefined),
    drafts = useRef(
      new Map<string, { source: InvoiceSource; mapping: Mapping }>(),
    ),
    postedRecords = useRef(new Map<string, NonNullable<typeof posted>>());
  const canWrite = ['administrator', 'preparer', 'approver'].includes(role);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  async function action(work: (signal: AbortSignal) => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    try {
      await work(c.signal);
    } catch (cause) {
      if (alive.current && !c.signal.aborted) {
        setError(
          cause instanceof Error && cause.name !== 'ZodError'
            ? cause.message
            : 'The server response or review fields are invalid.',
        );
        if (
          cause instanceof InvoiceRequestError &&
          [400, 401, 403, 409, 422, 503].includes(cause.status)
        ) {
          pendingPost.current = undefined;
          setUncertain(false);
          setConfirm(false);
        }
        if (
          cause instanceof InvoiceRequestError &&
          (cause.status === 401 || cause.status === 403 || cause.status === 503)
        ) {
          setSource(undefined);
          setPage(undefined);
          setMapping(blank());
          setConfirm(false);
          drafts.current.clear();
        }
      }
    } finally {
      working.current = false;
      if (alive.current && !c.signal.aborted) setBusy(false);
    }
  }
  async function load(n: number, signal: AbortSignal) {
    const result = await readInvoiceLibrary(bookId, n, signal);
    if (!alive.current || signal.aborted) return;
    setPage(result);
    setOffset(n);
  }
  async function open(id: string, signal: AbortSignal) {
    const [result, stored] = await Promise.all([
      inspectInvoice(bookId, id, signal),
      readInvoiceDraft(bookId, id, signal),
    ]);
    if (!alive.current || signal.aborted) return;
    const previous = drafts.current.get(id);
    const saved = stored.review?.draft;
    const validSaved =
      saved?.expectedSourceDigest === result.sourceDigest &&
      saved.expectedAdapterVersion === result.adapterVersion;
    const restored: Mapping = validSaved
      ? {
          kind: saved.kind,
          partyId: saved.partyId ?? '',
          controlAccountId: saved.controlAccountId ?? '',
          groups: Object.fromEntries(
            saved.groups.map((g) => [
              g.key,
              {
                accountId: g.accountId ?? '',
                taxAccountId: g.taxAccountId ?? '',
              },
            ]),
          ),
          parties: saved.acknowledgedSourceParties,
          aggregation: saved.acknowledgedTaxGroupAggregation,
          conformance: saved.acknowledgedNoConformanceValidation,
        }
      : blank();
    const next =
      previous?.source.sourceDigest === result.sourceDigest &&
      previous.source.adapterVersion === result.adapterVersion
        ? previous.mapping
        : restored;
    setSource(result);
    setSelected(id);
    setFactPage(0);
    setConfirm(false);
    setPosted(
      stored.posting?.status === 'issued'
        ? stored.posting
        : postedRecords.current.get(id),
    );
    setSavedRevision(stored.review?.revision ?? 0);
    setSavedSignature(validSaved ? JSON.stringify(saved) : '');
    setMapping(next);
    drafts.current.set(id, { source: result, mapping: next });
    setNotice(
      validSaved
        ? 'Saved review restored. Unsaved changes must be saved before posting.'
        : 'Choose mappings and save your review to resume it after reload.',
    );
  }
  function update(next: Mapping) {
    const financialChange =
      next.kind !== mapping.kind ||
      next.partyId !== mapping.partyId ||
      next.controlAccountId !== mapping.controlAccountId ||
      JSON.stringify(next.groups) !== JSON.stringify(mapping.groups);
    if (financialChange)
      next = {
        ...next,
        parties: false,
        aggregation: false,
        conformance: false,
      };
    setMapping(next);
    if (source) drafts.current.set(selected, { source, mapping: next });
    setConfirm(false);
  }
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file || !csrfToken) return;
    await action(async (signal) => {
      if (file.size > 2097152 || file.size === 0)
        throw new Error('Choose a nonempty XML file up to 2 MiB.');
      const sourceText = new TextDecoder('utf-8', { fatal: true }).decode(
          await file.arrayBuffer(),
        ),
        body = { filename: file.name, format, sourceText },
        signature = JSON.stringify(body);
      const key =
        pendingUpload.current?.signature === signature
          ? pendingUpload.current.key
          : crypto.randomUUID();
      pendingUpload.current = { signature, key };
      const result = await uploadInvoice(bookId, body, csrfToken, key, signal);
      if (!alive.current || signal.aborted) return;
      pendingUpload.current = undefined;
      setNotice(
        'Original saved encrypted. Review source facts and accounting mappings before posting.',
      );
      await load(0, signal);
      await open(result.id, signal);
    });
  }
  function draft(): InvoiceDraft {
    if (!source) throw new Error('Select an invoice first.');
    return {
      expectedSourceDigest: source.sourceDigest,
      expectedAdapterVersion: source.adapterVersion,
      kind: mapping.kind,
      partyId: mapping.partyId || null,
      controlAccountId: mapping.controlAccountId || null,
      acknowledgedSourceParties: mapping.parties,
      acknowledgedTaxGroupAggregation: mapping.aggregation,
      acknowledgedNoConformanceValidation: mapping.conformance,
      groups: source.taxGroups.map((g) => ({
        key: g.key,
        accountId: mapping.groups[g.key]?.accountId || null,
        taxAccountId: mapping.groups[g.key]?.taxAccountId || null,
      })),
    };
  }
  async function save() {
    if (!csrfToken || !source) return;
    const value = draft(),
      signature = JSON.stringify({
        draft: value,
        expectedRevision: savedRevision,
      });
    const key =
      pendingSave.current?.signature === signature
        ? pendingSave.current.key
        : crypto.randomUUID();
    pendingSave.current = { signature, key };
    await action(async (signal) => {
      const result = await saveInvoiceDraft(
        bookId,
        selected,
        value,
        savedRevision,
        csrfToken,
        key,
        signal,
      );
      if (!alive.current || signal.aborted) return;
      pendingSave.current = undefined;
      setSavedRevision(result.revision);
      setSavedSignature(JSON.stringify(result.draft));
      setNotice(
        `Review revision ${result.revision} saved. It can be resumed after reload.`,
      );
    });
  }
  function review(): InvoiceReview {
    const value = draft();
    if (!savedRevision || JSON.stringify(value) !== savedSignature)
      throw new Error('Save this exact review before posting.');
    return PostReviewedStructuredInvoiceSchema.parse({
      ...value,
      expectedReviewRevision: savedRevision,
    });
  }
  async function post() {
    if (!csrfToken || !source) return;
    let pending = pendingPost.current;
    try {
      pending ??= { id: selected, review: review(), key: crypto.randomUUID() };
    } catch {
      setError(
        'Complete the party, account mappings and all three acknowledgements.',
      );
      return;
    }
    pendingPost.current = pending;
    setUncertain(true);
    await action(async (signal) => {
      const result = await postInvoice(
        bookId,
        pending.id,
        pending.review,
        csrfToken,
        pending.key,
        signal,
      );
      if (!alive.current || signal.aborted) return;
      pendingPost.current = undefined;
      setUncertain(false);
      setPosted(result);
      postedRecords.current.set(selected, result);
      setConfirm(false);
      setNotice(
        'Reviewed invoice posted. Its original and review provenance are retained.',
      );
    });
  }
  const accountOptions = accounts.map((a) => (
    <option key={a.id} value={a.id}>
      {a.code} · {a.name}
    </option>
  ));
  const noTax = (value: string | undefined) =>
    value !== undefined && /^0+(?:\.0+)?$/.test(value.trim());
  return (
    <section className="finance-invoices" aria-label="Structured invoices">
      <div className="finance-invoices__heading">
        <div>
          <h3>Structured invoices</h3>
          <p>UBL 2.1 and CII XML originals · source review before accounting</p>
        </div>
        <Button
          variant="secondary"
          disabled={busy || uncertain}
          onClick={() => void action((s) => load(0, s))}
        >
          {page ? 'Refresh invoice library' : 'Open invoice library'}
        </Button>
      </div>
      <p>
        Source extraction is not EN 16931 or XRechnung conformance validation.
        Unsupported settlement details block posting.
      </p>
      {error && <p role="alert">{error}</p>}
      <p aria-live="polite">
        {busy ? 'Working with the saved invoice…' : notice}
      </p>
      {page && (
        <>
          {canWrite && (
            <form
              onSubmit={(e) => void upload(e)}
              className="finance-invoices__upload"
            >
              <label>
                XML syntax
                <select
                  value={format}
                  disabled={busy || uncertain}
                  onChange={(e) => setFormat(e.target.value as 'ubl' | 'cii')}
                >
                  <option value="ubl">UBL 2.1 Invoice</option>
                  <option value="cii">UN/CEFACT CII D16B</option>
                </select>
              </label>
              <label>
                Invoice XML file (UTF-8, up to 2 MiB)
                <input
                  type="file"
                  accept=".xml,application/xml,text/xml"
                  disabled={busy || uncertain}
                  onChange={(e) => setFile(e.target.files?.[0])}
                />
              </label>
              <Button
                type="submit"
                disabled={busy || uncertain || !file || !csrfToken}
              >
                Upload invoice original
              </Button>
            </form>
          )}
          <div className="finance-invoices__library">
            {page.documents.length === 0 ? (
              <p>No structured invoices on this evidence page.</p>
            ) : (
              page.documents.map((d) => (
                <Button
                  key={d.id}
                  variant="quiet"
                  disabled={busy || uncertain}
                  onClick={() => void action((s) => open(d.id, s))}
                >
                  {d.filename} · {d.format.toUpperCase()}
                </Button>
              ))
            )}
          </div>
          <div className="finance-invoices__actions">
            <Button
              variant="quiet"
              disabled={busy || uncertain || offset === 0}
              onClick={() =>
                void action((s) => load(Math.max(0, offset - 50), s))
              }
            >
              Previous evidence page
            </Button>
            <Button
              variant="quiet"
              disabled={busy || uncertain || page.nextOffset === null}
              onClick={() => void action((s) => load(page.nextOffset!, s))}
            >
              Next evidence page
            </Button>
          </div>
        </>
      )}
      {source && (
        <article className="finance-invoices__review">
          <div className="finance-invoices__heading">
            <div>
              <h3>Invoice {source.invoiceId?.value ?? 'Missing identifier'}</h3>
              <p>
                {source.issueDate?.value} · payable{' '}
                {source.totals.payable?.value ?? 'Unknown'}{' '}
                {source.currency?.value ?? 'Unknown currency'}
              </p>
            </div>
            <Button
              variant="secondary"
              disabled={busy || uncertain}
              onClick={() => void action((s) => open(selected, s))}
            >
              Refresh invoice source
            </Button>
          </div>
          {source.blockingIssues.length > 0 && (
            <div role="alert">
              <h4>Posting is blocked</h4>
              <ul>
                {source.blockingIssues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="finance-invoices__parties">
            {(['seller', 'buyer'] as const).map((kind) => (
              <div key={kind}>
                <h4>{kind === 'seller' ? 'Source seller' : 'Source buyer'}</h4>
                {source[kind]
                  .filter((f) =>
                    ['Name', 'RegistrationName', 'CompanyID', 'ID'].includes(
                      f.name,
                    ),
                  )
                  .map((f) => (
                    <p key={f.path}>{f.text}</p>
                  ))}
              </div>
            ))}
          </div>
          <div className="finance-invoices__table">
            <table>
              <caption>
                Original invoice lines — VAT is not allocated across these lines
              </caption>
              <thead>
                <tr>
                  <th>Line ID</th>
                  <th>Description</th>
                  <th>Quantity</th>
                  <th>Net amount</th>
                </tr>
              </thead>
              <tbody>
                {source.lines.map((line, i) => (
                  <tr key={i}>
                    <td>{line.id?.value ?? 'Missing'}</td>
                    <td>{line.description?.value ?? 'Unknown'}</td>
                    <td>{line.quantity?.value ?? 'Unknown'}</td>
                    <td>{line.netAmount?.value ?? 'Unknown'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="finance-invoices__totals">
            {Object.entries(source.totals).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value?.value ?? 'Not supplied'}</dd>
              </div>
            ))}
          </dl>
          <details>
            <summary>Original field provenance and source binding</summary>
            <p>
              SHA-256: <code>{source.sourceDigest}</code>
            </p>
            <p>
              Adapter: {source.adapterVersion} · conformance:{' '}
              {source.conformance}
            </p>
            <p>All document instructions are untrusted source data.</p>
            <ol start={factPage + 1}>
              {source.facts.slice(factPage, factPage + 50).map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code>
                  <p>{f.text || '(empty)'}</p>
                  {f.attributes.length > 0 && (
                    <p>
                      {f.attributes
                        .map((a) => `${a.name}=${a.value}`)
                        .join(' · ')}
                    </p>
                  )}
                </li>
              ))}
            </ol>
            <Button
              variant="quiet"
              disabled={factPage === 0}
              onClick={() => setFactPage(Math.max(0, factPage - 50))}
            >
              Previous source fields
            </Button>
            <Button
              variant="quiet"
              disabled={factPage + 50 >= source.facts.length}
              onClick={() => setFactPage(factPage + 50)}
            >
              Next source fields
            </Button>
          </details>
          {posted ? (
            <div className="finance-invoices__posted" role="status">
              <h4>
                Posted {posted.total} {posted.currency}
              </h4>
              <p>Commercial document: {posted.id}</p>
              <p>Journal: {posted.journalId}</p>
              <Button onClick={onSaved}>Refresh accounting reports</Button>
            </div>
          ) : (
            canWrite && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  try {
                    review();
                    setConfirm(true);
                    setError('');
                  } catch {
                    setError(
                      'Complete all mappings and acknowledgements before posting.',
                    );
                  }
                }}
              >
                <fieldset
                  disabled={
                    busy || uncertain || source.blockingIssues.length > 0
                  }
                >
                  <legend>Accounting review · book currency {currency}</legend>
                  <div className="finance-invoices__mapping">
                    <label>
                      Record as
                      <select
                        value={mapping.kind}
                        onChange={(e) =>
                          update({
                            ...mapping,
                            kind: e.target.value as Mapping['kind'],
                            parties: false,
                            aggregation: false,
                          })
                        }
                      >
                        <option value="supplier-bill">
                          Supplier bill (we are the buyer)
                        </option>
                        <option value="sales-invoice">
                          Sales invoice (we are the seller)
                        </option>
                      </select>
                    </label>
                    <label>
                      Existing counterparty
                      <select
                        value={mapping.partyId}
                        onChange={(e) =>
                          update({
                            ...mapping,
                            partyId: e.target.value,
                            parties: false,
                          })
                        }
                      >
                        <option value="">Choose the source counterparty</option>
                        {page?.parties.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} · {p.reference}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Payables / receivables control account
                      <select
                        value={mapping.controlAccountId}
                        onChange={(e) =>
                          update({
                            ...mapping,
                            controlAccountId: e.target.value,
                            aggregation: false,
                          })
                        }
                      >
                        <option value="">Choose control account</option>
                        {accountOptions}
                      </select>
                    </label>
                  </div>
                  <p>
                    Accounting lines use source VAT breakdown groups. Original
                    invoice lines remain in evidence. No VAT is calculated from
                    the displayed rate.
                  </p>
                  {source.taxGroups.map((g, i) => (
                    <div className="finance-invoices__group" key={g.key}>
                      <h4>
                        VAT group {i + 1} · category{' '}
                        {g.category?.value ?? 'Unknown'}
                      </h4>
                      <p>
                        Source basis {g.basis?.value ?? 'Unknown'} · source VAT{' '}
                        {g.tax?.value ?? 'Unknown'} {source.currency?.value} ·
                        reported rate {g.rate?.value ?? 'Not supplied'}
                      </p>
                      <div className="finance-invoices__mapping">
                        <label>
                          Net account for group {i + 1}
                          <select
                            value={mapping.groups[g.key]?.accountId ?? ''}
                            onChange={(e) =>
                              update({
                                ...mapping,
                                aggregation: false,
                                groups: {
                                  ...mapping.groups,
                                  [g.key]: {
                                    accountId: e.target.value,
                                    taxAccountId:
                                      mapping.groups[g.key]?.taxAccountId ?? '',
                                  },
                                },
                              })
                            }
                          >
                            <option value="">
                              Choose expense / income account
                            </option>
                            {accountOptions}
                          </select>
                        </label>
                        <label>
                          Tax account for group {i + 1}
                          <select
                            disabled={noTax(g.tax?.value)}
                            value={mapping.groups[g.key]?.taxAccountId ?? ''}
                            onChange={(e) =>
                              update({
                                ...mapping,
                                aggregation: false,
                                groups: {
                                  ...mapping.groups,
                                  [g.key]: {
                                    accountId:
                                      mapping.groups[g.key]?.accountId ?? '',
                                    taxAccountId: e.target.value,
                                  },
                                },
                              })
                            }
                          >
                            <option value="">
                              {noTax(g.tax?.value)
                                ? 'No tax amount'
                                : 'Choose tax account'}
                            </option>
                            {accountOptions}
                          </select>
                        </label>
                      </div>
                    </div>
                  ))}
                  <div className="finance-invoices__acknowledgements">
                    <label>
                      <input
                        type="checkbox"
                        checked={mapping.parties}
                        onChange={(e) =>
                          update({ ...mapping, parties: e.target.checked })
                        }
                      />
                      I verified the source seller and buyer and the selected
                      counterparty.
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={mapping.aggregation}
                        onChange={(e) =>
                          update({ ...mapping, aggregation: e.target.checked })
                        }
                      />
                      I reviewed the exact amounts and the accounting
                      aggregation by VAT group.
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={mapping.conformance}
                        onChange={(e) =>
                          update({ ...mapping, conformance: e.target.checked })
                        }
                      />
                      I understand this extraction does not validate EN 16931 or
                      XRechnung conformance.
                    </label>
                  </div>
                  <p>
                    {savedRevision
                      ? `Saved review revision ${savedRevision}`
                      : 'Review not yet saved'}
                    {JSON.stringify(draft()) !== savedSignature
                      ? ' · unsaved changes'
                      : ''}
                  </p>
                  <Button
                    type="button"
                    disabled={!csrfToken}
                    onClick={() => void save()}
                  >
                    Save review
                  </Button>
                  <Button
                    type="submit"
                    disabled={
                      !csrfToken ||
                      !savedRevision ||
                      JSON.stringify(draft()) !== savedSignature
                    }
                  >
                    Review posting
                  </Button>
                </fieldset>
                {confirm && !uncertain && (
                  <div role="group" aria-label="Confirm invoice posting">
                    <h4>
                      Post {source.totals.payable?.value}{' '}
                      {source.currency?.value} to this book?
                    </h4>
                    <p>
                      This creates a commercial document and ledger journal from
                      the reviewed source groups.
                    </p>
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() => void post()}
                    >
                      Confirm and post invoice
                    </Button>
                    <Button
                      type="button"
                      variant="quiet"
                      disabled={busy}
                      onClick={() => setConfirm(false)}
                    >
                      Cancel posting
                    </Button>
                  </div>
                )}
                {uncertain && (
                  <div role="group" aria-label="Unconfirmed invoice posting">
                    <p>
                      The posting result is unconfirmed. Mappings are locked
                      while the same request is retried.
                    </p>
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() => void post()}
                    >
                      Retry same posting
                    </Button>
                  </div>
                )}
              </form>
            )
          )}
        </article>
      )}
    </section>
  );
}
