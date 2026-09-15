CREATE TABLE "emdo"."finance_planning_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"automation_run_id" uuid NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"capability" text NOT NULL,
	"budget_id" uuid NOT NULL,
	"budget_revision" integer NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"source_lineage" jsonb NOT NULL,
	"source_hash" text NOT NULL,
	CONSTRAINT "planning_result_run" UNIQUE("automation_run_id"),
	CONSTRAINT "planning_result_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "planning_result_version" CHECK ("emdo"."finance_planning_results"."schema_version"=1 and "emdo"."finance_planning_results"."capability" in ('finance.planning.budget-vs-actuals','finance.planning.forecast')),
	CONSTRAINT "planning_result_payload" CHECK (jsonb_typeof("emdo"."finance_planning_results"."payload")='object' and octet_length("emdo"."finance_planning_results"."payload"::text)<=8000000 and jsonb_typeof("emdo"."finance_planning_results"."source_lineage")='object' and octet_length("emdo"."finance_planning_results"."source_lineage"::text)<=8000000),
	CONSTRAINT "planning_result_hash" CHECK ("emdo"."finance_planning_results"."source_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_automation_capabilities" DROP CONSTRAINT "automation_capability_closed";--> statement-breakpoint
ALTER TABLE "emdo"."finance_planning_results" ADD CONSTRAINT "planning_result_run_scope" FOREIGN KEY ("workspace_id","book_id","automation_run_id") REFERENCES "emdo"."finance_automation_runs"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_planning_results" ADD CONSTRAINT "planning_result_budget_scope" FOREIGN KEY ("workspace_id","book_id","budget_id","budget_revision") REFERENCES "emdo"."finance_budget_revisions"("workspace_id","book_id","budget_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_automation_capabilities" ADD CONSTRAINT "automation_capability_closed" CHECK ("emdo"."finance_automation_capabilities"."capability" in ('finance.documents.extract','finance.reports.generate','finance.journals.draft','finance.planning.budget-vs-actuals','finance.planning.forecast'));
--> statement-breakpoint
-- Deployment readiness is administrative; this migration enables no automation.
INSERT INTO emdo.finance_automation_capabilities(capability,ready) VALUES
 ('finance.planning.budget-vs-actuals',false),('finance.planning.forecast',false);
ALTER TABLE emdo.finance_planning_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_planning_results FORCE ROW LEVEL SECURITY;
REVOKE ALL ON emdo.finance_planning_results FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow;
GRANT SELECT,INSERT ON emdo.finance_planning_results TO emdo_finance_automation_executor;
CREATE POLICY planning_result_executor_read ON emdo.finance_planning_results FOR SELECT TO emdo_finance_automation_executor USING(true);
CREATE POLICY planning_result_executor_insert ON emdo.finance_planning_results FOR INSERT TO emdo_finance_automation_executor WITH CHECK(true);
GRANT SELECT ON emdo.finance_planning_results TO emdo_app;
CREATE POLICY planning_result_book_read ON emdo.finance_planning_results FOR SELECT TO emdo_app USING(emdo.finance_book_access(workspace_id,book_id));
CREATE TRIGGER planning_result_immutable BEFORE UPDATE OR DELETE ON emdo.finance_planning_results FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_planning_history_mutation();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['finance_budget_revisions','finance_budget_lines','finance_forecast_snapshots','finance_forecast_lines','finance_forecast_assumptions','finance_periods'] LOOP
  EXECUTE format('GRANT SELECT ON emdo.%I TO emdo_finance_automation_executor',t);
  EXECUTE format('CREATE POLICY planning_executor_source ON emdo.%I FOR SELECT TO emdo_finance_automation_executor USING(true)',t);
 END LOOP;
END $$;

-- Internal authority helper, invoked only while epoch/grant/book locks are held.
-- Direct reviewed fields must match ONE immutable, authenticated saved forecast.
CREATE FUNCTION emdo.validate_finance_planning_intent(w uuid,b uuid,actor uuid,cap text,p jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET row_security=on AS $$
DECLARE n integer; curr text; review_id uuid; review_revision integer; a jsonb; opening jsonb;
BEGIN
 IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR
    jsonb_typeof(p->'budgetRevision') IS DISTINCT FROM 'number' OR jsonb_typeof(p->'itemCount') IS DISTINCT FROM 'number' OR
    p->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR p->>'capability' IS DISTINCT FROM cap OR
    coalesce(p->>'budgetRevision','') !~ '^[1-9][0-9]{0,9}$' OR coalesce(p->>'itemCount','') !~ '^[1-9][0-9]{0,4}$' THEN
  RAISE EXCEPTION 'planning-invalid-intent' USING ERRCODE='22023'; END IF;
 IF cap='finance.planning.budget-vs-actuals' THEN
  IF NOT emdo.jsonb_object_has_exact_keys(p,ARRAY['schemaVersion','capability','budgetId','budgetRevision','asOf','currency','itemCount']) OR p->'asOf' IS DISTINCT FROM 'null'::jsonb THEN
   RAISE EXCEPTION 'planning-invalid-intent' USING ERRCODE='22023'; END IF;
 ELSIF cap='finance.planning.forecast' THEN
  IF NOT emdo.jsonb_object_has_exact_keys(p,ARRAY['schemaVersion','capability','budgetId','budgetRevision','asOf','currency','itemCount','openingBalance','assumptions']) OR
     coalesce(p->>'asOf','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR jsonb_typeof(p->'assumptions') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'planning-invalid-intent' USING ERRCODE='22023'; END IF;
  PERFORM (p->>'asOf')::date;
  IF jsonb_array_length(p->'assumptions')>10000 THEN RAISE EXCEPTION 'planning-source-limit' USING ERRCODE='54000'; END IF;
 ELSE RAISE EXCEPTION 'planning-invalid-capability' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*)=5 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity) FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='emdo' AND c.relname IN ('finance_budget_revisions','finance_budget_lines','finance_forecast_snapshots','finance_forecast_lines','finance_forecast_assumptions')) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'planning-schema-not-ready' USING ERRCODE='42501'; END IF;
 SELECT br.functional_currency INTO curr FROM emdo.finance_budget_revisions br
 WHERE br.workspace_id=w AND br.book_id=b AND br.budget_id=(p->>'budgetId')::uuid AND br.revision=(p->>'budgetRevision')::integer;
 IF curr IS NULL OR curr IS DISTINCT FROM p->>'currency' OR NOT EXISTS(SELECT FROM emdo.finance_books WHERE workspace_id=w AND id=b AND functional_currency=curr) THEN
  RAISE EXCEPTION 'planning-budget-unavailable' USING ERRCODE='42501'; END IF;
 SELECT count(*) INTO n FROM emdo.finance_budget_lines WHERE workspace_id=w AND book_id=b AND budget_id=(p->>'budgetId')::uuid AND revision=(p->>'budgetRevision')::integer;
 IF n NOT BETWEEN 1 AND 10000 OR n<>(p->>'itemCount')::integer THEN RAISE EXCEPTION 'planning-item-count-mismatch' USING ERRCODE='22023'; END IF;
 IF cap='finance.planning.forecast' THEN
  opening:=p->'openingBalance';
  IF opening->>'status'='unavailable' THEN
   IF opening IS DISTINCT FROM '{"status":"unavailable","label":"opening-balance-unavailable"}'::jsonb THEN RAISE EXCEPTION 'planning-opening-invalid' USING ERRCODE='22023'; END IF;
  ELSIF opening->>'status'='available' THEN
   IF NOT emdo.jsonb_object_has_exact_keys(opening,ARRAY['status','amount','currency','sourceReference','reviewedBy','reviewedAt']) OR
      opening->>'currency' IS DISTINCT FROM curr OR opening->>'reviewedBy' IS DISTINCT FROM actor::text OR
      coalesce(opening->>'amount','') !~ '^-?(0|[1-9][0-9]{0,25})(\.[0-9]{1,12})?$' OR
      coalesce(opening->>'sourceReference','')='' OR coalesce(opening->>'reviewedAt','')='' THEN
    RAISE EXCEPTION 'planning-opening-invalid' USING ERRCODE='22023'; END IF;
   IF (opening->>'amount')::numeric<>round((opening->>'amount')::numeric,CASE WHEN curr IN ('JPY','KRW') THEN 0 ELSE 2 END) THEN RAISE EXCEPTION 'planning-currency-precision' USING ERRCODE='22023'; END IF;
  ELSE RAISE EXCEPTION 'planning-opening-invalid' USING ERRCODE='22023'; END IF;
  FOR a IN SELECT value FROM jsonb_array_elements(p->'assumptions') LOOP
   IF NOT emdo.jsonb_object_has_exact_keys(a,ARRAY['periodId','accountId','currency','amount','label','sourceReference','reviewedBy','reviewedAt']) OR
      a->>'currency' IS DISTINCT FROM curr OR a->>'reviewedBy' IS DISTINCT FROM actor::text OR
      coalesce(a->>'amount','') !~ '^-?(0|[1-9][0-9]{0,25})(\.[0-9]{1,12})?$' OR
      coalesce(a->>'label','')='' OR coalesce(a->>'sourceReference','')='' OR coalesce(a->>'reviewedAt','')='' THEN
    RAISE EXCEPTION 'planning-assumption-invalid' USING ERRCODE='22023'; END IF;
   IF (a->>'amount')::numeric<>round((a->>'amount')::numeric,CASE WHEN curr IN ('JPY','KRW') THEN 0 ELSE 2 END) OR NOT EXISTS(
    SELECT FROM emdo.finance_budget_lines bl JOIN emdo.finance_periods fp ON fp.workspace_id=bl.workspace_id AND fp.book_id=bl.book_id AND fp.id=bl.period_id
    WHERE bl.workspace_id=w AND bl.book_id=b AND bl.budget_id=(p->>'budgetId')::uuid AND bl.revision=(p->>'budgetRevision')::integer
     AND bl.period_id=(a->>'periodId')::uuid AND bl.account_id=(a->>'accountId')::uuid AND fp.ends_on>(p->>'asOf')::date) THEN
    RAISE EXCEPTION 'planning-assumption-out-of-scope' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT (value->>'periodId',value->>'accountId',value->>'currency')) FROM jsonb_array_elements(p->'assumptions'))<>jsonb_array_length(p->'assumptions') THEN
   RAISE EXCEPTION 'planning-assumption-duplicate' USING ERRCODE='22023'; END IF;
  SELECT f.forecast_id,f.revision INTO review_id,review_revision FROM emdo.finance_forecast_snapshots f
   WHERE f.workspace_id=w AND f.book_id=b AND f.budget_id=(p->>'budgetId')::uuid AND f.budget_revision=(p->>'budgetRevision')::integer
    AND f.created_by=actor AND f.as_of=(p->>'asOf')::date AND f.opening_status=opening->>'status'
    AND (f.opening_status='unavailable' OR (f.opening_amount=(opening->>'amount')::numeric AND f.opening_currency=curr AND
      f.opening_source_reference=opening->>'sourceReference' AND f.opening_reviewed_by=actor AND f.opening_reviewed_at=(opening->>'reviewedAt')::timestamptz))
    AND (SELECT count(*) FROM emdo.finance_forecast_assumptions fa WHERE fa.workspace_id=w AND fa.book_id=b AND fa.forecast_id=f.forecast_id AND fa.revision=f.revision)=jsonb_array_length(p->'assumptions')
    AND NOT EXISTS(SELECT FROM jsonb_array_elements(p->'assumptions') x WHERE NOT EXISTS(
      SELECT FROM emdo.finance_forecast_assumptions fa WHERE fa.workspace_id=w AND fa.book_id=b AND fa.forecast_id=f.forecast_id AND fa.revision=f.revision
       AND fa.period_id=(x->>'periodId')::uuid AND fa.account_id=(x->>'accountId')::uuid AND fa.currency=x->>'currency' AND fa.amount=(x->>'amount')::numeric
       AND fa.label=x->>'label' AND fa.source_reference=x->>'sourceReference' AND fa.reviewed_by=actor AND fa.reviewed_at=(x->>'reviewedAt')::timestamptz))
   ORDER BY f.created_at,f.forecast_id,f.revision LIMIT 1;
  IF review_id IS NULL THEN RAISE EXCEPTION 'planning-reviewed-input-unavailable' USING ERRCODE='42501'; END IF;
 END IF;
 IF cap='finance.planning.forecast' THEN
   IF NOT emdo.finance_forecast_snapshot_is_complete(w,b,review_id,review_revision) THEN
     RAISE EXCEPTION 'planning-reviewed-input-unavailable' USING ERRCODE='42501';
   END IF;
 END IF;
 RETURN jsonb_build_object('itemCount',n,'currency',curr,'reviewForecastId',review_id,'reviewForecastRevision',review_revision);
