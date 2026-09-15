import type { DatabaseClient } from './scoped-repository.js';
import type { WorkspaceContext } from '@emdo/contracts';

/** Shared source read only; callers hold the canonical book mutation lock. */
export async function loadInvestmentValuationSources(
  client: DatabaseClient,
  context: WorkspaceContext,
  bookId: string,
  selected: {
    financialAccountId: string;
    instrumentId: string;
    openingId: string | null;
    priceId: string | null;
    fxId: string | null;
    observedPositionId: string | null;
  },
  asOf: string,
) {
  const instrument = (
    await client.query(
      `select valuation_multiplier::text as multiplier from emdo.finance_instruments where workspace_id=$1 and book_id=$2 and id=$3`,
      [context.workspaceId, bookId, selected.instrumentId],
    )
  ).rows[0];
  const account = (
    await client.query(
      `select id from emdo.finance_financial_accounts where workspace_id=$1 and book_id=$2 and id=$3 and kind='brokerage' and active`,
      [context.workspaceId, bookId, selected.financialAccountId],
    )
  ).rows[0];
  if (!instrument || !account)
    throw new Error('finance-investment-selection-unavailable');
  let opening: Record<string, unknown> | null = null,
    price: Record<string, unknown> | null = null,
    fx: Record<string, unknown> | null = null;
  if (selected.openingId) {
    const row = (
      await client.query(
        `select financial_account_id as "financialAccountId",instrument_id as "instrumentId",as_of::text as "asOf",quantity::text,source_reference as "sourceReference" from emdo.finance_investment_openings where workspace_id=$1 and book_id=$2 and id=$3`,
        [context.workspaceId, bookId, selected.openingId],
      )
    ).rows[0];
    if (!row) throw new Error('finance-investment-opening-unavailable');
    opening = row;
  }
  if (selected.priceId) {
    const row = (
      await client.query(
        `select id,instrument_id as "instrumentId",as_of::text as "asOf",price::text,currency,source_reference as "sourceReference" from emdo.finance_investment_prices where workspace_id=$1 and book_id=$2 and id=$3`,
        [context.workspaceId, bookId, selected.priceId],
      )
    ).rows[0];
    if (!row) throw new Error('finance-investment-price-unavailable');
    price = row;
  }
  if (selected.fxId) {
    const row = (
      await client.query(
        `select id,as_of::text as "asOf",from_currency as "fromCurrency",to_currency as "toCurrency",rate::text,source_reference as "sourceReference" from emdo.finance_fx_observations where workspace_id=$1 and book_id=$2 and id=$3`,
        [context.workspaceId, bookId, selected.fxId],
      )
    ).rows[0];
    if (!row) throw new Error('finance-investment-fx-unavailable');
    fx = row;
  }
  const movements = (
    await client.query(
      `select id,financial_account_id as "financialAccountId",instrument_id as "instrumentId",effective_on::text as "effectiveOn",quantity::text,source_reference as "sourceReference" from emdo.finance_investment_movements where workspace_id=$1 and book_id=$2 and financial_account_id=$3 and instrument_id=$4 and effective_on<=$5 order by effective_on,id`,
      [
        context.workspaceId,
        bookId,
        selected.financialAccountId,
        selected.instrumentId,
        asOf,
      ],
    )
  ).rows;
  let observed: Record<string, unknown> | null = null;
  if (selected.observedPositionId) {
    const row = (
      await client.query(
        `select id,financial_account_id as "financialAccountId",instrument_id as "instrumentId",as_of::text as "asOf",quantity::text,reported_market_value::text as "reportedMarketValue",reported_book_cost::text as "reportedBookCost",reported_price::text as "reportedPrice",reported_accrued_interest::text as "reportedAccruedInterest",mapping_id as "mappingId",source_facts as "sourceFacts",currency,evidence_id as "evidenceId",source_row as "sourceRow" from emdo.finance_observed_positions where workspace_id=$1 and book_id=$2 and id=$3`,
        [context.workspaceId, bookId, selected.observedPositionId],
      )
    ).rows[0];
    if (!row)
      throw new Error('finance-investment-observed-position-unavailable');
    observed = row;
  }
  return { selected, instrument, opening, movements, price, fx, observed };
}
