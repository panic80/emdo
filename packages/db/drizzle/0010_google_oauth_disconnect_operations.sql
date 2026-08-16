DO $role$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_google_oauth_disconnect_retention'
	) THEN
		CREATE ROLE emdo_google_oauth_disconnect_retention
			NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
			NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$role$;
DO $role$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_google_oauth_disconnect_reconciliation_executor'
	) THEN
		CREATE ROLE emdo_google_oauth_disconnect_reconciliation_executor
			NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
			NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_google_oauth_disconnect_reconciliation'
	) THEN
		CREATE ROLE emdo_google_oauth_disconnect_reconciliation
			NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
			NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$role$;
ALTER ROLE emdo_google_oauth_disconnect_retention
	NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
	NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_google_oauth_disconnect_reconciliation_executor
	NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
	NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_google_oauth_disconnect_reconciliation
	NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
	NOINHERIT NOBYPASSRLS NOREPLICATION;
--> statement-breakpoint
CREATE TABLE "emdo"."google_oauth_disconnect_operations" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"parent_operation_id" uuid,
	"household_id" uuid NOT NULL,
	"private_space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"origin_request_id" uuid NOT NULL,
	"dispatch_request_id" uuid,
	"dispatch_session_id" uuid,
	"completed_request_id" uuid,
	"completed_session_id" uuid,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"credential_revision" integer,
	"authorization_epoch" integer NOT NULL,
	"result" jsonb,
	"completion_source" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"retain_until" timestamp with time zone,
	CONSTRAINT "google_oauth_disconnect_operations_scope_key_unique"
		UNIQUE("household_id", "private_space_id", "original_owner_user_id", "session_id", "idempotency_key"),
	CONSTRAINT "google_oauth_disconnect_operations_household_space_fk"
		FOREIGN KEY ("household_id", "private_space_id")
		REFERENCES "emdo"."spaces"("household_id", "id")
		ON DELETE restrict ON UPDATE restrict,
		CONSTRAINT "google_oauth_disconnect_operations_owner_membership_fk"
		FOREIGN KEY ("household_id", "original_owner_user_id")
			REFERENCES "emdo"."household_memberships"("household_id", "user_id")
			ON DELETE restrict ON UPDATE restrict,
		CONSTRAINT "google_oauth_disconnect_operations_parent_fk"
			FOREIGN KEY ("parent_operation_id")
			REFERENCES "emdo"."google_oauth_disconnect_operations"("id")
			ON DELETE restrict ON UPDATE restrict,
		CONSTRAINT "google_oauth_disconnect_operations_parent_check"
			CHECK ("parent_operation_id" IS NULL OR "parent_operation_id" <> "id"),
	CONSTRAINT "google_oauth_disconnect_operations_key_check"
		CHECK (pg_catalog.length("idempotency_key") BETWEEN 16 AND 200
			AND "idempotency_key" ~ '^[A-Za-z0-9:._-]+$'),
	CONSTRAINT "google_oauth_disconnect_operations_fingerprint_check"
		CHECK ("request_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "google_oauth_disconnect_operations_epoch_revision_check"
		CHECK ("authorization_epoch" >= 0
			AND ("credential_revision" IS NULL OR "credential_revision" > 0)),
	CONSTRAINT "google_oauth_disconnect_operations_state_check"
			CHECK ("state" IN ('claimed', 'dispatching', 'linked', 'completed')),
		CONSTRAINT "google_oauth_disconnect_operations_transition_shape_check"
			CHECK (
				("state" = 'claimed'
					AND "parent_operation_id" IS NULL
					AND "dispatch_request_id" IS NULL
					AND "dispatch_session_id" IS NULL
					AND "completed_request_id" IS NULL
					AND "completed_session_id" IS NULL
					AND "completion_source" IS NULL
					AND "result" IS NULL
				AND "completed_at" IS NULL
				AND "retain_until" IS NULL)
			OR
				("state" = 'dispatching'
					AND "parent_operation_id" IS NULL
					AND "credential_revision" IS NOT NULL
					AND "dispatch_request_id" IS NOT NULL
					AND "dispatch_session_id" IS NOT NULL
					AND "completed_request_id" IS NULL
					AND "completed_session_id" IS NULL
					AND "completion_source" IS NULL
					AND "result" IS NULL
					AND "completed_at" IS NULL
					AND "retain_until" IS NULL)
				OR
				("state" = 'linked'
					AND "parent_operation_id" IS NOT NULL
					AND "dispatch_request_id" IS NULL
					AND "dispatch_session_id" IS NULL
					AND "completed_request_id" IS NULL
					AND "completed_session_id" IS NULL
					AND "completion_source" IS NULL
					AND "result" IS NULL
					AND "completed_at" IS NULL
					AND "retain_until" IS NULL)
				OR
				("state" = 'completed'
					AND (
						("completion_source" = 'interactive'
							AND "completed_request_id" IS NOT NULL
							AND "completed_session_id" IS NOT NULL)
						OR
						("completion_source" = 'reconciliation'
							AND "completed_request_id" IS NULL
							AND "completed_session_id" IS NULL
							AND "result" ->> 'providerRevocation' = 'unconfirmed')
					)
				AND "result" IS NOT NULL
				AND pg_catalog.jsonb_typeof("result") = 'object'
				AND "result" ?& ARRAY['status', 'providerRevocation']::text[]
				AND ("result" - ARRAY['status', 'providerRevocation']::text[]) = '{}'::jsonb
				AND "result" ->> 'status' = 'disconnected'
				AND (
						("credential_revision" IS NULL
							AND "dispatch_request_id" IS NULL
							AND "dispatch_session_id" IS NULL
							AND "result" ->> 'providerRevocation' = 'not-applicable')
						OR
						("credential_revision" IS NOT NULL
							AND "dispatch_request_id" IS NOT NULL
							AND "dispatch_session_id" IS NOT NULL
						AND "result" ->> 'providerRevocation' IN ('confirmed', 'unconfirmed'))
				)
				AND "completed_at" IS NOT NULL
				AND "retain_until" > "completed_at"
				AND "retain_until" <= "completed_at" + interval '90 days')
		)
);
--> statement-breakpoint
CREATE INDEX "google_oauth_disconnect_operations_retention_idx"
	ON "emdo"."google_oauth_disconnect_operations" ("retain_until");
CREATE UNIQUE INDEX "google_oauth_disconnect_operations_active_actor_unique"
	ON "emdo"."google_oauth_disconnect_operations" (
		"household_id", "private_space_id", "original_owner_user_id"
	)
	WHERE "parent_operation_id" IS NULL
		AND "state" IN ('claimed', 'dispatching');
