-- Admit complete PDF text projection v5; preserve historical provenance.
CREATE OR REPLACE FUNCTION emdo.reserve_standardization_spend(rid uuid,rev integer,token uuid,key text,input_ceiling integer,output_ceiling integer,estimate integer,pricing text,lineage jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; cfg emdo.finance_standardization_configuration; existing emdo.finance_standardization_spend; total bigint; result uuid;
BEGIN
 r:=emdo.lock_standardization_claim(rid,rev,token);
 IF lineage->>'orchestrationMode' IS DISTINCT FROM 'registered-workflow' OR coalesce(lineage->>'promptVersion','') NOT IN ('finance-standardization-proposal.v1','finance-standardization-proposal.v2','finance-standardization-proposal.v3','finance-standardization-proposal.v4','finance-standardization-proposal.v5') OR coalesce(lineage->>'managerInvocationId','') !~ '^[a-f0-9-]{36}$' OR coalesce(lineage->>'financeInvocationId','') !~ '^[a-f0-9-]{36}$' OR lineage->>'managerInvocationId'=lineage->>'financeInvocationId' OR octet_length(lineage::text)>2048 THEN RAISE EXCEPTION 'standardization-lineage-invalid' USING ERRCODE='23514'; END IF;
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

--> statement-breakpoint
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
 ELSIF ex.envelope->>'kind'='pdf-layout' AND lineage->>'promptVersion'='finance-standardization-proposal.v5' THEN
   IF projection IS NULL OR jsonb_typeof(projection) IS DISTINCT FROM 'object'
     OR NOT (projection ?& ARRAY['kind','extractionDigest','projectionDigest','pageCount','spanCount','textCharacters','omittedPages'])
     OR (SELECT count(*) FROM jsonb_object_keys(projection))<>7
     OR projection->>'kind' IS DISTINCT FROM 'pdf-text.v1'
     OR projection->>'extractionDigest' IS DISTINCT FROM ex.extraction_digest
     OR coalesce(projection->>'projectionDigest','') !~ '^[a-f0-9]{64}$'
     OR EXISTS(SELECT FROM jsonb_each(projection) f WHERE f.key IN ('pageCount','spanCount','textCharacters','omittedPages') AND (jsonb_typeof(f.value)<>'number' OR f.value::text !~ '^[0-9]+$' OR (f.value::text)::numeric>262144))
     OR projection->>'omittedPages' IS DISTINCT FROM '0'
     OR (projection->>'pageCount')::integer NOT BETWEEN 1 AND 25
     OR (projection->>'pageCount')::integer IS DISTINCT FROM jsonb_array_length((ex.envelope->>'factsJson')::jsonb->'pages')
     OR (projection->>'pageCount')::integer IS DISTINCT FROM ((ex.envelope->>'factsJson')::jsonb->>'totalPages')::integer
     OR (projection->>'spanCount')::integer>20000
     OR (projection->>'spanCount')::integer IS DISTINCT FROM (SELECT sum(jsonb_array_length(p->'spans')) FROM jsonb_array_elements((ex.envelope->>'factsJson')::jsonb->'pages') p)
     OR (projection->>'textCharacters')::integer IS DISTINCT FROM (SELECT coalesce(sum(CASE WHEN ascii(c)>65535 THEN 2 ELSE 1 END),0) FROM jsonb_array_elements((ex.envelope->>'factsJson')::jsonb->'pages') p CROSS JOIN LATERAL regexp_split_to_table(p->>'text','') c)
     OR input_ceiling<>64000 OR output_ceiling<>4000
     OR octet_length(projection::text)>1200
     THEN RAISE EXCEPTION 'standardization-pdf-projection-conflict' USING ERRCODE='23514'; END IF;
 ELSIF projection IS NOT NULL AND projection<>'null'::jsonb THEN
   RAISE EXCEPTION 'standardization-image-projection-conflict' USING ERRCODE='23514';
 END IF;
 IF pricing IS NULL OR jsonb_typeof(pricing) IS DISTINCT FROM 'object' OR octet_length(pricing::text)>256 OR NOT (pricing ?& ARRAY['inputCadMinorPerMillionTokens','outputCadMinorPerMillionTokens']) OR (pricing->>'inputCadMinorPerMillionTokens')::bigint<=0 OR (pricing->>'outputCadMinorPerMillionTokens')::bigint<=0 OR (pricing->>'inputCadMinorPerMillionTokens')::bigint>9007199254740991 OR (pricing->>'outputCadMinorPerMillionTokens')::bigint>9007199254740991 THEN RAISE EXCEPTION 'standardization-pricing-invalid' USING ERRCODE='23514';END IF;
 reserved_id:=emdo.reserve_standardization_spend(rid,rev,token,key,input_ceiling,output_ceiling,estimate,pricing_version,lineage);
 UPDATE emdo.finance_standardization_spend s SET pricing=reserve_standardization_spend.pricing,dispatch_phase='not-dispatched' WHERE s.id=reserved_id;
 RETURN reserved_id;
END $$;

--> statement-breakpoint
ALTER TABLE emdo.finance_standardization_spend DROP CONSTRAINT standardization_spend_bounds;
--> statement-breakpoint
ALTER TABLE emdo.finance_standardization_spend ADD CONSTRAINT standardization_spend_bounds CHECK ("emdo"."finance_standardization_spend"."attempt" between 1 and 3 and "emdo"."finance_standardization_spend"."input_token_ceiling" between 1 and (case when "emdo"."finance_standardization_spend"."lineage"->>'promptVersion'='finance-standardization-proposal.v5' and "emdo"."finance_standardization_spend"."lineage"->'promptProjection'->>'kind'='pdf-text.v1' then 64000 else 20000 end) and "emdo"."finance_standardization_spend"."output_token_ceiling" between 1 and 4000 and "emdo"."finance_standardization_spend"."reserved_cad_minor">0 and ("emdo"."finance_standardization_spend"."actual_cad_minor" is null or "emdo"."finance_standardization_spend"."actual_cad_minor">=0) and "emdo"."finance_standardization_spend"."status" in ('reserved','completed','not-sent','indeterminate') and length("emdo"."finance_standardization_spend"."request_key") between 1 and 200 and length("emdo"."finance_standardization_spend"."pricing_version") between 1 and 128);
