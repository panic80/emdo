-- Image originals remain encrypted. OCR is saved machine transcription, never approval.
CREATE OR REPLACE FUNCTION emdo.check_book_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.uploaded_by IS DISTINCT FROM emdo.current_user_id() OR NEW.format NOT IN ('csv','ofx','qfx','xlsx','pdf','ubl','cii','png','jpeg','webp') OR
    NEW.encrypted_original->>'algorithm' IS DISTINCT FROM 'aes-256-gcm' OR NEW.encrypted_original->>'schemaVersion' IS DISTINCT FROM '1'
    OR NEW.encrypted_original->>'aadVersion' IS DISTINCT FROM '1'
    OR coalesce(NEW.encrypted_original->>'ciphertext','') !~ '^[A-Za-z0-9_-]+$'
    OR coalesce(NEW.encrypted_original->>'nonce','') !~ '^[A-Za-z0-9_-]{16}$'
    OR coalesce(NEW.encrypted_original->>'authenticationTag','') !~ '^[A-Za-z0-9_-]{22}$'
    OR coalesce(NEW.encrypted_original->>'wrappedKey','') !~ '^[A-Za-z0-9_-]+$'
    OR coalesce(NEW.encrypted_original->>'keyVersion','') !~ '^finance-documents\.v[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'book evidence requires an authenticated encrypted original' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION emdo.read_finance_image_extraction(w uuid,b uuid,e uuid,rid uuid,rev integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE result jsonb;
BEGIN
  PERFORM emdo.standardization_app_book(w,b,false);
  SELECT jsonb_build_object('sourceDigest',ex.source_digest,'extractionDigest',ex.extraction_digest,'factsJson',ex.envelope->>'factsJson') INTO result
  FROM emdo.finance_standardization_extractions ex
  JOIN emdo.finance_standardization_runs r ON r.id=ex.run_id
  JOIN emdo.finance_book_evidence original ON original.id=r.evidence_id AND original.workspace_id=r.workspace_id AND original.book_id=r.book_id
  WHERE r.workspace_id=w AND r.book_id=b AND r.evidence_id=e AND r.id=rid AND ex.revision=rev
    AND rev BETWEEN 1 AND 3 AND original.format IN ('png','jpeg','webp')
    AND ex.source_digest=r.source_digest AND original.plaintext_sha256=r.source_digest
    AND ex.envelope->>'kind'='image-ocr'
    AND ex.envelope->>'sourceDigest'=ex.source_digest
    AND ex.envelope->>'extractionDigest'=ex.extraction_digest
    AND octet_length(ex.envelope->>'factsJson')<=262144
    AND encode(sha256(convert_to(ex.envelope->>'factsJson','UTF8')),'hex')=ex.extraction_digest;
  IF result IS NULL THEN RAISE EXCEPTION 'finance-image-extraction-not-found' USING ERRCODE='23514'; END IF;
  RETURN result;
END $$;
ALTER FUNCTION emdo.read_finance_image_extraction(uuid,uuid,uuid,uuid,integer) OWNER TO emdo_finance_standardization_executor;
REVOKE ALL ON FUNCTION emdo.read_finance_image_extraction(uuid,uuid,uuid,uuid,integer) FROM PUBLIC,emdo_worker,emdo_workflow,emdo_worker_executor,emdo_worker_dispatch_executor;
GRANT EXECUTE ON FUNCTION emdo.read_finance_image_extraction(uuid,uuid,uuid,uuid,integer) TO emdo_app;

