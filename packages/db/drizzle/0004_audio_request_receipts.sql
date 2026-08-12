DO $roles$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_audio_executor'
	) THEN
		CREATE ROLE emdo_audio_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_audio_reconciliation_executor'
	) THEN
		CREATE ROLE emdo_audio_reconciliation_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_audio_reconciliation'
	) THEN
		CREATE ROLE emdo_audio_reconciliation NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_audio_retention_executor'
	) THEN
		CREATE ROLE emdo_audio_retention_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_audio_retention'
	) THEN
		CREATE ROLE emdo_audio_retention NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$roles$;
--> statement-breakpoint
ALTER ROLE emdo_audio_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_audio_reconciliation_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_audio_reconciliation NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_audio_retention_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_audio_retention NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
--> statement-breakpoint
DO $membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname IN (
			'emdo_audio_executor', 'emdo_audio_reconciliation_executor',
			'emdo_audio_retention_executor'
		) OR child.rolname IN (
			'emdo_audio_executor', 'emdo_audio_reconciliation_executor',
			'emdo_audio_reconciliation', 'emdo_audio_retention_executor',
			'emdo_audio_retention'
		)
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'audio receipt executors must not have role memberships';
	END IF;
END
$membership_guard$;
--> statement-breakpoint
CREATE TABLE "emdo"."audio_request_receipts" (
	"receipt_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_version" smallint DEFAULT 1 NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"authenticated_session_id" uuid NOT NULL,
	"origin_request_id" uuid NOT NULL,
	"origin_space_access_grant_id" uuid NOT NULL,
	"origin_role" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"input_units" bigint NOT NULL,
	"request_fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"version" bigint NOT NULL,
	"claim_generation" integer NOT NULL,
	"claim_id" uuid NOT NULL,
	"ownership_token_hash" text NOT NULL,
	"execution_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"transcript" text,
	"result_model" text,
	"result_content_type" text,
	"spend_warning" boolean,
	"reason_code" text,
	"reconciliation_status" text DEFAULT 'not-required' NOT NULL,
	"reconciliation_resolution" text,
	"operator_reference" text,
	"reconciliation_marked_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "audio_request_receipts_principal_key_unique"
		UNIQUE ("household_id", "user_id", "idempotency_key"),
	CONSTRAINT "audio_request_receipts_claim_id_unique" UNIQUE ("claim_id"),
	CONSTRAINT "audio_request_receipts_schema_check"
		CHECK ("schema_version" = 1),
	CONSTRAINT "audio_request_receipts_key_check"
		CHECK (pg_catalog.length("idempotency_key") BETWEEN 16 AND 200
			AND "idempotency_key" ~ '^[A-Za-z0-9:._-]+$'),
	CONSTRAINT "audio_request_receipts_kind_model_check"
		CHECK (("kind" = 'transcription' AND "model" IN (
			'gpt-4o-mini-transcribe', 'gpt-4o-transcribe'
		)) OR ("kind" = 'speech' AND "model" IN (
			'tts-1', 'tts-1-hd', 'gpt-4o-mini-tts',
			'gpt-4o-mini-tts-2025-12-15'
		))),
	CONSTRAINT "audio_request_receipts_units_check"
		CHECK ("input_units" BETWEEN 1 AND 26214400),
	CONSTRAINT "audio_request_receipts_hash_check"
		CHECK ("request_fingerprint" ~ '^[a-f0-9]{64}$'
			AND "ownership_token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "audio_request_receipts_role_check"
		CHECK ("origin_role" IN ('owner', 'member')),
	CONSTRAINT "audio_request_receipts_state_check"
		CHECK ("state" IN (
			'claimed', 'released', 'completed-transcription',
			'completed-speech', 'completed-nonreplayable', 'indeterminate'
		)),
	CONSTRAINT "audio_request_receipts_revision_check"
		CHECK ("version" > 0 AND "claim_generation" > 0),
	CONSTRAINT "audio_request_receipts_reason_check"
		CHECK ("reason_code" IS NULL OR "reason_code" IN (
			'transcription-provider-not-dispatched',
			'speech-provider-not-dispatched',
			'claim-lease-expired',
			'transcription-provider-state-unknown',
			'speech-provider-state-unknown',
			'transcription-settlement-state-unknown',
			'speech-settlement-state-unknown'
		)),
	CONSTRAINT "audio_request_receipts_reconciliation_check"
		CHECK ("reconciliation_status" IN (
			'not-required', 'pending', 'resolved'
		) AND ("reconciliation_resolution" IS NULL OR
			"reconciliation_resolution" IN (
				'confirmed-not-dispatched', 'confirmed-dispatched'
			)) AND ("operator_reference" IS NULL OR (
			pg_catalog.length("operator_reference") BETWEEN 8 AND 200
			AND "operator_reference" ~ '^[A-Za-z0-9:._-]+$'
		))),
	CONSTRAINT "audio_request_receipts_transcript_check"
		CHECK ("transcript" IS NULL OR (
			pg_catalog.length("transcript") BETWEEN 1 AND 50000
			AND pg_catalog.octet_length("transcript") <= 200000
		)),
	CONSTRAINT "audio_request_receipts_result_shape_check" CHECK (COALESCE((
			("state" = 'completed-transcription'
				AND "kind" = 'transcription'
				AND "transcript" IS NOT NULL
				AND "result_model" IS NOT NULL
				AND "result_model" = "model"
				AND "result_content_type" IS NULL
				AND "spend_warning" IS NOT NULL
				AND "completed_at" IS NOT NULL)
			OR ("state" = 'completed-speech'
				AND "kind" = 'speech'
				AND "transcript" IS NULL
				AND "result_model" IS NOT NULL
				AND "result_model" = "model"
				AND "result_content_type" IS NOT NULL
				AND "result_content_type" IN (
					'audio/mpeg', 'audio/wav', 'audio/ogg'
				)
				AND "spend_warning" IS NULL
				AND "completed_at" IS NOT NULL)
			OR ("state" = 'completed-nonreplayable'
				AND "transcript" IS NULL
				AND "result_model" IS NULL
				AND "result_content_type" IS NULL
				AND "spend_warning" IS NULL
				AND "completed_at" IS NOT NULL
				AND "reconciliation_status" = 'resolved')
			OR ("state" NOT IN (
				'completed-transcription', 'completed-speech',
				'completed-nonreplayable'
			) AND "transcript" IS NULL
				AND "result_model" IS NULL
				AND "result_content_type" IS NULL
				AND "spend_warning" IS NULL
				AND "completed_at" IS NULL)
		), false)),
	CONSTRAINT "audio_request_receipts_lifecycle_shape_check" CHECK (COALESCE((
			("state" = 'claimed' AND "lease_expires_at" IS NOT NULL)
			OR ("state" <> 'claimed')
		), false)),
	CONSTRAINT "audio_request_receipts_reconciliation_shape_check" CHECK (COALESCE((
			("state" = 'indeterminate'
				AND "reason_code" IS NOT NULL
				AND "reconciliation_status" = 'pending'
				AND "reconciliation_marked_at" IS NOT NULL
				AND "reconciliation_resolution" IS NULL
				AND "operator_reference" IS NULL
				AND "reconciled_at" IS NULL)
			OR ("state" <> 'indeterminate'
				AND "reconciliation_status" <> 'pending')
		), false)),
	CONSTRAINT "audio_request_receipts_retention_check"
		CHECK ("retain_until" > "created_at"
			AND "retain_until" <= "created_at" + interval '90 days')
);
--> statement-breakpoint
CREATE TABLE "emdo"."audio_request_receipt_operations" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"receipt_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"receipt_revision" bigint NOT NULL,
	"claim_id" uuid NOT NULL,
	"ownership_token_hash" text,
	"claim_generation" integer NOT NULL,
	"generation_claim_id" uuid NOT NULL,
	"generation_ownership_token_hash" text NOT NULL,
	"execution_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"operation_kind" text NOT NULL,
	"operation_hash" text NOT NULL,
	"state_after" text NOT NULL,
	"safe_code" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "audio_request_receipt_operations_receipt_revision_unique"
		UNIQUE ("receipt_id", "receipt_revision"),
	CONSTRAINT "audio_request_receipt_operations_kind_check"
		CHECK ("operation_kind" IN (
			'claim', 'transcription-complete', 'speech-complete',
			'release', 'indeterminate', 'operator-release', 'operator-close'
		)),
	CONSTRAINT "audio_request_receipt_operations_state_check"
		CHECK ("state_after" IN (
			'claimed', 'released', 'completed-transcription',
			'completed-speech', 'completed-nonreplayable', 'indeterminate'
		)),
	CONSTRAINT "audio_request_receipt_operations_safe_code_check"
		CHECK ("safe_code" IS NULL OR "safe_code" IN (
			'transcription-provider-not-dispatched',
			'speech-provider-not-dispatched',
			'claim-lease-expired',
			'transcription-provider-state-unknown',
			'speech-provider-state-unknown',
			'transcription-settlement-state-unknown',
			'speech-settlement-state-unknown',
			'confirmed-not-dispatched', 'confirmed-dispatched'
		)),
	CONSTRAINT "audio_request_receipt_operations_hash_check"
		CHECK ("operation_hash" ~ '^[a-f0-9]{64}$'
			AND ("ownership_token_hash" IS NULL OR
				"ownership_token_hash" ~ '^[a-f0-9]{64}$')
			AND "generation_ownership_token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "audio_request_receipt_operations_token_shape_check"
		CHECK (("operation_kind" IN ('operator-release', 'operator-close')
				AND "ownership_token_hash" IS NULL)
			OR ("operation_kind" NOT IN ('operator-release', 'operator-close')
				AND "ownership_token_hash" IS NOT NULL)),
	CONSTRAINT "audio_request_receipt_operations_generation_shape_check"
		CHECK (COALESCE((("operation_kind" = 'claim'
				AND "state_after" = 'indeterminate'
				AND "safe_code" = 'claim-lease-expired')
			OR ("claim_id" = "generation_claim_id"
				AND ("ownership_token_hash" IS NULL OR
					"ownership_token_hash" =
						"generation_ownership_token_hash"))), false)),
	CONSTRAINT "audio_request_receipt_operations_revision_check"
		CHECK ("receipt_revision" > 0 AND "claim_generation" > 0),
	CONSTRAINT "audio_request_receipt_operations_retention_check"
		CHECK ("retain_until" > "recorded_at"
			AND "retain_until" <= "recorded_at" + interval '90 days')
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."is_safe_audio_claim_outcome"(
	p_result jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
	SELECT CASE
		WHEN pg_catalog.jsonb_typeof(p_result) <> 'object'
			OR pg_catalog.octet_length(p_result::text) > 210000
		THEN false
		WHEN p_result ->> 'status' IN (
			'conflict', 'completed-nonreplayable', 'indeterminate'
		) THEN (
			SELECT pg_catalog.count(*)
			FROM pg_catalog.jsonb_object_keys(p_result)
		) = 1
		WHEN p_result ->> 'status' = 'in-progress' THEN
			(
				SELECT pg_catalog.count(*)
				FROM pg_catalog.jsonb_object_keys(p_result)
			) = 2
			AND pg_catalog.jsonb_typeof(p_result -> 'retryAfterMs') = 'number'
			AND (p_result ->> 'retryAfterMs')::integer BETWEEN 100 AND 60000
		WHEN p_result ->> 'status' = 'claimed' THEN
			(
				SELECT pg_catalog.count(*)
				FROM pg_catalog.jsonb_object_keys(p_result)
			) = 4
			AND p_result ->> 'claimId' ~ '^[a-f0-9-]{36}$'
			AND p_result ->> 'executionId' ~ '^[a-f0-9-]{36}$'
			AND p_result ->> 'reservationId' ~ '^[a-f0-9-]{36}$'
		WHEN p_result ->> 'status' = 'replay' THEN
			(
				SELECT pg_catalog.count(*)
				FROM pg_catalog.jsonb_object_keys(p_result)
			) = 2
			AND pg_catalog.jsonb_typeof(p_result -> 'result') = 'object'
			AND (
				SELECT pg_catalog.count(*)
				FROM pg_catalog.jsonb_object_keys(p_result -> 'result')
			) = 4
			AND p_result #>> '{result,kind}' = 'transcription'
			AND p_result #>> '{result,model}' IN (
				'gpt-4o-mini-transcribe', 'gpt-4o-transcribe'
			)
			AND pg_catalog.jsonb_typeof(p_result #> '{result,spendWarning}') = 'boolean'
			AND pg_catalog.length(p_result #>> '{result,transcript}') BETWEEN 1 AND 50000
			AND pg_catalog.octet_length(p_result #>> '{result,transcript}') <= 200000
		ELSE false
	END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."audio_request_operation_hash"(
	p_parts text[]
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
	SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
		COALESCE((
			SELECT pg_catalog.string_agg(
				pg_catalog.octet_length(part)::text || ':' || part,
				'' ORDER BY ordinal
			)
			FROM pg_catalog.unnest(p_parts) WITH ORDINALITY AS value(part, ordinal)
		), ''),
		'UTF8'
	)), 'hex')
$function$;
--> statement-breakpoint
CREATE TABLE "emdo"."audio_request_claim_outcomes" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"operation_hash" text NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"origin_session_id" uuid NOT NULL,
	"origin_request_id" uuid NOT NULL,
	"origin_space_access_grant_id" uuid NOT NULL,
	"origin_role" text NOT NULL,
	"receipt_id" uuid NOT NULL,
	"request_claim_id" uuid NOT NULL,
	"request_ownership_token_hash" text NOT NULL,
	"generation_claim_id" uuid NOT NULL,
	"generation_ownership_token_hash" text NOT NULL,
	"claim_generation" integer NOT NULL,
	"receipt_revision" bigint NOT NULL,
	"stored_result" jsonb NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "audio_request_claim_outcomes_receipt_fk"
		FOREIGN KEY ("receipt_id") REFERENCES "emdo"."audio_request_receipts"("receipt_id")
		ON DELETE restrict ON UPDATE restrict,
	CONSTRAINT "audio_request_claim_outcomes_hash_check"
		CHECK ("operation_hash" ~ '^[a-f0-9]{64}$'
			AND "request_ownership_token_hash" ~ '^[a-f0-9]{64}$'
			AND "generation_ownership_token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "audio_request_claim_outcomes_role_check"
		CHECK ("origin_role" IN ('owner', 'member')),
	CONSTRAINT "audio_request_claim_outcomes_revision_check"
		CHECK ("claim_generation" > 0 AND "receipt_revision" > 0),
	CONSTRAINT "audio_request_claim_outcomes_result_check"
		CHECK ("emdo"."is_safe_audio_claim_outcome"("stored_result")),
	CONSTRAINT "audio_request_claim_outcomes_retention_check"
		CHECK ("retain_until" > "recorded_at"
			AND "retain_until" <= "recorded_at" + interval '90 days')
);
CREATE INDEX "audio_request_claim_outcomes_owner_idx"
	ON "emdo"."audio_request_claim_outcomes"
	("household_id", "user_id", "recorded_at");
ALTER TABLE "emdo"."audio_request_claim_outcomes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."audio_request_claim_outcomes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "emdo"."audio_request_receipts"
	ADD CONSTRAINT "audio_request_receipts_membership_fk"
	FOREIGN KEY ("household_id", "user_id")
	REFERENCES "emdo"."household_memberships"("household_id", "user_id")
	ON DELETE restrict ON UPDATE restrict;
ALTER TABLE "emdo"."audio_request_receipt_operations"
	ADD CONSTRAINT "audio_request_receipt_operations_receipt_fk"
	FOREIGN KEY ("receipt_id")
	REFERENCES "emdo"."audio_request_receipts"("receipt_id")
	ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
CREATE INDEX "audio_request_receipts_reconciliation_idx"
	ON "emdo"."audio_request_receipts"
	("reconciliation_status", "reconciliation_marked_at", "receipt_id");
CREATE INDEX "audio_request_receipts_owner_idx"
	ON "emdo"."audio_request_receipts"
	("household_id", "user_id", "updated_at");
CREATE INDEX "audio_request_receipt_operations_owner_idx"
	ON "emdo"."audio_request_receipt_operations"
	("household_id", "user_id", "recorded_at");
--> statement-breakpoint
ALTER TABLE "emdo"."audio_request_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."audio_request_receipts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."audio_request_receipt_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."audio_request_receipt_operations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audio_request_receipts_executor_scope
	ON "emdo"."audio_request_receipts"
	FOR ALL TO emdo_audio_executor
	USING (
		"household_id" = NULLIF(
			pg_catalog.current_setting('emdo.audio_household_id', true), ''
		)::uuid
		AND "user_id" = emdo.current_user_id()
	)
	WITH CHECK (
		"household_id" = NULLIF(
			pg_catalog.current_setting('emdo.audio_household_id', true), ''
		)::uuid
		AND "user_id" = emdo.current_user_id()
	);
CREATE POLICY audio_request_operations_executor_scope
	ON "emdo"."audio_request_receipt_operations"
	FOR ALL TO emdo_audio_executor
	USING (
		"household_id" = NULLIF(
			pg_catalog.current_setting('emdo.audio_household_id', true), ''
		)::uuid
		AND "user_id" = emdo.current_user_id()
	)
	WITH CHECK (
		"household_id" = NULLIF(
			pg_catalog.current_setting('emdo.audio_household_id', true), ''
		)::uuid
		AND "user_id" = emdo.current_user_id()
	);
CREATE POLICY audio_request_claim_outcomes_executor_scope
	ON "emdo"."audio_request_claim_outcomes"
	FOR ALL TO emdo_audio_executor
	USING (
		"household_id" = NULLIF(
			pg_catalog.current_setting('emdo.audio_household_id', true), ''
		)::uuid
		AND "user_id" = emdo.current_user_id()
	)
	WITH CHECK (
		"household_id" = NULLIF(
			pg_catalog.current_setting('emdo.audio_household_id', true), ''
		)::uuid
		AND "user_id" = emdo.current_user_id()
	);
CREATE POLICY audio_request_receipts_reconciliation_read
	ON "emdo"."audio_request_receipts"
	FOR SELECT TO emdo_audio_reconciliation_executor
	USING (("state" = 'indeterminate'
			AND "reconciliation_status" = 'pending')
		OR ("state" IN ('released', 'completed-nonreplayable')
			AND "reconciliation_status" = 'resolved'));
CREATE POLICY audio_request_receipts_reconciliation_update
	ON "emdo"."audio_request_receipts"
	FOR UPDATE TO emdo_audio_reconciliation_executor
	USING ("state" = 'indeterminate'
		AND "reconciliation_status" = 'pending')
	WITH CHECK ("state" IN ('released', 'completed-nonreplayable')
		AND "reconciliation_status" = 'resolved');
CREATE POLICY audio_request_operations_reconciliation_insert
	ON "emdo"."audio_request_receipt_operations"
	FOR INSERT TO emdo_audio_reconciliation_executor
	WITH CHECK ("state_after" IN ('released', 'completed-nonreplayable'));
CREATE POLICY audio_request_operations_reconciliation_read
	ON "emdo"."audio_request_receipt_operations"
	FOR SELECT TO emdo_audio_reconciliation_executor
	USING ("operation_kind" IN ('operator-release', 'operator-close'));
CREATE POLICY audio_request_receipts_retention_delete
	ON "emdo"."audio_request_receipts"
	FOR DELETE TO emdo_audio_retention_executor
	USING ("retain_until" <= pg_catalog.clock_timestamp()
		AND "state" IN (
			'released', 'completed-transcription', 'completed-speech',
			'completed-nonreplayable'
		)
		AND "reconciliation_status" <> 'pending');
CREATE POLICY audio_request_operations_retention_delete
	ON "emdo"."audio_request_receipt_operations"
	FOR DELETE TO emdo_audio_retention_executor
	USING (EXISTS (
		SELECT 1 FROM emdo.audio_request_receipts AS receipt
		WHERE receipt.receipt_id = audio_request_receipt_operations.receipt_id
			AND receipt.retain_until <= pg_catalog.clock_timestamp()
			AND receipt.state IN (
				'released', 'completed-transcription', 'completed-speech',
				'completed-nonreplayable'
			)
			AND receipt.reconciliation_status <> 'pending'
	));
CREATE POLICY audio_request_claim_outcomes_retention_delete
	ON "emdo"."audio_request_claim_outcomes"
	FOR DELETE TO emdo_audio_retention_executor
	USING (EXISTS (
		SELECT 1 FROM emdo.audio_request_receipts AS receipt
		WHERE receipt.receipt_id = audio_request_claim_outcomes.receipt_id
			AND receipt.retain_until <= pg_catalog.clock_timestamp()
			AND receipt.state IN (
				'released', 'completed-transcription', 'completed-speech',
				'completed-nonreplayable'
			)
			AND receipt.reconciliation_status <> 'pending'
	));
--> statement-breakpoint
CREATE POLICY memberships_audio_executor_read
	ON "emdo"."household_memberships"
	FOR SELECT TO emdo_audio_executor
	USING ("user_id" = emdo.current_user_id());
CREATE POLICY space_grants_audio_executor_read
	ON "emdo"."space_access_grants"
	FOR SELECT TO emdo_audio_executor
	USING ("original_owner_user_id" = emdo.current_user_id()
		AND "session_id" = emdo.current_session_id()
		AND "request_id" = emdo.current_request_id());
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."enforce_audio_request_receipt_transition"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, emdo
AS $function$
BEGIN
	IF NEW.receipt_id IS DISTINCT FROM OLD.receipt_id
		OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
		OR NEW.household_id IS DISTINCT FROM OLD.household_id
		OR NEW.user_id IS DISTINCT FROM OLD.user_id
		OR NEW.authenticated_session_id IS DISTINCT FROM OLD.authenticated_session_id
		OR NEW.origin_request_id IS DISTINCT FROM OLD.origin_request_id
		OR NEW.origin_space_access_grant_id IS DISTINCT FROM OLD.origin_space_access_grant_id
		OR NEW.origin_role IS DISTINCT FROM OLD.origin_role
		OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
		OR NEW.kind IS DISTINCT FROM OLD.kind
		OR NEW.model IS DISTINCT FROM OLD.model
		OR NEW.input_units IS DISTINCT FROM OLD.input_units
		OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
		OR NEW.retain_until IS DISTINCT FROM OLD.retain_until
	THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'audio request immutable binding cannot change';
	END IF;
	IF NEW.version <> OLD.version + 1 THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'audio request version must advance by one';
	END IF;
	IF OLD.state IN (
		'completed-transcription', 'completed-speech',
		'completed-nonreplayable'
	) THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'audio request terminal state cannot regress';
	END IF;
	IF OLD.state = 'claimed' THEN
		IF NEW.state NOT IN (
			'released', 'completed-transcription', 'completed-speech',
			'indeterminate'
		) OR NEW.claim_generation <> OLD.claim_generation
			OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
			OR NEW.ownership_token_hash IS DISTINCT FROM OLD.ownership_token_hash
			OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
			OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
		THEN
			RAISE EXCEPTION USING ERRCODE = '55000',
				MESSAGE = 'audio request owner transition is invalid';
		END IF;
	ELSIF OLD.state = 'released' THEN
		IF NEW.state <> 'claimed'
			OR NEW.claim_generation <> OLD.claim_generation + 1
			OR NEW.claim_id IS NOT DISTINCT FROM OLD.claim_id
			OR NEW.ownership_token_hash IS NOT DISTINCT FROM OLD.ownership_token_hash
			OR NEW.execution_id IS NOT DISTINCT FROM OLD.execution_id
			OR NEW.reservation_id IS NOT DISTINCT FROM OLD.reservation_id
		THEN
			RAISE EXCEPTION USING ERRCODE = '55000',
				MESSAGE = 'audio request reclaim fence is invalid';
		END IF;
	ELSIF OLD.state = 'indeterminate' THEN
		IF NEW.state NOT IN ('released', 'completed-nonreplayable')
			OR NEW.reconciliation_status <> 'resolved'
			OR NEW.claim_generation <> OLD.claim_generation
			OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
			OR NEW.ownership_token_hash IS DISTINCT FROM OLD.ownership_token_hash
			OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
			OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
		THEN
			RAISE EXCEPTION USING ERRCODE = '55000',
				MESSAGE = 'audio request operator transition is invalid';
		END IF;
	ELSE
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'audio request terminal state cannot regress';
	END IF;
	RETURN NEW;
END
$function$;
CREATE TRIGGER audio_request_receipts_immutable_binding
BEFORE UPDATE ON "emdo"."audio_request_receipts"
FOR EACH ROW EXECUTE FUNCTION "emdo"."enforce_audio_request_receipt_transition"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."reject_audio_request_operation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
	IF TG_OP = 'DELETE'
		AND current_user = 'emdo_audio_retention_executor'
	THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION USING ERRCODE = '55000',
		MESSAGE = 'audio request operation acknowledgement is append only';
END
$function$;
CREATE TRIGGER audio_request_receipt_operations_append_only
BEFORE UPDATE OR DELETE ON "emdo"."audio_request_receipt_operations"
FOR EACH ROW EXECUTE FUNCTION "emdo"."reject_audio_request_operation_mutation"();
CREATE TRIGGER audio_request_claim_outcomes_append_only
BEFORE UPDATE OR DELETE ON "emdo"."audio_request_claim_outcomes"
FOR EACH ROW EXECUTE FUNCTION "emdo"."reject_audio_request_operation_mutation"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."audio_request_scope_is_current"(
	p_household_id uuid,
	p_space_access_grant_id uuid,
	p_role text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
BEGIN
	IF p_household_id IS NULL OR p_space_access_grant_id IS NULL
		OR p_role NOT IN ('owner', 'member')
		OR NOT emdo.lock_active_request_scope(p_household_id, NULL, NULL)
	THEN
		RETURN false;
	END IF;
	PERFORM 1
	FROM emdo.space_access_grants AS access_grant
	JOIN emdo.household_memberships AS membership
		ON membership.id = access_grant.membership_id
		AND membership.household_id = access_grant.household_id
		AND membership.user_id = access_grant.original_owner_user_id
	WHERE access_grant.grant_id = p_space_access_grant_id
		AND access_grant.household_id = p_household_id
		AND access_grant.original_owner_user_id = emdo.current_user_id()
		AND access_grant.session_id = emdo.current_session_id()
		AND access_grant.request_id = emdo.current_request_id()
		AND access_grant.role = p_role
		AND access_grant.expires_at > pg_catalog.clock_timestamp()
		AND membership.status = 'active'
		AND membership.role = p_role;
	RETURN FOUND;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."record_audio_request_claim_outcome"(
	p_operation_id uuid,
	p_operation_hash text,
	p_receipt_id uuid,
	p_request_claim_id uuid,
	p_request_ownership_token_hash text,
	p_space_access_grant_id uuid,
	p_role text,
	p_stored_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_receipt emdo.audio_request_receipts%ROWTYPE;
	v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
	IF p_operation_id IS NULL OR p_receipt_id IS NULL
		OR p_request_claim_id IS NULL OR p_space_access_grant_id IS NULL
		OR p_operation_hash IS NULL
		OR p_operation_hash !~ '^[a-f0-9]{64}$'
		OR p_request_ownership_token_hash IS NULL
		OR p_request_ownership_token_hash !~ '^[a-f0-9]{64}$'
		OR p_role IS NULL OR p_role NOT IN ('owner', 'member')
		OR NOT emdo.is_safe_audio_claim_outcome(p_stored_result)
	THEN
		RAISE EXCEPTION USING ERRCODE = '22023',
			MESSAGE = 'audio claim outcome acknowledgement is invalid';
	END IF;
	SELECT receipt.* INTO STRICT v_receipt
	FROM emdo.audio_request_receipts AS receipt
	WHERE receipt.receipt_id = p_receipt_id
		AND receipt.household_id = NULLIF(
			pg_catalog.current_setting('emdo.audio_household_id', true), ''
		)::uuid
		AND receipt.user_id = emdo.current_user_id();
	INSERT INTO emdo.audio_request_claim_outcomes (
		operation_id, operation_hash, household_id, user_id,
		origin_session_id, origin_request_id, origin_space_access_grant_id,
		origin_role, receipt_id, request_claim_id,
		request_ownership_token_hash, generation_claim_id,
		generation_ownership_token_hash, claim_generation, receipt_revision,
		stored_result, recorded_at, retain_until
	) VALUES (
		p_operation_id, p_operation_hash, v_receipt.household_id,
		v_receipt.user_id, emdo.current_session_id(), emdo.current_request_id(),
		p_space_access_grant_id, p_role, v_receipt.receipt_id,
		p_request_claim_id, p_request_ownership_token_hash, v_receipt.claim_id,
		v_receipt.ownership_token_hash, v_receipt.claim_generation,
		v_receipt.version, p_stored_result, v_now, v_receipt.retain_until
	);
	RETURN p_stored_result;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."claim_audio_request"(
	p_operation_id uuid,
	p_operation_hash text,
	p_claim_id uuid,
	p_execution_id uuid,
	p_reservation_id uuid,
	p_idempotency_key text,
	p_kind text,
	p_model text,
	p_input_units bigint,
	p_request_fingerprint text,
	p_ownership_token_hash text,
	p_lease_duration_ms integer,
	p_household_id uuid,
	p_space_access_grant_id uuid,
	p_role text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_receipt emdo.audio_request_receipts%ROWTYPE;
	v_outcome emdo.audio_request_claim_outcomes%ROWTYPE;
	v_now timestamptz := pg_catalog.clock_timestamp();
	v_retry_after integer;
	v_expected_hash text;
	v_result jsonb;
BEGIN
	IF p_operation_id IS NULL OR p_claim_id IS NULL
		OR p_execution_id IS NULL OR p_reservation_id IS NULL
		OR p_operation_hash IS NULL
		OR p_operation_hash !~ '^[a-f0-9]{64}$'
		OR p_idempotency_key IS NULL OR p_kind IS NULL OR p_model IS NULL
		OR p_input_units IS NULL OR p_request_fingerprint IS NULL
		OR p_ownership_token_hash IS NULL OR p_lease_duration_ms IS NULL
		OR p_request_fingerprint !~ '^[a-f0-9]{64}$'
		OR p_ownership_token_hash !~ '^[a-f0-9]{64}$'
		OR p_lease_duration_ms NOT BETWEEN 30000 AND 300000
		OR pg_catalog.length(p_idempotency_key) NOT BETWEEN 16 AND 200
		OR p_idempotency_key !~ '^[A-Za-z0-9:._-]+$'
		OR p_input_units NOT BETWEEN 1 AND 26214400
		OR NOT (
			(p_kind = 'transcription' AND p_model IN (
				'gpt-4o-mini-transcribe', 'gpt-4o-transcribe'
			)) OR (p_kind = 'speech' AND p_model IN (
				'tts-1', 'tts-1-hd', 'gpt-4o-mini-tts',
				'gpt-4o-mini-tts-2025-12-15'
			))
		)
		OR NOT emdo.audio_request_scope_is_current(
			p_household_id, p_space_access_grant_id, p_role
		)
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	v_expected_hash := emdo.audio_request_operation_hash(ARRAY[
		'claim', p_claim_id::text, p_execution_id::text,
		p_reservation_id::text, p_household_id::text,
		emdo.current_user_id()::text, emdo.current_session_id()::text,
		emdo.current_request_id()::text, p_space_access_grant_id::text,
		p_role, p_idempotency_key, p_kind, p_model, p_input_units::text,
		p_request_fingerprint, p_ownership_token_hash,
		p_lease_duration_ms::text
	]);
	IF p_operation_hash <> v_expected_hash THEN
		RETURN pg_catalog.jsonb_build_object('status', 'conflict');
	END IF;
	PERFORM pg_catalog.set_config(
		'emdo.audio_household_id', p_household_id::text, true
	);
	SELECT outcome.* INTO v_outcome
	FROM emdo.audio_request_claim_outcomes AS outcome
	WHERE outcome.operation_id = p_operation_id;
	IF FOUND THEN
		RETURN CASE WHEN v_outcome.operation_hash = p_operation_hash
			AND v_outcome.household_id = p_household_id
			AND v_outcome.user_id = emdo.current_user_id()
			AND v_outcome.origin_session_id = emdo.current_session_id()
			AND v_outcome.origin_request_id = emdo.current_request_id()
			AND v_outcome.origin_space_access_grant_id = p_space_access_grant_id
			AND v_outcome.origin_role = p_role
			AND v_outcome.request_claim_id = p_claim_id
			AND v_outcome.request_ownership_token_hash = p_ownership_token_hash
		THEN v_outcome.stored_result
		ELSE pg_catalog.jsonb_build_object('status', 'conflict') END;
	END IF;
	PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
		p_household_id::text || ':' || emdo.current_user_id()::text || ':' ||
		p_idempotency_key, 0
	));

	SELECT receipt.* INTO v_receipt
	FROM emdo.audio_request_receipts AS receipt
	WHERE receipt.household_id = p_household_id
		AND receipt.user_id = emdo.current_user_id()
		AND receipt.idempotency_key = p_idempotency_key
	FOR UPDATE;

	IF NOT FOUND THEN
		INSERT INTO emdo.audio_request_receipts (
			receipt_id, schema_version, household_id, user_id,
			authenticated_session_id, origin_request_id,
			origin_space_access_grant_id, origin_role, idempotency_key,
			kind, model, input_units, request_fingerprint, state, version,
			claim_generation, claim_id, ownership_token_hash, execution_id,
			reservation_id, lease_expires_at, reconciliation_status,
			created_at, updated_at, retain_until
		) VALUES (
			gen_random_uuid(), 1, p_household_id, emdo.current_user_id(),
			emdo.current_session_id(), emdo.current_request_id(),
			p_space_access_grant_id, p_role, p_idempotency_key,
			p_kind, p_model, p_input_units, p_request_fingerprint,
			'claimed', 1, 1, p_claim_id, p_ownership_token_hash,
			p_execution_id, p_reservation_id,
			v_now + pg_catalog.make_interval(
				secs => p_lease_duration_ms::double precision / 1000.0
			), 'not-required', v_now, v_now, v_now + interval '90 days'
		)
		RETURNING * INTO v_receipt;
		INSERT INTO emdo.audio_request_receipt_operations (
			operation_id, receipt_id, household_id, user_id,
			receipt_revision, claim_id, ownership_token_hash,
			claim_generation, generation_claim_id,
			generation_ownership_token_hash, execution_id, reservation_id,
			operation_kind, operation_hash,
			state_after, recorded_at, retain_until
		) VALUES (
			p_operation_id, v_receipt.receipt_id, v_receipt.household_id,
			v_receipt.user_id, v_receipt.version, v_receipt.claim_id,
			p_ownership_token_hash,
			v_receipt.claim_generation, v_receipt.claim_id,
			v_receipt.ownership_token_hash, v_receipt.execution_id,
			v_receipt.reservation_id,
			'claim', p_operation_hash, v_receipt.state, v_now,
			v_receipt.retain_until
		);
		v_result := pg_catalog.jsonb_build_object(
			'status', 'claimed', 'claimId', v_receipt.claim_id,
			'executionId', v_receipt.execution_id,
			'reservationId', v_receipt.reservation_id
		);
		RETURN emdo.record_audio_request_claim_outcome(
			p_operation_id, p_operation_hash, v_receipt.receipt_id,
			p_claim_id, p_ownership_token_hash, p_space_access_grant_id,
			p_role, v_result
		);
	END IF;

	IF v_receipt.kind IS DISTINCT FROM p_kind
		OR v_receipt.model IS DISTINCT FROM p_model
		OR v_receipt.input_units IS DISTINCT FROM p_input_units
		OR v_receipt.request_fingerprint IS DISTINCT FROM p_request_fingerprint
	THEN
		v_result := pg_catalog.jsonb_build_object('status', 'conflict');
		RETURN emdo.record_audio_request_claim_outcome(
			p_operation_id, p_operation_hash, v_receipt.receipt_id,
			p_claim_id, p_ownership_token_hash, p_space_access_grant_id,
			p_role, v_result
		);
	END IF;

	IF v_receipt.state = 'claimed' THEN
		IF v_receipt.lease_expires_at <= pg_catalog.clock_timestamp() THEN
			UPDATE emdo.audio_request_receipts
			SET state = 'indeterminate', version = version + 1,
				reason_code = 'claim-lease-expired',
				reconciliation_status = 'pending',
				reconciliation_marked_at = pg_catalog.clock_timestamp(),
				updated_at = pg_catalog.clock_timestamp()
			WHERE receipt_id = v_receipt.receipt_id
			RETURNING * INTO v_receipt;
			INSERT INTO emdo.audio_request_receipt_operations (
				operation_id, receipt_id, household_id, user_id,
				receipt_revision, claim_id, ownership_token_hash,
				claim_generation, generation_claim_id,
				generation_ownership_token_hash, execution_id, reservation_id,
				operation_kind, operation_hash,
				state_after, safe_code, recorded_at, retain_until
			) VALUES (
				p_operation_id, v_receipt.receipt_id, v_receipt.household_id,
				v_receipt.user_id, v_receipt.version, p_claim_id,
				p_ownership_token_hash,
				v_receipt.claim_generation, v_receipt.claim_id,
				v_receipt.ownership_token_hash, v_receipt.execution_id,
				v_receipt.reservation_id,
				'claim', p_operation_hash, 'indeterminate',
				'claim-lease-expired', pg_catalog.clock_timestamp(),
				v_receipt.retain_until
			);
			v_result := pg_catalog.jsonb_build_object('status', 'indeterminate');
			RETURN emdo.record_audio_request_claim_outcome(
				p_operation_id, p_operation_hash, v_receipt.receipt_id,
				p_claim_id, p_ownership_token_hash, p_space_access_grant_id,
				p_role, v_result
			);
		END IF;
		v_retry_after := GREATEST(100, LEAST(
			60000,
			pg_catalog.floor(EXTRACT(EPOCH FROM
				(v_receipt.lease_expires_at - pg_catalog.clock_timestamp())
			) * 1000)::integer
		));
		v_result := pg_catalog.jsonb_build_object(
			'status', 'in-progress', 'retryAfterMs', v_retry_after
		);
		RETURN emdo.record_audio_request_claim_outcome(
			p_operation_id, p_operation_hash, v_receipt.receipt_id,
			p_claim_id, p_ownership_token_hash, p_space_access_grant_id,
			p_role, v_result
		);
	END IF;

	IF v_receipt.state = 'released' THEN
		UPDATE emdo.audio_request_receipts
		SET state = 'claimed', version = version + 1,
			claim_generation = claim_generation + 1,
			claim_id = p_claim_id,
			ownership_token_hash = p_ownership_token_hash,
			execution_id = p_execution_id,
			reservation_id = p_reservation_id,
			lease_expires_at = pg_catalog.clock_timestamp() +
				pg_catalog.make_interval(
					secs => p_lease_duration_ms::double precision / 1000.0
				),
			reason_code = NULL, reconciliation_status = 'not-required',
			reconciliation_resolution = NULL, operator_reference = NULL,
			reconciliation_marked_at = NULL, reconciled_at = NULL,
			released_at = NULL,
			updated_at = pg_catalog.clock_timestamp()
		WHERE receipt_id = v_receipt.receipt_id
		RETURNING * INTO v_receipt;
		INSERT INTO emdo.audio_request_receipt_operations (
			operation_id, receipt_id, household_id, user_id,
			receipt_revision, claim_id, ownership_token_hash,
			claim_generation, generation_claim_id,
			generation_ownership_token_hash, execution_id, reservation_id,
			operation_kind, operation_hash,
			state_after, recorded_at, retain_until
		) VALUES (
			p_operation_id, v_receipt.receipt_id, v_receipt.household_id,
			v_receipt.user_id, v_receipt.version, v_receipt.claim_id,
			p_ownership_token_hash,
			v_receipt.claim_generation, v_receipt.claim_id,
			v_receipt.ownership_token_hash, v_receipt.execution_id,
			v_receipt.reservation_id,
			'claim', p_operation_hash, 'claimed',
			pg_catalog.clock_timestamp(), v_receipt.retain_until
		);
		v_result := pg_catalog.jsonb_build_object(
			'status', 'claimed', 'claimId', v_receipt.claim_id,
			'executionId', v_receipt.execution_id,
			'reservationId', v_receipt.reservation_id
		);
		RETURN emdo.record_audio_request_claim_outcome(
			p_operation_id, p_operation_hash, v_receipt.receipt_id,
			p_claim_id, p_ownership_token_hash, p_space_access_grant_id,
			p_role, v_result
		);
	END IF;
	IF v_receipt.state = 'completed-transcription' THEN
		v_result := pg_catalog.jsonb_build_object(
			'status', 'replay', 'result', pg_catalog.jsonb_build_object(
				'kind', 'transcription', 'transcript', v_receipt.transcript,
				'model', v_receipt.result_model,
				'spendWarning', v_receipt.spend_warning
			)
		);
		RETURN emdo.record_audio_request_claim_outcome(
			p_operation_id, p_operation_hash, v_receipt.receipt_id,
			p_claim_id, p_ownership_token_hash, p_space_access_grant_id,
			p_role, v_result
		);
	END IF;
	IF v_receipt.state IN (
		'completed-speech', 'completed-nonreplayable'
	) THEN
		v_result := pg_catalog.jsonb_build_object(
			'status', 'completed-nonreplayable'
		);
		RETURN emdo.record_audio_request_claim_outcome(
			p_operation_id, p_operation_hash, v_receipt.receipt_id,
			p_claim_id, p_ownership_token_hash, p_space_access_grant_id,
			p_role, v_result
		);
	END IF;
	v_result := pg_catalog.jsonb_build_object('status', 'indeterminate');
	RETURN emdo.record_audio_request_claim_outcome(
		p_operation_id, p_operation_hash, v_receipt.receipt_id,
		p_claim_id, p_ownership_token_hash, p_space_access_grant_id,
		p_role, v_result
	);
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."complete_audio_transcription"(
	p_operation_id uuid,
	p_operation_hash text,
	p_claim_id uuid,
	p_ownership_token_hash text,
	p_transcript text,
	p_model text,
	p_spend_warning boolean,
	p_household_id uuid,
	p_space_access_grant_id uuid,
	p_role text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_receipt emdo.audio_request_receipts%ROWTYPE;
	v_ack emdo.audio_request_receipt_operations%ROWTYPE;
	v_expected_hash text;
BEGIN
	IF p_operation_id IS NULL OR p_claim_id IS NULL
		OR p_transcript IS NULL OR p_model IS NULL OR p_spend_warning IS NULL
		OR p_operation_hash IS NULL OR p_ownership_token_hash IS NULL
		OR p_operation_hash !~ '^[a-f0-9]{64}$'
		OR p_ownership_token_hash !~ '^[a-f0-9]{64}$'
		OR pg_catalog.length(p_transcript) NOT BETWEEN 1 AND 50000
		OR pg_catalog.octet_length(p_transcript) > 200000
		OR NOT emdo.audio_request_scope_is_current(
			p_household_id, p_space_access_grant_id, p_role
		)
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'denied');
	END IF;
	v_expected_hash := emdo.audio_request_operation_hash(ARRAY[
		'transcription-complete', p_claim_id::text, p_ownership_token_hash,
		p_transcript, p_model, p_spend_warning::text, p_household_id::text,
		emdo.current_user_id()::text, emdo.current_session_id()::text,
		emdo.current_request_id()::text, p_space_access_grant_id::text, p_role
	]);
	IF p_operation_hash <> v_expected_hash THEN
		RETURN pg_catalog.jsonb_build_object('status', 'denied');
	END IF;
	PERFORM pg_catalog.set_config(
		'emdo.audio_household_id', p_household_id::text, true
	);
	SELECT operation.* INTO v_ack
	FROM emdo.audio_request_receipt_operations AS operation
	WHERE operation.operation_id = p_operation_id;
	IF FOUND THEN
		RETURN pg_catalog.jsonb_build_object('status',
			CASE WHEN v_ack.operation_kind = 'transcription-complete'
				AND v_ack.operation_hash = p_operation_hash
				AND v_ack.claim_id = p_claim_id
				AND v_ack.ownership_token_hash = p_ownership_token_hash
			THEN 'exact-replay' ELSE 'denied' END
		);
	END IF;
	SELECT receipt.* INTO v_receipt
	FROM emdo.audio_request_receipts AS receipt
	WHERE receipt.household_id = p_household_id
		AND receipt.user_id = emdo.current_user_id()
		AND receipt.claim_id = p_claim_id
	FOR UPDATE;
	IF NOT FOUND OR v_receipt.state <> 'claimed'
		OR v_receipt.kind <> 'transcription'
		OR v_receipt.model <> p_model
		OR v_receipt.ownership_token_hash <> p_ownership_token_hash
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'denied');
	END IF;
	UPDATE emdo.audio_request_receipts
	SET state = 'completed-transcription', version = version + 1,
		transcript = p_transcript, result_model = p_model,
		spend_warning = p_spend_warning,
		completed_at = pg_catalog.clock_timestamp(),
		updated_at = pg_catalog.clock_timestamp()
	WHERE receipt_id = v_receipt.receipt_id
	RETURNING * INTO v_receipt;
	INSERT INTO emdo.audio_request_receipt_operations (
		operation_id, receipt_id, household_id, user_id,
		receipt_revision, claim_id, ownership_token_hash,
		claim_generation, generation_claim_id,
		generation_ownership_token_hash, execution_id, reservation_id,
		operation_kind, operation_hash,
		state_after, recorded_at, retain_until
	) VALUES (
		p_operation_id, v_receipt.receipt_id, v_receipt.household_id,
		v_receipt.user_id, v_receipt.version, v_receipt.claim_id,
		p_ownership_token_hash,
		v_receipt.claim_generation, v_receipt.claim_id,
		v_receipt.ownership_token_hash, v_receipt.execution_id,
		v_receipt.reservation_id,
		'transcription-complete', p_operation_hash,
		'completed-transcription', pg_catalog.clock_timestamp(),
		v_receipt.retain_until
	);
	RETURN pg_catalog.jsonb_build_object('status', 'completed');
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."complete_audio_speech"(
	p_operation_id uuid,
	p_operation_hash text,
	p_claim_id uuid,
	p_ownership_token_hash text,
	p_model text,
	p_content_type text,
	p_household_id uuid,
	p_space_access_grant_id uuid,
	p_role text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_receipt emdo.audio_request_receipts%ROWTYPE;
	v_ack emdo.audio_request_receipt_operations%ROWTYPE;
	v_expected_hash text;
BEGIN
	IF p_operation_id IS NULL OR p_claim_id IS NULL
		OR p_model IS NULL OR p_content_type IS NULL
		OR p_operation_hash IS NULL OR p_ownership_token_hash IS NULL
		OR p_operation_hash !~ '^[a-f0-9]{64}$'
		OR p_ownership_token_hash !~ '^[a-f0-9]{64}$'
		OR p_content_type NOT IN ('audio/mpeg', 'audio/wav', 'audio/ogg')
		OR NOT emdo.audio_request_scope_is_current(
			p_household_id, p_space_access_grant_id, p_role
		)
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'denied');
	END IF;
	v_expected_hash := emdo.audio_request_operation_hash(ARRAY[
		'speech-complete', p_claim_id::text, p_ownership_token_hash,
		p_model, p_content_type, p_household_id::text,
		emdo.current_user_id()::text, emdo.current_session_id()::text,
		emdo.current_request_id()::text, p_space_access_grant_id::text, p_role
	]);
	IF p_operation_hash <> v_expected_hash THEN
		RETURN pg_catalog.jsonb_build_object('status', 'denied');
	END IF;
	PERFORM pg_catalog.set_config(
		'emdo.audio_household_id', p_household_id::text, true
	);
	SELECT operation.* INTO v_ack
	FROM emdo.audio_request_receipt_operations AS operation
	WHERE operation.operation_id = p_operation_id;
	IF FOUND THEN
		RETURN pg_catalog.jsonb_build_object('status',
			CASE WHEN v_ack.operation_kind = 'speech-complete'
				AND v_ack.operation_hash = p_operation_hash
				AND v_ack.claim_id = p_claim_id
				AND v_ack.ownership_token_hash = p_ownership_token_hash
			THEN 'exact-replay' ELSE 'denied' END
		);
	END IF;
	SELECT receipt.* INTO v_receipt
	FROM emdo.audio_request_receipts AS receipt
	WHERE receipt.household_id = p_household_id
		AND receipt.user_id = emdo.current_user_id()
		AND receipt.claim_id = p_claim_id
	FOR UPDATE;
	IF NOT FOUND OR v_receipt.state <> 'claimed'
		OR v_receipt.kind <> 'speech'
		OR v_receipt.model <> p_model
		OR v_receipt.ownership_token_hash <> p_ownership_token_hash
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'denied');
	END IF;
	UPDATE emdo.audio_request_receipts
	SET state = 'completed-speech', version = version + 1,
		result_model = p_model, result_content_type = p_content_type,
		completed_at = pg_catalog.clock_timestamp(),
		updated_at = pg_catalog.clock_timestamp()
	WHERE receipt_id = v_receipt.receipt_id
	RETURNING * INTO v_receipt;
	INSERT INTO emdo.audio_request_receipt_operations (
		operation_id, receipt_id, household_id, user_id,
		receipt_revision, claim_id, ownership_token_hash,
		claim_generation, generation_claim_id,
		generation_ownership_token_hash, execution_id, reservation_id,
		operation_kind, operation_hash,
		state_after, recorded_at, retain_until
	) VALUES (
		p_operation_id, v_receipt.receipt_id, v_receipt.household_id,
		v_receipt.user_id, v_receipt.version, v_receipt.claim_id,
		p_ownership_token_hash,
		v_receipt.claim_generation, v_receipt.claim_id,
		v_receipt.ownership_token_hash, v_receipt.execution_id,
		v_receipt.reservation_id,
		'speech-complete', p_operation_hash, 'completed-speech',
		pg_catalog.clock_timestamp(), v_receipt.retain_until
	);
	RETURN pg_catalog.jsonb_build_object('status', 'completed');
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."release_audio_request_claim"(
	p_operation_id uuid,
	p_operation_hash text,
	p_claim_id uuid,
	p_ownership_token_hash text,
	p_reason_code text,
	p_household_id uuid,
	p_space_access_grant_id uuid,
	p_role text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_receipt emdo.audio_request_receipts%ROWTYPE;
	v_ack emdo.audio_request_receipt_operations%ROWTYPE;
	v_expected_hash text;
BEGIN
	IF p_operation_id IS NULL OR p_claim_id IS NULL
		OR p_reason_code IS NULL OR p_operation_hash IS NULL
		OR p_ownership_token_hash IS NULL
		OR p_reason_code NOT IN (
		'transcription-provider-not-dispatched',
		'speech-provider-not-dispatched'
	) OR p_operation_hash !~ '^[a-f0-9]{64}$'
		OR p_ownership_token_hash !~ '^[a-f0-9]{64}$'
		OR NOT emdo.audio_request_scope_is_current(
			p_household_id, p_space_access_grant_id, p_role
		)
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'denied');
	END IF;
	v_expected_hash := emdo.audio_request_operation_hash(ARRAY[
		'release', p_claim_id::text, p_ownership_token_hash, p_reason_code,
		p_household_id::text, emdo.current_user_id()::text,
		emdo.current_session_id()::text, emdo.current_request_id()::text,
		p_space_access_grant_id::text, p_role
	]);
	IF p_operation_hash <> v_expected_hash THEN
		RETURN pg_catalog.jsonb_build_object('status', 'denied');
	END IF;
	PERFORM pg_catalog.set_config(
		'emdo.audio_household_id', p_household_id::text, true
	);
	SELECT operation.* INTO v_ack
	FROM emdo.audio_request_receipt_operations AS operation
	WHERE operation.operation_id = p_operation_id;
	IF FOUND THEN
		RETURN pg_catalog.jsonb_build_object('status',
			CASE WHEN v_ack.operation_kind = 'release'
				AND v_ack.operation_hash = p_operation_hash
				AND v_ack.claim_id = p_claim_id
				AND v_ack.ownership_token_hash = p_ownership_token_hash
				AND v_ack.safe_code = p_reason_code
			THEN 'exact-replay' ELSE 'denied' END
		);
	END IF;
	SELECT receipt.* INTO v_receipt
	FROM emdo.audio_request_receipts AS receipt
	WHERE receipt.household_id = p_household_id
		AND receipt.user_id = emdo.current_user_id()
		AND receipt.claim_id = p_claim_id
	FOR UPDATE;
	IF NOT FOUND OR v_receipt.state <> 'claimed'
		OR v_receipt.ownership_token_hash <> p_ownership_token_hash
		OR (v_receipt.kind = 'transcription')
			IS DISTINCT FROM (p_reason_code LIKE 'transcription-%')
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'denied');
	END IF;
	UPDATE emdo.audio_request_receipts
	SET state = 'released', version = version + 1,
		reason_code = p_reason_code,
		released_at = pg_catalog.clock_timestamp(),
		updated_at = pg_catalog.clock_timestamp()
	WHERE receipt_id = v_receipt.receipt_id
	RETURNING * INTO v_receipt;
	INSERT INTO emdo.audio_request_receipt_operations (
		operation_id, receipt_id, household_id, user_id,
		receipt_revision, claim_id, ownership_token_hash,
		claim_generation, generation_claim_id,
		generation_ownership_token_hash, execution_id, reservation_id,
		operation_kind, operation_hash,
		state_after, safe_code, recorded_at, retain_until
	) VALUES (
		p_operation_id, v_receipt.receipt_id, v_receipt.household_id,
		v_receipt.user_id, v_receipt.version, v_receipt.claim_id,
		p_ownership_token_hash,
		v_receipt.claim_generation, v_receipt.claim_id,
		v_receipt.ownership_token_hash, v_receipt.execution_id,
		v_receipt.reservation_id,
		'release', p_operation_hash, 'released', p_reason_code,
		pg_catalog.clock_timestamp(), v_receipt.retain_until
	);
	RETURN pg_catalog.jsonb_build_object('status', 'released');
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."mark_audio_request_indeterminate"(
	p_operation_id uuid,
	p_operation_hash text,
	p_claim_id uuid,
	p_ownership_token_hash text,
	p_reason_code text,
	p_household_id uuid,
	p_space_access_grant_id uuid,
	p_role text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_receipt emdo.audio_request_receipts%ROWTYPE;
	v_ack emdo.audio_request_receipt_operations%ROWTYPE;
	v_expected_hash text;
BEGIN
	IF p_operation_id IS NULL OR p_claim_id IS NULL
		OR p_reason_code IS NULL OR p_operation_hash IS NULL
		OR p_ownership_token_hash IS NULL
		OR p_reason_code NOT IN (
		'transcription-provider-state-unknown',
		'speech-provider-state-unknown',
		'transcription-settlement-state-unknown',
		'speech-settlement-state-unknown'
	) OR p_operation_hash !~ '^[a-f0-9]{64}$'
		OR p_ownership_token_hash !~ '^[a-f0-9]{64}$'
		OR NOT emdo.audio_request_scope_is_current(
			p_household_id, p_space_access_grant_id, p_role
		)
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'denied');
	END IF;
	v_expected_hash := emdo.audio_request_operation_hash(ARRAY[
		'indeterminate', p_claim_id::text, p_ownership_token_hash,
		p_reason_code, p_household_id::text, emdo.current_user_id()::text,
		emdo.current_session_id()::text, emdo.current_request_id()::text,
		p_space_access_grant_id::text, p_role
	]);
	IF p_operation_hash <> v_expected_hash THEN
		RETURN pg_catalog.jsonb_build_object('status', 'denied');
	END IF;
	PERFORM pg_catalog.set_config(
		'emdo.audio_household_id', p_household_id::text, true
	);
	SELECT operation.* INTO v_ack
	FROM emdo.audio_request_receipt_operations AS operation
	WHERE operation.operation_id = p_operation_id;
	IF FOUND THEN
		RETURN pg_catalog.jsonb_build_object('status',
			CASE WHEN v_ack.operation_kind = 'indeterminate'
				AND v_ack.operation_hash = p_operation_hash
				AND v_ack.claim_id = p_claim_id
				AND v_ack.ownership_token_hash = p_ownership_token_hash
				AND v_ack.safe_code = p_reason_code
			THEN 'exact-replay' ELSE 'denied' END
		);
	END IF;
	SELECT receipt.* INTO v_receipt
	FROM emdo.audio_request_receipts AS receipt
	WHERE receipt.household_id = p_household_id
		AND receipt.user_id = emdo.current_user_id()
		AND receipt.claim_id = p_claim_id
	FOR UPDATE;
	IF NOT FOUND OR v_receipt.state <> 'claimed'
		OR v_receipt.ownership_token_hash <> p_ownership_token_hash
		OR (v_receipt.kind = 'transcription')
			IS DISTINCT FROM (p_reason_code LIKE 'transcription-%')
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'denied');
	END IF;
	UPDATE emdo.audio_request_receipts
	SET state = 'indeterminate', version = version + 1,
		reason_code = p_reason_code,
		reconciliation_status = 'pending',
		reconciliation_marked_at = pg_catalog.clock_timestamp(),
		updated_at = pg_catalog.clock_timestamp()
	WHERE receipt_id = v_receipt.receipt_id
	RETURNING * INTO v_receipt;
	INSERT INTO emdo.audio_request_receipt_operations (
		operation_id, receipt_id, household_id, user_id,
		receipt_revision, claim_id, ownership_token_hash,
		claim_generation, generation_claim_id,
		generation_ownership_token_hash, execution_id, reservation_id,
		operation_kind, operation_hash,
		state_after, safe_code, recorded_at, retain_until
	) VALUES (
		p_operation_id, v_receipt.receipt_id, v_receipt.household_id,
		v_receipt.user_id, v_receipt.version, v_receipt.claim_id,
		p_ownership_token_hash,
		v_receipt.claim_generation, v_receipt.claim_id,
		v_receipt.ownership_token_hash, v_receipt.execution_id,
		v_receipt.reservation_id,
		'indeterminate', p_operation_hash, 'indeterminate', p_reason_code,
		pg_catalog.clock_timestamp(), v_receipt.retain_until
	);
	RETURN pg_catalog.jsonb_build_object('status', 'indeterminate');
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."read_audio_request_claim"(
	p_operation_id uuid,
	p_operation_hash text,
	p_claim_id uuid,
	p_ownership_token_hash text,
	p_idempotency_key text,
	p_kind text,
	p_model text,
	p_input_units bigint,
	p_request_fingerprint text,
	p_household_id uuid,
	p_space_access_grant_id uuid,
	p_role text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_outcome emdo.audio_request_claim_outcomes%ROWTYPE;
BEGIN
	IF p_operation_id IS NULL OR p_claim_id IS NULL
		OR p_operation_hash IS NULL
		OR p_operation_hash !~ '^[a-f0-9]{64}$'
		OR p_ownership_token_hash IS NULL
		OR p_ownership_token_hash !~ '^[a-f0-9]{64}$'
		OR p_idempotency_key IS NULL OR p_kind IS NULL OR p_model IS NULL
		OR p_input_units IS NULL OR p_request_fingerprint IS NULL
		OR p_request_fingerprint !~ '^[a-f0-9]{64}$'
		OR pg_catalog.length(p_idempotency_key) NOT BETWEEN 16 AND 200
		OR p_idempotency_key !~ '^[A-Za-z0-9:._-]+$'
		OR p_input_units NOT BETWEEN 1 AND 26214400
		OR NOT emdo.audio_request_scope_is_current(
			p_household_id, p_space_access_grant_id, p_role
		)
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'denied');
	END IF;
	PERFORM pg_catalog.set_config(
		'emdo.audio_household_id', p_household_id::text, true
	);
	SELECT outcome.* INTO v_outcome
	FROM emdo.audio_request_claim_outcomes AS outcome
	JOIN emdo.audio_request_receipts AS receipt
		ON receipt.receipt_id = outcome.receipt_id
	WHERE outcome.operation_id = p_operation_id
		AND outcome.operation_hash = p_operation_hash
		AND outcome.household_id = p_household_id
		AND outcome.user_id = emdo.current_user_id()
		AND outcome.origin_session_id = emdo.current_session_id()
		AND outcome.origin_request_id = emdo.current_request_id()
		AND outcome.origin_space_access_grant_id = p_space_access_grant_id
		AND outcome.origin_role = p_role
		AND outcome.request_claim_id = p_claim_id
		AND outcome.request_ownership_token_hash = p_ownership_token_hash
		AND receipt.idempotency_key = p_idempotency_key
		AND receipt.kind = p_kind
		AND receipt.model = p_model
		AND receipt.input_units = p_input_units
		AND receipt.request_fingerprint = p_request_fingerprint;
	RETURN CASE WHEN FOUND THEN v_outcome.stored_result
		ELSE pg_catalog.jsonb_build_object('status', 'denied') END;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."read_audio_request_operation"(
	p_operation_id uuid,
	p_operation_hash text,
	p_claim_id uuid,
	p_ownership_token_hash text,
	p_operation_kind text,
	p_household_id uuid,
	p_space_access_grant_id uuid,
	p_role text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
BEGIN
	IF p_operation_hash !~ '^[a-f0-9]{64}$'
		OR p_ownership_token_hash !~ '^[a-f0-9]{64}$'
		OR p_operation_kind NOT IN (
			'transcription-complete', 'speech-complete',
			'release', 'indeterminate'
		)
		OR NOT emdo.audio_request_scope_is_current(
			p_household_id, p_space_access_grant_id, p_role
		)
	THEN
		RETURN pg_catalog.jsonb_build_object('status', 'denied');
	END IF;
	PERFORM pg_catalog.set_config(
		'emdo.audio_household_id', p_household_id::text, true
	);
	PERFORM 1
	FROM emdo.audio_request_receipt_operations AS operation
	WHERE operation.operation_id = p_operation_id
		AND operation.household_id = p_household_id
		AND operation.user_id = emdo.current_user_id()
		AND operation.claim_id = p_claim_id
		AND operation.ownership_token_hash = p_ownership_token_hash
		AND operation.operation_kind = p_operation_kind
		AND operation.operation_hash = p_operation_hash;
	RETURN pg_catalog.jsonb_build_object(
		'status', CASE WHEN FOUND THEN 'exact-replay' ELSE 'denied' END
	);
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."list_audio_request_reconciliation"(
	p_limit integer
)
RETURNS TABLE (
	receipt_id uuid,
	kind text,
	model text,
	reason_code text,
	version bigint,
	execution_id uuid,
	reservation_id uuid,
	marked_at timestamp with time zone
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
BEGIN
	IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
		RETURN;
	END IF;
	RETURN QUERY
	SELECT receipt.receipt_id, receipt.kind, receipt.model,
		receipt.reason_code, receipt.version, receipt.execution_id,
		receipt.reservation_id,
		receipt.reconciliation_marked_at
	FROM emdo.audio_request_receipts AS receipt
	WHERE receipt.state = 'indeterminate'
		AND receipt.reconciliation_status = 'pending'
	ORDER BY receipt.reconciliation_marked_at, receipt.receipt_id
	LIMIT p_limit;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."resolve_audio_request_reconciliation"(
	p_operation_id uuid,
	p_operation_hash text,
	p_receipt_id uuid,
	p_expected_version bigint,
	p_resolution text,
	p_operator_reference text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_receipt emdo.audio_request_receipts%ROWTYPE;
	v_ack emdo.audio_request_receipt_operations%ROWTYPE;
	v_now timestamptz := pg_catalog.clock_timestamp();
	v_operation_kind text;
	v_target_state text;
	v_expected_hash text;
BEGIN
	IF p_operation_id IS NULL OR p_receipt_id IS NULL
		OR p_expected_version IS NULL
		OR p_resolution IS NULL OR p_operator_reference IS NULL
		OR p_expected_version < 1
		OR p_operation_hash IS NULL
		OR p_operation_hash !~ '^[a-f0-9]{64}$'
		OR p_resolution NOT IN (
		'confirmed-not-dispatched', 'confirmed-dispatched'
	) OR pg_catalog.length(p_operator_reference) NOT BETWEEN 8 AND 200
		OR p_operator_reference !~ '^[A-Za-z0-9:._-]+$'
	THEN
		RETURN 'conflict';
	END IF;
	v_expected_hash := pg_catalog.encode(pg_catalog.sha256(
		pg_catalog.convert_to(
			p_receipt_id::text || ':' || p_expected_version::text || ':' ||
			p_resolution || ':' || p_operator_reference, 'UTF8'
		)
	), 'hex');
	IF p_operation_hash <> v_expected_hash THEN
		RETURN 'conflict';
	END IF;
	v_operation_kind := CASE p_resolution
		WHEN 'confirmed-not-dispatched' THEN 'operator-release'
		ELSE 'operator-close'
	END;
	SELECT operation.* INTO v_ack
	FROM emdo.audio_request_receipt_operations AS operation
	WHERE operation.operation_id = p_operation_id;
	IF FOUND THEN
		RETURN CASE WHEN v_ack.receipt_id = p_receipt_id
			AND v_ack.receipt_revision = p_expected_version + 1
			AND v_ack.operation_kind = v_operation_kind
			AND v_ack.operation_hash = p_operation_hash
			AND v_ack.safe_code = p_resolution
		THEN 'resolved' ELSE 'conflict' END;
	END IF;
	SELECT receipt.* INTO v_receipt
	FROM emdo.audio_request_receipts AS receipt
	WHERE receipt.receipt_id = p_receipt_id
		AND receipt.version = p_expected_version
		AND receipt.state = 'indeterminate'
		AND receipt.reconciliation_status = 'pending'
	FOR UPDATE;
	IF NOT FOUND THEN
		RETURN 'conflict';
	END IF;
	IF p_resolution = 'confirmed-not-dispatched' THEN
		v_target_state := 'released';
		UPDATE emdo.audio_request_receipts
		SET state = 'released', version = version + 1,
			reconciliation_status = 'resolved',
			reconciliation_resolution = p_resolution,
			operator_reference = p_operator_reference,
			reconciled_at = v_now, released_at = v_now, updated_at = v_now
		WHERE receipt_id = p_receipt_id;
	ELSE
		v_target_state := 'completed-nonreplayable';
		UPDATE emdo.audio_request_receipts
		SET state = 'completed-nonreplayable', version = version + 1,
			reconciliation_status = 'resolved',
			reconciliation_resolution = p_resolution,
			operator_reference = p_operator_reference,
			reconciled_at = v_now, completed_at = v_now, updated_at = v_now
		WHERE receipt_id = p_receipt_id;
	END IF;
	IF NOT FOUND THEN
		RETURN 'conflict';
	END IF;
	INSERT INTO emdo.audio_request_receipt_operations (
		operation_id, receipt_id, household_id, user_id,
		receipt_revision, claim_id, claim_generation,
		generation_claim_id, generation_ownership_token_hash,
		execution_id, reservation_id, operation_kind, operation_hash,
		state_after, safe_code, recorded_at, retain_until
	) VALUES (
		p_operation_id, v_receipt.receipt_id, v_receipt.household_id,
		v_receipt.user_id, p_expected_version + 1, v_receipt.claim_id,
		v_receipt.claim_generation, v_receipt.claim_id,
		v_receipt.ownership_token_hash, v_receipt.execution_id,
		v_receipt.reservation_id,
		v_operation_kind, p_operation_hash,
		v_target_state, p_resolution, v_now, v_receipt.retain_until
	);
	RETURN 'resolved';
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."read_audio_request_reconciliation_operation"(
	p_operation_id uuid,
	p_operation_hash text,
	p_receipt_id uuid,
	p_expected_version bigint,
	p_resolution text,
	p_operator_reference text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_ack emdo.audio_request_receipt_operations%ROWTYPE;
	v_operation_kind text;
	v_expected_hash text;
BEGIN
	IF p_operation_id IS NULL OR p_receipt_id IS NULL
		OR p_expected_version IS NULL
		OR p_resolution IS NULL OR p_operator_reference IS NULL
		OR p_expected_version < 1
		OR p_operation_hash IS NULL
		OR p_operation_hash !~ '^[a-f0-9]{64}$'
		OR p_resolution NOT IN (
			'confirmed-not-dispatched', 'confirmed-dispatched'
		)
		OR pg_catalog.length(p_operator_reference) NOT BETWEEN 8 AND 200
		OR p_operator_reference !~ '^[A-Za-z0-9:._-]+$'
	THEN
		RETURN 'conflict';
	END IF;
	v_expected_hash := pg_catalog.encode(pg_catalog.sha256(
		pg_catalog.convert_to(
			p_receipt_id::text || ':' || p_expected_version::text || ':' ||
			p_resolution || ':' || p_operator_reference, 'UTF8'
		)
	), 'hex');
	IF p_operation_hash <> v_expected_hash THEN
		RETURN 'conflict';
	END IF;
	v_operation_kind := CASE p_resolution
		WHEN 'confirmed-not-dispatched' THEN 'operator-release'
		ELSE 'operator-close'
	END;
	SELECT operation.* INTO v_ack
	FROM emdo.audio_request_receipt_operations AS operation
	WHERE operation.operation_id = p_operation_id;
	RETURN CASE WHEN FOUND
		AND v_ack.receipt_id = p_receipt_id
		AND v_ack.receipt_revision = p_expected_version + 1
		AND v_ack.operation_kind = v_operation_kind
		AND v_ack.operation_hash = p_operation_hash
		AND v_ack.safe_code = p_resolution
	THEN 'resolved' ELSE 'conflict' END;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."purge_expired_audio_request_receipts"(
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
	v_deleted integer := 0;
	v_receipt_ids uuid[];
BEGIN
	IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
		RETURN 0;
	END IF;
	SELECT pg_catalog.array_agg(candidate.receipt_id) INTO v_receipt_ids
	FROM (
		SELECT receipt.receipt_id
	FROM emdo.audio_request_receipts AS receipt
	WHERE receipt.retain_until <= pg_catalog.clock_timestamp()
		AND receipt.state IN (
			'released', 'completed-transcription', 'completed-speech',
			'completed-nonreplayable'
		)
		AND receipt.reconciliation_status <> 'pending'
	ORDER BY receipt.retain_until, receipt.receipt_id
	FOR UPDATE SKIP LOCKED
	LIMIT p_limit
	) AS candidate;
	IF v_receipt_ids IS NULL THEN
		RETURN 0;
	END IF;
	DELETE FROM emdo.audio_request_claim_outcomes AS outcome
	WHERE outcome.receipt_id = ANY (v_receipt_ids);
	DELETE FROM emdo.audio_request_receipt_operations AS operation
	WHERE operation.receipt_id = ANY (v_receipt_ids);
	DELETE FROM emdo.audio_request_receipts AS receipt
	WHERE receipt.receipt_id = ANY (v_receipt_ids);
	GET DIAGNOSTICS v_deleted = ROW_COUNT;
	RETURN v_deleted;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."audio_request_reconciliation_ready"()
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
			'emdo.audio_request_reconciliation_ready()'
		),
		pg_catalog.to_regprocedure(
			'emdo.list_audio_request_reconciliation(integer)'
		),
		pg_catalog.to_regprocedure(
			'emdo.resolve_audio_request_reconciliation(uuid,text,uuid,bigint,text,text)'
		),
		pg_catalog.to_regprocedure(
			'emdo.read_audio_request_reconciliation_operation(uuid,text,uuid,bigint,text,text)'
		)
	];
BEGIN
	RETURN session_user = 'emdo_audio_reconciliation_login'
		AND current_user = 'emdo_audio_reconciliation_executor'
		AND pg_catalog.pg_has_role(
			session_user, 'emdo_audio_reconciliation', 'SET'
		)
		AND NOT pg_catalog.pg_has_role(session_user, 'emdo_app', 'SET')
		AND (
			SELECT pg_catalog.count(*) = 1
			FROM pg_catalog.pg_auth_members AS membership
			JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
			JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
			WHERE child.rolname = session_user
				AND parent.rolname = 'emdo_audio_reconciliation'
				AND membership.admin_option = false
		)
		AND pg_catalog.array_position(v_expected, NULL) IS NULL
		AND (
			SELECT pg_catalog.count(*) = 4
			FROM pg_catalog.pg_proc AS routine
			WHERE routine.oid = ANY (v_expected)
				AND routine.prosecdef
				AND pg_catalog.pg_get_userbyid(routine.proowner)
					= 'emdo_audio_reconciliation_executor'
				AND routine.proconfig @> ARRAY['row_security=on']::text[]
				AND NOT EXISTS (
					SELECT 1
					FROM pg_catalog.aclexplode(COALESCE(
						routine.proacl,
						pg_catalog.acldefault('f', routine.proowner)
					)) AS privilege
					WHERE privilege.privilege_type = 'EXECUTE'
						AND privilege.grantee <> pg_catalog.to_regrole(
							'emdo_audio_reconciliation'
						)
				)
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user, 'emdo.audio_request_receipts', 'SELECT,INSERT,UPDATE,DELETE'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user, 'emdo.audio_request_receipt_operations', 'SELECT,INSERT,UPDATE,DELETE'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user, 'emdo.audio_request_claim_outcomes', 'SELECT,INSERT,UPDATE,DELETE'
		);
EXCEPTION WHEN OTHERS THEN
	RETURN false;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."audio_request_receipts_ready"()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_expected_app regprocedure[] := ARRAY[
		pg_catalog.to_regprocedure(
			'emdo.audio_request_receipts_ready()'
		),
		pg_catalog.to_regprocedure(
			'emdo.claim_audio_request(uuid,text,uuid,uuid,uuid,text,text,text,bigint,text,text,integer,uuid,uuid,text)'
		),
		pg_catalog.to_regprocedure(
			'emdo.complete_audio_transcription(uuid,text,uuid,text,text,text,boolean,uuid,uuid,text)'
		),
		pg_catalog.to_regprocedure(
			'emdo.complete_audio_speech(uuid,text,uuid,text,text,text,uuid,uuid,text)'
		),
		pg_catalog.to_regprocedure(
			'emdo.release_audio_request_claim(uuid,text,uuid,text,text,uuid,uuid,text)'
		),
		pg_catalog.to_regprocedure(
			'emdo.mark_audio_request_indeterminate(uuid,text,uuid,text,text,uuid,uuid,text)'
		),
		pg_catalog.to_regprocedure(
			'emdo.read_audio_request_claim(uuid,text,uuid,text,text,text,text,bigint,text,uuid,uuid,text)'
		),
		pg_catalog.to_regprocedure(
			'emdo.read_audio_request_operation(uuid,text,uuid,text,text,uuid,uuid,text)'
		)
	];
	v_expected_operator regprocedure[] := ARRAY[
		pg_catalog.to_regprocedure(
			'emdo.list_audio_request_reconciliation(integer)'
		),
		pg_catalog.to_regprocedure(
			'emdo.resolve_audio_request_reconciliation(uuid,text,uuid,bigint,text,text)'
		),
		pg_catalog.to_regprocedure(
			'emdo.read_audio_request_reconciliation_operation(uuid,text,uuid,bigint,text,text)'
		)
	];
BEGIN
	RETURN session_user = 'emdo_api_login'
		AND pg_catalog.pg_has_role(session_user, 'emdo_app', 'USAGE')
		AND NOT pg_catalog.pg_has_role(
			session_user, 'emdo_audio_reconciliation', 'MEMBER'
		)
		AND NOT pg_catalog.pg_has_role(
			session_user, 'emdo_audio_reconciliation', 'SET'
		)
		AND current_user = 'emdo_audio_executor'
		AND pg_catalog.array_position(v_expected_app, NULL) IS NULL
		AND pg_catalog.array_position(v_expected_operator, NULL) IS NULL
		AND (
			SELECT pg_catalog.count(*) = 8
			FROM pg_catalog.pg_proc AS routine
			WHERE routine.oid = ANY (v_expected_app)
				AND routine.prosecdef = true
				AND pg_catalog.pg_get_userbyid(routine.proowner)
					= 'emdo_audio_executor'
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
					WHERE privilege.privilege_type = 'EXECUTE'
						AND privilege.grantee <>
							pg_catalog.to_regrole('emdo_app')
				)
		)
		AND (
			SELECT pg_catalog.count(*) = 3
			FROM pg_catalog.pg_proc AS routine
			WHERE routine.oid = ANY (v_expected_operator)
				AND routine.prosecdef = true
				AND pg_catalog.pg_get_userbyid(routine.proowner)
					= 'emdo_audio_reconciliation_executor'
				AND routine.proconfig @> ARRAY['row_security=on']::text[]
				AND pg_catalog.array_to_string(routine.proconfig, ',')
					LIKE '%search_path=pg_catalog, emdo%'
				AND pg_catalog.has_function_privilege(
					'emdo_audio_reconciliation', routine.oid, 'EXECUTE'
				)
				AND NOT pg_catalog.has_function_privilege(
					session_user, routine.oid, 'EXECUTE'
				)
				AND NOT EXISTS (
					SELECT 1
					FROM pg_catalog.aclexplode(COALESCE(
						routine.proacl,
						pg_catalog.acldefault('f', routine.proowner)
					)) AS privilege
					WHERE privilege.privilege_type = 'EXECUTE'
						AND privilege.grantee <> pg_catalog.to_regrole(
							'emdo_audio_reconciliation'
						)
				)
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user, 'emdo.audio_request_receipts', 'SELECT'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user, 'emdo.audio_request_receipts', 'INSERT'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user, 'emdo.audio_request_receipts', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user, 'emdo.audio_request_receipts', 'DELETE'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user, 'emdo.audio_request_receipt_operations', 'SELECT'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user, 'emdo.audio_request_receipt_operations', 'INSERT'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user, 'emdo.audio_request_receipt_operations', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user, 'emdo.audio_request_receipt_operations', 'DELETE'
		)
		AND NOT pg_catalog.has_table_privilege(
			session_user, 'emdo.audio_request_claim_outcomes', 'SELECT,INSERT,UPDATE,DELETE'
		)
		AND (
			SELECT pg_catalog.count(*) = 3
			FROM pg_catalog.pg_class AS relation
			JOIN pg_catalog.pg_namespace AS namespace
				ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname = 'emdo'
				AND relation.relname IN (
					'audio_request_receipts',
					'audio_request_receipt_operations',
					'audio_request_claim_outcomes'
				)
				AND relation.relrowsecurity
				AND relation.relforcerowsecurity
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_attribute AS attribute
			JOIN pg_catalog.pg_class AS relation
				ON relation.oid = attribute.attrelid
			JOIN pg_catalog.pg_namespace AS namespace
				ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname = 'emdo'
				AND relation.relname IN (
					'audio_request_receipts',
					'audio_request_receipt_operations'
				)
				AND attribute.attnum > 0
				AND NOT attribute.attisdropped
				AND attribute.atttypid IN ('bytea'::regtype, 'jsonb'::regtype)
		)
		AND EXISTS (
			SELECT 1
			FROM pg_catalog.pg_attribute AS attribute
			WHERE attribute.attrelid =
				'emdo.audio_request_receipt_operations'::regclass
				AND attribute.attname = 'ownership_token_hash'
				AND NOT attribute.attisdropped
		)
		AND (
			SELECT pg_catalog.count(*) = 5
			FROM pg_catalog.pg_roles AS audio_role
			WHERE audio_role.rolname IN (
				'emdo_audio_executor',
				'emdo_audio_reconciliation_executor',
				'emdo_audio_reconciliation',
				'emdo_audio_retention_executor',
				'emdo_audio_retention'
			)
				AND NOT audio_role.rolcanlogin
				AND NOT audio_role.rolinherit
				AND NOT audio_role.rolbypassrls
				AND NOT audio_role.rolsuper
				AND NOT audio_role.rolcreatedb
				AND NOT audio_role.rolcreaterole
				AND NOT audio_role.rolreplication
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_auth_members AS membership
			JOIN pg_catalog.pg_roles AS parent
				ON parent.oid = membership.roleid
			JOIN pg_catalog.pg_roles AS child
				ON child.oid = membership.member
			WHERE parent.rolname IN (
				'emdo_audio_executor',
				'emdo_audio_reconciliation_executor',
				'emdo_audio_retention_executor'
			) OR child.rolname IN (
				'emdo_audio_executor',
				'emdo_audio_reconciliation_executor',
				'emdo_audio_reconciliation',
				'emdo_audio_retention_executor',
				'emdo_audio_retention'
			)
		);
EXCEPTION WHEN OTHERS THEN
	RETURN false;
END
$function$;
--> statement-breakpoint
ALTER TABLE "emdo"."audio_request_receipts" OWNER TO emdo_audio_executor;
ALTER TABLE "emdo"."audio_request_receipt_operations" OWNER TO emdo_audio_executor;
ALTER TABLE "emdo"."audio_request_claim_outcomes" OWNER TO emdo_audio_executor;
ALTER FUNCTION "emdo"."is_safe_audio_claim_outcome"(jsonb)
	OWNER TO emdo_audio_executor;
ALTER FUNCTION "emdo"."audio_request_operation_hash"(text[])
	OWNER TO emdo_audio_executor;
ALTER FUNCTION "emdo"."record_audio_request_claim_outcome"(uuid, text, uuid, uuid, text, uuid, text, jsonb)
	OWNER TO emdo_audio_executor;
ALTER FUNCTION "emdo"."enforce_audio_request_receipt_transition"()
	OWNER TO emdo_audio_executor;
ALTER FUNCTION "emdo"."reject_audio_request_operation_mutation"()
	OWNER TO emdo_audio_executor;
ALTER FUNCTION "emdo"."audio_request_scope_is_current"(uuid, uuid, text)
	OWNER TO emdo_audio_executor;
ALTER FUNCTION "emdo"."claim_audio_request"(uuid, text, uuid, uuid, uuid, text, text, text, bigint, text, text, integer, uuid, uuid, text)
	OWNER TO emdo_audio_executor;
ALTER FUNCTION "emdo"."complete_audio_transcription"(uuid, text, uuid, text, text, text, boolean, uuid, uuid, text)
	OWNER TO emdo_audio_executor;
ALTER FUNCTION "emdo"."complete_audio_speech"(uuid, text, uuid, text, text, text, uuid, uuid, text)
	OWNER TO emdo_audio_executor;
ALTER FUNCTION "emdo"."release_audio_request_claim"(uuid, text, uuid, text, text, uuid, uuid, text)
	OWNER TO emdo_audio_executor;
ALTER FUNCTION "emdo"."mark_audio_request_indeterminate"(uuid, text, uuid, text, text, uuid, uuid, text)
	OWNER TO emdo_audio_executor;
ALTER FUNCTION "emdo"."read_audio_request_claim"(uuid, text, uuid, text, text, text, text, bigint, text, uuid, uuid, text)
	OWNER TO emdo_audio_executor;
ALTER FUNCTION "emdo"."read_audio_request_operation"(uuid, text, uuid, text, text, uuid, uuid, text)
	OWNER TO emdo_audio_executor;
ALTER FUNCTION "emdo"."audio_request_receipts_ready"()
	OWNER TO emdo_audio_executor;
ALTER FUNCTION "emdo"."list_audio_request_reconciliation"(integer)
	OWNER TO emdo_audio_reconciliation_executor;
ALTER FUNCTION "emdo"."resolve_audio_request_reconciliation"(uuid, text, uuid, bigint, text, text)
	OWNER TO emdo_audio_reconciliation_executor;
ALTER FUNCTION "emdo"."read_audio_request_reconciliation_operation"(uuid, text, uuid, bigint, text, text)
	OWNER TO emdo_audio_reconciliation_executor;
ALTER FUNCTION "emdo"."audio_request_reconciliation_ready"()
	OWNER TO emdo_audio_reconciliation_executor;
ALTER FUNCTION "emdo"."purge_expired_audio_request_receipts"(integer)
	OWNER TO emdo_audio_retention_executor;
--> statement-breakpoint
REVOKE ALL ON TABLE "emdo"."audio_request_receipts",
	"emdo"."audio_request_receipt_operations",
	"emdo"."audio_request_claim_outcomes"
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_audio_reconciliation,
	emdo_audio_reconciliation_executor, emdo_audio_retention,
	emdo_audio_retention_executor;
GRANT SELECT, INSERT, UPDATE ON "emdo"."audio_request_receipts"
	TO emdo_audio_executor;
GRANT SELECT, INSERT ON "emdo"."audio_request_receipt_operations"
	TO emdo_audio_executor;
GRANT SELECT, INSERT ON "emdo"."audio_request_claim_outcomes"
	TO emdo_audio_executor;
GRANT SELECT, UPDATE ON "emdo"."audio_request_receipts"
	TO emdo_audio_reconciliation_executor;
GRANT SELECT, INSERT ON "emdo"."audio_request_receipt_operations"
	TO emdo_audio_reconciliation_executor;
GRANT SELECT, DELETE ON "emdo"."audio_request_receipts",
	"emdo"."audio_request_receipt_operations",
	"emdo"."audio_request_claim_outcomes" TO emdo_audio_retention_executor;
GRANT USAGE ON SCHEMA "emdo"
	TO emdo_audio_executor, emdo_audio_reconciliation,
	emdo_audio_reconciliation_executor, emdo_audio_retention,
	emdo_audio_retention_executor;
GRANT SELECT ON "emdo"."space_access_grants",
	"emdo"."household_memberships" TO emdo_audio_executor;
GRANT EXECUTE ON FUNCTION "emdo"."lock_active_request_scope"(uuid, uuid, uuid)
	TO emdo_audio_executor;
GRANT EXECUTE ON FUNCTION "emdo"."current_user_id"(),
	"emdo"."current_session_id"(), "emdo"."current_request_id"()
	TO emdo_audio_executor;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
	"emdo"."enforce_audio_request_receipt_transition"(),
	"emdo"."reject_audio_request_operation_mutation"(),
	"emdo"."is_safe_audio_claim_outcome"(jsonb),
	"emdo"."audio_request_operation_hash"(text[]),
	"emdo"."record_audio_request_claim_outcome"(uuid, text, uuid, uuid, text, uuid, text, jsonb),
	"emdo"."audio_request_scope_is_current"(uuid, uuid, text),
	"emdo"."claim_audio_request"(uuid, text, uuid, uuid, uuid, text, text, text, bigint, text, text, integer, uuid, uuid, text),
	"emdo"."complete_audio_transcription"(uuid, text, uuid, text, text, text, boolean, uuid, uuid, text),
	"emdo"."complete_audio_speech"(uuid, text, uuid, text, text, text, uuid, uuid, text),
	"emdo"."release_audio_request_claim"(uuid, text, uuid, text, text, uuid, uuid, text),
	"emdo"."mark_audio_request_indeterminate"(uuid, text, uuid, text, text, uuid, uuid, text),
	"emdo"."read_audio_request_claim"(uuid, text, uuid, text, text, text, text, bigint, text, uuid, uuid, text),
	"emdo"."read_audio_request_operation"(uuid, text, uuid, text, text, uuid, uuid, text),
	"emdo"."list_audio_request_reconciliation"(integer),
	"emdo"."resolve_audio_request_reconciliation"(uuid, text, uuid, bigint, text, text),
	"emdo"."read_audio_request_reconciliation_operation"(uuid, text, uuid, bigint, text, text),
	"emdo"."audio_request_reconciliation_ready"(),
	"emdo"."purge_expired_audio_request_receipts"(integer),
	"emdo"."audio_request_receipts_ready"()
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_audio_executor, emdo_audio_reconciliation,
	emdo_audio_reconciliation_executor, emdo_audio_retention,
	emdo_audio_retention_executor;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
	"emdo"."claim_audio_request"(uuid, text, uuid, uuid, uuid, text, text, text, bigint, text, text, integer, uuid, uuid, text),
	"emdo"."complete_audio_transcription"(uuid, text, uuid, text, text, text, boolean, uuid, uuid, text),
	"emdo"."complete_audio_speech"(uuid, text, uuid, text, text, text, uuid, uuid, text),
	"emdo"."release_audio_request_claim"(uuid, text, uuid, text, text, uuid, uuid, text),
	"emdo"."mark_audio_request_indeterminate"(uuid, text, uuid, text, text, uuid, uuid, text),
	"emdo"."read_audio_request_claim"(uuid, text, uuid, text, text, text, text, bigint, text, uuid, uuid, text),
	"emdo"."read_audio_request_operation"(uuid, text, uuid, text, text, uuid, uuid, text)
	TO emdo_app;
GRANT EXECUTE ON FUNCTION "emdo"."audio_request_receipts_ready"()
	TO emdo_app;
GRANT EXECUTE ON FUNCTION "emdo"."audio_request_scope_is_current"(uuid, uuid, text)
	TO emdo_audio_executor;
GRANT EXECUTE ON FUNCTION "emdo"."is_safe_audio_claim_outcome"(jsonb),
	"emdo"."audio_request_operation_hash"(text[]),
	"emdo"."record_audio_request_claim_outcome"(uuid, text, uuid, uuid, text, uuid, text, jsonb)
	TO emdo_audio_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."list_audio_request_reconciliation"(integer),
	"emdo"."resolve_audio_request_reconciliation"(uuid, text, uuid, bigint, text, text),
	"emdo"."read_audio_request_reconciliation_operation"(uuid, text, uuid, bigint, text, text),
	"emdo"."audio_request_reconciliation_ready"()
	TO emdo_audio_reconciliation;
GRANT EXECUTE ON FUNCTION "emdo"."purge_expired_audio_request_receipts"(integer)
	TO emdo_audio_retention;
