CREATE TABLE "emdo"."deployment_bootstraps" (
	"bootstrap_key" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"user_id" uuid,
	"household_id" uuid,
	"membership_id" uuid,
	"private_space_id" uuid,
	CONSTRAINT "deployment_bootstraps_key_check"
		CHECK ("bootstrap_key" = 'initial-owner-v1'),
	CONSTRAINT "deployment_bootstraps_state_check"
		CHECK ("state" in ('in_progress', 'complete')),
	CONSTRAINT "deployment_bootstraps_terminal_check"
		CHECK (
			(
				"state" = 'in_progress'
				AND "completed_at" IS NULL
				AND "user_id" IS NULL
				AND "household_id" IS NULL
				AND "membership_id" IS NULL
				AND "private_space_id" IS NULL
			)
			OR (
				"state" = 'complete'
				AND "completed_at" IS NOT NULL
				AND "completed_at" >= "started_at"
				AND "user_id" IS NOT NULL
				AND "household_id" IS NOT NULL
				AND "membership_id" IS NOT NULL
				AND "private_space_id" IS NOT NULL
			)
		),
	CONSTRAINT "deployment_bootstraps_user_unique" UNIQUE("user_id"),
	CONSTRAINT "deployment_bootstraps_household_unique" UNIQUE("household_id"),
	CONSTRAINT "deployment_bootstraps_membership_unique" UNIQUE("membership_id"),
	CONSTRAINT "deployment_bootstraps_private_space_unique" UNIQUE("private_space_id"),
	CONSTRAINT "deployment_bootstraps_user_fk"
		FOREIGN KEY ("user_id") REFERENCES "emdo"."auth_users"("id")
		ON DELETE restrict ON UPDATE restrict,
	CONSTRAINT "deployment_bootstraps_household_fk"
		FOREIGN KEY ("household_id") REFERENCES "emdo"."households"("id")
		ON DELETE restrict ON UPDATE restrict,
	CONSTRAINT "deployment_bootstraps_membership_fk"
		FOREIGN KEY ("membership_id") REFERENCES "emdo"."household_memberships"("id")
		ON DELETE restrict ON UPDATE restrict,
	CONSTRAINT "deployment_bootstraps_private_space_fk"
		FOREIGN KEY ("private_space_id") REFERENCES "emdo"."spaces"("id")
		ON DELETE restrict ON UPDATE restrict
);
--> statement-breakpoint
ALTER TABLE "emdo"."deployment_bootstraps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."deployment_bootstraps" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $roles$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_owner_bootstrap'
	) THEN
		CREATE ROLE emdo_owner_bootstrap NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_owner_bootstrap_executor'
	) THEN
		CREATE ROLE emdo_owner_bootstrap_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$roles$;
--> statement-breakpoint
ALTER ROLE emdo_owner_bootstrap NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_owner_bootstrap_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
--> statement-breakpoint
DO $membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		WHERE membership.roleid IN (
			SELECT oid FROM pg_catalog.pg_roles
			WHERE rolname IN ('emdo_owner_bootstrap', 'emdo_owner_bootstrap_executor')
		)
		OR membership.member IN (
			SELECT oid FROM pg_catalog.pg_roles
			WHERE rolname IN ('emdo_owner_bootstrap', 'emdo_owner_bootstrap_executor')
		)
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'owner bootstrap roles must not have role memberships during migration';
	END IF;
