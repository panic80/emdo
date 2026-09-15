CREATE TABLE "emdo"."finance_schedule_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"definition_revision" integer NOT NULL,
	"last_ordinal" bigint NOT NULL,
	"lease_token" uuid NOT NULL,
	"operation_id" uuid,
	"occurrence_key" text,
	"plan" jsonb NOT NULL,
	"lineage" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_schedule_occurrence" UNIQUE("schedule_id","definition_revision","last_ordinal"),
	CONSTRAINT "finance_schedule_plan_lease" UNIQUE("lease_token"),
	CONSTRAINT "finance_schedule_operation" UNIQUE("operation_id"),
	CONSTRAINT "finance_schedule_plan_bounds" CHECK ("emdo"."finance_schedule_plans"."definition_revision"=1 and "emdo"."finance_schedule_plans"."last_ordinal" between 0 and 999999999 and octet_length("emdo"."finance_schedule_plans"."plan"::text)<=16384 and octet_length("emdo"."finance_schedule_plans"."lineage"::text)<=4096 and ("emdo"."finance_schedule_plans"."operation_id" is null)=("emdo"."finance_schedule_plans"."occurrence_key" is null))
);

--> statement-breakpoint

CREATE TABLE "emdo"."finance_schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"grant_revision" integer NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_revision" integer DEFAULT 1 NOT NULL,
	"state_revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"next_ordinal" bigint DEFAULT 0 NOT NULL,
	"next_due_at" timestamp with time zone,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"planned_at" timestamp with time zone,
	"blocked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_schedule_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_schedule_state" CHECK ("emdo"."finance_schedules"."status" in ('active','paused','retired') and "emdo"."finance_schedules"."definition_revision"=1 and "emdo"."finance_schedules"."state_revision">0 and "emdo"."finance_schedules"."grant_revision">0 and "emdo"."finance_schedules"."next_ordinal" between 0 and 1000000000 and octet_length("emdo"."finance_schedules"."definition"::text)<=1048576)
);

--> statement-breakpoint

