-- Normalized Finance planning schema companion.
--
-- Migration 0057 contains this same schema and policy set in the numbered
-- journal. This companion remains useful for applying the planning objects to
-- an isolated synthetic PostgreSQL database while reviewing the repository.

CREATE TABLE emdo.finance_budget_revisions (
  workspace_id uuid NOT NULL,
  book_id uuid NOT NULL,
  budget_id uuid NOT NULL,
  revision integer NOT NULL,
  name text NOT NULL,
  functional_currency text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_budget_revisions_pk PRIMARY KEY (workspace_id, book_id, budget_id, revision),
  CONSTRAINT finance_budget_revisions_book FOREIGN KEY (workspace_id, book_id)
    REFERENCES emdo.finance_books (workspace_id, id),
  CONSTRAINT finance_budget_revisions_created_by FOREIGN KEY (created_by)
    REFERENCES emdo.auth_users (id),
  CONSTRAINT finance_budget_revisions_revision CHECK (revision > 0),
  CONSTRAINT finance_budget_revisions_currency CHECK
    (functional_currency IN ('CAD','USD','MXN','EUR','KRW','JPY'))
);

CREATE INDEX finance_budget_revisions_book
  ON emdo.finance_budget_revisions (workspace_id, book_id, budget_id, revision DESC);

CREATE TABLE emdo.finance_budget_lines (
  workspace_id uuid NOT NULL,
  book_id uuid NOT NULL,
  budget_id uuid NOT NULL,
  revision integer NOT NULL,
  period_id uuid NOT NULL,
  account_id uuid NOT NULL,
  currency text NOT NULL,
  amount numeric(38,12) NOT NULL,
  CONSTRAINT finance_budget_lines_pk PRIMARY KEY
    (workspace_id, book_id, budget_id, revision, period_id, account_id, currency),
  CONSTRAINT finance_budget_lines_revision FOREIGN KEY
    (workspace_id, book_id, budget_id, revision)
    REFERENCES emdo.finance_budget_revisions (workspace_id, book_id, budget_id, revision),
  CONSTRAINT finance_budget_lines_period FOREIGN KEY
    (workspace_id, book_id, period_id)
    REFERENCES emdo.finance_periods (workspace_id, book_id, id),
  CONSTRAINT finance_budget_lines_account FOREIGN KEY
    (workspace_id, book_id, account_id)
    REFERENCES emdo.finance_ledger_accounts (workspace_id, book_id, id),
  CONSTRAINT finance_budget_lines_currency CHECK
    (currency IN ('CAD','USD','MXN','EUR','KRW','JPY')),
  CONSTRAINT finance_budget_lines_amount CHECK
    (amount <> 'NaN'::numeric AND amount = round(amount, CASE WHEN currency IN ('JPY','KRW') THEN 0 ELSE 2 END))
);

CREATE INDEX finance_budget_lines_period_account
  ON emdo.finance_budget_lines (workspace_id, book_id, period_id, account_id);

CREATE TABLE emdo.finance_forecast_snapshots (
  workspace_id uuid NOT NULL,
  book_id uuid NOT NULL,
  forecast_id uuid NOT NULL,
  revision integer NOT NULL,
  budget_id uuid NOT NULL,
  budget_revision integer NOT NULL,
  functional_currency text NOT NULL,
  as_of date NOT NULL,
  opening_status text NOT NULL,
  opening_amount numeric(38,12),
  opening_currency text,
  opening_source_reference text,
  opening_reviewed_by uuid,
  opening_reviewed_at timestamptz,
  future_assumption_status text NOT NULL,
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_forecast_snapshots_pk PRIMARY KEY
    (workspace_id, book_id, forecast_id, revision),
  CONSTRAINT finance_forecast_snapshots_book FOREIGN KEY (workspace_id, book_id)
    REFERENCES emdo.finance_books (workspace_id, id),
  CONSTRAINT finance_forecast_snapshots_budget FOREIGN KEY
    (workspace_id, book_id, budget_id, budget_revision)
    REFERENCES emdo.finance_budget_revisions (workspace_id, book_id, budget_id, revision),
  CONSTRAINT finance_forecast_snapshots_created_by FOREIGN KEY (created_by)
    REFERENCES emdo.auth_users (id),
  CONSTRAINT finance_forecast_snapshots_opening_reviewed_by FOREIGN KEY (opening_reviewed_by)
    REFERENCES emdo.auth_users (id),
  CONSTRAINT finance_forecast_snapshots_revision CHECK (revision > 0 AND budget_revision > 0),
  CONSTRAINT finance_forecast_snapshots_currency CHECK
    (functional_currency IN ('CAD','USD','MXN','EUR','KRW','JPY')),
  CONSTRAINT finance_forecast_snapshots_opening CHECK
    ((opening_status = 'unavailable' AND opening_amount IS NULL AND opening_currency IS NULL
      AND opening_source_reference IS NULL AND opening_reviewed_by IS NULL AND opening_reviewed_at IS NULL)
     OR
     (opening_status = 'available' AND opening_amount IS NOT NULL AND opening_currency IS NOT NULL
      AND opening_source_reference IS NOT NULL AND opening_reviewed_by IS NOT NULL AND opening_reviewed_at IS NOT NULL)),
  CONSTRAINT finance_forecast_snapshots_status CHECK
    (opening_status IN ('available','unavailable')
     AND future_assumption_status IN ('not-applicable','provided','partial','unavailable')
     AND jsonb_typeof(labels) = 'array'
     AND jsonb_array_length(labels) <= 2
     AND labels <@ '["opening-balance-unavailable","future-assumption-unavailable"]'::jsonb)
);

