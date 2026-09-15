CREATE TABLE "emdo"."finance_tax_wage_reviews" (
	"workspace_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"tax_subject_id" uuid NOT NULL,
	"snapshot_revision" integer NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"snapshot_hash" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_revision" integer NOT NULL,
	"source_hash" text NOT NULL,
	"package_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_wage_review_scope" UNIQUE("workspace_id","case_id","snapshot_revision","id"),
	CONSTRAINT "tax_wage_review_hashes" CHECK ("emdo"."finance_tax_wage_reviews"."snapshot_hash" ~ '^[a-f0-9]{64}$' and "emdo"."finance_tax_wage_reviews"."source_hash" ~ '^[a-f0-9]{64}$' and "emdo"."finance_tax_wage_reviews"."package_hash" ~ '^[a-f0-9]{64}$' and "emdo"."finance_tax_wage_reviews"."manifest_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_tax_wage_reviews" ADD CONSTRAINT "finance_tax_wage_reviews_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_tax_wage_reviews" ADD CONSTRAINT "tax_wage_review_snapshot_fk" FOREIGN KEY ("workspace_id","case_id","snapshot_revision") REFERENCES "emdo"."finance_tax_case_snapshots"("workspace_id","case_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_tax_wage_reviews" ADD CONSTRAINT "tax_wage_review_source_fk" FOREIGN KEY ("workspace_id","case_id","source_id","source_revision") REFERENCES "emdo"."finance_tax_fact_sources"("workspace_id","case_id","id","revision") ON DELETE no action ON UPDATE no action;

CREATE OR REPLACE FUNCTION emdo.tax_working_package_scope_supported(workflow text, case_scope jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT workflow='ca-on-2025-personal-working-papers' OR
 (workflow='ca-on-2025-corporate-working-papers' AND case_scope='{"country":"CA","subdivision":"CA-ON","taxpayerType":"corporation","year":2025,"regime":"income-tax-return","formVersion":"T2-2025_GIFI-2025_ON-2025"}'::jsonb) OR
 (workflow='us-fed-2025-working-papers' AND case_scope='{"country":"US","subdivision":"US-FED","taxpayerType":"sole-proprietor","year":2025,"regime":"income-tax-return","formVersion":"1040-2025"}'::jsonb)
$$;
ALTER TABLE emdo.finance_tax_wage_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_tax_wage_reviews FORCE ROW LEVEL SECURITY;
REVOKE ALL ON emdo.finance_tax_wage_reviews FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow;
GRANT SELECT,INSERT ON emdo.finance_tax_wage_reviews TO emdo_app;
GRANT SELECT ON emdo.finance_tax_wage_reviews,emdo.finance_book_evidence TO emdo_policy_reader;
CREATE POLICY tax_wage_policy_reader ON emdo.finance_tax_wage_reviews FOR SELECT TO emdo_policy_reader USING(true);
CREATE POLICY tax_wage_read ON emdo.finance_tax_wage_reviews FOR SELECT TO emdo_app USING(emdo.tax_run_snapshot_access(workspace_id,case_id,snapshot_revision));
CREATE POLICY tax_wage_insert ON emdo.finance_tax_wage_reviews FOR INSERT TO emdo_app WITH CHECK(emdo.tax_case_access(workspace_id,case_id,ARRAY['owner','reviewer']) AND created_by=emdo.current_user_id());
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='emdo' AND tablename='finance_book_evidence' AND policyname='tax_wage_original_policy_reader') THEN CREATE POLICY tax_wage_original_policy_reader ON emdo.finance_book_evidence FOR SELECT TO emdo_policy_reader USING(true); END IF; END $$;
CREATE FUNCTION emdo.tax_wage_original(w uuid,c uuid,r integer,b uuid,e uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE q jsonb; original emdo.finance_book_evidence;
BEGIN
 IF NOT emdo.lock_tax_run_snapshot(w,c,r) THEN RAISE EXCEPTION 'private wage source forbidden' USING ERRCODE='42501'; END IF;
 SELECT questionnaire INTO q FROM emdo.finance_tax_case_snapshots WHERE workspace_id=w AND case_id=c AND revision=r;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'sourceAuthorizationBindings') a WHERE a->>'bookId'=b::text) THEN RAISE EXCEPTION 'private wage book forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO original FROM emdo.finance_book_evidence WHERE workspace_id=w AND book_id=b AND id=e;
 IF NOT FOUND OR original.format NOT IN ('pdf','png','jpeg') THEN RAISE EXCEPTION 'private wage original forbidden' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('encryptedOriginal',original.encrypted_original,'contentHash',original.plaintext_sha256,'byteSize',original.byte_size,'format',original.format,'filename',original.filename);
END $$;
ALTER FUNCTION emdo.tax_wage_original(uuid,uuid,integer,uuid,uuid) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.tax_wage_original(uuid,uuid,integer,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.tax_wage_original(uuid,uuid,integer,uuid,uuid) TO emdo_app,emdo_policy_reader;
CREATE FUNCTION emdo.validate_tax_wage_review() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE q emdo.finance_tax_case_snapshots; f emdo.finance_tax_fact_sources; extraction jsonb; a jsonb; d jsonb; original jsonb;
BEGIN
 IF NOT emdo.lock_tax_case(NEW.workspace_id,NEW.case_id,ARRAY['owner','reviewer'],true) OR NOT emdo.lock_tax_run_snapshot(NEW.workspace_id,NEW.case_id,NEW.snapshot_revision) THEN RAISE EXCEPTION 'wage review forbidden' USING ERRCODE='42501'; END IF;
 SELECT s.* INTO q FROM emdo.finance_tax_case_snapshots s JOIN emdo.finance_tax_cases c ON c.workspace_id=s.workspace_id AND c.id=s.case_id AND c.current_revision=s.revision WHERE s.workspace_id=NEW.workspace_id AND s.case_id=NEW.case_id AND s.revision=NEW.snapshot_revision;
 IF q.snapshot_hash IS DISTINCT FROM NEW.snapshot_hash OR q.tax_subject_id IS DISTINCT FROM NEW.tax_subject_id OR NOT emdo.tax_working_package_scope_supported('us-fed-2025-working-papers',q.questionnaire#>'{intake,scope}') OR NEW.created_by IS DISTINCT FROM emdo.current_user_id() THEN RAISE EXCEPTION 'wage review snapshot conflict' USING ERRCODE='23514'; END IF;
 SELECT * INTO f FROM emdo.finance_tax_fact_sources WHERE workspace_id=NEW.workspace_id AND case_id=NEW.case_id AND id=NEW.source_id AND revision=NEW.source_revision AND content_hash=NEW.source_hash AND fact_key='wageEvidence.documents' AND tax_subject_id=NEW.tax_subject_id;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM emdo.finance_tax_working_input_reviews r WHERE r.workspace_id=NEW.workspace_id AND r.case_id=NEW.case_id AND r.snapshot_revision=NEW.snapshot_revision AND r.source_id=NEW.source_id AND r.source_revision=NEW.source_revision AND r.source_hash=NEW.source_hash AND r.package_hash=NEW.package_hash) THEN RAISE EXCEPTION 'wage extraction review required' USING ERRCODE='23514'; END IF;
 extraction=(f.value->>'value')::jsonb;
 IF extraction->>'schemaVersion' IS DISTINCT FROM '1' OR jsonb_typeof(extraction->'documents') IS DISTINCT FROM 'array' OR jsonb_array_length(extraction->'documents')>5 OR length(f.value->>'value')>2000 OR emdo.canonical_json_hash(NEW.manifest) IS DISTINCT FROM NEW.manifest_hash OR NEW.manifest->>'reference' IS DISTINCT FROM 'tax-wage-review:'||NEW.id::text OR NEW.manifest->>'revision' IS DISTINCT FROM NEW.source_revision::text OR jsonb_array_length(NEW.manifest->'artifacts') IS DISTINCT FROM jsonb_array_length(extraction->'documents') THEN RAISE EXCEPTION 'wage manifest conflict' USING ERRCODE='23514'; END IF;
 IF (SELECT count(DISTINCT x->>'artifactId') FROM jsonb_array_elements(NEW.manifest->'artifacts') x)<>jsonb_array_length(NEW.manifest->'artifacts') THEN RAISE EXCEPTION 'duplicate wage original' USING ERRCODE='23514'; END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(NEW.manifest->'artifacts') LOOP
  SELECT value INTO d FROM jsonb_array_elements(extraction->'documents') WHERE value->>'evidenceId'=a->>'artifactId';
  IF d IS NULL OR d->>'form' IS DISTINCT FROM 'W-2' OR d->'originalEvidenceId' IS DISTINCT FROM 'null'::jsonb OR a->>'form' IS DISTINCT FROM 'W-2' OR a->'originalArtifactId' IS DISTINCT FROM 'null'::jsonb OR a->'boxes' IS DISTINCT FROM d->'boxes' OR a->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text OR a->>'caseId' IS DISTINCT FROM NEW.case_id::text OR a->>'taxSubjectId' IS DISTINCT FROM NEW.tax_subject_id::text OR a->>'revision' IS DISTINCT FROM NEW.source_revision::text OR a->>'taxYear' IS DISTINCT FROM '2025' OR a->>'reviewedBy' IS DISTINCT FROM NEW.created_by::text OR (a->>'reviewedAt')::timestamptz IS DISTINCT FROM NEW.created_at THEN RAISE EXCEPTION 'wage artifact binding conflict' USING ERRCODE='23514'; END IF;
  IF coalesce(d->'boxes' ?& ARRAY['box1','box2','box3','box5','box6','box7'],false) IS NOT TRUE OR (SELECT count(*) FROM jsonb_object_keys(d->'boxes'))<>6 OR EXISTS(SELECT 1 FROM jsonb_each_text(d->'boxes') box WHERE box.value IS NULL OR box.value !~ '^(0|[1-9][0-9]{0,14})(\.[0-9]{1,2})?$') THEN RAISE EXCEPTION 'wage boxes invalid' USING ERRCODE='23514'; END IF;
  original=emdo.tax_wage_original(NEW.workspace_id,NEW.case_id,NEW.snapshot_revision,(d->>'bookId')::uuid,(d->>'evidenceId')::uuid);
  IF a->>'contentHash' IS DISTINCT FROM original->>'contentHash' THEN RAISE EXCEPTION 'wage original hash conflict' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
ALTER FUNCTION emdo.validate_tax_wage_review() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.validate_tax_wage_review() FROM PUBLIC;
CREATE TRIGGER validate_tax_wage_review BEFORE INSERT ON emdo.finance_tax_wage_reviews FOR EACH ROW EXECUTE FUNCTION emdo.validate_tax_wage_review();
CREATE FUNCTION emdo.tax_wage_documents(w uuid,c uuid,r integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE q jsonb; documents jsonb;
BEGIN
 IF NOT emdo.lock_tax_run_snapshot(w,c,r) THEN RAISE EXCEPTION 'private wage case forbidden' USING ERRCODE='42501'; END IF;
 SELECT questionnaire INTO q FROM emdo.finance_tax_case_snapshots WHERE workspace_id=w AND case_id=c AND revision=r;
 SELECT coalesce(jsonb_agg(x.doc),'[]'::jsonb) INTO documents FROM (SELECT jsonb_build_object('bookId',e.book_id,'evidenceId',e.id,'filename',e.filename,'format',e.format,'contentHash',e.plaintext_sha256,'byteSize',e.byte_size) doc FROM emdo.finance_book_evidence e WHERE e.workspace_id=w AND e.format IN ('pdf','png','jpeg') AND EXISTS(SELECT 1 FROM jsonb_array_elements(q->'sourceAuthorizationBindings') a WHERE a->>'bookId'=e.book_id::text) ORDER BY e.created_at DESC,e.id LIMIT 100) x;
 RETURN documents;
END $$;
ALTER FUNCTION emdo.tax_wage_documents(uuid,uuid,integer) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.tax_wage_documents(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.tax_wage_documents(uuid,uuid,integer) TO emdo_app,emdo_policy_reader;
