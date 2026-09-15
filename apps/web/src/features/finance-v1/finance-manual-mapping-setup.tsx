import { useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { type FinanceReportMappingDefinition } from '@emdo/contracts/browser';
import {
  readStandardizationOriginal,
  StandardizationRequestError,
} from './finance-standardization-api.js';
import { Button } from '../../components/button.js';

const Setup = z.object({
  providerKey: z.string().trim().min(1).max(100),
  reportName: z.string().trim().min(1).max(200),
  reportType: z.enum(['bank-transactions', 'investment-positions']),
  layoutVersion: z.string().trim().min(1).max(100),
  headers: z.array(z.string().min(1).max(200)).min(1).max(100),
});
/** An unsaved human-authored draft. Empty bindings cannot pass the save schema. */
export function FinanceManualMappingSetup({
  format,
  disabled,
  onDownload,
  onContinue,
  csvSource,
  onAccessUnavailable,
}: {
  format: 'csv' | 'xlsx';
  csvSource?: { bookId: string; evidenceId: string; sourceDigest: string };
  onAccessUnavailable?: (message: string) => void;
  disabled: boolean;
  onDownload: () => void;
  onContinue: (definition: FinanceReportMappingDefinition) => void;
}) {
  const [error, setError] = useState('');
  const [headers, setHeaders] = useState('');
  const [loading, setLoading] = useState(Boolean(csvSource));
  const [observed, setObserved] = useState(false);
  const [sourceUnavailable, setSourceUnavailable] = useState(false);
  const bookId = csvSource?.bookId,
    evidenceId = csvSource?.evidenceId,
    sourceDigest = csvSource?.sourceDigest;
  useEffect(() => {
    if (!bookId || !evidenceId || !sourceDigest) return;
    const controller = new AbortController();
    setLoading(true);
    setHeaders('');
    setObserved(false);
    setSourceUnavailable(false);
    let verified = false;
    void readStandardizationOriginal(
      { bookId, evidenceId, sourceDigest, format: 'csv' },
      controller.signal,
    )
      .then((original) => {
        if (controller.signal.aborted) return;
        verified = true;
        const values = readObservedCsvHeaders(
          new TextDecoder('utf-8', { fatal: true }).decode(original.bytes),
        );
        setHeaders(values.join('\n'));
        setObserved(true);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (
          cause instanceof StandardizationRequestError &&
          [401, 403].includes(cause.status)
        ) {
          setHeaders('');
          onAccessUnavailable?.(cause.message);
        } else if (!verified) {
          setSourceUnavailable(true);
          setError(
            'The original CSV could not be verified. Reopen this review to retry before creating a mapping.',
          );
        } else
          setError(
            'Headings could not be read automatically. Download and check the original, then enter its exact headings.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [bookId, evidenceId, sourceDigest]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || loading || sourceUnavailable) return;
    const form = new FormData(event.currentTarget);
    try {
      if (form.get('checked') !== 'on')
        throw new Error('Check the original document before continuing.');
      const setup = Setup.parse({
        ...Object.fromEntries(form),
        headers: String(form.get('headers') ?? '')
          .split('\n')
          .map((value) => value.replace(/\r$/, '')),
      });
      if (new Set(setup.headers).size !== setup.headers.length)
        throw new Error('Source headings must be distinct.');
      onContinue({
        ...setup,
        bindings: (setup.reportType === 'bank-transactions'
          ? (['transactionDate', 'description', 'amount', 'currency'] as const)
          : (['asOf', 'instrumentIdentifier', 'quantity', 'currency'] as const)
        ).map((field) => ({ field, column: '', context: null })),
        dateFormat: 'yyyy-mm-dd',
        decimalSeparator: '.',
        groupingSeparator: '',
        quantityUnit: null,
        valuationMultiplier: null,
        identifierScheme: null,
        identifierNamespace: null,
      });
    } catch (cause) {
      setError(
        cause instanceof z.ZodError
          ? cause.issues.map((issue) => issue.message).join(' ')
          : cause instanceof Error
            ? cause.message
            : 'Check the source details.',
      );
    }
  }
  return (
    <section aria-label="Create a manual source mapping">
      <h4>Create a manual source mapping</h4>
      <p>
        No mapping has been proposed. Check the original document and identify
        this report. Continuing opens an unsaved draft with no field meanings
        selected.
      </p>
      <Button
        type="button"
        variant="quiet"
        disabled={disabled || loading}
        onClick={onDownload}
      >
        Download original {format === 'xlsx' ? 'workbook' : 'CSV'}
      </Button>
      {loading && <p role="status">Reading original CSV headings…</p>}
      {observed && (
        <p>
          Initial headings were read from the digest-verified original CSV.
          Confirm them against the source before continuing.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <form onSubmit={submit}>
        <fieldset disabled={disabled || loading || sourceUnavailable}>
          <legend>Report identity and source headings</legend>
          <label>
            Provider name
            <input name="providerKey" required maxLength={100} />
          </label>
          <label>
            Report name
            <input name="reportName" required maxLength={200} />
          </label>
          <label>
            Report type
            <select name="reportType" required defaultValue="">
              <option value="" disabled>
                Choose the report type
              </option>
              <option value="bank-transactions">Bank transactions</option>
              <option value="investment-positions">Investment positions</option>
            </select>
          </label>
          <label>
            Layout version
            <input name="layoutVersion" required maxLength={100} />
          </label>
          <label>
            Exact source headings, one per line
            <textarea
              name="headers"
              required
              rows={5}
              value={headers}
              onChange={(event) => setHeaders(event.target.value)}
            />
          </label>
          <p>
            {format === 'xlsx'
              ? 'Copy the headings in order from the exact worksheet range you intend to review. The next step requires the worksheet name and row and column boundaries.'
              : 'Copy the CSV header cells in their original order, preserving spelling, case and spaces. Do not include CSV quoting characters around the cell values.'}
          </p>
          <label>
            <input type="checkbox" name="checked" required />I checked the
            original document and these report details and headings.
          </label>
          <Button type="submit">Continue to field review</Button>
        </fieldset>
      </form>
    </section>
  );
}

/** Read the first RFC-style comma-separated record only; never infer field meanings. */
export function readObservedCsvHeaders(source: string): string[] {
  if (source.length > 2_097_152) throw new Error('CSV source too large');
  const text = source.replace(/^\uFEFF/u, '');
  const cells: string[] = [];
  let cell = '',
    quoted = false,
    closed = false;
  for (let index = 0; index <= text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else if (char === undefined || char === '\n' || char === '\r')
        throw new Error(
          'Multiline or incomplete headings require manual review',
        );
      else cell += char;
    } else if (
      char === ',' ||
      char === '\r' ||
      char === '\n' ||
      char === undefined
    ) {
      cells.push(cell);
      cell = '';
      closed = false;
      if (char !== ',') break;
    } else if (char === '"' && cell === '' && !closed) quoted = true;
    else if (closed || char === '"') throw new Error('Invalid CSV heading');
    else cell += char;
  }
  if (
    !cells.length ||
    cells.length > 100 ||
    cells.some((cell) => !cell || cell.length > 200) ||
    new Set(cells).size !== cells.length
  )
    throw new Error('Ambiguous CSV headings');
  return cells;
}
