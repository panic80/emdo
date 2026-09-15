CREATE TABLE "emdo"."finance_report_mapping_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"mapping_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"reviewed_by" uuid NOT NULL,
	CONSTRAINT "finance_report_mapping_reviews_revision" UNIQUE("workspace_id","book_id","mapping_id","revision"),
	CONSTRAINT "finance_report_mapping_reviews_valid" CHECK (revision>1 and decision in ('approve','retire') and length(trim(reason))>=3)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_report_mapping_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"report_name" text NOT NULL,
	"report_type" text NOT NULL,
	"layout_version" text NOT NULL,
	"version" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"definition" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"unresolved_questions" jsonb NOT NULL,
	"example" jsonb NOT NULL,
	"evidence_id" uuid NOT NULL,
	"validation" jsonb NOT NULL,
	"proposed_by_model" text,
	"created_by" uuid NOT NULL,
	CONSTRAINT "finance_report_mapping_versions_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_report_mapping_versions_identity" UNIQUE("workspace_id","book_id","provider_key","report_name","report_type","version"),
	CONSTRAINT "finance_report_mapping_versions_state" CHECK (version>0 and revision>0 and status in ('candidate','approved','retired') and report_type in ('bank-transactions','investment-positions') and (proposed_by_model is null or proposed_by_model='gpt-6-astra'))
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_report_mapping_reviews" ADD CONSTRAINT "finance_report_mapping_reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_report_mapping_reviews" ADD CONSTRAINT "finance_report_mapping_reviews_reviewed_by_auth_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_report_mapping_reviews" ADD CONSTRAINT "finance_report_mapping_reviews_mapping" FOREIGN KEY ("workspace_id","book_id","mapping_id") REFERENCES "emdo"."finance_report_mapping_versions"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_report_mapping_versions" ADD CONSTRAINT "finance_report_mapping_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_report_mapping_versions" ADD CONSTRAINT "finance_report_mapping_versions_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_report_mapping_versions" ADD CONSTRAINT "finance_report_mapping_versions_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_report_mapping_versions" ADD CONSTRAINT "finance_report_mapping_versions_evidence" FOREIGN KEY ("workspace_id","book_id","evidence_id") REFERENCES "emdo"."finance_book_evidence"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_report_mapping_versions_lookup" ON "emdo"."finance_report_mapping_versions" USING btree ("workspace_id","book_id","provider_key","report_type","status");
-- Candidate mappings carry no authority to post or to approve themselves.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['finance_report_mapping_versions','finance_report_mapping_reviews'] LOOP
    EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow',t);
    EXECUTE format('GRANT SELECT,INSERT ON emdo.%I TO emdo_app',t);
    EXECUTE format('CREATE POLICY %I ON emdo.%I FOR SELECT TO emdo_app USING (emdo.finance_book_access(workspace_id,book_id))',t||'_read',t);
    EXECUTE format('CREATE TRIGGER a_lock_book BEFORE INSERT OR UPDATE ON emdo.%I FOR EACH ROW EXECUTE FUNCTION emdo.lock_finance_book_mutation()',t);
  END LOOP;
END $$;
CREATE POLICY mapping_candidate_insert ON emdo.finance_report_mapping_versions FOR INSERT TO emdo_app WITH CHECK(emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','preparer','approver']));
CREATE POLICY mapping_review_insert ON emdo.finance_report_mapping_reviews FOR INSERT TO emdo_app WITH CHECK(emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','approver']));
GRANT UPDATE ON emdo.finance_report_mapping_versions TO emdo_app;
CREATE POLICY mapping_version_update ON emdo.finance_report_mapping_versions FOR UPDATE TO emdo_app USING(emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','approver'])) WITH CHECK(emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','approver']));
CREATE FUNCTION emdo.check_report_mapping_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'candidate' OR NEW.revision<>1 OR NEW.created_by IS DISTINCT FROM emdo.current_user_id()
      OR NEW.definition->>'providerKey' IS DISTINCT FROM NEW.provider_key OR NEW.definition->>'reportName' IS DISTINCT FROM NEW.report_name
      OR NEW.definition->>'reportType' IS DISTINCT FROM NEW.report_type OR NEW.definition->>'layoutVersion' IS DISTINCT FROM NEW.layout_version
      OR NEW.example->>'documentId' IS DISTINCT FROM NEW.evidence_id::text OR NEW.example->>'providerKey' IS DISTINCT FROM NEW.provider_key
      OR NEW.example->>'reportType' IS DISTINCT FROM NEW.report_type OR jsonb_typeof(NEW.unresolved_questions) IS DISTINCT FROM 'array'
      OR octet_length(NEW.example::text)>8388608 THEN
      RAISE EXCEPTION 'mapping must start as a source-bound candidate' USING ERRCODE='23514'; END IF;
  ELSE
    IF OLD.status='retired' OR NEW.revision<>OLD.revision+1 OR (to_jsonb(NEW)-ARRAY['status','revision']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','revision']) THEN
      RAISE EXCEPTION 'mapping definitions and historical versions are immutable' USING ERRCODE='23514'; END IF;
    IF NEW.status NOT IN ('approved','retired') OR NEW.status=OLD.status OR NOT EXISTS(SELECT 1 FROM emdo.finance_report_mapping_reviews WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND mapping_id=NEW.id AND revision=NEW.revision AND reviewed_by=emdo.current_user_id() AND decision=CASE NEW.status WHEN 'approved' THEN 'approve' ELSE 'retire' END) THEN
      RAISE EXCEPTION 'mapping status requires a matching review decision' USING ERRCODE='23514'; END IF;
    IF NEW.status='approved' AND (NEW.validation->>'status' IS DISTINCT FROM 'normalized' OR NEW.unresolved_questions<>'[]'::jsonb) THEN
      RAISE EXCEPTION 'mapping validation and questions must be resolved before approval' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_report_mapping_version BEFORE INSERT OR UPDATE ON emdo.finance_report_mapping_versions FOR EACH ROW EXECUTE FUNCTION emdo.check_report_mapping_version();
CREATE FUNCTION emdo.check_report_mapping_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.reviewed_by IS DISTINCT FROM emdo.current_user_id() OR NOT EXISTS(SELECT 1 FROM emdo.finance_report_mapping_versions WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.mapping_id AND status<>'retired' AND revision+1=NEW.revision) THEN
    RAISE EXCEPTION 'mapping review revision or reviewer is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_report_mapping_review BEFORE INSERT ON emdo.finance_report_mapping_reviews FOR EACH ROW EXECUTE FUNCTION emdo.check_report_mapping_review();
REVOKE ALL ON FUNCTION emdo.check_report_mapping_version(),emdo.check_report_mapping_review() FROM PUBLIC;
