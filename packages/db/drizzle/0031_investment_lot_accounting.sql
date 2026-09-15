CREATE TABLE "emdo"."finance_investment_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"movement_id" uuid NOT NULL,
	"acquisition_sequence" integer NOT NULL,
	"native_currency" text NOT NULL,
	"native_cost" numeric(38, 12) NOT NULL,
	"functional_cost" numeric(38, 12) NOT NULL,
	"source_reference" text NOT NULL,
	CONSTRAINT "finance_investment_lots_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_investment_lots_movement" UNIQUE("workspace_id","book_id","movement_id"),
	CONSTRAINT "finance_investment_lots_valid" CHECK (native_cost>=0 and native_cost<>'NaN'::numeric and functional_cost>=0 and functional_cost<>'NaN'::numeric and acquisition_sequence>=0 and native_currency in ('CAD','USD','MXN','EUR','JPY','KRW') and length(trim(source_reference))>0)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_lot_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"disposal_id" uuid NOT NULL,
	"quantity" numeric(38, 12) NOT NULL,
	"native_cost" numeric(38, 12) NOT NULL,
	"functional_cost" numeric(38, 12) NOT NULL,
	CONSTRAINT "finance_lot_allocations_identity" UNIQUE("workspace_id","book_id","disposal_id","lot_id"),
	CONSTRAINT "finance_lot_allocations_valid" CHECK (quantity>0 and quantity<>'NaN'::numeric and native_cost>=0 and native_cost<>'NaN'::numeric and functional_cost>=0 and functional_cost<>'NaN'::numeric)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_lot_disposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"movement_id" uuid NOT NULL,
	"method" text NOT NULL,
	"native_currency" text NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "finance_lot_disposals_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_lot_disposals_movement" UNIQUE("workspace_id","book_id","movement_id"),
	CONSTRAINT "finance_lot_disposals_valid" CHECK (method in ('fifo','specific') and native_currency in ('CAD','USD','MXN','EUR','JPY','KRW') and jsonb_typeof(input_snapshot)='object' and jsonb_typeof(result)='object')
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_lots" ADD CONSTRAINT "finance_investment_lots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_lots" ADD CONSTRAINT "finance_investment_lots_movement_fk" FOREIGN KEY ("workspace_id","book_id","movement_id") REFERENCES "emdo"."finance_investment_movements"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_lot_allocations" ADD CONSTRAINT "finance_lot_allocations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_lot_allocations" ADD CONSTRAINT "finance_lot_allocations_lot" FOREIGN KEY ("workspace_id","book_id","lot_id") REFERENCES "emdo"."finance_investment_lots"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_lot_allocations" ADD CONSTRAINT "finance_lot_allocations_disposal" FOREIGN KEY ("workspace_id","book_id","disposal_id") REFERENCES "emdo"."finance_lot_disposals"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_lot_disposals" ADD CONSTRAINT "finance_lot_disposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_lot_disposals" ADD CONSTRAINT "finance_lot_disposals_movement_fk" FOREIGN KEY ("workspace_id","book_id","movement_id") REFERENCES "emdo"."finance_investment_movements"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_lot_allocations_lot_lookup" ON "emdo"."finance_lot_allocations" USING btree ("workspace_id","book_id","lot_id");--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['finance_investment_lots','finance_lot_disposals','finance_lot_allocations'] LOOP
  EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow',t);
  EXECUTE format('GRANT SELECT,INSERT ON emdo.%I TO emdo_app',t);
  EXECUTE format('CREATE POLICY %I ON emdo.%I FOR SELECT TO emdo_app USING (emdo.finance_book_access(workspace_id,book_id))',t||'_read',t);
  EXECUTE format('CREATE POLICY %I ON emdo.%I FOR INSERT TO emdo_app WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY[''administrator'',''approver'']))',t||'_insert',t);
  EXECUTE format('CREATE TRIGGER a_lock_book BEFORE INSERT ON emdo.%I FOR EACH ROW EXECUTE FUNCTION emdo.lock_finance_book_mutation()',t);
 END LOOP;
