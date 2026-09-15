-- Investment evidence is append-only and uses the same explicit book authority.
DO $$ DECLARE t text; approved boolean; BEGIN
  FOREACH t IN ARRAY ARRAY['finance_instruments','finance_instrument_identifiers','finance_investment_openings','finance_investment_movements','finance_observed_positions','finance_investment_prices','finance_fx_observations'] LOOP
    EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow',t);
    EXECUTE format('GRANT SELECT,INSERT ON emdo.%I TO emdo_app',t);
    EXECUTE format('CREATE POLICY %I ON emdo.%I FOR SELECT TO emdo_app USING (emdo.finance_book_access(workspace_id,book_id))',t||'_read',t);
    approved:=t IN ('finance_investment_openings','finance_investment_movements');
    EXECUTE format('CREATE POLICY %I ON emdo.%I FOR INSERT TO emdo_app WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY[%s]))',t||'_insert',t,CASE WHEN approved THEN '''administrator'',''approver''' ELSE '''administrator'',''preparer'',''approver''' END);
    EXECUTE format('CREATE TRIGGER a_lock_book BEFORE INSERT ON emdo.%I FOR EACH ROW EXECUTE FUNCTION emdo.lock_finance_book_mutation()',t);
  END LOOP;
END $$;
CREATE FUNCTION emdo.check_investment_account() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM emdo.finance_financial_accounts WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.financial_account_id AND active AND kind='brokerage') THEN
    RAISE EXCEPTION 'investment positions require an active brokerage account' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_investment_account BEFORE INSERT ON emdo.finance_investment_openings FOR EACH ROW EXECUTE FUNCTION emdo.check_investment_account();
CREATE TRIGGER check_investment_account BEFORE INSERT ON emdo.finance_investment_movements FOR EACH ROW EXECUTE FUNCTION emdo.check_investment_account();
CREATE TRIGGER check_investment_account BEFORE INSERT ON emdo.finance_observed_positions FOR EACH ROW EXECUTE FUNCTION emdo.check_investment_account();
CREATE FUNCTION emdo.check_investment_movement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM emdo.finance_journals WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.journal_id AND status='posted' AND effective_on=NEW.effective_on) THEN
    RAISE EXCEPTION 'investment movement requires a matching posted journal date' USING ERRCODE='23514'; END IF;
  IF length(trim(NEW.source_reference))=0 THEN RAISE EXCEPTION 'investment movement requires provenance' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_investment_movement BEFORE INSERT ON emdo.finance_investment_movements FOR EACH ROW EXECUTE FUNCTION emdo.check_investment_movement();
REVOKE ALL ON FUNCTION emdo.check_investment_account(),emdo.check_investment_movement() FROM PUBLIC;
CREATE FUNCTION emdo.check_instrument_identifier() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF length(trim(NEW.value))=0 OR length(trim(NEW.namespace))=0 THEN RAISE EXCEPTION 'instrument identifier requires a value and namespace' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM emdo.finance_instrument_identifiers WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND scheme=NEW.scheme AND namespace=NEW.namespace AND value=NEW.value) THEN
    RAISE EXCEPTION 'instrument identifier is already mapped in this book' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_instrument_identifier BEFORE INSERT ON emdo.finance_instrument_identifiers FOR EACH ROW EXECUTE FUNCTION emdo.check_instrument_identifier();
REVOKE ALL ON FUNCTION emdo.check_instrument_identifier() FROM PUBLIC;
