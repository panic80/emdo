CREATE TABLE "emdo"."finance_automation_extraction_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_automation_extraction_results_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "automation_extraction_result_bound" CHECK (jsonb_typeof("emdo"."finance_automation_extraction_results"."result")='object' and octet_length("emdo"."finance_automation_extraction_results"."result"::text)<=262144)
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_standardization_runs" DROP CONSTRAINT "standardization_run_bounds";--> statement-breakpoint
ALTER TABLE "emdo"."finance_standardization_runs" ADD COLUMN "execution_mode" text DEFAULT 'proposal' NOT NULL;--> statement-breakpoint
ALTER TABLE "emdo"."finance_automation_extraction_results" ADD CONSTRAINT "finance_automation_extraction_results_operation_id_finance_automation_runs_id_fk" FOREIGN KEY ("operation_id") REFERENCES "emdo"."finance_automation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_automation_extraction_results" ADD CONSTRAINT "finance_automation_extraction_results_workspace_id_book_id_finance_books_workspace_id_id_fk" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_standardization_runs" ADD CONSTRAINT "standardization_execution_mode" CHECK ("emdo"."finance_standardization_runs"."execution_mode" in ('proposal','extraction-only') and ("emdo"."finance_standardization_runs"."execution_mode"<>'extraction-only' or ("emdo"."finance_standardization_runs"."delivery_pending"=false and "emdo"."finance_standardization_runs"."proposal" is null and "emdo"."finance_standardization_runs"."model_provenance" is null)) and ("emdo"."finance_standardization_runs"."status"<>'extracted' or ("emdo"."finance_standardization_runs"."execution_mode"='extraction-only' and "emdo"."finance_standardization_runs"."extraction" is not null)));--> statement-breakpoint
ALTER TABLE "emdo"."finance_standardization_runs" ADD CONSTRAINT "standardization_run_bounds" CHECK ("emdo"."finance_standardization_runs"."revision">0 and "emdo"."finance_standardization_runs"."authority_epoch">0 and "emdo"."finance_standardization_runs"."attempt" between 0 and 3 and "emdo"."finance_standardization_runs"."delivery_revision">0 and "emdo"."finance_standardization_runs"."source_digest" ~ '^[a-f0-9]{64}$' and "emdo"."finance_standardization_runs"."status" in ('queued','extracting','proposing','needs-review','blocked','authority-revoked','cancelled','indeterminate','extracted') and jsonb_typeof("emdo"."finance_standardization_runs"."blockers")='array' and octet_length("emdo"."finance_standardization_runs"."blockers"::text)<=65536 and coalesce(octet_length("emdo"."finance_standardization_runs"."extraction"::text),0)<=131072 and coalesce(octet_length("emdo"."finance_standardization_runs"."proposal"::text),0)<=131072 and coalesce(octet_length("emdo"."finance_standardization_runs"."model_provenance"::text),0)<=8192);
-- Prepared work is inert. Only an explicitly enqueued, currently authorized
-- automation lease can publish canonical extraction facts and a result receipt.
ALTER TABLE emdo.finance_automation_extraction_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_automation_extraction_results FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON emdo.finance_automation_extraction_results TO emdo_finance_automation_executor;
CREATE POLICY extraction_result_executor ON emdo.finance_automation_extraction_results TO emdo_finance_automation_executor USING(true) WITH CHECK(true);
CREATE TRIGGER immutable_extraction_result BEFORE UPDATE OR DELETE ON emdo.finance_automation_extraction_results FOR EACH ROW EXECUTE FUNCTION emdo.reject_generated_report_mutation();
GRANT SELECT,INSERT,UPDATE ON emdo.finance_standardization_runs TO emdo_finance_automation_executor;
GRANT SELECT,INSERT ON emdo.finance_standardization_extractions TO emdo_finance_automation_executor;
GRANT SELECT ON emdo.finance_book_evidence TO emdo_finance_automation_executor;
CREATE POLICY automation_extraction_run ON emdo.finance_standardization_runs TO emdo_finance_automation_executor USING(true) WITH CHECK(true);
CREATE POLICY automation_extraction_facts ON emdo.finance_standardization_extractions TO emdo_finance_automation_executor USING(true) WITH CHECK(true);
CREATE POLICY automation_extraction_original ON emdo.finance_book_evidence FOR SELECT TO emdo_finance_automation_executor USING(true);

