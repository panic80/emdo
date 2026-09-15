CREATE TABLE "emdo"."finance_fx_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"from_currency" text NOT NULL,
	"to_currency" text NOT NULL,
	"rate" numeric(38, 12) NOT NULL,
	"source_reference" text NOT NULL,
	CONSTRAINT "finance_fx_observations_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_fx_observations_valid" CHECK (rate>0 and rate<>'NaN'::numeric and from_currency<>to_currency and from_currency in ('CAD','USD','MXN','EUR','JPY','KRW') and to_currency in ('CAD','USD','MXN','EUR','JPY','KRW'))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_instrument_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"scheme" text NOT NULL,
	"value" text NOT NULL,
	"namespace" text NOT NULL,
	CONSTRAINT "finance_instrument_identifiers_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_instrument_identifiers_valid" CHECK (scheme in ('ISIN','CUSIP','SEDOL','ticker','provider'))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"quantity_unit" text NOT NULL,
	"valuation_multiplier" numeric(38, 12) NOT NULL,
	CONSTRAINT "finance_instruments_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_instruments_valid" CHECK (kind in ('equity','fund','bond','option','future','other') and quantity_unit in ('share','unit','face-value','contract') and valuation_multiplier>0 and valuation_multiplier<>'NaN'::numeric)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_investment_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"effective_on" date NOT NULL,
	"quantity" numeric(38, 12) NOT NULL,
	"journal_id" uuid NOT NULL,
	"source_reference" text NOT NULL,
	CONSTRAINT "finance_investment_movements_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_investment_movements_valid" CHECK (quantity<>0 and quantity<>'NaN'::numeric)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_investment_openings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"quantity" numeric(38, 12) NOT NULL,
	"evidence_id" uuid NOT NULL,
	"source_reference" text NOT NULL,
	CONSTRAINT "finance_investment_openings_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_investment_openings_valid" CHECK (quantity<>'NaN'::numeric)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_investment_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"price" numeric(38, 12) NOT NULL,
	"currency" text NOT NULL,
	"source_reference" text NOT NULL,
	CONSTRAINT "finance_investment_prices_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_investment_prices_valid" CHECK (price>=0 and price<>'NaN'::numeric and currency in ('CAD','USD','MXN','EUR','JPY','KRW'))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_observed_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"quantity" numeric(38, 12) NOT NULL,
	"reported_market_value" numeric(38, 12),
	"currency" text,
	"evidence_id" uuid NOT NULL,
	"source_row" integer NOT NULL,
	CONSTRAINT "finance_observed_positions_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_observed_positions_valid" CHECK (quantity<>'NaN'::numeric and source_row>0 and (reported_market_value is null or (reported_market_value<>'NaN'::numeric and currency is not null)) and (currency is null or currency in ('CAD','USD','MXN','EUR','JPY','KRW')))
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_fx_observations" ADD CONSTRAINT "finance_fx_observations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_fx_observations" ADD CONSTRAINT "finance_fx_observations_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_instrument_identifiers" ADD CONSTRAINT "finance_instrument_identifiers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_instrument_identifiers" ADD CONSTRAINT "finance_instrument_identifiers_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_instrument_identifiers" ADD CONSTRAINT "finance_instrument_identifiers_instrumentId" FOREIGN KEY ("workspace_id","book_id","instrument_id") REFERENCES "emdo"."finance_instruments"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_instruments" ADD CONSTRAINT "finance_instruments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_instruments" ADD CONSTRAINT "finance_instruments_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_movements" ADD CONSTRAINT "finance_investment_movements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_movements" ADD CONSTRAINT "finance_investment_movements_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_movements" ADD CONSTRAINT "finance_investment_movements_financialAccountId" FOREIGN KEY ("workspace_id","book_id","financial_account_id") REFERENCES "emdo"."finance_financial_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_movements" ADD CONSTRAINT "finance_investment_movements_instrumentId" FOREIGN KEY ("workspace_id","book_id","instrument_id") REFERENCES "emdo"."finance_instruments"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_movements" ADD CONSTRAINT "finance_investment_movements_journalId" FOREIGN KEY ("workspace_id","book_id","journal_id") REFERENCES "emdo"."finance_journals"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_openings" ADD CONSTRAINT "finance_investment_openings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_openings" ADD CONSTRAINT "finance_investment_openings_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_openings" ADD CONSTRAINT "finance_investment_openings_financialAccountId" FOREIGN KEY ("workspace_id","book_id","financial_account_id") REFERENCES "emdo"."finance_financial_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_openings" ADD CONSTRAINT "finance_investment_openings_instrumentId" FOREIGN KEY ("workspace_id","book_id","instrument_id") REFERENCES "emdo"."finance_instruments"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_openings" ADD CONSTRAINT "finance_investment_openings_evidenceId" FOREIGN KEY ("workspace_id","book_id","evidence_id") REFERENCES "emdo"."finance_book_evidence"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_prices" ADD CONSTRAINT "finance_investment_prices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_prices" ADD CONSTRAINT "finance_investment_prices_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_prices" ADD CONSTRAINT "finance_investment_prices_instrumentId" FOREIGN KEY ("workspace_id","book_id","instrument_id") REFERENCES "emdo"."finance_instruments"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_observed_positions" ADD CONSTRAINT "finance_observed_positions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_observed_positions" ADD CONSTRAINT "finance_observed_positions_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_observed_positions" ADD CONSTRAINT "finance_observed_positions_financialAccountId" FOREIGN KEY ("workspace_id","book_id","financial_account_id") REFERENCES "emdo"."finance_financial_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_observed_positions" ADD CONSTRAINT "finance_observed_positions_instrumentId" FOREIGN KEY ("workspace_id","book_id","instrument_id") REFERENCES "emdo"."finance_instruments"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_observed_positions" ADD CONSTRAINT "finance_observed_positions_evidenceId" FOREIGN KEY ("workspace_id","book_id","evidence_id") REFERENCES "emdo"."finance_book_evidence"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_fx_observations_book_lookup" ON "emdo"."finance_fx_observations" USING btree ("workspace_id","book_id");--> statement-breakpoint
CREATE INDEX "finance_instrument_identifiers_book_lookup" ON "emdo"."finance_instrument_identifiers" USING btree ("workspace_id","book_id");--> statement-breakpoint
CREATE INDEX "finance_instruments_book_lookup" ON "emdo"."finance_instruments" USING btree ("workspace_id","book_id");--> statement-breakpoint
CREATE INDEX "finance_investment_movements_book_lookup" ON "emdo"."finance_investment_movements" USING btree ("workspace_id","book_id");--> statement-breakpoint
CREATE INDEX "finance_investment_openings_book_lookup" ON "emdo"."finance_investment_openings" USING btree ("workspace_id","book_id");--> statement-breakpoint
CREATE INDEX "finance_investment_prices_book_lookup" ON "emdo"."finance_investment_prices" USING btree ("workspace_id","book_id");--> statement-breakpoint
CREATE INDEX "finance_observed_positions_book_lookup" ON "emdo"."finance_observed_positions" USING btree ("workspace_id","book_id");
-- Investment evidence is append-only and uses the same explicit book authority.
DO $$ DECLARE t text; approved boolean; BEGIN
  FOREACH t IN ARRAY ARRAY['finance_instruments','finance_instrument_identifiers','finance_investment_openings','finance_investment_movements','finance_observed_positions','finance_investment_prices','finance_fx_observations'] LOOP
    EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow',t);
    EXECUTE format('GRANT SELECT,INSERT ON emdo.%I TO emdo_app',t);
    EXECUTE format('CREATE POLICY %I ON emdo.%I FOR SELECT TO emdo_app USING (emdo.finance_book_access(workspace_id,book_id))',t||'_read',t);
    approved:=t IN ('finance_investment_openings','finance_investment_movements');
    EXECUTE format('CREATE POLICY %I ON emdo.%I FOR INSERT TO emdo_app WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY[%s]))',t||'_insert',t,CASE WHEN approved THEN '''administrator'',''approver''' ELSE '''administrator'',''preparer'',''approver''' END);
    EXECUTE format('CREATE TRIGGER a_lock_book BEFORE INSERT ON emdo.%I FOR EACH ROW EXECUTE FUNCTION emdo.lock_finance_book_mutation()',t);
  END LOOP;
