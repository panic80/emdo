import { financeAutomationBlockedReason } from './finance-automation-blocked-reason.js';
import { z } from 'zod';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  FinanceAutomationGrant,
  FinanceAutomationJournalDraftResult,
  FinanceAutomationRunRecord,
  PrepareFinanceAutomationJournalDraftResult,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { useAuth } from '../auth/auth-context.js';
import {
  journalDraftApi,
  JournalDraftError,
  type JournalDraftApi,
} from './finance-journal-drafts-api.js';
type Response<K extends keyof JournalDraftApi> = Awaited<
  ReturnType<JournalDraftApi[K]>
>;
export function FinanceJournalDrafts(props: {
  bookId: string;
  bookName: string;
  role: string;
  grants: FinanceAutomationGrant[] | undefined;
  csrfToken?: string;
}) {
  const auth = useAuth();
  return (
    <Panel
      key={`${auth.sessionBinding}:${auth.state}:${props.bookId}:${props.role}`}
      {...props}
      authenticated={!auth.state || auth.state === 'authenticated'}
    />
  );
}
function Panel({
  bookId,
  bookName,
  role,
  grants,
  csrfToken,
  authenticated,
}: Parameters<typeof FinanceJournalDrafts>[0] & { authenticated: boolean }) {
  const [opened, setOpened] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [sources, setSources] = useState<Response<'sources'>>(),
    [accounts, setAccounts] = useState<Response<'accounts'>>(),
    [list, setList] = useState<Response<'list'>>();
  const [batchId, setBatchId] = useState(''),
    [grantId, setGrantId] = useState(''),
    [prepared, setPrepared] =
      useState<PrepareFinanceAutomationJournalDraftResult>(),
    [run, setRun] = useState<FinanceAutomationRunRecord>(),
    [detail, setDetail] = useState<FinanceAutomationJournalDraftResult>();
  const [postConfirmation, setPostConfirmation] = useState(false),
    [visible, setVisible] = useState(10),
    [lineLimit, setLineLimit] = useState(100);
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
      Boolean(csrfToken),
    canReview = canPrepare && ['administrator', 'approver'].includes(role);
  const activeGrants =
    grants?.filter(
      (g) =>
        g.bookId === bookId &&
        g.status === 'active' &&
        g.allowedCapabilities.includes('finance.journals.draft') &&
        Date.parse(g.validFrom) <= Date.now() &&
        Date.parse(g.expiresAt) > Date.now(),
    ) ?? [];
  const selectedGrant = activeGrants.find((g) => g.id === grantId);
  function key(identity: unknown) {
    const value = JSON.stringify(identity);
    let saved = keys.current.get(value);
    if (!saved) {
      saved = crypto.randomUUID();
      keys.current.set(value, saved);
    }
    return saved;
  }
  function clear() {
    setOpened(false);
    setSources(undefined);
    setAccounts(undefined);
    setList(undefined);
    setPrepared(undefined);
    setRun(undefined);
    setDetail(undefined);
    setBatchId('');
    setGrantId('');
    setPostConfirmation(false);
    keys.current.clear();
  }
  async function action(work: (api: JournalDraftApi) => Promise<void>) {
    if (working.current || !authenticated) return;
    working.current = true;
    setBusy(true);
    setError('');
    controller.current?.abort();
    const control = new AbortController();
    controller.current = control;
    try {
      await work(journalDraftApi(bookId, control.signal));
    } catch (cause) {
      if (alive.current && !control.signal.aborted) {
        if (
          cause instanceof JournalDraftError &&
          [401, 403].includes(cause.status)
        )
          clear();
        setError(
          cause instanceof z.ZodError
            ? cause.issues.map((issue) => issue.message).join(' ')
            : cause instanceof Error
              ? cause.message
              : 'Journal draft review unavailable.',
        );
      }
    } finally {
      working.current = false;
      if (alive.current && !control.signal.aborted) setBusy(false);
    }
  }
  function load() {
    void action(async (api) => {
      const [s, a, l] = await Promise.all([
        api.sources(),
        api.accounts(),
        api.list(),
      ]);
      if (alive.current) {
        setSources(s);
        setAccounts(a);
        setList(l);
        setDetail(undefined);
        setPostConfirmation(false);
        setOpened(true);
      }
    });
  }
  function show(value: FinanceAutomationJournalDraftResult) {
    setDetail(value);
    setPostConfirmation(false);
    setVisible(10);
    setLineLimit(100);
  }
  function name(id: string) {
    return (
      sources?.imports.find((item) => item.id === id)?.filename ??
      `Saved import ${id.slice(-8)}`
    );
  }
  function update(operation: 'review' | 'discard' | 'post', body: unknown) {
    if (
      !detail ||
      !csrfToken ||
      !canPrepare ||
      (operation !== 'discard' && !canReview)
    )
      return;
    const selected = detail;
    void action(async (api) => {
      const value = await api.update(
        selected.id,
        operation,
        body,
        csrfToken,
        key([operation, selected.id, body]),
      );
      if (alive.current) show(value);
    });
  }
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail) return;
    const form = new FormData(event.currentTarget);
    update('review', {
      expectedRevision: detail.revision,
      decision: form.get('decision'),
      reason: String(form.get('reason')).trim() || null,
    });
  }
  return (
    <section aria-label="Journal draft automation">
      <h3>Prepare and review journal drafts</h3>
      <p>
        Choose a reviewed import in {bookName}. Preparation pins its source
        revision and reports the exact proposed scope. Queuing creates drafts
        for review; posting requires a separate decision.
      </p>
      <Button variant="quiet" disabled={busy || !authenticated} onClick={load}>
        {opened ? 'Refresh journal drafts' : 'Open journal drafts'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {opened && (
        <>
          {canPrepare && (
            <fieldset disabled={busy}>
              <legend>Prepare a saved import</legend>
              <label>
                Saved source import
                <select
                  value={batchId}
                  onChange={(event) => {
                    setBatchId(event.target.value);
                    setPrepared(undefined);
                    setRun(undefined);
                  }}
                >
                  <option value="">
                    Choose an import checked in Documents
                  </option>
                  {sources?.imports
                    .filter((item) => item.status === 'review')
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.filename} · revision {item.revision}
                      </option>
                    ))}
                </select>
              </label>
              <p>
                Complete account, row and component reviews in Documents first.
                Preparation validates the saved source without posting it.
              </p>
              <Button
                type="button"
                disabled={!batchId}
                onClick={() =>
                  void action(async (api) => {
                    const value = await api.prepare(
                      batchId,
                      csrfToken!,
                      key([
                        'prepare',
                        batchId,
                        sources?.imports.find((item) => item.id === batchId)
                          ?.revision,
                      ]),
                    );
                    if (alive.current) {
                      setPrepared(value);
                      setRun(undefined);
                    }
                  })
                }
              >
                Prepare journal scope
              </Button>
            </fieldset>
          )}
          {prepared && (
            <section aria-label="Prepared journal scope">
              <h4>Review the prepared scope</h4>
              <dl>
                <dt>Source</dt>
                <dd>
                  {name(prepared.journal.batchId)} · revision{' '}
                  {prepared.journal.expectedBatchRevision}
                </dd>
                <dt>Proposed journal lines</dt>
                <dd>{prepared.itemCount}</dd>
                <dt>Functional debit total</dt>
                <dd>
                  {prepared.amount} {prepared.currency}
                </dd>
              </dl>
              <p>These amounts and counts come from the saved preparation.</p>
              {role === 'administrator' && (
                <fieldset disabled={busy}>
                  <label>
                    Journal draft grant
                    <select
                      value={grantId}
                      onChange={(event) => setGrantId(event.target.value)}
                    >
                      <option value="">Choose an active grant</option>
                      {activeGrants
                        .filter((g) => g.limits.currency === prepared.currency)
                        .map((g) => (
                          <option key={g.id} value={g.id}>
                            Draft journals · {g.limits.currency} · revision{' '}
                            {g.revision} · expires {g.expiresAt.slice(0, 10)}
                          </option>
                        ))}
                    </select>
                  </label>
                  <Button
                    type="button"
                    disabled={!canPrepare || !selectedGrant || Boolean(run)}
                    onClick={() =>
                      void action(async (api) => {
                        const value = await api.enqueue(
                          prepared,
                          selectedGrant!,
                          csrfToken!,
                          key([
                            'enqueue',
                            selectedGrant!.id,
                            selectedGrant!.revision,
                            prepared,
                          ]),
                        );
                        if (alive.current) setRun(value);
                      })
                    }
                  >
                    Queue reviewed journal draft
                  </Button>
                </fieldset>
              )}
              {role !== 'administrator' && (
                <p>
                  An administrator with an active draft grant can queue this
                  prepared scope.
                </p>
              )}
            </section>
          )}
          {run && (
            <section aria-label="Journal draft run">
              <h4>Saved draft run · {run.run.status}</h4>
              <p>
                {name(run.run.request.journal!.batchId)} ·{' '}
                {run.run.request.itemCount} lines · {run.run.request.amount}{' '}
                {run.run.request.currency}
              </p>
              {run.blockedReason && (
                <p>{financeAutomationBlockedReason(run.blockedReason)}</p>
              )}
              <Button
                disabled={busy}
                onClick={() =>
                  void action(async (api) => {
                    const value = await api.run(run.run.request.operationId);
                    if (alive.current) setRun(value);
                    if (value.run.status === 'completed') {
                      const result = await api.outcome(value);
                      if (alive.current) show(result);
                    }
                  })
                }
              >
                Refresh draft run
              </Button>
            </section>
          )}
          <section aria-label="Saved journal drafts">
            <h4>Saved drafts</h4>
            {list?.items.map((item) => (
              <Button
                key={item.id}
                variant="quiet"
                disabled={busy}
                onClick={() =>
                  void action(async (api) => {
                    const value = await api.read(item.id);
                    if (alive.current) show(value);
                  })
                }
              >
                {name(item.source.batchId)} · {item.status.replaceAll('_', ' ')}{' '}
                · revision {item.revision}
              </Button>
            ))}
            {list?.items.length === 0 && <p>No saved draft results.</p>}
            {list && list.offset + list.items.length < list.total && (
              <Button
                disabled={busy}
                onClick={() =>
                  void action(async (api) => {
                    const value = await api.list(list.offset + list.limit);
                    if (alive.current) setList(value);
                  })
                }
              >
                Next drafts
              </Button>
            )}
          </section>
          {detail && (
            <section
              key={`${detail.id}:${detail.revision}`}
              aria-label="Saved journal draft detail"
            >
              <h4>
                {name(detail.source.batchId)} ·{' '}
                {detail.status.replaceAll('_', ' ')} · revision{' '}
                {detail.revision}
              </h4>
              <p>
                {detail.itemCount} journal lines · functional debit total{' '}
                {detail.amount} {detail.currency}. Posting:{' '}
                {detail.posting === 'performed' ? 'Performed' : 'Not performed'}
                .
              </p>
              <p>
                Source import revision {detail.source.batchRevision};{' '}
                {detail.source.rows.length} saved source rows. Evidence
                reference {detail.source.evidenceId}.
              </p>
              <details>
                <summary>Saved source fingerprints and row revisions</summary>
                <p>
                  Original fingerprint:{' '}
                  <code style={{ overflowWrap: 'anywhere' }}>
                    {detail.source.sourceDigest}
                  </code>
                </p>
                <p>
                  Reviewed snapshot:{' '}
                  <code style={{ overflowWrap: 'anywhere' }}>
                    {detail.source.snapshotHash}
                  </code>
                </p>
                {detail.source.rows.slice(0, visible).map((row) => (
                  <p key={row.rowId}>
                    Source row {row.sourceRow} · revision {row.revision} ·{' '}
                    {row.componentRevisions.length} saved component revisions
                  </p>
                ))}
              </details>
              {detail.proposal.journals
                .slice(0, visible)
                .map((journal, index) => (
                  <article key={index}>
                    <h5>
                      {journal.effectiveOn} · {journal.description}
                    </h5>
                    <p>Source: {journal.sourceReference}</p>
                    <div
                      className="finance-table-scroll"
                      tabIndex={0}
                      role="region"
                      aria-label={`Journal ${index + 1} line details`}
                    >
                      <table>
                        <caption>Proposed journal {index + 1}</caption>
                        <thead>
                          <tr>
                            <th>Account</th>
                            <th>Side</th>
                            <th>Functional amount</th>
                            <th>Source amount</th>
                            <th>FX evidence</th>
                          </tr>
                        </thead>
                        <tbody>
                          {journal.lines
                            .slice(0, lineLimit)
                            .map((line, lineIndex) => (
                              <tr key={lineIndex}>
                                <td>
                                  {accounts?.trialBalance.find(
                                    (a) => a.id === line.accountId,
                                  )?.name ??
                                    `Account ${line.accountId.slice(-8)}`}
                                  {line.description && (
                                    <p>{line.description}</p>
                                  )}
                                </td>
                                <td>{line.side}</td>
                                <td>
                                  {line.amount} {detail.currency}
                                </td>
                                <td>
                                  {line.nativeAmount} {line.currency}
                                </td>
                                <td>
                                  {line.fxRate} · {line.fxSource}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                    {journal.lines.length > lineLimit && (
                      <Button
                        type="button"
                        onClick={() => setLineLimit((value) => value + 100)}
                      >
                        Show more lines
                      </Button>
                    )}
                  </article>
                ))}
              {(detail.proposal.journals.length > visible ||
                detail.source.rows.length > visible ||
                detail.events.length > visible) && (
                <Button
                  type="button"
                  onClick={() => setVisible((value) => value + 10)}
                >
                  Show more journals and source rows
                </Button>
              )}
              {detail.review && (
                <p>
                  Saved review: {detail.review.decision} ·{' '}
                  {detail.review.reason ?? 'No review note'} ·{' '}
                  {detail.review.at}
                </p>
              )}
              {canReview &&
                ['review_required', 'rejected'].includes(detail.status) && (
                  <form onSubmit={review}>
                    <fieldset disabled={busy}>
                      <legend>Review the saved draft</legend>
                      <label>
                        Draft decision
                        <select name="decision" required defaultValue="">
                          <option value="" disabled>
                            Choose a decision
                          </option>
                          <option value="approved">Approve draft</option>
                          <option value="rejected">Reject draft</option>
                        </select>
                      </label>
                      <label>
                        Review reason
                        <textarea
                          name="reason"
                          required
                          minLength={3}
                          maxLength={500}
                        />
                      </label>
                      <Button type="submit">Save draft review</Button>
                    </fieldset>
                  </form>
                )}
              {canReview &&
                detail.status === 'approved' &&
                !postConfirmation && (
                  <Button
                    disabled={busy}
                    onClick={() => setPostConfirmation(true)}
                  >
                    Review posting action
                  </Button>
                )}
              {canReview &&
                detail.status === 'approved' &&
                postConfirmation && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (
                        new FormData(event.currentTarget).get('confirmed') ===
                        'on'
                      )
                        update('post', { expectedRevision: detail.revision });
                    }}
                  >
                    <fieldset disabled={busy}>
                      <legend>Confirm posting</legend>
                      <p>
                        This posts the approved saved journal lines to{' '}
                        {bookName}. The server revalidates the pinned source and
                        fiscal periods.
                      </p>
                      <label>
                        <input name="confirmed" type="checkbox" required />I
                        reviewed the approved journals and authorize posting
                        this draft.
                      </label>
                      <Button type="submit">
                        Confirm and post approved draft
                      </Button>
                      <Button
                        type="button"
                        variant="quiet"
                        onClick={() => setPostConfirmation(false)}
                      >
                        Cancel posting
                      </Button>
                    </fieldset>
                  </form>
                )}
              {canPrepare &&
                !['posted', 'discarded'].includes(detail.status) && (
                  <details>
                    <summary>Discard this draft</summary>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        update('discard', {
                          expectedRevision: detail.revision,
                          reason: new FormData(event.currentTarget).get(
                            'discardReason',
                          ),
                        });
                      }}
                    >
                      <fieldset disabled={busy}>
                        <label>
                          Discard reason
                          <textarea
                            name="discardReason"
                            required
                            minLength={3}
                            maxLength={500}
                          />
                        </label>
                        <Button type="submit">Discard saved draft</Button>
                      </fieldset>
                    </form>
                  </details>
                )}
              <h5>Saved actions</h5>
              <ol>
                {detail.events.slice(0, visible).map((event) => (
                  <li key={event.revision}>
                    Revision {event.revision} · {event.kind} · {event.at}
                    {'decision' in event ? ` · ${event.decision}` : ''}
                    {'reason' in event && event.reason
                      ? ` · ${event.reason}`
                      : ''}
                  </li>
                ))}
              </ol>
              {detail.postedJournalIds.length > 0 && (
                <p>
                  {detail.postedJournalIds.length} posted journal references
                  retained in this saved result.
                </p>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
