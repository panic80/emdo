CREATE TABLE "emdo"."finance_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"delivery_revision" integer NOT NULL,
	"payload_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_delivery_run_revision" UNIQUE("operation_id","delivery_revision"),
	CONSTRAINT "finance_delivery_bounds" CHECK ("emdo"."finance_deliveries"."delivery_revision">0 and "emdo"."finance_deliveries"."attempts" between 0 and 20 and "emdo"."finance_deliveries"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "finance_delivery_state" CHECK ("emdo"."finance_deliveries"."state" in ('pending','leased','enqueued','cancelled','quarantined'))
);

--> statement-breakpoint

ALTER TABLE "emdo"."finance_deliveries" ADD CONSTRAINT "finance_delivery_run_scope" FOREIGN KEY ("workspace_id","book_id","operation_id") REFERENCES "emdo"."finance_automation_runs"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "finance_delivery_due" ON "emdo"."finance_deliveries" USING btree ("state","available_at");
--> statement-breakpoint
-- Finance delivery is independent of the legacy deterministic-worker outbox.
ALTER TABLE emdo.finance_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_deliveries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON emdo.finance_deliveries FROM PUBLIC,emdo_app,emdo_worker,emdo_worker_executor,emdo_worker_dispatch_executor;
GRANT SELECT,INSERT,UPDATE ON emdo.finance_deliveries TO emdo_finance_automation_executor;
CREATE POLICY finance_delivery_executor ON emdo.finance_deliveries TO emdo_finance_automation_executor USING (true) WITH CHECK (true);

CREATE FUNCTION emdo.finance_delivery_identity(rid uuid,rev integer) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE b bytea;
BEGIN
 b:=substring(sha256(convert_to('emdo.finance.automation.queue.v1:'||rid::text||':'||rev::text,'UTF8')) from 1 for 16);
 b:=set_byte(b,6,(get_byte(b,6)&15)|128); b:=set_byte(b,8,(get_byte(b,8)&63)|128);
 RETURN encode(b,'hex')::uuid;
END $$;
CREATE FUNCTION emdo.finance_delivery_hash(rid uuid,rev integer) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to('{"deliveryRevision":'||rev::text||',"operationId":"'||rid::text||'","origin":"emdo-managed","schemaVersion":1}','UTF8')),'hex');
$$;
CREATE FUNCTION emdo.guard_finance_delivery_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.id,NEW.workspace_id,NEW.book_id,NEW.operation_id,NEW.delivery_revision,NEW.payload_hash,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.book_id,OLD.operation_id,OLD.delivery_revision,OLD.payload_hash,OLD.created_at)
 THEN RAISE EXCEPTION 'finance-delivery-binding-immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER finance_delivery_binding_immutable BEFORE UPDATE ON emdo.finance_deliveries FOR EACH ROW EXECUTE FUNCTION emdo.guard_finance_delivery_binding();

CREATE FUNCTION emdo.schedule_finance_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 -- No authority locks here: caller already owns the run lock. Only initial
 -- enqueue or confirmed-not-applied settlement can create a delivery revision.
 IF (TG_OP='INSERT' AND NEW.status='queued' AND NEW.revision=1 AND NEW.attempts=0)
 OR (TG_OP='UPDATE' AND OLD.status='executing' AND NEW.status='retryable' AND NEW.revision=OLD.revision+1) THEN
 INSERT INTO emdo.finance_deliveries(id,workspace_id,book_id,operation_id,delivery_revision,payload_hash)
 VALUES(emdo.finance_delivery_identity(NEW.id,NEW.revision),NEW.workspace_id,NEW.book_id,NEW.id,NEW.revision,emdo.finance_delivery_hash(NEW.id,NEW.revision));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER finance_run_delivery AFTER INSERT OR UPDATE ON emdo.finance_automation_runs FOR EACH ROW EXECUTE FUNCTION emdo.schedule_finance_delivery();

