-- Explicit administrator review retains all uncertain spend evidence; retry is separate.
GRANT SELECT ON emdo.finance_standardization_reconciliations TO emdo_finance_standardization_executor;
CREATE POLICY standardization_executor_reconciliation_read ON emdo.finance_standardization_reconciliations FOR SELECT TO emdo_finance_standardization_executor USING(true);
GRANT EXECUTE ON FUNCTION emdo.standardization_denial(emdo.finance_standardization_runs) TO emdo_finance_standardization_reconciler;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['workspace_entitlements','finance_automation_authority_epochs','finance_book_evidence','finance_standardization_configuration'] LOOP
  EXECUTE format('GRANT SELECT ON emdo.%I TO emdo_finance_standardization_reconciler',t);
  EXECUTE format('CREATE POLICY standardization_retained_cost_authority_read ON emdo.%I FOR SELECT TO emdo_finance_standardization_reconciler USING(true)',t);
 END LOOP;
END $$;
GRANT UPDATE(revision) ON emdo.finance_automation_authority_epochs TO emdo_finance_standardization_reconciler;
CREATE POLICY standardization_retained_cost_authority_lock ON emdo.finance_automation_authority_epochs FOR UPDATE TO emdo_finance_standardization_reconciler USING(true) WITH CHECK(true);


