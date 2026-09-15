-- Extend the existing immutable private tax run path; no new grants or tables.
CREATE FUNCTION emdo.tax_working_package_scope_supported(workflow text, case_scope jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT workflow='ca-on-2025-personal-working-papers' OR
 (workflow='ca-on-2025-corporate-working-papers' AND case_scope='{"country":"CA","subdivision":"CA-ON","taxpayerType":"corporation","year":2025,"regime":"income-tax-return","formVersion":"T2-2025_GIFI-2025_ON-2025"}'::jsonb)
$$;
ALTER FUNCTION emdo.tax_working_package_scope_supported(text,jsonb) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.tax_working_package_scope_supported(text,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION emdo.validate_tax_working_input_review() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE q emdo.finance_tax_case_snapshots;
BEGIN
 IF NOT emdo.lock_tax_case(NEW.workspace_id,NEW.case_id,ARRAY['owner','reviewer'],true) OR NOT emdo.lock_tax_run_snapshot(NEW.workspace_id,NEW.case_id,NEW.snapshot_revision) THEN RAISE EXCEPTION 'tax input review forbidden' USING ERRCODE='42501'; END IF;
 SELECT s.* INTO q FROM emdo.finance_tax_case_snapshots s JOIN emdo.finance_tax_cases c ON c.workspace_id=s.workspace_id AND c.id=s.case_id AND c.current_revision=s.revision WHERE s.workspace_id=NEW.workspace_id AND s.case_id=NEW.case_id AND s.revision=NEW.snapshot_revision;
 IF q.snapshot_hash IS DISTINCT FROM NEW.snapshot_hash OR q.tax_subject_id IS DISTINCT FROM NEW.tax_subject_id OR NOT emdo.tax_working_package_scope_supported(NEW.workflow_id,q.questionnaire#>'{intake,scope}') OR NEW.created_by<>emdo.current_user_id() THEN RAISE EXCEPTION 'tax input review binding conflict' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.questionnaire->'declarationSourceBindings') b JOIN emdo.finance_tax_fact_sources f ON f.workspace_id=NEW.workspace_id AND f.case_id=NEW.case_id AND f.id::text=b->>'sourceId' AND f.revision::text=b->>'sourceRevision' AND f.content_hash=b->>'contentHash' WHERE f.id=NEW.source_id AND f.revision=NEW.source_revision AND f.content_hash=NEW.source_hash AND f.tax_subject_id=NEW.tax_subject_id) THEN RAISE EXCEPTION 'tax input review source conflict' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION emdo.validate_tax_working_input_review() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.validate_tax_working_input_review() FROM PUBLIC;

CREATE OR REPLACE FUNCTION emdo.validate_tax_calculation_run() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE q emdo.finance_tax_case_snapshots; f jsonb;
BEGIN
 IF NOT emdo.lock_tax_case(NEW.workspace_id,NEW.case_id,ARRAY['owner','preparer'],true) OR NOT emdo.lock_tax_run_snapshot(NEW.workspace_id,NEW.case_id,NEW.snapshot_revision) THEN RAISE EXCEPTION 'tax calculation forbidden' USING ERRCODE='42501'; END IF;
 SELECT s.* INTO q FROM emdo.finance_tax_case_snapshots s JOIN emdo.finance_tax_cases c ON c.workspace_id=s.workspace_id AND c.id=s.case_id AND c.current_revision=s.revision WHERE s.workspace_id=NEW.workspace_id AND s.case_id=NEW.case_id AND s.revision=NEW.snapshot_revision;
 IF q.snapshot_hash IS DISTINCT FROM NEW.snapshot_hash OR q.tax_subject_id IS DISTINCT FROM NEW.tax_subject_id OR NOT emdo.tax_working_package_scope_supported(NEW.workflow_id,q.questionnaire#>'{intake,scope}') OR NEW.created_by<>emdo.current_user_id() OR NEW.complete OR NEW.output->'complete' IS DISTINCT FROM 'false'::jsonb OR NEW.output->'enabled' IS DISTINCT FROM 'false'::jsonb OR NEW.output->'reportable' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'tax run binding or readiness conflict' USING ERRCODE='23514'; END IF;
 IF NEW.input->'questionnaire' IS DISTINCT FROM q.questionnaire OR NEW.input#>'{calculationIntake}' IS DISTINCT FROM NEW.output->'inputSnapshot' OR ((NEW.input->'calculationIntake')-'facts') IS DISTINCT FROM ((q.questionnaire->'intake')-'facts') OR NEW.output->>'packageVersion' IS DISTINCT FROM NEW.package_version OR NEW.input->>'packageHash' IS DISTINCT FROM NEW.package_hash OR emdo.canonical_json_hash(NEW.input) IS DISTINCT FROM NEW.input_hash OR emdo.canonical_json_hash(NEW.output) IS DISTINCT FROM NEW.output_hash THEN RAISE EXCEPTION 'tax run input output integrity conflict' USING ERRCODE='23514'; END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(NEW.input#>'{calculationIntake,facts}') LOOP
  IF NOT EXISTS(SELECT 1 FROM emdo.finance_tax_fact_sources s JOIN jsonb_array_elements(q.questionnaire->'declarationSourceBindings') b ON b->>'sourceId'=s.id::text AND b->>'sourceRevision'=s.revision::text AND b->>'contentHash'=s.content_hash WHERE s.workspace_id=NEW.workspace_id AND s.case_id=NEW.case_id AND s.tax_subject_id=NEW.tax_subject_id AND f->>'key'=s.fact_key AND f->'value'=s.value AND f#>>'{source,kind}'='declaration' AND f#>>'{source,reference}'='declaration:'||s.id::text AND f#>>'{source,revision}'=s.revision::text AND f#>>'{source,contentHash}'=s.content_hash AND (f->>'reviewState'='unreviewed' OR (f->>'reviewState'='reviewed' AND EXISTS(SELECT 1 FROM emdo.finance_tax_working_input_reviews r WHERE r.workspace_id=s.workspace_id AND r.case_id=s.case_id AND r.snapshot_revision=NEW.snapshot_revision AND r.source_id=s.id AND r.source_revision=s.revision AND r.source_hash=s.content_hash AND r.package_hash=NEW.package_hash)))) THEN RAISE EXCEPTION 'tax run unreviewed or foreign input' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
ALTER FUNCTION emdo.validate_tax_calculation_run() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.validate_tax_calculation_run() FROM PUBLIC;