CREATE FUNCTION emdo.claim_finance_deliveries(batch_size integer) RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE candidate record; d emdo.finance_deliveries; r emdo.finance_automation_runs; g emdo.finance_automation_grants; denial text;
BEGIN
 IF batch_size IS NULL OR batch_size NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid-finance-delivery-batch'; END IF;
 -- Candidate enumeration is non-locking. Acquisition follows epoch -> grant ->
 -- run -> delivery everywhere. Busy scopes are skipped, never lock-inverted.
 FOR candidate IN SELECT id,workspace_id,operation_id FROM emdo.finance_deliveries
 WHERE (state='pending' AND available_at<=clock_timestamp()) OR (state='leased' AND lease_expires_at<=clock_timestamp())
 ORDER BY available_at,id LIMIT batch_size LOOP
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=candidate.workspace_id FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN CONTINUE; END IF;
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=candidate.operation_id;
 SELECT * INTO g FROM emdo.finance_automation_grants WHERE id=r.grant_id FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN CONTINUE; END IF;
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=candidate.operation_id FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN CONTINUE; END IF;
 SELECT * INTO d FROM emdo.finance_deliveries WHERE id=candidate.id FOR UPDATE SKIP LOCKED;
 IF NOT FOUND OR NOT ((d.state='pending' AND d.available_at<=clock_timestamp()) OR (d.state='leased' AND d.lease_expires_at<=clock_timestamp())) THEN CONTINUE; END IF;
 denial:=emdo.finance_automation_denial(g,r.capability);
 IF denial IS NOT NULL OR r.revision<>d.delivery_revision OR r.status NOT IN ('queued','retryable') THEN
 IF denial IS NOT NULL AND r.revision=d.delivery_revision AND r.status IN ('queued','retryable') THEN
 UPDATE emdo.finance_automation_runs SET status='blocked',blocked_reason=denial,revision=revision+1 WHERE id=r.id;
 END IF;
 UPDATE emdo.finance_deliveries SET state='cancelled',lease_token=NULL,lease_expires_at=NULL WHERE id=d.id;
 CONTINUE;
 END IF;
 IF d.attempts>=20 THEN
 UPDATE emdo.finance_automation_runs SET status='requires-reconciliation',blocked_reason='delivery-transport-exhausted',revision=revision+1 WHERE id=r.id;
 UPDATE emdo.finance_deliveries SET state='quarantined',lease_token=NULL,lease_expires_at=NULL WHERE id=d.id; CONTINUE; END IF;
 UPDATE emdo.finance_deliveries SET state='leased',attempts=attempts+1,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE id=d.id RETURNING * INTO d;
 RETURN NEXT jsonb_build_object('id',d.id,'operationId',d.operation_id,'deliveryRevision',d.delivery_revision,'payloadHash',d.payload_hash,'leaseToken',d.lease_token);
 END LOOP;
END $$;

CREATE FUNCTION emdo.ack_finance_delivery(did uuid,token uuid,binding_hash text,disposition text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE d emdo.finance_deliveries; r emdo.finance_automation_runs;
BEGIN
 IF disposition NOT IN ('enqueued','quarantined') OR disposition IS NULL THEN RAISE EXCEPTION 'invalid-finance-delivery-ack'; END IF;
 SELECT * INTO d FROM emdo.finance_deliveries WHERE id=did;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=d.operation_id;
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=r.workspace_id FOR UPDATE;
 PERFORM 1 FROM emdo.finance_automation_grants WHERE id=r.grant_id FOR UPDATE;
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=d.operation_id FOR UPDATE;
 SELECT * INTO d FROM emdo.finance_deliveries WHERE id=did FOR UPDATE;
 IF NOT FOUND OR d.payload_hash IS DISTINCT FROM binding_hash THEN RETURN false; END IF;
 -- A lost ack response can be replayed with its original lease token.
 IF d.state=disposition AND d.lease_token=token THEN RETURN true; END IF;
 IF d.state<>'leased' OR d.lease_token IS DISTINCT FROM token OR d.lease_expires_at<=clock_timestamp() THEN RETURN false; END IF;
 IF disposition='quarantined' AND r.revision=d.delivery_revision AND r.status IN ('queued','retryable') THEN
 UPDATE emdo.finance_automation_runs SET status='requires-reconciliation',blocked_reason='delivery-broker-conflict',revision=revision+1 WHERE id=r.id;
 END IF;
 UPDATE emdo.finance_deliveries SET state=disposition WHERE id=did;
 RETURN true;
END $$;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='emdo' AND p.proname IN ('finance_delivery_identity','finance_delivery_hash','guard_finance_delivery_binding','schedule_finance_delivery','claim_finance_deliveries','ack_finance_delivery') LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO emdo_finance_automation_executor',f.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION emdo.claim_finance_deliveries(integer),emdo.ack_finance_delivery(uuid,uuid,text,text) TO emdo_worker_dispatch_executor;
-- Existing accepted but not yet dispatched requests receive the same canonical
-- binding. No executing or uncertain run is made eligible by this migration.
INSERT INTO emdo.finance_deliveries(id,workspace_id,book_id,operation_id,delivery_revision,payload_hash)
SELECT emdo.finance_delivery_identity(id,revision),workspace_id,book_id,id,revision,emdo.finance_delivery_hash(id,revision)
FROM emdo.finance_automation_runs WHERE status IN ('queued','retryable');