CREATE OR REPLACE FUNCTION emdo.guard_finance_standardization_reconciliation() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'standardization reconciliation evidence is immutable' USING ERRCODE='23514';
 END IF;

 IF TG_OP='INSERT' THEN
  IF NEW.lookup_token IS NOT NULL OR NEW.lookup_expires_at IS NOT NULL OR NEW.observed_at IS NOT NULL THEN
   RAISE EXCEPTION 'standardization reconciliation lifecycle fields invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='receipt' THEN
   IF NEW.reservation_id IS NULL OR NEW.facts->>'status'<>'pending'
      OR NEW.facts->>'providerResponseId' IS NULL
      OR length(NEW.facts->>'providerResponseId') NOT BETWEEN 1 AND 200
      OR NEW.facts->>'receiptDigest' IS NOT NULL
      OR NEW.facts->>'inputTokens' IS NOT NULL
      OR NEW.facts->>'outputTokens' IS NOT NULL
      OR NEW.facts->>'actualCadMinor' IS NOT NULL
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.facts) AS k(name)
                WHERE name NOT IN ('status','providerResponseId','receiptDigest','inputTokens','outputTokens','actualCadMinor')) THEN
    RAISE EXCEPTION 'standardization receipt must start as pending' USING ERRCODE='23514';
   END IF;
  ELSIF NEW.kind='resolution' THEN
   IF NEW.facts->>'decision' NOT IN ('confirm-not-sent','accept-actual-cost','retain-reserved-cost')
      OR (NEW.facts->>'decision'='retain-reserved-cost' AND (NEW.reservation_id IS NULL OR NEW.facts->>'receiptId' IS NOT NULL))
      OR NOT (NEW.facts ? 'receiptId')
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.facts) AS k(name)
                WHERE name NOT IN ('decision','receiptId')) THEN
    RAISE EXCEPTION 'standardization resolution evidence invalid' USING ERRCODE='23514';
   END IF;
  ELSE
   RAISE EXCEPTION 'standardization reconciliation kind invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;

 IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.run_revision IS DISTINCT FROM OLD.run_revision
    OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'standardization reconciliation identity is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.kind<>'receipt' OR OLD.facts->>'status'<>'pending' THEN
  RAISE EXCEPTION 'terminal standardization reconciliation evidence is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.facts->>'status'='pending' THEN
  IF NEW.facts IS DISTINCT FROM OLD.facts OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
     OR (NEW.lookup_token IS NULL) IS DISTINCT FROM (NEW.lookup_expires_at IS NULL) THEN
   RAISE EXCEPTION 'pending receipt may only change its lookup lease' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.facts->>'status' IS NULL OR NEW.facts->>'status' NOT IN ('verified','unavailable','mismatch')
    OR NEW.lookup_token IS NOT NULL OR NEW.lookup_expires_at IS NOT NULL
    OR NEW.observed_at IS NULL
    OR NEW.facts->>'providerResponseId' IS DISTINCT FROM OLD.facts->>'providerResponseId'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.facts) AS k(name)
              WHERE name NOT IN ('status','providerResponseId','receiptDigest','inputTokens','outputTokens','actualCadMinor')) THEN
  RAISE EXCEPTION 'standardization terminal receipt binding invalid' USING ERRCODE='23514';
 END IF;
 IF NEW.facts->>'status'='verified' THEN
  IF NEW.facts->>'receiptDigest' IS NULL OR NEW.facts->>'receiptDigest' !~ '^[a-f0-9]{64}$'
     OR NEW.facts->>'inputTokens' IS NULL OR NEW.facts->>'inputTokens' !~ '^[0-9]+$'
     OR NEW.facts->>'outputTokens' IS NULL OR NEW.facts->>'outputTokens' !~ '^[0-9]+$'
     OR NEW.facts->>'actualCadMinor' IS NULL OR NEW.facts->>'actualCadMinor' !~ '^[0-9]+$' THEN
   RAISE EXCEPTION 'verified standardization receipt facts invalid' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NEW.facts->>'id' IS NOT NULL OR NEW.facts->>'model' IS NOT NULL
     OR NEW.facts->>'receiptDigest' IS NOT NULL
     OR NEW.facts->>'inputTokens' IS NOT NULL
     OR NEW.facts->>'outputTokens' IS NOT NULL
     OR NEW.facts->>'actualCadMinor' IS NOT NULL THEN
   RAISE EXCEPTION 'unavailable standardization receipt cannot assert usage' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION emdo.resolve_standardization_outcome(w uuid,b uuid,rid uuid,expected integer,reservation uuid,decision text,receipt_id uuid,k text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; s emdo.finance_standardization_spend; evidence emdo.finance_standardization_reconciliations; prior emdo.finance_command_receipts; h text; actual integer; response_id text;
BEGIN
 PERFORM emdo.standardization_app_book(w,b,true);
 IF NOT emdo.finance_book_access(w,b,ARRAY['administrator']) THEN RAISE EXCEPTION 'standardization-admin-required' USING ERRCODE='42501';END IF;
 IF decision NOT IN ('confirm-not-sent','accept-actual-cost','retain-reserved-cost') OR k !~ '^[a-fA-F0-9-]{36}$' THEN RAISE EXCEPTION 'standardization-resolution-invalid' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||emdo.current_user_id()::text||':'||k,0));
 h:=encode(sha256(convert_to(jsonb_build_array(b,rid,expected,reservation,decision,receipt_id)::text,'UTF8')),'hex');
 SELECT * INTO prior FROM emdo.finance_command_receipts WHERE workspace_id=w AND user_id=emdo.current_user_id() AND idempotency_key=k;
 IF FOUND THEN IF prior.operation<>'standardization.resolve' OR prior.payload_hash<>h THEN RAISE EXCEPTION 'standardization-idempotency-conflict' USING ERRCODE='23514';END IF;RETURN;END IF;
 IF decision='retain-reserved-cost' THEN
  PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=w FOR UPDATE;
 END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid AND workspace_id=w AND book_id=b FOR UPDATE;
 IF NOT FOUND OR r.revision<>expected OR r.status NOT IN ('indeterminate','cancelled','authority-revoked') OR coalesce(r.lease_expires_at>clock_timestamp(),false) THEN RAISE EXCEPTION 'standardization-resolution-conflict' USING ERRCODE='23514';END IF;
 IF reservation IS NULL THEN
  IF decision<>'confirm-not-sent' OR receipt_id IS NOT NULL OR EXISTS(SELECT FROM emdo.finance_standardization_spend WHERE run_id=rid) THEN RAISE EXCEPTION 'standardization-not-sent-unproven' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO s FROM emdo.finance_standardization_spend WHERE id=reservation AND run_id=rid FOR UPDATE;
  IF NOT FOUND OR s.attempt<>r.attempt THEN RAISE EXCEPTION 'standardization-reservation-conflict' USING ERRCODE='23514';END IF;
  IF decision='retain-reserved-cost' THEN
   IF r.status<>'indeterminate' OR r.attempt>=3 OR s.status<>'indeterminate' OR receipt_id IS NOT NULL OR emdo.standardization_denial(r) IS NOT NULL THEN RAISE EXCEPTION 'standardization-retained-cost-not-retryable' USING ERRCODE='23514';END IF;
   -- Preserve the entire uncertain spend record. This review never settles cost.
  ELSIF decision='confirm-not-sent' THEN
   IF receipt_id IS NOT NULL OR s.status='completed' OR (s.status<>'not-sent' AND s.dispatch_phase<>'not-dispatched') THEN RAISE EXCEPTION 'standardization-not-sent-unproven' USING ERRCODE='23514';END IF;
   UPDATE emdo.finance_standardization_spend SET status='not-sent',actual_cad_minor=0,settled_at=clock_timestamp() WHERE id=reservation;
  ELSE
   IF receipt_id IS NULL THEN
    IF s.status<>'completed' OR s.actual_cad_minor IS NULL OR s.provider_response_id IS NULL THEN RAISE EXCEPTION 'standardization-cost-unproven' USING ERRCODE='23514';END IF;
   ELSE
    SELECT * INTO evidence FROM emdo.finance_standardization_reconciliations WHERE id=receipt_id AND run_id=rid AND reservation_id=reservation AND kind='receipt';
    IF NOT FOUND OR evidence.source_digest<>r.source_digest OR evidence.facts->>'status'<>'verified' OR evidence.facts->>'providerResponseId' IS DISTINCT FROM s.provider_response_id THEN RAISE EXCEPTION 'standardization-receipt-unverified' USING ERRCODE='23514';END IF;
    actual:=(evidence.facts->>'actualCadMinor')::integer;IF actual IS NULL OR actual<0 THEN RAISE EXCEPTION 'standardization-cost-invalid' USING ERRCODE='23514';END IF;
    UPDATE emdo.finance_standardization_spend SET status='completed',actual_cad_minor=actual,settled_at=clock_timestamp() WHERE id=reservation;
   END IF;
  END IF;
 END IF;
 INSERT INTO emdo.finance_standardization_reconciliations(id,run_id,reservation_id,kind,run_revision,source_digest,facts,created_by) VALUES(gen_random_uuid(),rid,reservation,'resolution',expected,r.source_digest,jsonb_build_object('decision',decision,'receiptId',receipt_id),emdo.current_user_id());
 UPDATE emdo.finance_standardization_runs SET status=CASE WHEN status='indeterminate' THEN 'blocked' ELSE status END,revision=revision+1,blockers=jsonb_build_array('Execution outcome was reviewed. Any new attempt requires a separate authorized retry.'),updated_at=clock_timestamp() WHERE id=rid;
 INSERT INTO emdo.finance_command_receipts(workspace_id,user_id,idempotency_key,operation,payload_hash,result) VALUES(w,emdo.current_user_id(),k,'standardization.resolve',h,'{}');
