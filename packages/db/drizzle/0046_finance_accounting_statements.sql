-- Accounting statement reports and versioned ledger classifications.
-- Migration 0046 extends the existing immutable trial-balance snapshots while
-- preserving their legacy canonical intent hash and reader shape.

ALTER TABLE emdo.finance_generated_reports
  ADD COLUMN period_id uuid,
  ADD COLUMN period_start date,
  ADD COLUMN period_end date,
  ADD COLUMN as_of date;
--> statement-breakpoint
ALTER TABLE emdo.finance_generated_reports
  DROP CONSTRAINT generated_report_version;
--> statement-breakpoint
ALTER TABLE emdo.finance_generated_reports
  ADD CONSTRAINT generated_report_period_scope
  FOREIGN KEY (workspace_id,book_id,period_id)
  REFERENCES emdo.finance_periods(workspace_id,book_id,id);
--> statement-breakpoint
ALTER TABLE emdo.finance_generated_reports
  ADD CONSTRAINT generated_report_version CHECK (
    report_version=1 AND (
      (kind='posted-ledger-trial-balance'
       AND coverage='all-posted-journals-at-snapshot'
       AND period_id IS NULL AND period_start IS NULL
       AND period_end IS NULL AND as_of IS NULL)
      OR
      (kind='income-statement'
       AND coverage='period-posted-journals-at-snapshot'
       AND period_id IS NOT NULL AND period_start IS NOT NULL
       AND period_end IS NOT NULL AND as_of IS NULL)
      OR
      (kind='balance-sheet'
       AND coverage='posted-journals-through-as-of'
       AND period_id IS NULL AND period_start IS NULL
       AND period_end IS NULL AND as_of IS NOT NULL)
    )
  );
--> statement-breakpoint

