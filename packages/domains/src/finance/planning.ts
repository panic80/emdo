import {
  FinanceBudgetActualRowSchema,
  FinanceBudgetRevisionSchema,
  FinanceBudgetVsActualsSchema,
  FinanceForecastAssumptionInputSchema,
  FinanceForecastLineSchema,
  FinanceForecastOpeningInputSchema,
  FinanceForecastSnapshotSchema,
  FinancePlanningSignBasisSchema,
  type FinanceBudgetActualRow,
  type FinanceBudgetRevision,
  type FinanceBudgetVsActuals,
  type FinanceForecastAssumptionInput,
  type FinanceForecastOpeningInput,
  type FinanceForecastSnapshot,
} from '@emdo/contracts';

import { formatFinanceDecimal, parseFinanceDecimal } from './decimal.js';

type AccountKind = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

type FinancePlanningLabel =
  'opening-balance-unavailable' | 'future-assumption-unavailable';

export interface FinancePostedLedgerAggregateInput {
  readonly periodId: string;
  readonly accountId: string;
  readonly currency: FinanceBudgetActualRow['currency'];
  readonly accountKind: AccountKind;
  readonly debitAmount: string;
  readonly creditAmount: string;
  readonly journalCount: number;
  readonly lineCount: number;
}

export interface FinanceBudgetPeriodInput {
  readonly periodId: string;
  readonly startsOn: string;
  readonly endsOn: string;
}

export interface DeriveFinanceBudgetVsActualsInput {
  readonly budget: FinanceBudgetRevision;
  readonly periods: readonly FinanceBudgetPeriodInput[];
  readonly postedAggregates: readonly FinancePostedLedgerAggregateInput[];
  readonly snapshotAt: string;
}

export interface BuildFinanceForecastInput {
  readonly budget: FinanceBudgetRevision;
  readonly periods: readonly FinanceBudgetPeriodInput[];
  readonly postedAggregates: readonly FinancePostedLedgerAggregateInput[];
  readonly asOf: string;
  readonly openingBalance: FinanceForecastOpeningInput;
  readonly assumptions: readonly FinanceForecastAssumptionInput[];
  readonly forecastId: string;
  readonly revision: number;
  readonly createdBy: string;
  readonly snapshotAt: string;
}

const signBasisFor = (kind: AccountKind) =>
  kind === 'liability' || kind === 'equity'
    ? ('credit-minus-debit' as const)
    : ('debit-minus-credit' as const);

const signedMovement = (
  debit: string,
  credit: string,
  kind: AccountKind,
): bigint => {
  const d = parseFinanceDecimal(debit);
  const c = parseFinanceDecimal(credit);
  return signBasisFor(kind) === 'credit-minus-debit' ? c - d : d - c;
};

const periodMap = (periods: readonly FinanceBudgetPeriodInput[]) => {
  const map = new Map<string, FinanceBudgetPeriodInput>();
  for (const period of periods) {
    if (map.has(period.periodId))
      throw new Error('finance-planning-period-duplicate');
    if (period.startsOn > period.endsOn)
      throw new Error('finance-planning-period-invalid');
    map.set(period.periodId, period);
  }
  return map;
};

const aggregateMap = (
  aggregates: readonly FinancePostedLedgerAggregateInput[],
  functionalCurrency: FinanceBudgetRevision['functionalCurrency'],
) => {
  const map = new Map<string, FinancePostedLedgerAggregateInput>();
  for (const raw of aggregates) {
    const aggregate = FinanceBudgetActualRowSchema.pick({
      periodId: true,
      accountId: true,
      currency: true,
    })
      .extend({
        accountKind: FinanceBudgetActualRowSchema.shape.accountKind,
        debitAmount: FinanceBudgetActualRowSchema.shape.budgetAmount,
        creditAmount: FinanceBudgetActualRowSchema.shape.budgetAmount,
        journalCount: FinanceBudgetActualRowSchema.shape.sourceJournalCount,
        lineCount: FinanceBudgetActualRowSchema.shape.sourceLineCount,
      })
      .parse(raw);
    if (aggregate.currency !== functionalCurrency)
      throw new Error('finance-planning-currency-mismatch');
    const key = `${aggregate.periodId}:${aggregate.accountId}:${aggregate.currency}`;
    if (map.has(key)) throw new Error('finance-planning-actuals-duplicate');
    map.set(key, aggregate);
  }
  return map;
};

