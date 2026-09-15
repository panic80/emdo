-- Preserve complete bounded PDF layout facts; other extraction kinds retain their limits.
ALTER TABLE emdo.finance_standardization_extractions DROP CONSTRAINT standardization_extraction_bounds;
--> statement-breakpoint
ALTER TABLE emdo.finance_standardization_extractions ADD CONSTRAINT standardization_extraction_bounds CHECK ("emdo"."finance_standardization_extractions"."revision">0 and octet_length("emdo"."finance_standardization_extractions"."envelope"::text)<=case when "emdo"."finance_standardization_extractions"."envelope"->>'kind'='pdf-layout' then 4521984 else 1048576 end and coalesce(octet_length("emdo"."finance_standardization_extractions"."envelope"->>'factsJson'),0)<=case when "emdo"."finance_standardization_extractions"."envelope"->>'kind'='pdf-layout' then 2097152 else 262144 end and "emdo"."finance_standardization_extractions"."source_digest" ~ '^[a-f0-9]{64}$' and "emdo"."finance_standardization_extractions"."extraction_digest" ~ '^[a-f0-9]{64}$');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.save_finance_automation_extraction(rid uuid,rev integer,token uuid,summary jsonb,envelope jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_automation_runs;s emdo.finance_standardization_runs;ex emdo.finance_standardization_extractions;h text;next_revision integer;body jsonb;
BEGIN
 r:=emdo.lock_finance_extraction_automation(rid,rev,token);
 IF r.status='completed' AND EXISTS(SELECT FROM emdo.finance_automation_extraction_results WHERE operation_id=rid AND result->>'extractionDigest'=envelope->>'extractionDigest') THEN RETURN rid; END IF;
 s:=emdo.validate_finance_extraction_intent(r.workspace_id,r.book_id,(SELECT granted_by_user_id FROM emdo.finance_automation_grants WHERE id=r.grant_id),r.intent->'extraction');
 next_revision:=(r.intent->'extraction'->>'expectedExtractionRevision')::integer;
 h:=encode(sha256(convert_to(envelope->>'factsJson','UTF8')),'hex');
 IF next_revision=0 THEN next_revision:=1; END IF;
 IF summary IS NULL OR envelope IS NULL OR h IS NULL OR octet_length(envelope::text)>(CASE WHEN envelope->>'kind'='pdf-layout' THEN 4521984 ELSE 1048576 END) OR octet_length(envelope->>'factsJson')>(CASE WHEN envelope->>'kind'='pdf-layout' THEN 2097152 ELSE 262144 END) OR envelope->>'kind' NOT IN ('csv-table','xlsx-regions','pdf-layout','image-ocr','pdf-ocr') OR envelope->>'documentInstructions' IS DISTINCT FROM 'untrusted-source-data' OR envelope->>'complete' IS DISTINCT FROM 'false' OR summary->>'truncated' IS DISTINCT FROM 'false' OR summary->>'sourceDigest' IS DISTINCT FROM s.source_digest OR envelope->>'sourceDigest' IS DISTINCT FROM s.source_digest OR summary->>'extractionDigest' IS DISTINCT FROM h OR envelope->>'extractionDigest' IS DISTINCT FROM h OR (summary->>'revision')::integer IS DISTINCT FROM next_revision OR (envelope->>'revision')::integer IS DISTINCT FROM next_revision THEN RAISE EXCEPTION 'extraction-envelope-invalid' USING ERRCODE='23514'; END IF;
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