CREATE FUNCTION emdo.prepare_finance_automation_extraction(w uuid,b uuid,k text,e uuid,h text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE s emdo.finance_standardization_runs; receipt emdo.finance_command_receipts; request_hash text; result jsonb; epoch integer; current_ex integer;
BEGIN
 PERFORM emdo.standardization_app_book(w,b,true);
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=w FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||b::text,0));
 IF k !~ '^[a-fA-F0-9-]{36}$' OR h !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'extraction-preparation-invalid' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT FROM emdo.finance_book_evidence WHERE workspace_id=w AND book_id=b AND id=e AND plaintext_sha256=h AND format IN ('csv','xlsx','pdf','png','jpeg','webp')) THEN RAISE EXCEPTION 'extraction-original-unavailable' USING ERRCODE='42501'; END IF;
 request_hash:=encode(sha256(convert_to(jsonb_build_object('bookId',b,'evidenceId',e,'sourceDigest',h)::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM emdo.finance_command_receipts WHERE workspace_id=w AND user_id=emdo.current_user_id() AND idempotency_key=k;
 IF FOUND THEN IF receipt.operation<>'automation.extraction.prepare' OR receipt.payload_hash<>request_hash THEN RAISE EXCEPTION 'extraction-idempotency-conflict' USING ERRCODE='23514'; END IF; RETURN receipt.result; END IF;
 SELECT * INTO s FROM emdo.finance_standardization_runs WHERE workspace_id=w AND book_id=b AND evidence_id=e AND source_digest=h AND authorized_by=emdo.current_user_id() FOR UPDATE;
 IF NOT FOUND THEN
 SELECT revision INTO epoch FROM emdo.finance_automation_authority_epochs WHERE workspace_id=w;
 INSERT INTO emdo.finance_standardization_runs(id,workspace_id,book_id,evidence_id,source_digest,authorized_by,authority_epoch,authorization_expires_at,execution_mode,delivery_pending)
 VALUES(gen_random_uuid(),w,b,e,h,emdo.current_user_id(),epoch,clock_timestamp()+interval '7 days','extraction-only',false) RETURNING * INTO s;
 ELSIF s.status IN ('extracting','proposing','cancelled','authority-revoked','indeterminate') OR (s.execution_mode<>'extraction-only' AND s.extraction IS NULL) THEN RAISE EXCEPTION 'extraction-source-run-busy' USING ERRCODE='23514'; END IF;
 SELECT coalesce(max(revision),0) INTO current_ex FROM emdo.finance_standardization_extractions WHERE run_id=s.id;
 result:=jsonb_build_object('schemaVersion',1,'evidenceId',e,'expectedSourceDigest',h,'standardizationRunId',s.id,'expectedRunRevision',s.revision,'expectedExtractionRevision',current_ex);
 INSERT INTO emdo.finance_command_receipts(workspace_id,user_id,idempotency_key,operation,payload_hash,result) VALUES(w,emdo.current_user_id(),k,'automation.extraction.prepare',request_hash,result);
 RETURN result;
END $$;
ALTER FUNCTION emdo.prepare_finance_automation_extraction(uuid,uuid,text,uuid,text) OWNER TO emdo_finance_standardization_executor;
REVOKE ALL ON FUNCTION emdo.prepare_finance_automation_extraction(uuid,uuid,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.prepare_finance_automation_extraction(uuid,uuid,text,uuid,text) TO emdo_app;

CREATE FUNCTION emdo.validate_finance_extraction_intent(w uuid,b uuid,u uuid,x jsonb) RETURNS emdo.finance_standardization_runs
LANGUAGE plpgsql SET search_path=pg_catalog SET row_security=on AS $$
DECLARE s emdo.finance_standardization_runs; current_ex integer;
BEGIN
 IF NOT emdo.jsonb_object_has_exact_keys(x,ARRAY['schemaVersion','evidenceId','expectedSourceDigest','standardizationRunId','expectedRunRevision','expectedExtractionRevision']) OR x->>'schemaVersion'<>'1' OR x->>'expectedSourceDigest' !~ '^[a-f0-9]{64}$' OR (x->>'expectedExtractionRevision')::integer NOT BETWEEN 0 AND 3 THEN RAISE EXCEPTION 'extraction-intent-invalid' USING ERRCODE='23514'; END IF;
 SELECT * INTO s FROM emdo.finance_standardization_runs WHERE id=(x->>'standardizationRunId')::uuid AND workspace_id=w AND book_id=b AND authorized_by=u FOR UPDATE;
 IF NOT FOUND OR s.evidence_id IS DISTINCT FROM (x->>'evidenceId')::uuid OR s.source_digest IS DISTINCT FROM x->>'expectedSourceDigest' OR s.revision IS DISTINCT FROM (x->>'expectedRunRevision')::integer OR s.status IN ('extracting','proposing','cancelled','authority-revoked','indeterminate') THEN RAISE EXCEPTION 'extraction-source-revision-conflict' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT FROM emdo.finance_book_evidence WHERE workspace_id=w AND book_id=b AND id=s.evidence_id AND plaintext_sha256=s.source_digest AND format IN ('csv','xlsx','pdf','png','jpeg','webp')) THEN RAISE EXCEPTION 'extraction-source-unavailable' USING ERRCODE='42501'; END IF;
 SELECT coalesce(max(revision),0) INTO current_ex FROM emdo.finance_standardization_extractions WHERE run_id=s.id;
 IF current_ex IS DISTINCT FROM (x->>'expectedExtractionRevision')::integer OR (current_ex=0 AND (s.execution_mode<>'extraction-only' OR s.status<>'queued')) THEN RAISE EXCEPTION 'extraction-revision-conflict' USING ERRCODE='23514'; END IF;
 RETURN s;
END $$;
ALTER FUNCTION emdo.validate_finance_extraction_intent(uuid,uuid,uuid,jsonb) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.validate_finance_extraction_intent(uuid,uuid,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION emdo.enqueue_finance_extraction_automation(w uuid,b uuid,gid uuid,rid uuid,cap text,targets jsonb,curr text,amt text,x jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE g emdo.finance_automation_grants; r emdo.finance_automation_runs; payload jsonb; h text; reason text;
BEGIN
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=w FOR UPDATE;
 PERFORM emdo.finance_automation_admin(w,b);
 SELECT * INTO g FROM emdo.finance_automation_grants WHERE id=gid AND workspace_id=w AND book_id=b FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'extraction-grant-unavailable' USING ERRCODE='42501'; END IF;
 reason:=emdo.finance_automation_denial(g,cap);
 IF reason IS NOT NULL OR cap<>'finance.documents.extract' OR curr IS DISTINCT FROM g.limits->>'currency' OR amt IS NULL OR amt !~ '^0(\.0+)?$' OR targets IS DISTINCT FROM jsonb_build_array(x->>'evidenceId') OR (g.limits->>'maxItemsPerRun')::integer<1 THEN RAISE EXCEPTION 'extraction-grant-denied' USING ERRCODE='42501'; END IF;
 payload:=jsonb_build_object('workspaceId',w,'bookId',b,'grantId',gid,'grantRevision',g.revision,'capability',cap,'targets',targets,'currency',curr,'amount','0','extraction',x);
 h:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid;
 IF FOUND THEN IF r.workspace_id<>w OR r.book_id<>b OR r.request_hash<>h THEN RAISE EXCEPTION 'extraction-idempotency-conflict' USING ERRCODE='23514'; END IF; RETURN to_jsonb(r)||jsonb_build_object('amount',r.amount::text); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||b::text,0));
 PERFORM emdo.validate_finance_extraction_intent(w,b,g.granted_by_user_id,x);
 INSERT INTO emdo.finance_automation_runs(id,workspace_id,book_id,grant_id,grant_revision,capability,intent,request_hash,item_count,currency,amount) VALUES(rid,w,b,gid,g.revision,cap,payload,h,1,curr,0) RETURNING * INTO r;
 RETURN to_jsonb(r)||jsonb_build_object('amount',r.amount::text);
END $$;
ALTER FUNCTION emdo.enqueue_finance_extraction_automation(uuid,uuid,uuid,uuid,text,jsonb,text,text,jsonb) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.enqueue_finance_extraction_automation(uuid,uuid,uuid,uuid,text,jsonb,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.enqueue_finance_extraction_automation(uuid,uuid,uuid,uuid,text,jsonb,text,text,jsonb) TO emdo_app;

CREATE FUNCTION emdo.lock_finance_extraction_automation(rid uuid,rev integer,token uuid) RETURNS emdo.finance_automation_runs
LANGUAGE plpgsql SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_automation_runs;g emdo.finance_automation_grants;reason text;
BEGIN
 IF session_user<>'emdo_worker_executor_login' OR current_user<>'emdo_finance_automation_executor' OR token IS NULL THEN RAISE EXCEPTION 'extraction-worker-denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid;
 IF NOT FOUND THEN RAISE EXCEPTION 'extraction-run-unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=r.workspace_id FOR UPDATE;
 SELECT * INTO g FROM emdo.finance_automation_grants WHERE id=r.grant_id FOR UPDATE;
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.workspace_id::text||':'||r.book_id::text,0));
 reason:=emdo.finance_automation_denial(g,r.capability);
 IF reason IS NOT NULL OR r.grant_revision<>g.revision OR r.capability<>'finance.documents.extract' OR NOT r.reserved OR r.lease_token IS DISTINCT FROM token OR r.lease_expires_at<=clock_timestamp() OR NOT ((r.status='executing' AND r.revision=rev) OR (r.status='completed' AND r.revision=rev+1 AND r.outcome_reference=r.id)) THEN RAISE EXCEPTION 'extraction-authority-or-lease-revoked' USING ERRCODE='42501'; END IF;
 IF r.item_count<>1 OR r.amount<>0 OR r.currency IS DISTINCT FROM g.limits->>'currency' OR r.intent->'targets' IS DISTINCT FROM jsonb_build_array(r.intent->'extraction'->>'evidenceId') OR r.request_hash IS DISTINCT FROM encode(sha256(convert_to(r.intent::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'extraction-intent-conflict' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM emdo.finance_automation_runs WHERE grant_id=g.id AND reserved HAVING count(*)>(g.limits->>'maxRuns')::integer OR sum(item_count)>(g.limits->>'maxTotalItems')::integer OR sum(amount)>(g.limits->>'maxTotalAmount')::numeric) OR EXISTS(SELECT FROM emdo.workspace_entitlements e WHERE e.workspace_id=r.workspace_id AND e.capability='finance.automations.run' AND e."limit" IS NOT NULL AND (SELECT count(*) FROM emdo.finance_automation_runs WHERE workspace_id=r.workspace_id AND reserved)>e."limit") THEN RAISE EXCEPTION 'extraction-limit-exceeded' USING ERRCODE='42501'; END IF;
 RETURN r;
END $$;
ALTER FUNCTION emdo.lock_finance_extraction_automation(uuid,integer,uuid) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.lock_finance_extraction_automation(uuid,integer,uuid) FROM PUBLIC;

CREATE FUNCTION emdo.read_finance_automation_extraction_source(rid uuid,rev integer,token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_automation_runs;s emdo.finance_standardization_runs;ex emdo.finance_standardization_extractions;
BEGIN
 r:=emdo.lock_finance_extraction_automation(rid,rev,token);
 s:=emdo.validate_finance_extraction_intent(r.workspace_id,r.book_id,(SELECT granted_by_user_id FROM emdo.finance_automation_grants WHERE id=r.grant_id),r.intent->'extraction');
 SELECT * INTO ex FROM emdo.finance_standardization_extractions WHERE run_id=s.id AND revision=(r.intent->'extraction'->>'expectedExtractionRevision')::integer;
 IF FOUND AND (ex.source_digest<>s.source_digest OR ex.extraction_digest IS DISTINCT FROM encode(sha256(convert_to(ex.envelope->>'factsJson','UTF8')),'hex') OR s.extraction->>'extractionDigest' IS DISTINCT FROM ex.extraction_digest) THEN RAISE EXCEPTION 'extraction-saved-integrity-invalid' USING ERRCODE='23514'; END IF;
 RETURN (SELECT jsonb_build_object('format',format,'sourceDigest',s.source_digest,'encryptedOriginal',encrypted_original,'summary',CASE WHEN ex.id IS NULL THEN NULL ELSE s.extraction END,'envelope',ex.envelope) FROM emdo.finance_book_evidence WHERE id=s.evidence_id AND workspace_id=s.workspace_id AND book_id=s.book_id);
END $$;
ALTER FUNCTION emdo.read_finance_automation_extraction_source(uuid,integer,uuid) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.read_finance_automation_extraction_source(uuid,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.read_finance_automation_extraction_source(uuid,integer,uuid) TO emdo_worker_executor;

CREATE FUNCTION emdo.save_finance_automation_extraction(rid uuid,rev integer,token uuid,summary jsonb,envelope jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_automation_runs;s emdo.finance_standardization_runs;ex emdo.finance_standardization_extractions;h text;next_revision integer;body jsonb;
BEGIN
 r:=emdo.lock_finance_extraction_automation(rid,rev,token);
 IF r.status='completed' AND EXISTS(SELECT FROM emdo.finance_automation_extraction_results WHERE operation_id=rid AND result->>'extractionDigest'=envelope->>'extractionDigest') THEN RETURN rid; END IF;
 s:=emdo.validate_finance_extraction_intent(r.workspace_id,r.book_id,(SELECT granted_by_user_id FROM emdo.finance_automation_grants WHERE id=r.grant_id),r.intent->'extraction');
 next_revision:=(r.intent->'extraction'->>'expectedExtractionRevision')::integer;
 h:=encode(sha256(convert_to(envelope->>'factsJson','UTF8')),'hex');
 IF next_revision=0 THEN next_revision:=1; END IF;
 IF summary IS NULL OR envelope IS NULL OR h IS NULL OR octet_length(envelope::text)>1048576 OR octet_length(envelope->>'factsJson')>262144 OR envelope->>'kind' NOT IN ('csv-table','xlsx-regions','pdf-layout','image-ocr','pdf-ocr') OR envelope->>'documentInstructions' IS DISTINCT FROM 'untrusted-source-data' OR envelope->>'complete' IS DISTINCT FROM 'false' OR summary->>'truncated' IS DISTINCT FROM 'false' OR summary->>'sourceDigest' IS DISTINCT FROM s.source_digest OR envelope->>'sourceDigest' IS DISTINCT FROM s.source_digest OR summary->>'extractionDigest' IS DISTINCT FROM h OR envelope->>'extractionDigest' IS DISTINCT FROM h OR (summary->>'revision')::integer IS DISTINCT FROM next_revision OR (envelope->>'revision')::integer IS DISTINCT FROM next_revision THEN RAISE EXCEPTION 'extraction-envelope-invalid' USING ERRCODE='23514'; END IF;
 IF (r.intent->'extraction'->>'expectedExtractionRevision')::integer>0 THEN
 SELECT * INTO ex FROM emdo.finance_standardization_extractions WHERE run_id=s.id AND revision=next_revision;
 IF NOT FOUND OR ex.envelope IS DISTINCT FROM envelope OR s.extraction IS DISTINCT FROM summary OR ex.extraction_digest IS DISTINCT FROM h THEN RAISE EXCEPTION 'extraction-reuse-conflict' USING ERRCODE='23514'; END IF;
 ELSE
 INSERT INTO emdo.finance_standardization_extractions(id,run_id,revision,source_digest,extraction_digest,envelope) VALUES(gen_random_uuid(),s.id,next_revision,s.source_digest,h,envelope);
 UPDATE emdo.finance_standardization_runs SET status='extracted',revision=revision+1,attempt=next_revision,extraction=summary,updated_at=clock_timestamp() WHERE id=s.id;
 END IF;
 body:=jsonb_build_object('schemaVersion',1,'kind','finance-document-extraction','operationId',rid,'workspaceId',r.workspace_id,'bookId',r.book_id,'evidenceId',s.evidence_id,'sourceDigest',s.source_digest,'standardizationRunId',s.id,'extractionRevision',next_revision,'extractionDigest',h,'summary',summary,'approval','not-granted','posting','not-performed');
 INSERT INTO emdo.finance_automation_extraction_results(id,workspace_id,book_id,operation_id,result) VALUES(rid,r.workspace_id,r.book_id,rid,body);
 UPDATE emdo.finance_automation_runs SET status='completed',revision=revision+1,outcome_reference=rid,blocked_reason=NULL WHERE id=rid;
 RETURN rid;
END $$;
ALTER FUNCTION emdo.save_finance_automation_extraction(uuid,integer,uuid,jsonb,jsonb) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.save_finance_automation_extraction(uuid,integer,uuid,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.save_finance_automation_extraction(uuid,integer,uuid,jsonb,jsonb) TO emdo_worker_executor;

CREATE FUNCTION emdo.read_finance_automation_extraction_result(w uuid,b uuid,rid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE result jsonb;
BEGIN
 PERFORM emdo.finance_automation_admin(w,b);
 SELECT x.result INTO result FROM emdo.finance_automation_extraction_results x JOIN emdo.finance_automation_runs r ON r.id=x.operation_id AND r.workspace_id=x.workspace_id AND r.book_id=x.book_id JOIN emdo.finance_standardization_extractions e ON e.run_id=(x.result->>'standardizationRunId')::uuid AND e.revision=(x.result->>'extractionRevision')::integer AND e.extraction_digest=x.result->>'extractionDigest' AND e.source_digest=x.result->>'sourceDigest' WHERE x.id=rid AND x.workspace_id=w AND x.book_id=b AND r.status='completed' AND r.outcome_reference=x.id AND e.extraction_digest=encode(sha256(convert_to(e.envelope->>'factsJson','UTF8')),'hex');
 IF result IS NULL THEN RAISE EXCEPTION 'extraction-result-unavailable' USING ERRCODE='42501'; END IF;
 RETURN result;
END $$;
ALTER FUNCTION emdo.read_finance_automation_extraction_result(uuid,uuid,uuid) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.read_finance_automation_extraction_result(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.read_finance_automation_extraction_result(uuid,uuid,uuid) TO emdo_app;

CREATE OR REPLACE FUNCTION emdo.read_finance_automation_runs(w uuid,b uuid,start_offset integer,page_limit integer,rid uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE rows_json jsonb;
BEGIN
 IF start_offset IS NULL OR start_offset<0 OR start_offset>1000000 OR page_limit IS NULL OR page_limit<1 OR page_limit>100 THEN
  RAISE EXCEPTION 'automation-invalid-page' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=w FOR SHARE;
 PERFORM emdo.finance_automation_admin(w,b);
 SELECT coalesce(jsonb_agg(value ORDER BY created_at DESC,id DESC),'[]'::jsonb) INTO rows_json FROM (
  SELECT r.id,r.created_at,jsonb_build_object(
   'id',r.id,'workspace_id',r.workspace_id,'book_id',r.book_id,'grant_id',r.grant_id,
   'grant_revision',r.grant_revision,'capability',r.capability,'request_hash',r.request_hash,
   'item_count',r.item_count,'currency',r.currency,'amount',r.amount::text,
   'revision',r.revision,'attempts',r.attempts,'status',r.status,
   'outcome_reference',r.outcome_reference,'blocked_reason',r.blocked_reason,'created_at',r.created_at
  ) || jsonb_strip_nulls(jsonb_build_object('planning',r.intent->'planning','report',r.intent->'report','extraction',r.intent->'extraction')) AS value FROM emdo.finance_automation_runs r
  WHERE r.workspace_id=w AND r.book_id=b AND (rid IS NULL OR r.id=rid)
  ORDER BY r.created_at DESC,r.id DESC OFFSET start_offset LIMIT page_limit+1
 ) page;
 RETURN rows_json;
END $$;

CREATE OR REPLACE FUNCTION emdo.enqueue_finance_automation_run(
  w uuid,b uuid,gid uuid,rid uuid,cap text,targets jsonb,curr text,amt text,
  report jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET row_security=on AS $$
DECLARE
  g emdo.finance_automation_grants;
  r emdo.finance_automation_runs;
  payload jsonb;
  h text;
  reason text;
  target text;
  n numeric;
BEGIN
  IF cap='finance.documents.extract' THEN RAISE EXCEPTION 'extraction-explicit-intent-required' USING ERRCODE='22023'; END IF;
  IF cap IN ('finance.planning.budget-vs-actuals','finance.planning.forecast') THEN RAISE EXCEPTION 'planning-explicit-intent-required' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM emdo.finance_automation_authority_epochs
    WHERE workspace_id=w FOR UPDATE;
  PERFORM emdo.finance_automation_admin(w,b);
  SELECT * INTO g FROM emdo.finance_automation_grants
    WHERE id=gid AND workspace_id=w AND book_id=b FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'automation-grant-not-found'; END IF;
  reason:=emdo.finance_automation_denial(g,cap);
  IF reason IS NOT NULL THEN RAISE EXCEPTION '%' ,reason USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(targets)<>'array'
     OR jsonb_array_length(targets) NOT BETWEEN 1 AND 10000
     OR curr IS DISTINCT FROM g.limits->>'currency'
     OR amt IS NULL
     OR amt !~ '^(0|[1-9][0-9]{0,25})(\.[0-9]{1,12})?$'
    THEN RAISE EXCEPTION 'automation-invalid-intent'; END IF;
  IF report IS NULL OR jsonb_typeof(report)<>'object'
    THEN RAISE EXCEPTION 'automation-invalid-report-selection'; END IF;
  IF report->>'kind'='posted-ledger-trial-balance' THEN
    IF NOT emdo.jsonb_object_has_exact_keys(report,ARRAY['kind'])
      THEN RAISE EXCEPTION 'automation-invalid-report-selection'; END IF;
  ELSIF report->>'kind'='income-statement' THEN
    IF NOT emdo.jsonb_object_has_exact_keys(report,ARRAY['kind','periodId'])
      OR report->>'periodId' IS NULL THEN
      RAISE EXCEPTION 'automation-invalid-report-selection';
    END IF;
    PERFORM (report->>'periodId')::uuid;
  ELSIF report->>'kind'='balance-sheet' THEN
    IF NOT emdo.jsonb_object_has_exact_keys(report,ARRAY['kind','asOf'])
      OR report->>'asOf' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'automation-invalid-report-selection';
    END IF;
    PERFORM (report->>'asOf')::date;
  ELSE
    RAISE EXCEPTION 'automation-invalid-report-selection';
  END IF;
  FOR target IN SELECT jsonb_array_elements_text(targets) LOOP
    PERFORM target::uuid;
  END LOOP;
  IF (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(targets))
      <>jsonb_array_length(targets)
    THEN RAISE EXCEPTION 'automation-duplicate-target'; END IF;
  n:=amt::numeric;
  IF n<>round(n,CASE WHEN curr IN ('JPY','KRW') THEN 0 ELSE 2 END)
     OR n>(g.limits->>'maxAmountPerRun')::numeric
     OR jsonb_array_length(targets)>(g.limits->>'maxItemsPerRun')::integer
    THEN RAISE EXCEPTION 'automation-limit-exceeded'; END IF;
  -- Preserve the original request hash and intent bytes for legacy trial
  -- balance requests; statement selections are part of their canonical hash.
  IF report->>'kind'='posted-ledger-trial-balance' THEN
    payload:=jsonb_build_object(
      'workspaceId',w,'bookId',b,'grantId',gid,'grantRevision',g.revision,
      'capability',cap,'targets',targets,'currency',curr,
      'amount',trim_scale(n)::text
    );
  ELSE
    payload:=jsonb_build_object(
      'workspaceId',w,'bookId',b,'grantId',gid,'grantRevision',g.revision,
      'capability',cap,'targets',targets,'currency',curr,
      'amount',trim_scale(n)::text,'report',report
    );
  END IF;
  h:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
  SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid;
  IF FOUND THEN
    IF r.workspace_id<>w OR r.book_id<>b OR r.request_hash<>h
      THEN RAISE EXCEPTION 'automation-idempotency-conflict'; END IF;
    RETURN (to_jsonb(r)||jsonb_build_object('amount',r.amount::text));
  END IF;
  INSERT INTO emdo.finance_automation_runs(
    id,workspace_id,book_id,grant_id,grant_revision,capability,intent,
    request_hash,item_count,currency,amount
  ) VALUES (
    rid,w,b,gid,g.revision,cap,payload,h,jsonb_array_length(targets),curr,n
  ) RETURNING * INTO r;
  RETURN (to_jsonb(r)||jsonb_build_object('amount',r.amount::text));
END $$;

CREATE OR REPLACE FUNCTION emdo.claim_finance_standardization(rid uuid,drev integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; reason text;
BEGIN
 IF NOT emdo.standardization_worker_identity() THEN RAISE EXCEPTION 'standardization-worker-denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','denied'); END IF;
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=r.workspace_id FOR UPDATE;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid FOR UPDATE;
 IF r.execution_mode='extraction-only' THEN RETURN jsonb_build_object('status','denied'); END IF;
 IF r.delivery_revision<>drev OR r.status<>'queued' THEN RETURN jsonb_build_object('status','duplicate'); END IF;
 reason:=emdo.standardization_denial(r);
 IF reason IS NOT NULL THEN UPDATE emdo.finance_standardization_runs SET status='authority-revoked',revision=revision+1,blockers=jsonb_build_array(reason),delivery_pending=false,updated_at=clock_timestamp() WHERE id=rid;RETURN jsonb_build_object('status','denied'); END IF;
 IF r.attempt>=3 THEN RETURN jsonb_build_object('status','denied'); END IF;
 UPDATE emdo.finance_standardization_runs SET status='extracting',revision=revision+1,attempt=attempt+1,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '5 minutes',delivery_pending=false,updated_at=clock_timestamp() WHERE id=rid RETURNING * INTO r;
 RETURN jsonb_build_object('status','claimed','claim',jsonb_build_object('runId',r.id,'workspaceId',r.workspace_id,'bookId',r.book_id,'evidenceId',r.evidence_id,'sourceDigest',r.source_digest,'revision',r.revision,'leaseToken',r.lease_token,'leaseExpiresAt',r.lease_expires_at,'authorizedByUserId',r.authorized_by,'authorizationRevision',jsonb_build_object('membership',r.authority_epoch,'bookAccess',r.authority_epoch,'entitlement',r.authority_epoch)));
END $$;

CREATE OR REPLACE FUNCTION emdo.link_standardization_mapping(w uuid,b uuid,rid uuid,expected integer,mid uuid,k text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; h text; receipt emdo.finance_command_receipts; source_format text; m emdo.finance_report_mapping_versions; saved_ex emdo.finance_standardization_extractions; saved jsonb; facts jsonb; sel jsonb; review jsonb; page jsonb; image jsonb; cell record; provenance jsonb; cell_count integer:=0;
BEGIN
 PERFORM emdo.standardization_app_book(w,b,true);
 IF k !~ '^[a-fA-F0-9-]{36}$' THEN RAISE EXCEPTION 'standardization-invalid-key' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||emdo.current_user_id()::text||':'||k,0));
 h:=encode(sha256(convert_to(jsonb_build_object('runId',rid,'revision',expected,'mappingId',mid)::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM emdo.finance_command_receipts WHERE workspace_id=w AND user_id=emdo.current_user_id() AND idempotency_key=k;
 IF FOUND THEN IF receipt.operation<>'standardization.link-mapping' OR receipt.payload_hash<>h THEN RAISE EXCEPTION 'standardization-idempotency-conflict' USING ERRCODE='23514'; END IF;RETURN true;END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=rid AND workspace_id=w AND book_id=b FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'standardization-reviewed-mapping-conflict' USING ERRCODE='23514'; END IF;
 SELECT format INTO source_format FROM emdo.finance_book_evidence WHERE id=r.evidence_id AND workspace_id=w AND book_id=b;
 SELECT * INTO saved_ex FROM emdo.finance_standardization_extractions WHERE run_id=rid ORDER BY revision DESC LIMIT 1;
 IF source_format='pdf' AND saved_ex.envelope->>'kind'='pdf-ocr' THEN
   SELECT * INTO m FROM emdo.finance_report_mapping_versions WHERE id=mid AND workspace_id=w AND book_id=b AND evidence_id=r.evidence_id AND status='candidate';
   IF NOT FOUND OR r.revision IS DISTINCT FROM expected OR coalesce(r.status,'') NOT IN ('needs-review','blocked','extracted')
     OR saved_ex.revision::text IS DISTINCT FROM r.extraction->>'revision'
     OR saved_ex.extraction_digest IS DISTINCT FROM r.extraction->>'extractionDigest'
     OR saved_ex.source_digest IS DISTINCT FROM r.source_digest
     THEN RAISE EXCEPTION 'standardization-reviewed-mapping-conflict' USING ERRCODE='23514'; END IF;
   saved:=emdo.read_finance_pdf_ocr_extraction(w,b,r.evidence_id,rid,saved_ex.revision);
   facts:=(saved->>'factsJson')::jsonb;sel:=m.definition->'pdfOcrSelection';review:=m.example->'extractionReview';image:=sel->'imageSelection';
   IF jsonb_typeof(sel) IS DISTINCT FROM 'object' OR jsonb_typeof(review) IS DISTINCT FROM 'object'
     OR sel->>'standardizationRunId' IS DISTINCT FROM rid::text
     OR sel->>'extractionRevision' IS DISTINCT FROM saved_ex.revision::text
     OR sel->>'expectedSourceDigest' IS DISTINCT FROM r.source_digest
     OR sel->>'expectedExtractionDigest' IS DISTINCT FROM saved_ex.extraction_digest
     OR sel->>'acknowledgeOtherPages' IS DISTINCT FROM 'true'
     OR m.example->>'documentId' IS DISTINCT FROM r.evidence_id::text
     OR m.example->>'extractionRevision' IS DISTINCT FROM saved_ex.revision::text
     OR m.example->>'page' IS DISTINCT FROM sel->>'pageNumber'
     OR review->>'version' IS DISTINCT FROM 'reviewed-pdf-ocr.v1'
     OR review->>'standardizationRunId' IS DISTINCT FROM rid::text
     OR review->>'ocrExtractionRevision' IS DISTINCT FROM saved_ex.revision::text
     OR review->>'sourceDigest' IS DISTINCT FROM r.source_digest
     OR review->>'ocrExtractionDigest' IS DISTINCT FROM saved_ex.extraction_digest
     OR review->>'coverage' IS DISTINCT FROM 'selected-page-regions-only'
     OR review->>'textBasis' IS DISTINCT FROM 'human-reviewed-visual-transcription'
     OR review->>'rowNumbering' IS DISTINCT FROM 'logical-selection-order-not-pdf-row-numbers'
     OR coalesce(review->>'selectionDigest','') !~ '^[a-f0-9]{64}$'
     OR coalesce(m.definition->'imageSelection','null'::jsonb) IS DISTINCT FROM 'null'::jsonb
     OR coalesce(m.definition->'pdfSelection','null'::jsonb) IS DISTINCT FROM 'null'::jsonb
     OR coalesce(m.definition->'xlsxSelection','null'::jsonb) IS DISTINCT FROM 'null'::jsonb
     THEN RAISE EXCEPTION 'standardization-reviewed-mapping-conflict' USING ERRCODE='23514'; END IF;
   SELECT value INTO page FROM jsonb_array_elements(facts->'inventory'->'pages') WHERE value->>'pageNumber'=sel->>'pageNumber';
   IF page->>'kind' IS DISTINCT FROM 'ocr' OR review->'render' IS DISTINCT FROM page->'result'->'render'
     OR page->'result'->'render'->>'sourceDigest' IS DISTINCT FROM r.source_digest
     OR image->>'standardizationRunId' IS DISTINCT FROM rid::text
     OR image->>'extractionRevision' IS DISTINCT FROM saved_ex.revision::text
     OR image->>'expectedSourceDigest' IS DISTINCT FROM page->'result'->'render'->>'renderedImageDigest'
     OR image->'width' IS DISTINCT FROM page->'result'->'render'->'width'
     OR image->'height' IS DISTINCT FROM page->'result'->'render'->'height'
     OR image->>'coordinateSpace' IS DISTINCT FROM 'image-pixels-top-left'
     OR image->>'acknowledgeOcrUncertainty' IS DISTINCT FROM 'true'
     OR image->>'acknowledgeUnselectedContent' IS DISTINCT FROM 'true'
     OR image->>'confirmedHeaderAndContext' IS DISTINCT FROM 'true'
     OR jsonb_typeof(m.example->'pdfOcrCellProvenance') IS DISTINCT FROM 'array'
     OR jsonb_typeof(image->'headerCells') IS DISTINCT FROM 'array'
     OR jsonb_typeof(image->'rows') IS DISTINCT FROM 'array'
     THEN RAISE EXCEPTION 'standardization-reviewed-mapping-conflict' USING ERRCODE='23514'; END IF;
   -- Compare reviewed cell content directly, never JSON.stringify digests against jsonb::text.
   -- Server materialization separately validates overlap, word inventory hashes and raster bytes.
   FOR cell IN
     SELECT value AS item,'header' AS role,0::bigint AS row_number,ordinality AS col FROM jsonb_array_elements(image->'headerCells') WITH ORDINALITY
     UNION ALL SELECT c.value,'data',row_item.ordinality,c.ordinality FROM jsonb_array_elements(image->'rows') WITH ORDINALITY row_item CROSS JOIN LATERAL jsonb_array_elements(row_item.value->'cells') WITH ORDINALITY c
     UNION ALL SELECT image->'context'->'asOf','context-asOf',NULL::bigint,NULL::bigint WHERE jsonb_typeof(image->'context'->'asOf')='object'
     UNION ALL SELECT image->'context'->'currency','context-currency',NULL::bigint,NULL::bigint WHERE jsonb_typeof(image->'context'->'currency')='object'
   LOOP
     cell_count:=cell_count+1;
     SELECT value INTO provenance FROM jsonb_array_elements(m.example->'pdfOcrCellProvenance') WHERE value->'rasterCell'->>'role'=cell.role AND (value->'rasterCell'->>'logicalRow') IS NOT DISTINCT FROM cell.row_number::text AND (value->'rasterCell'->>'column') IS NOT DISTINCT FROM cell.col::text;
     IF provenance IS NULL OR provenance->>'originalPageNumber' IS DISTINCT FROM sel->>'pageNumber'
       OR provenance->'rasterCell'->'region' IS DISTINCT FROM cell.item->'region'
       OR provenance->'rasterCell'->'ocrWords' IS DISTINCT FROM cell.item->'words'
       OR provenance->'rasterCell'->'reviewedText' IS DISTINCT FROM cell.item->'reviewedText'
       OR provenance->'rasterCell'->'correctionReason' IS DISTINCT FROM cell.item->'correctionReason'
       OR cell.item->>'confirmedAgainstOriginal' IS DISTINCT FROM 'true'
       OR coalesce(cell.item->>'joiner','invalid') NOT IN ('',' ')
       OR provenance->'rasterCell'->>'ocrText' IS DISTINCT FROM (SELECT coalesce(string_agg(word.value->>'text',cell.item->>'joiner' ORDER BY word.ordinality),'') FROM jsonb_array_elements(cell.item->'words') WITH ORDINALITY word)
       OR EXISTS(SELECT FROM jsonb_array_elements(cell.item->'words') word WHERE NOT (page->'result'->'ocr'->'words' @> jsonb_build_array(word.value)))
       OR (cell.role='header' AND m.example->'headers'->((cell.col-1)::integer) IS DISTINCT FROM cell.item->'reviewedText')
       OR (cell.role='data' AND m.example->'rows'->((cell.row_number-1)::integer)->'cells'->((cell.col-1)::integer) IS DISTINCT FROM cell.item->'reviewedText')
       OR (cell.role='context-asOf' AND m.example->'context'->'asOf'->'value' IS DISTINCT FROM cell.item->'reviewedText')
       OR (cell.role='context-currency' AND m.example->'context'->'currency'->'value' IS DISTINCT FROM cell.item->'reviewedText')
       THEN RAISE EXCEPTION 'standardization-reviewed-mapping-conflict' USING ERRCODE='23514'; END IF;
   END LOOP;
   IF cell_count=0 OR cell_count IS DISTINCT FROM jsonb_array_length(m.example->'pdfOcrCellProvenance') THEN RAISE EXCEPTION 'standardization-reviewed-mapping-conflict' USING ERRCODE='23514'; END IF;
 ELSE
 IF r.revision<>expected OR NOT (r.status IN ('needs-review','extracted') OR (r.status='blocked' AND source_format IN ('png','jpeg','webp') AND EXISTS(SELECT FROM emdo.finance_standardization_extractions ex WHERE ex.run_id=r.id AND ex.revision=(r.extraction->>'revision')::integer AND ex.envelope->>'kind'='image-ocr'))) OR NOT EXISTS(SELECT FROM emdo.finance_report_mapping_versions WHERE id=mid AND workspace_id=w AND book_id=b AND evidence_id=r.evidence_id AND status='candidate' AND (source_format NOT IN ('png','jpeg','webp') OR (definition->'imageSelection'->>'standardizationRunId'=rid::text AND definition->'imageSelection'->>'extractionRevision'=r.extraction->>'revision' AND definition->'imageSelection'->>'expectedExtractionDigest'=r.extraction->>'extractionDigest'))) THEN RAISE EXCEPTION 'standardization-reviewed-mapping-conflict' USING ERRCODE='23514'; END IF;
 END IF;
 UPDATE emdo.finance_standardization_runs SET reviewed_mapping_id=mid,revision=revision+1,updated_at=clock_timestamp() WHERE id=rid;
 INSERT INTO emdo.finance_command_receipts(workspace_id,user_id,idempotency_key,operation,payload_hash,result) VALUES(w,emdo.current_user_id(),k,'standardization.link-mapping',h,jsonb_build_object('id',rid));RETURN true;
END $$;
