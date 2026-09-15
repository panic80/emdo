# Schema representation limits — implementation revision 0077

This file is intentionally separate from the ERD. The entries below describe
application/runtime behavior or explicitly deferred delivery boundaries that
are not physical tables or foreign-key edges in the actual Drizzle snapshot.
They are not a missing-code inventory, and they are deliberately absent from
the graph.

## Platform and orchestration schema limits

- `Workspace`, `WorkspaceMembership`, `WorkspaceContext`, tier entitlements,
  and server-owned section-agent registrations are implemented application
  contracts and runtime registry descriptors. The current snapshot has
  `workspaces`, compatibility household/space membership records, and
  `workspace_entitlements`, but no one-to-one relational table for each
  contract field. The graph preserves those actual tables and does not invent
  replacement entities.
- EMDO delegation, readiness, manager-only parentage, and cross-section
  disclosure rules are enforced by application/runtime contracts. They are
  not represented as a dedicated delegation-run foreign-key graph in this
  snapshot.

## Finance and report-standardization schema limits

- Provider-specific report layouts, Astra-assisted mapping proposals,
  deterministic normalization, review, approval, and reuse are implemented
  through application contracts, services, UI, and the persisted
  `finance_report_mapping_*` and evidence tables. The ERD can show those
  storage boundaries but cannot express the runtime validation and semantic
  drift rules as relational edges.
- The current securities implementation stores instruments, movements, lots,
  corporate-action records, revisions, prices, and observed positions. The
  SQL-only lot-position view is inventoried separately; this graph does not
  infer a base-table relationship or claim that a view is authoritative.

## Tax schema limits

- Versioned tax package registries, country calculations, questionnaires,
  coverage/readiness checks, and review pipelines are implemented in the tax
  contracts and services. This snapshot has no dedicated persisted tables for
  package rules, form definitions, jurisdiction subdivisions, or generated
  return schedules, so those runtime capabilities cannot be inferred from
  the ERD.
- The `finance_tax_*` records provide persisted privacy, source-book, fact,
  snapshot, receipt, and case boundaries. They do not by themselves prove
  return-level coverage for Canada, USA, Mexico, Germany, South Korea, Japan,
  or France; package enablement and independent validation remain release
  evidence outside this schema artifact.

## Explicitly deferred workflows

Payroll, electronic filing, live banking/trading execution, and group
consolidation remain outside this implementation revision.
