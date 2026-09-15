# Bank PDF compatibility and recovery

Bank statement mappings can describe either one signed amount column or a complete debit/credit pair. The deterministic normalizer produces credit minus debit with exact decimal arithmetic and keeps both original cells and their provenance. Missing both sides, negative inputs, two nonzero sides, invalid precision, and zero net transactions require review.

English month/day dates use `mmm dd` plus an explicitly reviewed `dateYear`. They never use the current year. Statements spanning years need separate year-specific selections. A dollar symbol does not identify account currency: `currencyCode` is optional human-supplied report context, only for bank mappings with a currency context binding. The provider must output null for that field. Conflicts with explicit source currency require review.

PDF review supports explicitly confirmed blank data cells with page, logical row, and column provenance. Headers and source context still require complete source spans. Loading an assistant suggestion never checks a blank-cell confirmation for the reviewer. These selections do not assert that all statement content was included.

The v6 proposal prompt retains the complete saved PDF text projection and previous input/output limits. Historical prompt versions remain readable. Safe failure codes and verified response usage are captured before SDK output parsing. Rejected output saves no candidate; unknown billing receipts remain indeterminate.

An administrator may acknowledge an uncertain response while retaining its full cost reservation. This records an immutable `retain-reserved-cost` resolution without changing any spend field. A separate authorized retry then rechecks source, current access, expiry, attempt limits and budgets. The retained reservation continues to count against both run and workspace caps. This action does not approve a mapping or post transactions.

Migrations 0080 and 0081 are additive function/constraint updates. Existing posted records and financial approvals remain unchanged. Validation includes strict provider wire serialization, invalid outputs, blank provenance spoofing, bank normalization, mounted review forms, and restricted PostgreSQL retry and budget checks. Live provider verification is a separate deployment acceptance step.
