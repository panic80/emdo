-- Canonical private tax policies, copied into migration 0040. No workspace/book role is a tax-case grant.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['finance_tax_subjects','finance_tax_cases','finance_tax_case_grants','finance_tax_case_snapshots','finance_tax_book_sources','finance_tax_fact_sources','finance_tax_receipts'] LOOP
  EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow',t);
  EXECUTE format('GRANT SELECT ON emdo.%I TO emdo_policy_reader',t);
  EXECUTE format('CREATE POLICY %I ON emdo.%I FOR SELECT TO emdo_policy_reader USING(true)',t||'_policy_reader',t);
 END LOOP;
END $$;
CREATE FUNCTION emdo.tax_case_access(w uuid,c uuid,roles text[] DEFAULT ARRAY['owner','preparer','reviewer','viewer']) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
 SELECT emdo.finance_v2_member(w) AND EXISTS(SELECT 1 FROM emdo.finance_tax_case_grants g
 WHERE g.workspace_id=w AND g.case_id=c AND g.user_id=emdo.current_user_id() AND g.revoked_at IS NULL AND g.role=ANY(roles))
$$;
ALTER FUNCTION emdo.tax_case_access(uuid,uuid,text[]) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.tax_case_access(uuid,uuid,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.tax_case_access(uuid,uuid,text[]) TO emdo_app,emdo_policy_reader;

-- Check the exact immutable authorizations bound to this snapshot, including historical reads.
CREATE FUNCTION emdo.tax_snapshot_access(w uuid,c uuid,q jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
 SELECT emdo.tax_case_access(w,c) AND NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(q->'sourceAuthorizationBindings') b
 LEFT JOIN emdo.finance_tax_book_sources s ON s.workspace_id=w AND s.case_id=c AND s.id::text=b->>'authorizationId'
 LEFT JOIN emdo.finance_book_grants g ON g.workspace_id=w AND g.book_id=s.book_id AND g.user_id=s.authorized_by
 LEFT JOIN emdo.household_memberships m ON m.household_id=w AND m.user_id=s.authorized_by
 WHERE s.id IS NULL OR s.revoked_at IS NOT NULL OR s.authorization_revision::text IS DISTINCT FROM b->>'authorizationRevision'
 OR s.book_id::text IS DISTINCT FROM b->>'bookId' OR s.snapshot_revision::text IS DISTINCT FROM b->>'snapshotRevision' OR s.snapshot_hash IS DISTINCT FROM b->>'snapshotHash'
 OR g.user_id IS NULL OR g.revoked_at IS NOT NULL OR g.revision<>s.book_grant_revision OR m.status IS DISTINCT FROM 'active')
$$;
ALTER FUNCTION emdo.tax_snapshot_access(uuid,uuid,jsonb) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.tax_snapshot_access(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.tax_snapshot_access(uuid,uuid,jsonb) TO emdo_app,emdo_policy_reader;
CREATE FUNCTION emdo.tax_case_sources_current(w uuid,c uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
 SELECT emdo.tax_case_access(w,c) AND EXISTS(SELECT 1 FROM emdo.finance_tax_cases t
 LEFT JOIN emdo.finance_tax_case_snapshots s ON s.workspace_id=w AND s.case_id=c AND s.revision=t.current_revision
 WHERE t.workspace_id=w AND t.id=c AND (t.current_revision=0 OR emdo.tax_snapshot_access(w,c,s.questionnaire)))
$$;
ALTER FUNCTION emdo.tax_case_sources_current(uuid,uuid) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.tax_case_sources_current(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.tax_case_sources_current(uuid,uuid) TO emdo_app,emdo_policy_reader;

CREATE FUNCTION emdo.tax_case_grantee_current(w uuid,c uuid,u uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 IF NOT emdo.tax_case_access(w,c,ARRAY['owner']) THEN RETURN false; END IF;
 PERFORM 1 FROM emdo.household_memberships WHERE household_id=w AND user_id=u AND status='active' FOR SHARE;
 RETURN FOUND;
END $$;
ALTER FUNCTION emdo.tax_case_grantee_current(uuid,uuid,uuid) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.tax_case_grantee_current(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.tax_case_grantee_current(uuid,uuid,uuid) TO emdo_app;

GRANT SELECT,INSERT ON emdo.finance_tax_subjects,emdo.finance_tax_cases,emdo.finance_tax_case_snapshots,emdo.finance_tax_fact_sources,emdo.finance_tax_receipts TO emdo_app;
GRANT SELECT,INSERT,UPDATE ON emdo.finance_tax_case_grants,emdo.finance_tax_book_sources TO emdo_app;
GRANT UPDATE(current_revision) ON emdo.finance_tax_cases TO emdo_app;
CREATE POLICY tax_subject_read ON emdo.finance_tax_subjects FOR SELECT TO emdo_app USING(emdo.finance_v2_member(workspace_id) AND (created_by=emdo.current_user_id() OR EXISTS(SELECT 1 FROM emdo.finance_tax_cases c WHERE c.workspace_id=finance_tax_subjects.workspace_id AND c.tax_subject_id=finance_tax_subjects.id AND emdo.tax_case_access(c.workspace_id,c.id))));
CREATE POLICY tax_subject_create ON emdo.finance_tax_subjects FOR INSERT TO emdo_app WITH CHECK(emdo.finance_v2_member(workspace_id) AND created_by=emdo.current_user_id());
CREATE POLICY tax_case_read ON emdo.finance_tax_cases FOR SELECT TO emdo_app USING(emdo.tax_case_access(workspace_id,id));
CREATE POLICY tax_case_create ON emdo.finance_tax_cases FOR INSERT TO emdo_app WITH CHECK(emdo.finance_v2_member(workspace_id) AND created_by=emdo.current_user_id() AND current_revision=0 AND EXISTS(SELECT 1 FROM emdo.finance_tax_subjects s WHERE s.id=tax_subject_id AND s.workspace_id=finance_tax_cases.workspace_id AND s.created_by=emdo.current_user_id()));
CREATE POLICY tax_case_advance ON emdo.finance_tax_cases FOR UPDATE TO emdo_app USING(emdo.tax_case_access(workspace_id,id,ARRAY['owner','preparer','reviewer'])) WITH CHECK(emdo.tax_case_access(workspace_id,id,ARRAY['owner','preparer','reviewer']));
CREATE POLICY tax_case_grant_read ON emdo.finance_tax_case_grants FOR SELECT TO emdo_app USING(emdo.tax_case_access(workspace_id,case_id) AND (user_id=emdo.current_user_id() OR emdo.tax_case_access(workspace_id,case_id,ARRAY['owner'])));
CREATE POLICY tax_case_grant_create ON emdo.finance_tax_case_grants FOR INSERT TO emdo_app WITH CHECK(emdo.tax_case_grantee_current(workspace_id,case_id,user_id));
CREATE POLICY tax_case_grant_change ON emdo.finance_tax_case_grants FOR UPDATE TO emdo_app USING(emdo.tax_case_access(workspace_id,case_id,ARRAY['owner'])) WITH CHECK(emdo.tax_case_access(workspace_id,case_id,ARRAY['owner']));
CREATE POLICY tax_snapshot_read ON emdo.finance_tax_case_snapshots FOR SELECT TO emdo_app USING(emdo.tax_snapshot_access(workspace_id,case_id,questionnaire));
CREATE POLICY tax_snapshot_create ON emdo.finance_tax_case_snapshots FOR INSERT TO emdo_app WITH CHECK(emdo.tax_snapshot_access(workspace_id,case_id,questionnaire) AND emdo.tax_case_access(workspace_id,case_id,ARRAY['owner','preparer','reviewer']) AND created_by=emdo.current_user_id());
CREATE POLICY tax_source_book_read ON emdo.finance_tax_book_sources FOR SELECT TO emdo_app USING(emdo.tax_case_sources_current(workspace_id,case_id));
CREATE POLICY tax_source_book_create ON emdo.finance_tax_book_sources FOR INSERT TO emdo_app WITH CHECK(emdo.tax_case_access(workspace_id,case_id,ARRAY['owner']) AND emdo.finance_book_access(workspace_id,book_id) AND authorized_by=emdo.current_user_id());
CREATE POLICY tax_source_book_revoke ON emdo.finance_tax_book_sources FOR UPDATE TO emdo_app USING(emdo.tax_case_access(workspace_id,case_id,ARRAY['owner'])) WITH CHECK(emdo.tax_case_access(workspace_id,case_id,ARRAY['owner']));
CREATE POLICY tax_source_fact_read ON emdo.finance_tax_fact_sources FOR SELECT TO emdo_app USING(emdo.tax_case_sources_current(workspace_id,case_id));
CREATE POLICY tax_source_fact_create ON emdo.finance_tax_fact_sources FOR INSERT TO emdo_app WITH CHECK(emdo.tax_case_sources_current(workspace_id,case_id) AND emdo.tax_case_access(workspace_id,case_id,ARRAY['owner','preparer']) AND created_by=emdo.current_user_id());
CREATE POLICY tax_receipt_read ON emdo.finance_tax_receipts FOR SELECT TO emdo_app USING(user_id=emdo.current_user_id() AND emdo.tax_case_access(workspace_id,case_id));
CREATE POLICY tax_receipt_create ON emdo.finance_tax_receipts FOR INSERT TO emdo_app WITH CHECK(user_id=emdo.current_user_id() AND emdo.tax_case_access(workspace_id,case_id));

GRANT INSERT,UPDATE ON emdo.finance_tax_case_grants TO emdo_policy_reader;
CREATE POLICY tax_case_grant_bootstrap ON emdo.finance_tax_case_grants FOR INSERT TO emdo_policy_reader WITH CHECK(true);
CREATE POLICY tax_case_grant_lock ON emdo.finance_tax_case_grants FOR UPDATE TO emdo_policy_reader USING(true) WITH CHECK(true);
CREATE FUNCTION emdo.initialize_tax_case() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
BEGIN
 INSERT INTO emdo.finance_tax_case_grants(workspace_id,case_id,tax_subject_id,user_id,role) VALUES(NEW.workspace_id,NEW.id,NEW.tax_subject_id,NEW.created_by,'owner');
 RETURN NEW;
END $$;
ALTER FUNCTION emdo.initialize_tax_case() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.initialize_tax_case() FROM PUBLIC;
CREATE TRIGGER initialize_tax_case AFTER INSERT ON emdo.finance_tax_cases FOR EACH ROW EXECUTE FUNCTION emdo.initialize_tax_case();

-- Locks the current actor grant and source-authorizer grants until transaction end, serializing revocation.
GRANT UPDATE(id) ON emdo.finance_tax_book_sources TO emdo_policy_reader;
CREATE POLICY tax_book_source_lock ON emdo.finance_tax_book_sources FOR UPDATE TO emdo_policy_reader USING(true) WITH CHECK(true);
CREATE FUNCTION emdo.lock_tax_case(w uuid,c uuid,roles text[],inputs boolean DEFAULT true) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE s record;
BEGIN
 IF NOT emdo.tax_case_access(w,c,roles) THEN RETURN false; END IF;
 PERFORM 1 FROM emdo.finance_tax_case_grants WHERE workspace_id=w AND case_id=c AND user_id=emdo.current_user_id() AND revoked_at IS NULL AND role=ANY(roles) FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF inputs THEN
  FOR s IN SELECT b.* FROM emdo.finance_tax_book_sources b
   JOIN emdo.finance_tax_cases t ON t.workspace_id=w AND t.id=c
   JOIN emdo.finance_tax_case_snapshots q ON q.workspace_id=w AND q.case_id=c AND q.revision=t.current_revision
   WHERE b.workspace_id=w AND b.case_id=c AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.questionnaire->'sourceAuthorizationBindings') a WHERE a->>'authorizationId'=b.id::text)
   ORDER BY b.book_id FOR SHARE OF b LOOP
   PERFORM 1 FROM emdo.finance_book_grants WHERE workspace_id=w AND book_id=s.book_id AND user_id=s.authorized_by AND revoked_at IS NULL AND revision=s.book_grant_revision FOR SHARE;
   IF NOT FOUND OR s.revoked_at IS NOT NULL THEN RETURN false; END IF;
   PERFORM 1 FROM emdo.household_memberships WHERE household_id=w AND user_id=s.authorized_by AND status='active' FOR SHARE;
   IF NOT FOUND THEN RETURN false; END IF;
  END LOOP;
  IF NOT emdo.tax_case_sources_current(w,c) THEN RETURN false; END IF;
 END IF;
 RETURN true;
END $$;
ALTER FUNCTION emdo.lock_tax_case(uuid,uuid,text[],boolean) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.lock_tax_case(uuid,uuid,text[],boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.lock_tax_case(uuid,uuid,text[],boolean) TO emdo_app;

CREATE FUNCTION emdo.protect_tax_case_grant() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.workspace_id,NEW.case_id,NEW.tax_subject_id,NEW.user_id) IS DISTINCT FROM (OLD.workspace_id,OLD.case_id,OLD.tax_subject_id,OLD.user_id) THEN RAISE EXCEPTION 'tax grant identity immutable' USING ERRCODE='23514'; END IF;
  NEW.revision:=OLD.revision+1;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_tax_case_grant BEFORE UPDATE ON emdo.finance_tax_case_grants FOR EACH ROW EXECUTE FUNCTION emdo.protect_tax_case_grant();
CREATE FUNCTION emdo.protect_tax_source_book() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'revoked_at'-'authorization_revision') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'authorization_revision') OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN RAISE EXCEPTION 'tax source immutable except revocation' USING ERRCODE='23514'; END IF;
  NEW.authorization_revision:=OLD.authorization_revision+1;
 ELSE
  IF NOT emdo.lock_finance_book_grant(NEW.workspace_id,NEW.book_id) OR NOT EXISTS(SELECT 1 FROM emdo.finance_book_grants WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND user_id=emdo.current_user_id() AND revoked_at IS NULL AND revision=NEW.book_grant_revision) THEN RAISE EXCEPTION 'tax source book forbidden' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_tax_source_book BEFORE INSERT OR UPDATE ON emdo.finance_tax_book_sources FOR EACH ROW EXECUTE FUNCTION emdo.protect_tax_source_book();

CREATE FUNCTION emdo.enforce_tax_snapshot() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE current_revision integer; previous emdo.finance_tax_case_snapshots;
BEGIN
 IF NOT emdo.tax_case_access(NEW.workspace_id,NEW.case_id,ARRAY['owner','preparer','reviewer']) THEN RAISE EXCEPTION 'tax snapshot forbidden' USING ERRCODE='42501'; END IF;
 -- Shipped registry has no validated packages. SQL callers cannot manufacture enabled questions or completed facts.
 IF NEW.questionnaire->'binding'->'manifest' IS DISTINCT FROM 'null'::jsonb OR NEW.questionnaire->'binding'->'manifestHash' IS DISTINCT FROM 'null'::jsonb OR NEW.questionnaire->'questions' IS DISTINCT FROM '[]'::jsonb OR NEW.questionnaire->'answers' IS DISTINCT FROM '[]'::jsonb OR NEW.questionnaire#>'{intake,facts}' IS DISTINCT FROM '[]'::jsonb OR NEW.questionnaire ? 'complete' THEN RAISE EXCEPTION 'tax package unavailable' USING ERRCODE='23514'; END IF;
 SELECT c.current_revision INTO current_revision FROM emdo.finance_tax_cases c WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.case_id FOR UPDATE;
 IF current_revision IS NULL OR NEW.revision<>current_revision+1 THEN RAISE EXCEPTION 'tax snapshot revision conflict' USING ERRCODE='23514'; END IF;
 IF NEW.questionnaire->>'visibility' IS DISTINCT FROM 'private' OR NEW.questionnaire#>>'{intake,caseId}' IS DISTINCT FROM NEW.case_id::text OR NEW.questionnaire#>>'{intake,workspaceId}' IS DISTINCT FROM NEW.workspace_id::text OR NEW.questionnaire#>>'{intake,taxSubjectId}' IS DISTINCT FROM NEW.tax_subject_id::text OR NEW.questionnaire#>>'{intake,revision}' IS DISTINCT FROM NEW.revision::text THEN RAISE EXCEPTION 'tax snapshot identity mismatch' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.questionnaire->'answers') a WHERE a->>'caseId' IS DISTINCT FROM NEW.case_id::text OR a->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text OR a->>'taxSubjectId' IS DISTINCT FROM NEW.tax_subject_id::text) THEN RAISE EXCEPTION 'tax answer identity mismatch' USING ERRCODE='23514'; END IF;
 IF current_revision>0 THEN
  SELECT * INTO previous FROM emdo.finance_tax_case_snapshots WHERE workspace_id=NEW.workspace_id AND case_id=NEW.case_id AND revision=current_revision;
  IF NOT emdo.tax_snapshot_access(NEW.workspace_id,NEW.case_id,previous.questionnaire) AND (NOT emdo.tax_case_access(NEW.workspace_id,NEW.case_id,ARRAY['owner']) OR NEW.questionnaire->'sourceAuthorizationBindings' IS DISTINCT FROM '[]'::jsonb OR NEW.questionnaire->'relatedParties' IS DISTINCT FROM '[]'::jsonb OR NEW.questionnaire->'withdrawnAnswers' IS DISTINCT FROM '[]'::jsonb OR NEW.questionnaire#>'{intake,sourceBooks}' IS DISTINCT FROM '[]'::jsonb) THEN RAISE EXCEPTION 'tax recovery must discard inaccessible inputs' USING ERRCODE='42501'; END IF;
  IF NEW.previous_snapshot_hash IS DISTINCT FROM previous.snapshot_hash OR NEW.questionnaire->'binding' IS DISTINCT FROM previous.questionnaire->'binding' OR NEW.questionnaire->'questions' IS DISTINCT FROM previous.questionnaire->'questions' OR NEW.questionnaire#>'{intake,scope}' IS DISTINCT FROM previous.questionnaire#>'{intake,scope}' THEN RAISE EXCEPTION 'tax package binding immutable' USING ERRCODE='23514'; END IF;
 ELSIF NEW.previous_snapshot_hash IS NOT NULL THEN RAISE EXCEPTION 'tax initial snapshot has predecessor' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION emdo.enforce_tax_snapshot() OWNER TO emdo_policy_reader;
GRANT UPDATE(current_revision) ON emdo.finance_tax_cases TO emdo_policy_reader;
CREATE POLICY tax_case_snapshot_lock ON emdo.finance_tax_cases FOR UPDATE TO emdo_policy_reader USING(true) WITH CHECK(true);
CREATE TRIGGER enforce_tax_snapshot BEFORE INSERT ON emdo.finance_tax_case_snapshots FOR EACH ROW EXECUTE FUNCTION emdo.enforce_tax_snapshot();
CREATE FUNCTION emdo.advance_tax_case() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.current_revision<>OLD.current_revision+1 OR NOT EXISTS(SELECT 1 FROM emdo.finance_tax_case_snapshots s WHERE s.workspace_id=NEW.workspace_id AND s.case_id=NEW.id AND s.revision=NEW.current_revision) THEN RAISE EXCEPTION 'tax case revision requires snapshot' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER advance_tax_case BEFORE UPDATE ON emdo.finance_tax_cases FOR EACH ROW EXECUTE FUNCTION emdo.advance_tax_case();
REVOKE ALL ON FUNCTION emdo.protect_tax_case_grant(),emdo.protect_tax_source_book(),emdo.enforce_tax_snapshot(),emdo.advance_tax_case() FROM PUBLIC;

-- Recovery deliberately returns no old personal facts, related parties, or source snapshots.
CREATE FUNCTION emdo.tax_case_recovery_seed(w uuid,c uuid,expected integer) RETURNS TABLE(questionnaire jsonb,previous_hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE q jsonb; h text; r integer;
BEGIN
 IF NOT emdo.lock_tax_case(w,c,ARRAY['owner'],false) THEN RAISE EXCEPTION 'tax recovery forbidden' USING ERRCODE='42501'; END IF;
 SELECT current_revision INTO r FROM emdo.finance_tax_cases WHERE workspace_id=w AND id=c FOR UPDATE;
 IF r IS DISTINCT FROM expected THEN RAISE EXCEPTION 'tax recovery revision conflict' USING ERRCODE='23514'; END IF;
 SELECT s.questionnaire,s.snapshot_hash INTO q,h FROM emdo.finance_tax_case_snapshots s WHERE workspace_id=w AND case_id=c AND revision=r;
 q:=q || jsonb_build_object('answers','[]'::jsonb,'withdrawnAnswers','[]'::jsonb,'relatedParties','[]'::jsonb,'sourceAuthorizationBindings','[]'::jsonb);
 q:=jsonb_set(q,'{intake}',q->'intake' || jsonb_build_object('revision',r+1,'facts','[]'::jsonb,'sourceBooks','[]'::jsonb,'domesticResident',null,'hasCrossBorderActivity',null,'standaloneCorporation',null));
 RETURN QUERY SELECT q,h;
END $$;
ALTER FUNCTION emdo.tax_case_recovery_seed(uuid,uuid,integer) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.tax_case_recovery_seed(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.tax_case_recovery_seed(uuid,uuid,integer) TO emdo_app;
