-- Commercial documents use functional-currency amounts. Tax amounts are explicit
-- source facts; this migration does not implement jurisdictional tax calculations.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['finance_parties','finance_commercial_documents','finance_commercial_lines','finance_payments','finance_payment_allocations'] LOOP
    EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON emdo.%I TO emdo_app',t);
    EXECUTE format('CREATE POLICY %I ON emdo.%I FOR SELECT TO emdo_app USING (emdo.finance_book_access(workspace_id,book_id))',t||'_read',t);
    EXECUTE format('CREATE POLICY %I ON emdo.%I FOR INSERT TO emdo_app WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY[''administrator'',''preparer'',''approver'']))',t||'_insert',t);
    EXECUTE format('CREATE POLICY %I ON emdo.%I FOR UPDATE TO emdo_app USING (emdo.finance_book_access(workspace_id,book_id,ARRAY[''administrator'',''preparer'',''approver''])) WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY[''administrator'',''preparer'',''approver'']))',t||'_update',t);
    EXECUTE format('CREATE TRIGGER a_lock_book BEFORE INSERT OR UPDATE ON emdo.%I FOR EACH ROW EXECUTE FUNCTION emdo.lock_finance_book_mutation()',t);
  END LOOP;
END $$;

CREATE FUNCTION emdo.commercial_journal_matches(w uuid,b uuid,j uuid,expected jsonb) RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog AS $$
  WITH wanted AS (
    SELECT account_id,side,sum(amount) amount FROM jsonb_to_recordset(expected) AS r(account_id uuid,side text,amount numeric)
    GROUP BY account_id,side
  ), actual AS (
    SELECT account_id,side,sum(amount) amount FROM emdo.finance_journal_lines WHERE workspace_id=w AND book_id=b AND journal_id=j
    GROUP BY account_id,side
  )
  SELECT NOT EXISTS((TABLE wanted EXCEPT TABLE actual) UNION ALL (TABLE actual EXCEPT TABLE wanted))
    AND NOT EXISTS(SELECT 1 FROM emdo.finance_journal_lines l JOIN emdo.finance_books bk ON bk.id=l.book_id AND bk.workspace_id=l.workspace_id
      WHERE l.workspace_id=w AND l.book_id=b AND l.journal_id=j AND (l.currency<>bk.functional_currency OR l.fx_rate<>1));
$$;

CREATE FUNCTION emdo.enforce_commercial_line() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE doc emdo.finance_commercial_documents; precision integer; kind text;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.id,NEW.document_id,NEW.line_number) IS DISTINCT FROM (OLD.id,OLD.document_id,OLD.line_number) THEN
    RAISE EXCEPTION 'commercial line identity is immutable' USING ERRCODE='23514'; END IF;
  SELECT * INTO doc FROM emdo.finance_commercial_documents WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.document_id;
  IF doc.id IS NULL OR doc.status<>'draft' THEN RAISE EXCEPTION 'issued commercial lines are immutable' USING ERRCODE='23514'; END IF;
  SELECT CASE functional_currency WHEN 'JPY' THEN 0 WHEN 'KRW' THEN 0 ELSE 2 END INTO precision FROM emdo.finance_books WHERE workspace_id=NEW.workspace_id AND id=NEW.book_id;
  IF NEW.net_amount<>round(NEW.net_amount,precision) OR NEW.tax_amount<>round(NEW.tax_amount,precision) THEN
    RAISE EXCEPTION 'commercial amount exceeds currency precision' USING ERRCODE='23514'; END IF;
  SELECT a.kind INTO kind FROM emdo.finance_ledger_accounts a WHERE a.workspace_id=NEW.workspace_id AND a.book_id=NEW.book_id AND a.id=NEW.account_id AND a.active;
  IF kind IS NULL OR (doc.kind='sales-invoice' AND kind<>'income') OR (doc.kind='supplier-bill' AND kind NOT IN ('expense','asset'))
    OR NEW.account_id=doc.control_account_id OR NEW.tax_account_id=doc.control_account_id THEN
    RAISE EXCEPTION 'commercial line account is invalid' USING ERRCODE='23514'; END IF;
  IF NEW.tax_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM emdo.finance_ledger_accounts a WHERE a.workspace_id=NEW.workspace_id AND a.book_id=NEW.book_id
    AND a.id=NEW.tax_account_id AND a.active AND a.kind=CASE doc.kind WHEN 'sales-invoice' THEN 'liability' ELSE 'asset' END) THEN
    RAISE EXCEPTION 'commercial tax account is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enforce_commercial_line BEFORE INSERT OR UPDATE ON emdo.finance_commercial_lines FOR EACH ROW EXECUTE FUNCTION emdo.enforce_commercial_line();

