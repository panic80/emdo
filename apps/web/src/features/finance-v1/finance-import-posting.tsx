import type { FinanceNormalizedImportPosting } from '@emdo/contracts/browser';
export function FinanceImportPosting({
  posting,
  status,
  functionalCurrency,
  accounts,
  evidenceId,
}: {
  posting: FinanceNormalizedImportPosting | null | undefined;
  status: string;
  functionalCurrency: string;
  accounts: readonly { id: string; code: string; name: string }[];
  evidenceId: string;
}) {
  if (posting === undefined)
    return <p>Saved posting details unavailable in this response.</p>;
  if (posting === null) return <p>No saved posting is linked to this row.</p>;
  if (posting.functionalCurrency !== functionalCurrency)
    return (
      <p role="alert">
        Saved posting currency does not match the current book.
      </p>
    );
  return (
    <details>
      <summary>
        {status === 'matched'
          ? 'Matched saved accounting trail'
          : 'Saved accounting trail'}{' '}
        · {posting.effectiveOn}
      </summary>
      <div style={{ overflowWrap: 'anywhere' }}>
        <p>{posting.description}</p>
        <ol aria-label="Saved journal lines">
          {posting.lines.map((line) => {
            const account = accounts.find((item) => item.id === line.accountId);
            return (
              <li key={line.lineNumber}>
                <h5>
                  Line {line.lineNumber} ·{' '}
                  {line.side === 'debit' ? 'Debit' : 'Credit'} ·{' '}
                  {account
                    ? `${account.code} · ${account.name}`
                    : 'Account name unavailable'}
                </h5>
                <dl>
                  <dt>Functional amount ({posting.functionalCurrency})</dt>
                  <dd>{line.amount}</dd>
                  <dt>Native amount ({line.currency})</dt>
                  <dd>{line.nativeAmount}</dd>
                  <dt>Saved FX rate</dt>
                  <dd>{line.fxRate}</dd>
                  <dt>FX source</dt>
                  <dd>{line.fxSource}</dd>
                  {line.description && (
                    <>
                      <dt>Line description</dt>
                      <dd>{line.description}</dd>
                    </>
                  )}
                  {!account && (
                    <>
                      <dt>Ledger account reference</dt>
                      <dd>{line.accountId}</dd>
                    </>
                  )}
                </dl>
              </li>
            );
          })}
        </ol>
        <details>
          <summary>Saved journal and source references</summary>
          <dl>
            <dt>Effective date</dt>
            <dd>{posting.effectiveOn}</dd>
            <dt>Journal</dt>
            <dd>{posting.journalId}</dd>
            <dt>Economic transaction</dt>
            <dd>{posting.economicTransactionId}</dd>
            <dt>Statement evidence</dt>
            <dd>{evidenceId}</dd>
            <dt>Saved source reference</dt>
            <dd>{posting.sourceReference ?? 'Not provided'}</dd>
            {posting.reversalOf && (
              <>
                <dt>Reversal of journal</dt>
                <dd>{posting.reversalOf}</dd>
              </>
            )}
          </dl>
        </details>
        <p>
          These are saved journal values. No amounts are recalculated here. Use
          Download original above to inspect the statement evidence.
        </p>
      </div>
    </details>
  );
}
