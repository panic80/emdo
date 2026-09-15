# France 2025-income / 2026-return working papers

This directory contains a deterministic development candidate for a narrow
French income-tax chain. It is pinned to the DGFiP 2026 declaration and guide,
which settle income received from 1 January through 31 December 2025. The
filing year is therefore 2026 while the tax/income year in the package scope
is 2025; the two years are deliberately represented as separate reviewed
facts.

The supported case is a metropolitan-France resident individual with exactly
one ordinary employment salary source, the standard 10% professional-expense
deduction, a single family status, and zero or one dependent first child. The
one-child branch is limited to a filer who lives alone and raises that first
child alone, so the specific full-part quotient rule and its €4,262 cap are
explicit rather than inferred. The no-child branch uses one part. The graph
keeps rational values until the DGFiP whole-euro half-up boundary and then
applies, in order:

1. the salary 10% deduction, with the €509 minimum and €14,555 maximum;
2. net taxable income and the quotient-family division;
3. the 2025-income progressive scale (0%, 11%, 30%, 41%, 45%);
4. the double liquidation needed for the bounded family-quotient cap;
5. the single-filer decote below €1,982, using €897 − 45.25% of tax;
6. the €61 collection threshold; and
7. the calendar-2025 PAS amount as a credit in the 2026 annual settlement.

`workflow.ts` fails closed for absent, unreviewed, mistyped, negative or
unsupported facts. `package.ts` and `full-return.test.ts` contain manually
authored expected fixture outputs; they never call the evaluator to generate
their expected side. Every working output is marked `complete: false`, `enabled: false` and
`reportable: false`. Liability figures are review calculations and do not
prove full form completion, filing readiness, acceptance, deployment or
activation.

`full-return.ts` adds a selected-form applicability, reporting and export
surface for three bounded branches. The salary branch carries the 2042
identity/family, 1AJ/1AK, selected excluded lines and 8HV fields. The
sole-proprietor branch adds one metropolitan micro-BIC-services or micro-BNC
activity through 2042-C-PRO, including its fixed abatement and 8HW advance.
The corporation branch adds one standalone metropolitan real-normal IS return
through 2065-SD, 2065 bis and aggregate 2058-A result lines, with the detailed
2050–2059-G liasse left explicitly user-required. Export redacts sensitive
identity fields by default and is an artifact only.

The selected module still does not cover the complete 2042/annex inventory,
identity private-intake/signature/electronic-filing workflow, actual
professional expenses, pensions, investment/rental/capital-gain income,
foreign income or treaties, deductions, reductions, credits, social
contributions, exceptional or deferred income, DOM rules, alternating
residence, children beyond the first, special quotient-family parts, other
self-employed regimes, VAT, payroll, groups, corporate deficits, special IS
rates or the detailed corporate liasse. Those are explicit release gaps in
`FRANCE_2025_GAPS` and `FRANCE_2025_SELECTED_RETURN_GAPS`.

Primary-source URLs, retrieval timestamp and SHA-256 response hashes are in
`sources.ts` and `sources/capture-manifest.json`. BOFiP is the official DGFiP
doctrine host; the DGFiP guide/form and filing pages are the official
impots.gouv.fr publications.

## FEC accounting export

`packages/domains/src/finance/france-fec.ts` contains the deterministic domain
exporter for the standard flat-file Fichier des écritures comptables (FEC).
It emits the eighteen required fields in the legal order from LPF article
A. 47 A-1, using a UTF-8 tab-separated file with a header and CRLF line
endings. Functional `Debit` and `Credit` values are exact EUR decimal strings
rendered with the French comma decimal separator; foreign amounts and their
three-letter currency are retained in `Montantdevise` and `Idevise`.

The exporter requires an authoritative SIREN source, reviewed opening-balance
policy, explicit journal and entry metadata, a continuous persisted entry
sequence, French account mappings, piece references/dates, validation dates,
and source reference plus SHA-256 evidence for every line. It balances every
entry using exact integer-scaled arithmetic, rejects centralization and
account-closing entries, and returns a reviewable blocked result without file
content when any required value is absent, ambiguous, out of order, or
inconsistent. It does not derive legal identifiers, piece references, or
sequence values from workspace or database identifiers. This is an accounting
export capability; it does not activate French tax-return coverage or
electronic filing.
