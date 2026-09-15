-- 0057 normalized finance book planning.
--
-- Budgets and forecast snapshots are immutable, book-scoped records. Actuals
-- are read from posted journal lines only; reviewed inputs are the sole source
-- for future assumptions.

CREATE TABLE "emdo"."finance_budget_lines" (
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"period_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(38, 12) NOT NULL,
	CONSTRAINT "finance_budget_lines_pk" PRIMARY KEY("workspace_id","book_id","budget_id","revision","period_id","account_id","currency"),
	CONSTRAINT "finance_budget_lines_currency" CHECK ("emdo"."finance_budget_lines"."currency" in ('CAD','USD','MXN','EUR','KRW','JPY')),
	CONSTRAINT "finance_budget_lines_amount" CHECK ("emdo"."finance_budget_lines"."amount" <> 'NaN'::numeric and "emdo"."finance_budget_lines"."amount" = round("emdo"."finance_budget_lines"."amount", case when "emdo"."finance_budget_lines"."currency" in ('JPY','KRW') then 0 else 2 end))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_budget_revisions" (
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"name" text NOT NULL,
	"functional_currency" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_budget_revisions_pk" PRIMARY KEY("workspace_id","book_id","budget_id","revision"),
	CONSTRAINT "finance_budget_revisions_revision" CHECK ("emdo"."finance_budget_revisions"."revision" > 0 and "emdo"."finance_budget_revisions"."revision" = trunc("emdo"."finance_budget_revisions"."revision")),
	CONSTRAINT "finance_budget_revisions_currency" CHECK ("emdo"."finance_budget_revisions"."functional_currency" in ('CAD','USD','MXN','EUR','KRW','JPY'))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_forecast_assumptions" (
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"forecast_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"period_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(38, 12) NOT NULL,
	"label" text NOT NULL,
	"source_reference" text NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "finance_forecast_assumptions_pk" PRIMARY KEY("workspace_id","book_id","forecast_id","revision","period_id","account_id","currency"),
	CONSTRAINT "finance_forecast_assumptions_currency" CHECK ("emdo"."finance_forecast_assumptions"."currency" in ('CAD','USD','MXN','EUR','KRW','JPY')),
	CONSTRAINT "finance_forecast_assumptions_amount" CHECK ("emdo"."finance_forecast_assumptions"."amount" <> 'NaN'::numeric and "emdo"."finance_forecast_assumptions"."amount" = round("emdo"."finance_forecast_assumptions"."amount", case when "emdo"."finance_forecast_assumptions"."currency" in ('JPY','KRW') then 0 else 2 end))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_forecast_lines" (
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"forecast_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"period_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"budget_amount" numeric(38, 12) NOT NULL,
	"posted_actual_amount" numeric(38, 12) NOT NULL,
	"forecast_amount" numeric(38, 12),
	"basis" text NOT NULL,
	"actual_sign_basis" text NOT NULL,
	"label" text,
	CONSTRAINT "finance_forecast_lines_pk" PRIMARY KEY("workspace_id","book_id","forecast_id","revision","period_id","account_id","currency"),
	CONSTRAINT "finance_forecast_lines_currency" CHECK ("emdo"."finance_forecast_lines"."currency" in ('CAD','USD','MXN','EUR','KRW','JPY')),
	CONSTRAINT "finance_forecast_lines_amount" CHECK ("emdo"."finance_forecast_lines"."budget_amount" <> 'NaN'::numeric and "emdo"."finance_forecast_lines"."posted_actual_amount" <> 'NaN'::numeric and ("emdo"."finance_forecast_lines"."forecast_amount" is null or "emdo"."finance_forecast_lines"."forecast_amount" <> 'NaN'::numeric)),
	CONSTRAINT "finance_forecast_lines_basis" CHECK ("emdo"."finance_forecast_lines"."basis" in ('posted-actual','reviewed-assumption','unavailable') and (("emdo"."finance_forecast_lines"."basis" = 'unavailable' and "emdo"."finance_forecast_lines"."forecast_amount" is null and "emdo"."finance_forecast_lines"."label" = 'future-assumption-unavailable') or ("emdo"."finance_forecast_lines"."basis" <> 'unavailable' and "emdo"."finance_forecast_lines"."forecast_amount" is not null and "emdo"."finance_forecast_lines"."label" is null))),
	CONSTRAINT "finance_forecast_lines_sign_basis" CHECK ("emdo"."finance_forecast_lines"."actual_sign_basis" in ('debit-minus-credit','credit-minus-debit'))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_forecast_snapshots" (
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"forecast_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"budget_id" uuid NOT NULL,
	"budget_revision" integer NOT NULL,
	"functional_currency" text NOT NULL,
	"as_of" date NOT NULL,
	"opening_status" text NOT NULL,
	"opening_amount" numeric(38, 12),
	"opening_currency" text,
	"opening_source_reference" text,
	"opening_reviewed_by" uuid,
	"opening_reviewed_at" timestamp with time zone,
	"future_assumption_status" text NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_forecast_snapshots_pk" PRIMARY KEY("workspace_id","book_id","forecast_id","revision"),
	CONSTRAINT "finance_forecast_snapshots_revision" CHECK ("emdo"."finance_forecast_snapshots"."revision" > 0 and "emdo"."finance_forecast_snapshots"."revision" = trunc("emdo"."finance_forecast_snapshots"."revision") and "emdo"."finance_forecast_snapshots"."budget_revision" > 0 and "emdo"."finance_forecast_snapshots"."budget_revision" = trunc("emdo"."finance_forecast_snapshots"."budget_revision")),
	CONSTRAINT "finance_forecast_snapshots_currency" CHECK ("emdo"."finance_forecast_snapshots"."functional_currency" in ('CAD','USD','MXN','EUR','KRW','JPY')),
	CONSTRAINT "finance_forecast_snapshots_opening" CHECK (("emdo"."finance_forecast_snapshots"."opening_status" = 'unavailable' and "emdo"."finance_forecast_snapshots"."opening_amount" is null and "emdo"."finance_forecast_snapshots"."opening_currency" is null and "emdo"."finance_forecast_snapshots"."opening_source_reference" is null and "emdo"."finance_forecast_snapshots"."opening_reviewed_by" is null and "emdo"."finance_forecast_snapshots"."opening_reviewed_at" is null) or ("emdo"."finance_forecast_snapshots"."opening_status" = 'available' and "emdo"."finance_forecast_snapshots"."opening_amount" is not null and "emdo"."finance_forecast_snapshots"."opening_currency" is not null and "emdo"."finance_forecast_snapshots"."opening_source_reference" is not null and "emdo"."finance_forecast_snapshots"."opening_reviewed_by" is not null and "emdo"."finance_forecast_snapshots"."opening_reviewed_at" is not null)),
	CONSTRAINT "finance_forecast_snapshots_status" CHECK ("emdo"."finance_forecast_snapshots"."opening_status" in ('available','unavailable') and "emdo"."finance_forecast_snapshots"."future_assumption_status" in ('not-applicable','provided','partial','unavailable') and jsonb_typeof("emdo"."finance_forecast_snapshots"."labels") = 'array')
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_budget_lines" ADD CONSTRAINT "finance_budget_lines_revision" FOREIGN KEY ("workspace_id","book_id","budget_id","revision") REFERENCES "emdo"."finance_budget_revisions"("workspace_id","book_id","budget_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_budget_lines" ADD CONSTRAINT "finance_budget_lines_period" FOREIGN KEY ("workspace_id","book_id","period_id") REFERENCES "emdo"."finance_periods"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_budget_lines" ADD CONSTRAINT "finance_budget_lines_account" FOREIGN KEY ("workspace_id","book_id","account_id") REFERENCES "emdo"."finance_ledger_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_budget_revisions" ADD CONSTRAINT "finance_budget_revisions_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_budget_revisions" ADD CONSTRAINT "finance_budget_revisions_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_forecast_assumptions" ADD CONSTRAINT "finance_forecast_assumptions_reviewed_by_auth_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_forecast_assumptions" ADD CONSTRAINT "finance_forecast_assumptions_snapshot" FOREIGN KEY ("workspace_id","book_id","forecast_id","revision") REFERENCES "emdo"."finance_forecast_snapshots"("workspace_id","book_id","forecast_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_forecast_assumptions" ADD CONSTRAINT "finance_forecast_assumptions_period" FOREIGN KEY ("workspace_id","book_id","period_id") REFERENCES "emdo"."finance_periods"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_forecast_assumptions" ADD CONSTRAINT "finance_forecast_assumptions_account" FOREIGN KEY ("workspace_id","book_id","account_id") REFERENCES "emdo"."finance_ledger_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_forecast_lines" ADD CONSTRAINT "finance_forecast_lines_snapshot" FOREIGN KEY ("workspace_id","book_id","forecast_id","revision") REFERENCES "emdo"."finance_forecast_snapshots"("workspace_id","book_id","forecast_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_forecast_lines" ADD CONSTRAINT "finance_forecast_lines_period" FOREIGN KEY ("workspace_id","book_id","period_id") REFERENCES "emdo"."finance_periods"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_forecast_lines" ADD CONSTRAINT "finance_forecast_lines_account" FOREIGN KEY ("workspace_id","book_id","account_id") REFERENCES "emdo"."finance_ledger_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_forecast_snapshots" ADD CONSTRAINT "finance_forecast_snapshots_opening_reviewed_by_auth_users_id_fk" FOREIGN KEY ("opening_reviewed_by") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_forecast_snapshots" ADD CONSTRAINT "finance_forecast_snapshots_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_forecast_snapshots" ADD CONSTRAINT "finance_forecast_snapshots_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_forecast_snapshots" ADD CONSTRAINT "finance_forecast_snapshots_budget" FOREIGN KEY ("workspace_id","book_id","budget_id","budget_revision") REFERENCES "emdo"."finance_budget_revisions"("workspace_id","book_id","budget_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "finance_budget_lines_period_account" ON "emdo"."finance_budget_lines" USING btree ("workspace_id","book_id","period_id","account_id");
--> statement-breakpoint
CREATE INDEX "finance_budget_revisions_book" ON "emdo"."finance_budget_revisions" USING btree ("workspace_id","book_id","budget_id","revision");
--> statement-breakpoint
CREATE INDEX "finance_forecast_assumptions_source" ON "emdo"."finance_forecast_assumptions" USING btree ("workspace_id","book_id","forecast_id","revision");
--> statement-breakpoint
CREATE INDEX "finance_forecast_snapshots_book" ON "emdo"."finance_forecast_snapshots" USING btree ("workspace_id","book_id","forecast_id","revision");
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'finance_budget_revisions',
    'finance_budget_lines',
    'finance_forecast_snapshots',
    'finance_forecast_lines',
    'finance_forecast_assumptions'
  ] LOOP
    EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow', table_name);
    EXECUTE format('GRANT SELECT,INSERT ON emdo.%I TO emdo_app', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON emdo.%I FOR SELECT TO emdo_app USING (emdo.finance_book_access(workspace_id,book_id))',
      table_name || '_read', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON emdo.%I FOR INSERT TO emdo_app WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY[''administrator'',''preparer'',''approver'']))',
      table_name || '_insert', table_name
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION emdo.enforce_finance_planning_book_currency()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog SET row_security = on AS $$
DECLARE functional_currency text;
BEGIN
  SELECT b.functional_currency INTO functional_currency
    FROM emdo.finance_books b
   WHERE b.workspace_id = NEW.workspace_id AND b.id = NEW.book_id;
  IF functional_currency IS NULL THEN
    RAISE EXCEPTION 'finance-planning-book-forbidden' USING ERRCODE='42501';
  END IF;
  -- A trigger record has the attached table's shape. Guard field access in a
  -- separate branch: boolean AND still prepares references to absent fields.
  IF TG_TABLE_NAME IN ('finance_budget_revisions','finance_forecast_snapshots') THEN
    IF NEW.functional_currency IS DISTINCT FROM functional_currency THEN
      RAISE EXCEPTION 'finance-planning-currency-mismatch' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.currency IS DISTINCT FROM functional_currency THEN
      RAISE EXCEPTION 'finance-planning-currency-mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'finance_forecast_snapshots' THEN
    IF NEW.opening_status = 'available' AND NEW.opening_currency IS DISTINCT FROM functional_currency THEN
      RAISE EXCEPTION 'finance-planning-opening-currency-mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'finance_forecast_assumptions' THEN
    IF NEW.reviewed_by IS DISTINCT FROM emdo.current_user_id() THEN
      RAISE EXCEPTION 'finance-planning-reviewer-mismatch' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION emdo.enforce_finance_planning_book_currency() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.enforce_finance_planning_book_currency() FROM PUBLIC;

