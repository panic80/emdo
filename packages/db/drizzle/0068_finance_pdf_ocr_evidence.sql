-- Read-only access to saved PDF OCR facts; no review, proposal or posting authority.
CREATE FUNCTION emdo.read_finance_pdf_ocr_extraction(w uuid,b uuid,e uuid,rid uuid,rev integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE result jsonb;
BEGIN
  PERFORM emdo.standardization_app_book(w,b,false);
  SELECT jsonb_build_object('sourceDigest',ex.source_digest,'extractionDigest',ex.extraction_digest,'factsJson',ex.envelope->>'factsJson') INTO result
  FROM emdo.finance_standardization_extractions ex
  JOIN emdo.finance_standardization_runs r ON r.id=ex.run_id
  JOIN emdo.finance_book_evidence original ON original.id=r.evidence_id AND original.workspace_id=r.workspace_id AND original.book_id=r.book_id
  WHERE r.workspace_id=w AND r.book_id=b AND r.evidence_id=e AND r.id=rid AND ex.revision=rev
    AND rev BETWEEN 1 AND 3 AND original.format='pdf'
    AND ex.source_digest=r.source_digest AND original.plaintext_sha256=r.source_digest
    AND ex.envelope->>'kind'='pdf-ocr'
    AND ex.envelope->>'sourceDigest'=ex.source_digest
    AND ex.envelope->>'extractionDigest'=ex.extraction_digest
    AND octet_length(ex.envelope->>'factsJson')<=262144
    AND encode(sha256(convert_to(ex.envelope->>'factsJson','UTF8')),'hex')=ex.extraction_digest;
  IF result IS NULL THEN RAISE EXCEPTION 'finance-pdf-ocr-extraction-not-found' USING ERRCODE='23514'; END IF;
  RETURN result;
END $$;
ALTER FUNCTION emdo.read_finance_pdf_ocr_extraction(uuid,uuid,uuid,uuid,integer) OWNER TO emdo_finance_standardization_executor;
REVOKE ALL ON FUNCTION emdo.read_finance_pdf_ocr_extraction(uuid,uuid,uuid,uuid,integer) FROM PUBLIC,emdo_worker,emdo_workflow,emdo_worker_executor,emdo_worker_dispatch_executor;
GRANT EXECUTE ON FUNCTION emdo.read_finance_pdf_ocr_extraction(uuid,uuid,uuid,uuid,integer) TO emdo_app;
