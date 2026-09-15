CREATE TABLE "emdo"."finance_economic_transaction_amount_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"economic_transaction_id" uuid NOT NULL,
	"source_component_id" uuid NOT NULL,
	"component_kind" text NOT NULL,
	"native_amount" numeric(38, 12) NOT NULL,
	"currency" text NOT NULL,
	"functional_amount" numeric(38, 12) NOT NULL,
	"inclusion" text NOT NULL,
	"posting_side" text NOT NULL,
	"ledger_account_id" uuid NOT NULL,
	"fx_rate" numeric(38, 12) NOT NULL,
	"fx_source" text NOT NULL,
	"journal_id" uuid NOT NULL,
	"journal_line_number" integer,
	"source_provenance" jsonb NOT NULL,
	CONSTRAINT "finance_economic_transaction_amount_components_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_economic_transaction_amount_components_kind" UNIQUE("workspace_id","book_id","economic_transaction_id","component_kind"),
	CONSTRAINT "finance_economic_transaction_amount_components_source" UNIQUE("workspace_id","book_id","source_component_id"),
	CONSTRAINT "finance_economic_transaction_amount_components_kind_check" CHECK ("emdo"."finance_economic_transaction_amount_components"."component_kind" in ('fee','commission','tax','principal','interest')),
	CONSTRAINT "finance_economic_transaction_amount_components_currency_check" CHECK ("emdo"."finance_economic_transaction_amount_components"."currency" in ('CAD','USD','MXN','EUR','KRW','JPY')),
	CONSTRAINT "finance_economic_transaction_amount_components_amounts_check" CHECK ("emdo"."finance_economic_transaction_amount_components"."native_amount"<>'NaN'::numeric and "emdo"."finance_economic_transaction_amount_components"."native_amount"=round("emdo"."finance_economic_transaction_amount_components"."native_amount",case when "emdo"."finance_economic_transaction_amount_components"."currency" in ('JPY','KRW') then 0 else 2 end) and "emdo"."finance_economic_transaction_amount_components"."functional_amount"<>'NaN'::numeric and "emdo"."finance_economic_transaction_amount_components"."fx_rate">0 and "emdo"."finance_economic_transaction_amount_components"."fx_rate"<>'NaN'::numeric),
	CONSTRAINT "finance_economic_transaction_amount_components_mapping_check" CHECK ("emdo"."finance_economic_transaction_amount_components"."inclusion"='included-in-net' and "emdo"."finance_economic_transaction_amount_components"."posting_side" in ('debit','credit') and ("emdo"."finance_economic_transaction_amount_components"."functional_amount"=0 and "emdo"."finance_economic_transaction_amount_components"."journal_line_number" is null or "emdo"."finance_economic_transaction_amount_components"."functional_amount"<>0 and "emdo"."finance_economic_transaction_amount_components"."journal_line_number" is not null))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_normalized_import_amount_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"component_kind" text NOT NULL,
	"native_amount" numeric(38, 12) NOT NULL,
	"currency" text NOT NULL,
	"source_provenance" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"reviewed_native_amount" numeric(38, 12),
	"reviewed_currency" text,
	"inclusion" text,
	"posting_side" text,
	"ledger_account_id" uuid,
	"fx_rate" numeric(38, 12),
	"fx_source" text,
	CONSTRAINT "finance_normalized_import_amount_components_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_normalized_import_amount_components_kind" UNIQUE("workspace_id","book_id","row_id","component_kind"),
	CONSTRAINT "finance_normalized_import_amount_components_kind_check" CHECK ("emdo"."finance_normalized_import_amount_components"."component_kind" in ('fee','commission','tax','principal','interest')),
	CONSTRAINT "finance_normalized_import_amount_components_currency_check" CHECK ("emdo"."finance_normalized_import_amount_components"."currency" in ('CAD','USD','MXN','EUR','KRW','JPY') and ("emdo"."finance_normalized_import_amount_components"."reviewed_currency" is null or "emdo"."finance_normalized_import_amount_components"."reviewed_currency" in ('CAD','USD','MXN','EUR','KRW','JPY'))),
	CONSTRAINT "finance_normalized_import_amount_components_source_amount_check" CHECK ("emdo"."finance_normalized_import_amount_components"."native_amount"<>'NaN'::numeric and "emdo"."finance_normalized_import_amount_components"."native_amount"=round("emdo"."finance_normalized_import_amount_components"."native_amount",case when "emdo"."finance_normalized_import_amount_components"."currency" in ('JPY','KRW') then 0 else 2 end)),
	CONSTRAINT "finance_normalized_import_amount_components_revision_check" CHECK ("emdo"."finance_normalized_import_amount_components"."revision">0),
	CONSTRAINT "finance_normalized_import_amount_components_mapping_check" CHECK ((
        ("emdo"."finance_normalized_import_amount_components"."reviewed_native_amount" is null and "emdo"."finance_normalized_import_amount_components"."reviewed_currency" is null and "emdo"."finance_normalized_import_amount_components"."inclusion" is null and "emdo"."finance_normalized_import_amount_components"."posting_side" is null and "emdo"."finance_normalized_import_amount_components"."ledger_account_id" is null and "emdo"."finance_normalized_import_amount_components"."fx_rate" is null and "emdo"."finance_normalized_import_amount_components"."fx_source" is null)
        or
        ("emdo"."finance_normalized_import_amount_components"."reviewed_native_amount" is not null and "emdo"."finance_normalized_import_amount_components"."reviewed_native_amount"<>'NaN'::numeric and "emdo"."finance_normalized_import_amount_components"."reviewed_currency" is not null and "emdo"."finance_normalized_import_amount_components"."reviewed_native_amount"=round("emdo"."finance_normalized_import_amount_components"."reviewed_native_amount",case when "emdo"."finance_normalized_import_amount_components"."reviewed_currency" in ('JPY','KRW') then 0 else 2 end) and "emdo"."finance_normalized_import_amount_components"."inclusion" in ('included-in-net','excluded-from-net') and "emdo"."finance_normalized_import_amount_components"."posting_side" in ('debit','credit') and "emdo"."finance_normalized_import_amount_components"."ledger_account_id" is not null and "emdo"."finance_normalized_import_amount_components"."fx_rate" is not null and "emdo"."finance_normalized_import_amount_components"."fx_rate">0 and "emdo"."finance_normalized_import_amount_components"."fx_rate"<>'NaN'::numeric and length("emdo"."finance_normalized_import_amount_components"."fx_source") between 1 and 200)
      ))
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_economic_transaction_amount_components" ADD CONSTRAINT "finance_economic_transaction_amount_components_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_economic_transaction_amount_components" ADD CONSTRAINT "finance_economic_transaction_amount_components_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_economic_transaction_amount_components" ADD CONSTRAINT "finance_economic_transaction_amount_components_transaction" FOREIGN KEY ("workspace_id","book_id","economic_transaction_id") REFERENCES "emdo"."finance_economic_transactions"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_economic_transaction_amount_components" ADD CONSTRAINT "finance_economic_transaction_amount_components_source_fk" FOREIGN KEY ("workspace_id","book_id","source_component_id") REFERENCES "emdo"."finance_normalized_import_amount_components"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_economic_transaction_amount_components" ADD CONSTRAINT "finance_economic_transaction_amount_components_account" FOREIGN KEY ("workspace_id","book_id","ledger_account_id") REFERENCES "emdo"."finance_ledger_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_economic_transaction_amount_components" ADD CONSTRAINT "finance_economic_transaction_amount_components_journal_line" FOREIGN KEY ("workspace_id","book_id","journal_id","journal_line_number") REFERENCES "emdo"."finance_journal_lines"("workspace_id","book_id","journal_id","line_number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_normalized_import_amount_components" ADD CONSTRAINT "finance_normalized_import_amount_components_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_normalized_import_amount_components" ADD CONSTRAINT "finance_normalized_import_amount_components_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_normalized_import_amount_components" ADD CONSTRAINT "finance_normalized_import_amount_components_row" FOREIGN KEY ("workspace_id","book_id","row_id") REFERENCES "emdo"."finance_normalized_import_rows"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_normalized_import_amount_components" ADD CONSTRAINT "finance_normalized_import_amount_components_account" FOREIGN KEY ("workspace_id","book_id","ledger_account_id") REFERENCES "emdo"."finance_ledger_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_economic_transaction_amount_components_transaction_idx" ON "emdo"."finance_economic_transaction_amount_components" USING btree ("workspace_id","book_id","economic_transaction_id");--> statement-breakpoint
CREATE INDEX "finance_normalized_import_amount_components_row_idx" ON "emdo"."finance_normalized_import_amount_components" USING btree ("workspace_id","book_id","row_id");--> statement-breakpoint

