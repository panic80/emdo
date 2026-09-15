-- Activation is separate from approval. No application INSERT privilege is granted
-- until every read/write adapter participates in routing. No marker is created here.
CREATE TABLE emdo.finance_legacy_activations (
 workspace_id uuid NOT NULL,
 source_space_id uuid NOT NULL,
 source_owner_user_id uuid NOT NULL,
 book_id uuid NOT NULL,
 migration_id uuid NOT NULL,
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 target_hash text NOT NULL CHECK(target_hash ~ '^[a-f0-9]{64}$'),
 activated_by uuid NOT NULL CONSTRAINT finance_legacy_activations_actor REFERENCES emdo.auth_users(id),
 activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT finance_legacy_activations_pk PRIMARY KEY(workspace_id,source_space_id,source_owner_user_id),
 CONSTRAINT finance_legacy_activations_run UNIQUE(workspace_id,migration_id),
 CONSTRAINT finance_legacy_activations_run_fk FOREIGN KEY(workspace_id,book_id,migration_id) REFERENCES emdo.finance_legacy_migration_runs(workspace_id,book_id,id)
);
--> statement-breakpoint
ALTER TABLE emdo.finance_legacy_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_legacy_activations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON emdo.finance_legacy_activations FROM PUBLIC,emdo_app,emdo_worker,emdo_workflow;
GRANT SELECT ON emdo.finance_legacy_activations TO emdo_policy_reader,emdo_app;
CREATE POLICY legacy_activation_policy_reader ON emdo.finance_legacy_activations FOR SELECT TO emdo_policy_reader USING(true);
CREATE POLICY legacy_activation_read ON emdo.finance_legacy_activations FOR SELECT TO emdo_app USING(emdo.finance_legacy_migration_access(workspace_id,book_id,workspace_id,source_space_id,source_owner_user_id));
-- A future coordinated release may grant INSERT; its policy and trigger are already strict.
CREATE POLICY legacy_activation_insert ON emdo.finance_legacy_activations FOR INSERT TO emdo_app WITH CHECK(emdo.finance_legacy_migration_access(workspace_id,book_id,workspace_id,source_space_id,source_owner_user_id,ARRAY['administrator','approver']));
--> statement-breakpoint
CREATE FUNCTION emdo.lock_legacy_finance_source(w uuid,s uuid,o uuid) RETURNS void LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT pg_advisory_xact_lock(hashtextextended('legacy-finance:'||w::text||':'||s::text||':'||o::text,0))
$$;
REVOKE ALL ON FUNCTION emdo.lock_legacy_finance_source(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.lock_legacy_finance_source(uuid,uuid,uuid) TO emdo_app,emdo_policy_reader;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sync_entities','finance_normalized_import_rows','finance_normalized_imports','finance_financial_accounts','finance_economic_transactions','finance_journals','finance_import_row_reviews'] LOOP
  EXECUTE format('GRANT SELECT ON emdo.%I TO emdo_policy_reader',t);
  EXECUTE format('CREATE POLICY %I ON emdo.%I FOR SELECT TO emdo_policy_reader USING(true)','legacy_activation_'||t,t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION emdo.legacy_finance_activation_readiness(w uuid,m uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE r emdo.finance_legacy_migration_runs; source_data jsonb; target_data jsonb;
BEGIN
 SELECT * INTO r FROM emdo.finance_legacy_migration_runs WHERE workspace_id=w AND id=m;
 IF NOT FOUND OR emdo.finance_legacy_migration_access(w,r.book_id,w,r.source_space_id,r.source_owner_user_id,ARRAY['administrator','approver']) IS NOT TRUE THEN RAISE EXCEPTION 'legacy-activation-forbidden' USING ERRCODE='42501'; END IF;
 -- Source first, book second. Writers take the same source lock before mutation.
 PERFORM emdo.lock_legacy_finance_source(w,r.source_space_id,r.source_owner_user_id);
 IF NOT emdo.lock_finance_book_grant(w,r.book_id) THEN RAISE EXCEPTION 'legacy-activation-forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||':'||r.book_id::text,0));
 SELECT * INTO r FROM emdo.finance_legacy_migration_runs WHERE workspace_id=w AND id=m;
 IF r.status<>'cutover-approved' OR NOT EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_cutovers c JOIN emdo.finance_legacy_migration_comparisons p ON p.workspace_id=c.workspace_id AND p.migration_id=c.migration_id AND p.id=c.comparison_id WHERE c.workspace_id=w AND c.migration_id=m AND c.source_snapshot_hash=r.source_snapshot_hash AND p.source_snapshot_hash=r.source_snapshot_hash AND p.status='passed') THEN RAISE EXCEPTION 'legacy-activation-approval-required' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_records x WHERE x.workspace_id=w AND x.migration_id=m AND (x.candidate_status='blocked' OR x.disposition='unresolved' OR (x.disposition='backfill' AND x.backfill_state<>'backfilled'))) THEN RAISE EXCEPTION 'legacy-activation-unresolved' USING ERRCODE='23514'; END IF;
 -- The current source must be exactly the reviewed archival snapshot, not a stale digest supplied by a caller.
 IF EXISTS(
  SELECT 1 FROM emdo.sync_entities s FULL JOIN (SELECT * FROM emdo.finance_legacy_migration_records WHERE workspace_id=w AND migration_id=m) x ON x.legacy_row_id=s.id
  WHERE (x.id IS NOT NULL OR (s.household_id=w AND s.space_id=r.source_space_id AND s.original_owner_user_id=r.source_owner_user_id AND s.entity_type IN ('finance.account','finance.transaction','finance.category','finance.budget','finance.bill','finance.subscription','finance.goal')))
  AND (x.id IS NULL OR s.id IS NULL OR s.household_id IS DISTINCT FROM w OR s.space_id IS DISTINCT FROM r.source_space_id OR s.original_owner_user_id IS DISTINCT FROM r.source_owner_user_id OR s.entity_type IS DISTINCT FROM x.entity_type OR s.entity_id IS DISTINCT FROM x.entity_id OR s.revision IS DISTINCT FROM x.source_revision OR s.payload IS DISTINCT FROM x.payload OR (s.tombstoned_at IS NOT NULL) IS DISTINCT FROM x.tombstoned)
 ) THEN RAISE EXCEPTION 'legacy-activation-source-changed' USING ERRCODE='23514'; END IF;
 -- Nonzero openings have no posted-opening bridge yet; explicit mapping alone is not posting proof.
 IF EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_records x WHERE x.workspace_id=w AND x.migration_id=m AND x.entity_type='finance.account' AND NOT x.tombstoned AND (x.payload->>'openingBalanceCadMinor') IS DISTINCT FROM '0') THEN RAISE EXCEPTION 'legacy-activation-opening-posting-required' USING ERRCODE='23514'; END IF;
 -- One normalized account belongs to one private legacy source. Do not expose another source's transactions.
 IF EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_records x JOIN emdo.finance_legacy_migration_records y ON y.workspace_id=x.workspace_id AND y.book_id=x.book_id AND y.target_financial_account_id=x.target_financial_account_id AND y.entity_type='finance.account' JOIN emdo.finance_legacy_activations a ON a.workspace_id=y.workspace_id AND a.migration_id=y.migration_id WHERE x.workspace_id=w AND x.migration_id=m AND x.entity_type='finance.account' AND y.migration_id<>m) OR EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_records x WHERE x.workspace_id=w AND x.migration_id=m AND x.entity_type='finance.account' AND NOT x.tombstoned GROUP BY x.target_financial_account_id HAVING count(*)<>1) THEN RAISE EXCEPTION 'legacy-activation-account-shared' USING ERRCODE='23514'; END IF;
 IF EXISTS(
  SELECT 1 FROM emdo.finance_legacy_migration_records x
  LEFT JOIN emdo.finance_normalized_import_rows n ON n.workspace_id=x.workspace_id AND n.book_id=x.book_id AND n.id=x.target_row_id
  LEFT JOIN emdo.finance_normalized_imports b ON b.workspace_id=n.workspace_id AND b.book_id=n.book_id AND b.id=n.batch_id
  LEFT JOIN emdo.finance_financial_accounts a ON a.workspace_id=b.workspace_id AND a.book_id=b.book_id AND a.id=b.financial_account_id
  LEFT JOIN emdo.finance_economic_transactions e ON e.workspace_id=n.workspace_id AND e.book_id=n.book_id AND e.id=n.economic_transaction_id
  LEFT JOIN emdo.finance_journals j ON j.workspace_id=e.workspace_id AND j.book_id=e.book_id AND j.id=e.journal_id
  WHERE x.workspace_id=w AND x.migration_id=m AND x.entity_type='finance.transaction' AND NOT x.tombstoned
  AND (n.id IS NULL OR b.status IS DISTINCT FROM 'committed' OR n.status NOT IN ('committed','matched') OR e.id IS NULL OR j.status IS DISTINCT FROM 'posted'
   OR n.native_amount IS DISTINCT FROM x.native_amount OR e.native_amount IS DISTINCT FROM x.native_amount OR a.currency IS DISTINCT FROM x.currency
   OR b.financial_account_id IS DISTINCT FROM x.target_financial_account_id OR e.financial_account_id IS DISTINCT FROM x.target_financial_account_id
   OR n.effective_on::text IS DISTINCT FROM x.payload->>'postedOn' OR e.effective_on IS DISTINCT FROM n.effective_on OR n.description IS DISTINCT FROM x.payload->>'description' OR e.description IS DISTINCT FROM n.description
   OR n.source_facts#>'{legacyMigration,provenance}' IS DISTINCT FROM x.provenance
   OR n.external_id IS DISTINCT FROM x.external_id OR n.source_facts#>>'{legacyMigration,payloadHash}' IS DISTINCT FROM x.payload_hash
   OR NOT EXISTS(SELECT 1 FROM emdo.finance_import_row_reviews v WHERE v.workspace_id=n.workspace_id AND v.book_id=n.book_id AND v.row_id=n.id AND v.revision=n.revision))
 ) THEN RAISE EXCEPTION 'legacy-activation-posted-target-required' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_records a JOIN emdo.finance_economic_transactions e ON e.workspace_id=a.workspace_id AND e.book_id=a.book_id AND e.financial_account_id=a.target_financial_account_id WHERE a.workspace_id=w AND a.migration_id=m AND a.entity_type='finance.account' AND NOT a.tombstoned AND NOT EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_records x JOIN emdo.finance_normalized_import_rows n ON n.workspace_id=x.workspace_id AND n.book_id=x.book_id AND n.id=x.target_row_id WHERE x.workspace_id=w AND x.migration_id=m AND NOT x.tombstoned AND n.economic_transaction_id=e.id)) THEN RAISE EXCEPTION 'legacy-activation-account-existing-unmapped-transactions' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM emdo.finance_legacy_migration_records x JOIN emdo.finance_normalized_import_rows n ON n.workspace_id=x.workspace_id AND n.book_id=x.book_id AND n.id=x.target_row_id WHERE x.workspace_id=w AND x.migration_id=m AND x.entity_type='finance.transaction' AND NOT x.tombstoned GROUP BY n.economic_transaction_id HAVING count(*)>1) THEN RAISE EXCEPTION 'legacy-activation-duplicate-target' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_array(x.legacy_row_id,x.entity_type,x.entity_id,x.source_revision,x.payload,x.tombstoned) ORDER BY x.entity_type,x.entity_id),'[]'::jsonb) INTO source_data FROM emdo.finance_legacy_migration_records x WHERE x.workspace_id=w AND x.migration_id=m;
 SELECT coalesce(jsonb_agg(jsonb_build_array(x.target_row_id,n.revision,n.status,e.id,e.journal_id,e.native_amount::text,e.description,e.effective_on,e.fingerprint) ORDER BY x.entity_id),'[]'::jsonb) INTO target_data FROM emdo.finance_legacy_migration_records x JOIN emdo.finance_normalized_import_rows n ON n.workspace_id=x.workspace_id AND n.book_id=x.book_id AND n.id=x.target_row_id JOIN emdo.finance_economic_transactions e ON e.workspace_id=n.workspace_id AND e.book_id=n.book_id AND e.id=n.economic_transaction_id WHERE x.workspace_id=w AND x.migration_id=m AND x.entity_type='finance.transaction' AND NOT x.tombstoned;
 RETURN jsonb_build_object('sourceHash',emdo.canonical_json_hash(source_data),'targetHash',emdo.canonical_json_hash(target_data),'bookId',r.book_id,'sourceSpaceId',r.source_space_id,'sourceOwnerUserId',r.source_owner_user_id);
