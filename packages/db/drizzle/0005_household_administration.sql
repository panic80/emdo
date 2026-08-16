ALTER TABLE emdo.invitations
	ADD COLUMN administration_version integer DEFAULT 1 NOT NULL;
ALTER TABLE emdo.invitations
	ADD CONSTRAINT invitations_administration_version_positive
	CHECK (administration_version > 0);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.issue_household_invitation(
	p_email text,
	p_role text,
	p_expires_in_seconds integer,
	p_token_hash text,
	p_idempotency_key text,
	p_request_hash text,
	p_invitation_id uuid,
	p_operation_id text,
	p_delivery_secret_id uuid,
	p_template_version text,
	p_envelope jsonb,
	p_payload_hash text
)
RETURNS TABLE (
	schema_version integer,
	invitation_id uuid,
	household_id uuid,
	email text,
	role text,
	state text,
	version integer,
	created_at timestamptz,
	expires_at timestamptz,
	replayed boolean,
	delivery_queued boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_scope record;
	v_command record;
	v_invitation emdo.invitations%ROWTYPE;
	v_now timestamptz;
	v_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
	v_payload jsonb;
	v_canonical_payload text;
	v_expected_payload_hash text;
	v_operation_id text;
	v_algorithm text;
	v_key_id text;
	v_binding_hash text;
BEGIN
	IF v_email IS NULL
		OR pg_catalog.char_length(v_email) NOT BETWEEN 3 AND 320
		OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
		OR p_role NOT IN ('owner', 'member')
		OR NOT (p_expires_in_seconds BETWEEN 60 AND 604800)
		OR p_token_hash !~ '^[a-f0-9]{64}$'
		OR p_idempotency_key !~ '^[A-Za-z0-9:._-]{16,200}$'
		OR p_request_hash !~ '^[a-f0-9]{64}$'
		OR p_invitation_id IS NULL
		OR p_delivery_secret_id IS NULL
		OR p_template_version IS DISTINCT FROM 'invitation-redemption.v1'
		OR pg_catalog.jsonb_typeof(p_envelope) IS DISTINCT FROM 'object'
		OR pg_catalog.octet_length(p_envelope::text) NOT BETWEEN 64 AND 16384
		OR p_payload_hash !~ '^[a-f0-9]{64}$'
	THEN
		RETURN;
	END IF;
	v_algorithm := p_envelope ->> 'algorithm';
	v_key_id := p_envelope ->> 'keyId';
	v_binding_hash := p_envelope ->> 'bindingHash';
	IF p_envelope ->> 'schemaVersion' IS DISTINCT FROM '1'
		OR v_algorithm IS DISTINCT FROM 'RSA-OAEP-256'
		OR v_key_id IS NULL
		OR pg_catalog.char_length(v_key_id) NOT BETWEEN 1 AND 128
		OR v_binding_hash !~ '^[a-f0-9]{64}$'
		OR p_envelope ->> 'ciphertext' !~ '^[A-Za-z0-9_-]+$'
		OR pg_catalog.char_length(p_envelope ->> 'ciphertext')
			NOT BETWEEN 64 AND 16384
		OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_envelope)) <> 5
	THEN
		RETURN;
	END IF;
	v_operation_id := 'invitation:' || p_invitation_id::text;
	IF p_operation_id IS DISTINCT FROM v_operation_id THEN
		RETURN;
	END IF;
	v_canonical_payload := '{"deliverySecretId":'
		|| pg_catalog.to_jsonb(p_delivery_secret_id::text)::text
		|| ',"invitationId":'
		|| pg_catalog.to_jsonb(p_invitation_id::text)::text
		|| ',"operationId":'
		|| pg_catalog.to_jsonb(v_operation_id)::text
		|| ',"origin":"deterministic-worker","schemaVersion":1}';
	v_expected_payload_hash := pg_catalog.encode(
		pg_catalog.sha256(
			pg_catalog.convert_to('emdo.invitation.delivery.v1', 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(v_canonical_payload, 'UTF8')
		),
		'hex'
	);
	IF p_payload_hash IS DISTINCT FROM v_expected_payload_hash THEN
		RETURN;
	END IF;
	v_payload := pg_catalog.jsonb_build_object(
		'schemaVersion', 1,
		'origin', 'deterministic-worker',
		'operationId', v_operation_id,
		'invitationId', p_invitation_id::text,
		'deliverySecretId', p_delivery_secret_id::text
	);

	SELECT * INTO v_scope FROM emdo.claim_household_owner_scope();
	IF NOT FOUND THEN
		RETURN;
	END IF;
	PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
		v_scope.actor_user_id::text || ':' || v_scope.actor_session_id::text
			|| ':issue-invitation:' || p_idempotency_key,
		0
	));
	SELECT command.* INTO v_command
	FROM emdo.household_administration_commands AS command
	WHERE command.household_id = v_scope.household_id
		AND command.actor_user_id = v_scope.actor_user_id
		AND command.actor_session_id = v_scope.actor_session_id
		AND command.command_kind = 'issue-invitation'
		AND command.idempotency_key = p_idempotency_key
	FOR UPDATE;
	IF FOUND THEN
		IF v_command.request_hash IS DISTINCT FROM p_request_hash THEN
			RETURN;
		END IF;
		IF pg_catalog.jsonb_typeof(v_command.result) IS DISTINCT FROM 'object'
			OR (SELECT pg_catalog.count(*)
				FROM pg_catalog.jsonb_object_keys(v_command.result)) <> 9
			OR v_command.result ->> 'householdId'
				IS DISTINCT FROM v_scope.household_id::text
			OR v_command.result ->> 'state' IS DISTINCT FROM 'pending'
			OR v_command.result ->> 'deliveryQueued' IS DISTINCT FROM 'true'
		THEN
			RETURN;
		END IF;
		RETURN QUERY SELECT 1,
			(v_command.result ->> 'invitationId')::uuid,
			(v_command.result ->> 'householdId')::uuid,
			v_command.result ->> 'email',
			v_command.result ->> 'role',
			v_command.result ->> 'state',
			(v_command.result ->> 'version')::integer,
			(v_command.result ->> 'createdAt')::timestamptz,
			(v_command.result ->> 'expiresAt')::timestamptz,
			true,
			(v_command.result ->> 'deliveryQueued')::boolean;
		RETURN;
	END IF;

	v_now := pg_catalog.clock_timestamp();
	INSERT INTO emdo.invitations (
		id, household_id, invited_by_user_id, email, role, token_hash,
		created_at, expires_at, administration_version
	) VALUES (
		p_invitation_id, v_scope.household_id, v_scope.actor_user_id,
		v_email, p_role, p_token_hash, v_now,
		v_now + pg_catalog.make_interval(secs => p_expires_in_seconds), 1
	)
	RETURNING * INTO v_invitation;

	INSERT INTO emdo.invitation_delivery_secrets (
		id, invitation_id, household_id, recipient, role, token_hash,
		template_version, algorithm, key_id, binding_hash, envelope, state,
		operation_id, created_at, expires_at
	) VALUES (
		p_delivery_secret_id, p_invitation_id, v_scope.household_id,
		v_email, p_role, p_token_hash, p_template_version, v_algorithm,
		v_key_id, v_binding_hash, p_envelope, 'pending', v_operation_id,
		v_now, v_invitation.expires_at
	);

	INSERT INTO emdo.worker_operation_outbox (
		household_id, space_id, original_owner_user_id, request_id,
		job_name, operation_id, target_type, target_id, target_revision,
		payload, payload_hash, state, available_at, created_at, updated_at,
		retain_until
	) VALUES (
		v_scope.household_id, v_scope.actor_private_space_id,
		v_scope.actor_user_id, emdo.current_request_id(),
		'emdo.invitation.delivery.v1', v_operation_id, 'invitation',
		p_invitation_id::text, 1, v_payload, p_payload_hash, 'pending',
		v_now, v_now, v_now, v_now + interval '30 days'
	)
	ON CONFLICT (job_name, operation_id) DO NOTHING;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = '40001',
			MESSAGE = 'EMDO:administration-conflict';
	END IF;

	INSERT INTO emdo.household_administration_commands (
		household_id, actor_user_id, actor_session_id, command_kind,
		idempotency_key, request_hash, target_id, result, created_at
	) VALUES (
		v_scope.household_id, v_scope.actor_user_id,
		v_scope.actor_session_id, 'issue-invitation', p_idempotency_key,
		p_request_hash, p_invitation_id,
		pg_catalog.jsonb_build_object(
			'invitationId', v_invitation.id::text,
			'householdId', v_invitation.household_id::text,
			'email', v_invitation.email,
			'role', v_invitation.role,
			'state', 'pending',
			'version', v_invitation.administration_version,
			'createdAt', v_invitation.created_at,
			'expiresAt', v_invitation.expires_at,
			'deliveryQueued', true
		),
		v_now
	);

	RETURN QUERY SELECT 1, v_invitation.id, v_invitation.household_id,
		v_invitation.email, v_invitation.role, 'pending'::text,
		v_invitation.administration_version, v_invitation.created_at,
		v_invitation.expires_at, false, true;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.is_safe_invitation_redemption_result(
	p_result jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path = pg_catalog
AS $function$
	SELECT CASE
		WHEN pg_catalog.jsonb_typeof(p_result) IS DISTINCT FROM 'object'
			OR pg_catalog.octet_length(p_result::text) NOT BETWEEN 2 AND 1024
		THEN false
		ELSE (
			SELECT pg_catalog.count(*) = 5
			FROM pg_catalog.jsonb_object_keys(p_result)
		)
			AND pg_catalog.jsonb_typeof(p_result -> 'schemaVersion') = 'number'
			AND p_result ->> 'schemaVersion' = '1'
			AND pg_catalog.jsonb_typeof(p_result -> 'userId') = 'string'
			AND p_result ->> 'userId'
				~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
			AND pg_catalog.jsonb_typeof(p_result -> 'householdId') = 'string'
			AND p_result ->> 'householdId'
				~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
			AND pg_catalog.jsonb_typeof(p_result -> 'role') = 'string'
			AND p_result ->> 'role' IN ('owner', 'member')
			AND p_result -> 'emailVerified' = 'true'::jsonb
	END
$function$;
REVOKE ALL ON FUNCTION emdo.is_safe_invitation_redemption_result(jsonb)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_onboarding, emdo_onboarding_executor;
--> statement-breakpoint
CREATE TABLE emdo.invitation_redemption_commands (
	idempotency_key text PRIMARY KEY NOT NULL,
	request_hash text NOT NULL,
	origin_request_id uuid NOT NULL,
	invitation_id uuid NOT NULL,
	result jsonb NOT NULL,
	completed_at timestamptz NOT NULL,
	retain_until timestamptz NOT NULL,
	CONSTRAINT invitation_redemption_commands_origin_request_unique
		UNIQUE (origin_request_id),
	CONSTRAINT invitation_redemption_commands_invitation_fk
		FOREIGN KEY (invitation_id) REFERENCES emdo.invitations(id)
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT invitation_redemption_commands_idempotency_check CHECK (
		idempotency_key ~ '^[A-Za-z0-9:._-]{16,200}$'
	),
	CONSTRAINT invitation_redemption_commands_request_hash_check CHECK (
		request_hash ~ '^[a-f0-9]{64}$'
	),
	CONSTRAINT invitation_redemption_commands_result_check CHECK (
		emdo.is_safe_invitation_redemption_result(result)
	),
	CONSTRAINT invitation_redemption_commands_retention_check CHECK (
		retain_until > completed_at
		AND retain_until <= completed_at + interval '90 days'
	)
);
CREATE INDEX invitation_redemption_commands_retention_idx
	ON emdo.invitation_redemption_commands(retain_until);
ALTER TABLE emdo.invitation_redemption_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.invitation_redemption_commands FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invitation_redemption_commands_executor_select
	ON emdo.invitation_redemption_commands
	FOR SELECT TO emdo_onboarding_executor USING (true);
CREATE POLICY invitation_redemption_commands_executor_insert
	ON emdo.invitation_redemption_commands
	FOR INSERT TO emdo_onboarding_executor WITH CHECK (true);
CREATE POLICY memberships_onboarding_issuer_read
	ON emdo.household_memberships
	FOR SELECT TO emdo_onboarding_executor
	USING (role = 'owner' AND status = 'active' AND ended_at IS NULL);
CREATE POLICY memberships_onboarding_issuer_lock
	ON emdo.household_memberships
	FOR UPDATE TO emdo_onboarding_executor
	USING (role = 'owner' AND status = 'active' AND ended_at IS NULL)
	WITH CHECK (role = 'owner' AND status = 'active' AND ended_at IS NULL);
GRANT SELECT (id, household_id, invited_by_user_id, email, role, token_hash,
	expires_at, consumed_at, revoked_at, administration_version)
	ON emdo.invitations TO emdo_onboarding_executor;
GRANT SELECT (id, household_id, user_id, role, status,
	administration_version, ended_at)
	ON emdo.household_memberships TO emdo_onboarding_executor;
GRANT UPDATE (household_id)
	ON emdo.household_memberships TO emdo_onboarding_executor;
GRANT SELECT, INSERT ON emdo.invitation_redemption_commands
	TO emdo_onboarding_executor;
GRANT EXECUTE ON FUNCTION emdo.provision_invited_account(
	uuid, text, text, text, text
) TO emdo_onboarding_executor;
REVOKE ALL ON FUNCTION emdo.provision_invited_account(
	uuid, text, text, text, text
) FROM emdo_onboarding;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.redeem_household_invitation(
	p_schema_version integer,
	p_invitation_id uuid,
	p_invitation_token_hash text,
	p_email text,
	p_display_name text,
	p_password_hash text,
	p_idempotency_key text,
	p_request_id uuid
)
RETURNS TABLE(status text, result jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_authority record;
	v_command emdo.invitation_redemption_commands%ROWTYPE;
	v_provisioned record;
	v_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
	v_name text := pg_catalog.btrim(p_display_name);
	v_canonical_request text;
	v_request_hash text;
	v_result jsonb;
	v_now timestamptz;
BEGIN
	IF p_schema_version IS DISTINCT FROM 1
		OR p_invitation_id IS NULL
		OR p_invitation_token_hash IS NULL
		OR p_invitation_token_hash !~ '^[a-f0-9]{64}$'
		OR v_email IS NULL
		OR pg_catalog.char_length(v_email) NOT BETWEEN 3 AND 320
		OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
		OR v_name IS NULL
		OR pg_catalog.char_length(v_name) NOT BETWEEN 1 AND 100
		OR p_password_hash IS NULL
		OR p_password_hash !~ '^[a-f0-9]{32}:[a-f0-9]{128}$'
		OR p_idempotency_key IS NULL
		OR p_idempotency_key !~ '^[A-Za-z0-9:._-]{16,200}$'
		OR p_request_id IS NULL
	THEN
		RETURN QUERY SELECT 'invalid'::text, NULL::jsonb;
		RETURN;
	END IF;

	v_canonical_request := '{"displayName":'
		|| pg_catalog.to_jsonb(v_name)::text
		|| ',"email":' || pg_catalog.to_jsonb(v_email)::text
		|| ',"invitationId":'
		|| pg_catalog.to_jsonb(p_invitation_id::text)::text
		|| ',"invitationTokenHash":'
		|| pg_catalog.to_jsonb(p_invitation_token_hash)::text
		|| ',"passwordHash":'
		|| pg_catalog.to_jsonb(p_password_hash)::text
		|| ',"schemaVersion":1}';
	v_request_hash := pg_catalog.encode(
		pg_catalog.sha256(
			pg_catalog.convert_to(
				'emdo.invitation-redemption-request.v1', 'UTF8'
			)
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(v_canonical_request, 'UTF8')
		),
		'hex'
	);

	PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
		'emdo.invitation-redemption-request:' || p_request_id::text, 0
	));
	PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
		'emdo.invitation-redemption-idempotency:' || p_idempotency_key, 0
	));
	SELECT command.* INTO v_command
	FROM emdo.invitation_redemption_commands AS command
	WHERE command.idempotency_key = p_idempotency_key;
	IF FOUND THEN
		IF v_command.request_hash IS DISTINCT FROM v_request_hash
			OR v_command.invitation_id IS DISTINCT FROM p_invitation_id
			OR v_command.origin_request_id IS DISTINCT FROM p_request_id
		THEN
			RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
			RETURN;
		END IF;
		IF NOT emdo.is_safe_invitation_redemption_result(v_command.result) THEN
			RAISE EXCEPTION USING ERRCODE = 'P0001',
				MESSAGE = 'invitation redemption receipt invalid';
		END IF;
		RETURN QUERY SELECT 'replay'::text, v_command.result;
		RETURN;
	END IF;
	PERFORM 1
	FROM emdo.invitation_redemption_commands AS command
	WHERE command.origin_request_id = p_request_id;
	IF FOUND THEN
		RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
		RETURN;
	END IF;

	SELECT invitation.id AS invitation_id,
		invitation.administration_version AS invitation_version,
		issuer.id AS issuer_membership_id,
		issuer.administration_version AS issuer_membership_version
	INTO v_authority
	FROM emdo.invitations AS invitation
	JOIN emdo.household_memberships AS issuer
		ON issuer.household_id = invitation.household_id
		AND issuer.user_id = invitation.invited_by_user_id
	WHERE invitation.id = p_invitation_id
		AND invitation.token_hash = p_invitation_token_hash
		AND invitation.email = v_email
		AND invitation.consumed_at IS NULL
		AND invitation.revoked_at IS NULL
		AND invitation.expires_at > pg_catalog.clock_timestamp()
		AND invitation.administration_version > 0
		AND issuer.role = 'owner'
		AND issuer.status = 'active'
		AND issuer.ended_at IS NULL
		AND issuer.administration_version > 0
	FOR UPDATE OF invitation
	FOR SHARE OF issuer;
	IF NOT FOUND THEN
		RETURN QUERY SELECT 'invalid'::text, NULL::jsonb;
		RETURN;
	END IF;

	SELECT provisioned.* INTO v_provisioned
	FROM emdo.provision_invited_account(
		p_invitation_id,
		p_invitation_token_hash,
		v_email,
		v_name,
		p_password_hash
	) AS provisioned;
	IF NOT FOUND
		OR v_provisioned.status IS DISTINCT FROM 'provisioned'
		OR v_provisioned.email IS DISTINCT FROM v_email
		OR v_provisioned.email_verified IS DISTINCT FROM true
		OR v_provisioned.user_id IS NULL
		OR v_provisioned.household_id IS NULL
		OR v_provisioned.role NOT IN ('owner', 'member')
	THEN
		RETURN QUERY SELECT 'invalid'::text, NULL::jsonb;
		RETURN;
	END IF;
	v_result := pg_catalog.jsonb_build_object(
		'schemaVersion', 1,
		'userId', v_provisioned.user_id::text,
		'householdId', v_provisioned.household_id::text,
		'role', v_provisioned.role,
		'emailVerified', true
	);
	IF NOT emdo.is_safe_invitation_redemption_result(v_result) THEN
		RAISE EXCEPTION USING ERRCODE = 'P0001',
			MESSAGE = 'invitation redemption result invalid';
	END IF;
	v_now := pg_catalog.clock_timestamp();
	INSERT INTO emdo.invitation_redemption_commands(
		idempotency_key, request_hash, origin_request_id, invitation_id,
		result, completed_at, retain_until
	) VALUES (
		p_idempotency_key, v_request_hash, p_request_id, p_invitation_id,
		v_result, v_now, v_now + interval '90 days'
	);
	RETURN QUERY SELECT 'provisioned'::text, v_result;