END $$;
ALTER FUNCTION emdo.validate_finance_planning_intent(uuid,uuid,uuid,text,jsonb) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.validate_finance_planning_intent(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow;

CREATE FUNCTION emdo.enqueue_finance_automation_run(w uuid,b uuid,gid uuid,rid uuid,cap text,targets jsonb,curr text,amt text,report jsonb,planning jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE g emdo.finance_automation_grants; r emdo.finance_automation_runs; facts jsonb; payload jsonb; h text; reason text;
BEGIN
 IF planning IS NULL THEN RETURN emdo.enqueue_finance_automation_run(w,b,gid,rid,cap,targets,curr,amt,report); END IF;
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=w FOR UPDATE;
 PERFORM emdo.finance_automation_admin(w,b);
 SELECT * INTO g FROM emdo.finance_automation_grants WHERE id=gid AND workspace_id=w AND book_id=b FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'planning-grant-unavailable' USING ERRCODE='42501'; END IF;
 reason:=emdo.finance_automation_denial(g,cap);
 IF reason IS NOT NULL THEN RAISE EXCEPTION '%',reason USING ERRCODE='42501'; END IF;
 IF report IS NOT NULL OR targets IS DISTINCT FROM jsonb_build_array(planning->>'budgetId') OR coalesce(amt,'') !~ '^0(\.0+)?$' OR curr IS DISTINCT FROM g.limits->>'currency' OR curr IS DISTINCT FROM planning->>'currency' THEN
  RAISE EXCEPTION 'planning-invalid-intent' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||b::text,0));
 facts:=emdo.validate_finance_planning_intent(w,b,g.granted_by_user_id,cap,planning);
 IF (facts->>'itemCount')::integer>(g.limits->>'maxItemsPerRun')::integer THEN RAISE EXCEPTION 'planning-limit-exceeded' USING ERRCODE='42501'; END IF;
 payload:=jsonb_build_object('workspaceId',w,'bookId',b,'grantId',gid,'grantRevision',g.revision,'capability',cap,'targets',targets,'currency',curr,'amount','0','planning',planning,'planningReview',facts);
 h:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid;
 IF FOUND THEN
  IF r.workspace_id<>w OR r.book_id<>b OR r.request_hash<>h THEN RAISE EXCEPTION 'automation-idempotency-conflict' USING ERRCODE='23505'; END IF;
  RETURN to_jsonb(r)||jsonb_build_object('amount',r.amount::text);
 END IF;
 INSERT INTO emdo.finance_automation_runs(id,workspace_id,book_id,grant_id,grant_revision,capability,intent,request_hash,item_count,currency,amount)
 VALUES(rid,w,b,gid,g.revision,cap,payload,h,(facts->>'itemCount')::integer,curr,0) RETURNING * INTO r;
 RETURN to_jsonb(r)||jsonb_build_object('amount',r.amount::text);