END $$;

CREATE OR REPLACE FUNCTION emdo.change_finance_standardization(w uuid,b uuid,rid uuid,expected integer,action text,k text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; h text; receipt emdo.finance_command_receipts; reason text;
BEGIN
 PERFORM emdo.standardization_app_book(w,b,true);
 IF action NOT IN ('retry','cancel') OR k !~ '^[a-fA-F0-9-]{36}$' THEN RAISE EXCEPTION 'standardization-invalid-action' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||emdo.current_user_id()::text||':'||k,0));
 h:=encode(sha256(convert_to(jsonb_build_object('runId',rid,'revision',expected,'action',action)::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM emdo.finance_command_receipts WHERE workspace_id=w AND user_id=emdo.current_user_id() AND idempotency_key=k;
 IF FOUND THEN IF receipt.operation<>'standardization.change' OR receipt.payload_hash<>h THEN RAISE EXCEPTION 'standardization-idempotency-conflict' USING ERRCODE='23514'; END IF;RETURN receipt.result; END IF;
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=w FOR UPDATE;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid AND workspace_id=w AND book_id=b FOR UPDATE;
 IF NOT FOUND OR (r.authorized_by<>emdo.current_user_id() AND NOT emdo.finance_book_access(w,b,ARRAY['administrator'])) THEN RAISE EXCEPTION 'standardization-run-access-denied' USING ERRCODE='42501'; END IF;
 IF r.revision<>expected THEN RAISE EXCEPTION 'standardization-revision-conflict' USING ERRCODE='23514'; END IF;
 IF action='cancel' THEN
 IF r.status NOT IN ('queued','extracting','proposing') THEN RAISE EXCEPTION 'standardization-not-cancellable' USING ERRCODE='23514'; END IF;
 UPDATE emdo.finance_standardization_runs SET status='cancelled',revision=revision+1,delivery_pending=false,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=rid;
 ELSE
 reason:=emdo.standardization_denial(r);
 IF r.status<>'blocked' OR r.attempt>=3 OR reason IS NOT NULL OR EXISTS(SELECT FROM emdo.finance_standardization_spend s WHERE s.run_id=rid AND (s.status='reserved' OR (s.status='indeterminate' AND NOT EXISTS(SELECT FROM emdo.finance_standardization_reconciliations e WHERE e.run_id=rid AND e.reservation_id=s.id AND e.source_digest=r.source_digest AND e.kind='resolution' AND e.facts->>'decision'='retain-reserved-cost' AND e.run_revision<r.revision)))) THEN RAISE EXCEPTION 'standardization-not-retryable' USING ERRCODE='23514'; END IF;
 UPDATE emdo.finance_standardization_runs SET status='queued',revision=revision+1,delivery_revision=delivery_revision+1,delivery_pending=true,delivery_token=NULL,delivery_expires_at=NULL,lease_token=NULL,lease_expires_at=NULL,blockers='[]'::jsonb,updated_at=clock_timestamp() WHERE id=rid;
 END IF;
 INSERT INTO emdo.finance_command_receipts(workspace_id,user_id,idempotency_key,operation,payload_hash,result) VALUES(w,emdo.current_user_id(),k,'standardization.change',h,jsonb_build_object('id',rid));RETURN jsonb_build_object('id',rid);
END $$;

CREATE OR REPLACE FUNCTION emdo.block_finance_standardization(rid uuid,rev integer,token uuid,outcome text,reason text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs;
BEGIN
 IF NOT emdo.standardization_worker_identity() THEN RAISE EXCEPTION 'standardization-worker-denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid FOR UPDATE;
 IF r.revision<>rev OR r.lease_token IS DISTINCT FROM token OR r.status NOT IN ('extracting','proposing') THEN RETURN false; END IF;
 IF outcome NOT IN ('blocked','indeterminate','authority-revoked') OR length(reason) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'standardization-invalid-outcome' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM emdo.finance_standardization_spend s WHERE s.run_id=rid AND (s.status='reserved' OR (s.status='indeterminate' AND NOT EXISTS(SELECT FROM emdo.finance_standardization_reconciliations e WHERE e.run_id=rid AND e.reservation_id=s.id AND e.source_digest=r.source_digest AND e.kind='resolution' AND e.facts->>'decision'='retain-reserved-cost' AND e.run_revision<r.revision)))) THEN outcome:='indeterminate'; END IF;
 UPDATE emdo.finance_standardization_runs SET status=outcome,revision=revision+1,blockers=jsonb_build_array(reason),lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=rid;RETURN true;
END $$;
