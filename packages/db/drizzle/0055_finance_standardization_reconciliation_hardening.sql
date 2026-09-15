-- 0055 hardens the 0052 receipt/review boundary without rewriting the frozen
-- migration.  Reconciliation evidence is written only by non-login function
-- owners; the worker role can invoke the narrow lookup functions but cannot
-- forge rows with raw INSERT or UPDATE.

DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='emdo_finance_standardization_reconciler') THEN
  CREATE ROLE emdo_finance_standardization_reconciler NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
 END IF;
 IF EXISTS(
  SELECT FROM pg_roles
  WHERE rolname='emdo_finance_standardization_reconciler'
    AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb)
 ) OR EXISTS(
  SELECT FROM pg_auth_members
  WHERE member=(SELECT oid FROM pg_roles WHERE rolname='emdo_finance_standardization_reconciler')
     OR roleid=(SELECT oid FROM pg_roles WHERE rolname='emdo_finance_standardization_reconciler')
 ) THEN
  RAISE EXCEPTION 'unsafe standardization reconciler';
 END IF;
END $$;

GRANT USAGE ON SCHEMA emdo TO emdo_finance_standardization_reconciler;

-- The executor retains read access for the existing SECURITY DEFINER reader,
-- but loses every direct mutation privilege on reconciliation evidence.
REVOKE ALL ON emdo.finance_standardization_reconciliations FROM emdo_finance_standardization_executor;
GRANT SELECT ON emdo.finance_standardization_reconciliations TO emdo_finance_standardization_executor;
DROP POLICY standardization_reconciliation_executor ON emdo.finance_standardization_reconciliations;
CREATE POLICY standardization_reconciliation_executor_read
 ON emdo.finance_standardization_reconciliations
 FOR SELECT TO emdo_finance_standardization_executor USING(true);

-- This role is NOLOGIN, has no members, and is used only as the owner of the
-- narrow SECURITY DEFINER functions below.  Column grants prevent future
-- functions from silently gaining unrelated write access.
GRANT SELECT,INSERT ON emdo.finance_standardization_reconciliations TO emdo_finance_standardization_reconciler;
GRANT UPDATE(lookup_token,lookup_expires_at,observed_at,facts)
 ON emdo.finance_standardization_reconciliations TO emdo_finance_standardization_reconciler;
CREATE POLICY standardization_reconciliation_reconciler_read
 ON emdo.finance_standardization_reconciliations
 FOR SELECT TO emdo_finance_standardization_reconciler USING(true);
CREATE POLICY standardization_reconciliation_reconciler_insert
 ON emdo.finance_standardization_reconciliations
 FOR INSERT TO emdo_finance_standardization_reconciler WITH CHECK(true);
CREATE POLICY standardization_reconciliation_reconciler_update
 ON emdo.finance_standardization_reconciliations
 FOR UPDATE TO emdo_finance_standardization_reconciler USING(true) WITH CHECK(true);

-- The receipt writer also needs to lock the run and, during explicit human
-- resolution, settle the matching spend and append a command receipt.
GRANT SELECT ON emdo.finance_standardization_runs,emdo.finance_standardization_spend
 TO emdo_finance_standardization_reconciler;
GRANT UPDATE(status,revision,blockers,updated_at)
 ON emdo.finance_standardization_runs TO emdo_finance_standardization_reconciler;
GRANT UPDATE(status,actual_cad_minor,settled_at)
 ON emdo.finance_standardization_spend TO emdo_finance_standardization_reconciler;
CREATE POLICY standardization_reconciler_runs_read
 ON emdo.finance_standardization_runs
 FOR SELECT TO emdo_finance_standardization_reconciler USING(true);
CREATE POLICY standardization_reconciler_runs_update
 ON emdo.finance_standardization_runs
 FOR UPDATE TO emdo_finance_standardization_reconciler USING(true) WITH CHECK(true);
CREATE POLICY standardization_reconciler_spend_read
 ON emdo.finance_standardization_spend
 FOR SELECT TO emdo_finance_standardization_reconciler USING(true);
CREATE POLICY standardization_reconciler_spend_update
 ON emdo.finance_standardization_spend
 FOR UPDATE TO emdo_finance_standardization_reconciler USING(true) WITH CHECK(true);

