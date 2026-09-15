CREATE TABLE "emdo"."finance_investment_corporate_action_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"source_lot_id" uuid NOT NULL,
	"successor_lot_id" uuid,
	"financial_account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"source_original_quantity" numeric(38, 12) NOT NULL,
	"source_disposed_quantity" numeric(38, 12) NOT NULL,
	"source_remaining_quantity" numeric(38, 12) NOT NULL,
	"source_native_cost_basis" numeric(38, 12) NOT NULL,
	"source_functional_cost_basis" numeric(38, 12) NOT NULL,
	"successor_quantity" numeric(38, 12) NOT NULL,
	"successor_native_cost_basis" numeric(38, 12) NOT NULL,
	"successor_functional_cost_basis" numeric(38, 12) NOT NULL,
	CONSTRAINT "finance_investment_corporate_action_effects_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_investment_corporate_action_effects_identity" UNIQUE("workspace_id","book_id","action_id","source_lot_id"),
	CONSTRAINT "finance_investment_corporate_action_effects_valid" CHECK ("emdo"."finance_investment_corporate_action_effects"."source_original_quantity">0 and "emdo"."finance_investment_corporate_action_effects"."source_disposed_quantity">=0 and "emdo"."finance_investment_corporate_action_effects"."source_remaining_quantity">=0 and "emdo"."finance_investment_corporate_action_effects"."source_native_cost_basis">=0 and "emdo"."finance_investment_corporate_action_effects"."source_functional_cost_basis">=0 and "emdo"."finance_investment_corporate_action_effects"."successor_quantity">=0 and "emdo"."finance_investment_corporate_action_effects"."successor_native_cost_basis">=0 and "emdo"."finance_investment_corporate_action_effects"."successor_functional_cost_basis">=0 and ("emdo"."finance_investment_corporate_action_effects"."successor_lot_id" is null and "emdo"."finance_investment_corporate_action_effects"."successor_quantity"=0 or "emdo"."finance_investment_corporate_action_effects"."successor_lot_id" is not null and "emdo"."finance_investment_corporate_action_effects"."successor_quantity">0) and "emdo"."finance_investment_corporate_action_effects"."source_original_quantity"<>'NaN'::numeric and "emdo"."finance_investment_corporate_action_effects"."source_disposed_quantity"<>'NaN'::numeric and "emdo"."finance_investment_corporate_action_effects"."source_remaining_quantity"<>'NaN'::numeric and "emdo"."finance_investment_corporate_action_effects"."source_native_cost_basis"<>'NaN'::numeric and "emdo"."finance_investment_corporate_action_effects"."source_functional_cost_basis"<>'NaN'::numeric and "emdo"."finance_investment_corporate_action_effects"."successor_quantity"<>'NaN'::numeric and "emdo"."finance_investment_corporate_action_effects"."successor_native_cost_basis"<>'NaN'::numeric and "emdo"."finance_investment_corporate_action_effects"."successor_functional_cost_basis"<>'NaN'::numeric)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_investment_corporate_action_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"source_lot_id" uuid NOT NULL,
	"successor_lot_key" text NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"acquired_on" date NOT NULL,
	"acquisition_sequence" integer NOT NULL,
	"quantity" numeric(38, 12) NOT NULL,
	"native_cost" numeric(38, 12) NOT NULL,
	"functional_cost" numeric(38, 12) NOT NULL,
	"native_currency" text NOT NULL,
	"functional_currency" text NOT NULL,
	"source_reference" text NOT NULL,
	CONSTRAINT "finance_investment_corporate_action_lots_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_investment_corporate_action_lots_identity" UNIQUE("workspace_id","book_id","action_id","source_lot_id"),
	CONSTRAINT "finance_investment_corporate_action_lots_key" UNIQUE("workspace_id","book_id","successor_lot_key"),
	CONSTRAINT "finance_investment_corporate_action_lots_valid" CHECK ("emdo"."finance_investment_corporate_action_lots"."quantity">0 and "emdo"."finance_investment_corporate_action_lots"."quantity"<>'NaN'::numeric and "emdo"."finance_investment_corporate_action_lots"."native_cost">=0 and "emdo"."finance_investment_corporate_action_lots"."native_cost"<>'NaN'::numeric and "emdo"."finance_investment_corporate_action_lots"."functional_cost">=0 and "emdo"."finance_investment_corporate_action_lots"."functional_cost"<>'NaN'::numeric and "emdo"."finance_investment_corporate_action_lots"."acquisition_sequence">=0 and "emdo"."finance_investment_corporate_action_lots"."native_currency" in ('CAD','USD','MXN','EUR','JPY','KRW') and "emdo"."finance_investment_corporate_action_lots"."functional_currency" in ('CAD','USD','MXN','EUR','JPY','KRW') and length(trim("emdo"."finance_investment_corporate_action_lots"."successor_lot_key"))>0 and length(trim("emdo"."finance_investment_corporate_action_lots"."source_reference"))>0)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_investment_corporate_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"effective_on" date NOT NULL,
	"numerator" numeric(38, 12) NOT NULL,
	"denominator" numeric(38, 12) NOT NULL,
	"fractional_treatment" text NOT NULL,
	"evidence_id" uuid NOT NULL,
	"source_reference" text NOT NULL,
	"cash_in_lieu" jsonb,
	"source_as_of" date NOT NULL,
	"source_boundary" text NOT NULL,
	"source_revision" integer NOT NULL,
	"source_snapshot_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"status" text DEFAULT 'committed' NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "finance_investment_corporate_actions_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_investment_corporate_actions_idempotency" UNIQUE("workspace_id","book_id","idempotency_key"),
	CONSTRAINT "finance_investment_corporate_actions_valid" CHECK ("emdo"."finance_investment_corporate_actions"."action_type" in ('split','reverse-split') and "emdo"."finance_investment_corporate_actions"."numerator">0 and "emdo"."finance_investment_corporate_actions"."denominator">0 and "emdo"."finance_investment_corporate_actions"."fractional_treatment" in ('unknown','retain','cash-in-lieu') and "emdo"."finance_investment_corporate_actions"."source_as_of"="emdo"."finance_investment_corporate_actions"."effective_on" and "emdo"."finance_investment_corporate_actions"."source_boundary"='immediately-before-action' and "emdo"."finance_investment_corporate_actions"."source_revision">=0 and "emdo"."finance_investment_corporate_actions"."status"='committed' and "emdo"."finance_investment_corporate_actions"."source_snapshot_hash" ~ '^[a-f0-9]{64}$' and length(trim("emdo"."finance_investment_corporate_actions"."idempotency_key"))>0 and "emdo"."finance_investment_corporate_actions"."command_hash" ~ '^[a-f0-9]{64}$' and ("emdo"."finance_investment_corporate_actions"."cash_in_lieu" is null or jsonb_typeof("emdo"."finance_investment_corporate_actions"."cash_in_lieu")='object'))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_investment_lot_revisions" (
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_investment_lot_revisions_workspace_id_book_id_pk" PRIMARY KEY("workspace_id","book_id"),
	CONSTRAINT "finance_investment_lot_revisions_valid" CHECK ("emdo"."finance_investment_lot_revisions"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_corporate_action_effects" ADD CONSTRAINT "finance_investment_corporate_action_effects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_corporate_action_effects" ADD CONSTRAINT "finance_investment_corporate_action_effects_action" FOREIGN KEY ("workspace_id","book_id","action_id") REFERENCES "emdo"."finance_investment_corporate_actions"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_corporate_action_effects" ADD CONSTRAINT "finance_investment_corporate_action_effects_source" FOREIGN KEY ("workspace_id","book_id","source_lot_id") REFERENCES "emdo"."finance_investment_lots"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_corporate_action_effects" ADD CONSTRAINT "finance_investment_corporate_action_effects_successor" FOREIGN KEY ("workspace_id","book_id","successor_lot_id") REFERENCES "emdo"."finance_investment_corporate_action_lots"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_corporate_action_lots" ADD CONSTRAINT "finance_investment_corporate_action_lots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_corporate_action_lots" ADD CONSTRAINT "finance_investment_corporate_action_lots_action" FOREIGN KEY ("workspace_id","book_id","action_id") REFERENCES "emdo"."finance_investment_corporate_actions"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_corporate_action_lots" ADD CONSTRAINT "finance_investment_corporate_action_lots_source" FOREIGN KEY ("workspace_id","book_id","source_lot_id") REFERENCES "emdo"."finance_investment_lots"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_corporate_action_lots" ADD CONSTRAINT "finance_investment_corporate_action_lots_account" FOREIGN KEY ("workspace_id","book_id","financial_account_id") REFERENCES "emdo"."finance_financial_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_corporate_action_lots" ADD CONSTRAINT "finance_investment_corporate_action_lots_instrument" FOREIGN KEY ("workspace_id","book_id","instrument_id") REFERENCES "emdo"."finance_instruments"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_corporate_actions" ADD CONSTRAINT "finance_investment_corporate_actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_corporate_actions" ADD CONSTRAINT "finance_investment_corporate_actions_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_corporate_actions" ADD CONSTRAINT "finance_investment_corporate_actions_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_corporate_actions" ADD CONSTRAINT "finance_investment_corporate_actions_account" FOREIGN KEY ("workspace_id","book_id","financial_account_id") REFERENCES "emdo"."finance_financial_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_corporate_actions" ADD CONSTRAINT "finance_investment_corporate_actions_instrument" FOREIGN KEY ("workspace_id","book_id","instrument_id") REFERENCES "emdo"."finance_instruments"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_corporate_actions" ADD CONSTRAINT "finance_investment_corporate_actions_evidence" FOREIGN KEY ("workspace_id","book_id","evidence_id") REFERENCES "emdo"."finance_book_evidence"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_lot_revisions" ADD CONSTRAINT "finance_investment_lot_revisions_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_investment_corporate_action_effects_lookup" ON "emdo"."finance_investment_corporate_action_effects" USING btree ("workspace_id","book_id","action_id");--> statement-breakpoint
CREATE INDEX "finance_investment_corporate_action_lots_lookup" ON "emdo"."finance_investment_corporate_action_lots" USING btree ("workspace_id","book_id","financial_account_id","instrument_id");--> statement-breakpoint
CREATE INDEX "finance_investment_corporate_actions_lookup" ON "emdo"."finance_investment_corporate_actions" USING btree ("workspace_id","book_id","effective_on","financial_account_id","instrument_id");--> statement-breakpoint

-- Corporate-action persistence is deliberately append-only. Source lots and
-- disposal rows remain the accounting history; this projection resolves the
-- active quantity/cost basis for every downstream lot read.
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='emdo_finance_corporate_action_executor') THEN
  CREATE ROLE emdo_finance_corporate_action_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
 END IF;
 IF EXISTS (SELECT FROM pg_roles WHERE rolname='emdo_finance_corporate_action_executor' AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb)) OR
    EXISTS (SELECT FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='emdo_finance_corporate_action_executor') OR roleid=(SELECT oid FROM pg_roles WHERE rolname='emdo_finance_corporate_action_executor')) THEN
  RAISE EXCEPTION 'unsafe corporate action executor role';
 END IF;