CREATE INDEX finance_forecast_snapshots_book
  ON emdo.finance_forecast_snapshots (workspace_id, book_id, created_at DESC, forecast_id, revision DESC);

CREATE TABLE emdo.finance_forecast_lines (
  workspace_id uuid NOT NULL,
  book_id uuid NOT NULL,
  forecast_id uuid NOT NULL,
  revision integer NOT NULL,
  period_id uuid NOT NULL,
  account_id uuid NOT NULL,
  currency text NOT NULL,
  budget_amount numeric(38,12) NOT NULL,
  posted_actual_amount numeric(38,12) NOT NULL,
  forecast_amount numeric(38,12),
  basis text NOT NULL,
  actual_sign_basis text NOT NULL,
  label text,
  CONSTRAINT finance_forecast_lines_pk PRIMARY KEY
    (workspace_id, book_id, forecast_id, revision, period_id, account_id, currency),
  CONSTRAINT finance_forecast_lines_snapshot FOREIGN KEY
    (workspace_id, book_id, forecast_id, revision)
    REFERENCES emdo.finance_forecast_snapshots (workspace_id, book_id, forecast_id, revision),
  CONSTRAINT finance_forecast_lines_period FOREIGN KEY
    (workspace_id, book_id, period_id)
    REFERENCES emdo.finance_periods (workspace_id, book_id, id),
  CONSTRAINT finance_forecast_lines_account FOREIGN KEY
    (workspace_id, book_id, account_id)
    REFERENCES emdo.finance_ledger_accounts (workspace_id, book_id, id),
  CONSTRAINT finance_forecast_lines_currency CHECK
    (currency IN ('CAD','USD','MXN','EUR','KRW','JPY')),
  CONSTRAINT finance_forecast_lines_amount CHECK
    (budget_amount <> 'NaN'::numeric AND posted_actual_amount <> 'NaN'::numeric
     AND (forecast_amount IS NULL OR forecast_amount <> 'NaN'::numeric)),
  CONSTRAINT finance_forecast_lines_basis CHECK
    (basis IN ('posted-actual','reviewed-assumption','unavailable')
     AND ((basis = 'unavailable' AND forecast_amount IS NULL AND label = 'future-assumption-unavailable')
       OR (basis <> 'unavailable' AND forecast_amount IS NOT NULL AND label IS NULL))),
  CONSTRAINT finance_forecast_lines_sign_basis CHECK
    (actual_sign_basis IN ('debit-minus-credit','credit-minus-debit'))
);

CREATE TABLE emdo.finance_forecast_assumptions (
  workspace_id uuid NOT NULL,
  book_id uuid NOT NULL,
  forecast_id uuid NOT NULL,
  revision integer NOT NULL,
  period_id uuid NOT NULL,
  account_id uuid NOT NULL,
  currency text NOT NULL,
  amount numeric(38,12) NOT NULL,
  label text NOT NULL,
  source_reference text NOT NULL,
  reviewed_by uuid NOT NULL,
  reviewed_at timestamptz NOT NULL,
  CONSTRAINT finance_forecast_assumptions_pk PRIMARY KEY
    (workspace_id, book_id, forecast_id, revision, period_id, account_id, currency),
  CONSTRAINT finance_forecast_assumptions_snapshot FOREIGN KEY
    (workspace_id, book_id, forecast_id, revision)
    REFERENCES emdo.finance_forecast_snapshots (workspace_id, book_id, forecast_id, revision),
  CONSTRAINT finance_forecast_assumptions_period FOREIGN KEY
    (workspace_id, book_id, period_id)
    REFERENCES emdo.finance_periods (workspace_id, book_id, id),
  CONSTRAINT finance_forecast_assumptions_account FOREIGN KEY
    (workspace_id, book_id, account_id)
    REFERENCES emdo.finance_ledger_accounts (workspace_id, book_id, id),
  CONSTRAINT finance_forecast_assumptions_created_by FOREIGN KEY (reviewed_by)
    REFERENCES emdo.auth_users (id),
  CONSTRAINT finance_forecast_assumptions_currency CHECK
    (currency IN ('CAD','USD','MXN','EUR','KRW','JPY')),
  CONSTRAINT finance_forecast_assumptions_amount CHECK
    (amount <> 'NaN'::numeric AND amount = round(amount, CASE WHEN currency IN ('JPY','KRW') THEN 0 ELSE 2 END))
);