END $$;
CREATE FUNCTION emdo.check_investment_account() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM emdo.finance_financial_accounts WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.financial_account_id AND active AND kind='brokerage') THEN
    RAISE EXCEPTION 'investment positions require an active brokerage account' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_investment_account BEFORE INSERT ON emdo.finance_investment_openings FOR EACH ROW EXECUTE FUNCTION emdo.check_investment_account();
CREATE TRIGGER check_investment_account BEFORE INSERT ON emdo.finance_investment_movements FOR EACH ROW EXECUTE FUNCTION emdo.check_investment_account();
CREATE TRIGGER check_investment_account BEFORE INSERT ON emdo.finance_observed_positions FOR EACH ROW EXECUTE FUNCTION emdo.check_investment_account();
CREATE FUNCTION emdo.check_investment_movement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM emdo.finance_journals WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.journal_id AND status='posted' AND effective_on=NEW.effective_on) THEN
    RAISE EXCEPTION 'investment movement requires a matching posted journal date' USING ERRCODE='23514'; END IF;
  IF length(trim(NEW.source_reference))=0 THEN RAISE EXCEPTION 'investment movement requires provenance' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_investment_movement BEFORE INSERT ON emdo.finance_investment_movements FOR EACH ROW EXECUTE FUNCTION emdo.check_investment_movement();
REVOKE ALL ON FUNCTION emdo.check_investment_account(),emdo.check_investment_movement() FROM PUBLIC;
CREATE FUNCTION emdo.check_instrument_identifier() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF length(trim(NEW.value))=0 OR length(trim(NEW.namespace))=0 THEN RAISE EXCEPTION 'instrument identifier requires a value and namespace' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM emdo.finance_instrument_identifiers WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND scheme=NEW.scheme AND namespace=NEW.namespace AND value=NEW.value) THEN
    RAISE EXCEPTION 'instrument identifier is already mapped in this book' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_instrument_identifier BEFORE INSERT ON emdo.finance_instrument_identifiers FOR EACH ROW EXECUTE FUNCTION emdo.check_instrument_identifier();
REVOKE ALL ON FUNCTION emdo.check_instrument_identifier() FROM PUBLIC;