END
$membership_guard$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA "emdo" FROM emdo_owner_bootstrap, emdo_owner_bootstrap_executor;
REVOKE ALL ON ALL TABLES IN SCHEMA "emdo" FROM emdo_owner_bootstrap, emdo_owner_bootstrap_executor;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "emdo" FROM emdo_owner_bootstrap, emdo_owner_bootstrap_executor;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "emdo" FROM emdo_owner_bootstrap, emdo_owner_bootstrap_executor;
GRANT USAGE ON SCHEMA "emdo" TO emdo_owner_bootstrap, emdo_owner_bootstrap_executor;
--> statement-breakpoint
CREATE POLICY owner_bootstrap_marker_insert ON "emdo"."deployment_bootstraps"
FOR INSERT TO emdo_owner_bootstrap_executor
WITH CHECK (
	bootstrap_key = 'initial-owner-v1'
	AND state = 'in_progress'
	AND completed_at IS NULL
	AND user_id IS NULL
	AND household_id IS NULL
	AND membership_id IS NULL
	AND private_space_id IS NULL
);
CREATE POLICY owner_bootstrap_marker_read ON "emdo"."deployment_bootstraps"
FOR SELECT TO emdo_owner_bootstrap_executor
USING (bootstrap_key = 'initial-owner-v1');
CREATE POLICY owner_bootstrap_marker_complete ON "emdo"."deployment_bootstraps"
FOR UPDATE TO emdo_owner_bootstrap_executor
USING (bootstrap_key = 'initial-owner-v1' AND state = 'in_progress')
WITH CHECK (
	bootstrap_key = 'initial-owner-v1'
	AND state = 'complete'
	AND completed_at IS NOT NULL
	AND user_id IS NOT NULL
	AND household_id IS NOT NULL
	AND membership_id IS NOT NULL
	AND private_space_id IS NOT NULL
);
CREATE POLICY owner_bootstrap_household_insert ON "emdo"."households"
FOR INSERT TO emdo_owner_bootstrap_executor
WITH CHECK (
	created_by_user_id IS NOT NULL
	AND pg_catalog.char_length(slug) BETWEEN 1 AND 63
);
CREATE POLICY owner_bootstrap_household_empty_check ON "emdo"."households"
FOR SELECT TO emdo_owner_bootstrap_executor
USING (true);
CREATE POLICY owner_bootstrap_membership_insert ON "emdo"."household_memberships"
FOR INSERT TO emdo_owner_bootstrap_executor
WITH CHECK (role = 'owner' AND status = 'active' AND ended_at IS NULL);
CREATE POLICY owner_bootstrap_membership_empty_check ON "emdo"."household_memberships"
FOR SELECT TO emdo_owner_bootstrap_executor
USING (true);
CREATE POLICY owner_bootstrap_space_insert ON "emdo"."spaces"
FOR INSERT TO emdo_owner_bootstrap_executor
WITH CHECK (
	visibility = 'private'
	AND revision = 1
	AND tombstoned_at IS NULL
);
CREATE POLICY owner_bootstrap_audit_insert ON "emdo"."audit_events"
FOR INSERT TO emdo_owner_bootstrap_executor
WITH CHECK (
	event_type = 'identity.owner-bootstrapped'
	AND actor_user_id = original_owner_user_id
);
--> statement-breakpoint
GRANT INSERT (id, name, email, email_verified, created_at, updated_at)
	ON "emdo"."auth_users" TO emdo_owner_bootstrap_executor;
GRANT SELECT (id) ON "emdo"."auth_users" TO emdo_owner_bootstrap_executor;
GRANT INSERT (id, user_id, account_id, provider_id, password, created_at, updated_at)
	ON "emdo"."auth_accounts" TO emdo_owner_bootstrap_executor;
GRANT INSERT (id, name, slug, created_by_user_id, created_at, updated_at)
	ON "emdo"."households" TO emdo_owner_bootstrap_executor;
GRANT SELECT (id) ON "emdo"."households" TO emdo_owner_bootstrap_executor;
GRANT INSERT (id, household_id, user_id, role, status, joined_at, updated_at)
	ON "emdo"."household_memberships" TO emdo_owner_bootstrap_executor;
GRANT SELECT (id) ON "emdo"."household_memberships" TO emdo_owner_bootstrap_executor;
GRANT INSERT (id, household_id, original_owner_user_id, name, visibility,
	revision, created_at, updated_at)
	ON "emdo"."spaces" TO emdo_owner_bootstrap_executor;
GRANT INSERT (id, household_id, space_id, original_owner_user_id, actor_user_id,
	event_type, payload, occurred_at, retain_until)
	ON "emdo"."audit_events" TO emdo_owner_bootstrap_executor;
GRANT SELECT (bootstrap_key, state)
	ON "emdo"."deployment_bootstraps" TO emdo_owner_bootstrap_executor;
GRANT INSERT (bootstrap_key, state, started_at)
	ON "emdo"."deployment_bootstraps" TO emdo_owner_bootstrap_executor;