const aggregateFor = (
  aggregates: ReadonlyMap<string, FinancePostedLedgerAggregateInput>,
  line: {
    readonly periodId: string;
    readonly accountId: string;
    readonly currency: string;
  },
) => {
  const aggregate = aggregates.get(budgetKey(line));
  if (!aggregate) throw new Error('finance-planning-account-kind-unavailable');
  return aggregate;
};

const budgetKey = (line: {
  readonly periodId: string;
  readonly accountId: string;
  readonly currency: string;
}) => `${line.periodId}:${line.accountId}:${line.currency}`;

const validateBudgetLineScope = (
  budget: FinanceBudgetRevision,
  periods: ReadonlyMap<string, FinanceBudgetPeriodInput>,
) => {
  const identities = new Set<string>();
  for (const line of budget.lines) {
    if (line.currency !== budget.functionalCurrency)
      throw new Error('finance-planning-currency-mismatch');
    if (!periods.has(line.periodId))
      throw new Error('finance-planning-period-unavailable');
    const key = budgetKey(line);
    if (identities.has(key)) throw new Error('finance-planning-line-duplicate');
    identities.add(key);
  }
};

/**
 * Computes signed actuals directly from one aggregate per period/account.
 * The aggregate is expected to have been produced from posted journal lines;
 * this function never consumes source observations or generated reports.
 */
export const deriveFinanceBudgetVsActuals = (
  input: DeriveFinanceBudgetVsActualsInput,
): FinanceBudgetVsActuals => {
  const budget = FinanceBudgetRevisionSchema.parse(input.budget);
  const periods = periodMap(input.periods);
  validateBudgetLineScope(budget, periods);
  const aggregates = aggregateMap(
    input.postedAggregates,
    budget.functionalCurrency,
  );
  const rows: FinanceBudgetActualRow[] = budget.lines.map((line) => {
    const period = periods.get(line.periodId)!;
    // The repository snapshot starts from every budget line and therefore emits
    // a zero-valued aggregate even when no journal activity exists. A missing
    // aggregate has no authoritative account kind and must stay unavailable.
    const aggregate = aggregateFor(aggregates, line);
    const actual = signedMovement(
      aggregate.debitAmount,
      aggregate.creditAmount,
      aggregate.accountKind,
    );
    const budgetAmount = parseFinanceDecimal(line.amount);
    const basis = signBasisFor(aggregate.accountKind);
    return FinanceBudgetActualRowSchema.parse({
      periodId: line.periodId,
      periodStart: period.startsOn,
      periodEnd: period.endsOn,
      accountId: line.accountId,
      accountKind: aggregate.accountKind,
      currency: line.currency,
      budgetAmount: line.amount,
      postedActualAmount: formatFinanceDecimal(actual),
      varianceAmount: formatFinanceDecimal(actual - budgetAmount),
      actualSignBasis: basis,
      sourceJournalCount: aggregate.journalCount,
      sourceLineCount: aggregate.lineCount,
    });
  });
  return FinanceBudgetVsActualsSchema.parse({
    schemaVersion: 1,
    workspaceId: budget.workspaceId,
    bookId: budget.bookId,
    budgetId: budget.budgetId,
    budgetRevision: budget.revision,
    functionalCurrency: budget.functionalCurrency,
    snapshotAt: input.snapshotAt,
    actualSource: {
      kind: 'authoritative-posted-ledger',
      coverage: 'posted-journals-in-budget-periods',
      signBasis: 'account-kind',
    },
    rows,
  });
};

const openingLabel = (opening: FinanceForecastOpeningInput) =>
  opening.status === 'unavailable'
    ? ('opening-balance-unavailable' as const)
    : undefined;

/**
 * Builds a forecast snapshot from posted actual aggregates and reviewed
 * assumptions. A future line without a matching reviewed assumption remains
 * null and carries an explicit unavailable label; no model estimate is made.
 */
