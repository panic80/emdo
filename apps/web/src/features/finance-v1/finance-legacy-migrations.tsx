import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  FinanceLegacyMigrationComparisonSchema,
  FinanceLegacyMigrationCutoverSchema,
  FinanceOpeningProofSchema,
  FinanceLegacyMigrationReviewDecisionSchema,
  type FinanceLegacyMigrationRecord,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { useAuth } from '../auth/auth-context.js';
import {
  checkInspection,
  migrationMutation,
  MigrationRequestError,
  readMigration,
  readMigrations,
  readMigrationAccounts,
  readMigrationSources,
  readMigrationEvidence,
  type MigrationInspection,
  type MigrationOperation,
} from './finance-legacy-migration-api.js';
export type FinanceLegacyMigrationsProps = {
  bookId: string;
  bookName: string;
  role: string;
  accounts: readonly { id: string; code: string; name: string }[];
};
export function FinanceLegacyMigrations(props: FinanceLegacyMigrationsProps) {
  const auth = useAuth();
  return (
    <MigrationPanel
      key={`${auth.sessionBinding}:${props.bookId}:${props.role}`}
      {...props}
    />
  );
}
const payloadObject = (
  record: FinanceLegacyMigrationRecord,
): Readonly<Record<string, unknown>> =>
  record.payload &&
  typeof record.payload === 'object' &&
  !Array.isArray(record.payload)
    ? (record.payload as Readonly<Record<string, unknown>>)
    : {};
