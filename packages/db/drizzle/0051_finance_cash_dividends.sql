CREATE TABLE "emdo"."finance_investment_cash_dividend_amounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"native_amount" numeric(38, 12) NOT NULL,
	"currency" text NOT NULL,
	"functional_amount" numeric(38, 12) NOT NULL,
	"fx_rate" numeric(38, 12) NOT NULL,
	"fx_source" text NOT NULL,
	"ledger_account_id" uuid NOT NULL,
	"posting_side" text NOT NULL,
	"journal_id" uuid NOT NULL,
	"journal_line_number" integer,
	"source_provenance" jsonb NOT NULL,
	CONSTRAINT "finance_investment_cash_dividend_amounts_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_investment_cash_dividend_amounts_kind" UNIQUE("workspace_id","book_id","action_id","kind"),
	CONSTRAINT "finance_investment_cash_dividend_amounts_valid" CHECK ("emdo"."finance_investment_cash_dividend_amounts"."kind" in ('gross','withholding','net') and "emdo"."finance_investment_cash_dividend_amounts"."currency" in ('CAD','USD','MXN','EUR','KRW','JPY') and "emdo"."finance_investment_cash_dividend_amounts"."native_amount">=0 and "emdo"."finance_investment_cash_dividend_amounts"."native_amount"<>'NaN'::numeric and "emdo"."finance_investment_cash_dividend_amounts"."native_amount"=round("emdo"."finance_investment_cash_dividend_amounts"."native_amount",case when "emdo"."finance_investment_cash_dividend_amounts"."currency" in ('JPY','KRW') then 0 else 2 end) and "emdo"."finance_investment_cash_dividend_amounts"."functional_amount">=0 and "emdo"."finance_investment_cash_dividend_amounts"."functional_amount"<>'NaN'::numeric and "emdo"."finance_investment_cash_dividend_amounts"."fx_rate">0 and "emdo"."finance_investment_cash_dividend_amounts"."fx_rate"<>'NaN'::numeric and length(trim("emdo"."finance_investment_cash_dividend_amounts"."fx_source")) between 1 and 200 and "emdo"."finance_investment_cash_dividend_amounts"."posting_side" in ('debit','credit') and ("emdo"."finance_investment_cash_dividend_amounts"."functional_amount"=0 and "emdo"."finance_investment_cash_dividend_amounts"."journal_line_number" is null or "emdo"."finance_investment_cash_dividend_amounts"."functional_amount">0 and "emdo"."finance_investment_cash_dividend_amounts"."journal_line_number" is not null) and jsonb_typeof("emdo"."finance_investment_cash_dividend_amounts"."source_provenance")='object')
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_investment_cash_dividends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"source_row_id" uuid NOT NULL,
	"declared_on" date NOT NULL,
	"ex_date" date,
	"payable_on" date NOT NULL,
	"source_reference" text NOT NULL,
	"review_reason" text NOT NULL,
	"cash_ledger_account_id" uuid NOT NULL,
	"dividend_income_ledger_account_id" uuid NOT NULL,
	"withholding_ledger_account_id" uuid NOT NULL,
	"source_revision" integer NOT NULL,
	"source_snapshot_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"economic_transaction_id" uuid NOT NULL,
	"journal_id" uuid NOT NULL,
	"status" text DEFAULT 'committed' NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "finance_investment_cash_dividends_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_investment_cash_dividends_idempotency" UNIQUE("workspace_id","book_id","idempotency_key"),
	CONSTRAINT "finance_investment_cash_dividends_source_row_identity" UNIQUE("workspace_id","book_id","source_row_id"),
	CONSTRAINT "finance_investment_cash_dividends_valid" CHECK ("emdo"."finance_investment_cash_dividends"."action_type"='cash-dividend' and "emdo"."finance_investment_cash_dividends"."status"='committed' and "emdo"."finance_investment_cash_dividends"."declared_on"<="emdo"."finance_investment_cash_dividends"."payable_on" and ("emdo"."finance_investment_cash_dividends"."ex_date" is null or ("emdo"."finance_investment_cash_dividends"."ex_date">="emdo"."finance_investment_cash_dividends"."declared_on" and "emdo"."finance_investment_cash_dividends"."ex_date"<="emdo"."finance_investment_cash_dividends"."payable_on")) and "emdo"."finance_investment_cash_dividends"."source_revision">0 and "emdo"."finance_investment_cash_dividends"."source_snapshot_hash" ~ '^[a-f0-9]{64}$' and "emdo"."finance_investment_cash_dividends"."command_hash" ~ '^[a-f0-9]{64}$' and length(trim("emdo"."finance_investment_cash_dividends"."source_reference")) between 1 and 500 and length(trim("emdo"."finance_investment_cash_dividends"."review_reason")) between 1 and 2000 and length(trim("emdo"."finance_investment_cash_dividends"."idempotency_key")) between 1 and 200),
	CONSTRAINT "finance_investment_cash_dividends_distinct_accounts" CHECK ("emdo"."finance_investment_cash_dividends"."cash_ledger_account_id"<>"emdo"."finance_investment_cash_dividends"."dividend_income_ledger_account_id" and "emdo"."finance_investment_cash_dividends"."cash_ledger_account_id"<>"emdo"."finance_investment_cash_dividends"."withholding_ledger_account_id" and "emdo"."finance_investment_cash_dividends"."dividend_income_ledger_account_id"<>"emdo"."finance_investment_cash_dividends"."withholding_ledger_account_id")
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_cash_dividend_amounts" ADD CONSTRAINT "finance_investment_cash_dividend_amounts_action" FOREIGN KEY ("workspace_id","book_id","action_id") REFERENCES "emdo"."finance_investment_cash_dividends"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_cash_dividend_amounts" ADD CONSTRAINT "finance_investment_cash_dividend_amounts_account" FOREIGN KEY ("workspace_id","book_id","ledger_account_id") REFERENCES "emdo"."finance_ledger_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_cash_dividend_amounts" ADD CONSTRAINT "finance_investment_cash_dividend_amounts_journal" FOREIGN KEY ("workspace_id","book_id","journal_id") REFERENCES "emdo"."finance_journals"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_cash_dividend_amounts" ADD CONSTRAINT "finance_investment_cash_dividend_amounts_journal_line" FOREIGN KEY ("workspace_id","book_id","journal_id","journal_line_number") REFERENCES "emdo"."finance_journal_lines"("workspace_id","book_id","journal_id","line_number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_cash_dividends" ADD CONSTRAINT "finance_investment_cash_dividends_created_by_auth_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_cash_dividends" ADD CONSTRAINT "finance_investment_cash_dividends_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_cash_dividends" ADD CONSTRAINT "finance_investment_cash_dividends_account" FOREIGN KEY ("workspace_id","book_id","financial_account_id") REFERENCES "emdo"."finance_financial_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_cash_dividends" ADD CONSTRAINT "finance_investment_cash_dividends_instrument" FOREIGN KEY ("workspace_id","book_id","instrument_id") REFERENCES "emdo"."finance_instruments"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_cash_dividends" ADD CONSTRAINT "finance_investment_cash_dividends_evidence" FOREIGN KEY ("workspace_id","book_id","evidence_id") REFERENCES "emdo"."finance_book_evidence"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_cash_dividends" ADD CONSTRAINT "finance_investment_cash_dividends_source_row" FOREIGN KEY ("workspace_id","book_id","source_row_id") REFERENCES "emdo"."finance_normalized_import_rows"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_cash_dividends" ADD CONSTRAINT "finance_investment_cash_dividends_cash_account" FOREIGN KEY ("workspace_id","book_id","cash_ledger_account_id") REFERENCES "emdo"."finance_ledger_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_cash_dividends" ADD CONSTRAINT "finance_investment_cash_dividends_income_account" FOREIGN KEY ("workspace_id","book_id","dividend_income_ledger_account_id") REFERENCES "emdo"."finance_ledger_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_cash_dividends" ADD CONSTRAINT "finance_investment_cash_dividends_withholding_account" FOREIGN KEY ("workspace_id","book_id","withholding_ledger_account_id") REFERENCES "emdo"."finance_ledger_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_cash_dividends" ADD CONSTRAINT "finance_investment_cash_dividends_transaction" FOREIGN KEY ("workspace_id","book_id","economic_transaction_id") REFERENCES "emdo"."finance_economic_transactions"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_investment_cash_dividends" ADD CONSTRAINT "finance_investment_cash_dividends_journal" FOREIGN KEY ("workspace_id","book_id","journal_id") REFERENCES "emdo"."finance_journals"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_investment_cash_dividend_amounts_lookup" ON "emdo"."finance_investment_cash_dividend_amounts" USING btree ("workspace_id","book_id","action_id");--> statement-breakpoint
CREATE INDEX "finance_investment_cash_dividends_lookup" ON "emdo"."finance_investment_cash_dividends" USING btree ("workspace_id","book_id","payable_on","financial_account_id","instrument_id");