END $$;
ALTER FUNCTION emdo.enqueue_finance_automation_run(uuid,uuid,uuid,uuid,text,jsonb,text,text,jsonb,jsonb) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.enqueue_finance_automation_run(uuid,uuid,uuid,uuid,text,jsonb,text,text,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.enqueue_finance_automation_run(uuid,uuid,uuid,uuid,text,jsonb,text,text,jsonb,jsonb) TO emdo_app;

CREATE FUNCTION emdo.generate_finance_planning_result(rid uuid,expected_revision integer,token uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_automation_runs; g emdo.finance_automation_grants; result_id uuid; p jsonb; facts jsonb;
 reason text; rows_json jsonb; sources jsonb; lineage jsonb; body jsonb; assumptions jsonb; labels jsonb;
 snapshot_time timestamptz; snapshot_iso text; future_count integer; supplied_count integer;
BEGIN
 IF token IS NULL OR expected_revision IS NULL OR expected_revision<1 THEN RAISE EXCEPTION 'planning-invalid-lease' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid;
 IF NOT FOUND THEN RAISE EXCEPTION 'planning-run-unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=r.workspace_id FOR UPDATE;
 SELECT * INTO g FROM emdo.finance_automation_grants WHERE id=r.grant_id FOR UPDATE;
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid FOR UPDATE;
 reason:=emdo.finance_automation_denial(g,r.capability);
 IF reason IS NOT NULL OR r.grant_revision<>g.revision THEN RAISE EXCEPTION 'planning-authority-revoked' USING ERRCODE='42501'; END IF;
 SELECT id INTO result_id FROM emdo.finance_planning_results WHERE automation_run_id=rid AND workspace_id=r.workspace_id AND book_id=r.book_id;
 IF FOUND AND r.status='completed' AND r.outcome_reference=result_id AND r.lease_token=token AND r.revision=expected_revision+1 THEN RETURN result_id; END IF;
 IF r.status<>'executing' OR r.revision<>expected_revision OR r.lease_token IS DISTINCT FROM token OR r.lease_expires_at<=clock_timestamp() OR NOT r.reserved THEN
  RAISE EXCEPTION 'planning-lease-conflict' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.workspace_id::text||':'||r.book_id::text,0));
 p:=r.intent->'planning';
 facts:=emdo.validate_finance_planning_intent(r.workspace_id,r.book_id,g.granted_by_user_id,r.capability,p);
 IF facts IS DISTINCT FROM r.intent->'planningReview' OR r.amount<>0 OR r.currency IS DISTINCT FROM facts->>'currency' OR r.currency IS DISTINCT FROM g.limits->>'currency' OR
    r.item_count<>(facts->>'itemCount')::integer OR r.item_count>(g.limits->>'maxItemsPerRun')::integer OR
    r.intent->'targets' IS DISTINCT FROM jsonb_build_array(p->>'budgetId') OR r.intent->>'workspaceId' IS DISTINCT FROM r.workspace_id::text OR
    r.intent->>'bookId' IS DISTINCT FROM r.book_id::text OR r.intent->>'capability' IS DISTINCT FROM r.capability OR
    r.request_hash IS DISTINCT FROM encode(sha256(convert_to(r.intent::text,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'planning-intent-conflict' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT FROM emdo.finance_automation_runs WHERE grant_id=g.id AND reserved HAVING count(*)>(g.limits->>'maxRuns')::integer OR sum(item_count)>(g.limits->>'maxTotalItems')::integer OR sum(amount)>(g.limits->>'maxTotalAmount')::numeric) OR
    EXISTS(SELECT FROM emdo.workspace_entitlements e WHERE e.workspace_id=r.workspace_id AND e.capability='finance.automations.run' AND e."limit" IS NOT NULL AND (SELECT count(*) FROM emdo.finance_automation_runs WHERE workspace_id=r.workspace_id AND reserved)>e."limit") THEN
  RAISE EXCEPTION 'planning-limit-exceeded' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM (SELECT 1 FROM emdo.finance_journals j WHERE j.workspace_id=r.workspace_id AND j.book_id=r.book_id AND j.status='posted' LIMIT 10001) bounded)>10000 OR
    (SELECT count(*) FROM (SELECT 1 FROM emdo.finance_journal_lines l WHERE l.workspace_id=r.workspace_id AND l.book_id=r.book_id LIMIT 100001) bounded)>100000 THEN
  RAISE EXCEPTION 'planning-source-limit' USING ERRCODE='54000'; END IF;
 result_id:=gen_random_uuid();
 snapshot_time:=clock_timestamp();
 snapshot_iso:=to_char(snapshot_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 -- One statement produces aggregate rows AND their source lineage. The book
 -- lock excludes accounting posts and planning mutations until completion.
 WITH posted AS MATERIALIZED (
  SELECT j.id,j.period_id,j.effective_on,j.source_reference,j.payload_hash FROM emdo.finance_journals j
  WHERE j.workspace_id=r.workspace_id AND j.book_id=r.book_id AND j.status='posted'
    AND (p->>'asOf' IS NULL OR j.effective_on<=(p->>'asOf')::date)
    AND EXISTS(SELECT FROM emdo.finance_budget_lines bl WHERE bl.workspace_id=r.workspace_id AND bl.book_id=r.book_id AND bl.budget_id=(p->>'budgetId')::uuid AND bl.revision=(p->>'budgetRevision')::integer AND bl.period_id=j.period_id)
 ), movements AS MATERIALIZED (
  SELECT j.period_id,l.account_id,
    sum(CASE WHEN l.side='debit' THEN l.amount ELSE -l.amount END) AS movement,
    count(DISTINCT j.id) AS journal_count,count(l.id) AS line_count
  FROM posted j JOIN emdo.finance_journal_lines l ON l.workspace_id=r.workspace_id AND l.book_id=r.book_id AND l.journal_id=j.id
  GROUP BY j.period_id,l.account_id
 ), aggregates AS (
  SELECT bl.period_id,fp.starts_on,fp.ends_on,bl.account_id,la.kind,bl.currency,bl.amount,
    coalesce(m.movement,0)*CASE WHEN la.kind IN ('liability','equity') THEN -1 ELSE 1 END AS actual,
    coalesce(m.journal_count,0) AS journal_count,coalesce(m.line_count,0) AS line_count
  FROM emdo.finance_budget_lines bl
  JOIN emdo.finance_periods fp ON fp.workspace_id=bl.workspace_id AND fp.book_id=bl.book_id AND fp.id=bl.period_id
  JOIN emdo.finance_ledger_accounts la ON la.workspace_id=bl.workspace_id AND la.book_id=bl.book_id AND la.id=bl.account_id
  LEFT JOIN movements m ON m.period_id=bl.period_id AND m.account_id=bl.account_id
  WHERE bl.workspace_id=r.workspace_id AND bl.book_id=r.book_id AND bl.budget_id=(p->>'budgetId')::uuid AND bl.revision=(p->>'budgetRevision')::integer
 ), materialized AS (
  SELECT a.*, x.value AS assumption FROM aggregates a LEFT JOIN LATERAL (
   SELECT value FROM jsonb_array_elements(coalesce(p->'assumptions','[]'::jsonb)) WHERE value->>'periodId'=a.period_id::text AND value->>'accountId'=a.account_id::text
  ) x ON true
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('periodId',period_id,'periodStart',starts_on,'periodEnd',ends_on,'accountId',account_id,'accountKind',kind,'currency',currency,
   'budgetAmount',trim_scale(amount)::text,'postedActualAmount',trim_scale(actual)::text,'actualSignBasis',CASE WHEN kind IN ('liability','equity') THEN 'credit-minus-debit' ELSE 'debit-minus-credit' END)||
   CASE WHEN r.capability='finance.planning.budget-vs-actuals' THEN jsonb_build_object('varianceAmount',trim_scale(actual-amount)::text,'sourceJournalCount',journal_count,'sourceLineCount',line_count)
   ELSE jsonb_build_object('forecastAmount',CASE WHEN ends_on<=(p->>'asOf')::date THEN trim_scale(actual)::text ELSE assumption->>'amount' END,
     'basis',CASE WHEN ends_on<=(p->>'asOf')::date THEN 'posted-actual' WHEN assumption IS NOT NULL THEN 'reviewed-assumption' ELSE 'unavailable' END,
     'label',CASE WHEN ends_on>(p->>'asOf')::date AND assumption IS NULL THEN 'future-assumption-unavailable' ELSE NULL END) END ORDER BY period_id,account_id),'[]'::jsonb),
   count(*) FILTER(WHERE ends_on>(p->>'asOf')::date), count(*) FILTER(WHERE ends_on>(p->>'asOf')::date AND assumption IS NOT NULL),
   coalesce((SELECT jsonb_agg(jsonb_build_object('journalId',id,'effectiveOn',effective_on,'sourceReference',source_reference,'payloadHash',payload_hash) ORDER BY effective_on,id) FROM posted),'[]'::jsonb)
 INTO rows_json,future_count,supplied_count,sources FROM materialized;
 -- Match the decimal-string contract before committing any saved outcome.
 IF EXISTS(SELECT FROM jsonb_array_elements(rows_json) row_value CROSS JOIN LATERAL jsonb_each_text(row_value) field
   WHERE field.key IN ('budgetAmount','postedActualAmount','varianceAmount','forecastAmount') AND field.value IS NOT NULL
    AND (length(field.value)>40 OR field.value !~ '^-?(0|[1-9][0-9]{0,25})(\.[0-9]{1,12})?$')) THEN
  RAISE EXCEPTION 'planning-result-decimal-overflow' USING ERRCODE='22003'; END IF;
 body:=jsonb_build_object('schemaVersion',1,'workspaceId',r.workspace_id,'bookId',r.book_id,'budgetId',p->>'budgetId','budgetRevision',(p->>'budgetRevision')::integer,'functionalCurrency',r.currency,'snapshotAt',snapshot_iso,
  'actualSource',jsonb_build_object('kind','authoritative-posted-ledger','coverage',CASE WHEN r.capability='finance.planning.forecast' THEN 'posted-journals-through-as-of' ELSE 'posted-journals-in-budget-periods' END,'signBasis','account-kind'));
 IF r.capability='finance.planning.budget-vs-actuals' THEN body:=body||jsonb_build_object('rows',rows_json);
 ELSE
  labels:='[]'::jsonb;
  IF supplied_count<future_count THEN labels:=labels||'"future-assumption-unavailable"'::jsonb; END IF;
  IF p->'openingBalance'->>'status'='unavailable' THEN labels:=labels||'"opening-balance-unavailable"'::jsonb; END IF;
  SELECT coalesce(jsonb_agg(value||jsonb_build_object('forecastId',result_id,'revision',1) ORDER BY ord),'[]'::jsonb) INTO assumptions FROM jsonb_array_elements(p->'assumptions') WITH ORDINALITY x(value,ord);
  body:=body||jsonb_build_object('forecastId',result_id,'revision',1,'asOf',p->>'asOf','openingBalance',p->'openingBalance','futureAssumptionsStatus',CASE WHEN future_count=0 THEN 'not-applicable' WHEN supplied_count=0 THEN 'unavailable' WHEN supplied_count=future_count THEN 'provided' ELSE 'partial' END,
    'labels',labels,'assumptionsSource','reviewed-inputs-only','createdBy',g.granted_by_user_id,'createdAt',snapshot_iso,'lines',rows_json,'assumptions',assumptions);
 END IF;
 lineage:=jsonb_build_object('budgetId',p->>'budgetId','budgetRevision',(p->>'budgetRevision')::integer,'review',facts,'sourceJournals',sources,'canonicalIntentHash',r.request_hash);
 IF octet_length(body::text)>8000000 OR octet_length(lineage::text)>8000000 THEN RAISE EXCEPTION 'planning-source-limit' USING ERRCODE='54000'; END IF;
 IF r.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'planning-lease-expired' USING ERRCODE='42501'; END IF;
 INSERT INTO emdo.finance_planning_results(id,workspace_id,book_id,automation_run_id,capability,budget_id,budget_revision,snapshot_at,payload,source_lineage,source_hash)
 VALUES(result_id,r.workspace_id,r.book_id,rid,r.capability,(p->>'budgetId')::uuid,(p->>'budgetRevision')::integer,snapshot_time,body,lineage,encode(sha256(convert_to(jsonb_build_object('payload',body,'lineage',lineage)::text,'UTF8')),'hex'));
 UPDATE emdo.finance_automation_runs SET status='completed',outcome_reference=result_id,revision=revision+1 WHERE id=rid;
 RETURN result_id;
END $$;
ALTER FUNCTION emdo.generate_finance_planning_result(uuid,integer,uuid) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.generate_finance_planning_result(uuid,integer,uuid) FROM PUBLIC,emdo_app,emdo_workflow;
GRANT EXECUTE ON FUNCTION emdo.generate_finance_planning_result(uuid,integer,uuid) TO emdo_worker,emdo_worker_executor;

CREATE OR REPLACE FUNCTION emdo.create_finance_automation_grant(w uuid,b uuid,gid uuid,caps jsonb,lim jsonb,starts timestamptz,ends timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE epoch integer; g emdo.finance_automation_grants; cap text; amount_key text; n numeric;
BEGIN
 -- Serialize against the authority epoch before validating current permissions.
 INSERT INTO emdo.finance_automation_authority_epochs(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 SELECT revision INTO epoch FROM emdo.finance_automation_authority_epochs WHERE workspace_id=w FOR UPDATE;
 PERFORM emdo.finance_automation_admin(w,b);
 IF jsonb_typeof(caps)<>'array' OR jsonb_array_length(caps) NOT BETWEEN 1 AND 5 OR
 jsonb_typeof(lim)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(lim))<>7 OR
 NOT(lim ?& ARRAY['maxRuns','maxAttemptsPerRun','maxItemsPerRun','maxTotalItems','currency','maxAmountPerRun','maxTotalAmount']) OR
 starts IS NULL OR ends IS NULL OR ends<=starts OR ends<=clock_timestamp() OR NOT isfinite(starts) OR NOT isfinite(ends) THEN
 RAISE EXCEPTION 'automation-invalid-grant' USING ERRCODE='22023'; END IF;
 IF (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(caps))<>jsonb_array_length(caps) THEN RAISE EXCEPTION 'automation-duplicate-capability'; END IF;
 IF NOT EXISTS(SELECT FROM emdo.workspace_entitlements WHERE workspace_id=w AND capability='finance.automations.run' AND enabled) THEN RAISE EXCEPTION 'automation-entitlement-required' USING ERRCODE='42501'; END IF;
 FOR cap IN SELECT jsonb_array_elements_text(caps) LOOP
 IF NOT EXISTS(SELECT FROM emdo.finance_automation_capabilities WHERE capability=cap AND ready) THEN RAISE EXCEPTION 'automation-capability-not-ready' USING ERRCODE='42501'; END IF;
 END LOOP;
 FOREACH amount_key IN ARRAY ARRAY['maxRuns','maxAttemptsPerRun','maxItemsPerRun','maxTotalItems'] LOOP
 IF jsonb_typeof(lim->amount_key)<>'number' OR (lim->>amount_key)!~'^[1-9][0-9]*$' OR (lim->>amount_key)::numeric>2147483647 THEN RAISE EXCEPTION 'automation-invalid-limit'; END IF;
 END LOOP;
 IF (lim->>'maxAttemptsPerRun')::integer>10 OR (lim->>'maxItemsPerRun')::integer>10000 OR
 (lim->>'currency') NOT IN ('CAD','USD','MXN','EUR','KRW','JPY') THEN RAISE EXCEPTION 'automation-invalid-limit'; END IF;
 FOREACH amount_key IN ARRAY ARRAY['maxAmountPerRun','maxTotalAmount'] LOOP
 IF jsonb_typeof(lim->amount_key)<>'string' OR (lim->>amount_key)!~'^(0|[1-9][0-9]{0,25})(\.[0-9]{1,12})?$' THEN RAISE EXCEPTION 'automation-invalid-amount'; END IF;
 n:=(lim->>amount_key)::numeric;
 IF n<>round(n,CASE WHEN lim->>'currency' IN ('JPY','KRW') THEN 0 ELSE 2 END) THEN RAISE EXCEPTION 'automation-currency-precision'; END IF;
 END LOOP;
 SELECT * INTO g FROM emdo.finance_automation_grants WHERE id=gid AND workspace_id=w AND book_id=b;
 IF FOUND THEN
 IF g.granted_by_user_id IS DISTINCT FROM emdo.current_user_id() OR g.capabilities IS DISTINCT FROM caps OR g.limits IS DISTINCT FROM lim OR g.valid_from IS DISTINCT FROM starts OR g.expires_at IS DISTINCT FROM ends THEN
 RAISE EXCEPTION 'automation-idempotency-conflict' USING ERRCODE='23505'; END IF;
 RETURN to_jsonb(g);
 END IF;
 INSERT INTO emdo.finance_automation_grants(id,workspace_id,book_id,granted_by_user_id,authority_epoch,capabilities,limits,valid_from,expires_at)
 VALUES(gid,w,b,emdo.current_user_id(),epoch,caps,lim,starts,ends) RETURNING * INTO g;
 RETURN to_jsonb(g);
END $$;


-- A saved forecast becomes review evidence for automation. Bind its author and
-- opening reviewer to the authenticated save, including direct app SQL writes.
CREATE FUNCTION emdo.guard_finance_forecast_review_author() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 IF NEW.created_by IS DISTINCT FROM emdo.current_user_id() OR
   (NEW.opening_status='available' AND NEW.opening_reviewed_by IS DISTINCT FROM emdo.current_user_id()) THEN
  RAISE EXCEPTION 'finance-planning-reviewer-mismatch' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION emdo.guard_finance_forecast_review_author() FROM PUBLIC;
CREATE TRIGGER finance_forecast_review_author BEFORE INSERT ON emdo.finance_forecast_snapshots FOR EACH ROW EXECUTE FUNCTION emdo.guard_finance_forecast_review_author();

-- Preserve the EMDO scheduler lane and bind reviewed planning at materialization.
CREATE OR REPLACE FUNCTION emdo.create_finance_schedule(w uuid,b uuid,sid uuid,d jsonb,tzversion text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE g emdo.finance_automation_grants; s emdo.finance_schedules; reason text; c jsonb:=d->'cadence'; target text; n numeric; probe jsonb; rule text; planning_facts jsonb; authoritative_items integer;
BEGIN
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=w FOR UPDATE;
 PERFORM emdo.finance_automation_admin(w,b);
 SELECT * INTO g FROM emdo.finance_automation_grants WHERE id=(d->>'grantId')::uuid AND workspace_id=w AND book_id=b FOR UPDATE;
 IF NOT FOUND OR g.granted_by_user_id<>emdo.current_user_id() THEN RAISE EXCEPTION 'schedule-owner-grant-required' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM emdo.finance_schedules WHERE id=sid;
 IF FOUND THEN IF s.workspace_id<>w OR s.book_id<>b OR s.created_by_user_id<>emdo.current_user_id() OR s.definition<>d THEN RAISE EXCEPTION 'schedule-idempotency-conflict'; END IF; RETURN to_jsonb(s)-'lease_token'-'lease_expires_at'-'planned_at'; END IF;
 reason:=emdo.finance_automation_denial(g,d->>'capability');
 IF reason IS NOT NULL OR (d->>'grantRevision')::integer<>g.revision THEN RAISE EXCEPTION 'schedule-grant-denied:%',coalesce(reason,'grant-revised') USING ERRCODE='42501'; END IF;
 IF NOT emdo.jsonb_object_has_exact_keys(d,ARRAY['workspaceId','bookId','grantId','grantRevision','capability','targets','money','startAt','endAt','cadence','misfire','concurrency'] || CASE WHEN d ? 'planning' THEN ARRAY['planning'] ELSE ARRAY[]::text[] END) OR (d->>'workspaceId')::uuid<>w OR (d->>'bookId')::uuid<>b OR octet_length(d::text)>1048576 OR jsonb_typeof(d->'targets')<>'array' OR jsonb_array_length(d->'targets') NOT BETWEEN 1 AND 10000 OR NOT(g.capabilities ? (d->>'capability')) THEN RAISE EXCEPTION 'schedule-definition-invalid'; END IF;
 IF (d->>'startAt')::timestamptz<g.valid_from OR (d->>'startAt')::timestamptz>=g.expires_at OR (d->>'endAt' IS NOT NULL AND ((d->>'endAt')::timestamptz<=(d->>'startAt')::timestamptz OR (d->>'endAt')::timestamptz>g.expires_at)) THEN RAISE EXCEPTION 'schedule-grant-window-invalid'; END IF;
 IF NOT emdo.jsonb_object_has_exact_keys(d->'money',ARRAY['currency','amount']) OR d->'money'->>'currency' IS DISTINCT FROM g.limits->>'currency' OR (d->'money'->>'amount')!~'^(0|[1-9][0-9]{0,25})(\.[0-9]{1,12})?$' THEN RAISE EXCEPTION 'schedule-money-invalid'; END IF;

 authoritative_items:=jsonb_array_length(d->'targets');
 IF d->>'capability' IN ('finance.planning.budget-vs-actuals','finance.planning.forecast') OR d ? 'planning' THEN
  IF d->'targets' IS DISTINCT FROM jsonb_build_array(d->'planning'->>'budgetId') OR d->'money'->>'amount' IS DISTINCT FROM '0' OR d->'money'->>'currency' IS DISTINCT FROM d->'planning'->>'currency' THEN RAISE EXCEPTION 'planning-invalid-intent' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||b::text,0));
  planning_facts:=emdo.validate_finance_planning_intent(w,b,g.granted_by_user_id,d->>'capability',d->'planning');
  authoritative_items:=(planning_facts->>'itemCount')::integer;
 END IF;
 n:=(d->'money'->>'amount')::numeric;
 IF n<>round(n,CASE WHEN d->'money'->>'currency' IN ('JPY','KRW') THEN 0 ELSE 2 END) OR n>(g.limits->>'maxAmountPerRun')::numeric OR authoritative_items>(g.limits->>'maxItemsPerRun')::integer THEN RAISE EXCEPTION 'schedule-grant-limit-exceeded'; END IF;
 FOR target IN SELECT jsonb_array_elements_text(d->'targets') LOOP PERFORM target::uuid; END LOOP;
 IF (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(d->'targets'))<>jsonb_array_length(d->'targets') THEN RAISE EXCEPTION 'schedule-target-duplicate'; END IF;
 IF NOT EXISTS(SELECT FROM pg_timezone_names WHERE name=c->>'timeZone') THEN RAISE EXCEPTION 'schedule-timezone-invalid'; END IF;
 rule:=c->>'kind';
 IF rule='interval' THEN
 IF NOT emdo.jsonb_object_has_exact_keys(c,ARRAY['kind','everySeconds','timeZone','clock']) OR c->>'clock'<>'elapsed-utc' OR (c->>'everySeconds')::integer NOT BETWEEN 60 AND 31622400 THEN RAISE EXCEPTION 'schedule-cadence-invalid'; END IF;
 ELSE
 IF c->>'tzdbVersion' IS DISTINCT FROM tzversion OR length(tzversion) NOT BETWEEN 1 AND 40 OR c->>'localTime'!~'^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$' OR c->>'gapPolicy' NOT IN ('skip','shift-forward') OR c->>'overlapPolicy' NOT IN ('earlier','later') THEN RAISE EXCEPTION 'schedule-calendar-invalid'; END IF;
 IF rule='daily' THEN IF NOT emdo.jsonb_object_has_exact_keys(c,ARRAY['kind','anchorDate','everyDays','timeZone','localTime','gapPolicy','overlapPolicy','tzdbVersion']) OR (c->>'everyDays')::integer NOT BETWEEN 1 AND 366 THEN RAISE EXCEPTION 'schedule-cadence-invalid'; END IF;
 ELSIF rule='weekly' THEN IF NOT emdo.jsonb_object_has_exact_keys(c,ARRAY['kind','anchorDate','everyWeeks','weekday','timeZone','localTime','gapPolicy','overlapPolicy','tzdbVersion']) OR (c->>'everyWeeks')::integer NOT BETWEEN 1 AND 52 OR (c->>'weekday')::integer<>extract(isodow FROM (c->>'anchorDate')::date)::integer THEN RAISE EXCEPTION 'schedule-cadence-invalid'; END IF;
 ELSIF rule='monthly' THEN IF NOT emdo.jsonb_object_has_exact_keys(c,ARRAY['kind','anchorMonth','dayOfMonth','everyMonths','shortMonthPolicy','timeZone','localTime','gapPolicy','overlapPolicy','tzdbVersion']) OR (c->>'everyMonths')::integer NOT BETWEEN 1 AND 12 OR (c->>'dayOfMonth')::integer NOT BETWEEN 1 AND 31 OR c->>'shortMonthPolicy' NOT IN ('skip','last-day') THEN RAISE EXCEPTION 'schedule-cadence-invalid'; END IF;
 ELSE RAISE EXCEPTION 'schedule-cadence-invalid'; END IF;
 END IF;
 IF d->'misfire'->>'policy'='skip' THEN IF NOT emdo.jsonb_object_has_exact_keys(d->'misfire',ARRAY['policy','graceSeconds']) OR (d->'misfire'->>'graceSeconds')::integer NOT BETWEEN 0 AND 300 THEN RAISE EXCEPTION 'schedule-misfire-invalid'; END IF;
 ELSIF d->'misfire'->>'policy'='coalesce-latest' THEN IF NOT emdo.jsonb_object_has_exact_keys(d->'misfire',ARRAY['policy','maxLatenessSeconds']) OR (d->'misfire'->>'maxLatenessSeconds')::integer NOT BETWEEN 0 AND 86400 THEN RAISE EXCEPTION 'schedule-misfire-invalid'; END IF;
 ELSE RAISE EXCEPTION 'schedule-misfire-invalid'; END IF;
 IF d->'concurrency'->>'onBusy'<>'defer' THEN RAISE EXCEPTION 'schedule-concurrency-invalid'; END IF;
 IF d->'concurrency'->>'policy'='forbid' THEN IF NOT emdo.jsonb_object_has_exact_keys(d->'concurrency',ARRAY['policy','onBusy']) THEN RAISE EXCEPTION 'schedule-concurrency-invalid'; END IF;
 ELSIF d->'concurrency'->>'policy'='allow' THEN IF NOT emdo.jsonb_object_has_exact_keys(d->'concurrency',ARRAY['policy','maxInFlight','onBusy']) OR (d->'concurrency'->>'maxInFlight')::integer NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'schedule-concurrency-invalid'; END IF;
 ELSE RAISE EXCEPTION 'schedule-concurrency-invalid'; END IF;
 probe:=emdo.finance_schedule_slot(d,0);
 INSERT INTO emdo.finance_schedules(id,workspace_id,book_id,grant_id,grant_revision,created_by_user_id,definition,next_due_at) VALUES(sid,w,b,g.id,g.revision,emdo.current_user_id(),d,emdo.finance_schedule_next(d,0)::timestamptz) RETURNING * INTO s;
 RETURN to_jsonb(s)-'lease_token'-'lease_expires_at'-'planned_at';
END $$;

CREATE OR REPLACE FUNCTION emdo.commit_finance_schedule(sid uuid,token uuid,claimed_state integer,claimed_cursor bigint,tzversion text,proposed jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE s emdo.finance_schedules; g emdo.finance_automation_grants; saved emdo.finance_schedule_plans; expected jsonb; blocking integer; reason text; rid uuid; payload jsonb; h text; lineage jsonb; ord bigint; total_runs bigint; total_items numeric; total_amount numeric; n numeric; planning_facts jsonb; authoritative_items integer;
BEGIN
 SELECT * INTO s FROM emdo.finance_schedules WHERE id=sid; IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=s.workspace_id FOR UPDATE;
 SELECT * INTO g FROM emdo.finance_automation_grants WHERE id=s.grant_id FOR UPDATE;
 SELECT * INTO s FROM emdo.finance_schedules WHERE id=sid FOR UPDATE;
 SELECT * INTO saved FROM emdo.finance_schedule_plans WHERE schedule_id=sid AND lease_token=token;
 IF FOUND THEN RETURN jsonb_build_object('status','duplicate','operationId',saved.operation_id,'plan',saved.plan); END IF;
 IF s.status<>'active' OR s.lease_token IS DISTINCT FROM token OR s.lease_expires_at<=clock_timestamp() OR s.state_revision<>claimed_state OR s.next_ordinal<>claimed_cursor THEN RETURN jsonb_build_object('status','stale'); END IF;
 reason:=emdo.finance_automation_denial(g,s.definition->>'capability'); IF reason IS NULL AND s.grant_revision<>g.revision THEN reason:='grant-revised'; END IF;
 IF reason IS NULL AND s.definition->>'endAt' IS NOT NULL AND clock_timestamp()>=(s.definition->>'endAt')::timestamptz THEN reason:='schedule-ended'; END IF;
 IF reason IS NOT NULL THEN UPDATE emdo.finance_schedules SET blocked_reason=reason,lease_token=NULL,lease_expires_at=NULL,planned_at=NULL,next_poll_at=clock_timestamp()+interval '1 minute' WHERE id=sid; RETURN jsonb_build_object('status','denied','reason',reason); END IF;
 SELECT count(*)::integer INTO blocking FROM emdo.finance_schedule_plans p JOIN emdo.finance_automation_runs r ON r.id=p.operation_id WHERE p.schedule_id=s.id AND r.status IN ('queued','executing','retryable','requires-reconciliation');
 expected:=emdo.finance_schedule_plan(s,s.planned_at,blocking,tzversion);
 IF proposed IS DISTINCT FROM expected THEN
 UPDATE emdo.finance_schedules SET blocked_reason='planner-parity-or-state-conflict',lease_token=NULL,lease_expires_at=NULL,planned_at=NULL,next_poll_at=clock_timestamp()+interval '1 minute' WHERE id=sid;
 RETURN jsonb_build_object('status','denied','reason','planner-parity-or-state-conflict'); END IF;
 IF expected->>'status' NOT IN ('due','skipped') THEN UPDATE emdo.finance_schedules SET blocked_reason=expected->>'reason',next_due_at=(expected->>'nextDueAt')::timestamptz,next_poll_at=clock_timestamp()+interval '1 minute',lease_token=NULL,lease_expires_at=NULL,planned_at=NULL WHERE id=sid; RETURN jsonb_build_object('status',expected->>'status','plan',expected,'operationId',NULL); END IF;
 ord:=(expected->'consumedRange'->>'lastOrdinal')::bigint; rid:=emdo.finance_schedule_identity(sid,s.definition_revision,ord);
 lineage:=jsonb_build_object('controller','emdo','runKind','deterministic-finance-automation','triggerKind','schedule','scheduleId',s.id,'scheduleDefinitionRevision',s.definition_revision,'scheduleStateRevision',s.state_revision,'occurrenceOrdinal',ord,'grantId',g.id,'grantRevision',g.revision,'grantIssuerUserId',g.granted_by_user_id,'calendarVerifier','postgres-calendar.v1');
 IF expected->>'status'='due' THEN

 authoritative_items:=jsonb_array_length(s.definition->'targets');
 IF s.definition->>'capability' IN ('finance.planning.budget-vs-actuals','finance.planning.forecast') OR s.definition ? 'planning' THEN
  BEGIN
   IF s.definition->'targets' IS DISTINCT FROM jsonb_build_array(s.definition->'planning'->>'budgetId') OR s.definition->'money'->>'amount' IS DISTINCT FROM '0' OR s.definition->'money'->>'currency' IS DISTINCT FROM s.definition->'planning'->>'currency' THEN RAISE EXCEPTION 'planning-invalid-intent' USING ERRCODE='22023'; END IF;
   PERFORM pg_advisory_xact_lock(hashtextextended(s.workspace_id::text||':'||s.book_id::text,0));
   planning_facts:=emdo.validate_finance_planning_intent(s.workspace_id,s.book_id,g.granted_by_user_id,s.definition->>'capability',s.definition->'planning');
   authoritative_items:=(planning_facts->>'itemCount')::integer;
   IF authoritative_items>(g.limits->>'maxItemsPerRun')::integer THEN RAISE EXCEPTION 'planning-limit-exceeded' USING ERRCODE='42501'; END IF;
  EXCEPTION WHEN SQLSTATE '42501' OR SQLSTATE '22023' THEN
   UPDATE emdo.finance_schedules SET blocked_reason='planning-intent-changed',lease_token=NULL,lease_expires_at=NULL,planned_at=NULL,next_poll_at=clock_timestamp()+interval '1 minute' WHERE id=sid;
   RETURN jsonb_build_object('status','denied','reason','planning-intent-changed');
  END;
 END IF;
 n:=(s.definition->'money'->>'amount')::numeric;
 SELECT count(*),coalesce(sum(item_count),0),coalesce(sum(amount),0) INTO total_runs,total_items,total_amount FROM emdo.finance_automation_runs WHERE grant_id=g.id AND (reserved OR status IN ('queued','retryable'));
 IF total_runs+1>(g.limits->>'maxRuns')::integer OR total_items+authoritative_items>(g.limits->>'maxTotalItems')::integer OR total_amount+n>(g.limits->>'maxTotalAmount')::numeric OR EXISTS(SELECT FROM emdo.workspace_entitlements e WHERE e.workspace_id=g.workspace_id AND e.capability='finance.automations.run' AND e."limit" IS NOT NULL AND (SELECT count(*) FROM emdo.finance_automation_runs WHERE workspace_id=g.workspace_id AND (reserved OR status IN ('queued','retryable')))>=e."limit") THEN
 UPDATE emdo.finance_schedules SET blocked_reason='limit-exceeded',lease_token=NULL,lease_expires_at=NULL,planned_at=NULL,next_poll_at=clock_timestamp()+interval '1 minute' WHERE id=sid; RETURN jsonb_build_object('status','denied','reason','limit-exceeded'); END IF;
 payload:=jsonb_build_object('workspaceId',s.workspace_id,'bookId',s.book_id,'grantId',g.id,'grantRevision',g.revision,'capability',s.definition->>'capability','targets',s.definition->'targets','currency',s.definition->'money'->>'currency','amount',trim_scale(n)::text);
 IF planning_facts IS NOT NULL THEN payload:=payload||jsonb_build_object('planning',s.definition->'planning','planningReview',planning_facts); END IF;
 IF s.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'schedule-lease-expired' USING ERRCODE='42501'; END IF;
 h:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
 -- Existing delivery trigger creates the canonical queue reference atomically.
 INSERT INTO emdo.finance_automation_runs(id,workspace_id,book_id,grant_id,grant_revision,capability,intent,request_hash,item_count,currency,amount) VALUES(rid,s.workspace_id,s.book_id,g.id,g.revision,s.definition->>'capability',payload,h,authoritative_items,s.definition->'money'->>'currency',n);
 END IF;
 INSERT INTO emdo.finance_schedule_plans(id,workspace_id,book_id,schedule_id,definition_revision,last_ordinal,lease_token,operation_id,occurrence_key,plan,lineage) VALUES(rid,s.workspace_id,s.book_id,s.id,s.definition_revision,ord,token,CASE WHEN expected->>'status'='due' THEN rid ELSE NULL END,expected->'occurrence'->>'id',expected,lineage);
 UPDATE emdo.finance_schedules SET next_ordinal=(expected->'nextCursor'->>'nextOrdinal')::bigint,next_due_at=(expected->>'nextDueAt')::timestamptz,next_poll_at=clock_timestamp(),blocked_reason=expected->>'reason',lease_token=NULL,lease_expires_at=NULL,planned_at=NULL,updated_at=clock_timestamp() WHERE id=sid;
 RETURN jsonb_build_object('status',expected->>'status','operationId',CASE WHEN expected->>'status'='due' THEN rid ELSE NULL END,'plan',expected);
END $$;

-- Legacy overloads cannot queue a planning run without its reviewed intent.
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
--> statement-breakpoint

-- Public run history preserves typed selections without worker authority.
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
  ) || jsonb_strip_nulls(jsonb_build_object('planning',r.intent->'planning','report',r.intent->'report')) AS value FROM emdo.finance_automation_runs r
  WHERE r.workspace_id=w AND r.book_id=b AND (rid IS NULL OR r.id=rid)
  ORDER BY r.created_at DESC,r.id DESC OFFSET start_offset LIMIT page_limit+1
 ) page;
 RETURN rows_json;
