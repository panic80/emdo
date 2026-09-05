# September 5 codebase audit fixes

These changes address the four reproduced findings from the audit of `main`
at `e66e43a`, on top of the local Astra migration at `ed23115`.

| Finding                                          | Corrected behavior                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval could commit a replacement draft        | Execution retains the review used to validate the permit. Its review ID, extraction revision, payload hash, token, and idempotency key reach the existing database commit check under the document lock. An intervening edit invalidates that review and rejects the commit. Exact committed replays remain idempotent.           |
| Refresh could undo logout                        | Only the latest refresh may publish state. Both logout seals, effect cleanup, and session expiration invalidate pending refreshes. Peer teardown and incomplete local cleanup also suspend new refreshes until cleanup completes.                                                                                                 |
| Receipts matched the wrong transaction direction | Expense document totals map to negative ledger amounts; negative expense totals map to refunds. Pay stubs retain the income direction, and bill amounts retain their document convention. Matching still requires exact CAD amount, a compatible document type, a seven-day window, and merchant similarity.                      |
| Matching stopped at the first 50 records         | A single database query filters the uploader's private, active CAD transactions by amount and date before ranking. Unrelated activity and budgets cannot crowd out matches. More than 100,000 eligible candidates, malformed results, or a failed lookup reject draft creation/update rather than saving an incomplete match set. |

The approval regression covers an edit between permit validation and commit, as
well as an edit during embedding generation. PostgreSQL verification proves that
an invalidated review commits no facts and that a newly reviewed replacement can
still commit. The browser component tests pause refreshes at each asynchronous
stage and verify all three logout outcomes.

No schema migration or model configuration change is required. Previously stored
review payloads retain their approval binding; editing a draft recomputes its
suggestions. Historical match decisions are not rewritten.

Local validation and logs are recorded in
`output/audit/2026-09-05 Fix Validation/Validation.md`. The database checks use
disposable local PostgreSQL 18 databases and synthetic data. Browser end-to-end,
credentialed provider, staging, and production checks remain separate.
