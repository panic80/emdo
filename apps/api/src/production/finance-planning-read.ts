import {
  FinanceBudgetListSchema,
  FinanceBudgetRevisionSchema,
  FinanceBudgetVsActualsSchema,
  FinanceForecastListSchema,
  FinanceForecastSnapshotSchema,
  FinancePlanningAutomationResultSchema,
  type WorkspaceContext,
} from '@emdo/contracts';
import type { FinancePlanningRouteService } from '../routes/finance-planning.js';

export type FinancePlanningReadPort = Pick<
  FinancePlanningRouteService,
  | 'listBudgets'
  | 'getBudget'
  | 'budgetVsActuals'
  | 'listForecasts'
  | 'getForecast'
  | 'getAutomationResult'
>;

export const planningReadViews = new Set([
  'budgets',
  'budget',
  'budget-vs-actuals',
  'forecasts',
  'forecast',
  'planning-result',
]);

/** The model receives saved inputs and deterministic results, never a write port. */
export async function readFinancePlanning(
  reader: FinancePlanningReadPort,
  context: WorkspaceContext,
  input: {
    view: string;
    bookId: string;
    budgetId?: string | null;
    forecastId?: string | null;
    planningResultId?: string | null;
    planningRevision?: number | null;
    offset: number;
    limit: number;
  },
): Promise<{
  records: Record<string, unknown>[];
  currency: string | null;
  repositoryPage?: { nextOffset: number | null };
}> {
  const checkScope = (record: { workspaceId: string; bookId: string }) => {
    if (
      record.workspaceId !== context.workspaceId ||
      record.bookId !== input.bookId
    )
      throw new Error('api-finance-planning-scope-invalid');
  };
  if (input.view === 'budgets' || input.view === 'forecasts') {
    const result =
      input.view === 'budgets'
        ? FinanceBudgetListSchema.parse(
            await reader.listBudgets(
              context,
              input.bookId,
              input.offset,
              input.limit,
            ),
          )
        : FinanceForecastListSchema.parse(
            await reader.listForecasts(
              context,
              input.bookId,
              input.offset,
              input.limit,
            ),
          );
    const items = 'budgets' in result ? result.budgets : result.forecasts;
    const records = items.map((item) => {
      checkScope(item);
      const { createdBy: _createdBy, ...fields } = item;
      void _createdBy;
      return {
        ...fields,
        id:
          'budgetId' in item && !('forecastId' in item)
            ? item.budgetId
            : (item as { forecastId: string }).forecastId,
      };
    });
    const currencies = new Set(items.map((item) => item.functionalCurrency));
    if (currencies.size > 1)
      throw new Error('api-finance-planning-currency-invalid');
    return {
      records,
      currency: items[0]?.functionalCurrency ?? null,
      repositoryPage: { nextOffset: result.nextOffset },
    };
  }
  if (input.view === 'planning-result') {
    const raw = await reader.getAutomationResult(
      context,
      input.bookId,
      input.planningResultId!,
    );
    if (!raw) throw new Error('api-finance-planning-unavailable');
    const result = FinancePlanningAutomationResultSchema.parse(raw);
    checkScope(result);
    if (result.id !== input.planningResultId)
      throw new Error('api-finance-planning-identity-invalid');

    const lineage = result.sourceLineage;
    const metadata = {
      resultId: result.id,
      workspaceId: result.workspaceId,
      bookId: result.bookId,
      automationRunId: result.automationRunId,
      schemaVersion: result.schemaVersion,
      capability: result.capability,
      budgetId: result.budgetId,
      budgetRevision: result.budgetRevision,
      snapshotAt: result.snapshotAt,
      sourceHash: result.sourceHash,
      sourceLineage: lineage,
    };
    const sourceRecords = lineage.sourceJournals.map((journal) => ({
      ...metadata,
      ...journal,
      id: `${result.id}:journal:${journal.journalId}`,
      recordType: 'planning-result-source-journal',
    }));

    if ('rows' in result.payload) {
      const { rows, ...header } = result.payload;
      const seen = new Set<string>();
      if (
        rows.some((row) => {
          const key = `${row.periodId}:${row.accountId}:${row.currency}`;
          if (
            row.currency !== result.payload.functionalCurrency ||
            seen.has(key)
          )
            return true;
          seen.add(key);
          return false;
        })
      )
        throw new Error('api-finance-planning-line-invalid');
      const summary = {
        ...metadata,
        ...header,
        id: result.id,
        recordType: 'planning-result-budget-vs-actuals',
        rowCount: rows.length,
        sourceJournalCount: sourceRecords.length,
      };
      const records = [
        summary,
        ...rows.map((row) => ({
          ...metadata,
          ...header,
          ...row,
          id: `${result.id}:row:${row.periodId}:${row.accountId}:${row.currency}`,
          recordType: 'planning-result-budget-actual-row',
        })),
        ...sourceRecords,
      ];
      return {
        records,
        currency: result.payload.functionalCurrency,
      };
    }

    const {
      lines,
      assumptions,
      createdBy: _createdBy,
      openingBalance,
      ...header
    } = result.payload;
    void _createdBy;
    const safeOpening =
      openingBalance.status === 'available'
        ? {
            status: openingBalance.status,
            currency: openingBalance.currency,
            amount: openingBalance.amount,
            sourceReference: openingBalance.sourceReference,
            reviewedAt: openingBalance.reviewedAt,
          }
        : openingBalance;
    const summary = {
      ...metadata,
      ...header,
      id: result.id,
      recordType: 'planning-result-forecast',
      openingBalance: safeOpening,
      rowCount: lines.length,
      assumptionCount: assumptions.length,
      sourceJournalCount: sourceRecords.length,
    };
    const lineIds = new Set<string>();
    if (
      lines.some((line) => {
        const key = `${line.periodId}:${line.accountId}:${line.currency}`;
        if (
          line.currency !== result.payload.functionalCurrency ||
          lineIds.has(key)
        )
          return true;
        lineIds.add(key);
        return false;
      })
    )
      throw new Error('api-finance-planning-line-invalid');
    const assumptionIds = new Set<string>();
    if (
      assumptions.some((assumption) => {
        const key = `${assumption.periodId}:${assumption.accountId}:${assumption.currency}`;
        if (
          assumption.forecastId !== result.id ||
          assumption.revision !== header.revision ||
          assumption.currency !== result.payload.functionalCurrency ||
          assumptionIds.has(key)
        )
          return true;
        assumptionIds.add(key);
        return false;
      })
    )
      throw new Error('api-finance-planning-assumption-invalid');
    const records = [
      summary,
      ...lines.map((line) => ({
        ...metadata,
        ...header,
        ...line,
        id: `${result.id}:line:${line.periodId}:${line.accountId}:${line.currency}`,
        recordType: 'planning-result-forecast-line',
      })),
      ...assumptions.map(({ reviewedBy: _reviewedBy, ...assumption }) => {
        void _reviewedBy;
        return {
          ...metadata,
          ...header,
          ...assumption,
          id: `${result.id}:assumption:${assumption.periodId}:${assumption.accountId}:${assumption.currency}`,
          recordType: 'planning-result-forecast-assumption',
        };
      }),
      ...sourceRecords,
    ];
    return {
      records,
      currency: result.payload.functionalCurrency,
    };
  }
  const revision = input.planningRevision ?? undefined;
  if (input.view === 'budget') {
    const raw = await reader.getBudget(
      context,
      input.bookId,
      input.budgetId!,
      revision,
    );
    if (!raw) throw new Error('api-finance-planning-unavailable');
    const result = FinanceBudgetRevisionSchema.parse(raw);
    checkScope(result);
    if (
      result.budgetId !== input.budgetId ||
      (revision !== undefined && result.revision !== revision)
    )
      throw new Error('api-finance-planning-identity-invalid');
    const { lines, createdBy: _createdBy, ...header } = result;
    void _createdBy;
    const seen = new Set<string>();
    const records = lines.map((line) => {
      const id = `${line.periodId}:${line.accountId}:${line.currency}`;
      if (
        line.budgetId !== result.budgetId ||
        line.revision !== result.revision ||
        line.currency !== result.functionalCurrency ||
        seen.has(id)
      )
        throw new Error('api-finance-planning-line-invalid');
      seen.add(id);
      return { ...header, ...line, id, recordType: 'budget-line' };
    });
    return { records, currency: result.functionalCurrency };
  }
  if (input.view === 'budget-vs-actuals') {
    const result = FinanceBudgetVsActualsSchema.parse(
      await reader.budgetVsActuals(
        context,
        input.bookId,
        input.budgetId!,
        revision,
      ),
    );
    checkScope(result);
    if (
      result.budgetId !== input.budgetId ||
      (revision !== undefined && result.budgetRevision !== revision)
    )
      throw new Error('api-finance-planning-identity-invalid');
    const { rows, ...header } = result;
    const seen = new Set<string>();
    const records = rows.map((row) => {
      const id = `${row.periodId}:${row.accountId}:${row.currency}`;
      if (row.currency !== result.functionalCurrency || seen.has(id))
        throw new Error('api-finance-planning-line-invalid');
      seen.add(id);
      return { ...header, ...row, id, recordType: 'budget-actual-line' };
    });
    return {
      records: [
        {
          ...header,
          id: result.budgetId,
          recordType: 'budget-actual-snapshot',
          rowCount: rows.length,
        },
        ...records,
      ],
      currency: result.functionalCurrency,
    };
  }
  if (input.view !== 'forecast')
    throw new Error('api-finance-planning-view-invalid');
  const raw = await reader.getForecast(
    context,
    input.bookId,
    input.forecastId!,
    revision,
  );
  if (!raw) throw new Error('api-finance-planning-unavailable');
  const result = FinanceForecastSnapshotSchema.parse(raw);
  checkScope(result);
  if (
    result.forecastId !== input.forecastId ||
    (revision !== undefined && result.revision !== revision)
  )
    throw new Error('api-finance-planning-identity-invalid');
  const {
    lines,
    assumptions,
    createdBy: _createdBy,
    openingBalance,
    ...header
  } = result;
  void _createdBy;
  const safeOpening =
    openingBalance.status === 'available'
      ? {
          status: openingBalance.status,
          currency: openingBalance.currency,
          amount: openingBalance.amount,
          sourceReference: openingBalance.sourceReference,
          reviewedAt: openingBalance.reviewedAt,
        }
      : openingBalance;
  const records: Record<string, unknown>[] = [
    {
      ...header,
      id: result.forecastId,
      recordType: 'forecast-snapshot',
      openingBalance: safeOpening,
    },
  ];
  const seen = new Set<string>();
  for (const line of lines) {
    const id = `${line.periodId}:${line.accountId}:${line.currency}`;
    if (line.currency !== result.functionalCurrency || seen.has(id))
      throw new Error('api-finance-planning-line-invalid');
    seen.add(id);
    records.push({ ...header, ...line, id, recordType: 'forecast-line' });
  }
  const assumptionIds = new Set<string>();
  for (const assumption of assumptions) {
    const id = `assumption:${assumption.periodId}:${assumption.accountId}:${assumption.currency}`;
    if (
      assumption.forecastId !== result.forecastId ||
      assumption.revision !== result.revision ||
      assumption.currency !== result.functionalCurrency ||
      assumptionIds.has(id)
    )
      throw new Error('api-finance-planning-line-invalid');
    assumptionIds.add(id);
    const { reviewedBy: _reviewedBy, ...fields } = assumption;
    void _reviewedBy;
    records.push({
      ...header,
      ...fields,
      id,
      recordType: 'forecast-assumption',
    });
  }
  return { records, currency: result.functionalCurrency };
}