-- Machine-proposed image acknowledgements cannot enter the CSV materialization path.
CREATE OR REPLACE FUNCTION emdo.finish_finance_standardization(rid uuid,rev integer,token uuid,result jsonb,candidate jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; p jsonb; d jsonb; provenance jsonb; mapping_version integer:=1; mapping_id uuid; ex emdo.finance_standardization_extractions;
BEGIN
 r:=emdo.lock_standardization_claim(rid,rev,token);p:=result->'proposal';d:=p->'definition';provenance:=result->'provenance';
 SELECT * INTO ex FROM emdo.finance_standardization_extractions WHERE run_id=rid AND revision=r.attempt;
 IF r.status<>'proposing' OR NOT FOUND OR jsonb_typeof(p)<>'object' OR jsonb_typeof(d)<>'object' OR jsonb_typeof(p->'unresolvedQuestions')<>'array' OR jsonb_array_length(p->'unresolvedQuestions') NOT BETWEEN 1 AND 30 OR provenance->>'controller' IS DISTINCT FROM 'emdo' OR provenance->>'orchestrationMode' IS DISTINCT FROM 'registered-workflow' OR provenance->>'model' IS DISTINCT FROM 'gpt-6-astra' OR NOT EXISTS(SELECT FROM emdo.finance_standardization_spend WHERE run_id=rid AND attempt=r.attempt AND status='completed' AND provider_response_id=provenance->>'providerResponseId' AND lineage->>'managerInvocationId'=provenance->>'managerInvocationId' AND lineage->>'financeInvocationId'=provenance->>'financeInvocationId' AND lineage->>'orchestrationMode'=provenance->>'orchestrationMode' AND lineage->>'promptVersion'=provenance->>'promptVersion' AND coalesce(lineage->'promptProjection','null'::jsonb)=coalesce(provenance->'promptProjection','null'::jsonb)) THEN RAISE EXCEPTION 'standardization-proposal-provenance-conflict' USING ERRCODE='23514'; END IF;
 IF candidate IS NOT NULL THEN
 -- Only exact CSV source rows can be materialized without human table selection.
 IF ex.envelope->>'kind'<>'csv-table' OR candidate->'example'->'headers' IS DISTINCT FROM (ex.envelope->>'factsJson')::jsonb->'headers' OR candidate->'example'->'rows' IS DISTINCT FROM (ex.envelope->>'factsJson')::jsonb->'rows' OR candidate->'example'->'headers' IS DISTINCT FROM d->'headers' OR candidate->'example'->>'documentId' IS DISTINCT FROM r.evidence_id::text OR candidate->'example'->'context' IS DISTINCT FROM '{"asOf":null,"currency":null}'::jsonb OR coalesce(d->'pdfSelection','null'::jsonb)<>'null'::jsonb OR coalesce(d->'xlsxSelection','null'::jsonb)<>'null'::jsonb OR coalesce(d->'imageSelection','null'::jsonb)<>'null'::jsonb THEN RAISE EXCEPTION 'standardization-example-source-conflict' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.workspace_id::text||':'||r.book_id::text,0));
 SELECT coalesce(max(version),0)+1 INTO mapping_version FROM emdo.finance_report_mapping_versions WHERE workspace_id=r.workspace_id AND book_id=r.book_id AND provider_key=d->>'providerKey' AND report_name=d->>'reportName' AND report_type=d->>'reportType';
 mapping_id:=rid;
 INSERT INTO emdo.finance_report_mapping_versions(id,workspace_id,book_id,provider_key,report_name,report_type,layout_version,version,revision,status,definition,rationale,unresolved_questions,example,evidence_id,validation,proposed_by_model,created_by) VALUES(mapping_id,r.workspace_id,r.book_id,d->>'providerKey',d->>'reportName',d->>'reportType',d->>'layoutVersion',mapping_version,1,'candidate',d,p->>'rationale',p->'unresolvedQuestions',candidate->'example',r.evidence_id,candidate->'validation','gpt-6-astra',r.authorized_by);
 END IF;
 UPDATE emdo.finance_standardization_runs SET status='needs-review',revision=revision+1,proposal=jsonb_build_object('mappingId',mapping_id,'mappingVersion',mapping_version,'definition',d,'rationale',p->>'rationale','status','candidate','unresolvedQuestions',p->'unresolvedQuestions'),model_provenance=provenance,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=rid;RETURN true;
END $$;


