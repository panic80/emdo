CREATE TABLE "emdo"."notification_preference_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"initial_request_id" uuid NOT NULL,
	"latest_request_id" uuid NOT NULL,
	"response" jsonb,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"retain_until" timestamp with time zone DEFAULT clock_timestamp() + interval '90 days' NOT NULL,
	CONSTRAINT "notification_preference_commands_idempotency_unique" UNIQUE("household_id","user_id","idempotency_key"),
	CONSTRAINT "notification_preference_commands_key_check" CHECK (pg_catalog.length("emdo"."notification_preference_commands"."idempotency_key") between 16 and 200 and "emdo"."notification_preference_commands"."idempotency_key" ~ '^[A-Za-z0-9:._-]+$'),
	CONSTRAINT "notification_preference_commands_hash_check" CHECK ("emdo"."notification_preference_commands"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "notification_preference_commands_completion_check" CHECK (("emdo"."notification_preference_commands"."response" is null and "emdo"."notification_preference_commands"."completed_at" is null) or ("emdo"."notification_preference_commands"."response" is not null and "emdo"."notification_preference_commands"."completed_at" is not null)),
	CONSTRAINT "notification_preference_commands_retention_check" CHECK ("emdo"."notification_preference_commands"."retain_until" > "emdo"."notification_preference_commands"."recorded_at" and "emdo"."notification_preference_commands"."retain_until" <= "emdo"."notification_preference_commands"."recorded_at" + interval '90 days')
);
--> statement-breakpoint
CREATE TABLE "emdo"."notification_preferences" (
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"push" boolean DEFAULT false NOT NULL,
	"email" boolean DEFAULT false NOT NULL,
	"spoken_replies" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_pk" PRIMARY KEY("household_id","user_id"),
	CONSTRAINT "notification_preferences_version_positive" CHECK ("emdo"."notification_preferences"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "emdo"."notification_preference_commands" ADD CONSTRAINT "notification_preference_commands_membership_fk" FOREIGN KEY ("household_id","user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."notification_preferences" ADD CONSTRAINT "notification_preferences_membership_fk" FOREIGN KEY ("household_id","user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
DO $role$
BEGIN
	IF NOT EXISTS (
		SELECT FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_experience_preferences_executor'
	) THEN
		CREATE ROLE emdo_experience_preferences_executor NOLOGIN NOSUPERUSER
			NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (
		SELECT FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_notification_preferences_worker_executor'
	) THEN
		CREATE ROLE emdo_notification_preferences_worker_executor NOLOGIN NOSUPERUSER
			NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$role$;
ALTER ROLE emdo_experience_preferences_executor NOLOGIN NOSUPERUSER
	NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_notification_preferences_worker_executor NOLOGIN NOSUPERUSER
	NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
--> statement-breakpoint
DO $membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname IN (
				'emdo_experience_preferences_executor',
				'emdo_notification_preferences_worker_executor'
			)
			OR child.rolname IN (
				'emdo_experience_preferences_executor',
				'emdo_notification_preferences_worker_executor'
			)
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'experience preferences executor must not have role memberships';
	END IF;
END
$membership_guard$;
--> statement-breakpoint
ALTER TABLE emdo.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.notification_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE emdo.notification_preference_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.notification_preference_commands FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notification_preferences_executor_scope
ON emdo.notification_preferences
FOR ALL TO emdo_experience_preferences_executor
USING (
	user_id = emdo.current_user_id()
	AND emdo.is_active_request_scope(household_id, NULL, NULL)
)
WITH CHECK (
	user_id = emdo.current_user_id()
	AND emdo.is_active_request_scope(household_id, NULL, NULL)
);
CREATE POLICY notification_preference_commands_executor_scope
ON emdo.notification_preference_commands
FOR ALL TO emdo_experience_preferences_executor
USING (
	user_id = emdo.current_user_id()
	AND emdo.is_active_request_scope(household_id, NULL, NULL)
)
WITH CHECK (
	user_id = emdo.current_user_id()
	AND emdo.is_active_request_scope(household_id, NULL, NULL)
);
CREATE POLICY notifications_preferences_worker_scope
ON emdo.notifications
FOR SELECT TO emdo_notification_preferences_worker_executor
USING (
	emdo.current_worker_job_name() = 'emdo.notification.delivery.v1'
	AND emdo.current_worker_target_type() = 'notification'
	AND notification_id::text = emdo.current_worker_target_id()
	AND revision = emdo.current_worker_target_revision()
	AND tombstoned_at IS NULL
	AND emdo.is_active_worker_operation_scope(
		household_id, space_id, original_owner_user_id
	)
);
CREATE POLICY notification_preferences_worker_scope
ON emdo.notification_preferences
FOR SELECT TO emdo_notification_preferences_worker_executor
USING (
	EXISTS (
		SELECT 1
		FROM emdo.notifications AS notification
		WHERE notification.household_id = notification_preferences.household_id
			AND notification.original_owner_user_id = notification_preferences.user_id
			AND notification.notification_id::text = emdo.current_worker_target_id()
			AND notification.revision = emdo.current_worker_target_revision()
			AND notification.tombstoned_at IS NULL
			AND emdo.current_worker_job_name() = 'emdo.notification.delivery.v1'
			AND emdo.current_worker_target_type() = 'notification'
			AND emdo.is_active_worker_operation_scope(
				notification.household_id,
				notification.space_id,
				notification.original_owner_user_id
		)
	)
);
CREATE POLICY auth_users_notification_preferences_worker_scope
ON emdo.auth_users
FOR SELECT TO emdo_notification_preferences_worker_executor
USING (
	email_verified = true
	AND EXISTS (
		SELECT 1
		FROM emdo.notifications AS notification
		WHERE notification.original_owner_user_id = auth_users.id
			AND notification.notification_id::text = emdo.current_worker_target_id()
			AND notification.revision = emdo.current_worker_target_revision()
			AND notification.tombstoned_at IS NULL
			AND emdo.current_worker_job_name() = 'emdo.notification.delivery.v1'
			AND emdo.current_worker_target_type() = 'notification'
			AND emdo.is_active_worker_operation_scope(
				notification.household_id,
				notification.space_id,
				notification.original_owner_user_id
			)
	)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.read_experience_notification_preferences(
	p_household_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	preference emdo.notification_preferences%ROWTYPE;
BEGIN
	IF NOT emdo.lock_active_request_scope(p_household_id, NULL, NULL) THEN
		RAISE EXCEPTION USING
			ERRCODE = '42501',
			MESSAGE = 'emdo:authorization-revoked';
	END IF;

	SELECT stored.* INTO preference
	FROM emdo.notification_preferences AS stored
	WHERE stored.household_id = p_household_id
		AND stored.user_id = emdo.current_user_id()
	FOR SHARE;

	RETURN pg_catalog.jsonb_build_object(
		'schemaVersion', 1,
		'version', COALESCE(preference.version, 1),
		'inApp', COALESCE(preference.in_app, true),
		'push', COALESCE(preference.push, false),
		'email', COALESCE(preference.email, false),
		'spokenReplies', COALESCE(preference.spoken_replies, false),
		'updatedAt', COALESCE(
			preference.updated_at,
			'1970-01-01 00:00:00+00'::timestamptz
		)
	);
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.update_experience_notification_preferences(
	p_household_id uuid,
	p_expected_version integer,
	p_in_app boolean,
	p_push boolean,
	p_email boolean,
	p_spoken_replies boolean,
	p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_user_id uuid := emdo.current_user_id();
	v_request_id uuid := emdo.current_request_id();
	v_request_hash text;
	v_now timestamptz := pg_catalog.clock_timestamp();
	v_command emdo.notification_preference_commands%ROWTYPE;
	v_preference emdo.notification_preferences%ROWTYPE;
	v_response jsonb;
BEGIN
	IF p_expected_version IS NULL OR p_expected_version < 1
		OR p_in_app IS NULL OR p_push IS NULL OR p_email IS NULL
		OR p_spoken_replies IS NULL
		OR p_idempotency_key IS NULL
		OR pg_catalog.length(p_idempotency_key) NOT BETWEEN 16 AND 200
		OR p_idempotency_key !~ '^[A-Za-z0-9:._-]+$'
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '22023',
			MESSAGE = 'emdo:invalid-notification-preferences';
	END IF;
	IF v_user_id IS NULL OR v_request_id IS NULL
		OR NOT emdo.lock_active_request_scope(p_household_id, NULL, NULL)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '42501',
			MESSAGE = 'emdo:authorization-revoked';
	END IF;

	v_request_hash := pg_catalog.encode(
		pg_catalog.sha256(pg_catalog.convert_to(
			pg_catalog.jsonb_build_object(
				'schemaVersion', 1,
				'expectedVersion', p_expected_version,
				'preferences', pg_catalog.jsonb_build_object(
					'inApp', p_in_app,
					'push', p_push,
					'email', p_email,
					'spokenReplies', p_spoken_replies
				)
			)::text,
			'UTF8'
		)),
		'hex'
	);

	INSERT INTO emdo.notification_preferences (
		household_id, user_id, in_app, push, email, spoken_replies,
		version, created_at, updated_at
	)
	VALUES (
		p_household_id, v_user_id, true, false, false, false, 1, v_now, v_now
	)
	ON CONFLICT (household_id, user_id) DO NOTHING;

	INSERT INTO emdo.notification_preference_commands (
		id, household_id, user_id, idempotency_key, request_hash,
		initial_request_id, latest_request_id, response,
		recorded_at, completed_at, retain_until
	)
	VALUES (
		pg_catalog.gen_random_uuid(), p_household_id, v_user_id,
		p_idempotency_key, v_request_hash, v_request_id, v_request_id,
		NULL, v_now, NULL, v_now + interval '90 days'
	)
	ON CONFLICT (household_id, user_id, idempotency_key) DO NOTHING;

	SELECT command.* INTO STRICT v_command
	FROM emdo.notification_preference_commands AS command
	WHERE command.household_id = p_household_id
		AND command.user_id = v_user_id
		AND command.idempotency_key = p_idempotency_key
	FOR UPDATE;

	IF v_command.request_hash <> v_request_hash THEN
		RAISE EXCEPTION USING
			ERRCODE = '40001',
			MESSAGE = 'emdo:idempotency-conflict';
	END IF;
	IF v_command.response IS NOT NULL THEN
		UPDATE emdo.notification_preference_commands
		SET latest_request_id = v_request_id
		WHERE id = v_command.id;
		RETURN v_command.response;
	END IF;

	UPDATE emdo.notification_preferences AS preference
	SET in_app = p_in_app,
		push = p_push,
		email = p_email,
		spoken_replies = p_spoken_replies,
		version = preference.version + 1,
		updated_at = v_now
	WHERE preference.household_id = p_household_id
		AND preference.user_id = v_user_id
		AND preference.version = p_expected_version
	RETURNING preference.* INTO v_preference;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = '40001',
			MESSAGE = 'emdo:version-conflict';
	END IF;

	v_response := pg_catalog.jsonb_build_object(
		'schemaVersion', 1,
		'version', v_preference.version,
		'inApp', v_preference.in_app,
		'push', v_preference.push,
		'email', v_preference.email,
		'spokenReplies', v_preference.spoken_replies,
		'updatedAt', v_preference.updated_at
	);
	UPDATE emdo.notification_preference_commands
	SET latest_request_id = v_request_id,
		response = v_response,
		completed_at = v_now
	WHERE id = v_command.id
		AND response IS NULL
		AND completed_at IS NULL;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = '40001',
			MESSAGE = 'emdo:idempotency-conflict';
	END IF;
	RETURN v_response;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.read_worker_notification_delivery_preferences(
	p_notification_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_result jsonb;
BEGIN
	IF p_notification_id IS NULL
		OR emdo.current_worker_job_name()
			IS DISTINCT FROM 'emdo.notification.delivery.v1'
		OR emdo.current_worker_target_type() IS DISTINCT FROM 'notification'
		OR emdo.current_worker_target_id()
			IS DISTINCT FROM p_notification_id::text
		OR emdo.current_worker_target_revision() IS NULL
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '42501',
			MESSAGE = 'emdo:worker-operation-unavailable';
	END IF;

	SELECT pg_catalog.jsonb_build_object(
		'schemaVersion', 1,
		'notificationId', notification.notification_id,
		'revision', notification.revision,
		'sensitivity', notification.sensitivity,
		'title', notification.title,
		'body', notification.body,
		'channels', pg_catalog.jsonb_build_object(
			'inApp', notification.in_app
				AND COALESCE(preference.in_app, true),
			'email', pg_catalog.jsonb_build_object(
				'enabled', notification.email_recipient IS NOT NULL
					AND COALESCE(preference.email, false)
					AND account_user.email_verified IS TRUE,
				'recipient', CASE
					WHEN notification.email_recipient IS NOT NULL
						AND COALESCE(preference.email, false)
						AND account_user.email_verified IS TRUE
					THEN account_user.email
					ELSE NULL
				END
			),
			-- Push consent cannot enable delivery until a current active
			-- subscription can be resolved independently of the frozen row.
			'push', pg_catalog.jsonb_build_object(
				'enabled', false AND COALESCE(preference.push, false),
				'subscriptionReference', NULL::text
			)
		)
	)
	INTO STRICT v_result
	FROM emdo.notifications AS notification
	LEFT JOIN emdo.notification_preferences AS preference
		ON preference.household_id = notification.household_id
		AND preference.user_id = notification.original_owner_user_id
	LEFT JOIN emdo.auth_users AS account_user
		ON account_user.id = notification.original_owner_user_id
		AND account_user.email_verified = true
	WHERE notification.notification_id = p_notification_id
		AND notification.notification_id::text = emdo.current_worker_target_id()
		AND notification.revision = emdo.current_worker_target_revision()
		AND notification.tombstoned_at IS NULL
		AND emdo.is_active_worker_operation_scope(
			notification.household_id,
			notification.space_id,
			notification.original_owner_user_id
		);

	RETURN v_result;
EXCEPTION
	WHEN no_data_found THEN
		RAISE EXCEPTION USING
			ERRCODE = '42501',
			MESSAGE = 'emdo:worker-operation-unavailable';
END
$function$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA emdo TO emdo_experience_preferences_executor,
	emdo_notification_preferences_worker_executor;
ALTER FUNCTION emdo.read_experience_notification_preferences(uuid)
	OWNER TO emdo_experience_preferences_executor;
ALTER FUNCTION emdo.update_experience_notification_preferences(
	uuid, integer, boolean, boolean, boolean, boolean, text
) OWNER TO emdo_experience_preferences_executor;
ALTER FUNCTION emdo.read_worker_notification_delivery_preferences(uuid)
	OWNER TO emdo_notification_preferences_worker_executor;
REVOKE CREATE ON SCHEMA emdo FROM emdo_experience_preferences_executor,
	emdo_notification_preferences_worker_executor;
REVOKE ALL ON emdo.notification_preferences,
	emdo.notification_preference_commands
	FROM PUBLIC, emdo_app, emdo_experience_preferences_executor;
REVOKE ALL ON emdo.notifications, emdo.notification_preferences,
	emdo.auth_users
	FROM emdo_notification_preferences_worker_executor;
REVOKE SELECT ON emdo.notifications FROM emdo_worker_executor;
GRANT USAGE ON SCHEMA emdo TO emdo_experience_preferences_executor;
GRANT USAGE ON SCHEMA emdo
	TO emdo_notification_preferences_worker_executor;
GRANT EXECUTE ON FUNCTION
	emdo.current_user_id(),
	emdo.current_request_id(),
	emdo.is_active_request_scope(uuid, uuid, uuid),
	emdo.lock_active_request_scope(uuid, uuid, uuid)
	TO emdo_experience_preferences_executor;
GRANT EXECUTE ON FUNCTION
	emdo.current_worker_job_name(),
	emdo.current_worker_target_type(),
	emdo.current_worker_target_id(),
	emdo.current_worker_target_revision(),
	emdo.is_active_worker_operation_scope(uuid, uuid, uuid)
	TO emdo_notification_preferences_worker_executor;
GRANT SELECT, INSERT ON emdo.notification_preferences
	TO emdo_experience_preferences_executor;
GRANT UPDATE (in_app, push, email, spoken_replies, version, updated_at)
	ON emdo.notification_preferences TO emdo_experience_preferences_executor;
GRANT SELECT, INSERT ON emdo.notification_preference_commands
	TO emdo_experience_preferences_executor;
GRANT UPDATE (latest_request_id, response, completed_at)
	ON emdo.notification_preference_commands
	TO emdo_experience_preferences_executor;
GRANT SELECT (
	notification_id, household_id, space_id, original_owner_user_id,
	revision, sensitivity, title, body, in_app, email_recipient,
	tombstoned_at
) ON emdo.notifications TO emdo_notification_preferences_worker_executor;
GRANT SELECT (household_id, user_id, in_app, email, push)
	ON emdo.notification_preferences
	TO emdo_notification_preferences_worker_executor;
GRANT SELECT (id, email, email_verified) ON emdo.auth_users
	TO emdo_notification_preferences_worker_executor;
GRANT SELECT (
	notification_id, household_id, space_id, original_owner_user_id,
	source_type, source_id, source_revision, revision, sensitivity, title,
	body, in_app, tombstoned_at
) ON emdo.notifications TO emdo_worker_executor;
REVOKE ALL ON FUNCTION
	emdo.read_experience_notification_preferences(uuid),
	emdo.update_experience_notification_preferences(
		uuid, integer, boolean, boolean, boolean, boolean, text
	)
	FROM PUBLIC, emdo_app;
REVOKE ALL ON FUNCTION
	emdo.read_worker_notification_delivery_preferences(uuid)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
		emdo_policy_reader, emdo_metering_executor,
		emdo_worker_scope_executor, emdo_worker_dispatch_executor,
		emdo_worker_executor,
		emdo_experience_preferences_executor,
		emdo_notification_preferences_worker_executor;
GRANT EXECUTE ON FUNCTION
	emdo.read_experience_notification_preferences(uuid),
	emdo.update_experience_notification_preferences(
		uuid, integer, boolean, boolean, boolean, boolean, text
	)
	TO emdo_app;
GRANT EXECUTE ON FUNCTION
	emdo.read_worker_notification_delivery_preferences(uuid)
	TO emdo_worker_executor;
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON
	emdo.notification_preferences, emdo.notification_preference_commands
	FROM PUBLIC, emdo_app, emdo_experience_preferences_executor,
		emdo_notification_preferences_worker_executor;
