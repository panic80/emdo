CREATE TABLE "emdo"."finance_book_grants" (
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "finance_book_grants_workspace_id_book_id_user_id_pk" PRIMARY KEY("workspace_id","book_id","user_id"),
	CONSTRAINT "finance_book_grants_role" CHECK ("emdo"."finance_book_grants"."role" in ('administrator','preparer','approver','viewer'))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entity_id" uuid NOT NULL,
	"name" text NOT NULL,
	"functional_currency" text NOT NULL,
	"fiscal_year_start_month" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "finance_books_scope" UNIQUE("workspace_id","id"),
	CONSTRAINT "finance_books_currency" CHECK ("emdo"."finance_books"."functional_currency" in ('CAD','USD','MXN','EUR','KRW','JPY')),
	CONSTRAINT "finance_books_fiscal_month" CHECK ("emdo"."finance_books"."fiscal_year_start_month" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_command_receipts" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"operation" text NOT NULL,
	"payload_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_command_receipts_workspace_id_user_id_idempotency_key_pk" PRIMARY KEY("workspace_id","user_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"country" text NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "finance_entities_scope" UNIQUE("workspace_id","id"),
	CONSTRAINT "finance_entities_kind" CHECK ("emdo"."finance_entities"."kind" in ('individual','sole-proprietor','corporation')),
	CONSTRAINT "finance_entities_country" CHECK ("emdo"."finance_entities"."country" in ('CA','US','MX','DE','KR','JP','FR'))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"journal_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"side" text NOT NULL,
	"amount" numeric(38, 12) NOT NULL,
	"currency" text NOT NULL,
	"native_amount" numeric(38, 12) NOT NULL,
	"fx_rate" numeric(38, 12) NOT NULL,
	"fx_source" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	CONSTRAINT "finance_journal_lines_number" UNIQUE("workspace_id","book_id","journal_id","line_number"),
	CONSTRAINT "finance_journal_lines_amounts" CHECK ("emdo"."finance_journal_lines"."amount" > 0 and "emdo"."finance_journal_lines"."native_amount" > 0 and "emdo"."finance_journal_lines"."fx_rate" > 0 and "emdo"."finance_journal_lines"."amount" <> 'NaN'::numeric and "emdo"."finance_journal_lines"."native_amount" <> 'NaN'::numeric and "emdo"."finance_journal_lines"."fx_rate" <> 'NaN'::numeric),
	CONSTRAINT "finance_journal_lines_side" CHECK ("emdo"."finance_journal_lines"."side" in ('debit','credit')),
	CONSTRAINT "finance_journal_lines_currency" CHECK ("emdo"."finance_journal_lines"."currency" in ('CAD','USD','MXN','EUR','KRW','JPY'))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"effective_on" date NOT NULL,
	"description" text NOT NULL,
	"source_reference" text NOT NULL,
	"period_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"posted_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"reversal_of" uuid,
	CONSTRAINT "finance_journals_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_journals_idempotency" UNIQUE("workspace_id","book_id","idempotency_key"),
	CONSTRAINT "finance_journals_reversal" UNIQUE("workspace_id","book_id","reversal_of"),
	CONSTRAINT "finance_journals_state" CHECK (("emdo"."finance_journals"."status" = 'draft' and "emdo"."finance_journals"."posted_at" is null) or ("emdo"."finance_journals"."status" = 'posted' and "emdo"."finance_journals"."posted_at" is not null)),
	CONSTRAINT "finance_journals_hash" CHECK ("emdo"."finance_journals"."payload_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "finance_ledger_accounts_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_ledger_accounts_code" UNIQUE("workspace_id","book_id","code"),
	CONSTRAINT "finance_ledger_accounts_kind" CHECK ("emdo"."finance_ledger_accounts"."kind" in ('asset','liability','equity','income','expense'))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	CONSTRAINT "finance_periods_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_periods_dates" CHECK ("emdo"."finance_periods"."starts_on" <= "emdo"."finance_periods"."ends_on"),
	CONSTRAINT "finance_periods_state" CHECK (("emdo"."finance_periods"."status" = 'open' and "emdo"."finance_periods"."closed_at" is null and "emdo"."finance_periods"."closed_by" is null) or ("emdo"."finance_periods"."status" = 'closed' and "emdo"."finance_periods"."closed_at" is not null and "emdo"."finance_periods"."closed_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_v2_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid,
	"actor_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"record_id" uuid NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emdo"."workspace_entitlements" (
	"workspace_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"enabled" boolean NOT NULL,
	"limit" integer,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "workspace_entitlements_workspace_id_capability_pk" PRIMARY KEY("workspace_id","capability"),
	CONSTRAINT "workspace_entitlement_limit" CHECK ("emdo"."workspace_entitlements"."limit" is null or "emdo"."workspace_entitlements"."limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "emdo"."workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"usage_type" text DEFAULT 'household' NOT NULL,
	"tier_code" text DEFAULT 'pilot' NOT NULL,
	"timezone" text DEFAULT 'America/Toronto' NOT NULL,
	"locale" text DEFAULT 'en-CA' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "workspaces_usage_type" CHECK ("emdo"."workspaces"."usage_type" in ('personal','household','organization')),
	CONSTRAINT "workspaces_revision" CHECK ("emdo"."workspaces"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_book_grants" ADD CONSTRAINT "finance_book_grants_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_book_grants" ADD CONSTRAINT "finance_book_grants_member" FOREIGN KEY ("workspace_id","user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_books" ADD CONSTRAINT "finance_books_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_books" ADD CONSTRAINT "finance_books_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_books" ADD CONSTRAINT "finance_books_entity" FOREIGN KEY ("workspace_id","entity_id") REFERENCES "emdo"."finance_entities"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_command_receipts" ADD CONSTRAINT "finance_command_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_command_receipts" ADD CONSTRAINT "finance_command_receipts_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_entities" ADD CONSTRAINT "finance_entities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_entities" ADD CONSTRAINT "finance_entities_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_journal_lines" ADD CONSTRAINT "finance_journal_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_journal_lines" ADD CONSTRAINT "finance_journal_lines_journal" FOREIGN KEY ("workspace_id","book_id","journal_id") REFERENCES "emdo"."finance_journals"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_journal_lines" ADD CONSTRAINT "finance_journal_lines_account" FOREIGN KEY ("workspace_id","book_id","account_id") REFERENCES "emdo"."finance_ledger_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_journals" ADD CONSTRAINT "finance_journals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_journals" ADD CONSTRAINT "finance_journals_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_journals" ADD CONSTRAINT "finance_journals_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_journals" ADD CONSTRAINT "finance_journals_period" FOREIGN KEY ("workspace_id","book_id","period_id") REFERENCES "emdo"."finance_periods"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_ledger_accounts" ADD CONSTRAINT "finance_ledger_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_ledger_accounts" ADD CONSTRAINT "finance_ledger_accounts_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_periods" ADD CONSTRAINT "finance_periods_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_periods" ADD CONSTRAINT "finance_periods_closed_by_auth_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_periods" ADD CONSTRAINT "finance_periods_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_v2_audit" ADD CONSTRAINT "finance_v2_audit_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_v2_audit" ADD CONSTRAINT "finance_v2_audit_actor_id_auth_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_v2_audit" ADD CONSTRAINT "finance_v2_audit_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."workspace_entitlements" ADD CONSTRAINT "workspace_entitlements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."workspaces" ADD CONSTRAINT "workspaces_id_households_id_fk" FOREIGN KEY ("id") REFERENCES "emdo"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_book_grants_user" ON "emdo"."finance_book_grants" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "finance_journal_lines_account_idx" ON "emdo"."finance_journal_lines" USING btree ("workspace_id","book_id","account_id");--> statement-breakpoint
CREATE INDEX "finance_journals_date" ON "emdo"."finance_journals" USING btree ("workspace_id","book_id","effective_on","id");--> statement-breakpoint
CREATE INDEX "finance_v2_audit_book_idx" ON "emdo"."finance_v2_audit" USING btree ("workspace_id","book_id","created_at");

--> statement-breakpoint
-- Appended to the generated foundation migration. Policy source is kept here
-- so subsequent schema generation cannot discard the accounting invariants.

INSERT INTO emdo.workspaces(id) SELECT id FROM emdo.households ON CONFLICT DO NOTHING;
INSERT INTO emdo.workspace_entitlements(workspace_id, capability, enabled)
SELECT id, 'finance.books.create', true FROM emdo.workspaces ON CONFLICT DO NOTHING;

CREATE FUNCTION emdo.initialize_workspace() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on AS $$
BEGIN
  INSERT INTO emdo.workspaces(id) VALUES (NEW.id);
  INSERT INTO emdo.workspace_entitlements(workspace_id, capability, enabled)
    VALUES (NEW.id, 'finance.books.create', true);
  RETURN NEW;
END $$;
CREATE TRIGGER initialize_workspace AFTER INSERT ON emdo.households
FOR EACH ROW EXECUTE FUNCTION emdo.initialize_workspace();

CREATE FUNCTION emdo.finance_v2_member(w uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on AS $$
  SELECT emdo.is_active_member(w) AND EXISTS (
    SELECT 1 FROM emdo.auth_sessions s JOIN emdo.auth_users u ON u.id = s.user_id
    WHERE s.id = emdo.current_session_id() AND s.user_id = emdo.current_user_id()
      AND s.active_household_id = w AND s.expires_at > statement_timestamp() AND u.email_verified
  )
$$;
ALTER FUNCTION emdo.finance_v2_member(uuid) OWNER TO emdo_policy_reader;

CREATE FUNCTION emdo.finance_book_access(w uuid, b uuid, roles text[] DEFAULT ARRAY['administrator','preparer','approver','viewer'])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog SET row_security = on AS $$
  SELECT emdo.finance_v2_member(w) AND EXISTS (
    SELECT 1 FROM emdo.finance_book_grants g
    WHERE g.workspace_id = w AND g.book_id = b AND g.user_id = emdo.current_user_id()
      AND g.revoked_at IS NULL AND g.role = ANY(roles)
  )
$$;
ALTER FUNCTION emdo.finance_book_access(uuid,uuid,text[]) OWNER TO emdo_policy_reader;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['workspaces','workspace_entitlements','finance_entities','finance_books',
    'finance_book_grants','finance_ledger_accounts','finance_periods','finance_journals',
    'finance_journal_lines','finance_command_receipts','finance_v2_audit'] LOOP
    EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC, emdo_app, emdo_worker, emdo_workflow', t);
  END LOOP;
END $$;

GRANT SELECT ON emdo.finance_book_grants, emdo.finance_books, emdo.finance_entities TO emdo_policy_reader;
CREATE POLICY finance_grants_policy_reader ON emdo.finance_book_grants FOR SELECT TO emdo_policy_reader USING (true);
CREATE POLICY finance_books_policy_reader ON emdo.finance_books FOR SELECT TO emdo_policy_reader USING (true);
CREATE POLICY finance_entities_policy_reader ON emdo.finance_entities FOR SELECT TO emdo_policy_reader USING (true);

GRANT SELECT ON emdo.workspaces, emdo.workspace_entitlements TO emdo_app;
GRANT UPDATE(usage_type,timezone,locale,revision) ON emdo.workspaces TO emdo_app;
CREATE POLICY workspace_read ON emdo.workspaces FOR SELECT TO emdo_app USING (emdo.finance_v2_member(id));
CREATE POLICY workspace_update ON emdo.workspaces FOR UPDATE TO emdo_app
USING (emdo.finance_v2_member(id) AND emdo.is_household_owner(id))
WITH CHECK (emdo.finance_v2_member(id) AND emdo.is_household_owner(id));
CREATE POLICY entitlement_read ON emdo.workspace_entitlements FOR SELECT TO emdo_app USING (emdo.finance_v2_member(workspace_id));

GRANT SELECT, INSERT ON emdo.finance_entities, emdo.finance_books TO emdo_app;
CREATE POLICY entity_read ON emdo.finance_entities FOR SELECT TO emdo_app USING (
  emdo.finance_v2_member(workspace_id) AND (created_by = emdo.current_user_id() OR EXISTS (
    SELECT 1 FROM emdo.finance_books b WHERE b.workspace_id = finance_entities.workspace_id AND b.entity_id = finance_entities.id)));
CREATE POLICY entity_insert ON emdo.finance_entities FOR INSERT TO emdo_app WITH CHECK (
  emdo.finance_v2_member(workspace_id) AND created_by = emdo.current_user_id());
CREATE POLICY book_read ON emdo.finance_books FOR SELECT TO emdo_app USING (emdo.finance_book_access(workspace_id,id));
CREATE POLICY book_insert ON emdo.finance_books FOR INSERT TO emdo_app WITH CHECK (
  emdo.finance_v2_member(workspace_id) AND created_by = emdo.current_user_id() AND EXISTS (
    SELECT 1 FROM emdo.finance_entities e WHERE e.workspace_id = finance_books.workspace_id
      AND e.id = finance_books.entity_id AND e.created_by = emdo.current_user_id()));

CREATE FUNCTION emdo.initialize_finance_book() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on AS $$
BEGIN
  INSERT INTO emdo.finance_book_grants(workspace_id,book_id,user_id,role)
    VALUES (NEW.workspace_id, NEW.id, NEW.created_by, 'administrator');
  RETURN NEW;
END $$;
GRANT INSERT ON emdo.finance_book_grants TO emdo_policy_reader;
CREATE POLICY finance_grants_bootstrap ON emdo.finance_book_grants FOR INSERT TO emdo_policy_reader WITH CHECK (true);
ALTER FUNCTION emdo.initialize_finance_book() OWNER TO emdo_policy_reader;
CREATE TRIGGER initialize_finance_book AFTER INSERT ON emdo.finance_books
FOR EACH ROW EXECUTE FUNCTION emdo.initialize_finance_book();

GRANT SELECT, INSERT, UPDATE ON emdo.finance_book_grants TO emdo_app;
CREATE POLICY grants_read ON emdo.finance_book_grants FOR SELECT TO emdo_app USING (
  emdo.finance_book_access(workspace_id,book_id) AND (user_id = emdo.current_user_id() OR
    emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator'])));
CREATE POLICY grants_insert ON emdo.finance_book_grants FOR INSERT TO emdo_app WITH CHECK (
  emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator']));
CREATE POLICY grants_update ON emdo.finance_book_grants FOR UPDATE TO emdo_app USING (
  emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator'])) WITH CHECK (
  emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator']));

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['finance_ledger_accounts','finance_periods','finance_journals','finance_journal_lines'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON emdo.%I TO emdo_app',t);
    EXECUTE format('CREATE POLICY %I ON emdo.%I FOR SELECT TO emdo_app USING (emdo.finance_book_access(workspace_id,book_id))',t||'_read',t);
    EXECUTE format('CREATE POLICY %I ON emdo.%I FOR INSERT TO emdo_app WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY[''administrator'',''preparer'',''approver'']))',t||'_insert',t);
    EXECUTE format('CREATE POLICY %I ON emdo.%I FOR UPDATE TO emdo_app USING (emdo.finance_book_access(workspace_id,book_id,ARRAY[''administrator'',''preparer'',''approver''])) WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY[''administrator'',''preparer'',''approver'']))',t||'_update',t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON emdo.finance_command_receipts, emdo.finance_v2_audit TO emdo_app;
CREATE POLICY receipt_read ON emdo.finance_command_receipts FOR SELECT TO emdo_app USING (emdo.finance_v2_member(workspace_id) AND user_id = emdo.current_user_id());
CREATE POLICY receipt_insert ON emdo.finance_command_receipts FOR INSERT TO emdo_app WITH CHECK (emdo.finance_v2_member(workspace_id) AND user_id = emdo.current_user_id());
CREATE POLICY audit_read ON emdo.finance_v2_audit FOR SELECT TO emdo_app USING (
  emdo.finance_v2_member(workspace_id) AND (book_id IS NOT NULL AND emdo.finance_book_access(workspace_id,book_id)));
CREATE POLICY audit_insert ON emdo.finance_v2_audit FOR INSERT TO emdo_app WITH CHECK (
  actor_id = emdo.current_user_id() AND emdo.finance_v2_member(workspace_id) AND
  (book_id IS NULL OR emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','preparer','approver'])));

-- Re-check current authority while serializing every mutation of a book.
CREATE FUNCTION emdo.lock_finance_book_mutation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog SET row_security = on AS $$
DECLARE w uuid; b uuid;
BEGIN
  w := NEW.workspace_id; b := NEW.book_id;
  IF NOT emdo.lock_finance_book_grant(w,b) THEN RAISE EXCEPTION 'book access revoked' USING ERRCODE='42501'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.workspace_id,NEW.book_id) IS DISTINCT FROM (OLD.workspace_id,OLD.book_id) THEN
    RAISE EXCEPTION 'finance scope is immutable' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(w::text || ':' || b::text,0));
  IF NOT emdo.finance_book_access(w,b,ARRAY['administrator','preparer','approver']) THEN
    RAISE EXCEPTION 'finance authority revoked' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['finance_book_grants','finance_ledger_accounts','finance_periods','finance_journals','finance_journal_lines'] LOOP
    -- The initial grant is installed by its own trusted trigger before access exists.
    IF t <> 'finance_book_grants' THEN
      EXECUTE format('CREATE TRIGGER a_lock_book BEFORE INSERT OR UPDATE ON emdo.%I FOR EACH ROW EXECUTE FUNCTION emdo.lock_finance_book_mutation()',t);
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION emdo.enforce_finance_period() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'closed' OR (NEW.starts_on,NEW.ends_on,NEW.id) IS DISTINCT FROM (OLD.starts_on,OLD.ends_on,OLD.id) THEN
      RAISE EXCEPTION 'closed period and period dates are immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.status = 'closed' AND NOT emdo.finance_book_access(NEW.workspace_id,NEW.book_id,ARRAY['administrator','approver']) THEN
      RAISE EXCEPTION 'period close requires approval authority' USING ERRCODE='42501';
    END IF;
    IF NEW.status = 'closed' AND EXISTS(SELECT 1 FROM emdo.finance_journals WHERE period_id = NEW.id AND status = 'draft') THEN
      RAISE EXCEPTION 'period has unposted drafts' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.status <> 'open' THEN
    RAISE EXCEPTION 'period must start open' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM emdo.finance_periods p WHERE p.workspace_id=NEW.workspace_id AND p.book_id=NEW.book_id
    AND p.id <> NEW.id AND p.starts_on <= NEW.ends_on AND p.ends_on >= NEW.starts_on) THEN
    RAISE EXCEPTION 'fiscal periods overlap' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enforce_period BEFORE INSERT OR UPDATE ON emdo.finance_periods FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_period();

CREATE FUNCTION emdo.enforce_finance_journal() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE total numeric; count_lines integer;
BEGIN
  IF TG_OP = 'INSERT' AND (NEW.status <> 'draft' OR NEW.created_by IS DISTINCT FROM emdo.current_user_id()) THEN
    RAISE EXCEPTION 'journal must start draft' USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.status = 'posted' OR
    (NEW.id,NEW.effective_on,NEW.period_id,NEW.created_by,NEW.idempotency_key,NEW.payload_hash,NEW.source_reference,NEW.reversal_of)
    IS DISTINCT FROM (OLD.id,OLD.effective_on,OLD.period_id,OLD.created_by,OLD.idempotency_key,OLD.payload_hash,OLD.source_reference,OLD.reversal_of)) THEN
    RAISE EXCEPTION 'journal history is immutable' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM emdo.finance_periods p WHERE p.id=NEW.period_id AND p.book_id=NEW.book_id
    AND p.workspace_id=NEW.workspace_id AND p.status='open' AND NEW.effective_on BETWEEN p.starts_on AND p.ends_on) THEN
    RAISE EXCEPTION 'journal requires an open matching period' USING ERRCODE='23514';
  END IF;
  IF NEW.reversal_of IS NOT NULL AND NOT EXISTS(SELECT 1 FROM emdo.finance_journals j WHERE j.id=NEW.reversal_of
    AND j.workspace_id=NEW.workspace_id AND j.book_id=NEW.book_id AND j.status='posted' AND j.reversal_of IS NULL) THEN
    RAISE EXCEPTION 'invalid reversal target' USING ERRCODE='23514';
  END IF;
  IF NEW.status = 'posted' THEN
    IF NEW.reversal_of IS NOT NULL AND EXISTS (
      (SELECT account_id, side, amount, currency, native_amount, fx_rate, fx_source FROM emdo.finance_journal_lines WHERE journal_id=NEW.id
       EXCEPT ALL
       SELECT account_id, CASE side WHEN 'debit' THEN 'credit' ELSE 'debit' END, amount, currency, native_amount, fx_rate, fx_source FROM emdo.finance_journal_lines WHERE journal_id=NEW.reversal_of)
      UNION ALL
      (SELECT account_id, CASE side WHEN 'debit' THEN 'credit' ELSE 'debit' END, amount, currency, native_amount, fx_rate, fx_source FROM emdo.finance_journal_lines WHERE journal_id=NEW.reversal_of
       EXCEPT ALL
       SELECT account_id, side, amount, currency, native_amount, fx_rate, fx_source FROM emdo.finance_journal_lines WHERE journal_id=NEW.id)
    ) THEN RAISE EXCEPTION 'reversal must exactly mirror its original' USING ERRCODE='23514'; END IF;
    IF NOT emdo.finance_book_access(NEW.workspace_id,NEW.book_id,ARRAY['administrator','approver']) THEN
      RAISE EXCEPTION 'journal posting requires approval authority' USING ERRCODE='42501';
    END IF;
    SELECT count(*), sum(CASE side WHEN 'debit' THEN amount ELSE -amount END) INTO count_lines,total
      FROM emdo.finance_journal_lines WHERE journal_id=NEW.id AND workspace_id=NEW.workspace_id AND book_id=NEW.book_id;
    IF count_lines < 2 OR total IS DISTINCT FROM 0::numeric THEN
      RAISE EXCEPTION 'journal is unbalanced' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enforce_journal BEFORE INSERT OR UPDATE ON emdo.finance_journals FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_journal();

CREATE FUNCTION emdo.enforce_finance_line() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE functional text; precision integer;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.id,NEW.journal_id) IS DISTINCT FROM (OLD.id,OLD.journal_id) THEN
    RAISE EXCEPTION 'journal line identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM emdo.finance_journals WHERE id=NEW.journal_id AND status='draft') THEN
    RAISE EXCEPTION 'posted journal lines are immutable' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM emdo.finance_ledger_accounts WHERE id=NEW.account_id AND active) THEN
    RAISE EXCEPTION 'ledger account is inactive' USING ERRCODE='23514';
  END IF;
  SELECT functional_currency INTO functional FROM emdo.finance_books WHERE id=NEW.book_id;
  precision := CASE WHEN functional IN ('JPY','KRW') THEN 0 ELSE 2 END;
  IF NEW.line_number < 1 OR NEW.amount <> round(NEW.amount,precision) OR NEW.native_amount <> round(NEW.native_amount,CASE WHEN NEW.currency IN ('JPY','KRW') THEN 0 ELSE 2 END)
    OR NEW.amount <> round(NEW.native_amount * NEW.fx_rate,precision)
    OR (NEW.currency=functional AND NEW.fx_rate<>1) THEN
    RAISE EXCEPTION 'invalid monetary precision or FX conversion' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enforce_line BEFORE INSERT OR UPDATE ON emdo.finance_journal_lines FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_line();

REVOKE ALL ON FUNCTION emdo.initialize_workspace(), emdo.initialize_finance_book(),
  emdo.finance_v2_member(uuid), emdo.finance_book_access(uuid,uuid,text[]),
  emdo.lock_finance_book_mutation(), emdo.enforce_finance_period(), emdo.enforce_finance_journal(), emdo.enforce_finance_line() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.finance_v2_member(uuid), emdo.finance_book_access(uuid,uuid,text[]) TO emdo_app, emdo_policy_reader;

CREATE FUNCTION emdo.protect_finance_account() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (NEW.id,NEW.code,NEW.kind) IS DISTINCT FROM (OLD.id,OLD.code,OLD.kind) THEN
    RAISE EXCEPTION 'ledger account identity and classification are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_account BEFORE UPDATE ON emdo.finance_ledger_accounts FOR EACH ROW EXECUTE FUNCTION emdo.protect_finance_account();
CREATE FUNCTION emdo.protect_finance_grant() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (NEW.workspace_id,NEW.book_id,NEW.user_id) IS DISTINCT FROM (OLD.workspace_id,OLD.book_id,OLD.user_id) THEN
    RAISE EXCEPTION 'book grant identity is immutable' USING ERRCODE='23514';
  END IF;
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_grant BEFORE UPDATE ON emdo.finance_book_grants FOR EACH ROW EXECUTE FUNCTION emdo.protect_finance_grant();
REVOKE ALL ON FUNCTION emdo.protect_finance_account(),emdo.protect_finance_grant() FROM PUBLIC;

GRANT SELECT ON emdo.workspace_entitlements TO emdo_policy_reader;
CREATE POLICY entitlement_policy_reader ON emdo.workspace_entitlements FOR SELECT TO emdo_policy_reader USING (true);
CREATE FUNCTION emdo.check_finance_book_entitlement() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET row_security=on AS $$
DECLARE quota integer; allowed boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('finance-books:' || NEW.workspace_id::text,0));
  SELECT enabled, "limit" INTO allowed,quota FROM emdo.workspace_entitlements
    WHERE workspace_id=NEW.workspace_id AND capability='finance.books.create';
  IF NOT emdo.finance_v2_member(NEW.workspace_id) OR allowed IS DISTINCT FROM true OR
    (quota IS NOT NULL AND (SELECT count(*) FROM emdo.finance_books WHERE workspace_id=NEW.workspace_id)>=quota) THEN
    RAISE EXCEPTION 'book creation entitlement unavailable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION emdo.check_finance_book_entitlement() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.check_finance_book_entitlement() FROM PUBLIC;
CREATE TRIGGER check_book_entitlement BEFORE INSERT ON emdo.finance_books FOR EACH ROW EXECUTE FUNCTION emdo.check_finance_book_entitlement();

-- Narrow definer lock avoids requiring a preparer/viewer to administer grants.
GRANT UPDATE ON emdo.finance_book_grants TO emdo_policy_reader;
CREATE POLICY finance_grants_lock_reader ON emdo.finance_book_grants FOR UPDATE TO emdo_policy_reader USING (true) WITH CHECK (true);
CREATE FUNCTION emdo.lock_finance_book_grant(w uuid,b uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
  IF NOT emdo.finance_v2_member(w) THEN RETURN false; END IF;
  PERFORM 1 FROM emdo.finance_book_grants WHERE workspace_id=w AND book_id=b
    AND user_id=emdo.current_user_id() AND revoked_at IS NULL FOR SHARE;
  RETURN FOUND;
END $$;
ALTER FUNCTION emdo.lock_finance_book_grant(uuid,uuid) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.lock_finance_book_grant(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.lock_finance_book_grant(uuid,uuid) TO emdo_app;