END
$function$;
REVOKE ALL ON FUNCTION emdo.redeem_household_invitation(
	integer, uuid, text, text, text, text, text, uuid
) FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_onboarding, emdo_onboarding_executor;
GRANT CREATE ON SCHEMA emdo TO emdo_onboarding_executor;
ALTER FUNCTION emdo.is_safe_invitation_redemption_result(jsonb)
	OWNER TO emdo_onboarding_executor;
ALTER FUNCTION emdo.redeem_household_invitation(
	integer, uuid, text, text, text, text, text, uuid
) OWNER TO emdo_onboarding_executor;
REVOKE CREATE ON SCHEMA emdo FROM emdo_onboarding_executor;
REVOKE ALL ON FUNCTION emdo.is_safe_invitation_redemption_result(jsonb)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_onboarding, emdo_onboarding_executor;
GRANT EXECUTE ON FUNCTION emdo.is_safe_invitation_redemption_result(jsonb)
	TO emdo_onboarding_executor;
REVOKE ALL ON FUNCTION emdo.redeem_household_invitation(
	integer, uuid, text, text, text, text, text, uuid
) FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_onboarding, emdo_onboarding_executor;
GRANT EXECUTE ON FUNCTION emdo.redeem_household_invitation(
	integer, uuid, text, text, text, text, text, uuid
) TO emdo_onboarding;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.invitation_redemption_ready()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
BEGIN
	RETURN current_user = 'emdo_onboarding_executor'
		AND pg_catalog.has_function_privilege(
			session_user,
			'emdo.redeem_household_invitation(integer,uuid,text,text,text,text,text,uuid)',
			'EXECUTE'
		)
		AND NOT pg_catalog.has_function_privilege(
			session_user,
			'emdo.provision_invited_account(uuid,text,text,text,text)',
			'EXECUTE'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.invitation_redemption_commands', 'SELECT'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.invitation_redemption_commands', 'INSERT'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.invitations', 'SELECT'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.auth_users', 'INSERT'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.auth_accounts', 'INSERT'
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_roles AS executor
			WHERE executor.rolname = 'emdo_onboarding_executor'
				AND NOT executor.rolcanlogin
				AND NOT executor.rolinherit
				AND NOT executor.rolsuper
				AND NOT executor.rolbypassrls
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_auth_members AS membership
			JOIN pg_catalog.pg_roles AS parent
				ON parent.oid = membership.roleid
			JOIN pg_catalog.pg_roles AS child
				ON child.oid = membership.member
			WHERE parent.rolname = 'emdo_onboarding_executor'
				OR child.rolname = 'emdo_onboarding_executor'
		);
EXCEPTION WHEN OTHERS THEN
	RETURN false;
END
$function$;
REVOKE ALL ON FUNCTION emdo.invitation_redemption_ready()
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_onboarding, emdo_onboarding_executor;
GRANT CREATE ON SCHEMA emdo TO emdo_onboarding_executor;
ALTER FUNCTION emdo.invitation_redemption_ready()
	OWNER TO emdo_onboarding_executor;
REVOKE CREATE ON SCHEMA emdo FROM emdo_onboarding_executor;
REVOKE ALL ON FUNCTION emdo.invitation_redemption_ready()
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_onboarding, emdo_onboarding_executor;
GRANT EXECUTE ON FUNCTION emdo.invitation_redemption_ready()
	TO emdo_onboarding;
