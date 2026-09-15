-- Private immutable working papers, never a completed/fileable return. Applied by migration 0044.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['finance_tax_working_input_reviews','finance_tax_calculation_runs','finance_tax_run_schedules','finance_tax_run_reviews'] LOOP
  EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow',t);
  EXECUTE format('GRANT SELECT,INSERT ON emdo.%I TO emdo_app',t);
  EXECUTE format('GRANT SELECT ON emdo.%I TO emdo_policy_reader',t);
  EXECUTE format('CREATE POLICY %I ON emdo.%I FOR SELECT TO emdo_policy_reader USING(true)',t||'_policy_reader',t);
 END LOOP;
END $$;
CREATE FUNCTION emdo.tax_run_snapshot_access(w uuid,c uuid,r integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
 SELECT EXISTS(SELECT 1 FROM emdo.finance_tax_case_snapshots s WHERE s.workspace_id=w AND s.case_id=c AND s.revision=r AND emdo.tax_snapshot_access(w,c,s.questionnaire))
$$;
ALTER FUNCTION emdo.tax_run_snapshot_access(uuid,uuid,integer) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.tax_run_snapshot_access(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.tax_run_snapshot_access(uuid,uuid,integer) TO emdo_app,emdo_policy_reader;
CREATE FUNCTION emdo.tax_calculation_run_access(w uuid,c uuid,r uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
 SELECT EXISTS(SELECT 1 FROM emdo.finance_tax_calculation_runs t WHERE t.workspace_id=w AND t.case_id=c AND t.id=r AND emdo.tax_run_snapshot_access(w,c,t.snapshot_revision))
$$;
ALTER FUNCTION emdo.tax_calculation_run_access(uuid,uuid,uuid) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.tax_calculation_run_access(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.tax_calculation_run_access(uuid,uuid,uuid) TO emdo_app,emdo_policy_reader;
-- Lock the exact historical authorization rows plus their grant/member revisions. Rebind never revives these rows.
CREATE FUNCTION emdo.lock_tax_run_snapshot(w uuid,c uuid,r integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE q jsonb; s record;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('tax-case:'||w::text||':'||c::text,0));
 IF NOT emdo.lock_tax_case(w,c,ARRAY['owner','preparer','reviewer','viewer'],false) THEN RETURN false; END IF;
 PERFORM 1 FROM emdo.household_memberships WHERE household_id=w AND user_id=emdo.current_user_id() AND status='active' FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT questionnaire INTO q FROM emdo.finance_tax_case_snapshots WHERE workspace_id=w AND case_id=c AND revision=r;
 IF q IS NULL THEN RETURN false; END IF;
 FOR s IN SELECT b.* FROM emdo.finance_tax_book_sources b WHERE b.workspace_id=w AND b.case_id=c AND EXISTS(SELECT 1 FROM jsonb_array_elements(q->'sourceAuthorizationBindings') a WHERE a->>'authorizationId'=b.id::text) ORDER BY b.book_id FOR SHARE OF b LOOP
  PERFORM 1 FROM emdo.finance_book_grants WHERE workspace_id=w AND book_id=s.book_id AND user_id=s.authorized_by AND revoked_at IS NULL AND revision=s.book_grant_revision FOR SHARE;
  IF NOT FOUND OR s.revoked_at IS NOT NULL THEN RETURN false; END IF;
  PERFORM 1 FROM emdo.household_memberships WHERE household_id=w AND user_id=s.authorized_by AND status='active' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
 END LOOP;
 RETURN emdo.tax_snapshot_access(w,c,q);
END $$;
ALTER FUNCTION emdo.lock_tax_run_snapshot(uuid,uuid,integer) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.lock_tax_run_snapshot(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.lock_tax_run_snapshot(uuid,uuid,integer) TO emdo_app,emdo_policy_reader;
CREATE POLICY tax_working_review_read ON emdo.finance_tax_working_input_reviews FOR SELECT TO emdo_app USING(emdo.tax_run_snapshot_access(workspace_id,case_id,snapshot_revision));
CREATE POLICY tax_working_review_insert ON emdo.finance_tax_working_input_reviews FOR INSERT TO emdo_app WITH CHECK(emdo.tax_case_access(workspace_id,case_id,ARRAY['owner','reviewer']) AND created_by=emdo.current_user_id());
CREATE POLICY tax_calculation_read ON emdo.finance_tax_calculation_runs FOR SELECT TO emdo_app USING(emdo.tax_run_snapshot_access(workspace_id,case_id,snapshot_revision));
CREATE POLICY tax_calculation_insert ON emdo.finance_tax_calculation_runs FOR INSERT TO emdo_app WITH CHECK(emdo.tax_case_access(workspace_id,case_id,ARRAY['owner','preparer']) AND created_by=emdo.current_user_id());
CREATE POLICY tax_run_schedule_read ON emdo.finance_tax_run_schedules FOR SELECT TO emdo_app USING(emdo.tax_calculation_run_access(workspace_id,case_id,run_id));
CREATE POLICY tax_run_schedule_insert ON emdo.finance_tax_run_schedules FOR INSERT TO emdo_app WITH CHECK(emdo.tax_calculation_run_access(workspace_id,case_id,run_id) AND emdo.tax_case_access(workspace_id,case_id,ARRAY['owner','preparer']));
CREATE POLICY tax_run_review_read ON emdo.finance_tax_run_reviews FOR SELECT TO emdo_app USING(emdo.tax_calculation_run_access(workspace_id,case_id,run_id));
CREATE POLICY tax_run_review_insert ON emdo.finance_tax_run_reviews FOR INSERT TO emdo_app WITH CHECK(emdo.tax_calculation_run_access(workspace_id,case_id,run_id) AND emdo.tax_case_access(workspace_id,case_id,ARRAY['owner','reviewer']) AND created_by=emdo.current_user_id());
CREATE FUNCTION emdo.validate_tax_working_input_review() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE q emdo.finance_tax_case_snapshots;
BEGIN
 IF NOT emdo.lock_tax_case(NEW.workspace_id,NEW.case_id,ARRAY['owner','reviewer'],true) OR NOT emdo.lock_tax_run_snapshot(NEW.workspace_id,NEW.case_id,NEW.snapshot_revision) THEN RAISE EXCEPTION 'tax input review forbidden' USING ERRCODE='42501'; END IF;
 SELECT s.* INTO q FROM emdo.finance_tax_case_snapshots s JOIN emdo.finance_tax_cases c ON c.workspace_id=s.workspace_id AND c.id=s.case_id AND c.current_revision=s.revision WHERE s.workspace_id=NEW.workspace_id AND s.case_id=NEW.case_id AND s.revision=NEW.snapshot_revision;
 IF q.snapshot_hash IS DISTINCT FROM NEW.snapshot_hash OR q.tax_subject_id IS DISTINCT FROM NEW.tax_subject_id OR NEW.workflow_id<>'ca-on-2025-personal-working-papers' OR NEW.created_by<>emdo.current_user_id() THEN RAISE EXCEPTION 'tax input review binding conflict' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.questionnaire->'declarationSourceBindings') b JOIN emdo.finance_tax_fact_sources f ON f.workspace_id=NEW.workspace_id AND f.case_id=NEW.case_id AND f.id::text=b->>'sourceId' AND f.revision::text=b->>'sourceRevision' AND f.content_hash=b->>'contentHash' WHERE f.id=NEW.source_id AND f.revision=NEW.source_revision AND f.content_hash=NEW.source_hash AND f.tax_subject_id=NEW.tax_subject_id) THEN RAISE EXCEPTION 'tax input review source conflict' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION emdo.validate_tax_working_input_review() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.validate_tax_working_input_review() FROM PUBLIC;
CREATE TRIGGER validate_tax_working_input_review BEFORE INSERT ON emdo.finance_tax_working_input_reviews FOR EACH ROW EXECUTE FUNCTION emdo.validate_tax_working_input_review();
CREATE FUNCTION emdo.validate_tax_calculation_run() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE q emdo.finance_tax_case_snapshots; f jsonb;
BEGIN
 IF NOT emdo.lock_tax_case(NEW.workspace_id,NEW.case_id,ARRAY['owner','preparer'],true) OR NOT emdo.lock_tax_run_snapshot(NEW.workspace_id,NEW.case_id,NEW.snapshot_revision) THEN RAISE EXCEPTION 'tax calculation forbidden' USING ERRCODE='42501'; END IF;
 SELECT s.* INTO q FROM emdo.finance_tax_case_snapshots s JOIN emdo.finance_tax_cases c ON c.workspace_id=s.workspace_id AND c.id=s.case_id AND c.current_revision=s.revision WHERE s.workspace_id=NEW.workspace_id AND s.case_id=NEW.case_id AND s.revision=NEW.snapshot_revision;
 IF q.snapshot_hash IS DISTINCT FROM NEW.snapshot_hash OR q.tax_subject_id IS DISTINCT FROM NEW.tax_subject_id OR NEW.workflow_id<>'ca-on-2025-personal-working-papers' OR NEW.created_by<>emdo.current_user_id() OR NEW.complete OR NEW.output->'complete' IS DISTINCT FROM 'false'::jsonb OR NEW.output->'enabled' IS DISTINCT FROM 'false'::jsonb OR NEW.output->'reportable' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'tax run binding or readiness conflict' USING ERRCODE='23514'; END IF;
 IF NEW.input->'questionnaire' IS DISTINCT FROM q.questionnaire OR NEW.input#>'{calculationIntake}' IS DISTINCT FROM NEW.output->'inputSnapshot' OR ((NEW.input->'calculationIntake')-'facts') IS DISTINCT FROM ((q.questionnaire->'intake')-'facts') OR NEW.output->>'packageVersion' IS DISTINCT FROM NEW.package_version OR NEW.input->>'packageHash' IS DISTINCT FROM NEW.package_hash OR emdo.canonical_json_hash(NEW.input) IS DISTINCT FROM NEW.input_hash OR emdo.canonical_json_hash(NEW.output) IS DISTINCT FROM NEW.output_hash THEN RAISE EXCEPTION 'tax run input output integrity conflict' USING ERRCODE='23514'; END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(NEW.input#>'{calculationIntake,facts}') LOOP
  IF NOT EXISTS(SELECT 1 FROM emdo.finance_tax_fact_sources s JOIN jsonb_array_elements(q.questionnaire->'declarationSourceBindings') b ON b->>'sourceId'=s.id::text AND b->>'sourceRevision'=s.revision::text AND b->>'contentHash'=s.content_hash WHERE s.workspace_id=NEW.workspace_id AND s.case_id=NEW.case_id AND s.tax_subject_id=NEW.tax_subject_id AND f->>'key'=s.fact_key AND f->'value'=s.value AND f#>>'{source,kind}'='declaration' AND f#>>'{source,reference}'='declaration:'||s.id::text AND f#>>'{source,revision}'=s.revision::text AND f#>>'{source,contentHash}'=s.content_hash AND (f->>'reviewState'='unreviewed' OR (f->>'reviewState'='reviewed' AND EXISTS(SELECT 1 FROM emdo.finance_tax_working_input_reviews r WHERE r.workspace_id=s.workspace_id AND r.case_id=s.case_id AND r.snapshot_revision=NEW.snapshot_revision AND r.source_id=s.id AND r.source_revision=s.revision AND r.source_hash=s.content_hash AND r.package_hash=NEW.package_hash)))) THEN RAISE EXCEPTION 'tax run unreviewed or foreign input' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
ALTER FUNCTION emdo.validate_tax_calculation_run() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.validate_tax_calculation_run() FROM PUBLIC;
CREATE TRIGGER validate_tax_calculation_run BEFORE INSERT ON emdo.finance_tax_calculation_runs FOR EACH ROW EXECUTE FUNCTION emdo.validate_tax_calculation_run();
CREATE FUNCTION emdo.validate_tax_run_child() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on AS $$
DECLARE r emdo.finance_tax_calculation_runs;
BEGIN
 SELECT * INTO r FROM emdo.finance_tax_calculation_runs WHERE workspace_id=NEW.workspace_id AND case_id=NEW.case_id AND id=NEW.run_id;
 IF NOT FOUND OR NOT emdo.lock_tax_run_snapshot(NEW.workspace_id,NEW.case_id,r.snapshot_revision) THEN RAISE EXCEPTION 'tax run source forbidden' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='finance_tax_run_schedules' THEN
  IF NOT emdo.tax_case_access(NEW.workspace_id,NEW.case_id,ARRAY['owner','preparer']) OR emdo.canonical_json_hash(NEW.content) IS DISTINCT FROM NEW.content_hash OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.output->'scheduleManifest') s WHERE s->>'formId'=NEW.form_id AND s->>'contentHash'=NEW.content_hash) THEN RAISE EXCEPTION 'tax schedule integrity conflict' USING ERRCODE='23514'; END IF;
 ELSE
  IF NOT emdo.tax_case_access(NEW.workspace_id,NEW.case_id,ARRAY['owner','reviewer']) OR r.status<>'incomplete-working-papers' OR NEW.created_by<>emdo.current_user_id() OR NEW.output_hash IS DISTINCT FROM r.output_hash THEN RAISE EXCEPTION 'tax run review conflict' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION emdo.validate_tax_run_child() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.validate_tax_run_child() FROM PUBLIC;
CREATE TRIGGER validate_tax_run_schedule BEFORE INSERT ON emdo.finance_tax_run_schedules FOR EACH ROW EXECUTE FUNCTION emdo.validate_tax_run_child();
CREATE TRIGGER validate_tax_run_review BEFORE INSERT ON emdo.finance_tax_run_reviews FOR EACH ROW EXECUTE FUNCTION emdo.validate_tax_run_child();

-- Pure canonical serialization is required by the trusted integrity triggers.
GRANT EXECUTE ON FUNCTION emdo.canonical_json_text(jsonb), emdo.canonical_json_hash(jsonb) TO emdo_policy_reader;
