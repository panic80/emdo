import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  FinanceFecMappingCreateSchema,
  type FinanceFecMappingCreate,
} from '@emdo/contracts/browser';
import { useAuth } from '../auth/auth-context.js';
import {
  downloadFec,
  fecMutation,
  FecExport,
  FecMapping,
  FecRequestError,
  readFecMapping,
  readFecExport,
  readFecEvidence,
  FecEvidencePage,
} from './finance-fec-api.js';
import './finance-fec.css';
type Props = {
  bookId: string;
  bookName: string;
  role: string;
  accounts: { id: string; code: string; name: string }[];
  journals: {
    id: string;
    effectiveOn: string;
    description: string;
    sourceReference: string;
  }[];
};
const source = () => ({ sourceReference: '', sourceDigest: '' });
const empty = (): FinanceFecMappingCreate => ({
  expectedRevision: 0,
  siren: '',
  sirenSource: source(),
  openingBalances: { status: 'not-applicable', source: source() },
  accounts: [],
  journals: [],
});
export function FinanceFec(props: Props) {
  const auth = useAuth();
  return (
    <FecScreen
      key={`${auth.sessionBinding}:${props.bookId}:${props.role}`}
      {...props}
    />
  );
}
function FecScreen({ bookId, bookName, role, accounts, journals }: Props) {
  const auth = useAuth(),
    controller = useRef(new AbortController()),
    mutate = useRef(fecMutation());
  const [draft, setDraft] = useState(empty),
    [saved, setSaved] = useState<z.infer<typeof FecMapping> | null>(null),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState<z.infer<typeof FecExport>>(),
    [startsOn, setStart] = useState(''),
    [endsOn, setEnd] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [exportKey, setExportKey] = useState(''),
    [evidence, setEvidence] = useState<
      z.infer<typeof FecEvidencePage>['documents']
    >([]),
    [nextEvidence, setNextEvidence] = useState<number | null>(0),
    [evidenceBusy, setEvidenceBusy] = useState(false),
    [evidenceError, setEvidenceError] = useState('');
  const canReview = role === 'administrator' || role === 'approver';
  function reportError(cause: unknown) {
    if (
      cause instanceof FecRequestError &&
      (cause.status === 401 || cause.status === 403)
    ) {
      setReady(false);
      setSaved(null);
      setDraft(empty());
      setResult(undefined);
      setExportKey('');
      setEvidence([]);
    }
    setError(
      cause instanceof Error ? cause.message : 'The FEC request failed.',
    );
  }

  async function loadEvidence(offset = 0) {
    const signal = controller.current.signal;
    setEvidenceBusy(true);
    setEvidenceError('');
    try {
      const page = await readFecEvidence(bookId, offset, signal);
      if (signal.aborted) return;
      setEvidence((current) =>
        offset === 0
          ? page.documents
          : [
              ...current,
              ...page.documents.filter(
                (d) => !current.some((c) => c.id === d.id),
              ),
            ],
      );
      setNextEvidence(page.nextOffset);
    } catch (cause) {
      if (!signal.aborted) {
        setEvidenceError(
          cause instanceof Error
            ? cause.message
            : 'Unable to load uploaded documents.',
        );
        if (
          cause instanceof FecRequestError &&
          [401, 403].includes(cause.status)
        ) {
          setEvidence([]);
          reportError(cause);
        }
      }
    } finally {
      if (!signal.aborted) setEvidenceBusy(false);
    }
  }
  async function load() {
    const signal = controller.current.signal;
    setBusy(true);
    setReady(false);
    setResult(undefined);
    setError('');
    try {
      const value = await readFecMapping(bookId, signal);
      if (signal.aborted) return;
      setSaved(value);
      setDraft(value?.mapping ?? empty());
      setConfirmed(false);
      setReady(true);
    } catch (e) {
      if (!signal.aborted) {
        setSaved(null);
        setDraft(empty());
        setError(
          e instanceof Error ? e.message : 'Unable to load FEC mappings.',
        );
      }
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    controller.current = new AbortController();
    void load();
    void loadEvidence();
    return () => controller.current.abort();
  }, [bookId]);
  const field = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    type = 'text',
  ) => (
    <label>
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setConfirmed(false);
          setResult(undefined);
        }}
      />
    </label>
  );
  async function save() {
    const signal = controller.current.signal;
    setError('');
    setBusy(true);
    try {
      const parsed = FinanceFecMappingCreateSchema.safeParse(draft);
      if (!parsed.success)
        throw new Error(
          parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        );
      await mutate.current(
        bookId,
        'mappings',
        parsed.data,
        auth.csrfToken,
        signal,
      );
      if (!signal.aborted) await load();
    } catch (e) {
      if (!signal.aborted) reportError(e);
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  async function runExport() {
    const signal = controller.current.signal;
    setError('');
    setResult(undefined);
    setBusy(true);
    try {
      const response = await mutate.current(
        bookId,
        'exports',
        { startsOn, endsOn, mappingRevision: saved?.revision },
        auth.csrfToken,
        signal,
        setExportKey,
      );
      if (!signal.aborted) setResult(FecExport.parse(response));
    } catch (e) {
      if (!signal.aborted) reportError(e);
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="finance-fec" aria-label="France FEC">
      <header>
        <h2>France FEC</h2>
        <p>
          {bookName} · Review legal labels against source records, then export
          posted EUR ledger entries.
        </p>
        <button type="button" disabled={busy} onClick={() => void load()}>
          Refresh reviewed mapping
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Working…</p>}
      {ready && (
        <>
          <p>
            {saved
              ? `Revision ${saved.revision} · Reviewed ${new Date(saved.reviewedAt).toLocaleString()}`
              : 'No reviewed mapping has been saved.'}
          </p>
          <p>
            Enter verified legal metadata; source fingerprints must be the
            original document SHA-256.
          </p>
          {!canReview && (
            <p>
              Only book administrators and approvers can save reviewed mappings.
            </p>
          )}
          <div>
            <p>
              {evidence.length} uploaded book documents available as sources.
            </p>
            {evidenceError && <p role="alert">{evidenceError}</p>}
            {nextEvidence !== null && (
              <button
                type="button"
                disabled={evidenceBusy || busy}
                onClick={() => void loadEvidence(nextEvidence)}
              >
                {evidenceBusy
                  ? 'Loading documents…'
                  : evidence.length
                    ? 'Load more source documents'
                    : 'Load source documents'}
              </button>
            )}
          </div>
          <fieldset disabled={!canReview || busy}>
            <legend>Legal identity and opening balances</legend>
            <div className="finance-fec__grid">
              {field('SIREN (9 digits)', draft.siren, (siren) =>
                setDraft({ ...draft, siren }),
              )}
              <EvidenceSource
                label="SIREN"
                value={draft.sirenSource}
                documents={evidence}
                onChange={(sirenSource) => {
                  setDraft({ ...draft, sirenSource });
                  setConfirmed(false);
                  setResult(undefined);
                }}
              />
              <label>
                Opening balances
                <select
                  value={draft.openingBalances.status}
                  onChange={(e) => {
                    setConfirmed(false);
                    setDraft({
                      ...draft,
                      openingBalances: {
                        ...draft.openingBalances,
                        status: e.target.value as 'included' | 'not-applicable',
                      },
                    });
                  }}
                >
                  <option value="not-applicable">
                    Not applicable — requires source justification
                  </option>
                  <option value="included">
                    Included in mapped opening entries
                  </option>
                </select>
              </label>
              <EvidenceSource
                label="Opening policy"
                value={draft.openingBalances.source}
                documents={evidence}
                onChange={(source) => {
                  setDraft({
                    ...draft,
                    openingBalances: { ...draft.openingBalances, source },
                  });
                  setConfirmed(false);
                  setResult(undefined);
                }}
              />
            </div>
          </fieldset>
          <fieldset disabled={!canReview || busy}>
            <legend>Account mappings ({draft.accounts.length})</legend>
            <label>
              Add ledger account
              <select
                value=""
                onChange={(e) => {
                  setConfirmed(false);
                  setDraft({
                    ...draft,
                    accounts: [
                      ...draft.accounts,
                      {
                        accountId: e.target.value,
                        accountNumber: '',
                        accountLabel: '',
                        auxiliary: null,
                      },
                    ],
                  });
                }}
              >
                <option value="">Select an unmapped account</option>
                {accounts
                  .filter(
                    (a) => !draft.accounts.some((m) => m.accountId === a.id),
                  )
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
              </select>
            </label>
            {draft.accounts.map((row, index) => (
              <details key={row.accountId}>
                <summary>
                  {accounts.find((a) => a.id === row.accountId)?.name ??
                    row.accountId}
                </summary>
                <div className="finance-fec__grid">
                  {(['accountNumber', 'accountLabel'] as const).map((key) => (
                    <div key={key}>
                      {field(
                        key === 'accountNumber'
                          ? 'French account number'
                          : 'French account label',
                        row[key],
                        (value) =>
                          setDraft({
                            ...draft,
                            accounts: draft.accounts.map((r, i) =>
                              i === index ? { ...r, [key]: value } : r,
                            ),
                          }),
                      )}
                    </div>
                  ))}
                  {field(
                    'Auxiliary number (optional)',
                    row.auxiliary?.number ?? '',
                    (number) =>
                      setDraft({
                        ...draft,
                        accounts: draft.accounts.map((r, i) =>
                          i === index
                            ? {
                                ...r,
                                auxiliary:
                                  number || r.auxiliary?.label
                                    ? {
                                        number,
                                        label: r.auxiliary?.label ?? '',
                                      }
                                    : null,
                              }
                            : r,
                        ),
                      }),
                  )}
                  {field(
                    'Auxiliary label (optional)',
                    row.auxiliary?.label ?? '',
                    (label) =>
                      setDraft({
                        ...draft,
                        accounts: draft.accounts.map((r, i) =>
                          i === index
                            ? {
                                ...r,
                                auxiliary:
                                  label || r.auxiliary?.number
                                    ? {
                                        label,
                                        number: r.auxiliary?.number ?? '',
                                      }
                                    : null,
                              }
                            : r,
                        ),
                      }),
                  )}
                </div>
              </details>
            ))}
          </fieldset>
          <fieldset disabled={!canReview || busy}>
            <legend>Posted journal mappings ({draft.journals.length})</legend>
            <label>
              Add posted journal
              <select
                value=""
                onChange={(e) => {
                  setConfirmed(false);
                  setDraft({
                    ...draft,
                    journals: [
                      ...draft.journals,
                      {
                        journalId: e.target.value,
                        entrySequence: 0,
                        entryNumber: '',
                        entryKind: 'normal',
                        journalCode: '',
                        journalLabel: '',
                        pieceReference: '',
                        pieceDate: '',
                        entryLabel: '',
                        validationDate: '',
                      },
                    ],
                  });
                }}
              >
                <option value="">Select an unmapped posted journal</option>
                {journals
                  .filter(
                    (j) => !draft.journals.some((m) => m.journalId === j.id),
                  )
                  .map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.effectiveOn} · {j.description}
                    </option>
                  ))}
              </select>
            </label>
            {draft.journals.map((row, index) => {
              const update = (patch: Partial<typeof row>) => {
                setConfirmed(false);
                setDraft({
                  ...draft,
                  journals: draft.journals.map((r, i) =>
                    i === index ? { ...r, ...patch } : r,
                  ),
                });
              };
              return (
                <details key={row.journalId}>
                  <summary>
                    {journals.find((j) => j.id === row.journalId)
                      ?.description ?? row.journalId}
                  </summary>
                  <p>
                    Ledger source:{' '}
                    {journals.find((j) => j.id === row.journalId)
                      ?.sourceReference ?? 'Saved journal mapping'}
                  </p>
                  <div className="finance-fec__grid">
                    {field(
                      'Chronological entry sequence',
                      String(row.entrySequence),
                      (v) => update({ entrySequence: Number(v) }),
                      'number',
                    )}
                    <label>
                      Entry kind
                      <select
                        value={row.entryKind}
                        onChange={(e) =>
                          update({
                            entryKind: e.target.value as typeof row.entryKind,
                          })
                        }
                      >
                        <option value="normal">Normal</option>
                        <option value="opening">Opening</option>
                        <option value="inventory">Inventory</option>
                      </select>
                    </label>
                    {(
                      [
                        'entryNumber',
                        'journalCode',
                        'journalLabel',
                        'pieceReference',
                        'pieceDate',
                        'entryLabel',
                        'validationDate',
                      ] as const
                    ).map((key) => (
                      <div key={key}>
                        {field(
                          {
                            entryNumber: 'Entry number',
                            journalCode: 'Journal code',
                            journalLabel: 'Journal label',
                            pieceReference: 'Document reference',
                            pieceDate: 'Document date',
                            entryLabel: 'Entry label',
                            validationDate: 'Validation date',
                          }[key],
                          row[key],
                          (v) => update({ [key]: v }),
                          key.endsWith('Date') ? 'date' : 'text',
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              );
            })}
          </fieldset>
          {canReview && (
            <>
              <label className="finance-fec__confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I reviewed these legal mappings and their source records.
              </label>
              <button
                type="button"
                disabled={busy || !confirmed}
                onClick={() => void save()}
              >
                Save immutable revision
              </button>
            </>
          )}
          <fieldset disabled={busy || !saved}>
            <legend>Export reviewed revision {saved?.revision ?? '—'}</legend>
            <p>
              Exports use the saved revision. Save reviewed edits before
              exporting. Missing mappings block the download.
            </p>
            <div className="finance-fec__grid">
              {field('Period start', startsOn, setStart, 'date')}
              {field('Period end', endsOn, setEnd, 'date')}
            </div>
            <button
              type="button"
              disabled={
                !startsOn || !endsOn || startsOn > endsOn || busy || !saved
              }
              onClick={() => void runExport()}
            >
              Validate and generate FEC
            </button>
          </fieldset>
          <fieldset disabled={busy}>
            <legend>Recover a saved export</legend>
            <p>
              Keep this export key to retrieve the same saved file after a
              reload or interrupted request.
            </p>
            {field('Saved export key', exportKey, setExportKey)}
            <button
              type="button"
              disabled={busy || !exportKey}
              onClick={async () => {
                const signal = controller.current.signal;
                setBusy(true);
                setResult(undefined);
                setError('');
                try {
                  const value = await readFecExport(bookId, exportKey, signal);
                  if (!signal.aborted) setResult(value);
                } catch (e) {
                  if (!signal.aborted) reportError(e);
                } finally {
                  if (!signal.aborted) setBusy(false);
                }
              }}
            >
              Retrieve saved FEC
            </button>
          </fieldset>
          {result && (
            <section aria-label="FEC review">
              <h3>
                {result.status === 'ready' ? 'FEC ready' : 'Export blocked'}
              </h3>
              <p>
                {result.review.entryCount} entries · {result.review.lineCount}{' '}
                lines
              </p>
              {result.review.errors.length > 0 && (
                <ul>
                  {result.review.errors.map((e, i) => (
                    <li key={i}>
                      {e.message} ({e.path}; {e.code})
                    </li>
                  ))}
                </ul>
              )}
              {result.status === 'ready' && result.file && (
                <button type="button" onClick={() => downloadFec(result)}>
                  Download {result.file.fileName}
                </button>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}

function EvidenceSource({
  label,
  value,
  documents,
  onChange,
}: {
  label: string;
  value: { sourceReference: string; sourceDigest: string };
  documents: z.infer<typeof FecEvidencePage>['documents'];
  onChange: (value: { sourceReference: string; sourceDigest: string }) => void;
}) {
  const [manual, setManual] = useState(
    Boolean(
      value.sourceReference && !value.sourceReference.startsWith('evidence:'),
    ),
  );
  const selected = value.sourceReference.startsWith('evidence:')
    ? value.sourceReference.slice(9)
    : '';
  return (
    <div className="finance-fec__source">
      <label>
        {label} source type
        <select
          value={manual ? 'external' : 'uploaded'}
          onChange={(e) => {
            setManual(e.target.value === 'external');
            onChange(source());
          }}
        >
          <option value="uploaded">Uploaded book document</option>
          <option value="external">Externally reviewed source (manual)</option>
        </select>
      </label>
      {manual ? (
        <>
          <label>
            {label} source reference
            <input
              value={value.sourceReference}
              onChange={(e) =>
                onChange({ ...value, sourceReference: e.target.value })
              }
            />
          </label>
          <label>
            {label} source SHA-256
            <input
              value={value.sourceDigest}
              onChange={(e) =>
                onChange({ ...value, sourceDigest: e.target.value })
              }
            />
          </label>
        </>
      ) : (
        <>
          <label>
            {label} uploaded document
            <select
              value={selected}
              onChange={(e) => {
                const document = documents.find((d) => d.id === e.target.value);
                onChange(
                  document
                    ? {
                        sourceReference: `evidence:${document.id}`,
                        sourceDigest: document.sourceDigest,
                      }
                    : source(),
                );
              }}
            >
              <option value="">Select a source document</option>
              {selected && !documents.some((d) => d.id === selected) && (
                <option value={selected}>Saved document {selected}</option>
              )}
              {documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.filename} · {d.format}
                </option>
              ))}
            </select>
          </label>
          <label>
            {label} source reference
            <input readOnly value={value.sourceReference} />
          </label>
          <label>
            {label} source SHA-256
            <input readOnly value={value.sourceDigest} />
          </label>
        </>
      )}
    </div>
  );
}
