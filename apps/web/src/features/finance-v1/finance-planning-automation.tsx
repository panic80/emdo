import { useEffect, useRef, useState } from 'react';
import type {
  FinanceAutomationGrant,
  FinanceAutomationPlanningIntent,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { Icon } from '../../components/icon.js';
import {
  enqueuePlanningRun,
  FinancePlanningRequestError,
  planningIntentFromBudget,
  planningIntentFromForecast,
  readPlanningBudget,
  readPlanningCatalog,
  readPlanningForecast,
  readPlanningResult,
  readPlanningRuns,
  type FinancePlanningBudget,
  type FinancePlanningForecast,
  type FinancePlanningResult,
  type FinancePlanningRunRecord,
} from './finance-planning-api.js';
import {
  FinanceSchedules,
  type PlanningScheduleOption,
} from './finance-schedules.js';

type PlanningMode = 'budget-vs-actuals' | 'forecast';

const capabilityLabel: Record<PlanningMode, string> = {
  'budget-vs-actuals': 'Budget versus actuals',
  forecast: 'Reviewed forecast',
};

const planningCapability = (
  mode: PlanningMode,
): 'finance.planning.budget-vs-actuals' | 'finance.planning.forecast' =>
  mode === 'forecast'
    ? 'finance.planning.forecast'
    : 'finance.planning.budget-vs-actuals';

function amount(value: string, currency: string) {
  return `${value} ${currency}`;
}

function formatDate(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
        timestamp,
      )
    : value;
}

function runLabel(run: FinancePlanningRunRecord) {
  const intent = run.run.request.planning;
  return intent
    ? `${capabilityLabel[intent.capability === 'finance.planning.forecast' ? 'forecast' : 'budget-vs-actuals']} · budget revision ${intent.budgetRevision}`
    : 'Planning run';
}

