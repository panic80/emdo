-- Bind recurring runs to the reviewed source; never select a newer source.
-- These functions preserve the original scheduler CAS and atomic outbox transaction.
CREATE FUNCTION emdo.validate_finance_schedule_source(w uuid,b uuid,u uuid,d jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET row_security=on AS $$
DECLARE derived jsonb; canonical jsonb; curr text;
BEGIN
 IF ((d->>'capability'='finance.documents.extract') IS DISTINCT FROM (d ? 'extraction')) OR
    ((d->>'capability'='finance.journals.draft') IS DISTINCT FROM (d ? 'journal')) OR
    (d ? 'planning' AND d->>'capability' NOT IN ('finance.planning.budget-vs-actuals','finance.planning.forecast')) THEN
  RAISE EXCEPTION 'schedule-source-intent-invalid' USING ERRCODE='22023';
 END IF;
 IF NOT (d ? 'extraction' OR d ? 'journal') THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||b::text,0));
 IF d ? 'extraction' THEN
  IF d->'targets' IS DISTINCT FROM jsonb_build_array(d->'extraction'->>'evidenceId') OR d->'money'->>'amount' IS DISTINCT FROM '0' THEN
   RAISE EXCEPTION 'extraction-intent-invalid' USING ERRCODE='23514';
  END IF;
  PERFORM emdo.validate_finance_extraction_intent(w,b,u,d->'extraction');
  SELECT functional_currency INTO curr FROM emdo.finance_books WHERE workspace_id=w AND id=b;
  IF curr IS DISTINCT FROM d->'money'->>'currency' THEN RAISE EXCEPTION 'extraction-currency-conflict' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('itemCount',1,'currency',curr,'amount','0');
 END IF;
 IF d->'targets' IS DISTINCT FROM jsonb_build_array(d->'journal'->>'batchId') THEN
  RAISE EXCEPTION 'finance-journal-enqueue-target-mismatch' USING ERRCODE='22023';
 END IF;
 derived:=emdo.finance_journal_draft_derive(w,b,(d->'journal'->>'batchId')::uuid);
 canonical:=jsonb_build_object('schemaVersion',1,'batchId',d->'journal'->>'batchId',
  'expectedBatchRevision',(derived->'source'->>'batchRevision')::integer,
  'expectedSnapshotHash',derived->'source'->>'snapshotHash');
 IF d->'journal' IS DISTINCT FROM canonical OR d->'money'->>'currency' IS DISTINCT FROM derived->>'currency' OR
    (d->'money'->>'amount')::numeric IS DISTINCT FROM (derived->>'amount')::numeric THEN
  RAISE EXCEPTION 'finance-journal-enqueue-intent-conflict' USING ERRCODE='23514';
 END IF;
 RETURN jsonb_build_object('itemCount',(derived->>'itemCount')::integer,'currency',derived->>'currency','amount',derived->>'amount');
