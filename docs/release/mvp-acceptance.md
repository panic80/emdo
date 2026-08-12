# EMDO MVP acceptance ledger

Every row requires dated evidence. `Not run` and `blocked` are valid honest
states; recorded fixtures never satisfy a live-provider or deployment gate.

| Gate             | Required evidence                                                                                           | Status                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Source quality   | format, lint, typecheck, unit/integration/eval/build commands from a clean checkout                         | 2026-08-12 local worktree gates passed; clean-checkout CI remains pending         |
| Identity/privacy | live PostgreSQL RLS, Better Auth claim bridge, invite/bootstrap, cross-household probes                     | Local PG17 matrix passed; production auth/provider and staging proof pending      |
| Offline/sync     | install/reopen, two-device edit, conflict, logout purge, Safari OPFS and encryption inspection              | Local Chromium/OPFS preview passed; install, two-device, Safari/live sync pending |
| Agents           | real manager/specialist SDK path, routing/dependency/partial failure, model fallback, approval pause/resume | Provider-free unit/eval gates passed; production/provider integration pending     |
| Scheduler        | Toronto/DST/travel plan plus exactly one approved Google event and readback                                 | Provider smoke not run                                                            |
| Finance          | CSV/OFX preview, rejects/duplicates, atomic import, exact CAD totals, editable budget                       | Provider-free domain gate implemented; final persistence/browser gate pending     |
| Shopping         | grouped plan, approved live offer, freshness, substitutions, unknown costs, safe link-out                   | Approved live offer unavailable until a sanctioned feed is configured             |
| Voice            | 60-second in-memory capture, editable transcript, STT retry, text and ephemeral spoken reply                | OpenAI endpoint/browser smoke pending                                             |
| Accessibility    | desktop/mobile Playwright plus axe and manual WCAG 2.2 AA checklist                                         | Local Chromium axe/keyboard/mobile passed; manual checklist pending               |
| Operations       | image build, Compose render, fresh migration, pg-boss provision, rollback, encrypted restore drill          | Local app builds and PG17 migration passed; image/restore/deployment pending      |
| Staging          | same-VPS synthetic acceptance using exact image digests                                                     | Not run                                                                           |
| Production       | protected approval, Hostinger snapshot, exact digest deployment and health                                  | Not run                                                                           |

Release is blocked by any unresolved Critical/Important security review finding,
missing production composition dependency, stale generated contract, or failed
test above. Unsupported commerce data remains explicitly unavailable rather
than inferred.