ALTER TABLE "emdo"."finance_schedule_plans" ADD CONSTRAINT "finance_schedule_plan_scope" FOREIGN KEY ("workspace_id","book_id","schedule_id") REFERENCES "emdo"."finance_schedules"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "emdo"."finance_schedule_plans" ADD CONSTRAINT "finance_schedule_run_scope" FOREIGN KEY ("workspace_id","book_id","operation_id") REFERENCES "emdo"."finance_automation_runs"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "emdo"."finance_schedules" ADD CONSTRAINT "finance_schedules_created_by_user_id_auth_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "emdo"."finance_schedules" ADD CONSTRAINT "finance_schedule_grant_scope" FOREIGN KEY ("workspace_id","book_id","grant_id") REFERENCES "emdo"."finance_automation_grants"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "finance_schedule_due" ON "emdo"."finance_schedules" USING btree ("next_poll_at","next_due_at") WHERE "emdo"."finance_schedules"."status"='active';
--> statement-breakpoint
-- Fixed scheduler can propose only due occurrences of immutable, owner-created schedules.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='emdo_finance_scheduler') THEN CREATE ROLE emdo_finance_scheduler NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='emdo_finance_scheduler' AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb)) OR EXISTS(SELECT FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='emdo_finance_scheduler') OR roleid=(SELECT oid FROM pg_roles WHERE rolname='emdo_finance_scheduler')) THEN RAISE EXCEPTION 'unsafe finance scheduler role'; END IF;
END $$;
GRANT USAGE ON SCHEMA emdo TO emdo_finance_scheduler;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['finance_schedules','finance_schedule_plans'] LOOP
 EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC,emdo_app,emdo_worker,emdo_worker_executor,emdo_worker_dispatch_executor,emdo_finance_scheduler',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON emdo.%I TO emdo_finance_automation_executor',t);
 EXECUTE format('CREATE POLICY finance_schedule_executor ON emdo.%I TO emdo_finance_automation_executor USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;

CREATE FUNCTION emdo.finance_schedule_iso(t timestamptz) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$ SELECT to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;
CREATE FUNCTION emdo.finance_schedule_identity(sid uuid,rev integer,ordinal bigint) RETURNS uuid LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE b bytea; BEGIN
 b:=substring(sha256(convert_to('finance-schedule:'||sid::text||':'||rev::text||':'||ordinal::text,'UTF8')) from 1 for 16);
 b:=set_byte(b,6,(get_byte(b,6)&15)|128); b:=set_byte(b,8,(get_byte(b,8)&63)|128); RETURN encode(b,'hex')::uuid;
END $$;

-- Independent bounded SQL verification of the reviewed calendar policy. No caller
-- supplied ordinal, timestamp, source target or hash is accepted as authority.
CREATE FUNCTION emdo.finance_schedule_slot(d jsonb,ord bigint) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE c jsonb:=d->'cadence'; kind text:=c->>'kind'; zone text:=c->>'timeZone'; nominal date; month_start date; days integer; desired timestamp; instant timestamptz; candidate timestamptz; earlier timestamptz; later timestamptz; probe timestamptz; off integer; intended text; resolved text; adjustment text:='none'; adjustments jsonb:='[]'; short boolean:=false; skipped boolean:=false;
BEGIN
 IF ord<0 OR ord>1000000000 THEN RAISE EXCEPTION 'schedule-ordinal-invalid'; END IF;
 IF kind='interval' THEN instant:=(d->>'startAt')::timestamptz+ord*(c->>'everySeconds')::bigint*interval '1 second';
 RETURN jsonb_build_object('ordinal',ord,'dueAt',emdo.finance_schedule_iso(instant),'scheduledAt',emdo.finance_schedule_iso(instant),'intendedLocal',NULL,'resolvedLocal',NULL,'offsetMinutes',NULL,'adjustment','none','adjustments','[]'::jsonb); END IF;
 IF kind='monthly' THEN
 month_start:=((c->>'anchorMonth')||'-01')::date+make_interval(months=>(ord*(c->>'everyMonths')::integer)::integer);
 days:=extract(day FROM (month_start+interval '1 month -1 day'))::integer; short:=(c->>'dayOfMonth')::integer>days;
 nominal:=month_start+(least((c->>'dayOfMonth')::integer,days)-1);
 IF short THEN adjustment:=CASE WHEN c->>'shortMonthPolicy'='skip' THEN 'short-month-skipped' ELSE 'short-month-last-day' END; adjustments:=adjustments||jsonb_build_array(adjustment); skipped:=c->>'shortMonthPolicy'='skip'; END IF;
 ELSIF kind IN ('daily','weekly') THEN nominal:=(c->>'anchorDate')::date+(ord*CASE WHEN kind='daily' THEN (c->>'everyDays')::integer ELSE (c->>'everyWeeks')::integer*7 END)::integer;
 ELSE RAISE EXCEPTION 'schedule-cadence-invalid'; END IF;
 desired:=nominal+(c->>'localTime')::time; intended:=to_char(nominal,'YYYY-MM-')||lpad(CASE WHEN short THEN c->>'dayOfMonth' ELSE extract(day FROM nominal)::integer::text END,2,'0')||'T'||(c->>'localTime');
 instant:=desired AT TIME ZONE zone;
 IF instant AT TIME ZONE zone<>desired THEN
 adjustment:=CASE WHEN c->>'gapPolicy'='skip' THEN 'gap-skipped' ELSE 'gap-shift-forward' END; skipped:=skipped OR c->>'gapPolicy'='skip'; adjustments:=adjustments||jsonb_build_array(adjustment);
 ELSE
 earlier:=instant; later:=instant;
 FOREACH probe IN ARRAY ARRAY[instant-interval '2 days',instant+interval '2 days'] LOOP
 off:=extract(epoch FROM ((probe AT TIME ZONE zone)-(probe AT TIME ZONE 'UTC')))::integer/60;
 candidate:=(desired AT TIME ZONE 'UTC')-off*interval '1 minute';
 IF candidate AT TIME ZONE zone=desired THEN earlier:=least(earlier,candidate); later:=greatest(later,candidate); END IF;
 END LOOP;
 IF earlier<>later THEN adjustment:='overlap-'||(c->>'overlapPolicy'); instant:=CASE WHEN c->>'overlapPolicy'='earlier' THEN earlier ELSE later END; adjustments:=adjustments||jsonb_build_array(adjustment); END IF;
 END IF;
 off:=extract(epoch FROM ((instant AT TIME ZONE zone)-(instant AT TIME ZONE 'UTC')))::integer/60;
 resolved:=to_char(instant AT TIME ZONE zone,'YYYY-MM-DD"T"HH24:MI:SS.MS')||CASE WHEN off<0 THEN '-' ELSE '+' END||lpad((abs(off)/60)::text,2,'0')||':'||lpad((abs(off)%60)::text,2,'0');
 -- Luxon emits Z for UTC, but explicit IANA/fixed UTC calendar DateTime emits Z too.
 IF lower(zone) IN ('utc','gmt') THEN resolved:=to_char(instant AT TIME ZONE zone,'YYYY-MM-DD"T"HH24:MI:SS.MS')||'Z'; END IF;
 RETURN jsonb_build_object('ordinal',ord,'dueAt',emdo.finance_schedule_iso(instant),'scheduledAt',CASE WHEN skipped THEN NULL ELSE emdo.finance_schedule_iso(instant) END,'intendedLocal',intended,'resolvedLocal',resolved,'offsetMinutes',off,'adjustment',adjustment,'adjustments',adjustments);
END $$;
CREATE FUNCTION emdo.finance_schedule_next(d jsonb,ord bigint) RETURNS text LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE due timestamptz; BEGIN
 due:=greatest((d->>'startAt')::timestamptz,(emdo.finance_schedule_slot(d,ord)->>'dueAt')::timestamptz);
 IF d->>'endAt' IS NOT NULL AND due>=(d->>'endAt')::timestamptz THEN RETURN NULL; END IF;
 RETURN emdo.finance_schedule_iso(due);
END $$;

CREATE FUNCTION emdo.finance_schedule_plan(s emdo.finance_schedules,planned timestamptz,blocking integer,tzversion text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE d jsonb:=s.definition; c jsonb:=d->'cadence'; kind text:=c->>'kind'; first_time timestamptz:=(d->>'startAt')::timestamptz; end_time timestamptz:=(d->>'endAt')::timestamptz; local_date date; anchor date; ord bigint; slot jsonb; p jsonb; occ jsonb; eligible boolean; max_lateness integer; i integer; state text; reason text;
BEGIN
 p:=jsonb_build_object('status','not-due','executionAuthority','none','reason',NULL,'expectedStateRevision',s.state_revision,'nextDueAt',NULL,'nextCursor',jsonb_build_object('scheduleId',s.id,'definitionRevision',s.definition_revision,'nextOrdinal',s.next_ordinal),'occurrence',NULL,'evaluatedSlot',NULL,'consumedRange',NULL);
 IF s.status<>'active' THEN RETURN p||jsonb_build_object('status',s.status); END IF;
 IF kind<>'interval' AND c->>'tzdbVersion' IS DISTINCT FROM tzversion THEN RETURN p||jsonb_build_object('status','blocked','reason','timezone-rules-review-required'); END IF;
 IF kind='weekly' AND extract(isodow FROM (c->>'anchorDate')::date)::integer<>(c->>'weekday')::integer THEN RETURN p||jsonb_build_object('status','blocked','reason','weekly-anchor-weekday-mismatch'); END IF;
 IF end_time IS NOT NULL AND planned>=end_time THEN RETURN p||jsonb_build_object('status','exhausted','reason','schedule-ended'); END IF;
 p:=p||jsonb_build_object('nextDueAt',emdo.finance_schedule_next(d,s.next_ordinal));
 IF planned<first_time THEN RETURN p; END IF;
 IF kind='interval' THEN ord:=floor(extract(epoch FROM planned-first_time)/(c->>'everySeconds')::integer)::bigint;
 ELSE
 local_date:=(planned AT TIME ZONE (c->>'timeZone'))::date;
 IF kind='monthly' THEN anchor:=((c->>'anchorMonth')||'-01')::date; ord:=floor(((extract(year FROM local_date)-extract(year FROM anchor))*12+extract(month FROM local_date)-extract(month FROM anchor))/(c->>'everyMonths')::integer)::bigint;
 ELSE ord:=floor((local_date-(c->>'anchorDate')::date)::numeric/CASE WHEN kind='daily' THEN (c->>'everyDays')::integer ELSE (c->>'everyWeeks')::integer*7 END)::bigint; END IF;
 END IF;
 IF ord<0 THEN RETURN p; END IF;
 slot:=emdo.finance_schedule_slot(d,ord);
 FOR i IN 1..3 LOOP EXIT WHEN (slot->>'dueAt')::timestamptz<=planned OR ord<0; ord:=ord-1; IF ord>=0 THEN slot:=emdo.finance_schedule_slot(d,ord); END IF; END LOOP;
 IF ord<s.next_ordinal OR ord<0 THEN RETURN p; END IF;
 IF (slot->>'dueAt')::timestamptz>planned THEN RETURN p||jsonb_build_object('status','blocked','reason','calendar-resolution-bound','nextDueAt',NULL); END IF;
 IF ord>=1000000000 THEN RETURN p||jsonb_build_object('status','blocked','reason','ordinal-limit','nextDueAt',NULL); END IF;
 max_lateness:=CASE WHEN d->'misfire'->>'policy'='skip' THEN (d->'misfire'->>'graceSeconds')::integer ELSE (d->'misfire'->>'maxLatenessSeconds')::integer END;
 eligible:=slot->>'scheduledAt' IS NOT NULL AND (slot->>'scheduledAt')::timestamptz>=first_time AND extract(epoch FROM planned-(slot->>'scheduledAt')::timestamptz)<=max_lateness;
 IF eligible AND blocking >= (CASE WHEN d->'concurrency'->>'policy'='forbid' THEN 1 ELSE (d->'concurrency'->>'maxInFlight')::integer END) THEN RETURN p||jsonb_build_object('status','deferred','reason','concurrency-limit'); END IF;
 IF eligible THEN occ:=jsonb_build_object('id','finance-schedule:'||s.id::text||':'||s.definition_revision::text||':'||ord::text,'ordinal',ord,'scheduledAt',slot->'scheduledAt','intendedLocal',slot->'intendedLocal','resolvedLocal',slot->'resolvedLocal','offsetMinutes',slot->'offsetMinutes','adjustment',slot->'adjustment','adjustments',slot->'adjustments','timezoneEngine','luxon-3.7.2','tzdbVersion',CASE WHEN kind='interval' THEN NULL ELSE c->>'tzdbVersion' END); state:='due'; reason:=NULL;
 ELSE state:='skipped'; reason:=CASE WHEN slot->>'scheduledAt' IS NULL THEN slot->>'adjustment' WHEN (slot->>'dueAt')::timestamptz<first_time THEN 'before-start' ELSE 'misfire-expired' END; END IF;
 RETURN p||jsonb_build_object('status',state,'reason',reason,'nextDueAt',emdo.finance_schedule_next(d,ord+1),'nextCursor',jsonb_build_object('scheduleId',s.id,'definitionRevision',s.definition_revision,'nextOrdinal',ord+1),'occurrence',occ,'evaluatedSlot',slot-'scheduledAt'-'offsetMinutes'-'adjustment','consumedRange',jsonb_build_object('firstOrdinal',s.next_ordinal,'lastOrdinal',ord,'count',ord-s.next_ordinal+1,'disposition',CASE WHEN eligible AND d->'misfire'->>'policy'='coalesce-latest' THEN 'prior-slots-coalesced' ELSE 'prior-slots-skipped' END,'triggeredOrdinal',CASE WHEN eligible THEN ord ELSE NULL END));
END $$;

CREATE FUNCTION emdo.guard_finance_schedule_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_TABLE_NAME='finance_schedule_plans' THEN RAISE EXCEPTION 'schedule-plan-immutable'; END IF;
 IF (NEW.id,NEW.workspace_id,NEW.book_id,NEW.grant_id,NEW.grant_revision,NEW.created_by_user_id,NEW.definition,NEW.definition_revision,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.book_id,OLD.grant_id,OLD.grant_revision,OLD.created_by_user_id,OLD.definition,OLD.definition_revision,OLD.created_at) THEN RAISE EXCEPTION 'schedule-definition-immutable'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER finance_schedule_immutable BEFORE UPDATE ON emdo.finance_schedules FOR EACH ROW EXECUTE FUNCTION emdo.guard_finance_schedule_immutable();
CREATE TRIGGER finance_schedule_plan_immutable BEFORE UPDATE OR DELETE ON emdo.finance_schedule_plans FOR EACH ROW EXECUTE FUNCTION emdo.guard_finance_schedule_immutable();

CREATE FUNCTION emdo.create_finance_schedule(w uuid,b uuid,sid uuid,d jsonb,tzversion text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE g emdo.finance_automation_grants; s emdo.finance_schedules; reason text; c jsonb:=d->'cadence'; target text; n numeric; probe jsonb; rule text;
BEGIN
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=w FOR UPDATE;
 PERFORM emdo.finance_automation_admin(w,b);
 SELECT * INTO g FROM emdo.finance_automation_grants WHERE id=(d->>'grantId')::uuid AND workspace_id=w AND book_id=b FOR UPDATE;
 IF NOT FOUND OR g.granted_by_user_id<>emdo.current_user_id() THEN RAISE EXCEPTION 'schedule-owner-grant-required' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM emdo.finance_schedules WHERE id=sid;
 IF FOUND THEN IF s.workspace_id<>w OR s.book_id<>b OR s.created_by_user_id<>emdo.current_user_id() OR s.definition<>d THEN RAISE EXCEPTION 'schedule-idempotency-conflict'; END IF; RETURN to_jsonb(s)-'lease_token'-'lease_expires_at'-'planned_at'; END IF;
 reason:=emdo.finance_automation_denial(g,d->>'capability');
 IF reason IS NOT NULL OR (d->>'grantRevision')::integer<>g.revision THEN RAISE EXCEPTION 'schedule-grant-denied:%',coalesce(reason,'grant-revised') USING ERRCODE='42501'; END IF;
 IF NOT emdo.jsonb_object_has_exact_keys(d,ARRAY['workspaceId','bookId','grantId','grantRevision','capability','targets','money','startAt','endAt','cadence','misfire','concurrency']) OR (d->>'workspaceId')::uuid<>w OR (d->>'bookId')::uuid<>b OR octet_length(d::text)>1048576 OR jsonb_typeof(d->'targets')<>'array' OR jsonb_array_length(d->'targets') NOT BETWEEN 1 AND 10000 OR NOT(g.capabilities ? (d->>'capability')) THEN RAISE EXCEPTION 'schedule-definition-invalid'; END IF;
 IF (d->>'startAt')::timestamptz<g.valid_from OR (d->>'startAt')::timestamptz>=g.expires_at OR (d->>'endAt' IS NOT NULL AND ((d->>'endAt')::timestamptz<=(d->>'startAt')::timestamptz OR (d->>'endAt')::timestamptz>g.expires_at)) THEN RAISE EXCEPTION 'schedule-grant-window-invalid'; END IF;
 IF NOT emdo.jsonb_object_has_exact_keys(d->'money',ARRAY['currency','amount']) OR d->'money'->>'currency' IS DISTINCT FROM g.limits->>'currency' OR (d->'money'->>'amount')!~'^(0|[1-9][0-9]{0,25})(\.[0-9]{1,12})?$' THEN RAISE EXCEPTION 'schedule-money-invalid'; END IF;
 n:=(d->'money'->>'amount')::numeric;
 IF n<>round(n,CASE WHEN d->'money'->>'currency' IN ('JPY','KRW') THEN 0 ELSE 2 END) OR n>(g.limits->>'maxAmountPerRun')::numeric OR jsonb_array_length(d->'targets')>(g.limits->>'maxItemsPerRun')::integer THEN RAISE EXCEPTION 'schedule-grant-limit-exceeded'; END IF;
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
CREATE FUNCTION emdo.set_finance_schedule_state(w uuid,b uuid,sid uuid,expected integer,target text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE s emdo.finance_schedules; g emdo.finance_automation_grants; reason text;
BEGIN
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=w FOR UPDATE; PERFORM emdo.finance_automation_admin(w,b);
 SELECT * INTO s FROM emdo.finance_schedules WHERE id=sid AND workspace_id=w AND book_id=b;
 IF NOT FOUND OR s.created_by_user_id<>emdo.current_user_id() THEN RAISE EXCEPTION 'schedule-owner-required' USING ERRCODE='42501'; END IF;
 SELECT * INTO g FROM emdo.finance_automation_grants WHERE id=s.grant_id FOR UPDATE;
 SELECT * INTO s FROM emdo.finance_schedules WHERE id=sid FOR UPDATE;
 IF expected IS NULL OR target NOT IN ('active','paused','retired') OR target IS NULL THEN RAISE EXCEPTION 'schedule-state-invalid'; END IF;
 IF s.state_revision=expected+1 AND s.status=target THEN RETURN to_jsonb(s)-'lease_token'-'lease_expires_at'-'planned_at'; END IF;
 IF s.state_revision<>expected OR s.status='retired' THEN RAISE EXCEPTION 'schedule-state-conflict'; END IF;
 IF target='active' THEN reason:=emdo.finance_automation_denial(g,s.definition->>'capability'); IF reason IS NOT NULL OR s.grant_revision<>g.revision THEN RAISE EXCEPTION 'schedule-grant-denied:%',coalesce(reason,'grant-revised') USING ERRCODE='42501'; END IF; END IF;
 UPDATE emdo.finance_schedules SET status=target,state_revision=state_revision+1,lease_token=NULL,lease_expires_at=NULL,planned_at=NULL,blocked_reason=NULL,next_poll_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=sid RETURNING * INTO s;
 RETURN to_jsonb(s)-'lease_token'-'lease_expires_at'-'planned_at';
END $$;
CREATE FUNCTION emdo.read_finance_schedules(w uuid,b uuid,start_offset integer,page_limit integer,sid uuid DEFAULT NULL) RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 PERFORM emdo.finance_automation_admin(w,b);
 IF start_offset NOT BETWEEN 0 AND 100000 OR page_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'schedule-page-invalid'; END IF;
 RETURN QUERY SELECT to_jsonb(s)-'lease_token'-'lease_expires_at'-'planned_at' FROM emdo.finance_schedules s WHERE workspace_id=w AND book_id=b AND (sid IS NULL OR id=sid) ORDER BY created_at,id OFFSET start_offset LIMIT page_limit;
END $$;

CREATE FUNCTION emdo.claim_finance_schedules(batch integer,tzversion text) RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE candidate record; s emdo.finance_schedules; g emdo.finance_automation_grants; reason text; blocking integer;
BEGIN
 IF batch IS NULL OR batch NOT BETWEEN 1 AND 20 OR length(tzversion) NOT BETWEEN 1 AND 40 THEN RAISE EXCEPTION 'schedule-claim-invalid'; END IF;
 FOR candidate IN SELECT id,workspace_id,grant_id FROM emdo.finance_schedules WHERE status='active' AND next_due_at<=clock_timestamp() AND next_poll_at<=clock_timestamp() AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) ORDER BY next_poll_at,next_due_at,id LIMIT batch LOOP
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=candidate.workspace_id FOR UPDATE SKIP LOCKED; IF NOT FOUND THEN CONTINUE; END IF;
 SELECT * INTO g FROM emdo.finance_automation_grants WHERE id=candidate.grant_id FOR UPDATE SKIP LOCKED; IF NOT FOUND THEN CONTINUE; END IF;
 SELECT * INTO s FROM emdo.finance_schedules WHERE id=candidate.id FOR UPDATE SKIP LOCKED;
 IF NOT FOUND OR s.status<>'active' OR s.next_poll_at>clock_timestamp() OR s.next_due_at>clock_timestamp() OR s.lease_expires_at>clock_timestamp() THEN CONTINUE; END IF;
 reason:=emdo.finance_automation_denial(g,s.definition->>'capability');
 IF reason IS NULL AND s.grant_revision<>g.revision THEN reason:='grant-revised'; END IF;
 IF reason IS NULL AND s.definition->'cadence'->>'kind'<>'interval' AND s.definition->'cadence'->>'tzdbVersion' IS DISTINCT FROM tzversion THEN reason:='timezone-rules-review-required'; END IF;
 IF reason IS NOT NULL THEN UPDATE emdo.finance_schedules SET blocked_reason=reason,next_poll_at=clock_timestamp()+interval '1 minute',lease_token=NULL,lease_expires_at=NULL,planned_at=NULL WHERE id=s.id; CONTINUE; END IF;
 SELECT count(*)::integer INTO blocking FROM emdo.finance_schedule_plans p JOIN emdo.finance_automation_runs r ON r.id=p.operation_id WHERE p.schedule_id=s.id AND r.status IN ('queued','executing','retryable','requires-reconciliation');
 UPDATE emdo.finance_schedules SET lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '30 seconds',planned_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=s.id RETURNING * INTO s;
 RETURN NEXT jsonb_build_object('leaseToken',s.lease_token,'input',jsonb_build_object('schedule',jsonb_build_object('id',s.id,'definitionRevision',s.definition_revision,'stateRevision',s.state_revision,'status',s.status,'definition',s.definition),'cursor',jsonb_build_object('scheduleId',s.id,'definitionRevision',s.definition_revision,'nextOrdinal',s.next_ordinal),'now',emdo.finance_schedule_iso(s.planned_at),'blockingRunCount',blocking,'runtimeTimezoneVersion',tzversion));
 END LOOP;
END $$;
CREATE FUNCTION emdo.commit_finance_schedule(sid uuid,token uuid,claimed_state integer,claimed_cursor bigint,tzversion text,proposed jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE s emdo.finance_schedules; g emdo.finance_automation_grants; saved emdo.finance_schedule_plans; expected jsonb; blocking integer; reason text; rid uuid; payload jsonb; h text; lineage jsonb; ord bigint; total_runs bigint; total_items numeric; total_amount numeric; n numeric;
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
 n:=(s.definition->'money'->>'amount')::numeric;
 SELECT count(*),coalesce(sum(item_count),0),coalesce(sum(amount),0) INTO total_runs,total_items,total_amount FROM emdo.finance_automation_runs WHERE grant_id=g.id AND (reserved OR status IN ('queued','retryable'));
 IF total_runs+1>(g.limits->>'maxRuns')::integer OR total_items+jsonb_array_length(s.definition->'targets')>(g.limits->>'maxTotalItems')::integer OR total_amount+n>(g.limits->>'maxTotalAmount')::numeric OR EXISTS(SELECT FROM emdo.workspace_entitlements e WHERE e.workspace_id=g.workspace_id AND e.capability='finance.automations.run' AND e."limit" IS NOT NULL AND (SELECT count(*) FROM emdo.finance_automation_runs WHERE workspace_id=g.workspace_id AND (reserved OR status IN ('queued','retryable')))>=e."limit") THEN
 UPDATE emdo.finance_schedules SET blocked_reason='limit-exceeded',lease_token=NULL,lease_expires_at=NULL,planned_at=NULL,next_poll_at=clock_timestamp()+interval '1 minute' WHERE id=sid; RETURN jsonb_build_object('status','denied','reason','limit-exceeded'); END IF;
 payload:=jsonb_build_object('workspaceId',s.workspace_id,'bookId',s.book_id,'grantId',g.id,'grantRevision',g.revision,'capability',s.definition->>'capability','targets',s.definition->'targets','currency',s.definition->'money'->>'currency','amount',trim_scale(n)::text);
 h:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
 -- Existing delivery trigger creates the canonical queue reference atomically.
 INSERT INTO emdo.finance_automation_runs(id,workspace_id,book_id,grant_id,grant_revision,capability,intent,request_hash,item_count,currency,amount) VALUES(rid,s.workspace_id,s.book_id,g.id,g.revision,s.definition->>'capability',payload,h,jsonb_array_length(s.definition->'targets'),s.definition->'money'->>'currency',n);
 END IF;
 INSERT INTO emdo.finance_schedule_plans(id,workspace_id,book_id,schedule_id,definition_revision,last_ordinal,lease_token,operation_id,occurrence_key,plan,lineage) VALUES(rid,s.workspace_id,s.book_id,s.id,s.definition_revision,ord,token,CASE WHEN expected->>'status'='due' THEN rid ELSE NULL END,expected->'occurrence'->>'id',expected,lineage);
 UPDATE emdo.finance_schedules SET next_ordinal=(expected->'nextCursor'->>'nextOrdinal')::bigint,next_due_at=(expected->>'nextDueAt')::timestamptz,next_poll_at=clock_timestamp(),blocked_reason=expected->>'reason',lease_token=NULL,lease_expires_at=NULL,planned_at=NULL,updated_at=clock_timestamp() WHERE id=sid;
 RETURN jsonb_build_object('status',expected->>'status','operationId',CASE WHEN expected->>'status'='due' THEN rid ELSE NULL END,'plan',expected);
END $$;

DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='emdo' AND p.proname IN ('finance_schedule_iso','finance_schedule_identity','finance_schedule_slot','finance_schedule_next','finance_schedule_plan','guard_finance_schedule_immutable','create_finance_schedule','set_finance_schedule_state','read_finance_schedules','claim_finance_schedules','commit_finance_schedule') LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO emdo_finance_automation_executor',f.signature); EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION emdo.create_finance_schedule(uuid,uuid,uuid,jsonb,text),emdo.set_finance_schedule_state(uuid,uuid,uuid,integer,text),emdo.read_finance_schedules(uuid,uuid,integer,integer,uuid) TO emdo_app;
GRANT EXECUTE ON FUNCTION emdo.claim_finance_schedules(integer,text),emdo.commit_finance_schedule(uuid,uuid,integer,bigint,text,jsonb) TO emdo_finance_scheduler;
-- Capability readiness is intentionally unchanged; no production leaf is enabled.

GRANT EXECUTE ON FUNCTION emdo.jsonb_object_has_exact_keys(jsonb,text[]) TO emdo_finance_automation_executor;
