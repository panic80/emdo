
CREATE INDEX "automation_run_expired_execution" ON "emdo"."finance_automation_runs" USING btree ("lease_expires_at","id") WHERE "emdo"."finance_automation_runs"."status"='executing';
--> statement-breakpoint

CREATE INDEX "automation_run_delivery_deadline" ON "emdo"."finance_automation_runs" USING btree ("created_at","id") WHERE "emdo"."finance_automation_runs"."status" in ('queued','retryable');
--> statement-breakpoint
-- Immediate Finance automation requests have a fixed 30-minute delivery
-- deadline. This is uncertainty recovery, never scheduling or automatic retry.
CREATE FUNCTION emdo.reconcile_stalled_finance_runs(batch_size integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE candidate record; r emdo.finance_automation_runs; d emdo.finance_deliveries; expected_delivery integer; reason text; changed integer:=0;
BEGIN
 IF batch_size IS NULL OR batch_size NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'invalid-finance-recovery-batch'; END IF;
 FOR candidate IN
 SELECT id,workspace_id,grant_id FROM (
   (SELECT id,workspace_id,grant_id,lease_expires_at AS due_at FROM emdo.finance_automation_runs
    WHERE status='executing' AND lease_expires_at<=statement_timestamp()
    ORDER BY lease_expires_at,id LIMIT batch_size)
   UNION ALL
   (SELECT id,workspace_id,grant_id,created_at+interval '30 minutes' AS due_at FROM emdo.finance_automation_runs
    WHERE status IN ('queued','retryable') AND created_at<=statement_timestamp()-interval '30 minutes'
    ORDER BY created_at,id LIMIT batch_size)
 ) due ORDER BY due_at,id LIMIT batch_size LOOP
   -- A live report transaction owns these same locks. SKIP LOCKED prevents the
   -- sweeper from waiting on it or overwriting an outcome committed meanwhile.
   PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=candidate.workspace_id FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN CONTINUE; END IF;
   PERFORM 1 FROM emdo.finance_automation_grants WHERE id=candidate.grant_id FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN CONTINUE; END IF;
   SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=candidate.id FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN CONTINUE; END IF;
   IF r.status='executing' AND r.lease_expires_at<=clock_timestamp() THEN
     expected_delivery:=r.revision-1; reason:='execution-lease-expired';
   ELSIF r.status IN ('queued','retryable') AND r.created_at<=clock_timestamp()-interval '30 minutes' THEN
     expected_delivery:=r.revision; reason:='delivery-deadline-exceeded';
   ELSE CONTINUE; END IF;
   SELECT * INTO d FROM emdo.finance_deliveries WHERE operation_id=r.id AND delivery_revision=expected_delivery FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN
     -- Never race a delivery lock. Pre-outbox executing runs may have no
     -- delivery row; their expired canonical lease must still be recovered.
     IF EXISTS(SELECT 1 FROM emdo.finance_deliveries WHERE operation_id=r.id AND delivery_revision=expected_delivery) THEN CONTINUE; END IF;
     IF r.status<>'executing' THEN CONTINUE; END IF;
   END IF;
   UPDATE emdo.finance_automation_runs SET status='requires-reconciliation',blocked_reason=reason,revision=revision+1 WHERE id=r.id;
   IF d.id IS NOT NULL THEN UPDATE emdo.finance_deliveries SET state='quarantined',lease_token=NULL,lease_expires_at=NULL WHERE id=d.id; END IF;
   changed:=changed+1;
 END LOOP;
 RETURN changed;
END $$;
ALTER FUNCTION emdo.reconcile_stalled_finance_runs(integer) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.reconcile_stalled_finance_runs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.reconcile_stalled_finance_runs(integer) TO emdo_worker_dispatch_executor;