GRANT SELECT,INSERT ON emdo.finance_command_receipts
 TO emdo_finance_standardization_reconciler;
CREATE POLICY standardization_reconciler_command_receipt_read
 ON emdo.finance_command_receipts
 FOR SELECT TO emdo_finance_standardization_reconciler
 USING(user_id=emdo.current_user_id());
CREATE POLICY standardization_reconciler_command_receipt_insert
 ON emdo.finance_command_receipts
 FOR INSERT TO emdo_finance_standardization_reconciler
 WITH CHECK(user_id=emdo.current_user_id());

-- Receipt lookup rechecks current authority through these source tables after
-- the durable run has been queued.  Policies stay explicit even though the
-- reconciler has no login or membership.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['household_memberships','auth_users','finance_book_grants'] LOOP
  EXECUTE format('GRANT SELECT ON emdo.%I TO emdo_finance_standardization_reconciler',t);
  EXECUTE format('CREATE POLICY standardization_reconciler_authority_read ON emdo.%I FOR SELECT TO emdo_finance_standardization_reconciler USING(true)',t);
 END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION emdo.current_user_id(),emdo.finance_book_access(uuid,uuid,text[]),emdo.lock_finance_book_grant(uuid,uuid),emdo.standardization_app_book(uuid,uuid,boolean)
 TO emdo_finance_standardization_reconciler;

CREATE FUNCTION emdo.standardization_reconciliation_worker_identity() RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT session_user='emdo_worker_executor_login'
    AND current_user='emdo_finance_standardization_reconciler'
$$;
ALTER FUNCTION emdo.standardization_reconciliation_worker_identity() OWNER TO emdo_finance_standardization_reconciler;
REVOKE ALL ON FUNCTION emdo.standardization_reconciliation_worker_identity() FROM PUBLIC,emdo_app,emdo_worker,emdo_worker_executor,emdo_worker_dispatch_executor;

