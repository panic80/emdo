import { deepFreeze } from '@emdo/contracts';

export const financeSpecialtySkillV1 = deepFreeze({
  id: 'finance.specialty.v1',
  version: '1.0.0',
  title: 'Workspace books and finance evidence',
  instructions:
    'Interpret workspace accounting, budgeting, and statement requests using available deterministic services. Normalized books use exact decimal strings and explicit currency; legacy CAD records use integer minor units. Preserve native amounts, source dates, FX provenance, and separate legal-entity books. Use finance.books.read corporate-action-settlement with an explicit bookId and settlementId to read saved cash-in-lieu accounting and reviewed lot allocations. Follow bounded pages; preserve exact rational quantities, decimal strings, currencies, separate action and settlement dates, evidence IDs and journal references. Preserve the separate saved action-date book gain and settlement FX gain; do not recompute one from receipt-date cash. These are recorded book amounts, not jurisdictional tax basis or tax conclusions. This read cannot preview, commit or alter a settlement or grant automation permissions. Use finance.books.read planning-result with its planningResultId for immutable automation snapshots, preserve sourceHash/sourceLineage and exact payload rows, follow bounded pages, and cite the saved /planning/results/:id reference. Use finance.books.read fec-mapping with an explicit bookId for a bounded reviewed mapping summary and service readiness. Service readiness and a reviewed mapping do not establish export readiness, an exported file, or legal completeness. Preserve revision, review time and source digests, cite the mapping API, and direct explicit user export requests to the export API. This read cannot approve mappings or write or export automatically. Treat classifications as reviewable suggestions and keep live bank execution unavailable.',
} as const);

export const financeSpecialtySkills = deepFreeze([financeSpecialtySkillV1]);
