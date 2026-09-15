# Mexico 2025 federal annual ISR working papers

This directory contains a development candidate for the latest fully published
SAT annual-return year at the 2026-09-14 capture date: fiscal year 2025. SAT's
annual-return page says the 2025 return is filed in April 2026. This package is
not enabled, is not registry eligible, and never reports `complete: true`.

The package implements three bounded candidates:

- `MX-FED / individual / 2025 / income-tax-return /
declaracion-anual-pf-2025-sueldos`: a full-year domestic-resident individual
  with ordinary salary income and reviewed payroll totals.
- `MX-FED / sole-proprietor / 2025 / income-tax-return /
declaracion-anual-pf-2025-actividad-profesional`: a full-year
  domestic-resident individual providing ordinary cash-basis professional
  services, with positive utility.
- `MX-FED / corporation / 2025 / income-tax-return /
declaracion-anual-pm-2025-regimen-general`: a full-year domestic standalone
  corporation in the ordinary Régimen General with positive result, an
  aggregate of ordinary authorized deductions, PTU and reviewed provisional
  credits.

The corporation candidate is limited to the positive ordinary slice. It blocks
RESICO, nonprofit, cooperative, coordinated, agricultural, maquiladora,
liquidation, merger/split, foreign, related-party, inventory/cost-of-sales,
unsupported investment/depreciation, employee/payroll, interest, stimulus, dividend-credit
and CUCA/CUFIN movement cases. The evaluator also blocks non-federal
subdivisions, nonresident or partial-year periods, cross-border activity, and
any requested feature other than `income-tax-return`.

## Implemented chain

All monetary facts are reviewed MXN decimal strings with no more than two
decimal places. Exact reduced `bigint` rationals are used until a field is
reported. Display fields use half-up whole-peso rounding; the trace retains the
exact numerator and denominator, and the tariff is applied to the exact
taxable base before display rounding. This reporting policy is a candidate
policy captured for review, not a filing certification.

For salary, the bounded graph is:

1. annual income less reviewed Article 93 exempt income;
2. Article 151 personal deductions, including Article 151(VIII) local salary
   tax when its rate is no more than 5%, subject to the lesser of five annual
   UMA or 15% of total income;
3. the Anexo 8 RMF 2025 annual tariff referred to by Article 152;
4. reviewed employment subsidy, reviewed ISR withholding and zero provisional
   payments as credits; and
5. tax due or balance in favor.

The salary subsidy is accepted as an annual amount calculated by the reviewed
withholding record. The table helper exposes the decree's January 2025 rate of
14.39% of the 2024 monthly UMA and February–December rate of 13.8% of the 2025
monthly UMA. `mexico2025MonthlySalaryIsr` exposes the current Anexo 8 section V
monthly employee withholding tariff; the workflow still requires the annual
withholding total as a reviewed payroll fact. Monthly eligibility,
payroll-period reconstruction, separation payments and non-accumulating income
remain blocked.

For professional services, the bounded graph is:

1. effectively received gross receipts less reviewed refunds/discounts;
2. less the reviewed Article 103 authorized-deduction bucket and local
   business/professional income tax;
3. less reviewed PTU paid and reviewed prior losses applied, producing the
   Article 109 taxable utility;
4. the Article 152 annual tariff after the Article 151 personal-deduction cap;
5. reviewed provisional payments and Article 106 withholding by legal entities;
   the latter must equal exactly 10% of the reviewed gross professional
   payments when the result is cent-exact; and
6. tax due or balance in favor.

The Article 103 bucket is not a receipt classifier: it is a reviewed amount
whose Article 105 requirements have already been checked. Inventory/COGS,
investments and depreciation, employees, special elections, current losses and
loss carryforward history, monthly provisional schedules, and nonzero stimuli
are outside this candidate and block output.

For an ordinary corporation, the bounded graph follows the current SAT
Régimen General guide and LISR article 9: accrued income less reviewed returns
and discounts and an ordinary authorized-deduction aggregate, less PTU and
reviewed prior losses, then 30% ISR less explicit-zero stimulus/dividend/foreign
credits and reviewed provisional payments/withholdings. The guide's income,
deductions, determination, payment and additional-data sections are listed in
`MEXICO_2025_FIELD_APPLICABILITY`. Unsupported income detail, cost-of-sales,
other investment classes/history, payroll, monthly-payment, CUCA/CUFIN and
related schedules remain visible there as unresolved scope.

## Fail-closed inputs and release boundary

Every exclusion is an explicit reviewed false fact. Missing, unreviewed,
disputed, malformed, extra unmapped, negative, over-precise, mismatched-scope,
or unsupported facts block the calculation. Salary exempt income cannot exceed
annual salary. Professional refunds cannot exceed receipts, PTU and applied
losses cannot exceed the available positive utility, and professional legal
entity withholding is reconciled to Article 106's 10% rule.

The candidates have explicit release blockers for the complete applicable form
inventories, Article 93 exemption categories, personal-deduction categories and
eligibility, the five-UMA source-rounding discrepancy, periodic withholding and
provisional reconstruction, professional depreciation and loss schedules,
corporate cost-of-sales/other-investment/payroll and CUCA/CUFIN
schedules, other Title IV income and credits, state/local/IVA/payroll coverage,
electronic filing and payment, and independent complete-return fixtures. A
returned set of working papers therefore remains incomplete even when all
bounded facts are present.

