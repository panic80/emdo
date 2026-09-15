-- Explicit, revocable private-source routing. Assignment does not establish an opening balance.
CREATE TABLE emdo.finance_account_source_assignments (
 workspace_id uuid NOT NULL, book_id uuid NOT NULL, account_id uuid NOT NULL,
 source_space_id uuid NOT NULL, source_owner_user_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), status text NOT NULL CHECK(status IN ('active','revoked')),
 compatibility_account_kind text NOT NULL CONSTRAINT finance_account_source_assignments_kind CHECK(compatibility_account_kind IN ('cash','chequing','savings','credit','other')),
 migration_id uuid, legacy_entity_id text,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 changed_by uuid NOT NULL CONSTRAINT finance_account_source_assignments_actor_fk REFERENCES emdo.auth_users(id), changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT finance_account_source_assignments_pk PRIMARY KEY(workspace_id,book_id,account_id),
 CONSTRAINT finance_account_source_assignments_account_fk FOREIGN KEY(workspace_id,book_id,account_id) REFERENCES emdo.finance_financial_accounts(workspace_id,book_id,id),
 CONSTRAINT finance_account_source_assignments_space_fk FOREIGN KEY(workspace_id,source_space_id) REFERENCES emdo.spaces(household_id,id),
 CONSTRAINT finance_account_source_assignments_owner_fk FOREIGN KEY(workspace_id,source_owner_user_id) REFERENCES emdo.household_memberships(household_id,user_id),
 CONSTRAINT finance_account_source_assignments_migration_fk FOREIGN KEY(workspace_id,book_id,migration_id) REFERENCES emdo.finance_legacy_migration_runs(workspace_id,book_id,id),
 CONSTRAINT finance_account_source_assignments_legacy_pair CHECK((migration_id IS NULL)=(legacy_entity_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE emdo.finance_account_source_assignment_events (
 workspace_id uuid NOT NULL, book_id uuid NOT NULL, account_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 source_space_id uuid NOT NULL, source_owner_user_id uuid NOT NULL,
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 changed_by uuid NOT NULL CONSTRAINT finance_account_source_assignment_events_actor_fk REFERENCES emdo.auth_users(id), changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT finance_account_source_assignment_events_pk PRIMARY KEY(workspace_id,book_id,account_id,revision),
 CONSTRAINT finance_account_source_assignment_events_head_fk FOREIGN KEY(workspace_id,book_id,account_id) REFERENCES emdo.finance_account_source_assignments(workspace_id,book_id,account_id),
 CONSTRAINT finance_account_source_assignment_events_space_fk FOREIGN KEY(workspace_id,source_space_id) REFERENCES emdo.spaces(household_id,id),
 CONSTRAINT finance_account_source_assignment_events_owner_fk FOREIGN KEY(workspace_id,source_owner_user_id) REFERENCES emdo.household_memberships(household_id,user_id)
);
--> statement-breakpoint
-- Only already-activated exact mapping associations are copied; no new ownership is inferred.
INSERT INTO emdo.finance_account_source_assignments(workspace_id,book_id,account_id,source_space_id,source_owner_user_id,revision,status,compatibility_account_kind,migration_id,legacy_entity_id,reason,changed_by,changed_at)
 SELECT a.workspace_id,a.book_id,x.target_financial_account_id,a.source_space_id,a.source_owner_user_id,1,'active',x.payload->>'accountKind',a.migration_id,x.entity_id,'Approved migration association',a.activated_by,a.activated_at
 FROM emdo.finance_legacy_activations a JOIN emdo.finance_legacy_migration_records x ON x.workspace_id=a.workspace_id AND x.book_id=a.book_id AND x.migration_id=a.migration_id
 WHERE x.entity_type='finance.account' AND NOT x.tombstoned AND x.backfill_state='backfilled';
INSERT INTO emdo.finance_account_source_assignment_events(workspace_id,book_id,account_id,revision,source_space_id,source_owner_user_id,snapshot,changed_by,changed_at)
 SELECT h.workspace_id,h.book_id,h.account_id,h.revision,h.source_space_id,h.source_owner_user_id,to_jsonb(h),h.changed_by,h.changed_at FROM emdo.finance_account_source_assignments h;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['finance_account_source_assignments','finance_account_source_assignment_events'] LOOP
  EXECUTE format('ALTER TABLE emdo.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE emdo.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON emdo.%I FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow',t);
  EXECUTE format('GRANT SELECT ON emdo.%I TO emdo_app',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON emdo.%I TO emdo_policy_reader',t);
  EXECUTE format('CREATE POLICY %I ON emdo.%I FOR ALL TO emdo_policy_reader USING(true) WITH CHECK(true)',t||'_internal',t);
  EXECUTE format('CREATE POLICY %I ON emdo.%I FOR SELECT TO emdo_app USING(emdo.finance_legacy_migration_access(workspace_id,book_id,workspace_id,source_space_id,source_owner_user_id))',t||'_read',t);
 END LOOP;
END $$;
CREATE TRIGGER finance_account_source_assignment_events_immutable BEFORE UPDATE OR DELETE ON emdo.finance_account_source_assignment_events FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_legacy_migration_history_mutation();
--> statement-breakpoint
CREATE FUNCTION emdo.set_legacy_finance_account_assignment(w uuid,b uuid,a uuid,expected_revision integer,s uuid,kind text,reason_text text,revoke boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE previous emdo.finance_account_source_assignments; saved emdo.finance_account_source_assignments; actor uuid; observed_source uuid; source uuid; lock_source uuid; account_kind text; mapped emdo.finance_legacy_migration_records;
BEGIN
 actor:=emdo.current_user_id();
 IF actor IS NULL OR expected_revision IS NULL OR expected_revision<0 OR length(btrim(reason_text)) NOT BETWEEN 1 AND 1000 OR reason_text IS NULL THEN RAISE EXCEPTION 'account-source-input-invalid' USING ERRCODE='23514'; END IF;
 SELECT * INTO previous FROM emdo.finance_account_source_assignments WHERE workspace_id=w AND book_id=b AND account_id=a;
 observed_source:=previous.source_space_id;
 source:=CASE WHEN revoke THEN previous.source_space_id ELSE s END;
 IF source IS NULL OR (previous.account_id IS NOT NULL AND previous.source_owner_user_id IS DISTINCT FROM actor) THEN RAISE EXCEPTION 'account-source-private-forbidden' USING ERRCODE='42501'; END IF;
 FOR lock_source IN SELECT DISTINCT value FROM unnest(ARRAY[source,previous.source_space_id]) value WHERE value IS NOT NULL ORDER BY value LOOP
  IF emdo.is_active_request_scope(w,lock_source,NULL) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM emdo.spaces p WHERE p.household_id=w AND p.id=lock_source AND p.visibility='private' AND p.original_owner_user_id=actor) THEN RAISE EXCEPTION 'account-source-private-forbidden' USING ERRCODE='42501'; END IF;
  PERFORM emdo.lock_legacy_finance_source(w,lock_source,actor);
 END LOOP;
 IF emdo.lock_finance_book_grant(w,b) IS NOT TRUE OR emdo.finance_book_access(w,b,ARRAY['administrator','approver']) IS NOT TRUE THEN RAISE EXCEPTION 'account-source-book-forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||b::text,0));
 SELECT * INTO previous FROM emdo.finance_account_source_assignments WHERE workspace_id=w AND book_id=b AND account_id=a FOR UPDATE;
 IF previous.source_space_id IS DISTINCT FROM observed_source THEN RAISE EXCEPTION 'account-source-revision-conflict' USING ERRCODE='40001'; END IF;
 IF coalesce(previous.revision,0)<>expected_revision THEN RAISE EXCEPTION 'account-source-revision-conflict' USING ERRCODE='40001'; END IF;
 IF previous.account_id IS NOT NULL AND previous.source_owner_user_id IS DISTINCT FROM actor THEN RAISE EXCEPTION 'account-source-private-forbidden' USING ERRCODE='42501'; END IF;
 IF revoke AND previous.account_id IS NULL THEN RAISE EXCEPTION 'account-source-assignment-required' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM emdo.finance_legacy_activations r WHERE r.workspace_id=w AND r.book_id=b AND r.source_space_id=source AND r.source_owner_user_id=actor) THEN RAISE EXCEPTION 'account-source-active-route-required' USING ERRCODE='23514'; END IF;
 SELECT f.kind INTO account_kind FROM emdo.finance_financial_accounts f WHERE f.workspace_id=w AND f.book_id=b AND f.id=a;
 IF NOT FOUND THEN RAISE EXCEPTION 'account-source-account-forbidden' USING ERRCODE='42501'; END IF;
 kind:=CASE WHEN revoke THEN previous.compatibility_account_kind ELSE kind END;
 IF NOT revoke AND ((account_kind='cash' AND kind='cash') OR (account_kind='credit-card' AND kind='credit') OR (account_kind='brokerage' AND kind='other') OR (account_kind='bank' AND kind IN ('chequing','savings','other'))) IS NOT TRUE THEN RAISE EXCEPTION 'account-source-kind-invalid' USING ERRCODE='23514'; END IF;
 SELECT x.* INTO mapped FROM emdo.finance_legacy_activations r JOIN emdo.finance_legacy_migration_records x ON x.workspace_id=r.workspace_id AND x.book_id=r.book_id AND x.migration_id=r.migration_id WHERE r.workspace_id=w AND r.book_id=b AND r.source_space_id=source AND r.source_owner_user_id=actor AND x.entity_type='finance.account' AND NOT x.tombstoned AND x.target_financial_account_id=a;
 -- Migrated account identities cannot be moved to another source by relabeling the account.
 IF previous.migration_id IS NOT NULL AND (previous.source_space_id IS DISTINCT FROM source OR mapped.migration_id IS DISTINCT FROM previous.migration_id) THEN RAISE EXCEPTION 'account-source-migrated-identity-fixed' USING ERRCODE='23514'; END IF;
 INSERT INTO emdo.finance_account_source_assignments(workspace_id,book_id,account_id,source_space_id,source_owner_user_id,revision,status,compatibility_account_kind,migration_id,legacy_entity_id,reason,changed_by)
 VALUES(w,b,a,source,actor,expected_revision+1,CASE WHEN revoke THEN 'revoked' ELSE 'active' END,kind,mapped.migration_id,mapped.entity_id,btrim(reason_text),actor)
 ON CONFLICT(workspace_id,book_id,account_id) DO UPDATE SET source_space_id=excluded.source_space_id,source_owner_user_id=excluded.source_owner_user_id,revision=excluded.revision,status=excluded.status,compatibility_account_kind=excluded.compatibility_account_kind,migration_id=excluded.migration_id,legacy_entity_id=excluded.legacy_entity_id,reason=excluded.reason,changed_by=excluded.changed_by,changed_at=clock_timestamp()
 RETURNING * INTO saved;
 INSERT INTO emdo.finance_account_source_assignment_events(workspace_id,book_id,account_id,revision,source_space_id,source_owner_user_id,snapshot,changed_by,changed_at) VALUES(w,b,a,saved.revision,source,actor,to_jsonb(saved),actor,saved.changed_at);
 RETURN to_jsonb(saved);
END $$;
ALTER FUNCTION emdo.set_legacy_finance_account_assignment(uuid,uuid,uuid,integer,uuid,text,text,boolean) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.set_legacy_finance_account_assignment(uuid,uuid,uuid,integer,uuid,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.set_legacy_finance_account_assignment(uuid,uuid,uuid,integer,uuid,text,text,boolean) TO emdo_app;
--> statement-breakpoint
CREATE FUNCTION emdo.list_legacy_finance_assignment_sources(w uuid,b uuid) RETURNS TABLE(source_space_id uuid,name text,source_owner_user_id uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog,emdo SET row_security=on AS $$
 SELECT a.source_space_id,s.name,a.source_owner_user_id FROM emdo.finance_legacy_activations a JOIN emdo.spaces s ON s.household_id=a.workspace_id AND s.id=a.source_space_id
 WHERE a.workspace_id=w AND a.book_id=b AND a.source_owner_user_id=emdo.current_user_id() AND s.visibility='private' AND s.original_owner_user_id=emdo.current_user_id() AND emdo.finance_book_access(w,b,ARRAY['administrator','approver'])
 ORDER BY s.name,a.source_space_id LIMIT 1001
$$;
REVOKE ALL ON FUNCTION emdo.list_legacy_finance_assignment_sources(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.list_legacy_finance_assignment_sources(uuid,uuid) TO emdo_app;
--> statement-breakpoint
-- Future guarded activations retain the same exact reviewed associations atomically.
CREATE FUNCTION emdo.seed_activated_account_source_assignments() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE x emdo.finance_legacy_migration_records;
BEGIN
 FOR x IN SELECT * FROM emdo.finance_legacy_migration_records WHERE workspace_id=NEW.workspace_id AND book_id=NEW.book_id AND migration_id=NEW.migration_id AND entity_type='finance.account' AND NOT tombstoned AND backfill_state='backfilled' LOOP
  PERFORM emdo.set_legacy_finance_account_assignment(NEW.workspace_id,NEW.book_id,x.target_financial_account_id,0,NEW.source_space_id,x.payload->>'accountKind','Approved migration association',false);
 END LOOP;
 RETURN NEW;
END $$;
ALTER FUNCTION emdo.seed_activated_account_source_assignments() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.seed_activated_account_source_assignments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.set_legacy_finance_account_assignment(uuid,uuid,uuid,integer,uuid,text,text,boolean) TO emdo_policy_reader;
CREATE TRIGGER seed_activated_account_source_assignments AFTER INSERT ON emdo.finance_legacy_activations FOR EACH ROW EXECUTE FUNCTION emdo.seed_activated_account_source_assignments();