--> statement-breakpoint
ALTER TABLE emdo.worker_operation_outbox
	DROP CONSTRAINT worker_operation_outbox_job_check;
ALTER TABLE emdo.worker_operation_outbox
	ADD CONSTRAINT worker_operation_outbox_job_check CHECK (
		job_name IN (
			'emdo.reminder.delivery.v1', 'emdo.calendar.sync.v1',
			'emdo.calendar.retry.v1', 'emdo.calendar.reconciliation.v1',
			'emdo.notification.delivery.v1', 'emdo.invitation.delivery.v1'
		)
	);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.worker_outbox_binding_is_valid(
	p_job_name text,
	p_operation_id text,
	p_target_type text,
	p_target_id text,
	p_target_revision integer,
	p_related_operation_id text,
	p_retry_sequence integer,
	p_payload jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, emdo
RETURN
	p_operation_id ~ '^[A-Za-z0-9:._-]{16,200}$'
	AND pg_catalog.btrim(p_target_id) = p_target_id
	AND pg_catalog.length(p_target_id) BETWEEN 1 AND 512
	AND p_target_id !~ '[[:cntrl:]]'
	AND pg_catalog.jsonb_typeof(p_payload) = 'object'
	AND p_payload ->> 'operationId' = p_operation_id
	AND p_payload ->> 'origin' = 'deterministic-worker'
	AND p_payload ->> 'schemaVersion' = '1'
	AND CASE p_job_name
		WHEN 'emdo.reminder.delivery.v1' THEN
			p_target_type = 'reminder'
			AND p_target_id = p_payload ->> 'reminderId'
			AND p_target_revision IS NOT NULL
			AND p_target_revision > 0
			AND p_payload ->> 'dueRevision' ~ '^[1-9][0-9]*$'
			AND (p_payload ->> 'dueRevision')::bigint = p_target_revision
			AND p_related_operation_id IS NULL
			AND p_retry_sequence IS NULL
		WHEN 'emdo.calendar.sync.v1' THEN
			p_target_type = 'calendar-connection'
			AND p_target_id = p_payload ->> 'connectionId'
			AND p_target_revision IS NOT NULL
			AND p_target_revision >= 0
			AND p_payload ->> 'syncGeneration' ~ '^[0-9]+$'
			AND (p_payload ->> 'syncGeneration')::bigint = p_target_revision
			AND p_related_operation_id IS NULL
			AND p_retry_sequence IS NULL
		WHEN 'emdo.calendar.retry.v1' THEN
			p_target_type = 'calendar-connection'
			AND p_target_id = p_payload ->> 'connectionId'
			AND p_target_revision IS NULL
			AND p_related_operation_id = p_payload ->> 'failedOperationId'
			AND p_related_operation_id ~ '^[A-Za-z0-9:._-]{16,200}$'
			AND p_retry_sequence BETWEEN 1 AND 20
			AND p_payload ->> 'retrySequence' ~ '^[1-9][0-9]*$'
			AND (p_payload ->> 'retrySequence')::bigint = p_retry_sequence
		WHEN 'emdo.calendar.reconciliation.v1' THEN
			p_target_type = 'provider-attempt'
			AND p_target_id = p_payload ->> 'providerAttemptId'
			AND p_target_revision IS NULL
			AND p_related_operation_id IS NULL
			AND p_retry_sequence IS NULL
		WHEN 'emdo.notification.delivery.v1' THEN
			p_target_type = 'notification'
			AND p_target_id = p_payload ->> 'notificationId'
			AND p_target_revision IS NOT NULL
			AND p_target_revision > 0
			AND p_related_operation_id IS NULL
			AND p_retry_sequence IS NULL
		WHEN 'emdo.invitation.delivery.v1' THEN
			p_operation_id = 'invitation:' || p_target_id
			AND p_target_type = 'invitation'
			AND p_target_id = p_payload ->> 'invitationId'
			AND p_target_id ~ '^[a-f0-9-]{36}$'
			AND p_payload ->> 'deliverySecretId' ~ '^[a-f0-9-]{36}$'
			AND p_target_revision = 1
			AND p_related_operation_id IS NULL
			AND p_retry_sequence IS NULL
			AND (
				SELECT pg_catalog.count(*)
				FROM pg_catalog.jsonb_object_keys(p_payload)
			) = 5
		ELSE false
	END;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.acquire_worker_job_execution(
	p_job_name text,
	p_operation_id text,
	p_queue_job_id uuid,
	p_payload_hash text
)
RETURNS TABLE (
	status text,
	job_name text,
	operation_id text,
	queue_job_id uuid,
	payload_hash text,
	lease_token uuid,
	lease_expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_now timestamptz := pg_catalog.clock_timestamp();
	v_outbox emdo.worker_operation_outbox%ROWTYPE;
	v_execution emdo.worker_job_executions%ROWTYPE;
	v_lease_token uuid;
	v_lease_expires_at timestamptz;
BEGIN
	IF p_job_name NOT IN (
		'emdo.reminder.delivery.v1', 'emdo.calendar.sync.v1',
		'emdo.calendar.retry.v1', 'emdo.calendar.reconciliation.v1',
		'emdo.notification.delivery.v1', 'emdo.invitation.delivery.v1'
	) OR p_operation_id !~ '^[A-Za-z0-9:._-]{16,200}$'
		OR p_queue_job_id IS NULL
		OR p_payload_hash !~ '^[a-f0-9]{64}$'
	THEN
		RETURN;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(p_job_name || ':' || p_operation_id, 0)
	);
	SELECT outbox.* INTO v_outbox
	FROM emdo.worker_operation_outbox AS outbox
	JOIN emdo.auth_users AS account_user
		ON account_user.id = outbox.original_owner_user_id
	JOIN emdo.household_memberships AS membership
		ON membership.household_id = outbox.household_id
		AND membership.user_id = outbox.original_owner_user_id
	JOIN emdo.spaces AS space
		ON space.household_id = outbox.household_id
		AND space.id = outbox.space_id
	WHERE outbox.job_name = p_job_name
		AND outbox.operation_id = p_operation_id
		AND outbox.queue_job_id = p_queue_job_id
		AND outbox.payload_hash = p_payload_hash
		AND outbox.state IN ('leased', 'enqueued', 'completed', 'quarantined')
		AND account_user.email_verified = true
		AND membership.status = 'active'
		AND space.tombstoned_at IS NULL
		AND (space.visibility = 'shared'
			OR space.original_owner_user_id = outbox.original_owner_user_id)
		AND emdo.worker_outbox_binding_is_valid(
			outbox.job_name, outbox.operation_id, outbox.target_type,
			outbox.target_id, outbox.target_revision,
			outbox.related_operation_id, outbox.retry_sequence, outbox.payload
		)
	FOR SHARE OF account_user, membership, space
	FOR UPDATE OF outbox;
	IF NOT FOUND THEN
		RETURN;
	END IF;

	SELECT execution.* INTO v_execution
	FROM emdo.worker_job_executions AS execution
	WHERE execution.job_name = p_job_name
		AND execution.operation_id = p_operation_id
	FOR UPDATE;
	IF FOUND THEN
		IF v_execution.outbox_id <> v_outbox.outbox_id
			OR v_execution.job_id <> p_queue_job_id
			OR v_execution.payload_hash <> p_payload_hash
		THEN
			RETURN;
		END IF;
		IF v_outbox.state = 'quarantined'
			AND v_outbox.safe_code = 'attempt-exhausted'
		THEN
			RETURN QUERY SELECT 'exhausted'::text, p_job_name, p_operation_id,
				p_queue_job_id, p_payload_hash, NULL::uuid, NULL::timestamptz;
			RETURN;
		END IF;
		IF v_execution.state IN ('completed', 'indeterminate') THEN
			RETURN QUERY SELECT 'duplicate'::text, p_job_name, p_operation_id,
				p_queue_job_id, p_payload_hash, NULL::uuid, NULL::timestamptz;
			RETURN;
		END IF;
		IF v_execution.state = 'leased' THEN
			IF v_execution.lease_expires_at > v_now THEN
				RETURN;
			END IF;
			UPDATE emdo.worker_job_executions
			SET state = 'indeterminate', completed_at = v_now, updated_at = v_now
			WHERE execution_id = v_execution.execution_id;
			UPDATE emdo.worker_operation_outbox
			SET state = 'quarantined', safe_code = 'execution-indeterminate',
				completed_at = v_now, updated_at = v_now
			WHERE outbox_id = v_outbox.outbox_id
				AND state IN ('leased', 'enqueued');
			RETURN QUERY SELECT 'duplicate'::text, p_job_name, p_operation_id,
				p_queue_job_id, p_payload_hash, NULL::uuid, NULL::timestamptz;
			RETURN;
		END IF;
		IF v_execution.attempt_count >= 5 THEN
			UPDATE emdo.worker_operation_outbox
			SET state = 'quarantined', safe_code = 'attempt-exhausted',
				completed_at = v_now, updated_at = v_now
			WHERE outbox_id = v_outbox.outbox_id
				AND state IN ('leased', 'enqueued');
			RETURN QUERY SELECT 'exhausted'::text, p_job_name, p_operation_id,
				p_queue_job_id, p_payload_hash, NULL::uuid, NULL::timestamptz;
			RETURN;
		END IF;
		v_lease_token := pg_catalog.gen_random_uuid();
		v_lease_expires_at := v_now + interval '5 minutes';
		UPDATE emdo.worker_job_executions
		SET state = 'leased', lease_token = v_lease_token,
			lease_expires_at = v_lease_expires_at,
			attempt_count = attempt_count + 1, completed_at = NULL,
			updated_at = v_now
		WHERE execution_id = v_execution.execution_id;
	ELSE
		v_lease_token := pg_catalog.gen_random_uuid();
		v_lease_expires_at := v_now + interval '5 minutes';
		INSERT INTO emdo.worker_job_executions (
			outbox_id, household_id, space_id, original_owner_user_id,
			job_id, job_name, operation_id, payload_hash, state,
			attempt_count, lease_token, lease_expires_at, started_at,
			updated_at, retain_until
		) VALUES (
			v_outbox.outbox_id, v_outbox.household_id, v_outbox.space_id,
			v_outbox.original_owner_user_id, p_queue_job_id, p_job_name,
			p_operation_id, p_payload_hash, 'leased', 1, v_lease_token,
			v_lease_expires_at, v_now, v_now, v_now + interval '90 days'
		);
	END IF;
	RETURN QUERY SELECT 'acquired'::text, p_job_name, p_operation_id,
		p_queue_job_id, p_payload_hash, v_lease_token, v_lease_expires_at;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.claim_worker_operation_scope(
	p_job_name text,
	p_operation_id text,
	p_queue_job_id uuid,
	p_payload_hash text,
	p_execution_lease_token uuid,
	p_target_type text DEFAULT NULL,
	p_target_id text DEFAULT NULL,
	p_target_revision integer DEFAULT NULL,
	p_related_operation_id text DEFAULT NULL,
	p_retry_sequence integer DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_outbox emdo.worker_operation_outbox%ROWTYPE;
BEGIN
	IF p_job_name NOT IN (
		'emdo.reminder.delivery.v1', 'emdo.calendar.sync.v1',
		'emdo.calendar.retry.v1', 'emdo.calendar.reconciliation.v1',
		'emdo.notification.delivery.v1', 'emdo.invitation.delivery.v1'
	) OR p_operation_id !~ '^[A-Za-z0-9:._-]{16,200}$'
		OR p_queue_job_id IS NULL OR p_execution_lease_token IS NULL
		OR p_payload_hash !~ '^[a-f0-9]{64}$'
	THEN
		RETURN false;
	END IF;
	SELECT outbox.* INTO v_outbox
	FROM emdo.worker_operation_outbox AS outbox
	JOIN emdo.worker_job_executions AS execution
		ON execution.outbox_id = outbox.outbox_id
		AND execution.job_name = outbox.job_name
		AND execution.operation_id = outbox.operation_id
		AND execution.payload_hash = outbox.payload_hash
	JOIN emdo.auth_users AS account_user
		ON account_user.id = outbox.original_owner_user_id
	JOIN emdo.household_memberships AS membership
		ON membership.household_id = outbox.household_id
		AND membership.user_id = outbox.original_owner_user_id
	JOIN emdo.spaces AS space
		ON space.household_id = outbox.household_id
		AND space.id = outbox.space_id
	WHERE outbox.job_name = p_job_name
		AND outbox.operation_id = p_operation_id
		AND outbox.state IN ('leased', 'enqueued')
		AND outbox.queue_job_id = p_queue_job_id
		AND outbox.payload_hash = p_payload_hash
		AND execution.job_id = p_queue_job_id
		AND execution.state = 'leased'
		AND execution.lease_token = p_execution_lease_token
		AND execution.lease_expires_at > pg_catalog.clock_timestamp()
		AND (p_target_type IS NULL OR outbox.target_type = p_target_type)
		AND (p_target_id IS NULL OR outbox.target_id = p_target_id)
		AND (p_target_revision IS NULL OR outbox.target_revision = p_target_revision)
		AND (p_related_operation_id IS NULL
			OR outbox.related_operation_id = p_related_operation_id)
		AND (p_retry_sequence IS NULL OR outbox.retry_sequence = p_retry_sequence)
		AND account_user.email_verified = true
		AND membership.status = 'active'
		AND space.tombstoned_at IS NULL
		AND (space.visibility = 'shared'
			OR space.original_owner_user_id = outbox.original_owner_user_id)
		AND emdo.worker_outbox_binding_is_valid(
			outbox.job_name, outbox.operation_id, outbox.target_type,
			outbox.target_id, outbox.target_revision,
			outbox.related_operation_id, outbox.retry_sequence, outbox.payload
		)
	FOR SHARE OF account_user, membership, space, outbox, execution;
	IF NOT FOUND THEN
		RETURN false;
	END IF;
	PERFORM pg_catalog.set_config(
		'emdo.user_id', v_outbox.original_owner_user_id::text, true
	);
	PERFORM pg_catalog.set_config('emdo.request_id', v_outbox.request_id::text, true);
	PERFORM pg_catalog.set_config('emdo.worker_job_name', v_outbox.job_name, true);
	PERFORM pg_catalog.set_config(
		'emdo.worker_operation_id', v_outbox.operation_id, true
	);
	PERFORM pg_catalog.set_config(
		'emdo.worker_queue_job_id', p_queue_job_id::text, true
	);
	PERFORM pg_catalog.set_config('emdo.worker_payload_hash', p_payload_hash, true);
	PERFORM pg_catalog.set_config(
		'emdo.worker_execution_lease_token', p_execution_lease_token::text, true
	);
	PERFORM pg_catalog.set_config(
		'emdo.worker_target_type', v_outbox.target_type, true
	);
	PERFORM pg_catalog.set_config(
		'emdo.worker_target_id', v_outbox.target_id, true
	);
	PERFORM pg_catalog.set_config(
		'emdo.worker_target_revision',
		COALESCE(v_outbox.target_revision::text, ''), true
	);
	PERFORM pg_catalog.set_config(
		'emdo.worker_retry_sequence',
		COALESCE(v_outbox.retry_sequence::text, ''), true
	);
	RETURN true;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.list_household_invitations()
RETURNS TABLE (
	schema_version integer,
	invitation_id uuid,
	household_id uuid,
	email text,
	role text,
	state text,
	version integer,
	created_at timestamptz,
	expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_scope record;
BEGIN
	SELECT * INTO v_scope FROM emdo.claim_household_owner_scope();
	IF NOT FOUND THEN
		RETURN;
	END IF;
	RETURN QUERY
	SELECT 1, invitation.id, invitation.household_id, invitation.email,
		invitation.role,
		CASE
			WHEN invitation.consumed_at IS NOT NULL THEN 'consumed'
			WHEN invitation.revoked_at IS NOT NULL THEN 'revoked'
			WHEN invitation.expires_at <= pg_catalog.clock_timestamp()
				THEN 'expired'
			ELSE 'pending'
		END,
		invitation.administration_version, invitation.created_at,
		invitation.expires_at
	FROM emdo.invitations AS invitation
	WHERE invitation.household_id = v_scope.household_id
	ORDER BY invitation.created_at DESC, invitation.id DESC;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.revoke_household_invitation(
	p_invitation_id uuid,
	p_expected_version integer,
	p_idempotency_key text,
	p_request_hash text
)
RETURNS TABLE (
	schema_version integer,
	invitation_id uuid,
	household_id uuid,
	email text,
	role text,
	state text,
	version integer,
	created_at timestamptz,
	expires_at timestamptz,
	replayed boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_scope record;
	v_command record;
	v_invitation emdo.invitations%ROWTYPE;
	v_now timestamptz;
BEGIN
	IF p_invitation_id IS NULL OR p_expected_version < 1
		OR p_idempotency_key !~ '^[A-Za-z0-9:._-]{16,200}$'
		OR p_request_hash !~ '^[a-f0-9]{64}$'
	THEN
		RETURN;
	END IF;
	SELECT * INTO v_scope FROM emdo.claim_household_owner_scope();
	IF NOT FOUND THEN RETURN; END IF;
	PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
		v_scope.actor_user_id::text || ':' || v_scope.actor_session_id::text
			|| ':revoke-invitation:' || p_idempotency_key,
		0
	));
	SELECT command.* INTO v_command
	FROM emdo.household_administration_commands AS command
	WHERE command.household_id = v_scope.household_id
		AND command.actor_user_id = v_scope.actor_user_id
		AND command.actor_session_id = v_scope.actor_session_id
		AND command.command_kind = 'revoke-invitation'
		AND command.idempotency_key = p_idempotency_key
	FOR UPDATE;
	IF FOUND THEN
		IF v_command.request_hash IS DISTINCT FROM p_request_hash
			OR v_command.target_id IS DISTINCT FROM p_invitation_id
		THEN RETURN; END IF;
		SELECT stored.* INTO v_invitation
		FROM emdo.invitations AS stored
		WHERE stored.id = p_invitation_id
			AND stored.household_id = v_scope.household_id
			AND stored.revoked_at IS NOT NULL
		FOR SHARE;
		IF NOT FOUND THEN RETURN; END IF;
		RETURN QUERY SELECT 1, v_invitation.id, v_invitation.household_id,
			v_invitation.email, v_invitation.role, 'revoked'::text,
			v_invitation.administration_version, v_invitation.created_at,
			v_invitation.expires_at, true;
		RETURN;
	END IF;
	v_now := pg_catalog.clock_timestamp();
	UPDATE emdo.invitations AS invitation
	SET revoked_at = v_now
	WHERE invitation.id = p_invitation_id
		AND invitation.household_id = v_scope.household_id
		AND invitation.administration_version = p_expected_version
		AND invitation.consumed_at IS NULL
		AND invitation.revoked_at IS NULL
	RETURNING invitation.* INTO v_invitation;
	IF NOT FOUND THEN RETURN; END IF;
	INSERT INTO emdo.household_administration_commands (
		household_id, actor_user_id, actor_session_id, command_kind,
		idempotency_key, request_hash, target_id, result, created_at
	) VALUES (
		v_scope.household_id, v_scope.actor_user_id,
		v_scope.actor_session_id, 'revoke-invitation', p_idempotency_key,
		p_request_hash, p_invitation_id,
		pg_catalog.jsonb_build_object('invitationId', p_invitation_id::text),
		v_now
	);
	RETURN QUERY SELECT 1, v_invitation.id, v_invitation.household_id,
		v_invitation.email, v_invitation.role, 'revoked'::text,
		v_invitation.administration_version, v_invitation.created_at,
		v_invitation.expires_at, false;
END
$function$;
--> statement-breakpoint
CREATE TABLE emdo.household_administration_commands (
	id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	household_id uuid NOT NULL,
	actor_user_id uuid NOT NULL,
	actor_session_id uuid NOT NULL,
	command_kind text NOT NULL,
	idempotency_key text NOT NULL,
	request_hash text NOT NULL,
	target_id uuid NOT NULL,
	result jsonb NOT NULL,
	created_at timestamptz NOT NULL,
	CONSTRAINT household_administration_commands_idempotency_unique
		UNIQUE (household_id, actor_user_id, actor_session_id,
			command_kind, idempotency_key),
	CONSTRAINT household_administration_commands_actor_membership_fk
		FOREIGN KEY (household_id, actor_user_id)
		REFERENCES emdo.household_memberships(household_id, user_id)
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT household_administration_commands_kind_check CHECK (
		command_kind IN ('issue-invitation', 'revoke-invitation',
			'change-membership-role', 'deactivate-membership')
	),
	CONSTRAINT household_administration_commands_idempotency_check CHECK (
		idempotency_key ~ '^[A-Za-z0-9:._-]{16,200}$'
	),
	CONSTRAINT household_administration_commands_request_hash_check CHECK (
		request_hash ~ '^[a-f0-9]{64}$'
	),
	CONSTRAINT household_administration_commands_result_size_check CHECK (
		pg_catalog.octet_length(result::text) BETWEEN 2 AND 4096
	)
);
CREATE INDEX household_administration_commands_household_created_idx
	ON emdo.household_administration_commands(household_id, created_at);
ALTER TABLE emdo.household_administration_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.household_administration_commands FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE emdo.invitation_delivery_secrets (
	id uuid PRIMARY KEY NOT NULL,
	invitation_id uuid NOT NULL,
	household_id uuid NOT NULL,
	recipient text NOT NULL,
	role text NOT NULL,
	token_hash text NOT NULL,
	template_version text NOT NULL,
	algorithm text NOT NULL,
	key_id text NOT NULL,
	binding_hash text NOT NULL,
	envelope jsonb,
	state text DEFAULT 'pending' NOT NULL,
	operation_id text NOT NULL,
	created_at timestamptz NOT NULL,
	expires_at timestamptz NOT NULL,
	indeterminate_at timestamptz,
	settled_at timestamptz,
	erased_at timestamptz,
	CONSTRAINT invitation_delivery_secrets_invitation_unique
		UNIQUE (invitation_id),
	CONSTRAINT invitation_delivery_secrets_operation_unique
		UNIQUE (operation_id),
	CONSTRAINT invitation_delivery_secrets_invitation_fk
		FOREIGN KEY (invitation_id) REFERENCES emdo.invitations(id)
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT invitation_delivery_secrets_email_normalized
		CHECK (recipient = pg_catalog.lower(recipient)),
	CONSTRAINT invitation_delivery_secrets_role_check
		CHECK (role IN ('owner', 'member')),
	CONSTRAINT invitation_delivery_secrets_token_hash_check
		CHECK (token_hash ~ '^[a-f0-9]{64}$'),
	CONSTRAINT invitation_delivery_secrets_binding_hash_check
		CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
	CONSTRAINT invitation_delivery_secrets_envelope_check CHECK (
		algorithm = 'RSA-OAEP-256'
		AND template_version = 'invitation-redemption.v1'
		AND pg_catalog.char_length(key_id) BETWEEN 1 AND 128
		AND operation_id = 'invitation:' || invitation_id::text
	),
	CONSTRAINT invitation_delivery_secrets_state_check CHECK (
		state IN ('pending', 'indeterminate', 'confirmed', 'expired', 'cancelled')
	),
	CONSTRAINT invitation_delivery_secrets_lifecycle_check CHECK (
		(
			state IN ('pending', 'indeterminate')
			AND envelope IS NOT NULL
			AND erased_at IS NULL
			AND settled_at IS NULL
		) OR (
			state IN ('confirmed', 'expired', 'cancelled')
			AND envelope IS NULL
			AND erased_at IS NOT NULL
			AND settled_at IS NOT NULL
		)
	),
	CONSTRAINT invitation_delivery_secrets_expiry_check CHECK (
		expires_at > created_at AND expires_at <= created_at + interval '7 days'
	),
	CONSTRAINT invitation_delivery_secrets_envelope_size_check CHECK (
		envelope IS NULL OR pg_catalog.octet_length(envelope::text)
			BETWEEN 64 AND 16384
	)
);
CREATE INDEX invitation_delivery_secrets_expiry_idx
	ON emdo.invitation_delivery_secrets(state, expires_at);
ALTER TABLE emdo.invitation_delivery_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.invitation_delivery_secrets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $roles$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_household_admin_executor'
	) THEN
		CREATE ROLE emdo_household_admin_executor NOLOGIN NOSUPERUSER
			NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_invitation_delivery_executor'
	) THEN
		CREATE ROLE emdo_invitation_delivery_executor NOLOGIN NOSUPERUSER
			NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$roles$;