-- Cash-dividend actions use the normalized statement receipt as their one
-- economic source. The tables are visible in book scope, while all writes are
-- limited to an administrator or approver and remain append-only.
ALTER TABLE emdo.finance_investment_cash_dividends ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_investment_cash_dividends FORCE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_investment_cash_dividend_amounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_investment_cash_dividend_amounts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON emdo.finance_investment_cash_dividends,
  emdo.finance_investment_cash_dividend_amounts FROM PUBLIC,emdo_worker,emdo_workflow;
GRANT SELECT,INSERT ON emdo.finance_investment_cash_dividends TO emdo_app;
GRANT SELECT,INSERT ON emdo.finance_investment_cash_dividend_amounts TO emdo_app;
CREATE POLICY finance_cash_dividend_read
  ON emdo.finance_investment_cash_dividends FOR SELECT TO emdo_app
  USING (emdo.finance_book_access(workspace_id,book_id));
CREATE POLICY finance_cash_dividend_insert
  ON emdo.finance_investment_cash_dividends FOR INSERT TO emdo_app
  WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','approver']));
CREATE POLICY finance_cash_dividend_amount_read
  ON emdo.finance_investment_cash_dividend_amounts FOR SELECT TO emdo_app
  USING (emdo.finance_book_access(workspace_id,book_id));
