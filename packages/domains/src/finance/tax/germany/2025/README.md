# Germany 2025 federal working papers

This package is a disabled, unregistered candidate for the German federal income-tax return. It covers one full-year domestic-resident individual with single assessment, ordinary employment and one cash-method sole-proprietor activity. The business activity must be reviewed as either a **free profession** (`professional`, §18 EStG) or a **trade** (`trade`, §15 EStG). A professional activity is emitted to the Anlage S branch and has no Gewerbesteuer. A trade is emitted to Anlage G and calculates Gewerbesteuer and the §35 EStG income-tax credit.

`evaluateGermany2025WorkingPapers` accepts only the exact `DE / DE-FED / individual / 2025 / income-tax-return / ESt1A-2025` scope, domestic residence, no cross-border activity and no additional requested feature. Every listed amount and exclusion is a distinct `FinanceTaxFact` with `reviewState: reviewed`; the adapter rejects missing, disputed, unreviewed, extra, negative or fractional-cent amounts. It never turns an absent fact into zero. The source-book authorization and snapshot binding remain the responsibility of trusted persistence.

The implemented annual chain is:

- Anlage N employment income: gross wages less the greater of reviewed actual work expenses and the €1,230 2025 employee allowance.
- Anlage S or Anlage G business income: reviewed gross receipts less reviewed deductible expense categories (advertising, professional fees, rent, utilities, insurance, office, travel and supplies). Inventory, assets/depreciation, partnership, multiple-business, foreign-activity, losses, carryforwards and other expenses are explicit blockers.
- Anlage Vorsorgeaufwand: reviewed pension contributions capped at the 2025 €29,344 old-age-provision maximum, basic health contributions with the 96% treatment for contributions carrying sickness-benefit entitlement, long-term-care contributions, reviewed refunds, and the €36 special-expenses allowance. Private/other insurance and other special expenses remain blocked.
- ESt 1 A: total income, special deductions, taxable income floored to whole EUR for §32a, individual tariff income tax, §35 trade-tax credit where applicable, solidarity surcharge, reviewed employment withholding, reviewed advances and balance/refund arithmetic.
- Trade branch: Gewerbeertrag floored to full €100, €24,500 natural-person allowance, 3.5% Steuermessbetrag floored to whole EUR, reviewed municipal Hebesatz, municipal trade tax and the lesser of four times the measure or the allocated tariff-tax reduction ceiling.

The tariff and surcharge calculations use reduced BigInt rationals. The 2025 §32a implementation uses the official zones and coefficients, and Soli uses the single threshold of €19,950, 5.5% rate and 11.9% progression cap. Amounts are displayed at two EUR places after the explicit statutory floor. Every emitted semantic paper line has a graph trace containing exact numerator/denominator, direct and transitive reviewed fact keys, dependencies and authority-reference IDs.

The source captures in `sources/` pin the official federal legal texts, BMF 2025 handbooks, BMF tax-change notice, ELSTER 2025 form guidance/catalogue and an official tax-office ESt1A 2025 bundle. `sources/source-manifest.json` records URL, byte count, locator and SHA-256 for each runtime source. The BMF 2025 payroll programme-flow-plan capture is retained as year/form availability evidence only; it is not used to calculate annual Soli because the annual return calculation is bound to SolzG and the BMF Soli handbook.

Focused tests in `workflow.test.ts` independently check tariff zone boundaries, surcharge threshold/cap, professional versus trade schedule routing, §35/Gewerbesteuer arithmetic, the employee allowance boundary, reviewed-fact fail-closed behavior, source-capture hashes and disabled-candidate blockers. The candidate remains `enabled: false`, `registryEligible: false`, `complete: false` and is not registered or activated.

## Completion blockers

The candidate does not attest full return coverage. State-tax and local-return packages, exact ELSTER field/applicability inventories and attachments, joint assessment, children and other personal benefits, church tax, other income (capital, rental, pension and foreign/progression cases), losses and carryforwards, business adjustments/VAT, corporations (KSt/GewSt returns), electronic filing, payroll and independent complete-return validation remain explicit blockers. There is no filing, payroll submission, persistence or tax-payment action in this package.