CREATE FUNCTION emdo.enforce_commercial_document() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE amount numeric; expected jsonb; control_side text; other_side text;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' OR NEW.journal_id IS NOT NULL OR NEW.void_journal_id IS NOT NULL OR NEW.total<>0 THEN
      RAISE EXCEPTION 'commercial document must start draft' USING ERRCODE='23514'; END IF;
  ELSE
    IF (NEW.id,NEW.kind,NEW.party_id,NEW.reference,NEW.issued_on,NEW.due_on,NEW.control_account_id,NEW.source_reference)
      IS DISTINCT FROM (OLD.id,OLD.kind,OLD.party_id,OLD.reference,OLD.issued_on,OLD.due_on,OLD.control_account_id,OLD.source_reference) THEN
      RAISE EXCEPTION 'commercial identity is immutable' USING ERRCODE='23514'; END IF;
    IF OLD.status<>'draft' AND NOT (
      (OLD.status='issued' AND NEW.status='void' AND NEW.void_journal_id IS NULL) OR
      (OLD.status='void' AND NEW.status='void' AND OLD.void_journal_id IS NULL AND NEW.void_journal_id IS NOT NULL)
    ) THEN RAISE EXCEPTION 'issued commercial document is immutable' USING ERRCODE='23514'; END IF;
    IF OLD.status<>'draft' AND (NEW.total,NEW.journal_id) IS DISTINCT FROM (OLD.total,OLD.journal_id) THEN
      RAISE EXCEPTION 'issued amounts and journal are immutable' USING ERRCODE='23514'; END IF;
    IF OLD.status='draft' AND NEW.status='void' THEN RAISE EXCEPTION 'cannot void an unissued document' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.status IN ('issued','void') AND NOT emdo.finance_book_access(NEW.workspace_id,NEW.book_id,ARRAY['administrator','approver']) THEN
    RAISE EXCEPTION 'commercial posting requires approval authority' USING ERRCODE='42501'; END IF;
  IF NEW.status='void' THEN
    IF EXISTS(SELECT 1 FROM emdo.finance_payment_allocations a JOIN emdo.finance_payments p ON p.workspace_id=a.workspace_id AND p.book_id=a.book_id AND p.id=a.payment_id
      WHERE a.workspace_id=NEW.workspace_id AND a.book_id=NEW.book_id AND a.document_id=NEW.id AND p.status='posted') THEN
      RAISE EXCEPTION 'settled commercial document cannot be voided' USING ERRCODE='23514'; END IF;
  ELSIF NEW.status='issued' THEN
    SELECT sum(net_amount+tax_amount) INTO amount FROM emdo.finance_commercial_lines WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND document_id=NEW.id;
    IF amount IS NULL OR amount<=0 OR NEW.total<>amount THEN RAISE EXCEPTION 'commercial totals do not match lines' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM emdo.finance_ledger_accounts WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.control_account_id
      AND active AND kind=CASE NEW.kind WHEN 'sales-invoice' THEN 'asset' ELSE 'liability' END) THEN
      RAISE EXCEPTION 'invalid receivable or payable control account' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM emdo.finance_journals j WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.journal_id
      AND NOT EXISTS(SELECT 1 FROM emdo.finance_journals reversal WHERE reversal.reversal_of=j.id) AND status='posted' AND reversal_of IS NULL AND effective_on=NEW.issued_on AND source_reference=NEW.source_reference) THEN
      RAISE EXCEPTION 'commercial document requires a matching posted journal' USING ERRCODE='23514'; END IF;
    control_side:=CASE NEW.kind WHEN 'sales-invoice' THEN 'debit' ELSE 'credit' END;
    other_side:=CASE NEW.kind WHEN 'sales-invoice' THEN 'credit' ELSE 'debit' END;
    SELECT jsonb_agg(row_to_json(r)) INTO expected FROM (
      SELECT NEW.control_account_id account_id,control_side side,amount amount
      UNION ALL SELECT account_id,other_side,net_amount FROM emdo.finance_commercial_lines WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND document_id=NEW.id
      UNION ALL SELECT tax_account_id,other_side,tax_amount FROM emdo.finance_commercial_lines WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND document_id=NEW.id AND tax_amount>0
    ) r;
    IF NOT emdo.commercial_journal_matches(NEW.workspace_id,NEW.book_id,NEW.journal_id,expected) THEN
      RAISE EXCEPTION 'commercial posting does not match document' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enforce_commercial_document BEFORE INSERT OR UPDATE ON emdo.finance_commercial_documents FOR EACH ROW EXECUTE FUNCTION emdo.enforce_commercial_document();