ALTER ROLE emdo_household_admin_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_invitation_delivery_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
DO $membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname = 'emdo_household_admin_executor'
			OR child.rolname = 'emdo_household_admin_executor'
	) THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'household administration executor must not have role memberships';
	END IF;
END
$membership_guard$;
DO $delivery_membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname = 'emdo_invitation_delivery_executor'
			OR child.rolname = 'emdo_invitation_delivery_executor'
	) THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'invitation delivery executor must not have role memberships';
	END IF;
END
$delivery_membership_guard$;
REVOKE ALL ON SCHEMA emdo FROM emdo_household_admin_executor;
REVOKE ALL ON SCHEMA emdo FROM emdo_invitation_delivery_executor;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA emdo
	FROM emdo_household_admin_executor;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA emdo
	FROM emdo_invitation_delivery_executor;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA emdo
	FROM emdo_household_admin_executor;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA emdo
	FROM emdo_invitation_delivery_executor;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA emdo
	FROM emdo_household_admin_executor;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA emdo
	FROM emdo_invitation_delivery_executor;
GRANT USAGE ON SCHEMA emdo TO emdo_household_admin_executor,
	emdo_invitation_delivery_executor;
--> statement-breakpoint
CREATE POLICY household_admin_sessions_select
	ON emdo.auth_sessions FOR SELECT TO emdo_household_admin_executor
	USING (true);