END $$;

--> statement-breakpoint
-- Planning rows are immutable after their construction transaction.  The
-- marker is xid8 rather than xmin/xid so the check remains correct across
-- PostgreSQL transaction-ID wraparound.
ALTER TABLE emdo.finance_budget_revisions
  ADD COLUMN planning_construction_txid xid8 NOT NULL DEFAULT pg_current_xact_id();
ALTER TABLE emdo.finance_forecast_snapshots
  ADD COLUMN planning_construction_txid xid8 NOT NULL DEFAULT pg_current_xact_id();

CREATE OR REPLACE FUNCTION emdo.set_finance_planning_construction_txid()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.planning_construction_txid := pg_current_xact_id();
  RETURN NEW;
END $$;
ALTER FUNCTION emdo.set_finance_planning_construction_txid() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.set_finance_planning_construction_txid() FROM PUBLIC;

CREATE TRIGGER finance_budget_revisions_construction_txid
  BEFORE INSERT ON emdo.finance_budget_revisions
  FOR EACH ROW EXECUTE FUNCTION emdo.set_finance_planning_construction_txid();
CREATE TRIGGER finance_forecast_snapshots_construction_txid
  BEFORE INSERT ON emdo.finance_forecast_snapshots
  FOR EACH ROW EXECUTE FUNCTION emdo.set_finance_planning_construction_txid();