END $$;
ALTER FUNCTION emdo.legacy_finance_activation_readiness(uuid,uuid) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.legacy_finance_activation_readiness(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.legacy_finance_activation_readiness(uuid,uuid) TO emdo_app,emdo_policy_reader;
--> statement-breakpoint
CREATE FUNCTION emdo.check_legacy_finance_activation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE ready jsonb;
BEGIN
 ready:=emdo.legacy_finance_activation_readiness(NEW.workspace_id,NEW.migration_id);
 IF NEW.book_id::text IS DISTINCT FROM ready->>'bookId' OR NEW.source_space_id::text IS DISTINCT FROM ready->>'sourceSpaceId' OR NEW.source_owner_user_id::text IS DISTINCT FROM ready->>'sourceOwnerUserId' OR NEW.source_hash IS DISTINCT FROM ready->>'sourceHash' OR NEW.target_hash IS DISTINCT FROM ready->>'targetHash' THEN RAISE EXCEPTION 'legacy-activation-binding-changed' USING ERRCODE='23514'; END IF;
 NEW.activated_by:=emdo.current_user_id(); NEW.activated_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER legacy_activation_guard BEFORE INSERT ON emdo.finance_legacy_activations FOR EACH ROW EXECUTE FUNCTION emdo.check_legacy_finance_activation();
CREATE TRIGGER legacy_activation_immutable BEFORE UPDATE OR DELETE ON emdo.finance_legacy_activations FOR EACH ROW EXECUTE FUNCTION emdo.reject_finance_legacy_migration_history_mutation();
REVOKE ALL ON FUNCTION emdo.check_legacy_finance_activation() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION emdo.resolve_legacy_finance_route(w uuid,s uuid,o uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE a emdo.finance_legacy_activations;
BEGIN
 IF o IS DISTINCT FROM emdo.current_user_id() OR emdo.is_active_request_scope(w,s,NULL) IS NOT TRUE THEN RAISE EXCEPTION 'legacy-route-private-scope-forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM emdo.finance_legacy_activations WHERE workspace_id=w AND source_space_id=s AND source_owner_user_id=o;
 IF NOT FOUND THEN RETURN '{"kind":"legacy"}'::jsonb; END IF;
 IF emdo.finance_legacy_migration_access(w,a.book_id,w,s,o) IS NOT TRUE THEN RAISE EXCEPTION 'legacy-route-target-forbidden' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('kind','normalized','migrationId',a.migration_id,'bookId',a.book_id,'activatedAt',a.activated_at);
END $$;
ALTER FUNCTION emdo.resolve_legacy_finance_route(uuid,uuid,uuid) OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.resolve_legacy_finance_route(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.resolve_legacy_finance_route(uuid,uuid,uuid) TO emdo_app;
--> statement-breakpoint
CREATE FUNCTION emdo.guard_activated_legacy_finance_writer() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE old_scope jsonb; new_scope jsonb; scope jsonb;
BEGIN
 IF TG_OP<>'INSERT' AND OLD.entity_type IN ('finance.account','finance.transaction','finance.category','finance.budget','finance.bill','finance.subscription','finance.goal') THEN old_scope:=jsonb_build_array(OLD.household_id,OLD.space_id,OLD.original_owner_user_id); END IF;
 IF TG_OP<>'DELETE' AND NEW.entity_type IN ('finance.account','finance.transaction','finance.category','finance.budget','finance.bill','finance.subscription','finance.goal') THEN new_scope:=jsonb_build_array(NEW.household_id,NEW.space_id,NEW.original_owner_user_id); END IF;
 FOR scope IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(old_scope,new_scope)) WHERE value<>'null'::jsonb ORDER BY value LOOP
  PERFORM emdo.lock_legacy_finance_source((scope->>0)::uuid,(scope->>1)::uuid,(scope->>2)::uuid);
  IF EXISTS(SELECT 1 FROM emdo.finance_legacy_activations WHERE workspace_id=(scope->>0)::uuid AND source_space_id=(scope->>1)::uuid AND source_owner_user_id=(scope->>2)::uuid) THEN RAISE EXCEPTION 'legacy-finance-writer-retired' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
ALTER FUNCTION emdo.guard_activated_legacy_finance_writer() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.guard_activated_legacy_finance_writer() FROM PUBLIC;
CREATE TRIGGER guard_activated_legacy_finance_writer BEFORE INSERT OR UPDATE OR DELETE ON emdo.sync_entities FOR EACH ROW EXECUTE FUNCTION emdo.guard_activated_legacy_finance_writer();
--> statement-breakpoint
CREATE FUNCTION emdo.guard_activated_legacy_archive() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,emdo SET row_security=on AS $$
DECLARE old_scope jsonb; new_scope jsonb; scope jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN old_scope:=jsonb_build_array(OLD.workspace_id,OLD.source_space_id,OLD.source_owner_user_id,OLD.migration_id); END IF;
 IF TG_OP<>'DELETE' THEN new_scope:=jsonb_build_array(NEW.workspace_id,NEW.source_space_id,NEW.source_owner_user_id,NEW.migration_id); END IF;
 FOR scope IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(old_scope,new_scope)) WHERE value<>'null'::jsonb ORDER BY value LOOP
  PERFORM emdo.lock_legacy_finance_source((scope->>0)::uuid,(scope->>1)::uuid,(scope->>2)::uuid);
  IF EXISTS(SELECT 1 FROM emdo.finance_legacy_activations WHERE workspace_id=(scope->>0)::uuid AND migration_id=(scope->>3)::uuid) THEN RAISE EXCEPTION 'legacy-activation-archive-immutable' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
ALTER FUNCTION emdo.guard_activated_legacy_archive() OWNER TO emdo_policy_reader;
REVOKE ALL ON FUNCTION emdo.guard_activated_legacy_archive() FROM PUBLIC;
CREATE TRIGGER guard_activated_legacy_archive BEFORE INSERT OR UPDATE OR DELETE ON emdo.finance_legacy_migration_records FOR EACH ROW EXECUTE FUNCTION emdo.guard_activated_legacy_archive();