export const buildFinanceForecast = (
  input: BuildFinanceForecastInput,
): FinanceForecastSnapshot => {
  const budget = FinanceBudgetRevisionSchema.parse(input.budget);
  const periods = periodMap(input.periods);
  validateBudgetLineScope(budget, periods);
  const aggregates = aggregateMap(
    input.postedAggregates,
    budget.functionalCurrency,
  );
  const assumptions = input.assumptions.map((assumption) =>
    FinanceForecastAssumptionInputSchema.parse(assumption),
  );
  const assumptionMap = new Map<string, FinanceForecastAssumptionInput>();
  for (const assumption of assumptions) {
    if (assumption.currency !== budget.functionalCurrency)
      throw new Error('finance-planning-currency-mismatch');
    const key = budgetKey(assumption);
    if (assumptionMap.has(key))
      throw new Error('finance-planning-assumption-duplicate');
    if (!budget.lines.some((line) => budgetKey(line) === key))
      throw new Error('finance-planning-assumption-out-of-scope');
    const period = periods.get(assumption.periodId);
    if (!period) throw new Error('finance-planning-period-unavailable');
    if (period.endsOn <= input.asOf)
      throw new Error('finance-planning-assumption-for-posted-period');
    assumptionMap.set(key, assumption);
  }

  let futureCount = 0;
  let futureProvided = 0;
  const labels = new Set<FinancePlanningLabel>();
  const lines = budget.lines.map((line) => {
    const period = periods.get(line.periodId)!;
    // See deriveFinanceBudgetVsActuals: account kind comes from the ledger
    // account join, including zero-activity rows emitted by the snapshot.
    const aggregate = aggregateFor(aggregates, line);
    const postedActual = signedMovement(
      aggregate.debitAmount,
      aggregate.creditAmount,
      aggregate.accountKind,
    );
    const isPostedPeriod = period.endsOn <= input.asOf;
    let forecastAmount: string | null;
    let basis: 'posted-actual' | 'reviewed-assumption' | 'unavailable';
    let label: 'future-assumption-unavailable' | null = null;
    if (isPostedPeriod) {
      forecastAmount = formatFinanceDecimal(postedActual);
      basis = 'posted-actual';
    } else {
      futureCount += 1;
      const assumption = assumptionMap.get(budgetKey(line));
      if (assumption) {
        forecastAmount = assumption.amount;
        basis = 'reviewed-assumption';
        futureProvided += 1;
      } else {
        forecastAmount = null;
        basis = 'unavailable';
        label = 'future-assumption-unavailable';
        labels.add(label);
      }
    }
    const signBasis = signBasisFor(aggregate.accountKind);
    return FinanceForecastLineSchema.parse({
      periodId: line.periodId,
      periodStart: period.startsOn,
      periodEnd: period.endsOn,
      accountId: line.accountId,
      accountKind: aggregate.accountKind,
      currency: line.currency,
      budgetAmount: line.amount,
      postedActualAmount: formatFinanceDecimal(postedActual),
      forecastAmount,
      basis,
      actualSignBasis: signBasis,
      label,
    });
  });
  const opening = FinanceForecastOpeningInputSchema.parse(input.openingBalance);
  const openingUnavailable = openingLabel(opening);
  if (openingUnavailable) labels.add(openingUnavailable);
  const futureAssumptionsStatus =
    futureCount === 0
      ? 'not-applicable'
      : futureProvided === 0
        ? 'unavailable'
        : futureProvided === futureCount
          ? 'provided'
          : 'partial';
  return FinanceForecastSnapshotSchema.parse({
    schemaVersion: 1,
    workspaceId: budget.workspaceId,
    bookId: budget.bookId,
    forecastId: input.forecastId,
    revision: input.revision,
    budgetId: budget.budgetId,
    budgetRevision: budget.revision,
    functionalCurrency: budget.functionalCurrency,
    asOf: input.asOf,
    snapshotAt: input.snapshotAt,
    openingBalance: opening,
    futureAssumptionsStatus,
    labels: [...labels],
    actualSource: {
      kind: 'authoritative-posted-ledger',
      coverage: 'posted-journals-through-as-of',
      signBasis: 'account-kind',
    },
    assumptionsSource: 'reviewed-inputs-only',
    createdBy: input.createdBy,
    createdAt: input.snapshotAt,
    lines,
    assumptions: assumptions.map((assumption) => ({
      ...assumption,
      forecastId: input.forecastId,
      revision: input.revision,
    })),
  });
};

export const financePlanningSignBasis = (kind: AccountKind) =>
  FinancePlanningSignBasisSchema.parse(signBasisFor(kind));