END $$;
GRANT USAGE ON SCHEMA emdo TO emdo_finance_corporate_action_executor;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['finance_investment_lot_revisions','finance_investment_corporate_actions','finance_investment_corporate_action_lots','finance_investment_corporate_action_effects'] LOOP
  EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow',t);
 END LOOP;
END $$;

GRANT SELECT ON emdo.finance_investment_lot_revisions TO emdo_app;
GRANT SELECT,INSERT,UPDATE ON emdo.finance_investment_lot_revisions TO emdo_finance_corporate_action_executor;
CREATE POLICY finance_investment_lot_revisions_app_read ON emdo.finance_investment_lot_revisions
 FOR SELECT TO emdo_app USING (emdo.finance_book_access(workspace_id,book_id));
CREATE POLICY finance_investment_lot_revisions_executor ON emdo.finance_investment_lot_revisions
	 TO emdo_finance_corporate_action_executor USING (true) WITH CHECK (true);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['finance_investment_corporate_actions','finance_investment_corporate_action_lots','finance_investment_corporate_action_effects'] LOOP
  EXECUTE format('GRANT SELECT,INSERT ON emdo.%I TO emdo_app',t);
  EXECUTE format('CREATE POLICY %I ON emdo.%I FOR SELECT TO emdo_app USING (emdo.finance_book_access(workspace_id,book_id))',t||'_app_read',t);
  EXECUTE format('CREATE POLICY %I ON emdo.%I FOR INSERT TO emdo_app WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY[''administrator'',''approver'']))',t||'_app_insert',t);
 END LOOP;