const recordLabel = (record: FinanceLegacyMigrationRecord) => {
  const payload = payloadObject(record);
  return String(payload.name ?? payload.description ?? record.entityId);
};
const displayCadCents = (cents: string) => {
  const negative = cents.startsWith('-');
  const digits = (negative ? cents.slice(1) : cents).padStart(3, '0');
  return `CAD ${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
};
function MigrationPanel({
  bookId,
  bookName,
  role,
  accounts,
}: FinanceLegacyMigrationsProps) {
  const auth = useAuth();
  const [sources, setSources] = useState<
    Awaited<ReturnType<typeof readMigrationSources>>['sources']
  >([]);
  const [financialAccounts, setFinancialAccounts] = useState<
    Awaited<ReturnType<typeof readMigrationAccounts>>['accounts']
  >([]);
  const [runs, setRuns] = useState<
    Awaited<ReturnType<typeof readMigrations>>['runs']
  >([]);
  const [evidence, setEvidence] = useState<
    Awaited<ReturnType<typeof readMigrationEvidence>>['documents']
  >([]);
  const [nextEvidence, setNextEvidence] = useState<number | null>(0);
  const [sourceId, setSourceId] = useState('');
  const [inspection, setInspection] = useState<MigrationInspection>();
  const [recordId, setRecordId] = useState('');
  const [page, setPage] = useState(0);
  const [comparison, setComparison] =
    useState<z.output<typeof FinanceLegacyMigrationComparisonSchema>>();
  const [opening, setOpening] =
    useState<z.output<typeof FinanceOpeningProofSchema>>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [approvalConfirmed, setApprovalConfirmed] = useState(false);
  const controller = useRef(new AbortController());
  const working = useRef(false);
  const mutate = useRef(migrationMutation());
  const canReview =
    ['administrator', 'preparer', 'approver'].includes(role) &&
    !!auth.csrfToken;
  const canApprove =
    ['administrator', 'approver'].includes(role) && !!auth.csrfToken;
  const selected = inspection?.records.find((record) => record.id === recordId);
  const openingMapping =
    selected &&
    inspection?.run.mapping.openings.find(
      (entry) => entry.legacyAccountId === selected.entityId,
    );
  function fail(cause: unknown) {
    if (
      cause instanceof MigrationRequestError &&
      [401, 403].includes(cause.status)
    ) {
      setReady(false);
      setInspection(undefined);
      setComparison(undefined);
      setOpening(undefined);
      setSources([]);
      setRuns([]);
      setEvidence([]);
      setFinancialAccounts([]);
    }
    setError(
      cause instanceof Error ? cause.message : 'Migration could not be loaded.',
    );
  }
  async function action(work: (signal: AbortSignal) => Promise<void>) {
    if (working.current || controller.current.signal.aborted) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work(controller.current.signal);
    } catch (cause) {
      if (!controller.current.signal.aborted) fail(cause);
    } finally {
      working.current = false;
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  async function catalog(signal: AbortSignal) {
    const [sourceResult, runResult, accountResult, evidenceResult] =
      await Promise.all([
        readMigrationSources(bookId, signal),
        readMigrations(bookId, signal),
        readMigrationAccounts(bookId, signal),
        readMigrationEvidence(bookId, 0, signal),
      ]);
    if (signal.aborted) return;
    setSources(sourceResult.sources);
    setRuns(runResult.runs);
    setFinancialAccounts(accountResult.accounts);
    setEvidence(evidenceResult.documents);
    setNextEvidence(evidenceResult.nextOffset);
    setReady(true);
  }
  useEffect(() => {
    const request = new AbortController();
    controller.current = request;
    working.current = true;
    setBusy(true);
    void catalog(request.signal)
      .catch((cause) => {
        if (!request.signal.aborted) fail(cause);
      })
      .finally(() => {
        if (!request.signal.aborted) {
          working.current = false;
          setBusy(false);
        }
      });
    return () => request.abort();
  }, []);
  async function refresh(migrationId: string, signal: AbortSignal) {
    const [value, list] = await Promise.all([
      readMigration(bookId, migrationId, signal),
      readMigrations(bookId, signal),
    ]);
    if (!signal.aborted) {
      setInspection(value);
      setRuns(list.runs);
    }
    return value;
  }
  function resume(migrationId: string) {
    void action(async (signal) => {
      const value = await readMigration(bookId, migrationId, signal);
      if (signal.aborted) return;
      setInspection(value);
      setRecordId('');
      setPage(0);
      setComparison(undefined);
      setOpening(undefined);
      setApprovalConfirmed(false);
    });
  }
  function inspect() {
    if (!canReview) return;
    const source = sources.find(
      (entry) => entry.source.privateSpaceId === sourceId,
    )?.source;
    if (!source) return;
    void action(async (signal) => {
      const raw = await mutate.current(
        bookId,
        'inspect',
        {
          mapping: {
            source,
            target: {
              workspaceId: source.householdId,
              bookId,
              ownerUserId: source.originalOwnerUserId,
            },
            financialAccounts: [],
            categories: [],
            evidence: [],
            openings: [],
          },
        },
        auth.csrfToken,
        signal,
      );
      if (signal.aborted) return;
      const value = checkInspection(raw, bookId);
      setInspection(value);
      setRecordId('');
      setPage(0);
      setComparison(undefined);
      setOpening(undefined);
      setApprovalConfirmed(false);
      const list = await readMigrations(bookId, signal);
      if (!signal.aborted) {
        setRuns(list.runs);
        setNotice(
          'Source snapshot saved. Review the account mappings and evidence below.',
        );
      }
    });
  }
  function perform(
    operation: Exclude<MigrationOperation, 'inspect' | 'review'>,
  ) {
    if (
      !inspection ||
      !canReview ||
      (operation === 'opening' && !canApprove) ||
      (operation === 'approve-cutover' &&
        (!canApprove ||
          !approvalConfirmed ||
          !comparison ||
          comparison.status !== 'passed'))
    )
      return;
    const current = inspection;
    const input =
      operation === 'opening'
        ? {
            expectedRunRevision: current.run.revision,
            expectedRecordRevision: selected?.revision,
            expectedSourceSnapshotHash: current.run.sourceSnapshotHash,
          }
        : {
            migrationId: current.run.id,
            expectedRevision: current.run.revision,
            ...(operation === 'backfill' || operation === 'approve-cutover'
              ? { sourceSnapshotHash: current.run.sourceSnapshotHash }
              : {}),
            ...(operation === 'approve-cutover'
              ? { comparisonId: comparison?.id }
              : {}),
          };
    void action(async (signal) => {
      const result = await mutate.current(
        bookId,
        operation,
        input,
        auth.csrfToken,
        signal,
        current.run.id,
        operation === 'opening' ? selected?.id : undefined,
      );
      if (signal.aborted) return;
      await refresh(current.run.id, signal);
      if (signal.aborted) return;
      if (operation === 'compare') {
        const saved = FinanceLegacyMigrationComparisonSchema.parse(result);
        setComparison(saved);
        setNotice(
          saved.status === 'passed'
            ? 'Saved comparison passed. Review its totals before approving cutover.'
            : 'Comparison found differences. Review the saved findings.',
        );
      } else if (operation === 'opening') {
        setOpening(FinanceOpeningProofSchema.parse(result));
        setComparison(undefined);
        setNotice(
          'Reviewed opening posted. The saved journal proof is shown below.',
        );
      } else if (operation === 'approve-cutover') {
        FinanceLegacyMigrationCutoverSchema.parse(result);
        setNotice(
          'Cutover approval saved. Reader activation remains a separate controlled step.',
        );
      } else {
        setComparison(undefined);
        setNotice(
          'Backfill saved. Compare the source and target records next.',
        );
      }
      setApprovalConfirmed(false);
    });
  }
  function review(
    decision: z.output<typeof FinanceLegacyMigrationReviewDecisionSchema>,
  ) {
    if (!selected || !inspection || !canReview) return;
    void action(async (signal) => {
      const raw = await mutate.current(
        bookId,
        'review',
        {
          migrationId: inspection.run.id,
          recordId: selected.id,
          expectedRevision: selected.revision,
          decision,
        },
        auth.csrfToken,
        signal,
        inspection.run.id,
      );
      if (signal.aborted) return;
      const value = raw as Record<string, unknown>;
      const snapshot = { ...value };
      delete snapshot.review;
      setInspection(checkInspection(snapshot, bookId, inspection.run.id));
      setComparison(undefined);
      setOpening(undefined);
      setApprovalConfirmed(false);
      setNotice('Review saved. Recheck remaining blockers before backfill.');
      const list = await readMigrations(bookId, signal);
      if (!signal.aborted) setRuns(list.runs);
    });
  }
  return (
    <section
      className="open-section finance-commercial"
      aria-label="Legacy Finance migration"
    >
      <h3>Bring legacy Finance into {bookName}</h3>
      <p>
        Review your private source records, map them to this book, and preserve
        their evidence. Posting an opening, backfilling records, comparing
        totals, and approving cutover are separate actions.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">Working…</p>}
      <Button
        disabled={busy}
        onClick={() =>
          void action(async (signal) => {
            await catalog(signal);
            if (inspection) {
              await refresh(inspection.run.id, signal);
              if (!signal.aborted) {
                setComparison(undefined);
                setOpening(undefined);
                setApprovalConfirmed(false);
              }
            }
          })
        }
      >
        Refresh migration data
      </Button>
      {ready && (
        <>
          {!canReview && (
            <p>
              Read-only access. A preparer, approver, or administrator with a
              current sign-in can review this migration.
            </p>
          )}
          <label>
            Private Finance source{' '}
            <select
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
              disabled={busy || !canReview}
            >
              <option value="">Choose your private source</option>
              {sources.map((entry) => (
                <option
                  key={entry.source.privateSpaceId}
                  value={entry.source.privateSpaceId}
                >
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          {!sources.length && (
            <p>No current private Finance source is available.</p>
          )}
          <Button disabled={busy || !canReview || !sourceId} onClick={inspect}>
            Inspect selected source
          </Button>
          <label>
            Saved migration{' '}
            <select
              value={inspection?.run.id ?? ''}
              onChange={(event) =>
                event.target.value && resume(event.target.value)
              }
              disabled={busy}
            >
              <option value="">Resume a saved migration</option>
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.createdAt.slice(0, 10)} · {run.status} ·{' '}
                  {run.sourceCount} records · {run.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {inspection && (
        <>
          <h4>Review queue</h4>
          <p>
            State: {inspection.run.status}. Revision {inspection.run.revision}.{' '}
            {inspection.run.sourceCount} source records;{' '}
            {inspection.run.readyCount} ready; {inspection.run.blockedCount}{' '}
            blocked; {inspection.run.unresolvedCount} unresolved.
          </p>
          <div
            className="finance-table-scroll"
            tabIndex={0}
            aria-label="Migration review records"
          >
            <table>
              <thead>
                <tr>
                  <th>Source record</th>
                  <th>Type</th>
                  <th>Review</th>
                  <th>Blockers</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {inspection.records
                  .slice(page * 25, (page + 1) * 25)
                  .map((record) => (
                    <tr key={record.id}>
                      <td>{recordLabel(record)}</td>
                      <td>{record.entityType.replace('finance.', '')}</td>
                      <td>
                        {record.status} · {record.disposition}
                      </td>
                      <td>
                        {record.blockers.length
                          ? record.blockers.join(', ')
                          : 'None'}
                      </td>
                      <td>
                        <Button
                          disabled={busy}
                          onClick={() => {
                            setRecordId(record.id);
                            setOpening(undefined);
                          }}
                        >
                          Review {recordLabel(record)}
                        </Button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {!inspection.records.length && (
            <p>This source snapshot contains no records.</p>
          )}
          {inspection.records.length > 25 && (
            <nav aria-label="Review queue pages">
              <Button
                disabled={busy || page === 0}
                onClick={() => {
                  setPage(page - 1);
                  setRecordId('');
                }}
              >
                Previous records
              </Button>
              <span>
                Page {page + 1} of {Math.ceil(inspection.records.length / 25)}
              </span>
              <Button
                disabled={busy || (page + 1) * 25 >= inspection.records.length}
                onClick={() => {
                  setPage(page + 1);
                  setRecordId('');
                }}
              >
                Next records
              </Button>
            </nav>
          )}
          {selected && (
            <MigrationRecordReview
              key={`${selected.id}:${selected.revision}`}
              record={selected}
              inspection={inspection}
              financialAccounts={financialAccounts}
              accounts={accounts}
              evidence={evidence}
              disabled={
                busy ||
                !canReview ||
                !['review', 'blocked'].includes(inspection.run.status)
              }
              onSave={review}
            />
          )}
          {nextEvidence !== null && (
            <Button
              disabled={busy}
              onClick={() =>
                void action(async (signal) => {
                  const value = await readMigrationEvidence(
                    bookId,
                    nextEvidence,
                    signal,
                  );
                  if (!signal.aborted) {
                    setEvidence((current) => [
                      ...current,
                      ...value.documents.filter(
                        (document) =>
                          !current.some(
                            (existing) => existing.id === document.id,
                          ),
                      ),
                    ]);
                    setNextEvidence(value.nextOffset);
                  }
                })
              }
            >
              Load more evidence documents
            </Button>
          )}
          {selected?.entityType === 'finance.account' &&
            openingMapping?.disposition === 'explicit-opening' && (
              <>
                <p>
                  Reviewed opening date: {openingMapping.openingEffectiveOn}.
                  Posting uses the saved source amount and reviewed evidence.
                </p>
                <Button
                  disabled={busy || !canApprove}
                  onClick={() => perform('opening')}
                >
                  Post reviewed opening
                </Button>
              </>
            )}
          {opening && (
            <p role="status">
              Posted opening: {displayCadCents(opening.amountCadMinor)},
              effective {opening.effectiveOn}. Journal {opening.journalId}.
              Evidence {opening.evidenceId}.
            </p>
          )}
          <h4>Backfill and verify</h4>
          <Button
            disabled={
              busy ||
              !canReview ||
              inspection.run.blockedCount > 0 ||
              inspection.run.unresolvedCount > 0 ||
              !['review', 'blocked'].includes(inspection.run.status)
            }
            onClick={() => perform('backfill')}
          >
            Backfill reviewed records
          </Button>
          <Button
            disabled={
              busy ||
              !canReview ||
              !['backfilled', 'comparison-passed', 'blocked'].includes(
                inspection.run.status,
              )
            }
            onClick={() => perform('compare')}
          >
            Compare source and target
          </Button>
          <p>
            Preserved-only records remain an archive. Their balances, budgets,
            or categories do not become posted ledger amounts.
          </p>
          {comparison && (
            <div>
              <h4>Saved comparison: {comparison.status}</h4>
              <p>
                Source: {comparison.sourceTransactionCount} transactions,{' '}
                {comparison.sourceCadMinorTotal} CAD cents. Target:{' '}
                {comparison.targetTransactionCount} transactions,{' '}
                {comparison.targetCadDecimalTotal} CAD. Unresolved:{' '}
                {comparison.unresolvedCount}.
              </p>
              {comparison.mismatches.length > 0 && (
                <ul>
                  {comparison.mismatches.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
              <p>Comparison reference: {comparison.id}</p>
            </div>
          )}
          <label>
            <input
              type="checkbox"
              checked={approvalConfirmed}
              disabled={busy || !canApprove || comparison?.status !== 'passed'}
              onChange={(event) => setApprovalConfirmed(event.target.checked)}
            />{' '}
            I reviewed the saved comparison and approve this migration cutover.
          </label>
          <Button
            disabled={
              busy ||
              !canApprove ||
              !approvalConfirmed ||
              comparison?.status !== 'passed' ||
              inspection.run.status !== 'comparison-passed'
            }
            onClick={() => perform('approve-cutover')}
          >
            Approve cutover
          </Button>
          <p>
            Approval saves the migration decision. This panel does not activate
            reader routing.
          </p>
        </>
      )}
    </section>
  );
}
function MigrationRecordReview({
  record,
  inspection,
  financialAccounts,
  accounts,
  evidence,
  disabled,
  onSave,
}: {
  record: FinanceLegacyMigrationRecord;
  inspection: MigrationInspection;
  financialAccounts: readonly {
    id: string;
    name: string;
    active: boolean;
    currency: string;
  }[];
  accounts: FinanceLegacyMigrationsProps['accounts'];
  evidence: readonly { id: string; filename: string }[];
  disabled: boolean;
  onSave: (
    decision: z.output<typeof FinanceLegacyMigrationReviewDecisionSchema>,
  ) => void;
}) {
  const savedOpening = inspection.run.mapping.openings.find(
    (value) => value.legacyAccountId === record.entityId,
  );
  const [financial, setFinancial] = useState(
    record.classification.targetFinancialAccountId ?? '',
  );
  const [ledger, setLedger] = useState(
    record.classification.targetLedgerAccountId ?? '',
  );
  const [document, setDocument] = useState(
    record.classification.targetEvidenceId ?? '',
  );
  const [openingDisposition, setOpeningDisposition] = useState<
    'queue' | 'explicit-opening'
  >(savedOpening?.disposition ?? 'queue');
  const [openingLedger, setOpeningLedger] = useState(
    savedOpening?.targetLedgerAccountId ?? '',
  );
  const [openingEvidence, setOpeningEvidence] = useState(
    savedOpening?.targetEvidenceId ?? '',
  );
  const [openingDate, setOpeningDate] = useState(
    savedOpening?.openingEffectiveOn ?? '',
  );
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const payload = payloadObject(record),
    isAccount = record.entityType === 'finance.account',
    isTransaction = record.entityType === 'finance.transaction';
  const supported =
    ['finance.account', 'finance.transaction', 'finance.category'].includes(
      record.entityType,
    ) && !record.tombstoned;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setError('');
        if (disabled || !supported || !confirmed) return;
        const decision = FinanceLegacyMigrationReviewDecisionSchema.safeParse({
          targetFinancialAccountId: financial || null,
          targetLedgerAccountId: ledger || null,
          targetEvidenceId: document || null,
          openingDisposition,
          openingLedgerAccountId:
            openingDisposition === 'explicit-opening'
              ? openingLedger || null
              : null,
          openingEvidenceId:
            openingDisposition === 'explicit-opening'
              ? openingEvidence || null
              : null,
          openingEffectiveOn:
            openingDisposition === 'explicit-opening'
              ? openingDate || null
              : null,
          classificationConfirmed: confirmed,
          reason,
        });
        if (!decision.success) {
          setError(
            'Choose the reviewed mappings and evidence. Explicit openings also require an effective date and counterpart account.',
          );
          return;
        }
        onSave(decision.data);
      }}
    >
      <h4>Review: {recordLabel(record)}</h4>
      <p>
        Record revision {record.revision}; original source revision{' '}
        {record.sourceRevision}.{' '}
        {record.blockers.length
          ? `Outstanding: ${record.blockers.join(', ')}`
          : 'No outstanding blockers.'}
      </p>
      {isAccount && (
        <p>
          Original opening:{' '}
          {String(payload.openingBalanceCadMinor ?? 'unavailable')} CAD cents.
        </p>
      )}
      {isTransaction && (
        <p>
          Source amount:{' '}
          {String(payload.effectiveAmountCadMinor ?? 'unavailable')} CAD cents.
          Source date: {String(payload.postedOn ?? 'unavailable')}.
        </p>
      )}
      {!supported ? (
        <p>
          This record is preserved as source evidence. This panel cannot convert
          its unsupported classification into posted accounting entries.
        </p>
      ) : (
        <fieldset disabled={disabled}>
          <legend>Reviewed mapping</legend>
          {(isAccount || isTransaction) && (
            <label>
              Target financial account{' '}
              <select
                value={financial}
                onChange={(event) => setFinancial(event.target.value)}
              >
                <option value="">Select an account</option>
                {financialAccounts
                  .filter((account) => account.active)
                  .map((account) => (
                    <option value={account.id} key={account.id}>
                      {account.name} · {account.currency}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {(record.entityType === 'finance.category' ||
            (isTransaction && !!payload.categoryId)) && (
            <label>
              Category ledger account{' '}
              <select
                value={ledger}
                onChange={(event) => setLedger(event.target.value)}
              >
                <option value="">Select a ledger account</option>
                {accounts.map((account) => (
                  <option value={account.id} key={account.id}>
                    {account.code} · {account.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Source evidence document{' '}
            <select
              value={document}
              onChange={(event) => setDocument(event.target.value)}
            >
              <option value="">Select uploaded evidence</option>
              {evidence.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.filename}
                </option>
              ))}
            </select>
          </label>
          {!evidence.length && (
            <p>
              Upload source evidence in Documents before completing this review.
            </p>
          )}
          {isAccount && (
            <>
              <label>
                Opening balance handling{' '}
                <select
                  value={openingDisposition}
                  onChange={(event) =>
                    setOpeningDisposition(
                      event.target.value as 'queue' | 'explicit-opening',
                    )
                  }
                >
                  <option value="queue">Keep queued for review</option>
                  <option value="explicit-opening">
                    Explicit reviewed opening
                  </option>
                </select>
              </label>
              {openingDisposition === 'explicit-opening' && (
                <>
                  <label>
                    Opening counterpart ledger account{' '}
                    <select
                      value={openingLedger}
                      onChange={(event) => setOpeningLedger(event.target.value)}
                    >
                      <option value="">Select counterpart account</option>
                      {accounts.map((account) => (
                        <option value={account.id} key={account.id}>
                          {account.code} · {account.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Opening evidence document{' '}
                    <select
                      value={openingEvidence}
                      onChange={(event) =>
                        setOpeningEvidence(event.target.value)
                      }
                    >
                      <option value="">Select opening evidence</option>
                      {evidence.map((item) => (
                        <option value={item.id} key={item.id}>
                          {item.filename}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Reviewed opening effective date{' '}
                    <input
                      type="date"
                      value={openingDate}
                      onChange={(event) => setOpeningDate(event.target.value)}
                      required
                    />
                  </label>
                </>
              )}
            </>
          )}
          <label>
            Review reason{' '}
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={3}
              maxLength={1000}
              required
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{' '}
            I checked the source classification and selected mappings.
          </label>
          {error && <p role="alert">{error}</p>}
          <Button type="submit" disabled={!confirmed}>
            Save record review
          </Button>
        </fieldset>
      )}
    </form>
  );
}
