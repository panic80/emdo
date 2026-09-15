-- Private 2025 Mexico working papers: exact supported scopes only.
-- Existing private ACL, immutable bindings and disabled readiness guards remain in force.
CREATE OR REPLACE FUNCTION emdo.tax_working_package_scope_supported(workflow text, case_scope jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT workflow='ca-on-2025-personal-working-papers' OR
 (workflow='ca-on-2025-corporate-working-papers' AND case_scope='{"country":"CA","subdivision":"CA-ON","taxpayerType":"corporation","year":2025,"regime":"income-tax-return","formVersion":"T2-2025_GIFI-2025_ON-2025"}'::jsonb) OR
 (workflow='us-fed-2025-working-papers' AND case_scope='{"country":"US","subdivision":"US-FED","taxpayerType":"sole-proprietor","year":2025,"regime":"income-tax-return","formVersion":"1040-2025"}'::jsonb) OR
 (workflow='us-ny-2025-working-papers' AND case_scope='{"country":"US","subdivision":"US-NY","taxpayerType":"sole-proprietor","year":2025,"regime":"income-tax-return","formVersion":"IT201-2025"}'::jsonb) OR
 (workflow='mx-fed-2025-working-papers' AND case_scope IN (
  '{"country":"MX","subdivision":"MX-FED","taxpayerType":"individual","year":2025,"regime":"income-tax-return","formVersion":"declaracion-anual-pf-2025-sueldos"}'::jsonb,
  '{"country":"MX","subdivision":"MX-FED","taxpayerType":"sole-proprietor","year":2025,"regime":"income-tax-return","formVersion":"declaracion-anual-pf-2025-actividad-profesional"}'::jsonb,
  '{"country":"MX","subdivision":"MX-FED","taxpayerType":"corporation","year":2025,"regime":"income-tax-return","formVersion":"declaracion-anual-pm-2025-regimen-general"}'::jsonb
 ))
$$;