CREATE POLICY household_admin_sessions_delete
	ON emdo.auth_sessions FOR DELETE TO emdo_household_admin_executor
	USING (true);
CREATE POLICY household_admin_users_select
	ON emdo.auth_users FOR SELECT TO emdo_household_admin_executor
	USING (true);
CREATE POLICY household_admin_memberships_select
	ON emdo.household_memberships FOR SELECT TO emdo_household_admin_executor
	USING (true);
CREATE POLICY household_admin_memberships_update
	ON emdo.household_memberships FOR UPDATE TO emdo_household_admin_executor
	USING (true) WITH CHECK (true);
CREATE POLICY household_admin_invitations_select
	ON emdo.invitations FOR SELECT TO emdo_household_admin_executor
	USING (true);
CREATE POLICY household_admin_invitations_insert
	ON emdo.invitations FOR INSERT TO emdo_household_admin_executor
	WITH CHECK (true);
CREATE POLICY household_admin_invitations_update
	ON emdo.invitations FOR UPDATE TO emdo_household_admin_executor
	USING (true) WITH CHECK (true);
CREATE POLICY household_admin_spaces_select
	ON emdo.spaces FOR SELECT TO emdo_household_admin_executor
	USING (true);
CREATE POLICY household_admin_rotating_sessions_select
	ON emdo.rotating_sessions FOR SELECT TO emdo_household_admin_executor
	USING (true);
CREATE POLICY household_admin_rotating_sessions_delete
	ON emdo.rotating_sessions FOR DELETE TO emdo_household_admin_executor
	USING (true);
CREATE POLICY household_admin_commands_all
	ON emdo.household_administration_commands FOR ALL
	TO emdo_household_admin_executor
	USING (true) WITH CHECK (true);
CREATE POLICY household_admin_delivery_secrets_all
	ON emdo.invitation_delivery_secrets FOR ALL
	TO emdo_household_admin_executor
	USING (true) WITH CHECK (true);
CREATE POLICY household_admin_outbox_select
	ON emdo.worker_operation_outbox FOR SELECT
	TO emdo_household_admin_executor USING (true);
CREATE POLICY household_admin_outbox_insert
	ON emdo.worker_operation_outbox FOR INSERT
	TO emdo_household_admin_executor WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON emdo.auth_sessions TO emdo_household_admin_executor;
GRANT UPDATE (updated_at)
	ON emdo.auth_sessions TO emdo_household_admin_executor;
GRANT SELECT ON emdo.auth_users TO emdo_household_admin_executor;
GRANT SELECT ON emdo.household_memberships TO emdo_household_admin_executor;
GRANT UPDATE (role, status, administration_version, ended_at, updated_at)
	ON emdo.household_memberships TO emdo_household_admin_executor;
GRANT SELECT, INSERT ON emdo.invitations TO emdo_household_admin_executor;
GRANT UPDATE (consumed_at, consumed_by_user_id, consumed_session_id,
	revoked_at, administration_version)
	ON emdo.invitations TO emdo_household_admin_executor;
GRANT SELECT ON emdo.spaces TO emdo_household_admin_executor;
GRANT SELECT, DELETE ON emdo.rotating_sessions
	TO emdo_household_admin_executor;
GRANT SELECT, INSERT ON emdo.household_administration_commands
	TO emdo_household_admin_executor;
GRANT UPDATE (created_at) ON emdo.household_administration_commands
	TO emdo_household_admin_executor;
GRANT SELECT, INSERT, UPDATE ON emdo.invitation_delivery_secrets
	TO emdo_household_admin_executor;
GRANT SELECT, INSERT ON emdo.worker_operation_outbox
	TO emdo_household_admin_executor;
GRANT EXECUTE ON FUNCTION emdo.current_user_id(),
	emdo.current_session_id(), emdo.current_request_id(),
	emdo.lock_active_request_scope(uuid, uuid, uuid)
	TO emdo_household_admin_executor;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.enforce_invitation_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
BEGIN
	IF ROW(
		NEW.id, NEW.household_id, NEW.invited_by_user_id, NEW.email,
		NEW.role, NEW.token_hash, NEW.created_at, NEW.expires_at
	) IS DISTINCT FROM ROW(
		OLD.id, OLD.household_id, OLD.invited_by_user_id, OLD.email,
		OLD.role, OLD.token_hash, OLD.created_at, OLD.expires_at
	) THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'invitation envelope is immutable';
	END IF;
	IF OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'terminal invitation is immutable';
	END IF;
	IF NEW.revoked_at IS NOT NULL
		AND NEW.consumed_at IS NULL
		AND NEW.consumed_by_user_id IS NULL
		AND NEW.consumed_session_id IS NULL
	THEN
		NEW.revoked_at := pg_catalog.clock_timestamp();
		NEW.administration_version := OLD.administration_version + 1;
		UPDATE emdo.invitation_delivery_secrets
		SET envelope = NULL, state = 'cancelled',
			settled_at = NEW.revoked_at, erased_at = NEW.revoked_at
		WHERE invitation_id = NEW.id
			AND state IN ('pending', 'indeterminate');
		RETURN NEW;
	END IF;
	IF NEW.revoked_at IS NULL
		AND NEW.consumed_at IS NOT NULL
		AND NEW.consumed_by_user_id IS NOT NULL
	THEN
		NEW.administration_version := OLD.administration_version + 1;
		UPDATE emdo.invitation_delivery_secrets
		SET envelope = NULL, state = 'cancelled',
			settled_at = NEW.consumed_at, erased_at = NEW.consumed_at
		WHERE invitation_id = NEW.id
			AND state IN ('pending', 'indeterminate');
		RETURN NEW;
	END IF;
	RAISE EXCEPTION USING ERRCODE = '55000',
		MESSAGE = 'invalid invitation lifecycle transition';
END
$function$;
GRANT CREATE ON SCHEMA emdo TO emdo_household_admin_executor;
ALTER FUNCTION emdo.enforce_invitation_lifecycle()
	OWNER TO emdo_household_admin_executor;
REVOKE CREATE ON SCHEMA emdo FROM emdo_household_admin_executor;
REVOKE ALL ON FUNCTION emdo.enforce_invitation_lifecycle()
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_household_admin_executor;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.claim_household_owner_scope()
RETURNS TABLE (
	household_id uuid,
	actor_user_id uuid,
	actor_session_id uuid,
	actor_membership_id uuid,
	actor_private_space_id uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_user_id uuid := emdo.current_user_id();
	v_session_id uuid := emdo.current_session_id();
	v_request_id uuid := emdo.current_request_id();
	v_household_id uuid;
BEGIN
	IF v_user_id IS NULL OR v_session_id IS NULL OR v_request_id IS NULL THEN
		RAISE EXCEPTION USING ERRCODE = '42501',
			MESSAGE = 'EMDO:authorization-revoked';
	END IF;
	SELECT session.active_household_id INTO v_household_id
	FROM emdo.auth_sessions AS session
	JOIN emdo.auth_users AS account_user ON account_user.id = session.user_id
	JOIN emdo.household_memberships AS membership
		ON membership.household_id = session.active_household_id
		AND membership.user_id = session.user_id
	WHERE session.id = v_session_id
		AND session.user_id = v_user_id
		AND session.active_household_id IS NOT NULL
		AND session.expires_at > pg_catalog.clock_timestamp()
		AND account_user.email_verified = true
		AND membership.role = 'owner'
		AND membership.status = 'active'
		AND EXISTS (
			SELECT 1 FROM emdo.spaces AS private_space
			WHERE private_space.household_id = session.active_household_id
				AND private_space.original_owner_user_id = session.user_id
				AND private_space.visibility = 'private'
				AND private_space.tombstoned_at IS NULL
		)
	LIMIT 1;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = '42501',
			MESSAGE = 'EMDO:authorization-revoked';
	END IF;
	PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
		'emdo.household-administration:' || v_household_id::text,
		0
	));
	RETURN QUERY
	SELECT session.active_household_id, session.user_id, session.id,
		membership.id, private_space.id
	FROM emdo.auth_sessions AS session
	JOIN emdo.auth_users AS account_user ON account_user.id = session.user_id
	JOIN emdo.household_memberships AS membership
		ON membership.household_id = session.active_household_id
		AND membership.user_id = session.user_id
	JOIN LATERAL (
		SELECT space.id
		FROM emdo.spaces AS space
		WHERE space.household_id = session.active_household_id
			AND space.original_owner_user_id = session.user_id
			AND space.visibility = 'private'
			AND space.tombstoned_at IS NULL
		ORDER BY space.created_at, space.id
		LIMIT 1
	) AS private_space ON true
	WHERE session.id = v_session_id
		AND session.user_id = v_user_id
		AND session.active_household_id = v_household_id
		AND session.active_household_id IS NOT NULL
		AND session.expires_at > pg_catalog.clock_timestamp()
		AND account_user.email_verified = true
		AND membership.role = 'owner'
		AND membership.status = 'active'
		AND emdo.lock_active_request_scope(
			session.active_household_id, private_space.id, NULL
		)
	FOR SHARE OF session, membership;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = '42501',
			MESSAGE = 'EMDO:authorization-revoked';
	END IF;
