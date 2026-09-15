# Local Docker cleanup — 2026-09-13

Removed stopped, dated local EMDO containers at user request. No volumes removed.

| Container | Last observed status | Retained database volume |
|---|---|---|
| emdo-finance-local-20260906 | Exited 0, four days ago | emdo-finance-local-20260906-data |
| emdo-local-dev | Exited 0, four days ago | 819464819b858e0702851251b89857ab17aae7cb9ce2764e763c5aba00034013 |
| emdo-local-postgres | Exited 0, two weeks ago | 4243d4b997cd1cf9f8e532561e55cc75ecbedc6d612faacdac95f01a791d9bdd |

The `emdo-finance-v2-test` PostgreSQL 18 instance and its synthetic volume were also removed after validation. The repeatable verification script cleans up its own container and synthetic volume automatically. The unnamed dead Docker inventory entry could not be inspected (Docker returned no such object); no deletion was attempted against an unidentified resource. Shared images were retained.