END $$;

INSERT INTO emdo.finance_investment_lot_revisions(workspace_id,book_id,revision)
 SELECT workspace_id,id,0 FROM emdo.finance_books ON CONFLICT(workspace_id,book_id) DO NOTHING;

CREATE FUNCTION emdo.bump_finance_investment_lot_revision() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE target_book_id uuid;
BEGIN
 -- A book row is keyed by its own id; all other revision sources carry a
 -- book_id. Read the latter through JSON so PostgreSQL does not resolve a
 -- nonexistent NEW.book_id field while compiling this generic trigger for
 -- finance_books.
 target_book_id := CASE WHEN TG_TABLE_NAME='finance_books' THEN NEW.id ELSE (to_jsonb(NEW)->>'book_id')::uuid END;
 INSERT INTO emdo.finance_investment_lot_revisions(workspace_id,book_id,revision,updated_at)
 VALUES(NEW.workspace_id,target_book_id,1,clock_timestamp())
 ON CONFLICT(workspace_id,book_id) DO UPDATE
   SET revision=emdo.finance_investment_lot_revisions.revision+1,
       updated_at=clock_timestamp();
 RETURN NULL;
END $$;
ALTER FUNCTION emdo.bump_finance_investment_lot_revision() OWNER TO emdo_finance_corporate_action_executor;
REVOKE ALL ON FUNCTION emdo.bump_finance_investment_lot_revision() FROM PUBLIC;