CREATE TABLE emdo.finance_ledger_account_classifications (
  workspace_id uuid NOT NULL,
  book_id uuid NOT NULL,
  account_id uuid NOT NULL,
  revision integer NOT NULL,
  statement text NOT NULL,
  section text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_ledger_account_classifications_pk
    PRIMARY KEY (workspace_id,book_id,account_id,revision),
  CONSTRAINT finance_ledger_account_classification_book
    FOREIGN KEY (workspace_id,book_id)
    REFERENCES emdo.finance_books(workspace_id,id),
  CONSTRAINT finance_ledger_account_classification_account
    FOREIGN KEY (workspace_id,book_id,account_id)
    REFERENCES emdo.finance_ledger_accounts(workspace_id,book_id,id),
  CONSTRAINT finance_ledger_account_classification_creator
    FOREIGN KEY (created_by)
    REFERENCES emdo.auth_users(id),
  CONSTRAINT finance_ledger_account_classification_statement
    CHECK (statement IN ('balance-sheet','income-statement')),
  CONSTRAINT finance_ledger_account_classification_section
    CHECK (section ~ '^[a-z0-9]+([_-][a-z0-9]+)*$'
      AND length(section) BETWEEN 1 AND 80),
  CONSTRAINT finance_ledger_account_classification_revision
    CHECK (revision>0 AND display_order BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE INDEX finance_ledger_account_classifications_current
  ON emdo.finance_ledger_account_classifications
  (workspace_id,book_id,account_id,revision);
--> statement-breakpoint
ALTER TABLE emdo.finance_ledger_account_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_ledger_account_classifications FORCE ROW LEVEL SECURITY;
REVOKE ALL ON emdo.finance_ledger_account_classifications
  FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow;
GRANT SELECT,INSERT ON emdo.finance_ledger_account_classifications
  TO emdo_finance_automation_executor;
GRANT SELECT ON emdo.finance_ledger_account_classifications TO emdo_app;
CREATE POLICY finance_ledger_account_classification_executor
  ON emdo.finance_ledger_account_classifications
  FOR ALL TO emdo_finance_automation_executor
  USING (true) WITH CHECK (true);
CREATE POLICY finance_ledger_account_classification_read
  ON emdo.finance_ledger_account_classifications
  FOR SELECT TO emdo_app
  USING (emdo.finance_book_access(workspace_id,book_id));
--> statement-breakpoint
CREATE FUNCTION emdo.reject_finance_ledger_account_classification_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'finance-ledger-account-classification-immutable'
    USING ERRCODE='23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER immutable_finance_ledger_account_classification
  BEFORE UPDATE OR DELETE ON emdo.finance_ledger_account_classifications
  FOR EACH ROW
  EXECUTE FUNCTION emdo.reject_finance_ledger_account_classification_mutation();
--> statement-breakpoint

CREATE FUNCTION emdo.set_finance_ledger_account_classification(
  w uuid,b uuid,a uuid,s text,section_name text,display integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET row_security=on AS $$
DECLARE
  account_kind text;
  next_revision integer;
  result jsonb;
BEGIN
  IF NOT emdo.finance_book_access(w,b,ARRAY['administrator','preparer','approver'])
    THEN RAISE EXCEPTION 'finance-classification-authority-revoked'
      USING ERRCODE='42501';
  END IF;
  IF s NOT IN ('balance-sheet','income-statement')
    OR section_name IS NULL
    OR section_name !~ '^[a-z0-9]+([_-][a-z0-9]+)*$'
    OR length(section_name) NOT BETWEEN 1 AND 80
    OR display IS NULL OR display NOT BETWEEN 0 AND 10000
    THEN RAISE EXCEPTION 'finance-classification-invalid'
      USING ERRCODE='22023';
  END IF;
  SELECT kind INTO account_kind
    FROM emdo.finance_ledger_accounts
   WHERE workspace_id=w AND book_id=b AND id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'finance-account-not-found'
    USING ERRCODE='22023'; END IF;
  IF (s='income-statement' AND account_kind NOT IN ('income','expense'))
     OR (s='balance-sheet' AND account_kind NOT IN ('asset','liability','equity'))
    THEN RAISE EXCEPTION 'finance-classification-kind-mismatch'
      USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||b::text,0));
  SELECT to_jsonb(c) INTO result
    FROM emdo.finance_ledger_account_classifications c
   WHERE c.workspace_id=w AND c.book_id=b AND c.account_id=a
   ORDER BY c.revision DESC LIMIT 1;
  IF result IS NOT NULL
     AND result->>'statement'=s
     AND result->>'section'=section_name
     AND (result->>'display_order')::integer=display
    THEN RETURN result; END IF;
  SELECT coalesce(max(revision),0)+1 INTO next_revision
    FROM emdo.finance_ledger_account_classifications
   WHERE workspace_id=w AND book_id=b AND account_id=a;
  INSERT INTO emdo.finance_ledger_account_classifications(
    workspace_id,book_id,account_id,revision,statement,section,
    display_order,created_by
  ) VALUES (w,b,a,next_revision,s,section_name,display,emdo.current_user_id());
  SELECT to_jsonb(c) INTO result
    FROM emdo.finance_ledger_account_classifications c
   WHERE c.workspace_id=w AND c.book_id=b AND c.account_id=a
     AND c.revision=next_revision;
  RETURN result;
END $$;
--> statement-breakpoint
CREATE FUNCTION emdo.read_finance_ledger_account_classifications(w uuid,b uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
  IF NOT emdo.finance_book_access(w,b)
    THEN RAISE EXCEPTION 'finance-book-forbidden' USING ERRCODE='42501'; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(to_jsonb(c) ORDER BY c.account_id,c.revision)
      FROM emdo.finance_ledger_account_classifications c
     WHERE c.workspace_id=w AND c.book_id=b
  ),'[]'::jsonb);
END $$;
--> statement-breakpoint
ALTER FUNCTION emdo.reject_finance_ledger_account_classification_mutation()
  OWNER TO emdo_finance_automation_executor;
ALTER FUNCTION emdo.set_finance_ledger_account_classification(uuid,uuid,uuid,text,text,integer)
  OWNER TO emdo_finance_automation_executor;