CREATE TRIGGER finance_budget_revisions_scope
  BEFORE INSERT ON emdo.finance_budget_revisions
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_planning_book_currency();
CREATE TRIGGER finance_budget_lines_scope
  BEFORE INSERT ON emdo.finance_budget_lines
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_planning_book_currency();
CREATE TRIGGER finance_forecast_snapshots_scope
  BEFORE INSERT ON emdo.finance_forecast_snapshots
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_planning_book_currency();
CREATE TRIGGER finance_forecast_lines_scope
  BEFORE INSERT ON emdo.finance_forecast_lines
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_planning_book_currency();
CREATE TRIGGER finance_forecast_assumptions_scope
  BEFORE INSERT ON emdo.finance_forecast_assumptions
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_planning_book_currency();

CREATE OR REPLACE FUNCTION emdo.reject_finance_planning_history_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'finance-planning-history-immutable' USING ERRCODE='23514';
END $$;
ALTER FUNCTION emdo.reject_finance_planning_history_mutation() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.reject_finance_planning_history_mutation() FROM PUBLIC;

CREATE TRIGGER finance_budget_revisions_immutable
  BEFORE UPDATE OR DELETE ON emdo.finance_budget_revisions
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_planning_history_mutation();
CREATE TRIGGER finance_budget_lines_immutable
  BEFORE UPDATE OR DELETE ON emdo.finance_budget_lines
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_planning_history_mutation();
CREATE TRIGGER finance_forecast_snapshots_immutable
  BEFORE UPDATE OR DELETE ON emdo.finance_forecast_snapshots
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_planning_history_mutation();
CREATE TRIGGER finance_forecast_lines_immutable
  BEFORE UPDATE OR DELETE ON emdo.finance_forecast_lines
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_planning_history_mutation();
CREATE TRIGGER finance_forecast_assumptions_immutable
  BEFORE UPDATE OR DELETE ON emdo.finance_forecast_assumptions
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_planning_history_mutation();
