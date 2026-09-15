# South Korea 2025 bounded tax working papers

This directory contains disabled, country-owned working-paper calculations for
the 2025 attributable-year South Korean national income-tax material. The
National Tax Service (NTS) published the “Individual Income Tax and Benefit
Guide for Foreigners 2026 (Tax return for 2025)” on 2026-04-30 and its year-end
page publishes the 2025 settlement material. The publication evidence is
retained in `sources.ts`, so the package is stored under `/2025` rather than
assuming that publication year and income year are the same.

The package does not change a shared registry, manifest, schema, migration, API
or UI. Every candidate has `enabled: false`, `registryEligible: false` and
`complete: false`. Calculations and review exports cannot authorize filing,
payment or production use.

## Salary settlement graph

The exact salary scope is:

`KR / KR-NATIONAL / individual / 2025 / income-tax-return / NTS-YEAREND-2025`

It requires a domestic resident with ordinary employment income only. The
national chain is:

1. Total salary = annual employment income − reviewed non-taxable employment
   income.
2. Article 47 earned-income deduction, using the NTS bands and KRW 20,000,000
   cap.
3. Earned-income amount = total salary − earned-income deduction.
4. Income deductions for the reviewed basic-deduction-person count at
   KRW 1,500,000 per person, public-pension contributions, health insurance,
   employment insurance, long-term-care insurance and an explicit zero for
   other income deductions.
5. Tax base = earned-income amount − those deductions, floored at zero.
6. The 2025 progressive national rates of 6%, 15%, 24%, 35%, 38%, 40%, 42%
   and 45%.
7. Article 59 earned-income tax credit, including its preliminary formula and
   total-salary cap.
8. The KRW 130,000 standard tax credit when the supported special deductions,
   other credits and monthly-rent credit are all zero. Health, employment and
   long-term-care insurance contributions are special income deductions and
   therefore suppress that credit; public-pension deduction is a separate
   branch and can coexist with it.
9. Reviewed income tax withheld and settlement balance = determined national
   tax − withholding. A positive balance below KRW 1,000 is reported as zero
   under the NTS form instruction while the exact balance remains in the trace.

The calculator emits 24 named national working-paper lines. Each line carries
exact numerator/denominator and decimal text, whole-won `reportedWon`, direct
and transitive source fact keys, rule IDs, references and dependencies. All
intermediates use reduced `BigInt` rationals; no binary floating point or
upstream display rounding is used. Salary and contribution inputs are already
reviewed annual values. Payroll contribution bases, ceilings, employer
certificates and monthly withholding are outside this graph.

## Local income tax

`local.ts` applies the NTS-published 10% relationship to a determined national
individual or corporate income-tax amount without pre-rounding. It returns the
exact rational, whole-won report value and the pinned local-tax source hash.
Salary form review, the sole-proprietor chain and the corporation chain include
this derived local amount. Local authority return fields, locality selection,
payment and submission evidence remain outside the package.

## Sole proprietor and corporation branches

The ordinary sole-proprietor graph uses:

`KR / KR-NATIONAL / sole-proprietor / 2025 / income-tax-return / NTS-GLOBAL-40-1-2025`

It calculates reviewed gross receipts − returns − ledger-supported necessary
expenses, then basic personal deduction, public-pension deduction, the
progressive national tax table, the NTS KRW 70,000 global-income standard tax
credit, prepaid income tax, balance and 10% local tax. Simplified expense-rate
Form 40(4), losses, compliant-filing business, other income and special
deductions/credits are explicit guards.

The standalone corporation graph uses:

`KR / KR-NATIONAL / corporation / 2025 / corporate-income-tax-return / NTS-CORPORATE-1-2025`

It calculates ordinary revenue − returns − reviewed deductible expenses as
accounting profit, carries that amount to the tax base with all tax-adjustment
bridges explicitly zero, then applies the published 9% / 19% / 21% / 24%
corporate bands, prepaid tax and 10% local tax. Groups, branches outside Korea,
losses, non-taxable income, tax adjustments, credits, reliefs, penalties,
special income and local filing are guarded out. Both branches return
`selectedComplete: true` only for their arithmetic input boundary; they remain
`complete: false`, `reportable: false` and `filingAuthorized: false`.

## Actual forms, attachments and review export

`form-inventory.ts` binds printed NTS fields to source IDs and page locators for
the actual 2025 salary withholding receipt (별지 제24호서식(1)), general global
income Form 40(1), simplified Form 40(4), and corporate Form 1. It records
calculated, reviewed-input, guarded, manual and out-of-scope decisions rather
than inventing a full return schema.

`auditSouthKorea2025FormApplicability` requires all nine reviewed salary
identity/employer/period facts and validates byte-hashed salary receipt and
employee declaration attachments. Nonzero pension and mandatory insurance
branches require their evidence; previous-employer evidence is conditional.
`buildSouthKorea2025ReviewExport` can mark this selected one-payer salary case
as `supportedCaseComplete` after those checks. The export always keeps
`fullReturnComplete`, `filingAuthorized` and `reportable` false and carries
source hashes, field decisions, attachment hashes, blockers and an export
hash.

## Required evidence and fail-closed guards