CREATE FUNCTION emdo.bump_finance_investment_book_revision() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 INSERT INTO emdo.finance_investment_lot_revisions(workspace_id,book_id,revision,updated_at)
 VALUES(NEW.workspace_id,NEW.id,1,clock_timestamp())
 ON CONFLICT(workspace_id,book_id) DO UPDATE
   SET revision=emdo.finance_investment_lot_revisions.revision+1,
       updated_at=clock_timestamp();
 RETURN NULL;
END $$;
ALTER FUNCTION emdo.bump_finance_investment_book_revision() OWNER TO emdo_finance_corporate_action_executor;
REVOKE ALL ON FUNCTION emdo.bump_finance_investment_book_revision() FROM PUBLIC;

CREATE TRIGGER finance_book_lot_revision AFTER INSERT ON emdo.finance_books
 FOR EACH ROW EXECUTE FUNCTION emdo.bump_finance_investment_book_revision();
CREATE TRIGGER finance_movement_lot_revision AFTER INSERT ON emdo.finance_investment_movements
 FOR EACH ROW EXECUTE FUNCTION emdo.bump_finance_investment_lot_revision();
CREATE TRIGGER finance_lot_lot_revision AFTER INSERT ON emdo.finance_investment_lots
 FOR EACH ROW EXECUTE FUNCTION emdo.bump_finance_investment_lot_revision();
CREATE TRIGGER finance_disposal_lot_revision AFTER INSERT ON emdo.finance_lot_disposals
 FOR EACH ROW EXECUTE FUNCTION emdo.bump_finance_investment_lot_revision();
CREATE TRIGGER finance_allocation_lot_revision AFTER INSERT ON emdo.finance_lot_allocations
 FOR EACH ROW EXECUTE FUNCTION emdo.bump_finance_investment_lot_revision();
