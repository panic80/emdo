import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  FinanceBookRoleSchema,
  FinanceGeneratedReportSchema,
  FinanceGeneratedReportSummarySchema,
  type FinanceGeneratedReport,
  type FinanceGeneratedReportSummary,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { Icon } from '../../components/icon.js';
import { saveMemoryFile } from '../../downloads/save-memory-file.js';
import { useAuth } from '../auth/auth-context.js';
import { generatedReportHtml } from './finance-generated-report-download.js';
import './finance-generated-reports.css';

const PAGE_SIZE = 20;
const reportTitle = (kind: FinanceGeneratedReport['kind']) =>
  kind === 'income-statement'
    ? 'Income statement'
    : kind === 'balance-sheet'
      ? 'Balance sheet'
      : 'Posted ledger snapshot';
const reportScope = (
  report: Pick<
    FinanceGeneratedReportSummary,
    'kind' | 'periodStart' | 'periodEnd' | 'asOf'
  >,
) =>
  report.kind === 'income-statement'
    ? `Period ${report.periodStart} to ${report.periodEnd}`
    : report.kind === 'balance-sheet'
      ? `As of ${report.asOf}`
      : 'All posted journals';
const reportCoverage = (report: FinanceGeneratedReport) =>
  report.kind === 'income-statement'
    ? `Posted journals dated ${report.periodStart} through ${report.periodEnd}, inclusive. Debit and credit are period flows grouped by configured account classification.`
    : report.kind === 'balance-sheet'
      ? `Posted journals through ${report.asOf}. Rows are ending balances grouped by configured account classification; current-year earnings are reconciled below.`
      : 'All posted journals at the saved snapshot. No period filter is applied. Debit and credit are gross cumulative movements; net movement is debit minus credit. These figures are not ending balances or a tax return.';
const reportTotalLabel = (
  kind: FinanceGeneratedReport['kind'],
  side: 'debit' | 'credit',
) =>
  kind === 'balance-sheet'
    ? `Ending ${side} balance`
    : kind === 'income-statement'
      ? `Period ${side} flow`
      : `Gross ${side} movements`;
const ReportPage = z.strictObject({
  reports: z.array(FinanceGeneratedReportSummarySchema).max(100),
  nextOffset: z.number().int().min(0).max(1000000).nullable(),
});
class ReportReadError extends Error {
  constructor(readonly status: number) {
    super(
      status === 403 || status === 401
        ? 'Current book access does not permit reading these saved reports.'
        : status === 503
          ? 'Saved accounting reports are not available in this environment yet.'
          : status === 404
            ? 'This saved report is no longer available in this book. Refresh the report list.'
            : 'Unable to load the saved report. Try again.',
    );
  }
}

/** Access changes replace all in-memory report state, including pending downloads. */
export function FinanceGeneratedReports(props: {
  bookId: string;
  bookName: string;
  role: string;
}) {
  const auth = useAuth();
  return (
    <SavedReportLibrary
      key={`${auth.sessionBinding}:${props.bookId}:${props.role}`}
      {...props}
    />
  );
}

