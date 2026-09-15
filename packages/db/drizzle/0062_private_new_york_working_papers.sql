-- Private 2025 New York working papers only; no filing or readiness activation.
-- Existing private ACL, snapshot locks and immutable wage review chains remain in force.
CREATE OR REPLACE FUNCTION emdo.tax_working_package_scope_supported(workflow text, case_scope jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT workflow='ca-on-2025-personal-working-papers' OR
 (workflow='ca-on-2025-corporate-working-papers' AND case_scope='{"country":"CA","subdivision":"CA-ON","taxpayerType":"corporation","year":2025,"regime":"income-tax-return","formVersion":"T2-2025_GIFI-2025_ON-2025"}'::jsonb) OR
 (workflow='us-fed-2025-working-papers' AND case_scope='{"country":"US","subdivision":"US-FED","taxpayerType":"sole-proprietor","year":2025,"regime":"income-tax-return","formVersion":"1040-2025"}'::jsonb) OR
 (workflow='us-ny-2025-working-papers' AND case_scope='{"country":"US","subdivision":"US-NY","taxpayerType":"sole-proprietor","year":2025,"regime":"income-tax-return","formVersion":"IT201-2025"}'::jsonb)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.validate_tax_wage_review() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE review_workflow text; q emdo.finance_tax_case_snapshots; f emdo.finance_tax_fact_sources; extraction jsonb; a jsonb; d jsonb; original jsonb; predecessor jsonb; root_doc jsonb; correction jsonb; expected jsonb; cursor_id text; visited text[];
BEGIN
 IF NOT emdo.lock_tax_case(NEW.workspace_id,NEW.case_id,ARRAY['owner','reviewer'],true) OR NOT emdo.lock_tax_run_snapshot(NEW.workspace_id,NEW.case_id,NEW.snapshot_revision) THEN RAISE EXCEPTION 'wage review forbidden' USING ERRCODE='42501'; END IF;
 SELECT s.* INTO q FROM emdo.finance_tax_case_snapshots s JOIN emdo.finance_tax_cases c ON c.workspace_id=s.workspace_id AND c.id=s.case_id AND c.current_revision=s.revision WHERE s.workspace_id=NEW.workspace_id AND s.case_id=NEW.case_id AND s.revision=NEW.snapshot_revision;
 review_workflow := CASE WHEN emdo.tax_working_package_scope_supported('us-ny-2025-working-papers',q.questionnaire#>'{intake,scope}') IS TRUE THEN 'us-ny-2025-working-papers' ELSE 'us-fed-2025-working-papers' END;
 IF q.snapshot_hash IS DISTINCT FROM NEW.snapshot_hash OR q.tax_subject_id IS DISTINCT FROM NEW.tax_subject_id OR emdo.tax_working_package_scope_supported(review_workflow,q.questionnaire#>'{intake,scope}') IS NOT TRUE OR NEW.created_by IS DISTINCT FROM emdo.current_user_id() THEN RAISE EXCEPTION 'wage review snapshot conflict' USING ERRCODE='23514'; END IF;
 SELECT * INTO f FROM emdo.finance_tax_fact_sources WHERE workspace_id=NEW.workspace_id AND case_id=NEW.case_id AND id=NEW.source_id AND revision=NEW.source_revision AND content_hash=NEW.source_hash AND fact_key='wageEvidence.documents' AND tax_subject_id=NEW.tax_subject_id;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM emdo.finance_tax_working_input_reviews r WHERE r.workspace_id=NEW.workspace_id AND r.case_id=NEW.case_id AND r.snapshot_revision=NEW.snapshot_revision AND r.source_id=NEW.source_id AND r.source_revision=NEW.source_revision AND r.source_hash=NEW.source_hash AND r.package_hash=NEW.package_hash AND r.snapshot_hash=NEW.snapshot_hash AND r.tax_subject_id=NEW.tax_subject_id AND r.workflow_id=review_workflow) THEN RAISE EXCEPTION 'wage extraction review required' USING ERRCODE='23514'; END IF;
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


--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.validate_tax_calculation_run() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE q emdo.finance_tax_case_snapshots; f jsonb; federal jsonb; state_input jsonb; component record;
BEGIN
 IF NOT emdo.lock_tax_case(NEW.workspace_id,NEW.case_id,ARRAY['owner','preparer'],true) OR NOT emdo.lock_tax_run_snapshot(NEW.workspace_id,NEW.case_id,NEW.snapshot_revision) THEN RAISE EXCEPTION 'tax calculation forbidden' USING ERRCODE='42501'; END IF;
 SELECT s.* INTO q FROM emdo.finance_tax_case_snapshots s JOIN emdo.finance_tax_cases c ON c.workspace_id=s.workspace_id AND c.id=s.case_id AND c.current_revision=s.revision WHERE s.workspace_id=NEW.workspace_id AND s.case_id=NEW.case_id AND s.revision=NEW.snapshot_revision;
 IF q.snapshot_hash IS DISTINCT FROM NEW.snapshot_hash OR q.tax_subject_id IS DISTINCT FROM NEW.tax_subject_id OR NOT emdo.tax_working_package_scope_supported(NEW.workflow_id,q.questionnaire#>'{intake,scope}') OR NEW.created_by<>emdo.current_user_id() OR NEW.complete OR NEW.output->'complete' IS DISTINCT FROM 'false'::jsonb OR NEW.output->'enabled' IS DISTINCT FROM 'false'::jsonb OR NEW.output->'reportable' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'tax run binding or readiness conflict' USING ERRCODE='23514'; END IF;
 IF NEW.input->'questionnaire' IS DISTINCT FROM q.questionnaire OR NEW.input#>'{calculationIntake}' IS DISTINCT FROM NEW.output->'inputSnapshot' OR ((NEW.input->'calculationIntake')-'facts') IS DISTINCT FROM ((q.questionnaire->'intake')-'facts') OR NEW.output->>'packageVersion' IS DISTINCT FROM NEW.package_version OR NEW.input->>'packageHash' IS DISTINCT FROM NEW.package_hash OR emdo.canonical_json_hash(NEW.input) IS DISTINCT FROM NEW.input_hash OR emdo.canonical_json_hash(NEW.output) IS DISTINCT FROM NEW.output_hash THEN RAISE EXCEPTION 'tax run input output integrity conflict' USING ERRCODE='23514'; END IF;
 IF NEW.workflow_id='us-ny-2025-working-papers' THEN
  federal := NEW.input->'federalCalculationIntake';
  state_input := NEW.input->'calculationIntake';
  IF jsonb_typeof(federal) IS DISTINCT FROM 'object'
     OR emdo.tax_working_package_scope_supported('us-fed-2025-working-papers',federal->'scope') IS NOT TRUE
     OR (federal-'scope'-'facts') IS DISTINCT FROM (state_input-'scope'-'facts')
     OR federal IS DISTINCT FROM NEW.output->'federalInputSnapshot'
     OR emdo.canonical_json_hash(federal) IS DISTINCT FROM NEW.output->>'federalInputHash'
     OR emdo.canonical_json_hash(state_input) IS DISTINCT FROM NEW.output->>'newYorkInputHash'
     OR NEW.output#>>'{inputBinding,snapshotHash}' IS DISTINCT FROM NEW.snapshot_hash
     OR NEW.output#>>'{inputBinding,federalSnapshotHash}' IS DISTINCT FROM NEW.snapshot_hash
     OR NEW.output#>>'{inputBinding,newYorkSnapshotHash}' IS DISTINCT FROM NEW.snapshot_hash
     OR NEW.output#>>'{inputBinding,workspaceId}' IS DISTINCT FROM NEW.workspace_id::text
     OR NEW.output#>>'{inputBinding,caseId}' IS DISTINCT FROM NEW.case_id::text
     OR NEW.output#>>'{inputBinding,taxSubjectId}' IS DISTINCT FROM NEW.tax_subject_id::text
     OR NEW.output#>>'{inputBinding,snapshotRevision}' IS DISTINCT FROM NEW.snapshot_revision::text
     OR NEW.output#>>'{inputBinding,federalRevision}' IS DISTINCT FROM NEW.snapshot_revision::text
     OR NEW.output#>>'{inputBinding,newYorkRevision}' IS DISTINCT FROM NEW.snapshot_revision::text
     OR jsonb_typeof(federal->'facts') IS DISTINCT FROM 'array'
     OR jsonb_typeof(state_input->'facts') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'NY federal dependency binding conflict' USING ERRCODE='23514'; END IF;
  FOR component IN SELECT * FROM (VALUES ('federal.',federal),('newYork.',state_input)) c(prefix,intake) LOOP
   IF (SELECT count(DISTINCT value->>'key') FROM jsonb_array_elements(component.intake->'facts')) IS DISTINCT FROM jsonb_array_length(component.intake->'facts')
      OR (SELECT count(*) FROM emdo.finance_tax_fact_sources s
        JOIN jsonb_array_elements(q.questionnaire->'declarationSourceBindings') b
          ON b->>'sourceId'=s.id::text AND b->>'sourceRevision'=s.revision::text AND b->>'contentHash'=s.content_hash
        WHERE s.workspace_id=NEW.workspace_id AND s.case_id=NEW.case_id AND s.tax_subject_id=NEW.tax_subject_id
          AND (starts_with(s.fact_key,component.prefix) OR (component.prefix='federal.' AND s.fact_key='wageEvidence.documents')))
        IS DISTINCT FROM jsonb_array_length(component.intake->'facts')::bigint
   THEN RAISE EXCEPTION 'NY omitted or duplicate component input' USING ERRCODE='23514'; END IF;
   FOR f IN SELECT value FROM jsonb_array_elements(component.intake->'facts') LOOP
    IF NOT EXISTS(
     SELECT 1 FROM emdo.finance_tax_fact_sources s
     JOIN jsonb_array_elements(q.questionnaire->'declarationSourceBindings') b
       ON b->>'sourceId'=s.id::text AND b->>'sourceRevision'=s.revision::text AND b->>'contentHash'=s.content_hash
     WHERE s.workspace_id=NEW.workspace_id AND s.case_id=NEW.case_id AND s.tax_subject_id=NEW.tax_subject_id
       AND (s.fact_key=component.prefix||(f->>'key') OR (component.prefix='federal.' AND s.fact_key='wageEvidence.documents' AND f->>'key'='wageEvidence.documents'))
       AND (CASE WHEN component.prefix='newYork.' AND f->>'key'='federalInputHash'
         THEN f->'value'=jsonb_build_object('type','text','value',emdo.canonical_json_hash(federal))
         ELSE f->'value'=s.value END)
       AND f#>>'{source,kind}'='declaration' AND f#>>'{source,reference}'='declaration:'||s.id::text
       AND f#>>'{source,revision}'=s.revision::text AND f#>>'{source,contentHash}'=s.content_hash
       AND (f->>'reviewState'='unreviewed' OR (f->>'reviewState'='reviewed' AND EXISTS(
        SELECT 1 FROM emdo.finance_tax_working_input_reviews r
        WHERE r.workspace_id=s.workspace_id AND r.case_id=s.case_id AND r.snapshot_revision=NEW.snapshot_revision
         AND r.snapshot_hash=NEW.snapshot_hash AND r.tax_subject_id=NEW.tax_subject_id AND r.workflow_id=NEW.workflow_id
         AND r.source_id=s.id AND r.source_revision=s.revision AND r.source_hash=s.content_hash AND r.package_hash=NEW.package_hash)))
    ) THEN RAISE EXCEPTION 'NY unreviewed or foreign component input' USING ERRCODE='23514'; END IF;
   END LOOP;
  END LOOP;
  RETURN NEW;
 END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(NEW.input#>'{calculationIntake,facts}') LOOP
  IF NOT EXISTS(SELECT 1 FROM emdo.finance_tax_fact_sources s JOIN jsonb_array_elements(q.questionnaire->'declarationSourceBindings') b ON b->>'sourceId'=s.id::text AND b->>'sourceRevision'=s.revision::text AND b->>'contentHash'=s.content_hash WHERE s.workspace_id=NEW.workspace_id AND s.case_id=NEW.case_id AND s.tax_subject_id=NEW.tax_subject_id AND f->>'key'=s.fact_key AND f->'value'=s.value AND f#>>'{source,kind}'='declaration' AND f#>>'{source,reference}'='declaration:'||s.id::text AND f#>>'{source,revision}'=s.revision::text AND f#>>'{source,contentHash}'=s.content_hash AND (f->>'reviewState'='unreviewed' OR (f->>'reviewState'='reviewed' AND EXISTS(SELECT 1 FROM emdo.finance_tax_working_input_reviews r WHERE r.workspace_id=s.workspace_id AND r.case_id=s.case_id AND r.snapshot_revision=NEW.snapshot_revision AND r.source_id=s.id AND r.source_revision=s.revision AND r.source_hash=s.content_hash AND r.package_hash=NEW.package_hash)))) THEN RAISE EXCEPTION 'tax run unreviewed or foreign input' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
ALTER FUNCTION emdo.validate_tax_calculation_run() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.validate_tax_calculation_run() FROM PUBLIC;
