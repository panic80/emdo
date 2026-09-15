CREATE TABLE "emdo"."finance_automation_authority_epochs" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "automation_epoch_positive" CHECK ("emdo"."finance_automation_authority_epochs"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_automation_capabilities" (
	"capability" text PRIMARY KEY NOT NULL,
	"ready" boolean DEFAULT false NOT NULL,
	CONSTRAINT "automation_capability_closed" CHECK ("emdo"."finance_automation_capabilities"."capability" in ('finance.documents.extract','finance.reports.generate','finance.journals.draft'))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_automation_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"authority_epoch" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"capabilities" jsonb NOT NULL,
	"limits" jsonb NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_grant_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "automation_grant_state" CHECK ("emdo"."finance_automation_grants"."status" in ('active','revoked') and "emdo"."finance_automation_grants"."revision">0 and "emdo"."finance_automation_grants"."authority_epoch">0 and "emdo"."finance_automation_grants"."expires_at">"emdo"."finance_automation_grants"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_automation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"grant_revision" integer NOT NULL,
	"capability" text NOT NULL,
	"intent" jsonb NOT NULL,
	"request_hash" text NOT NULL,
	"item_count" integer NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(38, 12) NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"reserved" boolean DEFAULT false NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"outcome_reference" uuid,
	"blocked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_run_state" CHECK ("emdo"."finance_automation_runs"."status" in ('queued','executing','retryable','completed','blocked','requires-reconciliation') and "emdo"."finance_automation_runs"."revision">0 and "emdo"."finance_automation_runs"."attempts">=0 and "emdo"."finance_automation_runs"."item_count">0 and "emdo"."finance_automation_runs"."amount">=0),
	CONSTRAINT "automation_run_outcome" CHECK (("emdo"."finance_automation_runs"."status"='completed') = ("emdo"."finance_automation_runs"."outcome_reference" is not null)),
	CONSTRAINT "automation_run_hash" CHECK ("emdo"."finance_automation_runs"."request_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_automation_authority_epochs" ADD CONSTRAINT "finance_automation_authority_epochs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_automation_grants" ADD CONSTRAINT "finance_automation_grants_granted_by_user_id_auth_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_automation_grants" ADD CONSTRAINT "finance_automation_grants_workspace_id_book_id_finance_books_workspace_id_id_fk" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_automation_runs" ADD CONSTRAINT "finance_automation_runs_workspace_id_book_id_grant_id_finance_automation_grants_workspace_id_book_id_id_fk" FOREIGN KEY ("workspace_id","book_id","grant_id") REFERENCES "emdo"."finance_automation_grants"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
--> statement-breakpoint
-- Durable authority is intentionally separate from browser/session invocation.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='emdo_finance_automation_executor') THEN
 CREATE ROLE emdo_finance_automation_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
 END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='emdo_finance_automation_executor' AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb)) OR EXISTS(SELECT FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='emdo_finance_automation_executor') OR roleid=(SELECT oid FROM pg_roles WHERE rolname='emdo_finance_automation_executor')) THEN RAISE EXCEPTION 'unsafe automation executor role'; END IF;
