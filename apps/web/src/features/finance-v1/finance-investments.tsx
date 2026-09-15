import { FinanceInvestmentReconciliation } from './finance-investment-reconciliation.js';
import { FinanceValuationBuilder } from './finance-valuation-builder.js';
import { FinanceStockSplitReview } from './finance-corporate-actions.js';
import { FinanceCashDividends } from './finance-cash-dividends.js';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { UuidSchema, FinanceDecimalSchema } from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
const Run = z.object({
  id: UuidSchema,
  asOf: z.string(),
  calculationVersion: z.string(),
  status: z.enum(['complete', 'incomplete']),
  currency: z.string(),
  total: FinanceDecimalSchema.nullable(),
  valuationScope: z.literal('selected-positions'),
});
const Position = z
  .object({
    financialAccountId: UuidSchema,
    instrumentId: UuidSchema,
    quantity: FinanceDecimalSchema.nullable(),
    nativeCurrency: z.string().nullable(),
    nativeValue: FinanceDecimalSchema.nullable(),
    functionalValue: FinanceDecimalSchema.nullable(),
    status: z.string(),
    reason: z.string().nullable(),
    sourceReferences: z.array(z.string()),
  })
  .passthrough();
const Reconciliation = z
  .object({
    observedPositionId: UuidSchema,
    evidenceId: UuidSchema,
    sourceRow: z.number(),
    observedQuantity: FinanceDecimalSchema,
    calculatedQuantity: FinanceDecimalSchema.nullable(),
    difference: FinanceDecimalSchema.nullable(),
    status: z.string(),
  })
  .passthrough();
