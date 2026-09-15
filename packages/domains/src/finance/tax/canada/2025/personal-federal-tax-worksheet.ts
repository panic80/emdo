import { deepFreeze } from '@emdo/contracts';
import { CANADA_2025_FEDERAL_FORM_COLUMNS } from './components.js';
import {
  decimal,
  minus,
  plus,
  positive,
  times,
  compare,
  type PersonalExact,
} from './personal-exact.js';

/**
 * The annual T1 Part A table is a source formula, not a payroll tax table.
 * The worksheet keeps the percentage as an exact dimensionless value and
 * leaves every monetary product unrounded until the paper-reporting policy
 * can prove that the result is lossless at cents.
 */
export type Canada2025FederalTaxWorksheet = Readonly<{
  column: 1 | 2 | 3 | 4 | 5;
  line70: PersonalExact;
  line71: PersonalExact;
  line72: PersonalExact;
  line73Rate: PersonalExact;
  line74: PersonalExact;
  line75: PersonalExact;
  line76: PersonalExact;
}>;

export const CANADA_2025_FEDERAL_TAX_WORKSHEET_SOURCE = deepFreeze({
  id: 'cra-5006-r-2025-etext',
  authority: 'Canada Revenue Agency',
  url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/5006-r/5006-r-25e.txt',
  formVersion: '5006-R E (25)',
  documentHash:
    '1506da18ccf68c528d23b9e43b1d129a922de28784a821976e5c1c32ce63ea71',
  locator: '5006-R E (25), page 5, Part A, columns 1-5, lines 70-76',
});

export function canada2025FederalTaxColumn(
  taxableIncome: PersonalExact,
): 1 | 2 | 3 | 4 | 5 {
  const index = CANADA_2025_FEDERAL_FORM_COLUMNS.findIndex(
    (column) =>
      column.maximum === null ||
      compare(taxableIncome, decimal(column.maximum)) <= 0,
  );
  if (index < 0) throw Error('federal-tax-column-not-found');
  return (index + 1) as 1 | 2 | 3 | 4 | 5;
}

export function calculateCanada2025FederalTaxWorksheet(
  taxableIncome: PersonalExact,
): Canada2025FederalTaxWorksheet {
  const column = canada2025FederalTaxColumn(taxableIncome);
  const published = CANADA_2025_FEDERAL_FORM_COLUMNS[column - 1]!;
  const line70 = taxableIncome;
  const line71 = decimal(published.threshold);
  const line72 = positive(minus(line70, line71));
  const line73Rate = decimal(published.rate);
  const line74 = times(line72, line73Rate);
  const line75 = decimal(published.base);
  const line76 = plus(line74, line75);
  return deepFreeze({
    column,
    line70,
    line71,
    line72,
    line73Rate,
    line74,
    line75,
    line76,
  });
}
