# API read-model production status and blockers

The production API readiness contract includes an `experience` group so that
hard-coded or local-only UI data cannot be mistaken for a release-ready server
graph. Authenticated ports, routes, PostgreSQL adapters, and the built-in API
composition now exist for all seven components. No process-memory or fixture
fallback is selected when a dependency is absent.

Every request derives its principal and request ID at the API boundary. The
adapters enter the database through the request-scope lock and forced RLS;
responses use schema version `1`, canonical timestamps, bounded strings,
bounded counts, and bounded page sizes. The shared capability probe verifies
the exact `emdo_api_login` identity, `emdo_app` membership, routine EXECUTE,
forced-RLS relations, selected columns, and raw preference-table DML denial.

| Readiness component                   | Durable source and response                                                                                                                      | Remaining release proof                                                                                                           | Web status                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `experience.activity-read`            | Safe titles/status only from audit events, Calendar maintenance receipts, and notification deliveries; cursor-bounded to 50 unique rows.         | Fresh and upgrade PG17 execution of migration `0007` plus the exact-login readiness probe. Raw audit payloads must remain absent. | `activity.tsx` uses the authenticated experience client; loading, unavailable, empty, cursor, and retry states are tested. |
| `experience.finance-read`             | RLS-scoped canonical `finance.transaction` and `finance.budget` entities, CAD minor units only, at most 50 rows.                                 | Fresh and upgrade PG17 execution plus cross-household/RLS proof.                                                                  | `finance.tsx` uses the authenticated experience client and does not retain demo totals.                                    |
| `experience.notification-preferences` | SECURITY DEFINER read and CAS/idempotent update routines over forced-RLS preference/command tables; response includes version and four booleans. | Fresh and upgrade PG17 execution of `0007`, including routine owner/ACL and replay/conflict proof.                                | The preferences form reads and saves through the authenticated experience client with CAS conflict handling.               |
| `experience.schedule-read`            | RLS-scoped canonical scheduler entities plus persisted Calendar connection state; ordered range at most 31 days and page at most 50.             | Fresh and upgrade PG17 execution; a connected live Calendar account remains a separate provider acceptance gate.                  | `schedule.tsx` uses the authenticated experience client; proposal creation remains a separate command.                     |
| `experience.settings-read`            | Member-safe household name/role, at most 50 private-space names, and persisted Calendar connection state.                                        | Fresh and upgrade PG17 execution plus member/owner cross-scope proof. Offline readiness still comes from local DomainData.        | `settings.tsx` uses the authenticated experience client while offline status remains local DomainData.                     |
| `experience.shopping-read`            | RLS-scoped canonical shopping entities with bounded optional name/unit/retailer, quantity minor units, and state; at most 50 rows.               | Fresh and upgrade PG17 execution plus cross-household/RLS proof. Offer pricing is intentionally not fabricated.                   | `shopping.tsx` uses the authenticated experience client and represents unavailable offer pricing honestly.                 |
| `experience.today-read`               | One bounded RLS transaction over schedule, reminders, notifications, finance counts, and shopping counts; sensitive titles are fixed redactions. | Fresh and upgrade PG17 execution plus a live consistency/redaction acceptance receipt.                                            | `today.tsx` uses the authenticated experience client with loading, unavailable, and retry behavior.                        |

## Shopping projection boundary

The canonical shopping projection preserves `name`, `unit`, `retailer`, and
`quantityMinorUnits`. The API contract deliberately omits `priceCadMinor`,
`sourceUrl`, and `offerUpdatedAt`: no durable authorized offer source exists,
so the UI must show those fields as unavailable. A synthetic seed payload is
not proof of live offer authority.

Production composition exposes a typed binding and bounded 503 fallback for
each port. It selects the curated PostgreSQL factory only with an API database
URL, and every component reports `ok` only after the capability probe returns
the literal value `true`. Source-level green tests do not replace the pending
fresh/upgrade PostgreSQL and authenticated-browser release gates.