const Detail = z.object({
  id: UuidSchema,
  asOf: z.string(),
  calculationVersion: z.string(),
  inputSnapshot: z.unknown(),
  result: z.object({
    mode: z.literal('saved'),
    valuationScope: z.literal('selected-positions'),
    status: z.enum(['complete', 'incomplete']),
    currency: z.string(),
    total: FinanceDecimalSchema.nullable(),
    availableSubtotal: FinanceDecimalSchema,
    unavailableCount: z.number().int(),
    positions: z.array(Position),
    reconciliations: z.array(Reconciliation),
    calculations: z.array(z.unknown()),
  }),
});
/** Parent keys this component by book and authenticated session. */
export function FinanceInvestments({
  bookId,
  role = 'viewer',
}: {
  bookId: string;
  role?: string;
}) {
  const [opened, setOpened] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [runs, setRuns] = useState<z.infer<typeof Run>[]>([]),
    [detail, setDetail] = useState<z.infer<typeof Detail>>(),
    [offset, setOffset] = useState(0),
    [nextOffset, setNextOffset] = useState<number | null>(null),
    [visible, setVisible] = useState(10);
  const alive = useRef(true),
    working = useRef(false),
    controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  const base = `/api/v2/finance/books/${bookId}/investments/valuation-runs`;
  async function action(work: (signal: AbortSignal) => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    try {
      await work(current.signal);
    } catch (e) {
      if (alive.current && !current.signal.aborted)
        setError(e instanceof Error ? e.message : 'Unable to load valuations.');
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function read(path: string, signal: AbortSignal) {
    const response = await fetch(base + path, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
    if (!response.ok)
      throw new Error(
        response.status === 403
          ? 'Current book access does not permit reading these valuations.'
          : response.status === 503
            ? 'Investment valuations are not available in this environment.'
            : 'Unable to load this saved valuation.',
      );
    return response.json() as Promise<unknown>;
  }
  function load(page = offset) {
    void action(async (signal) => {
      const result = z
        .object({ runs: z.array(Run), nextOffset: z.number().nullable() })
        .parse(await read(`?offset=${page}&limit=50`, signal));
      if (alive.current && !signal.aborted) {
        setRuns(result.runs);
        setOffset(page);
        setNextOffset(result.nextOffset);
        setOpened(true);
      }
    });
  }
  function select(id: string) {
    void action(async (signal) => {
      const result = Detail.parse(await read(`/${id}`, signal));
      if (alive.current && !signal.aborted) {
        setDetail(result);
        setVisible(10);
      }
    });
  }
  return (
    <section aria-label="Investment valuations">
      <h3>Investments</h3>
      <p>
        Work in progress (WIP). Existing investment records remain available.
      </p>
      {role !== 'viewer' && (
        <FinanceStockSplitReview bookId={bookId} role={role} />
      )}
      <FinanceCashDividends bookId={bookId} role={role} />
      <FinanceInvestmentReconciliation bookId={bookId} role={role} />
      {['administrator', 'preparer', 'approver'].includes(role) && (
        <FinanceValuationBuilder bookId={bookId} onSaved={select} />
      )}
      <p>
        Saved valuations retain the prices, exchange rates and position evidence
        used at calculation time.
      </p>
      <Button variant="quiet" disabled={busy} onClick={() => load()}>
        {opened ? 'Refresh valuations' : 'Open investment valuations'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {opened && (
        <>
          {!runs.length && <p>No saved valuations on this page.</p>}
          <ul>
            {runs.map((run) => (
              <li key={run.id}>
                <Button
                  variant="quiet"
                  disabled={busy}
                  onClick={() => select(run.id)}
                >
                  {run.asOf} · {run.currency} · {run.status} · {run.id}
                </Button>
              </li>
            ))}
          </ul>
          <Button
            variant="quiet"
            disabled={busy || offset === 0}
            onClick={() => load(Math.max(0, offset - 50))}
          >
            Previous valuations
          </Button>
          <Button
            variant="quiet"
            disabled={busy || nextOffset === null}
            onClick={() => load(nextOffset!)}
          >
            Next valuations
          </Button>
        </>
      )}
      {detail && (
        <div>
          <h4>Saved valuation · {detail.asOf}</h4>
          <p>
            Selected positions only. This historical result is not a current
            whole-book balance.
          </p>
          <p>
            Status: {detail.result.status}. Calculation version:{' '}
            {detail.calculationVersion}.
          </p>
          <p>
            Total:{' '}
            {detail.result.total === null
              ? 'Unavailable'
              : `${detail.result.total} ${detail.result.currency}`}
          </p>
          {detail.result.status === 'incomplete' && (
            <p>
              Available subtotal: {detail.result.availableSubtotal}{' '}
              {detail.result.currency}. Unavailable positions:{' '}
              {detail.result.unavailableCount}.
            </p>
          )}
          <div
            className="finance-table-scroll"
            tabIndex={0}
            aria-label="Financial records table"
          >
            <table>
              <caption>Saved position values</caption>
              <thead>
                <tr>
                  <th>Account / instrument</th>
                  <th>Quantity</th>
                  <th>Native value</th>
                  <th>Functional value</th>
                  <th>Availability</th>
                </tr>
              </thead>
              <tbody>
                {detail.result.positions.slice(0, visible).map((position) => (
                  <tr
                    key={`${position.financialAccountId}:${position.instrumentId}`}
                  >
                    <td>
                      {position.financialAccountId}
                      <br />
                      {position.instrumentId}
                    </td>
                    <td>{position.quantity ?? 'Unavailable'}</td>
                    <td>
                      {position.nativeValue === null
                        ? 'Unavailable'
                        : `${position.nativeValue} ${position.nativeCurrency ?? ''}`}
                    </td>
                    <td>
                      {position.functionalValue === null
                        ? 'Unavailable'
                        : `${position.functionalValue} ${detail.result.currency}`}
                    </td>
                    <td>
                      {position.reason ?? position.status}
                      <details>
                        <summary>Position sources and calculation</summary>
                        <pre className="finance-provenance">
                          {JSON.stringify(position, null, 2)}
                        </pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div
            className="finance-table-scroll"
            tabIndex={0}
            aria-label="Financial records table"
          >
            <table>
              <caption>Observed versus calculated quantities</caption>
              <thead>
                <tr>
                  <th>Evidence / source row</th>
                  <th>Observed</th>
                  <th>Calculated</th>
                  <th>Difference</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.result.reconciliations.slice(0, visible).map((item) => (
                  <tr key={item.observedPositionId}>
                    <td>
                      {item.evidenceId} · row {item.sourceRow}
                    </td>
                    <td>{item.observedQuantity}</td>
                    <td>{item.calculatedQuantity ?? 'Unavailable'}</td>
                    <td>{item.difference ?? 'Unavailable'}</td>
                    <td>{item.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!detail.result.reconciliations.length && (
            <p>No statement observations were selected for comparison.</p>
          )}
          {visible <
            Math.max(
              detail.result.positions.length,
              detail.result.reconciliations.length,
            ) && (
            <Button
              variant="quiet"
              onClick={() => setVisible((count) => count + 20)}
            >
              Show more positions
            </Button>
          )}
          <details>
            <summary>Frozen inputs and calculation provenance</summary>
            <pre className="finance-provenance">
              {JSON.stringify(
                {
                  id: detail.id,
                  inputSnapshot: detail.inputSnapshot,
                  calculations: detail.result.calculations,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
      )}
    </section>
  );
}