END $$;
GRANT USAGE ON SCHEMA emdo TO emdo_finance_automation_executor;
GRANT EXECUTE ON FUNCTION emdo.finance_book_access(uuid,uuid,text[]),emdo.current_user_id() TO emdo_finance_automation_executor;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['finance_automation_authority_epochs','finance_automation_capabilities','finance_automation_grants','finance_automation_runs'] LOOP
 EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON emdo.%I TO emdo_finance_automation_executor',t);
 EXECUTE format('CREATE POLICY automation_executor ON emdo.%I TO emdo_finance_automation_executor USING(true) WITH CHECK(true)',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['household_memberships','finance_book_grants','workspace_entitlements','auth_users','finance_books'] LOOP
 EXECUTE format('GRANT SELECT ON emdo.%I TO emdo_finance_automation_executor',t);
 EXECUTE format('CREATE POLICY automation_authority_read ON emdo.%I FOR SELECT TO emdo_finance_automation_executor USING(true)',t);
 END LOOP;
END $$;
-- Runtime cannot enable readiness or mint entitlements. Only reviewed deployment
-- configuration may enable an implemented leaf; this migration enables none.
REVOKE INSERT,UPDATE ON emdo.finance_automation_capabilities FROM emdo_finance_automation_executor;
INSERT INTO emdo.finance_automation_capabilities(capability,ready) VALUES
 ('finance.documents.extract',false),('finance.reports.generate',false),('finance.journals.draft',false);
INSERT INTO emdo.finance_automation_authority_epochs(workspace_id) SELECT id FROM emdo.workspaces;

CREATE FUNCTION emdo.bump_finance_automation_authority() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET row_security=on AS $$
DECLARE w uuid;
BEGIN
 IF TG_TABLE_NAME='household_memberships' THEN
 w:=CASE WHEN TG_OP='DELETE' THEN OLD.household_id ELSE NEW.household_id END;
 ELSE w:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END; END IF;
 INSERT INTO emdo.finance_automation_authority_epochs(workspace_id,revision) VALUES(w,1)
 ON CONFLICT(workspace_id) DO UPDATE SET revision=emdo.finance_automation_authority_epochs.revision+1;
 RETURN NULL;
END $$;
ALTER FUNCTION emdo.bump_finance_automation_authority() OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.bump_finance_automation_authority() FROM PUBLIC;
CREATE TRIGGER automation_membership_epoch AFTER INSERT OR UPDATE OR DELETE ON emdo.household_memberships FOR EACH ROW EXECUTE FUNCTION emdo.bump_finance_automation_authority();
CREATE TRIGGER automation_book_access_epoch AFTER INSERT OR UPDATE OR DELETE ON emdo.finance_book_grants FOR EACH ROW EXECUTE FUNCTION emdo.bump_finance_automation_authority();
CREATE TRIGGER automation_entitlement_epoch AFTER INSERT OR UPDATE OR DELETE ON emdo.workspace_entitlements FOR EACH ROW EXECUTE FUNCTION emdo.bump_finance_automation_authority();

CREATE FUNCTION emdo.finance_automation_admin(w uuid,b uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 IF NOT emdo.finance_book_access(w,b,ARRAY['administrator']) THEN
 RAISE EXCEPTION 'automation-admin-required' USING ERRCODE='42501'; END IF;
END $$;

CREATE FUNCTION emdo.create_finance_automation_grant(w uuid,b uuid,gid uuid,caps jsonb,lim jsonb,starts timestamptz,ends timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE epoch integer; g emdo.finance_automation_grants; cap text; amount_key text; n numeric;
BEGIN
 -- Serialize against the authority epoch before validating current permissions.
 INSERT INTO emdo.finance_automation_authority_epochs(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 SELECT revision INTO epoch FROM emdo.finance_automation_authority_epochs WHERE workspace_id=w FOR UPDATE;
 PERFORM emdo.finance_automation_admin(w,b);
 IF jsonb_typeof(caps)<>'array' OR jsonb_array_length(caps) NOT BETWEEN 1 AND 3 OR
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

CREATE FUNCTION emdo.revoke_finance_automation_grant(w uuid,b uuid,gid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET row_security=on AS $$
DECLARE g emdo.finance_automation_grants;
BEGIN
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=w FOR UPDATE;
 PERFORM emdo.finance_automation_admin(w,b);
 UPDATE emdo.finance_automation_grants SET status='revoked',revision=revision+1 WHERE id=gid AND workspace_id=w AND book_id=b AND status='active';
 SELECT * INTO g FROM emdo.finance_automation_grants WHERE id=gid AND workspace_id=w AND book_id=b;
 IF NOT FOUND THEN RAISE EXCEPTION 'automation-grant-not-found'; END IF;
 RETURN to_jsonb(g);
END $$;

CREATE FUNCTION emdo.list_finance_automation_grants(w uuid,b uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 PERFORM emdo.finance_automation_admin(w,b);
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(g) ORDER BY created_at,id) FROM emdo.finance_automation_grants g WHERE workspace_id=w AND book_id=b),'[]'::jsonb);
END $$;

-- This helper has no public/app/worker execute grant. Callers hold epoch + grant
-- locks. It reads REAL current membership, book access, entitlement and readiness.
CREATE FUNCTION emdo.finance_automation_denial(g emdo.finance_automation_grants,cap text) RETURNS text LANGUAGE plpgsql
SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 IF g.status<>'active' THEN RETURN 'grant-revoked'; END IF;
 IF clock_timestamp()<g.valid_from THEN RETURN 'grant-not-yet-valid'; END IF;
 IF clock_timestamp()>=g.expires_at THEN RETURN 'grant-expired'; END IF;
 IF NOT EXISTS(SELECT FROM emdo.household_memberships m JOIN emdo.auth_users u ON u.id=m.user_id
 WHERE m.household_id=g.workspace_id AND m.user_id=g.granted_by_user_id AND m.status='active' AND u.email_verified) THEN RETURN 'membership-inactive'; END IF;
 IF NOT EXISTS(SELECT FROM emdo.finance_book_grants WHERE workspace_id=g.workspace_id AND book_id=g.book_id AND user_id=g.granted_by_user_id AND revoked_at IS NULL AND role='administrator') THEN RETURN 'book-authority-changed'; END IF;
 IF NOT EXISTS(SELECT FROM emdo.workspace_entitlements WHERE workspace_id=g.workspace_id AND capability='finance.automations.run' AND enabled) THEN RETURN 'entitlement-disabled'; END IF;
 IF NOT EXISTS(SELECT FROM emdo.finance_automation_authority_epochs WHERE workspace_id=g.workspace_id AND revision=g.authority_epoch) THEN RETURN 'authority-changed'; END IF;
 IF NOT(g.capabilities ? cap) OR NOT EXISTS(SELECT FROM emdo.finance_automation_capabilities WHERE capability=cap AND ready) THEN RETURN 'capability-not-ready'; END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION emdo.enqueue_finance_automation_run(w uuid,b uuid,gid uuid,rid uuid,cap text,targets jsonb,curr text,amt text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE g emdo.finance_automation_grants; r emdo.finance_automation_runs; payload jsonb; h text; reason text; target text; n numeric;
BEGIN
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=w FOR UPDATE;
 PERFORM emdo.finance_automation_admin(w,b);
 SELECT * INTO g FROM emdo.finance_automation_grants WHERE id=gid AND workspace_id=w AND book_id=b FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'automation-grant-not-found'; END IF;
 reason:=emdo.finance_automation_denial(g,cap);
 IF reason IS NOT NULL THEN RAISE EXCEPTION '%',reason USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(targets)<>'array' OR jsonb_array_length(targets) NOT BETWEEN 1 AND 10000 OR
 curr IS DISTINCT FROM g.limits->>'currency' OR amt IS NULL OR amt!~'^(0|[1-9][0-9]{0,25})(\.[0-9]{1,12})?$' THEN RAISE EXCEPTION 'automation-invalid-intent'; END IF;
 FOR target IN SELECT jsonb_array_elements_text(targets) LOOP PERFORM target::uuid; END LOOP;
 IF (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(targets))<>jsonb_array_length(targets) THEN RAISE EXCEPTION 'automation-duplicate-target'; END IF;
 n:=amt::numeric;
 IF n<>round(n,CASE WHEN curr IN ('JPY','KRW') THEN 0 ELSE 2 END) OR n>(g.limits->>'maxAmountPerRun')::numeric OR jsonb_array_length(targets)>(g.limits->>'maxItemsPerRun')::integer THEN RAISE EXCEPTION 'automation-limit-exceeded'; END IF;
 -- Database-owned canonical JSONB encoding; no client/queue supplied hash.
 payload:=jsonb_build_object('workspaceId',w,'bookId',b,'grantId',gid,'grantRevision',g.revision,'capability',cap,'targets',targets,'currency',curr,'amount',trim_scale(n)::text);
 h:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid;
 IF FOUND THEN
 IF r.workspace_id<>w OR r.book_id<>b OR r.request_hash<>h THEN RAISE EXCEPTION 'automation-idempotency-conflict'; END IF;
 RETURN (to_jsonb(r)||jsonb_build_object('amount',r.amount::text));
 END IF;
 INSERT INTO emdo.finance_automation_runs(id,workspace_id,book_id,grant_id,grant_revision,capability,intent,request_hash,item_count,currency,amount)
 VALUES(rid,w,b,gid,g.revision,cap,payload,h,jsonb_array_length(targets),curr,n) RETURNING * INTO r;
 RETURN (to_jsonb(r)||jsonb_build_object('amount',r.amount::text));
END $$;

-- Worker receives only an operation UUID. It cannot submit authority, intent,
-- limits, tenant claims or a browser session. This is a durable claim foundation,
-- not pg-boss registration and not permission to invoke a production leaf yet.
CREATE FUNCTION emdo.claim_finance_automation_run(rid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_automation_runs; g emdo.finance_automation_grants; reason text; used_runs bigint; used_items bigint; used_amount numeric;
BEGIN
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=r.workspace_id FOR UPDATE;
 SELECT * INTO g FROM emdo.finance_automation_grants WHERE id=r.grant_id FOR UPDATE;
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid FOR UPDATE;
 reason:=emdo.finance_automation_denial(g,r.capability);
 IF reason IS NULL AND r.grant_revision<>g.revision THEN reason:='grant-revised'; END IF;
 IF r.status='executing' AND r.lease_expires_at<=clock_timestamp() THEN
 UPDATE emdo.finance_automation_runs SET status='requires-reconciliation',revision=revision+1,blocked_reason='lease-expired' WHERE id=rid RETURNING * INTO r;
 END IF;
 IF reason IS NOT NULL THEN
 IF r.status IN ('queued','retryable') THEN UPDATE emdo.finance_automation_runs SET status='blocked',blocked_reason=reason,revision=revision+1 WHERE id=rid; END IF;
 RETURN jsonb_build_object('status','denied','reason',reason);
 END IF;
 IF r.status='completed' THEN RETURN jsonb_build_object('status','duplicate','outcomeReference',r.outcome_reference); END IF;
 IF r.status NOT IN ('queued','retryable') THEN RETURN jsonb_build_object('status','denied','reason','run-not-runnable'); END IF;
 SELECT count(*),coalesce(sum(item_count),0),coalesce(sum(amount),0) INTO used_runs,used_items,used_amount FROM emdo.finance_automation_runs WHERE grant_id=g.id AND reserved AND id<>rid;
 IF EXISTS(SELECT FROM emdo.workspace_entitlements e WHERE e.workspace_id=g.workspace_id AND e.capability='finance.automations.run' AND e."limit" IS NOT NULL AND (SELECT count(*) FROM emdo.finance_automation_runs WHERE workspace_id=g.workspace_id AND reserved AND id<>rid)>=e."limit") THEN reason:='entitlement-limit-exceeded';
 ELSIF r.attempts>=(g.limits->>'maxAttemptsPerRun')::integer THEN reason:='attempts-exhausted';
 ELSIF used_runs+1>(g.limits->>'maxRuns')::integer OR used_items+r.item_count>(g.limits->>'maxTotalItems')::integer OR used_amount+r.amount>(g.limits->>'maxTotalAmount')::numeric THEN reason:='limit-exceeded'; END IF;
 IF reason IS NOT NULL THEN
 UPDATE emdo.finance_automation_runs SET status='blocked',blocked_reason=reason,revision=revision+1 WHERE id=rid;
 RETURN jsonb_build_object('status','denied','reason',reason);
 END IF;
 UPDATE emdo.finance_automation_runs SET status='executing',reserved=true,attempts=attempts+1,revision=revision+1,lease_token=gen_random_uuid(),lease_expires_at=least(clock_timestamp()+interval '2 minutes',g.expires_at) WHERE id=rid RETURNING * INTO r;
 RETURN jsonb_build_object('status','claimed','run',(to_jsonb(r)||jsonb_build_object('amount',r.amount::text)));
END $$;

-- Delivery revision is a reference, not authority. Reject stale/future queued
-- deliveries BEFORE claiming/reserving a new attempt, under canonical lock order.
CREATE FUNCTION emdo.claim_finance_automation_delivery(rid uuid,expected_revision integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_automation_runs;
BEGIN
 IF expected_revision IS NULL OR expected_revision<1 THEN RAISE EXCEPTION 'automation-invalid-delivery-revision'; END IF;
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=r.workspace_id FOR UPDATE;
 PERFORM 1 FROM emdo.finance_automation_grants WHERE id=r.grant_id FOR UPDATE;
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid FOR UPDATE;
 IF expected_revision>r.revision OR (expected_revision<>r.revision AND r.status<>'completed') THEN
 RETURN jsonb_build_object('status','denied','reason','delivery-revision-conflict'); END IF;
 -- Completed delivery replay still goes through fresh authority before returning
 -- the canonical outcome. Existing locks are reentrant within this transaction.
 RETURN emdo.claim_finance_automation_run(rid);
END $$;

CREATE FUNCTION emdo.settle_finance_automation_run(rid uuid,expected_revision integer,token uuid,result text,outcome uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_automation_runs;
BEGIN
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'automation-run-not-found'; END IF;
 IF result NOT IN ('applied','not-applied','indeterminate') OR (result='applied')<>(outcome IS NOT NULL) THEN RAISE EXCEPTION 'automation-invalid-outcome'; END IF;
 IF r.status='completed' AND result='applied' AND r.outcome_reference=outcome AND r.lease_token=token AND r.revision=expected_revision+1 THEN RETURN (to_jsonb(r)||jsonb_build_object('amount',r.amount::text)); END IF;
 IF r.status<>'executing' OR r.revision<>expected_revision OR r.lease_token IS DISTINCT FROM token THEN RAISE EXCEPTION 'automation-lease-conflict'; END IF;
 IF r.lease_expires_at<=clock_timestamp() THEN
 UPDATE emdo.finance_automation_runs SET status='requires-reconciliation',revision=revision+1,blocked_reason='lease-expired' WHERE id=rid RETURNING * INTO r;
 RETURN (to_jsonb(r)||jsonb_build_object('amount',r.amount::text));
 END IF;
 UPDATE emdo.finance_automation_runs SET status=CASE result WHEN 'applied' THEN 'completed' WHEN 'not-applied' THEN 'retryable' ELSE 'requires-reconciliation' END,
 outcome_reference=outcome,revision=revision+1 WHERE id=rid RETURNING * INTO r;
 RETURN (to_jsonb(r)||jsonb_build_object('amount',r.amount::text));
END $$;

DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='emdo' AND p.proname IN ('finance_automation_admin','create_finance_automation_grant','revoke_finance_automation_grant','list_finance_automation_grants','finance_automation_denial','enqueue_finance_automation_run','claim_finance_automation_run','claim_finance_automation_delivery','settle_finance_automation_run') LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO emdo_finance_automation_executor',f.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION emdo.create_finance_automation_grant(uuid,uuid,uuid,jsonb,jsonb,timestamptz,timestamptz),emdo.revoke_finance_automation_grant(uuid,uuid,uuid),emdo.list_finance_automation_grants(uuid,uuid),emdo.enqueue_finance_automation_run(uuid,uuid,uuid,uuid,text,jsonb,text,text) TO emdo_app;
GRANT EXECUTE ON FUNCTION emdo.claim_finance_automation_run(uuid),emdo.claim_finance_automation_delivery(uuid,integer),emdo.settle_finance_automation_run(uuid,integer,uuid,text,uuid) TO emdo_worker;
