CREATE TABLE "emdo"."finance_standardization_reconciliations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"reservation_id" uuid,
	"kind" text NOT NULL,
	"lookup_token" uuid,
	"lookup_expires_at" timestamp with time zone,
	"observed_at" timestamp with time zone,
	"run_revision" integer NOT NULL,
	"source_digest" text NOT NULL,
	"facts" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "standardization_reconciliation_bounds" CHECK ("emdo"."finance_standardization_reconciliations"."kind" in ('receipt','resolution') and "emdo"."finance_standardization_reconciliations"."run_revision">0 and "emdo"."finance_standardization_reconciliations"."source_digest" ~ '^[a-f0-9]{64}$' and octet_length("emdo"."finance_standardization_reconciliations"."facts"::text)<=8192)
);
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "emdo"."finance_standardization_spend" ADD COLUMN "pricing" jsonb;--> statement-breakpoint
ALTER TABLE "emdo"."finance_standardization_spend" ADD COLUMN "dispatch_phase" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "emdo"."finance_standardization_spend" ADD COLUMN "dispatch_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "emdo"."finance_standardization_reconciliations" ADD CONSTRAINT "finance_standardization_reconciliations_run_id_finance_standardization_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "emdo"."finance_standardization_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_standardization_reconciliations" ADD CONSTRAINT "finance_standardization_reconciliations_reservation_id_finance_standardization_spend_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "emdo"."finance_standardization_spend"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_standardization_reconciliations" ADD CONSTRAINT "finance_standardization_reconciliations_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "standardization_reconciliation_run" ON "emdo"."finance_standardization_reconciliations" USING btree ("run_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "standardization_receipt_pending" ON "emdo"."finance_standardization_reconciliations" USING btree ("created_at") WHERE "emdo"."finance_standardization_reconciliations"."kind"='receipt' and "emdo"."finance_standardization_reconciliations"."facts"->>'status'='pending';--> statement-breakpoint
ALTER TABLE "emdo"."finance_standardization_spend" ADD CONSTRAINT "standardization_spend_pricing_bounds" CHECK ("emdo"."finance_standardization_spend"."pricing" is null or (jsonb_typeof("emdo"."finance_standardization_spend"."pricing")='object' and octet_length("emdo"."finance_standardization_spend"."pricing"::text)<=256));--> statement-breakpoint
ALTER TABLE "emdo"."finance_standardization_spend" ADD CONSTRAINT "standardization_dispatch_phase" CHECK ("emdo"."finance_standardization_spend"."dispatch_phase" in ('unknown','not-dispatched','dispatch-started'));
--> statement-breakpoint
-- Append-only receipt/review evidence. A failed lookup never proves no provider dispatch.
ALTER TABLE emdo.finance_standardization_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_standardization_reconciliations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON emdo.finance_standardization_reconciliations FROM PUBLIC,emdo_app,emdo_worker,emdo_worker_executor,emdo_worker_dispatch_executor;
GRANT SELECT,INSERT,UPDATE ON emdo.finance_standardization_reconciliations TO emdo_finance_standardization_executor;
CREATE POLICY standardization_reconciliation_executor ON emdo.finance_standardization_reconciliations TO emdo_finance_standardization_executor USING(true) WITH CHECK(true);

