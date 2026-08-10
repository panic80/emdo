CREATE TABLE "emdo"."auth_rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "auth_rate_limits_key_unique" UNIQUE("key"),
	CONSTRAINT "auth_rate_limits_count_nonnegative" CHECK ("emdo"."auth_rate_limits"."count" >= 0),
	CONSTRAINT "auth_rate_limits_last_request_nonnegative" CHECK ("emdo"."auth_rate_limits"."last_request" >= 0)
);
--> statement-breakpoint
ALTER TABLE "emdo"."auth_sessions" ADD COLUMN "active_household_id" uuid;--> statement-breakpoint
ALTER TABLE "emdo"."household_memberships" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "emdo"."households" ADD COLUMN "slug" text
  DEFAULT ('household-' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')) NOT NULL;
ALTER TABLE "emdo"."households" ALTER COLUMN "slug" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "emdo"."households" ADD COLUMN "logo" text;--> statement-breakpoint
ALTER TABLE "emdo"."households" ADD COLUMN "metadata" text;--> statement-breakpoint
ALTER TABLE "emdo"."auth_sessions" ADD CONSTRAINT "auth_sessions_active_household_id_households_id_fk" FOREIGN KEY ("active_household_id") REFERENCES "emdo"."households"("id") ON DELETE set null ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "auth_sessions_active_household_id_idx" ON "emdo"."auth_sessions" USING btree ("active_household_id");--> statement-breakpoint
ALTER TABLE "emdo"."household_memberships" ADD CONSTRAINT "household_memberships_id_unique" UNIQUE("id");--> statement-breakpoint
ALTER TABLE "emdo"."households" ADD CONSTRAINT "households_slug_unique" UNIQUE("slug");--> statement-breakpoint
CREATE VIEW "emdo"."active_household_memberships" WITH (security_barrier = true) AS (select id, household_id as organization_id, user_id, role,
                 joined_at as created_at
            from emdo.household_memberships
           where status = 'active');--> statement-breakpoint
CREATE VIEW "emdo"."better_auth_invitations" WITH (security_barrier = true) AS (select id, household_id as organization_id, email, role,
                 'pending'::text as status,
                 expires_at, created_at, invited_by_user_id as inviter_id
            from emdo.invitations
           where consumed_at is null
             and revoked_at is null
             and expires_at > clock_timestamp());--> statement-breakpoint
CREATE VIEW "emdo"."better_auth_organizations" WITH (security_barrier = true) AS (select id, name, slug, logo, metadata, created_at
            from emdo.households);--> statement-breakpoint
DO $roles$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'emdo_identity_reader') THEN
		CREATE ROLE emdo_identity_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'emdo_onboarding') THEN
		CREATE ROLE emdo_onboarding NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'emdo_onboarding_executor') THEN
		CREATE ROLE emdo_onboarding_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$roles$;--> statement-breakpoint
ALTER ROLE emdo_identity_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_onboarding NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_onboarding_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;--> statement-breakpoint
REVOKE ALL ON SCHEMA "emdo" FROM emdo_identity_reader, emdo_onboarding, emdo_onboarding_executor;
REVOKE ALL ON ALL TABLES IN SCHEMA "emdo" FROM emdo_identity_reader, emdo_onboarding, emdo_onboarding_executor;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "emdo" FROM emdo_identity_reader, emdo_onboarding, emdo_onboarding_executor;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "emdo" FROM emdo_identity_reader, emdo_onboarding, emdo_onboarding_executor;
GRANT USAGE ON SCHEMA "emdo" TO emdo_identity_reader, emdo_onboarding, emdo_onboarding_executor;--> statement-breakpoint
DROP POLICY IF EXISTS invitations_auth_service ON "emdo"."invitations";
REVOKE ALL ON "emdo"."invitations" FROM emdo_auth;
REVOKE ALL ON "emdo"."invitations" FROM emdo_app;
REVOKE ALL (id, household_id, invited_by_user_id, email, role, token_hash,
	created_at, expires_at, consumed_at, consumed_by_user_id,
	consumed_session_id, revoked_at)
	ON "emdo"."invitations" FROM PUBLIC, emdo_app, emdo_auth, emdo_worker,
	emdo_workflow, emdo_policy_reader, emdo_identity_reader, emdo_onboarding,
	emdo_onboarding_executor;
