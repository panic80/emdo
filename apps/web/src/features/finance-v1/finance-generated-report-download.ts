import type {
  FinanceGeneratedReport,
  FinanceGeneratedReportSummary,
} from '@emdo/contracts/browser';

const entities: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (value: string | number | null) =>
  String(value ?? '').replace(/[&<>"']/gu, (character) => entities[character]!);
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

/** A complete, script-free report. Decimal and timestamp strings remain exact. */
export function generatedReportHtml(
  report: FinanceGeneratedReport,
  bookName: string,
) {
  const e = escapeHtml;
  const title = reportTitle(report.kind);
  const scope = reportScope(report);
  const rows = report.rows
    .map(
      (row) =>
        `<tr><th scope="row">${e(row.code)} · ${e(row.name)}<small>${e(row.kind)}${row.classification ? ` · ${e(row.classification.section)} · rev. ${row.classification.revision}` : ''}${row.balanceBasis ? ` · ${e(row.balanceBasis)}` : ''} · ${e(row.accountId)}</small></th><td>${e(row.debit)}</td><td>${e(row.credit)}</td><td>${e(row.balance)}</td></tr>`,
    )
    .join('');
  const sources = report.sourceJournals
    .map(
      (source) =>
        `<tr><th scope="row">${e(source.sourceReference)}<small>${e(source.journalId)}</small></th><td>${e(source.effectiveOn)}</td><td class="hash">${e(source.payloadHash)}</td></tr>`,
    )
    .join('');
  const isTrial = report.kind === 'posted-ledger-trial-balance';
  const isBalanceSheet = report.kind === 'balance-sheet';
  const reconciliation = report.reconciliation;
  const reconciliationHtml =
    !isTrial && reconciliation
      ? `<h2>Statement reconciliation</h2><dl class="reconciliation"><div><dt>Selected journal debits</dt><dd>${e(reconciliation.sourceTotalDebit)} ${e(report.currency)}</dd></div><div><dt>Selected journal credits</dt><dd>${e(reconciliation.sourceTotalCredit)} ${e(report.currency)}</dd></div><div><dt>Statement debit flow</dt><dd>${e(reconciliation.statementTotalDebit)} ${e(report.currency)}</dd></div><div><dt>Statement credit flow</dt><dd>${e(reconciliation.statementTotalCredit)} ${e(report.currency)}</dd></div>${isBalanceSheet ? `<div><dt>Assets</dt><dd>${e(reconciliation.balanceSheetAssets)} ${e(report.currency)}</dd></div><div><dt>Liabilities</dt><dd>${e(reconciliation.balanceSheetLiabilities)} ${e(report.currency)}</dd></div><div><dt>Equity</dt><dd>${e(reconciliation.balanceSheetEquity)} ${e(report.currency)}</dd></div><div><dt>Current-year earnings</dt><dd>${e(reconciliation.currentYearEarnings)} ${e(report.currency)}</dd></div><div><dt>Difference</dt><dd>${e(reconciliation.difference)} ${e(report.currency)}</dd></div>` : ''}<div><dt>Status</dt><dd>${reconciliation.balanced ? 'Balanced' : 'Review required'}</dd></div></dl>`
      : '';
  const periodMetadata =
    report.kind === 'income-statement'
      ? `<div><dt>Period</dt><dd>${e(report.periodId)} · ${e(report.periodStart)} to ${e(report.periodEnd)}</dd></div>`
      : report.kind === 'balance-sheet'
        ? `<div><dt>As of</dt><dd>${e(report.asOf)}</dd></div>`
        : '';
  const movementHeading = isTrial
    ? 'Account movements'
    : isBalanceSheet
      ? 'Ending balances'
      : 'Income statement rows';
  const debitHeading = isTrial ? 'Gross debit' : 'Debit';
  const creditHeading = isTrial ? 'Gross credit' : 'Credit';
  const balanceHeading = isBalanceSheet ? 'Ending balance' : 'Net movement';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)} · ${e(bookName)}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f7f9;color:#14243b;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1400px;margin:32px auto;padding:36px;background:white;border:1px solid #dce4e9;border-radius:10px}h1{font-size:30px;letter-spacing:-.03em;line-height:1.2;margin:8px 0}h2{font-size:18px;margin-top:32px}.eyebrow{color:#17624d;text-transform:uppercase;letter-spacing:.09em;font-size:11px;font-weight:700}.muted,small,dt{color:#53667a}small{display:block;font-weight:400;font-size:11px;overflow-wrap:anywhere}.scope{padding:16px 20px;background:#f3f7f5;border-left:3px solid #17624d}.totals{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:24px 0}.totals div,.reconciliation{padding:16px;border:1px solid #dce4e9;border-radius:6px}.totals dd{font-size:20px;font-weight:650;overflow-wrap:anywhere}.reconciliation{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 20px;background:#fbfcfc}.reconciliation dd{margin:0;font-variant-numeric:tabular-nums}dd{margin:0;font-variant-numeric:tabular-nums}table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;border-bottom:1px solid #dce4e9;padding:12px;vertical-align:top}thead{background:#f6f8fa}tbody th{font-weight:600}td{font-variant-numeric:tabular-nums}tfoot{font-weight:700}.records td:not(:first-child){white-space:nowrap}.scroll{overflow:auto}.hash{overflow-wrap:anywhere;max-width:330px}.metadata{display:grid;gap:10px}.metadata div{display:grid;grid-template-columns:180px minmax(0,1fr);gap:16px}.metadata dd{overflow-wrap:anywhere}.empty{padding:20px;background:#f8fafb}footer{font-size:11px;color:#53667a;margin-top:32px;padding-top:16px;border-top:1px solid #dce4e9}@media(max-width:600px){main{padding:20px;margin:0;border-radius:0}.totals,.reconciliation{grid-template-columns:1fr}.metadata div{grid-template-columns:1fr;gap:3px}}@media print{body{background:white}main{margin:0;padding:0;border:0}.scroll{overflow:visible}.records td:not(:first-child){white-space:normal;overflow-wrap:anywhere}thead{display:table-header-group}tr{break-inside:avoid}h2{break-after:avoid}}
</style></head><body><main>
<div class="eyebrow">EMDO · Saved accounting report</div><h1>${e(title)}</h1><p>${e(bookName)} · ${e(report.currency)} · ${e(scope)}</p>
<p class="scope">${e(reportCoverage(report))}</p>
<p class="muted">Snapshot captured: <time datetime="${e(report.snapshotAt)}">${e(report.snapshotAt)}</time></p>
<dl class="totals"><div><dt>${e(reportTotalLabel(report.kind, 'debit'))} · ${e(report.currency)}</dt><dd>${e(report.totalDebit)}</dd></div><div><dt>${e(reportTotalLabel(report.kind, 'credit'))} · ${e(report.currency)}</dt><dd>${e(report.totalCredit)}</dd></div></dl>
${reconciliationHtml}
<h2>${e(movementHeading)} (${report.rows.length})</h2>${report.rows.length ? `<div class="scroll"><table class="records"><thead><tr><th>Account</th><th>${e(debitHeading)} · ${e(report.currency)}</th><th>${e(creditHeading)} · ${e(report.currency)}</th><th>${e(balanceHeading)} · ${e(report.currency)}</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th scope="row">${e(title)} totals</th><td>${e(report.totalDebit)}</td><td>${e(report.totalCredit)}</td><td>—</td></tr></tfoot></table></div>` : '<p class="empty">No account rows were included in this snapshot.</p>'}
<h2>Source journals (${report.sourceJournals.length})</h2>${report.sourceJournals.length ? `<div class="scroll"><table><thead><tr><th>Source reference / journal</th><th>Effective date</th><th>Payload SHA-256</th></tr></thead><tbody>${sources}</tbody></table></div>` : '<p class="empty">No posted source journals were included in this snapshot.</p>'}
<h2>Snapshot provenance</h2><dl class="metadata"><div><dt>Report</dt><dd>${e(report.id)}</dd></div><div><dt>Book</dt><dd>${e(report.bookId)}</dd></div><div><dt>Workspace</dt><dd>${e(report.workspaceId)}</dd></div><div><dt>Automation run</dt><dd>${e(report.automationRunId)}</dd></div><div><dt>Report version</dt><dd>${report.reportVersion}</dd></div><div><dt>Report kind</dt><dd>${e(report.kind)}</dd></div><div><dt>Coverage</dt><dd>${e(report.coverage)}</dd></div>${periodMetadata}</dl>
<footer>Complete saved snapshot. Decimal amounts and source timestamps are preserved as recorded. Later postings are outside this snapshot.</footer>
</main></body></html>`;
}