--> statement-breakpoint
ALTER TABLE "emdo"."google_oauth_disconnect_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."google_oauth_disconnect_operations" FORCE ROW LEVEL SECURITY;
CREATE POLICY google_oauth_disconnect_operations_executor_scope
	ON "emdo"."google_oauth_disconnect_operations"
	FOR ALL TO emdo_oauth_grant_executor USING (true) WITH CHECK (true);
CREATE POLICY google_oauth_disconnect_operations_retention_select
	ON "emdo"."google_oauth_disconnect_operations"
	FOR SELECT TO emdo_google_oauth_disconnect_retention
	USING (
		state = 'completed'
		AND retain_until <= pg_catalog.clock_timestamp()
	);
CREATE POLICY google_oauth_disconnect_operations_retention_delete
	ON "emdo"."google_oauth_disconnect_operations"
	FOR DELETE TO emdo_google_oauth_disconnect_retention
	USING (
		state = 'completed'
		AND retain_until <= pg_catalog.clock_timestamp()
	);
CREATE POLICY google_oauth_disconnect_operations_reconciliation_select
	ON "emdo"."google_oauth_disconnect_operations"
	FOR SELECT TO emdo_google_oauth_disconnect_reconciliation_executor
	USING (true);
CREATE POLICY google_oauth_disconnect_operations_reconciliation_update
	ON "emdo"."google_oauth_disconnect_operations"
	FOR UPDATE TO emdo_google_oauth_disconnect_reconciliation_executor
	USING ("state" IN ('dispatching', 'linked'))
	WITH CHECK (
		"state" = 'completed'
		AND "completion_source" = 'reconciliation'
		AND "result" ->> 'providerRevocation' = 'unconfirmed'
	);
CREATE POLICY encrypted_google_calendar_grants_disconnect_reconciliation_read
	ON "emdo"."encrypted_google_calendar_grants"
	FOR SELECT TO emdo_google_oauth_disconnect_reconciliation_executor
	USING (true);
CREATE POLICY google_oauth_authorization_epochs_disconnect_reconciliation_read
	ON "emdo"."google_oauth_authorization_epochs"
	FOR SELECT TO emdo_google_oauth_disconnect_reconciliation_executor
	USING (true);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.enforce_google_oauth_disconnect_transition()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, emdo
AS $function$
BEGIN
	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.parent_operation_id IS DISTINCT FROM OLD.parent_operation_id
		OR NEW.household_id IS DISTINCT FROM OLD.household_id
		OR NEW.private_space_id IS DISTINCT FROM OLD.private_space_id
		OR NEW.original_owner_user_id IS DISTINCT FROM OLD.original_owner_user_id
		OR NEW.session_id IS DISTINCT FROM OLD.session_id
		OR NEW.origin_request_id IS DISTINCT FROM OLD.origin_request_id
		OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
		OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
		OR NEW.credential_revision IS DISTINCT FROM OLD.credential_revision
		OR NEW.authorization_epoch IS DISTINCT FROM OLD.authorization_epoch
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
		OR NEW.updated_at <= OLD.updated_at
		OR NOT (
			(OLD.state = 'claimed' AND NEW.state IN ('dispatching', 'completed'))
			OR (OLD.state = 'dispatching' AND NEW.state = 'completed')
			OR (OLD.state = 'linked' AND NEW.state = 'completed')
		)
		OR (OLD.dispatch_request_id IS NOT NULL
			AND NEW.dispatch_request_id IS DISTINCT FROM OLD.dispatch_request_id)
		OR (OLD.dispatch_session_id IS NOT NULL
			AND NEW.dispatch_session_id IS DISTINCT FROM OLD.dispatch_session_id)
		OR OLD.completed_request_id IS NOT NULL
		OR OLD.completed_session_id IS NOT NULL
		OR OLD.completion_source IS NOT NULL
		OR OLD.result IS NOT NULL
		OR OLD.completed_at IS NOT NULL
		OR OLD.retain_until IS NOT NULL
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'invalid google oauth disconnect transition';
	END IF;
	RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER google_oauth_disconnect_operations_transition_guard
	BEFORE UPDATE ON emdo.google_oauth_disconnect_operations
	FOR EACH ROW EXECUTE FUNCTION emdo.enforce_google_oauth_disconnect_transition();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.enforce_google_calendar_grant_disconnect_fence()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, emdo
AS $function$
DECLARE
	v_household_id uuid;
	v_private_space_id uuid;
	v_owner_user_id uuid;
	v_revision integer;
	v_authorization_epoch integer;
	v_operation_id uuid;