CREATE OR REPLACE FUNCTION emdo.enforce_finance_planning_child_construction()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog SET row_security = on AS $$
DECLARE parent_txid xid8;
BEGIN
  IF TG_TABLE_NAME = 'finance_budget_lines' THEN
    SELECT r.planning_construction_txid INTO parent_txid
      FROM emdo.finance_budget_revisions r
     WHERE r.workspace_id = NEW.workspace_id
       AND r.book_id = NEW.book_id
       AND r.budget_id = NEW.budget_id
       AND r.revision = NEW.revision;
  ELSIF TG_TABLE_NAME IN ('finance_forecast_lines','finance_forecast_assumptions') THEN
    SELECT s.planning_construction_txid INTO parent_txid
      FROM emdo.finance_forecast_snapshots s
     WHERE s.workspace_id = NEW.workspace_id
       AND s.book_id = NEW.book_id
       AND s.forecast_id = NEW.forecast_id
       AND s.revision = NEW.revision;
  ELSE
    RAISE EXCEPTION 'finance-planning-child-table-invalid' USING ERRCODE = '23514';
  END IF;
  IF parent_txid IS NULL THEN
    RAISE EXCEPTION 'finance-planning-parent-unavailable' USING ERRCODE = '23503';
  END IF;
  IF parent_txid IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'finance-planning-history-append-forbidden' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION emdo.enforce_finance_planning_child_construction() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.enforce_finance_planning_child_construction() FROM PUBLIC;

