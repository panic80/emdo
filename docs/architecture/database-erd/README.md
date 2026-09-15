# EMDO database ERD — implementation revision 0077

This is the current implementation ERD generated from the Drizzle PostgreSQL
metadata snapshot, not a conceptual target model. It contains **168 tables** and
**418 foreign keys** from the journal through `0077`.

## Reproduce

From the repository root:

```bash
python3 infra/scripts/generate-database-erd.py
python3 -m unittest discover -s infra/scripts -p 'test_generate_database_erd.py'
```

The generator uses only the Python standard library. It reads the selected
Drizzle snapshot and every SQL file named by the deployment journal, validates
all FK endpoints and columns, and writes this directory atomically by file.
The no-argument command follows the latest journal entry; use `--snapshot`,
`--journal`, `--output`, `--expected-tables`, and `--expected-fks` to pin a
specific implementation revision and its expected counts.

## Source provenance

| Source           | Path                                          | SHA-256                                                            |
| ---------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| Drizzle snapshot | `packages/db/drizzle/meta/0077_snapshot.json` | `a981ba5654ce0a845d54d8f16affc2ee3540a0a66502ed0f021b0d5b0426f4d8` |
| Drizzle journal  | `packages/db/drizzle/meta/_journal.json`      | `129f0f78c371a4e3d17b004df3e749ba7af1cebf751edbdde63ee6138aa67fe3` |

The complete per-migration source manifest is in `schema-index.json`. Hashes
are included so a regenerated artifact can be compared to its exact source
inputs. This artifact is a source-level schema view; applying migrations to a
database and production readback remain separate validation steps.

## Validation

- Tables: `168` (expected current revision: 168)
- Foreign keys: `418` (expected current revision: 418)
- Composite primary keys: `32`
- Unique constraints: `195`
- Indexes: `150`
- Check constraints: `513`
- FK endpoints checked: `418`; endpoint columns checked: `1826`
- Result: **PASS**

The machine-readable result is `validation.json`. Any missing table or source/
target column causes generation to fail. Cardinality is derived from source
FK nullability and source uniqueness; every composite column mapping is shown
in the relation label and full detail panel.

## Artifacts

- `database-erd.html` — self-contained interactive SVG ERD. Search and filter
  by domain, pan/zoom, click a table for every exact column and FK, and
  download the full Mermaid or schema JSON without a network request.
- `database-erd.mmd` — full downloadable Mermaid ER diagram for all tables and
  foreign keys.
- `schema-index.json` — complete normalized table, column, key, FK, count, and
  source-provenance index used by the HTML and generator.
- `validation.json` — endpoint and count validation output.
- `custom-sql-inventory.json` — SQL-only tables, views, functions, triggers,
  policies, RLS operations, and roles discovered in journaled migration SQL.
- `planned-gaps.md` — schema representation limits and deferred boundaries.
  Entries may be implemented in application/runtime code while remaining
  deliberately absent from this physical table graph.

## Readable domain views

- `WorkspaceAccess` — domain `.mmd` and `.svg` files under `domains/`
- `Accounting` — domain `.mmd` and `.svg` files under `domains/`
- `ImportsEvidence` — domain `.mmd` and `.svg` files under `domains/`
- `Investments` — domain `.mmd` and `.svg` files under `domains/`
- `Automation` — domain `.mmd` and `.svg` files under `domains/`
- `Tax` — domain `.mmd` and `.svg` files under `domains/`
- `LegacyRuntime` — domain `.mmd` and `.svg` files under `domains/`

Domain SVGs and Mermaid files include external context stubs only when a real
FK crosses a domain boundary. The stub is a readability aid; it does not add a
new relation or claim a missing table.

## Important implementation distinctions

- `finance_financial_accounts` represents bank, brokerage, cash, and card
  accounts. `finance_ledger_accounts` represents the general-ledger chart of
  accounts. They are separate tables with an explicit FK from the former to
  the latter.
- `finance_books` are book-scoped accounting boundaries, while
  `finance_entities` identify the legal/accounting owner. `workspaces` are
  access and tenancy boundaries; current compatibility SQL still links a
  workspace identity to the household foundation.
- `finance_tax_subjects` and `finance_tax_cases` are separate from workspaces,
  books, and entities. `finance_tax_case_grants` and `finance_tax_book_sources`
  preserve private case access and explicitly authorized book facts.

## SQL behavior outside the Drizzle graph

The snapshot records zero policy/RLS metadata for several tables even though
journaled SQL enables RLS and creates policies/triggers. The graph therefore
does not infer security or computed relations from snapshot omissions. Source-
side `1:1` labels use any declared unique key contained in the FK columns;
FK targets are checked against a complete exact primary/unique key. The
current SQL inventory reports `169 table declarations` (including
`1` SQL-only table outside the Drizzle table graph),
`4 views`, `178 triggers`,
`455 policies`, and `86 RLS operations`; review
`custom-sql-inventory.json` for migration provenance. SQL-only views such as
the investment lot-position projection are listed behavior metadata and are
not treated as base tables or authoritative FK endpoints.