-- The trigger is defense in depth for the non-login writer role and for any
-- future SECURITY DEFINER code.  A receipt can move pending -> one terminal
-- state exactly once; terminal evidence and all identity bindings are fixed.
CREATE FUNCTION emdo.guard_finance_standardization_reconciliation() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'standardization reconciliation evidence is immutable' USING ERRCODE='23514';
 END IF;

 IF TG_OP='INSERT' THEN
  IF NEW.lookup_token IS NOT NULL OR NEW.lookup_expires_at IS NOT NULL OR NEW.observed_at IS NOT NULL THEN
   RAISE EXCEPTION 'standardization reconciliation lifecycle fields invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='receipt' THEN
   IF NEW.reservation_id IS NULL OR NEW.facts->>'status'<>'pending'
      OR NEW.facts->>'providerResponseId' IS NULL
      OR length(NEW.facts->>'providerResponseId') NOT BETWEEN 1 AND 200
      OR NEW.facts->>'receiptDigest' IS NOT NULL
      OR NEW.facts->>'inputTokens' IS NOT NULL
      OR NEW.facts->>'outputTokens' IS NOT NULL
      OR NEW.facts->>'actualCadMinor' IS NOT NULL
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.facts) AS k(name)
                WHERE name NOT IN ('status','providerResponseId','receiptDigest','inputTokens','outputTokens','actualCadMinor')) THEN
    RAISE EXCEPTION 'standardization receipt must start as pending' USING ERRCODE='23514';
   END IF;
  ELSIF NEW.kind='resolution' THEN
   IF NEW.facts->>'decision' NOT IN ('confirm-not-sent','accept-actual-cost')
      OR NOT (NEW.facts ? 'receiptId')
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.facts) AS k(name)
                WHERE name NOT IN ('decision','receiptId')) THEN
    RAISE EXCEPTION 'standardization resolution evidence invalid' USING ERRCODE='23514';
   END IF;
  ELSE
   RAISE EXCEPTION 'standardization reconciliation kind invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;

 IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.run_revision IS DISTINCT FROM OLD.run_revision
    OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'standardization reconciliation identity is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.kind<>'receipt' OR OLD.facts->>'status'<>'pending' THEN
  RAISE EXCEPTION 'terminal standardization reconciliation evidence is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.facts->>'status'='pending' THEN
  IF NEW.facts IS DISTINCT FROM OLD.facts OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
     OR (NEW.lookup_token IS NULL) IS DISTINCT FROM (NEW.lookup_expires_at IS NULL) THEN
   RAISE EXCEPTION 'pending receipt may only change its lookup lease' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.facts->>'status' IS NULL OR NEW.facts->>'status' NOT IN ('verified','unavailable','mismatch')
    OR NEW.lookup_token IS NOT NULL OR NEW.lookup_expires_at IS NOT NULL
    OR NEW.observed_at IS NULL
    OR NEW.facts->>'providerResponseId' IS DISTINCT FROM OLD.facts->>'providerResponseId'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.facts) AS k(name)
              WHERE name NOT IN ('status','providerResponseId','receiptDigest','inputTokens','outputTokens','actualCadMinor')) THEN
  RAISE EXCEPTION 'standardization terminal receipt binding invalid' USING ERRCODE='23514';
 END IF;
 IF NEW.facts->>'status'='verified' THEN
  IF NEW.facts->>'receiptDigest' IS NULL OR NEW.facts->>'receiptDigest' !~ '^[a-f0-9]{64}$'
     OR NEW.facts->>'inputTokens' IS NULL OR NEW.facts->>'inputTokens' !~ '^[0-9]+$'
     OR NEW.facts->>'outputTokens' IS NULL OR NEW.facts->>'outputTokens' !~ '^[0-9]+$'
     OR NEW.facts->>'actualCadMinor' IS NULL OR NEW.facts->>'actualCadMinor' !~ '^[0-9]+$' THEN
   RAISE EXCEPTION 'verified standardization receipt facts invalid' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NEW.facts->>'id' IS NOT NULL OR NEW.facts->>'model' IS NOT NULL
     OR NEW.facts->>'receiptDigest' IS NOT NULL
     OR NEW.facts->>'inputTokens' IS NOT NULL
     OR NEW.facts->>'outputTokens' IS NOT NULL
     OR NEW.facts->>'actualCadMinor' IS NOT NULL THEN
   RAISE EXCEPTION 'unavailable standardization receipt cannot assert usage' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION emdo.guard_finance_standardization_reconciliation() OWNER TO emdo_finance_standardization_reconciler;
REVOKE ALL ON FUNCTION emdo.guard_finance_standardization_reconciliation() FROM PUBLIC,emdo_app,emdo_worker,emdo_worker_executor,emdo_worker_dispatch_executor;
CREATE TRIGGER finance_standardization_reconciliation_lifecycle
 BEFORE INSERT OR UPDATE OR DELETE ON emdo.finance_standardization_reconciliations
 FOR EACH ROW EXECUTE FUNCTION emdo.guard_finance_standardization_reconciliation();

