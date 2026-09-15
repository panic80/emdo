import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  CommitInvestmentStockSplitSettlementSchema,
  FinanceStockSplitSettlementCommitResultSchema,
  UuidSchema,
  SavedFinanceStockSplitSettlementSchema,
  type PlanInvestmentStockSplitSettlement,
  type FinanceCashDividendSourceSnapshot,
} from '@emdo/contracts/browser';
import { parseFinanceDecimal } from '@emdo/domains/finance/decimal';
import { useAuth } from '../auth/auth-context.js';
import { Button } from '../../components/button.js';
import {
  dividendApi,
  type DividendCatalog,
  type DividendImport,
} from './finance-cash-dividend-api.js';
import {
  financeCorporateActionApi,
  type InvestmentEvidence,
} from './finance-corporate-action-api.js';

type Command = z.infer<typeof CommitInvestmentStockSplitSettlementSchema>;
type Result = z.infer<typeof FinanceStockSplitSettlementCommitResultSchema>;
export type SettlementPostingProps = {
  bookId: string;
  settlement: PlanInvestmentStockSplitSettlement;
  sourceRevision: number;
  sourceSnapshotHash: string;
  onLockChange?: (locked: boolean) => void;
};
export function FinanceSettlementPosting({
  bookId,
  settlement,
  sourceRevision,
  sourceSnapshotHash,
  onLockChange,
}: SettlementPostingProps) {
  const auth = useAuth();
  const [catalog, setCatalog] = useState<DividendCatalog>();
  const [documents, setDocuments] = useState<InvestmentEvidence[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [statement, setStatement] = useState<DividendImport>();
  const [receipt, setReceipt] = useState<FinanceCashDividendSourceSnapshot>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [pending, setPending] = useState<Command>();
  const [result, setResult] = useState<Result>();
  const [confirmed, setConfirmed] = useState(false);
  const [readback, setReadback] =
    useState<
      z.infer<typeof SavedFinanceStockSplitSettlementSchema>['accounting']
    >();
  useEffect(() => {
    onLockChange?.(busy || !!pending || !!result);
  }, [busy, pending, result, onLockChange]);
  useEffect(() => () => onLockChange?.(false), [onLockChange]);
  const active = useRef<AbortController | undefined>(undefined);
  const working = useRef(false);
  const { action } = settlement.source;
  const cash = settlement.cashConsideration;
  const separateDates = cash.settledOn !== action.effectiveOn;
  useEffect(() => () => active.current?.abort(), []);
  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (working.current) return;
    const control = new AbortController();
    active.current?.abort();
    active.current = control;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await work(control.signal);
    } catch (cause) {
      if (!control.signal.aborted)
        setError(
          cause instanceof z.ZodError
            ? 'Posting details could not be verified. Refresh this book.'
            : cause instanceof Error
              ? cause.message
              : 'Settlement request failed.',
        );
    } finally {
      working.current = false;
      if (!control.signal.aborted) setBusy(false);
    }
  }
  const live = (signal: AbortSignal) => !signal.aborted;
  function load() {
    void run(async (signal) => {
      const [nextCatalog, evidence, response] = await Promise.all([
        dividendApi.catalog(bookId, signal),
        financeCorporateActionApi.readEvidence(bookId, signal),
        fetch('/api/v2/workspace', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal,
        }),
      ]);
      if (!live(signal)) return;
      if (!response.ok)
        throw new Error(
          'Current workspace could not be verified. Refresh this book.',
        );
      const workspace = z
        .object({ workspace: z.object({ id: UuidSchema }) })
        .parse(await response.json());
      if (!live(signal)) return;
      if (!['administrator', 'approver'].includes(nextCatalog.role)) {
        setBlocked(true);
        throw new Error(
          'Current book access does not permit settlement posting.',
        );
      }
      setWorkspaceId(workspace.workspace.id);
      setCatalog(nextCatalog);
      setDocuments(evidence);
    });
  }
  function chooseStatement(id: string) {
    setReceipt(undefined);
    setStatement(undefined);
    setConfirmed(false);
    const summary = catalog?.imports.find((item) => item.id === id);
    if (!summary) return;
    void run(async (signal) => {
      const next = await dividendApi.import(bookId, summary, signal);
      if (live(signal)) setStatement(next);
    });
  }
  function chooseReceipt(id: string) {
    setReceipt(undefined);
    setConfirmed(false);
    if (!id || !statement) return;
    void run(async (signal) => {
      const next = await dividendApi.source(
        bookId,
        {
          sourceRowId: id,
          evidenceId: statement.batch.evidence_id,
          financialAccountId: action.financialAccountId,
          instrumentId: action.instrumentId,
        },
        signal,
      );
      if (!live(signal)) return;
      if (
        next.batchId !== statement.batch.id ||
        next.status !== 'ready' ||
        next.issues.length ||
        next.evidenceId !== cash.evidenceId ||
        next.effectiveOn !== cash.settledOn ||
        next.currency !== cash.native.currency ||
        next.functionalCurrency !== cash.functional.currency ||
        next.nativeAmount === null ||
        parseFinanceDecimal(next.nativeAmount) !==
          parseFinanceDecimal(cash.native.amount)
      )
        throw new Error(
          'Choose a ready statement receipt matching the cash evidence, date, currency and amount in this preview.',
        );
      setReceipt(next);
    });
  }
  async function commit(command: Command, signal: AbortSignal) {
    if (!auth.csrfToken)
      throw new Error('Sign in again before posting this settlement.');
    const response = await fetch(
      `/api/v2/finance/books/${bookId}/investments/corporate-actions/stock-splits/settlement-commit`,
      {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': auth.csrfToken,
          'idempotency-key': command.idempotencyKey,
        },
        body: JSON.stringify(command),
      },
    );
    if (!live(signal)) return;
    if (!response.ok) {
      if ([401, 403, 409].includes(response.status)) setBlocked(true);
      if (response.status === 400) setPending(undefined);
      throw new Error(
        response.status === 503
          ? 'Settlement posting is not ready or its result is unavailable. No posting is confirmed. Retry the same request when the service is ready.'
          : response.status === 409
            ? 'Source, statement receipt or evidence changed. Refresh the stock split source before posting.'
            : [401, 403].includes(response.status)
              ? 'Book access changed. Refresh this book before continuing.'
              : response.status === 400
                ? 'Posting details were rejected. Review the selected accounts, evidence and action-date values.'
                : 'Posting is not confirmed. Retry the same request to recover its result.',
      );
    }
    const saved = FinanceStockSplitSettlementCommitResultSchema.parse(
      await response.json(),
    );
    if (!live(signal)) return;
    if (
      saved.workspaceId !== workspaceId ||
      saved.bookId !== bookId ||
      saved.actionId !== action.id ||
      saved.sourceRevision !== sourceRevision ||
      saved.nextSourceRevision !== sourceRevision + 1 ||
      saved.sourceSnapshotHash !== sourceSnapshotHash ||
      new Set(saved.journalIds).size !== saved.journalIds.length ||
      new Set(saved.successorLotIds).size !== saved.successorLotIds.length ||
      saved.journalIds.length !== (separateDates ? 2 : 1)
    )
      throw new Error(
        'The posting response does not match this reviewed settlement. No posting is confirmed; retry the same request.',
      );
    setResult(saved);
    setPending(undefined);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!receipt || !confirmed || !catalog || blocked || busy) return;
    const data = new FormData(event.currentTarget);
    const value = (key: string) => String(data.get(key) ?? '').trim();
    void run(async (signal) => {
      if (pending) {
        await commit(pending, signal);
        return;
      }
      const actionDateConsideration = separateDates
        ? {
            native: {
              amount: value('actionNative'),
              currency: cash.native.currency,
            },
            functional: {
              amount: value('actionFunctional'),
              currency: cash.functional.currency,
            },
            evidenceId: value('actionEvidence'),
            sourceReference: value('actionReference'),
            fx:
              cash.native.currency === cash.functional.currency
                ? null
                : { rate: value('actionFx'), source: value('actionFxSource') },
          }
        : null;
      const evidenceIds = new Set([
        action.evidenceId,
        settlement.allocationReview.evidenceId,
        cash.evidenceId,
        ...(actionDateConsideration
          ? [actionDateConsideration.evidenceId]
          : []),
      ]);
      const evidenceHashes = [...evidenceIds].map((evidenceId) => {
        const document = documents.find((item) => item.id === evidenceId);
        if (!document?.sourceDigest)
          throw new Error(
            'A reviewed document has no verified source digest. Refresh evidence before posting.',
          );
        return { evidenceId, sha256: document.sourceDigest };
      });
      const ledger = Object.fromEntries(
        [
          'cashLedgerAccountId',
          'investmentLedgerAccountId',
          'gainLedgerAccountId',
          'lossLedgerAccountId',
          'receivableLedgerAccountId',
          'fxGainLedgerAccountId',
          'fxLossLedgerAccountId',
        ].map((key) => [key, value(key) || null]),
      );
      if (ledger.cashLedgerAccountId !== receipt.financialAccountLedgerId)
        throw new Error(
          'The cash account must match the selected statement account.',
        );
      for (const id of Object.values(ledger))
        if (
          id &&
          !catalog.ledger.some((account) => account.id === id && account.active)
        )
          throw new Error('Choose active ledger accounts from this book.');
      const command = CommitInvestmentStockSplitSettlementSchema.parse({
        settlement,
        ledger,
        actionDateConsideration,
        expectedSourceRevision: sourceRevision,
        sourceSnapshotHash,
        receipt: {
          sourceRowId: receipt.sourceRowId,
          expectedRevision: receipt.sourceRevision,
          snapshotHash: receipt.sourceSnapshotHash,
        },
        evidenceHashes,
        idempotencyKey: crypto.randomUUID(),
      });
      setPending(command);
      await commit(command, signal);
    });
  }
  const ledgerField = (label: string, name: string, kind: string) => (
    <label>
      {label}
      <select name={name} defaultValue="" required>
        <option value="" disabled>
          Select account
        </option>
        {catalog?.ledger
          .filter((account) => account.active && account.kind === kind)
          .map((account) => (
            <option key={account.id} value={account.id}>
              {account.code} · {account.name}
            </option>
          ))}
      </select>
    </label>
  );
  const field = (label: string, name: string, decimal = false) => (
    <label>
      {label}
      <input
        name={name}
        required
        autoComplete="off"
        inputMode={decimal ? 'decimal' : undefined}
      />
    </label>
  );
  function refreshSaved() {
    if (!result) return;
    void run(async (signal) => {
      const response = await fetch(
        `/api/v2/finance/books/${bookId}/investments/corporate-actions/settlements/${result.settlementId}`,
        { credentials: 'same-origin', cache: 'no-store', signal },
      );
      if (!response.ok)
        throw new Error(
          'The saved settlement could not be refreshed. The earlier posting confirmation is retained.',
        );
      const saved = SavedFinanceStockSplitSettlementSchema.parse(
        await response.json(),
      );
      if (!live(signal)) return;
      const identity = saved.result;
      if (
        identity.workspaceId !== workspaceId ||
        identity.bookId !== bookId ||
        identity.actionId !== action.id ||
        identity.settlementId !== result.settlementId ||
        identity.economicTransactionId !== result.economicTransactionId ||
        identity.sourceSnapshotHash !== sourceSnapshotHash ||
        identity.sourceRevision !== sourceRevision ||
        identity.nextSourceRevision !== sourceRevision + 1 ||
        JSON.stringify(identity.journalIds) !==
          JSON.stringify(result.journalIds) ||
        saved.settlement.actionId !== action.id ||
        saved.settlement.financialAccountId !== action.financialAccountId ||
        saved.settlement.instrumentId !== action.instrumentId ||
        saved.settlement.effectiveOn !== action.effectiveOn ||
        saved.settlement.settledOn !== cash.settledOn
      )
        throw new Error(
          'The saved settlement did not match the confirmed posting.',
        );
      setReadback(saved.accounting);
    });
  }
  if (blocked)
    return (
      <section aria-label="Settlement posting blocked">
        <p role="alert">
          {error || 'Refresh the stock split source before continuing.'}
        </p>
      </section>
    );
  if (result)
    return (
      <section role="status" aria-label="Committed settlement">
        {error && <p role="alert">{error}</p>}
        <h5>
          {result.replayed
            ? 'Settlement posting recovered'
            : 'Settlement committed'}
        </h5>
        <p>
          Saved settlement {result.settlementId}. Source revision{' '}
          {result.sourceRevision} → {result.nextSourceRevision}.
        </p>
        <p>
          {result.successorLotIds.length} successor lots; {result.effectCount}{' '}
          lot effects.
        </p>
        <p>Posted journal IDs:</p>
        <Button disabled={busy} onClick={refreshSaved}>
          Refresh saved settlement
        </Button>
        {readback && (
          <div>
            <p>Saved settlement readback verified.</p>
            <p>
              Posted action-date functional consideration:{' '}
              {readback.actionDateFunctionalConsideration}{' '}
              {cash.functional.currency}.
            </p>
            <p>
              Posted settlement-date functional consideration:{' '}
              {readback.settlementDateFunctionalConsideration}{' '}
              {cash.functional.currency}.
            </p>
            <p>
              Posted book gain/loss: {readback.bookGainLoss}{' '}
              {cash.functional.currency}.
            </p>
            <p>
              Posted settlement FX gain/loss: {readback.fxGainLoss}{' '}
              {cash.functional.currency}.
            </p>
          </div>
        )}
        <ul>
          {result.journalIds.map((id) => (
            <li key={id}>
              <code>{id}</code>
            </li>
          ))}
        </ul>
        <p>
          Economic transaction <code>{result.economicTransactionId}</code>. Tax
          treatment is not assessed.
        </p>
      </section>
    );
  return (
    <section aria-label="Post reviewed settlement">
      <h5>Post reviewed settlement</h5>
      <p>
        Select the normalized cash receipt and ledger accounts. Posting closes
        source lots, creates retained lots and balanced journals, and claims the
        receipt once.
      </p>
      {error && <p role="alert">{error}</p>}
      {!catalog ? (
        <Button disabled={busy || blocked} onClick={load}>
          {busy ? 'Loading posting sources…' : 'Prepare settlement posting'}
        </Button>
      ) : (
        <form
          className="finance-corporate-action__form"
          onSubmit={submit}
          noValidate
        >
          <fieldset disabled={busy || blocked || !!pending}>
            <legend>Reviewed statement receipt</legend>
            <label>
              Settlement statement
              <select
                defaultValue=""
                onChange={(event) => chooseStatement(event.target.value)}
              >
                <option value="">Select statement</option>
                {catalog.imports
                  .filter(
                    (item) =>
                      item.financialAccountId === action.financialAccountId &&
                      item.evidenceId === cash.evidenceId,
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.filename} · {item.status}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Settlement receipt row
              <select
                key={statement?.batch.id ?? 'none'}
                defaultValue=""
                disabled={!statement}
                onChange={(event) => chooseReceipt(event.target.value)}
              >
                <option value="">Select receipt</option>
                {statement?.rows
                  .filter((row) => row.status === 'ready')
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      Row {row.source_row} · {row.date} · {row.amount} ·{' '}
                      {row.description}
                    </option>
                  ))}
              </select>
            </label>
            {receipt && (
              <p>
                Verified receipt: {receipt.effectiveOn} · {receipt.nativeAmount}{' '}
                {receipt.currency} · revision {receipt.sourceRevision}.
              </p>
            )}
          </fieldset>
          <fieldset
            disabled={busy || blocked || !!pending}
            onChange={() => setConfirmed(false)}
          >
            <legend>Posting accounts</legend>
            <div className="finance-corporate-action__fields">
              {ledgerField(
                'Settlement cash account',
                'cashLedgerAccountId',
                'asset',
              )}
              {ledgerField(
                'Investment carrying account',
                'investmentLedgerAccountId',
                'asset',
              )}
              {ledgerField(
                'Investment gain account',
                'gainLedgerAccountId',
                'income',
              )}
              {ledgerField(
                'Investment loss account',
                'lossLedgerAccountId',
                'expense',
              )}
              {separateDates && (
                <>
                  {ledgerField(
                    'Settlement receivable account',
                    'receivableLedgerAccountId',
                    'asset',
                  )}
                  {ledgerField(
                    'Settlement FX gain account',
                    'fxGainLedgerAccountId',
                    'income',
                  )}
                  {ledgerField(
                    'Settlement FX loss account',
                    'fxLossLedgerAccountId',
                    'expense',
                  )}
                </>
              )}
            </div>
          </fieldset>
          {separateDates && (
            <fieldset
              disabled={busy || blocked || !!pending}
              onChange={() => setConfirmed(false)}
            >
              <legend>Action-date recognition · {action.effectiveOn}</legend>
              <p>
                The settlement date differs. Enter recognition amounts and
                evidence for the action date; cash receipt will be posted
                separately on {cash.settledOn}.
              </p>
              <div className="finance-corporate-action__fields">
                {field(
                  `Action-date native amount (${cash.native.currency})`,
                  'actionNative',
                  true,
                )}
                {field(
                  `Action-date functional amount (${cash.functional.currency})`,
                  'actionFunctional',
                  true,
                )}
                <label>
                  Action-date evidence
                  <select name="actionEvidence" defaultValue="" required>
                    <option value="" disabled>
                      Select evidence
                    </option>
                    {documents.map((document) => (
                      <option key={document.id} value={document.id}>
                        {document.filename}
                      </option>
                    ))}
                  </select>
                </label>
                {field('Action-date reference', 'actionReference')}
                {cash.native.currency !== cash.functional.currency && (
                  <>
                    {field('Action-date FX rate', 'actionFx', true)}
                    {field('Action-date FX source', 'actionFxSource')}
                  </>
                )}
              </div>
            </fieldset>
          )}
          <label
            className="finance-corporate-action__confirm"
            style={{ display: 'flex' }}
          >
            <input
              style={{ width: 17, height: 17, minHeight: 17, padding: 0 }}
              type="checkbox"
              checked={confirmed}
              disabled={busy || blocked || !!pending}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I reviewed the cash receipt, lot allocations, dates, evidence and
            posting accounts.
          </label>
          <Button
            type="submit"
            disabled={
              busy || blocked || !receipt || !confirmed || !auth.csrfToken
            }
          >
            {busy
              ? 'Posting settlement…'
              : pending
                ? 'Retry same settlement request'
                : 'Post reviewed settlement'}
          </Button>
        </form>
      )}
    </section>
  );
}