GRANT UPDATE (state, completed_at, user_id, household_id, membership_id,
	private_space_id)
	ON "emdo"."deployment_bootstraps" TO emdo_owner_bootstrap_executor;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."bootstrap_initial_owner"(
	p_email text,
	p_name text,
	p_password_hash text,
	p_household_name text,
	p_household_slug text
)
RETURNS TABLE(
	user_id uuid,
	household_id uuid,
	membership_id uuid,
	private_space_id uuid,
	completed_at timestamp with time zone
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $function$
DECLARE
	v_email text;
	v_name text;
	v_household_name text;
	v_household_slug text;
	v_started_at timestamp with time zone;
	v_completed_at timestamp with time zone;
	v_user_id uuid;
	v_account_id uuid;
	v_household_id uuid;
	v_membership_id uuid;
	v_private_space_id uuid;
	v_audit_id uuid;
	v_affected integer;
BEGIN
	v_email := pg_catalog.lower(pg_catalog.btrim(p_email));
	v_name := pg_catalog.btrim(p_name);
	v_household_name := pg_catalog.btrim(p_household_name);
	v_household_slug := pg_catalog.lower(pg_catalog.btrim(p_household_slug));

	IF v_email IS NULL
		OR pg_catalog.char_length(v_email) NOT BETWEEN 3 AND 320
		OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
		OR v_name IS NULL
		OR pg_catalog.char_length(v_name) NOT BETWEEN 1 AND 100
		OR v_household_name IS NULL
		OR pg_catalog.char_length(v_household_name) NOT BETWEEN 1 AND 100
		OR v_household_slug IS NULL
		OR pg_catalog.char_length(v_household_slug) NOT BETWEEN 1 AND 63
		OR v_household_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
		OR p_password_hash IS NULL
		OR p_password_hash !~ '^[a-f0-9]{32}:[a-f0-9]{128}$'
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '22023',
			MESSAGE = 'invalid initial owner bootstrap input';
	END IF;

	v_started_at := pg_catalog.clock_timestamp();
	INSERT INTO "emdo"."deployment_bootstraps"
		(bootstrap_key, state, started_at)
	VALUES ('initial-owner-v1', 'in_progress', v_started_at)
	ON CONFLICT (bootstrap_key) DO NOTHING;
	GET DIAGNOSTICS v_affected = ROW_COUNT;
	IF v_affected <> 1 THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'initial owner bootstrap is already complete';
	END IF;

	IF EXISTS (SELECT 1 FROM "emdo"."auth_users")
		OR EXISTS (SELECT 1 FROM "emdo"."households")
		OR EXISTS (SELECT 1 FROM "emdo"."household_memberships")
	THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'initial owner bootstrap requires an empty identity database';
	END IF;

	v_user_id := pg_catalog.gen_random_uuid();
	v_account_id := pg_catalog.gen_random_uuid();
	v_household_id := pg_catalog.gen_random_uuid();
	v_membership_id := pg_catalog.gen_random_uuid();
	v_private_space_id := pg_catalog.gen_random_uuid();
	v_audit_id := pg_catalog.gen_random_uuid();

	INSERT INTO "emdo"."auth_users"
		(id, name, email, email_verified, created_at, updated_at)
	VALUES (v_user_id, v_name, v_email, true, v_started_at, v_started_at);

	INSERT INTO "emdo"."auth_accounts"
		(id, user_id, account_id, provider_id, password, created_at, updated_at)
	VALUES (
		v_account_id,
		v_user_id,
		v_user_id::text,
		'credential',
		p_password_hash,
		v_started_at,
		v_started_at
	);

	INSERT INTO "emdo"."households"
		(id, name, slug, created_by_user_id, created_at, updated_at)
	VALUES (
		v_household_id,
		v_household_name,
		v_household_slug,
		v_user_id,
		v_started_at,
		v_started_at
	);

	INSERT INTO "emdo"."household_memberships"
		(id, household_id, user_id, role, status, joined_at, updated_at)
	VALUES (
		v_membership_id,
		v_household_id,
		v_user_id,
		'owner',
		'active',
		v_started_at,
		v_started_at
	);

	INSERT INTO "emdo"."spaces"
		(id, household_id, original_owner_user_id, name, visibility, revision,
		created_at, updated_at)
	VALUES (
		v_private_space_id,
		v_household_id,
		v_user_id,
		'Private',
		'private',
		1,
		v_started_at,
		v_started_at
	);

	v_completed_at := pg_catalog.clock_timestamp();
	INSERT INTO "emdo"."audit_events"
		(id, household_id, space_id, original_owner_user_id, actor_user_id,
		event_type, payload, occurred_at, retain_until)
	VALUES (
		v_audit_id,
		v_household_id,
		v_private_space_id,
		v_user_id,
		v_user_id,
		'identity.owner-bootstrapped',
		pg_catalog.jsonb_build_object(
			'bootstrapKey', 'initial-owner-v1',
			'commandVersion', 1
		),
		v_completed_at,
		v_completed_at + interval '12 months'
	);

	UPDATE "emdo"."deployment_bootstraps"
	SET state = 'complete',
		completed_at = v_completed_at,
		user_id = v_user_id,
		household_id = v_household_id,
		membership_id = v_membership_id,
		private_space_id = v_private_space_id
	WHERE bootstrap_key = 'initial-owner-v1'
		AND state = 'in_progress';
	GET DIAGNOSTICS v_affected = ROW_COUNT;
	IF v_affected <> 1 THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'initial owner bootstrap marker could not be completed';
	END IF;

	RETURN QUERY SELECT
		v_user_id,
		v_household_id,
		v_membership_id,
		v_private_space_id,
		v_completed_at;
END
$function$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA "emdo" TO emdo_owner_bootstrap_executor;
ALTER FUNCTION "emdo"."bootstrap_initial_owner"(text, text, text, text, text)
	OWNER TO emdo_owner_bootstrap_executor;
REVOKE CREATE ON SCHEMA "emdo" FROM emdo_owner_bootstrap_executor;
REVOKE ALL ON FUNCTION "emdo"."bootstrap_initial_owner"(text, text, text, text, text)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_identity_reader, emdo_onboarding,
	emdo_onboarding_executor, emdo_owner_bootstrap_executor;
GRANT EXECUTE ON FUNCTION "emdo"."bootstrap_initial_owner"(text, text, text, text, text)
	TO emdo_owner_bootstrap;
