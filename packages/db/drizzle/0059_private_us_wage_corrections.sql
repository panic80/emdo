-- Version 1 branch retains migration0056 validation. Version2 adds immutable correction chains.
CREATE OR REPLACE FUNCTION emdo.validate_tax_wage_review() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE q emdo.finance_tax_case_snapshots; f emdo.finance_tax_fact_sources; extraction jsonb; a jsonb; d jsonb; original jsonb; predecessor jsonb; root_doc jsonb; correction jsonb; expected jsonb; cursor_id text; visited text[];
BEGIN
 IF NOT emdo.lock_tax_case(NEW.workspace_id,NEW.case_id,ARRAY['owner','reviewer'],true) OR NOT emdo.lock_tax_run_snapshot(NEW.workspace_id,NEW.case_id,NEW.snapshot_revision) THEN RAISE EXCEPTION 'wage review forbidden' USING ERRCODE='42501'; END IF;
 SELECT s.* INTO q FROM emdo.finance_tax_case_snapshots s JOIN emdo.finance_tax_cases c ON c.workspace_id=s.workspace_id AND c.id=s.case_id AND c.current_revision=s.revision WHERE s.workspace_id=NEW.workspace_id AND s.case_id=NEW.case_id AND s.revision=NEW.snapshot_revision;
 IF q.snapshot_hash IS DISTINCT FROM NEW.snapshot_hash OR q.tax_subject_id IS DISTINCT FROM NEW.tax_subject_id OR NOT emdo.tax_working_package_scope_supported('us-fed-2025-working-papers',q.questionnaire#>'{intake,scope}') OR NEW.created_by IS DISTINCT FROM emdo.current_user_id() THEN RAISE EXCEPTION 'wage review snapshot conflict' USING ERRCODE='23514'; END IF;
 SELECT * INTO f FROM emdo.finance_tax_fact_sources WHERE workspace_id=NEW.workspace_id AND case_id=NEW.case_id AND id=NEW.source_id AND revision=NEW.source_revision AND content_hash=NEW.source_hash AND fact_key='wageEvidence.documents' AND tax_subject_id=NEW.tax_subject_id;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM emdo.finance_tax_working_input_reviews r WHERE r.workspace_id=NEW.workspace_id AND r.case_id=NEW.case_id AND r.snapshot_revision=NEW.snapshot_revision AND r.source_id=NEW.source_id AND r.source_revision=NEW.source_revision AND r.source_hash=NEW.source_hash AND r.package_hash=NEW.package_hash) THEN RAISE EXCEPTION 'wage extraction review required' USING ERRCODE='23514'; END IF;
 extraction=(f.value->>'value')::jsonb;
 IF extraction->>'schemaVersion'='2' THEN
 IF extraction->'schemaVersion' IS DISTINCT FROM '2'::jsonb OR jsonb_typeof(extraction->'documents') IS DISTINCT FROM 'array' OR jsonb_array_length(extraction->'documents')>5 OR length(f.value->>'value')>2000 OR emdo.canonical_json_hash(NEW.manifest) IS DISTINCT FROM NEW.manifest_hash OR NEW.manifest->>'reference' IS DISTINCT FROM 'tax-wage-review:'||NEW.id::text OR NEW.manifest->>'revision' IS DISTINCT FROM NEW.source_revision::text OR jsonb_array_length(NEW.manifest->'artifacts') IS DISTINCT FROM jsonb_array_length(extraction->'documents') THEN RAISE EXCEPTION 'wage manifest conflict' USING ERRCODE='23514'; END IF;
 IF (SELECT count(DISTINCT x->>'artifactId') FROM jsonb_array_elements(NEW.manifest->'artifacts') x)<>jsonb_array_length(NEW.manifest->'artifacts') THEN RAISE EXCEPTION 'duplicate wage original' USING ERRCODE='23514'; END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(NEW.manifest->'artifacts') LOOP
  SELECT value INTO d FROM jsonb_array_elements(extraction->'documents') WHERE value->>'evidenceId'=a->>'artifactId';
  IF d IS NULL OR d->>'form' IS DISTINCT FROM a->>'form' OR d->'originalEvidenceId' IS DISTINCT FROM a->'originalArtifactId' OR d->'supersedesEvidenceId' IS DISTINCT FROM a->'supersedesArtifactId' OR d->'corrections' IS DISTINCT FROM a->'corrections' OR a->'boxes' IS DISTINCT FROM d->'boxes' OR a->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text OR a->>'caseId' IS DISTINCT FROM NEW.case_id::text OR a->>'taxSubjectId' IS DISTINCT FROM NEW.tax_subject_id::text OR a->>'revision' IS DISTINCT FROM NEW.source_revision::text OR a->>'taxYear' IS DISTINCT FROM '2025' OR a->>'reviewedBy' IS DISTINCT FROM NEW.created_by::text OR (a->>'reviewedAt')::timestamptz IS DISTINCT FROM NEW.created_at THEN RAISE EXCEPTION 'wage artifact binding conflict' USING ERRCODE='23514'; END IF;
  IF coalesce(d->'boxes' ?& ARRAY['box1','box2','box3','box5','box6','box7'],false) IS NOT TRUE OR (SELECT count(*) FROM jsonb_object_keys(d->'boxes'))<>6 OR EXISTS(SELECT 1 FROM jsonb_each_text(d->'boxes') box WHERE box.value IS NULL OR box.value !~ '^(0|[1-9][0-9]{0,14})(\.[0-9]{1,2})?$') THEN RAISE EXCEPTION 'wage boxes invalid' USING ERRCODE='23514'; END IF;
  original=emdo.tax_wage_original(NEW.workspace_id,NEW.case_id,NEW.snapshot_revision,(d->>'bookId')::uuid,(d->>'evidenceId')::uuid);
  IF a->>'contentHash' IS DISTINCT FROM original->>'contentHash' THEN RAISE EXCEPTION 'wage original hash conflict' USING ERRCODE='23514'; END IF;
 END LOOP;

 IF (SELECT count(DISTINCT x->>'evidenceId') FROM jsonb_array_elements(extraction->'documents') x)<>jsonb_array_length(extraction->'documents') OR (extraction - 'schemaVersion' - 'documents')<>'{}'::jsonb THEN RAISE EXCEPTION 'wage extraction structure invalid' USING ERRCODE='23514'; END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(NEW.manifest->'artifacts') LOOP
  IF (a-'artifactId'-'workspaceId'-'caseId'-'taxSubjectId'-'revision'-'contentHash'-'form'-'taxYear'-'originalArtifactId'-'supersedesArtifactId'-'corrections'-'reviewedBy'-'reviewedAt'-'boxes')<>'{}'::jsonb OR EXISTS(SELECT 1 FROM jsonb_each(a->'boxes') box WHERE jsonb_typeof(box.value) IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'wage artifact structure invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 FOR d IN SELECT value FROM jsonb_array_elements(extraction->'documents') LOOP
  IF d->>'form'='W-2' THEN
   IF d->'originalEvidenceId' IS DISTINCT FROM 'null'::jsonb OR (d-'bookId'-'evidenceId'-'form'-'originalEvidenceId'-'boxes')<>'{}'::jsonb THEN RAISE EXCEPTION 'original wage metadata invalid' USING ERRCODE='23514'; END IF;
  ELSIF d->>'form'='W-2c' THEN
   IF (d-'bookId'-'evidenceId'-'form'-'originalEvidenceId'-'supersedesEvidenceId'-'corrections'-'boxes')<>'{}'::jsonb OR jsonb_typeof(d->'corrections') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'corrections')>6 THEN RAISE EXCEPTION 'correction metadata invalid' USING ERRCODE='23514'; END IF;
   SELECT value INTO root_doc FROM jsonb_array_elements(extraction->'documents') WHERE value->>'evidenceId'=d->>'originalEvidenceId';
   SELECT value INTO predecessor FROM jsonb_array_elements(extraction->'documents') WHERE value->>'evidenceId'=d->>'supersedesEvidenceId';
   IF root_doc IS NULL OR root_doc->>'form' IS DISTINCT FROM 'W-2' OR predecessor IS NULL OR (predecessor->>'evidenceId' IS DISTINCT FROM root_doc->>'evidenceId' AND predecessor->>'originalEvidenceId' IS DISTINCT FROM root_doc->>'evidenceId') OR (SELECT count(*) FROM jsonb_array_elements(extraction->'documents') x WHERE x->>'supersedesEvidenceId'=d->>'supersedesEvidenceId')<>1 THEN RAISE EXCEPTION 'correction predecessor invalid' USING ERRCODE='23514'; END IF;
   IF (SELECT count(DISTINCT x->>'box') FROM jsonb_array_elements(d->'corrections') x)<>jsonb_array_length(d->'corrections') THEN RAISE EXCEPTION 'duplicate correction box' USING ERRCODE='23514'; END IF;
   expected=predecessor->'boxes';
   FOR correction IN SELECT value FROM jsonb_array_elements(d->'corrections') LOOP
    IF (correction-'box'-'previous'-'correct')<>'{}'::jsonb OR jsonb_typeof(correction->'previous') IS DISTINCT FROM 'string' OR jsonb_typeof(correction->'correct') IS DISTINCT FROM 'string' OR NOT coalesce(correction->>'box'=ANY(ARRAY['box1','box2','box3','box5','box6','box7']),false) OR NOT coalesce(correction->>'previous' ~ '^(0|[1-9][0-9]{0,14})(\.[0-9]{1,2})?$',false) OR NOT coalesce(correction->>'correct' ~ '^(0|[1-9][0-9]{0,14})(\.[0-9]{1,2})?$',false) THEN RAISE EXCEPTION 'correction values invalid' USING ERRCODE='23514'; END IF;
    IF (correction->>'previous')::numeric IS DISTINCT FROM (expected->>(correction->>'box'))::numeric THEN RAISE EXCEPTION 'correction previous mismatch' USING ERRCODE='23514'; END IF;
    expected=jsonb_set(expected,ARRAY[correction->>'box'],correction->'correct');
   END LOOP;
   IF EXISTS(SELECT 1 FROM jsonb_each_text(expected) box WHERE box.value::numeric IS DISTINCT FROM (d->'boxes'->>box.key)::numeric) THEN RAISE EXCEPTION 'correction effective mismatch' USING ERRCODE='23514'; END IF;
   cursor_id=d->>'evidenceId'; visited=ARRAY[]::text[];
   LOOP
    IF cursor_id=ANY(visited) OR cardinality(visited)>5 THEN RAISE EXCEPTION 'correction cycle' USING ERRCODE='23514'; END IF;
    visited=array_append(visited,cursor_id);
    SELECT value INTO predecessor FROM jsonb_array_elements(extraction->'documents') WHERE value->>'evidenceId'=cursor_id;
    IF predecessor IS NULL THEN RAISE EXCEPTION 'correction orphan' USING ERRCODE='23514'; END IF;
    EXIT WHEN predecessor->>'form'='W-2';
    cursor_id=predecessor->>'supersedesEvidenceId';
   END LOOP;
   IF cursor_id IS DISTINCT FROM d->>'originalEvidenceId' THEN RAISE EXCEPTION 'correction root mismatch' USING ERRCODE='23514'; END IF;
  ELSE RAISE EXCEPTION 'wage form unsupported' USING ERRCODE='23514'; END IF;
 END LOOP;
 ELSE
 IF extraction->>'schemaVersion' IS DISTINCT FROM '1' OR jsonb_typeof(extraction->'documents') IS DISTINCT FROM 'array' OR jsonb_array_length(extraction->'documents')>5 OR length(f.value->>'value')>2000 OR emdo.canonical_json_hash(NEW.manifest) IS DISTINCT FROM NEW.manifest_hash OR NEW.manifest->>'reference' IS DISTINCT FROM 'tax-wage-review:'||NEW.id::text OR NEW.manifest->>'revision' IS DISTINCT FROM NEW.source_revision::text OR jsonb_array_length(NEW.manifest->'artifacts') IS DISTINCT FROM jsonb_array_length(extraction->'documents') THEN RAISE EXCEPTION 'wage manifest conflict' USING ERRCODE='23514'; END IF;
 IF (SELECT count(DISTINCT x->>'artifactId') FROM jsonb_array_elements(NEW.manifest->'artifacts') x)<>jsonb_array_length(NEW.manifest->'artifacts') THEN RAISE EXCEPTION 'duplicate wage original' USING ERRCODE='23514'; END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(NEW.manifest->'artifacts') LOOP
  SELECT value INTO d FROM jsonb_array_elements(extraction->'documents') WHERE value->>'evidenceId'=a->>'artifactId';
  IF d IS NULL OR d->>'form' IS DISTINCT FROM 'W-2' OR d->'originalEvidenceId' IS DISTINCT FROM 'null'::jsonb OR a->>'form' IS DISTINCT FROM 'W-2' OR a->'originalArtifactId' IS DISTINCT FROM 'null'::jsonb OR a->'boxes' IS DISTINCT FROM d->'boxes' OR a->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text OR a->>'caseId' IS DISTINCT FROM NEW.case_id::text OR a->>'taxSubjectId' IS DISTINCT FROM NEW.tax_subject_id::text OR a->>'revision' IS DISTINCT FROM NEW.source_revision::text OR a->>'taxYear' IS DISTINCT FROM '2025' OR a->>'reviewedBy' IS DISTINCT FROM NEW.created_by::text OR (a->>'reviewedAt')::timestamptz IS DISTINCT FROM NEW.created_at THEN RAISE EXCEPTION 'wage artifact binding conflict' USING ERRCODE='23514'; END IF;
  IF coalesce(d->'boxes' ?& ARRAY['box1','box2','box3','box5','box6','box7'],false) IS NOT TRUE OR (SELECT count(*) FROM jsonb_object_keys(d->'boxes'))<>6 OR EXISTS(SELECT 1 FROM jsonb_each_text(d->'boxes') box WHERE box.value IS NULL OR box.value !~ '^(0|[1-9][0-9]{0,14})(\.[0-9]{1,2})?$') THEN RAISE EXCEPTION 'wage boxes invalid' USING ERRCODE='23514'; END IF;
  original=emdo.tax_wage_original(NEW.workspace_id,NEW.case_id,NEW.snapshot_revision,(d->>'bookId')::uuid,(d->>'evidenceId')::uuid);
  IF a->>'contentHash' IS DISTINCT FROM original->>'contentHash' THEN RAISE EXCEPTION 'wage original hash conflict' USING ERRCODE='23514'; END IF;
 END LOOP;
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION emdo.validate_tax_wage_review() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.validate_tax_wage_review() FROM PUBLIC;

CREATE FUNCTION emdo.tax_wage_correction_schema_version() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 2 $$;
REVOKE ALL ON FUNCTION emdo.tax_wage_correction_schema_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.tax_wage_correction_schema_version() TO emdo_app;