CREATE FUNCTION emdo.check_commercial_void_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE doc emdo.finance_commercial_documents;
BEGIN
  SELECT * INTO doc FROM emdo.finance_commercial_documents WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.id;
  IF doc.status='void' AND NOT EXISTS(SELECT 1 FROM emdo.finance_journals WHERE workspace_id=doc.workspace_id AND book_id=doc.book_id AND id=doc.void_journal_id
    AND status='posted' AND reversal_of=doc.journal_id AND effective_on>=doc.issued_on) THEN
    RAISE EXCEPTION 'void requires an exact posted reversal' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER commercial_void_complete AFTER INSERT OR UPDATE ON emdo.finance_commercial_documents DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION emdo.check_commercial_void_complete();

CREATE FUNCTION emdo.enforce_payment_allocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE payment emdo.finance_payments; doc emdo.finance_commercial_documents; precision integer;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.id,NEW.payment_id,NEW.document_id) IS DISTINCT FROM (OLD.id,OLD.payment_id,OLD.document_id) THEN
    RAISE EXCEPTION 'allocation identity is immutable' USING ERRCODE='23514'; END IF;
  SELECT * INTO payment FROM emdo.finance_payments WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.payment_id;
  SELECT * INTO doc FROM emdo.finance_commercial_documents WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.document_id;
  IF payment.id IS NULL OR doc.id IS NULL OR payment.status<>'draft' OR doc.status<>'issued' OR doc.party_id<>payment.party_id
    OR (payment.direction='receipt' AND doc.kind<>'sales-invoice') OR (payment.direction='disbursement' AND doc.kind<>'supplier-bill')
    OR payment.effective_on<doc.issued_on OR payment.cash_account_id=doc.control_account_id THEN
    RAISE EXCEPTION 'payment allocation is invalid or immutable' USING ERRCODE='23514'; END IF;
  SELECT CASE functional_currency WHEN 'JPY' THEN 0 WHEN 'KRW' THEN 0 ELSE 2 END INTO precision FROM emdo.finance_books WHERE workspace_id=NEW.workspace_id AND id=NEW.book_id;
  IF NEW.amount<>round(NEW.amount,precision) THEN RAISE EXCEPTION 'allocation exceeds currency precision' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enforce_payment_allocation BEFORE INSERT OR UPDATE ON emdo.finance_payment_allocations FOR EACH ROW EXECUTE FUNCTION emdo.enforce_payment_allocation();

