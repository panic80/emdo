import { useEffect, useRef, useState } from 'react';
import type { FinanceCashDividendSourceSnapshot } from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { saveMemoryFile } from '../../downloads/save-memory-file.js';
import { useAuth } from '../auth/auth-context.js';
import {
  DividendApiError,
  dividendApi,
  dividendError,
  type DividendCatalog,
  type DividendImport,
  type SavedDividend,
} from './finance-cash-dividend-api.js';
import { DividendReview } from './finance-cash-dividend-review.js';
import { DividendSavedDetail } from './finance-cash-dividend-detail.js';
import './finance-cash-dividends.css';

export function FinanceCashDividends({
  bookId,
  role,
}: {
  bookId: string;
  role: string;
}) {
  const auth = useAuth();
  return (
    <DividendWorkspace
      key={`${bookId}:${auth.sessionBinding}:${auth.state}:${role}`}
      bookId={bookId}
      role={role}
      authenticated={!auth.state || auth.state === 'authenticated'}
      {...(auth.csrfToken ? { csrfToken: auth.csrfToken } : {})}
    />
  );
}
function DividendWorkspace({
  bookId,
  role,
  authenticated,
  csrfToken,
}: {
  bookId: string;
  role: string;
  authenticated: boolean;
  csrfToken?: string;
}) {
  const [opened, setOpened] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [actions, setActions] = useState<SavedDividend[]>([]),
    [detail, setDetail] = useState<SavedDividend>();
  const [offset, setOffset] = useState(0),
    [nextOffset, setNextOffset] = useState<number | null>(null);
  const [catalog, setCatalog] = useState<DividendCatalog>(),
    [preparing, setPreparing] = useState(false),
    [statement, setStatement] = useState<DividendImport>();
  const [batchId, setBatchId] = useState(''),
    [rowId, setRowId] = useState(''),
    [instrumentId, setInstrumentId] = useState('');
  const [source, setSource] = useState<FinanceCashDividendSourceSnapshot>();
  const [reviewGeneration, setReviewGeneration] = useState(0);
  const alive = useRef(true),
    working = useRef(false),
    controller = useRef<AbortController | undefined>(undefined),
    detailHeading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (detail || source) detailHeading.current?.focus();
  }, [detail, source]);
  function clearPrivate() {
    setActions([]);
    setDetail(undefined);
    setSource(undefined);
    setStatement(undefined);
    setCatalog(undefined);
    setPreparing(false);
    setOpened(false);
  }
  function denied() {
    clearPrivate();
    setError(
      'Current book access no longer permits this dividend review. Loaded private details have been cleared.',
    );
  }
  async function act(work: (signal: AbortSignal) => Promise<void>) {
    if (!authenticated || working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    controller.current?.abort();
    const control = new AbortController();
    controller.current = control;
    try {
      await work(control.signal);
    } catch (cause) {
      if (alive.current && !control.signal.aborted) {
        setError(dividendError(cause));
        if (
          cause instanceof DividendApiError &&
          [401, 403].includes(cause.status)
        )
          clearPrivate();
      }
    } finally {
      working.current = false;
      if (alive.current && !control.signal.aborted) setBusy(false);
    }
  }
  const live = (signal: AbortSignal) => alive.current && !signal.aborted;
  function load(page = offset) {
    void act(async (signal) => {
      const result = await dividendApi.list(bookId, page, signal);
      if (live(signal)) {
        setActions(result.actions);
        setOffset(page);
        setNextOffset(result.nextOffset);
        setOpened(true);
      }
    });
  }
  function select(id: string) {
    void act(async (signal) => {
      const [record, page] = await Promise.all([
        dividendApi.detail(bookId, id, signal),
        dividendApi.list(bookId, offset, signal),
      ]);
      if (live(signal)) {
        setActions(page.actions);
        setNextOffset(page.nextOffset);
        setDetail(record);
        setSource(undefined);
        setPreparing(false);
      }
    });
  }
  function startReview() {
    if (!opened || !['administrator', 'approver', 'preparer'].includes(role))
      return;
    void act(async (signal) => {
      const value = await dividendApi.catalog(bookId, signal);
      if (live(signal)) {
        setCatalog(value);
        if (value.role === 'viewer') {
          setError(
            'Current book access permits reading saved dividends. An administrator, preparer or approver must prepare a new review.',
          );
          return;
        }
        setPreparing(true);
        setDetail(undefined);
        setSource(undefined);
        setStatement(undefined);
        setBatchId('');
        setRowId('');
        setInstrumentId('');
      }
    });
  }
  function selectStatement(id: string) {
    const summary = catalog?.imports.find((item) => item.id === id);
    setSource(undefined);
    setStatement(undefined);
    setBatchId(id);
    setRowId('');
    if (!summary) return;
    void act(async (signal) => {
      const value = await dividendApi.import(bookId, summary, signal);
      if (live(signal)) setStatement(value);
    });
  }
  function loadSource(refreshCatalog = false) {
    if (!statement || !rowId || !instrumentId) return;
    void act(async (signal) => {
      if (refreshCatalog) {
        const currentCatalog = await dividendApi.catalog(bookId, signal);
        if (!live(signal)) return;
        setCatalog(currentCatalog);
        if (currentCatalog.role === 'viewer') {
          denied();
          return;
        }
      }
      const value = await dividendApi.source(
        bookId,
        {
          sourceRowId: rowId,
          evidenceId: statement.batch.evidence_id,
          financialAccountId: statement.batch.financial_account_id,
          instrumentId,
        },
        signal,
      );
      if (value.batchId !== statement.batch.id)
        throw new Error(
          'The source snapshot does not match the selected statement.',
        );
      if (live(signal)) {
        setSource(value);
        setReviewGeneration((value) => value + 1);
      }
    });
  }
  function downloadOriginal(evidenceId: string) {
    void act((signal) =>
      dividendApi.downloadOriginal(bookId, evidenceId, signal),
    );
  }
  const accountName = (id: string) =>
    catalog?.accounts.find((item) => item.id === id)?.name ?? id;
  const sourceReady = source?.status === 'ready' && source.issues.length === 0;
  return (
    <section className="finance-dividends" aria-label="Cash dividends">
      <div className="finance-dividend-heading">
        <div>
          <span className="finance-dividend-eyebrow">Investment income</span>
          <h4>Cash dividends</h4>
          <p>
            Review gross income, withholding and the cash receipt against one
            original statement row.
          </p>
        </div>
        {!preparing && (
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !authenticated}
            onClick={() => load()}
          >
            {opened ? 'Refresh cash dividends' : 'Open cash dividends'}
          </Button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {opened && !preparing && (
        <>
          <div className="finance-dividend-list-heading">
            <div>
              <h5>Saved dividends</h5>
              <p>
                Posted actions retain their reviewed source, exact amounts and
                journal evidence.
              </p>
            </div>
            {['administrator', 'approver', 'preparer'].includes(role) && (
              <Button
                type="button"
                disabled={busy || !authenticated}
                onClick={startReview}
              >
                Review a cash dividend
              </Button>
            )}
          </div>
          {!actions.length ? (
            <p className="finance-dividend-empty">
              No saved dividends on this page. A dividend is added only after
              source review and an explicit posting decision.
            </p>
          ) : (
            <ul className="finance-dividend-list">
              {actions.map((action) => (
                <li key={action.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => select(action.id)}
                    aria-label={`Open saved dividend: ${action.sourceReference}`}
                  >
                    <span>
                      <strong>{action.sourceReference}</strong>
                      <small>
                        {action.payableOn} · source row{' '}
                        {action.source.sourceRow}
                      </small>
                    </span>
                    <span>
                      <strong>
                        {action.net.functionalAmount}{' '}
                        {action.source.functionalCurrency}
                      </strong>
                      <small>Net cash · posted</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="finance-dividend-pagination">
            <Button
              type="button"
              variant="quiet"
              disabled={busy || offset === 0}
              onClick={() => load(Math.max(0, offset - 20))}
            >
              Previous dividends
            </Button>
            <span>Page {Math.floor(offset / 20) + 1}</span>
            <Button
              type="button"
              variant="quiet"
              disabled={busy || nextOffset === null}
              onClick={() => load(nextOffset!)}
            >
              Next dividends
            </Button>
          </div>
        </>
      )}
      {preparing && catalog && (
        <>
          {!source && (
            <section
              className="finance-dividend-source-picker"
              aria-label="Select dividend source"
            >
              <div className="finance-dividend-list-heading">
                <div>
                  <h5>Start with a statement receipt</h5>
                  <p>
                    The statement selects its saved account and original. Choose
                    the row and investment explicitly.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={busy}
                  onClick={() => setPreparing(false)}
                >
                  Back to saved dividends
                </Button>
              </div>
              {!catalog.imports.length ? (
                <p className="finance-dividend-empty">
                  No statement imports are available. Save and review an
                  original in Documents first.
                </p>
              ) : (
                <div className="finance-dividend-fields">
                  <label>
                    Saved statement
                    <select
                      disabled={busy}
                      value={batchId}
                      onChange={(event) => selectStatement(event.target.value)}
                    >
                      <option value="">Choose statement</option>
                      {catalog.imports.map((item) => (
                        <option value={item.id} key={item.id}>
                          {item.filename} ·{' '}
                          {accountName(item.financialAccountId)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Investment
                    <select
                      disabled={busy}
                      value={instrumentId}
                      onChange={(event) => setInstrumentId(event.target.value)}
                    >
                      <option value="">Choose investment</option>
                      {catalog.instruments.map((item) => (
                        <option value={item.id} key={item.id}>
                          {[item.name, item.symbol ?? item.ticker]
                            .filter(Boolean)
                            .join(' · ') || item.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  {statement && (
                    <label className="finance-dividend-span">
                      Statement receipt row
                      <select
                        disabled={busy}
                        value={rowId}
                        onChange={(event) => setRowId(event.target.value)}
                      >
                        <option value="">Choose source row</option>
                        {statement.rows.map((row) => (
                          <option value={row.id} key={row.id}>
                            Row {row.source_row} · {row.date ?? 'Date missing'}{' '}
                            · {row.description} ·{' '}
                            {row.amount ?? 'Amount missing'} · {row.status}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              )}
              {statement && (
                <p>
                  Original:{' '}
                  {
                    catalog.imports.find((item) => item.id === batchId)
                      ?.filename
                  }{' '}
                  · Account: {accountName(statement.batch.financial_account_id)}
                </p>
              )}
              <div className="finance-dividend-actions">
                <Button
                  type="button"
                  disabled={busy || !statement || !rowId || !instrumentId}
                  onClick={() => loadSource()}
                >
                  Load current dividend source
                </Button>
                {statement && (
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={busy}
                    onClick={() =>
                      downloadOriginal(statement.batch.evidence_id)
                    }
                  >
                    Download selected original
                  </Button>
                )}
              </div>
            </section>
          )}
          {source && (
            <div
              ref={detailHeading}
              tabIndex={-1}
              className="finance-dividend-source-focus"
            >
              <div className="finance-dividend-source-strip">
                <div>
                  <span>Statement receipt</span>
                  <strong>
                    {source.nativeAmount ?? 'Not established'} {source.currency}
                  </strong>
                  <small>
                    {source.effectiveOn ?? 'Date missing'} ·{' '}
                    {accountName(source.financialAccountId)}
                  </small>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => downloadOriginal(source.evidenceId)}
                >
                  Download source original
                </Button>
              </div>
              {!sourceReady ? (
                <div className="finance-dividend-notice">
                  <strong>This statement receipt needs review</strong>
                  <p>
                    Status: {source.status}. Review the row in Documents before
                    preparing its dividend.
                  </p>
                  {source.issues.length > 0 && (
                    <ul>
                      {source.issues.map((issue, index) => (
                        <li key={`${index}:${issue}`}>{issue}</li>
                      ))}
                    </ul>
                  )}
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={busy}
                    onClick={() => setSource(undefined)}
                  >
                    Choose another source
                  </Button>
                </div>
              ) : (
                <DividendReview
                  key={`${source.sourceRowId}:${source.instrumentId}:${source.sourceRevision}:${source.sourceSnapshotHash}:${reviewGeneration}`}
                  bookId={bookId}
                  role={catalog.role}
                  source={source}
                  catalog={catalog}
                  {...(csrfToken ? { csrfToken } : {})}
                  onClose={() => setSource(undefined)}
                  onRefreshSource={() => loadSource(true)}
                  onViewSaved={select}
                  onDenied={denied}
                />
              )}
            </div>
          )}
        </>
      )}
      {detail && (
        <div ref={detailHeading} tabIndex={-1}>
          <DividendSavedDetail
            record={detail}
            {...(catalog ? { catalog } : {})}
            busy={busy}
            onOriginal={() => downloadOriginal(detail.evidenceId)}
            onDownload={() => {
              void act(async (signal) => {
                const current = await dividendApi.detail(
                  bookId,
                  detail.id,
                  signal,
                );
                if (live(signal))
                  saveMemoryFile(
                    `dividend-${current.id}.json`,
                    JSON.stringify(current, null, 2),
                    'application/json',
                  );
              });
            }}
          />
        </div>
      )}
    </section>
  );
}
