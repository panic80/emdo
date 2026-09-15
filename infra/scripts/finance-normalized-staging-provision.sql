-- Deployment-owner only. Execute using psql --set=ON_ERROR_STOP=1 with
-- normalized_staging=true, environment=staging, synthetic_only=true,
-- book_id=<seed output>, workspace_id, household_slug, synthetic_owner_email,
-- max_run_cad_minor and max_day_cad_minor. Run only against a disposable run DB.
-- No credentials, key generation, worker startup, or provider calls occur here.
BEGIN;
SELECT set_config('emdo.provision.normalized_staging', :'normalized_staging', true),
       set_config('emdo.provision.environment', :'environment', true),
       set_config('emdo.provision.synthetic_only', :'synthetic_only', true),
       set_config('emdo.provision.workspace_id', :'workspace_id', true),
       set_config('emdo.provision.household_slug', :'household_slug', true),
       set_config('emdo.provision.owner_email', :'synthetic_owner_email', true),
       set_config('emdo.provision.book_id', :'book_id', true),
       set_config('emdo.provision.max_run', :'max_run_cad_minor', true),
       set_config('emdo.provision.max_day', :'max_day_cad_minor', true);
DO $$
DECLARE b emdo.finance_books%ROWTYPE; r integer; d integer;
BEGIN
  IF current_setting('emdo.provision.normalized_staging') <> 'true'
    OR current_setting('emdo.provision.environment') <> 'staging'
    OR current_setting('emdo.provision.synthetic_only') <> 'true' THEN
    RAISE EXCEPTION 'normalized-synthetic-staging-only';
  END IF;
  SELECT * INTO STRICT b FROM emdo.finance_books
    WHERE id=current_setting('emdo.provision.book_id')::uuid FOR UPDATE;
  IF b.workspace_id <> current_setting('emdo.provision.workspace_id')::uuid
    OR (SELECT count(*) FROM emdo.workspaces) <> 1
    OR current_setting('emdo.provision.owner_email') !~ '^[^@]+@[^@]+[.]invalid$'
    OR NOT EXISTS (SELECT FROM emdo.households h JOIN emdo.household_memberships m ON m.household_id=h.id JOIN emdo.auth_users u ON u.id=m.user_id WHERE h.id=b.workspace_id AND h.slug=current_setting('emdo.provision.household_slug') AND u.id=b.created_by AND u.email=current_setting('emdo.provision.owner_email') AND m.role='owner' AND m.status='active' AND m.ended_at IS NULL)
    OR b.name <> 'Synthetic normalized staging' OR b.functional_currency <> 'CAD'
    OR EXISTS (SELECT FROM emdo.finance_books WHERE workspace_id <> b.workspace_id)
    OR EXISTS (SELECT FROM emdo.finance_journals WHERE book_id=b.id) THEN
    RAISE EXCEPTION 'isolated-empty-synthetic-finance-book-required';
  END IF;
  r := current_setting('emdo.provision.max_run')::integer;
  d := current_setting('emdo.provision.max_day')::integer;
  IF r < 1 OR r > 100 OR d < r OR d > 500 THEN
    RAISE EXCEPTION 'synthetic-budget-out-of-bounds';
  END IF;
  INSERT INTO emdo.workspace_entitlements(workspace_id,capability,enabled)
    VALUES(b.workspace_id,'finance.standardizations.run',true)
    ON CONFLICT(workspace_id,capability) DO UPDATE SET enabled=true, revision=emdo.workspace_entitlements.revision+1;
  INSERT INTO emdo.finance_standardization_configuration(id,ready,max_run_cad_minor,max_workspace_day_cad_minor)
    VALUES('v1',true,r,d)
    ON CONFLICT(id) DO UPDATE SET ready=true,max_run_cad_minor=r,max_workspace_day_cad_minor=d;
END $$;
COMMIT;