END
$function$;
GRANT CREATE ON SCHEMA emdo TO emdo_household_admin_executor;
ALTER FUNCTION emdo.claim_household_owner_scope()
	OWNER TO emdo_household_admin_executor;
REVOKE CREATE ON SCHEMA emdo FROM emdo_household_admin_executor;
REVOKE ALL ON FUNCTION emdo.claim_household_owner_scope()
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_household_admin_executor;
GRANT EXECUTE ON FUNCTION emdo.claim_household_owner_scope()
	TO emdo_household_admin_executor;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.list_household_memberships()
RETURNS TABLE (
	schema_version integer,
	membership_id uuid,
	household_id uuid,
	user_id uuid,
	email text,
	role text,
	status text,
	version integer,
	joined_at timestamptz,
	ended_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_scope record;
BEGIN
	SELECT * INTO v_scope FROM emdo.claim_household_owner_scope();
	RETURN QUERY
	SELECT 1, membership.id, membership.household_id, membership.user_id,
		account_user.email, membership.role, membership.status,
		membership.administration_version, membership.joined_at,
		membership.ended_at
	FROM emdo.household_memberships AS membership
	JOIN emdo.auth_users AS account_user ON account_user.id = membership.user_id
	WHERE membership.household_id = v_scope.household_id
	ORDER BY membership.joined_at, membership.id;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.change_household_membership_role(
	p_membership_id uuid,
	p_expected_version integer,
	p_role text,
	p_idempotency_key text,
	p_request_hash text
)
RETURNS TABLE (
	schema_version integer,
	membership_id uuid,
	household_id uuid,
	user_id uuid,
	email text,
	role text,
	status text,
	version integer,
	joined_at timestamptz,
	ended_at timestamptz,
	replayed boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_scope record;
	v_command record;
	v_target emdo.household_memberships%ROWTYPE;
	v_email text;
	v_now timestamptz;
	v_owner_count integer;
	v_result jsonb;
	v_was_owner boolean;
BEGIN
	IF p_membership_id IS NULL OR p_expected_version < 1
		OR p_role NOT IN ('owner', 'member')
		OR p_idempotency_key !~ '^[A-Za-z0-9:._-]{16,200}$'
		OR p_request_hash !~ '^[a-f0-9]{64}$'
	THEN
		RETURN;
	END IF;
	SELECT * INTO v_scope FROM emdo.claim_household_owner_scope();
	PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
		v_scope.actor_user_id::text || ':' || v_scope.actor_session_id::text
			|| ':change-membership-role:' || p_idempotency_key,
		0
	));
	SELECT command.* INTO v_command
	FROM emdo.household_administration_commands AS command
	WHERE command.household_id = v_scope.household_id
		AND command.actor_user_id = v_scope.actor_user_id
		AND command.actor_session_id = v_scope.actor_session_id
		AND command.command_kind = 'change-membership-role'
		AND command.idempotency_key = p_idempotency_key
	FOR UPDATE;
	IF FOUND THEN
		IF v_command.request_hash IS DISTINCT FROM p_request_hash
			OR v_command.target_id IS DISTINCT FROM p_membership_id
		THEN
			RETURN;
		END IF;
		v_result := v_command.result;
		RETURN QUERY SELECT 1,
			(v_result ->> 'membershipId')::uuid,
			(v_result ->> 'householdId')::uuid,
			(v_result ->> 'userId')::uuid,
			v_result ->> 'email', v_result ->> 'role',
			v_result ->> 'status', (v_result ->> 'version')::integer,
			(v_result ->> 'joinedAt')::timestamptz,
			(v_result ->> 'endedAt')::timestamptz, true;
		RETURN;
	END IF;

	SELECT membership.* INTO v_target
	FROM emdo.household_memberships AS membership
	WHERE membership.id = p_membership_id
		AND membership.household_id = v_scope.household_id
	FOR UPDATE OF membership;
	IF NOT FOUND OR v_target.status <> 'active'
		OR v_target.administration_version <> p_expected_version
		OR v_target.role = p_role
	THEN
		RETURN;
	END IF;
	v_was_owner := v_target.role = 'owner';
	SELECT account_user.email INTO v_email
	FROM emdo.auth_users AS account_user
	WHERE account_user.id = v_target.user_id;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	IF v_target.user_id = v_scope.actor_user_id AND p_role <> 'owner' THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'EMDO:self-lockout';
	END IF;
	IF v_target.role = 'owner' AND p_role = 'member' THEN
		PERFORM 1
		FROM emdo.household_memberships AS owner_membership
		WHERE owner_membership.household_id = v_scope.household_id
			AND owner_membership.role = 'owner'
			AND owner_membership.status = 'active'
		ORDER BY owner_membership.id
		FOR UPDATE;
		SELECT pg_catalog.count(*)::integer INTO v_owner_count
		FROM emdo.household_memberships AS owner_membership
		WHERE owner_membership.household_id = v_scope.household_id
			AND owner_membership.role = 'owner'
			AND owner_membership.status = 'active';
		IF v_owner_count <= 1 THEN
			RAISE EXCEPTION USING ERRCODE = '55000',
				MESSAGE = 'EMDO:last-owner-required';
		END IF;
	END IF;

	v_now := pg_catalog.clock_timestamp();
	UPDATE emdo.household_memberships AS membership
	SET role = p_role,
		administration_version = p_expected_version + 1,
		updated_at = v_now
	WHERE membership.id = p_membership_id
		AND membership.household_id = v_scope.household_id
		AND membership.status = 'active'
		AND membership.administration_version = p_expected_version
	RETURNING membership.* INTO v_target;
	IF NOT FOUND OR v_target.administration_version <> p_expected_version + 1 THEN
		RETURN;
	END IF;
	IF v_was_owner AND v_target.role <> 'owner' THEN
		UPDATE emdo.invitations AS issued_invitation
		SET revoked_at = v_now
		WHERE issued_invitation.household_id = v_scope.household_id
			AND issued_invitation.invited_by_user_id = v_target.user_id
			AND issued_invitation.consumed_at IS NULL
			AND issued_invitation.revoked_at IS NULL;
	END IF;
	DELETE FROM emdo.rotating_sessions AS target_session
	WHERE target_session.user_id = v_target.user_id;
	DELETE FROM emdo.auth_sessions AS target_session
	WHERE target_session.user_id = v_target.user_id;
	v_result := pg_catalog.jsonb_build_object(
		'membershipId', v_target.id::text,
		'householdId', v_target.household_id::text,
		'userId', v_target.user_id::text,
		'email', v_email,
		'role', v_target.role,
		'status', v_target.status,
		'version', v_target.administration_version,
		'joinedAt', v_target.joined_at,
		'endedAt', v_target.ended_at
	);
	INSERT INTO emdo.household_administration_commands (
		household_id, actor_user_id, actor_session_id, command_kind,
		idempotency_key, request_hash, target_id, result, created_at
	) VALUES (
		v_scope.household_id, v_scope.actor_user_id,
		v_scope.actor_session_id, 'change-membership-role',
		p_idempotency_key, p_request_hash, p_membership_id, v_result, v_now
	);
	RETURN QUERY SELECT 1, v_target.id, v_target.household_id,
		v_target.user_id, v_email, v_target.role, v_target.status,
		v_target.administration_version, v_target.joined_at,
		v_target.ended_at, false;
