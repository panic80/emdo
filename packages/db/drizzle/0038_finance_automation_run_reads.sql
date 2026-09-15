-- Administrative run history remains readable after an automation entitlement
-- is removed. It never exposes leases, canonical intents or dispatch authority.
CREATE FUNCTION emdo.read_finance_automation_runs(w uuid,b uuid,start_offset integer,page_limit integer,rid uuid DEFAULT NULL)
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
  ) AS value FROM emdo.finance_automation_runs r
  WHERE r.workspace_id=w AND r.book_id=b AND (rid IS NULL OR r.id=rid)
  ORDER BY r.created_at DESC,r.id DESC OFFSET start_offset LIMIT page_limit+1
 ) page;
 RETURN rows_json;
END $$;
ALTER FUNCTION emdo.read_finance_automation_runs(uuid,uuid,integer,integer,uuid) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.read_finance_automation_runs(uuid,uuid,integer,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.read_finance_automation_runs(uuid,uuid,integer,integer,uuid) TO emdo_app;