CREATE POLICY finance_cash_dividend_amount_insert
  ON emdo.finance_investment_cash_dividend_amounts FOR INSERT TO emdo_app
  WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','approver']));
CREATE TRIGGER finance_cash_dividend_book_lock
  BEFORE INSERT ON emdo.finance_investment_cash_dividends FOR EACH ROW
  EXECUTE FUNCTION emdo.lock_finance_book_mutation();
CREATE TRIGGER finance_cash_dividend_amount_book_lock
  BEFORE INSERT ON emdo.finance_investment_cash_dividend_amounts FOR EACH ROW
  EXECUTE FUNCTION emdo.lock_finance_book_mutation();

CREATE FUNCTION emdo.reject_finance_cash_dividend_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'finance-cash-dividend-immutable' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION emdo.reject_finance_cash_dividend_mutation() FROM PUBLIC;
CREATE TRIGGER finance_cash_dividend_immutable
  BEFORE UPDATE OR DELETE ON emdo.finance_investment_cash_dividends
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_cash_dividend_mutation();
CREATE TRIGGER finance_cash_dividend_amount_immutable
  BEFORE UPDATE OR DELETE ON emdo.finance_investment_cash_dividend_amounts
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_cash_dividend_mutation();

-- The action insert is a narrow proof that the source row, account, evidence,
-- instrument, journal, and economic transaction all share one book scope.
-- Amount-level arithmetic is deferred until all three component rows exist.
CREATE FUNCTION emdo.check_finance_cash_dividend_action()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE
  source record;
  account record;
  transaction_record record;
  journal record;
  account_count integer;
BEGIN
  IF NEW.action_type<>'cash-dividend' OR NEW.status<>'committed'
     OR NEW.source_revision<=0
     OR NEW.source_snapshot_hash !~ '^[a-f0-9]{64}$'
     OR NEW.command_hash !~ '^[a-f0-9]{64}$'
     OR NEW.created_by IS DISTINCT FROM emdo.current_user_id()
     OR NOT emdo.finance_book_access(NEW.workspace_id,NEW.book_id,ARRAY['administrator','approver']) THEN
    RAISE EXCEPTION 'finance-cash-dividend-action-authorization-invalid' USING ERRCODE='23514';
  END IF;
  SELECT r.*,i.evidence_id as batch_evidence_id,
         i.financial_account_id as batch_account_id,
         a.currency as account_currency,
         a.ledger_account_id as account_ledger_id
    INTO source
    FROM emdo.finance_normalized_import_rows r
    JOIN emdo.finance_normalized_imports i
      ON i.workspace_id=r.workspace_id AND i.book_id=r.book_id AND i.id=r.batch_id
    JOIN emdo.finance_financial_accounts a
      ON a.workspace_id=i.workspace_id AND a.book_id=i.book_id
     AND a.id=i.financial_account_id
   WHERE r.workspace_id=NEW.workspace_id AND r.book_id=NEW.book_id
     AND r.id=NEW.source_row_id;
  IF source.id IS NULL OR source.status<>'ready'
     OR source.revision<>NEW.source_revision
     OR source.economic_transaction_id IS NOT NULL
     OR source.batch_evidence_id IS DISTINCT FROM NEW.evidence_id
     OR source.batch_account_id IS DISTINCT FROM NEW.financial_account_id
     OR source.account_ledger_id IS DISTINCT FROM NEW.cash_ledger_account_id
     OR source.native_amount IS NULL OR source.native_amount<=0
     OR source.effective_on IS DISTINCT FROM NEW.payable_on
     OR NOT EXISTS (
       SELECT 1 FROM emdo.finance_instruments i
        WHERE i.workspace_id=NEW.workspace_id AND i.book_id=NEW.book_id
          AND i.id=NEW.instrument_id
     ) THEN
    RAISE EXCEPTION 'finance-cash-dividend-source-proof-invalid' USING ERRCODE='23514';
  END IF;
  SELECT * INTO account
    FROM emdo.finance_financial_accounts
   WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id
     AND id=NEW.financial_account_id AND active;
  IF account.id IS NULL OR account.currency IS DISTINCT FROM source.account_currency THEN
    RAISE EXCEPTION 'finance-cash-dividend-financial-account-invalid' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO account_count
    FROM emdo.finance_ledger_accounts
   WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id
     AND id IN (NEW.cash_ledger_account_id,NEW.dividend_income_ledger_account_id,NEW.withholding_ledger_account_id)
     AND active;
  IF account_count<>3 OR NEW.cash_ledger_account_id=NEW.dividend_income_ledger_account_id
     OR NEW.cash_ledger_account_id=NEW.withholding_ledger_account_id
     OR NEW.dividend_income_ledger_account_id=NEW.withholding_ledger_account_id THEN
    RAISE EXCEPTION 'finance-cash-dividend-ledger-mapping-invalid' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM emdo.finance_ledger_accounts
     WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id
       AND id=NEW.cash_ledger_account_id AND kind='asset' AND active
  ) OR NOT EXISTS (
    SELECT 1 FROM emdo.finance_ledger_accounts
     WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id
       AND id=NEW.dividend_income_ledger_account_id AND kind='income' AND active
  ) THEN
    RAISE EXCEPTION 'finance-cash-dividend-ledger-kind-invalid' USING ERRCODE='23514';
  END IF;
  SELECT * INTO transaction_record
    FROM emdo.finance_economic_transactions
   WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id
     AND id=NEW.economic_transaction_id;
  SELECT * INTO journal
    FROM emdo.finance_journals
   WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id
     AND id=NEW.journal_id;
  IF transaction_record.id IS NULL OR journal.id IS NULL
     OR transaction_record.financial_account_id IS DISTINCT FROM NEW.financial_account_id
     OR transaction_record.effective_on IS DISTINCT FROM NEW.payable_on
     OR transaction_record.journal_id IS DISTINCT FROM NEW.journal_id
     OR journal.status<>'posted' OR journal.effective_on IS DISTINCT FROM NEW.payable_on THEN
    RAISE EXCEPTION 'finance-cash-dividend-ledger-proof-invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_finance_cash_dividend_action
  BEFORE INSERT ON emdo.finance_investment_cash_dividends
  FOR EACH ROW EXECUTE FUNCTION emdo.check_finance_cash_dividend_action();