The exact DOF/INEGI 2025 UMA capture is daily `$113.14`, monthly `$3,439.46`,
and annual `$41,273.52`, making five annual UMA `$206,367.60`. Some SAT guide
text and FAQ display a whole-peso `$206,368` or a different cent value. The
adapter retains the DOF/INEGI exact amount and reports the whole-peso display,
while the discrepancy remains a release blocker rather than an undisclosed
choice.

## Evidence

`sources/capture-manifest.json` records the checked-in raw SAT/DOF captures,
retrieval timestamp, byte count, SHA-256 digest and locator. The PDFs have
derived text extracts for inspection; the PDF/HTML capture hashes are the
authority hashes. The runtime references are exported as
`MEXICO_2025_SOURCES` and are attached to every emitted trace row.

`field-catalog.ts` exposes source-bound SAT form and field applicability, while
`reporting.ts` exports a deterministic report containing the applicable field
map, unresolved fields, checked source references, exact trace and hashes. The
export is review data only and performs no filing or payment action.

`workflow.test.ts` provides independent fixtures for the Anexo 8 `$13,200`
tariff result (`$443.72` exact, `$444` displayed), tariff-boundary behavior,
January and February–December subsidy constants, salary withholding and refund arithmetic,
the exact five-UMA cap, professional Article 103/109/152/106 arithmetic,
source-fact traceability, ordinary corporate Article 9 arithmetic,
source-bound reporting, immutability and fail-closed cases. The three
`independent-complete-supported-slice` entries in `independent-fixtures.json`
have all bounded facts reviewed and replayed independently; `fullReturn` stays
false because they do not attest complete SAT return coverage.

## Corporate annual inflation graph (2025.2)

The corporate candidate now requires all twelve reviewed month-end credit and
debt balances. Article 44 annual averages feed the taxable debt-excess or
deductible credit-excess adjustment, then annual income/deductions, Article 9
ISR and payment. The ordinary aggregates must exclude this adjustment to avoid
double counting. Review facts attest Article 45/46 classification, exclusion of
current-month accrued interest and ordinary domestic balances. Special financial
instruments, foreign-currency classification and partial years remain outside scope.

Pinned INEGI December indices are 137.949 (2024) and 143.042 (2025). The
exact ratio less one is 5093/137949; the CFF Article 17-A four-decimal factor
is 0.0369. Monthly balances and averages retain exact fractions; no monthly
whole-peso rounding feeds the annual graph. Independent tests cover both
nonzero directions, refund, unequal monthly balances, source propagation and
missing/unreviewed schedule failures. Full-return classification automation and
independent SAT filing/reporting reconciliation remain release blockers.

## Private shared-intake adapter

`adaptPrivateMexico2025(intake, snapshotHash)` consumes the shared
`FinanceTaxIntake` scalar facts without conversion, renaming or inferred zeros.
`MEXICO_2025_PRIVATE_QUESTIONNAIRES` exposes the three exact scopes and their
required reviewed facts; `MEXICO_2025_PRIVATE_QUESTIONS_BY_TAXPAYER_TYPE` exposes
the corresponding input catalogs, including all corporate inflation months.
The adapter returns `{adapterVersion, status, complete: false, fileable: false,
registryEligible: false, binding, issues, result, report, adapterHash}`.
`result` is the existing workflow output and `report` is its source-bound report;
malformed snapshots or unsupported scope produce null results. Missing reviewed
facts produce blocked working papers with no partial calculation. Binding keeps
case revision, caller-provided snapshot hash, independently calculated input
hash, and every exact fact value/source revision. Snapshot authenticity and case
authorization remain the caller's responsibility. This local export does not
wire the API or interface and does not register or enable the package.

## First-year corporate investments (2025.3)

`corporation.investments.rows` is a reviewed JSON list (explicit `[]` for no
assets), with up to ten asset rows within the shared 2,000-character fact limit.
Each row requires `assetId`, `assetClass` (`office-furniture-equipment` or
`computer-equipment`), `acquisitionDate`, `firstUseDate`, and
`originalInvestment` as an exact MXN decimal string. Original investment is the
reviewed Article 31 amount, including eligible ancillary costs and excluding IVA.
Four explicit reviewed facts attest the original-investment requirements, ordinary
first-year maximum-rate election, full business use through December 31, and
exclusion from the ordinary deduction aggregate.

The graph supports acquisitions in 2025 followed by first use on a month’s first
day, January through November, and continuous use through year end. Article
34(III) office furniture/equipment uses 10%; Article 34(VII) computer equipment
uses 30%. Article 31 prorates by full months / 12, then updates the deduction
from acquisition-month INPC through the last month of the first half of use.
Odd periods omit the middle month. Captured INEGI monthly bulletins pin all
January–November indices; CFF Article 17-A factors are calculated to four
decimal places. All subsequent arithmetic remains rational until review display.
Per-asset source references, dates, rates, full months, raw index ratios, applied
factors and deductions are retained in `investmentSchedule` on the result and
source-bound report.

Independent fixtures prove a 100,000 computer yields 30,447 for full-year use,
27,909.75 for February–December use, and a 120,000 office asset acquired June 15
and first used July 1 yields 6,033.60. The two-asset 36,480.60 deduction feeds
annual ISR and a 69,055.82 exact balance owing in the documented test case.

Prior-year assets, deferred starts, lower rates, part-month starts, December-only
use, disposals, mixed/private use, cars/buildings/other classes, leases, merger
carryovers and immediate/special deductions remain outside this graph. These
are explicit unsupported inputs or review gates, not inferred zero deductions.
Complete-return status, filing precision and other corporate schedules remain
blocked.