CREATE FUNCTION emdo.enforce_finance_payment() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE amount numeric; expected jsonb; cash_side text; other_side text;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' OR NEW.journal_id IS NOT NULL OR NEW.void_journal_id IS NOT NULL OR NEW.total<>0 THEN RAISE EXCEPTION 'payment must start draft' USING ERRCODE='23514'; END IF;
  ELSE
    IF (OLD.status<>'draft' AND NOT ((OLD.status='posted' AND NEW.status='void' AND NEW.void_journal_id IS NULL) OR (OLD.status='void' AND NEW.status='void' AND OLD.void_journal_id IS NULL AND NEW.void_journal_id IS NOT NULL))) OR (NEW.id,NEW.direction,NEW.party_id,NEW.cash_account_id,NEW.effective_on,NEW.reference,NEW.source_reference)
      IS DISTINCT FROM (OLD.id,OLD.direction,OLD.party_id,OLD.cash_account_id,OLD.effective_on,OLD.reference,OLD.source_reference) THEN
      RAISE EXCEPTION 'payment identity and posted history are immutable' USING ERRCODE='23514'; END IF;
    IF OLD.status<>'draft' AND (NEW.total,NEW.journal_id) IS DISTINCT FROM (OLD.total,OLD.journal_id) THEN
      RAISE EXCEPTION 'posted payment amounts are immutable' USING ERRCODE='23514'; END IF;
    IF OLD.status='draft' AND NEW.status='void' THEN RAISE EXCEPTION 'cannot void an unposted payment' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.status='void' AND NOT emdo.finance_book_access(NEW.workspace_id,NEW.book_id,ARRAY['administrator','approver']) THEN
    RAISE EXCEPTION 'payment void requires approval authority' USING ERRCODE='42501'; END IF;
  IF NEW.status='posted' THEN
    IF NOT emdo.finance_book_access(NEW.workspace_id,NEW.book_id,ARRAY['administrator','approver']) THEN RAISE EXCEPTION 'payment requires approval authority' USING ERRCODE='42501'; END IF;
    SELECT sum(a.amount) INTO amount FROM emdo.finance_payment_allocations a WHERE a.workspace_id=NEW.workspace_id AND a.book_id=NEW.book_id AND a.payment_id=NEW.id;
    IF amount IS NULL OR amount<=0 OR amount<>NEW.total THEN RAISE EXCEPTION 'payment allocation total mismatch' USING ERRCODE='23514'; END IF;
    IF EXISTS(SELECT 1 FROM emdo.finance_payment_allocations a JOIN emdo.finance_commercial_documents d ON d.workspace_id=a.workspace_id AND d.book_id=a.book_id AND d.id=a.document_id
      WHERE a.workspace_id=NEW.workspace_id AND a.book_id=NEW.book_id AND a.payment_id=NEW.id AND
      (d.status<>'issued' OR d.party_id<>NEW.party_id OR NEW.effective_on<d.issued_on OR NEW.cash_account_id=d.control_account_id OR
       (NEW.direction='receipt' AND d.kind<>'sales-invoice') OR (NEW.direction='disbursement' AND d.kind<>'supplier-bill') OR
       a.amount+coalesce((SELECT sum(other.amount) FROM emdo.finance_payment_allocations other JOIN emdo.finance_payments p ON p.workspace_id=other.workspace_id AND p.book_id=other.book_id AND p.id=other.payment_id
         WHERE other.workspace_id=d.workspace_id AND other.book_id=d.book_id AND other.document_id=d.id AND p.status='posted' AND p.id<>NEW.id),0)>d.total)) THEN
      RAISE EXCEPTION 'payment would overpay or use an invalid document' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM emdo.finance_ledger_accounts WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.cash_account_id AND active AND kind='asset') THEN
      RAISE EXCEPTION 'payment cash account must be an active asset' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS(SELECT 1 FROM emdo.finance_journals j WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.journal_id AND NOT EXISTS(SELECT 1 FROM emdo.finance_journals reversal WHERE reversal.reversal_of=j.id) AND status='posted'
      AND reversal_of IS NULL AND effective_on=NEW.effective_on AND source_reference=NEW.source_reference) THEN
      RAISE EXCEPTION 'payment requires a matching posted journal' USING ERRCODE='23514'; END IF;
    cash_side:=CASE NEW.direction WHEN 'receipt' THEN 'debit' ELSE 'credit' END;
    other_side:=CASE NEW.direction WHEN 'receipt' THEN 'credit' ELSE 'debit' END;
    SELECT jsonb_agg(row_to_json(r)) INTO expected FROM (
      SELECT NEW.cash_account_id account_id,cash_side side,amount amount
      UNION ALL SELECT d.control_account_id,other_side,a.amount FROM emdo.finance_payment_allocations a JOIN emdo.finance_commercial_documents d
        ON d.workspace_id=a.workspace_id AND d.book_id=a.book_id AND d.id=a.document_id WHERE a.workspace_id=NEW.workspace_id AND a.book_id=NEW.book_id AND a.payment_id=NEW.id
    ) r;
    IF NOT emdo.commercial_journal_matches(NEW.workspace_id,NEW.book_id,NEW.journal_id,expected) THEN RAISE EXCEPTION 'payment posting does not match allocations' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enforce_finance_payment BEFORE INSERT OR UPDATE ON emdo.finance_payments FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_payment();

CREATE FUNCTION emdo.protect_commercial_journal_reversal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.reversal_of IS NOT NULL AND (
    EXISTS(SELECT 1 FROM emdo.finance_commercial_documents WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND journal_id=NEW.reversal_of AND status<>'void') OR
    EXISTS(SELECT 1 FROM emdo.finance_payments WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND journal_id=NEW.reversal_of AND status='posted')
  ) THEN RAISE EXCEPTION 'reverse commercial records through their lifecycle' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_commercial_reversal BEFORE INSERT ON emdo.finance_journals FOR EACH ROW EXECUTE FUNCTION emdo.protect_commercial_journal_reversal();
REVOKE ALL ON FUNCTION emdo.commercial_journal_matches(uuid,uuid,uuid,jsonb),emdo.enforce_commercial_line(),emdo.enforce_commercial_document(),
  emdo.check_commercial_void_complete(),emdo.enforce_payment_allocation(),emdo.enforce_finance_payment(),emdo.protect_commercial_journal_reversal() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.commercial_journal_matches(uuid,uuid,uuid,jsonb) TO emdo_app;

CREATE FUNCTION emdo.check_payment_void_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE payment emdo.finance_payments;
BEGIN
  SELECT * INTO payment FROM emdo.finance_payments WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.id;
  IF payment.status='void' AND NOT EXISTS(SELECT 1 FROM emdo.finance_journals WHERE workspace_id=payment.workspace_id AND book_id=payment.book_id AND id=payment.void_journal_id
    AND status='posted' AND reversal_of=payment.journal_id AND effective_on>=payment.effective_on) THEN
    RAISE EXCEPTION 'payment void requires an exact posted reversal' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payment_void_complete AFTER INSERT OR UPDATE ON emdo.finance_payments DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION emdo.check_payment_void_complete();
REVOKE ALL ON FUNCTION emdo.check_payment_void_complete() FROM PUBLIC;