REVOKE ALL ON FUNCTION emdo.check_finance_cash_dividend_action() FROM PUBLIC;

CREATE FUNCTION emdo.check_finance_cash_dividend_amount()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE
  action_record record;
  source record;
  book_currency text;
  precision integer;
  expected numeric;
  line record;
  expected_account uuid;
  expected_side text;
BEGIN
  SELECT * INTO action_record
    FROM emdo.finance_investment_cash_dividends
   WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.action_id;
  SELECT r.source_row INTO source
    FROM emdo.finance_normalized_import_rows r
   WHERE r.workspace_id=NEW.workspace_id AND r.book_id=NEW.book_id
     AND r.id=action_record.source_row_id;
  SELECT functional_currency INTO book_currency
    FROM emdo.finance_books
   WHERE workspace_id=NEW.workspace_id AND id=NEW.book_id;
  IF action_record.id IS NULL OR source.source_row IS NULL
     OR NEW.journal_id IS DISTINCT FROM action_record.journal_id
     OR NEW.kind NOT IN ('gross','withholding','net')
     OR NEW.currency NOT IN ('CAD','USD','MXN','EUR','KRW','JPY')
     OR NEW.native_amount<0 OR NEW.native_amount='NaN'::numeric
     OR NEW.functional_amount<0 OR NEW.functional_amount='NaN'::numeric
     OR NEW.fx_rate<=0 OR NEW.fx_rate='NaN'::numeric
     OR length(trim(NEW.fx_source))=0
     OR pg_catalog.jsonb_typeof(NEW.source_provenance)<>'object'
     OR NEW.source_provenance->>'field' IS DISTINCT FROM NEW.kind
     OR (NEW.source_provenance->>'sourceRow')::integer IS DISTINCT FROM source.source_row THEN
    RAISE EXCEPTION 'finance-cash-dividend-amount-proof-invalid' USING ERRCODE='23514';
  END IF;
  precision:=CASE WHEN book_currency IN ('JPY','KRW') THEN 0 ELSE 2 END;
  IF NEW.native_amount<>round(NEW.native_amount,CASE WHEN NEW.currency IN ('JPY','KRW') THEN 0 ELSE 2 END)
     OR NEW.functional_amount<>round(NEW.functional_amount,precision)
     OR NEW.functional_amount<>round(NEW.native_amount*NEW.fx_rate,precision)
     OR (NEW.currency=book_currency AND (NEW.fx_rate<>1 OR NEW.fx_source<>'identity'))
     OR (NEW.currency<>book_currency AND NEW.fx_source='identity') THEN
    RAISE EXCEPTION 'finance-cash-dividend-amount-fx-invalid' USING ERRCODE='23514';
  END IF;
  expected_account:=CASE WHEN NEW.kind='gross' THEN action_record.dividend_income_ledger_account_id
                          WHEN NEW.kind='withholding' THEN action_record.withholding_ledger_account_id
                          ELSE action_record.cash_ledger_account_id END;
  expected_side:=CASE WHEN NEW.kind='gross' THEN 'credit' ELSE 'debit' END;
  IF NEW.ledger_account_id IS DISTINCT FROM expected_account
     OR NEW.posting_side IS DISTINCT FROM expected_side THEN
    RAISE EXCEPTION 'finance-cash-dividend-amount-mapping-invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='gross' AND (NEW.native_amount<=0 OR NEW.functional_amount<=0) THEN
    RAISE EXCEPTION 'finance-cash-dividend-gross-invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='net' AND (NEW.native_amount<=0 OR NEW.functional_amount<=0) THEN
    RAISE EXCEPTION 'finance-cash-dividend-net-invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.functional_amount=0 THEN
    IF NEW.journal_line_number IS NOT NULL THEN
      RAISE EXCEPTION 'finance-cash-dividend-zero-line-invalid' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.journal_line_number IS NULL THEN
      RAISE EXCEPTION 'finance-cash-dividend-journal-line-missing' USING ERRCODE='23514';
    END IF;
    SELECT * INTO line FROM emdo.finance_journal_lines
     WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id
       AND journal_id=NEW.journal_id AND line_number=NEW.journal_line_number;
    IF line.id IS NULL OR line.account_id IS DISTINCT FROM NEW.ledger_account_id
       OR line.side IS DISTINCT FROM NEW.posting_side
       OR line.amount IS DISTINCT FROM NEW.functional_amount
       OR line.currency IS DISTINCT FROM NEW.currency
       OR line.native_amount IS DISTINCT FROM NEW.native_amount
       OR line.fx_rate IS DISTINCT FROM NEW.fx_rate
       OR line.fx_source IS DISTINCT FROM NEW.fx_source THEN
      RAISE EXCEPTION 'finance-cash-dividend-journal-line-invalid' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_finance_cash_dividend_amount
  BEFORE INSERT ON emdo.finance_investment_cash_dividend_amounts
  FOR EACH ROW EXECUTE FUNCTION emdo.check_finance_cash_dividend_amount();