-- Existing callers cannot create a new reservation without pinned rates and a dispatch phase.
REVOKE EXECUTE ON FUNCTION emdo.reserve_standardization_spend(uuid,integer,uuid,text,integer,integer,integer,text,jsonb) FROM emdo_worker_executor;
CREATE FUNCTION emdo.reserve_standardization_spend(rid uuid,rev integer,token uuid,key text,input_ceiling integer,output_ceiling integer,estimate integer,pricing_version text,lineage jsonb,pricing jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE reserved_id uuid;
BEGIN
 IF pricing IS NULL OR jsonb_typeof(pricing) IS DISTINCT FROM 'object' OR octet_length(pricing::text)>256 OR NOT (pricing ?& ARRAY['inputCadMinorPerMillionTokens','outputCadMinorPerMillionTokens']) OR (pricing->>'inputCadMinorPerMillionTokens')::bigint<=0 OR (pricing->>'outputCadMinorPerMillionTokens')::bigint<=0 OR (pricing->>'inputCadMinorPerMillionTokens')::bigint>9007199254740991 OR (pricing->>'outputCadMinorPerMillionTokens')::bigint>9007199254740991 THEN RAISE EXCEPTION 'standardization-pricing-invalid' USING ERRCODE='23514';END IF;
 reserved_id:=emdo.reserve_standardization_spend(rid,rev,token,key,input_ceiling,output_ceiling,estimate,pricing_version,lineage);
 UPDATE emdo.finance_standardization_spend s SET pricing=reserve_standardization_spend.pricing,dispatch_phase='not-dispatched' WHERE s.id=reserved_id;
 RETURN reserved_id;
END $$;
CREATE FUNCTION emdo.mark_standardization_dispatch(rid uuid,rev integer,token uuid,reservation uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs;
BEGIN
 r:=emdo.lock_standardization_claim(rid,rev,token);
 UPDATE emdo.finance_standardization_spend SET dispatch_phase='dispatch-started',dispatch_started_at=clock_timestamp() WHERE id=reservation AND run_id=rid AND claim_revision=rev AND claim_token=token AND status='reserved' AND dispatch_phase='not-dispatched';
 IF NOT FOUND THEN RAISE EXCEPTION 'standardization-dispatch-conflict' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION emdo.read_standardization_reconciliation(w uuid,b uuid,rid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs;
BEGIN
 PERFORM emdo.standardization_app_book(w,b,false);
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid AND workspace_id=w AND book_id=b;
 IF NOT FOUND THEN RAISE EXCEPTION 'standardization-run-denied' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('runId',r.id,'workspaceId',w,'bookId',b,'sourceDigest',r.source_digest,'revision',r.revision,'status',r.status,'hasLiveLease',coalesce(r.lease_expires_at>clock_timestamp(),false),'canResolve',emdo.finance_book_access(w,b,ARRAY['administrator']),
 'spend',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'attempt',s.attempt,'status',s.status,'dispatchPhase',s.dispatch_phase,'pricingVersion',s.pricing_version,'pricing',s.pricing,'reservedCadMinor',s.reserved_cad_minor,'actualCadMinor',s.actual_cad_minor,'providerResponseId',s.provider_response_id,'lineage',s.lineage) ORDER BY s.attempt) FROM emdo.finance_standardization_spend s WHERE s.run_id=rid),'[]'::jsonb),
 'receipts',coalesce((SELECT jsonb_agg(e.facts||jsonb_build_object('id',e.id,'reservationId',e.reservation_id,'observedAt',coalesce(e.observed_at,e.created_at)) ORDER BY e.created_at) FROM emdo.finance_standardization_reconciliations e WHERE e.run_id=rid AND e.kind='receipt'),'[]'::jsonb),
 'resolutions',coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'reservationId',e.reservation_id,'decision',e.facts->>'decision','reviewedBy',e.created_by,'reviewedAt',e.created_at,'receiptId',e.facts->'receiptId') ORDER BY e.created_at) FROM emdo.finance_standardization_reconciliations e WHERE e.run_id=rid AND e.kind='resolution'),'[]'::jsonb));
