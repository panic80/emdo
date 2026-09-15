ALTER TABLE emdo.finance_generated_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_generated_reports FORCE ROW LEVEL SECURITY;
REVOKE ALL ON emdo.finance_generated_reports FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow;
GRANT SELECT,INSERT ON emdo.finance_generated_reports TO emdo_finance_automation_executor;
CREATE POLICY generated_report_executor_read ON emdo.finance_generated_reports FOR SELECT TO emdo_finance_automation_executor USING(true);
CREATE POLICY generated_report_executor_insert ON emdo.finance_generated_reports FOR INSERT TO emdo_finance_automation_executor WITH CHECK(true);
GRANT SELECT ON emdo.finance_generated_reports TO emdo_app;
CREATE POLICY generated_report_book_read ON emdo.finance_generated_reports FOR SELECT TO emdo_app USING(emdo.finance_book_access(workspace_id,book_id));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['finance_ledger_accounts','finance_journals','finance_journal_lines'] LOOP
 EXECUTE format('GRANT SELECT ON emdo.%I TO emdo_finance_automation_executor',t);
 EXECUTE format('CREATE POLICY generated_report_source ON emdo.%I FOR SELECT TO emdo_finance_automation_executor USING(true)',t);
 END LOOP;
END $$;
CREATE FUNCTION emdo.reject_generated_report_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'generated-report-immutable' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION emdo.reject_generated_report_mutation() FROM PUBLIC;
CREATE TRIGGER immutable_generated_report BEFORE UPDATE OR DELETE ON emdo.finance_generated_reports FOR EACH ROW EXECUTE FUNCTION emdo.reject_generated_report_mutation();

