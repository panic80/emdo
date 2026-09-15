import { deepFreeze } from '@emdo/contracts';

/** Printed lines, not internal XFA names: e.g. printed 21700 is internally
 * Line45.Line_21900_Amount. Every match remains bound to the captured field hash.
 * These are explicit scope exclusions, never calculated zero amounts. */
export const PERSONAL_T1_EXCLUDED_BRANCHES = deepFreeze([
  {
    guard: 'scope.noOtherIncome',
    lines: [
      '10400',
      '11300',
      '11400',
      '11410',
      '11500',
      '11600',
      '11700',
      '11701',
      '11900',
      '11905',
      '12000',
      '12010',
      '12200',
      '12500',
      '12599',
      '12600',
      '12700',
      '12799',
      '12800',
      '12900',
      '12905',
      '12906',
      '13000',
      '13010',
      '13699',
      '13700',
      '14099',
      '14100',
      '14299',
      '14300',
      '14400',
      '14500',
      '14600',
    ],
    instruction:
      'T1 Step 2: no income other than reviewed ordinary employment, domestic interest and selected service business',
  },
  {
    guard: 'scope.singleOrdinaryT4',
    lines: ['10105', '10120', '10130'],
    instruction: 'T1 Steps 2 and 3: reviewed ordinary T4 without special boxes',
  },
  {
    guard: 'scope.noOtherDeductions',
    lines: [
      '20700',
      '20800',
      '20805',
      '21000',
      '21300',
      '21400',
      '21500',
      '21699',
      '21700',
      '21900',
      '22000',
      '22100',
      '22400',
      '22900',
      '23100',
      '23200',
      '24400',
      '24900',
      '25100',
      '25300',
      '25395',
      '25400',
      '25500',
      '25600',
    ],
    instruction:
      'T1 Steps 3 and 4: reviewed no unsupported deductions or losses except calculated CPP, reviewed line21200 dues and the supported line25200 carryforward',
  },
  {
    guard: 'scope.singleNoDependants',
    lines: ['30300', '30400', '30425', '30450', '30499', '30500'],
    instruction: 'T1 Part B: reviewed single taxpayer with no dependant claims',
  },
  {
    guard: 'scope.noOtherCredits',
    lines: [
      '31220',
      '31240',
      '31270',
      '31285',
      '31300',
      '31400',
      '31600',
      '31800',
      '31900',
      '32300',
      '32400',
      '32600',
      '33199',
    ],
    instruction:
      'T1 Part B: reviewed absence of other credits, disability, tuition and transfers except supported self medical expenses, educator school-supply credit and ordinary charitable donations',
  },
  {
    guard: 'scope.noSpecialTaxes',
    lines: [
      '40424',
      '40425',
      '40427',
      '40500',
      '40900',
      '41000',
      '41200',
      '41300',
      '41400',
      '41800',
    ],
    instruction:
      'T1 Part C: reviewed absence of split-income, minimum-tax, foreign, investment, political and special taxes/credits',
  },
  {
    guard: 'scope.noEiSpecialBenefitsAgreement',
    lines: ['31217'],
    instruction: 'T1 line 31217: no Schedule 13 special-benefits agreement',
  },
]);

export function personalT1ExcludedBranch(
  sourceId: string,
  label: string,
  reviewedGuard: (key: string) => boolean | undefined,
) {
  if (sourceId !== 'cra-5006-r-2025-fillable') return null;
  const printedLine = /^Line (\d{5})\./.exec(label)?.[1];
  if (!printedLine) return null;
  return (
    PERSONAL_T1_EXCLUDED_BRANCHES.find(
      (branch) =>
        branch.lines.includes(printedLine) && reviewedGuard(branch.guard),
    ) ?? null
  );
}