GRANT SELECT (id, household_id, invited_by_user_id, email, role, created_at,
	expires_at, consumed_at, consumed_by_user_id, revoked_at)
	ON "emdo"."invitations" TO emdo_app;
GRANT INSERT (id, household_id, invited_by_user_id, email, role, token_hash,
	created_at, expires_at)
	ON "emdo"."invitations" TO emdo_app;
GRANT UPDATE (revoked_at)
	ON "emdo"."invitations" TO emdo_app;--> statement-breakpoint
DROP POLICY IF EXISTS invitations_owner_update ON "emdo"."invitations";
CREATE POLICY invitations_owner_update ON "emdo"."invitations"
FOR UPDATE TO emdo_app
USING (
	"emdo"."is_household_owner"("household_id")
	AND "invited_by_user_id" = "emdo"."current_user_id"()
	AND "consumed_at" IS NULL
	AND "revoked_at" IS NULL
)
WITH CHECK (
	"emdo"."is_household_owner"("household_id")
	AND "invited_by_user_id" = "emdo"."current_user_id"()
	AND "consumed_at" IS NULL
	AND "consumed_by_user_id" IS NULL
	AND "revoked_at" IS NOT NULL
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."enforce_invitation_lifecycle"()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
	IF ROW(
		NEW.id,
		NEW.household_id,
		NEW.invited_by_user_id,
		NEW.email,
		NEW.role,
		NEW.token_hash,
		NEW.created_at,
		NEW.expires_at
	) IS DISTINCT FROM ROW(
		OLD.id,
		OLD.household_id,
		OLD.invited_by_user_id,
		OLD.email,
		OLD.role,
		OLD.token_hash,
		OLD.created_at,
		OLD.expires_at
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'invitation envelope is immutable';
	END IF;

	IF OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'terminal invitation is immutable';
	END IF;

	IF NEW.revoked_at IS NOT NULL
		AND NEW.consumed_at IS NULL
		AND NEW.consumed_by_user_id IS NULL
		AND NEW.consumed_session_id IS NULL
	THEN
		NEW.revoked_at := pg_catalog.clock_timestamp();
		RETURN NEW;
	END IF;

	IF NEW.revoked_at IS NULL
		AND NEW.consumed_at IS NOT NULL
		AND NEW.consumed_by_user_id IS NOT NULL
	THEN
		RETURN NEW;
	END IF;

	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = 'invalid invitation lifecycle transition';
END
$function$;
REVOKE ALL ON FUNCTION "emdo"."enforce_invitation_lifecycle"()
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_identity_reader, emdo_onboarding,
	emdo_onboarding_executor;
DROP TRIGGER IF EXISTS invitations_lifecycle_guard ON "emdo"."invitations";
CREATE TRIGGER invitations_lifecycle_guard
BEFORE UPDATE ON "emdo"."invitations"
FOR EACH ROW EXECUTE FUNCTION "emdo"."enforce_invitation_lifecycle"();--> statement-breakpoint
CREATE POLICY households_identity_projection ON "emdo"."households"
FOR SELECT TO emdo_identity_reader
USING ("emdo"."is_active_member"(id));
CREATE POLICY memberships_identity_projection ON "emdo"."household_memberships"
FOR SELECT TO emdo_identity_reader
USING (
	status = 'active'
	AND "emdo"."is_active_member"(household_id)
);
CREATE POLICY invitations_identity_projection ON "emdo"."invitations"
FOR SELECT TO emdo_identity_reader
USING (
	"emdo"."is_household_owner"(household_id)
	AND consumed_at IS NULL
	AND revoked_at IS NULL
	AND expires_at > pg_catalog.clock_timestamp()
);--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "emdo"."is_active_member"(uuid),
	"emdo"."is_household_owner"(uuid) TO emdo_identity_reader, emdo_auth;--> statement-breakpoint
GRANT SELECT (id, name, slug, logo, metadata, created_at)
	ON "emdo"."households" TO emdo_identity_reader;
GRANT SELECT (id, household_id, user_id, role, joined_at, status)
	ON "emdo"."household_memberships" TO emdo_identity_reader;
GRANT SELECT (id, household_id, email, role, expires_at, created_at,
	invited_by_user_id, consumed_at, revoked_at)
	ON "emdo"."invitations" TO emdo_identity_reader;--> statement-breakpoint
GRANT CREATE ON SCHEMA "emdo" TO emdo_identity_reader;
ALTER VIEW "emdo"."better_auth_organizations" OWNER TO emdo_identity_reader;
ALTER VIEW "emdo"."active_household_memberships" OWNER TO emdo_identity_reader;
ALTER VIEW "emdo"."better_auth_invitations" OWNER TO emdo_identity_reader;
REVOKE CREATE ON SCHEMA "emdo" FROM emdo_identity_reader;--> statement-breakpoint
REVOKE ALL ON "emdo"."better_auth_organizations", "emdo"."active_household_memberships",
	"emdo"."better_auth_invitations" FROM PUBLIC, emdo_app, emdo_auth, emdo_worker,
	emdo_workflow, emdo_policy_reader, emdo_onboarding, emdo_onboarding_executor;
GRANT SELECT ON "emdo"."better_auth_organizations", "emdo"."active_household_memberships",
	"emdo"."better_auth_invitations" TO emdo_auth;--> statement-breakpoint
REVOKE ALL ON "emdo"."auth_rate_limits" FROM PUBLIC, emdo_app, emdo_worker,
	emdo_workflow, emdo_policy_reader, emdo_identity_reader, emdo_onboarding,
	emdo_onboarding_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON "emdo"."auth_rate_limits" TO emdo_auth;
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON "emdo"."auth_rate_limits" FROM emdo_auth;--> statement-breakpoint
CREATE POLICY invitations_onboarding_read ON "emdo"."invitations"
FOR SELECT TO emdo_onboarding_executor
USING (revoked_at IS NULL);
CREATE POLICY invitations_onboarding_consume ON "emdo"."invitations"
FOR UPDATE TO emdo_onboarding_executor
USING (consumed_at IS NULL AND revoked_at IS NULL)
WITH CHECK (
	consumed_at IS NOT NULL
	AND consumed_by_user_id IS NOT NULL
	AND revoked_at IS NULL
);
CREATE POLICY memberships_onboarding_insert ON "emdo"."household_memberships"
FOR INSERT TO emdo_onboarding_executor
WITH CHECK (status = 'active' AND ended_at IS NULL);
CREATE POLICY spaces_onboarding_insert ON "emdo"."spaces"
FOR INSERT TO emdo_onboarding_executor
WITH CHECK (
	visibility = 'private'
	AND revision = 1
	AND tombstoned_at IS NULL
);
CREATE POLICY audit_onboarding_insert ON "emdo"."audit_events"
FOR INSERT TO emdo_onboarding_executor
WITH CHECK (
	event_type = 'identity.invitation-consumed'
	AND actor_user_id = original_owner_user_id
);--> statement-breakpoint
GRANT SELECT (id, household_id, email, role, token_hash, expires_at,
	consumed_at, revoked_at)
	ON "emdo"."invitations" TO emdo_onboarding_executor;
GRANT UPDATE (consumed_at, consumed_by_user_id)
	ON "emdo"."invitations" TO emdo_onboarding_executor;
GRANT INSERT (id, name, email, email_verified)
	ON "emdo"."auth_users" TO emdo_onboarding_executor;
GRANT INSERT (id, user_id, account_id, provider_id, password)
	ON "emdo"."auth_accounts" TO emdo_onboarding_executor;
GRANT INSERT (household_id, user_id, role, status)
	ON "emdo"."household_memberships" TO emdo_onboarding_executor;
GRANT INSERT (id, household_id, original_owner_user_id, name, visibility, revision)
	ON "emdo"."spaces" TO emdo_onboarding_executor;
GRANT INSERT (household_id, space_id, original_owner_user_id, actor_user_id,
	event_type, payload)
	ON "emdo"."audit_events" TO emdo_onboarding_executor;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."provision_invited_account"(
	p_invitation_id uuid,
	p_invitation_token_hash text,
	p_email text,
	p_display_name text,
	p_password_hash text
)
RETURNS TABLE(
	status text,
	user_id uuid,
	email text,
	email_verified boolean,
	household_id uuid,
	role text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $function$
DECLARE
	v_household_id uuid;
	v_role text;
	v_invite_email text;
	v_expires_at timestamp with time zone;
	v_email text;
	v_name text;
	v_now timestamp with time zone;
	v_user_id uuid;
	v_account_id uuid;
	v_space_id uuid;
	v_updated integer;
	v_constraint_name text;
	v_duplicate_email boolean := false;
BEGIN
	v_email := pg_catalog.lower(pg_catalog.btrim(p_email));
	v_name := pg_catalog.btrim(p_display_name);
	IF p_invitation_id IS NULL
		OR v_email IS NULL
		OR pg_catalog.char_length(v_email) NOT BETWEEN 3 AND 320
		OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
		OR v_name IS NULL
		OR pg_catalog.char_length(v_name) NOT BETWEEN 1 AND 100
		OR p_invitation_token_hash IS NULL
		OR p_invitation_token_hash !~ '^[a-f0-9]{64}$'
		OR p_password_hash IS NULL
		OR p_password_hash !~ '^[a-f0-9]{32}:[a-f0-9]{128}$'
	THEN
		RETURN;
	END IF;

	SELECT invitation.household_id, invitation.role, invitation.email,
		invitation.expires_at
	INTO v_household_id, v_role, v_invite_email, v_expires_at
	FROM "emdo"."invitations" AS invitation
	WHERE invitation.id = p_invitation_id
		AND invitation.token_hash = p_invitation_token_hash
		AND invitation.email = v_email
		AND invitation.consumed_at IS NULL
		AND invitation.revoked_at IS NULL
	FOR UPDATE;

	IF NOT FOUND THEN
		RETURN;
	END IF;
	v_now := pg_catalog.clock_timestamp();
	IF v_expires_at <= v_now OR v_invite_email <> v_email THEN
		RETURN;
	END IF;

	v_user_id := pg_catalog.gen_random_uuid();
	v_account_id := pg_catalog.gen_random_uuid();
	v_space_id := pg_catalog.gen_random_uuid();

	BEGIN
		UPDATE "emdo"."invitations" AS invitation
		SET consumed_at = v_now,
			consumed_by_user_id = v_user_id
		WHERE invitation.id = p_invitation_id
			AND invitation.consumed_at IS NULL
			AND invitation.revoked_at IS NULL
			AND invitation.expires_at > v_now;
		GET DIAGNOSTICS v_updated = ROW_COUNT;
		IF v_updated <> 1 THEN
			RETURN;
		END IF;

		INSERT INTO "emdo"."auth_users" (id, name, email, email_verified)
		VALUES (v_user_id, v_name, v_email, true);
		INSERT INTO "emdo"."auth_accounts"
			(id, user_id, account_id, provider_id, password)
		VALUES (
			v_account_id,
			v_user_id,
			v_user_id::text,
			'credential',
			p_password_hash
		);
		INSERT INTO "emdo"."household_memberships"
			(household_id, user_id, role, status)
		VALUES (v_household_id, v_user_id, v_role, 'active');
		INSERT INTO "emdo"."spaces"
			(id, household_id, original_owner_user_id, name, visibility, revision)
		VALUES (
			v_space_id,
			v_household_id,
			v_user_id,
			'Private',
			'private',
			1
		);
		INSERT INTO "emdo"."audit_events"
			(household_id, space_id, original_owner_user_id, actor_user_id,
			event_type, payload)
		VALUES (
			v_household_id,
			v_space_id,
			v_user_id,
			v_user_id,
			'identity.invitation-consumed',
			pg_catalog.jsonb_build_object(
				'invitationId', p_invitation_id::text,
				'role', v_role
			)
		);
	EXCEPTION
		WHEN unique_violation THEN
			GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
			IF v_constraint_name = 'auth_users_email_unique' THEN
				v_duplicate_email := true;
			ELSE
				RAISE;
			END IF;
	END;

	IF v_duplicate_email THEN
		RETURN;
	END IF;
	RETURN QUERY SELECT 'provisioned'::text, v_user_id, v_email, true,
		v_household_id, v_role;
END
$function$;--> statement-breakpoint
GRANT CREATE ON SCHEMA "emdo" TO emdo_onboarding_executor;
ALTER FUNCTION "emdo"."provision_invited_account"(uuid, text, text, text, text)
	OWNER TO emdo_onboarding_executor;
REVOKE CREATE ON SCHEMA "emdo" FROM emdo_onboarding_executor;
REVOKE ALL ON FUNCTION "emdo"."provision_invited_account"(uuid, text, text, text, text)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_identity_reader, emdo_onboarding_executor;
GRANT EXECUTE ON FUNCTION "emdo"."provision_invited_account"(uuid, text, text, text, text)
	TO emdo_onboarding;
