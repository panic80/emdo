# Japan 2025 national salary working papers

This directory is a disabled development package for calendar-year 2025 Japan
(`令和7年分`) national income-tax working papers. The National Tax Agency
(NTA, 国税庁) currently publishes the 令和7年分 return forms and guide as the
latest fully published return-year material. The pinned form is the NTA
`申告書第一表・第二表（令和7年分以降用）`; the package does not assume that a
future 令和8年分 release has the same rules.

The implementation is deliberately bounded to one liability chain:

- a full-year domestic resident individual;
- only ordinary calendar-year salary income, supplied as the aggregate gross
  salary from reviewed salary records;
- the NTA 2025 salary-income table, including its 650,000-yen minimum and the
  1,000-yen intermediate truncation in the two quarter-based bands;
- the social-insurance-premium deduction and the resident basic deduction;
- the NTA national income-tax quick table, followed by the 2.1% special income
  tax for reconstruction; and
- reviewed salary withholding and an explicitly zero estimated-payment input,
  reconciled to the signed assessment/refund result.

All source amounts must be reviewed, nonnegative, whole-JPY decimal strings.
The exact arithmetic layer uses reduced `bigint` rationals. Taxable income is
floored to the nearest 1,000 yen as directed by the NTA guide. Reconstruction
surtax fractions below one yen are dropped. A positive assessment is floored
below 100 yen; a negative result is retained as a signed refund amount. No
caller-supplied tax result is accepted.

The entry point is `runJapan2025WorkingPapers(raw)`, with the descriptive alias
`evaluateJapan2025WorkingPapers(raw)`. Its immutable result contains First
Form and Second Form working rows, exact rational values, source facts,
dependency traces, source references, hashes, and `complete: false`,
`reportable: false`, `enabled: false`, and `registryEligible: false`. A
successful calculation therefore means that this bounded working-paper graph
ran; it is not a fileable return or a complete liability chain.

`auditJapan2025FormApplicability(run, formInput)` independently binds reviewed
identity, return-type, salary-payer, social-insurance-detail and explicit
branch facts to the run's `outputHash`. It inventories selected Form 1/Form 2
fields, marks guarded branches `inapplicable`, and keeps Form 3/Form 4,
schedules, local tax and filing actions as explicit full-return gaps. A valid
ordinary salary fixture can therefore reach
`selectedComplete: true`/`formDataReady: true` for this selected field set;
the audit also returns `fullReturnComplete: false` and `reportable: false`.
`applyJapan2025SelectedReporting` and
`exportJapan2025SelectedReturn` preserve the same distinction. The CSV is a
deterministic source-provenanced review report marked `NOT A COMPLETE RETURN;
NOT FILEABLE`; it is not an e-file payload or filing authorization.

The package also exposes three separately bound development branches. The
`runJapan2025SoleProprietorSchedules` branch covers selected general business
schedule rows for a full-calendar-year domestic sole proprietor. It supports a
white-return general statement from explicit receipts and expense categories.
The blue-return general statement additionally requires reviewed complete books,
an explicit zero blue special deduction, and a balanced selected balance-sheet
subset. It reports selected business income while leaving the national Form
1/Form 2 graph, all other schedules, local tax, consumption tax and filing
actions outside the result. The branch cannot infer an expense, business-use
allocation or blue-return eligibility from omission.

The `runJapan2025StandaloneCorporation` branch is a separate selected Form 1
chain for a domestic ordinary standalone corporation with a 12-month 2025
fiscal year. It requires an explicit accounting-profit-to-taxable-income
reconciliation with no adjustments, a reviewed small-company classification,
and zero credits, losses, group items and prepayments. It applies the NTA
15%/23.2% corporate-tax rates and 10.3% national local-corporate-tax rate with
the published thousand-yen and declaration rounding steps. Corporate Form 1
and national local-corporate-tax working figures remain `complete: false`,
`reportable: false` and `fileable: false`; Form 1 continuation, Forms 4/5 and
other schedules, corporate inhabitant/enterprise/per-capita taxes, consumption
tax and filing are explicit gaps.

`prepareJapan2025LocalTaxHandoff` only prepares the NTA Form 2 local-tax
section's reviewed handoff fields. NTA states that the municipality and
prefecture calculate and notify the actual inhabitant/business tax, so this
branch deliberately returns `taxLiability: null`,
`calculationComplete: false` and `authorityCalculationRequired: true` until a
specific municipality's official schedule is selected and independently
reviewed.

## Source evidence

`sources.ts` and `sources/manifest.json` pin SHA-256 hashes for the captured NTA
bytes. The principal sources are:

- [NTA 2025 return forms and instructions index](https://www.nta.go.jp/taxes/shiraberu/shinkoku/syotoku/r07.htm)
- [NTA Form 1 and Form 2 PDF](https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r07/01.pdf)
- [NTA Form 1/Form 2 identity and return-type instructions](https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order1/3-1_01.htm)
- [NTA general white-return business statement](https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r07/05.pdf) and [2025 completion guide](https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/pdf/034.pdf)
- [NTA general blue-return business statement](https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r07/10.pdf) and [2025 completion guide](https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/pdf/037.pdf)
- [NTA 2025 corporate return form index](https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2025/01.htm), [domestic-corporation Form 1 blue](https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2025/pdf/01-01-a.pdf), and [Form 1 instructions](https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2025/pdf/01-01-ki.pdf)
- [NTA 2025 corporate tax guide](https://www.nta.go.jp/publication/pamph/hojin/aramashi2025/pdf/01.pdf) and [small-company classification](https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2025/pdf/f02-01.pdf)
- [NTA 2025 resident/business-tax handoff guidance](https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order6/3-6_01.htm)
- [NTA salary-income calculation table](https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order2/3-2_06.htm)
- [NTA social-insurance-premium deduction](https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order3/3-3_10.htm)
- [NTA 2025 resident basic-deduction table](https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order3/3-3_21.htm)
- [NTA national income-tax quick table](https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order4/3-4_26.htm)
- [NTA reconstruction surtax calculation](https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order4/3-4_45.htm)
- [NTA combined income-tax and reconstruction amount](https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order4/3-4_41_1.htm)
- [NTA withholding amount](https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order4/3-4_38.htm)
- [NTA declared assessment/refund rounding](https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order4/3-4_39.htm)
- [NTA third-period amount](https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/03/order4/3-4_41.htm)
- [NTA special high-income measure (No.2270)](https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2270.htm)
- [NTA 2025 tax-reform page](https://www.nta.go.jp/users/gensen/2025kiso/index.htm)

The captured HTML keeps the NTA's original response bytes and encoding. The
source hashes are evidence of the local capture, not a claim that an NTA page
can never be revised; re-capture and re-review must create a new package
version.

## Form and branch boundary

The graph emits selected rows from the two forms listed below. The labels are
stable ASCII working-paper keys; each field's `locator` names the NTA printed
line or section.

| Form                      | Supported working rows                                                                                                                                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First Form (`JP-Form-1`)  | salary receipts オ; salary income 6; total income 12; social insurance 10; basic deduction 25; total deductions 30; taxable income 31; tax 32; base income tax 42/44; reconstruction surtax 45; combined tax 46; withholding 49; estimated tax 51; assessment 50; third-period due/refund 52/53 |
| Second Form (`JP-Form-2`) | salary income and withholding in the income-details section; social insurance line 10                                                                                                                                                                                                           |

The NTA's full return system includes all applicable fields of First and
Second Form plus schedules and calculation statements. Depending on facts,
the complete return may require business, medical, housing, donation,
foreign-tax, separate-taxation, loss, high-income, or other attachments. This
package does not implement those fields and does not attest complete-return
coverage.

The complete-return form boundary is the NTA First Form (main income and tax
calculation), Second Form (income and deduction details), Third Form (separate
taxation), and Fourth Form (loss declaration), together with any applicable
calculation statements and schedules. This package emits selected working rows
from First and Second Form only; Third Form, Fourth Form, and all schedules are
outside the candidate.

The following cases are explicit blockers:

- any nonresident, non-full-year, foreign, cross-border, or special residency
  case;
- business/sole-proprietor income, expenses, blue/white return schedules, or
  business deductions;
- corporation income-tax returns, corporate local tax, or consumption tax;
- prefectural or municipal inhabitant tax (住民税) and other local taxes;
- pension, interest, dividends, capital gains, rental, miscellaneous, timber,
  retirement, occasional, or any other income;
- separate taxation, losses/carryovers, foreign tax, disaster relief, high
  income special measures, or any return requiring Form 3/Form 4 or another
  NTA schedule;
- medical, life-insurance, earthquake, small-business mutual aid, spouse,
  dependant, disability, working-student, widow/single-parent, donation,
  housing, employment-income adjustment, special salary-expense, or other
  deductions/credits; and
- estimated payments or other prepayments beyond the explicitly supported
  zero-payment boundary; payroll computation, e-filing, and filing submission
  are outside this working-papers package.

These gates keep an unsupported branch from being treated as a zero and keep a
deterministic national-tax calculation from being mistaken for a complete
Japanese personal, local, sole-proprietor, or corporate return.
