-- Legacy Finance migration is additive and review-first. It snapshots the
-- private sync-entity source, records explicit mappings and unresolved work,
-- and copies approved facts into normalized import review rows. The source
-- sync_entities rows remain untouched; this does not post journals or disable
-- legacy writers.

CREATE TABLE "emdo"."finance_legacy_migration_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"source_household_id" uuid NOT NULL,
	"source_space_id" uuid NOT NULL,
	"source_owner_user_id" uuid NOT NULL,
	"target_owner_user_id" uuid NOT NULL,
	"mapping" jsonb NOT NULL,
	"source_snapshot_hash" text NOT NULL,
	"mapping_hash" text NOT NULL,
	"inspect_idempotency_key" text NOT NULL,
	"status" text DEFAULT 'review' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_count" integer DEFAULT 0 NOT NULL,
	"ready_count" integer DEFAULT 0 NOT NULL,
	"blocked_count" integer DEFAULT 0 NOT NULL,
	"backfilled_count" integer DEFAULT 0 NOT NULL,
	"unresolved_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_legacy_migration_runs_scope" UNIQUE("workspace_id","id"),
	CONSTRAINT "finance_legacy_migration_runs_book_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_legacy_migration_runs_idempotency" UNIQUE("workspace_id","source_space_id","source_owner_user_id","book_id","inspect_idempotency_key"),
	CONSTRAINT "finance_legacy_migration_runs_source_scope" CHECK ("source_household_id" = "workspace_id"),
	CONSTRAINT "finance_legacy_migration_runs_hashes" CHECK ("source_snapshot_hash" ~ '^[0-9a-f]{64}$' AND "mapping_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "finance_legacy_migration_runs_key" CHECK (length("inspect_idempotency_key") BETWEEN 16 AND 200 AND "inspect_idempotency_key" ~ '^[A-Za-z0-9:._-]+$'),
	CONSTRAINT "finance_legacy_migration_runs_state" CHECK ("status" IN ('review','backfilled','comparison-passed','blocked','cutover-approved') AND "revision" > 0),
	CONSTRAINT "finance_legacy_migration_runs_counts" CHECK ("source_count" >= 0 AND "ready_count" >= 0 AND "blocked_count" >= 0 AND "backfilled_count" >= 0 AND "unresolved_count" >= 0 AND "ready_count" + "blocked_count" <= "source_count" AND "backfilled_count" <= "ready_count" AND "unresolved_count" <= "blocked_count"),
	CONSTRAINT "finance_legacy_migration_runs_mapping_size" CHECK (jsonb_typeof("mapping") = 'object' AND octet_length("mapping"::text) <= 1048576),
	CONSTRAINT "finance_legacy_migration_runs_mapping_scope" CHECK ((
		"mapping"->'source'->>'householdId' = "source_household_id"::text AND
		"mapping"->'source'->>'privateSpaceId' = "source_space_id"::text AND
		"mapping"->'source'->>'originalOwnerUserId' = "source_owner_user_id"::text AND
		"mapping"->'target'->>'workspaceId' = "workspace_id"::text AND
		"mapping"->'target'->>'bookId' = "book_id"::text AND
		"mapping"->'target'->>'ownerUserId' = "target_owner_user_id"::text
	) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_legacy_migration_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"migration_id" uuid NOT NULL,
	"source_household_id" uuid NOT NULL,
	"source_space_id" uuid NOT NULL,
	"source_owner_user_id" uuid NOT NULL,
	"legacy_row_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"source_revision" integer NOT NULL,
	"tombstoned" boolean NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"provenance" jsonb,
	"candidate_status" text NOT NULL,
	"disposition" text NOT NULL,
	"normalized" jsonb NOT NULL,
	"classification" jsonb NOT NULL,
	"blockers" jsonb NOT NULL,
	"target_record_id" uuid NOT NULL,
	"target_batch_id" uuid,
	"target_row_id" uuid,
	"native_amount" numeric(38,12),
	"currency" text,
	"source_row" integer,
	"external_id" text,
	"source_hash" text,
	"fingerprint" text,
	"target_financial_account_id" uuid,
	"target_ledger_account_id" uuid,
	"target_evidence_id" uuid,
	"backfill_state" text DEFAULT 'pending' NOT NULL,
	"backfilled_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_legacy_migration_records_scope" UNIQUE("workspace_id","id"),
	CONSTRAINT "finance_legacy_migration_records_run_scope" UNIQUE("workspace_id","migration_id","id"),
	CONSTRAINT "finance_legacy_migration_records_book_run_scope" UNIQUE("workspace_id","book_id","migration_id","id"),
	CONSTRAINT "finance_legacy_migration_records_identity" UNIQUE("migration_id","entity_type","entity_id"),
	CONSTRAINT "finance_legacy_migration_records_source_scope" CHECK ("source_household_id" = "workspace_id"),
	CONSTRAINT "finance_legacy_migration_records_entity_type" CHECK ("entity_type" IN ('finance.account','finance.transaction','finance.category','finance.budget','finance.bill','finance.subscription','finance.goal')),
	CONSTRAINT "finance_legacy_migration_records_entity_id" CHECK (length("entity_id") BETWEEN 1 AND 512 AND "entity_id" !~ '[[:cntrl:]]'),
	CONSTRAINT "finance_legacy_migration_records_revision" CHECK ("source_revision" > 0 AND "revision" > 0),
	CONSTRAINT "finance_legacy_migration_records_payload" CHECK (jsonb_typeof("payload") IS NOT NULL AND octet_length("payload"::text) BETWEEN 2 AND 1048576 AND "payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "finance_legacy_migration_records_candidate" CHECK ("candidate_status" IN ('ready','blocked','preserved') AND "disposition" IN ('backfill','preserve-only','unresolved') AND jsonb_typeof("normalized") = 'object' AND jsonb_typeof("classification") = 'object' AND jsonb_typeof("blockers") = 'array' AND octet_length("blockers"::text) <= 65536),
	CONSTRAINT "finance_legacy_migration_records_tombstone" CHECK (("tombstoned" AND "candidate_status" = 'preserved' AND "disposition" = 'preserve-only' AND "backfill_state" = 'preserved') OR NOT "tombstoned"),
	CONSTRAINT "finance_legacy_migration_records_backfill" CHECK ("backfill_state" IN ('pending','backfilled','preserved') AND (("backfill_state" = 'backfilled' AND "backfilled_at" IS NOT NULL) OR ("backfill_state" <> 'backfilled' AND "backfilled_at" IS NULL))),
	CONSTRAINT "finance_legacy_migration_records_currency" CHECK ("currency" IS NULL OR "currency" IN ('CAD','USD','MXN','EUR','KRW','JPY')),
	CONSTRAINT "finance_legacy_migration_records_amount" CHECK (("native_amount" IS NULL AND "currency" IS NULL) OR ("native_amount" IS NOT NULL AND "currency" IS NOT NULL AND "native_amount" <> 'NaN'::numeric AND "native_amount" = round("native_amount", CASE WHEN "currency" IN ('JPY','KRW') THEN 0 ELSE 2 END))),
	CONSTRAINT "finance_legacy_migration_records_source_row" CHECK ("source_row" IS NULL OR "source_row" BETWEEN 1 AND 100000),
	CONSTRAINT "finance_legacy_migration_records_source_hashes" CHECK (("source_hash" IS NULL AND "fingerprint" IS NULL) OR ("source_hash" IS NOT NULL AND "fingerprint" IS NOT NULL AND "source_hash" ~ '^[0-9a-f]{64}$' AND "fingerprint" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "finance_legacy_migration_records_provenance_size" CHECK ("provenance" IS NULL OR octet_length("provenance"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_legacy_migration_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"migration_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"decision" jsonb NOT NULL,
	"previous_state" jsonb NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_legacy_migration_reviews_identity" UNIQUE("workspace_id","migration_id","record_id","revision"),
	CONSTRAINT "finance_legacy_migration_reviews_revision" CHECK ("revision" > 0),
	CONSTRAINT "finance_legacy_migration_reviews_decision" CHECK (jsonb_typeof("decision") = 'object' AND octet_length("decision"::text) <= 65536 AND jsonb_typeof("previous_state") = 'object' AND octet_length("previous_state"::text) <= 1048576)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_legacy_migration_comparisons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"migration_id" uuid NOT NULL,
	"source_snapshot_hash" text NOT NULL,
	"target_snapshot_hash" text NOT NULL,
	"status" text NOT NULL,
	"source_transaction_count" integer NOT NULL,
	"target_transaction_count" integer NOT NULL,
	"source_cad_minor_total" numeric(38,0) NOT NULL,
	"target_cad_decimal_total" numeric(38,12) NOT NULL,
	"unresolved_count" integer NOT NULL,
	"mismatches" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_legacy_migration_comparisons_scope" UNIQUE("workspace_id","id"),
	CONSTRAINT "finance_legacy_migration_comparisons_run_scope" UNIQUE("workspace_id","migration_id","id"),
	CONSTRAINT "finance_legacy_migration_comparisons_book_run_scope" UNIQUE("workspace_id","book_id","migration_id","id"),
	CONSTRAINT "finance_legacy_migration_comparisons_hashes" CHECK ("source_snapshot_hash" ~ '^[0-9a-f]{64}$' AND "target_snapshot_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "finance_legacy_migration_comparisons_state" CHECK ("status" IN ('passed','failed') AND "source_transaction_count" >= 0 AND "target_transaction_count" >= 0 AND "unresolved_count" >= 0 AND jsonb_typeof("mismatches") = 'array' AND octet_length("mismatches"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_legacy_migration_cutovers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"migration_id" uuid NOT NULL,
	"comparison_id" uuid NOT NULL,
	"source_snapshot_hash" text NOT NULL,
	"status" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_legacy_migration_cutovers_migration" UNIQUE("workspace_id","migration_id"),
	CONSTRAINT "finance_legacy_migration_cutovers_hash" CHECK ("source_snapshot_hash" ~ '^[0-9a-f]{64}$' AND "status" = 'approved')
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_runs" ADD CONSTRAINT "finance_legacy_migration_runs_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_runs" ADD CONSTRAINT "finance_legacy_migration_runs_source_space" FOREIGN KEY ("source_household_id","source_space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_runs" ADD CONSTRAINT "finance_legacy_migration_runs_source_owner" FOREIGN KEY ("source_household_id","source_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_runs" ADD CONSTRAINT "finance_legacy_migration_runs_target_owner" FOREIGN KEY ("workspace_id","target_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_runs" ADD CONSTRAINT "finance_legacy_migration_runs_creator" FOREIGN KEY ("created_by") REFERENCES "emdo"."auth_users"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_records" ADD CONSTRAINT "finance_legacy_migration_records_run" FOREIGN KEY ("workspace_id","book_id","migration_id") REFERENCES "emdo"."finance_legacy_migration_runs"("workspace_id","book_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_records" ADD CONSTRAINT "finance_legacy_migration_records_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_records" ADD CONSTRAINT "finance_legacy_migration_records_source_space" FOREIGN KEY ("source_household_id","source_space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_records" ADD CONSTRAINT "finance_legacy_migration_records_source_owner" FOREIGN KEY ("source_household_id","source_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_records" ADD CONSTRAINT "finance_legacy_migration_records_financial_account" FOREIGN KEY ("workspace_id","book_id","target_financial_account_id") REFERENCES "emdo"."finance_financial_accounts"("workspace_id","book_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_records" ADD CONSTRAINT "finance_legacy_migration_records_ledger_account" FOREIGN KEY ("workspace_id","book_id","target_ledger_account_id") REFERENCES "emdo"."finance_ledger_accounts"("workspace_id","book_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_records" ADD CONSTRAINT "finance_legacy_migration_records_evidence" FOREIGN KEY ("workspace_id","book_id","target_evidence_id") REFERENCES "emdo"."finance_book_evidence"("workspace_id","book_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_reviews" ADD CONSTRAINT "finance_legacy_migration_reviews_run" FOREIGN KEY ("workspace_id","book_id","migration_id") REFERENCES "emdo"."finance_legacy_migration_runs"("workspace_id","book_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_reviews" ADD CONSTRAINT "finance_legacy_migration_reviews_record" FOREIGN KEY ("workspace_id","book_id","migration_id","record_id") REFERENCES "emdo"."finance_legacy_migration_records"("workspace_id","book_id","migration_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_reviews" ADD CONSTRAINT "finance_legacy_migration_reviews_reviewer" FOREIGN KEY ("reviewed_by") REFERENCES "emdo"."auth_users"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_comparisons" ADD CONSTRAINT "finance_legacy_migration_comparisons_run" FOREIGN KEY ("workspace_id","book_id","migration_id") REFERENCES "emdo"."finance_legacy_migration_runs"("workspace_id","book_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_comparisons" ADD CONSTRAINT "finance_legacy_migration_comparisons_creator" FOREIGN KEY ("created_by") REFERENCES "emdo"."auth_users"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_cutovers" ADD CONSTRAINT "finance_legacy_migration_cutovers_run" FOREIGN KEY ("workspace_id","book_id","migration_id") REFERENCES "emdo"."finance_legacy_migration_runs"("workspace_id","book_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_cutovers" ADD CONSTRAINT "finance_legacy_migration_cutovers_comparison" FOREIGN KEY ("workspace_id","book_id","migration_id","comparison_id") REFERENCES "emdo"."finance_legacy_migration_comparisons"("workspace_id","book_id","migration_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_legacy_migration_cutovers" ADD CONSTRAINT "finance_legacy_migration_cutovers_approver" FOREIGN KEY ("approved_by") REFERENCES "emdo"."auth_users"("id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
CREATE INDEX "finance_legacy_migration_runs_status" ON "emdo"."finance_legacy_migration_runs" USING btree ("workspace_id","book_id","status","updated_at");
--> statement-breakpoint
CREATE INDEX "finance_legacy_migration_records_run" ON "emdo"."finance_legacy_migration_records" USING btree ("workspace_id","migration_id","candidate_status","backfill_state");
--> statement-breakpoint
CREATE INDEX "finance_legacy_migration_records_source" ON "emdo"."finance_legacy_migration_records" USING btree ("source_household_id","source_space_id","source_owner_user_id","entity_type","entity_id");
--> statement-breakpoint
CREATE INDEX "finance_legacy_migration_reviews_record" ON "emdo"."finance_legacy_migration_reviews" USING btree ("workspace_id","migration_id","record_id","revision");
--> statement-breakpoint
CREATE INDEX "finance_legacy_migration_comparisons_run" ON "emdo"."finance_legacy_migration_comparisons" USING btree ("workspace_id","migration_id","created_at");
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['finance_legacy_migration_runs','finance_legacy_migration_records','finance_legacy_migration_reviews','finance_legacy_migration_comparisons','finance_legacy_migration_cutovers'] LOOP
    EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC, emdo_app, emdo_worker, emdo_workflow, emdo_worker_executor', table_name);
    EXECUTE format('GRANT SELECT ON emdo.%I TO emdo_policy_reader', table_name);
    EXECUTE format('CREATE POLICY %I ON emdo.%I FOR SELECT TO emdo_policy_reader USING (true)', table_name || '_policy_reader', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION emdo.finance_legacy_migration_access(w uuid,b uuid,sh uuid,ss uuid,owner_id uuid,roles text[] DEFAULT ARRAY['administrator','preparer','approver','viewer']) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, emdo SET row_security = on AS $$
  SELECT sh = w AND owner_id = emdo.current_user_id() AND emdo.finance_book_access(w,b,roles) AND emdo.is_active_request_scope(sh,ss,NULL)
$$;
--> statement-breakpoint
ALTER FUNCTION emdo.finance_legacy_migration_access(uuid,uuid,uuid,uuid,uuid,text[]) OWNER TO emdo_policy_reader;
--> statement-breakpoint
REVOKE ALL ON FUNCTION emdo.finance_legacy_migration_access(uuid,uuid,uuid,uuid,uuid,text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION emdo.finance_legacy_migration_access(uuid,uuid,uuid,uuid,uuid,text[]) TO emdo_app, emdo_policy_reader;
--> statement-breakpoint
-- The definer must be able to invoke the existing authenticated-scope guard.
-- Its session, membership and private-space checks remain authoritative.
GRANT EXECUTE ON FUNCTION emdo.is_active_request_scope(uuid,uuid,uuid) TO emdo_policy_reader;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON emdo.finance_legacy_migration_runs, emdo.finance_legacy_migration_records TO emdo_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON emdo.finance_legacy_migration_reviews, emdo.finance_legacy_migration_comparisons, emdo.finance_legacy_migration_cutovers TO emdo_app;
--> statement-breakpoint
CREATE POLICY finance_legacy_migration_runs_read ON emdo.finance_legacy_migration_runs FOR SELECT TO emdo_app USING (emdo.finance_legacy_migration_access(workspace_id,book_id,source_household_id,source_space_id,source_owner_user_id));
--> statement-breakpoint
CREATE POLICY finance_legacy_migration_runs_insert ON emdo.finance_legacy_migration_runs FOR INSERT TO emdo_app WITH CHECK (emdo.finance_legacy_migration_access(workspace_id,book_id,source_household_id,source_space_id,source_owner_user_id,ARRAY['administrator','preparer','approver']) AND created_by = emdo.current_user_id() AND target_owner_user_id = emdo.current_user_id());
--> statement-breakpoint
CREATE POLICY finance_legacy_migration_runs_update ON emdo.finance_legacy_migration_runs FOR UPDATE TO emdo_app USING (emdo.finance_legacy_migration_access(workspace_id,book_id,source_household_id,source_space_id,source_owner_user_id,ARRAY['administrator','preparer','approver'])) WITH CHECK (emdo.finance_legacy_migration_access(workspace_id,book_id,source_household_id,source_space_id,source_owner_user_id,ARRAY['administrator','preparer','approver']));
--> statement-breakpoint
CREATE POLICY finance_legacy_migration_records_read ON emdo.finance_legacy_migration_records FOR SELECT TO emdo_app USING (emdo.finance_legacy_migration_access(workspace_id,book_id,source_household_id,source_space_id,source_owner_user_id));
--> statement-breakpoint
CREATE POLICY finance_legacy_migration_records_insert ON emdo.finance_legacy_migration_records FOR INSERT TO emdo_app WITH CHECK (emdo.finance_legacy_migration_access(workspace_id,book_id,source_household_id,source_space_id,source_owner_user_id,ARRAY['administrator','preparer','approver']));
--> statement-breakpoint
CREATE POLICY finance_legacy_migration_records_update ON emdo.finance_legacy_migration_records FOR UPDATE TO emdo_app USING (emdo.finance_legacy_migration_access(workspace_id,book_id,source_household_id,source_space_id,source_owner_user_id,ARRAY['administrator','preparer','approver'])) WITH CHECK (emdo.finance_legacy_migration_access(workspace_id,book_id,source_household_id,source_space_id,source_owner_user_id,ARRAY['administrator','preparer','approver']));
--> statement-breakpoint
CREATE POLICY finance_legacy_migration_reviews_read ON emdo.finance_legacy_migration_reviews FOR SELECT TO emdo_app USING (EXISTS (SELECT 1 FROM emdo.finance_legacy_migration_runs r WHERE r.workspace_id = finance_legacy_migration_reviews.workspace_id AND r.id = finance_legacy_migration_reviews.migration_id AND r.book_id = finance_legacy_migration_reviews.book_id AND emdo.finance_legacy_migration_access(r.workspace_id,r.book_id,r.source_household_id,r.source_space_id,r.source_owner_user_id)));
--> statement-breakpoint
CREATE POLICY finance_legacy_migration_reviews_insert ON emdo.finance_legacy_migration_reviews FOR INSERT TO emdo_app WITH CHECK (EXISTS (SELECT 1 FROM emdo.finance_legacy_migration_runs r WHERE r.workspace_id = finance_legacy_migration_reviews.workspace_id AND r.id = finance_legacy_migration_reviews.migration_id AND r.book_id = finance_legacy_migration_reviews.book_id AND emdo.finance_legacy_migration_access(r.workspace_id,r.book_id,r.source_household_id,r.source_space_id,r.source_owner_user_id,ARRAY['administrator','preparer','approver'])) AND reviewed_by = emdo.current_user_id());
--> statement-breakpoint
CREATE POLICY finance_legacy_migration_comparisons_read ON emdo.finance_legacy_migration_comparisons FOR SELECT TO emdo_app USING (EXISTS (SELECT 1 FROM emdo.finance_legacy_migration_runs r WHERE r.workspace_id = finance_legacy_migration_comparisons.workspace_id AND r.id = finance_legacy_migration_comparisons.migration_id AND emdo.finance_legacy_migration_access(r.workspace_id,r.book_id,r.source_household_id,r.source_space_id,r.source_owner_user_id)));
--> statement-breakpoint
CREATE POLICY finance_legacy_migration_comparisons_insert ON emdo.finance_legacy_migration_comparisons FOR INSERT TO emdo_app WITH CHECK (created_by = emdo.current_user_id() AND EXISTS (SELECT 1 FROM emdo.finance_legacy_migration_runs r WHERE r.workspace_id = finance_legacy_migration_comparisons.workspace_id AND r.id = finance_legacy_migration_comparisons.migration_id AND emdo.finance_legacy_migration_access(r.workspace_id,r.book_id,r.source_household_id,r.source_space_id,r.source_owner_user_id,ARRAY['administrator','preparer','approver'])));
--> statement-breakpoint
CREATE POLICY finance_legacy_migration_cutovers_read ON emdo.finance_legacy_migration_cutovers FOR SELECT TO emdo_app USING (EXISTS (SELECT 1 FROM emdo.finance_legacy_migration_runs r WHERE r.workspace_id = finance_legacy_migration_cutovers.workspace_id AND r.id = finance_legacy_migration_cutovers.migration_id AND r.book_id = finance_legacy_migration_cutovers.book_id AND emdo.finance_legacy_migration_access(r.workspace_id,r.book_id,r.source_household_id,r.source_space_id,r.source_owner_user_id,ARRAY['administrator','approver'])));
--> statement-breakpoint
CREATE POLICY finance_legacy_migration_cutovers_insert ON emdo.finance_legacy_migration_cutovers FOR INSERT TO emdo_app WITH CHECK (EXISTS (SELECT 1 FROM emdo.finance_legacy_migration_runs r WHERE r.workspace_id = finance_legacy_migration_cutovers.workspace_id AND r.id = finance_legacy_migration_cutovers.migration_id AND r.book_id = finance_legacy_migration_cutovers.book_id AND emdo.finance_legacy_migration_access(r.workspace_id,r.book_id,r.source_household_id,r.source_space_id,r.source_owner_user_id,ARRAY['administrator','approver'])) AND approved_by = emdo.current_user_id());
--> statement-breakpoint
CREATE FUNCTION emdo.enforce_finance_legacy_migration_run() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id,NEW.workspace_id,NEW.book_id,NEW.source_household_id,NEW.source_space_id,NEW.source_owner_user_id,NEW.target_owner_user_id,NEW.source_snapshot_hash,NEW.inspect_idempotency_key,NEW.created_by,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.book_id,OLD.source_household_id,OLD.source_space_id,OLD.source_owner_user_id,OLD.target_owner_user_id,OLD.source_snapshot_hash,OLD.inspect_idempotency_key,OLD.created_by,OLD.created_at) THEN
      RAISE EXCEPTION 'legacy migration source identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.status NOT IN ('review','blocked') AND NEW.mapping IS DISTINCT FROM OLD.mapping THEN
      RAISE EXCEPTION 'legacy migration mapping is closed' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'cutover-approved' OR NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'legacy migration run revision or cutover state is immutable' USING ERRCODE = '23514';
    END IF;
    IF NOT ((OLD.status,NEW.status) IN (('review','review'),('review','blocked'),('review','backfilled'),('blocked','blocked'),('blocked','review'),('blocked','backfilled'),('backfilled','backfilled'),('backfilled','blocked'),('backfilled','comparison-passed'),('comparison-passed','comparison-passed'),('comparison-passed','blocked'),('comparison-passed','cutover-approved'))) THEN
      RAISE EXCEPTION 'invalid legacy migration run transition' USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
ALTER FUNCTION emdo.enforce_finance_legacy_migration_run() OWNER TO emdo_policy_reader;
--> statement-breakpoint
CREATE TRIGGER finance_legacy_migration_run_transition BEFORE UPDATE ON emdo.finance_legacy_migration_runs FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_legacy_migration_run();
--> statement-breakpoint
CREATE FUNCTION emdo.enforce_finance_legacy_migration_record() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id,NEW.workspace_id,NEW.book_id,NEW.migration_id,NEW.source_household_id,NEW.source_space_id,NEW.source_owner_user_id,NEW.legacy_row_id,NEW.entity_type,NEW.entity_id,NEW.source_revision,NEW.tombstoned,NEW.payload,NEW.payload_hash,NEW.provenance,NEW.normalized,NEW.target_record_id,NEW.target_batch_id,NEW.target_row_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.book_id,OLD.migration_id,OLD.source_household_id,OLD.source_space_id,OLD.source_owner_user_id,OLD.legacy_row_id,OLD.entity_type,OLD.entity_id,OLD.source_revision,OLD.tombstoned,OLD.payload,OLD.payload_hash,OLD.provenance,OLD.normalized,OLD.target_record_id,OLD.target_batch_id,OLD.target_row_id,OLD.created_at) THEN
      RAISE EXCEPTION 'legacy migration source record is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.backfill_state = 'backfilled' AND NEW.backfill_state <> OLD.backfill_state THEN
      RAISE EXCEPTION 'backfilled legacy migration record is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'legacy migration record revision conflict' USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
ALTER FUNCTION emdo.enforce_finance_legacy_migration_record() OWNER TO emdo_policy_reader;
--> statement-breakpoint
CREATE TRIGGER finance_legacy_migration_record_transition BEFORE UPDATE ON emdo.finance_legacy_migration_records FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_legacy_migration_record();
--> statement-breakpoint
CREATE FUNCTION emdo.reject_finance_legacy_migration_history_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'legacy migration history is append-only' USING ERRCODE = '55000';
END $$;
--> statement-breakpoint
ALTER FUNCTION emdo.reject_finance_legacy_migration_history_mutation() OWNER TO emdo_policy_reader;
--> statement-breakpoint
CREATE TRIGGER finance_legacy_migration_review_append_only BEFORE UPDATE OR DELETE ON emdo.finance_legacy_migration_reviews FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_legacy_migration_history_mutation();
--> statement-breakpoint
CREATE TRIGGER finance_legacy_migration_comparison_append_only BEFORE UPDATE OR DELETE ON emdo.finance_legacy_migration_comparisons FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_legacy_migration_history_mutation();
--> statement-breakpoint
CREATE TRIGGER finance_legacy_migration_cutover_append_only BEFORE UPDATE OR DELETE ON emdo.finance_legacy_migration_cutovers FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_legacy_migration_history_mutation();