REVOKE ALL ON FUNCTION emdo.check_finance_cash_dividend_amount() FROM PUBLIC;

-- A dividend action is complete only after its three immutable component proofs
-- and its claimed normalized source row have reached the same commit.  The
-- deferred trigger makes a partially inserted action uncommittable while still
-- allowing the repository to insert the action, amounts, review, and source
-- claim in one transaction.
CREATE FUNCTION emdo.check_finance_cash_dividend_complete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE
  action_id uuid;
  scope_workspace_id uuid;
  scope_book_id uuid;
  action_record record;
  source record;
  net_amount record;
  gross_amount record;
  withholding_amount record;
  account_currency text;
  book_currency text;
  journal_line_count integer;
  amount_line_count integer;
BEGIN
  IF TG_TABLE_NAME='finance_investment_cash_dividends' THEN
    action_id:=NEW.id;
  ELSIF TG_OP='DELETE' THEN
    action_id:=OLD.action_id;
  ELSE
    action_id:=NEW.action_id;
  END IF;
  IF TG_OP='DELETE' THEN
    scope_workspace_id:=OLD.workspace_id;
    scope_book_id:=OLD.book_id;
  ELSE
    scope_workspace_id:=NEW.workspace_id;
    scope_book_id:=NEW.book_id;
  END IF;

  SELECT * INTO action_record
    FROM emdo.finance_investment_cash_dividends
   WHERE workspace_id=scope_workspace_id
     AND book_id=scope_book_id
     AND id=action_id;
  IF action_record.id IS NULL THEN
    RAISE EXCEPTION 'finance-cash-dividend-complete-action-missing' USING ERRCODE='23514';
  END IF;

  SELECT * INTO source
    FROM emdo.finance_normalized_import_rows
   WHERE workspace_id=action_record.workspace_id
     AND book_id=action_record.book_id
     AND id=action_record.source_row_id;
  IF source.id IS NULL OR source.status<>'committed'
     OR source.revision<>action_record.source_revision+1
     OR source.economic_transaction_id IS DISTINCT FROM action_record.economic_transaction_id
     OR NOT EXISTS(
       SELECT 1 FROM emdo.finance_import_row_reviews r
        WHERE r.workspace_id=action_record.workspace_id
          AND r.book_id=action_record.book_id
          AND r.row_id=source.id
          AND r.revision=source.revision
          AND r.reviewed_by=action_record.created_by
          AND r.decision->>'action'='cash-dividend'
          AND r.decision->>'dividendActionId'=action_record.id::text
          AND r.decision->>'sourceSnapshotHash'=action_record.source_snapshot_hash
     ) THEN
    RAISE EXCEPTION 'finance-cash-dividend-complete-source-claim-invalid' USING ERRCODE='23514';
  END IF;

  SELECT functional_currency INTO book_currency
    FROM emdo.finance_books
   WHERE workspace_id=action_record.workspace_id AND id=action_record.book_id;
  SELECT currency INTO account_currency
    FROM emdo.finance_financial_accounts
   WHERE workspace_id=action_record.workspace_id
     AND book_id=action_record.book_id
     AND id=action_record.financial_account_id;
  SELECT * INTO gross_amount
    FROM emdo.finance_investment_cash_dividend_amounts a
   WHERE a.workspace_id=action_record.workspace_id AND a.book_id=action_record.book_id
     AND a.action_id=action_record.id AND a.kind='gross';
  SELECT * INTO withholding_amount
    FROM emdo.finance_investment_cash_dividend_amounts a
   WHERE a.workspace_id=action_record.workspace_id AND a.book_id=action_record.book_id
     AND a.action_id=action_record.id AND a.kind='withholding';
  SELECT * INTO net_amount
    FROM emdo.finance_investment_cash_dividend_amounts a
   WHERE a.workspace_id=action_record.workspace_id AND a.book_id=action_record.book_id
     AND a.action_id=action_record.id AND a.kind='net';
  IF gross_amount.id IS NULL OR withholding_amount.id IS NULL OR net_amount.id IS NULL
     OR (SELECT count(*) FROM emdo.finance_investment_cash_dividend_amounts a
          WHERE a.workspace_id=action_record.workspace_id AND a.book_id=action_record.book_id
            AND a.action_id=action_record.id)<>3 THEN
    RAISE EXCEPTION 'finance-cash-dividend-complete-amount-set-invalid' USING ERRCODE='23514';
  END IF;
  IF net_amount.native_amount IS DISTINCT FROM source.native_amount
     OR net_amount.currency IS DISTINCT FROM account_currency
     OR net_amount.fx_rate IS DISTINCT FROM source.fx_rate
     OR net_amount.fx_source IS DISTINCT FROM source.fx_source THEN
    RAISE EXCEPTION 'finance-cash-dividend-complete-net-source-invalid' USING ERRCODE='23514';
  END IF;
  IF gross_amount.functional_amount<>withholding_amount.functional_amount+net_amount.functional_amount
     OR gross_amount.currency=withholding_amount.currency
        AND withholding_amount.currency=net_amount.currency
        AND gross_amount.native_amount<>withholding_amount.native_amount+net_amount.native_amount THEN
    RAISE EXCEPTION 'finance-cash-dividend-complete-balance-invalid' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM emdo.finance_economic_transactions t
     WHERE t.workspace_id=action_record.workspace_id AND t.book_id=action_record.book_id
       AND t.id=action_record.economic_transaction_id
       AND t.native_amount=net_amount.native_amount
       AND t.functional_amount=net_amount.functional_amount
       AND t.fx_rate=net_amount.fx_rate
       AND t.fx_source=net_amount.fx_source
       AND t.journal_id=action_record.journal_id
  ) THEN
    RAISE EXCEPTION 'finance-cash-dividend-complete-transaction-invalid' USING ERRCODE='23514';
  END IF;

  SELECT count(*) INTO journal_line_count
    FROM emdo.finance_journal_lines l
   WHERE l.workspace_id=action_record.workspace_id AND l.book_id=action_record.book_id
     AND l.journal_id=action_record.journal_id;
  SELECT count(*) INTO amount_line_count
    FROM emdo.finance_investment_cash_dividend_amounts a
   WHERE a.workspace_id=action_record.workspace_id AND a.book_id=action_record.book_id
     AND a.action_id=action_record.id AND a.functional_amount>0;
  IF journal_line_count<>amount_line_count
     OR EXISTS(
       SELECT 1 FROM emdo.finance_journal_lines l
        WHERE l.workspace_id=action_record.workspace_id AND l.book_id=action_record.book_id
          AND l.journal_id=action_record.journal_id
          AND NOT EXISTS(
            SELECT 1 FROM emdo.finance_investment_cash_dividend_amounts a
             WHERE a.workspace_id=action_record.workspace_id AND a.book_id=action_record.book_id
               AND a.action_id=action_record.id AND a.functional_amount>0
               AND a.journal_line_number=l.line_number
          )
     )
     OR EXISTS(
       SELECT 1 FROM emdo.finance_investment_cash_dividend_amounts a
        WHERE a.workspace_id=action_record.workspace_id AND a.book_id=action_record.book_id
          AND a.action_id=action_record.id AND a.functional_amount>0
          AND NOT EXISTS(
            SELECT 1 FROM emdo.finance_journal_lines l
             WHERE l.workspace_id=action_record.workspace_id AND l.book_id=action_record.book_id
               AND l.journal_id=action_record.journal_id AND l.line_number=a.journal_line_number
          )
     ) THEN
    RAISE EXCEPTION 'finance-cash-dividend-complete-journal-lines-invalid' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER finance_cash_dividend_action_complete
  AFTER INSERT ON emdo.finance_investment_cash_dividends
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION emdo.check_finance_cash_dividend_complete();
CREATE CONSTRAINT TRIGGER finance_cash_dividend_amounts_complete
  AFTER INSERT OR UPDATE OR DELETE ON emdo.finance_investment_cash_dividend_amounts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION emdo.check_finance_cash_dividend_complete();
