CREATE TABLE "emdo"."finance_book_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"format" text NOT NULL,
	"plaintext_sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"encrypted_original" jsonb NOT NULL,
	"uploaded_by" uuid NOT NULL,
	CONSTRAINT "finance_book_evidence_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_book_evidence_hash" CHECK ("emdo"."finance_book_evidence"."plaintext_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "finance_book_evidence_size" CHECK ("emdo"."finance_book_evidence"."byte_size">0 and "emdo"."finance_book_evidence"."byte_size"<=2097152)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_economic_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"effective_on" date NOT NULL,
	"description" text NOT NULL,
	"native_amount" numeric(38, 12) NOT NULL,
	"functional_amount" numeric(38, 12) NOT NULL,
	"fx_rate" numeric(38, 12) NOT NULL,
	"fx_source" text NOT NULL,
	"journal_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"facts_hash" text NOT NULL,
	"external_id" text,
	CONSTRAINT "finance_economic_transactions_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_economic_transactions_identity" UNIQUE("workspace_id","book_id","financial_account_id","fingerprint"),
	CONSTRAINT "finance_economic_transactions_amounts" CHECK ("emdo"."finance_economic_transactions"."native_amount"<>0 and "emdo"."finance_economic_transactions"."functional_amount"<>0 and "emdo"."finance_economic_transactions"."fx_rate">0 and "emdo"."finance_economic_transactions"."native_amount"<>'NaN'::numeric and "emdo"."finance_economic_transactions"."functional_amount"<>'NaN'::numeric and "emdo"."finance_economic_transactions"."fx_rate"<>'NaN'::numeric),
	CONSTRAINT "finance_economic_transactions_hashes" CHECK ("emdo"."finance_economic_transactions"."fingerprint" ~ '^[0-9a-f]{64}$' and "emdo"."finance_economic_transactions"."facts_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_financial_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"currency" text NOT NULL,
	"ledger_account_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "finance_financial_accounts_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_financial_accounts_ledger" UNIQUE("workspace_id","book_id","ledger_account_id"),
	CONSTRAINT "finance_financial_accounts_kind" CHECK ("emdo"."finance_financial_accounts"."kind" in ('bank','brokerage','credit-card','cash')),
	CONSTRAINT "finance_financial_accounts_currency" CHECK ("emdo"."finance_financial_accounts"."currency" in ('CAD','USD','MXN','EUR','JPY','KRW'))
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_import_row_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"decision" jsonb NOT NULL,
	"previous_facts" jsonb NOT NULL,
	"reviewed_by" uuid NOT NULL,
	CONSTRAINT "finance_import_row_reviews_revision" UNIQUE("workspace_id","book_id","row_id","revision"),
	CONSTRAINT "finance_import_row_reviews_version" CHECK ("emdo"."finance_import_row_reviews"."revision">1)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_normalized_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"source_row" integer NOT NULL,
	"source_facts" jsonb NOT NULL,
	"effective_on" date,
	"description" text NOT NULL,
	"native_amount" numeric(38, 12),
	"external_id" text,
	"issues" jsonb NOT NULL,
	"status" text DEFAULT 'review' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"counter_account_id" uuid,
	"match_journal_id" uuid,
	"fx_rate" numeric(38, 12),
	"fx_source" text,
	"economic_transaction_id" uuid,
	CONSTRAINT "finance_normalized_import_rows_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_normalized_import_rows_source" UNIQUE("workspace_id","book_id","batch_id","source_row"),
	CONSTRAINT "finance_normalized_import_rows_status" CHECK ("emdo"."finance_normalized_import_rows"."status" in ('invalid','review','ready','ignored','committed','matched')),
	CONSTRAINT "finance_normalized_import_rows_revision" CHECK ("emdo"."finance_normalized_import_rows"."revision">0 and "emdo"."finance_normalized_import_rows"."source_row">0)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_normalized_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book_id" uuid NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"mapping" jsonb NOT NULL,
	"parser_version" text NOT NULL,
	"status" text DEFAULT 'review' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "finance_normalized_imports_scope" UNIQUE("workspace_id","book_id","id"),
	CONSTRAINT "finance_normalized_imports_status" CHECK ("emdo"."finance_normalized_imports"."status" in ('review','committed')),
	CONSTRAINT "finance_normalized_imports_revision" CHECK ("emdo"."finance_normalized_imports"."revision">0)
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_book_evidence" ADD CONSTRAINT "finance_book_evidence_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_book_evidence" ADD CONSTRAINT "finance_book_evidence_uploaded_by_auth_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_book_evidence" ADD CONSTRAINT "finance_book_evidence_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_economic_transactions" ADD CONSTRAINT "finance_economic_transactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_economic_transactions" ADD CONSTRAINT "finance_economic_transactions_account" FOREIGN KEY ("workspace_id","book_id","financial_account_id") REFERENCES "emdo"."finance_financial_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_economic_transactions" ADD CONSTRAINT "finance_economic_transactions_journal" FOREIGN KEY ("workspace_id","book_id","journal_id") REFERENCES "emdo"."finance_journals"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_financial_accounts" ADD CONSTRAINT "finance_financial_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_financial_accounts" ADD CONSTRAINT "finance_financial_accounts_book" FOREIGN KEY ("workspace_id","book_id") REFERENCES "emdo"."finance_books"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_financial_accounts" ADD CONSTRAINT "finance_financial_accounts_ledger_fk" FOREIGN KEY ("workspace_id","book_id","ledger_account_id") REFERENCES "emdo"."finance_ledger_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_import_row_reviews" ADD CONSTRAINT "finance_import_row_reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_import_row_reviews" ADD CONSTRAINT "finance_import_row_reviews_reviewed_by_auth_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "emdo"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_import_row_reviews" ADD CONSTRAINT "finance_import_row_reviews_row" FOREIGN KEY ("workspace_id","book_id","row_id") REFERENCES "emdo"."finance_normalized_import_rows"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_normalized_import_rows" ADD CONSTRAINT "finance_normalized_import_rows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_normalized_import_rows" ADD CONSTRAINT "finance_normalized_import_rows_batch" FOREIGN KEY ("workspace_id","book_id","batch_id") REFERENCES "emdo"."finance_normalized_imports"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_normalized_import_rows" ADD CONSTRAINT "finance_normalized_import_rows_counter" FOREIGN KEY ("workspace_id","book_id","counter_account_id") REFERENCES "emdo"."finance_ledger_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_normalized_import_rows" ADD CONSTRAINT "finance_normalized_import_rows_journal" FOREIGN KEY ("workspace_id","book_id","match_journal_id") REFERENCES "emdo"."finance_journals"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_normalized_import_rows" ADD CONSTRAINT "finance_normalized_import_rows_transaction" FOREIGN KEY ("workspace_id","book_id","economic_transaction_id") REFERENCES "emdo"."finance_economic_transactions"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_normalized_imports" ADD CONSTRAINT "finance_normalized_imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "emdo"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_normalized_imports" ADD CONSTRAINT "finance_normalized_imports_account" FOREIGN KEY ("workspace_id","book_id","financial_account_id") REFERENCES "emdo"."finance_financial_accounts"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emdo"."finance_normalized_imports" ADD CONSTRAINT "finance_normalized_imports_evidence" FOREIGN KEY ("workspace_id","book_id","evidence_id") REFERENCES "emdo"."finance_book_evidence"("workspace_id","book_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_economic_transactions_match" ON "emdo"."finance_economic_transactions" USING btree ("workspace_id","book_id","financial_account_id","effective_on");
--> statement-breakpoint
-- These tables are not exposed by the application until the durable review and
-- commit adapter is complete. Force isolation from their first migration.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['finance_financial_accounts','finance_book_evidence','finance_normalized_imports','finance_normalized_import_rows','finance_import_row_reviews','finance_economic_transactions'] LOOP
    EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow',t);
    EXECUTE format('GRANT SELECT,INSERT ON emdo.%I TO emdo_app',t);
    EXECUTE format('CREATE POLICY %I ON emdo.%I FOR SELECT TO emdo_app USING (emdo.finance_book_access(workspace_id,book_id))',t||'_read',t);
    EXECUTE format('CREATE POLICY %I ON emdo.%I FOR INSERT TO emdo_app WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY[''administrator'',''preparer'',''approver'']))',t||'_insert',t);
    EXECUTE format('CREATE TRIGGER a_lock_book BEFORE INSERT OR UPDATE ON emdo.%I FOR EACH ROW EXECUTE FUNCTION emdo.lock_finance_book_mutation()',t);
  END LOOP;
END $$;
CREATE FUNCTION emdo.check_financial_account() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM emdo.finance_ledger_accounts WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.ledger_account_id
    AND active AND kind=CASE NEW.kind WHEN 'credit-card' THEN 'liability' ELSE 'asset' END) THEN
    RAISE EXCEPTION 'financial account requires a valid asset or liability ledger account' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_financial_account BEFORE INSERT ON emdo.finance_financial_accounts FOR EACH ROW EXECUTE FUNCTION emdo.check_financial_account();
CREATE FUNCTION emdo.check_book_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.uploaded_by IS DISTINCT FROM emdo.current_user_id() OR NEW.format NOT IN ('csv','ofx','qfx') OR
    NEW.encrypted_original->>'algorithm' IS DISTINCT FROM 'aes-256-gcm' OR NEW.encrypted_original->>'schemaVersion' IS DISTINCT FROM '1'
    OR NEW.encrypted_original->>'aadVersion' IS DISTINCT FROM '1'
    OR coalesce(NEW.encrypted_original->>'ciphertext','') !~ '^[A-Za-z0-9_-]+$'
    OR coalesce(NEW.encrypted_original->>'nonce','') !~ '^[A-Za-z0-9_-]{16}$'
    OR coalesce(NEW.encrypted_original->>'authenticationTag','') !~ '^[A-Za-z0-9_-]{22}$'
    OR coalesce(NEW.encrypted_original->>'wrappedKey','') !~ '^[A-Za-z0-9_-]+$'
    OR coalesce(NEW.encrypted_original->>'keyVersion','') !~ '^finance-documents\.v[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'book evidence requires an authenticated encrypted original' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_book_evidence BEFORE INSERT ON emdo.finance_book_evidence FOR EACH ROW EXECUTE FUNCTION emdo.check_book_evidence();
CREATE FUNCTION emdo.check_economic_transaction() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE account emdo.finance_financial_accounts; functional text; native_precision integer; functional_precision integer; matched boolean;
BEGIN
  IF NOT emdo.finance_book_access(NEW.workspace_id,NEW.book_id,ARRAY['administrator','approver']) THEN RAISE EXCEPTION 'transaction commit requires approval authority' USING ERRCODE='42501'; END IF;
  SELECT * INTO account FROM emdo.finance_financial_accounts WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.financial_account_id AND active;
  SELECT functional_currency INTO functional FROM emdo.finance_books WHERE workspace_id=NEW.workspace_id AND id=NEW.book_id;
  IF account.id IS NULL THEN RAISE EXCEPTION 'financial account unavailable' USING ERRCODE='23514'; END IF;
  native_precision:=CASE WHEN account.currency IN ('JPY','KRW') THEN 0 ELSE 2 END;
  functional_precision:=CASE WHEN functional IN ('JPY','KRW') THEN 0 ELSE 2 END;
  IF NEW.native_amount<>round(NEW.native_amount,native_precision) OR NEW.functional_amount<>round(NEW.functional_amount,functional_precision)
    OR NEW.functional_amount<>round(NEW.native_amount*NEW.fx_rate,functional_precision) OR (account.currency=functional AND NEW.fx_rate<>1) THEN
    RAISE EXCEPTION 'economic transaction monetary precision or FX mismatch' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM emdo.finance_journals WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.journal_id AND status='posted' AND effective_on=NEW.effective_on) THEN
    RAISE EXCEPTION 'economic transaction requires a posted journal' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(CASE side WHEN 'debit' THEN amount ELSE -amount END),0)=NEW.functional_amount
    AND coalesce(sum(CASE side WHEN 'debit' THEN native_amount ELSE -native_amount END),0)=NEW.native_amount
    AND bool_and(currency=account.currency AND fx_rate=NEW.fx_rate)
    INTO matched FROM emdo.finance_journal_lines WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND journal_id=NEW.journal_id AND account_id=account.ledger_account_id;
  IF matched IS DISTINCT FROM true THEN RAISE EXCEPTION 'economic transaction does not match ledger account movements' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM emdo.finance_economic_transactions WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND financial_account_id=NEW.financial_account_id AND journal_id=NEW.journal_id) THEN RAISE EXCEPTION 'journal account movement already has an economic transaction' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_economic_transaction BEFORE INSERT ON emdo.finance_economic_transactions FOR EACH ROW EXECUTE FUNCTION emdo.check_economic_transaction();