END $$;
CREATE FUNCTION emdo.lot_cost_at_quantity(cost numeric,sold numeric,total numeric,places integer) RETURNS numeric LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT div(2*cost*power(10::numeric,places)*sold+total,2*total)/power(10::numeric,places)
$$;
CREATE FUNCTION emdo.check_investment_lot_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE m record; functional text; BEGIN
 SELECT * INTO m FROM emdo.finance_investment_movements WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.movement_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'lot movement unavailable' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='finance_investment_lots' THEN
  IF m.quantity<=0 THEN RAISE EXCEPTION 'acquisition requires positive movement' USING ERRCODE='23514'; END IF;
  SELECT functional_currency INTO functional FROM emdo.finance_books WHERE workspace_id=NEW.workspace_id AND id=NEW.book_id;
  IF round(NEW.native_cost,CASE WHEN NEW.native_currency IN ('JPY','KRW') THEN 0 ELSE 2 END)<>NEW.native_cost OR round(NEW.functional_cost,CASE WHEN functional IN ('JPY','KRW') THEN 0 ELSE 2 END)<>NEW.functional_cost OR (functional=NEW.native_currency AND NEW.native_cost<>NEW.functional_cost) THEN RAISE EXCEPTION 'lot cost currency precision or identity mismatch' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM emdo.finance_lot_disposals d JOIN emdo.finance_investment_movements v ON v.workspace_id=d.workspace_id AND v.book_id=d.book_id AND v.id=d.movement_id WHERE d.workspace_id=NEW.workspace_id AND d.book_id=NEW.book_id AND v.financial_account_id=m.financial_account_id AND v.instrument_id=m.instrument_id AND v.effective_on>=m.effective_on) THEN RAISE EXCEPTION 'backdated acquisition requires lot history review' USING ERRCODE='23514'; END IF;
 ELSE
  IF m.quantity>=0 THEN RAISE EXCEPTION 'disposal requires negative movement' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM emdo.finance_lot_disposals d JOIN emdo.finance_investment_movements v ON v.workspace_id=d.workspace_id AND v.book_id=d.book_id AND v.id=d.movement_id WHERE d.workspace_id=NEW.workspace_id AND d.book_id=NEW.book_id AND v.financial_account_id=m.financial_account_id AND v.instrument_id=m.instrument_id AND v.effective_on>m.effective_on) THEN RAISE EXCEPTION 'backdated disposal requires lot history review' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER check_lot_record BEFORE INSERT ON emdo.finance_investment_lots FOR EACH ROW EXECUTE FUNCTION emdo.check_investment_lot_record();
CREATE TRIGGER check_lot_record BEFORE INSERT ON emdo.finance_lot_disposals FOR EACH ROW EXECUTE FUNCTION emdo.check_investment_lot_record();
CREATE FUNCTION emdo.check_lot_allocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE l record; d record; used record; functional text; BEGIN
 SELECT v.*,m.quantity,m.financial_account_id,m.instrument_id,m.effective_on INTO l FROM emdo.finance_investment_lots v JOIN emdo.finance_investment_movements m ON m.workspace_id=v.workspace_id AND m.book_id=v.book_id AND m.id=v.movement_id WHERE v.workspace_id=NEW.workspace_id AND v.book_id=NEW.book_id AND v.id=NEW.lot_id;
 SELECT v.*,m.financial_account_id,m.instrument_id,m.effective_on INTO d FROM emdo.finance_lot_disposals v JOIN emdo.finance_investment_movements m ON m.workspace_id=v.workspace_id AND m.book_id=v.book_id AND m.id=v.movement_id WHERE v.workspace_id=NEW.workspace_id AND v.book_id=NEW.book_id AND v.id=NEW.disposal_id;
 IF l.id IS NULL OR d.id IS NULL OR l.financial_account_id<>d.financial_account_id OR l.instrument_id<>d.instrument_id OR l.native_currency<>d.native_currency OR l.effective_on>d.effective_on THEN RAISE EXCEPTION 'lot allocation scope mismatch' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(quantity),0) AS quantity,coalesce(sum(native_cost),0) AS native_cost,coalesce(sum(functional_cost),0) AS functional_cost INTO used FROM emdo.finance_lot_allocations WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND lot_id=NEW.lot_id;
 SELECT functional_currency INTO functional FROM emdo.finance_books WHERE workspace_id=NEW.workspace_id AND id=NEW.book_id;
 IF used.quantity+NEW.quantity>l.quantity OR used.native_cost+NEW.native_cost<>emdo.lot_cost_at_quantity(l.native_cost,used.quantity+NEW.quantity,l.quantity,CASE WHEN l.native_currency IN ('JPY','KRW') THEN 0 ELSE 2 END) OR used.functional_cost+NEW.functional_cost<>emdo.lot_cost_at_quantity(l.functional_cost,used.quantity+NEW.quantity,l.quantity,CASE WHEN functional IN ('JPY','KRW') THEN 0 ELSE 2 END) THEN RAISE EXCEPTION 'lot quantity or cumulative cost allocation invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER check_lot_allocation BEFORE INSERT ON emdo.finance_lot_allocations FOR EACH ROW EXECUTE FUNCTION emdo.check_lot_allocation();
CREATE FUNCTION emdo.check_lot_disposal_total() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE target uuid; expected numeric; actual numeric; BEGIN
 IF TG_TABLE_NAME='finance_lot_disposals' THEN target:=NEW.id; ELSE target:=NEW.disposal_id; END IF;
 SELECT -m.quantity INTO expected FROM emdo.finance_lot_disposals d JOIN emdo.finance_investment_movements m ON m.workspace_id=d.workspace_id AND m.book_id=d.book_id AND m.id=d.movement_id WHERE d.workspace_id=NEW.workspace_id AND d.book_id=NEW.book_id AND d.id=target;
 SELECT coalesce(sum(quantity),0) INTO actual FROM emdo.finance_lot_allocations WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND disposal_id=target;
 IF expected IS NULL OR expected<>actual THEN RAISE EXCEPTION 'disposal allocations must equal movement quantity' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER lot_disposal_total AFTER INSERT ON emdo.finance_lot_disposals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION emdo.check_lot_disposal_total();
CREATE CONSTRAINT TRIGGER lot_disposal_total AFTER INSERT ON emdo.finance_lot_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION emdo.check_lot_disposal_total();
REVOKE ALL ON FUNCTION emdo.check_investment_lot_record(),emdo.check_lot_allocation(),emdo.check_lot_disposal_total() FROM PUBLIC;
