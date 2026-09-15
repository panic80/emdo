-- Reviewed cash-in-lieu settlements preserve exact rational allocation proof while
-- successor quantities remain explicitly bounded by the existing numeric(38,12) ledger.
CREATE TABLE emdo.finance_investment_corporate_action_settlements (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, book_id uuid NOT NULL,
 action_id uuid NOT NULL, source_row_id uuid NOT NULL,
 receipt_revision integer NOT NULL CONSTRAINT finance_ca_settlement_receipt_revision_check CHECK(receipt_revision>=0),
 receipt_snapshot_hash text NOT NULL CONSTRAINT finance_ca_settlement_receipt_hash_check CHECK(receipt_snapshot_hash ~ '^[a-f0-9]{64}$'),
 economic_transaction_id uuid NOT NULL, action_journal_id uuid NOT NULL,
 receipt_journal_id uuid NOT NULL,
 command_hash text NOT NULL CONSTRAINT finance_ca_settlement_command_hash_check CHECK(command_hash ~ '^[a-f0-9]{64}$'),
 proof jsonb NOT NULL CONSTRAINT finance_ca_settlement_proof_check CHECK(jsonb_typeof(proof)='object'),
 proof_hash text NOT NULL CONSTRAINT finance_ca_settlement_proof_hash_check CHECK(proof_hash ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL CONSTRAINT finance_ca_settlement_result_check CHECK(jsonb_typeof(result)='object'),
 created_by uuid NOT NULL CONSTRAINT finance_ca_settlement_creator_fk REFERENCES emdo.auth_users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT finance_ca_settlement_scope UNIQUE(workspace_id,book_id,id),
 CONSTRAINT finance_ca_settlement_action UNIQUE(workspace_id,book_id,action_id),
 CONSTRAINT finance_ca_settlement_receipt UNIQUE(workspace_id,book_id,source_row_id),
 CONSTRAINT finance_ca_settlement_economic UNIQUE(workspace_id,book_id,economic_transaction_id),
 CONSTRAINT finance_ca_settlement_action_fk FOREIGN KEY(workspace_id,book_id,action_id) REFERENCES emdo.finance_investment_corporate_actions(workspace_id,book_id,id),
 CONSTRAINT finance_ca_settlement_receipt_fk FOREIGN KEY(workspace_id,book_id,source_row_id) REFERENCES emdo.finance_normalized_import_rows(workspace_id,book_id,id),
 CONSTRAINT finance_ca_settlement_economic_fk FOREIGN KEY(workspace_id,book_id,economic_transaction_id) REFERENCES emdo.finance_economic_transactions(workspace_id,book_id,id),
 CONSTRAINT finance_ca_settlement_action_journal_fk FOREIGN KEY(workspace_id,book_id,action_journal_id) REFERENCES emdo.finance_journals(workspace_id,book_id,id),
 CONSTRAINT finance_ca_settlement_receipt_journal_fk FOREIGN KEY(workspace_id,book_id,receipt_journal_id) REFERENCES emdo.finance_journals(workspace_id,book_id,id)
);
CREATE TABLE emdo.finance_investment_corporate_action_settlement_evidence (
 workspace_id uuid NOT NULL,book_id uuid NOT NULL,settlement_id uuid NOT NULL,
 evidence_id uuid NOT NULL,plaintext_sha256 text NOT NULL CONSTRAINT finance_ca_settlement_evidence_hash_check CHECK(plaintext_sha256 ~ '^[a-f0-9]{64}$'),
 CONSTRAINT finance_ca_settlement_evidence_pk PRIMARY KEY(workspace_id,book_id,settlement_id,evidence_id),
 CONSTRAINT finance_ca_settlement_evidence_settlement_fk FOREIGN KEY(workspace_id,book_id,settlement_id) REFERENCES emdo.finance_investment_corporate_action_settlements(workspace_id,book_id,id),
 CONSTRAINT finance_ca_settlement_evidence_evidence_fk FOREIGN KEY(workspace_id,book_id,evidence_id) REFERENCES emdo.finance_book_evidence(workspace_id,book_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['finance_investment_corporate_action_settlements','finance_investment_corporate_action_settlement_evidence'] LOOP
  EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC,emdo_worker,emdo_workflow',t);
  EXECUTE format('GRANT SELECT,INSERT ON emdo.%I TO emdo_app',t);
  EXECUTE format('CREATE POLICY settlement_read ON emdo.%I FOR SELECT TO emdo_app USING(emdo.finance_book_access(workspace_id,book_id))',t);
  EXECUTE format('CREATE POLICY settlement_insert ON emdo.%I FOR INSERT TO emdo_app WITH CHECK(emdo.finance_book_access(workspace_id,book_id,ARRAY[''administrator'',''approver'']))',t);
  EXECUTE format('CREATE TRIGGER settlement_lock BEFORE INSERT ON emdo.%I FOR EACH ROW EXECUTE FUNCTION emdo.lock_finance_book_mutation()',t);
  EXECUTE format('CREATE TRIGGER settlement_immutable BEFORE UPDATE OR DELETE ON emdo.%I FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_corporate_action_mutation()',t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION emdo.guard_finance_ca_settlement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE a emdo.finance_investment_corporate_actions; r emdo.finance_normalized_import_rows; x emdo.finance_economic_transactions; p jsonb;
BEGIN
 SELECT * INTO a FROM emdo.finance_investment_corporate_actions WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.action_id;
 SELECT * INTO r FROM emdo.finance_normalized_import_rows WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.source_row_id;
 SELECT * INTO x FROM emdo.finance_economic_transactions WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.economic_transaction_id;
 p:=NEW.proof->'settlement';
 IF NEW.created_by IS DISTINCT FROM emdo.current_user_id() OR a.id IS NULL OR a.status<>'committed' OR a.fractional_treatment<>'cash-in-lieu' OR a.command_hash<>NEW.command_hash OR
    p->>'actionId' IS DISTINCT FROM a.id::text OR p->>'financialAccountId' IS DISTINCT FROM a.financial_account_id::text OR p->>'instrumentId' IS DISTINCT FROM a.instrument_id::text OR (p->>'effectiveOn')::date IS DISTINCT FROM a.effective_on OR
    NEW.result->>'settlementId' IS DISTINCT FROM NEW.id::text OR NEW.result->>'actionId' IS DISTINCT FROM NEW.action_id::text OR NEW.result->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text OR NEW.result->>'bookId' IS DISTINCT FROM NEW.book_id::text OR NEW.result->>'economicTransactionId' IS DISTINCT FROM NEW.economic_transaction_id::text OR
    NEW.result->'journalIds'->>0 IS DISTINCT FROM NEW.action_journal_id::text OR NEW.result->'journalIds'->>-1 IS DISTINCT FROM NEW.receipt_journal_id::text OR
    r.id IS NULL OR r.status<>'committed' OR r.revision<>NEW.receipt_revision+1 OR r.economic_transaction_id<>NEW.economic_transaction_id OR
    x.id IS NULL OR x.financial_account_id<>a.financial_account_id OR x.journal_id<>NEW.receipt_journal_id OR
    x.effective_on IS DISTINCT FROM (p->>'settledOn')::date OR x.native_amount IS DISTINCT FROM (p->'cashConsideration'->'native'->>'amount')::numeric OR
    x.functional_amount IS DISTINCT FROM (p->'cashConsideration'->'functional'->>'amount')::numeric OR
    NOT EXISTS(SELECT 1 FROM emdo.finance_journals WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.action_journal_id AND status='posted' AND effective_on=a.effective_on) OR
    NOT EXISTS(SELECT 1 FROM emdo.finance_journals WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.receipt_journal_id AND status='posted' AND effective_on=x.effective_on)
 THEN RAISE EXCEPTION 'finance-settlement-binding-invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION emdo.guard_finance_ca_settlement() FROM PUBLIC;
CREATE TRIGGER settlement_binding BEFORE INSERT ON emdo.finance_investment_corporate_action_settlements FOR EACH ROW EXECUTE FUNCTION emdo.guard_finance_ca_settlement();
--> statement-breakpoint
CREATE TABLE emdo.finance_investment_corporate_action_settlement_allocations (
 workspace_id uuid NOT NULL, book_id uuid NOT NULL, settlement_id uuid NOT NULL,
 action_id uuid NOT NULL, source_lot_id uuid NOT NULL,
 retained_numerator text NOT NULL CONSTRAINT finance_ca_settlement_retained_numerator_check CHECK(retained_numerator ~ '^(0|[1-9][0-9]{0,119})$'),
 retained_denominator text NOT NULL CONSTRAINT finance_ca_settlement_retained_denominator_check CHECK(retained_denominator ~ '^[1-9][0-9]{0,119}$'),
 disposed_numerator text NOT NULL CONSTRAINT finance_ca_settlement_disposed_numerator_check CHECK(disposed_numerator ~ '^(0|[1-9][0-9]{0,119})$'),
 disposed_denominator text NOT NULL CONSTRAINT finance_ca_settlement_disposed_denominator_check CHECK(disposed_denominator ~ '^[1-9][0-9]{0,119}$'),
 retained_native_cost numeric(38,12) NOT NULL CONSTRAINT finance_ca_settlement_retained_native_cost_check CHECK(retained_native_cost>=0 AND retained_native_cost<>'NaN'::numeric),
 retained_functional_cost numeric(38,12) NOT NULL CONSTRAINT finance_ca_settlement_retained_functional_cost_check CHECK(retained_functional_cost>=0 AND retained_functional_cost<>'NaN'::numeric),
 disposed_native_cost numeric(38,12) NOT NULL CONSTRAINT finance_ca_settlement_disposed_native_cost_check CHECK(disposed_native_cost>=0 AND disposed_native_cost<>'NaN'::numeric),
 disposed_functional_cost numeric(38,12) NOT NULL CONSTRAINT finance_ca_settlement_disposed_functional_cost_check CHECK(disposed_functional_cost>=0 AND disposed_functional_cost<>'NaN'::numeric),
 CONSTRAINT finance_ca_settlement_allocation_pk PRIMARY KEY(workspace_id,book_id,settlement_id,source_lot_id),
 CONSTRAINT finance_ca_settlement_allocation_settlement_fk FOREIGN KEY(workspace_id,book_id,settlement_id) REFERENCES emdo.finance_investment_corporate_action_settlements(workspace_id,book_id,id),
 CONSTRAINT finance_ca_settlement_allocation_effect_fk FOREIGN KEY(workspace_id,book_id,action_id,source_lot_id) REFERENCES emdo.finance_investment_corporate_action_effects(workspace_id,book_id,action_id,source_lot_id)
);
ALTER TABLE emdo.finance_investment_corporate_action_settlement_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_investment_corporate_action_settlement_allocations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON emdo.finance_investment_corporate_action_settlement_allocations FROM PUBLIC,emdo_worker,emdo_workflow;
GRANT SELECT,INSERT ON emdo.finance_investment_corporate_action_settlement_allocations TO emdo_app;
CREATE POLICY settlement_read ON emdo.finance_investment_corporate_action_settlement_allocations FOR SELECT TO emdo_app USING(emdo.finance_book_access(workspace_id,book_id));
CREATE POLICY settlement_insert ON emdo.finance_investment_corporate_action_settlement_allocations FOR INSERT TO emdo_app WITH CHECK(emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','approver']));
CREATE TRIGGER settlement_lock BEFORE INSERT ON emdo.finance_investment_corporate_action_settlement_allocations FOR EACH ROW EXECUTE FUNCTION emdo.lock_finance_book_mutation();
CREATE TRIGGER settlement_immutable BEFORE UPDATE OR DELETE ON emdo.finance_investment_corporate_action_settlement_allocations FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_corporate_action_mutation();
CREATE FUNCTION emdo.guard_finance_ca_settlement_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,emdo SET row_security=on AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM emdo.finance_book_evidence WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.evidence_id AND plaintext_sha256=NEW.plaintext_sha256) THEN
 RAISE EXCEPTION 'finance-settlement-evidence-hash-conflict' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION emdo.guard_finance_ca_settlement_evidence() FROM PUBLIC;
CREATE TRIGGER settlement_evidence_binding BEFORE INSERT ON emdo.finance_investment_corporate_action_settlement_evidence FOR EACH ROW EXECUTE FUNCTION emdo.guard_finance_ca_settlement_evidence();
CREATE FUNCTION emdo.guard_finance_ca_settlement_allocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE e emdo.finance_investment_corporate_action_effects; a emdo.finance_investment_corporate_actions;
BEGIN
 SELECT * INTO e FROM emdo.finance_investment_corporate_action_effects WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND action_id=NEW.action_id AND source_lot_id=NEW.source_lot_id;
 SELECT * INTO a FROM emdo.finance_investment_corporate_actions WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.action_id;
 IF NOT EXISTS(SELECT 1 FROM emdo.finance_investment_corporate_action_settlements WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.settlement_id AND action_id=NEW.action_id) OR e.id IS NULL OR a.id IS NULL OR
 NEW.retained_numerator::numeric<>e.successor_quantity*NEW.retained_denominator::numeric OR
 (NEW.retained_numerator::numeric*NEW.disposed_denominator::numeric+NEW.disposed_numerator::numeric*NEW.retained_denominator::numeric)*a.denominator<>e.source_remaining_quantity*a.numerator*NEW.retained_denominator::numeric*NEW.disposed_denominator::numeric OR
 NEW.retained_native_cost<>e.successor_native_cost_basis OR NEW.retained_functional_cost<>e.successor_functional_cost_basis OR
 NEW.retained_native_cost+NEW.disposed_native_cost<>e.source_native_cost_basis OR NEW.retained_functional_cost+NEW.disposed_functional_cost<>e.source_functional_cost_basis
 THEN RAISE EXCEPTION 'finance-settlement-allocation-binding-invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION emdo.guard_finance_ca_settlement_allocation() FROM PUBLIC;
CREATE TRIGGER settlement_allocation_binding BEFORE INSERT ON emdo.finance_investment_corporate_action_settlement_allocations FOR EACH ROW EXECUTE FUNCTION emdo.guard_finance_ca_settlement_allocation();
CREATE FUNCTION emdo.check_finance_ca_settlement_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,emdo SET row_security=on AS $$
BEGIN
 IF (SELECT count(*) FROM emdo.finance_investment_corporate_action_settlement_allocations WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND settlement_id=NEW.id)<>(SELECT count(*) FROM emdo.finance_investment_corporate_action_effects WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND action_id=NEW.action_id AND source_remaining_quantity>0) OR
 (SELECT count(*) FROM emdo.finance_investment_corporate_action_settlement_allocations WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND settlement_id=NEW.id)<>jsonb_array_length(NEW.proof->'settlement'->'allocations') OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.proof->'evidenceHashes') ev WHERE NOT EXISTS(SELECT 1 FROM emdo.finance_investment_corporate_action_settlement_evidence e WHERE e.workspace_id=NEW.workspace_id AND e.book_id=NEW.book_id AND e.settlement_id=NEW.id AND e.evidence_id=(ev->>'evidenceId')::uuid AND e.plaintext_sha256=ev->>'sha256'))
 THEN RAISE EXCEPTION 'finance-settlement-proof-incomplete' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION emdo.check_finance_ca_settlement_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER settlement_complete AFTER INSERT ON emdo.finance_investment_corporate_action_settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION emdo.check_finance_ca_settlement_complete();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.check_import_review()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  current_row emdo.finance_normalized_import_rows;
BEGIN
  SELECT * INTO current_row
    FROM emdo.finance_normalized_import_rows
   WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.row_id;
  IF NEW.reviewed_by IS DISTINCT FROM emdo.current_user_id()
     OR current_row.id IS NULL
     OR NEW.revision<>current_row.revision+1
     OR length(coalesce(NEW.decision->>'reason',''))<3
     OR NEW.previous_facts IS DISTINCT FROM jsonb_build_object(
       'date',current_row.effective_on::text,
       'description',current_row.description,
       'amount',current_row.native_amount::text,
       'externalId',current_row.external_id
     )
     OR NOT EXISTS(
       SELECT 1 FROM emdo.finance_normalized_imports i
        WHERE i.workspace_id=NEW.workspace_id AND i.book_id=NEW.book_id
          AND i.id=current_row.batch_id AND i.status='review'
     )
     OR NOT (
       NEW.decision->>'action' IN ('post','match','ignore')
       OR (NEW.decision->>'action'='cash-in-lieu' AND current_row.status='ready'
         AND NEW.decision->>'sourceSnapshotHash' ~ '^[a-f0-9]{64}$'
         AND EXISTS(SELECT 1 FROM emdo.finance_investment_corporate_actions a WHERE a.workspace_id=NEW.workspace_id AND a.book_id=NEW.book_id AND a.id::text=NEW.decision->>'actionId' AND a.fractional_treatment='cash-in-lieu' AND a.status='committed'))
       OR (
         NEW.decision->>'action'='cash-dividend'
         AND current_row.status='ready'
         AND NEW.decision->>'dividendActionId' IS NOT NULL
         AND NEW.decision->>'sourceSnapshotHash' ~ '^[a-f0-9]{64}$'
         AND EXISTS(
           SELECT 1 FROM emdo.finance_investment_cash_dividends a
            WHERE a.workspace_id=NEW.workspace_id AND a.book_id=NEW.book_id
              AND a.id::text=NEW.decision->>'dividendActionId'
              AND a.source_row_id=current_row.id
              AND a.source_revision=current_row.revision
              AND a.source_snapshot_hash=NEW.decision->>'sourceSnapshotHash'
              AND a.status='committed'
         )
       )
     ) THEN
    RAISE EXCEPTION 'review revision or provenance is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION emdo.check_import_review() FROM PUBLIC;


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
    SELECT decision INTO review
      FROM emdo.finance_import_row_reviews
     WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id
       AND row_id=NEW.id AND revision=NEW.revision
       AND reviewed_by=emdo.current_user_id();
    IF review->>'action'='cash-in-lieu' THEN
      IF NEW.status<>'committed' OR OLD.status<>'ready' OR NEW.revision<>OLD.revision+1
         OR NOT emdo.finance_book_access(NEW.workspace_id,NEW.book_id,ARRAY['administrator','approver'])
         OR (NEW.effective_on,NEW.description,NEW.native_amount,NEW.external_id,NEW.issues,NEW.counter_account_id,NEW.match_journal_id,NEW.fx_rate,NEW.fx_source)
           IS DISTINCT FROM (OLD.effective_on,OLD.description,OLD.native_amount,OLD.external_id,OLD.issues,OLD.counter_account_id,OLD.match_journal_id,OLD.fx_rate,OLD.fx_source)
         OR NOT EXISTS(SELECT 1 FROM emdo.finance_economic_transactions x WHERE x.workspace_id=NEW.workspace_id AND x.book_id=NEW.book_id AND x.id=NEW.economic_transaction_id AND x.financial_account_id=batch.financial_account_id AND x.effective_on=NEW.effective_on AND x.native_amount=NEW.native_amount AND x.fx_rate=NEW.fx_rate)
         OR NOT EXISTS(SELECT 1 FROM emdo.finance_investment_corporate_actions a WHERE a.workspace_id=NEW.workspace_id AND a.book_id=NEW.book_id AND a.id::text=review->>'actionId' AND a.financial_account_id=batch.financial_account_id AND a.status='committed' AND a.fractional_treatment='cash-in-lieu')
      THEN RAISE EXCEPTION 'cash-in-lieu source claim must match saved action' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END IF;
    IF review->>'action'='cash-dividend' THEN
      IF NEW.status<>'committed' OR OLD.status<>'ready'
         OR NEW.revision<>OLD.revision+1
         OR NOT emdo.finance_book_access(NEW.workspace_id,NEW.book_id,ARRAY['administrator','approver'])
         OR (NEW.effective_on,NEW.description,NEW.native_amount,NEW.external_id,
             NEW.issues,NEW.counter_account_id,NEW.match_journal_id,NEW.fx_rate,
             NEW.fx_source)
            IS DISTINCT FROM
            (OLD.effective_on,OLD.description,OLD.native_amount,OLD.external_id,
             OLD.issues,OLD.counter_account_id,OLD.match_journal_id,OLD.fx_rate,
             OLD.fx_source)
         OR NEW.economic_transaction_id IS NULL
         OR review->>'dividendActionId' IS NULL
         OR review->>'sourceSnapshotHash' IS NULL
         OR NOT EXISTS(
           SELECT 1 FROM emdo.finance_investment_cash_dividends a
            WHERE a.workspace_id=NEW.workspace_id AND a.book_id=NEW.book_id
              AND a.id::text=review->>'dividendActionId'
              AND a.source_row_id=NEW.id
              AND a.source_revision=OLD.revision
              AND a.source_snapshot_hash=review->>'sourceSnapshotHash'
              AND a.economic_transaction_id=NEW.economic_transaction_id
              AND a.status='committed'
         ) THEN
        RAISE EXCEPTION 'cash-dividend source claim must match saved action' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END IF;
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

CREATE FUNCTION emdo.check_finance_ca_receipt_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,emdo SET row_security=on AS $$
BEGIN
 IF NEW.status='committed' AND EXISTS(SELECT 1 FROM emdo.finance_import_row_reviews WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND row_id=NEW.id AND revision=NEW.revision AND decision->>'action'='cash-in-lieu') AND NOT EXISTS(SELECT 1 FROM emdo.finance_investment_corporate_action_settlements WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND source_row_id=NEW.id AND receipt_revision=NEW.revision-1 AND economic_transaction_id=NEW.economic_transaction_id) THEN
 RAISE EXCEPTION 'finance-settlement-receipt-proof-required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION emdo.check_finance_ca_receipt_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER settlement_receipt_complete AFTER UPDATE ON emdo.finance_normalized_import_rows DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION emdo.check_finance_ca_receipt_complete();