-- Reserve immutable projection provenance before the single provider dispatch.
CREATE OR REPLACE FUNCTION emdo.reserve_standardization_spend(rid uuid,rev integer,token uuid,key text,input_ceiling integer,output_ceiling integer,estimate integer,pricing_version text,lineage jsonb,pricing jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE reserved_id uuid; r emdo.finance_standardization_runs; ex emdo.finance_standardization_extractions; projection jsonb;
BEGIN
 r:=emdo.lock_standardization_claim(rid,rev,token);
 SELECT * INTO ex FROM emdo.finance_standardization_extractions WHERE run_id=rid AND revision=r.attempt;
 projection:=lineage->'promptProjection';
 IF ex.envelope->>'kind'='image-ocr' THEN
   IF projection IS NULL OR jsonb_typeof(projection) IS DISTINCT FROM 'object'
     OR NOT (projection ?& ARRAY['version','digest','extractionDigest','selectedWordCount','omittedWordCount','selectedLineCount','omittedLineCount','selectedTextCharacterCount','omittedTextCharacterCount','textCounting'])
     OR EXISTS(SELECT FROM jsonb_each(projection) f WHERE f.key IN ('selectedWordCount','omittedWordCount','selectedLineCount','omittedLineCount','selectedTextCharacterCount','omittedTextCharacterCount') AND (jsonb_typeof(f.value)<>'number' OR f.value::text !~ '^[0-9]+$' OR (f.value::text)::numeric>65536))
     OR projection->>'version' IS DISTINCT FROM 'finance-image-lines-prefix.v1'
     OR projection->>'extractionDigest' IS DISTINCT FROM ex.extraction_digest
     OR coalesce(projection->>'digest','') !~ '^[a-f0-9]{64}$'
     OR projection->>'textCounting' IS DISTINCT FROM 'sum-of-raw-word-text-utf16-units'
     OR (projection->>'selectedWordCount')::integer < 0
     OR (projection->>'omittedWordCount')::integer < 0
     OR (projection->>'selectedWordCount')::integer + (projection->>'omittedWordCount')::integer <> jsonb_array_length((ex.envelope->>'factsJson')::jsonb->'words')
     OR octet_length(projection::text)>1200
     THEN RAISE EXCEPTION 'standardization-image-projection-conflict' USING ERRCODE='23514'; END IF;
 ELSIF projection IS NOT NULL AND projection<>'null'::jsonb THEN
   RAISE EXCEPTION 'standardization-image-projection-conflict' USING ERRCODE='23514';
 END IF;
 IF pricing IS NULL OR jsonb_typeof(pricing) IS DISTINCT FROM 'object' OR octet_length(pricing::text)>256 OR NOT (pricing ?& ARRAY['inputCadMinorPerMillionTokens','outputCadMinorPerMillionTokens']) OR (pricing->>'inputCadMinorPerMillionTokens')::bigint<=0 OR (pricing->>'outputCadMinorPerMillionTokens')::bigint<=0 OR (pricing->>'inputCadMinorPerMillionTokens')::bigint>9007199254740991 OR (pricing->>'outputCadMinorPerMillionTokens')::bigint>9007199254740991 THEN RAISE EXCEPTION 'standardization-pricing-invalid' USING ERRCODE='23514';END IF;
 reserved_id:=emdo.reserve_standardization_spend(rid,rev,token,key,input_ceiling,output_ceiling,estimate,pricing_version,lineage);
 UPDATE emdo.finance_standardization_spend s SET pricing=reserve_standardization_spend.pricing,dispatch_phase='not-dispatched' WHERE s.id=reserved_id;
 RETURN reserved_id;
END $$;

-- Explicit manual source review remains available when a bounded model projection cannot be made.
CREATE OR REPLACE FUNCTION emdo.link_standardization_mapping(w uuid,b uuid,rid uuid,expected integer,mid uuid,k text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; h text; receipt emdo.finance_command_receipts; source_format text;
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
 IF r.revision<>expected OR NOT (r.status='needs-review' OR (r.status='blocked' AND source_format IN ('png','jpeg','webp') AND EXISTS(SELECT FROM emdo.finance_standardization_extractions ex WHERE ex.run_id=r.id AND ex.revision=(r.extraction->>'revision')::integer AND ex.envelope->>'kind'='image-ocr'))) OR NOT EXISTS(SELECT FROM emdo.finance_report_mapping_versions WHERE id=mid AND workspace_id=w AND book_id=b AND evidence_id=r.evidence_id AND status='candidate' AND (source_format NOT IN ('png','jpeg','webp') OR (definition->'imageSelection'->>'standardizationRunId'=rid::text AND definition->'imageSelection'->>'extractionRevision'=r.extraction->>'revision' AND definition->'imageSelection'->>'expectedExtractionDigest'=r.extraction->>'extractionDigest'))) THEN RAISE EXCEPTION 'standardization-reviewed-mapping-conflict' USING ERRCODE='23514'; END IF;
 UPDATE emdo.finance_standardization_runs SET reviewed_mapping_id=mid,revision=revision+1,updated_at=clock_timestamp() WHERE id=rid;
 INSERT INTO emdo.finance_command_receipts(workspace_id,user_id,idempotency_key,operation,payload_hash,result) VALUES(w,emdo.current_user_id(),k,'standardization.link-mapping',h,jsonb_build_object('id',rid));RETURN true;
END $$;
