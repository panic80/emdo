import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  InvestmentReconciliationCase,
  InvestmentReconciliationComparison,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { useAuth } from '../auth/auth-context.js';
import {
  investmentReconciliationApi,
  InvestmentReconciliationError,
  type InvestmentReconciliationApi,
} from './finance-investment-reconciliation-api.js';
type Result<K extends keyof InvestmentReconciliationApi> = Awaited<
  ReturnType<InvestmentReconciliationApi[K]>
>;
export function FinanceInvestmentReconciliation({
  bookId,
  role,
}: {
  bookId: string;
  role: string;
}) {
  const auth = useAuth();
  return (
    <Panel
      key={`${bookId}:${auth.sessionBinding}:${auth.state}:${role}`}
      bookId={bookId}
      role={role}
      csrf={auth.csrfToken}
      authenticated={!auth.state || auth.state === 'authenticated'}
    />
  );
}
function Panel({
  bookId,
  role,
  csrf,
  authenticated,
}: {
  bookId: string;
  role: string;
  csrf?: string;
  authenticated: boolean;
}) {
  const [opened, setOpened] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [cases, setCases] = useState<Result<'list'>>(),
    [detail, setDetail] = useState<InvestmentReconciliationCase>();
  const [runs, setRuns] = useState<Result<'runs'>>(),
    [catalog, setCatalog] = useState<Result<'catalog'>>(),
    [documents, setDocuments] = useState<Result<'documents'>>();
  const [runId, setRunId] = useState(''),
    [selectedRun, setSelectedRun] = useState<Result<'run'>>(),
    [positionId, setPositionId] = useState(''),
    [preview, setPreview] = useState<Result<'preview'>>();
  const [resolutionKind, setResolutionKind] = useState('');
  const [corrective, setCorrective] = useState<Result<'correctiveRecords'>>();
  const alive = useRef(true),
    working = useRef(false),
    controller = useRef<AbortController | undefined>(undefined),
    keys = useRef(new Map<string, string>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  const canPrepare =
    authenticated &&
    ['administrator', 'preparer', 'approver'].includes(role) &&
    Boolean(csrf);
  function clear() {
    setCorrective(undefined);
    setOpened(false);
    setCases(undefined);
    setDetail(undefined);
    setRuns(undefined);
    setCatalog(undefined);
    setDocuments(undefined);
    setRunId('');
    setSelectedRun(undefined);
    setPositionId('');
    setPreview(undefined);
    keys.current.clear();
  }
  async function action(
    work: (api: InvestmentReconciliationApi) => Promise<void>,
  ) {
    if (working.current || !authenticated) return;
    working.current = true;
    setBusy(true);
    setError('');
    controller.current?.abort();
    const control = new AbortController();
    controller.current = control;
    try {
      await work(investmentReconciliationApi(bookId, control.signal));
    } catch (cause) {
      if (alive.current && !control.signal.aborted) {
        if (
          cause instanceof InvestmentReconciliationError &&
          [401, 403].includes(cause.status)
        )
          clear();
        setError(
          cause instanceof Error
            ? cause.message
            : 'Reconciliation review unavailable.',
        );
      }
    } finally {
      working.current = false;
      if (alive.current && !control.signal.aborted) setBusy(false);
    }
  }
  function load() {
    void action(async (api) => {
      const [items, valuations, sources, docs] = await Promise.all([
        api.list(),
        api.runs(),
        api.catalog(),
        api.documents(),
      ]);
      if (alive.current) {
        setCases(items);
        setRuns(valuations);
        setCatalog(sources);
        setDocuments(docs);
        setDetail(undefined);
        setPreview(undefined);
        setOpened(true);
      }
    });
  }
  function evidenceName(id: string) {
    return (
      documents?.documents.find((doc) => doc.id === id)?.filename ??
      `Saved evidence ${id}`
    );
  }
  function instrumentName(id: unknown) {
    return String(
      catalog?.instruments.find((item) => item.id === id)?.name ??
        'Selected instrument',
    );
  }
  function comparison(value: InvestmentReconciliationComparison) {
    return (
      <div>
        <p>
          {instrumentName(value.instrumentId)} · {value.asOf} · {value.status}
        </p>
        <dl>
          <dt>Observed quantity</dt>
          <dd>{value.observedQuantity}</dd>
          <dt>Calculated quantity</dt>
          <dd>{value.calculatedQuantity ?? 'Unavailable'}</dd>
          <dt>Difference (observed − calculated)</dt>
          <dd>{value.difference ?? 'Unavailable'}</dd>
          <dt>Original source</dt>
          <dd>
            {evidenceName(value.evidenceId)} · row {value.sourceRow}
          </dd>
        </dl>
      </div>
    );
  }
  async function save(kind: 'create' | 'resolve' | 'reopen', input: unknown) {
    if (!canPrepare) return;
    const id = kind === 'create' ? undefined : detail?.id;
    const identity = JSON.stringify([kind, id, input]);
    let key = keys.current.get(identity);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(identity, key);
    }
    await action(async (api) => {
      const saved = await api.save(kind, input, csrf!, key!, id);
      const records = await api.correctiveRecords(saved.id);
      if (alive.current) {
        setDetail(saved);
        setCorrective(records);
        setPreview(undefined);
        setResolutionKind('');
        setCases(undefined);
      }
    });
  }
  function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || detail.effectiveStatus !== 'open' || !detail.sourcesCurrent)
      return;
    const form = new FormData(event.currentTarget);
    void save('resolve', {
      expectedRevision: detail.revision,
      expectedComparisonHash: detail.comparison.comparisonHash,
      resolution: {
        kind: resolutionKind,
        explanation: form.get('explanation'),
        evidenceIds: form.getAll('evidence'),
        correctiveRecords:
          resolutionKind === 'corrective-records'
            ? form.getAll('corrective').map((value) => {
                const record = corrective?.items.find(
                  (item) => `${item.kind}:${item.id}` === value,
                );
                if (!record)
                  throw new Error('Choose an available corrective record.');
                return { kind: record.kind, id: record.id };
              })
            : [],
      },
    });
  }
  function reopen(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !detail ||
      !preview?.sourcesCurrent ||
      preview.comparison.valuationRunId === detail.comparison.valuationRunId
    )
      return;
    const form = new FormData(event.currentTarget);
    void save('reopen', {
      expectedRevision: detail.revision,
      valuationRunId: preview.comparison.valuationRunId,
      observedPositionId: preview.comparison.observedPositionId,
      expectedComparisonHash: preview.comparison.comparisonHash,
      reason: form.get('reason'),
    });
  }
  return (
    <section aria-label="Investment reconciliation cases">
      <h4>Reconcile investment quantities</h4>
      <p>
        Review saved statement quantities against a saved valuation.
        Reconciliation records explanations and existing corrections without
        creating balancing entries.
      </p>
      <Button variant="quiet" disabled={busy || !authenticated} onClick={load}>
        {opened
          ? 'Refresh reconciliation sources'
          : 'Open reconciliation review'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {opened && (
        <>
          <section aria-label="Saved reconciliation cases">
            <h5>Saved cases</h5>
            {cases?.items.map((item) => (
              <Button
                key={item.id}
                variant="quiet"
                disabled={busy}
                onClick={() =>
                  void action(async (api) => {
                    const saved = await api.read(item.id);
                    const records = await api.correctiveRecords(item.id);
                    if (alive.current) {
                      setDetail(saved);
                      setCorrective(records);
                      setPreview(undefined);
                      setResolutionKind('');
                    }
                  })
                }
              >
                {instrumentName(item.comparison.instrumentId)} ·{' '}
                {item.comparison.asOf} · {item.effectiveStatus} · revision{' '}
                {item.revision}
              </Button>
            ))}
            {cases && cases.items.length === 0 && <p>No saved cases.</p>}
            {cases && cases.offset + cases.items.length < cases.total && (
              <Button
                disabled={busy}
                onClick={() =>
                  void action(async (api) =>
                    setCases(await api.list(cases.offset + cases.limit)),
                  )
                }
              >
                Next cases
              </Button>
            )}
          </section>
          {canPrepare && (
            <fieldset disabled={busy}>
              <legend>
                {detail
                  ? 'Select a newer saved valuation to reopen'
                  : 'Choose a saved comparison'}
              </legend>
              <label>
                Saved valuation
                <select
                  value={runId}
                  onChange={(event) => {
                    const id = event.target.value;
                    setRunId(id);
                    setPositionId('');
                    setSelectedRun(undefined);
                    setPreview(undefined);
                    if (id)
                      void action(async (api) => {
                        const value = await api.run(id);
                        if (alive.current) setSelectedRun(value);
                      });
                  }}
                >
                  <option value="">Choose a saved valuation</option>
                  {runs?.runs.map((run) => (
                    <option value={run.id} key={run.id}>
                      {run.asOf} · {run.status} · {run.calculationVersion} ·{' '}
                      {run.id.slice(-8)}
                    </option>
                  ))}
                </select>
              </label>
              {runs?.nextOffset !== null && runs?.nextOffset !== undefined && (
                <Button
                  type="button"
                  onClick={() =>
                    void action(async (api) => {
                      const next = await api.runs(runs.nextOffset!);
                      if (alive.current)
                        setRuns({
                          runs: [...runs.runs, ...next.runs],
                          nextOffset: next.nextOffset,
                        });
                    })
                  }
                >
                  Load older valuations
                </Button>
              )}
              <label>
                Observed statement position
                <select
                  value={positionId}
                  onChange={(event) => {
                    setPositionId(event.target.value);
                    setPreview(undefined);
                  }}
                >
                  <option value="">Choose a source position</option>
                  {selectedRun?.result.reconciliations.map((item) => (
                    <option
                      value={item.observedPositionId}
                      key={item.observedPositionId}
                    >
                      {evidenceName(item.evidenceId)} · row {item.sourceRow} ·
                      quantity {item.observedQuantity}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="button"
                disabled={!runId || !positionId}
                onClick={() =>
                  void action(async (api) => {
                    const value = await api.preview({
                      valuationRunId: runId,
                      observedPositionId: positionId,
                    });
                    if (alive.current) setPreview(value);
                  })
                }
              >
                Preview saved comparison
              </Button>
            </fieldset>
          )}
          {preview && (
            <section aria-label="Reviewed comparison preview">
              <h5>Saved comparison preview</h5>
              {comparison(preview.comparison)}
              {!preview.sourcesCurrent && (
                <p>
                  The underlying sources changed. Save a new valuation before
                  creating or reopening a case.
                </p>
              )}
              {!detail ? (
                <Button
                  disabled={busy || !canPrepare || !preview.sourcesCurrent}
                  onClick={() =>
                    void save('create', {
                      valuationRunId: preview.comparison.valuationRunId,
                      observedPositionId: preview.comparison.observedPositionId,
                      expectedComparisonHash: preview.comparison.comparisonHash,
                    })
                  }
                >
                  Create reconciliation case
                </Button>
              ) : (
                <form onSubmit={reopen}>
                  <label>
                    Reason for reopening
                    <textarea
                      name="reason"
                      required
                      minLength={10}
                      maxLength={4000}
                    />
                  </label>
                  <Button
                    type="submit"
                    disabled={
                      busy ||
                      !canPrepare ||
                      !preview.sourcesCurrent ||
                      preview.comparison.valuationRunId ===
                        detail.comparison.valuationRunId
                    }
                  >
                    Reopen with reviewed valuation
                  </Button>
                </form>
              )}
            </section>
          )}
          {detail && (
            <section aria-label="Saved reconciliation detail">
              <h5>
                Saved case · revision {detail.revision} ·{' '}
                {detail.effectiveStatus}
              </h5>
              {comparison(detail.comparison)}
              <p>No accounting entries were created.</p>
              {detail.effectiveStatus === 'reopen-required' && (
                <p>
                  Sources changed after this comparison. Resolution is
                  unavailable until you explicitly reopen with a newer saved
                  valuation.
                </p>
              )}
              <Button
                type="button"
                disabled={busy}
                variant="quiet"
                onClick={() => {
                  setDetail(undefined);
                  setPreview(undefined);
                  setResolutionKind('');
                }}
              >
                Start a different case
              </Button>
              {canPrepare &&
                detail.effectiveStatus === 'open' &&
                detail.sourcesCurrent && (
                  <form onSubmit={resolve}>
                    <fieldset disabled={busy}>
                      <legend>Review resolution</legend>
                      <label>
                        Resolution type
                        <select
                          required
                          value={resolutionKind}
                          onChange={(event) =>
                            setResolutionKind(event.target.value)
                          }
                        >
                          <option value="">Choose a resolution</option>
                          <option value="reviewed-explanation">
                            Reviewed explanation
                          </option>
                          <option value="corrective-records">
                            Existing corrective records
                          </option>
                        </select>
                      </label>
                      <label>
                        Reviewed explanation
                        <textarea
                          name="explanation"
                          required
                          minLength={10}
                          maxLength={4000}
                        />
                      </label>
                      <fieldset>
                        <legend>
                          Supporting saved documents (select at least one)
                        </legend>
                        {documents?.documents.map((doc) => (
                          <label key={doc.id}>
                            <input
                              type="checkbox"
                              name="evidence"
                              value={doc.id}
                            />
                            {doc.filename}
                          </label>
                        ))}
                        {documents?.nextOffset !== null &&
                          documents?.nextOffset !== undefined && (
                            <Button
                              type="button"
                              onClick={() =>
                                void action(async (api) => {
                                  const next = await api.documents(
                                    documents.nextOffset!,
                                  );
                                  if (alive.current)
                                    setDocuments({
                                      documents: [
                                        ...documents.documents,
                                        ...next.documents,
                                      ],
                                      nextOffset: next.nextOffset,
                                    });
                                })
                              }
                            >
                              Load more documents
                            </Button>
                          )}
                      </fieldset>
                      {resolutionKind === 'corrective-records' && (
                        <fieldset>
                          <legend>Existing corrective records</legend>
                          <p>
                            Select only saved records that explain this
                            difference.
                          </p>
                          {corrective?.items.map((item) => (
                            <label key={`${item.kind}:${item.id}`}>
                              <input
                                type="checkbox"
                                name="corrective"
                                value={`${item.kind}:${item.id}`}
                              />
                              {item.label} · {item.effectiveOn} ·{' '}
                              {item.kind.replaceAll('-', ' ')}
                            </label>
                          ))}
                          {corrective && corrective.items.length === 0 && (
                            <p>
                              No eligible saved corrective records are
                              available.
                            </p>
                          )}
                          {corrective &&
                            corrective.offset + corrective.items.length <
                              corrective.total && (
                              <Button
                                type="button"
                                onClick={() =>
                                  void action(async (api) => {
                                    const next = await api.correctiveRecords(
                                      detail.id,
                                      corrective.offset +
                                        corrective.items.length,
                                    );
                                    if (alive.current)
                                      setCorrective({
                                        ...next,
                                        offset: corrective.offset,
                                        items: [
                                          ...corrective.items,
                                          ...next.items,
                                        ],
                                      });
                                  })
                                }
                              >
                                Load more corrective records
                              </Button>
                            )}
                        </fieldset>
                      )}
                      <Button type="submit">Save reviewed resolution</Button>
                    </fieldset>
                  </form>
                )}
              <h5>Saved review history</h5>
              <ol>
                {detail.history.map((event) => (
                  <li key={event.revision}>
                    <p>
                      Revision {event.revision} · {event.kind} ·{' '}
                      {event.createdAt}
                    </p>
                    {comparison(event.comparison)}
                    {event.reason && <p>{event.reason}</p>}
                    {event.resolution && (
                      <>
                        <p>{event.resolution.explanation}</p>
                        <p>
                          Supporting evidence:{' '}
                          {event.resolution.evidenceIds
                            .map(evidenceName)
                            .join(', ')}
                        </p>
                        <details>
                          <summary>
                            Saved evidence and corrective record snapshots
                          </summary>
                          <ul>
                            {event.evidenceSnapshots.map((snapshot, index) => (
                              <li key={index}>
                                {typeof snapshot.id === 'string'
                                  ? evidenceName(snapshot.id)
                                  : 'Supporting document'}
                                {typeof snapshot.sourceDigest === 'string' && (
                                  <p>
                                    Saved fingerprint:{' '}
                                    <code style={{ overflowWrap: 'anywhere' }}>
                                      {snapshot.sourceDigest}
                                    </code>
                                  </p>
                                )}
                              </li>
                            ))}
                          </ul>
                          <ul>
                            {event.correctiveRecordSnapshots.map(
                              (record, index) => {
                                const values =
                                  record.snapshot &&
                                  typeof record.snapshot === 'object' &&
                                  !Array.isArray(record.snapshot)
                                    ? (record.snapshot as Record<
                                        string,
                                        unknown
                                      >)
                                    : {};
                                return (
                                  <li key={index}>
                                    {String(
                                      record.kind ?? 'Corrective record',
                                    ).replaceAll('-', ' ')}
                                    <dl>
                                      {[
                                        'as_of',
                                        'effective_on',
                                        'quantity',
                                        'quantity_delta',
                                        'amount',
                                        'cash_amount',
                                        'source_reference',
                                      ]
                                        .filter(
                                          (key) =>
                                            typeof values[key] === 'string' ||
                                            typeof values[key] === 'number',
                                        )
                                        .map((key) => (
                                          <div key={key}>
                                            <dt>{key.replaceAll('_', ' ')}</dt>
                                            <dd>{String(values[key])}</dd>
                                          </div>
                                        ))}
                                    </dl>
                                  </li>
                                );
                              },
                            )}
                          </ul>
                        </details>
                        <p>
                          {event.resolution.kind === 'corrective-records'
                            ? `${event.resolution.correctiveRecords.length} existing corrective records retained with this review.`
                            : 'Reviewed explanation; no correction claimed.'}
                        </p>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </>
      )}
    </section>
  );
}
