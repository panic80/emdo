-- 0061 France FEC persistence.
--
-- FEC metadata is a reviewed, book-scoped input. A new revision is built in
-- one transaction: the reviewed header and every journal/account mapping row
-- carry the same server-assigned transaction marker. The history is immutable
-- after commit, so a later insert cannot silently extend a reviewed revision.

CREATE TABLE "emdo"."finance_fec_book_mapping_revisions" (
  "workspace_id" uuid NOT NULL,
  "book_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "siren" text NOT NULL,
  "siren_source_reference" text NOT NULL,
  "siren_source_digest" text NOT NULL,
  "opening_status" text NOT NULL,
  "opening_source_reference" text NOT NULL,
  "opening_source_digest" text NOT NULL,
  "reviewed_by" uuid DEFAULT emdo.current_user_id() NOT NULL,
  "reviewed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "created_by" uuid DEFAULT emdo.current_user_id() NOT NULL,
  "created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "fec_construction_txid" xid8 DEFAULT pg_current_xact_id() NOT NULL,
  CONSTRAINT "finance_fec_book_mapping_revisions_pk" PRIMARY KEY ("workspace_id","book_id","revision"),
  CONSTRAINT "finance_fec_book_mapping_revisions_revision" CHECK ("revision" > 0),
  CONSTRAINT "finance_fec_book_mapping_revisions_siren" CHECK ("siren" ~ '^[0-9]{9}$'),
  CONSTRAINT "finance_fec_book_mapping_revisions_sources" CHECK (
    length(btrim("siren_source_reference")) BETWEEN 1 AND 500
    AND "siren_source_reference" !~ '[[:cntrl:]]'
    AND "siren_source_digest" ~ '^[a-f0-9]{64}$'
    AND "opening_status" IN ('included','not-applicable')
    AND length(btrim("opening_source_reference")) BETWEEN 1 AND 500
    AND "opening_source_reference" !~ '[[:cntrl:]]'
    AND "opening_source_digest" ~ '^[a-f0-9]{64}$'
  )
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_fec_journal_mappings" (
  "workspace_id" uuid NOT NULL,
  "book_id" uuid NOT NULL,
  "journal_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "entry_sequence" integer NOT NULL,
  "entry_number" text NOT NULL,
  "entry_kind" text NOT NULL,
  "journal_code" text NOT NULL,
  "journal_label" text NOT NULL,
  "piece_reference" text NOT NULL,
  "piece_date" date NOT NULL,
  "entry_label" text NOT NULL,
  "validation_date" date NOT NULL,
  "reviewed_by" uuid DEFAULT emdo.current_user_id() NOT NULL,
  "reviewed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "created_by" uuid DEFAULT emdo.current_user_id() NOT NULL,
  "created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "fec_construction_txid" xid8 DEFAULT pg_current_xact_id() NOT NULL,
  CONSTRAINT "finance_fec_journal_mappings_pk" PRIMARY KEY ("workspace_id","book_id","journal_id","revision"),
  CONSTRAINT "finance_fec_journal_mappings_revision" CHECK ("revision" > 0),
  CONSTRAINT "finance_fec_journal_mappings_entry_sequence" CHECK ("entry_sequence" > 0),
  CONSTRAINT "finance_fec_journal_mappings_kind" CHECK ("entry_kind" IN ('opening','normal','inventory')),
  CONSTRAINT "finance_fec_journal_mappings_text" CHECK (
    length(btrim("entry_number")) BETWEEN 1 AND 200
    AND "entry_number" !~ '[[:cntrl:]]'
    AND length(btrim("journal_code")) BETWEEN 1 AND 200
    AND "journal_code" !~ '[[:cntrl:]]'
    AND length(btrim("journal_label")) BETWEEN 1 AND 500
    AND "journal_label" !~ '[[:cntrl:]]'
    AND length(btrim("piece_reference")) BETWEEN 1 AND 500
    AND "piece_reference" !~ '[[:cntrl:]]'
    AND length(btrim("entry_label")) BETWEEN 1 AND 2000
    AND "entry_label" !~ '[[:cntrl:]]'
  )
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_fec_account_mappings" (
  "workspace_id" uuid NOT NULL,
  "book_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "account_number" text NOT NULL,
  "account_label" text NOT NULL,
  "auxiliary_account_number" text,
  "auxiliary_account_label" text,
  "reviewed_by" uuid DEFAULT emdo.current_user_id() NOT NULL,
  "reviewed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "created_by" uuid DEFAULT emdo.current_user_id() NOT NULL,
  "created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "fec_construction_txid" xid8 DEFAULT pg_current_xact_id() NOT NULL,
  CONSTRAINT "finance_fec_account_mappings_pk" PRIMARY KEY ("workspace_id","book_id","account_id","revision"),
  CONSTRAINT "finance_fec_account_mappings_revision" CHECK ("revision" > 0),
  CONSTRAINT "finance_fec_account_mappings_account" CHECK (
    length(btrim("account_number")) BETWEEN 3 AND 100
    AND btrim("account_number") ~ '^[0-9]{3}'
    AND "account_number" !~ '[[:cntrl:]]'
    AND length(btrim("account_label")) BETWEEN 1 AND 500
    AND "account_label" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "finance_fec_account_mappings_auxiliary_pair" CHECK ((
    ("auxiliary_account_number" IS NULL AND "auxiliary_account_label" IS NULL)
    OR (
      length(btrim("auxiliary_account_number")) BETWEEN 1 AND 100
      AND "auxiliary_account_number" !~ '[[:cntrl:]]'
      AND length(btrim("auxiliary_account_label")) BETWEEN 1 AND 500
      AND "auxiliary_account_label" !~ '[[:cntrl:]]'
    )
  ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "emdo"."finance_fec_export_receipts" (
  "workspace_id" uuid NOT NULL,
  "book_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "mapping_revision" integer NOT NULL,
  "period_starts_on" date NOT NULL,
  "period_ends_on" date NOT NULL,
  "request_hash" text NOT NULL,
  "result_hash" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_by" uuid DEFAULT emdo.current_user_id() NOT NULL,
  "created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "finance_fec_export_receipts_pk" PRIMARY KEY ("workspace_id","book_id","idempotency_key"),
  CONSTRAINT "finance_fec_export_receipts_key" CHECK ("idempotency_key" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT "finance_fec_export_receipts_revision" CHECK ("mapping_revision" > 0),
  CONSTRAINT "finance_fec_export_receipts_period" CHECK ("period_starts_on" <= "period_ends_on"),
  CONSTRAINT "finance_fec_export_receipts_hashes" CHECK (
    "request_hash" ~ '^[a-f0-9]{64}$' AND "result_hash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "finance_fec_export_receipts_shape" CHECK ((
    pg_catalog.jsonb_typeof("result") = 'object'
    AND "result"->>'status' = 'ready'
    AND pg_catalog.jsonb_typeof("result"->'review') = 'object'
    AND "result"->'review'->>'status' = 'ready'
    AND pg_catalog.jsonb_typeof("result"->'review'->'errors') = 'array'
    AND CASE
      WHEN pg_catalog.jsonb_typeof("result"->'review'->'errors') = 'array'
      THEN pg_catalog.jsonb_array_length("result"->'review'->'errors') = 0
      ELSE false
    END
    AND pg_catalog.jsonb_typeof("result"->'review'->'entryCount') = 'number'
    AND pg_catalog.jsonb_typeof("result"->'review'->'lineCount') = 'number'
    AND pg_catalog.jsonb_typeof("result"->'review'->'fileName') = 'string'
    AND pg_catalog.jsonb_typeof("result"->'review'->'sourceLineage') = 'array'
    AND pg_catalog.jsonb_typeof("result"->'review'->'standard') = 'object'
    AND pg_catalog.jsonb_typeof("result"->'file') = 'object'
    AND pg_catalog.jsonb_typeof("result"->'file'->'fileName') = 'string'
    AND pg_catalog.jsonb_typeof("result"->'file'->'content') = 'string'
    AND pg_catalog.jsonb_typeof("result"->'file'->'byteLength') = 'number'
    AND pg_catalog.jsonb_typeof("result"->'file'->'columns') = 'array'
    AND CASE
      WHEN pg_catalog.jsonb_typeof("result"->'file'->'columns') = 'array'
      THEN pg_catalog.jsonb_array_length("result"->'file'->'columns') = 18
      ELSE false
    END
    AND "result"->'file'->>'encoding' = 'UTF-8'
    AND "result"->'file'->>'separator' = E'\t'
    AND "result"->'file'->>'lineEnding' = E'\r\n'
    AND pg_catalog.jsonb_typeof("result"->'sourceLineage') = 'array'
    AND "result"->'sourceLineage' = "result"->'review'->'sourceLineage'
    AND pg_catalog.octet_length("result"::text) <= 8000000
  ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "emdo"."finance_fec_book_mapping_revisions"
  ADD CONSTRAINT "finance_fec_book_mapping_revisions_book"
  FOREIGN KEY ("workspace_id","book_id")
  REFERENCES "emdo"."finance_books"("workspace_id","id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_fec_book_mapping_revisions"
  ADD CONSTRAINT "finance_fec_book_mapping_revisions_reviewer"
  FOREIGN KEY ("reviewed_by") REFERENCES "emdo"."auth_users"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_fec_book_mapping_revisions"
  ADD CONSTRAINT "finance_fec_book_mapping_revisions_creator"
  FOREIGN KEY ("created_by") REFERENCES "emdo"."auth_users"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_fec_journal_mappings"
  ADD CONSTRAINT "finance_fec_journal_mappings_book"
  FOREIGN KEY ("workspace_id","book_id")
  REFERENCES "emdo"."finance_books"("workspace_id","id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_fec_journal_mappings"
  ADD CONSTRAINT "finance_fec_journal_mappings_header"
  FOREIGN KEY ("workspace_id","book_id","revision")
  REFERENCES "emdo"."finance_fec_book_mapping_revisions"("workspace_id","book_id","revision")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_fec_journal_mappings"
  ADD CONSTRAINT "finance_fec_journal_mappings_journal"
  FOREIGN KEY ("workspace_id","book_id","journal_id")
  REFERENCES "emdo"."finance_journals"("workspace_id","book_id","id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_fec_journal_mappings"
  ADD CONSTRAINT "finance_fec_journal_mappings_reviewer"
  FOREIGN KEY ("reviewed_by") REFERENCES "emdo"."auth_users"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_fec_journal_mappings"
  ADD CONSTRAINT "finance_fec_journal_mappings_creator"
  FOREIGN KEY ("created_by") REFERENCES "emdo"."auth_users"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_fec_account_mappings"
  ADD CONSTRAINT "finance_fec_account_mappings_book"
  FOREIGN KEY ("workspace_id","book_id")
  REFERENCES "emdo"."finance_books"("workspace_id","id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_fec_account_mappings"
  ADD CONSTRAINT "finance_fec_account_mappings_header"
  FOREIGN KEY ("workspace_id","book_id","revision")
  REFERENCES "emdo"."finance_fec_book_mapping_revisions"("workspace_id","book_id","revision")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_fec_account_mappings"
  ADD CONSTRAINT "finance_fec_account_mappings_account_fk"
  FOREIGN KEY ("workspace_id","book_id","account_id")
  REFERENCES "emdo"."finance_ledger_accounts"("workspace_id","book_id","id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_fec_account_mappings"
  ADD CONSTRAINT "finance_fec_account_mappings_reviewer"
  FOREIGN KEY ("reviewed_by") REFERENCES "emdo"."auth_users"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_fec_account_mappings"
  ADD CONSTRAINT "finance_fec_account_mappings_creator"
  FOREIGN KEY ("created_by") REFERENCES "emdo"."auth_users"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_fec_export_receipts"
  ADD CONSTRAINT "finance_fec_export_receipts_book"
  FOREIGN KEY ("workspace_id","book_id")
  REFERENCES "emdo"."finance_books"("workspace_id","id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_fec_export_receipts"
  ADD CONSTRAINT "finance_fec_export_receipts_header"
  FOREIGN KEY ("workspace_id","book_id","mapping_revision")
  REFERENCES "emdo"."finance_fec_book_mapping_revisions"("workspace_id","book_id","revision")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "emdo"."finance_fec_export_receipts"
  ADD CONSTRAINT "finance_fec_export_receipts_creator"
  FOREIGN KEY ("created_by") REFERENCES "emdo"."auth_users"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX "finance_fec_journal_mappings_entry_sequence"
  ON "emdo"."finance_fec_journal_mappings" ("workspace_id","book_id","revision","entry_sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "finance_fec_journal_mappings_entry_number"
  ON "emdo"."finance_fec_journal_mappings" ("workspace_id","book_id","revision",btrim("entry_number"));
--> statement-breakpoint
CREATE INDEX "finance_fec_journal_mappings_revision"
  ON "emdo"."finance_fec_journal_mappings" ("workspace_id","book_id","revision","journal_id");
--> statement-breakpoint
CREATE INDEX "finance_fec_account_mappings_revision"
  ON "emdo"."finance_fec_account_mappings" ("workspace_id","book_id","revision","account_id");
--> statement-breakpoint
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'finance_fec_book_mapping_revisions',
    'finance_fec_journal_mappings',
    'finance_fec_account_mappings',
    'finance_fec_export_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow', table_name);
    EXECUTE format('GRANT SELECT ON emdo.%I TO emdo_policy_reader', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON emdo.%I FOR SELECT TO emdo_policy_reader USING (true)',
      table_name || '_policy_reader', table_name
    );
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT ON emdo.finance_fec_book_mapping_revisions,
  emdo.finance_fec_journal_mappings,
  emdo.finance_fec_account_mappings,
  emdo.finance_fec_export_receipts TO emdo_app;
--> statement-breakpoint
CREATE POLICY finance_fec_book_mapping_revisions_read
  ON emdo.finance_fec_book_mapping_revisions FOR SELECT TO emdo_app
  USING (emdo.finance_book_access(workspace_id,book_id));
--> statement-breakpoint
CREATE POLICY finance_fec_book_mapping_revisions_insert
  ON emdo.finance_fec_book_mapping_revisions FOR INSERT TO emdo_app
  WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','approver']));
--> statement-breakpoint
CREATE POLICY finance_fec_journal_mappings_read
  ON emdo.finance_fec_journal_mappings FOR SELECT TO emdo_app
  USING (emdo.finance_book_access(workspace_id,book_id));
--> statement-breakpoint
CREATE POLICY finance_fec_journal_mappings_insert
  ON emdo.finance_fec_journal_mappings FOR INSERT TO emdo_app
  WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','approver']));
--> statement-breakpoint
CREATE POLICY finance_fec_account_mappings_read
  ON emdo.finance_fec_account_mappings FOR SELECT TO emdo_app
  USING (emdo.finance_book_access(workspace_id,book_id));
--> statement-breakpoint
CREATE POLICY finance_fec_account_mappings_insert
  ON emdo.finance_fec_account_mappings FOR INSERT TO emdo_app
  WITH CHECK (emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','approver']));
--> statement-breakpoint
CREATE POLICY finance_fec_export_receipts_read
  ON emdo.finance_fec_export_receipts FOR SELECT TO emdo_app
  USING (emdo.finance_book_access(workspace_id,book_id));
--> statement-breakpoint
CREATE POLICY finance_fec_export_receipts_insert
  ON emdo.finance_fec_export_receipts FOR INSERT TO emdo_app
  WITH CHECK (emdo.finance_book_access(workspace_id,book_id));
--> statement-breakpoint
CREATE FUNCTION emdo.enforce_finance_fec_book_mapping_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, emdo
SET row_security = on
AS $$
DECLARE
  actor uuid;
  stamp timestamptz;
  functional_currency text;
BEGIN
  actor := emdo.current_user_id();
  IF actor IS NULL THEN
    RAISE EXCEPTION 'finance-fec-reviewer-required' USING ERRCODE='42501';
  END IF;
  IF NOT emdo.lock_finance_book_grant(NEW.workspace_id,NEW.book_id) THEN
    RAISE EXCEPTION 'finance-fec-book-forbidden' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.workspace_id::text || ':' || NEW.book_id::text,0)
  );
  IF NOT emdo.finance_book_access(NEW.workspace_id,NEW.book_id,ARRAY['administrator','approver']) THEN
    RAISE EXCEPTION 'finance-fec-review-authority-required' USING ERRCODE='42501';
  END IF;
  SELECT b.functional_currency INTO functional_currency
    FROM emdo.finance_books b
   WHERE b.workspace_id=NEW.workspace_id AND b.id=NEW.book_id;
  IF functional_currency IS DISTINCT FROM 'EUR' THEN
    RAISE EXCEPTION 'finance-fec-functional-currency-required' USING ERRCODE='23514';
  END IF;
  stamp := pg_catalog.clock_timestamp();
  NEW.created_by := actor;
  NEW.created_at := stamp;
  NEW.reviewed_by := actor;
  NEW.reviewed_at := stamp;
  NEW.fec_construction_txid := pg_catalog.pg_current_xact_id();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE FUNCTION emdo.enforce_finance_fec_child_mapping()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, emdo
SET row_security = on
AS $$
DECLARE
  actor uuid;
  stamp timestamptz;
  parent_txid xid8;
  journal_effective_on date;
BEGIN
  actor := emdo.current_user_id();
  IF actor IS NULL THEN
    RAISE EXCEPTION 'finance-fec-reviewer-required' USING ERRCODE='42501';
  END IF;
  IF NOT emdo.lock_finance_book_grant(NEW.workspace_id,NEW.book_id) THEN
    RAISE EXCEPTION 'finance-fec-book-forbidden' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.workspace_id::text || ':' || NEW.book_id::text,0)
  );
  IF NOT emdo.finance_book_access(NEW.workspace_id,NEW.book_id,ARRAY['administrator','approver']) THEN
    RAISE EXCEPTION 'finance-fec-review-authority-required' USING ERRCODE='42501';
  END IF;
  SELECT h.fec_construction_txid INTO parent_txid
    FROM emdo.finance_fec_book_mapping_revisions h
   WHERE h.workspace_id=NEW.workspace_id
     AND h.book_id=NEW.book_id
     AND h.revision=NEW.revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finance-fec-mapping-header-required' USING ERRCODE='23514';
  END IF;
  IF parent_txid IS DISTINCT FROM pg_catalog.pg_current_xact_id() THEN
    RAISE EXCEPTION 'finance-fec-mapping-append-after-review' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME = 'finance_fec_journal_mappings' THEN
    SELECT j.effective_on INTO journal_effective_on
      FROM emdo.finance_journals j
     WHERE j.workspace_id=NEW.workspace_id
       AND j.book_id=NEW.book_id
       AND j.id=NEW.journal_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finance-fec-journal-required' USING ERRCODE='23514';
    END IF;
    IF NEW.validation_date < journal_effective_on THEN
      RAISE EXCEPTION 'finance-fec-validation-date-before-accounting-date' USING ERRCODE='23514';
    END IF;
  END IF;
  stamp := pg_catalog.clock_timestamp();
  NEW.created_by := actor;
  NEW.created_at := stamp;
  NEW.reviewed_by := actor;
  NEW.reviewed_at := stamp;
  NEW.fec_construction_txid := pg_catalog.pg_current_xact_id();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE FUNCTION emdo.enforce_finance_fec_export_receipt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, emdo
SET row_security = on
AS $$
DECLARE
  actor uuid;
  stamp timestamptz;
  functional_currency text;
  mapping_siren text;
  mapping_reviewed_at timestamptz;
  expected_request_hash text;
  content text;
  expected_entry_count integer;
  expected_line_count integer;
  result_entry_count integer;
  result_line_count integer;
  expected_file_name text;
BEGIN
  actor := emdo.current_user_id();
  IF actor IS NULL THEN
    RAISE EXCEPTION 'finance-fec-export-actor-required' USING ERRCODE='42501';
  END IF;
  IF NOT emdo.lock_finance_book_grant(NEW.workspace_id,NEW.book_id) THEN
    RAISE EXCEPTION 'finance-fec-book-forbidden' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.workspace_id::text || ':' || NEW.book_id::text,0)
  );
  IF NOT emdo.finance_book_access(NEW.workspace_id,NEW.book_id,ARRAY['administrator','preparer','approver','viewer']) THEN
    RAISE EXCEPTION 'finance-fec-book-forbidden' USING ERRCODE='42501';
  END IF;
  SELECT b.functional_currency INTO functional_currency
    FROM emdo.finance_books b
   WHERE b.workspace_id=NEW.workspace_id AND b.id=NEW.book_id;
  IF functional_currency IS DISTINCT FROM 'EUR' THEN
    RAISE EXCEPTION 'finance-fec-functional-currency-required' USING ERRCODE='23514';
  END IF;
  SELECT h.siren,h.reviewed_at INTO mapping_siren,mapping_reviewed_at
    FROM emdo.finance_fec_book_mapping_revisions h
   WHERE h.workspace_id=NEW.workspace_id
     AND h.book_id=NEW.book_id
     AND h.revision=NEW.mapping_revision;
  IF NOT FOUND OR mapping_reviewed_at IS NULL THEN
    RAISE EXCEPTION 'finance-fec-receipt-mapping-unreviewed' USING ERRCODE='23514';
  END IF;

  expected_request_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      '{"workspaceId":' || pg_catalog.to_json(NEW.workspace_id::text)::text ||
      ',"bookId":' || pg_catalog.to_json(NEW.book_id::text)::text ||
      ',"startsOn":' || pg_catalog.to_json(NEW.period_starts_on::text)::text ||
      ',"endsOn":' || pg_catalog.to_json(NEW.period_ends_on::text)::text ||
      ',"mappingRevision":' || NEW.mapping_revision::text || '}',
      'UTF8'
    )),
    'hex'
  );
  IF NEW.request_hash IS DISTINCT FROM expected_request_hash THEN
    RAISE EXCEPTION 'finance-fec-receipt-request-hash-mismatch' USING ERRCODE='23514';
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.result) IS DISTINCT FROM 'object'
     OR NEW.result->>'status' IS DISTINCT FROM 'ready'
  THEN
    RAISE EXCEPTION 'finance-fec-receipt-shape-invalid' USING ERRCODE='23514';
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.result->'review') IS DISTINCT FROM 'object'
     OR NEW.result->'review'->>'status' IS DISTINCT FROM 'ready'
  THEN
    RAISE EXCEPTION 'finance-fec-receipt-shape-invalid' USING ERRCODE='23514';
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.result->'review'->'errors') IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'finance-fec-receipt-shape-invalid' USING ERRCODE='23514';
  END IF;
  IF pg_catalog.jsonb_array_length(NEW.result->'review'->'errors') <> 0 THEN
    RAISE EXCEPTION 'finance-fec-receipt-shape-invalid' USING ERRCODE='23514';
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.result->'review'->'entryCount') IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(NEW.result->'review'->'lineCount') IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(NEW.result->'review'->'fileName') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(NEW.result->'review'->'sourceLineage') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(NEW.result->'review'->'standard') IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION 'finance-fec-receipt-shape-invalid' USING ERRCODE='23514';
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.result->'sourceLineage') IS DISTINCT FROM 'array'
     OR NEW.result->'sourceLineage' IS DISTINCT FROM NEW.result->'review'->'sourceLineage'
  THEN
    RAISE EXCEPTION 'finance-fec-receipt-shape-invalid' USING ERRCODE='23514';
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.result->'file') IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(NEW.result->'file'->'fileName') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(NEW.result->'file'->'content') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(NEW.result->'file'->'byteLength') IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(NEW.result->'file'->'columns') IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'finance-fec-receipt-shape-invalid' USING ERRCODE='23514';
  END IF;
  IF pg_catalog.jsonb_array_length(NEW.result->'file'->'columns') <> 18 THEN
    RAISE EXCEPTION 'finance-fec-receipt-shape-invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.result->'file'->'columns' IS DISTINCT FROM '["JournalCode","JournalLib","EcritureNum","EcritureDate","CompteNum","CompteLib","CompAuxNum","CompAuxLib","PieceRef","PieceDate","EcritureLib","Debit","Credit","EcritureLet","DateLet","ValidDate","Montantdevise","Idevise"]'::jsonb
     OR NEW.result->'file'->>'encoding' IS DISTINCT FROM 'UTF-8'
     OR NEW.result->'file'->>'separator' IS DISTINCT FROM E'\t'
     OR NEW.result->'file'->>'lineEnding' IS DISTINCT FROM E'\r\n'
     OR NEW.result->'review'->'standard'->>'article' IS DISTINCT FROM 'LPF A. 47 A-1'
     OR NEW.result->'review'->'standard'->>'format' IS DISTINCT FROM 'flat-file'
     OR NEW.result->'review'->'standard'->>'currency' IS DISTINCT FROM 'EUR'
  THEN
    RAISE EXCEPTION 'finance-fec-receipt-standard-invalid' USING ERRCODE='23514';
  END IF;
  content := NEW.result #>> '{file,content}';
  IF content IS NULL OR pg_catalog.octet_length(content) = 0
     OR encode(sha256(convert_to(content,'UTF8')),'hex') IS DISTINCT FROM NEW.result_hash
     OR coalesce(NEW.result->'file'->>'byteLength','') !~ '^[0-9]{1,10}$'
     OR NEW.result->'file'->>'byteLength' IS DISTINCT FROM pg_catalog.octet_length(content)::text
  THEN
    RAISE EXCEPTION 'finance-fec-receipt-content-integrity' USING ERRCODE='23514';
  END IF;
  IF coalesce(NEW.result->'review'->>'entryCount','') !~ '^[1-9][0-9]{0,8}$'
     OR coalesce(NEW.result->'review'->>'lineCount','') !~ '^[1-9][0-9]{0,8}$'
  THEN
    RAISE EXCEPTION 'finance-fec-receipt-count-invalid' USING ERRCODE='23514';
  END IF;
  result_entry_count := (NEW.result->'review'->>'entryCount')::integer;
  result_line_count := (NEW.result->'review'->>'lineCount')::integer;
  expected_file_name := mapping_siren || 'FEC' || replace(NEW.period_ends_on::text,'-','') || '.txt';
  IF NEW.result->'file'->>'fileName' IS DISTINCT FROM expected_file_name
     OR NEW.result->'review'->>'fileName' IS DISTINCT FROM expected_file_name
  THEN
    RAISE EXCEPTION 'finance-fec-receipt-file-name-invalid' USING ERRCODE='23514';
  END IF;

  SELECT count(DISTINCT j.id)::integer,count(l.id)::integer
    INTO expected_entry_count,expected_line_count
    FROM emdo.finance_journals j
    LEFT JOIN emdo.finance_journal_lines l
      ON l.workspace_id=j.workspace_id
     AND l.book_id=j.book_id
     AND l.journal_id=j.id
   WHERE j.workspace_id=NEW.workspace_id
     AND j.book_id=NEW.book_id
     AND j.status='posted'
     AND j.effective_on BETWEEN NEW.period_starts_on AND NEW.period_ends_on;
  IF result_entry_count IS DISTINCT FROM expected_entry_count
     OR result_line_count IS DISTINCT FROM expected_line_count
     OR pg_catalog.jsonb_array_length(NEW.result->'sourceLineage') IS DISTINCT FROM expected_line_count
  THEN
    RAISE EXCEPTION 'finance-fec-receipt-source-count-mismatch' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM emdo.finance_journals j
      JOIN emdo.finance_journal_lines l
        ON l.workspace_id=j.workspace_id
       AND l.book_id=j.book_id
       AND l.journal_id=j.id
      LEFT JOIN emdo.finance_fec_journal_mappings jm
        ON jm.workspace_id=j.workspace_id
       AND jm.book_id=j.book_id
       AND jm.journal_id=j.id
       AND jm.revision=NEW.mapping_revision
       AND jm.reviewed_at IS NOT NULL
      LEFT JOIN emdo.finance_fec_account_mappings am
        ON am.workspace_id=l.workspace_id
       AND am.book_id=l.book_id
       AND am.account_id=l.account_id
       AND am.revision=NEW.mapping_revision
     WHERE j.workspace_id=NEW.workspace_id
       AND j.book_id=NEW.book_id
       AND j.status='posted'
       AND j.effective_on BETWEEN NEW.period_starts_on AND NEW.period_ends_on
       AND (jm.journal_id IS NULL OR am.account_id IS NULL OR NOT EXISTS (
         SELECT 1
           FROM pg_catalog.jsonb_array_elements(NEW.result->'sourceLineage') AS lineage(value)
          WHERE lineage.value->>'entryId' = j.id::text
            AND lineage.value->>'entryNumber' = jm.entry_number
            AND lineage.value->>'lineId' = l.id::text
            AND lineage.value->>'pieceReference' = jm.piece_reference
            AND lineage.value->>'sourceReference' = j.source_reference
            AND lineage.value->>'sourceDigest' = j.payload_hash
       ))
  ) THEN
    RAISE EXCEPTION 'finance-fec-receipt-source-lineage-mismatch' USING ERRCODE='23514';
  END IF;
  stamp := pg_catalog.clock_timestamp();
  NEW.created_by := actor;
  NEW.created_at := stamp;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE FUNCTION emdo.reject_finance_fec_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, emdo