CREATE INDEX finance_forecast_assumptions_source
  ON emdo.finance_forecast_assumptions (workspace_id, book_id, forecast_id, revision);

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
    EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow', table_name);
    EXECUTE format('GRANT SELECT,INSERT ON emdo.%I TO emdo_app', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON emdo.%I FOR SELECT TO emdo_app USING (emdo.finance_book_access(workspace_id,book_id))',
      table_name || '_read', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON emdo.%I FOR INSERT TO emdo_app WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY[''administrator'',''preparer'',''approver'']))',
      table_name || '_insert', table_name
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION emdo.enforce_finance_planning_book_currency()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog SET row_security = on AS $$
DECLARE functional_currency text;
BEGIN
  SELECT b.functional_currency INTO functional_currency
    FROM emdo.finance_books b
   WHERE b.workspace_id = NEW.workspace_id AND b.id = NEW.book_id;
  IF functional_currency IS NULL THEN
    RAISE EXCEPTION 'finance-planning-book-forbidden' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME IN ('finance_budget_revisions','finance_forecast_snapshots')
     AND NEW.functional_currency IS DISTINCT FROM functional_currency THEN
    RAISE EXCEPTION 'finance-planning-currency-mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME IN ('finance_budget_lines','finance_forecast_lines','finance_forecast_assumptions')
     AND NEW.currency IS DISTINCT FROM functional_currency THEN
    RAISE EXCEPTION 'finance-planning-currency-mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME = 'finance_forecast_snapshots'
     AND NEW.opening_status = 'available'
     AND NEW.opening_currency IS DISTINCT FROM functional_currency THEN
    RAISE EXCEPTION 'finance-planning-opening-currency-mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME = 'finance_forecast_assumptions'
     AND NEW.reviewed_by IS DISTINCT FROM emdo.current_user_id() THEN
    RAISE EXCEPTION 'finance-planning-reviewer-mismatch' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION emdo.enforce_finance_planning_book_currency() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.enforce_finance_planning_book_currency() FROM PUBLIC;

CREATE TRIGGER finance_budget_revisions_scope
  BEFORE INSERT ON emdo.finance_budget_revisions
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_planning_book_currency();
CREATE TRIGGER finance_budget_lines_scope
  BEFORE INSERT ON emdo.finance_budget_lines
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_planning_book_currency();
CREATE TRIGGER finance_forecast_snapshots_scope
  BEFORE INSERT ON emdo.finance_forecast_snapshots
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_planning_book_currency();
CREATE TRIGGER finance_forecast_lines_scope
  BEFORE INSERT ON emdo.finance_forecast_lines
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_planning_book_currency();
CREATE TRIGGER finance_forecast_assumptions_scope
  BEFORE INSERT ON emdo.finance_forecast_assumptions
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_planning_book_currency();

CREATE OR REPLACE FUNCTION emdo.reject_finance_planning_history_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'finance-planning-history-immutable' USING ERRCODE='23514';
END $$;
ALTER FUNCTION emdo.reject_finance_planning_history_mutation() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.reject_finance_planning_history_mutation() FROM PUBLIC;

CREATE TRIGGER finance_budget_revisions_immutable
  BEFORE UPDATE OR DELETE ON emdo.finance_budget_revisions
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_planning_history_mutation();
CREATE TRIGGER finance_budget_lines_immutable
  BEFORE UPDATE OR DELETE ON emdo.finance_budget_lines
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_planning_history_mutation();
CREATE TRIGGER finance_forecast_snapshots_immutable
  BEFORE UPDATE OR DELETE ON emdo.finance_forecast_snapshots
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_planning_history_mutation();
CREATE TRIGGER finance_forecast_lines_immutable
  BEFORE UPDATE OR DELETE ON emdo.finance_forecast_lines
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_planning_history_mutation();
CREATE TRIGGER finance_forecast_assumptions_immutable
  BEFORE UPDATE OR DELETE ON emdo.finance_forecast_assumptions
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_planning_history_mutation();