REVOKE ALL ON FUNCTION emdo.check_financial_account(),emdo.check_book_evidence(),emdo.check_economic_transaction() FROM PUBLIC;

GRANT UPDATE ON emdo.finance_normalized_imports,emdo.finance_normalized_import_rows TO emdo_app;
CREATE POLICY normalized_batch_update ON emdo.finance_normalized_imports FOR UPDATE TO emdo_app
USING (emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','preparer','approver']))
WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','preparer','approver']));
CREATE POLICY normalized_row_update ON emdo.finance_normalized_import_rows FOR UPDATE TO emdo_app
USING (emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','preparer','approver']))
WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','preparer','approver']));

CREATE FUNCTION emdo.check_normalized_batch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'review' OR NEW.revision<>1 THEN RAISE EXCEPTION 'import must start in review' USING ERRCODE='23514'; END IF;
  ELSE
    IF OLD.status='committed' OR NEW.revision<>OLD.revision+1 OR
      (NEW.id,NEW.workspace_id,NEW.book_id,NEW.created_at,NEW.financial_account_id,NEW.evidence_id,NEW.mapping,NEW.parser_version) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.book_id,OLD.created_at,OLD.financial_account_id,OLD.evidence_id,OLD.mapping,OLD.parser_version) THEN
      RAISE EXCEPTION 'import identity or committed history is immutable' USING ERRCODE='23514'; END IF;
    IF NEW.status='committed' THEN
      IF NOT emdo.finance_book_access(NEW.workspace_id,NEW.book_id,ARRAY['administrator','approver']) THEN RAISE EXCEPTION 'import commit requires approval authority' USING ERRCODE='42501'; END IF;
      IF NOT EXISTS(SELECT 1 FROM emdo.finance_normalized_import_rows WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND batch_id=NEW.id)
        OR EXISTS(SELECT 1 FROM emdo.finance_normalized_import_rows WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND batch_id=NEW.id AND status NOT IN ('committed','matched','ignored')) THEN
        RAISE EXCEPTION 'import still has unresolved rows' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_normalized_batch BEFORE INSERT OR UPDATE ON emdo.finance_normalized_imports FOR EACH ROW EXECUTE FUNCTION emdo.check_normalized_batch();

CREATE FUNCTION emdo.check_import_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE current_row emdo.finance_normalized_import_rows;
BEGIN
  SELECT * INTO current_row FROM emdo.finance_normalized_import_rows WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.row_id;
  IF NEW.reviewed_by IS DISTINCT FROM emdo.current_user_id() OR current_row.id IS NULL OR NEW.revision<>current_row.revision+1
    OR coalesce(NEW.decision->>'action','') NOT IN ('post','match','ignore') OR length(coalesce(NEW.decision->>'reason',''))<3
    OR NEW.previous_facts IS DISTINCT FROM jsonb_build_object('date',current_row.effective_on::text,'description',current_row.description,'amount',current_row.native_amount::text,'externalId',current_row.external_id)
    OR NOT EXISTS(SELECT 1 FROM emdo.finance_normalized_imports WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=current_row.batch_id AND status='review') THEN
    RAISE EXCEPTION 'review revision or provenance is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_import_review BEFORE INSERT ON emdo.finance_import_row_reviews FOR EACH ROW EXECUTE FUNCTION emdo.check_import_review();

CREATE FUNCTION emdo.check_normalized_row() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE review jsonb; batch emdo.finance_normalized_imports; account emdo.finance_financial_accounts; functional text; precision integer;
BEGIN
  SELECT * INTO batch FROM emdo.finance_normalized_imports WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.batch_id;
  IF batch.id IS NULL OR batch.status<>'review' THEN RAISE EXCEPTION 'committed import rows are immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NEW.status NOT IN ('review','invalid') OR NEW.economic_transaction_id IS NOT NULL
      OR NEW.counter_account_id IS NOT NULL OR NEW.match_journal_id IS NOT NULL OR NEW.fx_rate IS NOT NULL OR NEW.fx_source IS NOT NULL THEN
      RAISE EXCEPTION 'import row must start unreviewed' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.workspace_id,NEW.book_id,NEW.created_at,NEW.batch_id,NEW.source_row,NEW.source_facts) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.book_id,OLD.created_at,OLD.batch_id,OLD.source_row,OLD.source_facts)
    OR OLD.status IN ('committed','matched') THEN RAISE EXCEPTION 'import row evidence is immutable' USING ERRCODE='23514'; END IF;
  SELECT * INTO account FROM emdo.finance_financial_accounts WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=batch.financial_account_id;
  IF NEW.status IN ('committed','matched') THEN
    IF OLD.status<>'ready' OR NEW.revision<>OLD.revision OR NOT emdo.finance_book_access(NEW.workspace_id,NEW.book_id,ARRAY['administrator','approver'])
      OR (NEW.effective_on,NEW.description,NEW.native_amount,NEW.external_id,NEW.issues,NEW.counter_account_id,NEW.match_journal_id,NEW.fx_rate,NEW.fx_source)
      IS DISTINCT FROM (OLD.effective_on,OLD.description,OLD.native_amount,OLD.external_id,OLD.issues,OLD.counter_account_id,OLD.match_journal_id,OLD.fx_rate,OLD.fx_source)
      OR NOT EXISTS(SELECT 1 FROM emdo.finance_economic_transactions t WHERE t.workspace_id=NEW.workspace_id AND t.book_id=NEW.book_id AND t.id=NEW.economic_transaction_id
        AND t.financial_account_id=batch.financial_account_id AND t.effective_on=NEW.effective_on AND t.native_amount=NEW.native_amount AND t.fx_rate=NEW.fx_rate) THEN
      RAISE EXCEPTION 'import commit must match reviewed facts and saved transaction' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  SELECT decision INTO review FROM emdo.finance_import_row_reviews WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND row_id=NEW.id AND revision=NEW.revision AND reviewed_by=emdo.current_user_id();
  IF NEW.revision<>OLD.revision+1 OR review IS NULL OR NEW.economic_transaction_id IS NOT NULL
    OR NEW.effective_on IS DISTINCT FROM coalesce((review->'correction'->>'date')::date,OLD.effective_on)
    OR NEW.native_amount IS DISTINCT FROM coalesce((review->'correction'->>'amount')::numeric,OLD.native_amount)
    OR NEW.description IS DISTINCT FROM coalesce(review->'correction'->>'description',OLD.description)
    OR NEW.external_id IS DISTINCT FROM (CASE WHEN (review->'correction') ? 'externalId' THEN review->'correction'->>'externalId' ELSE OLD.external_id END) THEN
    RAISE EXCEPTION 'import changes require a matching review revision' USING ERRCODE='23514'; END IF;
  IF review->>'action'='ignore' THEN
    IF NEW.status<>'ignored' OR NEW.counter_account_id IS NOT NULL OR NEW.match_journal_id IS NOT NULL THEN RAISE EXCEPTION 'ignored row cannot post' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  SELECT functional_currency INTO functional FROM emdo.finance_books WHERE workspace_id=NEW.workspace_id AND id=NEW.book_id;
  precision:=CASE WHEN account.currency IN ('JPY','KRW') THEN 0 ELSE 2 END;
  IF NEW.status<>'ready' OR NEW.effective_on IS NULL OR NEW.native_amount IS NULL OR NEW.native_amount=0 OR NEW.native_amount='NaN'::numeric
    OR NEW.native_amount<>round(NEW.native_amount,precision) OR length(NEW.description)=0 OR NEW.issues IS DISTINCT FROM '[]'::jsonb
    OR NEW.fx_rate IS NULL OR NEW.fx_rate<=0 OR NEW.fx_rate='NaN'::numeric OR length(coalesce(NEW.fx_source,''))=0
    OR (account.currency=functional AND (NEW.fx_rate<>1 OR NEW.fx_source<>'identity'))
    OR (account.currency<>functional AND (NEW.fx_rate IS DISTINCT FROM (review->>'fxRate')::numeric OR NEW.fx_source IS DISTINCT FROM review->>'fxSource'))
    OR (review->>'action'='post' AND (NEW.counter_account_id IS NULL OR NEW.counter_account_id=account.ledger_account_id OR NEW.match_journal_id IS NOT NULL))
    OR (review->>'action'='match' AND (NEW.match_journal_id IS NULL OR NEW.counter_account_id IS NOT NULL))
    OR NEW.counter_account_id IS DISTINCT FROM (review->>'counterAccountId')::uuid OR NEW.match_journal_id IS DISTINCT FROM (review->>'matchJournalId')::uuid THEN
    RAISE EXCEPTION 'reviewed import row is incomplete or invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_normalized_row BEFORE INSERT OR UPDATE ON emdo.finance_normalized_import_rows FOR EACH ROW EXECUTE FUNCTION emdo.check_normalized_row();
REVOKE ALL ON FUNCTION emdo.check_normalized_batch(),emdo.check_import_review(),emdo.check_normalized_row() FROM PUBLIC;
