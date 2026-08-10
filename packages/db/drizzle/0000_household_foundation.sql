CREATE EXTENSION IF NOT EXISTS "vector";
--> statement-breakpoint
REVOKE CREATE ON SCHEMA "public" FROM PUBLIC;
--> statement-breakpoint
CREATE SCHEMA "emdo";
--> statement-breakpoint
REVOKE ALL ON SCHEMA "emdo" FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "emdo" REVOKE ALL ON TABLES FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "emdo" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint
DO $roles$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'emdo_app') THEN
		CREATE ROLE emdo_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'emdo_auth') THEN
		CREATE ROLE emdo_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'emdo_worker') THEN
		CREATE ROLE emdo_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'emdo_workflow') THEN
		CREATE ROLE emdo_workflow NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'emdo_policy_reader') THEN
		CREATE ROLE emdo_policy_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$roles$;
--> statement-breakpoint
ALTER ROLE emdo_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_workflow NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_policy_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
--> statement-breakpoint
DO $role_memberships$
DECLARE
	v_runtime_role name;
	v_parent_role name;
BEGIN
	FOR v_runtime_role, v_parent_role IN
		SELECT child.rolname, parent.rolname
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		WHERE child.rolname IN (
			'emdo_app',
			'emdo_auth',
			'emdo_worker',
			'emdo_workflow',
			'emdo_policy_reader'
		)
	LOOP
		EXECUTE pg_catalog.format(
			'REVOKE %I FROM %I',
			v_parent_role,
			v_runtime_role
		);
	END LOOP;

	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE child.rolname IN (
			'emdo_app',
			'emdo_auth',
			'emdo_worker',
			'emdo_workflow',
			'emdo_policy_reader'
		)
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '42501',
			MESSAGE = 'unexpected parent role membership on EMDO foundation role';
	END IF;