CREATE TRIGGER finance_budget_lines_construction
  BEFORE INSERT ON emdo.finance_budget_lines
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_planning_child_construction();
CREATE TRIGGER finance_forecast_lines_construction
  BEFORE INSERT ON emdo.finance_forecast_lines
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_planning_child_construction();
CREATE TRIGGER finance_forecast_assumptions_construction
  BEFORE INSERT ON emdo.finance_forecast_assumptions
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_planning_child_construction();

-- Planning inserts participate in the same book serialization used by
-- accounting mutations and the repository transaction API.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'finance_budget_revisions',
    'finance_budget_lines',
    'finance_forecast_snapshots',
    'finance_forecast_lines',
    'finance_forecast_assumptions'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER a_lock_book BEFORE INSERT ON emdo.%I FOR EACH ROW EXECUTE FUNCTION emdo.lock_finance_book_mutation()',
      table_name
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION emdo.enforce_finance_budget_revision_complete()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog SET row_security = on AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM emdo.finance_budget_lines l
     WHERE l.workspace_id = NEW.workspace_id
       AND l.book_id = NEW.book_id
       AND l.budget_id = NEW.budget_id
       AND l.revision = NEW.revision
  ) THEN
    RAISE EXCEPTION 'finance-budget-revision-incomplete' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION emdo.enforce_finance_budget_revision_complete() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.enforce_finance_budget_revision_complete() FROM PUBLIC;

