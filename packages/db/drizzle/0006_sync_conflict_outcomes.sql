DO $roles$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_sync_revision_executor'
	) THEN
		CREATE ROLE emdo_sync_revision_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$roles$;
--> statement-breakpoint
ALTER ROLE emdo_sync_revision_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
--> statement-breakpoint
DO $membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname = 'emdo_sync_revision_executor'
			OR child.rolname = 'emdo_sync_revision_executor'
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'sync revision executor must not have role memberships';
	END IF;
END
$membership_guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."is_bounded_sync_conflict_details"(
	p_details jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
	SELECT pg_catalog.jsonb_typeof(p_details) = 'array'
		AND pg_catalog.jsonb_array_length(
			CASE
				WHEN pg_catalog.jsonb_typeof(p_details) = 'array' THEN p_details
				ELSE '[]'::jsonb
			END
		) <= 32
		AND pg_catalog.octet_length(p_details::text) <= 8192
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.jsonb_array_elements(
				CASE
					WHEN pg_catalog.jsonb_typeof(p_details) = 'array' THEN p_details
					ELSE '[]'::jsonb
				END
			) AS detail(value)
			WHERE pg_catalog.jsonb_typeof(detail.value) <> 'object'
				OR CASE
					WHEN pg_catalog.jsonb_typeof(detail.value) = 'object' THEN (
						SELECT pg_catalog.count(*)
						FROM pg_catalog.jsonb_object_keys(detail.value)
					)
					ELSE 0
				END <> 2
				OR NOT (detail.value ?& ARRAY['field', 'material'])
				OR pg_catalog.jsonb_typeof(detail.value -> 'field') <> 'string'
				OR pg_catalog.length(detail.value ->> 'field') NOT BETWEEN 1 AND 200
				OR pg_catalog.btrim(detail.value ->> 'field')
					IS DISTINCT FROM detail.value ->> 'field'
				OR detail.value ->> 'field' ~ '[[:cntrl:]]'
				OR (
					pg_catalog.jsonb_typeof(detail.value -> 'material') = 'boolean'
				) IS NOT TRUE
		)
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."sync_entity_revision_hash"(
	p_household_id uuid,
	p_space_id uuid,
	p_original_owner_user_id uuid,
	p_entity_type text,
	p_entity_id text,
	p_revision integer,
	p_payload jsonb,
	p_tombstoned boolean,
	p_actor_intent text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
	SELECT pg_catalog.encode(
		pg_catalog.sha256(
			pg_catalog.convert_to(
				pg_catalog.jsonb_build_object(
					'actorIntent', p_actor_intent,
					'entityId', p_entity_id,
					'entityType', p_entity_type,
					'hashDomain', 'emdo.sync-entity-revision.v1',
					'hashVersion', 1,
					'householdId', p_household_id::text,
					'originalOwnerUserId', p_original_owner_user_id::text,
					'payload', p_payload,
					'revision', p_revision,
					'spaceId', p_space_id::text,
					'tombstoned', p_tombstoned
				)::text,
				'UTF8'
			)
		),
		'hex'
	)
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."is_safe_sync_snapshot_payload"(
	p_payload jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
DECLARE
	v_node_count bigint;
	v_max_depth integer;
	v_has_forbidden_key boolean;
BEGIN
	IF pg_catalog.jsonb_typeof(p_payload) <> 'object'
		OR pg_catalog.octet_length(p_payload::text) NOT BETWEEN 2 AND 1048576
	THEN
		RETURN false;
	END IF;

	WITH RECURSIVE payload_nodes(node, depth) AS (
		SELECT p_payload, 0
		UNION ALL
		SELECT child.node, parent.depth + 1
		FROM payload_nodes AS parent
		CROSS JOIN LATERAL (
			SELECT entry.value AS node
			FROM pg_catalog.jsonb_each(
				CASE
					WHEN pg_catalog.jsonb_typeof(parent.node) = 'object'
						THEN parent.node
					ELSE '{}'::jsonb
				END
			) AS entry
			UNION ALL
			SELECT entry.value AS node
			FROM pg_catalog.jsonb_array_elements(
				CASE
					WHEN pg_catalog.jsonb_typeof(parent.node) = 'array'
						THEN parent.node
					ELSE '[]'::jsonb
				END
			) AS entry(value)
		) AS child
		WHERE parent.depth < 65
	), payload_stats AS (
		SELECT pg_catalog.count(*) AS node_count,
			pg_catalog.max(depth) AS max_depth
		FROM payload_nodes
	), forbidden_keys AS (
		SELECT 1
		FROM payload_nodes AS payload_node
		CROSS JOIN LATERAL pg_catalog.jsonb_object_keys(
			CASE
				WHEN pg_catalog.jsonb_typeof(payload_node.node) = 'object'
					THEN payload_node.node
				ELSE '{}'::jsonb
			END
		) AS object_key(key)
		WHERE pg_catalog.regexp_replace(
			pg_catalog.lower(object_key.key), '[^a-z0-9]', '', 'g'
		) IN (
			'accesstoken', 'apikey', 'approval', 'approvalbinding',
			'approvalbindinghash', 'approvaldecisionid', 'approvalhash',
			'approvalstate', 'approved', 'authenticatedsessionid',
			'authorization', 'authority', 'authoritybinding', 'capability',
			'capabilityfingerprint', 'capabilityid', 'clientsecret',
			'credential', 'disclosuregrantid', 'encryptedcredential',
			'encryptedpayload', 'enqueueproviderwrite', 'externaleffects',
			'externalaction', 'googlecalendarwrite', 'idtoken',
			'mayenqueueproviderwrites', 'oauth', 'passphrase', 'password',
			'permit', 'privatekey', 'providerauthoritybindinghash',
			'providergrantreference', 'provideridempotencykey',
			'providerpreconditions', 'providersdkcallid', 'providerwrite',
			'providerwritepermit', 'refreshtoken', 'requestedexternalaction',
			'secret', 'sessionid', 'token'
		)
		LIMIT 1
	)
	SELECT payload_stats.node_count, payload_stats.max_depth,
		EXISTS (SELECT 1 FROM forbidden_keys)
	INTO v_node_count, v_max_depth, v_has_forbidden_key
	FROM payload_stats;

	RETURN v_node_count <= 100000
		AND v_max_depth <= 64
		AND NOT v_has_forbidden_key;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."is_safe_sync_api_response"(
	p_request_kind text,
	p_client_id uuid,
	p_response jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, emdo
AS $function$
DECLARE
	v_item jsonb;
	v_key_count bigint;
	v_status text;
	v_code text;
	v_disposition text;
	v_seen_operation_ids text[] := ARRAY[]::text[];
BEGIN
	IF pg_catalog.jsonb_typeof(p_response) <> 'object'
		OR pg_catalog.octet_length(p_response::text) NOT BETWEEN 2 AND 2097152
		OR pg_catalog.jsonb_typeof(p_response -> 'schemaVersion') <> 'number'
		OR p_response ->> 'schemaVersion' IS DISTINCT FROM '1'
		OR pg_catalog.jsonb_typeof(p_response -> 'clientId') <> 'string'
		OR p_response ->> 'clientId' IS DISTINCT FROM p_client_id::text
	THEN
		RETURN false;
	END IF;

	SELECT pg_catalog.count(*) INTO v_key_count
	FROM pg_catalog.jsonb_object_keys(p_response);
	IF p_request_kind = 'register-client' THEN
		RETURN v_key_count = 4
			AND p_response ?& ARRAY[
				'schemaVersion', 'clientId', 'status', 'replayed'
			]
			AND pg_catalog.jsonb_typeof(p_response -> 'status') = 'string'
			AND p_response ->> 'status' = 'registered'
			AND pg_catalog.jsonb_typeof(p_response -> 'replayed') = 'boolean';
	END IF;
	IF p_request_kind <> 'apply-operations'
		OR v_key_count <> 3
		OR NOT (p_response ?& ARRAY['schemaVersion', 'clientId', 'results'])
		OR (
			CASE
				WHEN pg_catalog.jsonb_typeof(p_response -> 'results') = 'array'
					THEN pg_catalog.jsonb_array_length(p_response -> 'results') > 1000
				ELSE true
			END
		)
	THEN
		RETURN false;
	END IF;

	FOR v_item IN
		SELECT result.value
		FROM pg_catalog.jsonb_array_elements(p_response -> 'results')
			AS result(value)
	LOOP
		IF pg_catalog.jsonb_typeof(v_item) <> 'object'
			OR NOT (v_item ?& ARRAY[
				'operationId', 'status', 'conflicts', 'replayed'
			])
			OR pg_catalog.jsonb_typeof(v_item -> 'operationId') <> 'string'
			OR v_item ->> 'operationId'
				!~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
			OR v_item ->> 'operationId' = ANY(v_seen_operation_ids)
			OR pg_catalog.jsonb_typeof(v_item -> 'status') <> 'string'
			OR pg_catalog.jsonb_typeof(v_item -> 'replayed') <> 'boolean'
			OR NOT emdo.is_bounded_sync_conflict_details(v_item -> 'conflicts')
		THEN
			RETURN false;
		END IF;
		v_seen_operation_ids := pg_catalog.array_append(
			v_seen_operation_ids, v_item ->> 'operationId'
		);

		SELECT pg_catalog.count(*) INTO v_key_count
		FROM pg_catalog.jsonb_object_keys(v_item);
		v_status := v_item ->> 'status';
		IF v_status = 'applied' THEN
			IF v_key_count <> 6
				OR NOT (v_item ?& ARRAY[
					'operationId', 'status', 'revision', 'resolution',
					'conflicts', 'replayed'
				])
				OR (
					CASE
						WHEN pg_catalog.jsonb_typeof(v_item -> 'revision') = 'number'
							THEN (v_item ->> 'revision')::numeric <= 0
								OR (v_item ->> 'revision')::numeric
									<> pg_catalog.trunc(
										(v_item ->> 'revision')::numeric
									)
								OR (v_item ->> 'revision')::numeric > 9007199254740991
						ELSE true
					END
				)
				OR pg_catalog.jsonb_typeof(v_item -> 'resolution') <> 'string'
				OR v_item ->> 'resolution' NOT IN (
					'created', 'applied', 'merged', 'ignored', 'duplicate'
				)
				OR pg_catalog.jsonb_array_length(v_item -> 'conflicts') <> 0
			THEN
				RETURN false;
			END IF;
			CONTINUE;
		END IF;

		v_code := v_item ->> 'code';
		v_disposition := v_item ->> 'disposition';
		IF v_status = 'conflict' THEN
			IF v_key_count <> (
				6 + CASE
					WHEN v_item ? 'currentRevision' THEN 1 ELSE 0
				END
			)
				OR NOT (v_item ?& ARRAY[
					'operationId', 'status', 'code', 'disposition',
					'conflicts', 'replayed'
				])
				OR pg_catalog.jsonb_typeof(v_item -> 'code') <> 'string'
				OR v_code NOT IN (
					'entity-exists', 'entity-not-found', 'revision-mismatch',
					'tombstoned', 'mutation-invalid', 'repository-rejected',
					'domain-operation-invalid', 'domain-operation-unsupported',
					'base-revision-unavailable', 'base-state-mismatch',
					'material-conflict', 'idempotency-key-reused'
				)
				OR pg_catalog.jsonb_typeof(v_item -> 'disposition') <> 'string'
				OR v_disposition IS DISTINCT FROM 'terminal'
				OR (
					v_item ? 'currentRevision'
					AND CASE
						WHEN pg_catalog.jsonb_typeof(
							v_item -> 'currentRevision'
						) = 'number'
							THEN (v_item ->> 'currentRevision')::numeric <= 0
								OR (v_item ->> 'currentRevision')::numeric
									<> pg_catalog.trunc(
										(v_item ->> 'currentRevision')::numeric
									)
								OR (v_item ->> 'currentRevision')::numeric
									> 9007199254740991
						ELSE true
					END
				)
			THEN
				RETURN false;
			END IF;
			CONTINUE;
		END IF;

		IF v_status = 'blocked' THEN
			IF v_key_count <> (
				6 + CASE
					WHEN v_item ? 'dependencyOperationId' THEN 1 ELSE 0
				END
			)
				OR NOT (v_item ?& ARRAY[
					'operationId', 'status', 'code', 'disposition',
					'conflicts', 'replayed'
				])
				OR pg_catalog.jsonb_typeof(v_item -> 'code') <> 'string'
				OR v_code NOT IN (
					'authorization-revoked', 'dependency-failed',
					'dependency-cycle'
				)
				OR pg_catalog.jsonb_typeof(v_item -> 'disposition') <> 'string'
				OR v_disposition IS DISTINCT FROM 'terminal'
				OR v_item -> 'replayed' IS DISTINCT FROM 'false'::jsonb
				OR pg_catalog.jsonb_array_length(v_item -> 'conflicts') <> 0
				OR (
					v_item ? 'dependencyOperationId'
					AND (
						pg_catalog.jsonb_typeof(v_item -> 'dependencyOperationId')
							<> 'string'
						OR v_item ->> 'dependencyOperationId'
							!~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
					)
				)
			THEN
				RETURN false;
			END IF;
			CONTINUE;
		END IF;

		RETURN false;
	END LOOP;

	RETURN true;
END
$function$;
--> statement-breakpoint
ALTER TABLE "emdo"."sync_operation_receipts"
	ADD COLUMN "outcome_contract_version" smallint DEFAULT 0 NOT NULL,
	ADD COLUMN "outcome_resolution" text,
	ADD COLUMN "outcome_disposition" text,
	ADD COLUMN "conflict_details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	ADD COLUMN "compaction_after" timestamp with time zone DEFAULT 'infinity'::timestamptz NOT NULL;
ALTER TABLE "emdo"."sync_operation_receipts"
	ALTER COLUMN "outcome_contract_version" SET DEFAULT 1,
	ALTER COLUMN "compaction_after" SET DEFAULT (pg_catalog.clock_timestamp() + interval '91 days');
ALTER TABLE "emdo"."sync_operation_receipts"
	ADD CONSTRAINT sync_operation_receipts_contract_version_check CHECK (
		"outcome_contract_version" IN (0, 1)
	),
	ADD CONSTRAINT sync_operation_receipts_conflict_details_check CHECK (
		pg_catalog.jsonb_typeof("conflict_details") = 'array'
		AND pg_catalog.jsonb_array_length("conflict_details") <= 32
		AND pg_catalog.octet_length("conflict_details"::text) <= 8192
		AND "emdo"."is_bounded_sync_conflict_details"("conflict_details")
	),
	ADD CONSTRAINT sync_operation_receipts_outcome_shape_check CHECK (
		(
			"outcome_contract_version" = 0
			AND "outcome_resolution" IS NULL
			AND "outcome_disposition" IS NULL
			AND "conflict_details" = '[]'::jsonb
		)
		OR (
			"outcome_contract_version" = 1
			AND (
				(
					"outcome_status" = 'applied'
					AND "outcome_code" IS NULL
					AND "outcome_resolution" IN (
						'created', 'applied', 'merged', 'ignored', 'duplicate'
					)
					AND "outcome_disposition" IS NULL
					AND "conflict_details" = '[]'::jsonb
					AND "resulting_revision" > 0
					AND (
						"current_revision" IS NULL OR "current_revision" > 0
					)
				)
				OR (
					"outcome_status" = 'conflict'
					AND "outcome_code" IN (
						'entity-exists', 'entity-not-found', 'revision-mismatch',
						'tombstoned', 'mutation-invalid', 'repository-rejected',
						'domain-operation-invalid',
						'domain-operation-unsupported',
						'base-revision-unavailable', 'base-state-mismatch',
						'material-conflict'
					)
					AND "outcome_resolution" IS NULL
					AND "outcome_disposition" = 'terminal'
					AND "resulting_revision" IS NULL
					AND (
						"current_revision" IS NULL OR "current_revision" > 0
					)
				)
			)
		)
	),
	ADD CONSTRAINT sync_operation_receipts_compaction_check CHECK (
		(
			"outcome_contract_version" = 0
			AND "compaction_after" = 'infinity'::timestamptz
		)
		OR (
			"outcome_contract_version" = 1
			AND "compaction_after" >= "retain_until"
			AND "compaction_after" <= "recorded_at" + interval '365 days'
		)
	);
--> statement-breakpoint
CREATE TABLE "emdo"."sync_entity_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"original_owner_user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"revision" integer NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"tombstoned" boolean NOT NULL,
	"actor_intent" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	"compaction_after" timestamp with time zone NOT NULL,
	"compaction_policy" text NOT NULL,
	CONSTRAINT sync_entity_revisions_scope_revision_unique
		UNIQUE("household_id","space_id","entity_type","entity_id","revision"),
	CONSTRAINT sync_entity_revisions_revision_positive CHECK ("revision" > 0),
	CONSTRAINT sync_entity_revisions_entity_type_check CHECK (
		"entity_type" IN (
			'conversation.event', 'scheduler.item', 'scheduler.task',
			'scheduler.reminder', 'scheduler.chore', 'scheduler.routine',
			'finance.account', 'finance.transaction', 'finance.category',
			'finance.budget', 'finance.bill', 'finance.subscription',
			'finance.goal', 'shopping.list', 'shopping.item',
			'shopping.preference'
		)
	),
	CONSTRAINT sync_entity_revisions_entity_id_check CHECK (
		pg_catalog.length("entity_id") BETWEEN 1 AND 512
		AND "entity_id" !~ '[[:cntrl:]]'
	),
	CONSTRAINT sync_entity_revisions_actor_intent_check CHECK (
		pg_catalog.length("actor_intent") BETWEEN 3 AND 1000
		AND pg_catalog.btrim("actor_intent") = "actor_intent"
	),
	CONSTRAINT sync_entity_revisions_payload_size_check CHECK (
		pg_catalog.octet_length("payload"::text) BETWEEN 2 AND 1048576
	),
	CONSTRAINT sync_entity_revisions_payload_safety_check CHECK (
		"emdo"."is_safe_sync_snapshot_payload"("payload")
	),
	CONSTRAINT sync_entity_revisions_payload_hash_check CHECK (
		"payload_hash" ~ '^[a-f0-9]{64}$'
		AND "payload_hash" = "emdo"."sync_entity_revision_hash"(
			"household_id", "space_id", "original_owner_user_id",
			"entity_type", "entity_id", "revision", "payload",
			"tombstoned", "actor_intent"
		)
	),
	CONSTRAINT sync_entity_revisions_retention_check CHECK (
		"retain_until" > "recorded_at"
		AND "retain_until" <= "recorded_at" + interval '365 days'
		AND "compaction_after" = "retain_until"
	),
	CONSTRAINT sync_entity_revisions_compaction_policy_check CHECK (
		"compaction_policy" = 'manual-review-required'
	),
	CONSTRAINT sync_entity_revisions_household_space_fk
		FOREIGN KEY ("household_id", "space_id")
		REFERENCES "emdo"."spaces"("household_id", "id")
		ON DELETE restrict ON UPDATE restrict,
	CONSTRAINT sync_entity_revisions_owner_membership_fk
		FOREIGN KEY ("household_id", "original_owner_user_id")
		REFERENCES "emdo"."household_memberships"("household_id", "user_id")
		ON DELETE restrict ON UPDATE restrict
);
CREATE INDEX sync_entity_revisions_household_space_idx
	ON "emdo"."sync_entity_revisions" USING btree
	("household_id", "space_id", "entity_type", "entity_id", "revision");
CREATE INDEX sync_entity_revisions_compaction_idx
	ON "emdo"."sync_entity_revisions" USING btree
	("compaction_policy", "compaction_after");
--> statement-breakpoint
CREATE TABLE "emdo"."sync_api_request_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"request_kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"initial_request_id" uuid NOT NULL,
	"latest_request_id" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"response" jsonb,
	"recorded_at" timestamp with time zone
		DEFAULT pg_catalog.statement_timestamp() NOT NULL,
	"completed_at" timestamp with time zone,
	"retain_until" timestamp with time zone
		DEFAULT (pg_catalog.statement_timestamp() + interval '90 days') NOT NULL,
	"compaction_after" timestamp with time zone
		DEFAULT (pg_catalog.statement_timestamp() + interval '91 days') NOT NULL,
	"compaction_policy" text DEFAULT 'manual-review-required' NOT NULL,
	CONSTRAINT sync_api_request_receipts_scope_key_unique
		UNIQUE("household_id","user_id","client_id","request_kind","idempotency_key"),
	CONSTRAINT sync_api_request_receipts_kind_check CHECK (
		"request_kind" IN ('register-client', 'apply-operations')
	),
	CONSTRAINT sync_api_request_receipts_idempotency_key_check CHECK (
		"idempotency_key" ~ '^[A-Za-z0-9:._-]{16,200}$'
	),
	CONSTRAINT sync_api_request_receipts_fingerprint_check CHECK (
		"request_fingerprint" ~ '^[a-f0-9]{64}$'
	),
	CONSTRAINT sync_api_request_receipts_response_check CHECK (
		"response" IS NULL
		OR "emdo"."is_safe_sync_api_response"(
			"request_kind", "client_id", "response"
		)
	),
	CONSTRAINT sync_api_request_receipts_completion_check CHECK (
		(
			"response" IS NULL
			AND "completed_at" IS NULL
			AND "latest_request_id" = "initial_request_id"
		)
		OR (
			"response" IS NOT NULL
			AND "completed_at" IS NOT NULL
			AND "completed_at" >= "recorded_at"
		)
	),
	CONSTRAINT sync_api_request_receipts_retention_check CHECK (
		"retain_until" > "recorded_at"
		AND "retain_until" <= "recorded_at" + interval '90 days'
		AND "compaction_after" >= "retain_until"
		AND "compaction_after" <= "recorded_at" + interval '365 days'
	),
	CONSTRAINT sync_api_request_receipts_compaction_policy_check CHECK (
		"compaction_policy" = 'manual-review-required'
	)
);
CREATE INDEX sync_api_request_receipts_scope_recorded_idx
	ON "emdo"."sync_api_request_receipts" USING btree
	("household_id", "user_id", "client_id", "recorded_at");
CREATE INDEX sync_api_request_receipts_compaction_idx
	ON "emdo"."sync_api_request_receipts" USING btree
	("compaction_policy", "compaction_after");
--> statement-breakpoint
WITH migration_clock AS (
	SELECT pg_catalog.clock_timestamp() AS now
)
INSERT INTO "emdo"."sync_entity_revisions" (
	"household_id", "space_id", "original_owner_user_id", "entity_type",
	"entity_id", "revision", "payload_hash", "payload", "tombstoned",
	"actor_intent", "recorded_at", "retain_until", "compaction_after",
	"compaction_policy"
)
SELECT entity."household_id", entity."space_id",
	entity."original_owner_user_id", entity."entity_type", entity."entity_id",
	entity."revision", "emdo"."sync_entity_revision_hash"(
		entity."household_id", entity."space_id",
		entity."original_owner_user_id", entity."entity_type",
		entity."entity_id", entity."revision", entity."payload",
		entity."tombstoned_at" IS NOT NULL, entity."actor_intent"
	), entity."payload", entity."tombstoned_at" IS NOT NULL,
	entity."actor_intent", migration_clock.now,
	migration_clock.now + interval '365 days',
	migration_clock.now + interval '365 days', 'manual-review-required'
FROM "emdo"."sync_entities" AS entity
CROSS JOIN migration_clock;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "emdo"."capture_sync_entity_revision"()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_now timestamptz := pg_catalog.clock_timestamp();
	v_tombstoned boolean := NEW.tombstoned_at IS NOT NULL;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF NEW.payload IS NOT DISTINCT FROM OLD.payload
			AND NEW.actor_intent IS NOT DISTINCT FROM OLD.actor_intent
			AND NEW.revision IS NOT DISTINCT FROM OLD.revision
			AND NEW.tombstoned_at IS NOT DISTINCT FROM OLD.tombstoned_at
		THEN
			RETURN NEW;
		END IF;
		IF NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
			RAISE EXCEPTION USING
				ERRCODE = '55000',
				MESSAGE = 'sync entity revisions must advance exactly once';
		END IF;
	END IF;
	IF NOT emdo.is_safe_sync_snapshot_payload(NEW.payload) THEN
		RAISE EXCEPTION USING
			ERRCODE = '22023',
			MESSAGE = 'sync entity payload cannot contain authority or secrets';
	END IF;

	INSERT INTO emdo.sync_entity_revisions (
		household_id, space_id, original_owner_user_id, entity_type,
		entity_id, revision, payload_hash, payload, tombstoned, actor_intent,
		recorded_at, retain_until, compaction_after, compaction_policy
	) VALUES (
		NEW.household_id, NEW.space_id, NEW.original_owner_user_id,
		NEW.entity_type, NEW.entity_id, NEW.revision,
		emdo.sync_entity_revision_hash(
			NEW.household_id, NEW.space_id, NEW.original_owner_user_id,
			NEW.entity_type, NEW.entity_id, NEW.revision, NEW.payload,
			v_tombstoned, NEW.actor_intent
		), NEW.payload, v_tombstoned, NEW.actor_intent, v_now,
		v_now + interval '365 days', v_now + interval '365 days',
		'manual-review-required'
	);
	RETURN NEW;
END
$function$;
CREATE OR REPLACE FUNCTION "emdo"."complete_sync_api_request_receipt"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
	IF OLD.response IS NOT NULL
		OR NEW.response IS NULL
		OR OLD.completed_at IS NOT NULL
		OR NEW.completed_at IS NULL
		OR NEW.completed_at < OLD.recorded_at
		OR (pg_catalog.to_jsonb(NEW)
			- 'latest_request_id' - 'response' - 'completed_at')
			IS DISTINCT FROM
			(pg_catalog.to_jsonb(OLD)
				- 'latest_request_id' - 'response' - 'completed_at')
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'sync API request receipt can only complete once';
	END IF;
	RETURN NEW;
END
$function$;
ALTER FUNCTION "emdo"."capture_sync_entity_revision"()
	OWNER TO emdo_sync_revision_executor;
ALTER FUNCTION "emdo"."complete_sync_api_request_receipt"()
	OWNER TO emdo_sync_revision_executor;
ALTER FUNCTION "emdo"."sync_entity_revision_hash"(
	uuid, uuid, uuid, text, text, integer, jsonb, boolean, text
) OWNER TO emdo_sync_revision_executor;
ALTER FUNCTION "emdo"."is_safe_sync_snapshot_payload"(jsonb)
	OWNER TO emdo_sync_revision_executor;
ALTER FUNCTION "emdo"."is_bounded_sync_conflict_details"(jsonb)
	OWNER TO emdo_sync_revision_executor;
ALTER FUNCTION "emdo"."is_safe_sync_api_response"(text, uuid, jsonb)
	OWNER TO emdo_sync_revision_executor;
--> statement-breakpoint
CREATE TRIGGER sync_entities_capture_revision
AFTER INSERT OR UPDATE OF "payload", "actor_intent", "revision", "tombstoned_at" ON "emdo"."sync_entities"
FOR EACH ROW EXECUTE FUNCTION "emdo"."capture_sync_entity_revision"();
CREATE TRIGGER sync_entity_revisions_append_only
BEFORE UPDATE OR DELETE ON "emdo"."sync_entity_revisions"
FOR EACH ROW EXECUTE FUNCTION "emdo"."reject_append_only_mutation"();
CREATE TRIGGER sync_api_request_receipts_complete_once
BEFORE UPDATE ON "emdo"."sync_api_request_receipts"
FOR EACH ROW EXECUTE FUNCTION "emdo"."complete_sync_api_request_receipt"();
CREATE TRIGGER sync_api_request_receipts_delete_forbidden
BEFORE DELETE ON "emdo"."sync_api_request_receipts"
FOR EACH ROW EXECUTE FUNCTION "emdo"."reject_append_only_mutation"();
--> statement-breakpoint
ALTER TABLE "emdo"."sync_entity_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."sync_entity_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."sync_api_request_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emdo"."sync_api_request_receipts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sync_entity_revisions_app_read
ON "emdo"."sync_entity_revisions"
FOR SELECT TO emdo_app
USING (
	"emdo"."is_active_request_scope"("household_id", "space_id", NULL)
);
CREATE POLICY sync_entity_revisions_executor_insert
ON "emdo"."sync_entity_revisions"
FOR INSERT TO emdo_sync_revision_executor
WITH CHECK (true);
CREATE POLICY sync_api_request_receipts_app_scope
ON "emdo"."sync_api_request_receipts"
FOR SELECT TO emdo_app
USING (
	"user_id" = "emdo"."current_user_id"()
	AND "emdo"."is_active_request_scope"(
		"household_id", NULL,
		CASE WHEN "request_kind" = 'apply-operations' THEN "client_id" END
	)
);
CREATE POLICY sync_api_request_receipts_app_insert_pending
ON "emdo"."sync_api_request_receipts"
FOR INSERT TO emdo_app
WITH CHECK (
	"user_id" = "emdo"."current_user_id"()
	AND "emdo"."is_active_request_scope"(
		"household_id", NULL,
		CASE WHEN "request_kind" = 'apply-operations' THEN "client_id" END
	)
	AND "initial_request_id" = "emdo"."current_request_id"()
	AND "latest_request_id" = "emdo"."current_request_id"()
	AND "response" IS NULL
	AND "completed_at" IS NULL
);
CREATE POLICY sync_api_request_receipts_app_complete
ON "emdo"."sync_api_request_receipts"
FOR UPDATE TO emdo_app
USING (
	"user_id" = "emdo"."current_user_id"()
	AND "emdo"."is_active_request_scope"(
		"household_id", NULL,
		CASE WHEN "request_kind" = 'apply-operations' THEN "client_id" END
	)
)
WITH CHECK (
	"user_id" = "emdo"."current_user_id"()
	AND "emdo"."is_active_request_scope"(
		"household_id", NULL,
		CASE WHEN "request_kind" = 'apply-operations' THEN "client_id" END
	)
	AND "latest_request_id" = "emdo"."current_request_id"()
);
--> statement-breakpoint
REVOKE ALL ON "emdo"."sync_entity_revisions",
	"emdo"."sync_api_request_receipts"
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_sync_revision_executor;
REVOKE ALL ON FUNCTION
	"emdo"."capture_sync_entity_revision"(),
	"emdo"."complete_sync_api_request_receipt"(),
	"emdo"."sync_entity_revision_hash"(
		uuid, uuid, uuid, text, text, integer, jsonb, boolean, text
	),
	"emdo"."is_safe_sync_snapshot_payload"(jsonb),
	"emdo"."is_bounded_sync_conflict_details"(jsonb),
	"emdo"."is_safe_sync_api_response"(text, uuid, jsonb)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_sync_revision_executor;
GRANT USAGE ON SCHEMA "emdo" TO emdo_sync_revision_executor;
GRANT SELECT ON "emdo"."sync_entity_revisions" TO emdo_app;
GRANT INSERT ON "emdo"."sync_entity_revisions" TO emdo_sync_revision_executor;
GRANT SELECT ON "emdo"."sync_api_request_receipts" TO emdo_app;
GRANT INSERT (
	"household_id", "user_id", "client_id", "request_kind",
	"idempotency_key", "initial_request_id", "latest_request_id",
	"request_fingerprint", "response", "recorded_at", "completed_at",
	"retain_until", "compaction_after", "compaction_policy"
) ON "emdo"."sync_api_request_receipts" TO emdo_app;
GRANT UPDATE ("latest_request_id", "response", "completed_at")
	ON "emdo"."sync_api_request_receipts" TO emdo_app;
GRANT EXECUTE ON FUNCTION
	"emdo"."sync_entity_revision_hash"(
		uuid, uuid, uuid, text, text, integer, jsonb, boolean, text
	),
	"emdo"."is_safe_sync_snapshot_payload"(jsonb),
	"emdo"."is_bounded_sync_conflict_details"(jsonb)
	TO emdo_sync_revision_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."is_bounded_sync_conflict_details"(jsonb),
	"emdo"."is_safe_sync_api_response"(text, uuid, jsonb)
	TO emdo_app;
REVOKE INSERT ON "emdo"."sync_operation_receipts" FROM emdo_app;
GRANT INSERT (
	"household_id", "space_id", "original_owner_user_id", "client_id",
	"operation_id", "fingerprint", "entity_type", "entity_id",
	"mutation_kind", "base_revision", "outcome_status", "outcome_code",
	"outcome_resolution", "outcome_disposition", "conflict_details",
	"current_revision", "resulting_revision", "recorded_at", "retain_until",
	"compaction_after"
) ON "emdo"."sync_operation_receipts" TO emdo_app;
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON "emdo"."sync_entity_revisions"
	FROM emdo_app, emdo_auth, emdo_worker, emdo_workflow, emdo_policy_reader,
	emdo_sync_revision_executor;
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON "emdo"."sync_api_request_receipts"
	FROM emdo_app, emdo_auth, emdo_worker, emdo_workflow, emdo_policy_reader,
	emdo_sync_revision_executor;
