-- Bind selected private book evidence to both reviewed FEC header sources.
-- External reviewed references retain their existing semantics.
CREATE OR REPLACE FUNCTION emdo.enforce_finance_fec_book_mapping_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, emdo
SET row_security = on
AS $$
DECLARE
  actor uuid;
  stamp timestamptz;
  functional_currency text;
  source record;
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
  FOR source IN SELECT * FROM (VALUES
    (NEW.siren_source_reference,NEW.siren_source_digest),
    (NEW.opening_source_reference,NEW.opening_source_digest)
  ) AS sources(reference,digest) LOOP
    IF starts_with(source.reference,'evidence:') THEN
      IF source.reference !~ '^evidence:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        RAISE EXCEPTION 'finance-fec-evidence-reference-invalid' USING ERRCODE='23514';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM emdo.finance_book_evidence e
         WHERE e.workspace_id=NEW.workspace_id AND e.book_id=NEW.book_id
           AND e.id=substring(source.reference FROM 10)::uuid
           AND e.plaintext_sha256=source.digest
      ) THEN
        RAISE EXCEPTION 'finance-fec-evidence-binding-invalid' USING ERRCODE='23514';
      END IF;
    END IF;
  END LOOP;
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
ALTER FUNCTION emdo.enforce_finance_fec_book_mapping_revision() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.enforce_finance_fec_book_mapping_revision() FROM PUBLIC;