-- Component observations are readable in book scope. Only reviewed source
-- mappings and committed transaction copies are writable through the app role.
ALTER TABLE emdo.finance_normalized_import_amount_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_normalized_import_amount_components FORCE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_economic_transaction_amount_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_economic_transaction_amount_components FORCE ROW LEVEL SECURITY;
REVOKE ALL ON emdo.finance_normalized_import_amount_components,
  emdo.finance_economic_transaction_amount_components
  FROM PUBLIC,emdo_worker,emdo_workflow;
GRANT SELECT,INSERT,UPDATE ON emdo.finance_normalized_import_amount_components TO emdo_app;
GRANT SELECT,INSERT ON emdo.finance_economic_transaction_amount_components TO emdo_app;
CREATE POLICY finance_normalized_component_read
  ON emdo.finance_normalized_import_amount_components FOR SELECT TO emdo_app
  USING (emdo.finance_book_access(workspace_id,book_id));
CREATE POLICY finance_normalized_component_insert
  ON emdo.finance_normalized_import_amount_components FOR INSERT TO emdo_app
  WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','preparer','approver']));
CREATE POLICY finance_normalized_component_update
  ON emdo.finance_normalized_import_amount_components FOR UPDATE TO emdo_app
  USING (emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','preparer','approver']))
  WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','preparer','approver']));
CREATE POLICY finance_economic_component_read
  ON emdo.finance_economic_transaction_amount_components FOR SELECT TO emdo_app
  USING (emdo.finance_book_access(workspace_id,book_id));
CREATE POLICY finance_economic_component_insert
  ON emdo.finance_economic_transaction_amount_components FOR INSERT TO emdo_app
  WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','approver']));
CREATE TRIGGER a_lock_book BEFORE INSERT OR UPDATE
  ON emdo.finance_normalized_import_amount_components FOR EACH ROW
  EXECUTE FUNCTION emdo.lock_finance_book_mutation();
CREATE TRIGGER a_lock_book BEFORE INSERT
  ON emdo.finance_economic_transaction_amount_components FOR EACH ROW
  EXECUTE FUNCTION emdo.lock_finance_book_mutation();
--> statement-breakpoint

-- This helper is called while a review row is advanced to ready. It binds
-- every mapping to a source component, validates account/FX choices, and
-- proves that explicit posting sides offset the reviewed cash movement.
CREATE FUNCTION emdo.finance_normalized_component_review_valid(
  w uuid,b uuid,r uuid,row_amount numeric,row_rate numeric,
  account_currency text,functional_currency text,account_ledger uuid,
  decision jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  source_count integer;
  mapping jsonb;
  component record;
  component_functional numeric;
  contribution numeric := 0;
  expected numeric;
  functional_precision integer;
BEGIN
  IF pg_catalog.jsonb_typeof(decision->'componentMappings') <> 'array'
     OR pg_catalog.jsonb_array_length(decision->'componentMappings') = 0 THEN
    RETURN false;
  END IF;
  SELECT count(*) INTO source_count
    FROM emdo.finance_normalized_import_amount_components
   WHERE workspace_id=w AND book_id=b AND row_id=r;
  IF source_count=0 OR pg_catalog.jsonb_array_length(decision->'componentMappings')<>source_count THEN
    RETURN false;
  END IF;
  functional_precision:=CASE WHEN functional_currency IN ('JPY','KRW') THEN 0 ELSE 2 END;
  FOR component IN
    SELECT * FROM emdo.finance_normalized_import_amount_components
     WHERE workspace_id=w AND book_id=b AND row_id=r
     ORDER BY component_kind
  LOOP
    SELECT value INTO mapping
      FROM pg_catalog.jsonb_array_elements(decision->'componentMappings') value
     WHERE value->>'kind'=component.component_kind;
    IF mapping IS NULL
       OR component.reviewed_native_amount IS NULL
       OR component.reviewed_currency IS NULL
       OR component.inclusion IS NULL
       OR component.posting_side IS NULL
       OR component.ledger_account_id IS NULL
       OR component.fx_rate IS NULL
       OR component.fx_source IS NULL
       OR mapping->>'nativeAmount' IS NULL
       OR mapping->>'currency' IS NULL
       OR mapping->>'ledgerAccountId' IS NULL
       OR mapping->>'fxRate' IS NULL
       OR mapping->>'fxSource' IS NULL
       OR component.reviewed_native_amount IS DISTINCT FROM (mapping->>'nativeAmount')::numeric
       OR component.reviewed_currency IS DISTINCT FROM mapping->>'currency'
       OR component.inclusion IS DISTINCT FROM mapping->>'inclusion'
       OR component.posting_side IS DISTINCT FROM mapping->>'postingSide'
       OR component.ledger_account_id::text IS DISTINCT FROM mapping->>'ledgerAccountId'
       OR component.fx_rate IS DISTINCT FROM (mapping->>'fxRate')::numeric
       OR component.fx_source IS DISTINCT FROM mapping->>'fxSource' THEN
      RETURN false;
    END IF;
    IF component.inclusion<>'included-in-net'
       OR component.posting_side NOT IN ('debit','credit')
       OR NOT EXISTS (
         SELECT 1 FROM emdo.finance_ledger_accounts a
          WHERE a.workspace_id=w AND a.book_id=b AND a.id=component.ledger_account_id
            AND a.active AND a.id<>account_ledger
       ) THEN
      RETURN false;
    END IF;
    IF (component.reviewed_currency=functional_currency
        AND (component.fx_rate<>1 OR component.fx_source<>'identity'))
       OR (component.reviewed_currency<>functional_currency
           AND component.fx_source='identity') THEN
      RETURN false;
    END IF;
    component_functional:=pg_catalog.round(
      component.reviewed_native_amount*component.fx_rate,functional_precision);
    contribution:=contribution+
      CASE WHEN component.posting_side='debit'
           THEN pg_catalog.abs(component_functional)
           ELSE -pg_catalog.abs(component_functional) END;
  END LOOP;
  expected:=-pg_catalog.round(row_amount*row_rate,functional_precision);
  RETURN contribution=expected;
END $$;
REVOKE ALL ON FUNCTION emdo.finance_normalized_component_review_valid(uuid,uuid,uuid,numeric,numeric,text,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.finance_normalized_component_review_valid(uuid,uuid,uuid,numeric,numeric,text,text,uuid,jsonb) TO emdo_app;

CREATE FUNCTION emdo.check_finance_normalized_import_amount_component()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE row_status text;
BEGIN
  SELECT status INTO row_status
    FROM emdo.finance_normalized_import_rows
   WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.row_id;
  IF row_status IS NULL THEN
    RAISE EXCEPTION 'normalized component row is unavailable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1
       OR NEW.reviewed_native_amount IS NOT NULL
       OR NEW.reviewed_currency IS NOT NULL
       OR NEW.inclusion IS NOT NULL
       OR NEW.posting_side IS NOT NULL
       OR NEW.ledger_account_id IS NOT NULL
       OR NEW.fx_rate IS NOT NULL
       OR NEW.fx_source IS NOT NULL THEN
      RAISE EXCEPTION 'normalized component must start as an immutable source fact' USING ERRCODE='23514';
    END IF;
  ELSE
    IF row_status<>'review'
       OR OLD.revision<1
       OR NEW.revision<>OLD.revision+1
       OR (NEW.id,NEW.workspace_id,NEW.book_id,NEW.created_at,NEW.row_id,
           NEW.component_kind,NEW.native_amount,NEW.currency,NEW.source_provenance)
          IS DISTINCT FROM
         (OLD.id,OLD.workspace_id,OLD.book_id,OLD.created_at,OLD.row_id,
          OLD.component_kind,OLD.native_amount,OLD.currency,OLD.source_provenance)
       OR OLD.reviewed_native_amount IS NOT NULL
       OR OLD.reviewed_currency IS NOT NULL
       OR OLD.inclusion IS NOT NULL
       OR OLD.posting_side IS NOT NULL
       OR OLD.ledger_account_id IS NOT NULL
       OR OLD.fx_rate IS NOT NULL
       OR OLD.fx_source IS NOT NULL THEN
      RAISE EXCEPTION 'normalized component source or reviewed history is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF (NEW.reviewed_native_amount IS NULL) <> (NEW.reviewed_currency IS NULL)
     OR (NEW.reviewed_native_amount IS NULL) <> (NEW.inclusion IS NULL)
     OR (NEW.reviewed_native_amount IS NULL) <> (NEW.posting_side IS NULL)
     OR (NEW.reviewed_native_amount IS NULL) <> (NEW.ledger_account_id IS NULL)
     OR (NEW.reviewed_native_amount IS NULL) <> (NEW.fx_rate IS NULL)
     OR (NEW.reviewed_native_amount IS NULL) <> (NEW.fx_source IS NULL) THEN
    RAISE EXCEPTION 'normalized component review mapping is incomplete' USING ERRCODE='23514';
  END IF;
  IF NEW.reviewed_native_amount IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM emdo.finance_ledger_accounts a
        WHERE a.workspace_id=NEW.workspace_id AND a.book_id=NEW.book_id
          AND a.id=NEW.ledger_account_id AND a.active
     ) THEN
    RAISE EXCEPTION 'normalized component ledger account is unavailable' USING ERRCODE='23514';
  END IF;
  IF NEW.reviewed_native_amount IS NOT NULL THEN
    IF NEW.reviewed_currency=NEW.currency AND NEW.fx_rate IS NULL THEN
      RAISE EXCEPTION 'normalized component FX mapping is missing' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_finance_normalized_import_amount_component
  BEFORE INSERT OR UPDATE ON emdo.finance_normalized_import_amount_components
  FOR EACH ROW EXECUTE FUNCTION emdo.check_finance_normalized_import_amount_component();
REVOKE ALL ON FUNCTION emdo.check_finance_normalized_import_amount_component() FROM PUBLIC;

-- The commit check is evaluated after all component rows have been inserted,
-- immediately before the normalized row becomes committed/matched. It binds
-- the immutable source revision, reviewed mapping, journal line and evidence.
CREATE FUNCTION emdo.finance_normalized_component_commit_valid(
  w uuid,b uuid,r uuid,t uuid
) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  source_count integer;
  output_count integer;
  component record;
  output_component record;
  line record;
  transaction_record record;
  functional_currency text;
  functional_precision integer;
  expected_functional numeric;
  contribution numeric := 0;
BEGIN
  SELECT * INTO transaction_record
    FROM emdo.finance_economic_transactions
   WHERE workspace_id=w AND book_id=b AND id=t;
  IF transaction_record.id IS NULL THEN RETURN false; END IF;
  SELECT fb.functional_currency INTO functional_currency
    FROM emdo.finance_books fb WHERE fb.workspace_id=w AND fb.id=b;
  functional_precision:=CASE WHEN functional_currency IN ('JPY','KRW') THEN 0 ELSE 2 END;
  SELECT count(*) INTO source_count
    FROM emdo.finance_normalized_import_amount_components
   WHERE workspace_id=w AND book_id=b AND row_id=r;
  SELECT count(*) INTO output_count
    FROM emdo.finance_economic_transaction_amount_components
   WHERE workspace_id=w AND book_id=b AND economic_transaction_id=t;
  IF source_count=0 OR output_count<>source_count THEN RETURN false; END IF;
  FOR component IN
    SELECT * FROM emdo.finance_normalized_import_amount_components
     WHERE workspace_id=w AND book_id=b AND row_id=r
     ORDER BY component_kind
  LOOP
    SELECT * INTO output_component
      FROM emdo.finance_economic_transaction_amount_components
     WHERE workspace_id=w AND book_id=b AND economic_transaction_id=t
       AND source_component_id=component.id;
    IF output_component.id IS NULL
       OR output_component.component_kind IS DISTINCT FROM component.component_kind
       OR output_component.native_amount IS DISTINCT FROM component.reviewed_native_amount
       OR output_component.currency IS DISTINCT FROM component.reviewed_currency
       OR output_component.inclusion IS DISTINCT FROM component.inclusion
       OR output_component.posting_side IS DISTINCT FROM component.posting_side
       OR output_component.ledger_account_id IS DISTINCT FROM component.ledger_account_id
       OR output_component.fx_rate IS DISTINCT FROM component.fx_rate
       OR output_component.fx_source IS DISTINCT FROM component.fx_source
       OR output_component.source_provenance IS DISTINCT FROM component.source_provenance
       OR output_component.journal_id IS DISTINCT FROM transaction_record.journal_id THEN
      RETURN false;
    END IF;
    expected_functional:=pg_catalog.round(
      component.reviewed_native_amount*component.fx_rate,functional_precision);
    IF output_component.functional_amount IS DISTINCT FROM expected_functional
       OR output_component.inclusion<>'included-in-net' THEN
      RETURN false;
    END IF;
    contribution:=contribution+
      CASE WHEN component.posting_side='debit'
           THEN pg_catalog.abs(expected_functional)
           ELSE -pg_catalog.abs(expected_functional) END;
    IF expected_functional=0 THEN
      IF output_component.journal_line_number IS NOT NULL THEN RETURN false; END IF;
    ELSE
      IF output_component.journal_line_number IS NULL THEN RETURN false; END IF;
      SELECT * INTO line
        FROM emdo.finance_journal_lines
       WHERE workspace_id=w AND book_id=b AND journal_id=transaction_record.journal_id
         AND line_number=output_component.journal_line_number;
      IF line.account_id IS NULL
         OR line.account_id IS DISTINCT FROM component.ledger_account_id
         OR line.side IS DISTINCT FROM component.posting_side
         OR line.amount IS DISTINCT FROM pg_catalog.abs(expected_functional)
         OR line.currency IS DISTINCT FROM component.reviewed_currency
         OR line.native_amount IS DISTINCT FROM pg_catalog.abs(component.reviewed_native_amount)
         OR line.fx_rate IS DISTINCT FROM component.fx_rate
         OR line.fx_source IS DISTINCT FROM component.fx_source THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;
  RETURN contribution + transaction_record.functional_amount = 0;
END $$;
REVOKE ALL ON FUNCTION emdo.finance_normalized_component_commit_valid(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.finance_normalized_component_commit_valid(uuid,uuid,uuid,uuid) TO emdo_app;

CREATE FUNCTION emdo.check_finance_economic_transaction_amount_component()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE source record; transaction_record record; functional_currency text; precision integer; expected numeric;
BEGIN
  SELECT * INTO source
    FROM emdo.finance_normalized_import_amount_components
   WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.source_component_id;
  SELECT * INTO transaction_record
    FROM emdo.finance_economic_transactions
   WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.economic_transaction_id;
  SELECT fb.functional_currency INTO functional_currency
    FROM emdo.finance_books fb
   WHERE fb.workspace_id=NEW.workspace_id AND fb.id=NEW.book_id;
  IF source.id IS NULL OR transaction_record.id IS NULL
     OR source.row_id IS NULL
     OR NEW.component_kind IS DISTINCT FROM source.component_kind
     OR NEW.native_amount IS DISTINCT FROM source.reviewed_native_amount
     OR NEW.currency IS DISTINCT FROM source.reviewed_currency
     OR NEW.inclusion IS DISTINCT FROM source.inclusion
     OR NEW.posting_side IS DISTINCT FROM source.posting_side
     OR NEW.ledger_account_id IS DISTINCT FROM source.ledger_account_id
     OR NEW.fx_rate IS DISTINCT FROM source.fx_rate
     OR NEW.fx_source IS DISTINCT FROM source.fx_source
     OR NEW.source_provenance IS DISTINCT FROM source.source_provenance
     OR NEW.journal_id IS DISTINCT FROM transaction_record.journal_id
     OR NEW.inclusion<>'included-in-net' THEN
    RAISE EXCEPTION 'economic component does not match reviewed source' USING ERRCODE='23514';
  END IF;
  precision:=CASE WHEN functional_currency IN ('JPY','KRW') THEN 0 ELSE 2 END;
  expected:=pg_catalog.round(NEW.native_amount*NEW.fx_rate,precision);
  IF NEW.functional_amount IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'economic component FX conversion is not exact' USING ERRCODE='23514';
  END IF;
  IF expected=0 THEN
    IF NEW.journal_line_number IS NOT NULL THEN
      RAISE EXCEPTION 'zero economic component cannot reference a journal line' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.journal_line_number IS NULL OR NOT EXISTS (
      SELECT 1 FROM emdo.finance_journal_lines l
       WHERE l.workspace_id=NEW.workspace_id AND l.book_id=NEW.book_id
         AND l.journal_id=NEW.journal_id AND l.line_number=NEW.journal_line_number
         AND l.account_id=NEW.ledger_account_id
         AND l.side=NEW.posting_side
         AND l.amount=pg_catalog.abs(expected)
         AND l.currency=NEW.currency
         AND l.native_amount=pg_catalog.abs(NEW.native_amount)
         AND l.fx_rate=NEW.fx_rate AND l.fx_source=NEW.fx_source
    ) THEN
      RAISE EXCEPTION 'economic component journal line does not match mapping' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_finance_economic_transaction_amount_component
  BEFORE INSERT ON emdo.finance_economic_transaction_amount_components
  FOR EACH ROW EXECUTE FUNCTION emdo.check_finance_economic_transaction_amount_component();
REVOKE ALL ON FUNCTION emdo.check_finance_economic_transaction_amount_component() FROM PUBLIC;

CREATE FUNCTION emdo.reject_finance_amount_component_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'finance amount component history is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_finance_economic_transaction_amount_component
  BEFORE UPDATE OR DELETE ON emdo.finance_economic_transaction_amount_components
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_amount_component_mutation();
CREATE TRIGGER immutable_finance_normalized_import_amount_component_delete
  BEFORE DELETE ON emdo.finance_normalized_import_amount_components
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_amount_component_mutation();
REVOKE ALL ON FUNCTION emdo.reject_finance_amount_component_mutation() FROM PUBLIC;

-- A direct SQL writer cannot commit a partial component set by inserting only
-- one output row. The deferred check runs after the complete transaction.
CREATE FUNCTION emdo.check_finance_economic_transaction_amount_components_complete()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE transaction_id uuid; v_workspace_id uuid; v_book_id uuid;
BEGIN
  transaction_id:=COALESCE(NEW.economic_transaction_id,OLD.economic_transaction_id);
  v_workspace_id:=COALESCE(NEW.workspace_id,OLD.workspace_id);
  v_book_id:=COALESCE(NEW.book_id,OLD.book_id);
  IF EXISTS (
    SELECT 1
      FROM emdo.finance_normalized_import_rows r
      JOIN emdo.finance_normalized_import_amount_components s
        ON s.workspace_id=r.workspace_id AND s.book_id=r.book_id AND s.row_id=r.id
     WHERE r.workspace_id=v_workspace_id AND r.book_id=v_book_id
       AND r.economic_transaction_id=transaction_id
       AND NOT emdo.finance_normalized_component_commit_valid(
         r.workspace_id,r.book_id,r.id,r.economic_transaction_id
       )
  ) THEN
    RAISE EXCEPTION 'economic transaction component set is incomplete or unbalanced' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER finance_economic_transaction_amount_components_complete
  AFTER INSERT OR UPDATE OR DELETE ON emdo.finance_economic_transaction_amount_components
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION emdo.check_finance_economic_transaction_amount_components_complete();
REVOKE ALL ON FUNCTION emdo.check_finance_economic_transaction_amount_components_complete() FROM PUBLIC;

-- Extend the original normalized-row guard in place so legacy counter-account
-- reviews retain their behavior while component reviews use the exact proof
-- above. The trigger created by 0026 continues to call this function.
CREATE OR REPLACE FUNCTION emdo.check_normalized_row()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  review jsonb;
  batch emdo.finance_normalized_imports;
  account emdo.finance_financial_accounts;
  functional text;
  precision integer;
  has_components boolean;
BEGIN
  SELECT * INTO batch FROM emdo.finance_normalized_imports
   WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.batch_id;
  IF batch.id IS NULL OR batch.status<>'review' THEN
    RAISE EXCEPTION 'committed import rows are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NEW.status NOT IN ('review','invalid')
       OR NEW.economic_transaction_id IS NOT NULL
       OR NEW.counter_account_id IS NOT NULL
       OR NEW.match_journal_id IS NOT NULL
       OR NEW.fx_rate IS NOT NULL OR NEW.fx_source IS NOT NULL THEN
      RAISE EXCEPTION 'import row must start unreviewed' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.workspace_id,NEW.book_id,NEW.created_at,NEW.batch_id,
      NEW.source_row,NEW.source_facts)
     IS DISTINCT FROM
     (OLD.id,OLD.workspace_id,OLD.book_id,OLD.created_at,OLD.batch_id,
      OLD.source_row,OLD.source_facts)
     OR OLD.status IN ('committed','matched') THEN
    RAISE EXCEPTION 'import row evidence is immutable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO account FROM emdo.finance_financial_accounts
   WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id
     AND id=batch.financial_account_id;
  SELECT EXISTS(
    SELECT 1 FROM emdo.finance_normalized_import_amount_components
     WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND row_id=NEW.id
  ) INTO has_components;
  IF NEW.status IN ('committed','matched') THEN
    IF OLD.status<>'ready' OR NEW.revision<>OLD.revision
       OR NOT emdo.finance_book_access(NEW.workspace_id,NEW.book_id,ARRAY['administrator','approver'])
       OR (NEW.effective_on,NEW.description,NEW.native_amount,NEW.external_id,
           NEW.issues,NEW.counter_account_id,NEW.match_journal_id,NEW.fx_rate,
           NEW.fx_source)
          IS DISTINCT FROM
          (OLD.effective_on,OLD.description,OLD.native_amount,OLD.external_id,
           OLD.issues,OLD.counter_account_id,OLD.match_journal_id,OLD.fx_rate,
           OLD.fx_source)
       OR NOT EXISTS(
         SELECT 1 FROM emdo.finance_economic_transactions t
          WHERE t.workspace_id=NEW.workspace_id AND t.book_id=NEW.book_id
            AND t.id=NEW.economic_transaction_id
            AND t.financial_account_id=batch.financial_account_id
            AND t.effective_on=NEW.effective_on
            AND t.native_amount=NEW.native_amount
            AND t.fx_rate=NEW.fx_rate
       )
       OR (has_components AND NOT emdo.finance_normalized_component_commit_valid(
         NEW.workspace_id,NEW.book_id,NEW.id,NEW.economic_transaction_id
       )) THEN
      RAISE EXCEPTION 'import commit must match reviewed facts and saved transaction' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT decision INTO review FROM emdo.finance_import_row_reviews
   WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id
     AND row_id=NEW.id AND revision=NEW.revision
     AND reviewed_by=emdo.current_user_id();
  IF NEW.revision<>OLD.revision+1 OR review IS NULL
     OR NEW.economic_transaction_id IS NOT NULL
     OR NEW.effective_on IS DISTINCT FROM coalesce((review->'correction'->>'date')::date,OLD.effective_on)
     OR NEW.native_amount IS DISTINCT FROM coalesce((review->'correction'->>'amount')::numeric,OLD.native_amount)
     OR NEW.description IS DISTINCT FROM coalesce(review->'correction'->>'description',OLD.description)
     OR NEW.external_id IS DISTINCT FROM (CASE WHEN (review->'correction') ? 'externalId'
       THEN review->'correction'->>'externalId' ELSE OLD.external_id END) THEN
    RAISE EXCEPTION 'import changes require a matching review revision' USING ERRCODE='23514';
  END IF;
  IF review->>'action'='ignore' THEN
    IF NEW.status<>'ignored' OR NEW.counter_account_id IS NOT NULL
       OR NEW.match_journal_id IS NOT NULL
       OR (has_components AND pg_catalog.jsonb_typeof(review->'componentMappings')='array'
           AND pg_catalog.jsonb_array_length(review->'componentMappings')>0) THEN
      RAISE EXCEPTION 'ignored row cannot post' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT functional_currency INTO functional FROM emdo.finance_books
   WHERE workspace_id=NEW.workspace_id AND id=NEW.book_id;
  precision:=CASE WHEN account.currency IN ('JPY','KRW') THEN 0 ELSE 2 END;
  IF NEW.status<>'ready' OR NEW.effective_on IS NULL OR NEW.native_amount IS NULL
     OR NEW.native_amount=0 OR NEW.native_amount='NaN'::numeric
     OR NEW.native_amount<>round(NEW.native_amount,precision)
     OR length(NEW.description)=0 OR NEW.issues IS DISTINCT FROM '[]'::jsonb
     OR NEW.fx_rate IS NULL OR NEW.fx_rate<=0 OR NEW.fx_rate='NaN'::numeric
     OR length(coalesce(NEW.fx_source,''))=0
     OR (account.currency=functional AND (NEW.fx_rate<>1 OR NEW.fx_source<>'identity'))
     OR (account.currency<>functional AND
         (NEW.fx_rate IS DISTINCT FROM (review->>'fxRate')::numeric
          OR NEW.fx_source IS DISTINCT FROM review->>'fxSource'))
     OR (review->>'action'='post' AND (
       (has_components AND (
         NEW.counter_account_id IS NOT NULL OR NEW.match_journal_id IS NOT NULL
         OR NOT emdo.finance_normalized_component_review_valid(
           NEW.workspace_id,NEW.book_id,NEW.id,NEW.native_amount,NEW.fx_rate,
           account.currency,functional,account.ledger_account_id,review
         )
       ))
       OR (NOT has_components AND (
         NEW.counter_account_id IS NULL OR NEW.counter_account_id=account.ledger_account_id
         OR NEW.match_journal_id IS NOT NULL
       ))
     ))
     OR (review->>'action'='match' AND (
       has_components OR NEW.match_journal_id IS NULL OR NEW.counter_account_id IS NOT NULL
     ))
     OR (NOT has_components AND pg_catalog.jsonb_typeof(review->'componentMappings')='array'
         AND pg_catalog.jsonb_array_length(review->'componentMappings')>0)
     OR NEW.counter_account_id IS DISTINCT FROM (review->>'counterAccountId')::uuid
     OR NEW.match_journal_id IS DISTINCT FROM (review->>'matchJournalId')::uuid THEN
    RAISE EXCEPTION 'reviewed import row is incomplete or invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