END $$;
CREATE FUNCTION emdo.request_standardization_receipt(w uuid,b uuid,rid uuid,expected integer,reservation uuid,k text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; s emdo.finance_standardization_spend; request_id uuid:=gen_random_uuid(); existing uuid; prior emdo.finance_command_receipts; h text;
BEGIN
 PERFORM emdo.standardization_app_book(w,b,true);
 IF NOT emdo.finance_book_access(w,b,ARRAY['administrator']) THEN RAISE EXCEPTION 'standardization-admin-required' USING ERRCODE='42501';END IF;
 IF k !~ '^[a-fA-F0-9-]{36}$' THEN RAISE EXCEPTION 'standardization-invalid-key' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||emdo.current_user_id()::text||':'||k,0));
 h:=encode(sha256(convert_to(jsonb_build_array(b,rid,expected,reservation)::text,'UTF8')),'hex');
 SELECT * INTO prior FROM emdo.finance_command_receipts WHERE workspace_id=w AND user_id=emdo.current_user_id() AND idempotency_key=k;
 IF FOUND THEN IF prior.operation<>'standardization.lookup' OR prior.payload_hash<>h THEN RAISE EXCEPTION 'standardization-idempotency-conflict' USING ERRCODE='23514';END IF;RETURN (prior.result->>'id')::uuid;END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid AND workspace_id=w AND book_id=b FOR UPDATE;
 IF NOT FOUND OR r.revision<>expected THEN RAISE EXCEPTION 'standardization-revision-conflict' USING ERRCODE='23514';END IF;
 SELECT * INTO s FROM emdo.finance_standardization_spend WHERE id=reservation AND run_id=rid;
 IF NOT FOUND OR s.provider_response_id IS NULL THEN RAISE EXCEPTION 'standardization-response-id-unavailable' USING ERRCODE='23514';END IF;
 SELECT e.id INTO existing FROM emdo.finance_standardization_reconciliations e WHERE e.run_id=rid AND e.reservation_id=reservation AND e.run_revision=expected AND e.kind='receipt' AND e.facts->>'status' IN ('pending','verified') ORDER BY e.created_at DESC LIMIT 1;
 IF FOUND THEN INSERT INTO emdo.finance_command_receipts(workspace_id,user_id,idempotency_key,operation,payload_hash,result) VALUES(w,emdo.current_user_id(),k,'standardization.lookup',h,jsonb_build_object('id',existing));RETURN existing;END IF;
 IF (SELECT count(*) FROM emdo.finance_standardization_reconciliations WHERE run_id=rid AND kind='receipt')>=30 THEN RAISE EXCEPTION 'standardization-receipt-limit' USING ERRCODE='23514';END IF;
 INSERT INTO emdo.finance_standardization_reconciliations(id,run_id,reservation_id,kind,run_revision,source_digest,facts,created_by) VALUES(request_id,rid,reservation,'receipt',expected,r.source_digest,jsonb_build_object('status','pending','providerResponseId',s.provider_response_id,'receiptDigest',NULL,'inputTokens',NULL,'outputTokens',NULL,'actualCadMinor',NULL),emdo.current_user_id());
 INSERT INTO emdo.finance_command_receipts(workspace_id,user_id,idempotency_key,operation,payload_hash,result) VALUES(w,emdo.current_user_id(),k,'standardization.lookup',h,jsonb_build_object('id',request_id));RETURN request_id;
