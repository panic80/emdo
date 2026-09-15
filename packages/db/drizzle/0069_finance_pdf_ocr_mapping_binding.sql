-- Exact saved PDF OCR review binding; no new approval or posting authority.
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
   IF NOT FOUND OR r.revision IS DISTINCT FROM expected OR coalesce(r.status,'') NOT IN ('needs-review','blocked')
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
 IF r.revision<>expected OR NOT (r.status='needs-review' OR (r.status='blocked' AND source_format IN ('png','jpeg','webp') AND EXISTS(SELECT FROM emdo.finance_standardization_extractions ex WHERE ex.run_id=r.id AND ex.revision=(r.extraction->>'revision')::integer AND ex.envelope->>'kind'='image-ocr'))) OR NOT EXISTS(SELECT FROM emdo.finance_report_mapping_versions WHERE id=mid AND workspace_id=w AND book_id=b AND evidence_id=r.evidence_id AND status='candidate' AND (source_format NOT IN ('png','jpeg','webp') OR (definition->'imageSelection'->>'standardizationRunId'=rid::text AND definition->'imageSelection'->>'extractionRevision'=r.extraction->>'revision' AND definition->'imageSelection'->>'expectedExtractionDigest'=r.extraction->>'extractionDigest'))) THEN RAISE EXCEPTION 'standardization-reviewed-mapping-conflict' USING ERRCODE='23514'; END IF;
 END IF;
 UPDATE emdo.finance_standardization_runs SET reviewed_mapping_id=mid,revision=revision+1,updated_at=clock_timestamp() WHERE id=rid;
 INSERT INTO emdo.finance_command_receipts(workspace_id,user_id,idempotency_key,operation,payload_hash,result) VALUES(w,emdo.current_user_id(),k,'standardization.link-mapping',h,jsonb_build_object('id',rid));RETURN true;
END $$;

CREATE OR REPLACE FUNCTION emdo.finish_finance_standardization(rid uuid,rev integer,token uuid,result jsonb,candidate jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; p jsonb; d jsonb; provenance jsonb; mapping_version integer:=1; mapping_id uuid; ex emdo.finance_standardization_extractions;
BEGIN
 r:=emdo.lock_standardization_claim(rid,rev,token);p:=result->'proposal';d:=p->'definition';provenance:=result->'provenance';
 SELECT * INTO ex FROM emdo.finance_standardization_extractions WHERE run_id=rid AND revision=r.attempt;
 IF r.status<>'proposing' OR NOT FOUND OR jsonb_typeof(p)<>'object' OR jsonb_typeof(d)<>'object' OR jsonb_typeof(p->'unresolvedQuestions')<>'array' OR jsonb_array_length(p->'unresolvedQuestions') NOT BETWEEN 1 AND 30 OR provenance->>'controller' IS DISTINCT FROM 'emdo' OR provenance->>'orchestrationMode' IS DISTINCT FROM 'registered-workflow' OR provenance->>'model' IS DISTINCT FROM 'gpt-6-astra' OR NOT EXISTS(SELECT FROM emdo.finance_standardization_spend WHERE run_id=rid AND attempt=r.attempt AND status='completed' AND provider_response_id=provenance->>'providerResponseId' AND lineage->>'managerInvocationId'=provenance->>'managerInvocationId' AND lineage->>'financeInvocationId'=provenance->>'financeInvocationId' AND lineage->>'orchestrationMode'=provenance->>'orchestrationMode' AND lineage->>'promptVersion'=provenance->>'promptVersion' AND coalesce(lineage->'promptProjection','null'::jsonb)=coalesce(provenance->'promptProjection','null'::jsonb)) THEN RAISE EXCEPTION 'standardization-proposal-provenance-conflict' USING ERRCODE='23514'; END IF;
 IF candidate IS NOT NULL THEN
 -- Only exact CSV source rows can be materialized without human table selection.
 IF ex.envelope->>'kind' IS DISTINCT FROM 'csv-table' OR candidate->'example'->'headers' IS DISTINCT FROM (ex.envelope->>'factsJson')::jsonb->'headers' OR candidate->'example'->'rows' IS DISTINCT FROM (ex.envelope->>'factsJson')::jsonb->'rows' OR candidate->'example'->'headers' IS DISTINCT FROM d->'headers' OR candidate->'example'->>'documentId' IS DISTINCT FROM r.evidence_id::text OR candidate->'example'->'context' IS DISTINCT FROM '{"asOf":null,"currency":null}'::jsonb OR coalesce(d->'pdfSelection','null'::jsonb)<>'null'::jsonb OR coalesce(d->'xlsxSelection','null'::jsonb)<>'null'::jsonb OR coalesce(d->'imageSelection','null'::jsonb)<>'null'::jsonb OR coalesce(d->'pdfOcrSelection','null'::jsonb) IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'standardization-example-source-conflict' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.workspace_id::text||':'||r.book_id::text,0));
 SELECT coalesce(max(version),0)+1 INTO mapping_version FROM emdo.finance_report_mapping_versions WHERE workspace_id=r.workspace_id AND book_id=r.book_id AND provider_key=d->>'providerKey' AND report_name=d->>'reportName' AND report_type=d->>'reportType';
 mapping_id:=rid;
 INSERT INTO emdo.finance_report_mapping_versions(id,workspace_id,book_id,provider_key,report_name,report_type,layout_version,version,revision,status,definition,rationale,unresolved_questions,example,evidence_id,validation,proposed_by_model,created_by) VALUES(mapping_id,r.workspace_id,r.book_id,d->>'providerKey',d->>'reportName',d->>'reportType',d->>'layoutVersion',mapping_version,1,'candidate',d,p->>'rationale',p->'unresolvedQuestions',candidate->'example',r.evidence_id,candidate->'validation','gpt-6-astra',r.authorized_by);
 END IF;
 UPDATE emdo.finance_standardization_runs SET status='needs-review',revision=revision+1,proposal=jsonb_build_object('mappingId',mapping_id,'mappingVersion',mapping_version,'definition',d,'rationale',p->>'rationale','status','candidate','unresolvedQuestions',p->'unresolvedQuestions'),model_provenance=provenance,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=rid;RETURN true;