CREATE OR REPLACE FUNCTION emdo.enforce_finance_forecast_snapshot_complete()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog SET row_security = on AS $$
DECLARE budget_count bigint;
DECLARE forecast_count bigint;
BEGIN
  SELECT count(*) INTO budget_count
    FROM emdo.finance_budget_lines l
   WHERE l.workspace_id = NEW.workspace_id
     AND l.book_id = NEW.book_id
     AND l.budget_id = NEW.budget_id
     AND l.revision = NEW.budget_revision;
  SELECT count(*) INTO forecast_count
    FROM emdo.finance_forecast_lines l
   WHERE l.workspace_id = NEW.workspace_id
     AND l.book_id = NEW.book_id
     AND l.forecast_id = NEW.forecast_id
     AND l.revision = NEW.revision;
  IF budget_count < 1 OR forecast_count <> budget_count OR
     EXISTS (
       SELECT 1
         FROM emdo.finance_budget_lines b
        WHERE b.workspace_id = NEW.workspace_id
          AND b.book_id = NEW.book_id
          AND b.budget_id = NEW.budget_id
          AND b.revision = NEW.budget_revision
          AND NOT EXISTS (
            SELECT 1
              FROM emdo.finance_forecast_lines f
             WHERE f.workspace_id = NEW.workspace_id
               AND f.book_id = NEW.book_id
               AND f.forecast_id = NEW.forecast_id
               AND f.revision = NEW.revision
               AND f.period_id = b.period_id
               AND f.account_id = b.account_id
               AND f.currency = b.currency
          )
     ) OR EXISTS (
       SELECT 1
         FROM emdo.finance_forecast_lines f
        WHERE f.workspace_id = NEW.workspace_id
          AND f.book_id = NEW.book_id
          AND f.forecast_id = NEW.forecast_id
          AND f.revision = NEW.revision
          AND NOT EXISTS (
            SELECT 1
              FROM emdo.finance_budget_lines b
             WHERE b.workspace_id = NEW.workspace_id
               AND b.book_id = NEW.book_id
               AND b.budget_id = NEW.budget_id
               AND b.revision = NEW.budget_revision
               AND b.period_id = f.period_id
               AND b.account_id = f.account_id
               AND b.currency = f.currency
          )
     ) THEN
    RAISE EXCEPTION 'finance-forecast-snapshot-incomplete' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION emdo.enforce_finance_forecast_snapshot_complete() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.enforce_finance_forecast_snapshot_complete() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER finance_budget_revision_complete
  AFTER INSERT ON emdo.finance_budget_revisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_budget_revision_complete();