BEGIN
	IF TG_OP = 'DELETE' THEN
		v_household_id := OLD.household_id;
		v_private_space_id := OLD.private_space_id;
		v_owner_user_id := OLD.original_owner_user_id;
		v_revision := OLD.revision;
		v_authorization_epoch := OLD.authorization_epoch;
	ELSE
		v_household_id := NEW.household_id;
		v_private_space_id := NEW.private_space_id;
		v_owner_user_id := NEW.original_owner_user_id;
		v_revision := NEW.revision;
		v_authorization_epoch := NEW.authorization_epoch;
	END IF;

	IF TG_OP = 'DELETE' THEN
		BEGIN
			v_operation_id := NULLIF(
				pg_catalog.current_setting(
					'emdo.google_oauth_disconnect_operation_id', true
				),
				''
			)::uuid;
		EXCEPTION
			WHEN invalid_text_representation THEN
				v_operation_id := NULL;
		END;
		IF v_operation_id IS NOT NULL AND EXISTS (
			SELECT 1
			FROM emdo.google_oauth_disconnect_operations AS operation
			WHERE operation.id = v_operation_id
				AND operation.parent_operation_id IS NULL
				AND operation.state = 'dispatching'
				AND operation.household_id = v_household_id
				AND operation.private_space_id = v_private_space_id
				AND operation.original_owner_user_id = v_owner_user_id
				AND operation.credential_revision = v_revision
				AND operation.authorization_epoch = v_authorization_epoch
		) THEN
			RETURN OLD;
		END IF;
	END IF;

	IF EXISTS (
		SELECT 1
		FROM emdo.google_oauth_disconnect_operations AS operation
		WHERE operation.parent_operation_id IS NULL
			AND operation.household_id = v_household_id
			AND operation.private_space_id = v_private_space_id
			AND operation.original_owner_user_id = v_owner_user_id
			AND operation.state IN ('claimed', 'dispatching')
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '40001',
			MESSAGE = 'google oauth credential is disconnecting';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END
$function$;
CREATE TRIGGER encrypted_google_calendar_grants_disconnect_fence
	BEFORE INSERT OR UPDATE OR DELETE ON emdo.encrypted_google_calendar_grants
	FOR EACH ROW EXECUTE FUNCTION emdo.enforce_google_calendar_grant_disconnect_fence();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.claim_google_oauth_disconnect(
	p_user_id uuid,
	p_household_id uuid,
	p_private_space_id uuid,
	p_session_id uuid,
	p_idempotency_key text,
	p_request_fingerprint text
)
RETURNS TABLE (
	status text,
	operation_id uuid,
	credential_revision integer,
	authorization_epoch integer,
	result jsonb
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_now timestamp with time zone := pg_catalog.clock_timestamp();
	v_expected_fingerprint text;
	v_existing emdo.google_oauth_disconnect_operations%ROWTYPE;
	v_canonical emdo.google_oauth_disconnect_operations%ROWTYPE;
	v_credential_revision integer;
	v_authorization_epoch integer;
BEGIN
	IF p_user_id IS DISTINCT FROM emdo.current_user_id()
		OR p_session_id IS DISTINCT FROM emdo.current_session_id()
		OR p_household_id IS NULL
		OR p_private_space_id IS NULL
		OR NOT emdo.lock_active_request_scope(
			p_household_id, p_private_space_id, NULL
		)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '42501',
			MESSAGE = 'google oauth disconnect scope is unavailable';
	END IF;
	IF p_idempotency_key IS NULL
		OR pg_catalog.length(p_idempotency_key) NOT BETWEEN 16 AND 200
		OR p_idempotency_key !~ '^[A-Za-z0-9:._-]+$'
		OR p_request_fingerprint !~ '^[a-f0-9]{64}$'
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '22023',
			MESSAGE = 'invalid google oauth disconnect claim';
	END IF;
	v_expected_fingerprint := emdo.canonical_json_hash(
		pg_catalog.jsonb_build_object(
			'domain', 'emdo.google-calendar.oauth-disconnect.v1'
		)
	);
	IF p_request_fingerprint IS DISTINCT FROM v_expected_fingerprint THEN
		RAISE EXCEPTION USING
			ERRCODE = '22023',
			MESSAGE = 'invalid google oauth disconnect fingerprint';
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			p_user_id::text || ':' || p_household_id::text || ':' ||
			p_private_space_id::text,
			0
		)
	);
	SELECT stored.* INTO v_existing
	FROM emdo.google_oauth_disconnect_operations AS stored
	WHERE stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_user_id
		AND stored.session_id = p_session_id
		AND stored.idempotency_key = p_idempotency_key
	FOR UPDATE;
	IF FOUND THEN
		IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
			RETURN QUERY SELECT
				'conflict'::text, NULL::uuid, NULL::integer,
				NULL::integer, NULL::jsonb;
			RETURN;
		END IF;
		IF v_existing.state = 'completed' THEN
			RETURN QUERY SELECT
				'replayed'::text, v_existing.id, v_existing.credential_revision,
				v_existing.authorization_epoch, v_existing.result;
			RETURN;
		END IF;
		IF v_existing.parent_operation_id IS NOT NULL THEN
			SELECT stored.* INTO v_canonical
			FROM emdo.google_oauth_disconnect_operations AS stored
			WHERE stored.id = v_existing.parent_operation_id
				AND stored.parent_operation_id IS NULL
				AND stored.household_id = p_household_id
				AND stored.private_space_id = p_private_space_id
				AND stored.original_owner_user_id = p_user_id
			FOR UPDATE;
			IF NOT FOUND THEN
				RETURN QUERY SELECT
					'conflict'::text, NULL::uuid, NULL::integer,
					NULL::integer, NULL::jsonb;
				RETURN;
			END IF;
			IF v_canonical.state = 'completed' THEN
				RETURN QUERY SELECT
					'replayed'::text, v_canonical.id,
					v_canonical.credential_revision,
					v_canonical.authorization_epoch, v_canonical.result;
				RETURN;
			END IF;
			RETURN QUERY SELECT
				v_canonical.state, v_canonical.id,
				v_canonical.credential_revision,
				v_canonical.authorization_epoch, NULL::jsonb;
			RETURN;
		END IF;
		RETURN QUERY SELECT
			v_existing.state, v_existing.id, v_existing.credential_revision,
			v_existing.authorization_epoch, NULL::jsonb;
		RETURN;
	END IF;

	SELECT stored.authorization_epoch INTO v_authorization_epoch
	FROM emdo.google_oauth_authorization_epochs AS stored
	WHERE stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_user_id
	FOR SHARE OF stored;
	v_authorization_epoch := COALESCE(v_authorization_epoch, 0);
	SELECT stored.revision INTO v_credential_revision
	FROM emdo.encrypted_google_calendar_grants AS stored
	WHERE stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_user_id
		AND stored.provider = 'google'
		AND stored.grant_type = 'calendar-authorization'
	FOR SHARE OF stored;

	SELECT stored.* INTO v_canonical
	FROM emdo.google_oauth_disconnect_operations AS stored
	WHERE stored.parent_operation_id IS NULL
		AND stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_user_id
		AND stored.state IN ('claimed', 'dispatching')
	FOR UPDATE;
	IF FOUND THEN
		INSERT INTO emdo.google_oauth_disconnect_operations(
			parent_operation_id,
			household_id, private_space_id, original_owner_user_id, session_id,
			origin_request_id, idempotency_key, request_fingerprint, state,
			credential_revision, authorization_epoch, created_at, updated_at
		) VALUES (
			v_canonical.id,
			p_household_id, p_private_space_id, p_user_id, p_session_id,
			emdo.current_request_id(), p_idempotency_key,
			p_request_fingerprint, 'linked', v_canonical.credential_revision,
			v_canonical.authorization_epoch, v_now, v_now
		);
		RETURN QUERY SELECT
			v_canonical.state, v_canonical.id,
			v_canonical.credential_revision,
			v_canonical.authorization_epoch, NULL::jsonb;
		RETURN;
	END IF;

	INSERT INTO emdo.google_oauth_disconnect_operations(
		household_id, private_space_id, original_owner_user_id, session_id,
		origin_request_id, idempotency_key, request_fingerprint, state,
		credential_revision, authorization_epoch, created_at, updated_at
	) VALUES (
		p_household_id, p_private_space_id, p_user_id, p_session_id,
		emdo.current_request_id(), p_idempotency_key, p_request_fingerprint,
		'claimed', v_credential_revision, v_authorization_epoch, v_now, v_now
	)
	RETURNING * INTO v_existing;
	RETURN QUERY SELECT
		'claimed'::text, v_existing.id, v_existing.credential_revision,
		v_existing.authorization_epoch, NULL::jsonb;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.mark_google_oauth_disconnect_dispatching(
	p_operation_id uuid,
	p_user_id uuid,
	p_household_id uuid,
	p_private_space_id uuid,
	p_session_id uuid
)
RETURNS TABLE (status text, result jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_now timestamp with time zone := pg_catalog.clock_timestamp();
	v_existing emdo.google_oauth_disconnect_operations%ROWTYPE;
	v_current_epoch integer;
	v_current_revision integer;
	v_advanced_epoch integer;
BEGIN
	IF p_operation_id IS NULL
		OR p_user_id IS DISTINCT FROM emdo.current_user_id()
		OR p_session_id IS DISTINCT FROM emdo.current_session_id()
		OR p_household_id IS NULL
		OR p_private_space_id IS NULL
		OR NOT emdo.lock_active_request_scope(
			p_household_id, p_private_space_id, NULL
		)
	THEN
		RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
		RETURN;
	END IF;
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			p_user_id::text || ':' || p_household_id::text || ':' ||
			p_private_space_id::text,
			0
		)
	);
	SELECT stored.* INTO v_existing
	FROM emdo.google_oauth_disconnect_operations AS stored
	WHERE stored.id = p_operation_id
		AND stored.parent_operation_id IS NULL
		AND stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_user_id
	FOR UPDATE;
	IF NOT FOUND THEN
		RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
		RETURN;
	END IF;
	IF v_existing.state = 'completed' THEN
		RETURN QUERY SELECT 'replayed'::text, v_existing.result;
		RETURN;
	END IF;
	IF v_existing.state = 'dispatching' THEN
		SELECT stored.authorization_epoch INTO v_current_epoch
		FROM emdo.google_oauth_authorization_epochs AS stored
		WHERE stored.household_id = p_household_id
			AND stored.private_space_id = p_private_space_id
			AND stored.original_owner_user_id = p_user_id
		FOR SHARE OF stored;
		SELECT stored.revision INTO v_current_revision
		FROM emdo.encrypted_google_calendar_grants AS stored
		WHERE stored.household_id = p_household_id
			AND stored.private_space_id = p_private_space_id
			AND stored.original_owner_user_id = p_user_id
			AND stored.provider = 'google'
			AND stored.grant_type = 'calendar-authorization'
		FOR SHARE OF stored;
		IF v_current_epoch IS DISTINCT FROM v_existing.authorization_epoch + 1
			OR v_current_revision IS NOT NULL
		THEN
			RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
			RETURN;
		END IF;
		RETURN QUERY SELECT 'dispatching'::text, NULL::jsonb;
		RETURN;
	END IF;
	IF v_existing.state <> 'claimed'
		OR v_existing.credential_revision IS NULL
	THEN
		RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
		RETURN;
	END IF;
	SELECT stored.authorization_epoch INTO v_current_epoch
	FROM emdo.google_oauth_authorization_epochs AS stored
	WHERE stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_user_id
		FOR UPDATE OF stored;
	v_current_epoch := COALESCE(v_current_epoch, 0);
	SELECT stored.revision INTO v_current_revision
	FROM emdo.encrypted_google_calendar_grants AS stored
	WHERE stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_user_id
		AND stored.provider = 'google'
		AND stored.grant_type = 'calendar-authorization'
		FOR UPDATE OF stored;
	IF v_current_epoch IS DISTINCT FROM v_existing.authorization_epoch
		OR v_current_revision IS DISTINCT FROM v_existing.credential_revision
	THEN
		RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
		RETURN;
	END IF;
	IF v_existing.authorization_epoch = 0 AND v_current_epoch = 0 THEN
		INSERT INTO emdo.google_oauth_authorization_epochs(
			household_id, private_space_id, original_owner_user_id,
			authorization_epoch, created_at, updated_at
		) VALUES (
			p_household_id, p_private_space_id, p_user_id, 1, v_now, v_now
		)
		ON CONFLICT (household_id, private_space_id, original_owner_user_id)
			DO UPDATE SET
				authorization_epoch =
					emdo.google_oauth_authorization_epochs.authorization_epoch + 1,
				updated_at = v_now
			WHERE emdo.google_oauth_authorization_epochs.authorization_epoch = 0
		RETURNING authorization_epoch INTO v_advanced_epoch;
	ELSE
		UPDATE emdo.google_oauth_authorization_epochs AS stored
		SET authorization_epoch = stored.authorization_epoch + 1,
			updated_at = v_now
		WHERE stored.household_id = p_household_id
			AND stored.private_space_id = p_private_space_id
			AND stored.original_owner_user_id = p_user_id
			AND stored.authorization_epoch = v_existing.authorization_epoch
		RETURNING stored.authorization_epoch INTO v_advanced_epoch;
	END IF;
	IF v_advanced_epoch IS DISTINCT FROM v_existing.authorization_epoch + 1 THEN
		RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
		RETURN;
	END IF;
	UPDATE emdo.google_oauth_disconnect_operations AS stored
	SET state = 'dispatching',
		dispatch_request_id = emdo.current_request_id(),
		dispatch_session_id = emdo.current_session_id(),
		updated_at = GREATEST(
			v_now, stored.updated_at + interval '1 microsecond'
		)
	WHERE stored.id = v_existing.id;
	PERFORM pg_catalog.set_config(
		'emdo.google_oauth_disconnect_operation_id', v_existing.id::text, true
	);
	DELETE FROM emdo.encrypted_google_calendar_grants AS stored
	WHERE stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_user_id
		AND stored.provider = 'google'
		AND stored.grant_type = 'calendar-authorization'
		AND stored.revision = v_existing.credential_revision
		AND stored.authorization_epoch = v_existing.authorization_epoch;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = '40001',
			MESSAGE = 'google oauth disconnect credential changed';
	END IF;
	PERFORM pg_catalog.set_config(
		'emdo.google_oauth_disconnect_operation_id', '', true
	);
	PERFORM emdo.invalidate_google_oauth_flows(
		p_user_id, p_household_id, p_private_space_id
	);
	RETURN QUERY SELECT 'dispatching'::text, NULL::jsonb;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.settle_google_oauth_disconnect(
	p_operation_id uuid,
	p_user_id uuid,
	p_household_id uuid,
	p_private_space_id uuid,
	p_session_id uuid,
	p_provider_revocation text
)
RETURNS TABLE (status text, result jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_now timestamp with time zone := pg_catalog.clock_timestamp();
	v_completed_at timestamp with time zone;
	v_latest_linked_updated_at timestamp with time zone;
	v_existing emdo.google_oauth_disconnect_operations%ROWTYPE;
	v_current_epoch integer;
	v_current_revision integer;
	v_advanced_epoch integer;
	v_result jsonb;
BEGIN
	IF p_operation_id IS NULL
		OR p_user_id IS DISTINCT FROM emdo.current_user_id()
		OR p_session_id IS DISTINCT FROM emdo.current_session_id()
		OR p_household_id IS NULL
		OR p_private_space_id IS NULL
		OR p_provider_revocation NOT IN (
			'not-applicable', 'confirmed', 'unconfirmed'
		)
		OR NOT emdo.lock_active_request_scope(
			p_household_id, p_private_space_id, NULL
		)
	THEN
		RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
		RETURN;
	END IF;
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			p_user_id::text || ':' || p_household_id::text || ':' ||
			p_private_space_id::text,
			0
		)
	);
	SELECT stored.* INTO v_existing
	FROM emdo.google_oauth_disconnect_operations AS stored
	WHERE stored.id = p_operation_id
		AND stored.parent_operation_id IS NULL
		AND stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_user_id
	FOR UPDATE;
	IF NOT FOUND THEN
		RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
		RETURN;
	END IF;
	IF v_existing.state = 'completed' THEN
		RETURN QUERY SELECT 'replayed'::text, v_existing.result;
		RETURN;
	END IF;
	IF (v_existing.credential_revision IS NULL
		AND (v_existing.state <> 'claimed'
			OR p_provider_revocation <> 'not-applicable'))
		OR (v_existing.credential_revision IS NOT NULL
			AND (v_existing.state <> 'dispatching'
				OR p_provider_revocation = 'not-applicable'))
	THEN
		RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
		RETURN;
	END IF;

	SELECT stored.authorization_epoch INTO v_current_epoch
	FROM emdo.google_oauth_authorization_epochs AS stored
	WHERE stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_user_id
	FOR UPDATE OF stored;
	v_current_epoch := COALESCE(v_current_epoch, 0);
	SELECT stored.revision INTO v_current_revision
	FROM emdo.encrypted_google_calendar_grants AS stored
	WHERE stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_user_id
		AND stored.provider = 'google'
		AND stored.grant_type = 'calendar-authorization'
	FOR UPDATE OF stored;
	IF v_existing.credential_revision IS NULL THEN
		IF v_current_epoch IS DISTINCT FROM v_existing.authorization_epoch
			OR v_current_revision IS NOT NULL
		THEN
			RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
			RETURN;
		END IF;
		IF v_existing.authorization_epoch = 0 AND v_current_epoch = 0 THEN
			INSERT INTO emdo.google_oauth_authorization_epochs(
				household_id, private_space_id, original_owner_user_id,
				authorization_epoch, created_at, updated_at
			) VALUES (
				p_household_id, p_private_space_id, p_user_id, 1, v_now, v_now
			)
			ON CONFLICT (household_id, private_space_id, original_owner_user_id)
				DO UPDATE SET
					authorization_epoch =
						emdo.google_oauth_authorization_epochs.authorization_epoch + 1,
					updated_at = v_now
				WHERE emdo.google_oauth_authorization_epochs.authorization_epoch = 0
			RETURNING authorization_epoch INTO v_advanced_epoch;
		ELSE
			UPDATE emdo.google_oauth_authorization_epochs AS stored
			SET authorization_epoch = stored.authorization_epoch + 1,
				updated_at = v_now
			WHERE stored.household_id = p_household_id
				AND stored.private_space_id = p_private_space_id
				AND stored.original_owner_user_id = p_user_id
				AND stored.authorization_epoch = v_existing.authorization_epoch
			RETURNING stored.authorization_epoch INTO v_advanced_epoch;
		END IF;
		IF v_advanced_epoch IS DISTINCT FROM v_existing.authorization_epoch + 1 THEN
			RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
			RETURN;
		END IF;
		PERFORM emdo.invalidate_google_oauth_flows(
			p_user_id, p_household_id, p_private_space_id
		);
	ELSE
		IF v_current_epoch IS DISTINCT FROM v_existing.authorization_epoch + 1
			OR v_current_revision IS NOT NULL
		THEN
			RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
			RETURN;
		END IF;
	END IF;
	v_result := pg_catalog.jsonb_build_object(
		'status', 'disconnected',
		'providerRevocation', p_provider_revocation
	);
	SELECT pg_catalog.max(linked.updated_at) INTO v_latest_linked_updated_at
	FROM emdo.google_oauth_disconnect_operations AS linked
	WHERE linked.parent_operation_id = v_existing.id
		AND linked.state = 'linked';
	v_completed_at := GREATEST(
		v_now,
		v_existing.updated_at + interval '1 microsecond',
		COALESCE(
			v_latest_linked_updated_at + interval '1 microsecond',
			v_now
		)
	);
	UPDATE emdo.google_oauth_disconnect_operations AS stored
	SET state = 'completed',
		completed_request_id = emdo.current_request_id(),
		completed_session_id = emdo.current_session_id(),
		completion_source = 'interactive',
		result = v_result,
		updated_at = v_completed_at,
		completed_at = v_completed_at,
		retain_until = v_completed_at + interval '90 days'
	WHERE stored.id = v_existing.id;
	UPDATE emdo.google_oauth_disconnect_operations AS linked
	SET state = 'completed',
		dispatch_request_id = v_existing.dispatch_request_id,
		dispatch_session_id = v_existing.dispatch_session_id,
		completed_request_id = emdo.current_request_id(),
		completed_session_id = emdo.current_session_id(),
		completion_source = 'interactive',
		result = v_result,
		updated_at = v_completed_at,
		completed_at = v_completed_at,
		retain_until = v_completed_at + interval '90 days'
	WHERE linked.parent_operation_id = v_existing.id
		AND linked.state = 'linked';
	RETURN QUERY SELECT 'stored'::text, v_result;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.reconcile_stranded_google_oauth_disconnects(
	p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_now timestamp with time zone := pg_catalog.clock_timestamp();
	v_completed_at timestamp with time zone;
	v_latest_linked_updated_at timestamp with time zone;
	v_existing emdo.google_oauth_disconnect_operations%ROWTYPE;
	v_current_epoch integer;
	v_current_grants integer;
	v_reconciled integer := 0;
	v_result jsonb := pg_catalog.jsonb_build_object(
		'status', 'disconnected',
		'providerRevocation', 'unconfirmed'
	);
BEGIN
	IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
		RAISE EXCEPTION USING
			ERRCODE = '22023',
			MESSAGE = 'invalid google oauth disconnect reconciliation limit';
	END IF;
	FOR v_existing IN
		SELECT stored.*
		FROM emdo.google_oauth_disconnect_operations AS stored
		WHERE stored.parent_operation_id IS NULL
			AND stored.state = 'dispatching'
			AND stored.updated_at <= v_now - interval '10 minutes'
		ORDER BY stored.updated_at, stored.id
		LIMIT p_limit
		FOR UPDATE SKIP LOCKED
	LOOP
		PERFORM pg_catalog.pg_advisory_xact_lock(
			pg_catalog.hashtextextended(
				v_existing.original_owner_user_id::text || ':' ||
				v_existing.household_id::text || ':' ||
				v_existing.private_space_id::text,
				0
			)
		);
		SELECT stored.authorization_epoch INTO v_current_epoch
		FROM emdo.google_oauth_authorization_epochs AS stored
		WHERE stored.household_id = v_existing.household_id
			AND stored.private_space_id = v_existing.private_space_id
			AND stored.original_owner_user_id =
				v_existing.original_owner_user_id;
		SELECT pg_catalog.count(*)::integer INTO v_current_grants
		FROM emdo.encrypted_google_calendar_grants AS stored
		WHERE stored.household_id = v_existing.household_id
			AND stored.private_space_id = v_existing.private_space_id
			AND stored.original_owner_user_id =
				v_existing.original_owner_user_id
			AND stored.provider = 'google'
			AND stored.grant_type = 'calendar-authorization';
		IF v_current_epoch IS DISTINCT FROM v_existing.authorization_epoch + 1
			OR v_current_grants <> 0
		THEN
			CONTINUE;
		END IF;
		SELECT pg_catalog.max(linked.updated_at)
		INTO v_latest_linked_updated_at
		FROM emdo.google_oauth_disconnect_operations AS linked
		WHERE linked.parent_operation_id = v_existing.id
			AND linked.state = 'linked';
		v_completed_at := GREATEST(
			v_now,
			v_existing.updated_at + interval '1 microsecond',
			COALESCE(
				v_latest_linked_updated_at + interval '1 microsecond',
				v_now
			)
		);
		UPDATE emdo.google_oauth_disconnect_operations AS stored
		SET state = 'completed',
			completion_source = 'reconciliation',
			result = v_result,
			updated_at = v_completed_at,
			completed_at = v_completed_at,
			retain_until = v_completed_at + interval '90 days'
		WHERE stored.id = v_existing.id
			AND stored.state = 'dispatching';
		IF NOT FOUND THEN
			CONTINUE;
		END IF;
		UPDATE emdo.google_oauth_disconnect_operations AS linked
		SET state = 'completed',
			dispatch_request_id = v_existing.dispatch_request_id,
			dispatch_session_id = v_existing.dispatch_session_id,
			completion_source = 'reconciliation',
			result = v_result,
			updated_at = v_completed_at,
			completed_at = v_completed_at,
			retain_until = v_completed_at + interval '90 days'
		WHERE linked.parent_operation_id = v_existing.id
			AND linked.state = 'linked';
		v_reconciled := v_reconciled + 1;
	END LOOP;
	RETURN v_reconciled;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.purge_completed_google_oauth_disconnects(
	p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_deleted integer;
BEGIN
	IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
		RAISE EXCEPTION USING
			ERRCODE = '22023',
			MESSAGE = 'invalid google oauth disconnect purge limit';
	END IF;
	WITH candidates AS (
		SELECT stored.id
		FROM emdo.google_oauth_disconnect_operations AS stored
		WHERE stored.state = 'completed'
			AND stored.retain_until <= pg_catalog.clock_timestamp()
			AND (
				stored.parent_operation_id IS NOT NULL
				OR NOT EXISTS (
					SELECT 1
					FROM emdo.google_oauth_disconnect_operations AS child
					WHERE child.parent_operation_id = stored.id
				)
			)
		ORDER BY
			(stored.parent_operation_id IS NULL),
			stored.retain_until,
			stored.id
		LIMIT p_limit
	)
	DELETE FROM emdo.google_oauth_disconnect_operations AS stored
	USING candidates
	WHERE stored.id = candidates.id;
	GET DIAGNOSTICS v_deleted = ROW_COUNT;
	RETURN v_deleted;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.google_oauth_disconnect_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
	SELECT
		session_user = 'emdo_api_login'
		AND pg_catalog.pg_has_role(session_user, 'emdo_app', 'MEMBER')
		AND NOT pg_catalog.pg_has_role(
			session_user, 'emdo_oauth_grant_executor', 'MEMBER'
		)
		AND NOT pg_catalog.pg_has_role(
			session_user, 'emdo_google_oauth_disconnect_retention', 'MEMBER'
		)
		AND NOT pg_catalog.pg_has_role(
			session_user,
			'emdo_google_oauth_disconnect_reconciliation_executor', 'MEMBER'
		)
		AND NOT pg_catalog.pg_has_role(
			session_user,
			'emdo_google_oauth_disconnect_reconciliation', 'MEMBER'
		)
		AND (
			SELECT pg_catalog.count(*) = 4
			FROM pg_catalog.pg_roles AS role
			WHERE role.rolname IN (
				'emdo_oauth_grant_executor',
				'emdo_google_oauth_disconnect_retention',
				'emdo_google_oauth_disconnect_reconciliation_executor',
				'emdo_google_oauth_disconnect_reconciliation'
			)
				AND role.rolcanlogin = false
				AND role.rolinherit = false
				AND role.rolbypassrls = false
				AND role.rolsuper = false
				AND role.rolcreatedb = false
				AND role.rolcreaterole = false
				AND role.rolreplication = false
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_auth_members AS membership
			WHERE 'emdo_google_oauth_disconnect_retention'::regrole
					IN (membership.roleid, membership.member)
				OR 'emdo_google_oauth_disconnect_reconciliation_executor'::regrole
					IN (membership.roleid, membership.member)
				OR 'emdo_google_oauth_disconnect_reconciliation'::regrole
					IN (membership.roleid, membership.member)
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_auth_members AS membership
			JOIN pg_catalog.pg_roles AS role
				ON role.oid IN (membership.roleid, membership.member)
			WHERE role.rolname = 'emdo_oauth_grant_executor'
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_class AS relation
			JOIN pg_catalog.pg_namespace AS namespace
				ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname = 'emdo'
				AND relation.relname = 'google_oauth_disconnect_operations'
				AND relation.relrowsecurity
				AND relation.relforcerowsecurity
				AND relation.relowner = 'emdo_oauth_grant_executor'::regrole
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user,
			'emdo.google_oauth_disconnect_operations',
			'SELECT,INSERT,UPDATE,DELETE'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_oauth_grant_executor',
			'emdo.google_oauth_disconnect_operations',
			'SELECT,INSERT,UPDATE,DELETE'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_retention',
			'emdo.google_oauth_disconnect_operations',
			'SELECT,DELETE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_retention',
			'emdo.google_oauth_disconnect_operations',
			'INSERT,UPDATE'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_reconciliation_executor',
			'emdo.google_oauth_disconnect_operations',
			'SELECT,UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_reconciliation_executor',
			'emdo.google_oauth_disconnect_operations',
			'INSERT,DELETE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_reconciliation',
			'emdo.google_oauth_disconnect_operations',
			'SELECT,INSERT,UPDATE,DELETE'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_reconciliation_executor',
			'emdo.google_oauth_authorization_epochs',
			'SELECT'
		)
		AND pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_reconciliation_executor',
			'emdo.encrypted_google_calendar_grants',
			'SELECT'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_reconciliation_executor',
			'emdo.google_oauth_authorization_epochs',
			'INSERT,UPDATE,DELETE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_google_oauth_disconnect_reconciliation_executor',
			'emdo.encrypted_google_calendar_grants',
			'INSERT,UPDATE,DELETE'
		)
		AND (
			SELECT pg_catalog.count(*) = 4
			FROM pg_catalog.pg_proc AS proc
			WHERE proc.oid IN (
				'emdo.claim_google_oauth_disconnect(uuid,uuid,uuid,uuid,text,text)'::regprocedure,
				'emdo.mark_google_oauth_disconnect_dispatching(uuid,uuid,uuid,uuid,uuid)'::regprocedure,
				'emdo.settle_google_oauth_disconnect(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure,
				'emdo.google_oauth_disconnect_ready()'::regprocedure
			)
				AND proc.prosecdef
				AND proc.proowner = 'emdo_oauth_grant_executor'::regrole
				AND proc.proconfig @> ARRAY[
					'row_security=on', 'search_path=pg_catalog, emdo'
				]
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS proc
			WHERE proc.oid =
				'emdo.purge_completed_google_oauth_disconnects(integer)'::regprocedure
				AND proc.prosecdef
				AND proc.proowner =
					'emdo_google_oauth_disconnect_retention'::regrole
				AND proc.proconfig @> ARRAY[
					'row_security=on', 'search_path=pg_catalog, emdo'
				]
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS proc
			WHERE proc.oid =
				'emdo.reconcile_stranded_google_oauth_disconnects(integer)'::regprocedure
				AND proc.prosecdef
				AND proc.proowner =
					'emdo_google_oauth_disconnect_reconciliation_executor'::regrole
				AND proc.proconfig @> ARRAY[
					'row_security=on', 'search_path=pg_catalog, emdo'
				]
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS proc
			WHERE proc.oid =
				ANY (ARRAY[
					'emdo.enforce_google_oauth_disconnect_transition()'::regprocedure,
					'emdo.enforce_google_calendar_grant_disconnect_fence()'::regprocedure
				])
				AND NOT proc.prosecdef
				AND proc.proowner = 'emdo_oauth_grant_executor'::regrole
				AND proc.proconfig @> ARRAY['search_path=pg_catalog, emdo']
			GROUP BY proc.proowner
			HAVING pg_catalog.count(*) = 2
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.unnest(ARRAY[
				'emdo.claim_google_oauth_disconnect(uuid,uuid,uuid,uuid,text,text)'::regprocedure,
				'emdo.mark_google_oauth_disconnect_dispatching(uuid,uuid,uuid,uuid,uuid)'::regprocedure,
				'emdo.settle_google_oauth_disconnect(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure,
				'emdo.google_oauth_disconnect_ready()'::regprocedure
			]) AS routine(oid)
			WHERE NOT pg_catalog.has_function_privilege(
				session_user, routine.oid, 'EXECUTE'
			)
		)
		AND NOT pg_catalog.has_function_privilege(
			session_user,
			'emdo.purge_completed_google_oauth_disconnects(integer)',
			'EXECUTE'
		)
		AND NOT pg_catalog.has_function_privilege(
			session_user,
			'emdo.reconcile_stranded_google_oauth_disconnects(integer)',
			'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_google_oauth_disconnect_retention',
			'emdo.purge_completed_google_oauth_disconnects(integer)',
			'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_google_oauth_disconnect_reconciliation',
			'emdo.reconcile_stranded_google_oauth_disconnects(integer)',
			'EXECUTE'
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.unnest(ARRAY[
				'emdo.claim_google_oauth_disconnect(uuid,uuid,uuid,uuid,text,text)'::regprocedure,
				'emdo.mark_google_oauth_disconnect_dispatching(uuid,uuid,uuid,uuid,uuid)'::regprocedure,
				'emdo.settle_google_oauth_disconnect(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure,
				'emdo.google_oauth_disconnect_ready()'::regprocedure,
				'emdo.enforce_google_oauth_disconnect_transition()'::regprocedure,
				'emdo.enforce_google_calendar_grant_disconnect_fence()'::regprocedure,
				'emdo.reconcile_stranded_google_oauth_disconnects(integer)'::regprocedure
			]) AS routine(oid)
			WHERE pg_catalog.has_function_privilege(
				'emdo_google_oauth_disconnect_retention', routine.oid, 'EXECUTE'
			)
		)
		AND NOT pg_catalog.has_function_privilege(
			session_user,
			'emdo.enforce_google_oauth_disconnect_transition()',
			'EXECUTE'
		)
		AND NOT pg_catalog.has_function_privilege(
			session_user,
			'emdo.enforce_google_calendar_grant_disconnect_fence()',
			'EXECUTE'
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.unnest(ARRAY[
				'emdo.claim_google_oauth_disconnect(uuid,uuid,uuid,uuid,text,text)'::regprocedure,
				'emdo.mark_google_oauth_disconnect_dispatching(uuid,uuid,uuid,uuid,uuid)'::regprocedure,
				'emdo.settle_google_oauth_disconnect(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure,
				'emdo.purge_completed_google_oauth_disconnects(integer)'::regprocedure,
				'emdo.google_oauth_disconnect_ready()'::regprocedure,
				'emdo.enforce_google_oauth_disconnect_transition()'::regprocedure,
				'emdo.enforce_google_calendar_grant_disconnect_fence()'::regprocedure
			]) AS routine(oid)
			WHERE pg_catalog.has_function_privilege(
				'emdo_google_oauth_disconnect_reconciliation',
				routine.oid, 'EXECUTE'
			)
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_proc AS proc
			CROSS JOIN LATERAL pg_catalog.aclexplode(
				COALESCE(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
			) AS privilege
			WHERE proc.oid IN (
				'emdo.claim_google_oauth_disconnect(uuid,uuid,uuid,uuid,text,text)'::regprocedure,
				'emdo.mark_google_oauth_disconnect_dispatching(uuid,uuid,uuid,uuid,uuid)'::regprocedure,
				'emdo.settle_google_oauth_disconnect(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure,
				'emdo.purge_completed_google_oauth_disconnects(integer)'::regprocedure,
				'emdo.reconcile_stranded_google_oauth_disconnects(integer)'::regprocedure,
				'emdo.google_oauth_disconnect_ready()'::regprocedure,
				'emdo.enforce_google_oauth_disconnect_transition()'::regprocedure,
				'emdo.enforce_google_calendar_grant_disconnect_fence()'::regprocedure
			)
				AND privilege.grantee = 0
				AND privilege.privilege_type = 'EXECUTE'
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.unnest(ARRAY[
				'emdo.current_user_id()'::regprocedure,
				'emdo.current_session_id()'::regprocedure,
				'emdo.current_request_id()'::regprocedure,
				'emdo.lock_active_request_scope(uuid,uuid,uuid)'::regprocedure,
				'emdo.canonical_json_text(jsonb)'::regprocedure,
				'emdo.canonical_json_hash(jsonb)'::regprocedure,
				'emdo.invalidate_google_oauth_flows(uuid,uuid,uuid)'::regprocedure
			]) AS helper(oid)
			WHERE NOT pg_catalog.has_function_privilege(
				'emdo_oauth_grant_executor', helper.oid, 'EXECUTE'
			)
		)
$function$;
--> statement-breakpoint
ALTER TABLE emdo.google_oauth_disconnect_operations
	OWNER TO emdo_oauth_grant_executor;
ALTER FUNCTION emdo.enforce_google_oauth_disconnect_transition()
	OWNER TO emdo_oauth_grant_executor;
ALTER FUNCTION emdo.enforce_google_calendar_grant_disconnect_fence()
	OWNER TO emdo_oauth_grant_executor;
ALTER FUNCTION emdo.claim_google_oauth_disconnect(uuid, uuid, uuid, uuid, text, text)
	OWNER TO emdo_oauth_grant_executor;
ALTER FUNCTION emdo.mark_google_oauth_disconnect_dispatching(uuid, uuid, uuid, uuid, uuid)
	OWNER TO emdo_oauth_grant_executor;
ALTER FUNCTION emdo.settle_google_oauth_disconnect(uuid, uuid, uuid, uuid, uuid, text)
	OWNER TO emdo_oauth_grant_executor;
ALTER FUNCTION emdo.reconcile_stranded_google_oauth_disconnects(integer)
	OWNER TO emdo_google_oauth_disconnect_reconciliation_executor;
ALTER FUNCTION emdo.purge_completed_google_oauth_disconnects(integer)
	OWNER TO emdo_google_oauth_disconnect_retention;
ALTER FUNCTION emdo.google_oauth_disconnect_ready()
	OWNER TO emdo_oauth_grant_executor;
REVOKE ALL ON emdo.google_oauth_disconnect_operations
	FROM PUBLIC, emdo_app, emdo_google_oauth_disconnect_retention,
		emdo_google_oauth_disconnect_reconciliation_executor,
		emdo_google_oauth_disconnect_reconciliation;
REVOKE ALL ON FUNCTION emdo.enforce_google_oauth_disconnect_transition()
	FROM PUBLIC, emdo_app;
REVOKE ALL ON FUNCTION emdo.enforce_google_calendar_grant_disconnect_fence()
	FROM PUBLIC, emdo_app;
REVOKE ALL ON FUNCTION emdo.claim_google_oauth_disconnect(uuid, uuid, uuid, uuid, text, text)
	FROM PUBLIC;
REVOKE ALL ON FUNCTION emdo.mark_google_oauth_disconnect_dispatching(uuid, uuid, uuid, uuid, uuid)
	FROM PUBLIC;
REVOKE ALL ON FUNCTION emdo.settle_google_oauth_disconnect(uuid, uuid, uuid, uuid, uuid, text)
	FROM PUBLIC;
REVOKE ALL ON FUNCTION emdo.reconcile_stranded_google_oauth_disconnects(integer)
	FROM PUBLIC, emdo_app, emdo_oauth_grant_executor,
		emdo_google_oauth_disconnect_retention;
REVOKE ALL ON FUNCTION emdo.purge_completed_google_oauth_disconnects(integer)
	FROM PUBLIC, emdo_app, emdo_oauth_grant_executor;
REVOKE ALL ON FUNCTION emdo.google_oauth_disconnect_ready() FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE
	ON emdo.google_oauth_disconnect_operations TO emdo_oauth_grant_executor;
GRANT SELECT, DELETE ON emdo.google_oauth_disconnect_operations
	TO emdo_google_oauth_disconnect_retention;
GRANT SELECT, UPDATE ON emdo.google_oauth_disconnect_operations
	TO emdo_google_oauth_disconnect_reconciliation_executor;
GRANT SELECT ON emdo.google_oauth_authorization_epochs,
	emdo.encrypted_google_calendar_grants
	TO emdo_google_oauth_disconnect_reconciliation_executor;
GRANT USAGE ON SCHEMA emdo TO emdo_google_oauth_disconnect_retention,
	emdo_google_oauth_disconnect_reconciliation_executor,
	emdo_google_oauth_disconnect_reconciliation;
GRANT EXECUTE ON FUNCTION emdo.invalidate_google_oauth_flows(uuid, uuid, uuid)
	TO emdo_oauth_grant_executor;
GRANT EXECUTE ON FUNCTION emdo.canonical_json_hash(jsonb)
	TO emdo_oauth_grant_executor;
GRANT EXECUTE ON FUNCTION emdo.canonical_json_text(jsonb)
	TO emdo_oauth_grant_executor;
GRANT EXECUTE ON FUNCTION emdo.claim_google_oauth_disconnect(uuid, uuid, uuid, uuid, text, text)
	TO emdo_app;
GRANT EXECUTE ON FUNCTION emdo.mark_google_oauth_disconnect_dispatching(uuid, uuid, uuid, uuid, uuid)
	TO emdo_app;
GRANT EXECUTE ON FUNCTION emdo.settle_google_oauth_disconnect(uuid, uuid, uuid, uuid, uuid, text)
	TO emdo_app;
GRANT EXECUTE ON FUNCTION emdo.reconcile_stranded_google_oauth_disconnects(integer)
	TO emdo_google_oauth_disconnect_reconciliation;
GRANT EXECUTE ON FUNCTION emdo.purge_completed_google_oauth_disconnects(integer)
	TO emdo_google_oauth_disconnect_retention;
GRANT EXECUTE ON FUNCTION emdo.google_oauth_disconnect_ready() TO emdo_app;