CREATE TRIGGER finance_corporate_action_lot_revision AFTER INSERT ON emdo.finance_investment_corporate_actions
 FOR EACH ROW EXECUTE FUNCTION emdo.bump_finance_investment_lot_revision();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['finance_investment_corporate_actions','finance_investment_corporate_action_lots','finance_investment_corporate_action_effects'] LOOP
  EXECUTE format('CREATE TRIGGER a_lock_book BEFORE INSERT ON emdo.%I FOR EACH ROW EXECUTE FUNCTION emdo.lock_finance_book_mutation()',t);
 END LOOP;
END $$;

CREATE FUNCTION emdo.reject_finance_corporate_action_mutation() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 -- Revision updates are emitted by the AFTER INSERT bump trigger. The
 -- executor role is intentionally unusable as a direct write path: a direct
 -- UPDATE/DELETE runs at trigger depth 1, while the nested bump update runs
 -- at depth 2.
 IF current_user='emdo_finance_corporate_action_executor' AND pg_trigger_depth()>1 THEN
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
 END IF;
 RAISE EXCEPTION 'finance-corporate-action-immutable' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION emdo.reject_finance_corporate_action_mutation() FROM PUBLIC;
CREATE TRIGGER finance_corporate_action_immutable BEFORE UPDATE OR DELETE ON emdo.finance_investment_corporate_actions
 FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_corporate_action_mutation();
CREATE TRIGGER finance_corporate_action_lot_immutable BEFORE UPDATE OR DELETE ON emdo.finance_investment_corporate_action_lots
 FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_corporate_action_mutation();
CREATE TRIGGER finance_corporate_action_effect_immutable BEFORE UPDATE OR DELETE ON emdo.finance_investment_corporate_action_effects
 FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_corporate_action_mutation();
CREATE TRIGGER finance_corporate_action_revision_immutable BEFORE UPDATE OR DELETE ON emdo.finance_investment_lot_revisions
 FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_corporate_action_mutation();