-- Sole implemented leaf: a current snapshot of ALL posted ledger movements.
-- It is NOT a historical cutoff, tax filing, or a claim of accounting completeness.
-- No capability readiness or entitlement is enabled by this migration.
CREATE FUNCTION emdo.generate_finance_trial_balance(rid uuid,expected_revision integer,token uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_automation_runs; g emdo.finance_automation_grants; reason text; report_id uuid; functional_currency text; snapshot_time timestamptz;
 rows_json jsonb; sources_json jsonb; total_debit numeric; total_credit numeric; body jsonb;
BEGIN
 IF token IS NULL OR expected_revision IS NULL OR expected_revision<1 THEN RAISE EXCEPTION 'report-invalid-lease' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid;
 IF NOT FOUND THEN RAISE EXCEPTION 'report-run-unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM emdo.finance_automation_authority_epochs WHERE workspace_id=r.workspace_id FOR UPDATE;
 SELECT * INTO g FROM emdo.finance_automation_grants WHERE id=r.grant_id FOR UPDATE;
 SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid FOR UPDATE;
 reason:=emdo.finance_automation_denial(g,r.capability);
 IF reason IS NOT NULL OR r.grant_revision<>g.revision THEN RAISE EXCEPTION 'report-authority-revoked' USING ERRCODE='42501'; END IF;
 IF r.capability<>'finance.reports.generate' OR r.item_count<>1 OR r.intent->'targets' IS DISTINCT FROM jsonb_build_array(r.book_id::text) OR r.amount<>0 THEN
 RAISE EXCEPTION 'report-unsupported-intent' USING ERRCODE='22023'; END IF;
 SELECT id INTO report_id FROM emdo.finance_generated_reports WHERE automation_run_id=rid AND workspace_id=r.workspace_id AND book_id=r.book_id;
 IF FOUND AND r.status='completed' AND r.outcome_reference=report_id AND r.lease_token=token AND r.revision=expected_revision+1 THEN RETURN report_id; END IF;
 IF r.status<>'executing' OR r.revision<>expected_revision OR r.lease_token IS DISTINCT FROM token OR r.lease_expires_at<=clock_timestamp() THEN
 RAISE EXCEPTION 'report-lease-conflict' USING ERRCODE='42501'; END IF;
 -- Existing book mutation triggers take this exact advisory lock. No account
 -- rename or journal posting can interleave with snapshot materialization.
 PERFORM pg_advisory_xact_lock(hashtextextended(r.workspace_id::text||':'||r.book_id::text,0));
 SELECT b.functional_currency INTO functional_currency FROM emdo.finance_books b WHERE b.workspace_id=r.workspace_id AND b.id=r.book_id;
 IF functional_currency IS NULL OR functional_currency<>r.currency THEN RAISE EXCEPTION 'report-currency-mismatch' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM (SELECT 1 FROM emdo.finance_journals WHERE workspace_id=r.workspace_id AND book_id=r.book_id AND status='posted' LIMIT 10001) x)>10000 OR
 (SELECT count(*) FROM (SELECT 1 FROM emdo.finance_ledger_accounts WHERE workspace_id=r.workspace_id AND book_id=r.book_id LIMIT 10001) x)>10000 OR
 (SELECT count(*) FROM (SELECT 1 FROM emdo.finance_journal_lines l JOIN emdo.finance_journals j ON j.workspace_id=l.workspace_id AND j.book_id=l.book_id AND j.id=l.journal_id WHERE l.workspace_id=r.workspace_id AND l.book_id=r.book_id AND j.status='posted' LIMIT 100001) x)>100000 THEN
 RAISE EXCEPTION 'report-source-limit-exceeded' USING ERRCODE='54000'; END IF;
 snapshot_time:=clock_timestamp();
 WITH posted AS MATERIALIZED (
 SELECT id,effective_on,source_reference,payload_hash FROM emdo.finance_journals WHERE workspace_id=r.workspace_id AND book_id=r.book_id AND status='posted'
 ), movements AS (
 SELECT l.account_id,sum(CASE WHEN l.side='debit' THEN l.amount ELSE 0 END)::numeric(43,12) AS debit,
 sum(CASE WHEN l.side='credit' THEN l.amount ELSE 0 END)::numeric(43,12) AS credit
 FROM emdo.finance_journal_lines l JOIN posted p ON p.id=l.journal_id
 WHERE l.workspace_id=r.workspace_id AND l.book_id=r.book_id GROUP BY l.account_id
 ), accounts AS (
 SELECT a.id,a.code,a.name,a.kind,coalesce(m.debit,0) AS debit,coalesce(m.credit,0) AS credit FROM emdo.finance_ledger_accounts a LEFT JOIN movements m ON m.account_id=a.id WHERE a.workspace_id=r.workspace_id AND a.book_id=r.book_id
 )
 SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('accountId',id,'code',code,'name',name,'kind',kind,'debit',trim_scale(debit)::text,'credit',trim_scale(credit)::text,'balance',trim_scale(debit-credit)::text) ORDER BY code,id) FROM accounts),'[]'::jsonb),
 coalesce((SELECT jsonb_agg(jsonb_build_object('journalId',id,'effectiveOn',effective_on,'sourceReference',source_reference,'payloadHash',payload_hash) ORDER BY effective_on,id) FROM posted),'[]'::jsonb),
 coalesce((SELECT sum(debit)::numeric(43,12) FROM accounts),0),coalesce((SELECT sum(credit)::numeric(43,12) FROM accounts),0)
 INTO rows_json,sources_json,total_debit,total_credit;
 IF total_debit<>total_credit THEN RAISE EXCEPTION 'report-ledger-unbalanced' USING ERRCODE='23514'; END IF;
 body:=jsonb_build_object('rows',rows_json,'sourceJournals',sources_json,'totalDebit',trim_scale(total_debit)::text,'totalCredit',trim_scale(total_credit)::text);
 IF octet_length(body::text)>8000000 THEN RAISE EXCEPTION 'report-source-limit-exceeded' USING ERRCODE='54000'; END IF;
 IF r.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'report-lease-expired' USING ERRCODE='42501'; END IF;
 INSERT INTO emdo.finance_generated_reports(workspace_id,book_id,automation_run_id,currency,snapshot_at,snapshot)
 VALUES(r.workspace_id,r.book_id,rid,functional_currency,snapshot_time,body) RETURNING id INTO report_id;
 -- Saved snapshot and outcome commit together. Dispatcher settlement uses the
 -- existing same-lease completed replay path, never a second report insertion.
 UPDATE emdo.finance_automation_runs SET status='completed',outcome_reference=report_id,revision=revision+1 WHERE id=rid;
 RETURN report_id;
END $$;
ALTER FUNCTION emdo.generate_finance_trial_balance(uuid,integer,uuid) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.generate_finance_trial_balance(uuid,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.generate_finance_trial_balance(uuid,integer,uuid) TO emdo_worker,emdo_worker_executor;
