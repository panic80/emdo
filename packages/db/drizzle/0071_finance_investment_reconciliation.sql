CREATE TABLE "emdo"."finance_investment_reconciliation_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_investment_reconciliation_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_investment_reconciliation_state" CHECK ("emdo"."finance_investment_reconciliation_cases"."revision">0 and "emdo"."finance_investment_reconciliation_cases"."status" in ('open','resolved'))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_investment_reconciliation_events" (
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"event" jsonb NOT NULL,
	CONSTRAINT "finance_investment_reconciliation_events_case_id_revision_pk" PRIMARY KEY("case_id","revision"),
	CONSTRAINT "finance_investment_reconciliation_event_shape" CHECK ("emdo"."finance_investment_reconciliation_events"."revision">0 and jsonb_typeof("emdo"."finance_investment_reconciliation_events"."event")='object' and octet_length("emdo"."finance_investment_reconciliation_events"."event"::text)<=1048576)
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_reconciliation_cases" ADD CONSTRAINT "finance_investment_reconciliation_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_reconciliation_events" ADD CONSTRAINT "finance_investment_reconciliation_event_case" FOREIGN KEY ("workspace_id","book_id","case_id") REFERENCES "emdo"."finance_investment_reconciliation_cases"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_investment_reconciliation_lookup" ON "emdo"."finance_investment_reconciliation_cases" USING btree ("workspace_id","book_id","created_at","id");--> statement-breakpoint
ALTER TABLE emdo.finance_investment_reconciliation_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_investment_reconciliation_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_investment_reconciliation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_investment_reconciliation_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON emdo.finance_investment_reconciliation_cases,emdo.finance_investment_reconciliation_events FROM PUBLIC,emdo_worker,emdo_workflow;
GRANT SELECT,INSERT,UPDATE ON emdo.finance_investment_reconciliation_cases TO emdo_app;
GRANT SELECT,INSERT ON emdo.finance_investment_reconciliation_events TO emdo_app;
CREATE POLICY investment_reconciliation_read ON emdo.finance_investment_reconciliation_cases FOR SELECT TO emdo_app USING(emdo.finance_book_access(workspace_id,book_id));
CREATE POLICY investment_reconciliation_insert ON emdo.finance_investment_reconciliation_cases FOR INSERT TO emdo_app WITH CHECK(emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','preparer','approver']));
CREATE POLICY investment_reconciliation_update ON emdo.finance_investment_reconciliation_cases FOR UPDATE TO emdo_app USING(emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','preparer','approver'])) WITH CHECK(emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','preparer','approver']));
CREATE POLICY investment_reconciliation_events_read ON emdo.finance_investment_reconciliation_events FOR SELECT TO emdo_app USING(emdo.finance_book_access(workspace_id,book_id));
CREATE POLICY investment_reconciliation_events_insert ON emdo.finance_investment_reconciliation_events FOR INSERT TO emdo_app WITH CHECK(emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','preparer','approver']));
CREATE TRIGGER a_lock_book BEFORE INSERT OR UPDATE ON emdo.finance_investment_reconciliation_cases FOR EACH ROW EXECUTE FUNCTION emdo.lock_finance_book_mutation();
CREATE TRIGGER a_lock_book BEFORE INSERT ON emdo.finance_investment_reconciliation_events FOR EACH ROW EXECUTE FUNCTION emdo.lock_finance_book_mutation();
CREATE TRIGGER immutable_investment_reconciliation_events BEFORE UPDATE OR DELETE ON emdo.finance_investment_reconciliation_events FOR EACH ROW EXECUTE FUNCTION emdo.reject_generated_report_mutation();
--> statement-breakpoint
CREATE FUNCTION emdo.validate_investment_reconciliation_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,emdo AS $$
DECLARE h record; v record; saved_source jsonb; saved_comparison jsonb; p jsonb; e jsonb; prior jsonb; current_movements jsonb; actual_record jsonb;
BEGIN
 SELECT * INTO h FROM emdo.finance_investment_reconciliation_cases WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.case_id FOR UPDATE;
 IF h.id IS NULL OR h.revision<>NEW.revision OR (NEW.event->>'revision')::int<>NEW.revision OR (NEW.event->>'createdBy')::uuid<>emdo.current_user_id() THEN RAISE EXCEPTION 'investment-reconciliation-event-scope' USING ERRCODE='23514'; END IF;
 SELECT event INTO prior FROM emdo.finance_investment_reconciliation_events WHERE case_id=NEW.case_id AND revision=NEW.revision-1;
 IF (NEW.revision=1 AND (NEW.event->>'kind'<>'created' OR h.status<>'open')) OR (NEW.revision>1 AND prior IS NULL) THEN RAISE EXCEPTION 'investment-reconciliation-event-revision' USING ERRCODE='23514'; END IF;
 p:=NEW.event->'comparison';
 SELECT * INTO v FROM emdo.finance_valuation_runs WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=(p->>'valuationRunId')::uuid;
 IF v.id IS NULL THEN RAISE EXCEPTION 'investment-reconciliation-valuation-unavailable' USING ERRCODE='23514'; END IF;
 SELECT item INTO saved_source FROM jsonb_array_elements(v.input_snapshot->'positions') item WHERE item->'selected'->>'observedPositionId'=p->>'observedPositionId';
 SELECT item INTO saved_comparison FROM jsonb_array_elements(v.result->'reconciliations') item WHERE item->>'observedPositionId'=p->>'observedPositionId';
 IF saved_source IS NULL OR saved_comparison IS NULL OR p->'sourceSnapshot' IS DISTINCT FROM saved_source OR p->>'valuationInputHash' IS DISTINCT FROM v.result->>'inputHash' OR p->>'asOf' IS DISTINCT FROM v.as_of::text
 OR p->>'financialAccountId' IS DISTINCT FROM saved_source->'selected'->>'financialAccountId' OR p->>'instrumentId' IS DISTINCT FROM saved_source->'selected'->>'instrumentId'
 OR (p-'valuationRunId'-'comparisonHash'-'valuationInputHash'-'financialAccountId'-'instrumentId'-'asOf'-'sourceSnapshot') IS DISTINCT FROM (saved_comparison-'calculationSources') THEN RAISE EXCEPTION 'investment-reconciliation-snapshot-mismatch' USING ERRCODE='23514'; END IF;
 IF prior IS NOT NULL AND (p->>'financialAccountId' IS DISTINCT FROM prior->'comparison'->>'financialAccountId' OR p->>'instrumentId' IS DISTINCT FROM prior->'comparison'->>'instrumentId' OR p->>'asOf' IS DISTINCT FROM prior->'comparison'->>'asOf') THEN RAISE EXCEPTION 'investment-reconciliation-case-scope' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'financialAccountId',m.financial_account_id,'instrumentId',m.instrument_id,'effectiveOn',m.effective_on::text,'quantity',m.quantity::text,'sourceReference',m.source_reference) ORDER BY m.effective_on,m.id),'[]'::jsonb) INTO current_movements FROM emdo.finance_investment_movements m WHERE m.workspace_id=NEW.workspace_id AND m.book_id=NEW.book_id AND m.financial_account_id=(p->>'financialAccountId')::uuid AND m.instrument_id=(p->>'instrumentId')::uuid AND m.effective_on<=(p->>'asOf')::date;
 IF current_movements IS DISTINCT FROM saved_source->'movements' OR NOT EXISTS(SELECT 1 FROM emdo.finance_financial_accounts WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=(p->>'financialAccountId')::uuid AND active AND kind='brokerage') THEN RAISE EXCEPTION 'investment-reconciliation-stale-source' USING ERRCODE='23514'; END IF;
 IF NEW.event->>'kind'='resolved' THEN
  IF h.status<>'resolved' OR prior->>'kind'='resolved' OR p IS DISTINCT FROM prior->'comparison' OR jsonb_typeof(NEW.event->'resolution')<>'object' OR jsonb_array_length(NEW.event->'evidenceSnapshots')=0 THEN RAISE EXCEPTION 'investment-reconciliation-resolution-invalid' USING ERRCODE='23514'; END IF;
  IF NEW.event->'resolution'->>'kind' NOT IN ('corrective-records','reviewed-explanation') OR length(trim(NEW.event->'resolution'->>'explanation'))<10 OR jsonb_array_length(NEW.event->'resolution'->'evidenceIds')<>jsonb_array_length(NEW.event->'evidenceSnapshots') OR jsonb_array_length(NEW.event->'resolution'->'correctiveRecords')<>jsonb_array_length(NEW.event->'correctiveRecordSnapshots') OR ((NEW.event->'resolution'->>'kind'='corrective-records')<>(jsonb_array_length(NEW.event->'correctiveRecordSnapshots')>0)) THEN RAISE EXCEPTION 'investment-reconciliation-resolution-shape' USING ERRCODE='23514'; END IF;
  FOR e IN SELECT item FROM jsonb_array_elements(NEW.event->'correctiveRecordSnapshots') item LOOP
   actual_record:=NULL;
   CASE e->>'kind'
   WHEN 'opening' THEN SELECT to_jsonb(r) INTO actual_record FROM emdo.finance_investment_openings r WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=(e->>'id')::uuid AND financial_account_id=(p->>'financialAccountId')::uuid AND instrument_id=(p->>'instrumentId')::uuid;
   WHEN 'movement' THEN SELECT to_jsonb(r) INTO actual_record FROM emdo.finance_investment_movements r WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=(e->>'id')::uuid AND financial_account_id=(p->>'financialAccountId')::uuid AND instrument_id=(p->>'instrumentId')::uuid;
   WHEN 'stock-split' THEN SELECT to_jsonb(r) INTO actual_record FROM emdo.finance_investment_corporate_actions r WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=(e->>'id')::uuid AND financial_account_id=(p->>'financialAccountId')::uuid AND instrument_id=(p->>'instrumentId')::uuid AND status='committed';
   WHEN 'cash-dividend' THEN SELECT to_jsonb(r) INTO actual_record FROM emdo.finance_investment_cash_dividends r WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=(e->>'id')::uuid AND financial_account_id=(p->>'financialAccountId')::uuid AND instrument_id=(p->>'instrumentId')::uuid AND status='committed';
   WHEN 'split-settlement' THEN SELECT to_jsonb(r) INTO actual_record FROM emdo.finance_investment_corporate_action_settlements r JOIN emdo.finance_investment_corporate_actions a ON a.workspace_id=r.workspace_id AND a.book_id=r.book_id AND a.id=r.action_id WHERE r.workspace_id=NEW.workspace_id AND r.book_id=NEW.book_id AND r.id=(e->>'id')::uuid AND a.financial_account_id=(p->>'financialAccountId')::uuid AND a.instrument_id=(p->>'instrumentId')::uuid AND a.status='committed';
   ELSE RAISE EXCEPTION 'investment-reconciliation-correction-kind' USING ERRCODE='23514'; END CASE;
   IF actual_record IS NULL OR actual_record IS DISTINCT FROM e->'snapshot' OR NOT (NEW.event->'resolution'->'correctiveRecords' @> jsonb_build_array(jsonb_build_object('kind',e->>'kind','id',e->>'id'))) THEN RAISE EXCEPTION 'investment-reconciliation-correction-mismatch' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR e IN SELECT item FROM jsonb_array_elements(NEW.event->'evidenceSnapshots') item LOOP
   IF NOT (NEW.event->'resolution'->'evidenceIds' @> jsonb_build_array(e->>'id')) OR NOT EXISTS(SELECT 1 FROM emdo.finance_book_evidence WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=(e->>'id')::uuid AND plaintext_sha256=e->>'sourceDigest') THEN RAISE EXCEPTION 'investment-reconciliation-evidence-mismatch' USING ERRCODE='23514'; END IF;
  END LOOP;
 ELSIF NEW.event->>'kind' IN ('created','reopened') THEN
  IF h.status<>'open' OR NEW.event->'resolution'<>'null'::jsonb OR (NEW.event->>'kind'='reopened' AND p->>'comparisonHash'=prior->'comparison'->>'comparisonHash') THEN RAISE EXCEPTION 'investment-reconciliation-open-invalid' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'investment-reconciliation-kind-invalid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION emdo.validate_investment_reconciliation_event() FROM PUBLIC;
CREATE TRIGGER b_validate_investment_reconciliation_event BEFORE INSERT ON emdo.finance_investment_reconciliation_events FOR EACH ROW EXECUTE FUNCTION emdo.validate_investment_reconciliation_event();
--> statement-breakpoint
CREATE FUNCTION emdo.validate_investment_reconciliation_header() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,emdo AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.workspace_id<>OLD.workspace_id OR NEW.book_id<>OLD.book_id OR NEW.id<>OLD.id OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1) THEN RAISE EXCEPTION 'investment-reconciliation-header-immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM emdo.finance_investment_reconciliation_events WHERE case_id=NEW.id AND revision=NEW.revision AND ((event->>'kind'='resolved')=(NEW.status='resolved'))) THEN RAISE EXCEPTION 'investment-reconciliation-history-required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION emdo.validate_investment_reconciliation_header() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER investment_reconciliation_history_required AFTER INSERT OR UPDATE ON emdo.finance_investment_reconciliation_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION emdo.validate_investment_reconciliation_header();