-- The view keeps original lot identifiers as stable roots. Its projected
-- original quantity/cost is the latest committed action state, while
-- post-action allocations are measured in the successor unit. That lets all
-- existing disposal APIs continue to use the root FK without mixing pre- and
-- post-split quantities.
CREATE VIEW emdo.finance_investment_lot_positions
 WITH (security_invoker=true) AS
 WITH projected AS (
  SELECT l.workspace_id,l.book_id,l.id,l.movement_id,l.acquisition_sequence,
         m.financial_account_id,m.instrument_id,m.journal_id,m.effective_on AS acquired_on,
         l.native_currency,b.functional_currency,l.source_reference,
         COALESCE(state.original_quantity,m.quantity) AS original_quantity,
         COALESCE(state.native_cost,l.native_cost) AS original_native_cost,
         COALESCE(state.functional_cost,l.functional_cost) AS original_functional_cost,
         latest.effective_on AS action_effective_on,
         COALESCE(SUM(a.quantity) FILTER (WHERE latest.effective_on IS NULL OR dm.effective_on>=latest.effective_on),0) AS disposed_quantity,
         COALESCE(SUM(a.native_cost) FILTER (WHERE latest.effective_on IS NULL OR dm.effective_on>=latest.effective_on),0) AS allocated_native_cost,
         COALESCE(SUM(a.functional_cost) FILTER (WHERE latest.effective_on IS NULL OR dm.effective_on>=latest.effective_on),0) AS allocated_functional_cost
    FROM emdo.finance_investment_lots l
    JOIN emdo.finance_investment_movements m ON m.workspace_id=l.workspace_id AND m.book_id=l.book_id AND m.id=l.movement_id
    JOIN emdo.finance_books b ON b.workspace_id=l.workspace_id AND b.id=l.book_id
    LEFT JOIN LATERAL (
      SELECT ca.id,ca.effective_on
	    FROM emdo.finance_investment_corporate_actions ca
       WHERE ca.workspace_id=l.workspace_id AND ca.book_id=l.book_id
         AND ca.financial_account_id=m.financial_account_id AND ca.instrument_id=m.instrument_id
         AND ca.status='committed' AND ca.effective_on<=CURRENT_DATE
         AND ca.effective_on>=m.effective_on
       ORDER BY ca.effective_on DESC,ca.created_at DESC,ca.id DESC LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(cal.quantity,e.successor_quantity) AS original_quantity,
             COALESCE(cal.native_cost,e.successor_native_cost_basis) AS native_cost,
             COALESCE(cal.functional_cost,e.successor_functional_cost_basis) AS functional_cost
        FROM emdo.finance_investment_corporate_action_effects e
        LEFT JOIN emdo.finance_investment_corporate_action_lots cal
          ON cal.workspace_id=e.workspace_id AND cal.book_id=e.book_id AND cal.action_id=e.action_id AND cal.source_lot_id=e.source_lot_id
       WHERE e.workspace_id=l.workspace_id AND e.book_id=l.book_id AND e.action_id=latest.id AND e.source_lot_id=l.id
    ) state ON true
    LEFT JOIN emdo.finance_lot_allocations a ON a.workspace_id=l.workspace_id AND a.book_id=l.book_id AND a.lot_id=l.id
    LEFT JOIN emdo.finance_lot_disposals d ON d.workspace_id=a.workspace_id AND d.book_id=a.book_id AND d.id=a.disposal_id
    LEFT JOIN emdo.finance_investment_movements dm ON dm.workspace_id=d.workspace_id AND dm.book_id=d.book_id AND dm.id=d.movement_id
   GROUP BY l.workspace_id,l.book_id,l.id,l.movement_id,l.acquisition_sequence,
            m.financial_account_id,m.instrument_id,m.journal_id,m.effective_on,
            m.quantity,l.native_currency,l.native_cost,l.functional_cost,b.functional_currency,l.source_reference,
            latest.effective_on,state.original_quantity,state.native_cost,state.functional_cost
 )
 SELECT workspace_id,book_id,id,movement_id,acquisition_sequence,financial_account_id,
        instrument_id,journal_id,acquired_on,native_currency,functional_currency,
        source_reference,original_quantity,original_native_cost,original_functional_cost,
        disposed_quantity,allocated_native_cost,allocated_functional_cost,
        original_quantity-disposed_quantity AS remaining_quantity,
        original_native_cost-allocated_native_cost AS remaining_native_cost,
        original_functional_cost-allocated_functional_cost AS remaining_functional_cost
   FROM projected;
GRANT SELECT ON emdo.finance_investment_lot_positions TO emdo_app;