END
$role_memberships$;
--> statement-breakpoint
CREATE TABLE "emdo"."action_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"schema_version" smallint DEFAULT 1 NOT NULL,
	"proposal_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"authenticated_session_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"approval_hash" text NOT NULL,
	"decision" text NOT NULL,
	"channel" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "action_decisions_proposal_unique" UNIQUE("proposal_id"),
	CONSTRAINT "action_decisions_scope_id_unique" UNIQUE("household_id","space_id","original_owner_user_id","id"),
	CONSTRAINT "action_decisions_idempotency_unique" UNIQUE("household_id","original_owner_user_id","idempotency_key"),
	CONSTRAINT "action_decisions_schema_version_check" CHECK ("emdo"."action_decisions"."schema_version" = 1),
	CONSTRAINT "action_decisions_decision_check" CHECK ("emdo"."action_decisions"."decision" in ('approved', 'rejected')),
	CONSTRAINT "action_decisions_channel_check" CHECK ("emdo"."action_decisions"."channel" = 'authenticated-visual')
);
--> statement-breakpoint
CREATE TABLE "emdo"."action_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"schema_version" smallint DEFAULT 1 NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"disclosure_grant_id" uuid NOT NULL,
	"capability_id" text NOT NULL,
	"capability_fingerprint" text NOT NULL,
	"canonical_arguments" jsonb NOT NULL,
	"targets" jsonb NOT NULL,
	"before_preview" jsonb NOT NULL,
	"after_preview" jsonb NOT NULL,
	"provider_preconditions" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"approval_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "action_proposals_scope_id_unique" UNIQUE("household_id","space_id","original_owner_user_id","id"),
	CONSTRAINT "action_proposals_idempotency_unique" UNIQUE("household_id","original_owner_user_id","capability_id","idempotency_key"),
	CONSTRAINT "action_proposals_schema_version_check" CHECK ("emdo"."action_proposals"."schema_version" = 1),
	CONSTRAINT "action_proposals_lifetime_check" CHECK ("emdo"."action_proposals"."expires_at" > "emdo"."action_proposals"."created_at" and "emdo"."action_proposals"."expires_at" <= "emdo"."action_proposals"."created_at" + interval '10 minutes'),
	CONSTRAINT "action_proposals_hash_check" CHECK ("emdo"."action_proposals"."payload_hash" ~ '^[a-f0-9]{64}$' and "emdo"."action_proposals"."approval_hash" ~ '^[a-f0-9]{64}$' and "emdo"."action_proposals"."capability_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "emdo"."agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"parent_run_id" uuid,
	"agent_id" text NOT NULL,
	"agent_version" text NOT NULL,
	"requested_model" text NOT NULL,
	"resolved_model" text,
	"model_reason" text,
	"status" text NOT NULL,
	"local_trace_reference" text,
	"safe_error" jsonb,
	"usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_runs_scope_id_unique" UNIQUE("household_id","space_id","original_owner_user_id","id"),
	CONSTRAINT "agent_runs_status_check" CHECK ("emdo"."agent_runs"."status" in ('queued', 'running', 'completed', 'failed', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "emdo"."audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"session_id" uuid,
	"request_id" uuid,
	"run_id" uuid,
	"proposal_id" uuid,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retain_until" timestamp with time zone DEFAULT now() + interval '12 months' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emdo"."auth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_accounts_provider_account_unique" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "emdo"."auth_passkeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"transports" text,
	"aaguid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_passkeys_credential_id_unique" UNIQUE("credential_id"),
	CONSTRAINT "auth_passkeys_counter_nonnegative" CHECK ("emdo"."auth_passkeys"."counter" >= 0)
);
--> statement-breakpoint
CREATE TABLE "emdo"."auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "emdo"."auth_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_users_email_normalized" CHECK ("emdo"."auth_users"."email" = lower("emdo"."auth_users"."email"))
);
--> statement-breakpoint
CREATE TABLE "emdo"."auth_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emdo"."conversation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"client_event_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_after" timestamp with time zone,
	CONSTRAINT "conversation_events_conversation_sequence_unique" UNIQUE("conversation_id","sequence"),
	CONSTRAINT "conversation_events_client_event_unique" UNIQUE("household_id","original_owner_user_id","client_event_id"),
	CONSTRAINT "conversation_events_sequence_positive" CHECK ("emdo"."conversation_events"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "emdo"."disclosure_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"schema_version" smallint DEFAULT 1 NOT NULL,
	"version" integer NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"record_allowlist" jsonb NOT NULL,
	"grant_hash" text NOT NULL,
	"one_run_only" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "disclosure_grants_scope_id_unique" UNIQUE("household_id","space_id","user_id","id"),
	CONSTRAINT "disclosure_grants_schema_version_check" CHECK ("emdo"."disclosure_grants"."schema_version" = 1),
	CONSTRAINT "disclosure_grants_version_positive" CHECK ("emdo"."disclosure_grants"."version" > 0),
	CONSTRAINT "disclosure_grants_one_run_only" CHECK ("emdo"."disclosure_grants"."one_run_only" = true),
	CONSTRAINT "disclosure_grants_lifetime_check" CHECK ("emdo"."disclosure_grants"."expires_at" > "emdo"."disclosure_grants"."created_at"),
	CONSTRAINT "disclosure_grants_terminal_check" CHECK (not ("emdo"."disclosure_grants"."consumed_at" is not null and "emdo"."disclosure_grants"."revoked_at" is not null)),
	CONSTRAINT "disclosure_grants_hash_check" CHECK ("emdo"."disclosure_grants"."grant_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "emdo"."household_memberships" (
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_memberships_pk" PRIMARY KEY("household_id","user_id"),
	CONSTRAINT "household_memberships_role_check" CHECK ("emdo"."household_memberships"."role" in ('owner', 'member')),
	CONSTRAINT "household_memberships_status_check" CHECK ("emdo"."household_memberships"."status" in ('active', 'inactive')),
	CONSTRAINT "household_memberships_ended_status_check" CHECK (("emdo"."household_memberships"."status" = 'active' and "emdo"."household_memberships"."ended_at" is null) or ("emdo"."household_memberships"."status" = 'inactive' and "emdo"."household_memberships"."ended_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "emdo"."households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emdo"."invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_user_id" uuid,
	"consumed_session_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitations_email_normalized" CHECK ("emdo"."invitations"."email" = lower("emdo"."invitations"."email")),
	CONSTRAINT "invitations_role_check" CHECK ("emdo"."invitations"."role" in ('owner', 'member')),
	CONSTRAINT "invitations_lifetime_check" CHECK ("emdo"."invitations"."expires_at" > "emdo"."invitations"."created_at" and "emdo"."invitations"."expires_at" <= "emdo"."invitations"."created_at" + interval '7 days'),
	CONSTRAINT "invitations_terminal_check" CHECK (not ("emdo"."invitations"."consumed_at" is not null and "emdo"."invitations"."revoked_at" is not null)),
	CONSTRAINT "invitations_token_hash_check" CHECK ("emdo"."invitations"."token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "emdo"."memory_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"source_record_id" uuid,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tombstoned_at" timestamp with time zone,
	CONSTRAINT "memory_chunks_content_hash_check" CHECK ("emdo"."memory_chunks"."content_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "emdo"."proposal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"proposal_version" integer NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_events_sequence_unique" UNIQUE("proposal_id","sequence"),
	CONSTRAINT "proposal_events_version_positive" CHECK ("emdo"."proposal_events"."proposal_version" > 0),
	CONSTRAINT "proposal_events_sequence_positive" CHECK ("emdo"."proposal_events"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "emdo"."proposal_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"completion_hash" text NOT NULL,
	"application" text NOT NULL,
	"result_hash" text,
	"evidence_hash" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_reconciliations_attempt_unique" UNIQUE("attempt_id"),
	CONSTRAINT "proposal_reconciliations_application_check" CHECK ("emdo"."proposal_reconciliations"."application" in ('applied', 'not-applied')),
	CONSTRAINT "proposal_reconciliations_completion_hash_check" CHECK ("emdo"."proposal_reconciliations"."completion_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "emdo"."proposal_states" (
	"proposal_id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_states_version_positive" CHECK ("emdo"."proposal_states"."version" > 0),
	CONSTRAINT "proposal_states_state_check" CHECK ("emdo"."proposal_states"."state" in ('pending', 'approved', 'rejected', 'prepared', 'executing', 'executed', 'not-applied', 'indeterminate', 'expired', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "emdo"."provider_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"proposal_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"attempt_version" integer NOT NULL,
	"attempt_state" text DEFAULT 'prepared' NOT NULL,
	"binding_hash" text NOT NULL,
	"capability_fingerprint" text NOT NULL,
	"approval_hash" text NOT NULL,
	"disclosure_grant_id" uuid NOT NULL,
	"disclosure_grant_hash" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_idempotency_key" text NOT NULL,
	"idempotency_expires_at" timestamp with time zone NOT NULL,
	"target_set_hash" text NOT NULL,
	"targets" jsonb NOT NULL,
	"provider_preconditions" jsonb NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"dispatched_at" timestamp with time zone,
	CONSTRAINT "provider_attempts_proposal_unique" UNIQUE("proposal_id"),
	CONSTRAINT "provider_attempts_decision_unique" UNIQUE("decision_id"),
	CONSTRAINT "provider_attempts_scope_id_unique" UNIQUE("household_id","space_id","original_owner_user_id","id"),
	CONSTRAINT "provider_attempts_provider_key_unique" UNIQUE("provider_id","provider_idempotency_key"),
	CONSTRAINT "provider_attempts_version_positive" CHECK ("emdo"."provider_attempts"."attempt_version" > 0),
	CONSTRAINT "provider_attempts_state_check" CHECK ("emdo"."provider_attempts"."attempt_state" in ('prepared', 'dispatching', 'executed', 'not-applied', 'indeterminate')),
	CONSTRAINT "provider_attempts_dispatch_time_check" CHECK (("emdo"."provider_attempts"."attempt_state" = 'prepared' and "emdo"."provider_attempts"."dispatched_at" is null) or ("emdo"."provider_attempts"."attempt_state" <> 'prepared' and "emdo"."provider_attempts"."dispatched_at" is not null)),
	CONSTRAINT "provider_attempts_idempotency_lifetime_check" CHECK ("emdo"."provider_attempts"."idempotency_expires_at" > "emdo"."provider_attempts"."issued_at"),
	CONSTRAINT "provider_attempts_hash_check" CHECK ("emdo"."provider_attempts"."binding_hash" ~ '^[a-f0-9]{64}$' and "emdo"."provider_attempts"."capability_fingerprint" ~ '^[a-f0-9]{64}$' and "emdo"."provider_attempts"."approval_hash" ~ '^[a-f0-9]{64}$' and "emdo"."provider_attempts"."disclosure_grant_hash" ~ '^[a-f0-9]{64}$' and "emdo"."provider_attempts"."provider_idempotency_key" ~ '^[a-f0-9]{64}$' and "emdo"."provider_attempts"."target_set_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "emdo"."provider_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"completion_hash" text NOT NULL,
	"application" text NOT NULL,
	"reason" text,
	"output_status" text,
	"result_hash" text,
	"evidence_hash" text,
	"safe_error_code" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_outcomes_attempt_unique" UNIQUE("attempt_id"),
	CONSTRAINT "provider_outcomes_application_check" CHECK ("emdo"."provider_outcomes"."application" in ('applied', 'not-applied', 'indeterminate')),
	CONSTRAINT "provider_outcomes_completion_hash_check" CHECK ("emdo"."provider_outcomes"."completion_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "emdo"."rotating_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"rotation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "rotating_sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "rotating_sessions_rotation_nonnegative" CHECK ("emdo"."rotating_sessions"."rotation" >= 0),
	CONSTRAINT "rotating_sessions_lifetime_check" CHECK ("emdo"."rotating_sessions"."expires_at" > "emdo"."rotating_sessions"."created_at"),
	CONSTRAINT "rotating_sessions_token_hash_check" CHECK ("emdo"."rotating_sessions"."token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "emdo"."space_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"record_kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"actor_intent" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"tombstoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_records_household_space_id_unique" UNIQUE("household_id","space_id","id"),
	CONSTRAINT "space_records_revision_positive" CHECK ("emdo"."space_records"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "emdo"."spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"visibility" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"tombstoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spaces_household_id_id_unique" UNIQUE("household_id","id"),
	CONSTRAINT "spaces_visibility_check" CHECK ("emdo"."spaces"."visibility" in ('private', 'shared')),
	CONSTRAINT "spaces_revision_positive" CHECK ("emdo"."spaces"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "emdo"."action_decisions" ADD CONSTRAINT "action_decisions_proposal_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","proposal_id") REFERENCES "emdo"."action_proposals"("household_id","space_id","original_owner_user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."action_proposals" ADD CONSTRAINT "action_proposals_household_space_fk" FOREIGN KEY ("household_id","space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."action_proposals" ADD CONSTRAINT "action_proposals_owner_membership_fk" FOREIGN KEY ("household_id","original_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."action_proposals" ADD CONSTRAINT "action_proposals_run_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","run_id") REFERENCES "emdo"."agent_runs"("household_id","space_id","original_owner_user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."action_proposals" ADD CONSTRAINT "action_proposals_disclosure_grant_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","disclosure_grant_id") REFERENCES "emdo"."disclosure_grants"("household_id","space_id","user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."agent_runs" ADD CONSTRAINT "agent_runs_household_space_fk" FOREIGN KEY ("household_id","space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."agent_runs" ADD CONSTRAINT "agent_runs_original_owner_membership_fk" FOREIGN KEY ("household_id","original_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."audit_events" ADD CONSTRAINT "audit_events_household_space_fk" FOREIGN KEY ("household_id","space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."audit_events" ADD CONSTRAINT "audit_events_original_owner_membership_fk" FOREIGN KEY ("household_id","original_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "emdo"."auth_users"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."auth_passkeys" ADD CONSTRAINT "auth_passkeys_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "emdo"."auth_users"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "emdo"."auth_users"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."conversation_events" ADD CONSTRAINT "conversation_events_household_space_fk" FOREIGN KEY ("household_id","space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."conversation_events" ADD CONSTRAINT "conversation_events_original_owner_membership_fk" FOREIGN KEY ("household_id","original_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."disclosure_grants" ADD CONSTRAINT "disclosure_grants_household_space_fk" FOREIGN KEY ("household_id","space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."disclosure_grants" ADD CONSTRAINT "disclosure_grants_user_membership_fk" FOREIGN KEY ("household_id","user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."disclosure_grants" ADD CONSTRAINT "disclosure_grants_run_fk" FOREIGN KEY ("household_id","space_id","user_id","run_id") REFERENCES "emdo"."agent_runs"("household_id","space_id","original_owner_user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."household_memberships" ADD CONSTRAINT "household_memberships_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "emdo"."households"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."household_memberships" ADD CONSTRAINT "household_memberships_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "emdo"."auth_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."households" ADD CONSTRAINT "households_created_by_user_id_auth_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "emdo"."auth_users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."invitations" ADD CONSTRAINT "invitations_issuer_membership_fk" FOREIGN KEY ("household_id","invited_by_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."memory_chunks" ADD CONSTRAINT "memory_chunks_household_space_fk" FOREIGN KEY ("household_id","space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."memory_chunks" ADD CONSTRAINT "memory_chunks_original_owner_membership_fk" FOREIGN KEY ("household_id","original_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."proposal_events" ADD CONSTRAINT "proposal_events_proposal_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","proposal_id") REFERENCES "emdo"."action_proposals"("household_id","space_id","original_owner_user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."proposal_reconciliations" ADD CONSTRAINT "proposal_reconciliations_attempt_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","attempt_id") REFERENCES "emdo"."provider_attempts"("household_id","space_id","original_owner_user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."proposal_states" ADD CONSTRAINT "proposal_states_proposal_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","proposal_id") REFERENCES "emdo"."action_proposals"("household_id","space_id","original_owner_user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."provider_attempts" ADD CONSTRAINT "provider_attempts_proposal_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","proposal_id") REFERENCES "emdo"."action_proposals"("household_id","space_id","original_owner_user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."provider_attempts" ADD CONSTRAINT "provider_attempts_decision_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","decision_id") REFERENCES "emdo"."action_decisions"("household_id","space_id","original_owner_user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."provider_outcomes" ADD CONSTRAINT "provider_outcomes_attempt_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","attempt_id") REFERENCES "emdo"."provider_attempts"("household_id","space_id","original_owner_user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."rotating_sessions" ADD CONSTRAINT "rotating_sessions_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "emdo"."auth_users"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."space_records" ADD CONSTRAINT "space_records_household_space_fk" FOREIGN KEY ("household_id","space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."space_records" ADD CONSTRAINT "space_records_original_owner_membership_fk" FOREIGN KEY ("household_id","original_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."spaces" ADD CONSTRAINT "spaces_original_owner_membership_fk" FOREIGN KEY ("household_id","original_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "action_decisions_household_space_idx" ON "emdo"."action_decisions" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "action_proposals_household_space_idx" ON "emdo"."action_proposals" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "action_proposals_grant_idx" ON "emdo"."action_proposals" USING btree ("household_id","disclosure_grant_id");--> statement-breakpoint
CREATE INDEX "agent_runs_household_space_idx" ON "emdo"."agent_runs" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "agent_runs_household_owner_created_idx" ON "emdo"."agent_runs" USING btree ("household_id","original_owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_household_space_idx" ON "emdo"."audit_events" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "audit_events_household_occurred_idx" ON "emdo"."audit_events" USING btree ("household_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_proposal_id_idx" ON "emdo"."audit_events" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "auth_accounts_user_id_idx" ON "emdo"."auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_passkeys_user_id_idx" ON "emdo"."auth_passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_idx" ON "emdo"."auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_at_idx" ON "emdo"."auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_users_email_unique" ON "emdo"."auth_users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "emdo"."auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "auth_verifications_expires_at_idx" ON "emdo"."auth_verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "conversation_events_household_space_idx" ON "emdo"."conversation_events" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "conversation_events_conversation_idx" ON "emdo"."conversation_events" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE INDEX "disclosure_grants_household_space_idx" ON "emdo"."disclosure_grants" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "disclosure_grants_user_expiry_idx" ON "emdo"."disclosure_grants" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "household_memberships_user_id_idx" ON "emdo"."household_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "household_memberships_active_idx" ON "emdo"."household_memberships" USING btree ("household_id","user_id","status");--> statement-breakpoint
CREATE INDEX "households_created_by_user_id_idx" ON "emdo"."households" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "invitations_household_email_idx" ON "emdo"."invitations" USING btree ("household_id","email");--> statement-breakpoint
CREATE INDEX "invitations_expires_at_idx" ON "emdo"."invitations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "memory_chunks_household_space_idx" ON "emdo"."memory_chunks" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "memory_chunks_source_record_idx" ON "emdo"."memory_chunks" USING btree ("source_record_id");--> statement-breakpoint
CREATE INDEX "proposal_events_household_space_idx" ON "emdo"."proposal_events" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "proposal_reconciliations_household_space_idx" ON "emdo"."proposal_reconciliations" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "proposal_states_household_space_idx" ON "emdo"."proposal_states" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "provider_attempts_household_space_idx" ON "emdo"."provider_attempts" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "provider_attempts_decision_idx" ON "emdo"."provider_attempts" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "provider_outcomes_household_space_idx" ON "emdo"."provider_outcomes" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "rotating_sessions_user_id_idx" ON "emdo"."rotating_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rotating_sessions_expires_at_idx" ON "emdo"."rotating_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "space_records_household_space_idx" ON "emdo"."space_records" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "space_records_household_owner_idx" ON "emdo"."space_records" USING btree ("household_id","original_owner_user_id");--> statement-breakpoint
CREATE INDEX "space_records_kind_created_idx" ON "emdo"."space_records" USING btree ("record_kind","created_at");--> statement-breakpoint
CREATE INDEX "spaces_household_owner_idx" ON "emdo"."spaces" USING btree ("household_id","original_owner_user_id");--> statement-breakpoint
CREATE INDEX "spaces_household_visibility_idx" ON "emdo"."spaces" USING btree ("household_id","visibility");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."current_user_id"()
RETURNS uuid
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
BEGIN
	RETURN NULLIF(pg_catalog.current_setting('emdo.user_id', true), '')::uuid;
EXCEPTION WHEN invalid_text_representation THEN
	RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."current_session_id"()
RETURNS uuid
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
BEGIN
	RETURN NULLIF(pg_catalog.current_setting('emdo.session_id', true), '')::uuid;
EXCEPTION WHEN invalid_text_representation THEN
	RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."current_request_id"()
RETURNS uuid
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
BEGIN
	RETURN NULLIF(pg_catalog.current_setting('emdo.request_id', true), '')::uuid;
EXCEPTION WHEN invalid_text_representation THEN
	RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."is_active_member"(p_household_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo, pg_temp
AS $function$
	SELECT EXISTS (
		SELECT 1
		FROM emdo.household_memberships AS membership
		WHERE membership.household_id = p_household_id
		  AND membership.user_id = emdo.current_user_id()
		  AND membership.status = 'active'
	)
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."is_household_owner"(p_household_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo, pg_temp
AS $function$
	SELECT EXISTS (
		SELECT 1
		FROM emdo.household_memberships AS membership
		WHERE membership.household_id = p_household_id
		  AND membership.user_id = emdo.current_user_id()
		  AND membership.status = 'active'
		  AND membership.role = 'owner'
	)
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."can_access_space"(
	p_household_id uuid,
	p_space_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo, pg_temp
AS $function$
	SELECT EXISTS (
		SELECT 1
		FROM emdo.spaces AS space
		WHERE space.household_id = p_household_id
		  AND space.id = p_space_id
		  AND space.tombstoned_at IS NULL
		  AND emdo.is_active_member(space.household_id)
		  AND (
			space.visibility = 'shared'
			OR space.original_owner_user_id = emdo.current_user_id()
		  )
	)
$function$;
--> statement-breakpoint
ALTER FUNCTION "emdo"."is_active_member"(uuid) OWNER TO emdo_policy_reader;
--> statement-breakpoint
ALTER FUNCTION "emdo"."is_household_owner"(uuid) OWNER TO emdo_policy_reader;
--> statement-breakpoint
ALTER FUNCTION "emdo"."can_access_space"(uuid, uuid) OWNER TO emdo_policy_reader;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."reject_append_only_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
	RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'append-only row cannot be changed';
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."protect_scoped_identity"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
	old_row jsonb := pg_catalog.to_jsonb(OLD);
	new_row jsonb := pg_catalog.to_jsonb(NEW);
BEGIN
	IF new_row ->> 'household_id' IS DISTINCT FROM old_row ->> 'household_id'
	   OR new_row ->> 'space_id' IS DISTINCT FROM old_row ->> 'space_id'
	   OR COALESCE(new_row ->> 'original_owner_user_id', new_row ->> 'user_id')
	      IS DISTINCT FROM
	      COALESCE(old_row ->> 'original_owner_user_id', old_row ->> 'user_id')
	THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'scope identity is immutable';
	END IF;
	RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."enforce_proposal_state_transition"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
	IF NEW.proposal_id <> OLD.proposal_id
	   OR NEW.household_id <> OLD.household_id
	   OR NEW.space_id <> OLD.space_id
	   OR NEW.original_owner_user_id <> OLD.original_owner_user_id
	   OR NEW.version <> OLD.version + 1
	THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid proposal state compare-and-set';
	END IF;
	IF NOT (
		(OLD.state = 'pending' AND NEW.state IN ('approved', 'rejected', 'expired'))
		OR (OLD.state = 'approved' AND NEW.state IN ('prepared', 'expired'))
		OR (OLD.state = 'prepared' AND NEW.state IN ('executing', 'not-applied'))
		OR (OLD.state = 'executing' AND NEW.state IN ('executed', 'not-applied', 'indeterminate', 'failed'))
		OR (OLD.state = 'indeterminate' AND NEW.state IN ('executed', 'not-applied'))
	) THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid proposal state transition';
	END IF;
	NEW.updated_at := pg_catalog.clock_timestamp();
	RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."enforce_provider_attempt_transition"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
	IF (pg_catalog.to_jsonb(NEW) - 'attempt_state' - 'dispatched_at')
	   IS DISTINCT FROM
	   (pg_catalog.to_jsonb(OLD) - 'attempt_state' - 'dispatched_at')
	THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider attempt binding is immutable';
	END IF;
	IF NOT (
		(OLD.attempt_state = 'prepared' AND NEW.attempt_state IN ('dispatching', 'not-applied'))
		OR (OLD.attempt_state = 'dispatching' AND NEW.attempt_state IN ('executed', 'not-applied', 'indeterminate'))
		OR (OLD.attempt_state = 'indeterminate' AND NEW.attempt_state IN ('executed', 'not-applied'))
	) THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid provider attempt transition';
	END IF;
	RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON "emdo"."audit_events"
FOR EACH ROW EXECUTE FUNCTION "emdo"."reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER conversation_events_append_only BEFORE UPDATE OR DELETE ON "emdo"."conversation_events"
FOR EACH ROW EXECUTE FUNCTION "emdo"."reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER action_decisions_append_only BEFORE UPDATE OR DELETE ON "emdo"."action_decisions"
FOR EACH ROW EXECUTE FUNCTION "emdo"."reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER proposal_events_append_only BEFORE UPDATE OR DELETE ON "emdo"."proposal_events"
FOR EACH ROW EXECUTE FUNCTION "emdo"."reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER provider_outcomes_append_only BEFORE UPDATE OR DELETE ON "emdo"."provider_outcomes"
FOR EACH ROW EXECUTE FUNCTION "emdo"."reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER proposal_reconciliations_append_only BEFORE UPDATE OR DELETE ON "emdo"."proposal_reconciliations"
FOR EACH ROW EXECUTE FUNCTION "emdo"."reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER spaces_scope_immutable BEFORE UPDATE ON "emdo"."spaces"
FOR EACH ROW EXECUTE FUNCTION "emdo"."protect_scoped_identity"();
--> statement-breakpoint
CREATE TRIGGER space_records_scope_immutable BEFORE UPDATE ON "emdo"."space_records"
FOR EACH ROW EXECUTE FUNCTION "emdo"."protect_scoped_identity"();
--> statement-breakpoint
CREATE TRIGGER proposal_states_transition BEFORE UPDATE ON "emdo"."proposal_states"
FOR EACH ROW EXECUTE FUNCTION "emdo"."enforce_proposal_state_transition"();
--> statement-breakpoint
CREATE TRIGGER provider_attempts_transition BEFORE UPDATE ON "emdo"."provider_attempts"
FOR EACH ROW EXECUTE FUNCTION "emdo"."enforce_provider_attempt_transition"();
--> statement-breakpoint
ALTER TABLE "emdo"."households" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."households" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."household_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."household_memberships" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."spaces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."spaces" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."space_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."space_records" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."conversation_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."conversation_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."audit_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."agent_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."agent_runs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."disclosure_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."disclosure_grants" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."action_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."action_proposals" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."proposal_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."proposal_states" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."action_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."action_decisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."provider_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."provider_attempts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."provider_outcomes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."provider_outcomes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."proposal_reconciliations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."proposal_reconciliations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."proposal_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."proposal_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."memory_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."memory_chunks" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."invitations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."rotating_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."rotating_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY household_memberships_policy_reader ON "emdo"."household_memberships"
FOR SELECT TO emdo_policy_reader USING (true);
CREATE POLICY spaces_policy_reader ON "emdo"."spaces"
FOR SELECT TO emdo_policy_reader USING (true);
--> statement-breakpoint
CREATE POLICY households_read ON "emdo"."households"
FOR SELECT TO emdo_app, emdo_worker, emdo_workflow
USING ("emdo"."is_active_member"("id"));
CREATE POLICY memberships_read ON "emdo"."household_memberships"
FOR SELECT TO emdo_app, emdo_worker, emdo_workflow
USING (
	"user_id" = "emdo"."current_user_id"()
	OR "emdo"."is_household_owner"("household_id")
);
CREATE POLICY spaces_read ON "emdo"."spaces"
FOR SELECT TO emdo_app, emdo_worker, emdo_workflow
USING ("emdo"."can_access_space"("household_id", "id"));
CREATE POLICY spaces_insert ON "emdo"."spaces"
FOR INSERT TO emdo_app, emdo_worker, emdo_workflow
WITH CHECK (
	"emdo"."is_active_member"("household_id")
	AND "original_owner_user_id" = "emdo"."current_user_id"()
);
CREATE POLICY spaces_update ON "emdo"."spaces"
FOR UPDATE TO emdo_app, emdo_worker, emdo_workflow
USING (
	"emdo"."can_access_space"("household_id", "id")
	AND "original_owner_user_id" = "emdo"."current_user_id"()
)
WITH CHECK (
	"emdo"."can_access_space"("household_id", "id")
	AND "original_owner_user_id" = "emdo"."current_user_id"()
);
--> statement-breakpoint
CREATE POLICY space_records_scope ON "emdo"."space_records"
FOR ALL TO emdo_app, emdo_worker, emdo_workflow
USING ("emdo"."can_access_space"("household_id", "space_id"))
WITH CHECK (
	"emdo"."can_access_space"("household_id", "space_id")
	AND "original_owner_user_id" = "emdo"."current_user_id"()
);
CREATE POLICY conversation_events_scope ON "emdo"."conversation_events"
FOR ALL TO emdo_app, emdo_worker, emdo_workflow
USING ("emdo"."can_access_space"("household_id", "space_id"))
WITH CHECK (
	"emdo"."can_access_space"("household_id", "space_id")
	AND "original_owner_user_id" = "emdo"."current_user_id"()
);
CREATE POLICY audit_events_scope ON "emdo"."audit_events"
FOR ALL TO emdo_app, emdo_worker, emdo_workflow
USING ("emdo"."can_access_space"("household_id", "space_id"))
WITH CHECK (
	"emdo"."can_access_space"("household_id", "space_id")
	AND "original_owner_user_id" = "emdo"."current_user_id"()
	AND "actor_user_id" = "emdo"."current_user_id"()
);
CREATE POLICY agent_runs_scope ON "emdo"."agent_runs"
FOR ALL TO emdo_app, emdo_worker, emdo_workflow
USING ("emdo"."can_access_space"("household_id", "space_id"))
WITH CHECK (
	"emdo"."can_access_space"("household_id", "space_id")
	AND "original_owner_user_id" = "emdo"."current_user_id"()
);
CREATE POLICY disclosure_grants_scope ON "emdo"."disclosure_grants"
FOR ALL TO emdo_app, emdo_worker, emdo_workflow
USING (
	"emdo"."can_access_space"("household_id", "space_id")
	AND "user_id" = "emdo"."current_user_id"()
)
WITH CHECK (
	"emdo"."can_access_space"("household_id", "space_id")
	AND "user_id" = "emdo"."current_user_id"()
);
CREATE POLICY action_proposals_scope ON "emdo"."action_proposals"
FOR ALL TO emdo_app, emdo_worker, emdo_workflow
USING ("emdo"."can_access_space"("household_id", "space_id"))
WITH CHECK (
	"emdo"."can_access_space"("household_id", "space_id")
	AND "original_owner_user_id" = "emdo"."current_user_id"()
);
CREATE POLICY proposal_states_scope ON "emdo"."proposal_states"
FOR ALL TO emdo_app, emdo_worker, emdo_workflow
USING ("emdo"."can_access_space"("household_id", "space_id"))
WITH CHECK (
	"emdo"."can_access_space"("household_id", "space_id")
	AND "original_owner_user_id" = "emdo"."current_user_id"()
);
CREATE POLICY action_decisions_scope ON "emdo"."action_decisions"
FOR ALL TO emdo_app, emdo_worker, emdo_workflow
USING ("emdo"."can_access_space"("household_id", "space_id"))
WITH CHECK (
	"emdo"."can_access_space"("household_id", "space_id")
	AND "original_owner_user_id" = "emdo"."current_user_id"()
);
CREATE POLICY provider_attempts_scope ON "emdo"."provider_attempts"
FOR ALL TO emdo_app, emdo_worker, emdo_workflow
USING ("emdo"."can_access_space"("household_id", "space_id"))
WITH CHECK (
	"emdo"."can_access_space"("household_id", "space_id")
	AND "original_owner_user_id" = "emdo"."current_user_id"()
);
CREATE POLICY provider_outcomes_scope ON "emdo"."provider_outcomes"
FOR ALL TO emdo_app, emdo_worker, emdo_workflow
USING ("emdo"."can_access_space"("household_id", "space_id"))
WITH CHECK (
	"emdo"."can_access_space"("household_id", "space_id")
	AND "original_owner_user_id" = "emdo"."current_user_id"()
);
CREATE POLICY proposal_reconciliations_scope ON "emdo"."proposal_reconciliations"
FOR ALL TO emdo_app, emdo_worker, emdo_workflow
USING ("emdo"."can_access_space"("household_id", "space_id"))
WITH CHECK (
	"emdo"."can_access_space"("household_id", "space_id")
	AND "original_owner_user_id" = "emdo"."current_user_id"()
);
CREATE POLICY proposal_events_scope ON "emdo"."proposal_events"
FOR ALL TO emdo_app, emdo_worker, emdo_workflow
USING ("emdo"."can_access_space"("household_id", "space_id"))
WITH CHECK (
	"emdo"."can_access_space"("household_id", "space_id")
	AND "original_owner_user_id" = "emdo"."current_user_id"()
);
CREATE POLICY memory_chunks_scope ON "emdo"."memory_chunks"
FOR ALL TO emdo_app, emdo_worker, emdo_workflow
USING ("emdo"."can_access_space"("household_id", "space_id"))
WITH CHECK (
	"emdo"."can_access_space"("household_id", "space_id")
	AND "original_owner_user_id" = "emdo"."current_user_id"()
);
--> statement-breakpoint
CREATE POLICY invitations_owner_read ON "emdo"."invitations"
FOR SELECT TO emdo_app
USING ("emdo"."is_household_owner"("household_id"));
CREATE POLICY invitations_owner_insert ON "emdo"."invitations"
FOR INSERT TO emdo_app
WITH CHECK (
	"emdo"."is_household_owner"("household_id")
	AND "invited_by_user_id" = "emdo"."current_user_id"()
);
CREATE POLICY invitations_owner_update ON "emdo"."invitations"
FOR UPDATE TO emdo_app
USING (
	"emdo"."is_household_owner"("household_id")
	AND "invited_by_user_id" = "emdo"."current_user_id"()
)
WITH CHECK (
	"emdo"."is_household_owner"("household_id")
	AND "invited_by_user_id" = "emdo"."current_user_id"()
);
CREATE POLICY invitations_auth_service ON "emdo"."invitations"
FOR ALL TO emdo_auth USING (true) WITH CHECK (true);
CREATE POLICY rotating_sessions_auth_service ON "emdo"."rotating_sessions"
FOR ALL TO emdo_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT USAGE ON SCHEMA "emdo" TO emdo_app, emdo_auth, emdo_worker, emdo_workflow, emdo_policy_reader;
GRANT SELECT ON "emdo"."household_memberships", "emdo"."spaces" TO emdo_policy_reader;
GRANT SELECT ON "emdo"."households", "emdo"."household_memberships", "emdo"."spaces",
	"emdo"."space_records", "emdo"."conversation_events", "emdo"."audit_events",
	"emdo"."agent_runs", "emdo"."disclosure_grants", "emdo"."action_proposals",
	"emdo"."proposal_states", "emdo"."action_decisions", "emdo"."provider_attempts",
	"emdo"."provider_outcomes", "emdo"."proposal_reconciliations",
	"emdo"."proposal_events", "emdo"."memory_chunks" TO emdo_app, emdo_worker;
GRANT INSERT, UPDATE ON "emdo"."spaces", "emdo"."space_records" TO emdo_app, emdo_worker;
GRANT INSERT ON "emdo"."conversation_events", "emdo"."audit_events", "emdo"."agent_runs",
	"emdo"."disclosure_grants", "emdo"."action_proposals", "emdo"."action_decisions"
	TO emdo_app, emdo_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON "emdo"."auth_users", "emdo"."auth_sessions",
	"emdo"."auth_accounts", "emdo"."auth_verifications", "emdo"."auth_passkeys"
	TO emdo_auth;
GRANT SELECT, INSERT, UPDATE ON "emdo"."invitations", "emdo"."rotating_sessions"
	TO emdo_auth;
GRANT SELECT, INSERT, UPDATE ON "emdo"."proposal_states", "emdo"."provider_attempts"
	TO emdo_workflow;
GRANT SELECT, INSERT ON "emdo"."proposal_events", "emdo"."provider_outcomes",
	"emdo"."proposal_reconciliations", "emdo"."audit_events" TO emdo_workflow;
REVOKE ALL ON ALL TABLES IN SCHEMA "emdo" FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "emdo" FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "emdo" FROM PUBLIC;
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON ALL TABLES IN SCHEMA "emdo"
	FROM emdo_app, emdo_auth, emdo_worker, emdo_workflow, emdo_policy_reader;
GRANT EXECUTE ON FUNCTION "emdo"."current_user_id"(),
	"emdo"."current_session_id"(), "emdo"."current_request_id"(),
	"emdo"."is_active_member"(uuid), "emdo"."is_household_owner"(uuid),
	"emdo"."can_access_space"(uuid, uuid)
	TO emdo_app, emdo_worker, emdo_workflow, emdo_policy_reader;
