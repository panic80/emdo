-- Append-only source rebinds. Revoked records and their ledger bodies are never reactivated.
CREATE FUNCTION emdo.tax_current_book_source_access(w uuid,c uuid,a uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
 SELECT emdo.tax_case_access(w,c) AND EXISTS(
  SELECT 1 FROM emdo.finance_tax_cases t
  JOIN emdo.finance_tax_case_snapshots q ON q.workspace_id=w AND q.case_id=c AND q.revision=t.current_revision
  WHERE t.workspace_id=w AND t.id=c AND emdo.tax_snapshot_access(w,c,q.questionnaire)
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.questionnaire->'sourceAuthorizationBindings') b WHERE b->>'authorizationId'=a::text))
$$;
ALTER FUNCTION emdo.tax_current_book_source_access(uuid,uuid,uuid) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.tax_current_book_source_access(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.tax_current_book_source_access(uuid,uuid,uuid) TO emdo_app;
DROP POLICY tax_source_book_read ON emdo.finance_tax_book_sources;
CREATE POLICY tax_source_book_read ON emdo.finance_tax_book_sources FOR SELECT TO emdo_app USING(emdo.tax_current_book_source_access(workspace_id,case_id,id));

-- Return version counters only, never old ledger data. The case lock serializes both repository and direct SQL writers.
CREATE FUNCTION emdo.next_tax_book_source_versions(w uuid,c uuid,b uuid)
RETURNS TABLE(authorization_revision integer,snapshot_revision integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('tax-case:'||w::text||':'||c::text,0));
 IF NOT emdo.lock_tax_case(w,c,ARRAY['owner'],true) OR NOT emdo.lock_finance_book_grant(w,b) THEN RAISE EXCEPTION 'tax book rebind forbidden' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM emdo.household_memberships WHERE household_id=w AND user_id=emdo.current_user_id() AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'tax book rebind membership revoked' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM emdo.finance_tax_cases t JOIN emdo.finance_tax_case_snapshots q ON q.workspace_id=w AND q.case_id=c AND q.revision=t.current_revision WHERE t.workspace_id=w AND t.id=c AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.questionnaire->'sourceAuthorizationBindings') a WHERE a->>'bookId'=b::text)) THEN RAISE EXCEPTION 'tax book already bound; explicit reset required' USING ERRCODE='23514'; END IF;
 RETURN QUERY SELECT coalesce(max(s.authorization_revision),0)+1,coalesce(max(s.snapshot_revision),0)+1 FROM emdo.finance_tax_book_sources s WHERE s.workspace_id=w AND s.case_id=c AND s.book_id=b;
END $$;
ALTER FUNCTION emdo.next_tax_book_source_versions(uuid,uuid,uuid) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.next_tax_book_source_versions(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.next_tax_book_source_versions(uuid,uuid,uuid) TO emdo_app;

CREATE OR REPLACE FUNCTION emdo.protect_tax_source_book() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE versions record;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'revoked_at'-'authorization_revision') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'authorization_revision') OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN RAISE EXCEPTION 'tax source immutable except revocation' USING ERRCODE='23514'; END IF;
  NEW.authorization_revision:=OLD.authorization_revision+1;
 ELSE
  SELECT * INTO versions FROM emdo.next_tax_book_source_versions(NEW.workspace_id,NEW.case_id,NEW.book_id);
  IF NEW.authorization_revision IS DISTINCT FROM versions.authorization_revision OR NEW.snapshot_revision IS DISTINCT FROM versions.snapshot_revision THEN RAISE EXCEPTION 'tax source version conflict' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM emdo.finance_book_grants WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND user_id=emdo.current_user_id() AND revoked_at IS NULL AND revision=NEW.book_grant_revision) THEN RAISE EXCEPTION 'tax source book forbidden' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION emdo.protect_tax_source_book() FROM PUBLIC;

-- New recovery revisions clear bindings, retaining immutable declaration source history.
CREATE OR REPLACE FUNCTION emdo.tax_case_recovery_seed(w uuid,c uuid,expected integer) RETURNS TABLE(questionnaire jsonb,previous_hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE q jsonb; h text; r integer;
BEGIN
 IF NOT emdo.lock_tax_case(w,c,ARRAY['owner'],false) THEN RAISE EXCEPTION 'tax recovery forbidden' USING ERRCODE='42501'; END IF;
 SELECT current_revision INTO r FROM emdo.finance_tax_cases WHERE workspace_id=w AND id=c FOR UPDATE;
 IF r IS DISTINCT FROM expected THEN RAISE EXCEPTION 'tax recovery revision conflict' USING ERRCODE='23514'; END IF;
 SELECT s.questionnaire,s.snapshot_hash INTO q,h FROM emdo.finance_tax_case_snapshots s WHERE workspace_id=w AND case_id=c AND revision=r;
 q:=q || jsonb_build_object('declarationSourceBindings','[]'::jsonb,'answers','[]'::jsonb,'withdrawnAnswers','[]'::jsonb,'relatedParties','[]'::jsonb,'sourceAuthorizationBindings','[]'::jsonb);
 q:=jsonb_set(q,'{intake}',q->'intake' || jsonb_build_object('revision',r+1,'facts','[]'::jsonb,'sourceBooks','[]'::jsonb,'domesticResident',null,'hasCrossBorderActivity',null,'standaloneCorporation',null));
 RETURN QUERY SELECT q,h;
END $$;
ALTER FUNCTION emdo.tax_case_recovery_seed(uuid,uuid,integer) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.tax_case_recovery_seed(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.tax_case_recovery_seed(uuid,uuid,integer) TO emdo_app;

CREATE FUNCTION emdo.validate_tax_declaration_bindings() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 IF NEW.questionnaire ? 'declarationSourceBindings' THEN
  IF jsonb_typeof(NEW.questionnaire->'declarationSourceBindings') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'tax declaration bindings must be an array' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*)<>count(DISTINCT b->>'sourceId') FROM jsonb_array_elements(NEW.questionnaire->'declarationSourceBindings') b) OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(NEW.questionnaire->'declarationSourceBindings') b WHERE NOT EXISTS(
    SELECT 1 FROM emdo.finance_tax_fact_sources s WHERE s.workspace_id=NEW.workspace_id AND s.case_id=NEW.case_id AND s.tax_subject_id=NEW.tax_subject_id AND s.id::text=b->>'sourceId' AND s.revision::text=b->>'sourceRevision' AND s.content_hash=b->>'contentHash')) THEN RAISE EXCEPTION 'tax declaration source binding mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION emdo.validate_tax_declaration_bindings() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.validate_tax_declaration_bindings() FROM PUBLIC;
CREATE TRIGGER validate_tax_declaration_bindings BEFORE INSERT ON emdo.finance_tax_case_snapshots FOR EACH ROW EXECUTE FUNCTION emdo.validate_tax_declaration_bindings();