REVOKE ALL ON FUNCTION emdo.check_finance_cash_dividend_complete() FROM PUBLIC;

-- The legacy review trigger accepts only generic post/match/ignore decisions.
-- A dividend claim has its own explicit review action, but it must retain the
-- same row revision, reviewer, previous-facts, and batch checks.
CREATE OR REPLACE FUNCTION emdo.check_import_review()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  current_row emdo.finance_normalized_import_rows;
BEGIN
  SELECT * INTO current_row
    FROM emdo.finance_normalized_import_rows
   WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.row_id;
  IF NEW.reviewed_by IS DISTINCT FROM emdo.current_user_id()
     OR current_row.id IS NULL
     OR NEW.revision<>current_row.revision+1
     OR length(coalesce(NEW.decision->>'reason',''))<3
     OR NEW.previous_facts IS DISTINCT FROM jsonb_build_object(
       'date',current_row.effective_on::text,
       'description',current_row.description,
       'amount',current_row.native_amount::text,
       'externalId',current_row.external_id
     )
     OR NOT EXISTS(
       SELECT 1 FROM emdo.finance_normalized_imports i
        WHERE i.workspace_id=NEW.workspace_id AND i.book_id=NEW.book_id
          AND i.id=current_row.batch_id AND i.status='review'
     )
     OR NOT (
       NEW.decision->>'action' IN ('post','match','ignore')
       OR (
         NEW.decision->>'action'='cash-dividend'
         AND current_row.status='ready'
         AND NEW.decision->>'dividendActionId' IS NOT NULL
         AND NEW.decision->>'sourceSnapshotHash' ~ '^[a-f0-9]{64}$'
         AND EXISTS(
           SELECT 1 FROM emdo.finance_investment_cash_dividends a
            WHERE a.workspace_id=NEW.workspace_id AND a.book_id=NEW.book_id
              AND a.id::text=NEW.decision->>'dividendActionId'
              AND a.source_row_id=current_row.id
              AND a.source_revision=current_row.revision
              AND a.source_snapshot_hash=NEW.decision->>'sourceSnapshotHash'
              AND a.status='committed'
         )
       )
     ) THEN
    RAISE EXCEPTION 'review revision or provenance is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION emdo.check_import_review() FROM PUBLIC;