-- Existing lot allocations retain the root lot FK. This trigger resolves the
-- active action state and applies cumulative cost checks in the same unit as
-- the disposal date, so sales after a split cannot spend pre-split quantity.
CREATE OR REPLACE FUNCTION emdo.check_lot_allocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE l record; d record; used record; functional text; action_date date;
BEGIN
 SELECT m.quantity,m.financial_account_id,m.instrument_id,m.effective_on AS acquired_on,
        v.native_currency,v.native_cost,v.functional_cost
   INTO l
   FROM emdo.finance_investment_lots v
   JOIN emdo.finance_investment_movements m ON m.workspace_id=v.workspace_id AND m.book_id=v.book_id AND m.id=v.movement_id
  WHERE v.workspace_id=NEW.workspace_id AND v.book_id=NEW.book_id AND v.id=NEW.lot_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'lot unavailable' USING ERRCODE='23514'; END IF;
 SELECT m.financial_account_id,m.instrument_id,m.effective_on,base_lot.native_currency,
        disposal.id,disposal.movement_id INTO d
   FROM emdo.finance_lot_disposals disposal
  JOIN emdo.finance_investment_movements m ON m.workspace_id=disposal.workspace_id AND m.book_id=disposal.book_id AND m.id=disposal.movement_id
  JOIN emdo.finance_investment_lots base_lot ON base_lot.workspace_id=disposal.workspace_id AND base_lot.book_id=disposal.book_id AND base_lot.id=NEW.lot_id
  WHERE disposal.workspace_id=NEW.workspace_id AND disposal.book_id=NEW.book_id AND disposal.id=NEW.disposal_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'disposal unavailable' USING ERRCODE='23514';
 END IF;
 IF l.financial_account_id<>d.financial_account_id OR l.instrument_id<>d.instrument_id OR l.native_currency<>d.native_currency OR l.acquired_on>d.effective_on THEN
  RAISE EXCEPTION 'lot allocation scope mismatch' USING ERRCODE='23514';
 END IF;
 SELECT ca.effective_on INTO action_date
   FROM emdo.finance_investment_corporate_actions ca
  WHERE ca.workspace_id=NEW.workspace_id AND ca.book_id=NEW.book_id
    AND ca.financial_account_id=d.financial_account_id AND ca.instrument_id=d.instrument_id
    AND ca.effective_on<=d.effective_on AND ca.effective_on>=l.acquired_on
    AND ca.status='committed'
  ORDER BY ca.effective_on DESC,ca.created_at DESC,ca.id DESC LIMIT 1;
	  IF action_date IS NOT NULL THEN
  SELECT COALESCE(cal.quantity,e.successor_quantity) AS quantity,
         COALESCE(cal.native_cost,e.successor_native_cost_basis) AS native_cost,
         COALESCE(cal.functional_cost,e.successor_functional_cost_basis) AS functional_cost
    INTO l.quantity,l.native_cost,l.functional_cost
    FROM emdo.finance_investment_corporate_actions ca
    JOIN emdo.finance_investment_corporate_action_effects e ON e.workspace_id=ca.workspace_id AND e.book_id=ca.book_id AND e.action_id=ca.id AND e.source_lot_id=NEW.lot_id
    LEFT JOIN emdo.finance_investment_corporate_action_lots cal ON cal.workspace_id=e.workspace_id AND cal.book_id=e.book_id AND cal.action_id=e.action_id AND cal.source_lot_id=e.source_lot_id
	    WHERE ca.workspace_id=NEW.workspace_id AND ca.book_id=NEW.book_id AND ca.financial_account_id=d.financial_account_id AND ca.instrument_id=d.instrument_id AND ca.effective_on=action_date;
	  IF NOT FOUND THEN
	   RAISE EXCEPTION 'corporate action successor unavailable' USING ERRCODE='23514';
	  END IF;
	  IF d.effective_on<action_date THEN action_date:=NULL; END IF;
 END IF;
 SELECT COALESCE(SUM(quantity),0) AS quantity,COALESCE(SUM(native_cost),0) AS native_cost,COALESCE(SUM(functional_cost),0) AS functional_cost INTO used
   FROM emdo.finance_lot_allocations fa WHERE fa.workspace_id=NEW.workspace_id AND fa.book_id=NEW.book_id AND fa.lot_id=NEW.lot_id
     AND (action_date IS NULL OR EXISTS (SELECT 1 FROM emdo.finance_lot_disposals pd JOIN emdo.finance_investment_movements pm ON pm.workspace_id=pd.workspace_id AND pm.book_id=pd.book_id AND pm.id=pd.movement_id WHERE pd.workspace_id=fa.workspace_id AND pd.book_id=fa.book_id AND pd.id=fa.disposal_id AND pm.effective_on>=action_date));
 SELECT functional_currency INTO functional FROM emdo.finance_books WHERE workspace_id=NEW.workspace_id AND id=NEW.book_id;
 IF used.quantity+NEW.quantity>l.quantity OR used.native_cost+NEW.native_cost<>emdo.lot_cost_at_quantity(l.native_cost,used.quantity+NEW.quantity,l.quantity,CASE WHEN l.native_currency IN ('JPY','KRW') THEN 0 ELSE 2 END) OR used.functional_cost+NEW.functional_cost<>emdo.lot_cost_at_quantity(l.functional_cost,used.quantity+NEW.quantity,l.quantity,CASE WHEN functional IN ('JPY','KRW') THEN 0 ELSE 2 END) THEN
  RAISE EXCEPTION 'lot quantity or cumulative cost allocation invalid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION emdo.check_lot_allocation() FROM PUBLIC;