END $$;
ALTER FUNCTION emdo.validate_finance_schedule_source(uuid,uuid,uuid,jsonb) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.validate_finance_schedule_source(uuid,uuid,uuid,jsonb) FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION emdo.create_finance_schedule(w uuid,b uuid,sid uuid,d jsonb,tzversion text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE g emdo.finance_automation_grants; s emdo.finance_schedules; reason text; c jsonb:=d->'cadence'; target text; n numeric; probe jsonb; rule text; planning_facts jsonb; authoritative_items integer; source_facts jsonb;
BEGIN
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=w FOR UPDATE;
 PERFORM emdo.finance_automation_admin(w,b);
 SELECT * INTO g FROM emdo.finance_automation_grants WHERE id=(d->>'grantId')::uuid AND workspace_id=w AND book_id=b FOR UPDATE;
 IF NOT FOUND OR g.granted_by_user_id<>emdo.current_user_id() THEN RAISE EXCEPTION 'schedule-owner-grant-required' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM emdo.finance_schedules WHERE id=sid;
 IF FOUND THEN IF s.workspace_id<>w OR s.book_id<>b OR s.created_by_user_id<>emdo.current_user_id() OR s.definition<>d THEN RAISE EXCEPTION 'schedule-idempotency-conflict'; END IF; RETURN to_jsonb(s)-'lease_token'-'lease_expires_at'-'planned_at'; END IF;
 reason:=emdo.finance_automation_denial(g,d->>'capability');
 IF reason IS NOT NULL OR (d->>'grantRevision')::integer<>g.revision THEN RAISE EXCEPTION 'schedule-grant-denied:%',coalesce(reason,'grant-revised') USING ERRCODE='42501'; END IF;
 IF NOT emdo.jsonb_object_has_exact_keys(d,ARRAY['workspaceId','bookId','grantId','grantRevision','capability','targets','money','startAt','endAt','cadence','misfire','concurrency'] || CASE WHEN d ? 'planning' THEN ARRAY['planning'] ELSE ARRAY[]::text[] END || CASE WHEN d ? 'extraction' THEN ARRAY['extraction'] ELSE ARRAY[]::text[] END || CASE WHEN d ? 'journal' THEN ARRAY['journal'] ELSE ARRAY[]::text[] END) OR (d->>'workspaceId')::uuid<>w OR (d->>'bookId')::uuid<>b OR octet_length(d::text)>1048576 OR jsonb_typeof(d->'targets')<>'array' OR jsonb_array_length(d->'targets') NOT BETWEEN 1 AND 10000 OR NOT(g.capabilities ? (d->>'capability')) THEN RAISE EXCEPTION 'schedule-definition-invalid'; END IF;
 IF (d->>'startAt')::timestamptz<g.valid_from OR (d->>'startAt')::timestamptz>=g.expires_at OR (d->>'endAt' IS NOT NULL AND ((d->>'endAt')::timestamptz<=(d->>'startAt')::timestamptz OR (d->>'endAt')::timestamptz>g.expires_at)) THEN RAISE EXCEPTION 'schedule-grant-window-invalid'; END IF;
 IF NOT emdo.jsonb_object_has_exact_keys(d->'money',ARRAY['currency','amount']) OR d->'money'->>'currency' IS DISTINCT FROM g.limits->>'currency' OR (d->'money'->>'amount')!~'^(0|[1-9][0-9]{0,25})(\.[0-9]{1,12})?$' THEN RAISE EXCEPTION 'schedule-money-invalid'; END IF;

 authoritative_items:=jsonb_array_length(d->'targets');
 IF d->>'capability' IN ('finance.planning.budget-vs-actuals','finance.planning.forecast') OR d ? 'planning' THEN
  IF d->'targets' IS DISTINCT FROM jsonb_build_array(d->'planning'->>'budgetId') OR d->'money'->>'amount' IS DISTINCT FROM '0' OR d->'money'->>'currency' IS DISTINCT FROM d->'planning'->>'currency' THEN RAISE EXCEPTION 'planning-invalid-intent' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||b::text,0));
  planning_facts:=emdo.validate_finance_planning_intent(w,b,g.granted_by_user_id,d->>'capability',d->'planning');
  authoritative_items:=(planning_facts->>'itemCount')::integer;
 END IF;
 source_facts:=emdo.validate_finance_schedule_source(w,b,g.granted_by_user_id,d);
 IF source_facts IS NOT NULL THEN authoritative_items:=(source_facts->>'itemCount')::integer; END IF;
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
DECLARE s emdo.finance_schedules; g emdo.finance_automation_grants; saved emdo.finance_schedule_plans; expected jsonb; blocking integer; reason text; rid uuid; payload jsonb; h text; lineage jsonb; ord bigint; total_runs bigint; total_items numeric; total_amount numeric; n numeric; planning_facts jsonb; authoritative_items integer; source_facts jsonb;
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
 BEGIN
  source_facts:=emdo.validate_finance_schedule_source(s.workspace_id,s.book_id,g.granted_by_user_id,s.definition);
  IF source_facts IS NOT NULL THEN
   authoritative_items:=(source_facts->>'itemCount')::integer;
   IF authoritative_items>(g.limits->>'maxItemsPerRun')::integer OR (source_facts->>'amount')::numeric>(g.limits->>'maxAmountPerRun')::numeric THEN
    RAISE EXCEPTION 'schedule-source-limit-exceeded' USING ERRCODE='42501';
   END IF;
  END IF;
 EXCEPTION WHEN SQLSTATE '42501' OR SQLSTATE '23514' OR SQLSTATE '22023' THEN
  GET STACKED DIAGNOSTICS reason = MESSAGE_TEXT;
  UPDATE emdo.finance_schedules SET blocked_reason=reason,lease_token=NULL,lease_expires_at=NULL,planned_at=NULL,next_poll_at=clock_timestamp()+interval '1 minute' WHERE id=sid;
  RETURN jsonb_build_object('status','denied','reason',reason);
 END;
 n:=(s.definition->'money'->>'amount')::numeric;
 SELECT count(*),coalesce(sum(item_count),0),coalesce(sum(amount),0) INTO total_runs,total_items,total_amount FROM emdo.finance_automation_runs WHERE grant_id=g.id AND (reserved OR status IN ('queued','retryable'));
 IF total_runs+1>(g.limits->>'maxRuns')::integer OR total_items+authoritative_items>(g.limits->>'maxTotalItems')::integer OR total_amount+n>(g.limits->>'maxTotalAmount')::numeric OR EXISTS(SELECT FROM emdo.workspace_entitlements e WHERE e.workspace_id=g.workspace_id AND e.capability='finance.automations.run' AND e."limit" IS NOT NULL AND (SELECT count(*) FROM emdo.finance_automation_runs WHERE workspace_id=g.workspace_id AND (reserved OR status IN ('queued','retryable')))>=e."limit") THEN
 UPDATE emdo.finance_schedules SET blocked_reason='limit-exceeded',lease_token=NULL,lease_expires_at=NULL,planned_at=NULL,next_poll_at=clock_timestamp()+interval '1 minute' WHERE id=sid; RETURN jsonb_build_object('status','denied','reason','limit-exceeded'); END IF;
 payload:=jsonb_build_object('workspaceId',s.workspace_id,'bookId',s.book_id,'grantId',g.id,'grantRevision',g.revision,'capability',s.definition->>'capability','targets',s.definition->'targets','currency',s.definition->'money'->>'currency','amount',trim_scale(n)::text);
 IF planning_facts IS NOT NULL THEN payload:=payload||jsonb_build_object('planning',s.definition->'planning','planningReview',planning_facts); END IF;
 IF s.definition ? 'extraction' THEN payload:=payload||jsonb_build_object('extraction',s.definition->'extraction'); END IF;
 IF s.definition ? 'journal' THEN payload:=payload||jsonb_build_object('journal',s.definition->'journal','journalReview',source_facts); END IF;
 IF s.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'schedule-lease-expired' USING ERRCODE='42501'; END IF;
 h:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
 -- Existing delivery trigger creates the canonical queue reference atomically.
 INSERT INTO emdo.finance_automation_runs(id,workspace_id,book_id,grant_id,grant_revision,capability,intent,request_hash,item_count,currency,amount) VALUES(rid,s.workspace_id,s.book_id,g.id,g.revision,s.definition->>'capability',payload,h,authoritative_items,s.definition->'money'->>'currency',n);
 END IF;
 INSERT INTO emdo.finance_schedule_plans(id,workspace_id,book_id,schedule_id,definition_revision,last_ordinal,lease_token,operation_id,occurrence_key,plan,lineage) VALUES(rid,s.workspace_id,s.book_id,s.id,s.definition_revision,ord,token,CASE WHEN expected->>'status'='due' THEN rid ELSE NULL END,expected->'occurrence'->>'id',expected,lineage);
 UPDATE emdo.finance_schedules SET next_ordinal=(expected->'nextCursor'->>'nextOrdinal')::bigint,next_due_at=(expected->>'nextDueAt')::timestamptz,next_poll_at=clock_timestamp(),blocked_reason=expected->>'reason',lease_token=NULL,lease_expires_at=NULL,planned_at=NULL,updated_at=clock_timestamp() WHERE id=sid;
 RETURN jsonb_build_object('status',expected->>'status','operationId',CASE WHEN expected->>'status'='due' THEN rid ELSE NULL END,'plan',expected);
END $$;