END
$function$;
--> statement-breakpoint
-- Forward declaration keeps ownership/ACL hardening atomic before the full
-- implementation below replaces this body without changing its identity.
CREATE OR REPLACE FUNCTION emdo.deactivate_household_membership(
	p_membership_id uuid,
	p_expected_version integer,
	p_idempotency_key text,
	p_request_hash text
)
RETURNS TABLE (
	schema_version integer,
	membership_id uuid,
	household_id uuid,
	user_id uuid,
	email text,
	role text,
	status text,
	version integer,
	joined_at timestamptz,
	ended_at timestamptz,
	replayed boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
BEGIN
	RETURN;
END
$function$;
--> statement-breakpoint
CREATE POLICY invitation_delivery_invitations_select
	ON emdo.invitations FOR SELECT TO emdo_invitation_delivery_executor
	USING (true);
CREATE POLICY invitation_delivery_invitations_lock
	ON emdo.invitations FOR UPDATE TO emdo_invitation_delivery_executor
	USING (true) WITH CHECK (true);
CREATE POLICY invitation_delivery_secrets_select
	ON emdo.invitation_delivery_secrets FOR SELECT
	TO emdo_invitation_delivery_executor USING (true);
CREATE POLICY invitation_delivery_secrets_update
	ON emdo.invitation_delivery_secrets FOR UPDATE
	TO emdo_invitation_delivery_executor USING (true) WITH CHECK (true);
CREATE POLICY invitation_delivery_outbox_select
	ON emdo.worker_operation_outbox FOR SELECT
	TO emdo_invitation_delivery_executor USING (true);
GRANT SELECT ON emdo.invitations TO emdo_invitation_delivery_executor;
GRANT UPDATE (id) ON emdo.invitations
	TO emdo_invitation_delivery_executor;
GRANT SELECT ON emdo.invitation_delivery_secrets
	TO emdo_invitation_delivery_executor;
GRANT UPDATE (envelope, state, indeterminate_at, settled_at, erased_at)
	ON emdo.invitation_delivery_secrets TO emdo_invitation_delivery_executor;
GRANT SELECT ON emdo.worker_operation_outbox
	TO emdo_invitation_delivery_executor;
GRANT EXECUTE ON FUNCTION
	emdo.current_worker_job_name(),
	emdo.current_worker_operation_id(),
	emdo.current_worker_target_type(),
	emdo.current_worker_target_id(),
	emdo.current_worker_target_revision(),
	emdo.is_active_worker_operation_scope(uuid, uuid, uuid)
	TO emdo_invitation_delivery_executor;
GRANT EXECUTE ON FUNCTION
	emdo.worker_outbox_binding_is_valid(
		text, text, text, text, integer, text, integer, jsonb
	)
	TO emdo_invitation_delivery_executor;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.capture_invitation_delivery_secret(
	p_invitation_id uuid,
	p_delivery_secret_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_now timestamptz := pg_catalog.clock_timestamp();
	v_outbox emdo.worker_operation_outbox%ROWTYPE;
	v_invitation emdo.invitations%ROWTYPE;
	v_secret emdo.invitation_delivery_secrets%ROWTYPE;
BEGIN
	IF p_invitation_id IS NULL OR p_delivery_secret_id IS NULL
		OR emdo.current_worker_job_name() <> 'emdo.invitation.delivery.v1'
		OR emdo.current_worker_operation_id()
			<> 'invitation:' || p_invitation_id::text
		OR emdo.current_worker_target_type() <> 'invitation'
		OR emdo.current_worker_target_id() <> p_invitation_id::text
		OR emdo.current_worker_target_revision() <> 1
	THEN
		RETURN NULL;
	END IF;
	SELECT outbox.* INTO v_outbox
	FROM emdo.worker_operation_outbox AS outbox
	WHERE outbox.job_name = emdo.current_worker_job_name()
		AND outbox.operation_id = emdo.current_worker_operation_id()
		AND outbox.target_type = 'invitation'
		AND outbox.target_id = p_invitation_id::text
		AND outbox.target_revision = 1
		AND outbox.payload ->> 'invitationId' = p_invitation_id::text
		AND outbox.payload ->> 'deliverySecretId' = p_delivery_secret_id::text
		AND emdo.worker_outbox_binding_is_valid(
			outbox.job_name, outbox.operation_id, outbox.target_type,
			outbox.target_id, outbox.target_revision,
			outbox.related_operation_id, outbox.retry_sequence, outbox.payload
		);
	IF NOT FOUND OR NOT emdo.is_active_worker_operation_scope(
		v_outbox.household_id, v_outbox.space_id,
		v_outbox.original_owner_user_id
	) THEN
		RETURN NULL;
	END IF;
	SELECT invitation.* INTO v_invitation
	FROM emdo.invitations AS invitation
	WHERE invitation.id = p_invitation_id
		AND invitation.household_id = v_outbox.household_id
	FOR SHARE;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;
	SELECT secret.* INTO v_secret
	FROM emdo.invitation_delivery_secrets AS secret
	WHERE secret.id = p_delivery_secret_id
		AND secret.invitation_id = p_invitation_id
		AND secret.household_id = v_outbox.household_id
		AND secret.operation_id = emdo.current_worker_operation_id()
	FOR UPDATE;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;
	IF v_secret.state IN ('confirmed', 'expired', 'cancelled') THEN
		RETURN pg_catalog.jsonb_build_object(
			'schemaVersion', 1, 'status', 'expired',
			'invitationId', p_invitation_id::text,
			'deliverySecretId', p_delivery_secret_id::text
		);
	END IF;
	IF v_invitation.consumed_at IS NOT NULL
		OR v_invitation.revoked_at IS NOT NULL
		OR v_invitation.expires_at <= v_now
		OR v_secret.expires_at <= v_now
	THEN
		UPDATE emdo.invitation_delivery_secrets
		SET envelope = NULL,
			state = CASE
				WHEN v_invitation.consumed_at IS NOT NULL
					OR v_invitation.revoked_at IS NOT NULL THEN 'cancelled'
				ELSE 'expired'
			END,
			settled_at = v_now, erased_at = v_now
		WHERE id = p_delivery_secret_id
			AND state IN ('pending', 'indeterminate');
		RETURN pg_catalog.jsonb_build_object(
			'schemaVersion', 1, 'status', 'expired',
			'invitationId', p_invitation_id::text,
			'deliverySecretId', p_delivery_secret_id::text
		);
	END IF;
	IF v_secret.recipient IS DISTINCT FROM v_invitation.email
		OR v_secret.role IS DISTINCT FROM v_invitation.role
		OR v_secret.token_hash IS DISTINCT FROM v_invitation.token_hash
		OR v_secret.template_version IS DISTINCT FROM 'invitation-redemption.v1'
		OR v_secret.algorithm IS DISTINCT FROM 'RSA-OAEP-256'
		OR v_secret.envelope IS NULL
		OR v_secret.envelope ->> 'schemaVersion' IS DISTINCT FROM '1'
		OR v_secret.envelope ->> 'algorithm' IS DISTINCT FROM v_secret.algorithm
		OR v_secret.envelope ->> 'keyId' IS DISTINCT FROM v_secret.key_id
		OR v_secret.envelope ->> 'bindingHash' IS DISTINCT FROM v_secret.binding_hash
		OR (SELECT pg_catalog.count(*)
			FROM pg_catalog.jsonb_object_keys(v_secret.envelope)) <> 5
	THEN
		RETURN NULL;
	END IF;
	RETURN pg_catalog.jsonb_build_object(
		'schemaVersion', 1,
		'status', 'active',
		'invitationId', p_invitation_id::text,
		'deliverySecretId', p_delivery_secret_id::text,
		'recipient', v_secret.recipient,
		'role', v_secret.role,
		'tokenHash', v_secret.token_hash,
		'templateVersion', v_secret.template_version,
		'envelope', v_secret.envelope
	);
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.settle_invitation_delivery_secret(
	p_invitation_id uuid,
	p_delivery_secret_id uuid,
	p_disposition text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_now timestamptz := pg_catalog.clock_timestamp();
	v_outbox emdo.worker_operation_outbox%ROWTYPE;
	v_invitation emdo.invitations%ROWTYPE;
	v_secret emdo.invitation_delivery_secrets%ROWTYPE;
BEGIN
	IF p_invitation_id IS NULL OR p_delivery_secret_id IS NULL
		OR NOT (p_disposition IN ('confirmed', 'indeterminate', 'expired'))
		OR emdo.current_worker_job_name() <> 'emdo.invitation.delivery.v1'
		OR emdo.current_worker_operation_id()
			<> 'invitation:' || p_invitation_id::text
		OR emdo.current_worker_target_type() <> 'invitation'
		OR emdo.current_worker_target_id() <> p_invitation_id::text
		OR emdo.current_worker_target_revision() <> 1
	THEN
		RETURN NULL;
	END IF;
	SELECT outbox.* INTO v_outbox
	FROM emdo.worker_operation_outbox AS outbox
	WHERE outbox.job_name = emdo.current_worker_job_name()
		AND outbox.operation_id = emdo.current_worker_operation_id()
		AND outbox.target_type = 'invitation'
		AND outbox.target_id = p_invitation_id::text
		AND outbox.target_revision = 1
		AND outbox.payload ->> 'deliverySecretId' = p_delivery_secret_id::text
		AND emdo.worker_outbox_binding_is_valid(
			outbox.job_name, outbox.operation_id, outbox.target_type,
			outbox.target_id, outbox.target_revision,
			outbox.related_operation_id, outbox.retry_sequence, outbox.payload
		);
	IF NOT FOUND OR NOT emdo.is_active_worker_operation_scope(
		v_outbox.household_id, v_outbox.space_id,
		v_outbox.original_owner_user_id
	) THEN
		RETURN NULL;
	END IF;
	SELECT invitation.* INTO v_invitation
	FROM emdo.invitations AS invitation
	WHERE invitation.id = p_invitation_id
		AND invitation.household_id = v_outbox.household_id
	FOR SHARE;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;
	SELECT secret.* INTO v_secret
	FROM emdo.invitation_delivery_secrets AS secret
	WHERE secret.id = p_delivery_secret_id
		AND secret.invitation_id = p_invitation_id
		AND secret.household_id = v_outbox.household_id
		AND secret.operation_id = emdo.current_worker_operation_id()
	FOR UPDATE;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;
	IF v_secret.state IN ('confirmed', 'expired', 'cancelled')
		OR (v_secret.state = 'indeterminate'
			AND p_disposition = 'indeterminate')
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'duplicate');
	END IF;
	IF p_disposition = 'indeterminate' THEN
		UPDATE emdo.invitation_delivery_secrets
		SET state = 'indeterminate', indeterminate_at = v_now
		WHERE id = p_delivery_secret_id AND state = 'pending';
	ELSE
		UPDATE emdo.invitation_delivery_secrets
		SET envelope = NULL, state = p_disposition,
			settled_at = v_now, erased_at = v_now
		WHERE id = p_delivery_secret_id
			AND state IN ('pending', 'indeterminate');
	END IF;
	IF NOT FOUND THEN
		RETURN pg_catalog.jsonb_build_object('status', 'duplicate');
	END IF;
	RETURN pg_catalog.jsonb_build_object('status', 'settled');
END
$function$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA emdo TO emdo_invitation_delivery_executor;
ALTER FUNCTION emdo.capture_invitation_delivery_secret(uuid, uuid)
	OWNER TO emdo_invitation_delivery_executor;
ALTER FUNCTION emdo.settle_invitation_delivery_secret(uuid, uuid, text)
	OWNER TO emdo_invitation_delivery_executor;
REVOKE CREATE ON SCHEMA emdo FROM emdo_invitation_delivery_executor;
REVOKE ALL ON FUNCTION emdo.capture_invitation_delivery_secret(uuid, uuid),
	emdo.settle_invitation_delivery_secret(uuid, uuid, text)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_household_admin_executor;
GRANT EXECUTE ON FUNCTION emdo.capture_invitation_delivery_secret(uuid, uuid),
	emdo.settle_invitation_delivery_secret(uuid, uuid, text)
	TO emdo_worker_executor;
--> statement-breakpoint
DROP POLICY IF EXISTS invitations_owner_read ON emdo.invitations;
DROP POLICY IF EXISTS invitations_owner_insert ON emdo.invitations;
DROP POLICY IF EXISTS invitations_owner_update ON emdo.invitations;
REVOKE ALL PRIVILEGES ON emdo.invitations FROM emdo_app;
REVOKE ALL (
	id, household_id, invited_by_user_id, email, role, token_hash,
	created_at, expires_at, consumed_at, consumed_by_user_id,
	consumed_session_id, revoked_at, administration_version
) ON emdo.invitations FROM emdo_app;
REVOKE ALL PRIVILEGES ON emdo.household_memberships FROM emdo_app;
REVOKE ALL (
	id, household_id, user_id, role, status, administration_version,
	joined_at, ended_at, updated_at
) ON emdo.household_memberships FROM emdo_app;
REVOKE ALL PRIVILEGES ON emdo.household_administration_commands FROM emdo_app;
REVOKE ALL PRIVILEGES ON emdo.invitation_delivery_secrets FROM emdo_app;
REVOKE SELECT ON emdo.worker_operation_outbox FROM emdo_app;
REVOKE SELECT (payload) ON emdo.worker_operation_outbox FROM emdo_app;
REVOKE INSERT, UPDATE, DELETE ON emdo.invitations FROM emdo_app;
REVOKE INSERT, UPDATE, DELETE ON emdo.household_memberships FROM emdo_app;
--> statement-breakpoint
GRANT CREATE ON SCHEMA emdo TO emdo_household_admin_executor;
ALTER FUNCTION emdo.issue_household_invitation(
	text, text, integer, text, text, text, uuid, text, uuid, text, jsonb, text
) OWNER TO emdo_household_admin_executor;
ALTER FUNCTION emdo.list_household_invitations()
	OWNER TO emdo_household_admin_executor;
ALTER FUNCTION emdo.revoke_household_invitation(uuid, integer, text, text)
	OWNER TO emdo_household_admin_executor;
ALTER FUNCTION emdo.list_household_memberships()
	OWNER TO emdo_household_admin_executor;
ALTER FUNCTION emdo.change_household_membership_role(
	uuid, integer, text, text, text
) OWNER TO emdo_household_admin_executor;
ALTER FUNCTION emdo.deactivate_household_membership(
	uuid, integer, text, text
) OWNER TO emdo_household_admin_executor;
REVOKE CREATE ON SCHEMA emdo FROM emdo_household_admin_executor;
REVOKE ALL ON FUNCTION
	emdo.issue_household_invitation(
		text, text, integer, text, text, text, uuid, text, uuid, text, jsonb, text
	),
	emdo.list_household_invitations(),
	emdo.revoke_household_invitation(uuid, integer, text, text),
	emdo.list_household_memberships(),
	emdo.change_household_membership_role(uuid, integer, text, text, text),
	emdo.deactivate_household_membership(uuid, integer, text, text)
	FROM PUBLIC, emdo_auth, emdo_worker, emdo_workflow, emdo_policy_reader,
	emdo_household_admin_executor, emdo_invitation_delivery_executor;
GRANT EXECUTE ON FUNCTION
	emdo.issue_household_invitation(
		text, text, integer, text, text, text, uuid, text, uuid, text, jsonb, text
	),
	emdo.list_household_invitations(),
	emdo.revoke_household_invitation(uuid, integer, text, text),
	emdo.list_household_memberships(),
	emdo.change_household_membership_role(uuid, integer, text, text, text),
	emdo.deactivate_household_membership(uuid, integer, text, text)
	TO emdo_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.household_administration_ready()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_expected regprocedure[] := ARRAY[
		pg_catalog.to_regprocedure(
			'emdo.issue_household_invitation(text,text,integer,text,text,text,uuid,text,uuid,text,jsonb,text)'
		),
		pg_catalog.to_regprocedure('emdo.list_household_invitations()'),
		pg_catalog.to_regprocedure(
			'emdo.revoke_household_invitation(uuid,integer,text,text)'
		),
		pg_catalog.to_regprocedure('emdo.list_household_memberships()'),
		pg_catalog.to_regprocedure(
			'emdo.change_household_membership_role(uuid,integer,text,text,text)'
		),
		pg_catalog.to_regprocedure(
			'emdo.deactivate_household_membership(uuid,integer,text,text)'
		)
	];
BEGIN
	RETURN session_user = 'emdo_api_login'
		AND pg_catalog.pg_has_role(session_user, 'emdo_app', 'USAGE')
		AND current_user = 'emdo_household_admin_executor'
		AND pg_catalog.has_column_privilege(
			current_user, 'emdo.auth_sessions', 'updated_at', 'UPDATE'
		)
		AND pg_catalog.has_column_privilege(
			current_user, 'emdo.household_administration_commands',
			'created_at', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			current_user, 'emdo.auth_sessions', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			current_user, 'emdo.household_administration_commands', 'UPDATE'
		)
		AND pg_catalog.array_position(v_expected, NULL) IS NULL
		AND (
			SELECT pg_catalog.count(*) = 6
			FROM pg_catalog.pg_proc AS routine
			JOIN pg_catalog.pg_namespace AS namespace
				ON namespace.oid = routine.pronamespace
			WHERE routine.oid = ANY (v_expected)
				AND namespace.nspname = 'emdo'
				AND routine.prosecdef = true
				AND pg_catalog.pg_get_userbyid(routine.proowner)
					= 'emdo_household_admin_executor'
				AND routine.proconfig @> ARRAY['row_security=on']::text[]
				AND pg_catalog.array_to_string(routine.proconfig, ',')
					LIKE '%search_path=pg_catalog, emdo%'
				AND pg_catalog.has_function_privilege(
					session_user, routine.oid, 'EXECUTE'
				)
				AND NOT EXISTS (
					SELECT 1
					FROM pg_catalog.aclexplode(COALESCE(
						routine.proacl,
						pg_catalog.acldefault('f', routine.proowner)
					)) AS privilege
					WHERE privilege.grantee = 0
						AND privilege.privilege_type = 'EXECUTE'
				)
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.invitations', 'SELECT'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.invitations', 'INSERT'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.invitations', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user, 'emdo.invitations', 'DELETE'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.household_memberships', 'SELECT'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.household_memberships', 'INSERT'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.household_memberships', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user, 'emdo.household_memberships', 'DELETE'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.household_administration_commands', 'SELECT'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.household_administration_commands', 'INSERT'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.household_administration_commands', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user, 'emdo.household_administration_commands', 'DELETE'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.invitation_delivery_secrets', 'SELECT'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.invitation_delivery_secrets', 'INSERT'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.invitation_delivery_secrets', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user, 'emdo.invitation_delivery_secrets', 'DELETE'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.worker_operation_outbox', 'SELECT'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.worker_operation_outbox', 'INSERT'
		)
		AND NOT pg_catalog.has_any_column_privilege(
			session_user, 'emdo.worker_operation_outbox', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user, 'emdo.worker_operation_outbox', 'DELETE'
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_attribute AS attribute
			WHERE attribute.attrelid = 'emdo.household_memberships'::regclass
				AND attribute.attname = 'administration_version'
				AND NOT attribute.attisdropped
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_attribute AS attribute
			WHERE attribute.attrelid = 'emdo.invitations'::regclass
				AND attribute.attname = 'administration_version'
				AND NOT attribute.attisdropped
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_attribute AS attribute
			WHERE attribute.attrelid = 'emdo.invitation_delivery_secrets'::regclass
				AND attribute.attname = 'envelope'
				AND NOT attribute.attisdropped
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_roles AS executor
			WHERE executor.rolname = 'emdo_household_admin_executor'
				AND NOT executor.rolcanlogin
				AND NOT executor.rolinherit
				AND NOT executor.rolbypassrls
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_auth_members AS membership
			JOIN pg_catalog.pg_roles AS parent
				ON parent.oid = membership.roleid
			JOIN pg_catalog.pg_roles AS child
				ON child.oid = membership.member
			WHERE parent.rolname = 'emdo_household_admin_executor'
				OR child.rolname = 'emdo_household_admin_executor'
		);
EXCEPTION WHEN OTHERS THEN
	RETURN false;
END
$function$;
GRANT CREATE ON SCHEMA emdo TO emdo_household_admin_executor;
ALTER FUNCTION emdo.household_administration_ready()
	OWNER TO emdo_household_admin_executor;
REVOKE CREATE ON SCHEMA emdo FROM emdo_household_admin_executor;
REVOKE ALL ON FUNCTION emdo.household_administration_ready()
	FROM PUBLIC, emdo_auth, emdo_worker, emdo_workflow, emdo_policy_reader,
	emdo_household_admin_executor, emdo_invitation_delivery_executor;
GRANT EXECUTE ON FUNCTION emdo.household_administration_ready()
	TO emdo_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.deactivate_household_membership(
	p_membership_id uuid,
	p_expected_version integer,
	p_idempotency_key text,
	p_request_hash text
)
RETURNS TABLE (
	schema_version integer,
	membership_id uuid,
	household_id uuid,
	user_id uuid,
	email text,
	role text,
	status text,
	version integer,
	joined_at timestamptz,
	ended_at timestamptz,
	replayed boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_scope record;
	v_command record;
	v_target emdo.household_memberships%ROWTYPE;
	v_email text;
	v_now timestamptz;
	v_owner_count integer;
	v_result jsonb;
BEGIN
	IF p_membership_id IS NULL OR p_expected_version < 1
		OR p_idempotency_key !~ '^[A-Za-z0-9:._-]{16,200}$'
		OR p_request_hash !~ '^[a-f0-9]{64}$'
	THEN
		RETURN;
	END IF;
	SELECT * INTO v_scope FROM emdo.claim_household_owner_scope();
	PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
		v_scope.actor_user_id::text || ':' || v_scope.actor_session_id::text
			|| ':deactivate-membership:' || p_idempotency_key,
		0
	));
	SELECT command.* INTO v_command
	FROM emdo.household_administration_commands AS command
	WHERE command.household_id = v_scope.household_id
		AND command.actor_user_id = v_scope.actor_user_id
		AND command.actor_session_id = v_scope.actor_session_id
		AND command.command_kind = 'deactivate-membership'
		AND command.idempotency_key = p_idempotency_key
	FOR UPDATE;
	IF FOUND THEN
		IF v_command.request_hash IS DISTINCT FROM p_request_hash
			OR v_command.target_id IS DISTINCT FROM p_membership_id
		THEN
			RETURN;
		END IF;
		v_result := v_command.result;
		RETURN QUERY SELECT 1,
			(v_result ->> 'membershipId')::uuid,
			(v_result ->> 'householdId')::uuid,
			(v_result ->> 'userId')::uuid,
			v_result ->> 'email', v_result ->> 'role',
			v_result ->> 'status', (v_result ->> 'version')::integer,
			(v_result ->> 'joinedAt')::timestamptz,
			(v_result ->> 'endedAt')::timestamptz, true;
		RETURN;
	END IF;

	SELECT membership.* INTO v_target
	FROM emdo.household_memberships AS membership
	WHERE membership.id = p_membership_id
		AND membership.household_id = v_scope.household_id
	FOR UPDATE OF membership;
	IF NOT FOUND OR v_target.status <> 'active'
		OR v_target.administration_version <> p_expected_version
	THEN
		RETURN;
	END IF;
	SELECT account_user.email INTO v_email
	FROM emdo.auth_users AS account_user
	WHERE account_user.id = v_target.user_id;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	IF v_target.user_id = v_scope.actor_user_id THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'EMDO:self-lockout';
	END IF;
	IF v_target.role = 'owner' THEN
		PERFORM 1
		FROM emdo.household_memberships AS owner_membership
		WHERE owner_membership.household_id = v_scope.household_id
			AND owner_membership.role = 'owner'
			AND owner_membership.status = 'active'
		ORDER BY owner_membership.id
		FOR UPDATE;
		SELECT pg_catalog.count(*)::integer INTO v_owner_count
		FROM emdo.household_memberships AS owner_membership
		WHERE owner_membership.household_id = v_scope.household_id
			AND owner_membership.role = 'owner'
			AND owner_membership.status = 'active';
		IF v_owner_count <= 1 THEN
			RAISE EXCEPTION USING ERRCODE = '55000',
				MESSAGE = 'EMDO:last-owner-required';
		END IF;
	END IF;

	v_now := pg_catalog.clock_timestamp();
	UPDATE emdo.household_memberships AS membership
	SET status = 'inactive', ended_at = v_now,
		administration_version = p_expected_version + 1,
		updated_at = v_now
	WHERE membership.id = p_membership_id
		AND membership.household_id = v_scope.household_id
		AND membership.status = 'active'
		AND membership.administration_version = p_expected_version
	RETURNING membership.* INTO v_target;
	IF NOT FOUND OR v_target.administration_version <> p_expected_version + 1 THEN
		RETURN;
	END IF;
	UPDATE emdo.invitations AS issued_invitation
	SET revoked_at = v_now
	WHERE issued_invitation.household_id = v_scope.household_id
		AND issued_invitation.invited_by_user_id = v_target.user_id
		AND issued_invitation.consumed_at IS NULL
		AND issued_invitation.revoked_at IS NULL;
	DELETE FROM emdo.rotating_sessions AS target_session
	WHERE target_session.user_id = v_target.user_id;
	DELETE FROM emdo.auth_sessions AS target_session
	WHERE target_session.user_id = v_target.user_id;
	v_result := pg_catalog.jsonb_build_object(
		'membershipId', v_target.id::text,
		'householdId', v_target.household_id::text,
		'userId', v_target.user_id::text,
		'email', v_email,
		'role', v_target.role,
		'status', v_target.status,
		'version', v_target.administration_version,
		'joinedAt', v_target.joined_at,
		'endedAt', v_target.ended_at
	);
	INSERT INTO emdo.household_administration_commands (
		household_id, actor_user_id, actor_session_id, command_kind,
		idempotency_key, request_hash, target_id, result, created_at
	) VALUES (
		v_scope.household_id, v_scope.actor_user_id,
		v_scope.actor_session_id, 'deactivate-membership',
		p_idempotency_key, p_request_hash, p_membership_id, v_result, v_now
	);
	RETURN QUERY SELECT 1, v_target.id, v_target.household_id,
		v_target.user_id, v_email, v_target.role, v_target.status,
		v_target.administration_version, v_target.joined_at,
		v_target.ended_at, false;
END
$function$;
--> statement-breakpoint