Required facts must be uniquely keyed, explicitly reviewed and bound to a valid
`FinanceTaxIntake` source envelope. Missing or unreviewed facts, unknown facts,
wrong types, invalid amounts, mismatched scope and unbound ledger facts block
evaluation. Zero is never inferred from an absent fact.

The supported guards exclude business/rental, interest/dividend, pension,
daily-worker, retirement, foreign-source and other global income from the
salary branch; foreign-worker flat-tax election, reductions, exemptions,
special deductions, other credits and housing credits are also excluded.

## Official source provenance

`SOUTH_KOREA_2025_SOURCES` records official NTS URLs, retrieval timestamps,
locators and SHA-256 byte hashes. The direct download hashes cover the fetched
NTS PDF, ZIP or HWP bytes. Publication pages can expose a changing read
counter, so their hashes bind the response observed at the recorded timestamp.

| Source                                  | Official material                                                                                                                                         | SHA-256                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `nts-kr-2025-year-end-settlement-guide` | [NTS 2025 year-end settlement guide](https://d.nts.go.kr/comm/nttFileDownload.do?fileKey=88c482e8d69eb1653515871654a4ab42)                                | `e25fe22ef388f12a48cdc39bc23ec762b2941f780a4e7ca0d66925a47594902e` |
| `nts-kr-2025-global-income-guide`       | [NTS Individual Income Tax and Benefit Guide for Foreigners 2026](https://www.nts.go.kr/comm/nttFileDownload.do?fileKey=f3672a0a56ff88d41548b4cc5fc41a3b) | `2144b60c037f91cf902b38b0a36035e3a8a52354ad4e4cc30d48c1cbec3fc5f6` |
| `nts-kr-2025-return-publication-page`   | [NTS return publication notice](https://www.nts.go.kr/english/na/ntt/selectNttInfo.do?mi=10788&nttSn=1350804)                                             | `5e925973003d1089475ba24ee709f995406a61d7c91410eee47d334913430516` |
| `nts-kr-2025-year-end-publication-page` | [NTS year-end settlement landing page](https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=238938&mi=6645)                                         | `0f4579bae22469eb9345590d2709d60a558f2e097028cd94dcc863e10db2b4a9` |
| `nts-kr-2025-local-income-tax-guide`    | [NTS withholding and local income-tax overview](https://g.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7701&mi=2413)                                    | `30be0384766a21a020dd477baf87b54cd45ab42dfbe9fea59dde01ca73a088bf` |
| `nts-kr-2025-global-income-overview`    | [NTS global-income and bookkeeping overview](https://nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7669&mi=2224)                                         | `65691003946457a575d6e553db1b67ceaa2e31f5ab42f4d0a3ae239dccfdb76f` |
| `nts-kr-2025-corporate-income-overview` | [NTS profit-making corporation income-tax overview](https://b.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7979&mi=6553)                                | `add895e49ebacad4958336e29ec8664d0b93edf74452afab1a98bfc9944029cf` |
| `nts-kr-2025-global-form40-1-page`      | [NTS Form 40(1) publication page](https://nts.go.kr/nts/na/ntt/selectNttInfo.do?mi=2240&nttSn=1002353)                                                    | `3a0af26269719cfbfbffaf0e3c84558eb37d68fa85889f748bcb2a4846781715` |
| `nts-kr-2025-global-form40-1`           | [NTS Form 40(1) HWP attachment](https://www.nts.go.kr/comm/nttFileDownload.do?fileKey=91cc4e65db49d2dd55f4b01214dc744a)                                   | `2fb6f557a510b3db861348cf84af5dbba25a01c07a0a2419965055b55b93ba33` |
| `nts-kr-2025-corporate-form1`           | [NTS Taxlaw historical Form 1 attachment](https://taxlaw.nts.go.kr/downloadFile.do?fleId=701000000001012513&fleSn=1)                                      | `e123f7d44aec869a430bda8a2d2670b690cd93bab231f1d92ec2d60d2faff7b2` |

Salary uses `2025.1-national-employment-working-papers.1`; the sole proprietor
and corporation branches use their own version strings in `business.ts`; form
inventory and review export versions are separately pinned. All source review
was recorded on 2026-09-14.

## Completion blockers and missing coverage

The package does not attest to a complete South Korean return. Remaining work
includes:

- full NTS national form field and attachment coverage, including prior-employer
  transfers, amended wage statements, employer certificates and all actual
  declaration schedules;
- complete personal deductions, special deductions, credits, reliefs,
  carryforwards and eligibility/attachment trees;
- rental, interest, dividend, pension, retirement, daily employment,
  foreign-source and combined global-income schedules;
- resident/nonresident and foreign-worker flat-tax variants, amended returns,
  withholding statement variants and filing/payment certification;
- simplified expense-rate classification, business tax adjustments, losses,
  corporation schedules and financial-statement reconciliation;
- local authority subdivision computation, returns and payment proof; and
- independent complete-return validation, review sign-off and filing
  submission.

`fixtures.ts`, `business-fixtures.ts`, `workflow.test.ts`, `business.test.ts`
and `review-export.test.ts` contain manually authored expected values and test
the published boundaries, exact arithmetic, source/version hashes, form and
attachment guards, deterministic review export and blocked unsupported cases.