function SavedReportLibrary({
  bookId,
  bookName,
  role,
}: {
  bookId: string;
  bookName: string;
  role: string;
}) {
  const [page, setPage] = useState<z.infer<typeof ReportPage>>();
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<FinanceGeneratedReportSummary>();
  const [report, setReport] = useState<FinanceGeneratedReport>();
  const [busy, setBusy] = useState<'list' | 'detail' | 'download'>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [rowOffset, setRowOffset] = useState(0);
  const [sourceOffset, setSourceOffset] = useState(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const canRead = FinanceBookRoleSchema.safeParse(role).success;
  const base = `/api/v2/finance/books/${bookId}/reports`;

  const read = useCallback(
    async (suffix: string, signal: AbortSignal) => {
      const response = await fetch(base + suffix, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new ReportReadError(response.status);
      return response.json() as Promise<unknown>;
    },
    [base],
  );

  const load = useCallback(
    async (nextOffset = 0) => {
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      setBusy('list');
      setError('');
      setNotice('');
      setPage(undefined);
      setSelected(undefined);
      setReport(undefined);
      try {
        const result = ReportPage.parse(
          await read(
            `?offset=${nextOffset}&limit=${PAGE_SIZE}`,
            current.signal,
          ),
        );
        if (
          result.reports.some((value) => value.bookId !== bookId) ||
          new Set(result.reports.map((value) => value.id)).size !==
            result.reports.length ||
          (result.nextOffset !== null && result.nextOffset <= nextOffset)
        )
          throw new Error('Unexpected report page');
        if (!mounted.current || current.signal.aborted) return;
        setPage(result);
        setOffset(nextOffset);
      } catch (cause) {
        if (mounted.current && !current.signal.aborted)
          setError(
            cause instanceof ReportReadError
              ? cause.message
              : 'Unable to load saved reports. Refresh to try again.',
          );
      } finally {
        if (mounted.current && !current.signal.aborted) setBusy(undefined);
      }
    },
    [bookId, read],
  );
  useEffect(() => {
    mounted.current = true;
    if (canRead) void load();
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [canRead, load]);
  useEffect(() => {
    if (report) detailHeading.current?.focus();
  }, [report?.id]);

  async function open(
    summary: FinanceGeneratedReportSummary,
    download = false,
  ) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(download ? 'download' : 'detail');
    setError('');
    setNotice('');
    if (!download) {
      setSelected(summary);
      setReport(undefined);
      setRowOffset(0);
      setSourceOffset(0);
    }
    try {
      const result = FinanceGeneratedReportSchema.parse(
        await read(`/${summary.id}`, current.signal),
      );
      for (const key of [
        'id',
        'bookId',
        'workspaceId',
        'automationRunId',
        'reportVersion',
        'kind',
        'coverage',
        'currency',
        'snapshotAt',
        'periodId',
        'periodStart',
        'periodEnd',
        'asOf',
      ] as const)
        if (result[key] !== summary[key])
          throw new Error('Unexpected report identity');
      if (!mounted.current || current.signal.aborted) return;
      if (download) {
        if (!report || JSON.stringify(result) !== JSON.stringify(report))
          throw new Error('Saved snapshot changed after review');
        saveMemoryFile(
          `emdo-${result.kind === 'posted-ledger-trial-balance' ? 'posted-ledger' : result.kind}-${result.id}.html`,
          generatedReportHtml(result, bookName),
          'text/html;charset=utf-8',
        );
        setNotice(
          'Download prepared with all account rows, classifications, source journals, and snapshot provenance.',
        );
      } else setReport(result);
    } catch (cause) {
      if (!mounted.current || current.signal.aborted) return;
      setReport(undefined);
      if (
        cause instanceof ReportReadError &&
        [401, 403, 503].includes(cause.status)
      ) {
        setPage(undefined);
        setSelected(undefined);
      }
      setError(
        cause instanceof ReportReadError
          ? cause.message
          : download
            ? 'The report download could not be prepared. Reopen the report and try again.'
            : 'This saved report could not be verified. Refresh the list and try again.',
      );
    } finally {
      if (mounted.current && !current.signal.aborted) setBusy(undefined);
    }
  }

  return (
    <section
      className="finance-saved-reports"
      aria-label="Saved accounting reports"
    >
      <div className="finance-saved-reports__heading">
        <div>
          <span className="finance-saved-reports__eyebrow">Report library</span>
          <h2>Saved reports</h2>
          <p>Review accounting snapshots saved for {bookName}.</p>
        </div>
        {canRead && (
          <Button
            variant="secondary"
            disabled={busy === 'list'}
            onClick={() => void load(offset)}
          >
            <Icon name="sync" size={16} />
            Refresh reports
          </Button>
        )}
      </div>
      <p className="finance-saved-reports__readiness">
        <Icon name="info" size={16} />
        <span>
          Saved snapshots are generated by the EMDO Finance automation leaf
          after a valid grant. Statement runs stop visibly when account
          classifications are missing.
        </span>
      </p>
      {!canRead ? (
        <p className="finance-saved-reports__empty">
          Access to this accounting book is required to read saved reports.
        </p>
      ) : (
        <>
          {error && <p role="alert">{error}</p>}
          <p className="finance-saved-reports__feedback" role="status">
            {notice ||
              (busy === 'list'
                ? 'Loading saved reports…'
                : busy === 'detail'
                  ? 'Loading report snapshot…'
                  : busy === 'download'
                    ? 'Verifying access and preparing the complete report…'
                    : '')}
          </p>
          {page && page.reports.length === 0 ? (
            <div className="finance-saved-reports__empty">
              <span className="finance-empty__icon">
                <Icon name="finance" size={24} />
              </span>
              <h3>
                {offset === 0
                  ? 'No saved reports for this book'
                  : 'No reports on this page'}
              </h3>
              <p>
                {offset === 0
                  ? 'A saved accounting snapshot will appear here when one is available.'
                  : 'Return to the previous page or refresh the report list.'}
              </p>
              {offset > 0 && (
                <Button
                  variant="secondary"
                  onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}
                >
                  Previous reports
                </Button>
              )}
            </div>
          ) : (
            page && (
              <div className="finance-saved-reports__layout">
                <aside
                  className="finance-report-library"
                  aria-label="Report list"
                >
                  <p className="finance-report-library__count">
                    Reports {offset + 1}–{offset + page.reports.length}
                  </p>
                  <ul>
                    {page.reports.map((summary) => (
                      <li key={summary.id}>
                        <button
                          type="button"
                          aria-pressed={selected?.id === summary.id}
                          onClick={() => void open(summary)}
                        >
                          <span className="finance-report-library__title">
                            {reportTitle(summary.kind)}
                            <Icon name="chevron-right" size={16} />
                          </span>
                          <time dateTime={summary.snapshotAt}>
                            {summary.snapshotAt}
                          </time>
                          <span className="finance-report-library__meta">
                            {summary.currency} · {reportScope(summary)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="finance-report-pagination">
                    <Button
                      variant="quiet"
                      disabled={offset === 0 || busy === 'list'}
                      onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}
                    >
                      Previous reports
                    </Button>
                    <Button
                      variant="quiet"
                      disabled={page.nextOffset === null || busy === 'list'}
                      onClick={() => void load(page.nextOffset!)}
                    >
                      Next reports
                    </Button>
                  </div>
                </aside>
                <div className="finance-report-detail">
                  {!report ? (
                    <div className="finance-report-detail__placeholder">
                      <Icon
                        name={busy === 'detail' ? 'sync' : 'finance'}
                        size={28}
                      />
                      <h3>
                        {busy === 'detail'
                          ? 'Loading the saved snapshot'
                          : selected && error
                            ? 'Report unavailable'
                            : 'Select a saved report'}
                      </h3>
                      <p>
                        Inspect account movements and the journals included in
                        each snapshot.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="finance-report-detail__heading">
                        <div>
                          <span className="finance-saved-reports__eyebrow">
                            Immutable snapshot · {report.currency}
                          </span>
                          <h3 ref={detailHeading} tabIndex={-1}>
                            {reportTitle(report.kind)}
                          </h3>
                          <time dateTime={report.snapshotAt}>
                            {report.snapshotAt}
                          </time>
                        </div>
                        <Button
                          variant="secondary"
                          disabled={Boolean(busy)}
                          onClick={() => selected && void open(selected, true)}
                        >
                          Download report
                        </Button>
                      </div>
                      <div className="finance-report-coverage">
                        <Icon name="info" size={18} />
                        <p>{reportCoverage(report)}</p>
                      </div>
                      <dl className="finance-report-totals">
                        <div>
                          <dt>
                            {reportTotalLabel(report.kind, 'debit')} ·{' '}
                            {report.currency}
                          </dt>
                          <dd>{report.totalDebit}</dd>
                        </div>
                        <div>
                          <dt>
                            {reportTotalLabel(report.kind, 'credit')} ·{' '}
                            {report.currency}
                          </dt>
                          <dd>{report.totalCredit}</dd>
                        </div>
                      </dl>
                      {report.reconciliation &&
                        report.kind !== 'posted-ledger-trial-balance' && (
                          <section
                            className="finance-report-reconciliation"
                            aria-label="Statement reconciliation"
                          >
                            <div className="finance-report-section-heading">
                              <h4>Statement reconciliation</h4>
                              <span>
                                {report.reconciliation.balanced
                                  ? 'Balanced'
                                  : 'Review required'}
                              </span>
                            </div>
                            <dl>
                              <div>
                                <dt>Selected journal debits</dt>
                                <dd>
                                  {report.reconciliation.sourceTotalDebit}{' '}
                                  {report.currency}
                                </dd>
                              </div>
                              <div>
                                <dt>Selected journal credits</dt>
                                <dd>
                                  {report.reconciliation.sourceTotalCredit}{' '}
                                  {report.currency}
                                </dd>
                              </div>
                              <div>
                                <dt>Statement debit flow</dt>
                                <dd>
                                  {report.reconciliation.statementTotalDebit}{' '}
                                  {report.currency}
                                </dd>
                              </div>
                              <div>
                                <dt>Statement credit flow</dt>
                                <dd>
                                  {report.reconciliation.statementTotalCredit}{' '}
                                  {report.currency}
                                </dd>
                              </div>
                              {report.kind === 'balance-sheet' && (
                                <>
                                  <div>
                                    <dt>Assets</dt>
                                    <dd>
                                      {report.reconciliation.balanceSheetAssets}{' '}
                                      {report.currency}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Liabilities</dt>
                                    <dd>
                                      {report.reconciliation.balanceSheetLiabilities}{' '}
                                      {report.currency}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Equity</dt>
                                    <dd>
                                      {report.reconciliation.balanceSheetEquity}{' '}
                                      {report.currency}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Current-year earnings</dt>
                                    <dd>
                                      {report.reconciliation.currentYearEarnings}{' '}
                                      {report.currency}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Difference</dt>
                                    <dd>
                                      {report.reconciliation.difference}{' '}
                                      {report.currency}
                                    </dd>
                                  </div>
                                </>
                              )}
                            </dl>
                          </section>
                        )}
                      <div className="finance-report-section-heading">
                        <h4>
                          {report.kind === 'balance-sheet'
                            ? 'Ending balances'
                            : report.kind === 'income-statement'
                              ? 'Income statement rows'
                              : 'Account movements'}
                        </h4>
                        <span>{report.rows.length} accounts</span>
                      </div>
                      {report.rows.length ? (
                        <>
                          <div
                            className="finance-table-scroll"
                            tabIndex={0}
                            aria-label="Account movement records"
                          >
                            <table>
                              <caption>
                                {report.kind === 'posted-ledger-trial-balance'
                                  ? 'Gross posted movements'
                                  : reportTitle(report.kind)}{' '}
                                · {report.currency}
                              </caption>
                              <thead>
                                <tr>
                                  <th scope="col">Account</th>
                                  <th scope="col">
                                    {report.kind === 'posted-ledger-trial-balance'
                                      ? 'Gross debit'
                                      : 'Debit'}
                                  </th>
                                  <th scope="col">
                                    {report.kind === 'posted-ledger-trial-balance'
                                      ? 'Gross credit'
                                      : 'Credit'}
                                  </th>
                                  <th scope="col">
                                    {report.kind === 'balance-sheet'
                                      ? 'Ending balance'
                                      : 'Net movement'}
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {report.rows
                                  .slice(rowOffset, rowOffset + PAGE_SIZE)
                                  .map((row) => (
                                    <tr key={row.accountId}>
                                      <th scope="row">
                                        <span>
                                          {row.code} · {row.name}
                                        </span>
                                        <small>{row.kind}</small>
                                        {row.classification && (
                                          <small>
                                            {row.classification.section} · rev.{' '}
                                            {row.classification.revision}
                                          </small>
                                        )}
                                        {row.balanceBasis && (
                                          <small>
                                            Balance: {row.balanceBasis}
                                          </small>
                                        )}
                                        <details>
                                          <summary>Account reference</summary>
                                          <span className="finance-report-reference">
                                            {row.accountId}
                                          </span>
                                        </details>
                                      </th>
                                      <td>{row.debit}</td>
                                      <td>{row.credit}</td>
                                      <td>{row.balance}</td>
                                    </tr>
                                  ))}
                              </tbody>
                            </table>
                          </div>
                          <ReportPagination
                            label="Account rows"
                            count={report.rows.length}
                            offset={rowOffset}
                            onChange={setRowOffset}
                          />
                        </>
                      ) : (
                        <p className="finance-empty-line">
                          No account rows were included in this snapshot.
                        </p>
                      )}
                      <details className="finance-report-sources">
                        <summary>
                          Source journals{' '}
                          <span>{report.sourceJournals.length}</span>
                        </summary>
                        <p>
                          Journal identities and source hashes recorded with
                          this snapshot.
                        </p>
                        {report.sourceJournals.length ? (
                          <>
                            <ul>
                              {report.sourceJournals
                                .slice(sourceOffset, sourceOffset + PAGE_SIZE)
                                .map((source) => (
                                  <li key={source.journalId}>
                                    <details>
                                      <summary>
                                        <span>{source.sourceReference}</span>
                                        <time dateTime={source.effectiveOn}>
                                          {source.effectiveOn}
                                        </time>
                                      </summary>
                                      <dl>
                                        <div>
                                          <dt>Journal</dt>
                                          <dd>{source.journalId}</dd>
                                        </div>
                                        <div>
                                          <dt>Payload SHA-256</dt>
                                          <dd>{source.payloadHash}</dd>
                                        </div>
                                      </dl>
                                    </details>
                                  </li>
                                ))}
                            </ul>
                            <ReportPagination
                              label="Source journals"
                              count={report.sourceJournals.length}
                              offset={sourceOffset}
                              onChange={setSourceOffset}
                            />
                          </>
                        ) : (
                          <p className="finance-empty-line">
                            No posted source journals were included in this
                            snapshot.
                          </p>
                        )}
                      </details>
                      <details className="finance-report-provenance">
                        <summary>Snapshot provenance</summary>
                        <dl>
                          <div>
                            <dt>Report</dt>
                            <dd>{report.id}</dd>
                          </div>
                          <div>
                            <dt>Book</dt>
                            <dd>
                              {bookName} · {report.bookId}
                            </dd>
                          </div>
                          <div>
                            <dt>Workspace</dt>
                            <dd>{report.workspaceId}</dd>
                          </div>
                          <div>
                            <dt>Automation run</dt>
                            <dd>{report.automationRunId}</dd>
                          </div>
                          <div>
                            <dt>Report version</dt>
                            <dd>{report.reportVersion}</dd>
                          </div>
                          <div>
                            <dt>Report kind</dt>
                            <dd>{report.kind}</dd>
                          </div>
                          <div>
                            <dt>Coverage</dt>
                            <dd>{report.coverage}</dd>
                          </div>
                          <div>
                            <dt>Scope</dt>
                            <dd>{reportScope(report)}</dd>
                          </div>
                        </dl>
                      </details>
                      <p className="finance-report-detail__footnote">
                        Later postings are outside this snapshot. The download
                        includes all {report.rows.length} account rows and{' '}
                        {report.sourceJournals.length} source journals as a
                        readable HTML file.
                      </p>
                    </>
                  )}
                </div>
              </div>
            )
          )}
        </>
      )}
    </section>
  );
}

function ReportPagination({
  label,
  count,
  offset,
  onChange,
}: {
  label: string;
  count: number;
  offset: number;
  onChange: (value: number) => void;
}) {
  if (count <= PAGE_SIZE) return null;
  return (
    <div className="finance-report-pagination" aria-label={`${label} pages`}>
      <span>
        {offset + 1}–{Math.min(offset + PAGE_SIZE, count)} of {count}
      </span>
      <div>
        <Button
          variant="quiet"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}
        >
          Previous {label.toLowerCase()}
        </Button>
        <Button
          variant="quiet"
          disabled={offset + PAGE_SIZE >= count}
          onClick={() => onChange(offset + PAGE_SIZE)}
        >
          Next {label.toLowerCase()}
        </Button>
      </div>
    </div>
  );
}
