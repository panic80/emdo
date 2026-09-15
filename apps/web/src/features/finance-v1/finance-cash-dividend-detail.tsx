import { Button } from '../../components/button.js';
import {
  dividendAmountKinds,
  dividendAmountLabels,
} from './finance-cash-dividend-fields.js';
import type {
  DividendCatalog,
  DividendPlan,
  SavedDividend,
} from './finance-cash-dividend-api.js';

export const dividendLedgerLabel = (
  catalog: DividendCatalog | undefined,
  id: string,
) => {
  const account = catalog?.ledger.find((item) => item.id === id);
  return account ? `${account.code} · ${account.name}` : id;
};
export function DividendJournalPreview({
  plan,
  catalog,
}: {
  plan: DividendPlan;
  catalog: DividendCatalog;
}) {
  return (
    <div
      className="finance-table-scroll"
      tabIndex={0}
      aria-label="Dividend journal preview"
    >
      <table>
        <caption>Proposed journal · {plan.source.functionalCurrency}</caption>
        <thead>
          <tr>
            <th scope="col">Financial meaning</th>
            <th scope="col">Ledger account</th>
            <th scope="col">Debit</th>
            <th scope="col">Credit</th>
          </tr>
        </thead>
        <tbody>
          {plan.journalLines.map((line) => (
            <tr key={line.kind}>
              <th scope="row">{dividendAmountLabels[line.kind]}</th>
              <td>{dividendLedgerLabel(catalog, line.accountId)}</td>
              <td className="finance-dividend-number">
                {line.side === 'debit' ? line.amount : '—'}
              </td>
              <td className="finance-dividend-number">
                {line.side === 'credit' ? line.amount : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function DividendSavedDetail({
  record,
  catalog,
  busy,
  onDownload,
  onOriginal,
}: {
  record: SavedDividend;
  catalog?: DividendCatalog;
  busy: boolean;
  onDownload: () => void;
  onOriginal: () => void;
}) {
  return (
    <section
      className="finance-dividend-saved"
      aria-label="Saved cash dividend"
    >
      <div className="finance-dividend-heading">
        <div>
          <span className="finance-dividend-eyebrow">Posted dividend</span>
          <h5>{record.sourceReference}</h5>
          <p>
            Payment {record.payableOn} · saved{' '}
            {new Intl.DateTimeFormat(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(record.createdAt))}
          </p>
        </div>
        <span className="finance-dividend-badge">Posted</span>
      </div>
      <div className="finance-dividend-amount-summary">
        {dividendAmountKinds.map((kind) => (
          <div key={kind}>
            <span>{dividendAmountLabels[kind]}</span>
            <strong>
              {record[kind].functionalAmount} {record.source.functionalCurrency}
            </strong>
            <small>
              {record[kind].nativeAmount} {record[kind].currency} in original
              currency
            </small>
          </div>
        ))}
      </div>
      <p>{record.reviewReason}</p>
      <div className="finance-dividend-actions">
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onOriginal}
        >
          Download dividend original
        </Button>
        <Button
          type="button"
          variant="quiet"
          disabled={busy}
          onClick={onDownload}
        >
          Download saved dividend
        </Button>
      </div>
      <div
        className="finance-table-scroll"
        tabIndex={0}
        aria-label="Saved dividend amounts and ledger proof"
      >
        <table>
          <caption>Saved amounts and posting accounts</caption>
          <thead>
            <tr>
              <th scope="col">Meaning / source</th>
              <th scope="col">Original amount</th>
              <th scope="col">Book amount</th>
              <th scope="col">Account / posting</th>
            </tr>
          </thead>
          <tbody>
            {dividendAmountKinds.map((kind) => {
              const amount = record[kind];
              return (
                <tr key={kind}>
                  <th scope="row">
                    {dividendAmountLabels[kind]}
                    <small>
                      Row {amount.provenance.sourceRow} ·{' '}
                      {amount.provenance.column ??
                        amount.provenance.contextAnchor ??
                        'Location unavailable'}
                    </small>
                  </th>
                  <td className="finance-dividend-number">
                    {amount.nativeAmount} {amount.currency}
                    <small>Original: {amount.provenance.raw}</small>
                  </td>
                  <td className="finance-dividend-number">
                    {amount.functionalAmount} {record.source.functionalCurrency}
                    <small>
                      Rate {amount.fxRate} · {amount.fxSource}
                    </small>
                  </td>
                  <td>
                    {dividendLedgerLabel(catalog, amount.ledgerAccountId)}
                    <small>
                      {amount.journalLineNumber === null
                        ? 'Explicit zero retained; no journal line'
                        : `${amount.postingSide} · journal line ${amount.journalLineNumber}`}
                    </small>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <details className="finance-dividend-provenance">
        <summary>Original, source revision and journal evidence</summary>
        <dl>
          <div>
            <dt>Source row</dt>
            <dd>
              Row {record.source.sourceRow} · reviewed revision{' '}
              {record.sourceRevision} · current revision{' '}
              {record.source.currentRevision}
            </dd>
          </div>
          <div>
            <dt>Source description</dt>
            <dd>{record.source.description}</dd>
          </div>
          <div>
            <dt>Original reference</dt>
            <dd>
              <code>{record.evidenceId}</code>
            </dd>
          </div>
          <div>
            <dt>Reviewed source fingerprint</dt>
            <dd>
              <code>{record.sourceSnapshotHash}</code>
            </dd>
          </div>
          <div>
            <dt>Financial account</dt>
            <dd>
              {catalog?.accounts.find(
                (item) => item.id === record.financialAccountId,
              )?.name ?? record.financialAccountId}
            </dd>
          </div>
          <div>
            <dt>Investment</dt>
            <dd>
              {catalog?.instruments.find(
                (item) => item.id === record.instrumentId,
              )?.name ?? record.instrumentId}
            </dd>
          </div>
          <div>
            <dt>Journal reference</dt>
            <dd>
              <code>{record.journalId}</code>
            </dd>
          </div>
          <div>
            <dt>Economic transaction</dt>
            <dd>
              <code>{record.economicTransactionId}</code>
            </dd>
          </div>
          <div>
            <dt>Saved action</dt>
            <dd>
              <code>{record.id}</code>
            </dd>
          </div>
          <div>
            <dt>Exact saved time</dt>
            <dd>
              <time dateTime={record.createdAt}>{record.createdAt}</time>
            </dd>
          </div>
        </dl>
      </details>
    </section>
  );
}
