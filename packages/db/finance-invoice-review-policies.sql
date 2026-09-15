ALTER TABLE emdo.finance_invoice_review_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_invoice_review_drafts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON emdo.finance_invoice_review_drafts FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow;
GRANT SELECT,INSERT ON emdo.finance_invoice_review_drafts TO emdo_app;
CREATE POLICY invoice_review_read ON emdo.finance_invoice_review_drafts FOR SELECT TO emdo_app USING(user_id=emdo.current_user_id() AND emdo.finance_book_access(workspace_id,book_id));
CREATE POLICY invoice_review_insert ON emdo.finance_invoice_review_drafts FOR INSERT TO emdo_app WITH CHECK(user_id=emdo.current_user_id() AND emdo.finance_book_access(workspace_id,book_id,ARRAY['administrator','preparer','approver']));
CREATE FUNCTION emdo.check_invoice_review_draft() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE prior integer; source_hash text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'invoice reviews are append-only' USING ERRCODE='23514'; END IF;
 IF NEW.user_id IS DISTINCT FROM emdo.current_user_id() OR NOT emdo.lock_finance_book_grant(NEW.workspace_id,NEW.book_id) THEN RAISE EXCEPTION 'invoice review access revoked' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id::text||':'||NEW.book_id::text,0));
 SELECT coalesce(max(revision),0) INTO prior FROM emdo.finance_invoice_review_drafts WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND evidence_id=NEW.evidence_id AND user_id=NEW.user_id;
 SELECT plaintext_sha256 INTO source_hash FROM emdo.finance_book_evidence WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND id=NEW.evidence_id AND format IN ('ubl','cii');
 IF NEW.revision<>prior+1 OR source_hash IS NULL OR NEW.draft->>'expectedSourceDigest' IS DISTINCT FROM source_hash OR NEW.draft->>'expectedAdapterVersion' IS DISTINCT FROM 'structured-invoice.v1' THEN RAISE EXCEPTION 'invoice review source or revision conflict' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invoice_review_guard BEFORE INSERT OR UPDATE OR DELETE ON emdo.finance_invoice_review_drafts FOR EACH ROW EXECUTE FUNCTION emdo.check_invoice_review_draft();