END $$;
CREATE FUNCTION emdo.claim_standardization_receipt_lookup() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE e emdo.finance_standardization_reconciliations; r emdo.finance_standardization_runs; s emdo.finance_standardization_spend; token uuid:=gen_random_uuid();
BEGIN
 IF NOT emdo.standardization_worker_identity() THEN RAISE EXCEPTION 'standardization-worker-denied' USING ERRCODE='42501';END IF;
 SELECT * INTO e FROM emdo.finance_standardization_reconciliations WHERE kind='receipt' AND facts->>'status'='pending' AND (lookup_expires_at IS NULL OR lookup_expires_at<clock_timestamp()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=e.run_id;
 SELECT * INTO s FROM emdo.finance_standardization_spend WHERE id=e.reservation_id AND run_id=e.run_id;
 IF r.revision<>e.run_revision OR r.source_digest<>e.source_digest OR NOT EXISTS(SELECT FROM emdo.finance_book_grants g JOIN emdo.household_memberships m ON m.household_id=g.workspace_id AND m.user_id=g.user_id JOIN emdo.auth_users u ON u.id=m.user_id WHERE g.workspace_id=r.workspace_id AND g.book_id=r.book_id AND g.user_id=e.created_by AND g.role='administrator' AND g.revoked_at IS NULL AND m.status='active' AND u.email_verified) THEN
 UPDATE emdo.finance_standardization_reconciliations SET observed_at=clock_timestamp(),facts=facts||jsonb_build_object('status','unavailable') WHERE id=e.id;RETURN NULL;END IF;
 UPDATE emdo.finance_standardization_reconciliations SET lookup_token=token,lookup_expires_at=clock_timestamp()+interval '1 minute' WHERE id=e.id;
 RETURN jsonb_build_object('id',e.id,'token',token,'providerResponseId',s.provider_response_id,'pricing',s.pricing);
END $$;
CREATE FUNCTION emdo.record_standardization_receipt_lookup(eid uuid,token uuid,facts jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE e emdo.finance_standardization_reconciliations; r emdo.finance_standardization_runs;
BEGIN
 IF NOT emdo.standardization_worker_identity() THEN RAISE EXCEPTION 'standardization-worker-denied' USING ERRCODE='42501';END IF;
 SELECT * INTO e FROM emdo.finance_standardization_reconciliations WHERE id=eid FOR UPDATE;
 IF NOT FOUND OR e.lookup_token IS DISTINCT FROM token OR e.lookup_expires_at<=clock_timestamp() OR e.facts->>'status'<>'pending' OR e.facts->>'providerResponseId' IS DISTINCT FROM facts->>'providerResponseId' OR facts->>'status' NOT IN ('verified','unavailable','mismatch') THEN RETURN false;END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=e.run_id;
 IF r.revision<>e.run_revision OR r.source_digest<>e.source_digest OR NOT EXISTS(SELECT FROM emdo.finance_book_grants g JOIN emdo.household_memberships m ON m.household_id=g.workspace_id AND m.user_id=g.user_id JOIN emdo.auth_users u ON u.id=m.user_id WHERE g.workspace_id=r.workspace_id AND g.book_id=r.book_id AND g.user_id=e.created_by AND g.role='administrator' AND g.revoked_at IS NULL AND m.status='active' AND u.email_verified) THEN RETURN false;END IF;
 UPDATE emdo.finance_standardization_reconciliations SET observed_at=clock_timestamp(),facts=record_standardization_receipt_lookup.facts,lookup_token=NULL,lookup_expires_at=NULL WHERE id=eid;RETURN true;
END $$;
CREATE FUNCTION emdo.resolve_standardization_outcome(w uuid,b uuid,rid uuid,expected integer,reservation uuid,decision text,receipt_id uuid,k text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; s emdo.finance_standardization_spend; evidence emdo.finance_standardization_reconciliations; prior emdo.finance_command_receipts; h text; actual integer; response_id text;
BEGIN
 PERFORM emdo.standardization_app_book(w,b,true);
 IF NOT emdo.finance_book_access(w,b,ARRAY['administrator']) THEN RAISE EXCEPTION 'standardization-admin-required' USING ERRCODE='42501';END IF;
 IF decision NOT IN ('confirm-not-sent','accept-actual-cost') OR k !~ '^[a-fA-F0-9-]{36}$' THEN RAISE EXCEPTION 'standardization-resolution-invalid' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||emdo.current_user_id()::text||':'||k,0));
 h:=encode(sha256(convert_to(jsonb_build_array(b,rid,expected,reservation,decision,receipt_id)::text,'UTF8')),'hex');
 SELECT * INTO prior FROM emdo.finance_command_receipts WHERE workspace_id=w AND user_id=emdo.current_user_id() AND idempotency_key=k;
 IF FOUND THEN IF prior.operation<>'standardization.resolve' OR prior.payload_hash<>h THEN RAISE EXCEPTION 'standardization-idempotency-conflict' USING ERRCODE='23514';END IF;RETURN;END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid AND workspace_id=w AND book_id=b FOR UPDATE;
 IF NOT FOUND OR r.revision<>expected OR r.status NOT IN ('indeterminate','cancelled','authority-revoked') OR coalesce(r.lease_expires_at>clock_timestamp(),false) THEN RAISE EXCEPTION 'standardization-resolution-conflict' USING ERRCODE='23514';END IF;
 IF reservation IS NULL THEN
  IF decision<>'confirm-not-sent' OR receipt_id IS NOT NULL OR EXISTS(SELECT FROM emdo.finance_standardization_spend WHERE run_id=rid) THEN RAISE EXCEPTION 'standardization-not-sent-unproven' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO s FROM emdo.finance_standardization_spend WHERE id=reservation AND run_id=rid FOR UPDATE;
  IF NOT FOUND OR s.attempt<>r.attempt THEN RAISE EXCEPTION 'standardization-reservation-conflict' USING ERRCODE='23514';END IF;
  IF decision='confirm-not-sent' THEN
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
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT proc.oid::regprocedure signature FROM pg_proc proc JOIN pg_namespace n ON n.oid=proc.pronamespace WHERE n.nspname='emdo' AND proc.proname IN ('reserve_standardization_spend','mark_standardization_dispatch','read_standardization_reconciliation','request_standardization_receipt','claim_standardization_receipt_lookup','record_standardization_receipt_lookup','resolve_standardization_outcome') LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO emdo_finance_standardization_executor',f.signature);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,emdo_app,emdo_worker,emdo_worker_executor,emdo_worker_dispatch_executor',f.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION emdo.reserve_standardization_spend(uuid,integer,uuid,text,integer,integer,integer,text,jsonb,jsonb),emdo.mark_standardization_dispatch(uuid,integer,uuid,uuid) TO emdo_worker_executor;
GRANT EXECUTE ON FUNCTION emdo.read_standardization_reconciliation(uuid,uuid,uuid),emdo.request_standardization_receipt(uuid,uuid,uuid,integer,uuid,text),emdo.resolve_standardization_outcome(uuid,uuid,uuid,integer,uuid,text,uuid,text) TO emdo_app;

GRANT EXECUTE ON FUNCTION emdo.claim_standardization_receipt_lookup(),emdo.record_standardization_receipt_lookup(uuid,uuid,jsonb) TO emdo_worker_executor;

CREATE OR REPLACE FUNCTION emdo.settle_standardization_spend(rid uuid,rev integer,token uuid,reservation uuid,outcome text,actual integer,response_id text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs;
BEGIN
 -- Costs remain recordable after revocation, but cannot authorize any further work.
 IF NOT emdo.standardization_worker_identity() THEN RAISE EXCEPTION 'standardization-worker-denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid FOR UPDATE;
 IF outcome='completed' AND NOT EXISTS(SELECT FROM emdo.finance_standardization_spend WHERE id=reservation AND run_id=rid AND claim_token=token AND claim_revision=rev AND dispatch_phase='dispatch-started') THEN RAISE EXCEPTION 'standardization-dispatch-unproven' USING ERRCODE='23514';END IF;
 IF outcome NOT IN ('completed','not-sent','indeterminate') OR (outcome='completed' AND (actual IS NULL OR actual<0 OR length(response_id) NOT BETWEEN 1 AND 200)) THEN RAISE EXCEPTION 'standardization-spend-settlement-conflict' USING ERRCODE='23514'; END IF;
 UPDATE emdo.finance_standardization_spend SET status=outcome,actual_cad_minor=actual,provider_response_id=response_id,settled_at=clock_timestamp() WHERE id=reservation AND run_id=rid AND claim_token=token AND claim_revision=rev AND status='reserved';RETURN FOUND;
END $$;