export function FinancePlanningAutomation({
  bookId,
  bookName,
  grants,
  csrfToken,
}: {
  bookId: string;
  bookName: string;
  grants: FinanceAutomationGrant[] | undefined;
  csrfToken?: string;
}) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<{
    budgets: FinancePlanningBudget[];
    forecasts: FinancePlanningForecast[];
  }>();
  const [runs, setRuns] = useState<FinancePlanningRunRecord[]>([]);
  const [mode, setMode] = useState<PlanningMode>('budget-vs-actuals');
  const [budgetId, setBudgetId] = useState('');
  const [forecastId, setForecastId] = useState('');
  const [intent, setIntent] = useState<FinanceAutomationPlanningIntent>();
  const [selectedResult, setSelectedResult] = useState<FinancePlanningResult>();
  const [busy, setBusy] = useState<
    'catalog' | 'detail' | 'run' | 'result' | undefined
  >();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedRunId, setSelectedRunId] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false);
  const idempotencyKeys = useRef(new Map<string, string>());

  const planningGrants = (grants ?? []).filter(
    (grant) =>
      grant.status === 'active' &&
      Date.parse(grant.expiresAt) > Date.now() &&
      grant.allowedCapabilities.some(
        (capability) =>
          capability === 'finance.planning.budget-vs-actuals' ||
          capability === 'finance.planning.forecast',
      ),
  );
  const budgetGrant = planningGrants.find((grant) =>
    grant.allowedCapabilities.includes('finance.planning.budget-vs-actuals'),
  );
  const forecastGrant = planningGrants.find((grant) =>
    grant.allowedCapabilities.includes('finance.planning.forecast'),
  );
  const grant = mode === 'forecast' ? forecastGrant : budgetGrant;
  const planningScheduleOptions: PlanningScheduleOption[] = catalog
    ? [
        ...catalog.budgets.map((budget) => ({
          id: `budget:${budget.budgetId}:${budget.revision}`,
          label: `${budget.name} · budget revision ${budget.revision} · budget versus actuals`,
          capability: 'finance.planning.budget-vs-actuals' as const,
        })),
        ...catalog.forecasts.map((forecast) => ({
          id: `forecast:${forecast.forecastId}:${forecast.revision}`,
          label: `As of ${forecast.asOf} · forecast revision ${forecast.revision} · budget revision ${forecast.budgetRevision}`,
          capability: 'finance.planning.forecast' as const,
        })),
      ]
    : [];

  async function resolvePlanningScheduleIntent(
    option: PlanningScheduleOption,
  ): Promise<FinanceAutomationPlanningIntent> {
    const signal = new AbortController();
    try {
      if (option.capability === 'finance.planning.budget-vs-actuals') {
        const summary = catalog?.budgets.find(
          (value) => option.id === `budget:${value.budgetId}:${value.revision}`,
        );
        if (!summary)
          throw new Error('The selected budget revision is unavailable.');
        return planningIntentFromBudget(
          await readPlanningBudget(
            bookId,
            summary.budgetId,
            summary.revision,
            signal.signal,
          ),
        );
      }
      const summary = catalog?.forecasts.find(
        (value) =>
          option.id === `forecast:${value.forecastId}:${value.revision}`,
      );
      if (!summary)
        throw new Error('The selected reviewed forecast is unavailable.');
      const forecast = await readPlanningForecast(
        bookId,
        summary.forecastId,
        summary.revision,
        signal.signal,
      );
      return planningIntentFromForecast(
        await readPlanningBudget(
          bookId,
          forecast.budgetId,
          forecast.budgetRevision,
          signal.signal,
        ),
        forecast,
      );
    } finally {
      signal.abort();
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  async function load() {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy('catalog');
    setError('');
    setNotice('');
    setSelectedResult(undefined);
    try {
      const [catalogResult, runResult] = await Promise.all([
        readPlanningCatalog(bookId, current.signal),
        readPlanningRuns(bookId, 0, current.signal),
      ]);
      if (!mounted.current || current.signal.aborted) return;
      setCatalog(catalogResult);
      setRuns(runResult.runs);
      const firstBudget = catalogResult.budgets[0];
      if (firstBudget) {
        setBudgetId(firstBudget.budgetId);
        await selectBudget(firstBudget, current.signal);
      } else {
        setBudgetId('');
        setIntent(undefined);
      }
      setOpen(true);
    } catch (cause) {
      if (mounted.current && !current.signal.aborted)
        setError(
          cause instanceof FinancePlanningRequestError
            ? cause.message
            : 'Unable to load normalized budgets and reviewed forecasts. Refresh and try again.',
        );
    } finally {
      if (mounted.current && !current.signal.aborted) setBusy(undefined);
    }
  }

  async function selectBudget(
    selected: FinancePlanningBudget,
    signal?: AbortSignal,
  ) {
    const current = signal ?? new AbortController().signal;
    setBusy('detail');
    setError('');
    try {
      const detail = await readPlanningBudget(
        bookId,
        selected.budgetId,
        selected.revision,
        current,
      );
      if (!mounted.current || current.aborted) return;
      setIntent(planningIntentFromBudget(detail));
      setSelectedResult(undefined);
    } catch (cause) {
      if (mounted.current && !current.aborted)
        setError(
          cause instanceof FinancePlanningRequestError
            ? cause.message
            : 'Unable to read the selected budget revision.',
        );
    } finally {
      if (mounted.current && !current.aborted) setBusy(undefined);
    }
  }

  async function selectForecast(selected: FinancePlanningForecast) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy('detail');
    setError('');
    try {
      const forecast = await readPlanningForecast(
        bookId,
        selected.forecastId,
        selected.revision,
        current.signal,
      );
      const budget = await readPlanningBudget(
        bookId,
        forecast.budgetId,
        forecast.budgetRevision,
        current.signal,
      );
      if (!mounted.current || current.signal.aborted) return;
      setBudgetId(budget.budgetId);
      setIntent(planningIntentFromForecast(budget, forecast));
      setSelectedResult(undefined);
    } catch (cause) {
      if (mounted.current && !current.signal.aborted)
        setError(
          cause instanceof FinancePlanningRequestError
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : 'Unable to read the selected reviewed forecast.',
        );
    } finally {
      if (mounted.current && !current.signal.aborted) setBusy(undefined);
    }
  }

  async function run() {
    if (!grant || !intent || !csrfToken) return;
    if (intent.itemCount > grant.limits.maxItemsPerRun) {
      setError(
        `The selected revision contains ${intent.itemCount} items, above this grant's per-run limit of ${grant.limits.maxItemsPerRun}.`,
      );
      return;
    }
    const keyInput = JSON.stringify({ grant: grant.id, intent });
    const key = idempotencyKeys.current.get(keyInput) ?? crypto.randomUUID();
    idempotencyKeys.current.set(keyInput, key);
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy('run');
    setError('');
    setNotice('');
    try {
      const result = await enqueuePlanningRun(
        bookId,
        grant,
        intent,
        csrfToken,
        key,
        current.signal,
      );
      if (!mounted.current || current.signal.aborted) return;
      idempotencyKeys.current.delete(keyInput);
      setRuns((previous) => [
        result,
        ...previous.filter(
          (value) =>
            value.run.request.operationId !== result.run.request.operationId,
        ),
      ]);
      setSelectedRunId(result.run.request.operationId);
      setNotice(
        result.run.status === 'completed'
          ? 'Planning run completed. Open the immutable saved result below.'
          : 'Planning run queued. Refresh run history to see its saved result.',
      );
      if (result.run.status === 'completed' && result.run.outcomeReference)
        await openResult(result.run.outcomeReference, current.signal);
    } catch (cause) {
      if (mounted.current && !current.signal.aborted)
        setError(
          cause instanceof FinancePlanningRequestError
            ? cause.message
            : 'The planning run could not be confirmed. Retry with the same request.',
        );
    } finally {
      if (mounted.current && !current.signal.aborted) setBusy(undefined);
    }
  }

  async function openResult(resultId: string, signal?: AbortSignal) {
    const current = signal ?? new AbortController().signal;
    setBusy('result');
    setError('');
    try {
      const result = await readPlanningResult(bookId, resultId, current);
      if (!mounted.current || current.aborted) return;
      setSelectedResult(result);
    } catch (cause) {
      if (mounted.current && !current.aborted)
        setError(
          cause instanceof FinancePlanningRequestError
            ? cause.message
            : 'Unable to open the immutable saved planning result.',
        );
    } finally {
      if (mounted.current && !current.aborted) setBusy(undefined);
    }
  }

  if (!open)
    return (
      <section
        className="finance-planning-automation"
        aria-label="Planning automations"
      >
        <div className="finance-automations__heading">
          <div>
            <span className="finance-automations__eyebrow">
              Normalized planning
            </span>
            <h2>Planning workflows</h2>
            <p>
              Run deterministic budget and forecast work against {bookName}’s
              reviewed revisions.
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={busy !== undefined || grants === undefined}
            onClick={() => void load()}
          >
            <Icon name="activity" size={16} />
            Open planning workflows
          </Button>
        </div>
        {grants !== undefined && planningGrants.length === 0 && (
          <p className="finance-planning-automation__muted">
            An active planning grant is required to run or schedule a workflow.
            You can still review normalized planning from the Planning section.
          </p>
        )}
      </section>
    );

  const summaries = selectedResult
    ? 'rows' in selectedResult.payload
      ? selectedResult.payload.rows
      : selectedResult.payload.lines
    : [];

  return (
    <section
      className="finance-planning-automation"
      aria-label="Planning automations"
    >
      <div className="finance-automations__heading">
        <div>
          <span className="finance-automations__eyebrow">
            Normalized planning
          </span>
          <h2>Planning workflows</h2>
          <p>
            Every run binds to one immutable budget revision and reviewed
            forecast inputs. EMDO stores the result for drilldown.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={busy !== undefined}
          onClick={() => void load()}
        >
          <Icon name="sync" size={16} />
          Refresh planning
        </Button>
      </div>
      {error && (
        <p className="finance-automations__feedback" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="finance-automations__feedback" role="status">
          {notice}
        </p>
      )}
      <div className="finance-planning-automation__grid">
        <form
          className="finance-planning-automation__form"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <div className="finance-panel-heading">
            <div>
              <h3>Run a planning workflow</h3>
              <p>Only saved revisions and reviewed inputs can be selected.</p>
            </div>
            <span className="finance-status">Deterministic</span>
          </div>
          <label>
            Workflow
            <select
              value={mode}
              onChange={(event) => {
                const next = event.target.value as PlanningMode;
                setMode(next);
                setSelectedResult(undefined);
                setIntent(undefined);
              }}
              disabled={busy !== undefined}
            >
              <option value="budget-vs-actuals">Budget versus actuals</option>
              <option value="forecast">Reviewed forecast</option>
            </select>
          </label>
          <label>
            Budget revision
            <select
              value={budgetId}
              onChange={(event) => {
                const selected = catalog?.budgets.find(
                  (value) => value.budgetId === event.target.value,
                );
                setBudgetId(event.target.value);
                if (selected && mode === 'budget-vs-actuals')
                  void selectBudget(selected);
              }}
              disabled={busy !== undefined || !catalog?.budgets.length}
              required
            >
              <option value="">Choose a budget revision</option>
              {(catalog?.budgets ?? []).map((budget) => (
                <option
                  key={`${budget.budgetId}:${budget.revision}`}
                  value={budget.budgetId}
                >
                  {budget.name} · revision {budget.revision} ·{' '}
                  {budget.functionalCurrency}
                </option>
              ))}
            </select>
          </label>
          {mode === 'forecast' && (
            <label>
              Reviewed forecast
              <select
                value={forecastId}
                onChange={(event) => {
                  const selected = catalog?.forecasts.find(
                    (value) => value.forecastId === event.target.value,
                  );
                  setForecastId(event.target.value);
                  if (selected) void selectForecast(selected);
                }}
                disabled={busy !== undefined || !catalog?.forecasts.length}
                required
              >
                <option value="">Choose a reviewed forecast</option>
                {(catalog?.forecasts ?? []).map((forecast) => (
                  <option
                    key={`${forecast.forecastId}:${forecast.revision}`}
                    value={forecast.forecastId}
                  >
                    As of {forecast.asOf} · revision {forecast.revision} ·
                    budget revision {forecast.budgetRevision}
                  </option>
                ))}
              </select>
            </label>
          )}
          {intent && (
            <dl className="finance-planning-automation__facts">
              <div>
                <dt>Capability</dt>
                <dd>
                  {
                    capabilityLabel[
                      intent.capability === 'finance.planning.forecast'
                        ? 'forecast'
                        : 'budget-vs-actuals'
                    ]
                  }
                </dd>
              </div>
              <div>
                <dt>Budget revision</dt>
                <dd>{intent.budgetRevision}</dd>
              </div>
              <div>
                <dt>Items</dt>
                <dd>{intent.itemCount}</dd>
              </div>
              <div>
                <dt>Currency</dt>
                <dd>{intent.currency}</dd>
              </div>
              <div>
                <dt>As of</dt>
                <dd>{intent.asOf ?? 'All budget periods'}</dd>
              </div>
              {intent.capability === 'finance.planning.forecast' && (
                <>
                  <div>
                    <dt>Opening balance</dt>
                    <dd>
                      {intent.openingBalance.status === 'available'
                        ? amount(
                            intent.openingBalance.amount,
                            intent.openingBalance.currency,
                          )
                        : 'Unavailable — review required'}
                    </dd>
                  </div>
                  <div>
                    <dt>Reviewed assumptions</dt>
                    <dd>{intent.assumptions.length}</dd>
                  </div>
                </>
              )}
            </dl>
          )}
          {!grant && (
            <p className="finance-planning-automation__muted">
              An active {mode === 'forecast' ? 'forecast' : 'budget'} planning
              grant is required to run this workflow.
            </p>
          )}
          <Button
            type="submit"
            busy={busy === 'run'}
            disabled={!grant || !intent || !csrfToken || busy !== undefined}
          >
            Run {mode === 'forecast' ? 'forecast' : 'budget versus actuals'}
          </Button>
        </form>
        <div className="finance-planning-automation__history">
          <div className="finance-panel-heading">
            <div>
              <h3>Saved planning results</h3>
              <p>
                Open a completed result to inspect rows and evidence lineage.
              </p>
            </div>
            <span className="finance-status">{runs.length}</span>
          </div>
          {runs.length === 0 ? (
            <p className="finance-planning-automation__muted">
              No planning runs have been saved for this book.
            </p>
          ) : (
            <ul className="finance-planning-automation__runs">
              {runs.map((run) => (
                <li
                  key={run.run.request.operationId}
                  className={
                    selectedRunId === run.run.request.operationId
                      ? 'is-selected'
                      : undefined
                  }
                >
                  <div>
                    <strong>{runLabel(run)}</strong>
                    <span>
                      {run.run.status} · {formatDate(run.createdAt)}
                    </span>
                  </div>
                  {run.run.status === 'completed' &&
                  run.run.outcomeReference ? (
                    <Button
                      variant="quiet"
                      disabled={busy !== undefined}
                      onClick={() => {
                        setSelectedRunId(run.run.request.operationId);
                        void openResult(run.run.outcomeReference!);
                      }}
                    >
                      Open result
                    </Button>
                  ) : (
                    <span className="finance-planning-automation__run-state">
                      Waiting for saved output
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {catalog && (
        <FinanceSchedules
          bookId={bookId}
          grants={grants}
          planningOnly
          planningOptions={planningScheduleOptions}
          resolvePlanningIntent={resolvePlanningScheduleIntent}
          {...(csrfToken ? { csrfToken } : {})}
        />
      )}
      {selectedResult && (
        <article
          className="finance-planning-automation__result"
          aria-labelledby="planning-result-heading"
        >
          <div className="finance-panel-heading">
            <div>
              <h3 id="planning-result-heading">Saved result</h3>
              <p>
                {selectedResult.capability === 'finance.planning.forecast'
                  ? 'Reviewed forecast'
                  : 'Budget versus actuals'}{' '}
                · snapshot {formatDate(selectedResult.snapshotAt)}
              </p>
            </div>
            <Button
              variant="quiet"
              onClick={() => setSelectedResult(undefined)}
            >
              Close result
            </Button>
          </div>
          <dl className="finance-planning-automation__result-meta">
            <div>
              <dt>Result</dt>
              <dd>{selectedResult.id}</dd>
            </div>
            <div>
              <dt>Budget revision</dt>
              <dd>{selectedResult.budgetRevision}</dd>
            </div>
            <div>
              <dt>Functional currency</dt>
              <dd>{selectedResult.payload.functionalCurrency}</dd>
            </div>
            <div>
              <dt>Source journals</dt>
              <dd>{selectedResult.sourceLineage.sourceJournals.length}</dd>
            </div>
            <div>
              <dt>Source hash</dt>
              <dd>{selectedResult.sourceHash}</dd>
            </div>
          </dl>
          <div className="finance-table-scroll" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col">Account</th>
                  <th scope="col">Budget</th>
                  <th scope="col">Actual / forecast</th>
                  <th scope="col">Variance / basis</th>
                </tr>
              </thead>
              <tbody>
                {summaries.slice(0, 100).map((row) => (
                  <tr key={`${row.periodId}:${row.accountId}`}>
                    <th scope="row">
                      {row.periodStart} — {row.periodEnd}
                    </th>
                    <td>{row.accountId}</td>
                    <td>{amount(row.budgetAmount, row.currency)}</td>
                    <td>
                      {'basis' in row
                        ? row.forecastAmount === null
                          ? (row.label ?? 'Unavailable')
                          : amount(row.forecastAmount, row.currency)
                        : amount(row.postedActualAmount, row.currency)}
                    </td>
                    <td>
                      {'basis' in row
                        ? row.basis
                        : amount(row.varianceAmount, row.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {summaries.length > 100 && (
            <p className="finance-caption">
              Showing the first 100 of {summaries.length} saved rows. Use the
              export/read API for the complete immutable result.
            </p>
          )}
          <details className="finance-planning-automation__lineage">
            <summary>Evidence and review lineage</summary>
            <p>
              Canonical intent hash:{' '}
              {selectedResult.sourceLineage.canonicalIntentHash}
            </p>
            <p>
              Reviewed input count:{' '}
              {selectedResult.sourceLineage.review.itemCount}
            </p>
            <p>
              Reviewed forecast:{' '}
              {selectedResult.sourceLineage.review.reviewForecastId ??
                'Not applicable'}
            </p>
          </details>
        </article>
      )}
      {busy === 'catalog' && (
        <p role="status">Loading normalized planning records…</p>
      )}
      {busy === 'detail' && <p role="status">Reading the selected revision…</p>}
      {busy === 'result' && (
        <p role="status">Opening the immutable saved result…</p>
      )}
      <p className="finance-caption">
        Planning capability: {planningCapability(mode)}. Amounts and variances
        are read from the authoritative saved result; this screen does not
        calculate them.
      </p>
    </section>
  );
}
