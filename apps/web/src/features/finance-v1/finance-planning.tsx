import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/button.js';
import { Icon } from '../../components/icon.js';
import {
  FinancePlanningRequestError,
  readBudgetVsActuals,
  readPlanningBudget,
  readPlanningCatalog,
  readPlanningForecast,
  type FinancePlanningBudget,
  type FinancePlanningForecast,
} from './finance-planning-api.js';
import type {
  FinanceBudgetRevision,
  FinanceBudgetVsActuals,
  FinanceForecastSnapshot,
} from '@emdo/contracts/browser';

type SelectedRecord =
  | { kind: 'budget'; summary: FinancePlanningBudget }
  | { kind: 'forecast'; summary: FinancePlanningForecast };

const money = (value: string, currency: string) => `${value} ${currency}`;

/** Read-only normalized planning workspace for one accounting book. */
export function FinancePlanning({
  bookId,
  bookName,
}: {
  bookId: string;
  bookName: string;
}) {
  const [catalog, setCatalog] = useState<{
    budgets: FinancePlanningBudget[];
    forecasts: FinancePlanningForecast[];
  }>();
  const [selected, setSelected] = useState<SelectedRecord>();
  const [budget, setBudget] = useState<FinanceBudgetRevision>();
  const [actuals, setActuals] = useState<FinanceBudgetVsActuals>();
  const [forecast, setForecast] = useState<FinanceForecastSnapshot>();
  const [busy, setBusy] = useState<'catalog' | 'detail' | undefined>();
  const [error, setError] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [bookId]);

  async function load() {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy('catalog');
    setError('');
    setSelected(undefined);
    setBudget(undefined);
    setActuals(undefined);
    setForecast(undefined);
    try {
      const result = await readPlanningCatalog(bookId, current.signal);
      if (!mounted.current || current.signal.aborted) return;
      setCatalog(result);
    } catch (cause) {
      if (mounted.current && !current.signal.aborted)
        setError(
          cause instanceof FinancePlanningRequestError
            ? cause.message
            : 'Unable to load normalized planning records. Refresh and try again.',
        );
    } finally {
      if (mounted.current && !current.signal.aborted) setBusy(undefined);
    }
  }

  async function openBudget(summary: FinancePlanningBudget) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy('detail');
    setError('');
    setSelected({ kind: 'budget', summary });
    setForecast(undefined);
    try {
      const [detail, budgetActuals] = await Promise.all([
        readPlanningBudget(
          bookId,
          summary.budgetId,
          summary.revision,
          current.signal,
        ),
        readBudgetVsActuals(
          bookId,
          summary.budgetId,
          summary.revision,
          current.signal,
        ),
      ]);
      if (!mounted.current || current.signal.aborted) return;
      setBudget(detail);
      setActuals(budgetActuals);
    } catch (cause) {
      if (mounted.current && !current.signal.aborted)
        setError(
          cause instanceof FinancePlanningRequestError
            ? cause.message
            : 'Unable to open the selected budget revision.',
        );
    } finally {
      if (mounted.current && !current.signal.aborted) setBusy(undefined);
    }
  }

  async function openForecast(summary: FinancePlanningForecast) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy('detail');
    setError('');
    setSelected({ kind: 'forecast', summary });
    setBudget(undefined);
    setActuals(undefined);
    try {
      const detail = await readPlanningForecast(
        bookId,
        summary.forecastId,
        summary.revision,
        current.signal,
      );
      if (!mounted.current || current.signal.aborted) return;
      setForecast(detail);
    } catch (cause) {
      if (mounted.current && !current.signal.aborted)
        setError(
          cause instanceof FinancePlanningRequestError
            ? cause.message
            : 'Unable to open the selected reviewed forecast.',
        );
    } finally {
      if (mounted.current && !current.signal.aborted) setBusy(undefined);
    }
  }

  return (
    <section
      className="finance-normalized-planning"
      aria-label="Normalized book planning"
    >
      <div className="finance-automations__heading">
        <div>
          <span className="finance-automations__eyebrow">
            Book-scoped planning
          </span>
          <h2>Normalized planning</h2>
          <p>
            Review immutable budget revisions and reviewed forecasts for{' '}
            {bookName}. Values are read from this accounting book’s source
            records.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={busy !== undefined}
          onClick={() => void load()}
        >
          <Icon name="sync" size={16} />
          {catalog ? 'Refresh planning' : 'Load planning'}
        </Button>
      </div>
      {error && (
        <p className="finance-automations__feedback" role="alert">
          {error}
        </p>
      )}
      {busy === 'catalog' && (
        <p role="status">Loading normalized planning records…</p>
      )}
      {busy === 'detail' && <p role="status">Opening the selected revision…</p>}
      {catalog && (
        <div className="finance-normalized-planning__layout">
          <aside
            className="finance-normalized-planning__catalog"
            aria-label="Planning revisions"
          >
            <div className="finance-panel-heading">
              <div>
                <h3>Saved revisions</h3>
                <p>
                  {catalog.budgets.length} budgets · {catalog.forecasts.length}{' '}
                  forecasts
                </p>
              </div>
            </div>
            <h4>Budgets</h4>
            {catalog.budgets.length ? (
              <ul>
                {catalog.budgets.map((item) => (
                  <li key={`${item.budgetId}:${item.revision}`}>
                    <button
                      type="button"
                      className={
                        selected?.kind === 'budget' &&
                        selected.summary.budgetId === item.budgetId &&
                        selected.summary.revision === item.revision
                          ? 'is-selected'
                          : undefined
                      }
                      onClick={() => void openBudget(item)}
                    >
                      <strong>{item.name}</strong>
                      <span>
                        Revision {item.revision} · {item.functionalCurrency}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="finance-normalized-planning__muted">
                No normalized budgets saved.
              </p>
            )}
            <h4>Reviewed forecasts</h4>
            {catalog.forecasts.length ? (
              <ul>
                {catalog.forecasts.map((item) => (
                  <li key={`${item.forecastId}:${item.revision}`}>
                    <button
                      type="button"
                      className={
                        selected?.kind === 'forecast' &&
                        selected.summary.forecastId === item.forecastId &&
                        selected.summary.revision === item.revision
                          ? 'is-selected'
                          : undefined
                      }
                      onClick={() => void openForecast(item)}
                    >
                      <strong>As of {item.asOf}</strong>
                      <span>
                        Revision {item.revision} · budget revision{' '}
                        {item.budgetRevision}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="finance-normalized-planning__muted">
                No reviewed forecasts saved.
              </p>
            )}
          </aside>
          <div className="finance-normalized-planning__detail">
            {!selected && (
              <p className="finance-normalized-planning__muted">
                Select a saved revision to inspect its source rows.
              </p>
            )}
            {selected?.kind === 'budget' && budget && actuals && (
              <BudgetDetail budget={budget} actuals={actuals} />
            )}
            {selected?.kind === 'forecast' && forecast && (
              <ForecastDetail forecast={forecast} />
            )}
          </div>
        </div>
      )}
      <p className="finance-caption">
        Planning values remain scoped to {bookName}; automation runs and
        schedules are managed in Automations.
      </p>
    </section>
  );
}

function BudgetDetail({
  budget,
  actuals,
}: {
  budget: FinanceBudgetRevision;
  actuals: FinanceBudgetVsActuals;
}) {
  return (
    <article>
      <div className="finance-panel-heading">
        <div>
          <h3>{budget.name}</h3>
          <p>
            Budget revision {budget.revision} · saved budget lines{' '}
            {budget.lines.length}
          </p>
        </div>
        <span className="finance-status">{budget.functionalCurrency}</span>
      </div>
      <div className="finance-table-scroll" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col">Account</th>
              <th scope="col">Budget</th>
              <th scope="col">Posted actual</th>
              <th scope="col">Variance</th>
            </tr>
          </thead>
          <tbody>
            {actuals.rows.slice(0, 100).map((row) => (
              <tr key={`${row.periodId}:${row.accountId}`}>
                <th scope="row">
                  {row.periodStart} — {row.periodEnd}
                </th>
                <td>{row.accountId}</td>
                <td>{money(row.budgetAmount, row.currency)}</td>
                <td>{money(row.postedActualAmount, row.currency)}</td>
                <td>{money(row.varianceAmount, row.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="finance-caption">
        Snapshot {actuals.snapshotAt} · source journals{' '}
        {actuals.rows.reduce((count, row) => count + row.sourceJournalCount, 0)}{' '}
        across displayed rows. Variances are supplied by the planning service.
      </p>
    </article>
  );
}

function ForecastDetail({ forecast }: { forecast: FinanceForecastSnapshot }) {
  return (
    <article>
      <div className="finance-panel-heading">
        <div>
          <h3>Reviewed forecast</h3>
          <p>
            As of {forecast.asOf} · forecast revision {forecast.revision} ·
            budget revision {forecast.budgetRevision}
          </p>
        </div>
        <span className="finance-status">{forecast.functionalCurrency}</span>
      </div>
      <dl className="finance-normalized-planning__meta">
        <div>
          <dt>Opening balance</dt>
          <dd>
            {forecast.openingBalance.status === 'available'
              ? money(
                  forecast.openingBalance.amount,
                  forecast.openingBalance.currency,
                )
              : 'Unavailable — review required'}
          </dd>
        </div>
        <div>
          <dt>Future assumptions</dt>
          <dd>{forecast.futureAssumptionsStatus}</dd>
        </div>
        <div>
          <dt>Reviewed assumptions</dt>
          <dd>{forecast.assumptions.length}</dd>
        </div>
      </dl>
      <div className="finance-table-scroll" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col">Account</th>
              <th scope="col">Budget</th>
              <th scope="col">Forecast</th>
              <th scope="col">Basis</th>
            </tr>
          </thead>
          <tbody>
            {forecast.lines.slice(0, 100).map((row) => (
              <tr key={`${row.periodId}:${row.accountId}`}>
                <th scope="row">
                  {row.periodStart} — {row.periodEnd}
                </th>
                <td>{row.accountId}</td>
                <td>{money(row.budgetAmount, row.currency)}</td>
                <td>
                  {row.forecastAmount === null
                    ? (row.label ?? 'Unavailable')
                    : money(row.forecastAmount, row.currency)}
                </td>
                <td>{row.basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="finance-caption">
        Snapshot {forecast.snapshotAt} · reviewed inputs only. This screen does
        not infer or calculate future values.
      </p>
    </article>
  );
}