AS $$
BEGIN
  RAISE EXCEPTION 'finance-fec-history-immutable' USING ERRCODE='23514';
END
$$;
--> statement-breakpoint
ALTER FUNCTION emdo.enforce_finance_fec_book_mapping_revision() OWNER TO emdo_policy_reader;
ALTER FUNCTION emdo.enforce_finance_fec_child_mapping() OWNER TO emdo_policy_reader;
ALTER FUNCTION emdo.enforce_finance_fec_export_receipt() OWNER TO emdo_policy_reader;
ALTER FUNCTION emdo.reject_finance_fec_history_mutation() OWNER TO emdo_policy_reader;
--> statement-breakpoint
REVOKE ALL ON FUNCTION emdo.enforce_finance_fec_book_mapping_revision() FROM PUBLIC;
REVOKE ALL ON FUNCTION emdo.enforce_finance_fec_child_mapping() FROM PUBLIC;
REVOKE ALL ON FUNCTION emdo.enforce_finance_fec_export_receipt() FROM PUBLIC;
REVOKE ALL ON FUNCTION emdo.reject_finance_fec_history_mutation() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER finance_fec_book_mapping_revision_guard
  BEFORE INSERT ON emdo.finance_fec_book_mapping_revisions
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_fec_book_mapping_revision();
--> statement-breakpoint
CREATE TRIGGER finance_fec_journal_mapping_guard
  BEFORE INSERT ON emdo.finance_fec_journal_mappings
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_fec_child_mapping();
--> statement-breakpoint
CREATE TRIGGER finance_fec_account_mapping_guard
  BEFORE INSERT ON emdo.finance_fec_account_mappings
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_fec_child_mapping();
--> statement-breakpoint
CREATE TRIGGER finance_fec_export_receipt_guard
  BEFORE INSERT ON emdo.finance_fec_export_receipts
  FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_fec_export_receipt();
--> statement-breakpoint
CREATE TRIGGER finance_fec_book_mapping_revision_immutable
  BEFORE UPDATE OR DELETE ON emdo.finance_fec_book_mapping_revisions
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_fec_history_mutation();
--> statement-breakpoint
CREATE TRIGGER finance_fec_journal_mapping_immutable
  BEFORE UPDATE OR DELETE ON emdo.finance_fec_journal_mappings
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_fec_history_mutation();
--> statement-breakpoint
CREATE TRIGGER finance_fec_account_mapping_immutable
  BEFORE UPDATE OR DELETE ON emdo.finance_fec_account_mappings
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_fec_history_mutation();
--> statement-breakpoint
CREATE TRIGGER finance_fec_export_receipt_immutable
  BEFORE UPDATE OR DELETE ON emdo.finance_fec_export_receipts
  FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_fec_history_mutation();