-- The worker-owned functions are moved under the non-login writer.  Their
-- execute surface is unchanged, but their session identity is now explicit.
CREATE OR REPLACE FUNCTION emdo.claim_standardization_receipt_lookup() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE e emdo.finance_standardization_reconciliations; r emdo.finance_standardization_runs; s emdo.finance_standardization_spend; token uuid:=gen_random_uuid();
BEGIN
 IF NOT emdo.standardization_reconciliation_worker_identity() THEN RAISE EXCEPTION 'standardization-worker-denied' USING ERRCODE='42501';END IF;
 SELECT * INTO e FROM emdo.finance_standardization_reconciliations WHERE kind='receipt' AND facts->>'status'='pending' AND (lookup_expires_at IS NULL OR lookup_expires_at<clock_timestamp()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=e.run_id;
 SELECT * INTO s FROM emdo.finance_standardization_spend WHERE id=e.reservation_id AND run_id=e.run_id;
 IF r.revision<>e.run_revision OR r.source_digest<>e.source_digest OR NOT EXISTS(SELECT FROM emdo.finance_book_grants g JOIN emdo.household_memberships m ON m.household_id=g.workspace_id AND m.user_id=g.user_id JOIN emdo.auth_users u ON u.id=m.user_id WHERE g.workspace_id=r.workspace_id AND g.book_id=r.book_id AND g.user_id=e.created_by AND g.role='administrator' AND g.revoked_at IS NULL AND m.status='active' AND u.email_verified) THEN
  UPDATE emdo.finance_standardization_reconciliations SET observed_at=clock_timestamp(),facts=facts||jsonb_build_object('status','unavailable'),lookup_token=NULL,lookup_expires_at=NULL WHERE id=e.id;RETURN NULL;
 END IF;
 UPDATE emdo.finance_standardization_reconciliations SET lookup_token=token,lookup_expires_at=clock_timestamp()+interval '1 minute' WHERE id=e.id;
 RETURN jsonb_build_object('id',e.id,'token',token,'providerResponseId',s.provider_response_id,'pricing',s.pricing);
END $$;
ALTER FUNCTION emdo.claim_standardization_receipt_lookup() OWNER TO emdo_finance_standardization_reconciler;

CREATE OR REPLACE FUNCTION emdo.record_standardization_receipt_lookup(eid uuid,token uuid,facts jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE e emdo.finance_standardization_reconciliations; r emdo.finance_standardization_runs;
BEGIN
 IF NOT emdo.standardization_reconciliation_worker_identity() THEN RAISE EXCEPTION 'standardization-worker-denied' USING ERRCODE='42501';END IF;
 SELECT * INTO e FROM emdo.finance_standardization_reconciliations WHERE id=eid FOR UPDATE;
 IF NOT FOUND OR e.lookup_token IS DISTINCT FROM token OR e.lookup_expires_at<=clock_timestamp() OR e.facts->>'status'<>'pending' OR e.facts->>'providerResponseId' IS DISTINCT FROM facts->>'providerResponseId' OR facts->>'status' NOT IN ('verified','unavailable','mismatch') THEN RETURN false;END IF;
 SELECT * INTO r FROM emdo.finance_standardization_runs WHERE id=e.run_id;
 IF r.revision<>e.run_revision OR r.source_digest<>e.source_digest OR NOT EXISTS(SELECT FROM emdo.finance_book_grants g JOIN emdo.household_memberships m ON m.household_id=g.workspace_id AND m.user_id=g.user_id JOIN emdo.auth_users u ON u.id=m.user_id WHERE g.workspace_id=r.workspace_id AND g.book_id=r.book_id AND g.user_id=e.created_by AND g.role='administrator' AND g.revoked_at IS NULL AND m.status='active' AND u.email_verified) THEN RETURN false;END IF;
 UPDATE emdo.finance_standardization_reconciliations SET observed_at=clock_timestamp(),facts=record_standardization_receipt_lookup.facts,lookup_token=NULL,lookup_expires_at=NULL WHERE id=eid;RETURN true;
END $$;
ALTER FUNCTION emdo.record_standardization_receipt_lookup(uuid,uuid,jsonb) OWNER TO emdo_finance_standardization_reconciler;

ALTER FUNCTION emdo.request_standardization_receipt(uuid,uuid,uuid,integer,uuid,text) OWNER TO emdo_finance_standardization_reconciler;
ALTER FUNCTION emdo.resolve_standardization_outcome(uuid,uuid,uuid,integer,uuid,text,uuid,text) OWNER TO emdo_finance_standardization_reconciler;

REVOKE ALL ON FUNCTION emdo.request_standardization_receipt(uuid,uuid,uuid,integer,uuid,text),emdo.resolve_standardization_outcome(uuid,uuid,uuid,integer,uuid,text,uuid,text),emdo.claim_standardization_receipt_lookup(),emdo.record_standardization_receipt_lookup(uuid,uuid,jsonb) FROM PUBLIC,emdo_app,emdo_worker,emdo_worker_executor,emdo_worker_dispatch_executor;
GRANT EXECUTE ON FUNCTION emdo.request_standardization_receipt(uuid,uuid,uuid,integer,uuid,text),emdo.resolve_standardization_outcome(uuid,uuid,uuid,integer,uuid,text,uuid,text) TO emdo_app;
GRANT EXECUTE ON FUNCTION emdo.claim_standardization_receipt_lookup(),emdo.record_standardization_receipt_lookup(uuid,uuid,jsonb) TO emdo_worker_executor;
