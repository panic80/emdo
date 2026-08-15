CREATE TABLE "emdo"."agent_run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_run_events_run_sequence_unique" UNIQUE("run_id","sequence"),
	CONSTRAINT "agent_run_events_sequence_positive" CHECK ("emdo"."agent_run_events"."sequence" > 0),
	CONSTRAINT "agent_run_events_retention_check" CHECK ("emdo"."agent_run_events"."retain_until" > "emdo"."agent_run_events"."occurred_at" and "emdo"."agent_run_events"."retain_until" <= "emdo"."agent_run_events"."occurred_at" + interval '90 days')
);
--> statement-breakpoint
CREATE TABLE "emdo"."ai_spend_reservations" (
	"reservation_id" text PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"authorized_user_id" uuid NOT NULL,
	"period" text NOT NULL,
	"category" text NOT NULL,
	"execution_id" text NOT NULL,
	"authorization_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"estimated_cad_minor" bigint NOT NULL,
	"actual_cad_minor" bigint,
	"decision_cad_minor" bigint NOT NULL,
	"warning" boolean NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"dispatched_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_spend_reservations_request_unique" UNIQUE("household_id","period","request_hash"),
	CONSTRAINT "ai_spend_reservations_period_check" CHECK ("emdo"."ai_spend_reservations"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "ai_spend_reservations_category_check" CHECK ("emdo"."ai_spend_reservations"."category" in ('model', 'audio')),
	CONSTRAINT "ai_spend_reservations_state_check" CHECK ("emdo"."ai_spend_reservations"."state" in ('blocked', 'reserved', 'dispatched', 'released', 'settled')),
	CONSTRAINT "ai_spend_reservations_amount_check" CHECK ("emdo"."ai_spend_reservations"."estimated_cad_minor" > 0 and "emdo"."ai_spend_reservations"."decision_cad_minor" >= 0 and ("emdo"."ai_spend_reservations"."actual_cad_minor" is null or "emdo"."ai_spend_reservations"."actual_cad_minor" >= 0)),
	CONSTRAINT "ai_spend_reservations_hash_check" CHECK ("emdo"."ai_spend_reservations"."authorization_hash" ~ '^[a-f0-9]{64}$' and "emdo"."ai_spend_reservations"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "ai_spend_reservations_retention_check" CHECK ("emdo"."ai_spend_reservations"."retain_until" > "emdo"."ai_spend_reservations"."created_at" and "emdo"."ai_spend_reservations"."retain_until" <= "emdo"."ai_spend_reservations"."created_at" + interval '90 days')
);
--> statement-breakpoint
CREATE TABLE "emdo"."approval_checkpoints" (
	"checkpoint_id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"format_version" smallint NOT NULL,
	"revision" integer NOT NULL,
	"state" text NOT NULL,
	"agent_graph_hash" text NOT NULL,
	"sdk_version" text NOT NULL,
	"sealed_state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "approval_checkpoints_state_check" CHECK ("emdo"."approval_checkpoints"."state" in ('pending', 'resumed', 'cancelled', 'expired')),
	CONSTRAINT "approval_checkpoints_lifetime_check" CHECK ("emdo"."approval_checkpoints"."expires_at" > "emdo"."approval_checkpoints"."created_at" and "emdo"."approval_checkpoints"."expires_at" <= "emdo"."approval_checkpoints"."created_at" + interval '10 minutes'),
	CONSTRAINT "approval_checkpoints_hash_check" CHECK ("emdo"."approval_checkpoints"."agent_graph_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "approval_checkpoints_retention_check" CHECK ("emdo"."approval_checkpoints"."retain_until" > "emdo"."approval_checkpoints"."created_at" and "emdo"."approval_checkpoints"."retain_until" <= "emdo"."approval_checkpoints"."created_at" + interval '90 days')
);
--> statement-breakpoint
CREATE TABLE "emdo"."scheduler_execution_receipts" (
	"receipt_key" text PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"command_hash" text NOT NULL,
	"state" text NOT NULL,
	"result" jsonb,
	"reconciliation_required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "scheduler_execution_receipts_hash_check" CHECK ("emdo"."scheduler_execution_receipts"."receipt_key" ~ '^[a-f0-9]{64}$' and "emdo"."scheduler_execution_receipts"."command_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "scheduler_execution_receipts_state_check" CHECK ("emdo"."scheduler_execution_receipts"."state" in ('pending', 'completed')),
	CONSTRAINT "scheduler_execution_receipts_retention_check" CHECK ("emdo"."scheduler_execution_receipts"."retain_until" > "emdo"."scheduler_execution_receipts"."created_at" and "emdo"."scheduler_execution_receipts"."retain_until" <= "emdo"."scheduler_execution_receipts"."created_at" + interval '90 days')
);
--> statement-breakpoint
CREATE TABLE "emdo"."sync_clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sync_clients_scope_id_unique" UNIQUE("household_id","user_id","id")
);
--> statement-breakpoint
CREATE TABLE "emdo"."sync_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"actor_intent" text NOT NULL,
	"revision" integer NOT NULL,
	"tombstoned_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sync_entities_scope_entity_unique" UNIQUE("household_id","space_id","entity_type","entity_id"),
	CONSTRAINT "sync_entities_revision_positive" CHECK ("emdo"."sync_entities"."revision" > 0),
	CONSTRAINT "sync_entities_entity_type_check" CHECK ("emdo"."sync_entities"."entity_type" in ('conversation.event', 'scheduler.item', 'scheduler.task', 'scheduler.reminder', 'scheduler.chore', 'scheduler.routine', 'finance.account', 'finance.transaction', 'finance.category', 'finance.budget', 'finance.bill', 'finance.subscription', 'finance.goal', 'shopping.list', 'shopping.item', 'shopping.preference')),
	CONSTRAINT "sync_entities_entity_id_check" CHECK (pg_catalog.length("emdo"."sync_entities"."entity_id") between 1 and 512 and "emdo"."sync_entities"."entity_id" !~ '[[:cntrl:]]'),
	CONSTRAINT "sync_entities_actor_intent_check" CHECK (pg_catalog.length("emdo"."sync_entities"."actor_intent") between 3 and 1000 and pg_catalog.btrim("emdo"."sync_entities"."actor_intent") = "emdo"."sync_entities"."actor_intent"),
	CONSTRAINT "sync_entities_payload_size_check" CHECK (pg_catalog.octet_length("emdo"."sync_entities"."payload"::text) between 2 and 1048576)
);
--> statement-breakpoint
CREATE TABLE "emdo"."sync_operation_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"mutation_kind" text NOT NULL,
	"base_revision" integer NOT NULL,
	"outcome_status" text NOT NULL,
	"outcome_code" text,
	"current_revision" integer,
	"resulting_revision" integer,
	"recorded_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "sync_operation_receipts_client_operation_unique" UNIQUE("client_id","operation_id"),
	CONSTRAINT "sync_operation_receipts_fingerprint_check" CHECK ("emdo"."sync_operation_receipts"."fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "sync_operation_receipts_outcome_check" CHECK ("emdo"."sync_operation_receipts"."outcome_status" in ('applied', 'conflict')),
	CONSTRAINT "sync_operation_receipts_retention_check" CHECK ("emdo"."sync_operation_receipts"."retain_until" > "emdo"."sync_operation_receipts"."recorded_at" and "emdo"."sync_operation_receipts"."retain_until" <= "emdo"."sync_operation_receipts"."recorded_at" + interval '90 days')
);
--> statement-breakpoint
ALTER TABLE "emdo"."agent_run_events" ADD CONSTRAINT "agent_run_events_run_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","run_id") REFERENCES "emdo"."agent_runs"("household_id","space_id","original_owner_user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."ai_spend_reservations" ADD CONSTRAINT "ai_spend_reservations_user_membership_fk" FOREIGN KEY ("household_id","authorized_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."approval_checkpoints" ADD CONSTRAINT "approval_checkpoints_run_fk" FOREIGN KEY ("household_id","space_id","user_id","run_id") REFERENCES "emdo"."agent_runs"("household_id","space_id","original_owner_user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."scheduler_execution_receipts" ADD CONSTRAINT "scheduler_execution_receipts_run_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","run_id") REFERENCES "emdo"."agent_runs"("household_id","space_id","original_owner_user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."sync_clients" ADD CONSTRAINT "sync_clients_user_membership_fk" FOREIGN KEY ("household_id","user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."sync_entities" ADD CONSTRAINT "sync_entities_household_space_fk" FOREIGN KEY ("household_id","space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."sync_entities" ADD CONSTRAINT "sync_entities_owner_membership_fk" FOREIGN KEY ("household_id","original_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."sync_operation_receipts" ADD CONSTRAINT "sync_operation_receipts_client_fk" FOREIGN KEY ("household_id","original_owner_user_id","client_id") REFERENCES "emdo"."sync_clients"("household_id","user_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."sync_operation_receipts" ADD CONSTRAINT "sync_operation_receipts_household_space_fk" FOREIGN KEY ("household_id","space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "agent_run_events_household_space_idx" ON "emdo"."agent_run_events" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "agent_run_events_run_idx" ON "emdo"."agent_run_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "ai_spend_reservations_household_period_idx" ON "emdo"."ai_spend_reservations" USING btree ("household_id","period","state");--> statement-breakpoint
CREATE INDEX "approval_checkpoints_household_space_idx" ON "emdo"."approval_checkpoints" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "approval_checkpoints_user_expiry_idx" ON "emdo"."approval_checkpoints" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "scheduler_execution_receipts_household_space_idx" ON "emdo"."scheduler_execution_receipts" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "scheduler_execution_receipts_reconciliation_idx" ON "emdo"."scheduler_execution_receipts" USING btree ("household_id","reconciliation_required","updated_at");--> statement-breakpoint
CREATE INDEX "sync_clients_user_active_idx" ON "emdo"."sync_clients" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "sync_entities_household_space_idx" ON "emdo"."sync_entities" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "sync_operation_receipts_household_space_idx" ON "emdo"."sync_operation_receipts" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "sync_operation_receipts_client_recorded_idx" ON "emdo"."sync_operation_receipts" USING btree ("client_id","recorded_at");
--> statement-breakpoint
ALTER TABLE "emdo"."agent_runs" ADD COLUMN "retain_until" timestamp with time zone;
UPDATE "emdo"."agent_runs"
	SET "retain_until" = "created_at" + interval '90 days'
	WHERE "retain_until" IS NULL;
ALTER TABLE "emdo"."agent_runs"
	ALTER COLUMN "retain_until" SET DEFAULT (now() + interval '90 days'),
	ALTER COLUMN "retain_until" SET NOT NULL,
	ADD CONSTRAINT "agent_runs_retention_check"
		CHECK ("retain_until" > "created_at" AND "retain_until" <= "created_at" + interval '90 days');
--> statement-breakpoint
ALTER TABLE "emdo"."approval_checkpoints"
	ADD CONSTRAINT "approval_checkpoints_format_revision_check"
		CHECK ("format_version" = 1 AND "revision" > 0),
	ADD CONSTRAINT "approval_checkpoints_sealed_state_size_check"
		CHECK (pg_catalog.octet_length("sealed_state") BETWEEN 1 AND 1400000);
--> statement-breakpoint
ALTER TABLE "emdo"."ai_spend_reservations"
	ALTER COLUMN "retain_until" SET DEFAULT (pg_catalog.clock_timestamp() + interval '90 days');
ALTER TABLE "emdo"."approval_checkpoints"
	ALTER COLUMN "retain_until" SET DEFAULT (pg_catalog.clock_timestamp() + interval '90 days');
ALTER TABLE "emdo"."agent_run_events"
	ALTER COLUMN "retain_until" SET DEFAULT (pg_catalog.clock_timestamp() + interval '90 days');
ALTER TABLE "emdo"."sync_operation_receipts"
	ALTER COLUMN "retain_until" SET DEFAULT (pg_catalog.clock_timestamp() + interval '90 days');
ALTER TABLE "emdo"."scheduler_execution_receipts"
	ALTER COLUMN "retain_until" SET DEFAULT (pg_catalog.clock_timestamp() + interval '90 days');
--> statement-breakpoint
DO $roles$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_metering_executor'
	) THEN
		CREATE ROLE emdo_metering_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$roles$;
--> statement-breakpoint
ALTER ROLE emdo_metering_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
--> statement-breakpoint
DO $membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname = 'emdo_metering_executor'
			OR child.rolname = 'emdo_metering_executor'
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'metering executor must not have role memberships';
	END IF;
END
$membership_guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."lock_active_request_scope"(
	p_household_id uuid,
	p_space_id uuid DEFAULT NULL,
	p_client_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_user_id uuid;
	v_session_id uuid;
	v_request_id uuid;
BEGIN
	v_user_id := emdo.current_user_id();
	v_session_id := emdo.current_session_id();
	v_request_id := emdo.current_request_id();
	IF p_household_id IS NULL OR v_user_id IS NULL OR v_session_id IS NULL
		OR v_request_id IS NULL
	THEN
		RETURN false;
	END IF;

	PERFORM 1
	FROM emdo.auth_sessions AS session
	JOIN emdo.auth_users AS account_user
		ON account_user.id = session.user_id
	JOIN emdo.household_memberships AS membership
		ON membership.household_id = p_household_id
		AND membership.user_id = session.user_id
	WHERE session.id = v_session_id
		AND session.user_id = v_user_id
		AND session.active_household_id = p_household_id
		AND session.expires_at > pg_catalog.clock_timestamp()
		AND account_user.email_verified = true
		AND membership.status = 'active';
	IF NOT FOUND THEN
		RETURN false;
	END IF;

	IF p_space_id IS NOT NULL THEN
		PERFORM 1
		FROM emdo.spaces AS space
		WHERE space.household_id = p_household_id
			AND space.id = p_space_id
			AND space.tombstoned_at IS NULL
			AND (
				space.visibility = 'shared'
				OR space.original_owner_user_id = v_user_id
			)
		FOR SHARE OF space;
		IF NOT FOUND THEN
			RETURN false;
		END IF;
	END IF;

	IF p_client_id IS NOT NULL THEN
		PERFORM 1
		FROM emdo.sync_clients AS client
		WHERE client.id = p_client_id
			AND client.household_id = p_household_id
			AND client.user_id = v_user_id
			AND client.revoked_at IS NULL
		FOR SHARE OF client;
		IF NOT FOUND THEN
			RETURN false;
		END IF;
	END IF;

	RETURN true;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."claim_due_worker_outbox"(
	p_dispatcher_id text,
	p_limit integer,
	p_lease_ms integer
)
RETURNS TABLE (
	outbox_id uuid,
	job_name text,
	payload jsonb,
	payload_hash text,
	start_after timestamptz,
	lease_token uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
BEGIN
	IF p_dispatcher_id IS NULL
		OR pg_catalog.btrim(p_dispatcher_id) <> p_dispatcher_id
		OR pg_catalog.length(p_dispatcher_id) NOT BETWEEN 1 AND 512
		OR p_dispatcher_id ~ '[[:cntrl:]]'
		OR p_limit NOT BETWEEN 1 AND 100
		OR p_lease_ms NOT BETWEEN 1000 AND 300000
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '22023',
			MESSAGE = 'invalid worker outbox claim';
	END IF;

	RETURN QUERY
	WITH database_time AS (
		SELECT pg_catalog.clock_timestamp() AS now
	), candidates AS (
		SELECT candidate.outbox_id
		FROM emdo.worker_operation_outbox AS candidate
		CROSS JOIN database_time
		WHERE candidate.dispatch_attempts < 20
			AND (
				(candidate.state IN ('pending', 'dispatch-failed')
					AND candidate.available_at <= database_time.now
					AND candidate.safe_code IS DISTINCT FROM 'invalid-operation')
				OR (candidate.state = 'leased'
					AND candidate.lease_expires_at <= database_time.now)
			)
		ORDER BY candidate.available_at, candidate.created_at, candidate.outbox_id
		FOR UPDATE OF candidate SKIP LOCKED
		LIMIT p_limit
	), claimed AS (
		UPDATE emdo.worker_operation_outbox AS claimed
		SET state = 'leased',
			lease_token = pg_catalog.gen_random_uuid(),
			lease_owner = p_dispatcher_id,
			lease_expires_at = database_time.now + p_lease_ms * interval '1 millisecond',
			dispatch_attempts = claimed.dispatch_attempts + 1,
			safe_code = NULL,
			updated_at = database_time.now
		FROM candidates CROSS JOIN database_time
		WHERE claimed.outbox_id = candidates.outbox_id
		RETURNING claimed.outbox_id, claimed.job_name, claimed.payload,
			claimed.payload_hash,
			claimed.available_at, claimed.lease_token
	)
	SELECT claimed.outbox_id, claimed.job_name, claimed.payload,
		claimed.payload_hash,
		claimed.available_at, claimed.lease_token
	FROM claimed;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."bind_worker_outbox_queue_job"(
	p_outbox_id uuid,
	p_lease_token uuid,
	p_queue_job_id uuid,
	p_payload_hash text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
	IF p_outbox_id IS NULL OR p_lease_token IS NULL OR p_queue_job_id IS NULL
		OR p_payload_hash !~ '^[a-f0-9]{64}$'
	THEN
		RETURN false;
	END IF;

	UPDATE emdo.worker_operation_outbox
	SET queue_job_id = p_queue_job_id, updated_at = v_now
	WHERE outbox_id = p_outbox_id
		AND lease_token = p_lease_token
		AND payload_hash = p_payload_hash
		AND state = 'leased'
		AND lease_expires_at > v_now
		AND (queue_job_id IS NULL OR queue_job_id = p_queue_job_id);
	IF FOUND THEN
		RETURN true;
	END IF;

	RETURN EXISTS (
		SELECT 1 FROM emdo.worker_operation_outbox
		WHERE outbox_id = p_outbox_id
			AND lease_token = p_lease_token
			AND payload_hash = p_payload_hash
			AND queue_job_id = p_queue_job_id
			AND state IN ('enqueued', 'completed', 'quarantined')
	);
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."mark_worker_outbox_enqueued"(
	p_outbox_id uuid,
	p_lease_token uuid,
	p_queue_job_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
	IF p_outbox_id IS NULL OR p_lease_token IS NULL
		OR p_queue_job_id IS NULL
	THEN
		RETURN false;
	END IF;

	UPDATE emdo.worker_operation_outbox
	SET state = 'enqueued',
		enqueued_at = v_now, updated_at = v_now,
		lease_expires_at = NULL, safe_code = NULL
	WHERE outbox_id = p_outbox_id
		AND lease_token = p_lease_token
		AND state = 'leased'
		AND queue_job_id = p_queue_job_id
		AND lease_expires_at > v_now;
	IF FOUND THEN
		RETURN true;
	END IF;

	-- The queue can start and finish a job before this acknowledgement. Fill
	-- only enqueue metadata; the immutable queue binding was written pre-send.
	UPDATE emdo.worker_operation_outbox
	SET enqueued_at = COALESCE(enqueued_at, v_now),
		updated_at = v_now
	WHERE outbox_id = p_outbox_id
		AND lease_token = p_lease_token
		AND state IN ('completed', 'quarantined')
		AND queue_job_id = p_queue_job_id;
	IF FOUND THEN
		RETURN true;
	END IF;

	RETURN EXISTS (
		SELECT 1 FROM emdo.worker_operation_outbox
		WHERE outbox_id = p_outbox_id
			AND lease_token = p_lease_token
			AND state IN ('enqueued', 'completed', 'quarantined')
			AND queue_job_id = p_queue_job_id
	);
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."mark_worker_outbox_failed"(
	p_outbox_id uuid,
	p_lease_token uuid,
	p_next_attempt_at timestamptz,
	p_safe_code text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_now timestamptz := pg_catalog.clock_timestamp();
	v_state text;
BEGIN
	IF p_outbox_id IS NULL OR p_lease_token IS NULL
		OR p_safe_code NOT IN ('queue-unavailable', 'invalid-operation')
		OR p_next_attempt_at < v_now
		OR p_next_attempt_at > v_now + interval '24 hours'
	THEN
		RETURN false;
	END IF;

	UPDATE emdo.worker_operation_outbox
	SET state = CASE
			WHEN p_safe_code = 'invalid-operation' OR dispatch_attempts >= 20
				THEN 'quarantined'
			ELSE 'dispatch-failed'
		END,
		safe_code = p_safe_code,
		available_at = CASE
			WHEN p_safe_code = 'queue-unavailable' AND dispatch_attempts < 20
				THEN p_next_attempt_at
			ELSE available_at
		END,
		completed_at = CASE
			WHEN p_safe_code = 'invalid-operation' OR dispatch_attempts >= 20
				THEN v_now
			ELSE completed_at
		END,
		lease_expires_at = NULL,
		updated_at = v_now
	WHERE outbox_id = p_outbox_id
		AND lease_token = p_lease_token
		AND state = 'leased'
		AND lease_expires_at > v_now
		AND (p_safe_code = 'invalid-operation' OR queue_job_id IS NULL)
	RETURNING state INTO v_state;
	IF FOUND THEN
		RETURN true;
	END IF;

	RETURN EXISTS (
		SELECT 1 FROM emdo.worker_operation_outbox
		WHERE outbox_id = p_outbox_id
			AND lease_token = p_lease_token
			AND safe_code = p_safe_code
			AND (p_safe_code = 'invalid-operation' OR queue_job_id IS NULL)
			AND (
				(state = 'quarantined')
				OR (state = 'dispatch-failed' AND available_at = p_next_attempt_at)
			)
	);
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."is_active_request_scope"(
	p_household_id uuid,
	p_space_id uuid DEFAULT NULL,
	p_client_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
	SELECT emdo.current_user_id() IS NOT NULL
		AND emdo.current_session_id() IS NOT NULL
		AND emdo.current_request_id() IS NOT NULL
		AND EXISTS (
			SELECT 1
			FROM emdo.auth_sessions AS session
			JOIN emdo.auth_users AS account_user
				ON account_user.id = session.user_id
			JOIN emdo.household_memberships AS membership
				ON membership.household_id = p_household_id
				AND membership.user_id = session.user_id
			WHERE session.id = emdo.current_session_id()
				AND session.user_id = emdo.current_user_id()
				AND session.active_household_id = p_household_id
				AND session.expires_at > pg_catalog.clock_timestamp()
				AND account_user.email_verified = true
				AND membership.status = 'active'
		)
		AND (
			p_space_id IS NULL
			OR EXISTS (
				SELECT 1 FROM emdo.spaces AS space
				WHERE space.household_id = p_household_id
					AND space.id = p_space_id
					AND space.tombstoned_at IS NULL
					AND (
						space.visibility = 'shared'
						OR space.original_owner_user_id = emdo.current_user_id()
					)
			)
		)
		AND (
			p_client_id IS NULL
			OR EXISTS (
				SELECT 1 FROM emdo.sync_clients AS client
				WHERE client.id = p_client_id
					AND client.household_id = p_household_id
					AND client.user_id = emdo.current_user_id()
					AND client.revoked_at IS NULL
			)
		)
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."resolve_sync_access"(
	p_session_id uuid,
	p_client_id uuid
)
RETURNS TABLE(
	user_id uuid,
	household_id uuid,
	role text,
	writable_spaces jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
	SELECT session.user_id,
		session.active_household_id,
		membership.role,
		COALESCE(
			pg_catalog.jsonb_agg(
				pg_catalog.jsonb_build_object(
					'id', space.id,
					'householdId', space.household_id,
					'visibility', space.visibility,
					'originalOwnerUserId', space.original_owner_user_id
				)
				ORDER BY space.id
			) FILTER (WHERE space.id IS NOT NULL),
			'[]'::jsonb
		) AS writable_spaces
	FROM emdo.auth_sessions AS session
	JOIN emdo.auth_users AS account_user ON account_user.id = session.user_id
	JOIN emdo.household_memberships AS membership
		ON membership.household_id = session.active_household_id
		AND membership.user_id = session.user_id
	JOIN emdo.sync_clients AS client
		ON client.id = p_client_id
		AND client.household_id = session.active_household_id
		AND client.user_id = session.user_id
		AND client.revoked_at IS NULL
	LEFT JOIN emdo.spaces AS space
		ON space.household_id = session.active_household_id
		AND space.tombstoned_at IS NULL
		AND (
			space.visibility = 'shared'
			OR space.original_owner_user_id = session.user_id
		)
	WHERE session.id = p_session_id
		AND session.active_household_id IS NOT NULL
		AND session.expires_at > pg_catalog.clock_timestamp()
		AND account_user.email_verified = true
		AND membership.status = 'active'
	GROUP BY session.user_id, session.active_household_id, membership.role
	HAVING pg_catalog.count(space.id) > 0
$function$;
--> statement-breakpoint
ALTER FUNCTION "emdo"."lock_active_request_scope"(uuid, uuid, uuid) OWNER TO emdo_policy_reader;
ALTER FUNCTION "emdo"."is_active_request_scope"(uuid, uuid, uuid) OWNER TO emdo_policy_reader;
ALTER FUNCTION "emdo"."resolve_sync_access"(uuid, uuid) OWNER TO emdo_policy_reader;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."enforce_approval_checkpoint_transition"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
	IF (pg_catalog.to_jsonb(NEW) - 'revision' - 'state' - 'updated_at')
		IS DISTINCT FROM
		(pg_catalog.to_jsonb(OLD) - 'revision' - 'state' - 'updated_at')
		OR NEW.revision <> OLD.revision + 1
		OR OLD.state <> 'pending'
		OR NEW.state NOT IN ('resumed', 'cancelled', 'expired')
	THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid approval checkpoint compare-and-set';
	END IF;
	NEW.updated_at := pg_catalog.clock_timestamp();
	RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."enforce_ai_spend_transition"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
	IF (pg_catalog.to_jsonb(NEW)
		- 'state' - 'actual_cad_minor' - 'dispatched_at' - 'released_at'
		- 'settled_at' - 'updated_at') IS DISTINCT FROM
		(pg_catalog.to_jsonb(OLD)
		- 'state' - 'actual_cad_minor' - 'dispatched_at' - 'released_at'
		- 'settled_at' - 'updated_at')
	THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AI spend reservation binding is immutable';
	END IF;
	IF NOT (
		(OLD.state = 'reserved' AND NEW.state IN ('dispatched', 'released', 'settled'))
		OR (OLD.state = 'dispatched' AND NEW.state = 'settled')
		OR (OLD.state = 'released' AND NEW.state = 'settled')
	) THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid AI spend reservation transition';
	END IF;
	NEW.updated_at := pg_catalog.clock_timestamp();
	RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."enforce_scheduler_execution_receipt_transition"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
	IF (pg_catalog.to_jsonb(NEW)
		- 'state' - 'result' - 'reconciliation_required' - 'completed_at'
		- 'updated_at') IS DISTINCT FROM
		(pg_catalog.to_jsonb(OLD)
		- 'state' - 'result' - 'reconciliation_required' - 'completed_at'
		- 'updated_at')
		OR NOT (OLD.state = 'pending' AND NEW.state = 'completed')
		OR NEW.result IS NULL OR NEW.completed_at IS NULL
	THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid scheduler execution receipt transition';
	END IF;
	NEW.updated_at := pg_catalog.clock_timestamp();
	RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER approval_checkpoints_transition
BEFORE UPDATE ON "emdo"."approval_checkpoints"
FOR EACH ROW EXECUTE FUNCTION "emdo"."enforce_approval_checkpoint_transition"();
CREATE TRIGGER ai_spend_reservations_transition
BEFORE UPDATE ON "emdo"."ai_spend_reservations"
FOR EACH ROW EXECUTE FUNCTION "emdo"."enforce_ai_spend_transition"();
CREATE TRIGGER scheduler_execution_receipts_transition
BEFORE UPDATE ON "emdo"."scheduler_execution_receipts"
FOR EACH ROW EXECUTE FUNCTION "emdo"."enforce_scheduler_execution_receipt_transition"();
CREATE TRIGGER agent_run_events_append_only
BEFORE UPDATE OR DELETE ON "emdo"."agent_run_events"
FOR EACH ROW EXECUTE FUNCTION "emdo"."reject_append_only_mutation"();
CREATE TRIGGER sync_operation_receipts_append_only
BEFORE UPDATE OR DELETE ON "emdo"."sync_operation_receipts"
FOR EACH ROW EXECUTE FUNCTION "emdo"."reject_append_only_mutation"();
CREATE TRIGGER sync_entities_scope_immutable
BEFORE UPDATE ON "emdo"."sync_entities"
FOR EACH ROW EXECUTE FUNCTION "emdo"."protect_scoped_identity"();
--> statement-breakpoint
ALTER TABLE "emdo"."ai_spend_reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."ai_spend_reservations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."approval_checkpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."approval_checkpoints" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."agent_run_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."agent_run_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."sync_clients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."sync_clients" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."sync_entities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."sync_entities" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."sync_operation_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."sync_operation_receipts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."scheduler_execution_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."scheduler_execution_receipts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ai_spend_app_read ON "emdo"."ai_spend_reservations"
FOR SELECT TO emdo_app
USING (
	"authorized_user_id" = "emdo"."current_user_id"()
	AND "emdo"."is_active_request_scope"("household_id", NULL, NULL)
);
CREATE POLICY ai_spend_metering_executor_update ON "emdo"."ai_spend_reservations"
FOR ALL TO emdo_metering_executor USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY approval_checkpoints_app_scope ON "emdo"."approval_checkpoints"
FOR ALL TO emdo_app
USING (
	"user_id" = "emdo"."current_user_id"()
	AND "emdo"."is_active_request_scope"("household_id", "space_id", NULL)
)
WITH CHECK (
	"user_id" = "emdo"."current_user_id"()
	AND "emdo"."is_active_request_scope"("household_id", "space_id", NULL)
);
CREATE POLICY agent_run_events_app_scope ON "emdo"."agent_run_events"
FOR ALL TO emdo_app
USING (
	"original_owner_user_id" = "emdo"."current_user_id"()
	AND "emdo"."is_active_request_scope"("household_id", "space_id", NULL)
)
WITH CHECK (
	"original_owner_user_id" = "emdo"."current_user_id"()
	AND "emdo"."is_active_request_scope"("household_id", "space_id", NULL)
);
--> statement-breakpoint
CREATE POLICY sync_clients_app_scope ON "emdo"."sync_clients"
FOR ALL TO emdo_app
USING (
	"user_id" = "emdo"."current_user_id"()
	AND "emdo"."is_active_request_scope"("household_id", NULL, NULL)
)
WITH CHECK (
	"user_id" = "emdo"."current_user_id"()
	AND "emdo"."is_active_request_scope"("household_id", NULL, NULL)
);
CREATE POLICY sync_clients_policy_reader ON "emdo"."sync_clients"
FOR SELECT TO emdo_policy_reader USING (true);
-- Row-locking reads participate in UPDATE RLS checks. The isolated NOLOGIN
-- policy-reader owns only SECURITY DEFINER scope predicates and has UPDATE
-- privileges on immutable key columns solely so FOR SHARE can serialize
-- membership, space, and sync-client revocation.
CREATE POLICY household_memberships_policy_reader_lock ON "emdo"."household_memberships"
FOR UPDATE TO emdo_policy_reader USING (true) WITH CHECK (true);
CREATE POLICY spaces_policy_reader_lock ON "emdo"."spaces"
FOR UPDATE TO emdo_policy_reader USING (true) WITH CHECK (true);
CREATE POLICY sync_clients_policy_reader_lock ON "emdo"."sync_clients"
FOR UPDATE TO emdo_policy_reader USING (true) WITH CHECK (true);
CREATE POLICY sync_entities_app_read ON "emdo"."sync_entities"
FOR SELECT TO emdo_app
USING ("emdo"."is_active_request_scope"("household_id", "space_id", NULL));
CREATE POLICY sync_entities_app_insert ON "emdo"."sync_entities"
FOR INSERT TO emdo_app
WITH CHECK (
	"original_owner_user_id" = "emdo"."current_user_id"()
	AND "emdo"."is_active_request_scope"("household_id", "space_id", NULL)
);
CREATE POLICY sync_entities_app_update ON "emdo"."sync_entities"
FOR UPDATE TO emdo_app
USING ("emdo"."is_active_request_scope"("household_id", "space_id", NULL))
WITH CHECK ("emdo"."is_active_request_scope"("household_id", "space_id", NULL));
CREATE POLICY sync_operation_receipts_app_scope ON "emdo"."sync_operation_receipts"
FOR ALL TO emdo_app
USING (
	"original_owner_user_id" = "emdo"."current_user_id"()
	AND "emdo"."is_active_request_scope"("household_id", "space_id", "client_id")
)
WITH CHECK (
	"original_owner_user_id" = "emdo"."current_user_id"()
	AND "emdo"."is_active_request_scope"("household_id", "space_id", "client_id")
);
--> statement-breakpoint
CREATE POLICY scheduler_execution_receipts_app_scope ON "emdo"."scheduler_execution_receipts"
FOR ALL TO emdo_app
USING (
	"original_owner_user_id" = "emdo"."current_user_id"()
	AND "emdo"."is_active_request_scope"("household_id", "space_id", NULL)
)
WITH CHECK (
	"original_owner_user_id" = "emdo"."current_user_id"()
	AND "emdo"."is_active_request_scope"("household_id", "space_id", NULL)
);
CREATE POLICY agent_run_events_worker_scope ON "emdo"."agent_run_events"
FOR ALL TO emdo_worker, emdo_workflow
USING (
	"original_owner_user_id" = "emdo"."current_user_id"()
	AND "emdo"."current_request_id"() IS NOT NULL
	AND "emdo"."can_access_space"("household_id", "space_id")
)
WITH CHECK (
	"original_owner_user_id" = "emdo"."current_user_id"()
	AND "emdo"."current_request_id"() IS NOT NULL
	AND "emdo"."can_access_space"("household_id", "space_id")
);
CREATE POLICY scheduler_execution_receipts_worker_scope ON "emdo"."scheduler_execution_receipts"
FOR ALL TO emdo_worker, emdo_workflow
USING (
	"original_owner_user_id" = "emdo"."current_user_id"()
	AND "emdo"."current_request_id"() IS NOT NULL
	AND "emdo"."can_access_space"("household_id", "space_id")
)
WITH CHECK (
	"original_owner_user_id" = "emdo"."current_user_id"()
	AND "emdo"."current_request_id"() IS NOT NULL
	AND "emdo"."can_access_space"("household_id", "space_id")
);
--> statement-breakpoint
REVOKE ALL ON "emdo"."ai_spend_reservations", "emdo"."approval_checkpoints",
	"emdo"."agent_run_events", "emdo"."sync_clients", "emdo"."sync_entities",
	"emdo"."sync_operation_receipts", "emdo"."scheduler_execution_receipts"
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor;
GRANT USAGE ON SCHEMA "emdo" TO emdo_metering_executor;
GRANT SELECT, INSERT, UPDATE ON "emdo"."ai_spend_reservations"
	TO emdo_metering_executor;
GRANT SELECT ON "emdo"."ai_spend_reservations" TO emdo_app;
GRANT SELECT, INSERT, UPDATE ON "emdo"."approval_checkpoints",
	"emdo"."sync_clients", "emdo"."sync_entities",
	"emdo"."scheduler_execution_receipts" TO emdo_app;
GRANT SELECT, INSERT ON "emdo"."agent_run_events",
	"emdo"."sync_operation_receipts" TO emdo_app;
GRANT SELECT, INSERT ON "emdo"."agent_run_events" TO emdo_worker, emdo_workflow;
GRANT SELECT, INSERT, UPDATE ON "emdo"."scheduler_execution_receipts"
	TO emdo_worker, emdo_workflow;
GRANT SELECT ON "emdo"."sync_clients" TO emdo_policy_reader;
GRANT SELECT (id, user_id, expires_at, active_household_id)
	ON "emdo"."auth_sessions" TO emdo_policy_reader;
GRANT SELECT (id, email_verified) ON "emdo"."auth_users" TO emdo_policy_reader;
GRANT UPDATE (id) ON "emdo"."auth_sessions", "emdo"."auth_users",
	"emdo"."spaces", "emdo"."sync_clients" TO emdo_policy_reader;
GRANT UPDATE (household_id) ON "emdo"."household_memberships"
	TO emdo_policy_reader;
GRANT UPDATE (resolved_model, model_reason, status, local_trace_reference,
	safe_error, usage, completed_at) ON "emdo"."agent_runs" TO emdo_app, emdo_worker;
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON "emdo"."ai_spend_reservations",
	"emdo"."approval_checkpoints", "emdo"."agent_run_events",
	"emdo"."sync_clients", "emdo"."sync_entities",
	"emdo"."sync_operation_receipts", "emdo"."scheduler_execution_receipts"
	FROM emdo_app, emdo_auth, emdo_worker, emdo_workflow, emdo_policy_reader,
	emdo_metering_executor;
--> statement-breakpoint
ALTER TABLE "emdo"."ai_spend_reservations"
	ADD CONSTRAINT ai_spend_reservations_terminal_shape_check CHECK (
		(state = 'blocked' AND actual_cad_minor IS NULL AND dispatched_at IS NULL
			AND released_at IS NULL AND settled_at IS NULL)
		OR (state = 'reserved' AND actual_cad_minor IS NULL AND dispatched_at IS NULL
			AND released_at IS NULL AND settled_at IS NULL)
		OR (state = 'dispatched' AND actual_cad_minor IS NULL
			AND dispatched_at IS NOT NULL AND released_at IS NULL AND settled_at IS NULL)
		OR (state = 'released' AND actual_cad_minor IS NULL
			AND dispatched_at IS NULL AND released_at IS NOT NULL AND settled_at IS NULL)
		OR (state = 'settled' AND actual_cad_minor IS NOT NULL
			AND settled_at IS NOT NULL)
	);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."reserve_ai_spend"(
	p_reservation_id text,
	p_household_id uuid,
	p_period text,
	p_category text,
	p_execution_id text,
	p_authorization_hash text,
	p_request_hash text,
	p_estimated_cad_minor bigint,
	p_warning_cad_minor bigint,
	p_limit_cad_minor bigint
)
RETURNS SETOF "emdo"."ai_spend_reservations"
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_record emdo.ai_spend_reservations%ROWTYPE;
	v_current bigint;
	v_projected bigint;
	v_decision bigint;
	v_state text;
	v_warning boolean;
	v_now timestamp with time zone;
	v_period text;
BEGIN
	v_period := pg_catalog.to_char(
		pg_catalog.clock_timestamp() AT TIME ZONE 'America/Toronto',
		'YYYY-MM'
	);
	IF "emdo"."current_user_id"() IS NULL
		OR "emdo"."current_session_id"() IS NULL
		OR "emdo"."current_request_id"() IS NULL
		OR NOT "emdo"."lock_active_request_scope"(p_household_id, NULL, NULL)
		OR p_reservation_id IS NULL OR pg_catalog.length(p_reservation_id) NOT BETWEEN 16 AND 200
		OR p_period IS DISTINCT FROM v_period
		OR p_category NOT IN ('model', 'audio')
		OR p_execution_id IS NULL OR pg_catalog.length(p_execution_id) NOT BETWEEN 16 AND 200
		OR p_authorization_hash !~ '^[a-f0-9]{64}$'
		OR p_request_hash !~ '^[a-f0-9]{64}$'
		OR p_estimated_cad_minor <= 0
		OR p_warning_cad_minor <> 5000
		OR p_limit_cad_minor <> 7500
	THEN
		RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid AI spend reservation';
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(p_household_id::text || ':' || v_period, 0)
	);
	SELECT reservation.* INTO v_record
	FROM emdo.ai_spend_reservations AS reservation
	WHERE reservation.reservation_id = p_reservation_id
		OR (reservation.household_id = p_household_id
			AND reservation.period = v_period
			AND reservation.request_hash = p_request_hash)
	FOR UPDATE;
	IF FOUND THEN
		IF v_record.household_id <> p_household_id
			OR v_record.authorized_user_id <> "emdo"."current_user_id"()
			OR v_record.period <> v_period
			OR v_record.category <> p_category
			OR v_record.execution_id <> p_execution_id
			OR v_record.authorization_hash <> p_authorization_hash
			OR v_record.request_hash <> p_request_hash
			OR v_record.estimated_cad_minor <> p_estimated_cad_minor
		THEN
			RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AI spend reservation binding conflict';
		END IF;
		RETURN NEXT v_record;
		RETURN;
	END IF;

	SELECT (
		COALESCE(pg_catalog.sum(reservation.actual_cad_minor)
			FILTER (WHERE reservation.state = 'settled'), 0)
		+ COALESCE(pg_catalog.sum(reservation.estimated_cad_minor)
			FILTER (WHERE reservation.state IN ('reserved', 'dispatched')), 0)
	)::bigint INTO v_current
	FROM emdo.ai_spend_reservations AS reservation
	WHERE reservation.household_id = p_household_id
		AND reservation.period = v_period;
	v_projected := v_current + p_estimated_cad_minor;
	IF v_current >= p_limit_cad_minor OR v_projected > p_limit_cad_minor THEN
		v_state := 'blocked';
		v_decision := v_current;
		v_warning := true;
	ELSE
		v_state := 'reserved';
		v_decision := v_projected;
		v_warning := v_projected >= p_warning_cad_minor;
	END IF;
	v_now := pg_catalog.clock_timestamp();
	INSERT INTO emdo.ai_spend_reservations(
		reservation_id, household_id, authorized_user_id, period, category,
		execution_id, authorization_hash, request_hash, estimated_cad_minor,
		decision_cad_minor, warning, state, created_at, updated_at, retain_until
	) VALUES (
		p_reservation_id, p_household_id, "emdo"."current_user_id"(), v_period,
		p_category, p_execution_id, p_authorization_hash, p_request_hash,
		p_estimated_cad_minor, v_decision, v_warning, v_state, v_now, v_now,
		v_now + interval '90 days'
	) RETURNING * INTO v_record;
	RETURN NEXT v_record;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."transition_ai_spend"(
	p_reservation_id text,
	p_authorization_hash text,
	p_transition text
)
RETURNS SETOF "emdo"."ai_spend_reservations"
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_record emdo.ai_spend_reservations%ROWTYPE;
	v_household_id uuid;
	v_now timestamp with time zone;
BEGIN
	IF p_transition NOT IN ('dispatched', 'released')
		OR p_authorization_hash !~ '^[a-f0-9]{64}$'
	THEN
		RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid AI spend transition';
	END IF;
	SELECT reservation.household_id INTO v_household_id
	FROM emdo.ai_spend_reservations AS reservation
	WHERE reservation.reservation_id = p_reservation_id
		AND reservation.authorized_user_id = "emdo"."current_user_id"();
	IF NOT FOUND
		OR NOT "emdo"."lock_active_request_scope"(v_household_id, NULL, NULL)
	THEN
		RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'AI spend transition unauthorized';
	END IF;
	SELECT reservation.* INTO v_record
	FROM emdo.ai_spend_reservations AS reservation
	WHERE reservation.reservation_id = p_reservation_id
		AND reservation.authorized_user_id = "emdo"."current_user_id"()
	FOR UPDATE;
	IF NOT FOUND OR v_record.authorization_hash <> p_authorization_hash THEN
		RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'AI spend transition unauthorized';
	END IF;
	IF v_record.state = p_transition
		OR (p_transition = 'dispatched' AND v_record.state = 'settled')
	THEN
		RETURN NEXT v_record;
		RETURN;
	END IF;
	IF v_record.state <> 'reserved' THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AI spend reservation is not transitionable';
	END IF;
	v_now := pg_catalog.clock_timestamp();
	IF p_transition = 'dispatched' THEN
		UPDATE emdo.ai_spend_reservations
		SET state = 'dispatched', dispatched_at = v_now, updated_at = v_now
		WHERE reservation_id = p_reservation_id RETURNING * INTO v_record;
	ELSE
		UPDATE emdo.ai_spend_reservations
		SET state = 'released', released_at = v_now, updated_at = v_now
		WHERE reservation_id = p_reservation_id RETURNING * INTO v_record;
	END IF;
	RETURN NEXT v_record;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."settle_ai_spend"(
	p_reservation_id text,
	p_execution_id text,
	p_actual_cad_minor bigint
)
RETURNS TABLE(
	period text,
	reservation_id text,
	actual_cad_minor bigint,
	reservation_exceeded boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_record emdo.ai_spend_reservations%ROWTYPE;
	v_household_id uuid;
	v_now timestamp with time zone;
BEGIN
	IF p_reservation_id IS NULL OR p_execution_id IS NULL
		OR p_actual_cad_minor IS NULL OR p_actual_cad_minor < 0
	THEN
		RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid AI spend settlement';
	END IF;

	SELECT reservation.household_id INTO v_household_id
	FROM emdo.ai_spend_reservations AS reservation
	WHERE reservation.reservation_id = p_reservation_id
		AND reservation.authorized_user_id = "emdo"."current_user_id"();
	IF NOT FOUND
		OR NOT "emdo"."lock_active_request_scope"(v_household_id, NULL, NULL)
	THEN
		RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'spend settlement scope is unauthorized';
	END IF;
	SELECT * INTO v_record
	FROM emdo.ai_spend_reservations AS reservation
	WHERE reservation.reservation_id = p_reservation_id
		AND reservation.authorized_user_id = "emdo"."current_user_id"()
	FOR UPDATE;
	IF NOT FOUND OR v_record.state = 'blocked' THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'spend reservation is not active';
	END IF;
	IF v_record.execution_id <> p_execution_id THEN
		RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'spend reservation execution mismatch';
	END IF;
	IF "emdo"."current_user_id"() IS NULL
		OR "emdo"."current_session_id"() IS NULL
		OR "emdo"."current_request_id"() IS NULL
		OR v_record.authorized_user_id <> "emdo"."current_user_id"()
		OR v_record.household_id IS DISTINCT FROM v_household_id
	THEN
		RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'spend settlement scope is unauthorized';
	END IF;
	IF v_record.state = 'settled' THEN
		IF v_record.actual_cad_minor <> p_actual_cad_minor THEN
			RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'spend settlement idempotency conflict';
		END IF;
		RETURN QUERY SELECT v_record.period, v_record.reservation_id,
			v_record.actual_cad_minor,
			v_record.actual_cad_minor > v_record.estimated_cad_minor;
		RETURN;
	END IF;

	v_now := pg_catalog.clock_timestamp();
	UPDATE emdo.ai_spend_reservations AS reservation
	SET state = 'settled', actual_cad_minor = p_actual_cad_minor,
		settled_at = v_now, updated_at = v_now
	WHERE reservation.reservation_id = p_reservation_id;

	RETURN QUERY SELECT v_record.period, v_record.reservation_id,
		p_actual_cad_minor,
		p_actual_cad_minor > v_record.estimated_cad_minor;
END
$function$;
--> statement-breakpoint
ALTER FUNCTION "emdo"."reserve_ai_spend"(text, uuid, text, text, text, text, text, bigint, bigint, bigint)
	OWNER TO emdo_metering_executor;
ALTER FUNCTION "emdo"."transition_ai_spend"(text, text, text)
	OWNER TO emdo_metering_executor;
ALTER FUNCTION "emdo"."settle_ai_spend"(text, text, bigint)
	OWNER TO emdo_metering_executor;
REVOKE ALL ON FUNCTION
	"emdo"."reserve_ai_spend"(text, uuid, text, text, text, text, text, bigint, bigint, bigint),
	"emdo"."transition_ai_spend"(text, text, text),
	"emdo"."settle_ai_spend"(text, text, bigint)
	FROM PUBLIC, emdo_policy_reader, emdo_auth, emdo_worker, emdo_workflow,
	emdo_metering_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."reserve_ai_spend"(text, uuid, text, text, text, text, text, bigint, bigint, bigint),
	"emdo"."transition_ai_spend"(text, text, text),
	"emdo"."settle_ai_spend"(text, text, bigint)
	TO emdo_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "emdo"."lock_active_request_scope"(uuid, uuid, uuid),
	"emdo"."is_active_request_scope"(uuid, uuid, uuid),
	"emdo"."resolve_sync_access"(uuid, uuid)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor;
GRANT EXECUTE ON FUNCTION "emdo"."lock_active_request_scope"(uuid, uuid, uuid),
	"emdo"."is_active_request_scope"(uuid, uuid, uuid)
	TO emdo_app, emdo_metering_executor;
GRANT EXECUTE ON FUNCTION "emdo"."resolve_sync_access"(uuid, uuid)
	TO emdo_app;
GRANT EXECUTE ON FUNCTION "emdo"."current_user_id"(),
	"emdo"."current_session_id"(), "emdo"."current_request_id"()
	TO emdo_metering_executor;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "emdo"."enforce_approval_checkpoint_transition"(),
	"emdo"."enforce_ai_spend_transition"(),
	"emdo"."enforce_scheduler_execution_receipt_transition"()
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor;
-- Tables below are generated from the final Drizzle schema and intentionally
-- live in this single pre-release durable-runtime migration.
CREATE TABLE "emdo"."calendar_maintenance_receipts" (
	"receipt_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"related_operation_id" text,
	"retry_sequence" integer,
	"status" text NOT NULL,
	"safe_code" text,
	"provider_version" text,
	"result_hash" text,
	"evidence_hash" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone DEFAULT clock_timestamp() + interval '90 days' NOT NULL,
	CONSTRAINT "calendar_maintenance_receipts_operation_unique" UNIQUE("operation_id"),
	CONSTRAINT "calendar_maintenance_receipts_kind_check" CHECK ("emdo"."calendar_maintenance_receipts"."kind" in ('sync', 'retry', 'reconciliation')),
	CONSTRAINT "calendar_maintenance_receipts_status_check" CHECK ("emdo"."calendar_maintenance_receipts"."status" in ('completed', 'failed', 'indeterminate')),
	CONSTRAINT "calendar_maintenance_receipts_safe_code_check" CHECK ("emdo"."calendar_maintenance_receipts"."safe_code" is null or "emdo"."calendar_maintenance_receipts"."safe_code" in ('provider-unavailable', 'cursor-invalid', 'generation-conflict', 'readback-indeterminate')),
	CONSTRAINT "calendar_maintenance_receipts_hash_check" CHECK (("emdo"."calendar_maintenance_receipts"."result_hash" is null or "emdo"."calendar_maintenance_receipts"."result_hash" ~ '^[a-f0-9]{64}$') and ("emdo"."calendar_maintenance_receipts"."evidence_hash" is null or "emdo"."calendar_maintenance_receipts"."evidence_hash" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "calendar_maintenance_receipts_retention_check" CHECK ("emdo"."calendar_maintenance_receipts"."retain_until" > "emdo"."calendar_maintenance_receipts"."recorded_at" and "emdo"."calendar_maintenance_receipts"."retain_until" <= "emdo"."calendar_maintenance_receipts"."recorded_at" + interval '90 days')
);
--> statement-breakpoint
CREATE TABLE "emdo"."calendar_sync_states" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"provider_id" text DEFAULT 'google-calendar' NOT NULL,
	"sync_generation" integer DEFAULT 0 NOT NULL,
	"sealed_cursor" text,
	"provider_version" text,
	"state" text DEFAULT 'ready' NOT NULL,
	"retry_sequence" integer DEFAULT 0 NOT NULL,
	"last_safe_code" text,
	"last_evidence_hash" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"disconnected_at" timestamp with time zone,
	CONSTRAINT "calendar_sync_states_scope_id_unique" UNIQUE("household_id","space_id","original_owner_user_id","connection_id"),
	CONSTRAINT "calendar_sync_states_generation_nonnegative" CHECK ("emdo"."calendar_sync_states"."sync_generation" >= 0 and "emdo"."calendar_sync_states"."retry_sequence" between 0 and 20),
	CONSTRAINT "calendar_sync_states_state_check" CHECK ("emdo"."calendar_sync_states"."state" in ('ready', 'syncing', 'retry-pending', 'disconnected')),
	CONSTRAINT "calendar_sync_states_hash_check" CHECK ("emdo"."calendar_sync_states"."last_evidence_hash" is null or "emdo"."calendar_sync_states"."last_evidence_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."is_valid_encrypted_google_calendar_grant_payload"(
	p_payload jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
	SELECT CASE
		WHEN pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
			THEN false
		ELSE COALESCE(
			p_payload ?& ARRAY[
				'algorithm', 'aadVersion', 'ciphertext', 'nonce',
				'authenticationTag', 'wrappedKey', 'keyVersion'
			]
			AND p_payload - ARRAY[
				'algorithm', 'aadVersion', 'ciphertext', 'nonce',
				'authenticationTag', 'wrappedKey', 'keyVersion'
			]::text[] = '{}'::jsonb
			AND pg_catalog.jsonb_typeof(p_payload -> 'algorithm') = 'string'
			AND p_payload ->> 'algorithm' = 'aes-256-gcm'
			AND pg_catalog.jsonb_typeof(p_payload -> 'aadVersion') = 'number'
			AND p_payload -> 'aadVersion' = '1'::jsonb
			AND pg_catalog.jsonb_typeof(p_payload -> 'ciphertext') = 'string'
			AND p_payload ->> 'ciphertext' ~ '^[A-Za-z0-9_-]*$'
			AND pg_catalog.length(p_payload ->> 'ciphertext') % 4 <> 1
			AND (
				pg_catalog.length(p_payload ->> 'ciphertext') % 4 = 0
				OR (
					pg_catalog.length(p_payload ->> 'ciphertext') % 4 = 2
					AND pg_catalog.right(p_payload ->> 'ciphertext', 1) ~ '^[AQgw]$'
				)
				OR (
					pg_catalog.length(p_payload ->> 'ciphertext') % 4 = 3
					AND pg_catalog.right(p_payload ->> 'ciphertext', 1)
						~ '^[AEIMQUYcgkosw048]$'
				)
			)
			AND pg_catalog.jsonb_typeof(p_payload -> 'nonce') = 'string'
			AND p_payload ->> 'nonce' ~ '^[A-Za-z0-9_-]{16}$'
			AND pg_catalog.jsonb_typeof(p_payload -> 'authenticationTag') = 'string'
			AND p_payload ->> 'authenticationTag'
				~ '^[A-Za-z0-9_-]{21}[AQgw]$'
			AND pg_catalog.jsonb_typeof(p_payload -> 'wrappedKey') = 'string'
			AND p_payload ->> 'wrappedKey' ~ '^[A-Za-z0-9_-]{80}$'
			AND pg_catalog.jsonb_typeof(p_payload -> 'keyVersion') = 'string'
			AND pg_catalog.length(p_payload ->> 'keyVersion') BETWEEN 2 AND 64
			AND p_payload ->> 'keyVersion'
				~ '^[a-z0-9]+([._-][a-z0-9]+)*$',
			false
		)
	END
$function$;
--> statement-breakpoint
CREATE TABLE "emdo"."encrypted_google_calendar_grants" (
	"record_id" text PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"private_space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"grant_type" text NOT NULL,
	"revision" integer NOT NULL,
	"authorization_epoch" integer NOT NULL,
	"provider_grant_reference" text NOT NULL,
	"encrypted_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "encrypted_google_calendar_grants_scope_unique" UNIQUE("household_id","private_space_id","original_owner_user_id","provider","grant_type"),
	CONSTRAINT "encrypted_google_calendar_grants_reference_unique" UNIQUE("provider","provider_grant_reference"),
	CONSTRAINT "encrypted_google_calendar_grants_binding_check" CHECK ("emdo"."encrypted_google_calendar_grants"."provider" = 'google' and "emdo"."encrypted_google_calendar_grants"."grant_type" = 'calendar-authorization' and "emdo"."encrypted_google_calendar_grants"."revision" > 0 and "emdo"."encrypted_google_calendar_grants"."authorization_epoch" >= 0 and pg_catalog.length("emdo"."encrypted_google_calendar_grants"."provider_grant_reference") between 16 and 160 and pg_catalog.btrim("emdo"."encrypted_google_calendar_grants"."provider_grant_reference") = "emdo"."encrypted_google_calendar_grants"."provider_grant_reference" and "emdo"."encrypted_google_calendar_grants"."provider_grant_reference" !~ '[[:cntrl:]]'),
	CONSTRAINT "encrypted_google_calendar_grants_payload_size_check" CHECK (pg_catalog.octet_length("emdo"."encrypted_google_calendar_grants"."encrypted_payload"::text) between 1 and 65536),
	CONSTRAINT "encrypted_google_calendar_grants_payload_shape_check" CHECK ("emdo"."is_valid_encrypted_google_calendar_grant_payload"("emdo"."encrypted_google_calendar_grants"."encrypted_payload") IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "emdo"."google_oauth_authorization_epochs" (
	"household_id" uuid NOT NULL,
	"private_space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"authorization_epoch" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "google_oauth_authorization_epochs_pk" PRIMARY KEY("household_id","private_space_id","original_owner_user_id"),
	CONSTRAINT "google_oauth_authorization_epochs_nonnegative" CHECK ("emdo"."google_oauth_authorization_epochs"."authorization_epoch" >= 0)
);
--> statement-breakpoint
CREATE TABLE "emdo"."google_oauth_flows" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"private_space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"purpose" text NOT NULL,
	"requested_scopes" jsonb NOT NULL,
	"credential_revision_at_start" integer,
	"authorization_epoch_at_start" integer NOT NULL,
	"code_verifier" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "google_oauth_flows_state_id_check" CHECK ("emdo"."google_oauth_flows"."id" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "google_oauth_flows_purpose_check" CHECK ("emdo"."google_oauth_flows"."purpose" in ('calendar-read', 'calendar-event-write')),
	CONSTRAINT "google_oauth_flows_revision_epoch_check" CHECK (("emdo"."google_oauth_flows"."credential_revision_at_start" is null or "emdo"."google_oauth_flows"."credential_revision_at_start" > 0) and "emdo"."google_oauth_flows"."authorization_epoch_at_start" >= 0),
	CONSTRAINT "google_oauth_flows_lifetime_check" CHECK ("emdo"."google_oauth_flows"."expires_at" > "emdo"."google_oauth_flows"."created_at" and "emdo"."google_oauth_flows"."expires_at" <= "emdo"."google_oauth_flows"."created_at" + interval '10 minutes'),
	CONSTRAINT "google_oauth_flows_verifier_size_check" CHECK (pg_catalog.octet_length("emdo"."google_oauth_flows"."code_verifier") between 43 and 128)
);
--> statement-breakpoint
CREATE TABLE "emdo"."notification_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"revision" integer NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"sensitivity" text,
	"title" text,
	"body" text,
	"attempted_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone DEFAULT clock_timestamp() + interval '90 days' NOT NULL,
	CONSTRAINT "notification_deliveries_channel_check" CHECK ("emdo"."notification_deliveries"."channel" in ('in-app', 'email', 'push')),
	CONSTRAINT "notification_deliveries_status_check" CHECK ("emdo"."notification_deliveries"."status" in ('created', 'sent', 'duplicate', 'gone', 'not-applied', 'indeterminate')),
	CONSTRAINT "notification_deliveries_external_payload_check" CHECK (("emdo"."notification_deliveries"."channel" = 'in-app' and "emdo"."notification_deliveries"."sensitivity" in ('standard', 'sensitive') and "emdo"."notification_deliveries"."title" is not null and "emdo"."notification_deliveries"."body" is not null) or ("emdo"."notification_deliveries"."channel" in ('email', 'push') and "emdo"."notification_deliveries"."sensitivity" is null and "emdo"."notification_deliveries"."title" is null and "emdo"."notification_deliveries"."body" is null)),
	CONSTRAINT "notification_deliveries_revision_positive" CHECK ("emdo"."notification_deliveries"."revision" > 0),
	CONSTRAINT "notification_deliveries_retention_check" CHECK ("emdo"."notification_deliveries"."retain_until" > "emdo"."notification_deliveries"."attempted_at" and "emdo"."notification_deliveries"."retain_until" <= "emdo"."notification_deliveries"."attempted_at" + interval '90 days')
);
--> statement-breakpoint
CREATE TABLE "emdo"."notifications" (
	"notification_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"source_revision" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"sensitivity" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"in_app" boolean NOT NULL,
	"email_recipient" text,
	"push_subscription_reference" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"tombstoned_at" timestamp with time zone,
	CONSTRAINT "notifications_scope_id_unique" UNIQUE("household_id","space_id","original_owner_user_id","notification_id"),
	CONSTRAINT "notifications_source_revision_unique" UNIQUE("household_id","space_id","original_owner_user_id","source_type","source_id","source_revision"),
	CONSTRAINT "notifications_source_revision_positive" CHECK ("emdo"."notifications"."source_revision" > 0 and "emdo"."notifications"."revision" > 0),
	CONSTRAINT "notifications_sensitivity_check" CHECK ("emdo"."notifications"."sensitivity" in ('standard', 'sensitive')),
	CONSTRAINT "notifications_channel_check" CHECK ("emdo"."notifications"."in_app" or "emdo"."notifications"."email_recipient" is not null or "emdo"."notifications"."push_subscription_reference" is not null)
);
--> statement-breakpoint
CREATE TABLE "emdo"."scheduler_reminders" (
	"reminder_id" text PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"due_revision" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'scheduled' NOT NULL,
	"sensitivity" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"in_app" boolean NOT NULL,
	"email_recipient" text,
	"push_subscription_reference" text,
	"delivered_revision" integer,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"tombstoned_at" timestamp with time zone,
	CONSTRAINT "scheduler_reminders_scope_id_unique" UNIQUE("household_id","space_id","original_owner_user_id","reminder_id"),
	CONSTRAINT "scheduler_reminders_due_revision_positive" CHECK ("emdo"."scheduler_reminders"."due_revision" > 0),
	CONSTRAINT "scheduler_reminders_state_check" CHECK ("emdo"."scheduler_reminders"."state" in ('scheduled', 'cancelled', 'delivered')),
	CONSTRAINT "scheduler_reminders_sensitivity_check" CHECK ("emdo"."scheduler_reminders"."sensitivity" in ('standard', 'sensitive')),
	CONSTRAINT "scheduler_reminders_channel_check" CHECK ("emdo"."scheduler_reminders"."in_app" or "emdo"."scheduler_reminders"."email_recipient" is not null or "emdo"."scheduler_reminders"."push_subscription_reference" is not null)
);
--> statement-breakpoint
CREATE TABLE "emdo"."worker_job_executions" (
	"execution_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"job_name" text NOT NULL,
	"operation_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"state" text NOT NULL,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"lease_token" uuid NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone DEFAULT clock_timestamp() + interval '90 days' NOT NULL,
	CONSTRAINT "worker_job_executions_job_operation_unique" UNIQUE("job_name","operation_id"),
	CONSTRAINT "worker_job_executions_state_check" CHECK ("emdo"."worker_job_executions"."state" in ('leased', 'completed', 'failed', 'indeterminate')),
	CONSTRAINT "worker_job_executions_attempt_count_check" CHECK ("emdo"."worker_job_executions"."attempt_count" between 1 and 5),
	CONSTRAINT "worker_job_executions_payload_hash_check" CHECK ("emdo"."worker_job_executions"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "worker_job_executions_retention_check" CHECK ("emdo"."worker_job_executions"."retain_until" > "emdo"."worker_job_executions"."started_at" and "emdo"."worker_job_executions"."retain_until" <= "emdo"."worker_job_executions"."started_at" + interval '90 days')
);
--> statement-breakpoint
CREATE TABLE "emdo"."worker_operation_outbox" (
	"outbox_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"job_name" text NOT NULL,
	"operation_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"target_revision" integer,
	"related_operation_id" text,
	"retry_sequence" integer,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_token" uuid,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"queue_job_id" uuid,
	"safe_code" text,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"enqueued_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"retain_until" timestamp with time zone DEFAULT clock_timestamp() + interval '90 days' NOT NULL,
	CONSTRAINT "worker_operation_outbox_job_operation_unique" UNIQUE("job_name","operation_id"),
	CONSTRAINT "worker_operation_outbox_scope_id_unique" UNIQUE("household_id","space_id","original_owner_user_id","outbox_id"),
	CONSTRAINT "worker_operation_outbox_execution_binding_unique" UNIQUE("household_id","space_id","original_owner_user_id","outbox_id","job_name","operation_id","payload_hash"),
	CONSTRAINT "worker_operation_outbox_state_check" CHECK ("emdo"."worker_operation_outbox"."state" in ('pending', 'leased', 'enqueued', 'completed', 'dispatch-failed', 'quarantined')),
	CONSTRAINT "worker_operation_outbox_job_check" CHECK ("emdo"."worker_operation_outbox"."job_name" in ('emdo.reminder.delivery.v1', 'emdo.calendar.sync.v1', 'emdo.calendar.retry.v1', 'emdo.calendar.reconciliation.v1', 'emdo.notification.delivery.v1')),
	CONSTRAINT "worker_operation_outbox_target_revision_check" CHECK ("emdo"."worker_operation_outbox"."target_revision" is null or "emdo"."worker_operation_outbox"."target_revision" >= 0),
	CONSTRAINT "worker_operation_outbox_retry_sequence_check" CHECK ("emdo"."worker_operation_outbox"."retry_sequence" is null or "emdo"."worker_operation_outbox"."retry_sequence" between 1 and 20),
	CONSTRAINT "worker_operation_outbox_dispatch_attempts_nonnegative" CHECK ("emdo"."worker_operation_outbox"."dispatch_attempts" between 0 and 20),
	CONSTRAINT "worker_operation_outbox_payload_hash_check" CHECK ("emdo"."worker_operation_outbox"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "worker_operation_outbox_safe_code_check" CHECK ("emdo"."worker_operation_outbox"."safe_code" is null or "emdo"."worker_operation_outbox"."safe_code" in ('queue-unavailable', 'invalid-operation', 'attempt-exhausted', 'execution-indeterminate')),
	CONSTRAINT "worker_operation_outbox_retention_check" CHECK ("emdo"."worker_operation_outbox"."retain_until" > "emdo"."worker_operation_outbox"."created_at" and "emdo"."worker_operation_outbox"."retain_until" <= "emdo"."worker_operation_outbox"."created_at" + interval '90 days')
);
--> statement-breakpoint
ALTER TABLE "emdo"."scheduler_execution_receipts" ADD COLUMN "lease_expires_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "emdo"."calendar_maintenance_receipts" ADD CONSTRAINT "calendar_maintenance_receipts_household_space_fk" FOREIGN KEY ("household_id","space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."calendar_maintenance_receipts" ADD CONSTRAINT "calendar_maintenance_receipts_owner_membership_fk" FOREIGN KEY ("household_id","original_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."calendar_sync_states" ADD CONSTRAINT "calendar_sync_states_household_space_fk" FOREIGN KEY ("household_id","space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."calendar_sync_states" ADD CONSTRAINT "calendar_sync_states_owner_membership_fk" FOREIGN KEY ("household_id","original_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."encrypted_google_calendar_grants" ADD CONSTRAINT "encrypted_google_calendar_grants_household_space_fk" FOREIGN KEY ("household_id","private_space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."encrypted_google_calendar_grants" ADD CONSTRAINT "encrypted_google_calendar_grants_owner_membership_fk" FOREIGN KEY ("household_id","original_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."google_oauth_authorization_epochs" ADD CONSTRAINT "google_oauth_authorization_epochs_household_space_fk" FOREIGN KEY ("household_id","private_space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."google_oauth_authorization_epochs" ADD CONSTRAINT "google_oauth_authorization_epochs_owner_membership_fk" FOREIGN KEY ("household_id","original_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."google_oauth_flows" ADD CONSTRAINT "google_oauth_flows_household_space_fk" FOREIGN KEY ("household_id","private_space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."google_oauth_flows" ADD CONSTRAINT "google_oauth_flows_owner_membership_fk" FOREIGN KEY ("household_id","original_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","notification_id") REFERENCES "emdo"."notifications"("household_id","space_id","original_owner_user_id","notification_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."notifications" ADD CONSTRAINT "notifications_household_space_fk" FOREIGN KEY ("household_id","space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."notifications" ADD CONSTRAINT "notifications_owner_membership_fk" FOREIGN KEY ("household_id","original_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."scheduler_reminders" ADD CONSTRAINT "scheduler_reminders_household_space_fk" FOREIGN KEY ("household_id","space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."scheduler_reminders" ADD CONSTRAINT "scheduler_reminders_owner_membership_fk" FOREIGN KEY ("household_id","original_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."worker_job_executions" ADD CONSTRAINT "worker_job_executions_outbox_fk" FOREIGN KEY ("household_id","space_id","original_owner_user_id","outbox_id","job_name","operation_id","payload_hash") REFERENCES "emdo"."worker_operation_outbox"("household_id","space_id","original_owner_user_id","outbox_id","job_name","operation_id","payload_hash") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."worker_operation_outbox" ADD CONSTRAINT "worker_operation_outbox_household_space_fk" FOREIGN KEY ("household_id","space_id") REFERENCES "emdo"."spaces"("household_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "emdo"."worker_operation_outbox" ADD CONSTRAINT "worker_operation_outbox_owner_membership_fk" FOREIGN KEY ("household_id","original_owner_user_id") REFERENCES "emdo"."household_memberships"("household_id","user_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "calendar_maintenance_receipts_household_space_idx" ON "emdo"."calendar_maintenance_receipts" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "calendar_maintenance_receipts_target_idx" ON "emdo"."calendar_maintenance_receipts" USING btree ("target_id","recorded_at");--> statement-breakpoint
CREATE INDEX "calendar_sync_states_household_space_idx" ON "emdo"."calendar_sync_states" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "encrypted_google_calendar_grants_household_space_idx" ON "emdo"."encrypted_google_calendar_grants" USING btree ("household_id","private_space_id");--> statement-breakpoint
CREATE INDEX "google_oauth_authorization_epochs_household_space_idx" ON "emdo"."google_oauth_authorization_epochs" USING btree ("household_id","private_space_id");--> statement-breakpoint
CREATE INDEX "google_oauth_flows_household_space_idx" ON "emdo"."google_oauth_flows" USING btree ("household_id","private_space_id");--> statement-breakpoint
CREATE INDEX "google_oauth_flows_actor_expiry_idx" ON "emdo"."google_oauth_flows" USING btree ("original_owner_user_id","expires_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_household_space_idx" ON "emdo"."notification_deliveries" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_notification_idx" ON "emdo"."notification_deliveries" USING btree ("notification_id","revision");--> statement-breakpoint
CREATE INDEX "notifications_household_space_idx" ON "emdo"."notifications" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "scheduler_reminders_household_space_idx" ON "emdo"."scheduler_reminders" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "scheduler_reminders_due_idx" ON "emdo"."scheduler_reminders" USING btree ("state","due_at");--> statement-breakpoint
CREATE INDEX "worker_job_executions_household_space_idx" ON "emdo"."worker_job_executions" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "worker_job_executions_state_lease_idx" ON "emdo"."worker_job_executions" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "worker_operation_outbox_household_space_idx" ON "emdo"."worker_operation_outbox" USING btree ("household_id","space_id");--> statement-breakpoint
CREATE INDEX "worker_operation_outbox_due_idx" ON "emdo"."worker_operation_outbox" USING btree ("state","available_at","created_at");--> statement-breakpoint
CREATE INDEX "worker_job_executions_exhausted_idx"
	ON "emdo"."worker_job_executions" ("updated_at", "job_name", "operation_id")
	WHERE "state" = 'failed' AND "attempt_count" = 5;
CREATE INDEX "notification_deliveries_reconciliation_idx"
	ON "emdo"."notification_deliveries"
	("household_id", "space_id", "original_owner_user_id", "attempted_at")
	WHERE "status" = 'indeterminate';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."acquire_worker_job_execution"(
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
		'emdo.notification.delivery.v1'
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
CREATE OR REPLACE FUNCTION "emdo"."complete_worker_job_execution"(
	p_job_name text,
	p_operation_id text,
	p_queue_job_id uuid,
	p_payload_hash text,
	p_lease_token uuid,
	p_state text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_now timestamptz := pg_catalog.clock_timestamp();
	v_attempt_count integer;
BEGIN
	IF p_queue_job_id IS NULL OR p_lease_token IS NULL
		OR p_payload_hash !~ '^[a-f0-9]{64}$'
		OR p_state NOT IN ('completed', 'failed')
	THEN
		RETURN 'conflict';
	END IF;

	UPDATE emdo.worker_job_executions
	SET state = p_state, completed_at = v_now, updated_at = v_now
	WHERE job_name = p_job_name AND operation_id = p_operation_id
		AND job_id = p_queue_job_id AND payload_hash = p_payload_hash
		AND lease_token = p_lease_token AND state = 'leased'
	RETURNING attempt_count INTO v_attempt_count;
	IF NOT FOUND THEN
		IF EXISTS (
			SELECT 1 FROM emdo.worker_job_executions
			WHERE job_name = p_job_name AND operation_id = p_operation_id
				AND job_id = p_queue_job_id AND payload_hash = p_payload_hash
				AND lease_token = p_lease_token AND state = p_state
		) THEN
			IF p_state = 'failed' AND EXISTS (
				SELECT 1 FROM emdo.worker_job_executions
				WHERE job_name = p_job_name AND operation_id = p_operation_id
					AND attempt_count >= 5
			) THEN
				RETURN 'exhausted';
			END IF;
			RETURN 'applied';
		END IF;
		RETURN 'conflict';
	END IF;

	IF p_state = 'completed' THEN
		UPDATE emdo.worker_operation_outbox
		SET state = 'completed', completed_at = v_now, updated_at = v_now
		WHERE job_name = p_job_name AND operation_id = p_operation_id
			AND queue_job_id = p_queue_job_id AND payload_hash = p_payload_hash
			AND state IN ('leased', 'enqueued');
	ELSIF v_attempt_count >= 5 THEN
		UPDATE emdo.worker_operation_outbox
		SET state = 'quarantined', safe_code = 'attempt-exhausted',
			completed_at = v_now, updated_at = v_now
		WHERE job_name = p_job_name AND operation_id = p_operation_id
			AND queue_job_id = p_queue_job_id AND payload_hash = p_payload_hash
			AND state IN ('leased', 'enqueued');
		RETURN 'exhausted';
	END IF;
	RETURN 'applied';
END
$function$;
--> statement-breakpoint
DO $roles$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_worker_executor'
	) THEN
		CREATE ROLE emdo_worker_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_worker_scope_executor'
	) THEN
		CREATE ROLE emdo_worker_scope_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_worker_dispatch_executor'
	) THEN
		CREATE ROLE emdo_worker_dispatch_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$roles$;
ALTER ROLE emdo_worker_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_worker_scope_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_worker_dispatch_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
--> statement-breakpoint
DO $membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname = 'emdo_worker_scope_executor'
			OR child.rolname = 'emdo_worker_scope_executor'
			OR child.rolname = 'emdo_worker_executor'
			OR child.rolname = 'emdo_worker_dispatch_executor'
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'worker scope executor must not have role memberships';
	END IF;
END
$membership_guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."current_worker_operation_id"()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, emdo
RETURN NULLIF(pg_catalog.current_setting('emdo.worker_operation_id', true), '');
CREATE OR REPLACE FUNCTION "emdo"."current_worker_job_name"()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, emdo
RETURN NULLIF(pg_catalog.current_setting('emdo.worker_job_name', true), '');
CREATE OR REPLACE FUNCTION "emdo"."current_worker_target_type"()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, emdo
RETURN NULLIF(pg_catalog.current_setting('emdo.worker_target_type', true), '');
CREATE OR REPLACE FUNCTION "emdo"."current_worker_target_id"()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, emdo
RETURN NULLIF(pg_catalog.current_setting('emdo.worker_target_id', true), '');
CREATE OR REPLACE FUNCTION "emdo"."current_worker_target_revision"()
RETURNS integer
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, emdo
RETURN NULLIF(pg_catalog.current_setting('emdo.worker_target_revision', true), '')::integer;
CREATE OR REPLACE FUNCTION "emdo"."current_worker_queue_job_id"()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, emdo
RETURN NULLIF(pg_catalog.current_setting('emdo.worker_queue_job_id', true), '')::uuid;
CREATE OR REPLACE FUNCTION "emdo"."current_worker_payload_hash"()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, emdo
RETURN NULLIF(pg_catalog.current_setting('emdo.worker_payload_hash', true), '');
CREATE OR REPLACE FUNCTION "emdo"."current_worker_execution_lease_token"()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, emdo
RETURN NULLIF(pg_catalog.current_setting('emdo.worker_execution_lease_token', true), '')::uuid;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."worker_outbox_binding_is_valid"(
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
		ELSE false
	END;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."is_active_worker_operation_scope"(
	p_household_id uuid,
	p_space_id uuid,
	p_owner_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
RETURN EXISTS (
	SELECT 1
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
	WHERE outbox.job_name = emdo.current_worker_job_name()
		AND outbox.operation_id = emdo.current_worker_operation_id()
		AND outbox.household_id = p_household_id
		AND outbox.space_id = p_space_id
		AND outbox.original_owner_user_id = p_owner_user_id
		AND outbox.queue_job_id = emdo.current_worker_queue_job_id()
		AND outbox.payload_hash = emdo.current_worker_payload_hash()
		AND outbox.request_id = emdo.current_request_id()
		AND outbox.original_owner_user_id = emdo.current_user_id()
		AND outbox.state IN ('leased', 'enqueued')
		AND execution.job_id = outbox.queue_job_id
		AND execution.state = 'leased'
		AND execution.lease_token = emdo.current_worker_execution_lease_token()
		AND execution.lease_expires_at > pg_catalog.clock_timestamp()
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
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."is_claimed_worker_operation_scope"(
	p_household_id uuid,
	p_space_id uuid,
	p_owner_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
RETURN EXISTS (
	SELECT 1
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
	WHERE outbox.job_name = emdo.current_worker_job_name()
		AND outbox.operation_id = emdo.current_worker_operation_id()
		AND outbox.household_id = p_household_id
		AND outbox.space_id = p_space_id
		AND outbox.original_owner_user_id = p_owner_user_id
		AND outbox.queue_job_id = emdo.current_worker_queue_job_id()
		AND outbox.payload_hash = emdo.current_worker_payload_hash()
		AND outbox.request_id = emdo.current_request_id()
		AND outbox.original_owner_user_id = emdo.current_user_id()
		AND outbox.state IN ('leased', 'enqueued')
		AND execution.job_id = outbox.queue_job_id
		AND execution.state = 'leased'
		AND execution.lease_token = emdo.current_worker_execution_lease_token()
		AND execution.lease_expires_at > pg_catalog.clock_timestamp()
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
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."claim_worker_operation_scope"(
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
		'emdo.notification.delivery.v1'
	) OR p_operation_id !~ '^[A-Za-z0-9:._-]{16,200}$'
		OR p_queue_job_id IS NULL OR p_execution_lease_token IS NULL
		OR p_payload_hash !~ '^[a-f0-9]{64}$' THEN
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

	PERFORM pg_catalog.set_config('emdo.user_id', v_outbox.original_owner_user_id::text, true);
	PERFORM pg_catalog.set_config('emdo.request_id', v_outbox.request_id::text, true);
	PERFORM pg_catalog.set_config('emdo.worker_job_name', v_outbox.job_name, true);
	PERFORM pg_catalog.set_config('emdo.worker_operation_id', v_outbox.operation_id, true);
	PERFORM pg_catalog.set_config('emdo.worker_queue_job_id', p_queue_job_id::text, true);
	PERFORM pg_catalog.set_config('emdo.worker_payload_hash', p_payload_hash, true);
	PERFORM pg_catalog.set_config(
		'emdo.worker_execution_lease_token',
		p_execution_lease_token::text,
		true
	);
	PERFORM pg_catalog.set_config('emdo.worker_target_type', v_outbox.target_type, true);
	PERFORM pg_catalog.set_config('emdo.worker_target_id', v_outbox.target_id, true);
	PERFORM pg_catalog.set_config(
		'emdo.worker_target_revision',
		COALESCE(v_outbox.target_revision::text, ''),
		true
	);
	PERFORM pg_catalog.set_config(
		'emdo.worker_retry_sequence',
		COALESCE(v_outbox.retry_sequence::text, ''),
		true
	);
	RETURN true;
END
$function$;
--> statement-breakpoint
ALTER TABLE "emdo"."worker_operation_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."worker_operation_outbox" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."worker_job_executions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."worker_job_executions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."scheduler_reminders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."scheduler_reminders" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."notifications" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."notification_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."notification_deliveries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."calendar_sync_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."calendar_sync_states" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."calendar_maintenance_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."calendar_maintenance_receipts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY worker_outbox_scope_executor_read ON "emdo"."worker_operation_outbox"
FOR SELECT TO emdo_worker_scope_executor USING (true);
CREATE POLICY worker_outbox_scope_executor_update ON "emdo"."worker_operation_outbox"
FOR UPDATE TO emdo_worker_scope_executor USING (true) WITH CHECK (true);
CREATE POLICY worker_executions_scope_executor_read ON "emdo"."worker_job_executions"
FOR SELECT TO emdo_worker_scope_executor USING (true);
CREATE POLICY worker_executions_scope_executor_insert ON "emdo"."worker_job_executions"
FOR INSERT TO emdo_worker_scope_executor WITH CHECK (true);
CREATE POLICY worker_executions_scope_executor_update ON "emdo"."worker_job_executions"
FOR UPDATE TO emdo_worker_scope_executor USING (true) WITH CHECK (true);
CREATE POLICY memberships_worker_scope_executor_read ON "emdo"."household_memberships"
FOR SELECT TO emdo_worker_scope_executor USING (true);
CREATE POLICY memberships_worker_scope_executor_lock ON "emdo"."household_memberships"
FOR UPDATE TO emdo_worker_scope_executor USING (true) WITH CHECK (true);
CREATE POLICY spaces_worker_scope_executor_read ON "emdo"."spaces"
FOR SELECT TO emdo_worker_scope_executor USING (true);
CREATE POLICY spaces_worker_scope_executor_lock ON "emdo"."spaces"
FOR UPDATE TO emdo_worker_scope_executor USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY worker_outbox_app_read ON "emdo"."worker_operation_outbox"
FOR SELECT TO emdo_app
USING (
	"original_owner_user_id" = emdo.current_user_id()
	AND emdo.is_active_request_scope("household_id", "space_id", NULL)
);
CREATE POLICY worker_outbox_app_insert ON "emdo"."worker_operation_outbox"
FOR INSERT TO emdo_app
WITH CHECK (
	"original_owner_user_id" = emdo.current_user_id()
	AND "request_id" = emdo.current_request_id()
	AND "state" = 'pending'
	AND "dispatch_attempts" = 0
	AND "lease_token" IS NULL AND "lease_owner" IS NULL
	AND "lease_expires_at" IS NULL AND "queue_job_id" IS NULL
	AND "safe_code" IS NULL AND "enqueued_at" IS NULL
	AND "completed_at" IS NULL
	AND emdo.is_active_request_scope("household_id", "space_id", NULL)
	AND emdo.worker_outbox_binding_is_valid(
		"job_name", "operation_id", "target_type", "target_id",
		"target_revision", "related_operation_id", "retry_sequence", "payload"
	)
);
--> statement-breakpoint
CREATE POLICY worker_outbox_worker_read ON "emdo"."worker_operation_outbox"
FOR SELECT TO emdo_worker_executor
USING (
	emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
	AND (
		("job_name" = emdo.current_worker_job_name()
			AND "operation_id" = emdo.current_worker_operation_id())
		OR (
			"job_name" = 'emdo.calendar.retry.v1'
			AND "related_operation_id" = emdo.current_worker_operation_id()
			AND "target_id" = emdo.current_worker_target_id()
		)
		OR (
			"job_name" = 'emdo.notification.delivery.v1'
			AND EXISTS (
				SELECT 1 FROM emdo.notifications AS notification
				WHERE notification.notification_id::text = "target_id"
					AND notification.source_type = 'reminder'
					AND notification.source_id = emdo.current_worker_target_id()
					AND notification.source_revision = emdo.current_worker_target_revision()
			)
		)
	)
);
CREATE POLICY worker_outbox_worker_insert ON "emdo"."worker_operation_outbox"
FOR INSERT TO emdo_worker_executor
WITH CHECK (
	"original_owner_user_id" = emdo.current_user_id()
	AND "request_id" = emdo.current_request_id()
	AND "state" = 'pending' AND "dispatch_attempts" = 0
	AND "lease_token" IS NULL AND "lease_owner" IS NULL
	AND "lease_expires_at" IS NULL AND "queue_job_id" IS NULL
	AND "safe_code" IS NULL AND "enqueued_at" IS NULL
	AND "completed_at" IS NULL
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
	AND emdo.worker_outbox_binding_is_valid(
		"job_name", "operation_id", "target_type", "target_id",
		"target_revision", "related_operation_id", "retry_sequence", "payload"
	)
	AND (
		(
			emdo.current_worker_job_name() IN (
				'emdo.calendar.sync.v1', 'emdo.calendar.retry.v1'
			)
			AND "job_name" = 'emdo.calendar.retry.v1'
			AND "related_operation_id" = emdo.current_worker_operation_id()
			AND "target_id" = emdo.current_worker_target_id()
			AND "retry_sequence" = COALESCE(
				NULLIF(pg_catalog.current_setting('emdo.worker_retry_sequence', true), '')::integer,
				0
			) + 1
		)
		OR (
			emdo.current_worker_job_name() = 'emdo.reminder.delivery.v1'
			AND "job_name" = 'emdo.notification.delivery.v1'
			AND EXISTS (
				SELECT 1 FROM emdo.notifications AS notification
				WHERE notification.notification_id::text = "target_id"
					AND notification.source_type = 'reminder'
					AND notification.source_id = emdo.current_worker_target_id()
					AND notification.source_revision = emdo.current_worker_target_revision()
			)
		)
	)
);
CREATE POLICY worker_outbox_worker_update ON "emdo"."worker_operation_outbox"
FOR UPDATE TO emdo_worker_executor
USING (
	emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
	AND "job_name" = emdo.current_worker_job_name()
	AND "operation_id" = emdo.current_worker_operation_id()
)
WITH CHECK (
	emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
	AND "job_name" = emdo.current_worker_job_name()
	AND "operation_id" = emdo.current_worker_operation_id()
);
--> statement-breakpoint
CREATE POLICY worker_executions_worker_read ON "emdo"."worker_job_executions"
FOR SELECT TO emdo_worker_executor
USING (
	emdo.is_claimed_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
	AND "job_name" = emdo.current_worker_job_name()
	AND "operation_id" = emdo.current_worker_operation_id()
);
CREATE POLICY worker_executions_worker_insert ON "emdo"."worker_job_executions"
FOR INSERT TO emdo_worker_executor
WITH CHECK (
	emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
	AND "job_name" = emdo.current_worker_job_name()
	AND "operation_id" = emdo.current_worker_operation_id()
);
CREATE POLICY worker_executions_worker_update ON "emdo"."worker_job_executions"
FOR UPDATE TO emdo_worker_executor
USING (
	emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
	AND "job_name" = emdo.current_worker_job_name()
	AND "operation_id" = emdo.current_worker_operation_id()
)
WITH CHECK (
	emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
	AND "job_name" = emdo.current_worker_job_name()
	AND "operation_id" = emdo.current_worker_operation_id()
);
CREATE POLICY reminders_worker_scope ON "emdo"."scheduler_reminders"
FOR ALL TO emdo_worker_executor
USING (
	emdo.current_worker_job_name() = 'emdo.reminder.delivery.v1'
	AND "reminder_id" = emdo.current_worker_target_id()
	AND "due_revision" = emdo.current_worker_target_revision()
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
)
WITH CHECK (
	emdo.current_worker_job_name() = 'emdo.reminder.delivery.v1'
	AND "reminder_id" = emdo.current_worker_target_id()
	AND "due_revision" = emdo.current_worker_target_revision()
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
);
CREATE POLICY notifications_worker_scope ON "emdo"."notifications"
FOR ALL TO emdo_worker_executor
USING (
	emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
	AND (
		(emdo.current_worker_job_name() = 'emdo.notification.delivery.v1'
			AND "notification_id"::text = emdo.current_worker_target_id()
			AND "revision" = emdo.current_worker_target_revision())
		OR (emdo.current_worker_job_name() = 'emdo.reminder.delivery.v1'
			AND "source_type" = 'reminder'
			AND "source_id" = emdo.current_worker_target_id()
			AND "source_revision" = emdo.current_worker_target_revision())
	)
)
WITH CHECK (
	emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
	AND emdo.current_worker_job_name() = 'emdo.reminder.delivery.v1'
	AND "source_type" = 'reminder'
	AND "source_id" = emdo.current_worker_target_id()
	AND "source_revision" = emdo.current_worker_target_revision()
);
CREATE POLICY notification_deliveries_worker_scope ON "emdo"."notification_deliveries"
FOR ALL TO emdo_worker_executor
USING (
	emdo.current_worker_job_name() = 'emdo.notification.delivery.v1'
	AND "notification_id"::text = emdo.current_worker_target_id()
	AND "revision" = emdo.current_worker_target_revision()
	AND "operation_id" = emdo.current_worker_operation_id()
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
)
WITH CHECK (
	emdo.current_worker_job_name() = 'emdo.notification.delivery.v1'
	AND "notification_id"::text = emdo.current_worker_target_id()
	AND "revision" = emdo.current_worker_target_revision()
	AND "operation_id" = emdo.current_worker_operation_id()
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
);
CREATE POLICY calendar_sync_worker_scope ON "emdo"."calendar_sync_states"
FOR ALL TO emdo_worker_executor
USING (
	emdo.current_worker_job_name() IN (
		'emdo.calendar.sync.v1', 'emdo.calendar.retry.v1'
	)
	AND "connection_id" = emdo.current_worker_target_id()
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
)
WITH CHECK (
	emdo.current_worker_job_name() IN (
		'emdo.calendar.sync.v1', 'emdo.calendar.retry.v1'
	)
	AND "connection_id" = emdo.current_worker_target_id()
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
);
CREATE POLICY calendar_receipts_worker_scope ON "emdo"."calendar_maintenance_receipts"
FOR ALL TO emdo_worker_executor
USING (
	"operation_id" = emdo.current_worker_operation_id()
	AND "target_id" = emdo.current_worker_target_id()
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
)
WITH CHECK (
	"operation_id" = emdo.current_worker_operation_id()
	AND "target_id" = emdo.current_worker_target_id()
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
);
--> statement-breakpoint
CREATE POLICY provider_attempts_worker_reconciliation ON "emdo"."provider_attempts"
FOR SELECT TO emdo_worker_executor
USING (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND "id"::text = emdo.current_worker_target_id()
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
);
CREATE POLICY provider_outcomes_worker_reconciliation ON "emdo"."provider_outcomes"
FOR SELECT TO emdo_worker_executor
USING (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND "attempt_id"::text = emdo.current_worker_target_id()
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
);
CREATE POLICY proposal_reconciliations_worker_scope ON "emdo"."proposal_reconciliations"
FOR ALL TO emdo_worker_executor
USING (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND "attempt_id"::text = emdo.current_worker_target_id()
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
)
WITH CHECK (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND "attempt_id"::text = emdo.current_worker_target_id()
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
);
--> statement-breakpoint
ALTER FUNCTION "emdo"."current_worker_operation_id"() OWNER TO emdo_worker_scope_executor;
ALTER FUNCTION "emdo"."current_worker_job_name"() OWNER TO emdo_worker_scope_executor;
ALTER FUNCTION "emdo"."current_worker_target_type"() OWNER TO emdo_worker_scope_executor;
ALTER FUNCTION "emdo"."current_worker_target_id"() OWNER TO emdo_worker_scope_executor;
ALTER FUNCTION "emdo"."current_worker_target_revision"() OWNER TO emdo_worker_scope_executor;
ALTER FUNCTION "emdo"."current_worker_queue_job_id"() OWNER TO emdo_worker_scope_executor;
ALTER FUNCTION "emdo"."current_worker_payload_hash"() OWNER TO emdo_worker_scope_executor;
ALTER FUNCTION "emdo"."current_worker_execution_lease_token"() OWNER TO emdo_worker_scope_executor;
ALTER FUNCTION "emdo"."worker_outbox_binding_is_valid"(text, text, text, text, integer, text, integer, jsonb)
	OWNER TO emdo_worker_scope_executor;
ALTER FUNCTION "emdo"."is_active_worker_operation_scope"(uuid, uuid, uuid)
	OWNER TO emdo_worker_scope_executor;
ALTER FUNCTION "emdo"."is_claimed_worker_operation_scope"(uuid, uuid, uuid)
	OWNER TO emdo_worker_scope_executor;
ALTER FUNCTION "emdo"."claim_worker_operation_scope"(text, text, uuid, text, uuid, text, text, integer, text, integer)
	OWNER TO emdo_worker_scope_executor;
ALTER FUNCTION "emdo"."claim_due_worker_outbox"(text, integer, integer)
	OWNER TO emdo_worker_scope_executor;
ALTER FUNCTION "emdo"."bind_worker_outbox_queue_job"(uuid, uuid, uuid, text)
	OWNER TO emdo_worker_scope_executor;
ALTER FUNCTION "emdo"."mark_worker_outbox_enqueued"(uuid, uuid, uuid)
	OWNER TO emdo_worker_scope_executor;
ALTER FUNCTION "emdo"."mark_worker_outbox_failed"(uuid, uuid, timestamptz, text)
	OWNER TO emdo_worker_scope_executor;
ALTER FUNCTION "emdo"."acquire_worker_job_execution"(text, text, uuid, text)
	OWNER TO emdo_worker_scope_executor;
ALTER FUNCTION "emdo"."complete_worker_job_execution"(text, text, uuid, text, uuid, text)
	OWNER TO emdo_worker_scope_executor;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "emdo" FROM emdo_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "emdo" FROM emdo_worker;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA "emdo" FROM emdo_worker;
GRANT USAGE ON SCHEMA "emdo" TO emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor;
GRANT SELECT, UPDATE ON "emdo"."worker_operation_outbox"
	TO emdo_worker_scope_executor;
GRANT SELECT, INSERT, UPDATE ON "emdo"."worker_job_executions"
	TO emdo_worker_scope_executor;
GRANT SELECT (id, email_verified), UPDATE (id) ON "emdo"."auth_users"
	TO emdo_worker_scope_executor;
GRANT SELECT, UPDATE (household_id) ON "emdo"."household_memberships"
	TO emdo_worker_scope_executor;
GRANT SELECT, UPDATE (id) ON "emdo"."spaces"
	TO emdo_worker_scope_executor;
GRANT SELECT, INSERT ON "emdo"."worker_operation_outbox"
	TO emdo_worker_executor;
GRANT SELECT ON "emdo"."scheduler_reminders" TO emdo_worker_executor;
GRANT UPDATE (state, delivered_revision, delivered_at, updated_at)
	ON "emdo"."scheduler_reminders" TO emdo_worker_executor;
GRANT SELECT, INSERT ON "emdo"."notifications" TO emdo_worker_executor;
GRANT SELECT, INSERT ON "emdo"."notification_deliveries"
	TO emdo_worker_executor;
GRANT UPDATE (status, updated_at) ON "emdo"."notification_deliveries"
	TO emdo_worker_executor;
GRANT SELECT ON "emdo"."calendar_sync_states" TO emdo_worker_executor;
GRANT UPDATE (sync_generation, sealed_cursor, provider_version, state,
	retry_sequence, last_safe_code, last_evidence_hash, last_synced_at,
	updated_at)
	ON "emdo"."calendar_sync_states" TO emdo_worker_executor;
GRANT SELECT, INSERT ON "emdo"."calendar_maintenance_receipts"
	TO emdo_worker_executor;
GRANT SELECT ON "emdo"."provider_attempts", "emdo"."provider_outcomes"
	TO emdo_worker_executor;
GRANT SELECT, INSERT ON "emdo"."proposal_reconciliations"
	TO emdo_worker_executor;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
	"emdo"."current_worker_operation_id"(),
	"emdo"."current_worker_job_name"(),
	"emdo"."current_worker_target_type"(),
	"emdo"."current_worker_target_id"(),
	"emdo"."current_worker_target_revision"(),
	"emdo"."current_worker_queue_job_id"(),
	"emdo"."current_worker_payload_hash"(),
	"emdo"."current_worker_execution_lease_token"(),
	"emdo"."worker_outbox_binding_is_valid"(text, text, text, text, integer, text, integer, jsonb),
	"emdo"."is_active_worker_operation_scope"(uuid, uuid, uuid),
	"emdo"."is_claimed_worker_operation_scope"(uuid, uuid, uuid),
	"emdo"."claim_worker_operation_scope"(text, text, uuid, text, uuid, text, text, integer, text, integer),
	"emdo"."claim_due_worker_outbox"(text, integer, integer),
	"emdo"."bind_worker_outbox_queue_job"(uuid, uuid, uuid, text),
	"emdo"."mark_worker_outbox_enqueued"(uuid, uuid, uuid),
	"emdo"."mark_worker_outbox_failed"(uuid, uuid, timestamptz, text),
	"emdo"."acquire_worker_job_execution"(text, text, uuid, text),
	"emdo"."complete_worker_job_execution"(text, text, uuid, text, uuid, text)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."current_worker_operation_id"(),
	"emdo"."current_worker_job_name"(),
	"emdo"."current_worker_target_type"(),
	"emdo"."current_worker_target_id"(),
	"emdo"."current_worker_target_revision"(),
	"emdo"."current_worker_queue_job_id"(),
	"emdo"."current_worker_payload_hash"(),
	"emdo"."current_worker_execution_lease_token"(),
	"emdo"."is_active_worker_operation_scope"(uuid, uuid, uuid),
	"emdo"."is_claimed_worker_operation_scope"(uuid, uuid, uuid)
	TO emdo_worker_executor, emdo_worker_scope_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."worker_outbox_binding_is_valid"(text, text, text, text, integer, text, integer, jsonb)
	TO emdo_app, emdo_worker_executor, emdo_worker_scope_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."claim_worker_operation_scope"(text, text, uuid, text, uuid, text, text, integer, text, integer),
	"emdo"."acquire_worker_job_execution"(text, text, uuid, text),
	"emdo"."complete_worker_job_execution"(text, text, uuid, text, uuid, text)
	TO emdo_worker_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."claim_due_worker_outbox"(text, integer, integer),
	"emdo"."bind_worker_outbox_queue_job"(uuid, uuid, uuid, text),
	"emdo"."mark_worker_outbox_enqueued"(uuid, uuid, uuid),
	"emdo"."mark_worker_outbox_failed"(uuid, uuid, timestamptz, text)
	TO emdo_worker_dispatch_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."current_user_id"(), "emdo"."current_request_id"()
	TO emdo_worker_executor, emdo_worker_scope_executor;
--> statement-breakpoint
DO $runtime_membership$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_worker_login'
	) THEN
		REVOKE emdo_worker FROM emdo_worker_login;
		REVOKE emdo_worker_executor FROM emdo_worker_login;
		REVOKE emdo_worker_dispatch_executor FROM emdo_worker_login;
	END IF;
	IF EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_worker_executor_login'
	) THEN
		REVOKE emdo_worker FROM emdo_worker_executor_login;
		REVOKE emdo_worker_dispatch_executor FROM emdo_worker_executor_login;
		GRANT emdo_worker_executor TO emdo_worker_executor_login;
	END IF;
	IF EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_worker_dispatcher_login'
	) THEN
		REVOKE emdo_worker FROM emdo_worker_dispatcher_login;
		REVOKE emdo_worker_executor FROM emdo_worker_dispatcher_login;
		GRANT emdo_worker_dispatch_executor TO emdo_worker_dispatcher_login;
	END IF;
END
$runtime_membership$;
--> statement-breakpoint
DO $roles$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_oauth_flow_executor'
	) THEN
		CREATE ROLE emdo_oauth_flow_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_oauth_grant_executor'
	) THEN
		CREATE ROLE emdo_oauth_grant_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$roles$;
ALTER ROLE emdo_oauth_flow_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_oauth_grant_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
--> statement-breakpoint
DO $membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname IN (
			'emdo_oauth_flow_executor', 'emdo_oauth_grant_executor'
		)
			OR child.rolname IN (
				'emdo_oauth_flow_executor', 'emdo_oauth_grant_executor'
			)
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'oauth executors must not have role memberships';
	END IF;
END
$membership_guard$;
--> statement-breakpoint
ALTER TABLE "emdo"."google_oauth_flows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."google_oauth_flows" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."google_oauth_authorization_epochs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."google_oauth_authorization_epochs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."encrypted_google_calendar_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."encrypted_google_calendar_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY google_oauth_flows_app_scope ON "emdo"."google_oauth_flows"
FOR ALL TO emdo_app
USING (
	"original_owner_user_id" = emdo.current_user_id()
	AND "session_id" = emdo.current_session_id()
	AND emdo.is_active_request_scope("household_id", "private_space_id", NULL)
)
WITH CHECK (
	"original_owner_user_id" = emdo.current_user_id()
	AND "session_id" = emdo.current_session_id()
	AND emdo.is_active_request_scope("household_id", "private_space_id", NULL)
);
CREATE POLICY google_oauth_flows_executor_scope ON "emdo"."google_oauth_flows"
FOR SELECT TO emdo_oauth_flow_executor USING (true);
CREATE POLICY google_oauth_flows_executor_lock ON "emdo"."google_oauth_flows"
FOR UPDATE TO emdo_oauth_flow_executor USING (true) WITH CHECK (true);
CREATE POLICY google_oauth_flows_executor_delete ON "emdo"."google_oauth_flows"
FOR DELETE TO emdo_oauth_flow_executor USING (true);
CREATE POLICY google_oauth_epochs_executor_scope
ON "emdo"."google_oauth_authorization_epochs"
FOR ALL TO emdo_oauth_grant_executor USING (true) WITH CHECK (true);
CREATE POLICY encrypted_google_grants_executor_scope
ON "emdo"."encrypted_google_calendar_grants"
FOR ALL TO emdo_oauth_grant_executor USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."consume_google_oauth_flow"(
	p_id text,
	p_user_id uuid,
	p_household_id uuid,
	p_private_space_id uuid,
	p_session_id uuid
)
RETURNS TABLE (status text, flow jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_flow emdo.google_oauth_flows%ROWTYPE;
BEGIN
	IF p_id !~ '^[A-Za-z0-9_-]{43}$'
		OR p_user_id IS DISTINCT FROM emdo.current_user_id()
		OR p_session_id IS DISTINCT FROM emdo.current_session_id()
		OR p_household_id IS NULL OR p_private_space_id IS NULL
		OR NOT emdo.lock_active_request_scope(
			p_household_id, p_private_space_id, NULL
		)
	THEN
		RETURN QUERY SELECT 'binding-mismatch'::text, NULL::jsonb;
		RETURN;
	END IF;

	SELECT stored.* INTO v_flow
	FROM emdo.google_oauth_flows AS stored
	WHERE stored.id = p_id
	FOR UPDATE;
	IF NOT FOUND THEN
		RETURN QUERY SELECT 'missing'::text, NULL::jsonb;
		RETURN;
	END IF;

	IF v_flow.original_owner_user_id IS DISTINCT FROM p_user_id
		OR v_flow.household_id IS DISTINCT FROM p_household_id
		OR v_flow.private_space_id IS DISTINCT FROM p_private_space_id
		OR v_flow.session_id IS DISTINCT FROM p_session_id
	THEN
		RETURN QUERY SELECT 'binding-mismatch'::text, NULL::jsonb;
		RETURN;
	END IF;

	DELETE FROM emdo.google_oauth_flows WHERE id = v_flow.id;
	IF v_flow.expires_at <= pg_catalog.clock_timestamp() THEN
		RETURN QUERY SELECT 'expired'::text, NULL::jsonb;
		RETURN;
	END IF;

	RETURN QUERY SELECT 'consumed'::text, pg_catalog.jsonb_build_object(
		'id', v_flow.id,
		'household_id', v_flow.household_id,
		'private_space_id', v_flow.private_space_id,
		'original_owner_user_id', v_flow.original_owner_user_id,
		'session_id', v_flow.session_id,
		'redirect_uri', v_flow.redirect_uri,
		'purpose', v_flow.purpose,
		'requested_scopes', v_flow.requested_scopes,
		'credential_revision_at_start', v_flow.credential_revision_at_start,
		'authorization_epoch_at_start', v_flow.authorization_epoch_at_start,
		'code_verifier', v_flow.code_verifier,
		'created_at', v_flow.created_at,
		'expires_at', v_flow.expires_at
	);
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."invalidate_google_oauth_flows"(
	p_user_id uuid,
	p_household_id uuid,
	p_private_space_id uuid
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
	IF p_user_id IS DISTINCT FROM emdo.current_user_id()
		OR p_household_id IS NULL OR p_private_space_id IS NULL
		OR NOT emdo.lock_active_request_scope(
			p_household_id, p_private_space_id, NULL
		)
	THEN
		RETURN 0;
	END IF;
	DELETE FROM emdo.google_oauth_flows
	WHERE household_id = p_household_id
		AND private_space_id = p_private_space_id
		AND original_owner_user_id = p_user_id;
	GET DIAGNOSTICS v_deleted = ROW_COUNT;
	RETURN v_deleted;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."load_google_oauth_authorization_epoch"(
	p_user_id uuid,
	p_household_id uuid,
	p_private_space_id uuid
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_epoch integer;
BEGIN
	IF p_user_id IS DISTINCT FROM emdo.current_user_id()
		OR p_household_id IS NULL OR p_private_space_id IS NULL
		OR NOT emdo.lock_active_request_scope(
			p_household_id, p_private_space_id, NULL
		)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '42501',
			MESSAGE = 'oauth grant scope is unavailable';
	END IF;
	SELECT stored.authorization_epoch INTO v_epoch
	FROM emdo.google_oauth_authorization_epochs AS stored
	WHERE stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_user_id;
	RETURN COALESCE(v_epoch, 0);
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."advance_google_oauth_authorization_epoch"(
	p_user_id uuid,
	p_household_id uuid,
	p_private_space_id uuid,
	p_expected_epoch integer
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_epoch integer;
	v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
	IF p_user_id IS DISTINCT FROM emdo.current_user_id()
		OR p_household_id IS NULL OR p_private_space_id IS NULL
		OR p_expected_epoch IS NULL OR p_expected_epoch < 0
		OR NOT emdo.lock_active_request_scope(
			p_household_id, p_private_space_id, NULL
		)
	THEN
		RETURN NULL;
	END IF;
	IF p_expected_epoch = 0 THEN
		INSERT INTO emdo.google_oauth_authorization_epochs(
			household_id, private_space_id, original_owner_user_id,
			authorization_epoch, created_at, updated_at
		) VALUES (
			p_household_id, p_private_space_id, p_user_id, 1, v_now, v_now
		)
		ON CONFLICT (household_id, private_space_id, original_owner_user_id)
			DO NOTHING
		RETURNING authorization_epoch INTO v_epoch;
		IF FOUND THEN
			RETURN v_epoch;
		END IF;
	END IF;
	UPDATE emdo.google_oauth_authorization_epochs AS stored
	SET authorization_epoch = stored.authorization_epoch + 1,
		updated_at = v_now
	WHERE stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_user_id
		AND stored.authorization_epoch = p_expected_epoch
	RETURNING stored.authorization_epoch INTO v_epoch;
	RETURN v_epoch;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."load_encrypted_google_calendar_grant"(
	p_record_id text,
	p_household_id uuid,
	p_private_space_id uuid,
	p_user_id uuid
)
RETURNS SETOF "emdo"."encrypted_google_calendar_grants"
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
BEGIN
	IF p_user_id IS DISTINCT FROM emdo.current_user_id()
		OR p_record_id IS NULL
		OR p_household_id IS NULL OR p_private_space_id IS NULL
		OR NOT emdo.lock_active_request_scope(
			p_household_id, p_private_space_id, NULL
		)
	THEN
		RETURN;
	END IF;
	RETURN QUERY
	SELECT stored.*
	FROM emdo.encrypted_google_calendar_grants AS stored
	WHERE stored.record_id = p_record_id
		AND stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_user_id
		AND stored.provider = 'google'
		AND stored.grant_type = 'calendar-authorization';
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."compare_and_set_encrypted_google_calendar_grant"(
	p_record_id text,
	p_household_id uuid,
	p_private_space_id uuid,
	p_user_id uuid,
	p_expected_revision integer,
	p_authorization_epoch integer,
	p_provider_grant_reference text,
	p_encrypted_payload jsonb
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_current_epoch integer;
	v_revision integer;
	v_now timestamptz := pg_catalog.clock_timestamp();
	v_expected_record_id text;
BEGIN
	v_expected_record_id := 'google-calendar-oauth-v1-' || pg_catalog.encode(
		pg_catalog.sha256(
			pg_catalog.convert_to(p_user_id::text, 'UTF8')
		),
		'hex'
	);
	IF p_user_id IS DISTINCT FROM emdo.current_user_id()
		OR p_household_id IS NULL OR p_private_space_id IS NULL
		OR p_record_id IS DISTINCT FROM v_expected_record_id
		OR (p_expected_revision IS NOT NULL AND p_expected_revision <= 0)
		OR p_authorization_epoch IS NULL OR p_authorization_epoch < 0
		OR p_provider_grant_reference IS NULL
		OR pg_catalog.length(p_provider_grant_reference) NOT BETWEEN 16 AND 160
		OR pg_catalog.btrim(p_provider_grant_reference)
			IS DISTINCT FROM p_provider_grant_reference
		OR p_provider_grant_reference ~ '[[:cntrl:]]'
		OR p_encrypted_payload IS NULL
		OR emdo.is_valid_encrypted_google_calendar_grant_payload(
			p_encrypted_payload
		) IS NOT TRUE
		OR pg_catalog.octet_length(p_encrypted_payload::text)
			NOT BETWEEN 1 AND 65536
		OR NOT emdo.lock_active_request_scope(
			p_household_id, p_private_space_id, NULL
		)
	THEN
		RETURN NULL;
	END IF;
	IF p_authorization_epoch = 0 THEN
		INSERT INTO emdo.google_oauth_authorization_epochs(
			household_id, private_space_id, original_owner_user_id,
			authorization_epoch, created_at, updated_at
		) VALUES (
			p_household_id, p_private_space_id, p_user_id, 0, v_now, v_now
		)
		ON CONFLICT (household_id, private_space_id, original_owner_user_id)
			DO NOTHING;
	END IF;
	SELECT stored.authorization_epoch INTO v_current_epoch
	FROM emdo.google_oauth_authorization_epochs AS stored
	WHERE stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_user_id
	FOR SHARE OF stored;
	IF NOT FOUND OR v_current_epoch IS DISTINCT FROM p_authorization_epoch THEN
		RETURN NULL;
	END IF;
	IF p_expected_revision IS NULL THEN
		INSERT INTO emdo.encrypted_google_calendar_grants(
			record_id, household_id, private_space_id,
			original_owner_user_id, provider, grant_type, revision,
			authorization_epoch, provider_grant_reference, encrypted_payload,
			created_at, updated_at
		) VALUES (
			p_record_id, p_household_id, p_private_space_id, p_user_id,
			'google', 'calendar-authorization', 1, p_authorization_epoch,
			p_provider_grant_reference, p_encrypted_payload, v_now, v_now
		)
		ON CONFLICT (record_id) DO NOTHING
		RETURNING revision INTO v_revision;
	ELSE
		UPDATE emdo.encrypted_google_calendar_grants AS stored
		SET revision = stored.revision + 1,
			authorization_epoch = p_authorization_epoch,
			provider_grant_reference = p_provider_grant_reference,
			encrypted_payload = p_encrypted_payload,
			updated_at = v_now
		WHERE stored.record_id = p_record_id
			AND stored.revision = p_expected_revision
			AND stored.household_id = p_household_id
			AND stored.private_space_id = p_private_space_id
			AND stored.original_owner_user_id = p_user_id
			AND stored.provider = 'google'
			AND stored.grant_type = 'calendar-authorization'
		RETURNING stored.revision INTO v_revision;
	END IF;
	RETURN v_revision;
EXCEPTION
	WHEN unique_violation THEN
		RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."delete_encrypted_google_calendar_grant"(
	p_record_id text,
	p_household_id uuid,
	p_private_space_id uuid,
	p_user_id uuid,
	p_expected_revision integer
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
BEGIN
	IF p_user_id IS DISTINCT FROM emdo.current_user_id()
		OR p_record_id IS NULL
		OR p_household_id IS NULL OR p_private_space_id IS NULL
		OR p_expected_revision IS NULL OR p_expected_revision <= 0
		OR NOT emdo.lock_active_request_scope(
			p_household_id, p_private_space_id, NULL
		)
	THEN
		RETURN false;
	END IF;
	DELETE FROM emdo.encrypted_google_calendar_grants AS stored
	WHERE stored.record_id = p_record_id
		AND stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_user_id
		AND stored.revision = p_expected_revision
		AND stored.provider = 'google'
		AND stored.grant_type = 'calendar-authorization';
	RETURN FOUND;
END
$function$;
--> statement-breakpoint
ALTER FUNCTION "emdo"."consume_google_oauth_flow"(text, uuid, uuid, uuid, uuid)
	OWNER TO emdo_oauth_flow_executor;
ALTER FUNCTION "emdo"."invalidate_google_oauth_flows"(uuid, uuid, uuid)
	OWNER TO emdo_oauth_flow_executor;
ALTER FUNCTION "emdo"."load_google_oauth_authorization_epoch"(uuid, uuid, uuid)
	OWNER TO emdo_oauth_grant_executor;
ALTER FUNCTION "emdo"."advance_google_oauth_authorization_epoch"(uuid, uuid, uuid, integer)
	OWNER TO emdo_oauth_grant_executor;
ALTER FUNCTION "emdo"."is_valid_encrypted_google_calendar_grant_payload"(jsonb)
	OWNER TO emdo_oauth_grant_executor;
ALTER FUNCTION "emdo"."load_encrypted_google_calendar_grant"(text, uuid, uuid, uuid)
	OWNER TO emdo_oauth_grant_executor;
ALTER FUNCTION "emdo"."compare_and_set_encrypted_google_calendar_grant"(text, uuid, uuid, uuid, integer, integer, text, jsonb)
	OWNER TO emdo_oauth_grant_executor;
ALTER FUNCTION "emdo"."delete_encrypted_google_calendar_grant"(text, uuid, uuid, uuid, integer)
	OWNER TO emdo_oauth_grant_executor;
GRANT USAGE ON SCHEMA "emdo" TO emdo_oauth_flow_executor;
GRANT USAGE ON SCHEMA "emdo" TO emdo_oauth_grant_executor;
GRANT SELECT, UPDATE (id), DELETE ON "emdo"."google_oauth_flows"
	TO emdo_oauth_flow_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON
	"emdo"."google_oauth_authorization_epochs",
	"emdo"."encrypted_google_calendar_grants"
	TO emdo_oauth_grant_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."current_user_id"(), "emdo"."current_session_id"(),
	"emdo"."lock_active_request_scope"(uuid, uuid, uuid)
	TO emdo_oauth_flow_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."current_user_id"(), "emdo"."current_session_id"(),
	"emdo"."current_request_id"(),
	"emdo"."lock_active_request_scope"(uuid, uuid, uuid)
	TO emdo_oauth_grant_executor;
REVOKE ALL ON FUNCTION
	"emdo"."consume_google_oauth_flow"(text, uuid, uuid, uuid, uuid),
	"emdo"."invalidate_google_oauth_flows"(uuid, uuid, uuid),
	"emdo"."load_google_oauth_authorization_epoch"(uuid, uuid, uuid),
	"emdo"."advance_google_oauth_authorization_epoch"(uuid, uuid, uuid, integer),
	"emdo"."is_valid_encrypted_google_calendar_grant_payload"(jsonb),
	"emdo"."load_encrypted_google_calendar_grant"(text, uuid, uuid, uuid),
	"emdo"."compare_and_set_encrypted_google_calendar_grant"(text, uuid, uuid, uuid, integer, integer, text, jsonb),
	"emdo"."delete_encrypted_google_calendar_grant"(text, uuid, uuid, uuid, integer)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow, emdo_policy_reader,
	emdo_metering_executor, emdo_worker_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_oauth_grant_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."is_valid_encrypted_google_calendar_grant_payload"(jsonb)
	TO emdo_oauth_grant_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."consume_google_oauth_flow"(text, uuid, uuid, uuid, uuid),
	"emdo"."invalidate_google_oauth_flows"(uuid, uuid, uuid),
	"emdo"."load_google_oauth_authorization_epoch"(uuid, uuid, uuid),
	"emdo"."advance_google_oauth_authorization_epoch"(uuid, uuid, uuid, integer),
	"emdo"."load_encrypted_google_calendar_grant"(text, uuid, uuid, uuid),
	"emdo"."compare_and_set_encrypted_google_calendar_grant"(text, uuid, uuid, uuid, integer, integer, text, jsonb),
	"emdo"."delete_encrypted_google_calendar_grant"(text, uuid, uuid, uuid, integer)
	TO emdo_app;
REVOKE ALL ON "emdo"."google_oauth_flows",
	"emdo"."google_oauth_authorization_epochs",
	"emdo"."encrypted_google_calendar_grants"
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_scope_executor, emdo_oauth_grant_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON "emdo"."google_oauth_flows"
	TO emdo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
	"emdo"."google_oauth_authorization_epochs",
	"emdo"."encrypted_google_calendar_grants"
	TO emdo_oauth_grant_executor;
--> statement-breakpoint
CREATE POLICY reminders_app_read ON "emdo"."scheduler_reminders"
FOR SELECT TO emdo_app
USING (
	"original_owner_user_id" = emdo.current_user_id()
	AND emdo.is_active_request_scope("household_id", "space_id", NULL)
);
CREATE POLICY reminders_app_insert ON "emdo"."scheduler_reminders"
FOR INSERT TO emdo_app
WITH CHECK (
	"original_owner_user_id" = emdo.current_user_id()
	AND emdo.is_active_request_scope("household_id", "space_id", NULL)
);
CREATE POLICY reminders_app_update ON "emdo"."scheduler_reminders"
FOR UPDATE TO emdo_app
USING (
	"original_owner_user_id" = emdo.current_user_id()
	AND emdo.is_active_request_scope("household_id", "space_id", NULL)
)
WITH CHECK (
	"original_owner_user_id" = emdo.current_user_id()
	AND emdo.is_active_request_scope("household_id", "space_id", NULL)
);
CREATE POLICY notifications_app_read ON "emdo"."notifications"
FOR SELECT TO emdo_app
USING (
	"original_owner_user_id" = emdo.current_user_id()
	AND emdo.is_active_request_scope("household_id", "space_id", NULL)
);
CREATE POLICY notification_deliveries_app_read ON "emdo"."notification_deliveries"
FOR SELECT TO emdo_app
USING (
	"original_owner_user_id" = emdo.current_user_id()
	AND emdo.is_active_request_scope("household_id", "space_id", NULL)
);
CREATE POLICY calendar_sync_app_scope ON "emdo"."calendar_sync_states"
FOR ALL TO emdo_app
USING (
	"original_owner_user_id" = emdo.current_user_id()
	AND emdo.is_active_request_scope("household_id", "space_id", NULL)
)
WITH CHECK (
	"original_owner_user_id" = emdo.current_user_id()
	AND emdo.is_active_request_scope("household_id", "space_id", NULL)
);
CREATE POLICY calendar_receipts_app_read ON "emdo"."calendar_maintenance_receipts"
FOR SELECT TO emdo_app
USING (
	"original_owner_user_id" = emdo.current_user_id()
	AND emdo.is_active_request_scope("household_id", "space_id", NULL)
);
GRANT SELECT, INSERT, UPDATE ON "emdo"."scheduler_reminders"
	TO emdo_app;
GRANT SELECT ON "emdo"."notifications", "emdo"."notification_deliveries",
	"emdo"."calendar_maintenance_receipts"
	TO emdo_app;
GRANT SELECT, INSERT, UPDATE ON "emdo"."calendar_sync_states"
	TO emdo_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."enforce_worker_outbox_transition"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, emdo
AS $function$
BEGIN
	IF NEW.household_id IS DISTINCT FROM OLD.household_id
		OR NEW.space_id IS DISTINCT FROM OLD.space_id
		OR NEW.original_owner_user_id IS DISTINCT FROM OLD.original_owner_user_id
		OR NEW.request_id IS DISTINCT FROM OLD.request_id
		OR NEW.job_name IS DISTINCT FROM OLD.job_name
		OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
		OR NEW.target_type IS DISTINCT FROM OLD.target_type
		OR NEW.target_id IS DISTINCT FROM OLD.target_id
		OR NEW.target_revision IS DISTINCT FROM OLD.target_revision
		OR NEW.related_operation_id IS DISTINCT FROM OLD.related_operation_id
		OR NEW.retry_sequence IS DISTINCT FROM OLD.retry_sequence
		OR NEW.payload IS DISTINCT FROM OLD.payload
		OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
		OR NEW.retain_until IS DISTINCT FROM OLD.retain_until
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'worker-outbox-binding-immutable';
	END IF;
	IF OLD.queue_job_id IS NOT NULL
		AND NEW.queue_job_id IS DISTINCT FROM OLD.queue_job_id
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'worker-outbox-queue-binding-immutable';
	END IF;
	IF OLD.queue_job_id IS NULL AND NEW.queue_job_id IS NOT NULL
		AND NOT (
			OLD.state = 'leased' AND NEW.state = 'leased'
			AND OLD.lease_token IS NOT NULL
			AND NEW.lease_token = OLD.lease_token
			AND OLD.lease_expires_at > pg_catalog.clock_timestamp()
		)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'worker-outbox-queue-binding-invalid';
	END IF;
	IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
		(OLD.state IN ('pending', 'dispatch-failed') AND NEW.state = 'leased')
		OR (OLD.state = 'leased' AND NEW.state IN (
			'enqueued', 'dispatch-failed', 'quarantined', 'completed'
		))
		OR (OLD.state = 'enqueued' AND NEW.state IN ('completed', 'quarantined'))
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'worker-outbox-transition-invalid';
	END IF;
	IF (NEW.state = 'leased' AND (
		NEW.lease_token IS NULL OR NEW.lease_owner IS NULL
		OR NEW.lease_expires_at IS NULL
	)) OR (NEW.state = 'enqueued' AND NEW.enqueued_at IS NULL)
		OR (NEW.state = 'completed' AND NEW.completed_at IS NULL)
		OR (NEW.state = 'quarantined' AND (
			NEW.safe_code IS NULL OR NEW.completed_at IS NULL
		))
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'worker-outbox-state-shape-invalid';
	END IF;
	RETURN NEW;
END
$function$;
CREATE TRIGGER worker_operation_outbox_transition
BEFORE UPDATE ON "emdo"."worker_operation_outbox"
FOR EACH ROW EXECUTE FUNCTION "emdo"."enforce_worker_outbox_transition"();
REVOKE ALL ON FUNCTION "emdo"."enforce_worker_outbox_transition"()
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_scope_executor, emdo_oauth_flow_executor;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."enforce_worker_execution_transition"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, emdo
AS $function$
BEGIN
	IF NEW.execution_id IS DISTINCT FROM OLD.execution_id
		OR NEW.outbox_id IS DISTINCT FROM OLD.outbox_id
		OR NEW.household_id IS DISTINCT FROM OLD.household_id
		OR NEW.space_id IS DISTINCT FROM OLD.space_id
		OR NEW.original_owner_user_id IS DISTINCT FROM OLD.original_owner_user_id
		OR NEW.job_id IS DISTINCT FROM OLD.job_id
		OR NEW.job_name IS DISTINCT FROM OLD.job_name
		OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
		OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
		OR NEW.started_at IS DISTINCT FROM OLD.started_at
		OR NEW.retain_until IS DISTINCT FROM OLD.retain_until
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'worker-execution-binding-immutable';
	END IF;
	IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
		(OLD.state = 'leased' AND NEW.state IN (
			'completed', 'failed', 'indeterminate'
		))
		OR (OLD.state = 'failed' AND NEW.state = 'leased')
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'worker-execution-transition-invalid';
	END IF;
	IF OLD.state = 'failed' AND NEW.state = 'leased' THEN
		IF NEW.attempt_count <> OLD.attempt_count + 1
			OR NEW.lease_token = OLD.lease_token
			OR NEW.lease_expires_at <= pg_catalog.clock_timestamp()
		THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				MESSAGE = 'worker-execution-retry-invalid';
		END IF;
	ELSIF NEW.attempt_count <> OLD.attempt_count
		OR NEW.lease_token IS DISTINCT FROM OLD.lease_token
		OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'worker-execution-lease-immutable';
	END IF;
	IF (NEW.state = 'leased' AND NEW.completed_at IS NOT NULL)
		OR (NEW.state <> 'leased' AND NEW.completed_at IS NULL)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'worker-execution-state-shape-invalid';
	END IF;
	RETURN NEW;
END
$function$;
CREATE TRIGGER worker_job_execution_transition
BEFORE UPDATE ON "emdo"."worker_job_executions"
FOR EACH ROW EXECUTE FUNCTION "emdo"."enforce_worker_execution_transition"();
REVOKE ALL ON FUNCTION "emdo"."enforce_worker_execution_transition"()
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor;
--> statement-breakpoint
CREATE TABLE "emdo"."space_access_grants" (
	"grant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_version" smallint DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"household_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"role" text NOT NULL,
	"private_space_id" uuid NOT NULL,
	"writable_space_ids" uuid[] NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "space_access_grants_request_unique"
		UNIQUE("original_owner_user_id", "session_id", "request_id"),
	CONSTRAINT "space_access_grants_schema_version_check"
		CHECK ("schema_version" = 1 AND "version" = 1),
	CONSTRAINT "space_access_grants_role_check"
		CHECK ("role" IN ('owner', 'member')),
	CONSTRAINT "space_access_grants_spaces_check"
		CHECK (pg_catalog.cardinality("writable_space_ids") BETWEEN 1 AND 256
			AND pg_catalog.array_position("writable_space_ids", "private_space_id") IS NOT NULL),
	CONSTRAINT "space_access_grants_lifetime_check"
		CHECK ("expires_at" > "issued_at"
			AND "expires_at" <= "issued_at" + interval '15 minutes'),
	CONSTRAINT "space_access_grants_retention_check"
		CHECK ("retain_until" > "issued_at"
			AND "retain_until" <= "issued_at" + interval '90 days')
);
ALTER TABLE "emdo"."space_access_grants"
	ADD CONSTRAINT "space_access_grants_membership_id_fk"
	FOREIGN KEY ("membership_id") REFERENCES "emdo"."household_memberships"("id")
	ON DELETE restrict ON UPDATE restrict;
ALTER TABLE "emdo"."space_access_grants"
	ADD CONSTRAINT "space_access_grants_user_membership_fk"
	FOREIGN KEY ("household_id", "original_owner_user_id")
	REFERENCES "emdo"."household_memberships"("household_id", "user_id")
	ON DELETE restrict ON UPDATE restrict;
ALTER TABLE "emdo"."space_access_grants"
	ADD CONSTRAINT "space_access_grants_private_space_fk"
	FOREIGN KEY ("household_id", "private_space_id")
	REFERENCES "emdo"."spaces"("household_id", "id")
	ON DELETE restrict ON UPDATE restrict;
CREATE INDEX "space_access_grants_owner_request_idx"
	ON "emdo"."space_access_grants" ("original_owner_user_id", "request_id");
CREATE INDEX "space_access_grants_expiry_idx"
	ON "emdo"."space_access_grants" ("expires_at");
ALTER TABLE "emdo"."space_access_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."space_access_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $roles$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_space_grant_executor'
	) THEN
		CREATE ROLE emdo_space_grant_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$roles$;
ALTER ROLE emdo_space_grant_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
DO $membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname = 'emdo_space_grant_executor'
			OR child.rolname = 'emdo_space_grant_executor'
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'space grant executor must not have role memberships';
	END IF;
END
$membership_guard$;
--> statement-breakpoint
CREATE POLICY memberships_space_grant_executor_read
ON "emdo"."household_memberships"
FOR SELECT TO emdo_space_grant_executor
USING ("user_id" = emdo.current_user_id());
CREATE POLICY spaces_space_grant_executor_read ON "emdo"."spaces"
FOR SELECT TO emdo_space_grant_executor
USING (
	"original_owner_user_id" = emdo.current_user_id()
	OR "visibility" = 'shared'
);
CREATE POLICY space_access_grants_executor_read
ON "emdo"."space_access_grants"
FOR SELECT TO emdo_space_grant_executor
USING (
	"original_owner_user_id" = emdo.current_user_id()
	AND "session_id" = emdo.current_session_id()
	AND "request_id" = emdo.current_request_id()
);
CREATE POLICY space_access_grants_executor_insert
ON "emdo"."space_access_grants"
FOR INSERT TO emdo_space_grant_executor
WITH CHECK (
	"original_owner_user_id" = emdo.current_user_id()
	AND "session_id" = emdo.current_session_id()
	AND "request_id" = emdo.current_request_id()
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."issue_space_access_grant"(
	p_household_id uuid,
	p_membership_id uuid,
	p_expected_role text
)
RETURNS SETOF "emdo"."space_access_grants"
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
	v_role text;
	v_private_space_id uuid;
	v_private_count integer;
	v_writable_space_ids uuid[];
	v_space_id uuid;
	v_now timestamptz;
	v_grant emdo.space_access_grants%ROWTYPE;
BEGIN
	IF p_household_id IS NULL OR p_membership_id IS NULL
		OR p_expected_role NOT IN ('owner', 'member')
		OR v_user_id IS NULL OR v_session_id IS NULL OR v_request_id IS NULL
		OR NOT emdo.lock_active_request_scope(p_household_id, NULL, NULL)
	THEN
		RETURN;
	END IF;

	SELECT membership.role INTO v_role
	FROM emdo.household_memberships AS membership
	WHERE membership.id = p_membership_id
		AND membership.household_id = p_household_id
		AND membership.user_id = v_user_id
		AND membership.status = 'active';
	IF NOT FOUND OR v_role IS DISTINCT FROM p_expected_role THEN
		RETURN;
	END IF;

	SELECT pg_catalog.array_agg(accessible.id ORDER BY accessible.id)
	INTO v_writable_space_ids
	FROM (
		SELECT space.id
		FROM emdo.spaces AS space
		WHERE space.household_id = p_household_id
			AND space.tombstoned_at IS NULL
			AND (
				space.visibility = 'shared'
				OR space.original_owner_user_id = v_user_id
			)
		ORDER BY space.id
		LIMIT 257
	) AS accessible;
	SELECT pg_catalog.count(*), pg_catalog.min(private_space.id::text)::uuid
	INTO v_private_count, v_private_space_id
	FROM emdo.spaces AS private_space
	WHERE private_space.household_id = p_household_id
		AND private_space.original_owner_user_id = v_user_id
		AND private_space.visibility = 'private'
		AND private_space.tombstoned_at IS NULL;
	IF v_writable_space_ids IS NULL
		OR pg_catalog.cardinality(v_writable_space_ids) NOT BETWEEN 1 AND 256
		OR v_private_count <> 1 OR v_private_space_id IS NULL
	THEN
		RETURN;
	END IF;
	FOREACH v_space_id IN ARRAY v_writable_space_ids LOOP
		IF NOT emdo.lock_active_request_scope(
			p_household_id, v_space_id, NULL
		) THEN
			RETURN;
		END IF;
	END LOOP;

	v_now := pg_catalog.clock_timestamp();
	INSERT INTO emdo.space_access_grants(
		grant_id, schema_version, version, household_id,
		original_owner_user_id, session_id, request_id, membership_id,
		role, private_space_id, writable_space_ids, issued_at, expires_at,
		retain_until
	) VALUES (
		pg_catalog.gen_random_uuid(), 1, 1, p_household_id,
		v_user_id, v_session_id, v_request_id, p_membership_id,
		v_role, v_private_space_id, v_writable_space_ids, v_now,
		v_now + interval '15 minutes', v_now + interval '90 days'
	)
	ON CONFLICT (original_owner_user_id, session_id, request_id) DO NOTHING
	RETURNING * INTO v_grant;
	IF NOT FOUND THEN
		SELECT stored.* INTO v_grant
		FROM emdo.space_access_grants AS stored
		WHERE stored.original_owner_user_id = v_user_id
			AND stored.session_id = v_session_id
			AND stored.request_id = v_request_id;
	END IF;
	IF v_grant.household_id IS DISTINCT FROM p_household_id
		OR v_grant.membership_id IS DISTINCT FROM p_membership_id
		OR v_grant.role IS DISTINCT FROM v_role
		OR v_grant.private_space_id IS DISTINCT FROM v_private_space_id
		OR v_grant.writable_space_ids IS DISTINCT FROM v_writable_space_ids
		OR v_grant.expires_at <= pg_catalog.clock_timestamp()
	THEN
		RETURN;
	END IF;
	RETURN NEXT v_grant;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."resolve_space_access_grant"(
	p_grant_id uuid,
	p_household_id uuid,
	p_user_id uuid,
	p_session_id uuid,
	p_request_id uuid,
	p_space_id uuid
)
RETURNS SETOF "emdo"."space_access_grants"
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_grant emdo.space_access_grants%ROWTYPE;
	v_current_role text;
	v_current_writable_space_ids uuid[];
BEGIN
	IF p_grant_id IS NULL OR p_household_id IS NULL OR p_space_id IS NULL
		OR p_user_id IS DISTINCT FROM emdo.current_user_id()
		OR p_session_id IS DISTINCT FROM emdo.current_session_id()
		OR p_request_id IS DISTINCT FROM emdo.current_request_id()
		OR NOT emdo.lock_active_request_scope(
			p_household_id, p_space_id, NULL
		)
	THEN
		RETURN;
	END IF;
	SELECT stored.* INTO v_grant
	FROM emdo.space_access_grants AS stored
	JOIN emdo.household_memberships AS membership
		ON membership.id = stored.membership_id
		AND membership.household_id = stored.household_id
		AND membership.user_id = stored.original_owner_user_id
		AND membership.status = 'active'
		AND membership.role = stored.role
	WHERE stored.grant_id = p_grant_id
		AND stored.household_id = p_household_id
		AND stored.original_owner_user_id = p_user_id
		AND stored.session_id = p_session_id
		AND stored.request_id = p_request_id
		AND stored.expires_at > pg_catalog.clock_timestamp()
		AND p_space_id = ANY(stored.writable_space_ids);
	IF NOT FOUND THEN
		RETURN;
	END IF;
	SELECT membership.role INTO v_current_role
	FROM emdo.household_memberships AS membership
	WHERE membership.id = v_grant.membership_id
		AND membership.household_id = v_grant.household_id
		AND membership.user_id = v_grant.original_owner_user_id
		AND membership.status = 'active';
	SELECT pg_catalog.array_agg(accessible.id ORDER BY accessible.id)
	INTO v_current_writable_space_ids
	FROM (
		SELECT space.id
		FROM emdo.spaces AS space
		WHERE space.household_id = v_grant.household_id
			AND space.tombstoned_at IS NULL
			AND (
				space.visibility = 'shared'
				OR space.original_owner_user_id = v_grant.original_owner_user_id
			)
		ORDER BY space.id
		LIMIT 257
	) AS accessible;
	IF v_current_role IS DISTINCT FROM v_grant.role
		OR v_current_writable_space_ids IS DISTINCT FROM v_grant.writable_space_ids
		OR pg_catalog.cardinality(v_current_writable_space_ids) NOT BETWEEN 1 AND 256
	THEN
		RETURN;
	END IF;
	RETURN NEXT v_grant;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."reject_space_access_grant_update"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = 'space access grant is immutable';
END
$function$;
CREATE TRIGGER space_access_grants_immutable
BEFORE UPDATE ON "emdo"."space_access_grants"
FOR EACH ROW EXECUTE FUNCTION "emdo"."reject_space_access_grant_update"();
--> statement-breakpoint
ALTER FUNCTION "emdo"."issue_space_access_grant"(uuid, uuid, text)
	OWNER TO emdo_space_grant_executor;
ALTER FUNCTION "emdo"."resolve_space_access_grant"(uuid, uuid, uuid, uuid, uuid, uuid)
	OWNER TO emdo_space_grant_executor;
GRANT USAGE ON SCHEMA "emdo" TO emdo_space_grant_executor;
GRANT SELECT ON "emdo"."household_memberships", "emdo"."spaces"
	TO emdo_space_grant_executor;
GRANT SELECT, INSERT ON "emdo"."space_access_grants"
	TO emdo_space_grant_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."current_user_id"(), "emdo"."current_session_id"(),
	"emdo"."current_request_id"(),
	"emdo"."lock_active_request_scope"(uuid, uuid, uuid)
	TO emdo_space_grant_executor;
REVOKE ALL ON FUNCTION
	"emdo"."issue_space_access_grant"(uuid, uuid, text),
	"emdo"."resolve_space_access_grant"(uuid, uuid, uuid, uuid, uuid, uuid)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_scope_executor, emdo_oauth_flow_executor,
	emdo_space_grant_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."issue_space_access_grant"(uuid, uuid, text)
	TO emdo_space_grant_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."resolve_space_access_grant"(uuid, uuid, uuid, uuid, uuid, uuid)
	TO emdo_app;
REVOKE ALL ON "emdo"."space_access_grants"
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_scope_executor, emdo_oauth_flow_executor;
REVOKE ALL ON FUNCTION "emdo"."reject_space_access_grant_update"()
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_scope_executor, emdo_oauth_flow_executor,
	emdo_space_grant_executor;
--> statement-breakpoint
CREATE POLICY memberships_oauth_grant_executor_read
ON "emdo"."household_memberships"
FOR SELECT TO emdo_oauth_grant_executor
USING ("user_id" = emdo.current_user_id());
CREATE POLICY space_access_grants_oauth_executor_read
ON "emdo"."space_access_grants"
FOR SELECT TO emdo_oauth_grant_executor
USING (
	"original_owner_user_id" = emdo.current_user_id()
	AND "session_id" = emdo.current_session_id()
	AND "request_id" = emdo.current_request_id()
);
CREATE POLICY space_access_grants_oauth_executor_lock
ON "emdo"."space_access_grants"
FOR UPDATE TO emdo_oauth_grant_executor
USING (
	"original_owner_user_id" = emdo.current_user_id()
	AND "session_id" = emdo.current_session_id()
	AND "request_id" = emdo.current_request_id()
)
WITH CHECK (
	"original_owner_user_id" = emdo.current_user_id()
	AND "session_id" = emdo.current_session_id()
	AND "request_id" = emdo.current_request_id()
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."resolve_current_google_calendar_authority"(
	p_space_access_grant_id uuid,
	p_run_id uuid
)
RETURNS TABLE (
	household_id uuid,
	private_space_id uuid,
	request_id uuid,
	session_id uuid,
	user_id uuid,
	space_access_grant_id uuid,
	authorization_scope_fingerprint text,
	provider_grant_reference text,
	authorization_epoch integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_authority record;
	v_provider_grant_reference text;
	v_authorization_epoch integer;
BEGIN
	IF p_space_access_grant_id IS NULL OR p_run_id IS NULL
	THEN
		RETURN;
	END IF;

	SELECT locked.* INTO v_authority
	FROM emdo.lock_current_authorization_scope(
		p_space_access_grant_id, NULL, p_run_id
	) AS locked;
	IF NOT FOUND
		OR v_authority.proposal_space_id IS NULL
		OR v_authority.authorization_scope_fingerprint
			!~ '^[a-f0-9]{64}$'
	THEN
		RETURN;
	END IF;

	SELECT stored.provider_grant_reference, stored.authorization_epoch
	INTO v_provider_grant_reference, v_authorization_epoch
	FROM emdo.encrypted_google_calendar_grants AS stored
	JOIN emdo.google_oauth_authorization_epochs AS epoch
		ON epoch.household_id = stored.household_id
		AND epoch.private_space_id = stored.private_space_id
		AND epoch.original_owner_user_id = stored.original_owner_user_id
		AND epoch.authorization_epoch = stored.authorization_epoch
	WHERE stored.household_id = v_authority.household_id
		AND stored.private_space_id = v_authority.private_space_id
		AND stored.original_owner_user_id = v_authority.user_id
		AND stored.provider = 'google'
		AND stored.grant_type = 'calendar-authorization'
	FOR SHARE OF stored, epoch;
	IF NOT FOUND THEN
		RETURN;
	END IF;

	IF NOT emdo.lock_active_request_scope(
		v_authority.household_id, v_authority.private_space_id, NULL
	)
	THEN
		RETURN;
	END IF;

	RETURN QUERY SELECT
		v_authority.household_id,
		v_authority.private_space_id,
		v_authority.request_id,
		v_authority.session_id,
		v_authority.user_id,
		p_space_access_grant_id,
		v_authority.authorization_scope_fingerprint,
		v_provider_grant_reference,
		v_authorization_epoch;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."lock_current_google_calendar_authority"(
	p_household_id uuid,
	p_private_space_id uuid,
	p_original_owner_user_id uuid,
	p_authorization_scope_fingerprint text,
	p_expected_binding_hash text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_provider_grant_reference text;
	v_authorization_epoch integer;
	v_binding text;
	v_binding_hash text;
BEGIN
	IF p_original_owner_user_id IS DISTINCT FROM emdo.current_user_id()
		OR p_household_id IS NULL OR p_private_space_id IS NULL
		OR p_authorization_scope_fingerprint IS NULL
		OR p_authorization_scope_fingerprint !~ '^[a-f0-9]{64}$'
		OR p_expected_binding_hash IS NULL
		OR p_expected_binding_hash !~ '^[a-f0-9]{64}$'
		OR NOT emdo.lock_active_request_scope(
			p_household_id, p_private_space_id, NULL
		)
	THEN
		RETURN false;
	END IF;
	SELECT stored.provider_grant_reference, stored.authorization_epoch
	INTO v_provider_grant_reference, v_authorization_epoch
	FROM emdo.encrypted_google_calendar_grants AS stored
	JOIN emdo.google_oauth_authorization_epochs AS epoch
		ON epoch.household_id = stored.household_id
		AND epoch.private_space_id = stored.private_space_id
		AND epoch.original_owner_user_id = stored.original_owner_user_id
		AND epoch.authorization_epoch = stored.authorization_epoch
	WHERE stored.household_id = p_household_id
		AND stored.private_space_id = p_private_space_id
		AND stored.original_owner_user_id = p_original_owner_user_id
		AND stored.provider = 'google'
		AND stored.grant_type = 'calendar-authorization'
	FOR SHARE OF stored, epoch;
	IF NOT FOUND THEN
		RETURN false;
	END IF;

	IF NOT emdo.lock_active_request_scope(
			p_household_id, p_private_space_id, NULL
		)
	THEN
		RETURN false;
	END IF;
	v_binding := '{"authorizationEpoch":' || v_authorization_epoch::text
		|| ',"authorizationScopeFingerprint":'
		|| pg_catalog.to_jsonb(p_authorization_scope_fingerprint)::text
		|| ',"householdId":'
		|| pg_catalog.to_jsonb(p_household_id::text)::text
		|| ',"kind":"google-calendar-grant-v2"'
		|| ',"privateSpaceId":'
		|| pg_catalog.to_jsonb(p_private_space_id::text)::text
		|| ',"providerGrantReference":'
		|| pg_catalog.to_jsonb(v_provider_grant_reference)::text || '}';
	v_binding_hash := pg_catalog.encode(
		pg_catalog.sha256(pg_catalog.convert_to(v_binding, 'UTF8')), 'hex'
	);
	RETURN v_binding_hash = p_expected_binding_hash;
END
$function$;
--> statement-breakpoint
ALTER FUNCTION "emdo"."lock_current_google_calendar_authority"(uuid, uuid, uuid, text, text)
	OWNER TO emdo_oauth_grant_executor;
ALTER FUNCTION "emdo"."resolve_current_google_calendar_authority"(uuid, uuid)
	OWNER TO emdo_oauth_grant_executor;
GRANT SELECT ON "emdo"."household_memberships"
	TO emdo_oauth_grant_executor;
GRANT SELECT, UPDATE ("grant_id") ON "emdo"."space_access_grants"
	TO emdo_oauth_grant_executor;
REVOKE ALL ON FUNCTION
	"emdo"."lock_current_google_calendar_authority"(uuid, uuid, uuid, text, text),
	"emdo"."resolve_current_google_calendar_authority"(uuid, uuid)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."resolve_current_google_calendar_authority"(uuid, uuid)
	TO emdo_app;
--> statement-breakpoint
DO $roles$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_disclosure_executor'
	) THEN
		CREATE ROLE emdo_disclosure_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$roles$;
ALTER ROLE emdo_disclosure_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
DO $membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname = 'emdo_disclosure_executor'
			OR child.rolname = 'emdo_disclosure_executor'
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'disclosure executor must not have role memberships';
	END IF;
END
$membership_guard$;
--> statement-breakpoint
CREATE POLICY disclosure_grants_executor_read
ON "emdo"."disclosure_grants"
FOR SELECT TO emdo_disclosure_executor
USING ("user_id" = emdo.current_user_id());
CREATE POLICY disclosure_grants_executor_insert
ON "emdo"."disclosure_grants"
FOR INSERT TO emdo_disclosure_executor
WITH CHECK ("user_id" = emdo.current_user_id());
CREATE POLICY disclosure_grants_executor_update
ON "emdo"."disclosure_grants"
FOR UPDATE TO emdo_disclosure_executor
USING ("user_id" = emdo.current_user_id())
WITH CHECK ("user_id" = emdo.current_user_id());
CREATE POLICY agent_runs_disclosure_executor_read
ON "emdo"."agent_runs"
FOR SELECT TO emdo_disclosure_executor
USING ("original_owner_user_id" = emdo.current_user_id());
CREATE POLICY agent_runs_disclosure_executor_lock
ON "emdo"."agent_runs"
FOR UPDATE TO emdo_disclosure_executor
USING ("original_owner_user_id" = emdo.current_user_id())
WITH CHECK ("original_owner_user_id" = emdo.current_user_id());
CREATE POLICY space_access_grants_disclosure_executor_read
ON "emdo"."space_access_grants"
FOR SELECT TO emdo_disclosure_executor
USING (
	"original_owner_user_id" = emdo.current_user_id()
	AND "session_id" = emdo.current_session_id()
	AND "request_id" = emdo.current_request_id()
);
CREATE POLICY audit_events_disclosure_executor_insert
ON "emdo"."audit_events"
FOR INSERT TO emdo_disclosure_executor
WITH CHECK (
	"original_owner_user_id" = emdo.current_user_id()
	AND "actor_user_id" = emdo.current_user_id()
	AND "session_id" = emdo.current_session_id()
	AND "request_id" = emdo.current_request_id()
);
--> statement-breakpoint
ALTER TABLE "emdo"."disclosure_grants"
	ADD COLUMN "phase_purpose" text DEFAULT 'specialist-execution' NOT NULL,
	DROP CONSTRAINT "disclosure_grants_terminal_check",
	ADD CONSTRAINT "disclosure_grants_run_phase_agent_unique"
		UNIQUE (
			"household_id", "space_id", "user_id", "run_id", "agent_id",
			"phase_purpose", "provider"
		),
	ADD CONSTRAINT "disclosure_grants_phase_purpose_check"
		CHECK ("phase_purpose" IN (
			'manager-plan', 'specialist-execution', 'manager-synthesis'
		)),
	ADD CONSTRAINT "disclosure_grants_terminal_check"
		CHECK (
			("consumed_at" IS NULL OR (
				"consumed_at" >= "created_at" AND "consumed_at" < "expires_at"
			))
			AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
		);
COMMENT ON COLUMN "emdo"."disclosure_grants"."consumed_at" IS
	'First successful send; the grant remains reusable only inside its exact run, agent, and phase until expiry or revocation';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."issue_model_disclosure_grant"(
	p_run_id uuid,
	p_household_id uuid,
	p_user_id uuid,
	p_space_id uuid,
	p_space_access_grant_id uuid,
	p_agent_id text,
	p_phase_purpose text,
	p_purpose text,
	p_provider text,
	p_record_allowlist jsonb
)
RETURNS TABLE (
	schema_version smallint,
	version integer,
	grant_id uuid,
	household_id uuid,
	space_id uuid,
	original_owner_user_id uuid,
	run_id uuid,
	agent_id text,
	purpose text,
	phase_purpose text,
	provider text,
	record_allowlist jsonb,
	grant_hash text,
	one_run_only boolean,
	created_at timestamptz,
	expires_at timestamptz,
	database_time timestamptz
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
	v_space_grant emdo.space_access_grants%ROWTYPE;
	v_grant emdo.disclosure_grants%ROWTYPE;
	v_record jsonb;
	v_canonical_record jsonb;
	v_canonical_allowlist jsonb := '[]'::jsonb;
	v_data_class text;
	v_record_id text;
	v_field text;
	v_fields jsonb;
	v_fields_text text;
	v_record_text text;
	v_record_texts text[] := ARRAY[]::text[];
	v_binding text;
	v_bindings text[] := ARRAY[]::text[];
	v_allowlist_text text;
	v_grant_text text;
	v_created_iso text;
	v_expires_iso text;
	v_expected_hash text;
	v_now timestamptz;
	v_created_at timestamptz;
	v_expires_at timestamptz;
	v_grant_id uuid;
	v_existing_grant boolean;
BEGIN
	IF p_run_id IS NULL OR p_household_id IS NULL OR p_user_id IS NULL
		OR p_space_id IS NULL OR p_space_access_grant_id IS NULL
		OR p_user_id IS DISTINCT FROM v_user_id
		OR v_session_id IS NULL OR v_request_id IS NULL
		OR p_agent_id IS NULL OR pg_catalog.btrim(p_agent_id) <> p_agent_id
		OR pg_catalog.length(p_agent_id) NOT BETWEEN 2 AND 160
		OR p_agent_id !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
		OR p_phase_purpose NOT IN (
			'manager-plan', 'specialist-execution', 'manager-synthesis'
		)
		OR p_purpose IS NULL OR pg_catalog.btrim(p_purpose) <> p_purpose
		OR pg_catalog.length(p_purpose) NOT BETWEEN 3 AND 500
		OR p_provider <> 'openai'
	THEN
		RETURN;
	END IF;
	IF pg_catalog.jsonb_typeof(p_record_allowlist) <> 'array' THEN
		RETURN;
	END IF;
	IF pg_catalog.jsonb_array_length(p_record_allowlist) NOT BETWEEN 1 AND 256
		OR pg_catalog.octet_length(p_record_allowlist::text) > 262144
	THEN
		RETURN;
	END IF;

	FOR v_record IN
		SELECT entry.value
		FROM pg_catalog.jsonb_array_elements(p_record_allowlist) AS entry(value)
		ORDER BY entry.value ->> 'dataClass', entry.value ->> 'recordId'
	LOOP
		IF pg_catalog.jsonb_typeof(v_record) <> 'object' THEN
			RETURN;
		END IF;
		IF NOT (v_record ?& ARRAY['dataClass', 'recordId', 'fields'])
			OR (
				SELECT pg_catalog.count(*)
				FROM pg_catalog.jsonb_object_keys(v_record)
			) <> 3
			OR pg_catalog.jsonb_typeof(v_record -> 'dataClass') <> 'string'
			OR pg_catalog.jsonb_typeof(v_record -> 'recordId') <> 'string'
			OR pg_catalog.jsonb_typeof(v_record -> 'fields') <> 'array'
		THEN
			RETURN;
		END IF;
		IF pg_catalog.jsonb_array_length(v_record -> 'fields') NOT BETWEEN 1 AND 128
		THEN
			RETURN;
		END IF;
		v_data_class := v_record ->> 'dataClass';
		v_record_id := v_record ->> 'recordId';
		IF pg_catalog.length(v_data_class) NOT BETWEEN 2 AND 160
			OR v_data_class !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
			OR pg_catalog.btrim(v_record_id) <> v_record_id
			OR pg_catalog.length(v_record_id) NOT BETWEEN 1 AND 512
			OR v_record_id ~ '[[:cntrl:]]'
		THEN
			RETURN;
		END IF;
		FOR v_field IN
			SELECT field.value
			FROM pg_catalog.jsonb_array_elements_text(v_record -> 'fields')
				AS field(value)
		LOOP
			IF pg_catalog.length(v_field) NOT BETWEEN 2 AND 160
				OR v_field !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
			THEN
				RETURN;
			END IF;
		END LOOP;
		IF (
			SELECT pg_catalog.count(*)
			FROM pg_catalog.jsonb_array_elements_text(v_record -> 'fields')
		) <> (
			SELECT pg_catalog.count(DISTINCT field.value)
			FROM pg_catalog.jsonb_array_elements_text(v_record -> 'fields')
				AS field(value)
		) THEN
			RETURN;
		END IF;
		v_binding := v_data_class || E'\x1f' || v_record_id;
		IF v_binding = ANY(v_bindings) THEN
			RETURN;
		END IF;
		v_bindings := pg_catalog.array_append(v_bindings, v_binding);
		SELECT
			pg_catalog.jsonb_agg(pg_catalog.to_jsonb(field.value) ORDER BY field.value),
			'[' || pg_catalog.string_agg(
				pg_catalog.to_jsonb(field.value)::text, ',' ORDER BY field.value
			) || ']'
		INTO v_fields, v_fields_text
		FROM pg_catalog.jsonb_array_elements_text(v_record -> 'fields')
			AS field(value);
		v_canonical_record := pg_catalog.jsonb_build_object(
			'dataClass', v_data_class,
			'fields', v_fields,
			'recordId', v_record_id
		);
		v_canonical_allowlist := v_canonical_allowlist
			|| pg_catalog.jsonb_build_array(v_canonical_record);
		v_record_text := '{"dataClass":'
			|| pg_catalog.to_jsonb(v_data_class)::text
			|| ',"fields":' || v_fields_text
			|| ',"recordId":' || pg_catalog.to_jsonb(v_record_id)::text || '}';
		v_record_texts := pg_catalog.array_append(v_record_texts, v_record_text);
	END LOOP;
	v_allowlist_text := '[' || pg_catalog.array_to_string(v_record_texts, ',') || ']';

	SELECT resolved.* INTO v_space_grant
	FROM emdo.resolve_space_access_grant(
		p_space_access_grant_id, p_household_id, p_user_id,
		v_session_id, v_request_id, p_space_id
	) AS resolved;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	PERFORM 1
	FROM emdo.agent_runs AS run
	WHERE run.id = p_run_id
		AND run.household_id = p_household_id
		AND run.space_id = p_space_id
		AND run.original_owner_user_id = p_user_id
		AND run.agent_id = p_agent_id
		AND run.status IN ('queued', 'running')
	FOR SHARE OF run;
	IF NOT FOUND THEN
		RETURN;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			p_household_id::text || ':' || p_space_id::text || ':'
			|| p_user_id::text || ':' || p_run_id::text || ':'
			|| p_agent_id || ':' || p_phase_purpose || ':' || p_provider,
			0
		)
	);
	SELECT stored.* INTO v_grant
	FROM emdo.disclosure_grants AS stored
	WHERE stored.household_id = p_household_id
		AND stored.space_id = p_space_id
		AND stored.user_id = p_user_id
		AND stored.run_id = p_run_id
		AND stored.agent_id = p_agent_id
		AND stored.phase_purpose = p_phase_purpose
		AND stored.provider = p_provider
	FOR UPDATE;
	v_existing_grant := FOUND;
	SELECT resolved.* INTO v_space_grant
	FROM emdo.resolve_space_access_grant(
		p_space_access_grant_id, p_household_id, p_user_id,
		v_session_id, v_request_id, p_space_id
	) AS resolved;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	v_now := pg_catalog.clock_timestamp();
	IF v_space_grant.issued_at > v_now OR v_space_grant.expires_at <= v_now THEN
		RETURN;
	END IF;
	IF v_existing_grant THEN
		v_created_iso := pg_catalog.to_char(
			v_grant.created_at AT TIME ZONE 'UTC',
			'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
		);
		v_expires_iso := pg_catalog.to_char(
			v_grant.expires_at AT TIME ZONE 'UTC',
			'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
		);
		v_grant_text := '{"agentId":' || pg_catalog.to_jsonb(v_grant.agent_id)::text
			|| ',"createdAt":' || pg_catalog.to_jsonb(v_created_iso)::text
			|| ',"expiresAt":' || pg_catalog.to_jsonb(v_expires_iso)::text
			|| ',"householdId":' || pg_catalog.to_jsonb(v_grant.household_id::text)::text
			|| ',"id":' || pg_catalog.to_jsonb(v_grant.id::text)::text
			|| ',"oneRunOnly":true'
			|| ',"provider":' || pg_catalog.to_jsonb(v_grant.provider)::text
			|| ',"purpose":' || pg_catalog.to_jsonb(v_grant.purpose)::text
			|| ',"recordAllowlist":' || v_allowlist_text
			|| ',"runId":' || pg_catalog.to_jsonb(v_grant.run_id::text)::text
			|| ',"schemaVersion":1'
			|| ',"userId":' || pg_catalog.to_jsonb(v_grant.user_id::text)::text
			|| ',"version":' || v_grant.version::text || '}';
		v_expected_hash := pg_catalog.encode(
			pg_catalog.sha256(pg_catalog.convert_to(v_grant_text, 'UTF8')),
			'hex'
		);
		IF v_grant.schema_version <> 1 OR v_grant.version <> 1
			OR v_grant.purpose IS DISTINCT FROM p_purpose
			OR v_grant.record_allowlist IS DISTINCT FROM v_canonical_allowlist
			OR v_grant.one_run_only IS DISTINCT FROM true
			OR v_grant.created_at IS DISTINCT FROM pg_catalog.date_trunc(
				'milliseconds', v_grant.created_at
			)
			OR v_grant.expires_at IS DISTINCT FROM
				v_grant.created_at + interval '10 minutes'
			OR v_grant.revoked_at IS NOT NULL
			OR v_grant.expires_at <= v_now
			OR v_grant.grant_hash IS DISTINCT FROM v_expected_hash
		THEN
			RETURN;
		END IF;
		RETURN QUERY SELECT
			v_grant.schema_version, v_grant.version, v_grant.id,
			v_grant.household_id, v_grant.space_id, v_grant.user_id,
			v_grant.run_id, v_grant.agent_id, v_grant.purpose,
			v_grant.phase_purpose, v_grant.provider,
			v_grant.record_allowlist, v_grant.grant_hash,
			v_grant.one_run_only, v_grant.created_at, v_grant.expires_at, v_now;
		RETURN;
	END IF;

	v_created_at := pg_catalog.date_trunc('milliseconds', v_now);
	v_expires_at := v_created_at + interval '10 minutes';
	v_grant_id := pg_catalog.gen_random_uuid();
	v_created_iso := pg_catalog.to_char(
		v_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
	);
	v_expires_iso := pg_catalog.to_char(
		v_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
	);
	v_grant_text := '{"agentId":' || pg_catalog.to_jsonb(p_agent_id)::text
		|| ',"createdAt":' || pg_catalog.to_jsonb(v_created_iso)::text
		|| ',"expiresAt":' || pg_catalog.to_jsonb(v_expires_iso)::text
		|| ',"householdId":' || pg_catalog.to_jsonb(p_household_id::text)::text
		|| ',"id":' || pg_catalog.to_jsonb(v_grant_id::text)::text
		|| ',"oneRunOnly":true'
		|| ',"provider":' || pg_catalog.to_jsonb(p_provider)::text
		|| ',"purpose":' || pg_catalog.to_jsonb(p_purpose)::text
		|| ',"recordAllowlist":' || v_allowlist_text
		|| ',"runId":' || pg_catalog.to_jsonb(p_run_id::text)::text
		|| ',"schemaVersion":1'
		|| ',"userId":' || pg_catalog.to_jsonb(p_user_id::text)::text
		|| ',"version":1}';
	v_expected_hash := pg_catalog.encode(
		pg_catalog.sha256(pg_catalog.convert_to(v_grant_text, 'UTF8')), 'hex'
	);
	INSERT INTO emdo.disclosure_grants(
		id, schema_version, version, household_id, space_id, user_id,
		run_id, agent_id, purpose, phase_purpose, provider, record_allowlist,
		grant_hash, one_run_only, created_at, expires_at
	) VALUES (
		v_grant_id, 1, 1, p_household_id, p_space_id, p_user_id,
		p_run_id, p_agent_id, p_purpose, p_phase_purpose, p_provider,
		v_canonical_allowlist, v_expected_hash, true, v_created_at, v_expires_at
	)
	ON CONFLICT ON CONSTRAINT disclosure_grants_run_phase_agent_unique
		DO NOTHING
	RETURNING * INTO v_grant;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	INSERT INTO emdo.audit_events(
		household_id, space_id, original_owner_user_id, actor_user_id,
		session_id, request_id, run_id, event_type, payload,
		occurred_at, retain_until
	) VALUES (
		p_household_id, p_space_id, p_user_id, p_user_id,
		v_session_id, v_request_id, p_run_id, 'model.disclosure.granted',
		pg_catalog.jsonb_build_object(
			'schemaVersion', 1, 'grantId', v_grant.id,
			'grantVersion', v_grant.version, 'agentId', p_agent_id,
			'phasePurpose', p_phase_purpose, 'provider', p_provider,
			'records', v_canonical_allowlist
		), v_now, v_now + interval '12 months'
	);
	RETURN QUERY SELECT
		v_grant.schema_version, v_grant.version, v_grant.id,
		v_grant.household_id, v_grant.space_id, v_grant.user_id,
		v_grant.run_id, v_grant.agent_id, v_grant.purpose,
		v_grant.phase_purpose, v_grant.provider,
		v_grant.record_allowlist, v_grant.grant_hash,
		v_grant.one_run_only, v_grant.created_at, v_grant.expires_at, v_now;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."resolve_model_disclosure_grant"(
	p_requested_grant_id uuid,
	p_run_id uuid,
	p_household_id uuid,
	p_user_id uuid,
	p_space_access_grant_id uuid,
	p_agent_id text,
	p_phase_purpose text,
	p_provider text,
	p_requested_data_classes jsonb
)
RETURNS TABLE (
	status text,
	schema_version smallint,
	version integer,
	grant_id uuid,
	household_id uuid,
	space_id uuid,
	original_owner_user_id uuid,
	run_id uuid,
	agent_id text,
	purpose text,
	provider text,
	record_allowlist jsonb,
	grant_hash text,
	created_at timestamptz,
	expires_at timestamptz,
	database_time timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_grant emdo.disclosure_grants%ROWTYPE;
	v_space_grant emdo.space_access_grants%ROWTYPE;
	v_now timestamptz;
	v_allowlist_valid boolean;
BEGIN
	IF p_run_id IS NULL OR p_household_id IS NULL OR p_user_id IS NULL
		OR p_space_access_grant_id IS NULL
		OR p_user_id IS DISTINCT FROM emdo.current_user_id()
		OR p_agent_id IS NULL OR pg_catalog.btrim(p_agent_id) <> p_agent_id
		OR pg_catalog.length(p_agent_id) NOT BETWEEN 2 AND 160
		OR p_phase_purpose NOT IN (
			'manager-plan', 'specialist-execution', 'manager-synthesis'
		)
		OR p_provider <> 'openai'
		OR pg_catalog.jsonb_typeof(p_requested_data_classes) <> 'array'
		OR pg_catalog.jsonb_array_length(p_requested_data_classes) > 64
		OR EXISTS (
			SELECT 1 FROM pg_catalog.jsonb_array_elements(p_requested_data_classes) AS requested(value)
			WHERE pg_catalog.jsonb_typeof(requested.value) <> 'string'
				OR pg_catalog.length(requested.value #>> '{}') NOT BETWEEN 2 AND 160
		)
		OR (
			SELECT pg_catalog.count(*)
			FROM pg_catalog.jsonb_array_elements_text(p_requested_data_classes)
		) <> (
			SELECT pg_catalog.count(DISTINCT requested)
			FROM pg_catalog.jsonb_array_elements_text(p_requested_data_classes) AS requested
		)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '22023',
			MESSAGE = 'invalid model disclosure request';
	END IF;

	v_now := pg_catalog.clock_timestamp();
	SELECT stored.* INTO v_space_grant
	FROM emdo.space_access_grants AS stored
	WHERE stored.grant_id = p_space_access_grant_id
		AND stored.household_id = p_household_id
		AND stored.original_owner_user_id = p_user_id
		AND stored.session_id = emdo.current_session_id()
		AND stored.request_id = emdo.current_request_id()
		AND stored.expires_at > v_now;
	IF NOT FOUND THEN
		RETURN QUERY SELECT 'no-active-grant'::text, NULL::smallint,
			NULL::integer, p_requested_grant_id, NULL::uuid, NULL::uuid,
			NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text,
			NULL::jsonb, NULL::text, NULL::timestamptz, NULL::timestamptz,
			v_now;
		RETURN;
	END IF;

	IF p_requested_grant_id IS NULL THEN
		RETURN QUERY SELECT 'no-active-grant'::text, NULL::smallint,
			NULL::integer, NULL::uuid, NULL::uuid, NULL::uuid,
			NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text,
			NULL::jsonb, NULL::text, NULL::timestamptz, NULL::timestamptz,
			v_now;
		RETURN;
	END IF;
	SELECT candidate.* INTO v_grant
	FROM emdo.disclosure_grants AS candidate
	WHERE candidate.id = p_requested_grant_id
		AND candidate.user_id = p_user_id
	FOR UPDATE;
	IF NOT FOUND THEN
		RETURN QUERY SELECT 'grant-not-found'::text, NULL::smallint,
			NULL::integer, p_requested_grant_id, NULL::uuid, NULL::uuid,
			NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text,
			NULL::jsonb, NULL::text, NULL::timestamptz, NULL::timestamptz,
			v_now;
		RETURN;
	END IF;

	v_now := pg_catalog.clock_timestamp();
	IF v_space_grant.issued_at > v_now OR v_space_grant.expires_at <= v_now THEN
		status := 'no-active-grant';
	ELSIF v_grant.household_id IS DISTINCT FROM p_household_id THEN
		status := 'grant-household-mismatch';
	ELSIF v_grant.user_id IS DISTINCT FROM p_user_id THEN
		status := 'grant-user-mismatch';
	ELSIF v_grant.run_id IS DISTINCT FROM p_run_id THEN
		status := 'grant-run-mismatch';
	ELSIF v_grant.agent_id IS DISTINCT FROM p_agent_id THEN
		status := 'grant-agent-mismatch';
	ELSIF v_grant.provider IS DISTINCT FROM p_provider THEN
		status := 'grant-provider-mismatch';
	ELSIF v_grant.phase_purpose IS DISTINCT FROM p_phase_purpose THEN
		status := 'grant-purpose-mismatch';
	ELSIF v_grant.revoked_at IS NOT NULL OR v_grant.expires_at <= v_now THEN
		status := 'grant-expired';
	ELSIF NOT (v_grant.space_id = ANY(v_space_grant.writable_space_ids))
		OR NOT EXISTS (
			SELECT 1
			FROM emdo.resolve_space_access_grant(
				p_space_access_grant_id, p_household_id, p_user_id,
				emdo.current_session_id(), emdo.current_request_id(),
				v_grant.space_id
			)
		)
	THEN
		status := 'no-active-grant';
	ELSE
		SELECT (
			pg_catalog.jsonb_typeof(v_grant.record_allowlist) = 'array'
			AND pg_catalog.jsonb_array_length(v_grant.record_allowlist) BETWEEN 1 AND 256
			AND NOT EXISTS (
				SELECT 1
				FROM pg_catalog.jsonb_array_elements(v_grant.record_allowlist) AS allowed(record)
				WHERE pg_catalog.jsonb_typeof(allowed.record) <> 'object'
					OR NOT (allowed.record ?& ARRAY['dataClass', 'recordId', 'fields'])
					OR (
						SELECT pg_catalog.count(*)
						FROM pg_catalog.jsonb_object_keys(allowed.record)
					) <> 3
					OR pg_catalog.jsonb_typeof(allowed.record -> 'dataClass') <> 'string'
					OR pg_catalog.jsonb_typeof(allowed.record -> 'recordId') <> 'string'
					OR pg_catalog.jsonb_typeof(allowed.record -> 'fields') <> 'array'
					OR pg_catalog.jsonb_array_length(allowed.record -> 'fields') NOT BETWEEN 1 AND 128
			)
		) INTO v_allowlist_valid;
		IF NOT v_allowlist_valid OR EXISTS (
			SELECT 1
			FROM pg_catalog.jsonb_array_elements_text(p_requested_data_classes) AS requested(data_class)
			WHERE NOT EXISTS (
				SELECT 1
				FROM pg_catalog.jsonb_array_elements(v_grant.record_allowlist) AS allowed(record)
				WHERE allowed.record ->> 'dataClass' = requested.data_class
			)
		) THEN
			status := 'record-not-allowed';
		ELSE
			PERFORM 1
			FROM emdo.agent_runs AS run
			WHERE run.id = v_grant.run_id
				AND run.household_id = v_grant.household_id
				AND run.space_id = v_grant.space_id
				AND run.original_owner_user_id = v_grant.user_id
				AND run.agent_id = v_grant.agent_id;
			IF FOUND THEN
				status := 'active';
			ELSE
				status := 'grant-run-mismatch';
			END IF;
		END IF;
	END IF;

	IF status = 'active' THEN
		v_now := pg_catalog.clock_timestamp();
		IF v_space_grant.expires_at <= v_now THEN
			status := 'no-active-grant';
		ELSIF v_grant.expires_at <= v_now THEN
			status := 'grant-expired';
		END IF;
	END IF;
	IF status <> 'active' THEN
		RETURN QUERY SELECT status, NULL::smallint, NULL::integer,
			v_grant.id, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
			NULL::text, NULL::text, NULL::text, NULL::jsonb, NULL::text,
			NULL::timestamptz, NULL::timestamptz, v_now;
		RETURN;
	END IF;
	RETURN QUERY SELECT status, v_grant.schema_version, v_grant.version,
		v_grant.id, v_grant.household_id, v_grant.space_id, v_grant.user_id,
		v_grant.run_id, v_grant.agent_id, v_grant.purpose, v_grant.provider,
		v_grant.record_allowlist, v_grant.grant_hash, v_grant.created_at,
		v_grant.expires_at, v_now;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."commit_model_disclosure_authorization"(
	p_grant_id uuid,
	p_version integer,
	p_grant_hash text,
	p_space_access_grant_id uuid,
	p_phase_purpose text,
	p_records jsonb
)
RETURNS TABLE (committed boolean, database_time timestamptz, expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_grant emdo.disclosure_grants%ROWTYPE;
	v_space_grant emdo.space_access_grants%ROWTYPE;
	v_record jsonb;
	v_allowed jsonb;
	v_field text;
	v_binding text;
	v_bindings text[] := ARRAY[]::text[];
	v_now timestamptz;
BEGIN
	IF p_grant_id IS NULL OR p_version IS NULL OR p_version <= 0
		OR p_grant_hash !~ '^[a-f0-9]{64}$'
		OR p_space_access_grant_id IS NULL
		OR p_phase_purpose NOT IN (
			'manager-plan', 'specialist-execution', 'manager-synthesis'
		)
		OR pg_catalog.jsonb_typeof(p_records) <> 'array'
		OR pg_catalog.jsonb_array_length(p_records) > 256
	THEN
		RETURN;
	END IF;
	SELECT stored.* INTO v_grant
	FROM emdo.disclosure_grants AS stored
	WHERE stored.id = p_grant_id
		AND stored.version = p_version
		AND stored.grant_hash = p_grant_hash
		AND stored.phase_purpose = p_phase_purpose
		AND stored.user_id = emdo.current_user_id()
	FOR UPDATE;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	SELECT resolved.* INTO v_space_grant
	FROM emdo.resolve_space_access_grant(
		p_space_access_grant_id, v_grant.household_id, v_grant.user_id,
		emdo.current_session_id(), emdo.current_request_id(), v_grant.space_id
	) AS resolved;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	v_now := pg_catalog.clock_timestamp();
	IF v_grant.revoked_at IS NOT NULL OR v_grant.expires_at <= v_now
		OR v_space_grant.issued_at > v_now OR v_space_grant.expires_at <= v_now
	THEN
		RETURN;
	END IF;

	FOR v_record IN SELECT value FROM pg_catalog.jsonb_array_elements(p_records)
	LOOP
		IF pg_catalog.jsonb_typeof(v_record) <> 'object'
			OR NOT (v_record ?& ARRAY['dataClass', 'recordId', 'fields'])
			OR (
				SELECT pg_catalog.count(*)
				FROM pg_catalog.jsonb_object_keys(v_record)
			) <> 3
			OR pg_catalog.jsonb_typeof(v_record -> 'dataClass') <> 'string'
			OR pg_catalog.jsonb_typeof(v_record -> 'recordId') <> 'string'
			OR pg_catalog.jsonb_typeof(v_record -> 'fields') <> 'array'
			OR pg_catalog.jsonb_array_length(v_record -> 'fields') NOT BETWEEN 1 AND 128
		THEN
			RETURN;
		END IF;
		v_binding := (v_record ->> 'dataClass') || E'\x1f' || (v_record ->> 'recordId');
		IF v_binding = ANY(v_bindings) THEN
			RETURN;
		END IF;
		v_bindings := pg_catalog.array_append(v_bindings, v_binding);
		SELECT allowed.record INTO v_allowed
		FROM pg_catalog.jsonb_array_elements(v_grant.record_allowlist) AS allowed(record)
		WHERE allowed.record ->> 'dataClass' = v_record ->> 'dataClass'
			AND allowed.record ->> 'recordId' = v_record ->> 'recordId';
		IF NOT FOUND THEN
			RETURN;
		END IF;
		FOR v_field IN SELECT value FROM pg_catalog.jsonb_array_elements_text(v_record -> 'fields')
		LOOP
			IF NOT ((v_allowed -> 'fields') ? v_field) THEN
				RETURN;
			END IF;
		END LOOP;
		IF (
			SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements_text(v_record -> 'fields')
		) <> (
			SELECT pg_catalog.count(DISTINCT field_name)
			FROM pg_catalog.jsonb_array_elements_text(v_record -> 'fields') AS field_name
		) THEN
			RETURN;
		END IF;
	END LOOP;

	v_now := pg_catalog.clock_timestamp();
	IF v_grant.expires_at <= v_now OR v_space_grant.expires_at <= v_now
		OR NOT emdo.lock_active_request_scope(
			v_grant.household_id, v_grant.space_id, NULL
		)
	THEN
		RETURN;
	END IF;
	UPDATE emdo.disclosure_grants
	SET consumed_at = COALESCE(consumed_at, v_now)
	WHERE id = v_grant.id;
	INSERT INTO emdo.audit_events(
		household_id, space_id, original_owner_user_id, actor_user_id,
		session_id, request_id, run_id, event_type, payload,
		occurred_at, retain_until
	) VALUES (
		v_grant.household_id, v_grant.space_id, v_grant.user_id,
		v_grant.user_id, emdo.current_session_id(), emdo.current_request_id(),
		v_grant.run_id, 'model.disclosure.sent',
		pg_catalog.jsonb_build_object(
			'schemaVersion', 1, 'grantId', v_grant.id,
			'grantVersion', v_grant.version, 'agentId', v_grant.agent_id,
			'phasePurpose', p_phase_purpose, 'provider', v_grant.provider,
			'records', p_records
		), v_now, v_now + interval '12 months'
	);
	RETURN QUERY SELECT true, v_now, v_grant.expires_at;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."record_model_disclosure_denial"(
	p_grant_id uuid,
	p_version integer,
	p_grant_hash text,
	p_space_access_grant_id uuid,
	p_phase_purpose text,
	p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_grant emdo.disclosure_grants%ROWTYPE;
	v_space_grant emdo.space_access_grants%ROWTYPE;
	v_now timestamptz;
BEGIN
	IF p_reason NOT IN ('record-not-allowed', 'field-not-allowed')
		OR p_phase_purpose NOT IN (
			'manager-plan', 'specialist-execution', 'manager-synthesis'
		)
	THEN
		RETURN false;
	END IF;
	SELECT stored.* INTO v_grant
	FROM emdo.disclosure_grants AS stored
	WHERE stored.id = p_grant_id
		AND stored.version = p_version
		AND stored.grant_hash = p_grant_hash
		AND stored.phase_purpose = p_phase_purpose
		AND stored.user_id = emdo.current_user_id()
	FOR UPDATE;
	IF NOT FOUND THEN
		RETURN false;
	END IF;
	SELECT resolved.* INTO v_space_grant
	FROM emdo.resolve_space_access_grant(
		p_space_access_grant_id, v_grant.household_id, v_grant.user_id,
		emdo.current_session_id(), emdo.current_request_id(), v_grant.space_id
	) AS resolved;
	IF NOT FOUND THEN
		RETURN false;
	END IF;
	v_now := pg_catalog.clock_timestamp();
	IF v_grant.revoked_at IS NOT NULL OR v_grant.expires_at <= v_now
		OR v_space_grant.issued_at > v_now OR v_space_grant.expires_at <= v_now
	THEN
		RETURN false;
	END IF;
	INSERT INTO emdo.audit_events(
		household_id, space_id, original_owner_user_id, actor_user_id,
		session_id, request_id, run_id, event_type, payload,
		occurred_at, retain_until
	) VALUES (
		v_grant.household_id, v_grant.space_id, v_grant.user_id,
		v_grant.user_id, emdo.current_session_id(), emdo.current_request_id(),
		v_grant.run_id, 'model.disclosure.denied',
		pg_catalog.jsonb_build_object(
			'schemaVersion', 1, 'grantId', v_grant.id,
			'grantVersion', v_grant.version, 'agentId', v_grant.agent_id,
			'phasePurpose', p_phase_purpose, 'provider', v_grant.provider,
			'reason', p_reason
		), v_now, v_now + interval '12 months'
	);
	RETURN true;
END
$function$;
--> statement-breakpoint
ALTER FUNCTION "emdo"."issue_model_disclosure_grant"(uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb)
	OWNER TO emdo_disclosure_executor;
ALTER FUNCTION "emdo"."resolve_model_disclosure_grant"(uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb)
	OWNER TO emdo_disclosure_executor;
ALTER FUNCTION "emdo"."commit_model_disclosure_authorization"(uuid, integer, text, uuid, text, jsonb)
	OWNER TO emdo_disclosure_executor;
ALTER FUNCTION "emdo"."record_model_disclosure_denial"(uuid, integer, text, uuid, text, text)
	OWNER TO emdo_disclosure_executor;
GRANT USAGE ON SCHEMA "emdo" TO emdo_disclosure_executor;
GRANT SELECT, INSERT, UPDATE ("consumed_at") ON "emdo"."disclosure_grants"
	TO emdo_disclosure_executor;
GRANT SELECT ON "emdo"."agent_runs", "emdo"."space_access_grants"
	TO emdo_disclosure_executor;
GRANT UPDATE ("id") ON "emdo"."agent_runs" TO emdo_disclosure_executor;
GRANT INSERT ON "emdo"."audit_events" TO emdo_disclosure_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."current_user_id"(), "emdo"."current_session_id"(),
	"emdo"."current_request_id"(),
	"emdo"."lock_active_request_scope"(uuid, uuid, uuid)
	TO emdo_disclosure_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."resolve_space_access_grant"(uuid, uuid, uuid, uuid, uuid, uuid)
	TO emdo_disclosure_executor;
REVOKE ALL ON FUNCTION
	"emdo"."issue_model_disclosure_grant"(uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb),
	"emdo"."resolve_model_disclosure_grant"(uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb),
	"emdo"."commit_model_disclosure_authorization"(uuid, integer, text, uuid, text, jsonb),
	"emdo"."record_model_disclosure_denial"(uuid, integer, text, uuid, text, text)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."issue_model_disclosure_grant"(uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb),
	"emdo"."resolve_model_disclosure_grant"(uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb),
	"emdo"."commit_model_disclosure_authorization"(uuid, integer, text, uuid, text, jsonb),
	"emdo"."record_model_disclosure_denial"(uuid, integer, text, uuid, text, text)
	TO emdo_app;
REVOKE ALL ON "emdo"."disclosure_grants"
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor;
--> statement-breakpoint

-- Provider-write proposal persistence keeps the authority-bearing inputs in
-- immutable database rows. The workflow claim issuer below locks and compares
-- these values before an isolated workflow login may commit a mutation.
ALTER TABLE "emdo"."household_memberships"
	ADD COLUMN IF NOT EXISTS "administration_version"
		integer DEFAULT 1 NOT NULL;
DO $membership_version_prerequisite$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_constraint
		WHERE conrelid = 'emdo.household_memberships'::regclass
			AND conname =
				'household_memberships_administration_version_positive'
	) THEN
		ALTER TABLE "emdo"."household_memberships"
			ADD CONSTRAINT
				"household_memberships_administration_version_positive"
			CHECK ("administration_version" > 0);
	END IF;
END
$membership_version_prerequisite$;
--> statement-breakpoint
DO $proposal_upgrade_guard$
BEGIN
	IF EXISTS (SELECT 1 FROM emdo.action_proposals LIMIT 1)
		OR EXISTS (SELECT 1 FROM emdo.provider_attempts LIMIT 1)
		OR EXISTS (SELECT 1 FROM emdo.provider_outcomes LIMIT 1)
		OR EXISTS (SELECT 1 FROM emdo.proposal_reconciliations LIMIT 1)
	THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'proposal authority persistence requires an empty proposal aggregate; rebuild or run the audited data migration first';
	END IF;
END
$proposal_upgrade_guard$;
--> statement-breakpoint
ALTER TABLE "emdo"."action_proposals"
	ADD COLUMN "provider_authority_binding_hash" text NOT NULL,
	ADD COLUMN "authorization_scope_fingerprint" text NOT NULL,
	ADD COLUMN "provider_sdk_call_id" text NOT NULL,
	ADD COLUMN "disclosure_grant" jsonb NOT NULL,
	ADD COLUMN "approval_display" jsonb NOT NULL,
	ADD CONSTRAINT "action_proposals_provider_authority_binding_hash_check"
		CHECK ("provider_authority_binding_hash" ~ '^[a-f0-9]{64}$'),
	ADD CONSTRAINT "action_proposals_authorization_scope_fingerprint_check"
		CHECK ("authorization_scope_fingerprint" ~ '^[a-f0-9]{64}$'),
	ADD CONSTRAINT "action_proposals_provider_sdk_call_id_check" CHECK (
		pg_catalog.length("provider_sdk_call_id") BETWEEN 1 AND 512
		AND pg_catalog.btrim("provider_sdk_call_id") = "provider_sdk_call_id"
		AND "provider_sdk_call_id" !~ '[[:cntrl:]]'
	),
	ADD CONSTRAINT "action_proposals_disclosure_grant_check" CHECK (
		pg_catalog.jsonb_typeof("disclosure_grant") = 'object'
		AND pg_catalog.octet_length("disclosure_grant"::text) <= 262144
		AND "disclosure_grant" ->> 'id' = "disclosure_grant_id"::text
		AND "disclosure_grant" ->> 'runId' = "run_id"::text
		AND "disclosure_grant" ->> 'householdId' = "household_id"::text
		AND "disclosure_grant" ->> 'userId' = "original_owner_user_id"::text
	),
	ADD CONSTRAINT "action_proposals_approval_display_check" CHECK (
		pg_catalog.jsonb_typeof("approval_display") = 'object'
		AND pg_catalog.octet_length("approval_display"::text) <= 131072
		AND "approval_display" ?& ARRAY[
			'schemaVersion', 'title', 'summary', 'beforeSummary',
			'afterSummary', 'fields'
		]::text[]
		AND "approval_display" - ARRAY[
			'schemaVersion', 'title', 'summary', 'beforeSummary',
			'afterSummary', 'fields'
		]::text[] = '{}'::jsonb
		AND "approval_display" -> 'schemaVersion' = '1'::jsonb
		AND pg_catalog.jsonb_typeof("approval_display" -> 'title') = 'string'
		AND pg_catalog.length("approval_display" ->> 'title') <= 200
		AND pg_catalog.jsonb_typeof("approval_display" -> 'summary') = 'string'
		AND pg_catalog.length("approval_display" ->> 'summary') <= 1000
		AND pg_catalog.jsonb_typeof(
			"approval_display" -> 'beforeSummary'
		) = 'string'
		AND pg_catalog.length("approval_display" ->> 'beforeSummary') <= 2000
		AND pg_catalog.jsonb_typeof(
			"approval_display" -> 'afterSummary'
		) = 'string'
		AND pg_catalog.length("approval_display" ->> 'afterSummary') <= 2000
		AND pg_catalog.jsonb_typeof("approval_display" -> 'fields') = 'array'
		AND pg_catalog.jsonb_array_length("approval_display" -> 'fields') <= 32
	),
	ADD CONSTRAINT "action_proposals_provider_sdk_call_unique" UNIQUE (
		"household_id", "original_owner_user_id", "run_id",
		"capability_id", "provider_sdk_call_id"
	);
ALTER TABLE "emdo"."action_decisions"
	DROP CONSTRAINT "action_decisions_idempotency_unique",
	ADD CONSTRAINT "action_decisions_idempotency_unique" UNIQUE (
		"household_id", "original_owner_user_id", "proposal_id",
		"idempotency_key"
	);
--> statement-breakpoint

-- A single locked reconstruction is the source of truth for collection and
-- operation scope fingerprints. Callers may compare this value but cannot
-- choose or mint any part of its canonical material.
CREATE POLICY proposals_space_grant_executor_read
	ON "emdo"."action_proposals"
	FOR SELECT TO emdo_space_grant_executor
	USING ("original_owner_user_id" = emdo.current_user_id());
CREATE POLICY runs_space_grant_executor_read
	ON "emdo"."agent_runs"
	FOR SELECT TO emdo_space_grant_executor
	USING ("original_owner_user_id" = emdo.current_user_id());
CREATE POLICY households_space_grant_executor_read
	ON "emdo"."households"
	FOR SELECT TO emdo_space_grant_executor
	USING (
		"id" = (
			SELECT session.active_household_id
			FROM emdo.auth_sessions AS session
			WHERE session.id = emdo.current_session_id()
				AND session.user_id = emdo.current_user_id()
		)
	);
CREATE POLICY households_space_grant_executor_lock
	ON "emdo"."households"
	FOR UPDATE TO emdo_space_grant_executor
	USING (
		"id" = (
			SELECT session.active_household_id
			FROM emdo.auth_sessions AS session
			WHERE session.id = emdo.current_session_id()
				AND session.user_id = emdo.current_user_id()
		)
	)
	WITH CHECK (
		"id" = (
			SELECT session.active_household_id
			FROM emdo.auth_sessions AS session
			WHERE session.id = emdo.current_session_id()
				AND session.user_id = emdo.current_user_id()
		)
	);
CREATE POLICY spaces_space_grant_executor_lock
	ON "emdo"."spaces"
	FOR UPDATE TO emdo_space_grant_executor
	USING (
		"household_id" = (
			SELECT session.active_household_id
			FROM emdo.auth_sessions AS session
			WHERE session.id = emdo.current_session_id()
				AND session.user_id = emdo.current_user_id()
		)
		AND (
			"visibility" = 'shared'
			OR "original_owner_user_id" = emdo.current_user_id()
		)
	)
	WITH CHECK (
		"household_id" = (
			SELECT session.active_household_id
			FROM emdo.auth_sessions AS session
			WHERE session.id = emdo.current_session_id()
				AND session.user_id = emdo.current_user_id()
		)
		AND (
			"visibility" = 'shared'
			OR "original_owner_user_id" = emdo.current_user_id()
		)
	);
CREATE POLICY space_access_grants_executor_lock
	ON "emdo"."space_access_grants"
	FOR UPDATE TO emdo_space_grant_executor
	USING (
		"original_owner_user_id" = emdo.current_user_id()
		AND "session_id" = emdo.current_session_id()
		AND "request_id" = emdo.current_request_id()
	)
	WITH CHECK (
		"original_owner_user_id" = emdo.current_user_id()
		AND "session_id" = emdo.current_session_id()
		AND "request_id" = emdo.current_request_id()
	);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."lock_current_authorization_scope"(
	p_space_access_grant_id uuid,
	p_proposal_id uuid,
	p_run_id uuid
)
RETURNS TABLE (
	user_id uuid,
	session_id uuid,
	request_id uuid,
	household_id uuid,
	membership_id uuid,
	membership_administration_version integer,
	role text,
	private_space_id uuid,
	proposal_space_id uuid,
	writable_space_ids uuid[],
	authorization_scope_fingerprint text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	fingerprint_domain CONSTANT text := 'emdo.authorization-scope.v1';
	canonical_keys CONSTANT text[] := ARRAY[
		'domain',
		'householdId',
		'membershipAdministrationVersion',
		'membershipId',
		'privateSpaceId',
		'proposalSpaceId',
		'role',
		'sessionId',
		'userId',
		'writableSpaceIds'
	];
	v_user_id uuid := emdo.current_user_id();
	v_session_id uuid := emdo.current_session_id();
	v_request_id uuid := emdo.current_request_id();
	v_grant emdo.space_access_grants%ROWTYPE;
	v_membership_id uuid;
	v_membership_administration_version integer;
	v_role text;
	v_private_space_id uuid;
	v_private_count integer;
	v_writable_space_ids uuid[];
	v_operation_space_id uuid;
	v_space_id uuid;
	v_material text;
	v_authorization_scope_fingerprint text;
	v_now timestamptz;
BEGIN
	IF p_space_access_grant_id IS NULL
		OR (p_proposal_id IS NOT NULL AND p_run_id IS NOT NULL)
		OR v_user_id IS NULL OR v_session_id IS NULL OR v_request_id IS NULL
	THEN
		RETURN;
	END IF;

	SELECT access.* INTO v_grant
	FROM emdo.space_access_grants AS access
	WHERE access.grant_id = p_space_access_grant_id
		AND access.original_owner_user_id = v_user_id
		AND access.session_id = v_session_id
		AND access.request_id = v_request_id
		AND access.schema_version = 1
		AND access.version = 1
	FOR SHARE OF access;
	IF NOT FOUND THEN
		RETURN;
	END IF;

	v_now := pg_catalog.clock_timestamp();
	IF v_grant.issued_at > v_now OR v_grant.expires_at <= v_now
		OR NOT emdo.lock_active_request_scope(
			v_grant.household_id, NULL, NULL
		)
	THEN
		RETURN;
	END IF;

	SELECT membership.id, membership.administration_version,
		membership.role
	INTO v_membership_id, v_membership_administration_version, v_role
	FROM emdo.auth_sessions AS session
	JOIN emdo.auth_users AS account_user
		ON account_user.id = session.user_id
	JOIN emdo.household_memberships AS membership
		ON membership.id = v_grant.membership_id
		AND membership.household_id = v_grant.household_id
		AND membership.user_id = session.user_id
	WHERE session.id = v_session_id
		AND session.user_id = v_user_id
		AND session.active_household_id = v_grant.household_id
		AND session.expires_at > v_now
		AND account_user.email_verified = true
		AND membership.status = 'active';
	IF NOT FOUND
		OR v_membership_id IS DISTINCT FROM v_grant.membership_id
		OR v_role IS DISTINCT FROM v_grant.role
		OR v_membership_administration_version IS NULL
		OR v_membership_administration_version <= 0
	THEN
		RETURN;
	END IF;

	-- The parent-row UPDATE lock blocks FK-backed space inserts while the
	-- materialized row locks serialize visibility/tombstone mutations.
	PERFORM 1
	FROM emdo.households AS household
	WHERE household.id = v_grant.household_id
	FOR UPDATE OF household;
	IF NOT FOUND THEN
		RETURN;
	END IF;

	WITH locked_spaces AS MATERIALIZED (
		SELECT space.id, space.visibility, space.original_owner_user_id
		FROM emdo.spaces AS space
		WHERE space.household_id = v_grant.household_id
			AND space.tombstoned_at IS NULL
			AND (
				space.visibility = 'shared'
				OR space.original_owner_user_id = v_user_id
			)
		ORDER BY space.id::text COLLATE "C"
		LIMIT 257
		FOR SHARE OF space
	)
	SELECT pg_catalog.array_agg(
			locked.id ORDER BY locked.id::text COLLATE "C"
		),
		pg_catalog.count(*) FILTER (
			WHERE locked.visibility = 'private'
				AND locked.original_owner_user_id = v_user_id
		),
		pg_catalog.min(locked.id::text) FILTER (
			WHERE locked.visibility = 'private'
				AND locked.original_owner_user_id = v_user_id
		)::uuid
	INTO v_writable_space_ids, v_private_count, v_private_space_id
	FROM locked_spaces AS locked;
	IF v_writable_space_ids IS NULL
		OR pg_catalog.cardinality(v_writable_space_ids) NOT BETWEEN 1 AND 256
		OR v_private_count <> 1 OR v_private_space_id IS NULL
		OR v_grant.private_space_id IS DISTINCT FROM v_private_space_id
		OR v_grant.writable_space_ids IS DISTINCT FROM v_writable_space_ids
	THEN
		RETURN;
	END IF;

	FOREACH v_space_id IN ARRAY v_writable_space_ids LOOP
		IF NOT emdo.lock_active_request_scope(
			v_grant.household_id, v_space_id, NULL
		) THEN
			RETURN;
		END IF;
	END LOOP;

	IF p_proposal_id IS NOT NULL THEN
		SELECT proposal.space_id INTO v_operation_space_id
		FROM emdo.action_proposals AS proposal
		WHERE proposal.id = p_proposal_id
			AND proposal.household_id = v_grant.household_id
			AND proposal.original_owner_user_id = v_user_id
			AND proposal.space_id = ANY(v_writable_space_ids);
		IF NOT FOUND THEN
			RETURN;
		END IF;
	ELSIF p_run_id IS NOT NULL THEN
		SELECT run.space_id INTO v_operation_space_id
		FROM emdo.agent_runs AS run
		WHERE run.id = p_run_id
			AND run.household_id = v_grant.household_id
			AND run.original_owner_user_id = v_user_id
			AND run.space_id = ANY(v_writable_space_ids);
		IF NOT FOUND THEN
			RETURN;
		END IF;
	END IF;

	IF v_operation_space_id IS NOT NULL
		AND NOT emdo.lock_active_request_scope(
			v_grant.household_id, v_operation_space_id, NULL
		)
	THEN
		RETURN;
	END IF;
	IF v_grant.issued_at > pg_catalog.clock_timestamp()
		OR v_grant.expires_at <= pg_catalog.clock_timestamp()
	THEN
		RETURN;
	END IF;

	v_material := pg_catalog.concat(
		'{"', canonical_keys[1], '":',
		pg_catalog.to_jsonb(fingerprint_domain)::text,
		',"', canonical_keys[2], '":',
		pg_catalog.to_jsonb(v_grant.household_id::text)::text,
		',"', canonical_keys[3], '":',
		v_membership_administration_version::text,
		',"', canonical_keys[4], '":',
		pg_catalog.to_jsonb(v_membership_id::text)::text,
		',"', canonical_keys[5], '":',
		pg_catalog.to_jsonb(v_private_space_id::text)::text,
		',"', canonical_keys[6], '":',
		CASE WHEN v_operation_space_id IS NULL THEN 'null'
			ELSE pg_catalog.to_jsonb(v_operation_space_id::text)::text END,
		',"', canonical_keys[7], '":',
		pg_catalog.to_jsonb(v_role)::text,
		',"', canonical_keys[8], '":',
		pg_catalog.to_jsonb(v_session_id::text)::text,
		',"', canonical_keys[9], '":',
		pg_catalog.to_jsonb(v_user_id::text)::text,
		',"', canonical_keys[10], '":',
		pg_catalog.array_to_json(v_writable_space_ids)::text,
		'}'
	);
	v_authorization_scope_fingerprint := pg_catalog.encode(
		pg_catalog.sha256(pg_catalog.convert_to(v_material, 'UTF8')), 'hex'
	);

	RETURN QUERY SELECT
		v_user_id,
		v_session_id,
		v_request_id,
		v_grant.household_id,
		v_membership_id,
		v_membership_administration_version,
		v_role,
		v_private_space_id,
		v_operation_space_id,
		v_writable_space_ids,
		v_authorization_scope_fingerprint;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."issue_active_principal_scope"(
	p_household_id uuid,
	p_membership_id uuid,
	p_expected_role text
)
RETURNS TABLE (
	user_id uuid,
	session_id uuid,
	request_id uuid,
	household_id uuid,
	membership_id uuid,
	role text,
	email_verified boolean,
	private_space_id uuid,
	space_access_grant_id uuid,
	collection_authorization_scope_fingerprint text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_grant emdo.space_access_grants%ROWTYPE;
	v_authority record;
BEGIN
	SELECT issued.* INTO v_grant
	FROM emdo.issue_space_access_grant(
		p_household_id, p_membership_id, p_expected_role
	) AS issued;
	IF NOT FOUND THEN
		RETURN;
	END IF;

	SELECT locked.* INTO v_authority
	FROM emdo.lock_current_authorization_scope(
		v_grant.grant_id, NULL, NULL
	) AS locked;
	IF NOT FOUND
		OR v_authority.user_id IS DISTINCT FROM v_grant.original_owner_user_id
		OR v_authority.session_id IS DISTINCT FROM v_grant.session_id
		OR v_authority.request_id IS DISTINCT FROM v_grant.request_id
		OR v_authority.household_id IS DISTINCT FROM v_grant.household_id
		OR v_authority.membership_id IS DISTINCT FROM v_grant.membership_id
		OR v_authority.role IS DISTINCT FROM v_grant.role
		OR v_authority.private_space_id IS DISTINCT FROM v_grant.private_space_id
		OR v_authority.proposal_space_id IS NOT NULL
		OR v_authority.writable_space_ids IS DISTINCT FROM
			v_grant.writable_space_ids
		OR v_authority.authorization_scope_fingerprint
			!~ '^[a-f0-9]{64}$'
	THEN
		RETURN;
	END IF;

	RETURN QUERY SELECT
		v_authority.user_id,
		v_authority.session_id,
		v_authority.request_id,
		v_grant.household_id,
		v_authority.membership_id,
		v_grant.role,
		true,
		v_authority.private_space_id,
		v_grant.grant_id,
		v_authority.authorization_scope_fingerprint;
END
$function$;
--> statement-breakpoint
ALTER FUNCTION "emdo"."lock_current_authorization_scope"(uuid, uuid, uuid)
	OWNER TO emdo_space_grant_executor;
ALTER FUNCTION "emdo"."issue_active_principal_scope"(uuid, uuid, text)
	OWNER TO emdo_space_grant_executor;
GRANT SELECT ON "emdo"."auth_users", "emdo"."auth_sessions",
	"emdo"."households", "emdo"."household_memberships", "emdo"."spaces",
	"emdo"."action_proposals", "emdo"."agent_runs",
	"emdo"."space_access_grants"
	TO emdo_space_grant_executor;
GRANT UPDATE ("grant_id") ON "emdo"."space_access_grants"
	TO emdo_space_grant_executor;
GRANT UPDATE ("id") ON "emdo"."households", "emdo"."spaces"
	TO emdo_space_grant_executor;
REVOKE ALL ON FUNCTION
	"emdo"."lock_current_authorization_scope"(uuid, uuid, uuid),
	"emdo"."issue_active_principal_scope"(uuid, uuid, text)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."lock_current_authorization_scope"(uuid, uuid, uuid)
	TO emdo_space_grant_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."issue_active_principal_scope"(uuid, uuid, text)
	TO emdo_app;
GRANT EXECUTE ON FUNCTION
	"emdo"."lock_current_authorization_scope"(uuid, uuid, uuid)
	TO emdo_oauth_grant_executor;
--> statement-breakpoint

CREATE TABLE "emdo"."proposal_preparations" (
	"proposal_id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"preparation_binding" jsonb NOT NULL,
	"preparation_binding_hash" text NOT NULL,
	"abandonment_reason" text,
	"abandoned_at" timestamp with time zone,
	CONSTRAINT "proposal_preparations_proposal_fk" FOREIGN KEY (
		"household_id", "space_id", "original_owner_user_id", "proposal_id"
	) REFERENCES "emdo"."action_proposals" (
		"household_id", "space_id", "original_owner_user_id", "id"
	) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "proposal_preparations_binding_hash_check" CHECK (
		"preparation_binding_hash" ~ '^[a-f0-9]{64}$'
	),
	CONSTRAINT "proposal_preparations_binding_check" CHECK (
		pg_catalog.jsonb_typeof("preparation_binding") = 'object'
		AND pg_catalog.octet_length("preparation_binding"::text) <= 65536
		AND "preparation_binding" ->> 'proposalId' = "proposal_id"::text
		AND "preparation_binding" ->> 'householdId' = "household_id"::text
		AND "preparation_binding" ->> 'userId' = "original_owner_user_id"::text
		AND "preparation_binding" ->> 'disclosurePolicyVersion'
			~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
	),
	CONSTRAINT "proposal_preparations_abandonment_check" CHECK (
		(
			"abandonment_reason" IS NULL
			AND "abandoned_at" IS NULL
		)
		OR (
			"abandonment_reason" IN (
				'multiple-provider-writes-require-separate-turns',
				'execution-ended-before-checkpoint'
			)
			AND "abandoned_at" IS NOT NULL
		)
	)
);
CREATE INDEX "proposal_preparations_household_space_idx"
	ON "emdo"."proposal_preparations" ("household_id", "space_id");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."protect_proposal_preparation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'proposal preparation binding is immutable';
	END IF;
	IF NEW.proposal_id <> OLD.proposal_id
		OR NEW.household_id <> OLD.household_id
		OR NEW.space_id <> OLD.space_id
		OR NEW.original_owner_user_id <> OLD.original_owner_user_id
		OR NEW.preparation_binding IS DISTINCT FROM OLD.preparation_binding
		OR NEW.preparation_binding_hash <> OLD.preparation_binding_hash
		OR OLD.abandonment_reason IS NOT NULL
		OR OLD.abandoned_at IS NOT NULL
		OR NEW.abandonment_reason IS NULL
		OR NEW.abandoned_at IS NULL
	THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'proposal preparation binding is immutable';
	END IF;
	RETURN NEW;
END
$function$;
CREATE TRIGGER proposal_preparations_immutable
BEFORE UPDATE OR DELETE ON "emdo"."proposal_preparations"
FOR EACH ROW EXECUTE FUNCTION "emdo"."protect_proposal_preparation"();
--> statement-breakpoint

ALTER TABLE "emdo"."provider_attempts"
	ADD COLUMN "authorization" jsonb NOT NULL,
	ADD COLUMN "approval_binding" jsonb NOT NULL,
	ADD COLUMN "provider_authority_binding_hash" text NOT NULL,
	ADD COLUMN "provider_sdk_call_id" text NOT NULL,
	ADD CONSTRAINT "provider_attempts_authorization_check" CHECK (
		pg_catalog.jsonb_typeof("authorization") = 'object'
		AND pg_catalog.octet_length("authorization"::text) <= 262144
		AND "authorization" ->> 'proposalId' = "proposal_id"::text
		AND "authorization" ->> 'attemptId' = "id"::text
		AND ("authorization" ->> 'attemptVersion')::integer = "attempt_version"
		AND "authorization" ->> 'approvalBindingHash' = "binding_hash"
		AND "authorization" ->> 'capabilityFingerprint' = "capability_fingerprint"
		AND "authorization" ->> 'approvalHash' = "approval_hash"
		AND "authorization" ->> 'disclosureGrantId' = "disclosure_grant_id"::text
		AND "authorization" ->> 'disclosureGrantHash' = "disclosure_grant_hash"
		AND "authorization" ->> 'providerIdempotencyKey' = "provider_idempotency_key"
		AND "authorization" -> 'approvalBinding' = "approval_binding"
	),
	ADD CONSTRAINT "provider_attempts_approval_binding_check" CHECK (
		pg_catalog.jsonb_typeof("approval_binding") = 'object'
		AND pg_catalog.octet_length("approval_binding"::text) <= 131072
		AND "approval_binding" ->> 'decisionId' = "decision_id"::text
	),
	ADD CONSTRAINT "provider_attempts_provider_authority_binding_hash_check"
		CHECK ("provider_authority_binding_hash" ~ '^[a-f0-9]{64}$'),
	ADD CONSTRAINT "provider_attempts_provider_sdk_call_id_check" CHECK (
		pg_catalog.length("provider_sdk_call_id") BETWEEN 1 AND 512
		AND pg_catalog.btrim("provider_sdk_call_id") = "provider_sdk_call_id"
		AND "provider_sdk_call_id" !~ '[[:cntrl:]]'
	);
ALTER TABLE "emdo"."provider_outcomes"
	ADD COLUMN "completion" jsonb NOT NULL,
	ADD CONSTRAINT "provider_outcomes_completion_check" CHECK (
		pg_catalog.jsonb_typeof("completion") = 'object'
		AND pg_catalog.octet_length("completion"::text) <= 131072
		AND "completion" ->> 'application' = "application"
		AND "completion" ->> 'reason' IS NOT DISTINCT FROM "reason"
		AND "completion" ->> 'outputStatus' IS NOT DISTINCT FROM "output_status"
		AND "completion" ->> 'resultHash' IS NOT DISTINCT FROM "result_hash"
		AND "completion" ->> 'evidenceHash' IS NOT DISTINCT FROM "evidence_hash"
		AND "completion" ->> 'safeErrorCode' IS NOT DISTINCT FROM "safe_error_code"
	);
ALTER TABLE "emdo"."proposal_reconciliations"
	ADD COLUMN "completion" jsonb NOT NULL,
	ADD CONSTRAINT "proposal_reconciliations_completion_check" CHECK (
		pg_catalog.jsonb_typeof("completion") = 'object'
		AND pg_catalog.octet_length("completion"::text) <= 131072
		AND "completion" ->> 'application' = "application"
		AND "completion" ->> 'resultHash' IS NOT DISTINCT FROM "result_hash"
		AND "completion" ->> 'evidenceHash' IS NOT DISTINCT FROM "evidence_hash"
	);
--> statement-breakpoint

ALTER TABLE "emdo"."provider_attempts"
	DROP CONSTRAINT "provider_attempts_state_check",
	DROP CONSTRAINT "provider_attempts_dispatch_time_check",
	ADD CONSTRAINT "provider_attempts_state_check" CHECK (
		"attempt_state" IN (
			'prepared', 'executing', 'executed', 'not-applied', 'indeterminate'
		)
	),
	ADD CONSTRAINT "provider_attempts_dispatch_time_check" CHECK (
		("attempt_state" = 'prepared' AND "dispatched_at" IS NULL)
		OR ("attempt_state" = 'not-applied')
		OR (
			"attempt_state" IN ('executing', 'executed', 'indeterminate')
			AND "dispatched_at" IS NOT NULL
		)
	);
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
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'provider attempt binding is immutable';
	END IF;
	IF NOT (
		(
			OLD.attempt_state = 'prepared'
			AND NEW.attempt_state = 'executing'
			AND OLD.dispatched_at IS NULL
			AND NEW.dispatched_at IS NOT NULL
		)
		OR (
			OLD.attempt_state = 'prepared'
			AND NEW.attempt_state = 'not-applied'
			AND NEW.dispatched_at IS NULL
		)
		OR (
			OLD.attempt_state = 'executing'
			AND NEW.attempt_state IN ('executed', 'not-applied', 'indeterminate')
			AND NEW.dispatched_at = OLD.dispatched_at
		)
		OR (
			OLD.attempt_state = 'indeterminate'
			AND NEW.attempt_state IN ('executed', 'not-applied')
			AND NEW.dispatched_at = OLD.dispatched_at
		)
	) THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'invalid provider attempt transition';
	END IF;
	RETURN NEW;
END
$function$;
--> statement-breakpoint

ALTER TABLE "emdo"."proposal_preparations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."proposal_preparations" FORCE ROW LEVEL SECURITY;
CREATE POLICY proposal_preparations_app_read
ON "emdo"."proposal_preparations"
FOR SELECT TO emdo_app
USING (
	emdo.can_access_space("household_id", "space_id")
	AND "original_owner_user_id" = emdo.current_user_id()
);
REVOKE ALL ON "emdo"."proposal_preparations"
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor;
GRANT SELECT ON "emdo"."proposal_preparations" TO emdo_app;
REVOKE INSERT, UPDATE, DELETE ON
	"emdo"."action_proposals", "emdo"."proposal_states",
	"emdo"."action_decisions", "emdo"."provider_attempts",
	"emdo"."provider_outcomes", "emdo"."proposal_reconciliations",
	"emdo"."proposal_events", "emdo"."proposal_preparations"
	FROM emdo_app;
REVOKE ALL ON FUNCTION "emdo"."protect_proposal_preparation"()
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor;
--> statement-breakpoint

-- Visual decision proofs persist only deterministic token seed material and
-- its digest. Bearer tokens and HMAC keys never cross the SQL boundary.
CREATE TABLE "emdo"."visual_decision_proofs" (
	"proof_id" uuid PRIMARY KEY NOT NULL,
	"nonce" text NOT NULL,
	"key_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"binding_version" integer DEFAULT 1 NOT NULL,
	"issuance_fingerprint" text NOT NULL,
	"authorization_scope_fingerprint" text NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"proposal_version" integer NOT NULL,
	"payload_hash" text NOT NULL,
	"approval_hash" text NOT NULL,
	"channel" text DEFAULT 'authenticated-visual' NOT NULL,
	"idempotency_key" text NOT NULL,
	"initial_request_id" uuid NOT NULL,
	"latest_request_id" uuid NOT NULL,
	"initial_issued_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"decision_id" uuid,
	"row_version" integer DEFAULT 1 NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "visual_decision_proofs_proposal_fk" FOREIGN KEY (
		"household_id", "space_id", "user_id", "proposal_id"
	) REFERENCES "emdo"."action_proposals" (
		"household_id", "space_id", "original_owner_user_id", "id"
	) ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "visual_decision_proofs_owner_membership_fk" FOREIGN KEY (
		"household_id", "user_id"
	) REFERENCES "emdo"."household_memberships" (
		"household_id", "user_id"
	) ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "visual_decision_proofs_session_fk" FOREIGN KEY (
		"session_id"
	) REFERENCES "emdo"."auth_sessions" ("id")
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "visual_decision_proofs_token_hash_unique"
		UNIQUE ("token_hash"),
	CONSTRAINT "visual_decision_proofs_decision_unique"
		UNIQUE ("decision_id"),
	CONSTRAINT "visual_decision_proofs_idempotency_unique" UNIQUE (
		"user_id", "proposal_id", "idempotency_key"
	),
	CONSTRAINT "visual_decision_proofs_token_material_check" CHECK (
		"nonce" ~ '^[A-Za-z0-9_-]{32,128}$'
		AND "key_id" ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
		AND pg_catalog.length("key_id") BETWEEN 2 AND 64
		AND "token_hash" ~ '^[a-f0-9]{64}$'
	),
	CONSTRAINT "visual_decision_proofs_binding_check" CHECK (
		"binding_version" = 1
		AND "issuance_fingerprint" ~ '^[a-f0-9]{64}$'
		AND "authorization_scope_fingerprint" ~ '^[a-f0-9]{64}$'
		AND "payload_hash" ~ '^[a-f0-9]{64}$'
		AND "approval_hash" ~ '^[a-f0-9]{64}$'
		AND "channel" = 'authenticated-visual'
	),
	CONSTRAINT "visual_decision_proofs_version_check" CHECK (
		"proposal_version" > 0 AND "row_version" > 0
	),
	CONSTRAINT "visual_decision_proofs_lifetime_check" CHECK (
		"initial_issued_at" = "issued_at"
		AND "expires_at" > "issued_at"
		AND "expires_at" <= "issued_at" + interval '120 seconds'
		AND "retain_until" >= "expires_at"
	),
	CONSTRAINT "visual_decision_proofs_terminal_check" CHECK (
		(
			"consumed_at" IS NULL
			AND "decision_id" IS NULL
		)
		OR (
			"consumed_at" IS NOT NULL
			AND "decision_id" IS NOT NULL
			AND "consumed_at" >= "issued_at"
		)
	)
);
CREATE INDEX "visual_decision_proofs_household_space_idx"
	ON "emdo"."visual_decision_proofs" ("household_id", "space_id");
CREATE INDEX "visual_decision_proofs_proposal_idx"
	ON "emdo"."visual_decision_proofs" ("proposal_id", "expires_at");
ALTER TABLE "emdo"."visual_decision_proofs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."visual_decision_proofs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

DO $roles$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_visual_proof_executor'
	) THEN
		CREATE ROLE emdo_visual_proof_executor NOLOGIN NOSUPERUSER NOCREATEDB
			NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$roles$;
ALTER ROLE emdo_visual_proof_executor NOLOGIN NOSUPERUSER NOCREATEDB
	NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
DO $membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname = 'emdo_visual_proof_executor'
			OR child.rolname = 'emdo_visual_proof_executor'
	) THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'visual proof executor must not have role memberships';
	END IF;
END
$membership_guard$;
--> statement-breakpoint

CREATE POLICY visual_proofs_executor_select
	ON "emdo"."visual_decision_proofs"
	FOR SELECT TO emdo_visual_proof_executor USING (true);
CREATE POLICY visual_proofs_executor_insert
	ON "emdo"."visual_decision_proofs"
	FOR INSERT TO emdo_visual_proof_executor WITH CHECK (true);
CREATE POLICY visual_proofs_executor_update
	ON "emdo"."visual_decision_proofs"
	FOR UPDATE TO emdo_visual_proof_executor USING (true) WITH CHECK (true);
CREATE POLICY visual_proof_proposals_executor_select
	ON "emdo"."action_proposals"
	FOR SELECT TO emdo_visual_proof_executor USING (true);
CREATE POLICY visual_proof_proposals_executor_update
	ON "emdo"."action_proposals"
	FOR UPDATE TO emdo_visual_proof_executor USING (true) WITH CHECK (true);
CREATE POLICY visual_proof_states_executor_select
	ON "emdo"."proposal_states"
	FOR SELECT TO emdo_visual_proof_executor USING (true);
CREATE POLICY visual_proof_states_executor_update
	ON "emdo"."proposal_states"
	FOR UPDATE TO emdo_visual_proof_executor USING (true) WITH CHECK (true);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."protect_visual_decision_proof"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'visual decision proof is immutable';
	END IF;
	IF (pg_catalog.to_jsonb(NEW)
			- 'latest_request_id' - 'consumed_at' - 'decision_id' - 'row_version')
		IS DISTINCT FROM
		(pg_catalog.to_jsonb(OLD)
			- 'latest_request_id' - 'consumed_at' - 'decision_id' - 'row_version')
	THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'visual decision proof binding is immutable';
	END IF;
	IF OLD.consumed_at IS NOT NULL THEN
		IF NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
			OR NEW.decision_id IS DISTINCT FROM OLD.decision_id
			OR NEW.latest_request_id IS DISTINCT FROM OLD.latest_request_id
			OR NEW.row_version IS DISTINCT FROM OLD.row_version
		THEN
			RAISE EXCEPTION USING ERRCODE = '55000',
				MESSAGE = 'visual decision proof cannot be revived';
		END IF;
	ELSIF NEW.consumed_at IS NULL THEN
		IF NEW.decision_id IS NOT NULL
			OR NEW.row_version IS DISTINCT FROM OLD.row_version
		THEN
			RAISE EXCEPTION USING ERRCODE = '55000',
				MESSAGE = 'visual decision proof lineage update is invalid';
		END IF;
	ELSIF NEW.decision_id IS NULL
		OR NEW.consumed_at < OLD.issued_at
		OR NEW.latest_request_id IS DISTINCT FROM OLD.latest_request_id
		OR NEW.row_version IS DISTINCT FROM OLD.row_version + 1
	THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'visual decision proof consumption is invalid';
	END IF;
	RETURN NEW;
END
$function$;
CREATE TRIGGER visual_decision_proofs_immutable
BEFORE UPDATE OR DELETE ON "emdo"."visual_decision_proofs"
FOR EACH ROW EXECUTE FUNCTION "emdo"."protect_visual_decision_proof"();
--> statement-breakpoint


CREATE OR REPLACE FUNCTION "emdo"."visual_decision_proof_issuance_fingerprint"(
	p_proof_id uuid,
	p_nonce text,
	p_key_id text,
	p_authorization_scope_fingerprint text,
	p_user_id uuid,
	p_session_id uuid,
	p_household_id uuid,
	p_space_id uuid,
	p_proposal_id uuid,
	p_proposal_version integer,
	p_payload_hash text,
	p_approval_hash text,
	p_idempotency_key text,
	p_initial_request_id uuid,
	p_issued_at timestamptz,
	p_expires_at timestamptz
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $function$
	SELECT pg_catalog.encode(
		pg_catalog.sha256(
			pg_catalog.convert_to(
				'emdo.visual-decision-proof-issuance.v1', 'UTF8'
			)
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_proof_id::text, 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_nonce, 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_key_id, 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(
				p_authorization_scope_fingerprint, 'UTF8'
			)
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_user_id::text, 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_session_id::text, 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_household_id::text, 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_space_id::text, 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_proposal_id::text, 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_proposal_version::text, 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_payload_hash, 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_approval_hash, 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_idempotency_key, 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_initial_request_id::text, 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.timestamptz_send(p_issued_at)
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.timestamptz_send(p_expires_at)
		),
		'hex'
	)
$function$;
--> statement-breakpoint

-- Private replay resolution runs only after prepare holds the transaction
-- advisory/proposal locks. It may advance request lineage and nothing else.
CREATE OR REPLACE FUNCTION "emdo"."resolve_visual_decision_proof_replay"(
	p_space_access_grant_id uuid,
	p_proposal_id uuid,
	p_expected_proposal_version integer,
	p_expected_payload_hash text,
	p_expected_approval_hash text,
	p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_scope record;
	v_proof emdo.visual_decision_proofs%ROWTYPE;
	v_proposal emdo.action_proposals%ROWTYPE;
	v_state emdo.proposal_states%ROWTYPE;
	v_locked record;
	v_request_id uuid := emdo.current_request_id();
	v_now timestamptz := pg_catalog.clock_timestamp();
	v_expected_issuance_fingerprint text;
BEGIN
	IF p_space_access_grant_id IS NULL OR p_proposal_id IS NULL
		OR p_expected_proposal_version IS NULL
		OR p_expected_proposal_version < 1
		OR p_expected_payload_hash IS NULL
		OR p_expected_payload_hash !~ '^[a-f0-9]{64}$'
		OR p_expected_approval_hash IS NULL
		OR p_expected_approval_hash !~ '^[a-f0-9]{64}$'
		OR p_idempotency_key IS NULL
		OR pg_catalog.length(p_idempotency_key) NOT BETWEEN 16 AND 200
		OR p_idempotency_key !~ '^[A-Za-z0-9:._-]+$'
	THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'proposal-binding-mismatch'
		);
	END IF;
	SELECT scope.* INTO v_scope
	FROM emdo.lock_current_authorization_scope(
		p_space_access_grant_id, p_proposal_id, NULL
	) AS scope;
	IF NOT FOUND OR v_request_id IS NULL THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'proposal-not-found'
		);
	END IF;

	SELECT ROW(proposal.*)::emdo.action_proposals AS proposal_row,
		ROW(state.*)::emdo.proposal_states AS state_row
	INTO v_locked
	FROM emdo.action_proposals AS proposal
	JOIN emdo.proposal_states AS state
		ON state.proposal_id = proposal.id
	WHERE proposal.id = p_proposal_id
		AND proposal.household_id = v_scope.household_id
		AND proposal.space_id = v_scope.proposal_space_id
		AND proposal.original_owner_user_id = v_scope.user_id
	FOR UPDATE OF proposal, state;
	IF NOT FOUND THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'proposal-not-found'
		);
	END IF;
	v_proposal := v_locked.proposal_row;
	v_state := v_locked.state_row;

	SELECT stored.* INTO v_proof
	FROM emdo.visual_decision_proofs AS stored
	WHERE stored.user_id = v_scope.user_id
		AND stored.proposal_id = p_proposal_id
		AND stored.idempotency_key = p_idempotency_key
	FOR UPDATE OF stored;
	IF NOT FOUND THEN
		RETURN pg_catalog.jsonb_build_object('status', 'absent');
	END IF;
	IF v_state.state IS DISTINCT FROM 'pending' THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'proposal-not-pending'
		);
	END IF;
	IF v_proposal.expires_at <= v_now OR v_proof.expires_at <= v_now THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'proposal-expired'
		);
	END IF;
	IF v_proof.consumed_at IS NOT NULL OR v_proof.decision_id IS NOT NULL THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'proposal-not-pending'
		);
	END IF;
	IF v_state.version IS DISTINCT FROM p_expected_proposal_version
		OR v_proposal.payload_hash IS DISTINCT FROM p_expected_payload_hash
		OR v_proposal.approval_hash IS DISTINCT FROM p_expected_approval_hash
		OR v_proposal.authorization_scope_fingerprint IS DISTINCT FROM
			v_scope.authorization_scope_fingerprint
	THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'proposal-binding-mismatch'
		);
	END IF;
	IF v_proof.binding_version <> 1
		OR v_proof.household_id IS DISTINCT FROM v_scope.household_id
		OR v_proof.space_id IS DISTINCT FROM v_scope.proposal_space_id
		OR v_proof.user_id IS DISTINCT FROM v_scope.user_id
		OR v_proof.session_id IS DISTINCT FROM v_scope.session_id
		OR v_proof.proposal_version IS DISTINCT FROM
			p_expected_proposal_version
		OR v_proof.payload_hash IS DISTINCT FROM p_expected_payload_hash
		OR v_proof.approval_hash IS DISTINCT FROM p_expected_approval_hash
		OR v_proof.channel IS DISTINCT FROM 'authenticated-visual'
		OR v_proof.authorization_scope_fingerprint IS DISTINCT FROM
			v_scope.authorization_scope_fingerprint
	THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'idempotency-conflict'
		);
	END IF;
	v_expected_issuance_fingerprint :=
		emdo.visual_decision_proof_issuance_fingerprint(
			v_proof.proof_id, v_proof.nonce, v_proof.key_id,
			v_proof.authorization_scope_fingerprint, v_proof.user_id,
			v_proof.session_id, v_proof.household_id, v_proof.space_id,
			v_proof.proposal_id, v_proof.proposal_version,
			v_proof.payload_hash, v_proof.approval_hash,
			v_proof.idempotency_key, v_proof.initial_request_id,
			v_proof.issued_at, v_proof.expires_at
		);
	IF v_proof.issuance_fingerprint IS DISTINCT FROM
		v_expected_issuance_fingerprint
	THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'idempotency-conflict'
		);
	END IF;

	UPDATE emdo.visual_decision_proofs AS stored
	SET latest_request_id = v_request_id
	WHERE stored.proof_id = v_proof.proof_id
		AND stored.latest_request_id = v_proof.latest_request_id;
	IF NOT FOUND THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'idempotency-conflict'
		);
	END IF;
	v_proof.latest_request_id := v_request_id;
	RETURN pg_catalog.jsonb_build_object(
		'status', 'prepared',
		'proof', pg_catalog.jsonb_build_object(
			'schemaVersion', 1,
			'proposalId', v_proof.proposal_id,
			'proposalVersion', v_proof.proposal_version,
			'payloadHash', v_proof.payload_hash,
			'approvalHash', v_proof.approval_hash,
			'issuedAt', v_proof.issued_at,
			'expiresAt', v_proof.expires_at,
			'replayed', true
		),
		'proposalExpiresAt', v_proposal.expires_at,
		'binding', pg_catalog.jsonb_build_object(
			'bindingVersion', v_proof.binding_version,
			'issuanceFingerprint', v_proof.issuance_fingerprint,
			'authorizationScopeFingerprint',
				v_proof.authorization_scope_fingerprint,
			'initialRequestId', v_proof.initial_request_id
		),
		'tokenMaterial', pg_catalog.jsonb_build_object(
			'proofId', v_proof.proof_id,
			'nonce', v_proof.nonce,
			'keyId', v_proof.key_id,
			'tokenHash', v_proof.token_hash
		)
	);
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."prepare_visual_decision_proof"(
	p_household_id uuid,
	p_space_access_grant_id uuid,
	p_proposal_id uuid,
	p_expected_proposal_version integer,
	p_expected_payload_hash text,
	p_expected_approval_hash text,
	p_idempotency_key text,
	p_candidate_proof_id uuid,
	p_candidate_nonce text,
	p_candidate_key_id text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_scope record;
	v_proposal emdo.action_proposals%ROWTYPE;
	v_state emdo.proposal_states%ROWTYPE;
	v_locked record;
	v_replay jsonb;
	v_now timestamptz;
	v_expires_at timestamptz;
	v_issuance_fingerprint text;
	v_request_id uuid := emdo.current_request_id();
	v_user_id uuid := emdo.current_user_id();
BEGIN
	IF p_household_id IS NULL OR p_space_access_grant_id IS NULL
		OR p_proposal_id IS NULL OR p_expected_proposal_version IS NULL
		OR p_expected_proposal_version < 1
		OR p_expected_payload_hash IS NULL
		OR p_expected_payload_hash !~ '^[a-f0-9]{64}$'
		OR p_expected_approval_hash IS NULL
		OR p_expected_approval_hash !~ '^[a-f0-9]{64}$'
		OR p_idempotency_key IS NULL
		OR pg_catalog.length(p_idempotency_key) NOT BETWEEN 16 AND 200
		OR p_idempotency_key !~ '^[A-Za-z0-9:._-]+$'
		OR p_candidate_proof_id IS NULL
		OR p_candidate_nonce IS NULL
		OR p_candidate_nonce !~ '^[A-Za-z0-9_-]{32,128}$'
		OR p_candidate_key_id IS NULL
		OR pg_catalog.length(p_candidate_key_id) NOT BETWEEN 2 AND 64
		OR p_candidate_key_id !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
		OR v_request_id IS NULL OR v_user_id IS NULL
	THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'proposal-binding-mismatch'
		);
	END IF;
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			v_user_id::text || ':' || p_proposal_id::text || ':'
				|| p_idempotency_key,
			0
		)
	);
	SELECT scope.* INTO v_scope
	FROM emdo.lock_current_authorization_scope(
		p_space_access_grant_id, p_proposal_id, NULL
	) AS scope;
	IF NOT FOUND THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'proposal-not-found'
		);
	END IF;

	SELECT ROW(proposal.*)::emdo.action_proposals AS proposal_row,
		ROW(state.*)::emdo.proposal_states AS state_row
	INTO v_locked
	FROM emdo.action_proposals AS proposal
	JOIN emdo.proposal_states AS state
		ON state.proposal_id = proposal.id
	WHERE proposal.id = p_proposal_id
		AND proposal.household_id = v_scope.household_id
		AND proposal.space_id = v_scope.proposal_space_id
		AND proposal.original_owner_user_id = v_scope.user_id
	FOR UPDATE OF proposal, state;
	IF NOT FOUND THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'proposal-not-found'
		);
	END IF;
	v_proposal := v_locked.proposal_row;
	v_state := v_locked.state_row;
	v_now := pg_catalog.clock_timestamp();
	IF v_scope.household_id IS DISTINCT FROM p_household_id
		OR v_state.version IS DISTINCT FROM p_expected_proposal_version
		OR v_proposal.payload_hash IS DISTINCT FROM p_expected_payload_hash
		OR v_proposal.approval_hash IS DISTINCT FROM p_expected_approval_hash
		OR v_proposal.authorization_scope_fingerprint IS DISTINCT FROM
			v_scope.authorization_scope_fingerprint
	THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'proposal-binding-mismatch'
		);
	END IF;
	IF v_state.state IS DISTINCT FROM 'pending' THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'proposal-not-pending'
		);
	END IF;
	IF v_proposal.expires_at <= v_now THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'proposal-expired'
		);
	END IF;

	v_replay := emdo.resolve_visual_decision_proof_replay(
		p_space_access_grant_id, p_proposal_id,
		p_expected_proposal_version, p_expected_payload_hash,
		p_expected_approval_hash, p_idempotency_key
	);
	IF v_replay ->> 'status' IS DISTINCT FROM 'absent' THEN
		RETURN v_replay;
	END IF;

	v_now := pg_catalog.clock_timestamp();
	v_expires_at := least(
		v_now + interval '120 seconds', v_proposal.expires_at
	);
	IF v_expires_at <= v_now THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'proposal-expired'
		);
	END IF;
	v_issuance_fingerprint :=
		emdo.visual_decision_proof_issuance_fingerprint(
			p_candidate_proof_id, p_candidate_nonce, p_candidate_key_id,
			v_scope.authorization_scope_fingerprint, v_scope.user_id,
			v_scope.session_id, v_scope.household_id,
			v_scope.proposal_space_id, p_proposal_id,
			p_expected_proposal_version, p_expected_payload_hash,
			p_expected_approval_hash, p_idempotency_key, v_request_id,
			v_now, v_expires_at
		);
	RETURN pg_catalog.jsonb_build_object(
		'status', 'prepared',
		'proof', pg_catalog.jsonb_build_object(
			'schemaVersion', 1,
			'proposalId', p_proposal_id,
			'proposalVersion', p_expected_proposal_version,
			'payloadHash', p_expected_payload_hash,
			'approvalHash', p_expected_approval_hash,
			'issuedAt', v_now,
			'expiresAt', v_expires_at,
			'replayed', false
		),
		'proposalExpiresAt', v_proposal.expires_at,
		'binding', pg_catalog.jsonb_build_object(
			'bindingVersion', 1,
			'issuanceFingerprint', v_issuance_fingerprint,
			'authorizationScopeFingerprint',
				v_scope.authorization_scope_fingerprint,
			'initialRequestId', v_request_id
		),
		'tokenMaterial', pg_catalog.jsonb_build_object(
			'proofId', p_candidate_proof_id,
			'nonce', p_candidate_nonce,
			'keyId', p_candidate_key_id
		)
	);
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."finalize_visual_decision_proof"(
	p_household_id uuid,
	p_space_access_grant_id uuid,
	p_proposal_id uuid,
	p_idempotency_key text,
	p_proof_id uuid,
	p_nonce text,
	p_key_id text,
	p_binding_version integer,
	p_issuance_fingerprint text,
	p_authorization_scope_fingerprint text,
	p_initial_request_id uuid,
	p_issued_at timestamptz,
	p_expires_at timestamptz,
	p_token_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_scope record;
	v_proposal emdo.action_proposals%ROWTYPE;
	v_state emdo.proposal_states%ROWTYPE;
	v_proof emdo.visual_decision_proofs%ROWTYPE;
	v_locked record;
	v_now timestamptz := pg_catalog.clock_timestamp();
	v_request_id uuid := emdo.current_request_id();
	v_user_id uuid := emdo.current_user_id();
	v_expected_issuance_fingerprint text;
	v_replayed boolean := false;
BEGIN
	IF p_household_id IS NULL OR p_space_access_grant_id IS NULL
		OR p_proposal_id IS NULL OR p_proof_id IS NULL
		OR p_idempotency_key IS NULL
		OR pg_catalog.length(p_idempotency_key) NOT BETWEEN 16 AND 200
		OR p_idempotency_key !~ '^[A-Za-z0-9:._-]+$'
		OR p_nonce IS NULL
		OR p_nonce !~ '^[A-Za-z0-9_-]{32,128}$'
		OR p_key_id IS NULL
		OR pg_catalog.length(p_key_id) NOT BETWEEN 2 AND 64
		OR p_key_id !~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
		OR p_binding_version IS NULL OR p_binding_version <> 1
		OR p_issuance_fingerprint IS NULL
		OR p_issuance_fingerprint !~ '^[a-f0-9]{64}$'
		OR p_authorization_scope_fingerprint IS NULL
		OR p_authorization_scope_fingerprint !~ '^[a-f0-9]{64}$'
		OR p_initial_request_id IS NULL
		OR p_issued_at IS NULL OR p_expires_at IS NULL
		OR p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$'
		OR v_request_id IS NULL OR v_user_id IS NULL
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			v_user_id::text || ':' || p_proposal_id::text || ':'
				|| p_idempotency_key,
			0
		)
	);
	SELECT scope.* INTO v_scope
	FROM emdo.lock_current_authorization_scope(
		p_space_access_grant_id, p_proposal_id, NULL
	) AS scope;
	IF NOT FOUND
		OR v_scope.household_id IS DISTINCT FROM p_household_id
		OR v_scope.authorization_scope_fingerprint IS DISTINCT FROM
			p_authorization_scope_fingerprint
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;

	SELECT ROW(proposal.*)::emdo.action_proposals AS proposal_row,
		ROW(state.*)::emdo.proposal_states AS state_row
	INTO v_locked
	FROM emdo.action_proposals AS proposal
	JOIN emdo.proposal_states AS state
		ON state.proposal_id = proposal.id
	WHERE proposal.id = p_proposal_id
		AND proposal.household_id = v_scope.household_id
		AND proposal.space_id = v_scope.proposal_space_id
		AND proposal.original_owner_user_id = v_scope.user_id
	FOR UPDATE OF proposal, state;
	IF NOT FOUND THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	v_proposal := v_locked.proposal_row;
	v_state := v_locked.state_row;
	IF v_state.state IS DISTINCT FROM 'pending'
		OR v_state.version < 1
		OR v_proposal.expires_at <= v_now
		OR v_proposal.authorization_scope_fingerprint IS DISTINCT FROM
			v_scope.authorization_scope_fingerprint
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;

	SELECT stored.* INTO v_proof
	FROM emdo.visual_decision_proofs AS stored
	WHERE stored.user_id = v_scope.user_id
		AND stored.proposal_id = p_proposal_id
		AND stored.idempotency_key = p_idempotency_key
	FOR UPDATE OF stored;
	IF FOUND THEN
		v_replayed := true;
		v_expected_issuance_fingerprint :=
			emdo.visual_decision_proof_issuance_fingerprint(
				v_proof.proof_id, v_proof.nonce, v_proof.key_id,
				v_proof.authorization_scope_fingerprint, v_proof.user_id,
				v_proof.session_id, v_proof.household_id, v_proof.space_id,
				v_proof.proposal_id, v_proof.proposal_version,
				v_proof.payload_hash, v_proof.approval_hash,
				v_proof.idempotency_key, v_proof.initial_request_id,
				v_proof.issued_at, v_proof.expires_at
			);
		IF v_proof.proof_id IS DISTINCT FROM p_proof_id
			OR v_proof.nonce IS DISTINCT FROM p_nonce
			OR v_proof.key_id IS DISTINCT FROM p_key_id
			OR v_proof.token_hash IS DISTINCT FROM p_token_hash
			OR v_proof.binding_version IS DISTINCT FROM p_binding_version
			OR v_proof.issuance_fingerprint IS DISTINCT FROM
				p_issuance_fingerprint
			OR v_proof.issuance_fingerprint IS DISTINCT FROM
				v_expected_issuance_fingerprint
			OR v_proof.authorization_scope_fingerprint IS DISTINCT FROM
				p_authorization_scope_fingerprint
			OR v_proof.user_id IS DISTINCT FROM v_scope.user_id
			OR v_proof.session_id IS DISTINCT FROM v_scope.session_id
			OR v_proof.household_id IS DISTINCT FROM v_scope.household_id
			OR v_proof.space_id IS DISTINCT FROM v_scope.proposal_space_id
			OR v_proof.proposal_version IS DISTINCT FROM v_state.version
			OR v_proof.payload_hash IS DISTINCT FROM v_proposal.payload_hash
			OR v_proof.approval_hash IS DISTINCT FROM v_proposal.approval_hash
			OR v_proof.initial_request_id IS DISTINCT FROM p_initial_request_id
			OR v_proof.issued_at IS DISTINCT FROM p_issued_at
			OR v_proof.expires_at IS DISTINCT FROM p_expires_at
			OR v_proof.expires_at <= v_now
			OR v_proof.consumed_at IS NOT NULL
			OR v_proof.decision_id IS NOT NULL
			OR v_proof.latest_request_id IS DISTINCT FROM v_request_id
		THEN
			RETURN pg_catalog.jsonb_build_object('status', 'conflict');
		END IF;
	ELSE
		IF v_request_id IS DISTINCT FROM p_initial_request_id
			OR p_issued_at < pg_catalog.transaction_timestamp()
			OR p_issued_at > v_now
			OR p_issued_at < v_now - interval '30 seconds'
			OR p_expires_at <= v_now
			OR p_expires_at IS DISTINCT FROM least(
				p_issued_at + interval '120 seconds', v_proposal.expires_at
			)
		THEN
			RETURN pg_catalog.jsonb_build_object('status', 'conflict');
		END IF;
		v_expected_issuance_fingerprint :=
			emdo.visual_decision_proof_issuance_fingerprint(
				p_proof_id, p_nonce, p_key_id,
				p_authorization_scope_fingerprint, v_scope.user_id,
				v_scope.session_id, v_scope.household_id,
				v_scope.proposal_space_id, p_proposal_id, v_state.version,
				v_proposal.payload_hash, v_proposal.approval_hash,
				p_idempotency_key, p_initial_request_id, p_issued_at,
				p_expires_at
			);
		IF p_issuance_fingerprint IS DISTINCT FROM
			v_expected_issuance_fingerprint
		THEN
			RETURN pg_catalog.jsonb_build_object('status', 'conflict');
		END IF;
		INSERT INTO emdo.visual_decision_proofs(
			proof_id, nonce, key_id, token_hash, binding_version,
			issuance_fingerprint, authorization_scope_fingerprint,
			user_id, session_id, household_id, space_id, proposal_id,
			proposal_version, payload_hash, approval_hash, channel,
			idempotency_key, initial_request_id, latest_request_id,
			initial_issued_at, issued_at, expires_at, consumed_at,
			decision_id, row_version, retain_until
		) VALUES (
			p_proof_id, p_nonce, p_key_id, p_token_hash, 1,
			p_issuance_fingerprint, p_authorization_scope_fingerprint,
			v_scope.user_id, v_scope.session_id, v_scope.household_id,
			v_scope.proposal_space_id, p_proposal_id, v_state.version,
			v_proposal.payload_hash, v_proposal.approval_hash,
			'authenticated-visual', p_idempotency_key,
			p_initial_request_id, v_request_id, p_issued_at, p_issued_at,
			p_expires_at, NULL, NULL, 1,
			p_issued_at + interval '90 days'
		)
		ON CONFLICT DO NOTHING
		RETURNING * INTO v_proof;
		IF NOT FOUND THEN
			RETURN pg_catalog.jsonb_build_object('status', 'conflict');
		END IF;
	END IF;

	RETURN pg_catalog.jsonb_build_object(
		'status', 'issued',
		'proof', pg_catalog.jsonb_build_object(
			'schemaVersion', 1,
			'proposalId', v_proof.proposal_id,
			'proposalVersion', v_proof.proposal_version,
			'payloadHash', v_proof.payload_hash,
			'approvalHash', v_proof.approval_hash,
			'issuedAt', v_proof.issued_at,
			'expiresAt', v_proof.expires_at,
			'replayed', v_replayed
		),
		'tokenMaterial', pg_catalog.jsonb_build_object(
			'proofId', v_proof.proof_id,
			'nonce', v_proof.nonce,
			'keyId', v_proof.key_id,
			'tokenHash', v_proof.token_hash
		)
	);
END
$function$;
--> statement-breakpoint

ALTER FUNCTION "emdo"."visual_decision_proof_issuance_fingerprint"(
	uuid, text, text, text, uuid, uuid, uuid, uuid, uuid, integer, text,
	text, text, uuid, timestamptz, timestamptz
) OWNER TO emdo_visual_proof_executor;
ALTER FUNCTION "emdo"."resolve_visual_decision_proof_replay"(
	uuid, uuid, integer, text, text, text
) OWNER TO emdo_visual_proof_executor;
ALTER FUNCTION "emdo"."prepare_visual_decision_proof"(
	uuid, uuid, uuid, integer, text, text, text, uuid, text, text
) OWNER TO emdo_visual_proof_executor;
ALTER FUNCTION "emdo"."finalize_visual_decision_proof"(
	uuid, uuid, uuid, text, uuid, text, text, integer, text, text, uuid,
	timestamptz, timestamptz, text
) OWNER TO emdo_visual_proof_executor;
ALTER FUNCTION "emdo"."protect_visual_decision_proof"()
	OWNER TO emdo_visual_proof_executor;
--> statement-breakpoint

GRANT USAGE ON SCHEMA "emdo" TO emdo_visual_proof_executor;
GRANT SELECT ON
	"emdo"."action_proposals", "emdo"."proposal_states"
	TO emdo_visual_proof_executor;
GRANT UPDATE ("id") ON "emdo"."action_proposals"
	TO emdo_visual_proof_executor;
GRANT UPDATE ("proposal_id") ON "emdo"."proposal_states"
	TO emdo_visual_proof_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."current_user_id"(), "emdo"."current_session_id"(),
	"emdo"."current_request_id"(),
	"emdo"."lock_current_authorization_scope"(uuid, uuid, uuid)
	TO emdo_visual_proof_executor;
--> statement-breakpoint

REVOKE ALL ON "emdo"."visual_decision_proofs"
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor;
REVOKE INSERT, UPDATE, DELETE ON "emdo"."visual_decision_proofs"
	FROM emdo_app;
GRANT SELECT, INSERT ON "emdo"."visual_decision_proofs"
	TO emdo_visual_proof_executor;
GRANT UPDATE (
	"latest_request_id", "consumed_at", "decision_id", "row_version"
) ON "emdo"."visual_decision_proofs" TO emdo_visual_proof_executor;
REVOKE ALL ON FUNCTION "emdo"."protect_visual_decision_proof"()
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_visual_proof_executor;
REVOKE ALL ON FUNCTION
	"emdo"."visual_decision_proof_issuance_fingerprint"(
		uuid, text, text, text, uuid, uuid, uuid, uuid, uuid, integer, text,
		text, text, uuid, timestamptz, timestamptz
	),
	"emdo"."resolve_visual_decision_proof_replay"(
		uuid, uuid, integer, text, text, text
	)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."visual_decision_proof_issuance_fingerprint"(
		uuid, text, text, text, uuid, uuid, uuid, uuid, uuid, integer, text,
		text, text, uuid, timestamptz, timestamptz
	),
	"emdo"."resolve_visual_decision_proof_replay"(
		uuid, uuid, integer, text, text, text
	)
	TO emdo_visual_proof_executor;
REVOKE ALL ON FUNCTION
	"emdo"."prepare_visual_decision_proof"(
		uuid, uuid, uuid, integer, text, text, text, uuid, text, text
	),
	"emdo"."finalize_visual_decision_proof"(
		uuid, uuid, uuid, text, uuid, text, text, integer, text, text, uuid,
		timestamptz, timestamptz, text
	)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."prepare_visual_decision_proof"(
		uuid, uuid, uuid, integer, text, text, text, uuid, text, text
	),
	"emdo"."finalize_visual_decision_proof"(
		uuid, uuid, uuid, text, uuid, text, text, integer, text, text, uuid,
		timestamptz, timestamptz, text
	)
	TO emdo_app;
--> statement-breakpoint

-- A workflow login receives no data-plane role membership. The server mints
-- one opaque, short-lived operation claim and the login can only consume that
-- claim through the SECURITY DEFINER boundary below. Canonical rows are locked
-- and revalidated in the same transaction that activates the scope.
CREATE TABLE "emdo"."workflow_operation_claims" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"phase" text NOT NULL,
	"scope_assertion" jsonb NOT NULL,
	"origin_request_id" uuid NOT NULL,
	"origin_space_access_grant_id" uuid NOT NULL,
	"origin_session_id" uuid NOT NULL,
	"current_request_id" uuid NOT NULL,
	"current_space_access_grant_id" uuid NOT NULL,
	"current_session_id" uuid NOT NULL,
	"authorization_scope_fingerprint" text NOT NULL,
	"disclosure_grant_id" uuid NOT NULL,
	"disclosure_grant_version" integer NOT NULL,
	"disclosure_grant_hash" text NOT NULL,
	"provider_sdk_call_id" text NOT NULL,
	"active_at" timestamp with time zone NOT NULL,
	"require_active_disclosure_grant" boolean NOT NULL,
	"authenticated_session_id" uuid,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"decision_id" uuid,
	"provider_attempt_id" uuid,
	"provider_authority_binding_hash" text NOT NULL,
	"preparation_binding_hash" text NOT NULL,
	"binding_hash" text,
	"mutation_hash" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "workflow_operation_claims_operation_id_check" CHECK (
		pg_catalog.length("operation_id") BETWEEN 32 AND 512
		AND "operation_id" ~ '^[A-Za-z0-9_-]+$'
	),
	CONSTRAINT "workflow_operation_claims_phase_check" CHECK (
		(
			"phase" = 'proposal-create'
			AND "authenticated_session_id" IS NULL
			AND "decision_id" IS NULL
			AND "provider_attempt_id" IS NULL
			AND "binding_hash" IS NULL
			AND "require_active_disclosure_grant" = true
		)
		OR (
			"phase" = 'visual-decision'
			AND "authenticated_session_id" IS NOT NULL
			AND "decision_id" IS NOT NULL
			AND "provider_attempt_id" IS NULL
			AND "binding_hash" IS NULL
		)
		OR (
			"phase" = 'provider-write-prepare'
			AND "authenticated_session_id" IS NOT NULL
			AND "decision_id" IS NOT NULL
			AND "provider_attempt_id" IS NOT NULL
			AND "binding_hash" IS NOT NULL
			AND "require_active_disclosure_grant" = true
		)
		OR (
			"phase" = 'provider-write-dispatch'
			AND "authenticated_session_id" IS NOT NULL
			AND "decision_id" IS NOT NULL
			AND "provider_attempt_id" IS NOT NULL
			AND "binding_hash" IS NOT NULL
			AND "require_active_disclosure_grant" = true
		)
	),
	CONSTRAINT "workflow_operation_claims_scope_assertion_check" CHECK (
		pg_catalog.jsonb_typeof("scope_assertion") = 'object'
		AND pg_catalog.octet_length("scope_assertion"::text) <= 16384
	),
	CONSTRAINT "workflow_operation_claims_disclosure_version_check" CHECK (
		"disclosure_grant_version" > 0
	),
	CONSTRAINT "workflow_operation_claims_provider_sdk_call_id_check" CHECK (
		pg_catalog.length("provider_sdk_call_id") BETWEEN 1 AND 512
		AND pg_catalog.btrim("provider_sdk_call_id") = "provider_sdk_call_id"
		AND "provider_sdk_call_id" !~ '[[:cntrl:]]'
	),
	CONSTRAINT "workflow_operation_claims_binding_hash_check" CHECK (
		"authorization_scope_fingerprint" ~ '^[a-f0-9]{64}$'
		AND
		"provider_authority_binding_hash" ~ '^[a-f0-9]{64}$'
		AND "preparation_binding_hash" ~ '^[a-f0-9]{64}$'
		AND (
			"binding_hash" IS NULL
			OR "binding_hash" ~ '^[a-f0-9]{64}$'
		)
		AND "mutation_hash" ~ '^[a-f0-9]{64}$'
		AND "disclosure_grant_hash" ~ '^[a-f0-9]{64}$'
	),
	CONSTRAINT "workflow_operation_claims_owner_check" CHECK (
		"user_id" = "original_owner_user_id"
		AND (
			"authenticated_session_id" IS NULL
			OR "authenticated_session_id" = "current_session_id"
		)
	),
	CONSTRAINT "workflow_operation_claims_lifetime_check" CHECK (
		"expires_at" > "issued_at"
		AND "expires_at" <= "issued_at" + interval '10 minutes'
		AND (
			"claimed_at" IS NULL
			OR "claimed_at" BETWEEN "issued_at" AND "expires_at"
		)
	),
	CONSTRAINT "workflow_operation_claims_user_membership_fk"
		FOREIGN KEY ("household_id", "user_id")
		REFERENCES "emdo"."household_memberships"("household_id", "user_id")
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "workflow_operation_claims_space_fk"
		FOREIGN KEY ("household_id", "space_id")
		REFERENCES "emdo"."spaces"("household_id", "id")
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "workflow_operation_claims_run_fk"
		FOREIGN KEY (
			"household_id", "space_id", "original_owner_user_id", "run_id"
		)
		REFERENCES "emdo"."agent_runs"(
			"household_id", "space_id", "original_owner_user_id", "id"
		)
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "workflow_operation_claims_current_session_fk"
		FOREIGN KEY ("current_session_id")
		REFERENCES "emdo"."auth_sessions"("id")
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "workflow_operation_claims_origin_session_fk"
		FOREIGN KEY ("origin_session_id")
		REFERENCES "emdo"."auth_sessions"("id")
		ON DELETE RESTRICT ON UPDATE RESTRICT
);
--> statement-breakpoint
CREATE INDEX "workflow_operation_claims_expiry_idx"
	ON "emdo"."workflow_operation_claims" ("expires_at", "claimed_at");
--> statement-breakpoint
ALTER TABLE "emdo"."workflow_operation_claims" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."workflow_operation_claims" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."enforce_workflow_operation_claim_transition"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
	IF TG_OP = 'DELETE'
		OR (pg_catalog.to_jsonb(NEW) - 'claimed_at') IS DISTINCT FROM
			(pg_catalog.to_jsonb(OLD) - 'claimed_at')
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'workflow operation claim binding is immutable';
	END IF;
	IF OLD.claimed_at IS NOT NULL
		OR NEW.claimed_at IS NULL
		OR NEW.claimed_at < OLD.issued_at
		OR NEW.claimed_at > OLD.expires_at
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'invalid workflow operation claim transition';
	END IF;
	RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER workflow_operation_claims_transition
BEFORE UPDATE OR DELETE ON "emdo"."workflow_operation_claims"
FOR EACH ROW EXECUTE FUNCTION "emdo"."enforce_workflow_operation_claim_transition"();
--> statement-breakpoint
DO $roles$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_workflow_executor'
	) THEN
		CREATE ROLE emdo_workflow_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_workflow_login'
	) THEN
		CREATE ROLE emdo_workflow_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_visual_decision_login'
	) THEN
		CREATE ROLE emdo_visual_decision_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$roles$;
--> statement-breakpoint
ALTER ROLE emdo_workflow_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_workflow_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
	NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_visual_decision_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
	NOINHERIT NOBYPASSRLS NOREPLICATION;
REVOKE emdo_workflow FROM emdo_workflow_login;
REVOKE emdo_workflow_executor FROM emdo_workflow_login;
REVOKE emdo_workflow FROM emdo_visual_decision_login;
REVOKE emdo_workflow_executor FROM emdo_visual_decision_login;
--> statement-breakpoint
DO $membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname IN (
			'emdo_workflow_executor', 'emdo_visual_decision_login'
		)
			OR child.rolname IN (
				'emdo_workflow_executor', 'emdo_visual_decision_login'
			)
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'workflow executor must not have role memberships; visual decision login must not have role memberships';
	END IF;
END
$membership_guard$;
--> statement-breakpoint
CREATE POLICY workflow_claims_executor_select
	ON "emdo"."workflow_operation_claims"
	FOR SELECT TO emdo_workflow_executor USING (true);
CREATE POLICY workflow_claims_executor_update
	ON "emdo"."workflow_operation_claims"
	FOR UPDATE TO emdo_workflow_executor USING (true) WITH CHECK (true);
CREATE POLICY workflow_claims_executor_insert
	ON "emdo"."workflow_operation_claims"
	FOR INSERT TO emdo_workflow_executor WITH CHECK (true);
CREATE POLICY workflow_memberships_executor_select
	ON "emdo"."household_memberships"
	FOR SELECT TO emdo_workflow_executor USING (true);
CREATE POLICY workflow_memberships_executor_update
	ON "emdo"."household_memberships"
	FOR UPDATE TO emdo_workflow_executor USING (true) WITH CHECK (true);
CREATE POLICY workflow_spaces_executor_select
	ON "emdo"."spaces"
	FOR SELECT TO emdo_workflow_executor USING (true);
CREATE POLICY workflow_spaces_executor_update
	ON "emdo"."spaces"
	FOR UPDATE TO emdo_workflow_executor USING (true) WITH CHECK (true);
CREATE POLICY workflow_runs_executor_select
	ON "emdo"."agent_runs"
	FOR SELECT TO emdo_workflow_executor USING (true);
CREATE POLICY workflow_runs_executor_update
	ON "emdo"."agent_runs"
	FOR UPDATE TO emdo_workflow_executor USING (true) WITH CHECK (true);
CREATE POLICY workflow_proposals_executor_select
	ON "emdo"."action_proposals"
	FOR SELECT TO emdo_workflow_executor USING (true);
CREATE POLICY workflow_proposals_executor_update
	ON "emdo"."action_proposals"
	FOR UPDATE TO emdo_workflow_executor USING (true) WITH CHECK (true);
CREATE POLICY workflow_decisions_executor_select
	ON "emdo"."action_decisions"
	FOR SELECT TO emdo_workflow_executor USING (true);
CREATE POLICY workflow_decisions_executor_update
	ON "emdo"."action_decisions"
	FOR UPDATE TO emdo_workflow_executor USING (true) WITH CHECK (true);
CREATE POLICY workflow_attempts_executor_select
	ON "emdo"."provider_attempts"
	FOR SELECT TO emdo_workflow_executor USING (true);
CREATE POLICY workflow_attempts_executor_update
	ON "emdo"."provider_attempts"
	FOR UPDATE TO emdo_workflow_executor USING (true) WITH CHECK (true);
CREATE POLICY workflow_states_executor_select
	ON "emdo"."proposal_states"
	FOR SELECT TO emdo_workflow_executor USING (true);
CREATE POLICY workflow_states_executor_update
	ON "emdo"."proposal_states"
	FOR UPDATE TO emdo_workflow_executor USING (true) WITH CHECK (true);
CREATE POLICY workflow_preparations_executor_select
	ON "emdo"."proposal_preparations"
	FOR SELECT TO emdo_workflow_executor USING (true);
CREATE POLICY workflow_preparations_executor_update
	ON "emdo"."proposal_preparations"
	FOR UPDATE TO emdo_workflow_executor USING (true) WITH CHECK (true);
CREATE POLICY workflow_space_grants_executor_select
	ON "emdo"."space_access_grants"
	FOR SELECT TO emdo_workflow_executor USING (true);
CREATE POLICY workflow_space_grants_executor_update
	ON "emdo"."space_access_grants"
	FOR UPDATE TO emdo_workflow_executor USING (true) WITH CHECK (true);
CREATE POLICY workflow_disclosure_grants_executor_select
	ON "emdo"."disclosure_grants"
	FOR SELECT TO emdo_workflow_executor USING (true);
CREATE POLICY workflow_disclosure_grants_executor_update
	ON "emdo"."disclosure_grants"
	FOR UPDATE TO emdo_workflow_executor USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT USAGE ON SCHEMA "emdo" TO emdo_workflow_executor;
GRANT SELECT, INSERT, UPDATE ("claimed_at")
	ON "emdo"."workflow_operation_claims" TO emdo_workflow_executor;
GRANT SELECT, UPDATE ("id")
	ON "emdo"."auth_users", "emdo"."auth_sessions", "emdo"."spaces",
		"emdo"."agent_runs", "emdo"."action_proposals",
		"emdo"."action_decisions", "emdo"."provider_attempts",
		"emdo"."disclosure_grants"
	TO emdo_workflow_executor;
GRANT SELECT, UPDATE ("proposal_id")
	ON "emdo"."proposal_states", "emdo"."proposal_preparations"
	TO emdo_workflow_executor;
GRANT SELECT, UPDATE ("household_id")
	ON "emdo"."household_memberships" TO emdo_workflow_executor;
GRANT SELECT, UPDATE ("grant_id")
	ON "emdo"."space_access_grants" TO emdo_workflow_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."current_user_id"(), "emdo"."current_session_id"(),
	"emdo"."current_request_id"(),
	"emdo"."lock_active_request_scope"(uuid, uuid, uuid),
	"emdo"."lock_current_authorization_scope"(uuid, uuid, uuid),
	"emdo"."lock_current_google_calendar_authority"(
		uuid, uuid, uuid, text, text
	)
	TO emdo_workflow_executor;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."issue_workflow_operation_claim"(
	p_operation_id text,
	p_scope jsonb,
	p_decision_id uuid,
	p_provider_attempt_id uuid,
	p_binding_hash text,
	p_create_preparation_binding_hash text,
	p_provider_authority_binding_hash text,
	p_mutation jsonb
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_user_id uuid := emdo.current_user_id();
	v_session_id uuid := emdo.current_session_id();
	v_current_request_id uuid := emdo.current_request_id();
	v_origin_request_id uuid;
	v_origin_space_access_grant_id uuid;
	v_origin_session_id uuid;
	v_phase text;
	v_request_id uuid;
	v_household_id uuid;
	v_run_id uuid;
	v_scope_user_id uuid;
	v_scope_session_id uuid;
	v_space_access_grant_id uuid;
	v_disclosure_grant_id uuid;
	v_disclosure_grant_version integer;
	v_disclosure_grant_hash text;
	v_proposal_id uuid;
	v_provider_sdk_call_id text;
	v_active_at timestamptz;
	v_require_active boolean;
	v_authenticated_session_id uuid;
	v_session_expires_at timestamptz;
	v_now timestamptz;
	v_expires_at timestamptz;
	v_scope_assertion jsonb;
	v_access emdo.space_access_grants%ROWTYPE;
	v_origin_access emdo.space_access_grants%ROWTYPE;
	v_run emdo.agent_runs%ROWTYPE;
	v_disclosure emdo.disclosure_grants%ROWTYPE;
	v_proposal emdo.action_proposals%ROWTYPE;
	v_state emdo.proposal_states%ROWTYPE;
	v_preparation emdo.proposal_preparations%ROWTYPE;
	v_decision emdo.action_decisions%ROWTYPE;
	v_attempt emdo.provider_attempts%ROWTYPE;
	v_existing emdo.workflow_operation_claims%ROWTYPE;
	v_locked RECORD;
	v_preparation_binding_hash text;
	v_expected_authorization_scope_fingerprint text;
	v_authorization_scope_fingerprint text;
	v_mutation_hash text;
	v_mutation_node_count bigint;
	v_mutation_max_depth integer;
	v_mutation_key_count bigint;
	v_scope_key_count bigint;
	v_has_existing_claim boolean := false;
BEGIN
	-- A failed issuance never leaves stale workflow authority in this transaction.
	PERFORM pg_catalog.set_config('emdo.workflow_operation_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_phase', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_household_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_space_id', '', true);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_original_owner_user_id', '', true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_run_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_proposal_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_decision_id', '', true);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_provider_attempt_id', '', true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_origin_request_id', '', true);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_origin_space_access_grant_id', '', true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_origin_session_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_current_request_id', '', true);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_current_space_access_grant_id', '', true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_current_session_id', '', true);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_authorization_scope_fingerprint', '', true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_binding_hash', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_mutation_hash', '', true);

	IF p_operation_id IS NULL
		OR pg_catalog.length(p_operation_id) NOT BETWEEN 32 AND 512
		OR p_operation_id !~ '^[A-Za-z0-9_-]+$'
		OR pg_catalog.jsonb_typeof(p_scope) <> 'object'
		OR pg_catalog.octet_length(p_scope::text) > 16384
		OR pg_catalog.jsonb_typeof(p_mutation) <> 'object'
		OR pg_catalog.octet_length(p_mutation::text) > 524288
		OR pg_catalog.jsonb_typeof(p_scope -> 'phase') <> 'string'
	THEN
		RETURN false;
	END IF;
	v_phase := p_scope ->> 'phase';
	IF v_phase NOT IN (
		'proposal-create', 'visual-decision',
		'provider-write-prepare', 'provider-write-dispatch'
	) THEN
		RETURN false;
	END IF;

	WITH RECURSIVE mutation_nodes(node, depth) AS (
		SELECT p_mutation, 0
		UNION ALL
		SELECT child.node, parent.depth + 1
		FROM mutation_nodes AS parent
		CROSS JOIN LATERAL (
			SELECT entry.value AS node
			FROM pg_catalog.jsonb_each(
				CASE WHEN pg_catalog.jsonb_typeof(parent.node) = 'object'
					THEN parent.node ELSE '{}'::jsonb END
			) AS entry
			UNION ALL
			SELECT entry.value AS node
			FROM pg_catalog.jsonb_array_elements(
				CASE WHEN pg_catalog.jsonb_typeof(parent.node) = 'array'
					THEN parent.node ELSE '[]'::jsonb END
			) AS entry(value)
		) AS child
		WHERE parent.depth < 13
	)
	SELECT pg_catalog.count(*), pg_catalog.max(depth)
	INTO v_mutation_node_count, v_mutation_max_depth
	FROM mutation_nodes;
	SELECT pg_catalog.count(*) INTO v_mutation_key_count
	FROM pg_catalog.jsonb_object_keys(p_mutation);
	IF v_mutation_node_count > 8192 OR v_mutation_max_depth > 12
		OR pg_catalog.jsonb_typeof(p_mutation -> 'scope') <> 'object'
		OR p_mutation -> 'scope' IS DISTINCT FROM p_scope
		OR (
			v_phase = 'proposal-create'
			AND (
				NOT (p_mutation ?& ARRAY[
					'proposal', 'preparation', 'scope', 'event'
				])
				OR v_mutation_key_count <> 4
				OR pg_catalog.jsonb_typeof(p_mutation -> 'proposal') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'preparation') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'event') <> 'object'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{proposal,id}'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{proposal,runId}'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{proposal,providerSdkCallId}'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{proposal,providerAuthorityBindingHash}'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{preparation,bindingHash}'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{preparation,binding}'
				) <> 'object'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{preparation,binding,disclosurePolicyVersion}'
				) <> 'string'
				OR p_mutation #>> '{proposal,id}'
					IS DISTINCT FROM p_scope ->> 'proposalId'
				OR p_mutation #>> '{proposal,runId}'
					IS DISTINCT FROM p_scope ->> 'runId'
				OR p_mutation #>> '{proposal,providerSdkCallId}'
					IS DISTINCT FROM p_scope ->> 'providerSdkCallId'
				OR p_mutation #>> '{proposal,providerAuthorityBindingHash}'
					IS DISTINCT FROM p_provider_authority_binding_hash
				OR p_mutation #>> '{preparation,bindingHash}'
					IS DISTINCT FROM p_create_preparation_binding_hash
				OR p_mutation #>> '{preparation,binding,proposalId}'
					IS DISTINCT FROM p_scope ->> 'proposalId'
				OR p_mutation #>> '{preparation,binding,originRequestId}'
					IS DISTINCT FROM p_scope ->> 'currentRequestId'
				OR p_mutation #>> '{preparation,binding,originSpaceAccessGrantId}'
					IS DISTINCT FROM p_scope ->> 'currentSpaceAccessGrantId'
				OR p_mutation #>> '{preparation,binding,originSessionId}'
					IS DISTINCT FROM p_scope ->> 'currentSessionId'
				OR p_mutation #>>
					'{preparation,binding,disclosurePolicyVersion}'
					!~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
			)
		)
		OR (
			v_phase = 'visual-decision'
			AND (
				NOT (p_mutation ?& ARRAY[
					'expected', 'next', 'decision', 'scope', 'event',
					'visualDecisionProofHash'
				])
				OR v_mutation_key_count <> 6
				OR pg_catalog.jsonb_typeof(p_mutation -> 'expected') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'next') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'decision') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'event') <> 'object'
				OR pg_catalog.jsonb_typeof(
					p_mutation -> 'visualDecisionProofHash'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{decision,id}'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{decision,authenticatedSessionId}'
				) <> 'string'
				OR p_mutation ->> 'visualDecisionProofHash'
					!~ '^[a-f0-9]{64}$'
				OR p_mutation #>> '{decision,id}'
					IS DISTINCT FROM p_decision_id::text
				OR p_mutation #>> '{decision,authenticatedSessionId}'
					IS DISTINCT FROM p_scope ->> 'currentSessionId'
			)
		)
		OR (
			v_phase = 'provider-write-prepare'
			AND (
				NOT (p_mutation ?& ARRAY[
					'expected', 'next', 'decisionId', 'bindingHash',
					'authorization', 'approvalBinding', 'scope', 'event'
				])
				OR v_mutation_key_count <> 8
				OR pg_catalog.jsonb_typeof(p_mutation -> 'expected') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'next') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'authorization') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'approvalBinding') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'event') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'decisionId') <> 'string'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'bindingHash') <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{authorization,attemptId}'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{authorization,approvalBindingHash}'
				) <> 'string'
				OR pg_catalog.jsonb_typeof(
					p_mutation #> '{authorization,approvalBinding}'
				) <> 'object'
				OR p_mutation ->> 'decisionId' IS DISTINCT FROM p_decision_id::text
				OR p_mutation ->> 'bindingHash' IS DISTINCT FROM p_binding_hash
				OR p_mutation #>> '{authorization,attemptId}'
					IS DISTINCT FROM p_provider_attempt_id::text
				OR p_mutation #>> '{authorization,approvalBindingHash}'
					IS DISTINCT FROM p_binding_hash
				OR p_mutation -> 'authorization' -> 'approvalBinding'
					IS DISTINCT FROM p_mutation -> 'approvalBinding'
			)
		)
		OR (
			v_phase = 'provider-write-dispatch'
			AND (
				NOT (p_mutation ?& ARRAY[
					'expected', 'next', 'decisionId', 'bindingHash', 'attemptId',
					'dispatchedAt', 'scope', 'event'
				])
				OR v_mutation_key_count <> 8
				OR pg_catalog.jsonb_typeof(p_mutation -> 'expected') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'next') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'event') <> 'object'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'decisionId') <> 'string'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'bindingHash') <> 'string'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'attemptId') <> 'string'
				OR pg_catalog.jsonb_typeof(p_mutation -> 'dispatchedAt') <> 'string'
				OR p_mutation ->> 'decisionId' IS DISTINCT FROM p_decision_id::text
				OR p_mutation ->> 'bindingHash' IS DISTINCT FROM p_binding_hash
				OR p_mutation ->> 'attemptId'
					IS DISTINCT FROM p_provider_attempt_id::text
				OR p_mutation ->> 'dispatchedAt' !~
					'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
			)
		)
	THEN
		RETURN false;
	END IF;
	v_mutation_hash := pg_catalog.encode(
		pg_catalog.sha256(
			pg_catalog.convert_to('emdo.workflow-mutation.v1', 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(v_phase, 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_mutation::text, 'UTF8')
		),
		'hex'
	);

	SELECT pg_catalog.count(*) INTO v_scope_key_count
	FROM pg_catalog.jsonb_object_keys(p_scope);
	IF NOT (p_scope ?& ARRAY[
		'phase', 'currentRequestId', 'currentSessionId', 'runId',
		'householdId', 'userId', 'currentSpaceAccessGrantId',
		'authorizationScopeFingerprint', 'disclosureGrantId',
		'disclosureGrantVersion', 'disclosureGrantHash', 'proposalId',
		'providerSdkCallId', 'activeAt', 'requireActiveDisclosureGrant'
	]) OR v_scope_key_count <> 15
		OR pg_catalog.jsonb_typeof(p_scope -> 'currentRequestId') <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'currentSessionId') <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'runId') <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'householdId') <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'userId') <> 'string'
		OR pg_catalog.jsonb_typeof(
			p_scope -> 'currentSpaceAccessGrantId'
		) <> 'string'
		OR pg_catalog.jsonb_typeof(
			p_scope -> 'authorizationScopeFingerprint'
		) <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'disclosureGrantId') <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'disclosureGrantVersion') <> 'number'
		OR pg_catalog.jsonb_typeof(p_scope -> 'disclosureGrantHash') <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'proposalId') <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'providerSdkCallId') <> 'string'
		OR pg_catalog.jsonb_typeof(p_scope -> 'activeAt') <> 'string'
		OR pg_catalog.jsonb_typeof(
			p_scope -> 'requireActiveDisclosureGrant'
		) <> 'boolean'
	THEN
		RETURN false;
	END IF;

	BEGIN
		v_request_id := (p_scope ->> 'currentRequestId')::uuid;
		v_scope_session_id := (p_scope ->> 'currentSessionId')::uuid;
		v_run_id := (p_scope ->> 'runId')::uuid;
		v_household_id := (p_scope ->> 'householdId')::uuid;
		v_scope_user_id := (p_scope ->> 'userId')::uuid;
		v_space_access_grant_id :=
			(p_scope ->> 'currentSpaceAccessGrantId')::uuid;
		v_expected_authorization_scope_fingerprint :=
			p_scope ->> 'authorizationScopeFingerprint';
		v_disclosure_grant_id := (p_scope ->> 'disclosureGrantId')::uuid;
		v_disclosure_grant_version :=
			(p_scope ->> 'disclosureGrantVersion')::integer;
		v_disclosure_grant_hash := p_scope ->> 'disclosureGrantHash';
		v_proposal_id := (p_scope ->> 'proposalId')::uuid;
		v_provider_sdk_call_id := p_scope ->> 'providerSdkCallId';
		v_active_at := (p_scope ->> 'activeAt')::timestamptz;
		v_require_active :=
			(p_scope ->> 'requireActiveDisclosureGrant')::boolean;
		IF v_phase <> 'proposal-create' THEN
			v_authenticated_session_id := v_scope_session_id;
		END IF;
	EXCEPTION
		WHEN invalid_text_representation OR invalid_datetime_format
			OR datetime_field_overflow OR numeric_value_out_of_range
		THEN
			RETURN false;
	END;

	IF p_scope ->> 'currentRequestId' <> v_request_id::text
		OR p_scope ->> 'currentSessionId' <> v_scope_session_id::text
		OR p_scope ->> 'runId' <> v_run_id::text
		OR p_scope ->> 'householdId' <> v_household_id::text
		OR p_scope ->> 'userId' <> v_scope_user_id::text
		OR p_scope ->> 'currentSpaceAccessGrantId'
			<> v_space_access_grant_id::text
		OR p_scope ->> 'disclosureGrantId' <> v_disclosure_grant_id::text
		OR p_scope ->> 'proposalId' <> v_proposal_id::text
		OR v_disclosure_grant_version <= 0
		OR v_disclosure_grant_hash !~ '^[a-f0-9]{64}$'
		OR v_expected_authorization_scope_fingerprint !~ '^[a-f0-9]{64}$'
		OR p_provider_authority_binding_hash !~ '^[a-f0-9]{64}$'
		OR pg_catalog.length(v_provider_sdk_call_id) NOT BETWEEN 1 AND 512
		OR pg_catalog.btrim(v_provider_sdk_call_id) <> v_provider_sdk_call_id
		OR v_provider_sdk_call_id ~ '[[:cntrl:]]'
		OR p_scope ->> 'activeAt' !~
			'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
		OR v_user_id IS NULL OR v_session_id IS NULL
		OR v_current_request_id IS NULL
		OR v_scope_user_id IS DISTINCT FROM v_user_id
		OR v_request_id IS DISTINCT FROM v_current_request_id
		OR v_scope_session_id IS DISTINCT FROM v_session_id
	THEN
		RETURN false;
	END IF;

	IF (v_phase = 'proposal-create' AND (
			p_decision_id IS NOT NULL
			OR p_provider_attempt_id IS NOT NULL
			OR p_binding_hash IS NOT NULL
			OR p_create_preparation_binding_hash !~ '^[a-f0-9]{64}$'
			OR v_require_active IS DISTINCT FROM true
		)) OR (v_phase = 'visual-decision' AND (
			p_decision_id IS NULL
			OR p_provider_attempt_id IS NOT NULL
			OR p_binding_hash IS NOT NULL
			OR p_create_preparation_binding_hash IS NOT NULL
		)) OR (v_phase = 'provider-write-prepare' AND (
			p_decision_id IS NULL
			OR p_provider_attempt_id IS NULL
			OR p_binding_hash !~ '^[a-f0-9]{64}$'
			OR p_create_preparation_binding_hash IS NOT NULL
			OR v_require_active IS DISTINCT FROM true
		)) OR (v_phase = 'provider-write-dispatch' AND (
			p_decision_id IS NULL
			OR p_provider_attempt_id IS NULL
			OR p_binding_hash !~ '^[a-f0-9]{64}$'
			OR p_create_preparation_binding_hash IS NOT NULL
			OR v_require_active IS DISTINCT FROM true
		)) THEN
		RETURN false;
	END IF;
	IF v_phase = 'visual-decision'
		AND v_require_active IS DISTINCT FROM true
		AND p_mutation #>> '{decision,decision}' IS DISTINCT FROM 'rejected'
	THEN
		RETURN false;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(p_operation_id, 0)
	);
	IF NOT emdo.lock_active_request_scope(v_household_id, NULL, NULL) THEN
		RETURN false;
	END IF;

	SELECT access.* INTO v_access
	FROM emdo.space_access_grants AS access
	JOIN emdo.household_memberships AS membership
		ON membership.id = access.membership_id
		AND membership.household_id = access.household_id
		AND membership.user_id = access.original_owner_user_id
	WHERE access.grant_id = v_space_access_grant_id
		AND access.schema_version = 1
		AND access.version = 1
		AND access.household_id = v_household_id
		AND access.original_owner_user_id = v_user_id
		AND access.session_id = v_session_id
		AND access.request_id = v_request_id
		AND membership.status = 'active'
		AND membership.ended_at IS NULL
		AND membership.role = access.role
	FOR UPDATE OF access, membership;
	IF NOT FOUND THEN
		RETURN false;
	END IF;

	SELECT run.* INTO v_run
	FROM emdo.agent_runs AS run
	JOIN emdo.spaces AS space
		ON space.household_id = run.household_id
		AND space.id = run.space_id
		AND space.original_owner_user_id = run.original_owner_user_id
	WHERE run.id = v_run_id
		AND run.household_id = v_household_id
		AND run.original_owner_user_id = v_user_id
		AND run.space_id = ANY(v_access.writable_space_ids)
		AND run.status IN ('queued', 'running')
		AND space.tombstoned_at IS NULL
	FOR UPDATE OF run, space;
	IF NOT FOUND
		OR NOT emdo.lock_active_request_scope(
			v_household_id, v_run.space_id, NULL
		)
	THEN
		RETURN false;
	END IF;

	SELECT disclosure.* INTO v_disclosure
	FROM emdo.disclosure_grants AS disclosure
	WHERE disclosure.id = v_disclosure_grant_id
		AND disclosure.schema_version = 1
		AND disclosure.version = v_disclosure_grant_version
		AND disclosure.grant_hash = v_disclosure_grant_hash
		AND disclosure.household_id = v_household_id
		AND disclosure.space_id = v_run.space_id
		AND disclosure.user_id = v_user_id
		AND disclosure.run_id = v_run_id
		AND disclosure.one_run_only = true
		AND (
			NOT v_require_active
			OR disclosure.revoked_at IS NULL
		)
	FOR UPDATE OF disclosure;
	IF NOT FOUND THEN
		RETURN false;
	END IF;

	-- Presence is used only to bypass new-operation absence/pre-state checks.
	-- Exact binding, current authority, and expiry are still proved below
	-- before an existing claim is accepted for aggregate replay validation.
	SELECT claim.* INTO v_existing
	FROM emdo.workflow_operation_claims AS claim
	WHERE claim.operation_id = p_operation_id
	FOR UPDATE OF claim;
	v_has_existing_claim := FOUND;

	IF v_phase = 'proposal-create' THEN
		PERFORM 1 FROM emdo.action_proposals AS proposal
		WHERE proposal.id = v_proposal_id
		FOR UPDATE OF proposal;
		IF FOUND AND NOT v_has_existing_claim THEN
			RETURN false;
		END IF;
		v_preparation_binding_hash := p_create_preparation_binding_hash;
		v_origin_request_id := v_request_id;
		v_origin_space_access_grant_id := v_space_access_grant_id;
		v_origin_session_id := v_session_id;
	ELSE
		SELECT ROW(proposal.*)::emdo.action_proposals AS proposal_row,
			ROW(state.*)::emdo.proposal_states AS state_row,
			ROW(preparation.*)::emdo.proposal_preparations AS preparation_row
		INTO v_locked
		FROM emdo.action_proposals AS proposal
		JOIN emdo.proposal_states AS state
			ON state.proposal_id = proposal.id
			AND state.household_id = proposal.household_id
			AND state.space_id = proposal.space_id
			AND state.original_owner_user_id = proposal.original_owner_user_id
		JOIN emdo.proposal_preparations AS preparation
			ON preparation.proposal_id = proposal.id
			AND preparation.household_id = proposal.household_id
			AND preparation.space_id = proposal.space_id
			AND preparation.original_owner_user_id =
				proposal.original_owner_user_id
		WHERE proposal.id = v_proposal_id
			AND proposal.household_id = v_household_id
			AND proposal.space_id = v_run.space_id
			AND proposal.original_owner_user_id = v_user_id
			AND proposal.run_id = v_run_id
			AND proposal.disclosure_grant_id = v_disclosure_grant_id
			AND proposal.provider_sdk_call_id = v_provider_sdk_call_id
			AND proposal.provider_authority_binding_hash =
				p_provider_authority_binding_hash
			AND proposal.authorization_scope_fingerprint ~ '^[a-f0-9]{64}$'
			AND preparation.abandonment_reason IS NULL
			AND preparation.abandoned_at IS NULL
		FOR UPDATE OF proposal, state, preparation;
		IF NOT FOUND THEN
			RETURN false;
		END IF;
		v_proposal := v_locked.proposal_row;
		v_state := v_locked.state_row;
		v_preparation := v_locked.preparation_row;
		IF v_preparation.preparation_binding ->> 'proposalId'
				IS DISTINCT FROM v_proposal_id::text
			OR v_preparation.preparation_binding ->> 'runId'
				IS DISTINCT FROM v_run_id::text
			OR v_preparation.preparation_binding ->> 'householdId'
				IS DISTINCT FROM v_household_id::text
			OR v_preparation.preparation_binding ->> 'userId'
				IS DISTINCT FROM v_user_id::text
			OR v_preparation.preparation_binding ->> 'disclosureGrantId'
				IS DISTINCT FROM v_disclosure_grant_id::text
			OR v_preparation.preparation_binding ->> 'sdkCallId'
				IS DISTINCT FROM v_provider_sdk_call_id
			OR v_preparation.preparation_binding ->> 'providerAuthorityBindingHash'
				IS DISTINCT FROM p_provider_authority_binding_hash
		THEN
			RETURN false;
		END IF;
		BEGIN
			v_origin_request_id :=
				(v_preparation.preparation_binding ->> 'originRequestId')::uuid;
			v_origin_space_access_grant_id :=
				(v_preparation.preparation_binding
					->> 'originSpaceAccessGrantId')::uuid;
			v_origin_session_id :=
				(v_preparation.preparation_binding ->> 'originSessionId')::uuid;
		EXCEPTION WHEN invalid_text_representation THEN
			RETURN false;
		END;
		v_preparation_binding_hash := v_preparation.preparation_binding_hash;
	END IF;

	-- The immutable preparation records origin lineage. Only the fresh current
	-- request grant is authority-bearing for this phase.
	SELECT origin.* INTO v_origin_access
	FROM emdo.space_access_grants AS origin
	WHERE origin.grant_id = v_origin_space_access_grant_id
		AND origin.schema_version = 1
		AND origin.version = 1
		AND origin.household_id = v_household_id
		AND origin.original_owner_user_id = v_user_id
		AND origin.request_id = v_origin_request_id
		AND origin.private_space_id = v_access.private_space_id
		AND v_run.space_id = ANY(origin.writable_space_ids)
	FOR SHARE OF origin;
	IF NOT FOUND THEN
		RETURN false;
	END IF;
	IF v_origin_access.session_id IS DISTINCT FROM v_origin_session_id THEN
		RETURN false;
	END IF;

	SELECT authority.authorization_scope_fingerprint
	INTO v_authorization_scope_fingerprint
	FROM emdo.lock_current_authorization_scope(
		v_space_access_grant_id,
		CASE WHEN v_phase = 'proposal-create' THEN NULL ELSE v_proposal_id END,
		CASE WHEN v_phase = 'proposal-create' THEN v_run_id ELSE NULL END
	) AS authority;
	IF NOT FOUND
		OR v_authorization_scope_fingerprint !~ '^[a-f0-9]{64}$'
		OR v_authorization_scope_fingerprint IS DISTINCT FROM
			v_expected_authorization_scope_fingerprint
		OR (
			v_phase <> 'proposal-create'
			AND v_proposal.authorization_scope_fingerprint
				IS DISTINCT FROM v_authorization_scope_fingerprint
		)
	THEN
		RETURN false;
	END IF;

	-- The OAuth verifier locks the current provider reference and epoch. Its v2
	-- binding contains the DB-derived stable scope fingerprint, never a grant ID.
	IF NOT emdo.lock_current_google_calendar_authority(
		v_household_id,
		v_access.private_space_id,
		v_user_id,
		v_authorization_scope_fingerprint,
		p_provider_authority_binding_hash
	) THEN
		RETURN false;
	END IF;

	IF v_phase = 'visual-decision' THEN
		IF NOT v_has_existing_claim THEN
			IF v_state.state <> 'pending' THEN
				RETURN false;
			END IF;
			PERFORM 1 FROM emdo.action_decisions AS decision
			WHERE decision.id = p_decision_id
			FOR UPDATE OF decision;
			IF FOUND THEN
				RETURN false;
			END IF;
		END IF;
	ELSIF v_phase IN ('provider-write-prepare', 'provider-write-dispatch') THEN
		SELECT decision.* INTO v_decision
		FROM emdo.action_decisions AS decision
		WHERE decision.id = p_decision_id
			AND decision.proposal_id = v_proposal_id
			AND decision.household_id = v_household_id
			AND decision.space_id = v_run.space_id
			AND decision.original_owner_user_id = v_user_id
			AND decision.decision = 'approved'
			AND decision.channel = 'authenticated-visual'
			AND decision.authenticated_session_id = v_session_id
		FOR UPDATE OF decision;
		IF NOT FOUND THEN
			RETURN false;
		END IF;
		IF v_phase = 'provider-write-prepare' THEN
			IF NOT v_has_existing_claim THEN
				IF v_state.state <> 'approved' THEN
					RETURN false;
				END IF;
				PERFORM 1 FROM emdo.provider_attempts AS attempt
				WHERE attempt.id = p_provider_attempt_id
				FOR UPDATE OF attempt;
				IF FOUND THEN
					RETURN false;
				END IF;
			END IF;
		ELSE
			IF NOT v_has_existing_claim AND v_state.state <> 'prepared' THEN
				RETURN false;
			END IF;
			SELECT attempt.* INTO v_attempt
			FROM emdo.provider_attempts AS attempt
			WHERE attempt.id = p_provider_attempt_id
				AND attempt.proposal_id = v_proposal_id
				AND attempt.decision_id = p_decision_id
				AND attempt.household_id = v_household_id
				AND attempt.space_id = v_run.space_id
				AND attempt.original_owner_user_id = v_user_id
				AND (
					v_has_existing_claim
					OR attempt.attempt_state = 'prepared'
				)
				AND attempt.binding_hash = p_binding_hash
				AND attempt.disclosure_grant_id = v_disclosure_grant_id
				AND attempt.disclosure_grant_hash = v_disclosure_grant_hash
				AND attempt.provider_authority_binding_hash =
					p_provider_authority_binding_hash
				AND attempt.provider_sdk_call_id = v_provider_sdk_call_id
			FOR UPDATE OF attempt;
			IF NOT FOUND THEN
				RETURN false;
			END IF;
		END IF;
	END IF;

	SELECT session.expires_at INTO v_session_expires_at
	FROM emdo.auth_sessions AS session
	JOIN emdo.auth_users AS account_user ON account_user.id = session.user_id
	WHERE session.id = v_session_id
		AND session.user_id = v_user_id
		AND session.active_household_id = v_household_id
		AND account_user.email_verified = true
	FOR UPDATE OF session, account_user;
	-- Sample database time only after all authority-bearing rows are locked.
	v_now := pg_catalog.clock_timestamp();
	IF NOT FOUND
		OR v_session_expires_at <= v_now
		OR v_access.expires_at <= v_now
		OR v_active_at < v_now - interval '60 seconds'
		OR v_active_at > v_now + interval '5 seconds'
		OR (
			v_require_active
			AND (
				v_disclosure.revoked_at IS NOT NULL
				OR v_disclosure.created_at > v_active_at
				OR v_disclosure.expires_at <= v_active_at
				OR v_disclosure.expires_at <= v_now
			)
		)
		OR (
			v_phase <> 'proposal-create'
			AND v_proposal.expires_at <= v_now
		)
		OR (
			v_phase = 'provider-write-dispatch'
			AND v_attempt.expires_at <= v_now
		)
	THEN
		RETURN false;
	END IF;

	v_expires_at := LEAST(
		v_now + interval '60 seconds',
		v_session_expires_at,
		v_access.expires_at
	);
	IF v_require_active THEN
		v_expires_at := LEAST(
			v_expires_at, v_disclosure.expires_at
		);
	END IF;
	IF v_phase <> 'proposal-create' THEN
		v_expires_at := LEAST(v_expires_at, v_proposal.expires_at);
	END IF;
	IF v_phase = 'provider-write-dispatch' THEN
		v_expires_at := LEAST(v_expires_at, v_attempt.expires_at);
	END IF;
	IF v_expires_at <= v_now THEN
		RETURN false;
	END IF;

	v_scope_assertion := pg_catalog.jsonb_build_object(
		'phase', v_phase,
		'currentRequestId', v_request_id,
		'currentSessionId', v_session_id,
		'runId', v_run_id,
		'householdId', v_household_id,
		'userId', v_user_id,
		'currentSpaceAccessGrantId', v_space_access_grant_id,
		'authorizationScopeFingerprint', v_authorization_scope_fingerprint,
		'disclosureGrantId', v_disclosure_grant_id,
		'disclosureGrantVersion', v_disclosure_grant_version,
		'disclosureGrantHash', v_disclosure_grant_hash,
		'proposalId', v_proposal_id,
		'providerSdkCallId', v_provider_sdk_call_id,
		'activeAt', p_scope ->> 'activeAt',
		'requireActiveDisclosureGrant', v_require_active
	);
	SELECT claim.* INTO v_existing
	FROM emdo.workflow_operation_claims AS claim
	WHERE claim.operation_id = p_operation_id
	FOR UPDATE OF claim;
	IF FOUND THEN
		-- An already-claimed, byte-exact operation may reach the aggregate's
		-- duplicate validator. All current authority rows were re-locked above;
		-- stale, expired, or mismatched replays still fail closed here.
		RETURN v_existing.expires_at > v_now
			AND v_existing.phase = v_phase
			AND v_existing.scope_assertion = v_scope_assertion
			AND v_existing.origin_request_id = v_origin_request_id
			AND v_existing.origin_space_access_grant_id =
				v_origin_space_access_grant_id
			AND v_existing.origin_session_id = v_origin_session_id
			AND v_existing.current_request_id = v_request_id
			AND v_existing.current_space_access_grant_id =
				v_space_access_grant_id
			AND v_existing.current_session_id = v_session_id
			AND v_existing.authorization_scope_fingerprint =
				v_authorization_scope_fingerprint
			AND v_existing.disclosure_grant_id = v_disclosure_grant_id
			AND v_existing.disclosure_grant_version =
				v_disclosure_grant_version
			AND v_existing.disclosure_grant_hash = v_disclosure_grant_hash
			AND v_existing.provider_sdk_call_id = v_provider_sdk_call_id
			AND v_existing.active_at = v_active_at
			AND v_existing.require_active_disclosure_grant = v_require_active
			AND v_existing.authenticated_session_id IS NOT DISTINCT FROM
				v_authenticated_session_id
			AND v_existing.household_id = v_household_id
			AND v_existing.space_id = v_run.space_id
			AND v_existing.original_owner_user_id = v_user_id
			AND v_existing.user_id = v_user_id
			AND v_existing.run_id = v_run_id
			AND v_existing.proposal_id = v_proposal_id
			AND v_existing.decision_id IS NOT DISTINCT FROM p_decision_id
			AND v_existing.provider_attempt_id IS NOT DISTINCT FROM
				p_provider_attempt_id
			AND v_existing.provider_authority_binding_hash =
				p_provider_authority_binding_hash
			AND v_existing.preparation_binding_hash =
				v_preparation_binding_hash
			AND v_existing.binding_hash IS NOT DISTINCT FROM p_binding_hash
			AND v_existing.mutation_hash = v_mutation_hash;
	END IF;

	INSERT INTO emdo.workflow_operation_claims(
		operation_id, phase, scope_assertion,
		origin_request_id, origin_space_access_grant_id, origin_session_id,
		current_request_id, current_space_access_grant_id, current_session_id,
		authorization_scope_fingerprint,
		disclosure_grant_id, disclosure_grant_version,
		disclosure_grant_hash, provider_sdk_call_id, active_at,
		require_active_disclosure_grant, authenticated_session_id,
		household_id, space_id, original_owner_user_id, user_id,
		run_id, proposal_id, decision_id, provider_attempt_id,
		provider_authority_binding_hash, preparation_binding_hash,
		binding_hash, mutation_hash, issued_at, expires_at, claimed_at
	) VALUES (
		p_operation_id, v_phase, v_scope_assertion,
		v_origin_request_id, v_origin_space_access_grant_id, v_origin_session_id,
		v_request_id, v_space_access_grant_id, v_session_id,
		v_authorization_scope_fingerprint,
		v_disclosure_grant_id, v_disclosure_grant_version,
		v_disclosure_grant_hash, v_provider_sdk_call_id, v_active_at,
		v_require_active, v_authenticated_session_id,
		v_household_id, v_run.space_id, v_user_id, v_user_id,
		v_run_id, v_proposal_id, p_decision_id,
		p_provider_attempt_id, p_provider_authority_binding_hash,
		v_preparation_binding_hash, p_binding_hash, v_mutation_hash,
		v_now, v_expires_at, NULL
	);
	RETURN true;
END
$function$;
--> statement-breakpoint
ALTER FUNCTION "emdo"."issue_workflow_operation_claim"(text, jsonb, uuid, uuid, text, text, text, jsonb) OWNER TO emdo_workflow_executor;
REVOKE ALL ON FUNCTION "emdo"."issue_workflow_operation_claim"(text, jsonb, uuid, uuid, text, text, text, jsonb) FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_workflow_executor, emdo_workflow_login;
GRANT EXECUTE ON FUNCTION "emdo"."issue_workflow_operation_claim"(text, jsonb, uuid, uuid, text, text, text, jsonb) TO emdo_workflow_executor;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."claim_workflow_operation_scope"(
	p_operation_id text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_claim emdo.workflow_operation_claims%ROWTYPE;
	v_account_user emdo.auth_users%ROWTYPE;
	v_session emdo.auth_sessions%ROWTYPE;
	v_membership emdo.household_memberships%ROWTYPE;
	v_space emdo.spaces%ROWTYPE;
	v_run emdo.agent_runs%ROWTYPE;
	v_access emdo.space_access_grants%ROWTYPE;
	v_origin_access emdo.space_access_grants%ROWTYPE;
	v_disclosure emdo.disclosure_grants%ROWTYPE;
	v_proposal emdo.action_proposals%ROWTYPE;
	v_state emdo.proposal_states%ROWTYPE;
	v_preparation emdo.proposal_preparations%ROWTYPE;
	v_decision emdo.action_decisions%ROWTYPE;
	v_attempt emdo.provider_attempts%ROWTYPE;
	v_locked_base RECORD;
	v_locked_proposal RECORD;
	v_now timestamptz;
	v_provider_authority_valid boolean;
	v_authorization_scope_valid boolean;
	v_authorization_scope_fingerprint text;
BEGIN
	-- Clear caller-controlled or stale transaction scope before every attempt.
	PERFORM pg_catalog.set_config('emdo.user_id', '', true);
	PERFORM pg_catalog.set_config('emdo.session_id', '', true);
	PERFORM pg_catalog.set_config('emdo.request_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_operation_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_phase', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_household_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_space_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_original_owner_user_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_run_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_proposal_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_decision_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_provider_attempt_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_origin_request_id', '', true);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_origin_space_access_grant_id', '', true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_origin_session_id', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_current_request_id', '', true);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_current_space_access_grant_id', '', true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_current_session_id', '', true);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_authorization_scope_fingerprint', '', true
	);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_disclosure_grant_id', '', true
	);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_disclosure_grant_version', '', true
	);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_disclosure_grant_hash', '', true
	);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_provider_sdk_call_id', '', true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_active_at', '', true);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_require_active_disclosure_grant', '', true
	);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_authenticated_session_id', '', true
	);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_provider_authority_binding_hash', '', true
	);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_preparation_binding_hash', '', true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_binding_hash', '', true);
	PERFORM pg_catalog.set_config('emdo.workflow_mutation_hash', '', true);

	IF p_operation_id IS NULL
		OR pg_catalog.length(p_operation_id) NOT BETWEEN 32 AND 512
		OR p_operation_id !~ '^[A-Za-z0-9_-]+$'
	THEN
		RETURN false;
	END IF;

	SELECT claim AS claim_row,
		account_user AS account_user_row,
		session AS session_row,
		membership AS membership_row,
		space AS space_row,
		run AS run_row,
		access AS access_row,
		disclosure AS disclosure_row
	INTO v_locked_base
	FROM emdo.workflow_operation_claims AS claim
	JOIN emdo.auth_users AS account_user
		ON account_user.id = claim.user_id
	JOIN emdo.auth_sessions AS session
		ON session.id = claim.current_session_id
		AND session.user_id = claim.user_id
		AND session.active_household_id = claim.household_id
	JOIN emdo.household_memberships AS membership
		ON membership.household_id = claim.household_id
		AND membership.user_id = claim.user_id
	JOIN emdo.spaces AS space
		ON space.id = claim.space_id
		AND space.household_id = claim.household_id
		AND space.original_owner_user_id = claim.original_owner_user_id
	JOIN emdo.agent_runs AS run
		ON run.id = claim.run_id
		AND run.household_id = claim.household_id
		AND run.space_id = claim.space_id
		AND run.original_owner_user_id = claim.original_owner_user_id
	JOIN emdo.space_access_grants AS access
		ON access.grant_id = claim.current_space_access_grant_id
		AND access.schema_version = 1
		AND access.version = 1
		AND access.household_id = claim.household_id
		AND access.original_owner_user_id = claim.user_id
		AND access.session_id = claim.current_session_id
		AND access.request_id = claim.current_request_id
		AND access.membership_id = membership.id
		AND access.role = membership.role
		AND claim.space_id = ANY(access.writable_space_ids)
	JOIN emdo.disclosure_grants AS disclosure
		ON disclosure.id = claim.disclosure_grant_id
		AND disclosure.schema_version = 1
		AND disclosure.version = claim.disclosure_grant_version
		AND disclosure.grant_hash = claim.disclosure_grant_hash
		AND disclosure.household_id = claim.household_id
		AND disclosure.space_id = claim.space_id
		AND disclosure.user_id = claim.user_id
		AND disclosure.run_id = claim.run_id
		AND disclosure.one_run_only = true
		AND (
			NOT claim.require_active_disclosure_grant
			OR disclosure.revoked_at IS NULL
		)
	WHERE claim.operation_id = p_operation_id
		AND account_user.email_verified = true
		AND membership.status = 'active'
	FOR UPDATE OF claim, account_user, session, membership, space, run,
		access, disclosure;
	IF NOT FOUND THEN
		RETURN false;
	END IF;
	v_claim := v_locked_base.claim_row;
	v_account_user := v_locked_base.account_user_row;
	v_session := v_locked_base.session_row;
	v_membership := v_locked_base.membership_row;
	v_space := v_locked_base.space_row;
	v_run := v_locked_base.run_row;
	v_access := v_locked_base.access_row;
	v_disclosure := v_locked_base.disclosure_row;

	-- Proposal creation carries an exact future UUID; later phases lock the
	-- current proposal, state, and immutable preparation binding.
	IF v_claim.phase = 'proposal-create' THEN
		PERFORM 1 FROM emdo.action_proposals AS proposal
		WHERE proposal.id = v_claim.proposal_id
		FOR UPDATE OF proposal;
		IF FOUND THEN
			RETURN false;
		END IF;
	ELSE
		SELECT ROW(proposal.*)::emdo.action_proposals AS proposal_row,
			ROW(state.*)::emdo.proposal_states AS state_row,
			ROW(preparation.*)::emdo.proposal_preparations AS preparation_row
		INTO v_locked_proposal
		FROM emdo.action_proposals AS proposal
		JOIN emdo.workflow_operation_claims AS claim
			ON claim.operation_id = v_claim.operation_id
		JOIN emdo.proposal_states AS state
			ON state.proposal_id = proposal.id
			AND state.household_id = proposal.household_id
			AND state.space_id = proposal.space_id
			AND state.original_owner_user_id = proposal.original_owner_user_id
		JOIN emdo.proposal_preparations AS preparation
			ON preparation.proposal_id = proposal.id
			AND preparation.household_id = proposal.household_id
			AND preparation.space_id = proposal.space_id
			AND preparation.original_owner_user_id =
				proposal.original_owner_user_id
		WHERE proposal.id = v_claim.proposal_id
			AND proposal.household_id = v_claim.household_id
			AND proposal.space_id = v_claim.space_id
			AND proposal.original_owner_user_id =
				v_claim.original_owner_user_id
			AND proposal.run_id = claim.run_id
			AND proposal.disclosure_grant_id = v_claim.disclosure_grant_id
			AND proposal.provider_sdk_call_id = v_claim.provider_sdk_call_id
			AND proposal.provider_authority_binding_hash =
				v_claim.provider_authority_binding_hash
			AND proposal.authorization_scope_fingerprint =
				v_claim.authorization_scope_fingerprint
			AND preparation.preparation_binding_hash =
				v_claim.preparation_binding_hash
			AND preparation.abandonment_reason IS NULL
			AND preparation.abandoned_at IS NULL
		FOR UPDATE OF proposal, state, preparation;
		IF NOT FOUND THEN
			RETURN false;
		END IF;
		v_proposal := v_locked_proposal.proposal_row;
		v_state := v_locked_proposal.state_row;
		v_preparation := v_locked_proposal.preparation_row;
		IF v_preparation.preparation_binding ->> 'proposalId'
				IS DISTINCT FROM v_claim.proposal_id::text
			OR v_preparation.preparation_binding ->> 'originRequestId'
				IS DISTINCT FROM v_claim.origin_request_id::text
			OR v_preparation.preparation_binding ->> 'runId'
				IS DISTINCT FROM v_claim.run_id::text
			OR v_preparation.preparation_binding ->> 'householdId'
				IS DISTINCT FROM v_claim.household_id::text
			OR v_preparation.preparation_binding ->> 'userId'
				IS DISTINCT FROM v_claim.user_id::text
			OR v_preparation.preparation_binding ->> 'originSpaceAccessGrantId'
				IS DISTINCT FROM v_claim.origin_space_access_grant_id::text
			OR v_preparation.preparation_binding ->> 'originSessionId'
				IS DISTINCT FROM v_claim.origin_session_id::text
			OR v_preparation.preparation_binding ->> 'disclosureGrantId'
				IS DISTINCT FROM v_claim.disclosure_grant_id::text
			OR v_preparation.preparation_binding ->> 'sdkCallId'
				IS DISTINCT FROM v_claim.provider_sdk_call_id
			OR v_preparation.preparation_binding ->> 'providerAuthorityBindingHash'
				IS DISTINCT FROM v_claim.provider_authority_binding_hash
		THEN
			RETURN false;
		END IF;
	END IF;

	IF v_claim.phase = 'proposal-create' AND (
		v_claim.origin_request_id <> v_claim.current_request_id
		OR v_claim.origin_space_access_grant_id <>
			v_claim.current_space_access_grant_id
		OR v_claim.origin_session_id <> v_claim.current_session_id
	) THEN
		RETURN false;
	END IF;
	SELECT origin.* INTO v_origin_access
	FROM emdo.space_access_grants AS origin
	WHERE origin.grant_id = v_claim.origin_space_access_grant_id
		AND origin.schema_version = 1
		AND origin.version = 1
		AND origin.household_id = v_claim.household_id
		AND origin.original_owner_user_id = v_claim.user_id
		AND origin.session_id = v_claim.origin_session_id
		AND origin.request_id = v_claim.origin_request_id
		AND origin.private_space_id = v_access.private_space_id
		AND v_claim.space_id = ANY(origin.writable_space_ids)
	FOR SHARE OF origin;
	IF NOT FOUND THEN
		RETURN false;
	END IF;

	-- Install only the locked current principal while both the stable scope and
	-- provider v2 binding are reconstructed, then clear it on every path.
	BEGIN
		PERFORM pg_catalog.set_config(
			'emdo.user_id', v_claim.user_id::text, true
		);
		PERFORM pg_catalog.set_config(
			'emdo.session_id', v_claim.current_session_id::text, true
		);
		PERFORM pg_catalog.set_config(
			'emdo.request_id', v_claim.current_request_id::text, true
		);
		SELECT authority.authorization_scope_fingerprint
		INTO v_authorization_scope_fingerprint
		FROM emdo.lock_current_authorization_scope(
			v_claim.current_space_access_grant_id,
			CASE WHEN v_claim.phase = 'proposal-create'
				THEN NULL ELSE v_claim.proposal_id END,
			CASE WHEN v_claim.phase = 'proposal-create'
				THEN v_claim.run_id ELSE NULL END
		) AS authority;
		v_authorization_scope_valid := FOUND
			AND v_authorization_scope_fingerprint IS NOT DISTINCT FROM
				v_claim.authorization_scope_fingerprint
			AND (
				v_claim.phase = 'proposal-create'
				OR v_authorization_scope_fingerprint IS NOT DISTINCT FROM
					v_proposal.authorization_scope_fingerprint
			);
		IF v_authorization_scope_valid THEN
			v_provider_authority_valid :=
				emdo.lock_current_google_calendar_authority(
					v_claim.household_id,
					v_access.private_space_id,
					v_claim.user_id,
					v_authorization_scope_fingerprint,
					v_claim.provider_authority_binding_hash
				);
		END IF;
	EXCEPTION WHEN OTHERS THEN
		PERFORM pg_catalog.set_config('emdo.user_id', '', true);
		PERFORM pg_catalog.set_config('emdo.session_id', '', true);
		PERFORM pg_catalog.set_config('emdo.request_id', '', true);
		RETURN false;
	END;
	PERFORM pg_catalog.set_config('emdo.user_id', '', true);
	PERFORM pg_catalog.set_config('emdo.session_id', '', true);
	PERFORM pg_catalog.set_config('emdo.request_id', '', true);
	IF v_authorization_scope_valid IS DISTINCT FROM true
		OR v_provider_authority_valid IS DISTINCT FROM true
	THEN
		RETURN false;
	END IF;

	IF v_claim.phase = 'visual-decision' THEN
		IF v_state.state <> 'pending' THEN
			RETURN false;
		END IF;
		PERFORM 1 FROM emdo.action_decisions AS decision
		WHERE decision.id = v_claim.decision_id
		FOR UPDATE OF decision;
		IF FOUND THEN
			RETURN false;
		END IF;
	ELSIF v_claim.phase IN (
		'provider-write-prepare', 'provider-write-dispatch'
	) THEN
		SELECT decision.* INTO v_decision
		FROM emdo.action_decisions AS decision
		JOIN emdo.workflow_operation_claims AS claim
			ON claim.operation_id = v_claim.operation_id
		WHERE decision.id = claim.decision_id
			AND decision.proposal_id = claim.proposal_id
			AND decision.household_id = v_claim.household_id
			AND decision.space_id = v_claim.space_id
			AND decision.original_owner_user_id =
				v_claim.original_owner_user_id
			AND decision.decision = 'approved'
			AND decision.channel = 'authenticated-visual'
			AND decision.authenticated_session_id = claim.current_session_id
		FOR UPDATE OF decision;
		IF NOT FOUND THEN
			RETURN false;
		END IF;
		IF v_claim.phase = 'provider-write-prepare' THEN
			IF v_state.state <> 'approved' THEN
				RETURN false;
			END IF;
			PERFORM 1 FROM emdo.provider_attempts AS attempt
			WHERE attempt.id = v_claim.provider_attempt_id
			FOR UPDATE OF attempt;
			IF FOUND THEN
				RETURN false;
			END IF;
		ELSE
			IF v_state.state <> 'prepared' THEN
				RETURN false;
			END IF;
			SELECT attempt.* INTO v_attempt
			FROM emdo.provider_attempts AS attempt
			JOIN emdo.workflow_operation_claims AS claim
				ON claim.operation_id = v_claim.operation_id
			WHERE attempt.id = claim.provider_attempt_id
				AND attempt.proposal_id = claim.proposal_id
				AND attempt.decision_id = claim.decision_id
				AND attempt.household_id = v_claim.household_id
				AND attempt.space_id = v_claim.space_id
				AND attempt.original_owner_user_id =
					v_claim.original_owner_user_id
				AND attempt.binding_hash = claim.binding_hash
				AND attempt.attempt_state = 'prepared'
				AND attempt.disclosure_grant_id =
					v_claim.disclosure_grant_id
				AND attempt.disclosure_grant_hash =
					v_claim.disclosure_grant_hash
				AND attempt.provider_authority_binding_hash =
					v_claim.provider_authority_binding_hash
				AND attempt.provider_sdk_call_id =
					v_claim.provider_sdk_call_id
			FOR UPDATE OF attempt;
			IF NOT FOUND THEN
				RETURN false;
			END IF;
		END IF;
	END IF;

	v_now := pg_catalog.clock_timestamp();
	IF v_claim.user_id <> v_claim.original_owner_user_id
		OR v_claim.claimed_at IS NOT NULL
		OR v_claim.issued_at > v_now
		OR v_claim.expires_at <= v_now
		OR v_account_user.email_verified IS DISTINCT FROM true
		OR v_session.expires_at <= v_now
		OR v_session.active_household_id <> v_claim.household_id
		OR v_membership.status <> 'active'
		OR v_membership.ended_at IS NOT NULL
		OR v_space.tombstoned_at IS NOT NULL
		OR v_access.expires_at <= v_now
		OR (
			v_claim.require_active_disclosure_grant
			AND (
				v_disclosure.revoked_at IS NOT NULL
				OR v_disclosure.created_at > v_claim.active_at
				OR v_disclosure.expires_at <= v_claim.active_at
				OR v_disclosure.expires_at <= v_now
			)
		)
		OR (
			v_claim.phase <> 'proposal-create'
			AND v_proposal.expires_at <= v_now
		)
		OR (
			v_claim.phase = 'provider-write-dispatch'
			AND v_attempt.expires_at <= v_now
		)
	THEN
		RETURN false;
	END IF;

	UPDATE emdo.workflow_operation_claims
	SET claimed_at = pg_catalog.clock_timestamp()
	WHERE operation_id = v_claim.operation_id
		AND claimed_at IS NULL
		AND expires_at > pg_catalog.clock_timestamp();
	IF NOT FOUND THEN
		RETURN false;
	END IF;

	PERFORM pg_catalog.set_config('emdo.user_id', v_claim.user_id::text, true);
	PERFORM pg_catalog.set_config(
		'emdo.session_id', v_claim.current_session_id::text, true
	);
	PERFORM pg_catalog.set_config(
		'emdo.request_id', v_claim.current_request_id::text, true
	);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_operation_id', v_claim.operation_id, true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_phase', v_claim.phase, true);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_household_id', v_claim.household_id::text, true
	);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_space_id', v_claim.space_id::text, true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_original_owner_user_id',
		v_claim.original_owner_user_id::text,
		true
	);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_run_id', v_claim.run_id::text, true
	);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_proposal_id', v_claim.proposal_id::text, true
	);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_decision_id',
		COALESCE(v_claim.decision_id::text, ''),
		true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_provider_attempt_id',
		COALESCE(v_claim.provider_attempt_id::text, ''),
		true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_origin_request_id',
		v_claim.origin_request_id::text,
		true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_origin_space_access_grant_id',
		v_claim.origin_space_access_grant_id::text,
		true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_origin_session_id',
		v_claim.origin_session_id::text,
		true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_current_request_id',
		v_claim.current_request_id::text,
		true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_current_space_access_grant_id',
		v_claim.current_space_access_grant_id::text,
		true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_current_session_id',
		v_claim.current_session_id::text,
		true
	);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_authorization_scope_fingerprint',
		v_claim.authorization_scope_fingerprint,
		true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_disclosure_grant_id',
		v_claim.disclosure_grant_id::text,
		true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_disclosure_grant_version',
		v_claim.disclosure_grant_version::text,
		true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_disclosure_grant_hash',
		v_claim.disclosure_grant_hash,
		true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_provider_sdk_call_id',
		v_claim.provider_sdk_call_id,
		true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_active_at',
		v_claim.active_at::text,
		true
	);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_require_active_disclosure_grant',
		v_claim.require_active_disclosure_grant::text,
		true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_authenticated_session_id',
		COALESCE(v_claim.authenticated_session_id::text, ''),
		true
	);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_provider_authority_binding_hash',
		v_claim.provider_authority_binding_hash,
		true
	);
	PERFORM pg_catalog.set_config('emdo.workflow_preparation_binding_hash',
		v_claim.preparation_binding_hash,
		true
	);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_binding_hash', COALESCE(v_claim.binding_hash, ''), true
	);
	PERFORM pg_catalog.set_config(
		'emdo.workflow_mutation_hash', v_claim.mutation_hash, true
	);
	RETURN true;
END
$function$;
--> statement-breakpoint
ALTER FUNCTION "emdo"."claim_workflow_operation_scope"(text)
	OWNER TO emdo_workflow_executor;
REVOKE ALL ON FUNCTION "emdo"."enforce_workflow_operation_claim_transition"()
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_workflow_login;
REVOKE ALL ON FUNCTION "emdo"."claim_workflow_operation_scope"(text)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_workflow_executor, emdo_workflow_login;
GRANT EXECUTE ON FUNCTION "emdo"."claim_workflow_operation_scope"(text)
	TO emdo_workflow_executor;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "emdo" FROM emdo_workflow;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "emdo" FROM emdo_workflow;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA "emdo" FROM emdo_workflow;
REVOKE ALL ON SCHEMA "emdo" FROM emdo_workflow;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "emdo" FROM emdo_workflow_login;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "emdo" FROM emdo_workflow_login;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA "emdo" FROM emdo_workflow_login;
REVOKE ALL ON SCHEMA "emdo" FROM emdo_workflow_login;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "emdo" FROM emdo_visual_decision_login;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "emdo" FROM emdo_visual_decision_login;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA "emdo" FROM emdo_visual_decision_login;
REVOKE ALL ON SCHEMA "emdo" FROM emdo_visual_decision_login;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "emdo" TO emdo_workflow_login;
--> statement-breakpoint

-- Proposal aggregate commit helpers are executable only by membership-free
-- function owners. Runtime logins receive the narrow commit functions below.
CREATE OR REPLACE FUNCTION "emdo"."provider_proposal_mutation_hash"(
	p_phase text,
	p_input jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $function$
	SELECT pg_catalog.encode(
		pg_catalog.sha256(
			pg_catalog.convert_to('emdo.workflow-mutation.v1', 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_phase, 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_input::text, 'UTF8')
		),
		'hex'
	)
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."proposal_row_matches_input"(
	p_proposal emdo.action_proposals,
	p_version integer,
	p_state text,
	p_input jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $function$
	SELECT pg_catalog.jsonb_typeof(p_input) = 'object'
		AND (
			SELECT pg_catalog.count(*)
			FROM pg_catalog.jsonb_object_keys(p_input)
		) = 22
		AND (p_input ->> 'schemaVersion')::smallint = p_proposal.schema_version
		AND (p_input ->> 'id')::uuid = p_proposal.id
		AND (p_input ->> 'version')::integer = p_version
		AND (p_input ->> 'runId')::uuid = p_proposal.run_id
		AND p_input ->> 'capabilityId' = p_proposal.capability_id
		AND p_input ->> 'capabilityFingerprint' =
			p_proposal.capability_fingerprint
		AND p_input ->> 'authorizationScopeFingerprint' =
			p_proposal.authorization_scope_fingerprint
		AND p_input -> 'canonicalArguments' = p_proposal.canonical_arguments
		AND p_input -> 'targets' = p_proposal.targets
		AND p_input -> 'beforePreview' = p_proposal.before_preview
		AND p_input -> 'afterPreview' = p_proposal.after_preview
		AND p_input -> 'providerPreconditions' =
			p_proposal.provider_preconditions
		AND p_input -> 'approvalDisplay' = p_proposal.approval_display
		AND p_input ->> 'providerAuthorityBindingHash' =
			p_proposal.provider_authority_binding_hash
		AND p_input ->> 'providerSdkCallId' = p_proposal.provider_sdk_call_id
		AND p_input ->> 'payloadHash' = p_proposal.payload_hash
		AND p_input ->> 'approvalHash' = p_proposal.approval_hash
		AND p_input -> 'disclosureGrant' = p_proposal.disclosure_grant
		AND (p_input ->> 'createdAt')::timestamptz = p_proposal.created_at
		AND (p_input ->> 'expiresAt')::timestamptz = p_proposal.expires_at
		AND p_input ->> 'idempotencyKey' = p_proposal.idempotency_key
		AND p_input ->> 'state' = p_state
$function$;
--> statement-breakpoint

CREATE POLICY workflow_proposals_executor_insert
	ON "emdo"."action_proposals"
	FOR INSERT TO emdo_workflow_executor WITH CHECK (true);
CREATE POLICY workflow_states_executor_insert
	ON "emdo"."proposal_states"
	FOR INSERT TO emdo_workflow_executor WITH CHECK (true);
CREATE POLICY workflow_preparations_executor_insert
	ON "emdo"."proposal_preparations"
	FOR INSERT TO emdo_workflow_executor WITH CHECK (true);
CREATE POLICY workflow_decisions_executor_insert
	ON "emdo"."action_decisions"
	FOR INSERT TO emdo_workflow_executor WITH CHECK (true);
CREATE POLICY workflow_attempts_executor_insert
	ON "emdo"."provider_attempts"
	FOR INSERT TO emdo_workflow_executor WITH CHECK (true);
CREATE POLICY workflow_events_executor_select
	ON "emdo"."proposal_events"
	FOR SELECT TO emdo_workflow_executor USING (true);
CREATE POLICY workflow_events_executor_insert
	ON "emdo"."proposal_events"
	FOR INSERT TO emdo_workflow_executor WITH CHECK (true);
CREATE POLICY workflow_outcomes_executor_select
	ON "emdo"."provider_outcomes"
	FOR SELECT TO emdo_workflow_executor USING (true);
CREATE POLICY workflow_outcomes_executor_insert
	ON "emdo"."provider_outcomes"
	FOR INSERT TO emdo_workflow_executor WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT ON "emdo"."action_proposals",
	"emdo"."action_decisions", "emdo"."proposal_events",
	"emdo"."provider_outcomes" TO emdo_workflow_executor;
GRANT SELECT, INSERT, UPDATE ON "emdo"."proposal_states",
	"emdo"."provider_attempts", "emdo"."proposal_preparations"
	TO emdo_workflow_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."provider_proposal_mutation_hash"(text, jsonb),
	"emdo"."proposal_row_matches_input"(
		emdo.action_proposals, integer, text, jsonb
	)
	TO emdo_workflow_executor;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."commit_provider_proposal_create"(
	p_operation_id text,
	p_input jsonb
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_claim emdo.workflow_operation_claims%ROWTYPE;
	v_proposal emdo.action_proposals%ROWTYPE;
	v_state emdo.proposal_states%ROWTYPE;
	v_disclosure emdo.disclosure_grants%ROWTYPE;
	v_id uuid;
	v_created_at timestamptz;
	v_expires_at timestamptz;
	v_mutation_hash text;
	v_now timestamptz;
	v_locked record;
BEGIN
	IF p_operation_id IS NULL
		OR pg_catalog.jsonb_typeof(p_input) IS DISTINCT FROM 'object'
		OR pg_catalog.octet_length(p_input::text) > 524288
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input, ARRAY['proposal', 'preparation', 'scope', 'event']::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'proposal',
			ARRAY[
				'schemaVersion', 'id', 'version', 'runId', 'capabilityId',
				'capabilityFingerprint', 'authorizationScopeFingerprint',
				'canonicalArguments', 'targets',
				'beforePreview', 'afterPreview', 'providerPreconditions',
				'approvalDisplay', 'providerAuthorityBindingHash',
				'providerSdkCallId', 'payloadHash', 'approvalHash',
				'disclosureGrant', 'createdAt', 'expiresAt', 'idempotencyKey',
				'state'
			]::text[]
		)
		OR NOT emdo.proposal_approval_display_is_valid(
			p_input #> '{proposal,approvalDisplay}'
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'preparation', ARRAY['binding', 'bindingHash']::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input #> '{preparation,binding}',
			ARRAY[
				'proposalId', 'originRequestId', 'originSpaceAccessGrantId',
				'originSessionId', 'runId', 'householdId', 'userId', 'agentId',
				'disclosureGrantId', 'disclosurePolicyVersion',
				'capabilityId', 'sdkCallId',
				'providerAuthorityBindingHash'
			]::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'event',
			ARRAY['proposalId', 'eventType', 'occurredAt']::text[]
		)
	THEN
		RETURN 'conflict';
	END IF;
	-- Mint and consume authority inside this SECURITY DEFINER aggregate's
	-- transaction. No app or workflow login can execute the private issuer.
	IF NOT emdo.issue_workflow_operation_claim(
		p_operation_id,
		p_input -> 'scope',
		NULL,
		NULL,
		NULL,
		p_input #>> '{preparation,bindingHash}',
		p_input #>> '{proposal,providerAuthorityBindingHash}',
		p_input
	) THEN
		RETURN 'conflict';
	END IF;
	v_mutation_hash := emdo.provider_proposal_mutation_hash(
		'proposal-create', p_input
	);
	SELECT claim.* INTO v_claim
	FROM emdo.workflow_operation_claims AS claim
	WHERE claim.operation_id = p_operation_id
	FOR UPDATE OF claim;
	IF NOT FOUND
		OR v_claim.phase IS DISTINCT FROM 'proposal-create'
		OR v_claim.mutation_hash IS DISTINCT FROM v_mutation_hash
	THEN
		RETURN 'conflict';
	END IF;
	v_id := (p_input #>> '{proposal,id}')::uuid;
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(v_id::text, 0)
	);
	IF v_claim.claimed_at IS NOT NULL THEN
		SELECT ROW(proposal.*)::emdo.action_proposals AS proposal_row,
			ROW(state.*)::emdo.proposal_states AS state_row
		INTO v_locked
		FROM emdo.action_proposals AS proposal
		JOIN emdo.proposal_states AS state ON state.proposal_id = proposal.id
		WHERE proposal.id = v_id
		FOR UPDATE OF proposal, state;
		IF FOUND THEN
			v_proposal := v_locked.proposal_row;
			v_state := v_locked.state_row;
		END IF;
		RETURN CASE WHEN FOUND
			AND v_proposal.authorization_scope_fingerprint =
				v_claim.authorization_scope_fingerprint
			AND emdo.proposal_row_matches_input(
				v_proposal, v_state.version, v_state.state,
				p_input -> 'proposal'
			)
			AND EXISTS (
				SELECT 1 FROM emdo.proposal_preparations AS preparation
				WHERE preparation.proposal_id = v_id
					AND preparation.preparation_binding =
						p_input #> '{preparation,binding}'
					AND preparation.preparation_binding_hash =
						p_input #>> '{preparation,bindingHash}'
					AND preparation.abandonment_reason IS NULL
			)
			AND EXISTS (
				SELECT 1 FROM emdo.proposal_events AS event
				WHERE event.proposal_id = v_id AND event.sequence = 1
					AND event.payload = p_input -> 'event'
			)
		THEN 'duplicate' ELSE 'conflict' END;
	END IF;
	IF NOT emdo.claim_workflow_operation_scope(p_operation_id) THEN
		RETURN 'conflict';
	END IF;
	IF p_input -> 'scope' IS DISTINCT FROM v_claim.scope_assertion
		OR p_input #>> '{proposal,id}' IS DISTINCT FROM v_claim.proposal_id::text
		OR p_input #>> '{proposal,runId}' IS DISTINCT FROM v_claim.run_id::text
		OR p_input #>> '{proposal,providerSdkCallId}' IS DISTINCT FROM
			v_claim.provider_sdk_call_id
		OR p_input #>> '{proposal,providerAuthorityBindingHash}' IS DISTINCT FROM
			v_claim.provider_authority_binding_hash
		OR p_input #>> '{proposal,authorizationScopeFingerprint}' IS DISTINCT FROM
			v_claim.authorization_scope_fingerprint
		OR p_input #>> '{proposal,disclosureGrant,id}' IS DISTINCT FROM
			v_claim.disclosure_grant_id::text
		OR p_input #>> '{proposal,disclosureGrant,version}' IS DISTINCT FROM
			v_claim.disclosure_grant_version::text
		OR p_input #>> '{preparation,bindingHash}' IS DISTINCT FROM
			v_claim.preparation_binding_hash
		OR p_input #>> '{preparation,binding,proposalId}' IS DISTINCT FROM
			v_claim.proposal_id::text
		OR p_input #>> '{preparation,binding,originRequestId}' IS DISTINCT FROM
			v_claim.origin_request_id::text
		OR p_input #>> '{preparation,binding,runId}' IS DISTINCT FROM
			v_claim.run_id::text
		OR p_input #>> '{preparation,binding,householdId}' IS DISTINCT FROM
			v_claim.household_id::text
		OR p_input #>> '{preparation,binding,userId}' IS DISTINCT FROM
			v_claim.user_id::text
		OR p_input #>> '{preparation,binding,originSpaceAccessGrantId}'
			IS DISTINCT FROM
			v_claim.origin_space_access_grant_id::text
		OR p_input #>> '{preparation,binding,originSessionId}' IS DISTINCT FROM
			v_claim.origin_session_id::text
		OR p_input #>> '{preparation,binding,disclosureGrantId}' IS DISTINCT FROM
			v_claim.disclosure_grant_id::text
		OR p_input #>> '{preparation,binding,disclosurePolicyVersion}'
			!~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
		OR p_input #>> '{preparation,binding,sdkCallId}' IS DISTINCT FROM
			v_claim.provider_sdk_call_id
		OR p_input #>> '{preparation,binding,providerAuthorityBindingHash}'
			IS DISTINCT FROM v_claim.provider_authority_binding_hash
		OR (p_input #>> '{proposal,schemaVersion}')::smallint IS DISTINCT FROM 1
		OR (p_input #>> '{proposal,version}')::integer IS DISTINCT FROM 1
		OR p_input #>> '{proposal,state}' IS DISTINCT FROM 'pending'
		OR p_input #>> '{event,proposalId}' IS DISTINCT FROM v_claim.proposal_id::text
		OR p_input #>> '{event,eventType}' IS DISTINCT FROM 'proposal.created'
	THEN
		RETURN 'conflict';
	END IF;
	SELECT disclosure.* INTO v_disclosure
	FROM emdo.disclosure_grants AS disclosure
	WHERE disclosure.id = v_claim.disclosure_grant_id
		AND disclosure.household_id = v_claim.household_id
		AND disclosure.space_id = v_claim.space_id
		AND disclosure.user_id = v_claim.user_id
		AND disclosure.run_id = v_claim.run_id
		AND disclosure.version = v_claim.disclosure_grant_version
		AND disclosure.grant_hash = v_claim.disclosure_grant_hash
	FOR SHARE OF disclosure;
	IF NOT FOUND
		OR p_input #> '{proposal,disclosureGrant}' IS DISTINCT FROM
			pg_catalog.jsonb_build_object(
				'schemaVersion', v_disclosure.schema_version,
				'id', v_disclosure.id,
				'version', v_disclosure.version,
				'userId', v_disclosure.user_id,
				'householdId', v_disclosure.household_id,
				'agentId', v_disclosure.agent_id,
				'purpose', v_disclosure.purpose,
				'runId', v_disclosure.run_id,
				'recordAllowlist', v_disclosure.record_allowlist,
				'provider', v_disclosure.provider,
				'createdAt', pg_catalog.to_char(
					v_disclosure.created_at AT TIME ZONE 'UTC',
					'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
				),
				'expiresAt', pg_catalog.to_char(
					v_disclosure.expires_at AT TIME ZONE 'UTC',
					'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
				),
				'oneRunOnly', v_disclosure.one_run_only
			)
	THEN
		RETURN 'conflict';
	END IF;
	v_created_at := (p_input #>> '{proposal,createdAt}')::timestamptz;
	v_expires_at := (p_input #>> '{proposal,expiresAt}')::timestamptz;
	v_now := pg_catalog.clock_timestamp();
	IF v_created_at > v_now OR v_expires_at <= v_now
		OR v_expires_at > v_created_at + interval '10 minutes'
		OR (p_input #>> '{event,occurredAt}')::timestamptz
			IS DISTINCT FROM v_created_at
	THEN
		RETURN 'conflict';
	END IF;
	INSERT INTO emdo.action_proposals(
		id, schema_version, household_id, space_id, original_owner_user_id,
		run_id, disclosure_grant_id, capability_id, capability_fingerprint,
		canonical_arguments, targets, before_preview, after_preview,
		provider_preconditions, approval_display,
		provider_authority_binding_hash, authorization_scope_fingerprint,
		provider_sdk_call_id, payload_hash, approval_hash, disclosure_grant,
		idempotency_key, created_at, expires_at
	) VALUES (
		v_claim.proposal_id, 1, v_claim.household_id, v_claim.space_id,
		v_claim.user_id, v_claim.run_id, v_claim.disclosure_grant_id,
		p_input #>> '{proposal,capabilityId}',
		p_input #>> '{proposal,capabilityFingerprint}',
		p_input #> '{proposal,canonicalArguments}',
		p_input #> '{proposal,targets}', p_input #> '{proposal,beforePreview}',
		p_input #> '{proposal,afterPreview}',
		p_input #> '{proposal,providerPreconditions}',
		p_input #> '{proposal,approvalDisplay}',
		v_claim.provider_authority_binding_hash,
		v_claim.authorization_scope_fingerprint, v_claim.provider_sdk_call_id,
		p_input #>> '{proposal,payloadHash}',
		p_input #>> '{proposal,approvalHash}',
		p_input #> '{proposal,disclosureGrant}',
		p_input #>> '{proposal,idempotencyKey}', v_created_at, v_expires_at
	);
	INSERT INTO emdo.proposal_states(
		proposal_id, household_id, space_id, original_owner_user_id,
		version, state, updated_at
	) VALUES (
		v_claim.proposal_id, v_claim.household_id, v_claim.space_id,
		v_claim.user_id, 1, 'pending', v_now
	);
	INSERT INTO emdo.proposal_preparations(
		proposal_id, household_id, space_id, original_owner_user_id,
		preparation_binding, preparation_binding_hash
	) VALUES (
		v_claim.proposal_id, v_claim.household_id, v_claim.space_id,
		v_claim.user_id, p_input #> '{preparation,binding}',
		v_claim.preparation_binding_hash
	);
	INSERT INTO emdo.proposal_events(
		proposal_id, household_id, space_id, original_owner_user_id,
		proposal_version, sequence, event_type, payload, occurred_at
	) VALUES (
		v_claim.proposal_id, v_claim.household_id, v_claim.space_id,
		v_claim.user_id, 1, 1, 'proposal.created', p_input -> 'event',
		v_created_at
	);
	RETURN 'created';
EXCEPTION
	WHEN invalid_text_representation OR invalid_datetime_format
		OR datetime_field_overflow OR numeric_value_out_of_range
		OR not_null_violation OR check_violation OR foreign_key_violation
		OR unique_violation THEN
		RETURN 'conflict';
END
$function$;
--> statement-breakpoint

-- Proposal terminal and post-approval aggregate commits.
CREATE OR REPLACE FUNCTION "emdo"."jsonb_object_has_exact_keys"(
	p_value jsonb,
	p_keys text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $function$
	SELECT pg_catalog.jsonb_typeof(p_value) = 'object'
		AND (
			SELECT pg_catalog.count(*)
			FROM pg_catalog.jsonb_object_keys(p_value)
		) = pg_catalog.cardinality(p_keys)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.jsonb_object_keys(p_value) AS candidate(key)
			WHERE NOT candidate.key = ANY (p_keys)
		)
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."json_text_utf16_length"(
	p_value text
)
RETURNS integer
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $function$
	SELECT COALESCE(pg_catalog.sum(
		CASE WHEN pg_catalog.ascii(piece.value) > 65535 THEN 2 ELSE 1 END
	), 0)::integer
	FROM pg_catalog.regexp_split_to_table(p_value, '') AS piece(value)
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."proposal_approval_display_text_is_safe"(
	p_value text,
	p_require_visible boolean
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $function$
	WITH codepoints AS MATERIALIZED (
		SELECT pg_catalog.ascii(piece.value) AS codepoint
		FROM pg_catalog.regexp_split_to_table(p_value, '') AS piece(value)
		WHERE piece.value <> ''
	)
	SELECT NOT EXISTS (
		SELECT 1
		FROM codepoints
		WHERE codepoint BETWEEN 0 AND 31
			OR codepoint BETWEEN 127 AND 159
			-- Unicode General_Category=Cf. Keep this denylist aligned with
			-- the parsed ActionProposalApprovalDisplay contract.
			OR codepoint IN (
				173, 1564, 1757, 1807, 2192, 2193, 2274, 6158,
				65279, 69821, 69837, 917505
			)
			OR codepoint BETWEEN 1536 AND 1541
			OR codepoint BETWEEN 8288 AND 8292
			OR codepoint BETWEEN 8294 AND 8303
			OR codepoint BETWEEN 65529 AND 65531
			OR codepoint BETWEEN 78896 AND 78911
			OR codepoint BETWEEN 113824 AND 113827
			OR codepoint BETWEEN 119155 AND 119162
			OR codepoint BETWEEN 917536 AND 917631
			OR codepoint BETWEEN 8234 AND 8238
			OR codepoint BETWEEN 8203 AND 8207
	)
	AND (
		NOT p_require_visible
		OR EXISTS (
			SELECT 1
			FROM codepoints
			WHERE NOT (
				-- Unicode White_Space.
				codepoint BETWEEN 9 AND 13
				OR codepoint IN (
					32, 133, 160, 5760, 8232, 8233, 8239, 8287, 12288
				)
				OR codepoint BETWEEN 8192 AND 8202
				-- Non-Cf Default_Ignorable_Code_Point ranges. Cf code
				-- points are already rejected above rather than stripped.
				OR codepoint IN (847, 12644, 65440)
				OR codepoint BETWEEN 4447 AND 4448
				OR codepoint BETWEEN 6068 AND 6069
				OR codepoint BETWEEN 6155 AND 6159
				OR codepoint BETWEEN 65024 AND 65039
				OR codepoint BETWEEN 65520 AND 65528
				OR codepoint BETWEEN 917504 AND 921599
				OR codepoint BETWEEN 917760 AND 917999
			)
		)
	)
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."proposal_approval_display_is_valid"(
	p_display jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, emdo
AS $function$
	SELECT emdo.jsonb_object_has_exact_keys(
		p_display,
		ARRAY[
			'schemaVersion', 'title', 'summary', 'beforeSummary',
			'afterSummary', 'fields'
		]::text[]
	)
		AND p_display -> 'schemaVersion' = '1'::jsonb
		AND pg_catalog.jsonb_typeof(p_display -> 'title') = 'string'
		AND emdo.json_text_utf16_length(p_display ->> 'title')
			BETWEEN 1 AND 200
		AND emdo.proposal_approval_display_text_is_safe(
			p_display ->> 'title', true
		)
		AND pg_catalog.jsonb_typeof(p_display -> 'summary') = 'string'
		AND emdo.json_text_utf16_length(p_display ->> 'summary')
			BETWEEN 1 AND 1000
		AND emdo.proposal_approval_display_text_is_safe(
			p_display ->> 'summary', true
		)
		AND pg_catalog.jsonb_typeof(p_display -> 'beforeSummary') = 'string'
		AND emdo.json_text_utf16_length(p_display ->> 'beforeSummary') <= 2000
		AND emdo.proposal_approval_display_text_is_safe(
			p_display ->> 'beforeSummary', false
		)
		AND pg_catalog.jsonb_typeof(p_display -> 'afterSummary') = 'string'
		AND emdo.json_text_utf16_length(p_display ->> 'afterSummary') <= 2000
		AND emdo.proposal_approval_display_text_is_safe(
			p_display ->> 'afterSummary', false
		)
		AND CASE
			WHEN pg_catalog.jsonb_typeof(p_display -> 'fields') = 'array'
			THEN pg_catalog.jsonb_array_length(p_display -> 'fields') <= 32
				AND NOT EXISTS (
					SELECT 1
					FROM pg_catalog.jsonb_array_elements(
						p_display -> 'fields'
					) AS field(value)
					WHERE NOT emdo.jsonb_object_has_exact_keys(
						field.value, ARRAY['label', 'value']::text[]
					)
						OR pg_catalog.jsonb_typeof(field.value -> 'label')
							IS DISTINCT FROM 'string'
						OR emdo.json_text_utf16_length(field.value ->> 'label')
							NOT BETWEEN 1 AND 120
						OR NOT emdo.proposal_approval_display_text_is_safe(
							field.value ->> 'label', true
						)
						OR pg_catalog.jsonb_typeof(field.value -> 'value')
							IS DISTINCT FROM 'string'
						OR emdo.json_text_utf16_length(field.value ->> 'value')
							> 2000
						OR NOT emdo.proposal_approval_display_text_is_safe(
							field.value ->> 'value', false
						)
				)
			ELSE false
		END
$function$;
--> statement-breakpoint

ALTER TABLE "emdo"."action_proposals"
	DROP CONSTRAINT "action_proposals_approval_display_check",
	ADD CONSTRAINT "action_proposals_approval_display_check" CHECK (
		emdo.proposal_approval_display_is_valid("approval_display")
	);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."proposal_event_has_only_known_keys"(
	p_event jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $function$
	SELECT pg_catalog.jsonb_typeof(p_event) = 'object'
		AND pg_catalog.octet_length(p_event::text) <= 65536
		AND p_event ?& ARRAY['proposalId', 'eventType', 'occurredAt']
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.jsonb_object_keys(p_event) AS candidate(key)
			WHERE NOT candidate.key = ANY (ARRAY[
				'proposalId', 'eventType', 'occurredAt', 'decisionId',
				'actorUserId', 'authenticatedSessionId', 'approvalHash',
				'decisionIdempotencyKey', 'application', 'outcomeReason',
				'outputStatus', 'reconciliationRequired', 'evidenceHash',
				'providerIdempotencyKey', 'attemptId', 'attemptVersion',
				'resultHash', 'safeErrorCode'
			]::text[])
		)
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."provider_completion_is_valid"(
	p_completion jsonb,
	p_allow_reconciliation boolean
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, emdo
AS $function$
	SELECT CASE
		WHEN pg_catalog.jsonb_typeof(p_completion) <> 'object'
			OR pg_catalog.octet_length(p_completion::text) > 65536
		THEN false
		WHEN p_completion ->> 'state' = 'executed'
			AND p_completion ->> 'application' = 'applied'
			AND p_completion ->> 'outputStatus' = 'valid'
		THEN emdo.jsonb_object_has_exact_keys(
			p_completion,
			CASE WHEN p_completion ? 'evidenceHash'
				THEN ARRAY[
					'state', 'application', 'outputStatus', 'resultHash',
					'evidenceHash'
				]::text[]
				ELSE ARRAY[
					'state', 'application', 'outputStatus', 'resultHash'
				]::text[]
			END
		)
			AND p_completion ->> 'resultHash' ~ '^[a-f0-9]{64}$'
			AND (
				NOT (p_completion ? 'evidenceHash')
				OR p_completion ->> 'evidenceHash' ~ '^[a-f0-9]{64}$'
			)
		WHEN p_completion ->> 'state' = 'executed'
			AND p_completion ->> 'application' = 'applied'
			AND p_completion ->> 'outputStatus' = 'invalid'
		THEN emdo.jsonb_object_has_exact_keys(
			p_completion,
			CASE WHEN p_completion ? 'evidenceHash'
				THEN ARRAY[
					'state', 'application', 'outputStatus', 'safeErrorCode',
					'evidenceHash'
				]::text[]
				ELSE ARRAY[
					'state', 'application', 'outputStatus', 'safeErrorCode'
				]::text[]
			END
		)
			AND p_completion ->> 'safeErrorCode' =
				'provider-write-output-invalid'
			AND (
				NOT (p_completion ? 'evidenceHash')
				OR p_completion ->> 'evidenceHash' ~ '^[a-f0-9]{64}$'
			)
		WHEN p_completion ->> 'state' = 'not-applied'
			AND p_completion ->> 'application' = 'not-applied'
		THEN emdo.jsonb_object_has_exact_keys(
			p_completion,
			CASE WHEN p_completion ? 'evidenceHash'
				THEN ARRAY[
					'state', 'application', 'reason', 'evidenceHash'
				]::text[]
				ELSE ARRAY['state', 'application', 'reason']::text[]
			END
		)
			AND p_completion ->> 'reason' IN (
				'approval-expired-before-dispatch',
				'approval-policy-mismatch',
				'provider-precondition-failed',
				'provider-rejected-before-apply'
			)
			AND (
				NOT (p_completion ? 'evidenceHash')
				OR p_completion ->> 'evidenceHash' ~ '^[a-f0-9]{64}$'
			)
			AND (
				NOT p_allow_reconciliation
				OR p_completion ->> 'reason' NOT IN (
					'approval-expired-before-dispatch',
					'approval-policy-mismatch'
				)
			)
		WHEN NOT p_allow_reconciliation
			AND p_completion ->> 'state' = 'indeterminate'
			AND p_completion ->> 'application' = 'indeterminate'
			AND p_completion -> 'reconciliationRequired' = 'true'::jsonb
		THEN emdo.jsonb_object_has_exact_keys(
			p_completion,
			CASE WHEN p_completion ? 'evidenceHash'
				THEN ARRAY[
					'state', 'application', 'reason',
					'reconciliationRequired', 'evidenceHash'
				]::text[]
				ELSE ARRAY[
					'state', 'application', 'reason',
					'reconciliationRequired'
				]::text[]
			END
		)
			AND p_completion ->> 'reason' IN (
				'timeout-after-dispatch',
				'transport-lost-after-dispatch',
				'executor-threw-after-dispatch-boundary',
				'provider-outcome-envelope-invalid'
			)
			AND (
				NOT (p_completion ? 'evidenceHash')
				OR p_completion ->> 'evidenceHash' ~ '^[a-f0-9]{64}$'
			)
		ELSE false
	END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."canonical_json_text"(
	p_value jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, emdo
AS $function$
DECLARE
	v_canonical text;
BEGIN
	CASE pg_catalog.jsonb_typeof(p_value)
		WHEN 'object' THEN
			SELECT '{' || COALESCE(pg_catalog.string_agg(
				pg_catalog.to_json(entry.key)::text || ':' ||
				emdo.canonical_json_text(entry.value),
				',' ORDER BY entry.key COLLATE "C"
			), '') || '}'
			INTO v_canonical
			FROM pg_catalog.jsonb_each(p_value) AS entry(key, value);
		WHEN 'array' THEN
			SELECT '[' || COALESCE(pg_catalog.string_agg(
				emdo.canonical_json_text(element.value),
				',' ORDER BY element.ordinality
			), '') || ']'
			INTO v_canonical
			FROM pg_catalog.jsonb_array_elements(p_value)
				WITH ORDINALITY AS element(value, ordinality);
		ELSE
			v_canonical := p_value::text;
	END CASE;
	RETURN v_canonical;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."canonical_json_hash"(
	p_value jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, emdo
AS $function$
	SELECT pg_catalog.encode(
		pg_catalog.sha256(
			pg_catalog.convert_to(
				emdo.canonical_json_text(p_value), 'UTF8'
			)
		),
		'hex'
	)
$function$;
--> statement-breakpoint

-- The provider proposal service supports a terminal pre-decision abandonment.
-- Preserve every foundation transition and add only pending -> not-applied.
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
	THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'proposal scope is immutable';
	END IF;
	IF NEW.version <> OLD.version + 1 THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'proposal version must increment exactly once';
	END IF;
	IF NOT (
		(OLD.state = 'pending' AND NEW.state IN (
			'approved', 'rejected', 'expired', 'not-applied'
		))
		OR (OLD.state = 'approved' AND NEW.state IN ('prepared', 'expired'))
		OR (OLD.state = 'prepared' AND NEW.state IN ('executing', 'not-applied'))
		OR (OLD.state = 'executing' AND NEW.state IN (
			'executed', 'not-applied', 'indeterminate', 'failed'
		))
		OR (OLD.state = 'indeterminate' AND NEW.state IN (
			'executed', 'not-applied'
		))
	) THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'invalid proposal state transition';
	END IF;
	NEW.updated_at := pg_catalog.clock_timestamp();
	RETURN NEW;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."commit_provider_proposal_abandonment"(
	p_input jsonb
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_proposal emdo.action_proposals%ROWTYPE;
	v_state emdo.proposal_states%ROWTYPE;
	v_preparation emdo.proposal_preparations%ROWTYPE;
	v_locked record;
	v_proposal_id uuid;
	v_expected_version integer;
	v_expected_state text;
	v_expected_approval_hash text;
	v_next_version integer;
	v_abandoned_at timestamptz;
	v_now timestamptz;
	v_sequence integer;
BEGIN
	IF p_input IS NULL
		OR pg_catalog.octet_length(p_input::text) > 524288
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input, ARRAY['expected', 'next', 'preparation', 'event']::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'expected',
			ARRAY['proposalId', 'version', 'state', 'approvalHash']::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'preparation',
			ARRAY['binding', 'bindingHash', 'abandonment']::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input #> '{preparation,abandonment}',
			ARRAY['reason', 'abandonedAt']::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'event',
			ARRAY[
				'proposalId', 'eventType', 'occurredAt', 'application',
				'outcomeReason'
			]::text[]
		)
	THEN
		RETURN 'conflict';
	END IF;
	v_proposal_id := (p_input #>> '{expected,proposalId}')::uuid;
	v_expected_version := (p_input #>> '{expected,version}')::integer;
	v_expected_state := p_input #>> '{expected,state}';
	v_expected_approval_hash := p_input #>> '{expected,approvalHash}';
	v_next_version := (p_input #>> '{next,version}')::integer;
	v_abandoned_at :=
		(p_input #>> '{preparation,abandonment,abandonedAt}')::timestamptz;
	v_now := pg_catalog.clock_timestamp();
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(v_proposal_id::text, 0)
	);
	SELECT ROW(proposal.*)::emdo.action_proposals AS proposal_row,
		ROW(state.*)::emdo.proposal_states AS state_row,
		ROW(preparation.*)::emdo.proposal_preparations AS preparation_row
	INTO v_locked
	FROM emdo.action_proposals AS proposal
	JOIN emdo.proposal_states AS state ON state.proposal_id = proposal.id
	JOIN emdo.proposal_preparations AS preparation
		ON preparation.proposal_id = proposal.id
	WHERE proposal.id = v_proposal_id
	FOR UPDATE OF proposal, state, preparation;
	IF NOT FOUND THEN
		RETURN 'conflict';
	END IF;
	v_proposal := v_locked.proposal_row;
	v_state := v_locked.state_row;
	v_preparation := v_locked.preparation_row;
	IF v_preparation.abandonment_reason IS NOT NULL THEN
		RETURN CASE WHEN
			v_state.version = v_next_version
			AND v_state.state = 'not-applied'
			AND emdo.proposal_row_matches_input(
				v_proposal, v_next_version, 'not-applied', p_input -> 'next'
			)
			AND v_preparation.preparation_binding =
				p_input #> '{preparation,binding}'
			AND v_preparation.preparation_binding_hash =
				p_input #>> '{preparation,bindingHash}'
			AND v_preparation.abandonment_reason =
				p_input #>> '{preparation,abandonment,reason}'
			AND v_preparation.abandoned_at = v_abandoned_at
			AND EXISTS (
				SELECT 1 FROM emdo.proposal_events AS event
				WHERE event.proposal_id = v_proposal_id
					AND event.proposal_version = v_next_version
					AND event.payload = p_input -> 'event'
			)
		THEN 'duplicate' ELSE 'conflict' END;
	END IF;
	IF v_state.version IS DISTINCT FROM v_expected_version
		OR v_state.state IS DISTINCT FROM v_expected_state
		OR v_proposal.approval_hash IS DISTINCT FROM v_expected_approval_hash
		OR v_expected_state IS DISTINCT FROM 'pending'
		OR v_next_version IS DISTINCT FROM v_expected_version + 1
		OR NOT emdo.proposal_row_matches_input(
			v_proposal, v_next_version, 'not-applied', p_input -> 'next'
		)
		OR v_preparation.preparation_binding IS DISTINCT FROM
			p_input #> '{preparation,binding}'
		OR v_preparation.preparation_binding_hash IS DISTINCT FROM
			p_input #>> '{preparation,bindingHash}'
		OR p_input #>> '{preparation,abandonment,reason}' IS NULL
		OR p_input #>> '{preparation,abandonment,reason}' NOT IN (
			'multiple-provider-writes-require-separate-turns',
			'execution-ended-before-checkpoint'
		)
		OR v_abandoned_at < v_proposal.created_at
		OR v_abandoned_at > v_now
		OR p_input #>> '{event,proposalId}' IS DISTINCT FROM v_proposal_id::text
		OR p_input #>> '{event,eventType}' IS DISTINCT FROM
			'proposal.not-applied'
		OR (p_input #>> '{event,occurredAt}')::timestamptz IS DISTINCT FROM
			v_abandoned_at
		OR p_input #>> '{event,outcomeReason}' IS DISTINCT FROM
			p_input #>> '{preparation,abandonment,reason}'
		OR p_input #>> '{event,application}' IS DISTINCT FROM 'not-applied'
		OR EXISTS (
			SELECT 1 FROM emdo.action_decisions AS decision
			WHERE decision.proposal_id = v_proposal_id
		)
		OR EXISTS (
			SELECT 1 FROM emdo.provider_attempts AS attempt
			WHERE attempt.proposal_id = v_proposal_id
		)
		OR NOT EXISTS (
			SELECT 1
			FROM emdo.workflow_operation_claims AS claim
			WHERE claim.phase = 'proposal-create'
				AND claim.claimed_at IS NOT NULL
				AND claim.proposal_id = v_proposal.id
				AND claim.household_id = v_proposal.household_id
				AND claim.space_id = v_proposal.space_id
				AND claim.original_owner_user_id =
					v_proposal.original_owner_user_id
				AND claim.run_id = v_proposal.run_id
				AND claim.disclosure_grant_id = v_proposal.disclosure_grant_id
				AND claim.provider_sdk_call_id = v_proposal.provider_sdk_call_id
				AND claim.provider_authority_binding_hash =
					v_proposal.provider_authority_binding_hash
				AND claim.authorization_scope_fingerprint =
					v_proposal.authorization_scope_fingerprint
				AND claim.preparation_binding_hash =
					v_preparation.preparation_binding_hash
		)
	THEN
		RETURN 'conflict';
	END IF;
	SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
	INTO v_sequence
	FROM emdo.proposal_events AS event
	WHERE event.proposal_id = v_proposal_id;
	UPDATE emdo.proposal_preparations AS preparation
	SET abandonment_reason = p_input #>> '{preparation,abandonment,reason}',
		abandoned_at = v_abandoned_at
	WHERE preparation.proposal_id = v_proposal_id
		AND preparation.abandonment_reason IS NULL
		AND preparation.abandoned_at IS NULL;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = 'P0001',
			MESSAGE = 'proposal preparation CAS failed';
	END IF;
	UPDATE emdo.proposal_states AS state
	SET version = v_next_version, state = 'not-applied', updated_at = v_now
	WHERE state.proposal_id = v_proposal_id
		AND state.version = v_expected_version
		AND state.state = v_expected_state;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = 'P0001',
			MESSAGE = 'proposal state CAS failed';
	END IF;
	INSERT INTO emdo.proposal_events(
		proposal_id, household_id, space_id, original_owner_user_id,
		proposal_version, sequence, event_type, payload, occurred_at
	) VALUES (
		v_proposal.id, v_proposal.household_id, v_proposal.space_id,
		v_proposal.original_owner_user_id, v_next_version, v_sequence,
		'proposal.not-applied', p_input -> 'event', v_abandoned_at
	);
	RETURN 'created';
EXCEPTION
	WHEN data_exception OR integrity_constraint_violation OR raise_exception THEN
		RETURN 'conflict';
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."commit_provider_proposal_prepare"(
	p_operation_id text,
	p_input jsonb
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_claim emdo.workflow_operation_claims%ROWTYPE;
	v_proposal emdo.action_proposals%ROWTYPE;
	v_state emdo.proposal_states%ROWTYPE;
	v_preparation emdo.proposal_preparations%ROWTYPE;
	v_decision emdo.action_decisions%ROWTYPE;
	v_attempt emdo.provider_attempts%ROWTYPE;
	v_locked record;
	v_proposal_id uuid;
	v_expected_version integer;
	v_expected_state text;
	v_expected_approval_hash text;
	v_next_version integer;
	v_attempt_id uuid;
	v_issued_at timestamptz;
	v_expires_at timestamptz;
	v_idempotency_expires_at timestamptz;
	v_event_at timestamptz;
	v_mutation_hash text;
	v_now timestamptz;
	v_sequence integer;
BEGIN
	IF p_operation_id IS NULL
		OR p_input IS NULL
		OR pg_catalog.octet_length(p_input::text) > 524288
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input,
			ARRAY[
				'expected', 'next', 'decisionId', 'bindingHash',
				'authorization', 'approvalBinding', 'scope', 'event'
			]::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'expected',
			ARRAY['proposalId', 'version', 'state', 'approvalHash']::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'authorization',
			ARRAY[
				'proposalId', 'approvalHash', 'approvalBindingHash',
				'capabilityFingerprint', 'proposalCreatedAt', 'expiresAt',
				'disclosureGrantId', 'disclosureGrantHash', 'approvalBinding',
				'providerIdempotencyKey', 'idempotencyExpiresAt', 'attemptId',
				'attemptVersion', 'issuedAt', 'targets', 'providerPreconditions'
			]::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'approvalBinding',
			ARRAY[
				'decisionId', 'userId', 'agentId', 'runId', 'capabilityId',
				'capabilityFingerprint', 'disclosureGrantId', 'payloadHash',
				'idempotencyTtlMs', 'authorityBinding'
			]::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input #> '{approvalBinding,authorityBinding}',
			ARRAY[
				'kind', 'householdId', 'privateSpaceId',
				'authorizationScopeFingerprint', 'providerGrantReference',
				'authorizationEpoch'
			]::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'event',
			ARRAY[
				'proposalId', 'eventType', 'occurredAt', 'decisionId',
				'actorUserId', 'authenticatedSessionId', 'approvalHash',
				'decisionIdempotencyKey', 'providerIdempotencyKey',
				'attemptId', 'attemptVersion'
			]::text[]
		)
		OR p_input -> 'approvalBinding' IS DISTINCT FROM
			p_input #> '{authorization,approvalBinding}'
	THEN
		RETURN 'conflict';
	END IF;
	IF NOT emdo.issue_workflow_operation_claim(
		p_operation_id,
		p_input -> 'scope',
		(p_input ->> 'decisionId')::uuid,
		(p_input #>> '{authorization,attemptId}')::uuid,
		p_input ->> 'bindingHash',
		NULL,
		p_input #>> '{next,providerAuthorityBindingHash}',
		p_input
	) THEN
		RETURN 'conflict';
	END IF;
	v_mutation_hash := emdo.provider_proposal_mutation_hash(
		'provider-write-prepare', p_input
	);
	SELECT claim.* INTO v_claim
	FROM emdo.workflow_operation_claims AS claim
	WHERE claim.operation_id = p_operation_id
	FOR UPDATE OF claim;
	IF NOT FOUND
		OR v_claim.phase IS DISTINCT FROM 'provider-write-prepare'
		OR v_claim.mutation_hash IS DISTINCT FROM v_mutation_hash
	THEN
		RETURN 'conflict';
	END IF;
	v_proposal_id := (p_input #>> '{expected,proposalId}')::uuid;
	v_attempt_id := (p_input #>> '{authorization,attemptId}')::uuid;
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(v_proposal_id::text, 0)
	);
	IF v_claim.claimed_at IS NOT NULL THEN
		SELECT ROW(proposal.*)::emdo.action_proposals AS proposal_row,
			ROW(state.*)::emdo.proposal_states AS state_row,
			ROW(preparation.*)::emdo.proposal_preparations AS preparation_row,
			ROW(decision.*)::emdo.action_decisions AS decision_row,
			ROW(attempt.*)::emdo.provider_attempts AS attempt_row
		INTO v_locked
		FROM emdo.action_proposals AS proposal
		JOIN emdo.proposal_states AS state ON state.proposal_id = proposal.id
		JOIN emdo.proposal_preparations AS preparation
			ON preparation.proposal_id = proposal.id
		JOIN emdo.action_decisions AS decision
			ON decision.proposal_id = proposal.id
		JOIN emdo.provider_attempts AS attempt
			ON attempt.proposal_id = proposal.id
		WHERE proposal.id = v_proposal_id
			AND decision.id = v_claim.decision_id
			AND attempt.id = v_attempt_id
		FOR UPDATE OF proposal, state, preparation, decision, attempt;
		IF NOT FOUND THEN
			RETURN 'conflict';
		END IF;
		v_proposal := v_locked.proposal_row;
		v_state := v_locked.state_row;
		v_attempt := v_locked.attempt_row;
		RETURN CASE WHEN
			v_state.version = (p_input #>> '{next,version}')::integer
			AND v_state.state = 'prepared'
			AND emdo.proposal_row_matches_input(
				v_proposal, v_state.version, 'prepared', p_input -> 'next'
			)
			AND v_attempt.decision_id = (p_input ->> 'decisionId')::uuid
			AND v_attempt.binding_hash = p_input ->> 'bindingHash'
			AND v_attempt.attempt_state = 'prepared'
			AND v_attempt."authorization" = p_input -> 'authorization'
			AND v_attempt.approval_binding = p_input -> 'approvalBinding'
			AND EXISTS (
				SELECT 1 FROM emdo.proposal_events AS event
				WHERE event.proposal_id = v_proposal_id
					AND event.proposal_version = v_state.version
					AND event.event_type = 'proposal.prepared'
					AND event.payload = p_input -> 'event'
			)
		THEN 'duplicate' ELSE 'conflict' END;
	END IF;
	SELECT ROW(proposal.*)::emdo.action_proposals AS proposal_row,
		ROW(state.*)::emdo.proposal_states AS state_row,
		ROW(preparation.*)::emdo.proposal_preparations AS preparation_row,
		ROW(decision.*)::emdo.action_decisions AS decision_row
	INTO v_locked
	FROM emdo.action_proposals AS proposal
	JOIN emdo.proposal_states AS state ON state.proposal_id = proposal.id
	JOIN emdo.proposal_preparations AS preparation
		ON preparation.proposal_id = proposal.id
	JOIN emdo.action_decisions AS decision
		ON decision.proposal_id = proposal.id
	WHERE proposal.id = v_proposal_id
		AND decision.id = v_claim.decision_id
	FOR UPDATE OF proposal, state, preparation, decision;
	IF NOT FOUND THEN
		RETURN 'conflict';
	END IF;
	v_proposal := v_locked.proposal_row;
	v_state := v_locked.state_row;
	v_preparation := v_locked.preparation_row;
	v_decision := v_locked.decision_row;
	v_expected_version := (p_input #>> '{expected,version}')::integer;
	v_expected_state := p_input #>> '{expected,state}';
	v_expected_approval_hash := p_input #>> '{expected,approvalHash}';
	v_next_version := (p_input #>> '{next,version}')::integer;
	v_issued_at := (p_input #>> '{authorization,issuedAt}')::timestamptz;
	v_expires_at := (p_input #>> '{authorization,expiresAt}')::timestamptz;
	v_idempotency_expires_at :=
		(p_input #>> '{authorization,idempotencyExpiresAt}')::timestamptz;
	v_event_at := (p_input #>> '{event,occurredAt}')::timestamptz;
	v_now := pg_catalog.clock_timestamp();
	IF p_input -> 'scope' IS DISTINCT FROM v_claim.scope_assertion
		OR v_claim.proposal_id IS DISTINCT FROM v_proposal_id
		OR v_claim.household_id IS DISTINCT FROM v_proposal.household_id
		OR v_claim.space_id IS DISTINCT FROM v_proposal.space_id
		OR v_claim.original_owner_user_id IS DISTINCT FROM
			v_proposal.original_owner_user_id
		OR v_claim.run_id IS DISTINCT FROM v_proposal.run_id
		OR v_claim.disclosure_grant_id IS DISTINCT FROM
			v_proposal.disclosure_grant_id
		OR v_claim.provider_sdk_call_id IS DISTINCT FROM
			v_proposal.provider_sdk_call_id
		OR v_claim.decision_id IS DISTINCT FROM (p_input ->> 'decisionId')::uuid
		OR v_claim.provider_attempt_id IS DISTINCT FROM v_attempt_id
		OR v_claim.binding_hash IS DISTINCT FROM p_input ->> 'bindingHash'
		OR v_claim.provider_authority_binding_hash IS DISTINCT FROM
			v_proposal.provider_authority_binding_hash
		OR v_claim.authorization_scope_fingerprint IS DISTINCT FROM
			v_proposal.authorization_scope_fingerprint
		OR v_claim.preparation_binding_hash IS DISTINCT FROM
			v_preparation.preparation_binding_hash
		OR v_state.version IS DISTINCT FROM v_expected_version
		OR v_state.state IS DISTINCT FROM v_expected_state
		OR v_expected_state IS DISTINCT FROM 'approved'
		OR v_proposal.approval_hash IS DISTINCT FROM v_expected_approval_hash
		OR v_next_version IS DISTINCT FROM v_expected_version + 1
		OR NOT emdo.proposal_row_matches_input(
			v_proposal, v_next_version, 'prepared', p_input -> 'next'
		)
		OR v_preparation.abandonment_reason IS NOT NULL
		OR v_decision.decision IS DISTINCT FROM 'approved'
		OR v_decision.channel IS DISTINCT FROM 'authenticated-visual'
		OR v_decision.authenticated_session_id IS DISTINCT FROM
			v_claim.authenticated_session_id
		OR v_decision.approval_hash IS DISTINCT FROM v_proposal.approval_hash
		OR v_decision.payload_hash IS DISTINCT FROM v_proposal.payload_hash
		OR p_input #>> '{authorization,proposalId}' IS DISTINCT FROM
			v_proposal.id::text
		OR p_input #>> '{authorization,approvalHash}' IS DISTINCT FROM
			v_proposal.approval_hash
		OR p_input #>> '{authorization,approvalBindingHash}' IS DISTINCT FROM
			v_claim.binding_hash
		OR p_input #>> '{authorization,capabilityFingerprint}' IS DISTINCT FROM
			v_proposal.capability_fingerprint
		OR (p_input #>> '{authorization,proposalCreatedAt}')::timestamptz
			IS DISTINCT FROM v_proposal.created_at
		OR v_expires_at IS DISTINCT FROM v_proposal.expires_at
		OR p_input #>> '{authorization,disclosureGrantId}' IS DISTINCT FROM
			v_proposal.disclosure_grant_id::text
		OR p_input #>> '{authorization,disclosureGrantHash}' IS DISTINCT FROM
			v_claim.disclosure_grant_hash
		OR (p_input #>> '{authorization,providerIdempotencyKey}' ~
			'^[a-f0-9]{64}$') IS DISTINCT FROM true
		OR (p_input #>> '{authorization,attemptVersion}')::integer
			IS DISTINCT FROM 1
		OR p_input #> '{authorization,targets}' IS DISTINCT FROM v_proposal.targets
		OR p_input #> '{authorization,providerPreconditions}' IS DISTINCT FROM
			v_proposal.provider_preconditions
		OR emdo.canonical_json_hash(
			pg_catalog.jsonb_build_object(
				'domain', 'emdo.provider-write-approval-binding.v1',
				'binding', p_input -> 'approvalBinding'
			)
		) IS DISTINCT FROM v_claim.binding_hash
		OR emdo.canonical_json_hash(
			p_input #> '{approvalBinding,authorityBinding}'
		) IS DISTINCT FROM v_claim.provider_authority_binding_hash
		OR p_input #>> '{approvalBinding,decisionId}' IS DISTINCT FROM
			v_decision.id::text
		OR p_input #>> '{approvalBinding,userId}' IS DISTINCT FROM
			v_proposal.original_owner_user_id::text
		OR p_input #>> '{approvalBinding,agentId}' IS DISTINCT FROM
			v_preparation.preparation_binding ->> 'agentId'
		OR p_input #>> '{approvalBinding,runId}' IS DISTINCT FROM
			v_proposal.run_id::text
		OR p_input #>> '{approvalBinding,capabilityId}' IS DISTINCT FROM
			v_proposal.capability_id
		OR p_input #>> '{approvalBinding,capabilityFingerprint}' IS DISTINCT FROM
			v_proposal.capability_fingerprint
		OR p_input #>> '{approvalBinding,disclosureGrantId}' IS DISTINCT FROM
			v_proposal.disclosure_grant_id::text
		OR p_input #>> '{approvalBinding,payloadHash}' IS DISTINCT FROM
			v_proposal.payload_hash
		OR p_input #>> '{approvalBinding,authorityBinding,kind}' IS DISTINCT FROM
			'google-calendar-grant-v2'
		OR p_input #>> '{approvalBinding,authorityBinding,householdId}'
			IS DISTINCT FROM v_proposal.household_id::text
		OR p_input #>>
			'{approvalBinding,authorityBinding,authorizationScopeFingerprint}'
			IS DISTINCT FROM v_proposal.authorization_scope_fingerprint
		OR p_input #>>
			'{approvalBinding,authorityBinding,authorizationScopeFingerprint}'
			IS DISTINCT FROM v_claim.authorization_scope_fingerprint
		OR (p_input #>> '{approvalBinding,authorityBinding,authorizationEpoch}'
			~ '^[0-9]+$') IS DISTINCT FROM true
		OR v_issued_at IS NULL
		OR v_idempotency_expires_at IS NULL
		OR v_issued_at IS DISTINCT FROM v_claim.active_at
		OR v_issued_at < v_proposal.created_at
		OR v_issued_at < v_decision.decided_at
		OR v_issued_at > v_now
		OR v_expires_at <= v_issued_at
		OR v_idempotency_expires_at <= v_issued_at
		OR (p_input #>> '{approvalBinding,idempotencyTtlMs}')::bigint
			IS DISTINCT FROM (
				extract(
					EPOCH FROM (v_idempotency_expires_at - v_issued_at)
				) * 1000
			)::bigint
		OR v_event_at IS DISTINCT FROM v_issued_at
		OR p_input #>> '{event,proposalId}' IS DISTINCT FROM v_proposal.id::text
		OR p_input #>> '{event,eventType}' IS DISTINCT FROM 'proposal.prepared'
		OR p_input #>> '{event,decisionId}' IS DISTINCT FROM v_decision.id::text
		OR p_input #>> '{event,actorUserId}' IS DISTINCT FROM
			v_decision.original_owner_user_id::text
		OR p_input #>> '{event,authenticatedSessionId}' IS DISTINCT FROM
			v_decision.authenticated_session_id::text
		OR p_input #>> '{event,approvalHash}' IS DISTINCT FROM
			v_decision.approval_hash
		OR p_input #>> '{event,decisionIdempotencyKey}' IS DISTINCT FROM
			v_decision.idempotency_key
		OR p_input #>> '{event,providerIdempotencyKey}' IS DISTINCT FROM
			p_input #>> '{authorization,providerIdempotencyKey}'
		OR p_input #>> '{event,attemptId}' IS DISTINCT FROM v_attempt_id::text
		OR (p_input #>> '{event,attemptVersion}')::integer IS DISTINCT FROM 1
	THEN
		RETURN 'conflict';
	END IF;
	IF NOT emdo.claim_workflow_operation_scope(p_operation_id) THEN
		RETURN 'conflict';
	END IF;
	SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
	INTO v_sequence
	FROM emdo.proposal_events AS event
	WHERE event.proposal_id = v_proposal_id;
	UPDATE emdo.proposal_states AS state
	SET version = v_next_version, state = 'prepared', updated_at = v_now
	WHERE state.proposal_id = v_proposal_id
		AND state.version = v_expected_version
		AND state.state = v_expected_state;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = 'P0001',
			MESSAGE = 'proposal state CAS failed';
	END IF;
	INSERT INTO emdo.provider_attempts(
		id, proposal_id, decision_id, household_id, space_id,
		original_owner_user_id, attempt_version, attempt_state, binding_hash,
		capability_fingerprint, approval_hash, disclosure_grant_id,
		disclosure_grant_hash, provider_id, provider_idempotency_key,
		idempotency_expires_at, target_set_hash, targets,
		provider_preconditions, issued_at, expires_at, dispatched_at,
		"authorization", approval_binding, provider_authority_binding_hash,
		provider_sdk_call_id
	) VALUES (
		v_attempt_id, v_proposal.id, v_decision.id, v_proposal.household_id,
		v_proposal.space_id, v_proposal.original_owner_user_id, 1, 'prepared',
		v_claim.binding_hash, v_proposal.capability_fingerprint,
		v_proposal.approval_hash, v_proposal.disclosure_grant_id,
		v_claim.disclosure_grant_hash, 'google-calendar',
		p_input #>> '{authorization,providerIdempotencyKey}',
		v_idempotency_expires_at,
		emdo.canonical_json_hash(p_input #> '{authorization,targets}'),
		p_input #> '{authorization,targets}',
		p_input #> '{authorization,providerPreconditions}',
		v_issued_at, v_expires_at, NULL, p_input -> 'authorization',
		p_input -> 'approvalBinding', v_claim.provider_authority_binding_hash,
		v_claim.provider_sdk_call_id
	);
	INSERT INTO emdo.proposal_events(
		proposal_id, household_id, space_id, original_owner_user_id,
		proposal_version, sequence, event_type, payload, occurred_at
	) VALUES (
		v_proposal.id, v_proposal.household_id, v_proposal.space_id,
		v_proposal.original_owner_user_id, v_next_version, v_sequence,
		'proposal.prepared', p_input -> 'event', v_event_at
	);
	RETURN 'created';
EXCEPTION
	WHEN data_exception OR integrity_constraint_violation OR raise_exception THEN
		RETURN 'conflict';
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."commit_provider_proposal_transition"(
	p_input jsonb
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_proposal emdo.action_proposals%ROWTYPE;
	v_state emdo.proposal_states%ROWTYPE;
	v_preparation emdo.proposal_preparations%ROWTYPE;
	v_locked record;
	v_proposal_id uuid;
	v_expected_version integer;
	v_expected_state text;
	v_expected_approval_hash text;
	v_next_version integer;
	v_event_at timestamptz;
	v_now timestamptz;
	v_sequence integer;
BEGIN
	IF p_input IS NULL
		OR pg_catalog.octet_length(p_input::text) > 524288
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input, ARRAY['expected', 'next', 'event']::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'expected',
			ARRAY['proposalId', 'version', 'state', 'approvalHash']::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'event',
			ARRAY['proposalId', 'eventType', 'occurredAt']::text[]
		)
	THEN
		RETURN 'conflict';
	END IF;
	v_proposal_id := (p_input #>> '{expected,proposalId}')::uuid;
	v_expected_version := (p_input #>> '{expected,version}')::integer;
	v_expected_state := p_input #>> '{expected,state}';
	v_expected_approval_hash := p_input #>> '{expected,approvalHash}';
	v_next_version := (p_input #>> '{next,version}')::integer;
	v_event_at := (p_input #>> '{event,occurredAt}')::timestamptz;
	v_now := pg_catalog.clock_timestamp();
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(v_proposal_id::text, 0)
	);
	SELECT ROW(proposal.*)::emdo.action_proposals AS proposal_row,
		ROW(state.*)::emdo.proposal_states AS state_row,
		ROW(preparation.*)::emdo.proposal_preparations AS preparation_row
	INTO v_locked
	FROM emdo.action_proposals AS proposal
	JOIN emdo.proposal_states AS state ON state.proposal_id = proposal.id
	JOIN emdo.proposal_preparations AS preparation
		ON preparation.proposal_id = proposal.id
	WHERE proposal.id = v_proposal_id
	FOR UPDATE OF proposal, state, preparation;
	IF NOT FOUND THEN
		RETURN 'conflict';
	END IF;
	v_proposal := v_locked.proposal_row;
	v_state := v_locked.state_row;
	v_preparation := v_locked.preparation_row;
	IF v_state.version = v_next_version AND v_state.state = 'expired' THEN
		RETURN CASE WHEN
			emdo.proposal_row_matches_input(
				v_proposal, v_next_version, 'expired', p_input -> 'next'
			)
			AND EXISTS (
				SELECT 1 FROM emdo.proposal_events AS event
				WHERE event.proposal_id = v_proposal_id
					AND event.proposal_version = v_next_version
					AND event.event_type = 'proposal.expired'
					AND event.occurred_at = v_event_at
					AND event.payload = p_input -> 'event'
			)
		THEN 'duplicate' ELSE 'conflict' END;
	END IF;
	IF v_state.version IS DISTINCT FROM v_expected_version
		OR v_state.state IS DISTINCT FROM v_expected_state
		OR v_proposal.approval_hash IS DISTINCT FROM v_expected_approval_hash
		OR v_expected_state NOT IN ('pending', 'approved')
		OR v_next_version IS DISTINCT FROM v_expected_version + 1
		OR v_proposal.expires_at > v_now
		OR v_event_at < v_proposal.expires_at
		OR v_event_at > v_now
		OR NOT emdo.proposal_row_matches_input(
			v_proposal, v_next_version, 'expired', p_input -> 'next'
		)
		OR p_input #>> '{event,proposalId}' IS DISTINCT FROM v_proposal_id::text
		OR p_input #>> '{event,eventType}' IS DISTINCT FROM 'proposal.expired'
		OR NOT EXISTS (
			SELECT 1
			FROM emdo.workflow_operation_claims AS claim
			WHERE claim.phase = 'proposal-create'
				AND claim.claimed_at IS NOT NULL
				AND claim.proposal_id = v_proposal.id
				AND claim.household_id = v_proposal.household_id
				AND claim.space_id = v_proposal.space_id
				AND claim.original_owner_user_id =
					v_proposal.original_owner_user_id
				AND claim.run_id = v_proposal.run_id
				AND claim.disclosure_grant_id = v_proposal.disclosure_grant_id
				AND claim.provider_sdk_call_id = v_proposal.provider_sdk_call_id
				AND claim.provider_authority_binding_hash =
					v_proposal.provider_authority_binding_hash
				AND claim.authorization_scope_fingerprint =
					v_proposal.authorization_scope_fingerprint
				AND claim.preparation_binding_hash =
					v_preparation.preparation_binding_hash
		)
	THEN
		RETURN 'conflict';
	END IF;
	SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
	INTO v_sequence
	FROM emdo.proposal_events AS event
	WHERE event.proposal_id = v_proposal_id;
	UPDATE emdo.proposal_states AS state
	SET version = v_next_version, state = 'expired', updated_at = v_now
	WHERE state.proposal_id = v_proposal_id
		AND state.version = v_expected_version
		AND state.state = v_expected_state;
	IF NOT FOUND THEN
		RETURN 'conflict';
	END IF;
	INSERT INTO emdo.proposal_events(
		proposal_id, household_id, space_id, original_owner_user_id,
		proposal_version, sequence, event_type, payload, occurred_at
	) VALUES (
		v_proposal.id, v_proposal.household_id, v_proposal.space_id,
		v_proposal.original_owner_user_id, v_next_version, v_sequence,
		'proposal.expired', p_input -> 'event', v_event_at
	);
	RETURN 'created';
EXCEPTION
	WHEN data_exception OR integrity_constraint_violation THEN
		RETURN 'conflict';
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."commit_provider_proposal_dispatch"(
	p_operation_id text,
	p_input jsonb
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_claim emdo.workflow_operation_claims%ROWTYPE;
	v_proposal emdo.action_proposals%ROWTYPE;
	v_state emdo.proposal_states%ROWTYPE;
	v_preparation emdo.proposal_preparations%ROWTYPE;
	v_decision emdo.action_decisions%ROWTYPE;
	v_attempt emdo.provider_attempts%ROWTYPE;
	v_locked record;
	v_proposal_id uuid;
	v_attempt_id uuid;
	v_expected_version integer;
	v_expected_state text;
	v_expected_approval_hash text;
	v_next_version integer;
	v_dispatched_at timestamptz;
	v_event_at timestamptz;
	v_mutation_hash text;
	v_now timestamptz;
	v_sequence integer;
BEGIN
	IF p_operation_id IS NULL
		OR p_input IS NULL
		OR pg_catalog.octet_length(p_input::text) > 524288
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input,
			ARRAY[
				'expected', 'next', 'decisionId', 'bindingHash', 'attemptId',
				'dispatchedAt', 'scope', 'event'
			]::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'expected',
			ARRAY['proposalId', 'version', 'state', 'approvalHash']::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'event',
			ARRAY[
				'proposalId', 'eventType', 'occurredAt', 'decisionId',
				'actorUserId', 'authenticatedSessionId', 'approvalHash',
				'decisionIdempotencyKey', 'providerIdempotencyKey',
				'attemptId', 'attemptVersion'
			]::text[]
		)
	THEN
		RETURN 'conflict';
	END IF;
	IF NOT emdo.issue_workflow_operation_claim(
		p_operation_id,
		p_input -> 'scope',
		(p_input ->> 'decisionId')::uuid,
		(p_input ->> 'attemptId')::uuid,
		p_input ->> 'bindingHash',
		NULL,
		p_input #>> '{next,providerAuthorityBindingHash}',
		p_input
	) THEN
		RETURN 'conflict';
	END IF;
	v_mutation_hash := emdo.provider_proposal_mutation_hash(
		'provider-write-dispatch', p_input
	);
	SELECT claim.* INTO v_claim
	FROM emdo.workflow_operation_claims AS claim
	WHERE claim.operation_id = p_operation_id
	FOR UPDATE OF claim;
	IF NOT FOUND
		OR v_claim.phase IS DISTINCT FROM 'provider-write-dispatch'
		OR v_claim.mutation_hash IS DISTINCT FROM v_mutation_hash
	THEN
		RETURN 'conflict';
	END IF;
	v_proposal_id := (p_input #>> '{expected,proposalId}')::uuid;
	v_attempt_id := (p_input ->> 'attemptId')::uuid;
	v_dispatched_at := (p_input ->> 'dispatchedAt')::timestamptz;
	v_event_at := (p_input #>> '{event,occurredAt}')::timestamptz;
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(v_proposal_id::text, 0)
	);
	IF v_claim.claimed_at IS NOT NULL THEN
		SELECT ROW(proposal.*)::emdo.action_proposals AS proposal_row,
			ROW(state.*)::emdo.proposal_states AS state_row,
			ROW(attempt.*)::emdo.provider_attempts AS attempt_row
		INTO v_locked
		FROM emdo.action_proposals AS proposal
		JOIN emdo.proposal_states AS state ON state.proposal_id = proposal.id
		JOIN emdo.provider_attempts AS attempt
			ON attempt.proposal_id = proposal.id
		WHERE proposal.id = v_proposal_id
			AND attempt.id = v_attempt_id
		FOR UPDATE OF proposal, state, attempt;
		IF NOT FOUND THEN
			RETURN 'conflict';
		END IF;
		v_proposal := v_locked.proposal_row;
		v_state := v_locked.state_row;
		v_attempt := v_locked.attempt_row;
		RETURN CASE WHEN
			v_state.version = (p_input #>> '{next,version}')::integer
			AND v_state.state = 'executing'
			AND emdo.proposal_row_matches_input(
				v_proposal, v_state.version, 'executing', p_input -> 'next'
			)
			AND v_attempt.decision_id = (p_input ->> 'decisionId')::uuid
			AND v_attempt.binding_hash = p_input ->> 'bindingHash'
			AND v_attempt.attempt_state = 'executing'
			AND v_attempt.dispatched_at = v_dispatched_at
			AND EXISTS (
				SELECT 1 FROM emdo.proposal_events AS event
				WHERE event.proposal_id = v_proposal_id
					AND event.proposal_version = v_state.version
					AND event.event_type = 'proposal.executing'
					AND event.occurred_at = v_event_at
					AND event.payload = p_input -> 'event'
			)
		THEN 'duplicate' ELSE 'conflict' END;
	END IF;
	SELECT ROW(proposal.*)::emdo.action_proposals AS proposal_row,
		ROW(state.*)::emdo.proposal_states AS state_row,
		ROW(preparation.*)::emdo.proposal_preparations AS preparation_row,
		ROW(decision.*)::emdo.action_decisions AS decision_row,
		ROW(attempt.*)::emdo.provider_attempts AS attempt_row
	INTO v_locked
	FROM emdo.action_proposals AS proposal
	JOIN emdo.proposal_states AS state ON state.proposal_id = proposal.id
	JOIN emdo.proposal_preparations AS preparation
		ON preparation.proposal_id = proposal.id
	JOIN emdo.action_decisions AS decision
		ON decision.proposal_id = proposal.id
	JOIN emdo.provider_attempts AS attempt
		ON attempt.proposal_id = proposal.id
	WHERE proposal.id = v_proposal_id
		AND decision.id = v_claim.decision_id
		AND attempt.id = v_attempt_id
	FOR UPDATE OF proposal, state, preparation, decision, attempt;
	IF NOT FOUND THEN
		RETURN 'conflict';
	END IF;
	v_proposal := v_locked.proposal_row;
	v_state := v_locked.state_row;
	v_preparation := v_locked.preparation_row;
	v_decision := v_locked.decision_row;
	v_attempt := v_locked.attempt_row;
	v_expected_version := (p_input #>> '{expected,version}')::integer;
	v_expected_state := p_input #>> '{expected,state}';
	v_expected_approval_hash := p_input #>> '{expected,approvalHash}';
	v_next_version := (p_input #>> '{next,version}')::integer;
	v_now := pg_catalog.clock_timestamp();
	IF p_input -> 'scope' IS DISTINCT FROM v_claim.scope_assertion
		OR v_claim.proposal_id IS DISTINCT FROM v_proposal.id
		OR v_claim.household_id IS DISTINCT FROM v_proposal.household_id
		OR v_claim.space_id IS DISTINCT FROM v_proposal.space_id
		OR v_claim.original_owner_user_id IS DISTINCT FROM
			v_proposal.original_owner_user_id
		OR v_claim.run_id IS DISTINCT FROM v_proposal.run_id
		OR v_claim.disclosure_grant_id IS DISTINCT FROM
			v_proposal.disclosure_grant_id
		OR v_claim.provider_sdk_call_id IS DISTINCT FROM
			v_proposal.provider_sdk_call_id
		OR v_claim.decision_id IS DISTINCT FROM v_decision.id
		OR v_claim.provider_attempt_id IS DISTINCT FROM v_attempt.id
		OR v_claim.binding_hash IS DISTINCT FROM v_attempt.binding_hash
		OR v_claim.binding_hash IS DISTINCT FROM p_input ->> 'bindingHash'
		OR v_claim.provider_authority_binding_hash IS DISTINCT FROM
			v_attempt.provider_authority_binding_hash
		OR v_claim.authorization_scope_fingerprint IS DISTINCT FROM
			v_proposal.authorization_scope_fingerprint
		OR v_claim.preparation_binding_hash IS DISTINCT FROM
			v_preparation.preparation_binding_hash
		OR v_state.version IS DISTINCT FROM v_expected_version
		OR v_state.state IS DISTINCT FROM v_expected_state
		OR v_expected_state IS DISTINCT FROM 'prepared'
		OR v_proposal.approval_hash IS DISTINCT FROM v_expected_approval_hash
		OR v_next_version IS DISTINCT FROM v_expected_version + 1
		OR NOT emdo.proposal_row_matches_input(
			v_proposal, v_next_version, 'executing', p_input -> 'next'
		)
		OR v_preparation.abandonment_reason IS NOT NULL
		OR v_decision.decision IS DISTINCT FROM 'approved'
		OR v_decision.channel IS DISTINCT FROM 'authenticated-visual'
		OR v_decision.authenticated_session_id IS DISTINCT FROM
			v_claim.authenticated_session_id
		OR v_decision.approval_hash IS DISTINCT FROM v_proposal.approval_hash
		OR v_attempt.attempt_state IS DISTINCT FROM 'prepared'
		OR v_attempt.dispatched_at IS NOT NULL
		OR v_attempt.decision_id IS DISTINCT FROM v_decision.id
		OR v_attempt.approval_hash IS DISTINCT FROM v_proposal.approval_hash
		OR v_attempt.capability_fingerprint IS DISTINCT FROM
			v_proposal.capability_fingerprint
		OR v_attempt.disclosure_grant_hash IS DISTINCT FROM
			v_claim.disclosure_grant_hash
		OR v_attempt.provider_sdk_call_id IS DISTINCT FROM
			v_claim.provider_sdk_call_id
		OR v_attempt."authorization" #>> '{approvalBindingHash}' IS DISTINCT FROM
			v_claim.binding_hash
		OR v_dispatched_at IS NULL
		OR v_dispatched_at IS DISTINCT FROM v_claim.active_at
		OR v_event_at IS DISTINCT FROM v_dispatched_at
		OR v_dispatched_at < v_attempt.issued_at
		OR v_dispatched_at > v_now
		OR v_dispatched_at >= v_attempt.expires_at
		OR v_dispatched_at >= v_attempt.idempotency_expires_at
		OR p_input #>> '{event,proposalId}' IS DISTINCT FROM v_proposal.id::text
		OR p_input #>> '{event,eventType}' IS DISTINCT FROM 'proposal.executing'
		OR p_input #>> '{event,decisionId}' IS DISTINCT FROM v_decision.id::text
		OR p_input #>> '{event,actorUserId}' IS DISTINCT FROM
			v_decision.original_owner_user_id::text
		OR p_input #>> '{event,authenticatedSessionId}' IS DISTINCT FROM
			v_decision.authenticated_session_id::text
		OR p_input #>> '{event,approvalHash}' IS DISTINCT FROM
			v_decision.approval_hash
		OR p_input #>> '{event,decisionIdempotencyKey}' IS DISTINCT FROM
			v_decision.idempotency_key
		OR p_input #>> '{event,providerIdempotencyKey}' IS DISTINCT FROM
			v_attempt.provider_idempotency_key
		OR p_input #>> '{event,attemptId}' IS DISTINCT FROM v_attempt.id::text
		OR (p_input #>> '{event,attemptVersion}')::integer IS DISTINCT FROM
			v_attempt.attempt_version
	THEN
		RETURN 'conflict';
	END IF;
	IF NOT emdo.claim_workflow_operation_scope(p_operation_id) THEN
		RETURN 'conflict';
	END IF;
	SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
	INTO v_sequence
	FROM emdo.proposal_events AS event
	WHERE event.proposal_id = v_proposal_id;
	UPDATE emdo.provider_attempts AS attempt
	SET attempt_state = 'executing', dispatched_at = v_dispatched_at
	WHERE attempt.id = v_attempt_id
		AND attempt.attempt_state = 'prepared'
		AND attempt.dispatched_at IS NULL;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = 'P0001',
			MESSAGE = 'provider attempt CAS failed';
	END IF;
	UPDATE emdo.proposal_states AS state
	SET version = v_next_version, state = 'executing', updated_at = v_now
	WHERE state.proposal_id = v_proposal_id
		AND state.version = v_expected_version
		AND state.state = v_expected_state;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = 'P0001',
			MESSAGE = 'proposal state CAS failed';
	END IF;
	INSERT INTO emdo.proposal_events(
		proposal_id, household_id, space_id, original_owner_user_id,
		proposal_version, sequence, event_type, payload, occurred_at
	) VALUES (
		v_proposal.id, v_proposal.household_id, v_proposal.space_id,
		v_proposal.original_owner_user_id, v_next_version, v_sequence,
		'proposal.executing', p_input -> 'event', v_event_at
	);
	RETURN 'created';
EXCEPTION
	WHEN data_exception OR integrity_constraint_violation OR raise_exception THEN
		RETURN 'conflict';
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."commit_provider_proposal_completion"(
	p_input jsonb
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_proposal emdo.action_proposals%ROWTYPE;
	v_state emdo.proposal_states%ROWTYPE;
	v_preparation emdo.proposal_preparations%ROWTYPE;
	v_decision emdo.action_decisions%ROWTYPE;
	v_attempt emdo.provider_attempts%ROWTYPE;
	v_outcome emdo.provider_outcomes%ROWTYPE;
	v_locked record;
	v_proposal_id uuid;
	v_attempt_id uuid;
	v_decision_id uuid;
	v_expected_version integer;
	v_expected_state text;
	v_expected_approval_hash text;
	v_next_version integer;
	v_next_state text;
	v_mode text;
	v_prior_phase text;
	v_completed_at timestamptz;
	v_now timestamptz;
	v_sequence integer;
	v_has_outcome boolean;
	v_expected_event jsonb;
BEGIN
	IF p_input IS NULL
		OR pg_catalog.octet_length(p_input::text) > 524288
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input,
			ARRAY[
				'mode', 'expected', 'next', 'decisionId', 'bindingHash',
				'attemptId', 'completion', 'event'
			]::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'expected',
			ARRAY['proposalId', 'version', 'state', 'approvalHash']::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'completion',
			ARRAY[
				'completion', 'bindingHash', 'completionHash', 'completedAt'
			]::text[]
		)
		OR NOT emdo.provider_completion_is_valid(
			p_input #> '{completion,completion}', false
		)
		OR NOT emdo.proposal_event_has_only_known_keys(p_input -> 'event')
		OR p_input ->> 'mode' IS NULL
		OR p_input ->> 'mode' NOT IN ('pre-dispatch', 'post-dispatch')
	THEN
		RETURN 'conflict';
	END IF;
	v_proposal_id := (p_input #>> '{expected,proposalId}')::uuid;
	v_attempt_id := (p_input ->> 'attemptId')::uuid;
	v_decision_id := (p_input ->> 'decisionId')::uuid;
	v_mode := p_input ->> 'mode';
	v_prior_phase := CASE v_mode
		WHEN 'pre-dispatch' THEN 'provider-write-prepare'
		ELSE 'provider-write-dispatch'
	END;
	v_completed_at := (p_input #>> '{completion,completedAt}')::timestamptz;
	v_now := pg_catalog.clock_timestamp();
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(v_proposal_id::text, 0)
	);
	SELECT ROW(proposal.*)::emdo.action_proposals AS proposal_row,
		ROW(state.*)::emdo.proposal_states AS state_row,
		ROW(preparation.*)::emdo.proposal_preparations AS preparation_row,
		ROW(decision.*)::emdo.action_decisions AS decision_row,
		ROW(attempt.*)::emdo.provider_attempts AS attempt_row
	INTO v_locked
	FROM emdo.action_proposals AS proposal
	JOIN emdo.proposal_states AS state ON state.proposal_id = proposal.id
	JOIN emdo.proposal_preparations AS preparation
		ON preparation.proposal_id = proposal.id
	JOIN emdo.action_decisions AS decision
		ON decision.proposal_id = proposal.id
	JOIN emdo.provider_attempts AS attempt
		ON attempt.proposal_id = proposal.id
	WHERE proposal.id = v_proposal_id
		AND decision.id = v_decision_id
		AND attempt.id = v_attempt_id
	FOR UPDATE OF proposal, state, preparation, decision, attempt;
	IF NOT FOUND THEN
		RETURN 'conflict';
	END IF;
	v_proposal := v_locked.proposal_row;
	v_state := v_locked.state_row;
	v_preparation := v_locked.preparation_row;
	v_decision := v_locked.decision_row;
	v_attempt := v_locked.attempt_row;
	SELECT outcome.* INTO v_outcome
	FROM emdo.provider_outcomes AS outcome
	WHERE outcome.attempt_id = v_attempt_id;
	v_has_outcome := FOUND;
	v_expected_version := (p_input #>> '{expected,version}')::integer;
	v_expected_state := p_input #>> '{expected,state}';
	v_expected_approval_hash := p_input #>> '{expected,approvalHash}';
	v_next_version := (p_input #>> '{next,version}')::integer;
	v_next_state := p_input #>> '{next,state}';
	v_expected_event := pg_catalog.jsonb_strip_nulls(
		pg_catalog.jsonb_build_object(
			'proposalId', v_proposal.id,
			'eventType', 'proposal.' ||
				(p_input #>> '{completion,completion,state}'),
			'occurredAt', p_input #>> '{completion,completedAt}',
			'decisionId', v_decision.id,
			'actorUserId', v_decision.original_owner_user_id,
			'authenticatedSessionId', v_decision.authenticated_session_id,
			'approvalHash', v_decision.approval_hash,
			'decisionIdempotencyKey', v_decision.idempotency_key,
			'application', p_input #>> '{completion,completion,application}',
			'outcomeReason', p_input #>> '{completion,completion,reason}',
			'outputStatus', p_input #>> '{completion,completion,outputStatus}',
			'reconciliationRequired',
				p_input #> '{completion,completion,reconciliationRequired}',
			'evidenceHash', p_input #>> '{completion,completion,evidenceHash}',
			'providerIdempotencyKey', v_attempt.provider_idempotency_key,
			'attemptId', v_attempt.id,
			'attemptVersion', v_attempt.attempt_version,
			'resultHash', p_input #>> '{completion,completion,resultHash}',
			'safeErrorCode', p_input #>> '{completion,completion,safeErrorCode}'
		)
	);
	IF v_preparation.abandonment_reason IS NOT NULL
		OR v_decision.decision IS DISTINCT FROM 'approved'
		OR v_decision.channel IS DISTINCT FROM 'authenticated-visual'
		OR v_decision.approval_hash IS DISTINCT FROM v_proposal.approval_hash
		OR v_attempt.proposal_id IS DISTINCT FROM v_proposal.id
		OR v_attempt.decision_id IS DISTINCT FROM v_decision.id
		OR v_attempt.binding_hash IS DISTINCT FROM p_input ->> 'bindingHash'
		OR v_attempt."authorization" #>> '{approvalBindingHash}' IS DISTINCT FROM
			v_attempt.binding_hash
		OR v_attempt.approval_hash IS DISTINCT FROM v_proposal.approval_hash
		OR v_attempt.provider_authority_binding_hash IS DISTINCT FROM
			v_proposal.provider_authority_binding_hash
		OR p_input #>> '{completion,bindingHash}' IS DISTINCT FROM
			v_attempt.binding_hash
		OR (p_input #>> '{completion,completionHash}' ~ '^[a-f0-9]{64}$')
			IS DISTINCT FROM true
		OR p_input #>> '{completion,completionHash}' IS DISTINCT FROM
			emdo.canonical_json_hash(p_input #> '{completion,completion}')
		OR v_completed_at IS NULL
		OR v_completed_at > v_now
		OR v_completed_at < v_attempt.issued_at
		OR v_next_version IS DISTINCT FROM v_expected_version + 1
		OR v_next_state IS DISTINCT FROM
			p_input #>> '{completion,completion,state}'
		OR NOT emdo.proposal_row_matches_input(
			v_proposal, v_next_version, v_next_state, p_input -> 'next'
		)
		OR p_input -> 'event' IS DISTINCT FROM v_expected_event
		OR NOT EXISTS (
			SELECT 1
			FROM emdo.workflow_operation_claims AS claim
			WHERE claim.phase = v_prior_phase
				AND claim.claimed_at IS NOT NULL
				AND claim.proposal_id = v_proposal.id
				AND claim.household_id = v_proposal.household_id
				AND claim.space_id = v_proposal.space_id
				AND claim.original_owner_user_id =
					v_proposal.original_owner_user_id
				AND claim.run_id = v_proposal.run_id
				AND claim.disclosure_grant_id = v_proposal.disclosure_grant_id
				AND claim.decision_id = v_decision.id
				AND claim.provider_attempt_id = v_attempt.id
				AND claim.binding_hash = v_attempt.binding_hash
				AND claim.provider_sdk_call_id = v_attempt.provider_sdk_call_id
				AND claim.provider_authority_binding_hash =
					v_attempt.provider_authority_binding_hash
				AND claim.authorization_scope_fingerprint =
					v_proposal.authorization_scope_fingerprint
				AND claim.preparation_binding_hash =
					v_preparation.preparation_binding_hash
		)
	THEN
		RETURN 'conflict';
	END IF;
	IF v_has_outcome THEN
		RETURN CASE WHEN
			v_state.version = v_next_version
			AND v_state.state = v_next_state
			AND v_attempt.attempt_state = v_next_state
			AND v_outcome.completion = p_input #> '{completion,completion}'
			AND v_outcome.completion_hash =
				p_input #>> '{completion,completionHash}'
			AND v_outcome.recorded_at = v_completed_at
			AND EXISTS (
				SELECT 1 FROM emdo.proposal_events AS event
				WHERE event.proposal_id = v_proposal.id
					AND event.proposal_version = v_next_version
					AND event.event_type = 'proposal.' || v_next_state
					AND event.occurred_at = v_completed_at
					AND event.payload = p_input -> 'event'
			)
		THEN 'duplicate' ELSE 'conflict' END;
	END IF;
	IF v_state.version IS DISTINCT FROM v_expected_version
		OR v_state.state IS DISTINCT FROM v_expected_state
		OR v_proposal.approval_hash IS DISTINCT FROM v_expected_approval_hash
		OR (
			v_mode = 'pre-dispatch'
			AND (
				v_expected_state IS DISTINCT FROM 'prepared'
				OR v_attempt.attempt_state IS DISTINCT FROM 'prepared'
				OR v_attempt.dispatched_at IS NOT NULL
				OR v_next_state IS DISTINCT FROM 'not-applied'
				OR p_input #>> '{completion,completion,reason}' IS NULL
				OR p_input #>> '{completion,completion,reason}' NOT IN (
					'approval-expired-before-dispatch',
					'approval-policy-mismatch',
					'provider-rejected-before-apply'
				)
			)
		)
		OR (
			v_mode = 'post-dispatch'
			AND (
				v_expected_state IS DISTINCT FROM 'executing'
				OR v_attempt.attempt_state IS DISTINCT FROM 'executing'
				OR v_attempt.dispatched_at IS NULL
				OR v_completed_at < v_attempt.dispatched_at
			)
		)
	THEN
		RETURN 'conflict';
	END IF;
	SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
	INTO v_sequence
	FROM emdo.proposal_events AS event
	WHERE event.proposal_id = v_proposal_id;
	UPDATE emdo.provider_attempts AS attempt
	SET attempt_state = v_next_state
	WHERE attempt.id = v_attempt_id
		AND attempt.attempt_state = v_expected_state;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = 'P0001',
			MESSAGE = 'provider attempt CAS failed';
	END IF;
	UPDATE emdo.proposal_states AS state
	SET version = v_next_version, state = v_next_state, updated_at = v_now
	WHERE state.proposal_id = v_proposal_id
		AND state.version = v_expected_version
		AND state.state = v_expected_state;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = 'P0001',
			MESSAGE = 'proposal state CAS failed';
	END IF;
	INSERT INTO emdo.provider_outcomes(
		attempt_id, household_id, space_id, original_owner_user_id,
		completion_hash, application, reason, output_status, result_hash,
		evidence_hash, safe_error_code, recorded_at, completion
	) VALUES (
		v_attempt.id, v_attempt.household_id, v_attempt.space_id,
		v_attempt.original_owner_user_id,
		p_input #>> '{completion,completionHash}',
		p_input #>> '{completion,completion,application}',
		p_input #>> '{completion,completion,reason}',
		p_input #>> '{completion,completion,outputStatus}',
		p_input #>> '{completion,completion,resultHash}',
		p_input #>> '{completion,completion,evidenceHash}',
		p_input #>> '{completion,completion,safeErrorCode}',
		v_completed_at, p_input #> '{completion,completion}'
	);
	INSERT INTO emdo.proposal_events(
		proposal_id, household_id, space_id, original_owner_user_id,
		proposal_version, sequence, event_type, payload, occurred_at
	) VALUES (
		v_proposal.id, v_proposal.household_id, v_proposal.space_id,
		v_proposal.original_owner_user_id, v_next_version, v_sequence,
		'proposal.' || v_next_state, p_input -> 'event', v_completed_at
	);
	RETURN 'created';
EXCEPTION
	WHEN data_exception OR integrity_constraint_violation OR raise_exception THEN
		RETURN 'conflict';
END
$function$;
--> statement-breakpoint

-- A paused agent turn must exist before a visual decision. The decision
-- aggregate only links this immutable binding; later worker helpers own claim
-- and terminal state transitions.
CREATE TABLE "emdo"."approval_resume_jobs" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"checkpoint_id" uuid NOT NULL,
	"interruption_id" text NOT NULL,
	"proposal_id" uuid NOT NULL,
	"capability_id" text NOT NULL,
	"origin_session_id" uuid NOT NULL,
	"origin_turn_request_id" uuid NOT NULL,
	"origin_space_access_grant_id" uuid NOT NULL,
	"authorization_scope_fingerprint" text NOT NULL,
	"disclosure_grant_id" uuid NOT NULL,
	"disclosure_grant_version" integer NOT NULL,
	"disclosure_policy_version" text NOT NULL,
	"payload_hash" text NOT NULL,
	"approval_hash" text NOT NULL,
	"approval_event_sequence" bigint,
	"state" text DEFAULT 'awaiting-decision' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"claim_id" uuid,
	"ownership_token_digest" text,
	"decision_id" uuid,
	"decision_type" text,
	"authenticated_session_id" uuid,
	"resume_request_id" uuid,
	"resume_space_access_grant_id" uuid,
	"collection_authorization_scope_fingerprint" text,
	"claimed_at" timestamptz,
	"claim_expires_at" timestamptz,
	"terminal_event_sequence" bigint,
	"terminal_reason_code" text,
	"terminal_result_hash" text,
	"created_at" timestamptz NOT NULL,
	"updated_at" timestamptz NOT NULL,
	"expires_at" timestamptz NOT NULL,
	"retain_until" timestamptz NOT NULL,
	CONSTRAINT "approval_resume_jobs_checkpoint_unique" UNIQUE ("checkpoint_id"),
	CONSTRAINT "approval_resume_jobs_proposal_unique" UNIQUE ("proposal_id"),
	CONSTRAINT "approval_resume_jobs_claim_unique" UNIQUE ("claim_id"),
	CONSTRAINT "approval_resume_jobs_ownership_digest_unique"
		UNIQUE ("ownership_token_digest"),
	CONSTRAINT "approval_resume_jobs_decision_unique" UNIQUE ("decision_id"),
	CONSTRAINT "approval_resume_jobs_resume_request_unique"
		UNIQUE ("resume_request_id"),
	CONSTRAINT "approval_resume_jobs_resume_grant_unique"
		UNIQUE ("resume_space_access_grant_id"),
	CONSTRAINT "approval_resume_jobs_proposal_fk" FOREIGN KEY (
		"household_id", "space_id", "user_id", "proposal_id"
	) REFERENCES "emdo"."action_proposals" (
		"household_id", "space_id", "original_owner_user_id", "id"
	) ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "approval_resume_jobs_run_fk" FOREIGN KEY (
		"household_id", "space_id", "user_id", "run_id"
	) REFERENCES "emdo"."agent_runs" (
		"household_id", "space_id", "original_owner_user_id", "id"
	) ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "approval_resume_jobs_disclosure_grant_fk" FOREIGN KEY (
		"household_id", "space_id", "user_id", "disclosure_grant_id"
	) REFERENCES "emdo"."disclosure_grants" (
		"household_id", "space_id", "user_id", "id"
	) ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "approval_resume_jobs_checkpoint_fk" FOREIGN KEY (
		"checkpoint_id"
	) REFERENCES "emdo"."approval_checkpoints" ("checkpoint_id")
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "approval_resume_jobs_origin_session_fk" FOREIGN KEY (
		"origin_session_id"
	) REFERENCES "emdo"."auth_sessions" ("id")
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "approval_resume_jobs_origin_grant_fk" FOREIGN KEY (
		"origin_space_access_grant_id"
	) REFERENCES "emdo"."space_access_grants" ("grant_id")
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "approval_resume_jobs_decision_fk" FOREIGN KEY (
		"decision_id"
	) REFERENCES "emdo"."action_decisions" ("id")
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "approval_resume_jobs_authenticated_session_fk" FOREIGN KEY (
		"authenticated_session_id"
	) REFERENCES "emdo"."auth_sessions" ("id")
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "approval_resume_jobs_resume_grant_fk" FOREIGN KEY (
		"resume_space_access_grant_id"
	) REFERENCES "emdo"."space_access_grants" ("grant_id")
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "approval_resume_jobs_approval_event_fk" FOREIGN KEY (
		"run_id", "approval_event_sequence"
	) REFERENCES "emdo"."agent_run_events" ("run_id", "sequence")
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "approval_resume_jobs_terminal_event_fk" FOREIGN KEY (
		"run_id", "terminal_event_sequence"
	) REFERENCES "emdo"."agent_run_events" ("run_id", "sequence")
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "approval_resume_jobs_binding_check" CHECK (
		"authorization_scope_fingerprint" ~ '^[a-f0-9]{64}$'
		AND (
			"collection_authorization_scope_fingerprint" IS NULL
			OR "collection_authorization_scope_fingerprint" ~ '^[a-f0-9]{64}$'
		)
		AND "payload_hash" ~ '^[a-f0-9]{64}$'
		AND "approval_hash" ~ '^[a-f0-9]{64}$'
		AND "disclosure_grant_version" > 0
		AND pg_catalog.length("interruption_id") BETWEEN 1 AND 512
		AND "interruption_id" !~ '[[:cntrl:]]'
		AND pg_catalog.length("capability_id") BETWEEN 1 AND 200
		AND "capability_id" !~ '[[:cntrl:]]'
	),
	CONSTRAINT "approval_resume_jobs_revision_check" CHECK ("revision" > 0),
	CONSTRAINT "approval_resume_jobs_disclosure_policy_version_check" CHECK (
		pg_catalog.length("disclosure_policy_version") BETWEEN 5 AND 64
		AND "disclosure_policy_version"
			~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
	),
	CONSTRAINT "approval_resume_jobs_decision_check" CHECK (
		("decision_id" IS NULL AND "decision_type" IS NULL)
		OR (
			"decision_id" IS NOT NULL
			AND "decision_type" IN ('approved', 'rejected')
		)
	),
	CONSTRAINT "approval_resume_jobs_state_check" CHECK (
		(
			"state" = 'awaiting-decision'
			AND "decision_id" IS NULL
			AND "authenticated_session_id" IS NULL
			AND "claim_id" IS NULL
			AND "ownership_token_digest" IS NULL
			AND "resume_request_id" IS NULL
			AND "resume_space_access_grant_id" IS NULL
			AND "collection_authorization_scope_fingerprint" IS NULL
			AND "claimed_at" IS NULL
			AND "claim_expires_at" IS NULL
			AND "terminal_event_sequence" IS NULL
			AND "terminal_reason_code" IS NULL
			AND "terminal_result_hash" IS NULL
		)
		OR (
			"state" = 'ready'
			AND "decision_id" IS NOT NULL
			AND "authenticated_session_id" IS NOT NULL
			AND "claim_id" IS NULL
			AND "ownership_token_digest" IS NULL
			AND "resume_request_id" IS NULL
			AND "resume_space_access_grant_id" IS NULL
			AND "collection_authorization_scope_fingerprint" IS NULL
			AND "claimed_at" IS NULL
			AND "claim_expires_at" IS NULL
			AND "terminal_event_sequence" IS NULL
			AND "terminal_reason_code" IS NULL
			AND "terminal_result_hash" IS NULL
		)
		OR (
			"state" = 'claimed'
			AND "decision_id" IS NOT NULL
			AND "authenticated_session_id" IS NOT NULL
			AND "claim_id" IS NOT NULL
			AND "ownership_token_digest" ~ '^[a-f0-9]{64}$'
			AND "resume_request_id" IS NOT NULL
			AND "resume_space_access_grant_id" IS NOT NULL
			AND "collection_authorization_scope_fingerprint" ~ '^[a-f0-9]{64}$'
			AND "claimed_at" IS NOT NULL
			AND "claim_expires_at" IS NOT NULL
			AND "terminal_event_sequence" IS NULL
			AND "terminal_reason_code" IS NULL
			AND "terminal_result_hash" IS NULL
		)
		OR (
			"state" = 'terminal'
			AND "decision_id" IS NOT NULL
			AND "authenticated_session_id" IS NOT NULL
			AND "claim_id" IS NOT NULL
			AND "ownership_token_digest" ~ '^[a-f0-9]{64}$'
			AND "resume_request_id" IS NOT NULL
			AND "resume_space_access_grant_id" IS NOT NULL
			AND "collection_authorization_scope_fingerprint" ~ '^[a-f0-9]{64}$'
			AND "claimed_at" IS NOT NULL
			AND "claim_expires_at" IS NOT NULL
			AND "terminal_event_sequence" > 0
			AND (
				"terminal_reason_code" IS NULL
				OR "terminal_reason_code" = 'approval-resume-binding-invalid'
			)
			AND "terminal_result_hash" ~ '^[a-f0-9]{64}$'
		)
		OR (
			"state" = 'indeterminate'
			AND "decision_id" IS NOT NULL
			AND "authenticated_session_id" IS NOT NULL
			AND "claim_id" IS NOT NULL
			AND "ownership_token_digest" ~ '^[a-f0-9]{64}$'
			AND "resume_request_id" IS NOT NULL
			AND "resume_space_access_grant_id" IS NOT NULL
			AND "collection_authorization_scope_fingerprint" ~ '^[a-f0-9]{64}$'
			AND "claimed_at" IS NOT NULL
			AND "claim_expires_at" IS NOT NULL
			AND "terminal_event_sequence" > 0
			AND "terminal_reason_code" = 'approval-resume-failed'
			AND "terminal_result_hash" ~ '^[a-f0-9]{64}$'
		)
	),
	CONSTRAINT "approval_resume_jobs_claim_lifetime_check" CHECK (
		(
			"claimed_at" IS NULL
			AND "claim_expires_at" IS NULL
		)
		OR (
			"claimed_at" IS NOT NULL
			AND "claim_expires_at" > "claimed_at"
			AND "claim_expires_at" <= "claimed_at" + interval '10 minutes'
		)
	),
	CONSTRAINT "approval_resume_jobs_lifetime_check" CHECK (
		"updated_at" >= "created_at"
		AND "expires_at" > "created_at"
		AND "expires_at" <= "created_at" + interval '10 minutes'
		AND "retain_until" > "created_at"
		AND "retain_until" <= "created_at" + interval '90 days'
	)
);
CREATE INDEX "approval_resume_jobs_household_space_idx"
	ON "emdo"."approval_resume_jobs" ("household_id", "space_id");
CREATE INDEX "approval_resume_jobs_state_expiry_idx"
	ON "emdo"."approval_resume_jobs" ("state", "expires_at", "job_id");
ALTER TABLE "emdo"."approval_resume_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."approval_resume_jobs" FORCE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION "emdo"."enforce_approval_resume_job_transition"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'approval resume jobs are append-preserving';
	END IF;
	IF (pg_catalog.to_jsonb(NEW)
		- 'state' - 'revision' - 'decision_id' - 'decision_type'
		- 'authenticated_session_id' - 'claim_id' - 'ownership_token_digest'
		- 'resume_request_id' - 'resume_space_access_grant_id'
		- 'collection_authorization_scope_fingerprint' - 'claimed_at'
		- 'claim_expires_at' - 'terminal_event_sequence'
		- 'terminal_reason_code' - 'terminal_result_hash' - 'updated_at')
		IS DISTINCT FROM
		(pg_catalog.to_jsonb(OLD)
		- 'state' - 'revision' - 'decision_id' - 'decision_type'
		- 'authenticated_session_id' - 'claim_id' - 'ownership_token_digest'
		- 'resume_request_id' - 'resume_space_access_grant_id'
		- 'collection_authorization_scope_fingerprint' - 'claimed_at'
		- 'claim_expires_at' - 'terminal_event_sequence'
		- 'terminal_reason_code' - 'terminal_result_hash' - 'updated_at')
		OR NEW.revision <> OLD.revision + 1
		OR NOT (
			(OLD.state = 'awaiting-decision' AND NEW.state = 'ready')
			OR (OLD.state = 'ready' AND NEW.state = 'claimed')
			OR (
				OLD.state = 'claimed'
				AND NEW.state IN ('terminal', 'indeterminate')
			)
		)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'invalid approval resume job transition';
	END IF;
	NEW.updated_at := pg_catalog.clock_timestamp();
	RETURN NEW;
END
$function$;
CREATE TRIGGER approval_resume_jobs_transition
BEFORE UPDATE OR DELETE ON "emdo"."approval_resume_jobs"
FOR EACH ROW EXECUTE FUNCTION "emdo"."enforce_approval_resume_job_transition"();
--> statement-breakpoint
DO $approval_resume_roles$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_approval_resume_executor'
	) THEN
		CREATE ROLE emdo_approval_resume_executor NOLOGIN NOSUPERUSER NOCREATEDB
			NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$approval_resume_roles$;
ALTER ROLE emdo_approval_resume_executor NOLOGIN NOSUPERUSER NOCREATEDB
	NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
DO $approval_resume_membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname = 'emdo_approval_resume_executor'
			OR child.rolname = 'emdo_approval_resume_executor'
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'approval resume executor must not have role memberships';
	END IF;
END
$approval_resume_membership_guard$;
--> statement-breakpoint
CREATE POLICY workflow_approval_resume_jobs_select
	ON "emdo"."approval_resume_jobs"
	FOR SELECT TO emdo_workflow_executor USING (true);
CREATE POLICY workflow_approval_resume_jobs_update
	ON "emdo"."approval_resume_jobs"
	FOR UPDATE TO emdo_workflow_executor USING (true) WITH CHECK (true);
CREATE POLICY workflow_visual_proofs_select
	ON "emdo"."visual_decision_proofs"
	FOR SELECT TO emdo_workflow_executor USING (true);
CREATE POLICY workflow_visual_proofs_update
	ON "emdo"."visual_decision_proofs"
	FOR UPDATE TO emdo_workflow_executor USING (true) WITH CHECK (true);
CREATE POLICY approval_resume_jobs_executor_select
	ON "emdo"."approval_resume_jobs"
	FOR SELECT TO emdo_approval_resume_executor USING (true);
CREATE POLICY approval_resume_jobs_executor_update
	ON "emdo"."approval_resume_jobs"
	FOR UPDATE TO emdo_approval_resume_executor USING (true) WITH CHECK (true);
CREATE POLICY approval_resume_checkpoints_executor_select
	ON "emdo"."approval_checkpoints"
	FOR SELECT TO emdo_approval_resume_executor USING (true);
CREATE POLICY approval_resume_checkpoints_executor_update
	ON "emdo"."approval_checkpoints"
	FOR UPDATE TO emdo_approval_resume_executor USING (true) WITH CHECK (true);
CREATE POLICY approval_resume_run_events_executor_select
	ON "emdo"."agent_run_events"
	FOR SELECT TO emdo_approval_resume_executor USING (true);
CREATE POLICY approval_resume_run_events_executor_insert
	ON "emdo"."agent_run_events"
	FOR INSERT TO emdo_approval_resume_executor WITH CHECK (true);
CREATE POLICY approval_resume_decisions_executor_select
	ON "emdo"."action_decisions"
	FOR SELECT TO emdo_approval_resume_executor USING (true);
CREATE POLICY approval_resume_proposals_executor_select
	ON "emdo"."action_proposals"
	FOR SELECT TO emdo_approval_resume_executor USING (true);
CREATE POLICY approval_resume_states_executor_select
	ON "emdo"."proposal_states"
	FOR SELECT TO emdo_approval_resume_executor USING (true);
CREATE POLICY approval_resume_disclosures_executor_select
	ON "emdo"."disclosure_grants"
	FOR SELECT TO emdo_approval_resume_executor USING (true);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."commit_provider_proposal_decision"(
	p_operation_id text,
	p_input jsonb
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_claim emdo.workflow_operation_claims%ROWTYPE;
	v_proposal emdo.action_proposals%ROWTYPE;
	v_state emdo.proposal_states%ROWTYPE;
	v_preparation emdo.proposal_preparations%ROWTYPE;
	v_proof emdo.visual_decision_proofs%ROWTYPE;
	v_resume emdo.approval_resume_jobs%ROWTYPE;
	v_existing_decision emdo.action_decisions%ROWTYPE;
	v_locked record;
	v_scope record;
	v_proposal_id uuid;
	v_decision_id uuid;
	v_expected_version integer;
	v_expected_state text;
	v_expected_approval_hash text;
	v_next_version integer;
	v_next_state text;
	v_decided_at timestamptz;
	v_now timestamptz;
	v_sequence integer;
	v_mutation_hash text;
	v_expected_event jsonb;
	v_expected_issuance_fingerprint text;
	v_has_decision boolean;
BEGIN
	IF p_operation_id IS NULL OR p_input IS NULL
		OR pg_catalog.octet_length(p_input::text) > 524288
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input,
			ARRAY[
				'expected', 'next', 'decision', 'scope', 'event',
				'visualDecisionProofHash'
			]::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'expected',
			ARRAY['proposalId', 'version', 'state', 'approvalHash']::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'decision',
			ARRAY[
				'schemaVersion', 'id', 'proposalId', 'userId',
				'authenticatedSessionId', 'payloadHash', 'approvalHash',
				'decision', 'channel', 'decidedAt', 'idempotencyKey'
			]::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'event',
			ARRAY[
				'proposalId', 'eventType', 'occurredAt', 'decisionId',
				'actorUserId', 'authenticatedSessionId', 'approvalHash',
				'decisionIdempotencyKey'
			]::text[]
		)
		OR (p_input ->> 'visualDecisionProofHash' ~ '^[a-f0-9]{64}$')
			IS DISTINCT FROM true
		OR p_input #>> '{decision,decision}' NOT IN ('approved', 'rejected')
	THEN
		RETURN 'conflict';
	END IF;
	IF NOT emdo.issue_workflow_operation_claim(
		p_operation_id,
		p_input -> 'scope',
		(p_input #>> '{decision,id}')::uuid,
		NULL,
		NULL,
		NULL,
		p_input #>> '{next,providerAuthorityBindingHash}',
		p_input
	) THEN
		RETURN 'conflict';
	END IF;
	v_mutation_hash := emdo.provider_proposal_mutation_hash(
		'visual-decision', p_input
	);
	SELECT claim.* INTO v_claim
	FROM emdo.workflow_operation_claims AS claim
	WHERE claim.operation_id = p_operation_id
	FOR UPDATE OF claim;
	IF NOT FOUND
		OR v_claim.phase IS DISTINCT FROM 'visual-decision'
		OR v_claim.mutation_hash IS DISTINCT FROM v_mutation_hash
	THEN
		RETURN 'conflict';
	END IF;
	v_proposal_id := (p_input #>> '{expected,proposalId}')::uuid;
	v_decision_id := (p_input #>> '{decision,id}')::uuid;
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			v_claim.user_id::text || ':' || v_proposal_id::text || ':' ||
				(p_input #>> '{decision,idempotencyKey}'),
			0
		)
	);
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(v_proposal_id::text, 0)
	);
	SELECT ROW(proposal.*)::emdo.action_proposals AS proposal_row,
		ROW(state.*)::emdo.proposal_states AS state_row,
		ROW(preparation.*)::emdo.proposal_preparations AS preparation_row
	INTO v_locked
	FROM emdo.action_proposals AS proposal
	JOIN emdo.proposal_states AS state ON state.proposal_id = proposal.id
	JOIN emdo.proposal_preparations AS preparation
		ON preparation.proposal_id = proposal.id
	WHERE proposal.id = v_proposal_id
	FOR UPDATE OF proposal, state, preparation;
	IF NOT FOUND THEN
		RETURN 'conflict';
	END IF;
	v_proposal := v_locked.proposal_row;
	v_state := v_locked.state_row;
	v_preparation := v_locked.preparation_row;
	SELECT scope.* INTO v_scope
	FROM emdo.lock_current_authorization_scope(
		v_claim.current_space_access_grant_id, v_proposal_id, NULL
	) AS scope;
	IF NOT FOUND THEN
		RETURN 'conflict';
	END IF;
	SELECT proof.* INTO v_proof
	FROM emdo.visual_decision_proofs AS proof
	WHERE proof.token_hash = p_input ->> 'visualDecisionProofHash'
	FOR UPDATE OF proof;
	IF NOT FOUND THEN
		RETURN 'conflict';
	END IF;
	SELECT resume.* INTO v_resume
	FROM emdo.approval_resume_jobs AS resume
	WHERE resume.proposal_id = v_proposal_id
	FOR UPDATE OF resume;
	IF NOT FOUND THEN
		RETURN 'conflict';
	END IF;
	SELECT decision.* INTO v_existing_decision
	FROM emdo.action_decisions AS decision
	WHERE decision.proposal_id = v_proposal_id;
	v_has_decision := FOUND;
	v_expected_version := (p_input #>> '{expected,version}')::integer;
	v_expected_state := p_input #>> '{expected,state}';
	v_expected_approval_hash := p_input #>> '{expected,approvalHash}';
	v_next_version := (p_input #>> '{next,version}')::integer;
	v_next_state := p_input #>> '{next,state}';
	v_decided_at := (p_input #>> '{decision,decidedAt}')::timestamptz;
	v_now := pg_catalog.clock_timestamp();
	v_expected_event := pg_catalog.jsonb_build_object(
		'proposalId', v_proposal.id,
		'eventType', 'proposal.' || (p_input #>> '{decision,decision}'),
		'occurredAt', p_input #>> '{decision,decidedAt}',
		'decisionId', v_decision_id,
		'actorUserId', v_claim.user_id,
		'authenticatedSessionId', v_claim.current_session_id,
		'approvalHash', v_proposal.approval_hash,
		'decisionIdempotencyKey', p_input #>> '{decision,idempotencyKey}'
	);
	v_expected_issuance_fingerprint :=
		emdo.visual_decision_proof_issuance_fingerprint(
			v_proof.proof_id, v_proof.nonce, v_proof.key_id,
			v_proof.authorization_scope_fingerprint, v_proof.user_id,
			v_proof.session_id, v_proof.household_id, v_proof.space_id,
			v_proof.proposal_id, v_proof.proposal_version,
			v_proof.payload_hash, v_proof.approval_hash,
			v_proof.idempotency_key, v_proof.initial_request_id,
			v_proof.issued_at, v_proof.expires_at
		);
	IF p_input -> 'scope' IS DISTINCT FROM v_claim.scope_assertion
		OR v_claim.proposal_id IS DISTINCT FROM v_proposal.id
		OR v_claim.decision_id IS DISTINCT FROM v_decision_id
		OR v_claim.household_id IS DISTINCT FROM v_proposal.household_id
		OR v_claim.space_id IS DISTINCT FROM v_proposal.space_id
		OR v_claim.user_id IS DISTINCT FROM v_proposal.original_owner_user_id
		OR v_claim.run_id IS DISTINCT FROM v_proposal.run_id
		OR v_claim.disclosure_grant_id IS DISTINCT FROM
			v_proposal.disclosure_grant_id
		OR v_claim.provider_sdk_call_id IS DISTINCT FROM
			v_proposal.provider_sdk_call_id
		OR v_claim.provider_authority_binding_hash IS DISTINCT FROM
			v_proposal.provider_authority_binding_hash
		OR v_claim.authorization_scope_fingerprint IS DISTINCT FROM
			v_proposal.authorization_scope_fingerprint
		OR v_claim.preparation_binding_hash IS DISTINCT FROM
			v_preparation.preparation_binding_hash
		OR v_scope.user_id IS DISTINCT FROM v_claim.user_id
		OR v_scope.session_id IS DISTINCT FROM v_claim.current_session_id
		OR v_scope.household_id IS DISTINCT FROM v_claim.household_id
		OR v_scope.proposal_space_id IS DISTINCT FROM v_claim.space_id
		OR v_scope.authorization_scope_fingerprint IS DISTINCT FROM
			v_claim.authorization_scope_fingerprint
		OR v_expected_state IS DISTINCT FROM 'pending'
		OR v_next_version IS DISTINCT FROM v_expected_version + 1
		OR v_next_state IS DISTINCT FROM p_input #>> '{decision,decision}'
		OR v_proposal.approval_hash IS DISTINCT FROM v_expected_approval_hash
		OR NOT emdo.proposal_row_matches_input(
			v_proposal, v_next_version, v_next_state, p_input -> 'next'
		)
		OR v_preparation.abandonment_reason IS NOT NULL
		OR v_preparation.preparation_binding_hash IS DISTINCT FROM
			emdo.canonical_json_hash(pg_catalog.jsonb_build_object(
				'domain', 'emdo.provider-proposal-preparation.v1',
				'binding', v_preparation.preparation_binding
			))
		OR (p_input #>> '{decision,schemaVersion}')::smallint
			IS DISTINCT FROM 1
		OR p_input #>> '{decision,proposalId}' IS DISTINCT FROM
			v_proposal.id::text
		OR p_input #>> '{decision,userId}' IS DISTINCT FROM v_claim.user_id::text
		OR p_input #>> '{decision,authenticatedSessionId}' IS DISTINCT FROM
			v_claim.current_session_id::text
		OR p_input #>> '{decision,payloadHash}' IS DISTINCT FROM
			v_proposal.payload_hash
		OR p_input #>> '{decision,approvalHash}' IS DISTINCT FROM
			v_proposal.approval_hash
		OR p_input #>> '{decision,channel}' IS DISTINCT FROM
			'authenticated-visual'
		OR v_claim.require_active_disclosure_grant IS DISTINCT FROM
			((p_input #>> '{decision,decision}') = 'approved')
		OR v_decided_at < v_proof.issued_at
		OR v_decided_at < v_proposal.created_at
		OR v_decided_at > v_claim.active_at
		OR v_decided_at > v_now
		OR v_decided_at >= v_proposal.expires_at
		OR p_input -> 'event' IS DISTINCT FROM v_expected_event
		OR v_proof.binding_version IS DISTINCT FROM 1
		OR v_proof.issuance_fingerprint IS DISTINCT FROM
			v_expected_issuance_fingerprint
		OR v_proof.user_id IS DISTINCT FROM v_claim.user_id
		OR v_proof.session_id IS DISTINCT FROM v_claim.current_session_id
		OR v_proof.household_id IS DISTINCT FROM v_proposal.household_id
		OR v_proof.space_id IS DISTINCT FROM v_proposal.space_id
		OR v_proof.proposal_id IS DISTINCT FROM v_proposal.id
		OR v_proof.proposal_version IS DISTINCT FROM v_expected_version
		OR v_proof.payload_hash IS DISTINCT FROM v_proposal.payload_hash
		OR v_proof.approval_hash IS DISTINCT FROM v_proposal.approval_hash
		OR v_proof.channel IS DISTINCT FROM 'authenticated-visual'
		OR v_proof.authorization_scope_fingerprint IS DISTINCT FROM
			v_proposal.authorization_scope_fingerprint
		OR v_resume.household_id IS DISTINCT FROM v_proposal.household_id
		OR v_resume.space_id IS DISTINCT FROM v_proposal.space_id
		OR v_resume.user_id IS DISTINCT FROM v_proposal.original_owner_user_id
		OR v_resume.run_id IS DISTINCT FROM v_proposal.run_id
		OR v_resume.capability_id IS DISTINCT FROM v_proposal.capability_id
		OR v_resume.origin_session_id::text IS DISTINCT FROM
			v_preparation.preparation_binding ->> 'originSessionId'
		OR v_resume.origin_turn_request_id::text IS DISTINCT FROM
			v_preparation.preparation_binding ->> 'originRequestId'
		OR v_resume.origin_space_access_grant_id::text IS DISTINCT FROM
			v_preparation.preparation_binding ->> 'originSpaceAccessGrantId'
		OR v_resume.authorization_scope_fingerprint IS DISTINCT FROM
			v_proposal.authorization_scope_fingerprint
		OR v_resume.disclosure_grant_id IS DISTINCT FROM
			v_proposal.disclosure_grant_id
		OR v_resume.disclosure_grant_version::text IS DISTINCT FROM
			v_proposal.disclosure_grant ->> 'version'
		OR v_resume.payload_hash IS DISTINCT FROM v_proposal.payload_hash
		OR v_resume.approval_hash IS DISTINCT FROM v_proposal.approval_hash
	THEN
		RETURN 'conflict';
	END IF;
	IF v_proof.consumed_at IS NOT NULL OR v_proof.decision_id IS NOT NULL THEN
		RETURN CASE WHEN
			v_proof.consumed_at IS NOT NULL
			AND v_proof.decision_id = v_decision_id
			AND v_proof.row_version = 2
			AND v_has_decision
			AND v_existing_decision.schema_version = 1
			AND v_existing_decision.id = v_decision_id
			AND v_existing_decision.original_owner_user_id = v_claim.user_id
			AND v_existing_decision.authenticated_session_id =
				v_claim.current_session_id
			AND v_existing_decision.payload_hash = v_proposal.payload_hash
			AND v_existing_decision.approval_hash = v_proposal.approval_hash
			AND v_existing_decision.decision = v_next_state
			AND v_existing_decision.channel = 'authenticated-visual'
			AND v_existing_decision.decided_at = v_decided_at
			AND v_existing_decision.idempotency_key =
				p_input #>> '{decision,idempotencyKey}'
			AND v_resume.decision_id = v_decision_id
			AND v_resume.decision_type = v_next_state
			AND v_resume.authenticated_session_id = v_claim.current_session_id
			AND v_resume.state IN (
				'ready', 'claimed', 'terminal', 'indeterminate'
			)
			AND EXISTS (
				SELECT 1 FROM emdo.proposal_events AS event
				WHERE event.proposal_id = v_proposal.id
					AND event.proposal_version = v_next_version
					AND event.event_type = 'proposal.' || v_next_state
					AND event.occurred_at = v_decided_at
					AND event.payload = p_input -> 'event'
			)
		THEN 'duplicate' ELSE 'conflict' END;
	END IF;
	IF v_proof.expires_at <= v_now
		OR v_proof.row_version IS DISTINCT FROM 1
		OR v_has_decision
		OR v_state.version IS DISTINCT FROM v_expected_version
		OR v_state.state IS DISTINCT FROM 'pending'
		OR v_resume.state IS DISTINCT FROM 'awaiting-decision'
		OR v_resume.decision_id IS NOT NULL
		OR v_resume.decision_type IS NOT NULL
		OR v_resume.claim_id IS NOT NULL
		OR v_resume.ownership_token_digest IS NOT NULL
		OR v_resume.terminal_event_sequence IS NOT NULL
		OR v_resume.expires_at <= v_now
	THEN
		RETURN 'conflict';
	END IF;
	IF v_claim.claimed_at IS NULL THEN
		IF NOT emdo.claim_workflow_operation_scope(p_operation_id) THEN
			RETURN 'conflict';
		END IF;
	END IF;
	SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
	INTO v_sequence
	FROM emdo.proposal_events AS event
	WHERE event.proposal_id = v_proposal_id;
	INSERT INTO emdo.action_decisions(
		id, schema_version, proposal_id, household_id, space_id,
		original_owner_user_id, authenticated_session_id, payload_hash,
		approval_hash, decision, channel, decided_at, idempotency_key
	) VALUES (
		v_decision_id, 1, v_proposal.id, v_proposal.household_id,
		v_proposal.space_id, v_proposal.original_owner_user_id,
		v_claim.current_session_id, v_proposal.payload_hash,
		v_proposal.approval_hash, v_next_state, 'authenticated-visual',
		v_decided_at, p_input #>> '{decision,idempotencyKey}'
	);
	UPDATE emdo.proposal_states AS state
	SET version = v_next_version, state = v_next_state, updated_at = v_now
	WHERE state.proposal_id = v_proposal_id
		AND state.version = v_expected_version
		AND state.state = 'pending';
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = 'P0001',
			MESSAGE = 'proposal decision state CAS failed';
	END IF;
	UPDATE emdo.approval_resume_jobs AS resume
	SET decision_id = v_decision_id, decision_type = v_next_state,
		authenticated_session_id = v_claim.current_session_id,
		state = 'ready', revision = resume.revision + 1, updated_at = v_now
	WHERE resume.job_id = v_resume.job_id
		AND resume.revision = v_resume.revision
		AND resume.state = 'awaiting-decision'
		AND resume.decision_id IS NULL
		AND resume.decision_type IS NULL;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = 'P0001',
			MESSAGE = 'approval resume decision link CAS failed';
	END IF;
	INSERT INTO emdo.proposal_events(
		proposal_id, household_id, space_id, original_owner_user_id,
		proposal_version, sequence, event_type, payload, occurred_at
	) VALUES (
		v_proposal.id, v_proposal.household_id, v_proposal.space_id,
		v_proposal.original_owner_user_id, v_next_version, v_sequence,
		'proposal.' || v_next_state, p_input -> 'event', v_decided_at
	);
	UPDATE emdo.visual_decision_proofs AS proof
	SET consumed_at = v_now, decision_id = v_decision_id,
		row_version = proof.row_version + 1
	WHERE proof.proof_id = v_proof.proof_id
		AND proof.token_hash = p_input ->> 'visualDecisionProofHash'
		AND proof.row_version = 1
		AND proof.consumed_at IS NULL
		AND proof.decision_id IS NULL
		AND proof.expires_at > v_now;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = 'P0001',
			MESSAGE = 'visual decision proof CAS failed';
	END IF;
	RETURN 'created';
EXCEPTION
	WHEN data_exception OR integrity_constraint_violation OR raise_exception THEN
		RETURN 'conflict';
END
$function$;
--> statement-breakpoint

-- The visual decision request is only a launch point. Claiming re-locks the
-- exact proposal scope, then replaces request-local authority with a new
-- server-generated request and space grant before returning any owner token.
-- A claimed row is never reclaimed, even after its monitoring deadline.
CREATE OR REPLACE FUNCTION "emdo"."claim_approval_resume_job"(
	p_decision_id uuid,
	p_decision_request_id uuid,
	p_current_space_access_grant_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_job emdo.approval_resume_jobs%ROWTYPE;
	v_decision emdo.action_decisions%ROWTYPE;
	v_proposal emdo.action_proposals%ROWTYPE;
	v_proposal_state emdo.proposal_states%ROWTYPE;
	v_checkpoint emdo.approval_checkpoints%ROWTYPE;
	v_disclosure emdo.disclosure_grants%ROWTYPE;
	v_locked record;
	v_current_scope record;
	v_collection_scope record;
	v_resume_scope record;
	v_resume_grant emdo.space_access_grants%ROWTYPE;
	v_now timestamptz;
	v_resume_request_id uuid;
	v_claim_id uuid;
	v_ownership_token text;
	v_ownership_token_digest text;
BEGIN
	IF p_decision_id IS NULL OR p_decision_request_id IS NULL
		OR p_current_space_access_grant_id IS NULL
		OR emdo.current_user_id() IS NULL
		OR emdo.current_session_id() IS NULL
		OR emdo.current_request_id() IS DISTINCT FROM p_decision_request_id
	THEN
		RETURN NULL;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(p_decision_id::text, 0)
	);
	SELECT
		ROW(resume.*)::emdo.approval_resume_jobs AS job,
		ROW(decision.*)::emdo.action_decisions AS decision,
		ROW(proposal.*)::emdo.action_proposals AS proposal,
		ROW(proposal_state.*)::emdo.proposal_states AS proposal_state,
		ROW(checkpoint.*)::emdo.approval_checkpoints AS checkpoint,
		ROW(disclosure.*)::emdo.disclosure_grants AS disclosure
	INTO v_locked
	FROM emdo.approval_resume_jobs AS resume
	JOIN emdo.action_decisions AS decision
		ON decision.id = resume.decision_id
	JOIN emdo.action_proposals AS proposal
		ON proposal.id = resume.proposal_id
	JOIN emdo.proposal_states AS proposal_state
		ON proposal_state.proposal_id = resume.proposal_id
	JOIN emdo.approval_checkpoints AS checkpoint
		ON checkpoint.checkpoint_id = resume.checkpoint_id
	JOIN emdo.disclosure_grants AS disclosure
		ON disclosure.id = resume.disclosure_grant_id
	WHERE resume.decision_id = p_decision_id
		AND resume.user_id = emdo.current_user_id()
	FOR UPDATE OF resume;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;
	v_job := v_locked.job;
	v_decision := v_locked.decision;
	v_proposal := v_locked.proposal;
	v_proposal_state := v_locked.proposal_state;
	v_checkpoint := v_locked.checkpoint;
	v_disclosure := v_locked.disclosure;
	IF v_job.authenticated_session_id IS DISTINCT FROM
			emdo.current_session_id()
		OR v_decision.schema_version IS DISTINCT FROM 1
		OR v_decision.proposal_id IS DISTINCT FROM v_job.proposal_id
		OR v_decision.original_owner_user_id IS DISTINCT FROM v_job.user_id
		OR v_decision.authenticated_session_id IS DISTINCT FROM
			v_job.authenticated_session_id
		OR v_decision.payload_hash IS DISTINCT FROM v_job.payload_hash
		OR v_decision.approval_hash IS DISTINCT FROM v_job.approval_hash
		OR v_decision.decision IS DISTINCT FROM v_job.decision_type
		OR v_decision.channel IS DISTINCT FROM 'authenticated-visual'
		OR v_proposal.household_id IS DISTINCT FROM v_job.household_id
		OR v_proposal.space_id IS DISTINCT FROM v_job.space_id
		OR v_proposal.original_owner_user_id IS DISTINCT FROM v_job.user_id
		OR v_proposal.run_id IS DISTINCT FROM v_job.run_id
		OR v_proposal.capability_id IS DISTINCT FROM v_job.capability_id
		OR v_proposal.disclosure_grant_id IS DISTINCT FROM
			v_job.disclosure_grant_id
		OR v_proposal.payload_hash IS DISTINCT FROM v_job.payload_hash
		OR v_proposal.approval_hash IS DISTINCT FROM v_job.approval_hash
		OR v_proposal.authorization_scope_fingerprint IS DISTINCT FROM
			v_job.authorization_scope_fingerprint
		OR v_proposal_state.state IS DISTINCT FROM v_job.decision_type
		OR v_checkpoint.household_id IS DISTINCT FROM v_job.household_id
		OR v_checkpoint.space_id IS DISTINCT FROM v_job.space_id
		OR v_checkpoint.user_id IS DISTINCT FROM v_job.user_id
		OR v_checkpoint.run_id IS DISTINCT FROM v_job.run_id
		OR v_disclosure.schema_version IS DISTINCT FROM 1
		OR v_disclosure.version IS DISTINCT FROM v_job.disclosure_grant_version
		OR v_disclosure.household_id IS DISTINCT FROM v_job.household_id
		OR v_disclosure.space_id IS DISTINCT FROM v_job.space_id
		OR v_disclosure.user_id IS DISTINCT FROM v_job.user_id
		OR v_disclosure.run_id IS DISTINCT FROM v_job.run_id
		OR v_disclosure.id IS DISTINCT FROM v_job.disclosure_grant_id
	THEN
		RETURN NULL;
	END IF;

	SELECT locked.* INTO v_current_scope
	FROM emdo.lock_current_authorization_scope(
		p_current_space_access_grant_id, v_job.proposal_id, NULL
	) AS locked;
	IF NOT FOUND
		OR v_current_scope.user_id IS DISTINCT FROM v_job.user_id
		OR v_current_scope.session_id IS DISTINCT FROM
			v_job.authenticated_session_id
		OR v_current_scope.request_id IS DISTINCT FROM p_decision_request_id
		OR v_current_scope.household_id IS DISTINCT FROM v_job.household_id
		OR v_current_scope.proposal_space_id IS DISTINCT FROM v_job.space_id
		OR v_current_scope.authorization_scope_fingerprint IS DISTINCT FROM
			v_job.authorization_scope_fingerprint
	THEN
		RETURN NULL;
	END IF;

	v_now := pg_catalog.clock_timestamp();
	IF v_job.state IN ('terminal', 'indeterminate') THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'terminal-replay',
			'runId', v_job.run_id,
			'terminalEventSequence', v_job.terminal_event_sequence
		);
	END IF;
	IF v_job.state = 'claimed' THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'in-progress', 'runId', v_job.run_id
		);
	END IF;
	IF v_job.state IS DISTINCT FROM 'ready'
		OR v_job.approval_event_sequence IS NULL
		OR v_job.expires_at <= v_now
		OR v_checkpoint.state IS DISTINCT FROM 'pending'
		OR v_checkpoint.expires_at <= v_now
		OR v_disclosure.revoked_at IS NOT NULL
		OR v_disclosure.expires_at <= v_now
		OR NOT EXISTS (
			SELECT 1
			FROM emdo.agent_run_events AS approval_event
			WHERE approval_event.run_id = v_job.run_id
				AND approval_event.sequence = v_job.approval_event_sequence
				AND approval_event.household_id = v_job.household_id
				AND approval_event.space_id = v_job.space_id
				AND approval_event.original_owner_user_id = v_job.user_id
		)
	THEN
		RETURN NULL;
	END IF;

	v_resume_request_id := pg_catalog.gen_random_uuid();
	PERFORM pg_catalog.set_config(
		'emdo.request_id', v_resume_request_id::text, true
	);
	SELECT issued.* INTO v_resume_grant
	FROM emdo.issue_space_access_grant(
		v_job.household_id,
		v_current_scope.membership_id,
		v_current_scope.role
	) AS issued;
	IF NOT FOUND
		OR v_resume_grant.request_id IS DISTINCT FROM v_resume_request_id
		OR v_resume_grant.session_id IS DISTINCT FROM
			v_job.authenticated_session_id
		OR v_resume_grant.household_id IS DISTINCT FROM v_job.household_id
		OR v_resume_grant.original_owner_user_id IS DISTINCT FROM v_job.user_id
	THEN
		RETURN NULL;
	END IF;

	SELECT locked.* INTO v_collection_scope
	FROM emdo.lock_current_authorization_scope(
		v_resume_grant.grant_id, NULL, NULL
	) AS locked;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;
	SELECT locked.* INTO v_resume_scope
	FROM emdo.lock_current_authorization_scope(
		v_resume_grant.grant_id, v_job.proposal_id, NULL
	) AS locked;
	IF NOT FOUND
		OR v_collection_scope.user_id IS DISTINCT FROM v_job.user_id
		OR v_collection_scope.session_id IS DISTINCT FROM
			v_job.authenticated_session_id
		OR v_collection_scope.request_id IS DISTINCT FROM v_resume_request_id
		OR v_collection_scope.household_id IS DISTINCT FROM v_job.household_id
		OR v_collection_scope.proposal_space_id IS NOT NULL
		OR v_collection_scope.authorization_scope_fingerprint
			!~ '^[a-f0-9]{64}$'
		OR v_resume_scope.user_id IS DISTINCT FROM v_job.user_id
		OR v_resume_scope.session_id IS DISTINCT FROM
			v_job.authenticated_session_id
		OR v_resume_scope.request_id IS DISTINCT FROM v_resume_request_id
		OR v_resume_scope.household_id IS DISTINCT FROM v_job.household_id
		OR v_resume_scope.proposal_space_id IS DISTINCT FROM v_job.space_id
		OR v_resume_scope.authorization_scope_fingerprint IS DISTINCT FROM
			v_job.authorization_scope_fingerprint
	THEN
		RETURN NULL;
	END IF;

	v_claim_id := pg_catalog.gen_random_uuid();
	v_ownership_token := pg_catalog.replace(
		pg_catalog.gen_random_uuid()::text, '-', ''
	) || pg_catalog.replace(
		pg_catalog.gen_random_uuid()::text, '-', ''
	);
	v_ownership_token_digest := pg_catalog.encode(
		pg_catalog.sha256(
			pg_catalog.convert_to('emdo.approval-resume-owner.v1', 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(v_ownership_token, 'UTF8')
		),
		'hex'
	);
	v_now := pg_catalog.clock_timestamp();
	UPDATE emdo.approval_resume_jobs AS resume
	SET state = 'claimed', revision = resume.revision + 1,
		claim_id = v_claim_id,
		ownership_token_digest = v_ownership_token_digest,
		resume_request_id = v_resume_request_id,
		resume_space_access_grant_id = v_resume_grant.grant_id,
		collection_authorization_scope_fingerprint =
			v_collection_scope.authorization_scope_fingerprint,
		claimed_at = v_now,
		claim_expires_at = least(
			v_now + interval '5 minutes', resume.expires_at
		),
		updated_at = v_now
	WHERE resume.job_id = v_job.job_id
		AND resume.revision = v_job.revision
		AND resume.state = 'ready'
		AND resume.claim_id IS NULL
		AND resume.ownership_token_digest IS NULL;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'approval resume claim CAS failed';
	END IF;

	RETURN pg_catalog.jsonb_build_object(
		'status', 'claimed',
		'claimId', v_claim_id,
		'ownershipToken', v_ownership_token,
		'binding', pg_catalog.jsonb_build_object(
			'turnRequestId', v_resume_request_id,
			'runId', v_job.run_id,
			'conversationId', v_job.conversation_id,
			'checkpointId', v_job.checkpoint_id,
			'interruptionId', v_job.interruption_id,
			'proposalId', v_job.proposal_id,
			'approvalDecisionId', v_job.decision_id,
			'decision', CASE v_job.decision_type
				WHEN 'approved' THEN 'approve' ELSE 'reject' END,
			'householdId', v_job.household_id,
			'userId', v_job.user_id,
			'authenticatedSessionId', v_job.authenticated_session_id,
			'spaceAccessGrantId', v_resume_grant.grant_id,
			'disclosureGrantId', v_job.disclosure_grant_id,
			'disclosureGrantVersion',
				v_job.disclosure_policy_version,
			'collectionAuthorizationScopeFingerprint',
				v_collection_scope.authorization_scope_fingerprint,
			'authorizationScopeFingerprint',
				v_resume_scope.authorization_scope_fingerprint,
			'payloadHash', v_job.payload_hash,
			'approvalHash', v_job.approval_hash
		)
	);
END
$function$;
--> statement-breakpoint

-- Settlement is one ownership-token CAS plus the exact append-only terminal
-- event. An observed owner is never released for redispatch; an uncertain
-- caller can only observe the already durable terminal sequence as a replay.
CREATE OR REPLACE FUNCTION "emdo"."settle_approval_resume_job"(
	p_claim_id uuid,
	p_ownership_token text,
	p_mode text,
	p_reason_code text,
	p_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_job emdo.approval_resume_jobs%ROWTYPE;
	v_ownership_token_digest text;
	v_terminal_state text;
	v_public_status text;
	v_event_type text;
	v_event_payload jsonb;
	v_terminal_result_hash text;
	v_terminal_sequence bigint;
	v_now timestamptz;
BEGIN
	IF p_claim_id IS NULL
		OR pg_catalog.length(p_ownership_token) NOT BETWEEN 16 AND 512
		OR p_ownership_token ~ '[[:cntrl:]]'
		OR p_mode IS NULL
		OR p_mode NOT IN ('complete', 'terminalize-not-dispatched', 'indeterminate')
		OR emdo.current_user_id() IS NULL
		OR emdo.current_session_id() IS NULL
		OR emdo.current_request_id() IS NULL
		OR (
			p_mode = 'complete'
			AND (
				p_reason_code IS NOT NULL
				OR pg_catalog.jsonb_typeof(p_result) IS DISTINCT FROM 'object'
				OR pg_catalog.octet_length(p_result::text) > 1400000
				OR ((p_result ->> 'status') IN (
					'completed', 'needs-approval', 'failed'
				)) IS DISTINCT FROM true
			)
		)
		OR (
			p_mode = 'terminalize-not-dispatched'
			AND (
				p_reason_code IS DISTINCT FROM
					'approval-resume-binding-invalid'
				OR p_result IS NOT NULL
			)
		)
		OR (
			p_mode = 'indeterminate'
			AND (
				p_reason_code IS DISTINCT FROM 'approval-resume-failed'
				OR p_result IS NOT NULL
			)
		)
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;

	v_ownership_token_digest := pg_catalog.encode(
		pg_catalog.sha256(
			pg_catalog.convert_to('emdo.approval-resume-owner.v1', 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(p_ownership_token, 'UTF8')
		),
		'hex'
	);
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(p_claim_id::text, 0)
	);
	SELECT resume.* INTO v_job
	FROM emdo.approval_resume_jobs AS resume
	WHERE resume.claim_id = p_claim_id
		AND resume.user_id = emdo.current_user_id()
	FOR UPDATE OF resume;
	IF NOT FOUND
		OR v_job.ownership_token_digest IS DISTINCT FROM
			v_ownership_token_digest
		OR v_job.authenticated_session_id IS DISTINCT FROM
			emdo.current_session_id()
		OR v_job.resume_request_id IS DISTINCT FROM emdo.current_request_id()
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	IF v_job.state IN ('terminal', 'indeterminate') THEN
		RETURN pg_catalog.jsonb_build_object(
			'status', 'replay',
			'terminalEventSequence', v_job.terminal_event_sequence
		);
	END IF;
	IF v_job.state IS DISTINCT FROM 'claimed'
		OR (
			p_mode = 'complete'
			AND p_result ->> 'runId' IS DISTINCT FROM v_job.run_id::text
		)
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;

	v_terminal_state := CASE p_mode
		WHEN 'indeterminate' THEN 'indeterminate' ELSE 'terminal' END;
	v_public_status := CASE p_mode
		WHEN 'complete' THEN 'completed'
		WHEN 'terminalize-not-dispatched' THEN 'terminalized'
		ELSE 'indeterminate'
	END;
	v_event_type := CASE p_mode
		WHEN 'complete' THEN 'agent.turn.' || (p_result ->> 'status')
		WHEN 'terminalize-not-dispatched' THEN 'agent.turn.failed'
		ELSE 'agent.turn.indeterminate'
	END;
	v_event_payload := pg_catalog.jsonb_strip_nulls(
		pg_catalog.jsonb_build_object(
			'schemaVersion', 1,
			'runId', v_job.run_id,
			'proposalId', v_job.proposal_id,
			'approvalDecisionId', v_job.decision_id,
			'status', v_public_status,
			'reasonCode', p_reason_code,
			'result', p_result
		)
	);
	v_terminal_result_hash := pg_catalog.encode(
		pg_catalog.sha256(
			pg_catalog.convert_to('emdo.approval-resume-terminal.v1', 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(v_event_payload::text, 'UTF8')
		),
		'hex'
	);

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(v_job.run_id::text, 0)
	);
	SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
	INTO v_terminal_sequence
	FROM emdo.agent_run_events AS event
	WHERE event.run_id = v_job.run_id;
	v_now := pg_catalog.clock_timestamp();
	INSERT INTO emdo.agent_run_events(
		household_id, space_id, original_owner_user_id, run_id,
		sequence, event_type, payload, occurred_at, retain_until
	) VALUES (
		v_job.household_id, v_job.space_id, v_job.user_id, v_job.run_id,
		v_terminal_sequence, v_event_type, v_event_payload, v_now,
		v_now + interval '90 days'
	);
	UPDATE emdo.approval_resume_jobs AS resume
	SET state = v_terminal_state, revision = resume.revision + 1,
		terminal_event_sequence = v_terminal_sequence,
		terminal_reason_code = p_reason_code,
		terminal_result_hash = v_terminal_result_hash,
		updated_at = v_now
	WHERE resume.job_id = v_job.job_id
		AND resume.revision = v_job.revision
		AND resume.state = 'claimed'
		AND resume.claim_id = p_claim_id
		AND resume.ownership_token_digest = v_ownership_token_digest;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'approval resume terminal CAS failed';
	END IF;
	UPDATE emdo.approval_checkpoints AS checkpoint
	SET state = 'cancelled', revision = checkpoint.revision + 1,
		updated_at = v_now
	WHERE checkpoint.checkpoint_id = v_job.checkpoint_id
		AND checkpoint.state = 'pending';

	RETURN pg_catalog.jsonb_build_object(
		'status', v_public_status,
		'terminalEventSequence', v_terminal_sequence
	);
END
$function$;
--> statement-breakpoint

-- A consumed visual proof is the only authority for decision idempotency
-- replay. Proof age is intentionally ignored after consumption, but current
-- session and stable authorization scope are re-proved on every read.
CREATE POLICY visual_proof_decisions_executor_select
ON "emdo"."action_decisions"
FOR SELECT TO emdo_visual_proof_executor USING (true);
CREATE POLICY visual_proof_decisions_executor_update
ON "emdo"."action_decisions"
FOR UPDATE TO emdo_visual_proof_executor USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."resolve_provider_proposal_decision_replay"(
	p_user_id uuid,
	p_proposal_id uuid,
	p_idempotency_key text,
	p_visual_decision_proof_hash text,
	p_current_space_access_grant_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_scope record;
	v_proposal emdo.action_proposals%ROWTYPE;
	v_proof emdo.visual_decision_proofs%ROWTYPE;
	v_decision emdo.action_decisions%ROWTYPE;
	v_expected_issuance_fingerprint text;
BEGIN
	IF p_user_id IS NULL OR p_proposal_id IS NULL
		OR p_current_space_access_grant_id IS NULL
		OR pg_catalog.length(p_idempotency_key) NOT BETWEEN 16 AND 200
		OR p_idempotency_key !~ '^[A-Za-z0-9:._-]+$'
		OR p_visual_decision_proof_hash !~ '^[a-f0-9]{64}$'
		OR emdo.current_user_id() IS DISTINCT FROM p_user_id
	THEN
		RETURN NULL;
	END IF;
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			p_user_id::text || ':' || p_proposal_id::text || ':' ||
				p_idempotency_key,
			0
		)
	);
	SELECT scope.* INTO v_scope
	FROM emdo.lock_current_authorization_scope(
		p_current_space_access_grant_id, p_proposal_id, NULL
	) AS scope;
	IF NOT FOUND
		OR v_scope.user_id IS DISTINCT FROM p_user_id
		OR v_scope.session_id IS DISTINCT FROM emdo.current_session_id()
	THEN
		RETURN NULL;
	END IF;
	SELECT proposal.* INTO v_proposal
	FROM emdo.action_proposals AS proposal
	WHERE proposal.id = p_proposal_id
		AND proposal.household_id = v_scope.household_id
		AND proposal.space_id = v_scope.proposal_space_id
		AND proposal.original_owner_user_id = v_scope.user_id
		AND proposal.authorization_scope_fingerprint =
			v_scope.authorization_scope_fingerprint
	FOR SHARE OF proposal;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;
	SELECT proof.* INTO v_proof
	FROM emdo.visual_decision_proofs AS proof
	WHERE proof.token_hash = p_visual_decision_proof_hash
		AND proof.user_id = p_user_id
		AND proof.proposal_id = p_proposal_id
	FOR SHARE OF proof;
	IF NOT FOUND
		OR v_proof.binding_version IS DISTINCT FROM 1
		OR v_proof.consumed_at IS NULL
		OR v_proof.decision_id IS NULL
		OR v_proof.row_version IS DISTINCT FROM 2
		OR v_proof.user_id IS DISTINCT FROM v_scope.user_id
		OR v_proof.session_id IS DISTINCT FROM v_scope.session_id
		OR v_proof.household_id IS DISTINCT FROM v_scope.household_id
		OR v_proof.space_id IS DISTINCT FROM v_scope.proposal_space_id
		OR v_proof.payload_hash IS DISTINCT FROM v_proposal.payload_hash
		OR v_proof.approval_hash IS DISTINCT FROM v_proposal.approval_hash
		OR v_proof.channel IS DISTINCT FROM 'authenticated-visual'
		OR v_proof.authorization_scope_fingerprint IS DISTINCT FROM
			v_scope.authorization_scope_fingerprint
		OR v_proof.authorization_scope_fingerprint IS DISTINCT FROM
			v_proposal.authorization_scope_fingerprint
	THEN
		RETURN NULL;
	END IF;
	v_expected_issuance_fingerprint :=
		emdo.visual_decision_proof_issuance_fingerprint(
			v_proof.proof_id, v_proof.nonce, v_proof.key_id,
			v_proof.authorization_scope_fingerprint, v_proof.user_id,
			v_proof.session_id, v_proof.household_id, v_proof.space_id,
			v_proof.proposal_id, v_proof.proposal_version,
			v_proof.payload_hash, v_proof.approval_hash,
			v_proof.idempotency_key, v_proof.initial_request_id,
			v_proof.issued_at, v_proof.expires_at
		);
	IF v_proof.issuance_fingerprint IS DISTINCT FROM
		v_expected_issuance_fingerprint
	THEN
		RETURN NULL;
	END IF;
	SELECT decision.* INTO v_decision
	FROM emdo.action_decisions AS decision
	WHERE decision.id = v_proof.decision_id
		AND decision.proposal_id = v_proof.proposal_id
		AND decision.original_owner_user_id = v_proof.user_id
		AND decision.authenticated_session_id = v_proof.session_id
		AND decision.payload_hash = v_proof.payload_hash
		AND decision.approval_hash = v_proof.approval_hash
		AND decision.channel = v_proof.channel
		AND decision.idempotency_key = p_idempotency_key
	FOR SHARE OF decision;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;
	RETURN pg_catalog.jsonb_build_object(
		'proposalId', v_decision.proposal_id,
		'decision', pg_catalog.jsonb_build_object(
			'schemaVersion', v_decision.schema_version,
			'id', v_decision.id,
			'proposalId', v_decision.proposal_id,
			'userId', v_decision.original_owner_user_id,
			'authenticatedSessionId', v_decision.authenticated_session_id,
			'payloadHash', v_decision.payload_hash,
			'approvalHash', v_decision.approval_hash,
			'decision', v_decision.decision,
			'channel', v_decision.channel,
			'decidedAt', v_decision.decided_at,
			'idempotencyKey', v_decision.idempotency_key
		)
	);
EXCEPTION
	WHEN data_exception THEN
		RETURN NULL;
END
$function$;
--> statement-breakpoint

-- Reconciliation is a worker-only aggregate boundary. Its SECURITY DEFINER
-- owner is intentionally not a member of any runtime login role, so the
-- worker login cannot SET ROLE around this function's exact-target checks.
DO $proposal_reconciliation_role$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_proposal_reconciliation_executor'
	) THEN
		CREATE ROLE emdo_proposal_reconciliation_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$proposal_reconciliation_role$;
ALTER ROLE emdo_proposal_reconciliation_executor
	NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
	NOBYPASSRLS NOREPLICATION;
--> statement-breakpoint
DO $proposal_reconciliation_membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname = 'emdo_proposal_reconciliation_executor'
			OR child.rolname = 'emdo_proposal_reconciliation_executor'
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'proposal reconciliation executor must not have role memberships';
	END IF;
END
$proposal_reconciliation_membership_guard$;
--> statement-breakpoint

-- The repository may read only rows reachable from the one provider attempt
-- named by its live reconciliation lease. The definer receives the same
-- policies so FORCE ROW LEVEL SECURITY remains effective inside the commit.
CREATE POLICY proposal_reconciliation_proposals_read
ON "emdo"."action_proposals"
FOR SELECT TO emdo_worker_executor, emdo_proposal_reconciliation_executor
USING (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND emdo.current_worker_target_type() = 'provider-attempt'
	AND EXISTS (
		SELECT 1
		FROM emdo.provider_attempts AS bounded_attempt
		WHERE bounded_attempt.id::text = emdo.current_worker_target_id()
			AND bounded_attempt.proposal_id = action_proposals.id
			AND emdo.is_active_worker_operation_scope(
				bounded_attempt.household_id, bounded_attempt.space_id,
				bounded_attempt.original_owner_user_id
			)
	)
);
CREATE POLICY proposal_reconciliation_states_read
ON "emdo"."proposal_states"
FOR SELECT TO emdo_worker_executor, emdo_proposal_reconciliation_executor
USING (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND emdo.current_worker_target_type() = 'provider-attempt'
	AND EXISTS (
		SELECT 1
		FROM emdo.provider_attempts AS bounded_attempt
		WHERE bounded_attempt.id::text = emdo.current_worker_target_id()
			AND bounded_attempt.proposal_id = proposal_states.proposal_id
			AND emdo.is_active_worker_operation_scope(
				bounded_attempt.household_id, bounded_attempt.space_id,
				bounded_attempt.original_owner_user_id
			)
	)
);
CREATE POLICY proposal_reconciliation_states_update
ON "emdo"."proposal_states"
FOR UPDATE TO emdo_proposal_reconciliation_executor
USING (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND emdo.current_worker_target_type() = 'provider-attempt'
	AND EXISTS (
		SELECT 1
		FROM emdo.provider_attempts AS bounded_attempt
		WHERE bounded_attempt.id::text = emdo.current_worker_target_id()
			AND bounded_attempt.proposal_id = proposal_states.proposal_id
			AND emdo.is_active_worker_operation_scope(
				bounded_attempt.household_id, bounded_attempt.space_id,
				bounded_attempt.original_owner_user_id
			)
	)
)
WITH CHECK (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND emdo.current_worker_target_type() = 'provider-attempt'
	AND "state" IN ('executed', 'not-applied')
	AND EXISTS (
		SELECT 1
		FROM emdo.provider_attempts AS bounded_attempt
		WHERE bounded_attempt.id::text = emdo.current_worker_target_id()
			AND bounded_attempt.proposal_id = proposal_states.proposal_id
			AND emdo.is_active_worker_operation_scope(
				bounded_attempt.household_id, bounded_attempt.space_id,
				bounded_attempt.original_owner_user_id
			)
	)
);
CREATE POLICY proposal_reconciliation_preparations_read
ON "emdo"."proposal_preparations"
FOR SELECT TO emdo_worker_executor, emdo_proposal_reconciliation_executor
USING (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND emdo.current_worker_target_type() = 'provider-attempt'
	AND EXISTS (
		SELECT 1
		FROM emdo.provider_attempts AS bounded_attempt
		WHERE bounded_attempt.id::text = emdo.current_worker_target_id()
			AND bounded_attempt.proposal_id = proposal_preparations.proposal_id
			AND emdo.is_active_worker_operation_scope(
				bounded_attempt.household_id, bounded_attempt.space_id,
				bounded_attempt.original_owner_user_id
			)
	)
);
CREATE POLICY proposal_reconciliation_decisions_read
ON "emdo"."action_decisions"
FOR SELECT TO emdo_worker_executor, emdo_proposal_reconciliation_executor
USING (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND emdo.current_worker_target_type() = 'provider-attempt'
	AND EXISTS (
		SELECT 1
		FROM emdo.provider_attempts AS bounded_attempt
		WHERE bounded_attempt.id::text = emdo.current_worker_target_id()
			AND bounded_attempt.decision_id = action_decisions.id
			AND emdo.is_active_worker_operation_scope(
				bounded_attempt.household_id, bounded_attempt.space_id,
				bounded_attempt.original_owner_user_id
			)
	)
);
CREATE POLICY proposal_reconciliation_attempts_read
ON "emdo"."provider_attempts"
FOR SELECT TO emdo_proposal_reconciliation_executor
USING (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND emdo.current_worker_target_type() = 'provider-attempt'
	AND "id"::text = emdo.current_worker_target_id()
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
);
CREATE POLICY proposal_reconciliation_attempts_update
ON "emdo"."provider_attempts"
FOR UPDATE TO emdo_proposal_reconciliation_executor
USING (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND emdo.current_worker_target_type() = 'provider-attempt'
	AND "id"::text = emdo.current_worker_target_id()
	AND "attempt_state" = 'indeterminate'
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
)
WITH CHECK (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND emdo.current_worker_target_type() = 'provider-attempt'
	AND "id"::text = emdo.current_worker_target_id()
	AND "attempt_state" IN ('executed', 'not-applied')
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
);
CREATE POLICY proposal_reconciliation_outcomes_read
ON "emdo"."provider_outcomes"
FOR SELECT TO emdo_proposal_reconciliation_executor
USING (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND emdo.current_worker_target_type() = 'provider-attempt'
	AND "attempt_id"::text = emdo.current_worker_target_id()
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
);
CREATE POLICY proposal_reconciliation_records_read
ON "emdo"."proposal_reconciliations"
FOR SELECT TO emdo_proposal_reconciliation_executor
USING (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND emdo.current_worker_target_type() = 'provider-attempt'
	AND "attempt_id"::text = emdo.current_worker_target_id()
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
);
CREATE POLICY proposal_reconciliation_records_insert
ON "emdo"."proposal_reconciliations"
FOR INSERT TO emdo_proposal_reconciliation_executor
WITH CHECK (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND emdo.current_worker_target_type() = 'provider-attempt'
	AND "attempt_id"::text = emdo.current_worker_target_id()
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
);
CREATE POLICY proposal_reconciliation_events_read
ON "emdo"."proposal_events"
FOR SELECT TO emdo_worker_executor, emdo_proposal_reconciliation_executor
USING (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND emdo.current_worker_target_type() = 'provider-attempt'
	AND EXISTS (
		SELECT 1
		FROM emdo.provider_attempts AS bounded_attempt
		WHERE bounded_attempt.id::text = emdo.current_worker_target_id()
			AND bounded_attempt.proposal_id = proposal_events.proposal_id
			AND emdo.is_active_worker_operation_scope(
				bounded_attempt.household_id, bounded_attempt.space_id,
				bounded_attempt.original_owner_user_id
			)
	)
);
CREATE POLICY proposal_reconciliation_events_insert
ON "emdo"."proposal_events"
FOR INSERT TO emdo_proposal_reconciliation_executor
WITH CHECK (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND emdo.current_worker_target_type() = 'provider-attempt'
	AND EXISTS (
		SELECT 1
		FROM emdo.provider_attempts AS bounded_attempt
		WHERE bounded_attempt.id::text = emdo.current_worker_target_id()
			AND bounded_attempt.proposal_id = proposal_events.proposal_id
			AND emdo.is_active_worker_operation_scope(
				bounded_attempt.household_id, bounded_attempt.space_id,
				bounded_attempt.original_owner_user_id
			)
	)
);
CREATE POLICY proposal_reconciliation_claims_read
ON "emdo"."workflow_operation_claims"
FOR SELECT TO emdo_proposal_reconciliation_executor
USING (
	emdo.current_worker_job_name() = 'emdo.calendar.reconciliation.v1'
	AND emdo.current_worker_target_type() = 'provider-attempt'
	AND "provider_attempt_id"::text = emdo.current_worker_target_id()
	AND emdo.is_active_worker_operation_scope(
		"household_id", "space_id", "original_owner_user_id"
	)
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."commit_provider_proposal_reconciliation"(
	p_input jsonb
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_proposal emdo.action_proposals%ROWTYPE;
	v_state emdo.proposal_states%ROWTYPE;
	v_preparation emdo.proposal_preparations%ROWTYPE;
	v_decision emdo.action_decisions%ROWTYPE;
	v_attempt emdo.provider_attempts%ROWTYPE;
	v_outcome emdo.provider_outcomes%ROWTYPE;
	v_reconciliation emdo.proposal_reconciliations%ROWTYPE;
	v_locked record;
	v_proposal_id uuid;
	v_attempt_id uuid;
	v_decision_id uuid;
	v_expected_version integer;
	v_expected_state text;
	v_expected_approval_hash text;
	v_next_version integer;
	v_next_state text;
	v_completed_at timestamptz;
	v_now timestamptz;
	v_sequence integer;
	v_has_reconciliation boolean;
	v_expected_event jsonb;
BEGIN
	IF p_input IS NULL
		OR pg_catalog.octet_length(p_input::text) > 524288
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input,
			ARRAY[
				'expected', 'next', 'decisionId', 'bindingHash',
				'attemptId', 'completion', 'event'
			]::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'expected',
			ARRAY['proposalId', 'version', 'state', 'approvalHash']::text[]
		)
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_input -> 'completion',
			ARRAY[
				'completion', 'bindingHash', 'completionHash', 'completedAt'
			]::text[]
		)
		OR NOT emdo.provider_completion_is_valid(
			p_input #> '{completion,completion}', true
		)
		OR NOT emdo.proposal_event_has_only_known_keys(p_input -> 'event')
	THEN
		RETURN 'conflict';
	END IF;
	v_proposal_id := (p_input #>> '{expected,proposalId}')::uuid;
	v_attempt_id := (p_input ->> 'attemptId')::uuid;
	v_decision_id := (p_input ->> 'decisionId')::uuid;
	v_completed_at := (p_input #>> '{completion,completedAt}')::timestamptz;
	v_now := pg_catalog.clock_timestamp();
	IF emdo.current_worker_job_name() IS DISTINCT FROM
			'emdo.calendar.reconciliation.v1'
		OR emdo.current_worker_target_type() IS DISTINCT FROM 'provider-attempt'
		OR emdo.current_worker_target_id() IS DISTINCT FROM v_attempt_id::text
	THEN
		RETURN 'conflict';
	END IF;
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(v_proposal_id::text, 0)
	);
	SELECT ROW(proposal.*)::emdo.action_proposals AS proposal_row,
		ROW(state.*)::emdo.proposal_states AS state_row,
		ROW(preparation.*)::emdo.proposal_preparations AS preparation_row,
		ROW(decision.*)::emdo.action_decisions AS decision_row,
		ROW(attempt.*)::emdo.provider_attempts AS attempt_row
	INTO v_locked
	FROM emdo.action_proposals AS proposal
	JOIN emdo.proposal_states AS state ON state.proposal_id = proposal.id
	JOIN emdo.proposal_preparations AS preparation
		ON preparation.proposal_id = proposal.id
	JOIN emdo.action_decisions AS decision
		ON decision.proposal_id = proposal.id
	JOIN emdo.provider_attempts AS attempt
		ON attempt.proposal_id = proposal.id
	WHERE proposal.id = v_proposal_id
		AND decision.id = v_decision_id
		AND attempt.id = v_attempt_id
	FOR UPDATE OF state, attempt;
	IF NOT FOUND THEN
		RETURN 'conflict';
	END IF;
	v_proposal := v_locked.proposal_row;
	v_state := v_locked.state_row;
	v_preparation := v_locked.preparation_row;
	v_decision := v_locked.decision_row;
	v_attempt := v_locked.attempt_row;
	IF NOT emdo.is_active_worker_operation_scope(
		v_attempt.household_id, v_attempt.space_id,
		v_attempt.original_owner_user_id
	) THEN
		RETURN 'conflict';
	END IF;
	SELECT outcome.* INTO v_outcome
	FROM emdo.provider_outcomes AS outcome
	WHERE outcome.attempt_id = v_attempt_id;
	IF NOT FOUND THEN
		RETURN 'conflict';
	END IF;
	SELECT reconciliation.* INTO v_reconciliation
	FROM emdo.proposal_reconciliations AS reconciliation
	WHERE reconciliation.attempt_id = v_attempt_id;
	v_has_reconciliation := FOUND;
	v_expected_version := (p_input #>> '{expected,version}')::integer;
	v_expected_state := p_input #>> '{expected,state}';
	v_expected_approval_hash := p_input #>> '{expected,approvalHash}';
	v_next_version := (p_input #>> '{next,version}')::integer;
	v_next_state := p_input #>> '{next,state}';
	v_expected_event := pg_catalog.jsonb_strip_nulls(
		pg_catalog.jsonb_build_object(
			'proposalId', v_proposal.id,
			'eventType', 'proposal.' ||
				(p_input #>> '{completion,completion,state}'),
			'occurredAt', p_input #>> '{completion,completedAt}',
			'decisionId', v_decision.id,
			'actorUserId', v_decision.original_owner_user_id,
			'authenticatedSessionId', v_decision.authenticated_session_id,
			'approvalHash', v_decision.approval_hash,
			'decisionIdempotencyKey', v_decision.idempotency_key,
			'application', p_input #>> '{completion,completion,application}',
			'outcomeReason', p_input #>> '{completion,completion,reason}',
			'outputStatus', p_input #>> '{completion,completion,outputStatus}',
			'evidenceHash', p_input #>> '{completion,completion,evidenceHash}',
			'providerIdempotencyKey', v_attempt.provider_idempotency_key,
			'attemptId', v_attempt.id,
			'attemptVersion', v_attempt.attempt_version,
			'resultHash', p_input #>> '{completion,completion,resultHash}',
			'safeErrorCode', p_input #>> '{completion,completion,safeErrorCode}'
		)
	);
	IF v_preparation.abandonment_reason IS NOT NULL
		OR v_decision.decision IS DISTINCT FROM 'approved'
		OR v_decision.channel IS DISTINCT FROM 'authenticated-visual'
		OR v_decision.approval_hash IS DISTINCT FROM v_proposal.approval_hash
		OR v_attempt.proposal_id IS DISTINCT FROM v_proposal.id
		OR v_attempt.decision_id IS DISTINCT FROM v_decision.id
		OR v_attempt.binding_hash IS DISTINCT FROM p_input ->> 'bindingHash'
		OR v_attempt."authorization" #>> '{approvalBindingHash}' IS DISTINCT FROM
			v_attempt.binding_hash
		OR v_attempt.approval_hash IS DISTINCT FROM v_proposal.approval_hash
		OR v_attempt.provider_authority_binding_hash IS DISTINCT FROM
			v_proposal.provider_authority_binding_hash
		OR p_input #>> '{completion,bindingHash}' IS DISTINCT FROM
			v_attempt.binding_hash
		OR (p_input #>> '{completion,completionHash}' ~ '^[a-f0-9]{64}$')
			IS DISTINCT FROM true
		OR p_input #>> '{completion,completionHash}' IS DISTINCT FROM
			emdo.canonical_json_hash(p_input #> '{completion,completion}')
		OR v_outcome.completion_hash IS DISTINCT FROM
			emdo.canonical_json_hash(v_outcome.completion)
		OR v_outcome.application IS DISTINCT FROM 'indeterminate'
		OR v_outcome.completion #>> '{state}' IS DISTINCT FROM 'indeterminate'
		OR v_outcome.completion #>> '{application}' IS DISTINCT FROM
			'indeterminate'
		OR v_outcome.completion #> '{reconciliationRequired}' IS DISTINCT FROM
			'true'::jsonb
		OR v_completed_at IS NULL
		OR v_completed_at > v_now
		OR v_attempt.dispatched_at IS NULL
		OR v_completed_at < v_attempt.dispatched_at
		OR v_completed_at < v_outcome.recorded_at
		OR v_next_version IS DISTINCT FROM v_expected_version + 1
		OR v_expected_state IS DISTINCT FROM 'indeterminate'
		OR v_next_state IS DISTINCT FROM
			p_input #>> '{completion,completion,state}'
		OR v_next_state NOT IN ('executed', 'not-applied')
		OR NOT emdo.proposal_row_matches_input(
			v_proposal, v_next_version, v_next_state, p_input -> 'next'
		)
		OR p_input -> 'event' IS DISTINCT FROM v_expected_event
		OR NOT EXISTS (
			SELECT 1
			FROM emdo.workflow_operation_claims AS claim
			WHERE claim.phase = 'provider-write-dispatch'
				AND claim.claimed_at IS NOT NULL
				AND claim.proposal_id = v_proposal.id
				AND claim.household_id = v_proposal.household_id
				AND claim.space_id = v_proposal.space_id
				AND claim.original_owner_user_id =
					v_proposal.original_owner_user_id
				AND claim.run_id = v_proposal.run_id
				AND claim.disclosure_grant_id =
					v_proposal.disclosure_grant_id
				AND claim.decision_id = v_decision.id
				AND claim.provider_attempt_id = v_attempt.id
				AND claim.binding_hash = v_attempt.binding_hash
				AND claim.provider_sdk_call_id =
					v_attempt.provider_sdk_call_id
				AND claim.provider_authority_binding_hash =
					v_attempt.provider_authority_binding_hash
				AND claim.authorization_scope_fingerprint =
					v_proposal.authorization_scope_fingerprint
				AND claim.preparation_binding_hash =
					v_preparation.preparation_binding_hash
		)
	THEN
		RETURN 'conflict';
	END IF;
	IF v_has_reconciliation THEN
		RETURN CASE WHEN
			v_state.version = v_next_version
			AND v_state.state = v_next_state
			AND v_attempt.attempt_state = v_next_state
			AND v_reconciliation.completion =
				p_input #> '{completion,completion}'
			AND v_reconciliation.completion_hash =
				p_input #>> '{completion,completionHash}'
			AND v_reconciliation.recorded_at = v_completed_at
			AND EXISTS (
				SELECT 1 FROM emdo.proposal_events AS event
				WHERE event.proposal_id = v_proposal.id
					AND event.proposal_version = v_next_version
					AND event.event_type = 'proposal.' || v_next_state
					AND event.occurred_at = v_completed_at
					AND event.payload = p_input -> 'event'
			)
		THEN 'duplicate' ELSE 'conflict' END;
	END IF;
	IF v_state.version IS DISTINCT FROM v_expected_version
		OR v_state.state IS DISTINCT FROM 'indeterminate'
		OR v_attempt.attempt_state IS DISTINCT FROM 'indeterminate'
		OR v_proposal.approval_hash IS DISTINCT FROM v_expected_approval_hash
	THEN
		RETURN 'conflict';
	END IF;
	SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
	INTO v_sequence
	FROM emdo.proposal_events AS event
	WHERE event.proposal_id = v_proposal_id;
	UPDATE emdo.provider_attempts AS attempt
	SET attempt_state = v_next_state
	WHERE attempt.id = v_attempt_id
		AND attempt.attempt_state = 'indeterminate';
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = 'P0001',
			MESSAGE = 'provider attempt reconciliation CAS failed';
	END IF;
	UPDATE emdo.proposal_states AS state
	SET version = v_next_version, state = v_next_state, updated_at = v_now
	WHERE state.proposal_id = v_proposal_id
		AND state.version = v_expected_version
		AND state.state = 'indeterminate';
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = 'P0001',
			MESSAGE = 'proposal reconciliation state CAS failed';
	END IF;
	INSERT INTO emdo.proposal_reconciliations(
		attempt_id, household_id, space_id, original_owner_user_id,
		completion_hash, application, result_hash, evidence_hash,
		recorded_at, completion
	) VALUES (
		v_attempt.id, v_attempt.household_id, v_attempt.space_id,
		v_attempt.original_owner_user_id,
		p_input #>> '{completion,completionHash}',
		p_input #>> '{completion,completion,application}',
		p_input #>> '{completion,completion,resultHash}',
		p_input #>> '{completion,completion,evidenceHash}',
		v_completed_at, p_input #> '{completion,completion}'
	);
	INSERT INTO emdo.proposal_events(
		proposal_id, household_id, space_id, original_owner_user_id,
		proposal_version, sequence, event_type, payload, occurred_at
	) VALUES (
		v_proposal.id, v_proposal.household_id, v_proposal.space_id,
		v_proposal.original_owner_user_id, v_next_version, v_sequence,
		'proposal.' || v_next_state, p_input -> 'event', v_completed_at
	);
	RETURN 'created';
EXCEPTION
	WHEN data_exception OR integrity_constraint_violation OR raise_exception THEN
		RETURN 'conflict';
END
$function$;
--> statement-breakpoint

ALTER FUNCTION "emdo"."commit_provider_proposal_reconciliation"(jsonb)
	OWNER TO emdo_proposal_reconciliation_executor;
ALTER FUNCTION "emdo"."commit_provider_proposal_create"(text, jsonb)
	OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."commit_provider_proposal_abandonment"(jsonb)
	OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."commit_provider_proposal_transition"(jsonb)
	OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."commit_provider_proposal_decision"(text, jsonb)
	OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."commit_provider_proposal_prepare"(text, jsonb)
	OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."commit_provider_proposal_dispatch"(text, jsonb)
	OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."commit_provider_proposal_completion"(jsonb)
	OWNER TO emdo_workflow_executor;
GRANT USAGE ON SCHEMA "emdo" TO emdo_proposal_reconciliation_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."current_worker_job_name"(),
	"emdo"."current_worker_target_type"(),
	"emdo"."current_worker_target_id"(),
	"emdo"."is_active_worker_operation_scope"(uuid, uuid, uuid)
	TO emdo_proposal_reconciliation_executor;
GRANT SELECT ON
	"emdo"."action_proposals", "emdo"."proposal_states",
	"emdo"."proposal_preparations", "emdo"."action_decisions",
	"emdo"."provider_attempts", "emdo"."provider_outcomes",
	"emdo"."proposal_reconciliations", "emdo"."proposal_events",
	"emdo"."workflow_operation_claims"
	TO emdo_proposal_reconciliation_executor;
GRANT UPDATE ("version", "state", "updated_at")
	ON "emdo"."proposal_states"
	TO emdo_proposal_reconciliation_executor;
GRANT UPDATE ("attempt_state") ON "emdo"."provider_attempts"
	TO emdo_proposal_reconciliation_executor;
GRANT INSERT ON "emdo"."proposal_reconciliations", "emdo"."proposal_events"
	TO emdo_proposal_reconciliation_executor;
REVOKE INSERT ON "emdo"."proposal_reconciliations"
	FROM emdo_worker, emdo_worker_executor;
REVOKE ALL ON FUNCTION
	"emdo"."commit_provider_proposal_reconciliation"(jsonb)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login, emdo_visual_decision_login,
	emdo_proposal_reconciliation_executor;
REVOKE ALL ON FUNCTION
	"emdo"."commit_provider_proposal_create"(text, jsonb),
	"emdo"."commit_provider_proposal_abandonment"(jsonb),
	"emdo"."commit_provider_proposal_transition"(jsonb),
	"emdo"."commit_provider_proposal_decision"(text, jsonb),
	"emdo"."commit_provider_proposal_prepare"(text, jsonb),
	"emdo"."commit_provider_proposal_dispatch"(text, jsonb),
	"emdo"."commit_provider_proposal_completion"(jsonb)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login, emdo_visual_decision_login,
	emdo_proposal_reconciliation_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."commit_provider_proposal_create"(text, jsonb),
	"emdo"."commit_provider_proposal_abandonment"(jsonb),
	"emdo"."commit_provider_proposal_transition"(jsonb),
	"emdo"."commit_provider_proposal_decision"(text, jsonb),
	"emdo"."commit_provider_proposal_prepare"(text, jsonb),
	"emdo"."commit_provider_proposal_dispatch"(text, jsonb),
	"emdo"."commit_provider_proposal_completion"(jsonb)
	TO emdo_workflow_login;
GRANT USAGE ON SCHEMA "emdo" TO emdo_visual_decision_login;
GRANT EXECUTE ON FUNCTION
	"emdo"."commit_provider_proposal_decision"(text, jsonb)
	TO emdo_visual_decision_login;
GRANT EXECUTE ON FUNCTION
	"emdo"."commit_provider_proposal_reconciliation"(jsonb)
	TO emdo_worker_executor;
GRANT SELECT ON "emdo"."approval_resume_jobs",
	"emdo"."visual_decision_proofs"
	TO emdo_workflow_executor;
GRANT UPDATE (
	"decision_id", "decision_type", "authenticated_session_id", "state",
	"revision", "updated_at"
)
	ON "emdo"."approval_resume_jobs" TO emdo_workflow_executor;
GRANT UPDATE ("consumed_at", "decision_id", "row_version")
	ON "emdo"."visual_decision_proofs" TO emdo_workflow_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."visual_decision_proof_issuance_fingerprint"(
		uuid, text, text, text, uuid, uuid, uuid, uuid, uuid, integer, text,
		text, text, uuid, timestamptz, timestamptz
	)
	TO emdo_workflow_executor;

ALTER FUNCTION "emdo"."claim_approval_resume_job"(uuid, uuid, uuid)
	OWNER TO emdo_approval_resume_executor;
ALTER FUNCTION "emdo"."settle_approval_resume_job"(
	uuid, text, text, text, jsonb
) OWNER TO emdo_approval_resume_executor;
GRANT USAGE ON SCHEMA "emdo" TO emdo_approval_resume_executor;
GRANT SELECT ON "emdo"."approval_resume_jobs"
	TO emdo_approval_resume_executor;
GRANT UPDATE (
	"state", "revision", "claim_id", "ownership_token_digest",
	"resume_request_id", "resume_space_access_grant_id",
	"collection_authorization_scope_fingerprint", "claimed_at",
	"claim_expires_at", "terminal_event_sequence", "terminal_reason_code",
	"terminal_result_hash", "updated_at"
) ON "emdo"."approval_resume_jobs" TO emdo_approval_resume_executor;
GRANT SELECT ON
	"emdo"."action_decisions", "emdo"."action_proposals",
	"emdo"."proposal_states", "emdo"."disclosure_grants",
	"emdo"."approval_checkpoints", "emdo"."agent_run_events"
	TO emdo_approval_resume_executor;
GRANT UPDATE ("state", "revision", "updated_at")
	ON "emdo"."approval_checkpoints" TO emdo_approval_resume_executor;
GRANT INSERT ON "emdo"."agent_run_events"
	TO emdo_approval_resume_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."current_user_id"(), "emdo"."current_session_id"(),
	"emdo"."current_request_id"(),
	"emdo"."lock_current_authorization_scope"(uuid, uuid, uuid),
	"emdo"."issue_space_access_grant"(uuid, uuid, text)
	TO emdo_approval_resume_executor;
REVOKE ALL ON "emdo"."approval_resume_jobs"
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_approval_resume_executor;
GRANT SELECT ON "emdo"."approval_resume_jobs"
	TO emdo_approval_resume_executor, emdo_workflow_executor;
GRANT UPDATE (
	"state", "revision", "claim_id", "ownership_token_digest",
	"resume_request_id", "resume_space_access_grant_id",
	"collection_authorization_scope_fingerprint", "claimed_at",
	"claim_expires_at", "terminal_event_sequence", "terminal_reason_code",
	"terminal_result_hash", "updated_at"
) ON "emdo"."approval_resume_jobs" TO emdo_approval_resume_executor;
GRANT UPDATE (
	"decision_id", "decision_type", "authenticated_session_id", "state",
	"revision", "updated_at"
) ON "emdo"."approval_resume_jobs" TO emdo_workflow_executor;
REVOKE ALL ON FUNCTION
	"emdo"."claim_approval_resume_job"(uuid, uuid, uuid),
	"emdo"."settle_approval_resume_job"(uuid, text, text, text, jsonb)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login,
	emdo_proposal_reconciliation_executor, emdo_approval_resume_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."claim_approval_resume_job"(uuid, uuid, uuid),
	"emdo"."settle_approval_resume_job"(uuid, text, text, text, jsonb)
	TO emdo_app;
REVOKE ALL ON FUNCTION
	"emdo"."enforce_approval_resume_job_transition"()
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login,
	emdo_proposal_reconciliation_executor, emdo_approval_resume_executor;

ALTER FUNCTION "emdo"."resolve_provider_proposal_decision_replay"(
	uuid, uuid, text, text, uuid
) OWNER TO emdo_visual_proof_executor;
GRANT SELECT ON "emdo"."action_decisions" TO emdo_visual_proof_executor;
GRANT UPDATE ("id") ON "emdo"."action_decisions"
	TO emdo_visual_proof_executor;
REVOKE ALL ON FUNCTION
	"emdo"."resolve_provider_proposal_decision_replay"(
		uuid, uuid, text, text, uuid
	)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login,
	emdo_proposal_reconciliation_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."resolve_provider_proposal_decision_replay"(
		uuid, uuid, text, text, uuid
	)
	TO emdo_app;
--> statement-breakpoint

-- Approval queries expose only the immutable, approval-hash-bound display
-- projection. A fresh grant is locked for every call, while the cursor's
-- authenticated query binding is re-derived independently in SQL.
DO $proposal_query_role$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_proposal_query_executor'
	) THEN
		CREATE ROLE emdo_proposal_query_executor NOLOGIN NOSUPERUSER NOCREATEDB
			NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$proposal_query_role$;
ALTER ROLE emdo_proposal_query_executor NOLOGIN NOSUPERUSER NOCREATEDB
	NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
DO $proposal_query_membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname = 'emdo_proposal_query_executor'
			OR child.rolname = 'emdo_proposal_query_executor'
	) THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'proposal query executor must not have role memberships';
	END IF;
END
$proposal_query_membership_guard$;
--> statement-breakpoint

CREATE POLICY proposal_query_proposals_read
	ON "emdo"."action_proposals"
	FOR SELECT TO emdo_proposal_query_executor USING (true);
CREATE POLICY proposal_query_states_read
	ON "emdo"."proposal_states"
	FOR SELECT TO emdo_proposal_query_executor USING (true);
CREATE POLICY proposal_app_owner_only_raw_read
	ON "emdo"."action_proposals" AS RESTRICTIVE
	FOR SELECT TO emdo_app
	USING ("original_owner_user_id" = emdo.current_user_id());
CREATE POLICY proposal_state_app_owner_only_raw_read
	ON "emdo"."proposal_states" AS RESTRICTIVE
	FOR SELECT TO emdo_app
	USING ("original_owner_user_id" = emdo.current_user_id());
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."list_proposal_approval_sources"(
	p_household_id uuid,
	p_fresh_grant_id uuid,
	p_state text,
	p_expected_scope text,
	p_cursor_created_at timestamptz,
	p_cursor_id uuid,
	p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_scope record;
	v_query_fingerprint text;
	v_sources jsonb;
	v_count integer;
BEGIN
	IF p_household_id IS NULL OR p_fresh_grant_id IS NULL
		OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50
		OR p_expected_scope IS NULL
		OR p_expected_scope !~ '^[a-f0-9]{64}$'
		OR p_state IS NOT NULL AND p_state NOT IN (
			'pending', 'approved', 'rejected', 'prepared', 'executing',
			'executed', 'not-applied', 'indeterminate', 'expired', 'failed'
		)
		OR (p_cursor_created_at IS NULL AND p_cursor_id IS NOT NULL)
		OR (p_cursor_created_at IS NOT NULL AND p_cursor_id IS NULL)
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'invalid-cursor');
	END IF;

	SELECT scope.* INTO v_scope
	FROM emdo.lock_current_authorization_scope(
		p_fresh_grant_id, NULL, NULL
	) AS scope;
	IF NOT FOUND OR v_scope.household_id IS DISTINCT FROM p_household_id THEN
		RETURN pg_catalog.jsonb_build_object('status', 'invalid-cursor');
	END IF;
	v_query_fingerprint := pg_catalog.encode(
		pg_catalog.sha256(
			pg_catalog.convert_to('emdo.proposal-query.v1', 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(
				v_scope.authorization_scope_fingerprint, 'UTF8'
			)
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(COALESCE(p_state, ''), 'UTF8')
			|| pg_catalog.decode('00', 'hex')
			|| pg_catalog.convert_to(
				'created-at-desc-id-desc-v1', 'UTF8'
			)
		),
		'hex'
	);
	IF p_expected_scope IS DISTINCT FROM v_query_fingerprint THEN
		RETURN pg_catalog.jsonb_build_object('status', 'invalid-cursor');
	END IF;

	WITH bounded AS MATERIALIZED (
		SELECT proposal.id, state.version, state.state,
			proposal.capability_id, proposal.payload_hash,
			proposal.approval_hash, proposal.approval_display,
			proposal.created_at, proposal.expires_at
		FROM emdo.action_proposals AS proposal
		JOIN emdo.proposal_states AS state
			ON state.proposal_id = proposal.id
		WHERE proposal.household_id = p_household_id
			AND proposal.original_owner_user_id = v_scope.user_id
			AND proposal.space_id = ANY(v_scope.writable_space_ids)
			AND (p_state IS NULL OR state.state = p_state)
			AND (
				p_cursor_created_at IS NULL
				OR (proposal.created_at, proposal.id)
					< (p_cursor_created_at, p_cursor_id)
			)
		ORDER BY proposal.created_at DESC, proposal.id DESC
		LIMIT (p_limit + 1)
	), projected AS (
		SELECT pg_catalog.jsonb_build_object(
			'id', bounded.id,
			'version', bounded.version,
			'state', bounded.state,
			'capabilityId', bounded.capability_id,
			'payloadHash', bounded.payload_hash,
			'approvalHash', bounded.approval_hash,
			'approvalDisplay', bounded.approval_display,
			'createdAt', bounded.created_at,
			'expiresAt', bounded.expires_at
		) AS source,
		pg_catalog.row_number() OVER (
			ORDER BY bounded.created_at DESC, bounded.id DESC
		) AS ordinal
		FROM bounded
	)
	SELECT COALESCE(
		pg_catalog.jsonb_agg(source ORDER BY ordinal)
			FILTER (WHERE ordinal <= p_limit),
		'[]'::jsonb
	), pg_catalog.count(*)::integer
	INTO v_sources, v_count
	FROM projected;

	RETURN pg_catalog.jsonb_build_object(
		'status', 'ok',
		'page', pg_catalog.jsonb_build_object(
			'schemaVersion', 1,
			'authorizationScopeFingerprint',
				v_scope.authorization_scope_fingerprint,
			'sources', v_sources,
			'hasMore', v_count > p_limit
		)
	);
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."get_proposal_approval_source"(
	p_household_id uuid,
	p_fresh_grant_id uuid,
	p_proposal_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_scope record;
	v_source jsonb;
BEGIN
	IF p_household_id IS NULL OR p_fresh_grant_id IS NULL
		OR p_proposal_id IS NULL
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'not-found');
	END IF;
	SELECT scope.* INTO v_scope
	FROM emdo.lock_current_authorization_scope(
		p_fresh_grant_id, p_proposal_id, NULL
	) AS scope;
	IF NOT FOUND OR v_scope.household_id IS DISTINCT FROM p_household_id THEN
		RETURN pg_catalog.jsonb_build_object('status', 'not-found');
	END IF;

	SELECT pg_catalog.jsonb_build_object(
		'id', proposal.id,
		'version', state.version,
		'state', state.state,
		'capabilityId', proposal.capability_id,
		'payloadHash', proposal.payload_hash,
		'approvalHash', proposal.approval_hash,
		'approvalDisplay', proposal.approval_display,
		'createdAt', proposal.created_at,
		'expiresAt', proposal.expires_at
	) INTO v_source
	FROM emdo.action_proposals AS proposal
	JOIN emdo.proposal_states AS state ON state.proposal_id = proposal.id
	WHERE proposal.id = p_proposal_id
		AND proposal.household_id = p_household_id
		AND proposal.original_owner_user_id = v_scope.user_id
		AND proposal.space_id = v_scope.proposal_space_id
		AND proposal.authorization_scope_fingerprint =
			v_scope.authorization_scope_fingerprint;
	IF NOT FOUND THEN
		RETURN pg_catalog.jsonb_build_object('status', 'not-found');
	END IF;
	RETURN pg_catalog.jsonb_build_object('status', 'ok', 'source', v_source);
END
$function$;
--> statement-breakpoint

ALTER FUNCTION "emdo"."list_proposal_approval_sources"(
	uuid, uuid, text, text, timestamptz, uuid, integer
) OWNER TO emdo_proposal_query_executor;
ALTER FUNCTION "emdo"."get_proposal_approval_source"(uuid, uuid, uuid)
	OWNER TO emdo_proposal_query_executor;
GRANT USAGE ON SCHEMA "emdo" TO emdo_proposal_query_executor;
GRANT SELECT ON "emdo"."action_proposals", "emdo"."proposal_states"
	TO emdo_proposal_query_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."lock_current_authorization_scope"(uuid, uuid, uuid)
	TO emdo_proposal_query_executor, emdo_visual_proof_executor;
REVOKE ALL ON FUNCTION
	"emdo"."list_proposal_approval_sources"(
		uuid, uuid, text, text, timestamptz, uuid, integer
	),
	"emdo"."get_proposal_approval_source"(uuid, uuid, uuid)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login,
	emdo_proposal_reconciliation_executor, emdo_proposal_query_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."list_proposal_approval_sources"(
		uuid, uuid, text, text, timestamptz, uuid, integer
	),
	"emdo"."get_proposal_approval_source"(uuid, uuid, uuid)
	TO emdo_app;
--> statement-breakpoint

-- Manager turns are committed through one database-owned aggregate. The
-- request's immutable origin authority is preserved separately from the
-- operation scope re-derived after the run exists; neither fingerprint is
-- accepted from the application.
DO $manager_turn_role$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_manager_turn_executor'
	) THEN
		CREATE ROLE emdo_manager_turn_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$manager_turn_role$;
ALTER ROLE emdo_manager_turn_executor NOLOGIN NOSUPERUSER NOCREATEDB
	NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
DO $manager_turn_membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname = 'emdo_manager_turn_executor'
			OR child.rolname = 'emdo_manager_turn_executor'
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'manager turn executor must not have role memberships';
	END IF;
END
$manager_turn_membership_guard$;
--> statement-breakpoint

CREATE TABLE "emdo"."manager_turns" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"schema_version" smallint DEFAULT 1 NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"origin_session_id" uuid NOT NULL,
	"origin_request_id" uuid NOT NULL,
	"origin_space_access_grant_id" uuid NOT NULL,
	"origin_collection_authorization_scope_fingerprint" text NOT NULL,
	"origin_operation_authorization_scope_fingerprint" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_payload" jsonb NOT NULL,
	"request_hash" text NOT NULL,
	"manager_agent_version" text NOT NULL,
	"requested_model" text NOT NULL,
	"claim_id" uuid NOT NULL,
	"ownership_token_hash" text NOT NULL,
	"state" text DEFAULT 'claimed' NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"result" jsonb,
	"result_hash" text,
	"terminal_event_sequence" bigint,
	"approval_checkpoint_id" uuid,
	"reason_code" text,
	"created_at" timestamptz NOT NULL,
	"updated_at" timestamptz NOT NULL,
	"retain_until" timestamptz NOT NULL,
	CONSTRAINT "manager_turns_household_user_idempotency_unique"
		UNIQUE ("household_id", "user_id", "idempotency_key"),
	CONSTRAINT "manager_turns_claim_unique" UNIQUE ("claim_id"),
	CONSTRAINT "manager_turns_run_fk" FOREIGN KEY (
		"household_id", "space_id", "user_id", "run_id"
	) REFERENCES "emdo"."agent_runs" (
		"household_id", "space_id", "original_owner_user_id", "id"
	) ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "manager_turns_origin_session_fk" FOREIGN KEY (
		"origin_session_id"
	) REFERENCES "emdo"."auth_sessions" ("id")
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "manager_turns_origin_grant_fk" FOREIGN KEY (
		"origin_space_access_grant_id"
	) REFERENCES "emdo"."space_access_grants" ("grant_id")
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "manager_turns_terminal_event_fk" FOREIGN KEY (
		"run_id", "terminal_event_sequence"
	) REFERENCES "emdo"."agent_run_events" ("run_id", "sequence")
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "manager_turns_approval_checkpoint_fk" FOREIGN KEY (
		"approval_checkpoint_id"
	) REFERENCES "emdo"."approval_checkpoints" ("checkpoint_id")
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "manager_turns_schema_revision_check" CHECK (
		"schema_version" = 1 AND "revision" > 0
	),
	CONSTRAINT "manager_turns_authority_check" CHECK (
		"origin_collection_authorization_scope_fingerprint"
			~ '^[a-f0-9]{64}$'
		AND "origin_operation_authorization_scope_fingerprint"
			~ '^[a-f0-9]{64}$'
	),
	CONSTRAINT "manager_turns_idempotency_check" CHECK (
		pg_catalog.length("idempotency_key") BETWEEN 16 AND 200
		AND "idempotency_key" ~ '^[A-Za-z0-9:._-]+$'
	),
	CONSTRAINT "manager_turns_request_check" CHECK (
		pg_catalog.jsonb_typeof("request_payload") = 'object'
		AND pg_catalog.octet_length("request_payload"::text) <= 131072
		AND "request_hash" ~ '^[a-f0-9]{64}$'
		AND "request_hash" = emdo.canonical_json_hash("request_payload")
	),
	CONSTRAINT "manager_turns_runtime_check" CHECK (
		pg_catalog.length("manager_agent_version") BETWEEN 5 AND 64
		AND "manager_agent_version"
			~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
		AND "requested_model" IN ('gpt-5.6-luna', 'gpt-5.6-terra')
		AND "ownership_token_hash" ~ '^[a-f0-9]{64}$'
	),
	CONSTRAINT "manager_turns_state_check" CHECK (
		(
			"state" = 'claimed'
			AND "result" IS NULL
			AND "result_hash" IS NULL
			AND "terminal_event_sequence" IS NULL
			AND "approval_checkpoint_id" IS NULL
			AND "reason_code" IS NULL
		)
		OR (
			"state" IN ('completed', 'failed', 'needs-approval')
			AND pg_catalog.jsonb_typeof("result") = 'object'
			AND pg_catalog.octet_length("result"::text) <= 1400000
			AND "result_hash" ~ '^[a-f0-9]{64}$'
			AND "result_hash" = emdo.canonical_json_hash("result")
			AND "terminal_event_sequence" > 0
			AND (
				("state" = 'needs-approval' AND "approval_checkpoint_id" IS NOT NULL)
				OR (
					"state" IN ('completed', 'failed')
					AND "approval_checkpoint_id" IS NULL
				)
			)
			AND "reason_code" IS NULL
		)
		OR (
			"state" = 'indeterminate'
			AND pg_catalog.jsonb_typeof("result") = 'object'
			AND pg_catalog.octet_length("result"::text) <= 1400000
			AND "result_hash" ~ '^[a-f0-9]{64}$'
			AND "result_hash" = emdo.canonical_json_hash("result")
			AND "terminal_event_sequence" > 0
			AND "approval_checkpoint_id" IS NULL
			AND "reason_code" = 'agent-runtime-failed'
		)
	),
	CONSTRAINT "manager_turns_retention_check" CHECK (
		"updated_at" >= "created_at"
		AND "retain_until" > "created_at"
		AND "retain_until" <= "created_at" + interval '90 days'
	)
);
CREATE INDEX "manager_turns_household_user_created_idx"
	ON "emdo"."manager_turns" (
		"household_id", "user_id", "created_at" DESC
	);
CREATE INDEX "manager_turns_household_space_idx"
	ON "emdo"."manager_turns" ("household_id", "space_id");
--> statement-breakpoint

-- Each database command records its exact public result before commit. A
-- caller that loses the COMMIT acknowledgement can only recover a receipt
-- whose operation hash, claim identity, and ownership digest all match.
CREATE TABLE "emdo"."manager_turn_operations" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_claim_id" uuid NOT NULL,
	"request_ownership_token_hash" text NOT NULL,
	"operation_kind" text NOT NULL,
	"operation_hash" text NOT NULL,
	"result_hash" text,
	"stored_result" jsonb NOT NULL,
	"recorded_at" timestamptz NOT NULL,
	"retain_until" timestamptz NOT NULL,
	CONSTRAINT "manager_turn_operations_turn_fk" FOREIGN KEY ("run_id")
		REFERENCES "emdo"."manager_turns" ("run_id")
		ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "manager_turn_operations_kind_check" CHECK (
		"operation_kind" IN ('claim', 'complete', 'indeterminate')
	),
	CONSTRAINT "manager_turn_operations_hash_check" CHECK (
		"request_ownership_token_hash" ~ '^[a-f0-9]{64}$'
		AND "operation_hash" ~ '^[a-f0-9]{64}$'
		AND ("result_hash" IS NULL OR "result_hash" ~ '^[a-f0-9]{64}$')
	),
	CONSTRAINT "manager_turn_operations_result_check" CHECK (
		pg_catalog.jsonb_typeof("stored_result") = 'object'
		AND pg_catalog.octet_length("stored_result"::text) <= 65536
	),
	CONSTRAINT "manager_turn_operations_retention_check" CHECK (
		"retain_until" > "recorded_at"
		AND "retain_until" <= "recorded_at" + interval '90 days'
	)
);
CREATE INDEX "manager_turn_operations_run_recorded_idx"
	ON "emdo"."manager_turn_operations" ("run_id", "recorded_at");
CREATE TRIGGER manager_turn_operations_append_only
BEFORE UPDATE OR DELETE ON "emdo"."manager_turn_operations"
FOR EACH ROW EXECUTE FUNCTION "emdo"."reject_append_only_mutation"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."enforce_manager_turn_transition"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
	IF TG_OP = 'DELETE'
		OR NEW.run_id <> OLD.run_id
		OR NEW.schema_version <> OLD.schema_version
		OR NEW.household_id <> OLD.household_id
		OR NEW.space_id <> OLD.space_id
		OR NEW.user_id <> OLD.user_id
		OR NEW.conversation_id <> OLD.conversation_id
		OR NEW.origin_session_id <> OLD.origin_session_id
		OR NEW.origin_request_id <> OLD.origin_request_id
		OR NEW.origin_space_access_grant_id <>
			OLD.origin_space_access_grant_id
		OR NEW.origin_collection_authorization_scope_fingerprint <>
			OLD.origin_collection_authorization_scope_fingerprint
		OR NEW.origin_operation_authorization_scope_fingerprint <>
			OLD.origin_operation_authorization_scope_fingerprint
		OR NEW.idempotency_key <> OLD.idempotency_key
		OR NEW.request_payload IS DISTINCT FROM OLD.request_payload
		OR NEW.request_hash <> OLD.request_hash
		OR NEW.manager_agent_version <> OLD.manager_agent_version
		OR NEW.requested_model <> OLD.requested_model
		OR NEW.claim_id <> OLD.claim_id
		OR NEW.ownership_token_hash <> OLD.ownership_token_hash
		OR NEW.created_at <> OLD.created_at
		OR NEW.retain_until <> OLD.retain_until
		OR OLD.state <> 'claimed'
		OR NEW.state NOT IN (
			'completed', 'failed', 'needs-approval', 'indeterminate'
		)
		OR NEW.revision <> OLD.revision + 1
		OR NEW.updated_at < OLD.updated_at
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'invalid manager turn transition';
	END IF;
	RETURN NEW;
END
$function$;
CREATE TRIGGER manager_turns_transition
BEFORE UPDATE OR DELETE ON "emdo"."manager_turns"
FOR EACH ROW EXECUTE FUNCTION "emdo"."enforce_manager_turn_transition"();
--> statement-breakpoint

ALTER TABLE "emdo"."manager_turns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."manager_turns" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."manager_turn_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."manager_turn_operations" FORCE ROW LEVEL SECURITY;
CREATE POLICY manager_turns_executor_select ON "emdo"."manager_turns"
	FOR SELECT TO emdo_manager_turn_executor USING (true);
CREATE POLICY manager_turns_executor_insert ON "emdo"."manager_turns"
	FOR INSERT TO emdo_manager_turn_executor WITH CHECK (true);
CREATE POLICY manager_turns_executor_update ON "emdo"."manager_turns"
	FOR UPDATE TO emdo_manager_turn_executor USING (true) WITH CHECK (true);
CREATE POLICY manager_turn_operations_executor_select
	ON "emdo"."manager_turn_operations"
	FOR SELECT TO emdo_manager_turn_executor USING (true);
CREATE POLICY manager_turn_operations_executor_insert
	ON "emdo"."manager_turn_operations"
	FOR INSERT TO emdo_manager_turn_executor WITH CHECK (true);

CREATE POLICY manager_turn_agent_runs_select ON "emdo"."agent_runs"
	FOR SELECT TO emdo_manager_turn_executor USING (true);
CREATE POLICY manager_turn_agent_runs_insert ON "emdo"."agent_runs"
	FOR INSERT TO emdo_manager_turn_executor WITH CHECK (true);
CREATE POLICY manager_turn_agent_runs_update ON "emdo"."agent_runs"
	FOR UPDATE TO emdo_manager_turn_executor USING (true) WITH CHECK (true);
CREATE POLICY manager_turn_run_events_select ON "emdo"."agent_run_events"
	FOR SELECT TO emdo_manager_turn_executor USING (true);
CREATE POLICY manager_turn_run_events_insert ON "emdo"."agent_run_events"
	FOR INSERT TO emdo_manager_turn_executor WITH CHECK (true);
CREATE POLICY manager_turn_checkpoints_select ON "emdo"."approval_checkpoints"
	FOR SELECT TO emdo_manager_turn_executor USING (true);
CREATE POLICY manager_turn_resume_jobs_select ON "emdo"."approval_resume_jobs"
	FOR SELECT TO emdo_manager_turn_executor USING (true);
CREATE POLICY manager_turn_resume_jobs_insert ON "emdo"."approval_resume_jobs"
	FOR INSERT TO emdo_manager_turn_executor WITH CHECK (true);
CREATE POLICY manager_turn_proposals_select ON "emdo"."action_proposals"
	FOR SELECT TO emdo_manager_turn_executor USING (true);
CREATE POLICY manager_turn_proposal_states_select ON "emdo"."proposal_states"
	FOR SELECT TO emdo_manager_turn_executor USING (true);
CREATE POLICY manager_turn_preparations_select ON "emdo"."proposal_preparations"
	FOR SELECT TO emdo_manager_turn_executor USING (true);
CREATE POLICY manager_turn_disclosures_select ON "emdo"."disclosure_grants"
	FOR SELECT TO emdo_manager_turn_executor USING (true);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."record_manager_turn_operation"(
	p_operation_id uuid,
	p_run_id uuid,
	p_operation_kind text,
	p_operation_hash text,
	p_request_claim_id uuid,
	p_request_ownership_token_hash text,
	p_result_hash text,
	p_stored_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_turn emdo.manager_turns%ROWTYPE;
	v_operation emdo.manager_turn_operations%ROWTYPE;
	v_now timestamptz;
BEGIN
	SELECT turn.* INTO v_turn
	FROM emdo.manager_turns AS turn
	WHERE turn.run_id = p_run_id;
	IF NOT FOUND THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	v_now := pg_catalog.clock_timestamp();
	INSERT INTO emdo.manager_turn_operations(
		operation_id, run_id, household_id, user_id,
		request_claim_id, request_ownership_token_hash,
		operation_kind, operation_hash, result_hash, stored_result,
		recorded_at, retain_until
	) VALUES (
		p_operation_id, p_run_id, v_turn.household_id, v_turn.user_id,
		p_request_claim_id, p_request_ownership_token_hash,
		p_operation_kind, p_operation_hash, p_result_hash, p_stored_result,
		v_now, v_now + interval '90 days'
	)
	ON CONFLICT (operation_id) DO NOTHING;

	SELECT operation.* INTO v_operation
	FROM emdo.manager_turn_operations AS operation
	WHERE operation.operation_id = p_operation_id;
	IF NOT FOUND
		OR v_operation.run_id IS DISTINCT FROM p_run_id
		OR v_operation.household_id IS DISTINCT FROM v_turn.household_id
		OR v_operation.user_id IS DISTINCT FROM v_turn.user_id
		OR v_operation.request_claim_id IS DISTINCT FROM p_request_claim_id
		OR v_operation.request_ownership_token_hash IS DISTINCT FROM
			p_request_ownership_token_hash
		OR v_operation.operation_kind IS DISTINCT FROM p_operation_kind
		OR v_operation.operation_hash IS DISTINCT FROM p_operation_hash
		OR v_operation.result_hash IS DISTINCT FROM p_result_hash
		OR v_operation.stored_result IS DISTINCT FROM p_stored_result
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	RETURN v_operation.stored_result;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."claim_manager_turn"(
	p_operation_id uuid,
	p_operation_hash text,
	p_candidate_run_id uuid,
	p_candidate_conversation_id uuid,
	p_request_claim_id uuid,
	p_request_ownership_token_hash text,
	p_idempotency_key text,
	p_request jsonb,
	p_household_id uuid,
	p_space_access_grant_id uuid,
	p_role text,
	p_manager_agent_version text,
	p_requested_model text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_collection_scope record;
	v_operation_scope record;
	v_existing_operation emdo.manager_turn_operations%ROWTYPE;
	v_existing_turn emdo.manager_turns%ROWTYPE;
	v_request_hash text;
	v_expected_operation_hash text;
	v_result jsonb;
	v_now timestamptz;
BEGIN
	IF p_operation_id IS NULL
		OR p_operation_hash !~ '^[a-f0-9]{64}$'
		OR p_candidate_run_id IS NULL
		OR p_candidate_conversation_id IS NULL
		OR p_request_claim_id IS NULL
		OR p_request_ownership_token_hash !~ '^[a-f0-9]{64}$'
		OR pg_catalog.length(p_idempotency_key) NOT BETWEEN 16 AND 200
		OR p_idempotency_key !~ '^[A-Za-z0-9:._-]+$'
		OR pg_catalog.jsonb_typeof(p_request) IS DISTINCT FROM 'object'
		OR pg_catalog.octet_length(p_request::text) > 131072
		OR NOT (p_request ?& ARRAY['schemaVersion', 'message']::text[])
		OR p_request - ARRAY[
			'schemaVersion', 'conversationId', 'message', 'routeHint'
		]::text[] <> '{}'::jsonb
		OR p_request -> 'schemaVersion' IS DISTINCT FROM '1'::jsonb
		OR pg_catalog.jsonb_typeof(p_request -> 'message')
			IS DISTINCT FROM 'string'
		OR pg_catalog.length(p_request ->> 'message') NOT BETWEEN 1 AND 16000
		OR pg_catalog.btrim(p_request ->> 'message')
			IS DISTINCT FROM p_request ->> 'message'
		OR (
			p_request ? 'routeHint'
			AND p_request ->> 'routeHint'
				NOT IN ('scheduler', 'finance', 'shopping')
		)
		OR (
			p_request ? 'conversationId'
			AND p_request ->> 'conversationId'
				IS DISTINCT FROM p_candidate_conversation_id::text
		)
		OR p_household_id IS NULL
		OR p_space_access_grant_id IS NULL
		OR p_role NOT IN ('owner', 'member')
		OR pg_catalog.length(p_manager_agent_version) NOT BETWEEN 5 AND 64
		OR p_manager_agent_version
			!~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
		OR p_requested_model NOT IN ('gpt-5.6-luna', 'gpt-5.6-terra')
		OR emdo.current_user_id() IS NULL
		OR emdo.current_session_id() IS NULL
		OR emdo.current_request_id() IS NULL
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;

	SELECT scope.* INTO v_collection_scope
	FROM emdo.lock_current_authorization_scope(
		p_space_access_grant_id, NULL, NULL
	) AS scope;
	IF NOT FOUND
		OR v_collection_scope.user_id IS DISTINCT FROM emdo.current_user_id()
		OR v_collection_scope.session_id IS DISTINCT FROM
			emdo.current_session_id()
		OR v_collection_scope.request_id IS DISTINCT FROM
			emdo.current_request_id()
		OR v_collection_scope.household_id IS DISTINCT FROM p_household_id
		OR v_collection_scope.role IS DISTINCT FROM p_role
		OR v_collection_scope.proposal_space_id IS NOT NULL
		OR v_collection_scope.authorization_scope_fingerprint
			!~ '^[a-f0-9]{64}$'
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;

	v_request_hash := emdo.canonical_json_hash(p_request);
	v_expected_operation_hash := emdo.canonical_json_hash(
		pg_catalog.jsonb_build_object(
			'domain', 'emdo.manager-turn-operation.v1',
			'kind', 'claim',
			'operationId', p_operation_id,
			'candidateRunId', p_candidate_run_id,
			'candidateConversationId', p_candidate_conversation_id,
			'requestClaimId', p_request_claim_id,
			'requestOwnershipTokenHash', p_request_ownership_token_hash,
			'idempotencyKey', p_idempotency_key,
			'request', p_request,
			'householdId', p_household_id,
			'userId', emdo.current_user_id(),
			'sessionId', emdo.current_session_id(),
			'requestId', emdo.current_request_id(),
			'spaceAccessGrantId', p_space_access_grant_id,
			'role', p_role,
			'managerAgentVersion', p_manager_agent_version,
			'requestedModel', p_requested_model
		)
	);
	IF p_operation_hash IS DISTINCT FROM v_expected_operation_hash THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;

	SELECT operation.* INTO v_existing_operation
	FROM emdo.manager_turn_operations AS operation
	WHERE operation.operation_id = p_operation_id;
	IF FOUND THEN
		RETURN CASE WHEN
			v_existing_operation.operation_kind = 'claim'
			AND v_existing_operation.operation_hash = p_operation_hash
			AND v_existing_operation.request_claim_id = p_request_claim_id
			AND v_existing_operation.request_ownership_token_hash =
				p_request_ownership_token_hash
			AND v_existing_operation.household_id = p_household_id
			AND v_existing_operation.user_id = emdo.current_user_id()
		THEN v_existing_operation.stored_result
		ELSE pg_catalog.jsonb_build_object('status', 'conflict') END;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			p_household_id::text || ':' || emdo.current_user_id()::text || ':' ||
			p_idempotency_key,
			0
		)
	);
	SELECT turn.* INTO v_existing_turn
	FROM emdo.manager_turns AS turn
	WHERE turn.household_id = p_household_id
		AND turn.user_id = emdo.current_user_id()
		AND turn.idempotency_key = p_idempotency_key
	FOR UPDATE OF turn;
	IF FOUND THEN
		IF v_existing_turn.request_hash IS DISTINCT FROM v_request_hash
			OR v_existing_turn.request_payload IS DISTINCT FROM p_request
			OR v_existing_turn.manager_agent_version IS DISTINCT FROM
				p_manager_agent_version
			OR v_existing_turn.requested_model IS DISTINCT FROM
				p_requested_model
		THEN
			v_result := pg_catalog.jsonb_build_object('status', 'conflict');
		ELSE
			v_result := pg_catalog.jsonb_build_object(
				'status', 'replay',
				'runId', v_existing_turn.run_id,
				'conversationId', v_existing_turn.conversation_id
			);
		END IF;
		RETURN emdo.record_manager_turn_operation(
			p_operation_id, v_existing_turn.run_id, 'claim',
			p_operation_hash, p_request_claim_id,
			p_request_ownership_token_hash, NULL, v_result
		);
	END IF;

	v_now := pg_catalog.clock_timestamp();
	INSERT INTO emdo.agent_runs(
		id, household_id, space_id, original_owner_user_id, parent_run_id,
		agent_id, agent_version, requested_model, resolved_model,
		model_reason, status, local_trace_reference, safe_error, usage,
		created_at, completed_at, retain_until
	) VALUES (
		p_candidate_run_id, p_household_id,
		v_collection_scope.private_space_id, emdo.current_user_id(), NULL,
		'manager', p_manager_agent_version, p_requested_model, NULL,
		NULL, 'running', NULL, NULL, NULL, v_now, NULL,
		v_now + interval '90 days'
	);

	-- This is the fresh operation scope for the newly created run. It remains
	-- distinct from immutable origin lineage even though both are derived from
	-- the same still-current request grant at initial claim time.
	SELECT scope.* INTO v_operation_scope
	FROM emdo.lock_current_authorization_scope(
		p_space_access_grant_id, NULL, p_candidate_run_id
	) AS scope;
	IF NOT FOUND
		OR v_operation_scope.user_id IS DISTINCT FROM
			v_collection_scope.user_id
		OR v_operation_scope.session_id IS DISTINCT FROM
			v_collection_scope.session_id
		OR v_operation_scope.request_id IS DISTINCT FROM
			v_collection_scope.request_id
		OR v_operation_scope.household_id IS DISTINCT FROM p_household_id
		OR v_operation_scope.proposal_space_id IS DISTINCT FROM
			v_collection_scope.private_space_id
		OR v_operation_scope.authorization_scope_fingerprint
			!~ '^[a-f0-9]{64}$'
	THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001', MESSAGE = 'manager run scope derivation failed';
	END IF;

	INSERT INTO emdo.manager_turns(
		run_id, schema_version, household_id, space_id, user_id,
		conversation_id, origin_session_id, origin_request_id,
		origin_space_access_grant_id,
		origin_collection_authorization_scope_fingerprint,
		origin_operation_authorization_scope_fingerprint,
		idempotency_key, request_payload, request_hash,
		manager_agent_version, requested_model, claim_id,
		ownership_token_hash, state, revision, result, result_hash,
		terminal_event_sequence, reason_code, created_at, updated_at,
		retain_until
	) VALUES (
		p_candidate_run_id, 1, p_household_id,
		v_collection_scope.private_space_id, emdo.current_user_id(),
		p_candidate_conversation_id, emdo.current_session_id(),
		emdo.current_request_id(), p_space_access_grant_id,
		v_collection_scope.authorization_scope_fingerprint,
		v_operation_scope.authorization_scope_fingerprint,
		p_idempotency_key, p_request, v_request_hash,
		p_manager_agent_version, p_requested_model, p_request_claim_id,
		p_request_ownership_token_hash, 'claimed', 1, NULL, NULL,
		NULL, NULL, v_now, v_now, v_now + interval '90 days'
	);
	INSERT INTO emdo.agent_run_events(
		household_id, space_id, original_owner_user_id, run_id,
		sequence, event_type, payload, occurred_at, retain_until
	) VALUES (
		p_household_id, v_collection_scope.private_space_id,
		emdo.current_user_id(), p_candidate_run_id, 1, 'run.accepted',
		pg_catalog.jsonb_build_object(
			'schemaVersion', 1,
			'runId', p_candidate_run_id,
			'conversationId', p_candidate_conversation_id,
			'requestHash', v_request_hash,
			'originCollectionAuthorizationScopeFingerprint',
				v_collection_scope.authorization_scope_fingerprint,
			'originOperationAuthorizationScopeFingerprint',
				v_operation_scope.authorization_scope_fingerprint
		),
		v_now, v_now + interval '90 days'
	);
	v_result := pg_catalog.jsonb_build_object(
		'status', 'claimed',
		'claimId', p_request_claim_id,
		'runId', p_candidate_run_id,
		'conversationId', p_candidate_conversation_id,
		'authorizationScopeFingerprint',
			v_operation_scope.authorization_scope_fingerprint,
		'escalationTriggers', '[]'::jsonb
	);
	RETURN emdo.record_manager_turn_operation(
		p_operation_id, p_candidate_run_id, 'claim', p_operation_hash,
		p_request_claim_id, p_request_ownership_token_hash, NULL, v_result
	);
EXCEPTION
	WHEN data_exception OR integrity_constraint_violation OR raise_exception THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."complete_manager_turn"(
	p_operation_id uuid,
	p_operation_hash text,
	p_claim_id uuid,
	p_ownership_token_hash text,
	p_run_id uuid,
	p_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_turn emdo.manager_turns%ROWTYPE;
	v_run emdo.agent_runs%ROWTYPE;
	v_operation emdo.manager_turn_operations%ROWTYPE;
	v_checkpoint emdo.approval_checkpoints%ROWTYPE;
	v_proposal emdo.action_proposals%ROWTYPE;
	v_proposal_state emdo.proposal_states%ROWTYPE;
	v_preparation emdo.proposal_preparations%ROWTYPE;
	v_disclosure emdo.disclosure_grants%ROWTYPE;
	v_interruption jsonb;
	v_result_hash text;
	v_expected_operation_hash text;
	v_public_result jsonb;
	v_status text;
	v_terminal_event_type text;
	v_next_sequence bigint;
	v_terminal_sequence bigint;
	v_now timestamptz;
	v_checkpoint_id uuid;
	v_proposal_id uuid;
	v_specialist_count integer;
BEGIN
	IF p_operation_id IS NULL
		OR p_operation_hash !~ '^[a-f0-9]{64}$'
		OR p_claim_id IS NULL
		OR p_ownership_token_hash !~ '^[a-f0-9]{64}$'
		OR p_run_id IS NULL
		OR pg_catalog.jsonb_typeof(p_result) IS DISTINCT FROM 'object'
		OR pg_catalog.octet_length(p_result::text) > 1400000
		OR NOT (p_result ?& ARRAY[
			'status', 'runId', 'localTraceReference',
			'specialistOutcomes', 'usage'
		]::text[])
		OR p_result ->> 'runId' IS DISTINCT FROM p_run_id::text
		OR p_result ->> 'status'
			NOT IN ('completed', 'needs-approval', 'failed')
		OR pg_catalog.jsonb_typeof(p_result -> 'specialistOutcomes')
			IS DISTINCT FROM 'array'
		OR pg_catalog.jsonb_array_length(p_result -> 'specialistOutcomes') > 64
	OR pg_catalog.jsonb_typeof(p_result -> 'usage')
			IS DISTINCT FROM 'object'
		OR (pg_catalog.length(p_result ->> 'localTraceReference')
			BETWEEN 1 AND 512) IS DISTINCT FROM true
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_result -> 'usage',
			ARRAY['inputTokens', 'outputTokens', 'modelCostCadMinor']::text[]
		)
		OR pg_catalog.jsonb_typeof(p_result #> '{usage,inputTokens}')
			IS DISTINCT FROM 'number'
		OR pg_catalog.jsonb_typeof(p_result #> '{usage,outputTokens}')
			IS DISTINCT FROM 'number'
		OR pg_catalog.jsonb_typeof(p_result #> '{usage,modelCostCadMinor}')
			IS DISTINCT FROM 'number'
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	v_status := p_result ->> 'status';
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.jsonb_array_elements(
			p_result -> 'specialistOutcomes'
		) AS outcome(value)
		WHERE pg_catalog.jsonb_typeof(outcome.value) <> 'object'
			OR NOT (outcome.value ?& ARRAY[
				'delegationId', 'specialistId', 'status', 'usage'
			]::text[])
			OR (outcome.value ->> 'status'
				IN ('completed', 'failed', 'blocked')) IS DISTINCT FROM true
			OR (pg_catalog.length(outcome.value ->> 'delegationId')
				BETWEEN 1 AND 200) IS DISTINCT FROM true
			OR (pg_catalog.length(outcome.value ->> 'specialistId')
				BETWEEN 1 AND 200) IS DISTINCT FROM true
			OR pg_catalog.jsonb_typeof(outcome.value -> 'usage') <> 'object'
	) THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	IF (
		v_status = 'completed'
		AND (
			NOT emdo.jsonb_object_has_exact_keys(
				p_result,
				ARRAY[
					'status', 'runId', 'localTraceReference', 'output',
					'specialistOutcomes', 'hasPartialFailures', 'usage',
					'modelResolution'
				]::text[]
			)
			OR pg_catalog.jsonb_typeof(p_result -> 'hasPartialFailures')
				IS DISTINCT FROM 'boolean'
			OR pg_catalog.jsonb_typeof(p_result -> 'modelResolution')
				IS DISTINCT FROM 'object'
			OR p_result #>> '{modelResolution,status}'
				IS DISTINCT FROM 'resolved'
		)
	) OR (
		v_status = 'needs-approval'
		AND (
			NOT emdo.jsonb_object_has_exact_keys(
				p_result,
				ARRAY[
					'status', 'runId', 'localTraceReference', 'checkpoint',
					'interruptions', 'specialistOutcomes', 'usage',
					'modelResolution'
				]::text[]
			)
			OR pg_catalog.jsonb_typeof(p_result -> 'checkpoint')
				IS DISTINCT FROM 'object'
			OR pg_catalog.jsonb_typeof(p_result -> 'interruptions')
				IS DISTINCT FROM 'array'
			OR pg_catalog.jsonb_array_length(p_result -> 'interruptions') <> 1
			OR pg_catalog.jsonb_typeof(p_result -> 'modelResolution')
				IS DISTINCT FROM 'object'
			OR p_result #>> '{modelResolution,status}'
				IS DISTINCT FROM 'resolved'
		)
	) OR (
		v_status = 'failed'
		AND (
			NOT (p_result ? 'safeError')
			OR p_result - ARRAY[
				'status', 'runId', 'localTraceReference', 'safeError',
				'specialistOutcomes', 'usage', 'modelResolution'
			]::text[] <> '{}'::jsonb
			OR pg_catalog.jsonb_typeof(p_result -> 'safeError')
				IS DISTINCT FROM 'object'
		)
	) THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;

	v_result_hash := emdo.canonical_json_hash(p_result);
	v_expected_operation_hash := emdo.canonical_json_hash(
		pg_catalog.jsonb_build_object(
			'domain', 'emdo.manager-turn-operation.v1',
			'kind', 'complete',
			'operationId', p_operation_id,
			'claimId', p_claim_id,
			'ownershipTokenHash', p_ownership_token_hash,
			'runId', p_run_id,
			'resultHash', v_result_hash
		)
	);
	IF p_operation_hash IS DISTINCT FROM v_expected_operation_hash THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	SELECT operation.* INTO v_operation
	FROM emdo.manager_turn_operations AS operation
	WHERE operation.operation_id = p_operation_id;
	IF FOUND THEN
		RETURN CASE WHEN
			v_operation.run_id = p_run_id
			AND v_operation.operation_kind = 'complete'
			AND v_operation.operation_hash = p_operation_hash
			AND v_operation.request_claim_id = p_claim_id
			AND v_operation.request_ownership_token_hash =
				p_ownership_token_hash
			AND v_operation.result_hash = v_result_hash
		THEN v_operation.stored_result
		ELSE pg_catalog.jsonb_build_object('status', 'conflict') END;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(p_claim_id::text, 0)
	);
	SELECT turn.* INTO v_turn
	FROM emdo.manager_turns AS turn
	WHERE turn.run_id = p_run_id
	FOR UPDATE OF turn;
	IF NOT FOUND THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	IF v_turn.claim_id IS DISTINCT FROM p_claim_id
		OR v_turn.ownership_token_hash IS DISTINCT FROM p_ownership_token_hash
	THEN
		RETURN emdo.record_manager_turn_operation(
			p_operation_id, p_run_id, 'complete', p_operation_hash,
			p_claim_id, p_ownership_token_hash, v_result_hash,
			pg_catalog.jsonb_build_object('status', 'conflict')
		);
	END IF;
	IF v_turn.state <> 'claimed' THEN
		v_public_result := CASE WHEN
			v_turn.state <> 'indeterminate'
			AND v_turn.result_hash = v_result_hash
			AND v_turn.result = p_result
		THEN pg_catalog.jsonb_build_object(
			'status', 'replay',
			'terminalEventSequence', v_turn.terminal_event_sequence
		)
		ELSE pg_catalog.jsonb_build_object('status', 'conflict') END;
		RETURN emdo.record_manager_turn_operation(
			p_operation_id, p_run_id, 'complete', p_operation_hash,
			p_claim_id, p_ownership_token_hash, v_result_hash, v_public_result
		);
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(p_run_id::text, 0)
	);
	SELECT run.* INTO v_run
	FROM emdo.agent_runs AS run
	WHERE run.id = p_run_id
		AND run.household_id = v_turn.household_id
		AND run.space_id = v_turn.space_id
		AND run.original_owner_user_id = v_turn.user_id
	FOR UPDATE OF run;
	IF NOT FOUND OR v_run.status IS DISTINCT FROM 'running' THEN
		RETURN emdo.record_manager_turn_operation(
			p_operation_id, p_run_id, 'complete', p_operation_hash,
			p_claim_id, p_ownership_token_hash, v_result_hash,
			pg_catalog.jsonb_build_object('status', 'conflict')
		);
	END IF;
	SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
	INTO v_next_sequence
	FROM emdo.agent_run_events AS event
	WHERE event.run_id = p_run_id;
	v_specialist_count := pg_catalog.jsonb_array_length(
		p_result -> 'specialistOutcomes'
	);
	v_now := pg_catalog.clock_timestamp();
	INSERT INTO emdo.agent_run_events(
		household_id, space_id, original_owner_user_id, run_id,
		sequence, event_type, payload, occurred_at, retain_until
	)
	SELECT v_turn.household_id, v_turn.space_id, v_turn.user_id,
		v_turn.run_id, v_next_sequence + outcome.ordinality - 1,
		'specialist.' || COALESCE(outcome.value ->> 'status', 'failed'),
		outcome.value, v_now, v_now + interval '90 days'
	FROM pg_catalog.jsonb_array_elements(p_result -> 'specialistOutcomes')
		WITH ORDINALITY AS outcome(value, ordinality)
	ORDER BY outcome.ordinality;
	v_terminal_sequence := v_next_sequence + v_specialist_count;
	v_terminal_event_type := CASE v_status
		WHEN 'completed' THEN 'run.completed'
		WHEN 'failed' THEN 'run.failed'
		ELSE 'approval.required'
	END;
	INSERT INTO emdo.agent_run_events(
		household_id, space_id, original_owner_user_id, run_id,
		sequence, event_type, payload, occurred_at, retain_until
	) VALUES (
		v_turn.household_id, v_turn.space_id, v_turn.user_id,
		v_turn.run_id, v_terminal_sequence, v_terminal_event_type,
		p_result, v_now, v_now + interval '90 days'
	);

	IF v_status = 'needs-approval' THEN
		v_interruption := p_result -> 'interruptions' -> 0;
		IF NOT emdo.jsonb_object_has_exact_keys(
				v_interruption,
				ARRAY[
					'id', 'agentId', 'capabilityId', 'proposalId',
					'argumentsPreview'
				]::text[]
			)
			OR NOT emdo.jsonb_object_has_exact_keys(
				p_result -> 'checkpoint',
				ARRAY[
					'checkpointId', 'householdId', 'userId', 'runId',
					'agentGraphHash', 'sdkVersion', 'formatVersion',
					'revision', 'state', 'createdAt', 'expiresAt', 'updatedAt'
				]::text[]
			)
			OR p_result #>> '{checkpoint,householdId}'
				IS DISTINCT FROM v_turn.household_id::text
			OR p_result #>> '{checkpoint,userId}'
				IS DISTINCT FROM v_turn.user_id::text
			OR p_result #>> '{checkpoint,runId}'
				IS DISTINCT FROM v_turn.run_id::text
			OR p_result #>> '{checkpoint,state}' IS DISTINCT FROM 'pending'
			OR p_result #>> '{checkpoint,formatVersion}' IS DISTINCT FROM '1'
			OR p_result #>> '{checkpoint,revision}' IS DISTINCT FROM '1'
		THEN
			RAISE EXCEPTION USING
				ERRCODE = 'P0001', MESSAGE = 'invalid approval result binding';
		END IF;
		v_checkpoint_id := (p_result #>> '{checkpoint,checkpointId}')::uuid;
		v_proposal_id := (v_interruption ->> 'proposalId')::uuid;

		SELECT checkpoint.* INTO v_checkpoint
		FROM emdo.approval_checkpoints AS checkpoint
		WHERE checkpoint.checkpoint_id = v_checkpoint_id
		FOR UPDATE OF checkpoint;
		SELECT proposal.* INTO v_proposal
		FROM emdo.action_proposals AS proposal
		WHERE proposal.id = v_proposal_id
		FOR UPDATE OF proposal;
		SELECT state.* INTO v_proposal_state
		FROM emdo.proposal_states AS state
		WHERE state.proposal_id = v_proposal_id
		FOR UPDATE OF state;
		SELECT preparation.* INTO v_preparation
		FROM emdo.proposal_preparations AS preparation
		WHERE preparation.proposal_id = v_proposal_id
		FOR UPDATE OF preparation;
		SELECT disclosure.* INTO v_disclosure
		FROM emdo.disclosure_grants AS disclosure
		WHERE disclosure.id = v_proposal.disclosure_grant_id
		FOR UPDATE OF disclosure;
		IF v_checkpoint.checkpoint_id IS NULL
			OR v_proposal.id IS NULL
			OR v_proposal_state.proposal_id IS NULL
			OR v_preparation.proposal_id IS NULL
			OR v_disclosure.id IS NULL
			OR v_checkpoint.household_id <> v_turn.household_id
			OR v_checkpoint.space_id <> v_turn.space_id
			OR v_checkpoint.user_id <> v_turn.user_id
			OR v_checkpoint.run_id <> v_turn.run_id
			OR v_checkpoint.state <> 'pending'
			OR v_checkpoint.format_version <> 1
			OR v_checkpoint.revision <> 1
			OR v_checkpoint.agent_graph_hash IS DISTINCT FROM
				p_result #>> '{checkpoint,agentGraphHash}'
			OR v_checkpoint.sdk_version IS DISTINCT FROM
				p_result #>> '{checkpoint,sdkVersion}'
			OR v_checkpoint.created_at IS DISTINCT FROM
				(p_result #>> '{checkpoint,createdAt}')::timestamptz
			OR v_checkpoint.expires_at IS DISTINCT FROM
				(p_result #>> '{checkpoint,expiresAt}')::timestamptz
			OR v_checkpoint.updated_at IS DISTINCT FROM
				(p_result #>> '{checkpoint,updatedAt}')::timestamptz
			OR v_checkpoint.expires_at <= v_now
			OR v_proposal.household_id <> v_turn.household_id
			OR v_proposal.space_id <> v_turn.space_id
			OR v_proposal.original_owner_user_id <> v_turn.user_id
			OR v_proposal.run_id <> v_turn.run_id
			OR v_proposal.capability_id IS DISTINCT FROM
				v_interruption ->> 'capabilityId'
			OR v_proposal.authorization_scope_fingerprint IS DISTINCT FROM
				v_turn.origin_operation_authorization_scope_fingerprint
			OR v_proposal.expires_at <= v_now
			OR v_proposal_state.state <> 'pending'
			OR v_preparation.abandonment_reason IS NOT NULL
			OR v_preparation.abandoned_at IS NOT NULL
			OR v_preparation.preparation_binding_hash IS DISTINCT FROM
				emdo.canonical_json_hash(pg_catalog.jsonb_build_object(
					'domain', 'emdo.provider-proposal-preparation.v1',
					'binding', v_preparation.preparation_binding
				))
			OR v_preparation.preparation_binding ->> 'proposalId'
				IS DISTINCT FROM v_proposal.id::text
			OR v_preparation.preparation_binding ->> 'runId'
				IS DISTINCT FROM v_turn.run_id::text
			OR v_preparation.preparation_binding ->> 'householdId'
				IS DISTINCT FROM v_turn.household_id::text
			OR v_preparation.preparation_binding ->> 'userId'
				IS DISTINCT FROM v_turn.user_id::text
			OR v_preparation.preparation_binding ->> 'originSessionId'
				IS DISTINCT FROM v_turn.origin_session_id::text
			OR v_preparation.preparation_binding ->> 'originRequestId'
				IS DISTINCT FROM v_turn.origin_request_id::text
			OR v_preparation.preparation_binding ->> 'originSpaceAccessGrantId'
				IS DISTINCT FROM v_turn.origin_space_access_grant_id::text
			OR v_preparation.preparation_binding ->> 'agentId'
				IS DISTINCT FROM v_interruption ->> 'agentId'
			OR v_preparation.preparation_binding ->> 'capabilityId'
				IS DISTINCT FROM v_interruption ->> 'capabilityId'
			OR v_preparation.preparation_binding ->> 'disclosurePolicyVersion'
				!~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
			OR v_disclosure.schema_version <> 1
			OR v_disclosure.household_id <> v_turn.household_id
			OR v_disclosure.space_id <> v_turn.space_id
			OR v_disclosure.user_id <> v_turn.user_id
			OR v_disclosure.run_id <> v_turn.run_id
			OR v_disclosure.id <> v_proposal.disclosure_grant_id
			OR v_disclosure.id::text IS DISTINCT FROM
				v_preparation.preparation_binding ->> 'disclosureGrantId'
			OR v_disclosure.revoked_at IS NOT NULL
			OR v_disclosure.expires_at <= v_now
			OR v_proposal.disclosure_grant ->> 'id'
				IS DISTINCT FROM v_disclosure.id::text
			OR v_proposal.disclosure_grant ->> 'version'
				IS DISTINCT FROM v_disclosure.version::text
		THEN
			RAISE EXCEPTION USING
				ERRCODE = 'P0001', MESSAGE = 'approval staging binding mismatch';
		END IF;

		INSERT INTO emdo.approval_resume_jobs(
			job_id, household_id, space_id, user_id, run_id,
			conversation_id, checkpoint_id, interruption_id, proposal_id,
			capability_id, origin_session_id, origin_turn_request_id,
			origin_space_access_grant_id, authorization_scope_fingerprint,
			disclosure_grant_id, disclosure_grant_version,
			disclosure_policy_version, payload_hash, approval_hash,
			approval_event_sequence, state, revision, claim_id,
			ownership_token_digest, decision_id, decision_type,
			authenticated_session_id, resume_request_id,
			resume_space_access_grant_id,
			collection_authorization_scope_fingerprint, claimed_at,
			claim_expires_at, terminal_event_sequence, terminal_reason_code,
			terminal_result_hash, created_at, updated_at, expires_at,
			retain_until
		) VALUES (
			pg_catalog.gen_random_uuid(), v_turn.household_id, v_turn.space_id,
			v_turn.user_id, v_turn.run_id, v_turn.conversation_id,
			v_checkpoint.checkpoint_id, v_interruption ->> 'id',
			v_proposal.id, v_proposal.capability_id,
			v_turn.origin_session_id, v_turn.origin_request_id,
			v_turn.origin_space_access_grant_id,
			v_turn.origin_operation_authorization_scope_fingerprint,
			v_disclosure.id, v_disclosure.version,
			v_preparation.preparation_binding ->> 'disclosurePolicyVersion',
			v_proposal.payload_hash, v_proposal.approval_hash,
			v_terminal_sequence, 'awaiting-decision', 1, NULL, NULL,
			NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
			NULL,
			v_now, v_now,
			pg_catalog.least(
				v_checkpoint.expires_at,
				v_proposal.expires_at,
				v_disclosure.expires_at,
				v_now + interval '10 minutes'
			),
			v_now + interval '90 days'
		);
	END IF;

	UPDATE emdo.manager_turns AS turn
	SET state = v_status, revision = turn.revision + 1,
		result = p_result, result_hash = v_result_hash,
		terminal_event_sequence = v_terminal_sequence,
		approval_checkpoint_id = CASE WHEN v_status = 'needs-approval'
			THEN v_checkpoint_id ELSE NULL END,
		updated_at = v_now
	WHERE turn.run_id = p_run_id
		AND turn.revision = v_turn.revision
		AND turn.state = 'claimed';
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001', MESSAGE = 'manager turn completion CAS failed';
	END IF;
	UPDATE emdo.agent_runs AS run
	SET status = CASE v_status
			WHEN 'completed' THEN 'completed'
			WHEN 'failed' THEN 'failed'
			ELSE 'blocked'
		END,
		resolved_model = p_result #>> '{modelResolution,resolvedModel}',
		model_reason = p_result #>> '{modelResolution,reason}',
		local_trace_reference = p_result ->> 'localTraceReference',
		safe_error = CASE WHEN v_status = 'failed'
			THEN p_result -> 'safeError' ELSE NULL END,
		usage = p_result -> 'usage',
		completed_at = CASE WHEN v_status = 'needs-approval'
			THEN NULL ELSE v_now END
	WHERE run.id = p_run_id
		AND run.status = 'running';
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001', MESSAGE = 'manager run completion CAS failed';
	END IF;
	v_public_result := pg_catalog.jsonb_build_object(
		'status', 'completed',
		'terminalEventSequence', v_terminal_sequence
	);
	RETURN emdo.record_manager_turn_operation(
		p_operation_id, p_run_id, 'complete', p_operation_hash,
		p_claim_id, p_ownership_token_hash, v_result_hash, v_public_result
	);
EXCEPTION
	WHEN data_exception OR integrity_constraint_violation OR raise_exception THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."mark_manager_turn_indeterminate"(
	p_operation_id uuid,
	p_operation_hash text,
	p_claim_id uuid,
	p_ownership_token_hash text,
	p_run_id uuid,
	p_reason_code text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_turn emdo.manager_turns%ROWTYPE;
	v_operation emdo.manager_turn_operations%ROWTYPE;
	v_expected_operation_hash text;
	v_result jsonb;
	v_result_hash text;
	v_public_result jsonb;
	v_terminal_sequence bigint;
	v_now timestamptz;
BEGIN
	IF p_operation_id IS NULL
		OR p_operation_hash !~ '^[a-f0-9]{64}$'
		OR p_claim_id IS NULL
		OR p_ownership_token_hash !~ '^[a-f0-9]{64}$'
		OR p_run_id IS NULL
		OR p_reason_code IS DISTINCT FROM 'agent-runtime-failed'
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	v_expected_operation_hash := emdo.canonical_json_hash(
		pg_catalog.jsonb_build_object(
			'domain', 'emdo.manager-turn-operation.v1',
			'kind', 'indeterminate',
			'operationId', p_operation_id,
			'claimId', p_claim_id,
			'ownershipTokenHash', p_ownership_token_hash,
			'runId', p_run_id,
			'reasonCode', p_reason_code
		)
	);
	IF p_operation_hash IS DISTINCT FROM v_expected_operation_hash THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	SELECT operation.* INTO v_operation
	FROM emdo.manager_turn_operations AS operation
	WHERE operation.operation_id = p_operation_id;
	IF FOUND THEN
		RETURN CASE WHEN
			v_operation.run_id = p_run_id
			AND v_operation.operation_kind = 'indeterminate'
			AND v_operation.operation_hash = p_operation_hash
			AND v_operation.request_claim_id = p_claim_id
			AND v_operation.request_ownership_token_hash =
				p_ownership_token_hash
		THEN v_operation.stored_result
		ELSE pg_catalog.jsonb_build_object('status', 'conflict') END;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(p_claim_id::text, 0)
	);
	SELECT turn.* INTO v_turn
	FROM emdo.manager_turns AS turn
	WHERE turn.run_id = p_run_id
	FOR UPDATE OF turn;
	IF NOT FOUND
		OR v_turn.claim_id IS DISTINCT FROM p_claim_id
		OR v_turn.ownership_token_hash IS DISTINCT FROM p_ownership_token_hash
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	IF v_turn.state <> 'claimed' THEN
		v_public_result := CASE WHEN
			v_turn.state = 'indeterminate'
			AND v_turn.reason_code = p_reason_code
		THEN pg_catalog.jsonb_build_object(
			'status', 'replay',
			'terminalEventSequence', v_turn.terminal_event_sequence
		)
		ELSE pg_catalog.jsonb_build_object('status', 'conflict') END;
		RETURN emdo.record_manager_turn_operation(
			p_operation_id, p_run_id, 'indeterminate', p_operation_hash,
			p_claim_id, p_ownership_token_hash, v_turn.result_hash,
			v_public_result
		);
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(p_run_id::text, 0)
	);
	SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
	INTO v_terminal_sequence
	FROM emdo.agent_run_events AS event
	WHERE event.run_id = p_run_id;
	v_result := pg_catalog.jsonb_build_object(
		'status', 'failed',
		'runId', p_run_id,
		'localTraceReference', 'durable-manager-turn-indeterminate',
		'safeError', pg_catalog.jsonb_build_object(
			'code', p_reason_code,
			'message', 'The manager turn outcome could not be verified.',
			'retryable', false
		),
		'specialistOutcomes', '[]'::jsonb,
		'usage', pg_catalog.jsonb_build_object(
			'inputTokens', 0, 'outputTokens', 0, 'modelCostCadMinor', 0
		)
	);
	v_result_hash := emdo.canonical_json_hash(v_result);
	v_now := pg_catalog.clock_timestamp();
	INSERT INTO emdo.agent_run_events(
		household_id, space_id, original_owner_user_id, run_id,
		sequence, event_type, payload, occurred_at, retain_until
	) VALUES (
		v_turn.household_id, v_turn.space_id, v_turn.user_id, v_turn.run_id,
		v_terminal_sequence, 'run.indeterminate', v_result,
		v_now, v_now + interval '90 days'
	);
	UPDATE emdo.manager_turns AS turn
	SET state = 'indeterminate', revision = turn.revision + 1,
		result = v_result, result_hash = v_result_hash,
		terminal_event_sequence = v_terminal_sequence,
		reason_code = p_reason_code, updated_at = v_now
	WHERE turn.run_id = p_run_id
		AND turn.state = 'claimed'
		AND turn.revision = v_turn.revision;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001', MESSAGE = 'manager indeterminate CAS failed';
	END IF;
	UPDATE emdo.agent_runs AS run
	SET status = 'failed',
		local_trace_reference = 'durable-manager-turn-indeterminate',
		safe_error = v_result -> 'safeError', usage = v_result -> 'usage',
		completed_at = v_now
	WHERE run.id = p_run_id
		AND run.household_id = v_turn.household_id
		AND run.space_id = v_turn.space_id
		AND run.original_owner_user_id = v_turn.user_id
		AND run.status = 'running';
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001', MESSAGE = 'manager run indeterminate CAS failed';
	END IF;
	v_public_result := pg_catalog.jsonb_build_object(
		'status', 'indeterminate',
		'terminalEventSequence', v_terminal_sequence
	);
	RETURN emdo.record_manager_turn_operation(
		p_operation_id, p_run_id, 'indeterminate', p_operation_hash,
		p_claim_id, p_ownership_token_hash, v_result_hash, v_public_result
	);
EXCEPTION
	WHEN data_exception OR integrity_constraint_violation OR raise_exception THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."read_manager_turn_operation"(
	p_operation_id uuid,
	p_operation_hash text,
	p_request_claim_id uuid,
	p_request_ownership_token_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_operation emdo.manager_turn_operations%ROWTYPE;
BEGIN
	IF p_operation_id IS NULL
		OR p_operation_hash !~ '^[a-f0-9]{64}$'
		OR p_request_claim_id IS NULL
		OR p_request_ownership_token_hash !~ '^[a-f0-9]{64}$'
	THEN
		RETURN NULL;
	END IF;
	SELECT operation.* INTO v_operation
	FROM emdo.manager_turn_operations AS operation
	WHERE operation.operation_id = p_operation_id;
	IF NOT FOUND
		OR v_operation.operation_hash IS DISTINCT FROM p_operation_hash
		OR v_operation.request_claim_id IS DISTINCT FROM p_request_claim_id
		OR v_operation.request_ownership_token_hash IS DISTINCT FROM
			p_request_ownership_token_hash
	THEN
		RETURN NULL;
	END IF;
	RETURN v_operation.stored_result;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."read_agent_run_events"(
	p_space_access_grant_id uuid,
	p_run_id uuid,
	p_after_sequence bigint,
	p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_scope record;
	v_events jsonb;
BEGIN
	IF p_space_access_grant_id IS NULL
		OR p_run_id IS NULL
		OR p_after_sequence IS NULL OR p_after_sequence < 0
		OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 250
	THEN
		RETURN NULL;
	END IF;

	SELECT scope.* INTO v_scope
	FROM emdo.lock_current_authorization_scope(
		p_space_access_grant_id, NULL, p_run_id
	) AS scope;
	IF NOT FOUND OR v_scope.proposal_space_id IS NULL THEN
		RETURN NULL;
	END IF;

	PERFORM 1
	FROM emdo.manager_turns AS turn
	WHERE turn.run_id = p_run_id
		AND turn.household_id = v_scope.household_id
		AND turn.space_id = v_scope.proposal_space_id
		AND turn.user_id = v_scope.user_id
		AND turn.origin_session_id = v_scope.session_id
		AND turn.origin_operation_authorization_scope_fingerprint =
			v_scope.authorization_scope_fingerprint
	FOR SHARE OF turn;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;

	WITH bounded AS MATERIALIZED (
		SELECT event.sequence, event.event_type, event.payload,
			event.occurred_at
		FROM emdo.agent_run_events AS event
		WHERE event.run_id = p_run_id
			AND event.household_id = v_scope.household_id
			AND event.space_id = v_scope.proposal_space_id
			AND event.original_owner_user_id = v_scope.user_id
			AND event.sequence > p_after_sequence
		ORDER BY event.sequence
		LIMIT p_limit
	), projected AS (
		SELECT pg_catalog.jsonb_build_object(
			'schemaVersion', 1,
			'runId', p_run_id,
			'sequence', bounded.sequence,
			'type', bounded.event_type,
			'occurredAt', bounded.occurred_at,
			'data', bounded.payload
		) AS event,
		bounded.sequence
		FROM bounded
	)
	SELECT COALESCE(
		pg_catalog.jsonb_agg(event ORDER BY sequence), '[]'::jsonb
	)
	INTO v_events
	FROM projected;

	RETURN pg_catalog.jsonb_build_object(
		'schemaVersion', 1,
		'events', v_events
	);
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."manager_turn_store_ready"()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_executor_oid oid;
	v_function_count integer;
BEGIN
	SELECT role.oid INTO v_executor_oid
	FROM pg_catalog.pg_roles AS role
	WHERE role.rolname = 'emdo_manager_turn_executor'
		AND NOT role.rolcanlogin
		AND NOT role.rolsuper
		AND NOT role.rolcreatedb
		AND NOT role.rolcreaterole
		AND NOT role.rolinherit
		AND NOT role.rolbypassrls;
	IF v_executor_oid IS NULL
		OR EXISTS (
			SELECT 1 FROM pg_catalog.pg_auth_members AS membership
			WHERE membership.roleid = v_executor_oid
				OR membership.member = v_executor_oid
		)
	THEN
		RETURN false;
	END IF;
	SELECT pg_catalog.count(*) INTO v_function_count
	FROM pg_catalog.pg_proc AS procedure
	WHERE procedure.proowner = v_executor_oid
		AND procedure.prosecdef
		AND procedure.proconfig @> ARRAY[
			'search_path=pg_catalog, emdo', 'row_security=on'
		]::text[]
		AND procedure.oid = ANY(ARRAY[
			pg_catalog.to_regprocedure(
				'emdo.claim_manager_turn(uuid,text,uuid,uuid,uuid,text,text,jsonb,uuid,uuid,text,text,text)'
			),
			pg_catalog.to_regprocedure(
				'emdo.complete_manager_turn(uuid,text,uuid,text,uuid,jsonb)'
			),
			pg_catalog.to_regprocedure(
				'emdo.mark_manager_turn_indeterminate(uuid,text,uuid,text,uuid,text)'
			),
			pg_catalog.to_regprocedure(
				'emdo.read_manager_turn_operation(uuid,text,uuid,text)'
			),
			pg_catalog.to_regprocedure('emdo.manager_turn_store_ready()')
		]::oid[]);
	RETURN v_function_count = 5
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_class AS relation
			JOIN pg_catalog.pg_namespace AS namespace
				ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname = 'emdo'
				AND relation.relname = 'manager_turns'
				AND relation.relrowsecurity
				AND relation.relforcerowsecurity
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_class AS relation
			JOIN pg_catalog.pg_namespace AS namespace
				ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname = 'emdo'
				AND relation.relname = 'manager_turn_operations'
				AND relation.relrowsecurity
				AND relation.relforcerowsecurity
		)
		AND pg_catalog.has_schema_privilege(
			SESSION_USER, 'emdo', 'USAGE'
		)
		AND pg_catalog.has_function_privilege(
			SESSION_USER,
			'emdo.claim_manager_turn(uuid,text,uuid,uuid,uuid,text,text,jsonb,uuid,uuid,text,text,text)',
			'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			SESSION_USER,
			'emdo.complete_manager_turn(uuid,text,uuid,text,uuid,jsonb)',
			'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			SESSION_USER,
			'emdo.mark_manager_turn_indeterminate(uuid,text,uuid,text,uuid,text)',
			'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			SESSION_USER,
			'emdo.read_manager_turn_operation(uuid,text,uuid,text)',
			'EXECUTE'
		)
		AND NOT pg_catalog.has_function_privilege(
			SESSION_USER,
			'emdo.record_manager_turn_operation(uuid,uuid,text,text,uuid,text,text,jsonb)',
			'EXECUTE'
		)
		AND NOT pg_catalog.has_table_privilege(
			SESSION_USER, 'emdo.manager_turns',
			'SELECT,INSERT,UPDATE,DELETE'
		)
		AND NOT pg_catalog.has_table_privilege(
			SESSION_USER, 'emdo.manager_turn_operations',
			'SELECT,INSERT,UPDATE,DELETE'
		);
EXCEPTION
	WHEN undefined_object OR insufficient_privilege THEN
		RETURN false;
END
$function$;
--> statement-breakpoint

ALTER FUNCTION "emdo"."record_manager_turn_operation"(
	uuid, uuid, text, text, uuid, text, text, jsonb
) OWNER TO emdo_manager_turn_executor;
ALTER FUNCTION "emdo"."claim_manager_turn"(
	uuid, text, uuid, uuid, uuid, text, text, jsonb,
	uuid, uuid, text, text, text
) OWNER TO emdo_manager_turn_executor;
ALTER FUNCTION "emdo"."complete_manager_turn"(
	uuid, text, uuid, text, uuid, jsonb
) OWNER TO emdo_manager_turn_executor;
ALTER FUNCTION "emdo"."mark_manager_turn_indeterminate"(
	uuid, text, uuid, text, uuid, text
) OWNER TO emdo_manager_turn_executor;
ALTER FUNCTION "emdo"."read_manager_turn_operation"(
	uuid, text, uuid, text
) OWNER TO emdo_manager_turn_executor;
ALTER FUNCTION "emdo"."read_agent_run_events"(
	uuid, uuid, bigint, integer
) OWNER TO emdo_manager_turn_executor;
ALTER FUNCTION "emdo"."manager_turn_store_ready"()
	OWNER TO emdo_manager_turn_executor;

GRANT USAGE ON SCHEMA "emdo" TO emdo_manager_turn_executor;
GRANT SELECT, INSERT, UPDATE ON "emdo"."manager_turns"
	TO emdo_manager_turn_executor;
GRANT SELECT, INSERT ON "emdo"."manager_turn_operations"
	TO emdo_manager_turn_executor;
GRANT SELECT, INSERT, UPDATE ON "emdo"."agent_runs"
	TO emdo_manager_turn_executor;
GRANT SELECT, INSERT ON "emdo"."agent_run_events"
	TO emdo_manager_turn_executor;
GRANT SELECT ON
	"emdo"."approval_checkpoints",
	"emdo"."approval_resume_jobs",
	"emdo"."action_proposals",
	"emdo"."proposal_states",
	"emdo"."proposal_preparations",
	"emdo"."disclosure_grants"
	TO emdo_manager_turn_executor;
GRANT INSERT ON "emdo"."approval_resume_jobs"
	TO emdo_manager_turn_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."current_user_id"(),
	"emdo"."current_session_id"(),
	"emdo"."current_request_id"(),
	"emdo"."lock_current_authorization_scope"(uuid, uuid, uuid),
	"emdo"."canonical_json_text"(jsonb),
	"emdo"."canonical_json_hash"(jsonb),
	"emdo"."jsonb_object_has_exact_keys"(jsonb, text[])
	TO emdo_manager_turn_executor;

REVOKE ALL ON "emdo"."manager_turns",
	"emdo"."manager_turn_operations"
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login,
	emdo_approval_resume_executor, emdo_proposal_reconciliation_executor,
	emdo_proposal_query_executor;
REVOKE ALL ON FUNCTION
	"emdo"."record_manager_turn_operation"(
		uuid, uuid, text, text, uuid, text, text, jsonb
	),
	"emdo"."claim_manager_turn"(
		uuid, text, uuid, uuid, uuid, text, text, jsonb,
		uuid, uuid, text, text, text
	),
	"emdo"."complete_manager_turn"(
		uuid, text, uuid, text, uuid, jsonb
	),
	"emdo"."mark_manager_turn_indeterminate"(
		uuid, text, uuid, text, uuid, text
	),
	"emdo"."read_manager_turn_operation"(uuid, text, uuid, text),
	"emdo"."read_agent_run_events"(uuid, uuid, bigint, integer),
	"emdo"."manager_turn_store_ready"()
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login,
	emdo_approval_resume_executor, emdo_proposal_reconciliation_executor,
	emdo_proposal_query_executor, emdo_manager_turn_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."record_manager_turn_operation"(
		uuid, uuid, text, text, uuid, text, text, jsonb
	)
	TO emdo_manager_turn_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."claim_manager_turn"(
		uuid, text, uuid, uuid, uuid, text, text, jsonb,
		uuid, uuid, text, text, text
	),
	"emdo"."complete_manager_turn"(
		uuid, text, uuid, text, uuid, jsonb
	),
	"emdo"."mark_manager_turn_indeterminate"(
		uuid, text, uuid, text, uuid, text
	),
	"emdo"."read_manager_turn_operation"(uuid, text, uuid, text),
	"emdo"."manager_turn_store_ready"()
	TO emdo_app;
GRANT EXECUTE ON FUNCTION
	"emdo"."read_agent_run_events"(uuid, uuid, bigint, integer)
	TO emdo_app;
--> statement-breakpoint

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. These
-- helpers are reached only from the bounded SECURITY DEFINER aggregates (or
-- the manager-turn transition trigger), so make every caller explicit before
-- the public visual-decision login is granted its single entrypoint.
ALTER FUNCTION "emdo"."provider_proposal_mutation_hash"(text, jsonb)
	OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."proposal_row_matches_input"(
	emdo.action_proposals, integer, text, jsonb
) OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."jsonb_object_has_exact_keys"(jsonb, text[])
	OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."json_text_utf16_length"(text)
	OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."proposal_approval_display_text_is_safe"(text, boolean)
	OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."proposal_approval_display_is_valid"(jsonb)
	OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."proposal_event_has_only_known_keys"(jsonb)
	OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."provider_completion_is_valid"(jsonb, boolean)
	OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."canonical_json_text"(jsonb)
	OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."canonical_json_hash"(jsonb)
	OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."enforce_manager_turn_transition"()
	OWNER TO emdo_manager_turn_executor;
REVOKE ALL ON FUNCTION
	"emdo"."provider_proposal_mutation_hash"(text, jsonb),
	"emdo"."proposal_row_matches_input"(
		emdo.action_proposals, integer, text, jsonb
	),
	"emdo"."jsonb_object_has_exact_keys"(jsonb, text[]),
	"emdo"."json_text_utf16_length"(text),
	"emdo"."proposal_approval_display_text_is_safe"(text, boolean),
	"emdo"."proposal_approval_display_is_valid"(jsonb),
	"emdo"."proposal_event_has_only_known_keys"(jsonb),
	"emdo"."provider_completion_is_valid"(jsonb, boolean),
	"emdo"."canonical_json_text"(jsonb),
	"emdo"."canonical_json_hash"(jsonb),
	"emdo"."enforce_manager_turn_transition"()
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login,
	emdo_visual_decision_login, emdo_proposal_reconciliation_executor,
	emdo_approval_resume_executor, emdo_proposal_query_executor,
	emdo_manager_turn_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."provider_proposal_mutation_hash"(text, jsonb),
	"emdo"."proposal_row_matches_input"(
		emdo.action_proposals, integer, text, jsonb
	),
	"emdo"."jsonb_object_has_exact_keys"(jsonb, text[]),
	"emdo"."json_text_utf16_length"(text),
	"emdo"."proposal_approval_display_text_is_safe"(text, boolean),
	"emdo"."proposal_approval_display_is_valid"(jsonb),
	"emdo"."proposal_event_has_only_known_keys"(jsonb),
	"emdo"."provider_completion_is_valid"(jsonb, boolean),
	"emdo"."canonical_json_text"(jsonb),
	"emdo"."canonical_json_hash"(jsonb)
	TO emdo_workflow_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."proposal_row_matches_input"(
		emdo.action_proposals, integer, text, jsonb
	),
	"emdo"."jsonb_object_has_exact_keys"(jsonb, text[]),
	"emdo"."proposal_event_has_only_known_keys"(jsonb),
	"emdo"."provider_completion_is_valid"(jsonb, boolean),
	"emdo"."canonical_json_text"(jsonb),
	"emdo"."canonical_json_hash"(jsonb)
	TO emdo_proposal_reconciliation_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."canonical_json_text"(jsonb),
	"emdo"."canonical_json_hash"(jsonb),
	"emdo"."jsonb_object_has_exact_keys"(jsonb, text[]),
	"emdo"."enforce_manager_turn_transition"()
	TO emdo_manager_turn_executor;
--> statement-breakpoint

-- This login is exposed to the internet-facing API. Revoke again after every
-- function in this migration exists so default PUBLIC execution on a later
-- helper can never widen it beyond the single visual-decision aggregate.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "emdo"
	FROM emdo_visual_decision_login;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "emdo"
	FROM emdo_visual_decision_login;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA "emdo"
	FROM emdo_visual_decision_login;
REVOKE ALL ON SCHEMA "emdo" FROM emdo_visual_decision_login;
GRANT USAGE ON SCHEMA "emdo" TO emdo_visual_decision_login;
GRANT EXECUTE ON FUNCTION
	"emdo"."commit_provider_proposal_decision"(text, jsonb)
	TO emdo_visual_decision_login;
--> statement-breakpoint