-- A cash-dividend claim is a reviewed source-row transition with a new
-- revision.  Keep the generic import commit path unchanged for all other
-- actions, but require the saved action/economic transaction linkage here.
CREATE OR REPLACE FUNCTION emdo.check_normalized_row()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  review jsonb;
  batch emdo.finance_normalized_imports;
  account emdo.finance_financial_accounts;
  functional text;
  precision integer;
  has_components boolean;
BEGIN
  SELECT * INTO batch FROM emdo.finance_normalized_imports
   WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.batch_id;
  IF batch.id IS NULL OR batch.status<>'review' THEN
    RAISE EXCEPTION 'committed import rows are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NEW.status NOT IN ('review','invalid')
       OR NEW.economic_transaction_id IS NOT NULL
       OR NEW.counter_account_id IS NOT NULL
       OR NEW.match_journal_id IS NOT NULL
       OR NEW.fx_rate IS NOT NULL OR NEW.fx_source IS NOT NULL THEN
      RAISE EXCEPTION 'import row must start unreviewed' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.workspace_id,NEW.book_id,NEW.created_at,NEW.batch_id,
      NEW.source_row,NEW.source_facts)
     IS DISTINCT FROM
     (OLD.id,OLD.workspace_id,OLD.book_id,OLD.created_at,OLD.batch_id,
      OLD.source_row,OLD.source_facts)
     OR OLD.status IN ('committed','matched') THEN
    RAISE EXCEPTION 'import row evidence is immutable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO account FROM emdo.finance_financial_accounts
   WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id
     AND id=batch.financial_account_id;
  SELECT EXISTS(
    SELECT 1 FROM emdo.finance_normalized_import_amount_components
     WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND row_id=NEW.id
  ) INTO has_components;
  IF NEW.status IN ('committed','matched') THEN
    SELECT decision INTO review
      FROM emdo.finance_import_row_reviews
     WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id
       AND row_id=NEW.id AND revision=NEW.revision
       AND reviewed_by=emdo.current_user_id();
    IF review->>'action'='cash-dividend' THEN
      IF NEW.status<>'committed' OR OLD.status<>'ready'
         OR NEW.revision<>OLD.revision+1
         OR NOT emdo.finance_book_access(NEW.workspace_id,NEW.book_id,ARRAY['administrator','approver'])
         OR (NEW.effective_on,NEW.description,NEW.native_amount,NEW.external_id,
             NEW.issues,NEW.counter_account_id,NEW.match_journal_id,NEW.fx_rate,
             NEW.fx_source)
            IS DISTINCT FROM
            (OLD.effective_on,OLD.description,OLD.native_amount,OLD.external_id,
             OLD.issues,OLD.counter_account_id,OLD.match_journal_id,OLD.fx_rate,
             OLD.fx_source)
         OR NEW.economic_transaction_id IS NULL
         OR review->>'dividendActionId' IS NULL
         OR review->>'sourceSnapshotHash' IS NULL
         OR NOT EXISTS(
           SELECT 1 FROM emdo.finance_investment_cash_dividends a
            WHERE a.workspace_id=NEW.workspace_id AND a.book_id=NEW.book_id
              AND a.id::text=review->>'dividendActionId'
              AND a.source_row_id=NEW.id
              AND a.source_revision=OLD.revision
              AND a.source_snapshot_hash=review->>'sourceSnapshotHash'
              AND a.economic_transaction_id=NEW.economic_transaction_id
              AND a.status='committed'
         ) THEN
        RAISE EXCEPTION 'cash-dividend source claim must match saved action' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.status<>'ready' OR NEW.revision<>OLD.revision
       OR NOT emdo.finance_book_access(NEW.workspace_id,NEW.book_id,ARRAY['administrator','approver'])
       OR (NEW.effective_on,NEW.description,NEW.native_amount,NEW.external_id,
           NEW.issues,NEW.counter_account_id,NEW.match_journal_id,NEW.fx_rate,
           NEW.fx_source)
          IS DISTINCT FROM
          (OLD.effective_on,OLD.description,OLD.native_amount,OLD.external_id,
           OLD.issues,OLD.counter_account_id,OLD.match_journal_id,OLD.fx_rate,
           OLD.fx_source)
       OR NOT EXISTS(
         SELECT 1 FROM emdo.finance_economic_transactions t
          WHERE t.workspace_id=NEW.workspace_id AND t.book_id=NEW.book_id
            AND t.id=NEW.economic_transaction_id
            AND t.financial_account_id=batch.financial_account_id
            AND t.effective_on=NEW.effective_on
            AND t.native_amount=NEW.native_amount
            AND t.fx_rate=NEW.fx_rate
       )
       OR (has_components AND NOT emdo.finance_normalized_component_commit_valid(
         NEW.workspace_id,NEW.book_id,NEW.id,NEW.economic_transaction_id
       )) THEN
      RAISE EXCEPTION 'import commit must match reviewed facts and saved transaction' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT decision INTO review FROM emdo.finance_import_row_reviews
   WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id
     AND row_id=NEW.id AND revision=NEW.revision
     AND reviewed_by=emdo.current_user_id();
  IF NEW.revision<>OLD.revision+1 OR review IS NULL
     OR NEW.economic_transaction_id IS NOT NULL
     OR NEW.effective_on IS DISTINCT FROM coalesce((review->'correction'->>'date')::date,OLD.effective_on)
     OR NEW.native_amount IS DISTINCT FROM coalesce((review->'correction'->>'amount')::numeric,OLD.native_amount)
     OR NEW.description IS DISTINCT FROM coalesce(review->'correction'->>'description',OLD.description)
     OR NEW.external_id IS DISTINCT FROM (CASE WHEN (review->'correction') ? 'externalId'
       THEN review->'correction'->>'externalId' ELSE OLD.external_id END) THEN
    RAISE EXCEPTION 'import changes require a matching review revision' USING ERRCODE='23514';
  END IF;
  IF review->>'action'='ignore' THEN
    IF NEW.status<>'ignored' OR NEW.counter_account_id IS NOT NULL
       OR NEW.match_journal_id IS NOT NULL
       OR (has_components AND pg_catalog.jsonb_typeof(review->'componentMappings')='array'
           AND pg_catalog.jsonb_array_length(review->'componentMappings')>0) THEN
      RAISE EXCEPTION 'ignored row cannot post' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT functional_currency INTO functional FROM emdo.finance_books
   WHERE workspace_id=NEW.workspace_id AND id=NEW.book_id;
  precision:=CASE WHEN account.currency IN ('JPY','KRW') THEN 0 ELSE 2 END;
  IF NEW.status<>'ready' OR NEW.effective_on IS NULL OR NEW.native_amount IS NULL
     OR NEW.native_amount=0 OR NEW.native_amount='NaN'::numeric
     OR NEW.native_amount<>round(NEW.native_amount,precision)
     OR length(NEW.description)=0 OR NEW.issues IS DISTINCT FROM '[]'::jsonb
     OR NEW.fx_rate IS NULL OR NEW.fx_rate<=0 OR NEW.fx_rate='NaN'::numeric
     OR length(coalesce(NEW.fx_source,''))=0
     OR (account.currency=functional AND (NEW.fx_rate<>1 OR NEW.fx_source<>'identity'))
     OR (account.currency<>functional AND
         (NEW.fx_rate IS DISTINCT FROM (review->>'fxRate')::numeric
          OR NEW.fx_source IS DISTINCT FROM review->>'fxSource'))
     OR (review->>'action'='post' AND (
       (has_components AND (
         NEW.counter_account_id IS NOT NULL OR NEW.match_journal_id IS NOT NULL
         OR NOT emdo.finance_normalized_component_review_valid(
           NEW.workspace_id,NEW.book_id,NEW.id,NEW.native_amount,NEW.fx_rate,
           account.currency,functional,account.ledger_account_id,review
         )
       ))
       OR (NOT has_components AND (
         NEW.counter_account_id IS NULL OR NEW.counter_account_id=account.ledger_account_id
         OR NEW.match_journal_id IS NOT NULL
       ))
     ))
     OR (review->>'action'='match' AND (
       has_components OR NEW.match_journal_id IS NULL OR NEW.counter_account_id IS NOT NULL
     ))
     OR (NOT has_components AND pg_catalog.jsonb_typeof(review->'componentMappings')='array'
         AND pg_catalog.jsonb_array_length(review->'componentMappings')>0)
     OR NEW.counter_account_id IS DISTINCT FROM (review->>'counterAccountId')::uuid
     OR NEW.match_journal_id IS DISTINCT FROM (review->>'matchJournalId')::uuid THEN
    RAISE EXCEPTION 'reviewed import row is incomplete or invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