END $$;



-- Preserve historical v1 runs while admitting the active explicit v2 prompt.
CREATE OR REPLACE FUNCTION emdo.reserve_standardization_spend(rid uuid,rev integer,token uuid,key text,input_ceiling integer,output_ceiling integer,estimate integer,pricing text,lineage jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; cfg emdo.finance_standardization_configuration; existing emdo.finance_standardization_spend; total bigint; result uuid;
BEGIN
 r:=emdo.lock_standardization_claim(rid,rev,token);
 IF lineage->>'orchestrationMode' IS DISTINCT FROM 'registered-workflow' OR coalesce(lineage->>'promptVersion','') NOT IN ('finance-standardization-proposal.v1','finance-standardization-proposal.v2') OR coalesce(lineage->>'managerInvocationId','') !~ '^[a-f0-9-]{36}$' OR coalesce(lineage->>'financeInvocationId','') !~ '^[a-f0-9-]{36}$' OR lineage->>'managerInvocationId'=lineage->>'financeInvocationId' OR octet_length(lineage::text)>2048 THEN RAISE EXCEPTION 'standardization-lineage-invalid' USING ERRCODE='23514'; END IF;
 IF r.status<>'proposing' THEN RAISE EXCEPTION 'standardization-not-proposing' USING ERRCODE='23514'; END IF;
 SELECT * INTO existing FROM emdo.finance_standardization_spend WHERE run_id=rid AND attempt=r.attempt;
 IF FOUND THEN RAISE EXCEPTION 'standardization-provider-attempt-already-reserved' USING ERRCODE='23514'; END IF;
 SELECT * INTO cfg FROM emdo.finance_standardization_configuration WHERE id='v1';
 PERFORM pg_advisory_xact_lock(hashtextextended('standardization-budget:'||r.workspace_id::text,0));
 SELECT coalesce(sum(CASE WHEN status='not-sent' THEN 0 ELSE greatest(reserved_cad_minor,coalesce(actual_cad_minor,0)) END),0) INTO total FROM emdo.finance_standardization_spend WHERE run_id=rid;
 IF estimate<1 OR total+estimate>cfg.max_run_cad_minor THEN RAISE EXCEPTION 'standardization-run-budget-exhausted' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(CASE WHEN s.status='not-sent' THEN 0 ELSE greatest(s.reserved_cad_minor,coalesce(s.actual_cad_minor,0)) END),0) INTO total FROM emdo.finance_standardization_spend s JOIN emdo.finance_standardization_runs other ON other.id=s.run_id WHERE other.workspace_id=r.workspace_id AND s.created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
 IF total+estimate>cfg.max_workspace_day_cad_minor THEN RAISE EXCEPTION 'standardization-workspace-budget-exhausted' USING ERRCODE='23514'; END IF;
 result:=gen_random_uuid();INSERT INTO emdo.finance_standardization_spend(id,run_id,attempt,request_key,claim_token,claim_revision,pricing_version,lineage,input_token_ceiling,output_token_ceiling,reserved_cad_minor) VALUES(result,rid,r.attempt,key,token,rev,pricing,lineage,input_ceiling,output_ceiling,estimate);RETURN result;
END $$;