CREATE CONSTRAINT TRIGGER finance_forecast_snapshot_complete
  AFTER INSERT ON emdo.finance_forecast_snapshots
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_forecast_snapshot_complete();

-- The deferred trigger protects snapshots created after this migration.  The
-- validator also checks legacy rows before binding one as reviewed input.
CREATE OR REPLACE FUNCTION emdo.finance_forecast_snapshot_is_complete(
  w uuid,
  b uuid,
  forecast_key uuid,
  forecast_revision integer
)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog SET row_security = on AS $$
DECLARE budget_key uuid;
DECLARE budget_revision_key integer;
DECLARE budget_count bigint;
DECLARE forecast_count bigint;
BEGIN
  SELECT f.budget_id, f.budget_revision
    INTO budget_key, budget_revision_key
    FROM emdo.finance_forecast_snapshots f
   WHERE f.workspace_id = w
     AND f.book_id = b
     AND f.forecast_id = forecast_key
     AND f.revision = forecast_revision;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT count(*) INTO budget_count
    FROM emdo.finance_budget_lines l
   WHERE l.workspace_id = w
     AND l.book_id = b
     AND l.budget_id = budget_key
     AND l.revision = budget_revision_key;
  SELECT count(*) INTO forecast_count
    FROM emdo.finance_forecast_lines l
   WHERE l.workspace_id = w
     AND l.book_id = b
     AND l.forecast_id = forecast_key
     AND l.revision = forecast_revision;
  IF budget_count < 1 OR forecast_count <> budget_count THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM emdo.finance_budget_lines budget_line
     WHERE budget_line.workspace_id = w
       AND budget_line.book_id = b
       AND budget_line.budget_id = budget_key
       AND budget_line.revision = budget_revision_key
       AND NOT EXISTS (
         SELECT 1
           FROM emdo.finance_forecast_lines forecast_line
          WHERE forecast_line.workspace_id = w
            AND forecast_line.book_id = b
            AND forecast_line.forecast_id = forecast_key
            AND forecast_line.revision = forecast_revision
            AND forecast_line.period_id = budget_line.period_id
            AND forecast_line.account_id = budget_line.account_id
            AND forecast_line.currency = budget_line.currency
       )
  ) OR EXISTS (
    SELECT 1
      FROM emdo.finance_forecast_lines forecast_line
     WHERE forecast_line.workspace_id = w
       AND forecast_line.book_id = b
       AND forecast_line.forecast_id = forecast_key
       AND forecast_line.revision = forecast_revision
       AND NOT EXISTS (
         SELECT 1
           FROM emdo.finance_budget_lines budget_line
          WHERE budget_line.workspace_id = w
            AND budget_line.book_id = b
            AND budget_line.budget_id = budget_key
            AND budget_line.revision = budget_revision_key
            AND budget_line.period_id = forecast_line.period_id
            AND budget_line.account_id = forecast_line.account_id
            AND budget_line.currency = forecast_line.currency
       )
  ) THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;
ALTER FUNCTION emdo.finance_forecast_snapshot_is_complete(uuid,uuid,uuid,integer)
  OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.finance_forecast_snapshot_is_complete(uuid,uuid,uuid,integer)
  FROM PUBLIC, emdo_app, emdo_worker, emdo_workflow;