ALTER FUNCTION emdo.read_finance_ledger_account_classifications(uuid,uuid)
  OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION
  emdo.reject_finance_ledger_account_classification_mutation(),
  emdo.set_finance_ledger_account_classification(uuid,uuid,uuid,text,text,integer),
  emdo.read_finance_ledger_account_classifications(uuid,uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  emdo.set_finance_ledger_account_classification(uuid,uuid,uuid,text,text,integer),
  emdo.read_finance_ledger_account_classifications(uuid,uuid) TO emdo_app;
--> statement-breakpoint

-- The eight-argument function remains the legacy trial-balance enqueue
-- contract. Statement selections use the nine-argument overload.
CREATE OR REPLACE FUNCTION emdo.enqueue_finance_automation_run(
  w uuid,b uuid,gid uuid,rid uuid,cap text,targets jsonb,curr text,amt text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
  RETURN emdo.enqueue_finance_automation_run(
    w,b,gid,rid,cap,targets,curr,amt,
    jsonb_build_object('kind','posted-ledger-trial-balance')
  );
END $$;
--> statement-breakpoint
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
ALTER FUNCTION emdo.enqueue_finance_automation_run(
  uuid,uuid,uuid,uuid,text,jsonb,text,text
) OWNER TO emdo_finance_automation_executor;
ALTER FUNCTION emdo.enqueue_finance_automation_run(
  uuid,uuid,uuid,uuid,text,jsonb,text,text,jsonb
) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.enqueue_finance_automation_run(
  uuid,uuid,uuid,uuid,text,jsonb,text,text
), emdo.enqueue_finance_automation_run(
  uuid,uuid,uuid,uuid,text,jsonb,text,text,jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.enqueue_finance_automation_run(
  uuid,uuid,uuid,uuid,text,jsonb,text,text
), emdo.enqueue_finance_automation_run(
  uuid,uuid,uuid,uuid,text,jsonb,text,text,jsonb
) TO emdo_app;
--> statement-breakpoint

-- Blocked input is a durable, user-visible terminal outcome. The original
-- five-argument settlement remains callable by existing workers.
CREATE OR REPLACE FUNCTION emdo.settle_finance_automation_run(
  rid uuid,expected_revision integer,token uuid,result text,outcome uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
  RETURN emdo.settle_finance_automation_run(
    rid,expected_revision,token,result,outcome,NULL
  );
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.settle_finance_automation_run(
  rid uuid,expected_revision integer,token uuid,result text,outcome uuid,
  p_blocked_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_automation_runs;
BEGIN
  SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'automation-run-not-found'; END IF;
  IF result NOT IN ('applied','not-applied','indeterminate','blocked')
     OR (result='applied')<>(outcome IS NOT NULL)
     OR (result='blocked')<>(p_blocked_reason IS NOT NULL)
    THEN RAISE EXCEPTION 'automation-invalid-outcome'; END IF;
  IF r.status='completed' AND result='applied'
     AND r.outcome_reference=outcome AND r.lease_token=token
     AND r.revision=expected_revision+1
    THEN RETURN (to_jsonb(r)||jsonb_build_object('amount',r.amount::text)); END IF;
  IF r.status<>'executing' OR r.revision<>expected_revision
     OR r.lease_token IS DISTINCT FROM token
    THEN RAISE EXCEPTION 'automation-lease-conflict'; END IF;
  IF r.lease_expires_at<=clock_timestamp() THEN
    UPDATE emdo.finance_automation_runs
       SET status='requires-reconciliation',revision=revision+1,
           blocked_reason='lease-expired'
     WHERE id=rid RETURNING * INTO r;
    RETURN (to_jsonb(r)||jsonb_build_object('amount',r.amount::text));
  END IF;
  UPDATE emdo.finance_automation_runs
     SET status=CASE result
       WHEN 'applied' THEN 'completed'
       WHEN 'not-applied' THEN 'retryable'
       WHEN 'blocked' THEN 'blocked'
       ELSE 'requires-reconciliation' END,
       outcome_reference=outcome,
       blocked_reason=CASE WHEN result='blocked' THEN p_blocked_reason ELSE NULL END,
       revision=revision+1
   WHERE id=rid RETURNING * INTO r;
  RETURN (to_jsonb(r)||jsonb_build_object('amount',r.amount::text));
END $$;
--> statement-breakpoint
ALTER FUNCTION emdo.settle_finance_automation_run(
  uuid,integer,uuid,text,uuid
) OWNER TO emdo_finance_automation_executor;
ALTER FUNCTION emdo.settle_finance_automation_run(
  uuid,integer,uuid,text,uuid,text
) OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.settle_finance_automation_run(
  uuid,integer,uuid,text,uuid
),emdo.settle_finance_automation_run(
  uuid,integer,uuid,text,uuid,text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.settle_finance_automation_run(
  uuid,integer,uuid,text,uuid,text
) TO emdo_worker,emdo_worker_executor;
--> statement-breakpoint

-- Deterministic income statement and balance sheet generation. Trial balance
-- remains on generate_finance_trial_balance for its compatibility contract.
CREATE FUNCTION emdo.generate_finance_accounting_report(
  rid uuid,expected_revision integer,token uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET row_security=on AS $$
DECLARE
  r emdo.finance_automation_runs;
  g emdo.finance_automation_grants;
  reason text;
  report_id uuid;
  functional_currency text;
  report_kind text;
  period_id uuid;
  period_start date;
  period_end date;
  as_of date;
  fiscal_start date;
  snapshot_time timestamptz;
  rows_json jsonb;
  sources_json jsonb;
  total_debit numeric;
  total_credit numeric;
  source_debit numeric;
  source_credit numeric;
  statement_debit numeric;
  statement_credit numeric;
  assets numeric;
  liabilities numeric;
  equity numeric;
  earnings numeric;
  difference numeric;
  body jsonb;
  selection jsonb;
BEGIN
  IF token IS NULL OR expected_revision IS NULL OR expected_revision<1
    THEN RAISE EXCEPTION 'report-invalid-lease' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid;
  IF NOT FOUND THEN RAISE EXCEPTION 'report-run-unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM emdo.finance_automation_authority_epochs
    WHERE workspace_id=r.workspace_id FOR UPDATE;
  SELECT * INTO g FROM emdo.finance_automation_grants WHERE id=r.grant_id FOR UPDATE;
  SELECT * INTO r FROM emdo.finance_automation_runs WHERE id=rid FOR UPDATE;
  reason:=emdo.finance_automation_denial(g,r.capability);
  IF reason IS NOT NULL OR r.grant_revision<>g.revision
    THEN RAISE EXCEPTION 'report-authority-revoked' USING ERRCODE='42501'; END IF;
  IF r.capability<>'finance.reports.generate'
     OR r.item_count<>1
     OR r.intent->'targets' IS DISTINCT FROM jsonb_build_array(r.book_id::text)
     OR r.amount<>0
    THEN RAISE EXCEPTION 'report-unsupported-intent' USING ERRCODE='22023'; END IF;

  selection:=r.intent->'report';
  IF selection IS NULL OR jsonb_typeof(selection)<>'object'
    THEN RAISE EXCEPTION 'report-selection-missing' USING ERRCODE='22023'; END IF;
  report_kind:=selection->>'kind';
  IF report_kind='income-statement' THEN
    IF NOT emdo.jsonb_object_has_exact_keys(selection,ARRAY['kind','periodId'])
      THEN RAISE EXCEPTION 'report-selection-invalid' USING ERRCODE='22023'; END IF;
    period_id:=(selection->>'periodId')::uuid;
    SELECT p.starts_on,p.ends_on INTO period_start,period_end
      FROM emdo.finance_periods p
     WHERE p.workspace_id=r.workspace_id AND p.book_id=r.book_id
       AND p.id=period_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'report-period-unavailable'
      USING ERRCODE='22023'; END IF;
  ELSIF report_kind='balance-sheet' THEN
    IF NOT emdo.jsonb_object_has_exact_keys(selection,ARRAY['kind','asOf'])
      THEN RAISE EXCEPTION 'report-selection-invalid' USING ERRCODE='22023'; END IF;
    as_of:=(selection->>'asOf')::date;
    SELECT make_date(
      CASE WHEN extract(month FROM as_of)>=b.fiscal_year_start_month
           THEN extract(year FROM as_of)::integer
           ELSE extract(year FROM as_of)::integer-1 END,
      b.fiscal_year_start_month,1
    ) INTO fiscal_start
      FROM emdo.finance_books b
     WHERE b.workspace_id=r.workspace_id AND b.id=r.book_id;
    IF fiscal_start IS NULL THEN RAISE EXCEPTION 'report-book-unavailable'
      USING ERRCODE='22023'; END IF;
  ELSE
    RAISE EXCEPTION 'report-selection-invalid' USING ERRCODE='22023';
  END IF;

  SELECT id INTO report_id
    FROM emdo.finance_generated_reports
   WHERE automation_run_id=rid
     AND workspace_id=r.workspace_id AND book_id=r.book_id;
  IF FOUND AND r.status='completed'
     AND r.outcome_reference=report_id
     AND r.lease_token=token
     AND r.revision=expected_revision+1
    THEN RETURN report_id; END IF;
  IF r.status<>'executing' OR r.revision<>expected_revision
     OR r.lease_token IS DISTINCT FROM token
     OR r.lease_expires_at<=clock_timestamp()
    THEN RAISE EXCEPTION 'report-lease-conflict' USING ERRCODE='42501'; END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(r.workspace_id::text||':'||r.book_id::text,0)
  );
  SELECT b.functional_currency INTO functional_currency
    FROM emdo.finance_books b
   WHERE b.workspace_id=r.workspace_id AND b.id=r.book_id;
  IF functional_currency IS NULL OR functional_currency<>r.currency
    THEN RAISE EXCEPTION 'report-currency-mismatch' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM (
        SELECT 1 FROM emdo.finance_journals
         WHERE workspace_id=r.workspace_id AND book_id=r.book_id
           AND status='posted'
           AND (report_kind='balance-sheet' AND effective_on<=as_of
             OR report_kind='income-statement'
               AND effective_on BETWEEN period_start AND period_end)
         LIMIT 10001
      ) j)>10000
     OR (SELECT count(*) FROM (
        SELECT 1 FROM emdo.finance_ledger_accounts
         WHERE workspace_id=r.workspace_id AND book_id=r.book_id
         LIMIT 10001
      ) a)>10000
     OR (SELECT count(*) FROM (
        SELECT 1
          FROM emdo.finance_journal_lines l
          JOIN emdo.finance_journals j
            ON j.workspace_id=l.workspace_id AND j.book_id=l.book_id
           AND j.id=l.journal_id AND j.status='posted'
         WHERE l.workspace_id=r.workspace_id AND l.book_id=r.book_id
           AND (report_kind='balance-sheet' AND j.effective_on<=as_of
             OR report_kind='income-statement'
               AND j.effective_on BETWEEN period_start AND period_end)
         LIMIT 100001
      ) l)>100000
    THEN RAISE EXCEPTION 'report-source-limit-exceeded' USING ERRCODE='54000';
  END IF;

  -- A statement cannot silently omit an unclassified natural account. The
  -- latest immutable revision is the only classification used for this run.
  IF EXISTS (
    WITH latest AS (
      SELECT DISTINCT ON (account_id) account_id,statement
        FROM emdo.finance_ledger_account_classifications
       WHERE workspace_id=r.workspace_id AND book_id=r.book_id
       ORDER BY account_id,revision DESC
    )
    SELECT 1
      FROM emdo.finance_ledger_accounts a
      LEFT JOIN latest c ON c.account_id=a.id
     WHERE a.workspace_id=r.workspace_id AND a.book_id=r.book_id
       AND (
         (a.kind IN ('income','expense')
          AND c.statement IS DISTINCT FROM 'income-statement')
         OR
         (a.kind IN ('asset','liability','equity')
          AND c.statement IS DISTINCT FROM 'balance-sheet')
       )
  ) THEN RAISE EXCEPTION 'report-missing-account-classification'
    USING ERRCODE='23514';
  END IF;

  snapshot_time:=clock_timestamp();
  WITH selected_journals AS MATERIALIZED (
    SELECT j.id,j.effective_on,j.source_reference,j.payload_hash
      FROM emdo.finance_journals j
     WHERE j.workspace_id=r.workspace_id AND j.book_id=r.book_id
       AND j.status='posted'
       AND (
         (report_kind='balance-sheet' AND j.effective_on<=as_of)
         OR
         (report_kind='income-statement'
          AND j.effective_on BETWEEN period_start AND period_end)
       )
  ), selected_lines AS MATERIALIZED (
    SELECT l.account_id,l.side,l.amount,l.journal_id
      FROM emdo.finance_journal_lines l
      JOIN selected_journals j
        ON j.id=l.journal_id
       AND l.workspace_id=r.workspace_id AND l.book_id=r.book_id
  ), latest AS (
    SELECT DISTINCT ON (account_id)
      account_id,revision,statement,section,display_order
      FROM emdo.finance_ledger_account_classifications
     WHERE workspace_id=r.workspace_id AND book_id=r.book_id
     ORDER BY account_id,revision DESC
  ), movements AS (
    SELECT account_id,
      coalesce(sum(amount) FILTER (WHERE side='debit'),0) AS debit,
      coalesce(sum(amount) FILTER (WHERE side='credit'),0) AS credit
      FROM selected_lines GROUP BY account_id
  ), statement_accounts AS (
    SELECT a.id,a.code,a.name,a.kind,c.revision,c.statement,c.section,c.display_order,
      CASE
        WHEN report_kind='balance-sheet'
          THEN greatest(coalesce(m.debit,0)-coalesce(m.credit,0),0)
        ELSE coalesce(m.debit,0)
      END AS debit,
      CASE
        WHEN report_kind='balance-sheet'
          THEN greatest(coalesce(m.credit,0)-coalesce(m.debit,0),0)
        ELSE coalesce(m.credit,0)
      END AS credit
      FROM emdo.finance_ledger_accounts a
      JOIN latest c ON c.account_id=a.id
      LEFT JOIN movements m ON m.account_id=a.id
     WHERE a.workspace_id=r.workspace_id AND a.book_id=r.book_id
       AND (
         (report_kind='income-statement' AND c.statement='income-statement'
          AND a.kind IN ('income','expense'))
         OR
         (report_kind='balance-sheet' AND c.statement='balance-sheet'
          AND a.kind IN ('asset','liability','equity'))
       )
  ), source_totals AS (
    SELECT coalesce(sum(amount) FILTER (WHERE side='debit'),0) AS debit,
      coalesce(sum(amount) FILTER (WHERE side='credit'),0) AS credit
      FROM selected_lines
  ), statement_totals AS (
    SELECT coalesce(sum(debit),0) AS debit,coalesce(sum(credit),0) AS credit
      FROM statement_accounts
  ), years AS (
    SELECT coalesce(sum(
      CASE WHEN a.kind='income' THEN
        CASE WHEN l.side='credit' THEN l.amount ELSE -l.amount END
      WHEN a.kind='expense' THEN
        CASE WHEN l.side='credit' THEN l.amount ELSE -l.amount END
      ELSE 0 END
    ),0) AS earnings
      FROM emdo.finance_journal_lines l
      JOIN emdo.finance_journals j
        ON j.workspace_id=l.workspace_id AND j.book_id=l.book_id
       AND j.id=l.journal_id AND j.status='posted'
      JOIN emdo.finance_ledger_accounts a
        ON a.workspace_id=l.workspace_id AND a.book_id=l.book_id
       AND a.id=l.account_id
     WHERE report_kind='balance-sheet'
       AND l.workspace_id=r.workspace_id AND l.book_id=r.book_id
       AND j.effective_on BETWEEN fiscal_start AND as_of
  )
  SELECT
    coalesce((SELECT jsonb_agg(jsonb_build_object(
      'accountId',id,'code',code,'name',name,'kind',kind,
      'debit',trim_scale(debit)::text,'credit',trim_scale(credit)::text,
      'balance',trim_scale(CASE
        WHEN report_kind='balance-sheet' AND kind IN ('liability','equity')
          THEN credit-debit
        ELSE debit-credit END)::text,
      'balanceBasis',CASE
        WHEN report_kind='balance-sheet' AND kind IN ('liability','equity')
          THEN 'credit-minus-debit'
        ELSE 'debit-minus-credit' END,
      'classification',jsonb_build_object(
        'statement',statement,'section',section,'revision',revision,
        'displayOrder',display_order
      )
    ) ORDER BY section,display_order,code,id) FROM statement_accounts),'[]'::jsonb),
    coalesce((SELECT jsonb_agg(jsonb_build_object(
      'journalId',id,'effectiveOn',effective_on,
      'sourceReference',source_reference,'payloadHash',payload_hash
    ) ORDER BY effective_on,id) FROM selected_journals),'[]'::jsonb),
    (SELECT debit FROM source_totals),(SELECT credit FROM source_totals),
    (SELECT debit FROM statement_totals),(SELECT credit FROM statement_totals),
    coalesce((SELECT years.earnings FROM years),0),
    coalesce((SELECT sum(debit-credit) FILTER (WHERE kind='asset')
      FROM statement_accounts),0),
    coalesce((SELECT sum(credit-debit) FILTER (WHERE kind='liability')
      FROM statement_accounts),0),
    coalesce((SELECT sum(credit-debit) FILTER (WHERE kind='equity')
      FROM statement_accounts),0)
    INTO rows_json,sources_json,source_debit,source_credit,
      statement_debit,statement_credit,earnings,assets,liabilities,equity;

  source_debit:=coalesce(source_debit,0);
  source_credit:=coalesce(source_credit,0);
  statement_debit:=coalesce(statement_debit,0);
  statement_credit:=coalesce(statement_credit,0);
  earnings:=coalesce(earnings,0);
  assets:=coalesce(assets,0);
  liabilities:=coalesce(liabilities,0);
  equity:=coalesce(equity,0);
  IF source_debit<>source_credit
    THEN RAISE EXCEPTION 'report-ledger-unbalanced' USING ERRCODE='23514'; END IF;
  difference:=assets-liabilities-equity-earnings;

  body:=jsonb_build_object(
    'rows',rows_json,
    'sourceJournals',sources_json,
    'totalDebit',trim_scale(statement_debit)::text,
    'totalCredit',trim_scale(statement_credit)::text,
    'reconciliation',jsonb_build_object(
      'trialBalanceTotalDebit',trim_scale(source_debit)::text,
      'trialBalanceTotalCredit',trim_scale(source_credit)::text,
      'sourceTotalDebit',trim_scale(source_debit)::text,
      'sourceTotalCredit',trim_scale(source_credit)::text,
      'statementTotalDebit',trim_scale(statement_debit)::text,
      'statementTotalCredit',trim_scale(statement_credit)::text,
      'balanceSheetAssets',CASE WHEN report_kind='balance-sheet'
        THEN trim_scale(assets)::text ELSE NULL END,
      'balanceSheetLiabilities',CASE WHEN report_kind='balance-sheet'
        THEN trim_scale(liabilities)::text ELSE NULL END,
      'balanceSheetEquity',CASE WHEN report_kind='balance-sheet'
        THEN trim_scale(equity)::text ELSE NULL END,
      'currentYearEarnings',CASE WHEN report_kind='balance-sheet'
        THEN trim_scale(earnings)::text ELSE NULL END,
      'difference',trim_scale(CASE WHEN report_kind='balance-sheet'
        THEN difference ELSE 0 END)::text,
      'balanced',CASE WHEN report_kind='balance-sheet'
        THEN difference=0 ELSE true END
    )
  );
  IF octet_length(body::text)>8000000
    THEN RAISE EXCEPTION 'report-source-limit-exceeded' USING ERRCODE='54000'; END IF;
  IF r.lease_expires_at<=clock_timestamp()
    THEN RAISE EXCEPTION 'report-lease-expired' USING ERRCODE='42501'; END IF;
  INSERT INTO emdo.finance_generated_reports(
    workspace_id,book_id,automation_run_id,report_version,kind,coverage,
    currency,period_id,period_start,period_end,as_of,snapshot_at,snapshot
  ) VALUES (
    r.workspace_id,r.book_id,rid,1,report_kind,
    CASE WHEN report_kind='income-statement'
      THEN 'period-posted-journals-at-snapshot'
      ELSE 'posted-journals-through-as-of' END,
    functional_currency,
    CASE WHEN report_kind='income-statement' THEN period_id ELSE NULL END,
    CASE WHEN report_kind='income-statement' THEN period_start ELSE NULL END,
    CASE WHEN report_kind='income-statement' THEN period_end ELSE NULL END,
    CASE WHEN report_kind='balance-sheet' THEN as_of ELSE NULL END,
    snapshot_time,body
  ) RETURNING id INTO report_id;
  UPDATE emdo.finance_automation_runs
     SET status='completed',outcome_reference=report_id,revision=revision+1
   WHERE id=rid;
  RETURN report_id;
END $$;
--> statement-breakpoint
ALTER FUNCTION emdo.generate_finance_accounting_report(uuid,integer,uuid)
  OWNER TO emdo_finance_automation_executor;
REVOKE ALL ON FUNCTION emdo.generate_finance_accounting_report(uuid,integer,uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.generate_finance_accounting_report(uuid,integer,uuid)
  TO emdo_worker_executor;
--> statement-breakpoint
GRANT SELECT ON emdo.finance_periods,emdo.finance_books,
  emdo.finance_ledger_account_classifications TO emdo_finance_automation_executor;
CREATE POLICY generated_report_period_source
  ON emdo.finance_periods FOR SELECT
  TO emdo_finance_automation_executor USING (true);
CREATE POLICY generated_report_book_source
  ON emdo.finance_books FOR SELECT
  TO emdo_finance_automation_executor USING (true);
