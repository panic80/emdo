-- Admit the active v3 prompt while retaining historical v1/v2 provenance.
CREATE OR REPLACE FUNCTION emdo.reserve_standardization_spend(rid uuid,rev integer,token uuid,key text,input_ceiling integer,output_ceiling integer,estimate integer,pricing text,lineage jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_standardization_runs; cfg emdo.finance_standardization_configuration; existing emdo.finance_standardization_spend; total bigint; result uuid;
BEGIN
 r:=emdo.lock_standardization_claim(rid,rev,token);
 IF lineage->>'orchestrationMode' IS DISTINCT FROM 'registered-workflow' OR coalesce(lineage->>'promptVersion','') NOT IN ('finance-standardization-proposal.v1','finance-standardization-proposal.v2','finance-standardization-proposal.v3') OR coalesce(lineage->>'managerInvocationId','') !~ '^[a-f0-9-]{36}$' OR coalesce(lineage->>'financeInvocationId','') !~ '^[a-f0-9-]{36}$' OR lineage->>'managerInvocationId'=lineage->>'financeInvocationId' OR octet_length(lineage::text)>2048 THEN RAISE EXCEPTION 'standardization-lineage-invalid' USING ERRCODE='23514'; END IF;
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
