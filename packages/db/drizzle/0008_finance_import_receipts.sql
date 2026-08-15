DO $roles$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_finance_import_executor'
	) THEN
		CREATE ROLE emdo_finance_import_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_finance_import_retention'
	) THEN
		CREATE ROLE emdo_finance_import_retention NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
	END IF;
END
$roles$;
--> statement-breakpoint
ALTER ROLE emdo_finance_import_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
ALTER ROLE emdo_finance_import_retention NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
--> statement-breakpoint
DO $membership_guard$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_auth_members AS membership
		JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
		JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
		WHERE parent.rolname IN ('emdo_finance_import_executor', 'emdo_finance_import_retention')
			OR child.rolname IN ('emdo_finance_import_executor', 'emdo_finance_import_retention')
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'finance import executor roles must not have role memberships';
	END IF;
END
$membership_guard$;
--> statement-breakpoint
CREATE TABLE emdo.finance_import_plans (
	plan_id uuid PRIMARY KEY NOT NULL,
	household_id uuid NOT NULL,
	space_id uuid NOT NULL,
	owner_user_id uuid NOT NULL,
	account_id text NOT NULL,
	source_hash text NOT NULL,
	plan_hash text NOT NULL,
	canonical_plan jsonb NOT NULL,
	diagnostics jsonb NOT NULL,
	mapping_metadata jsonb NOT NULL,
	scope_fingerprint text NOT NULL,
	origin_session_id uuid NOT NULL,
	origin_request_id uuid NOT NULL,
	origin_space_access_grant_id uuid NOT NULL,
	created_at timestamptz NOT NULL,
	expires_at timestamptz NOT NULL,
	redacted_at timestamptz,
	CONSTRAINT finance_import_plans_household_space_fk
		FOREIGN KEY (household_id, space_id)
		REFERENCES emdo.spaces(household_id, id)
		ON DELETE restrict ON UPDATE restrict,
	CONSTRAINT finance_import_plans_owner_membership_fk
		FOREIGN KEY (household_id, owner_user_id)
		REFERENCES emdo.household_memberships(household_id, user_id)
		ON DELETE restrict ON UPDATE restrict,
	CONSTRAINT finance_import_plans_source_hash_check
		CHECK (source_hash ~ '^[a-f0-9]{64}$'),
	CONSTRAINT finance_import_plans_plan_hash_check
		CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
	CONSTRAINT finance_import_plans_scope_hash_check
		CHECK (scope_fingerprint ~ '^[a-f0-9]{64}$'),
	CONSTRAINT finance_import_plans_account_id_check
		CHECK (pg_catalog.octet_length(account_id) BETWEEN 1 AND 512
			AND account_id !~ '[[:cntrl:]]'),
	CONSTRAINT finance_import_plans_expiry_check
		CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes'),
	CONSTRAINT finance_import_plans_plan_size_check
		CHECK (pg_catalog.octet_length(canonical_plan::text) BETWEEN 2 AND 1048576),
	CONSTRAINT finance_import_plans_diagnostics_size_check
		CHECK (pg_catalog.octet_length(diagnostics::text) BETWEEN 2 AND 1048576),
	CONSTRAINT finance_import_plans_mapping_size_check
		CHECK (pg_catalog.octet_length(mapping_metadata::text) BETWEEN 2 AND 4096)
);
CREATE INDEX finance_import_plans_scope_expiry_idx
	ON emdo.finance_import_plans(household_id, owner_user_id, expires_at);
CREATE UNIQUE INDEX finance_import_plans_scope_hash_unique
	ON emdo.finance_import_plans(household_id, owner_user_id, plan_hash);
--> statement-breakpoint
CREATE TABLE emdo.finance_import_fingerprints (
	household_id uuid NOT NULL,
	space_id uuid NOT NULL,
	owner_user_id uuid NOT NULL,
	account_id text NOT NULL,
	fingerprint text NOT NULL,
	transaction_entity_id uuid NOT NULL,
	recorded_at timestamptz NOT NULL,
	CONSTRAINT finance_import_fingerprints_scope_primary
		PRIMARY KEY (household_id, space_id, account_id, fingerprint),
	CONSTRAINT finance_import_fingerprints_transaction_unique
		UNIQUE (transaction_entity_id),
	CONSTRAINT finance_import_fingerprints_hash_check
		CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
	CONSTRAINT finance_import_fingerprints_account_id_check
		CHECK (pg_catalog.octet_length(account_id) BETWEEN 1 AND 512
			AND account_id !~ '[[:cntrl:]]')
);
--> statement-breakpoint
CREATE TABLE emdo.finance_import_receipts (
	receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	household_id uuid NOT NULL,
	space_id uuid NOT NULL,
	owner_user_id uuid NOT NULL,
	account_id text NOT NULL,
	plan_id uuid NOT NULL,
	plan_hash text NOT NULL,
	idempotency_key text NOT NULL,
	scope_fingerprint text NOT NULL,
	origin_space_access_grant_id uuid NOT NULL,
	transaction_count integer NOT NULL,
	committed_at timestamptz NOT NULL,
	CONSTRAINT finance_import_receipts_owner_idempotency_unique
		UNIQUE (household_id, owner_user_id, idempotency_key),
	CONSTRAINT finance_import_receipts_plan_unique UNIQUE (plan_id),
	CONSTRAINT finance_import_receipts_plan_hash_check
		CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
	CONSTRAINT finance_import_receipts_scope_hash_check
		CHECK (scope_fingerprint ~ '^[a-f0-9]{64}$'),
	CONSTRAINT finance_import_receipts_account_id_check
		CHECK (pg_catalog.octet_length(account_id) BETWEEN 1 AND 512
			AND account_id !~ '[[:cntrl:]]'),
	CONSTRAINT finance_import_receipts_key_check
		CHECK (pg_catalog.length(idempotency_key) BETWEEN 16 AND 200
			AND idempotency_key ~ '^[A-Za-z0-9:._-]+$'),
	CONSTRAINT finance_import_receipts_transaction_count_check
		CHECK (transaction_count BETWEEN 1 AND 100000)
);
--> statement-breakpoint
CREATE TRIGGER finance_import_receipts_append_only
BEFORE UPDATE OR DELETE ON emdo.finance_import_receipts
FOR EACH ROW EXECUTE FUNCTION emdo.reject_append_only_mutation();
CREATE OR REPLACE FUNCTION emdo.enforce_finance_import_plan_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, emdo
AS $function$
BEGIN
	IF OLD.redacted_at IS NOT NULL
		OR NEW.redacted_at IS NULL
		OR NEW.canonical_plan IS DISTINCT FROM '{}'::jsonb
		OR NEW.diagnostics IS DISTINCT FROM '{}'::jsonb
		OR NEW.mapping_metadata IS DISTINCT FROM '{}'::jsonb
		OR (pg_catalog.to_jsonb(NEW) - 'canonical_plan' - 'diagnostics'
			- 'mapping_metadata' - 'redacted_at')
			IS DISTINCT FROM
			(pg_catalog.to_jsonb(OLD) - 'canonical_plan' - 'diagnostics'
				- 'mapping_metadata' - 'redacted_at')
		OR NOT EXISTS (
			SELECT 1 FROM emdo.finance_import_receipts AS receipt
			WHERE receipt.plan_id = OLD.plan_id
		)
	THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'finance import plan can only redact once after a receipt';
	END IF;
	RETURN NEW;
END
$function$;
CREATE TRIGGER finance_import_plans_redact_once
BEFORE UPDATE ON emdo.finance_import_plans
FOR EACH ROW EXECUTE FUNCTION emdo.enforce_finance_import_plan_transition();
--> statement-breakpoint
ALTER TABLE emdo.finance_import_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_import_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_import_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_import_fingerprints FORCE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_import_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE emdo.finance_import_receipts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY finance_import_plans_executor_scope
ON emdo.finance_import_plans
FOR ALL TO emdo_finance_import_executor
USING (true) WITH CHECK (true);
CREATE POLICY finance_import_plans_retention_delete
ON emdo.finance_import_plans
FOR DELETE TO emdo_finance_import_retention
USING (
	expires_at <= pg_catalog.clock_timestamp()
	AND NOT EXISTS (
		SELECT 1 FROM emdo.finance_import_receipts AS receipt
		WHERE receipt.plan_id = finance_import_plans.plan_id
	)
);
CREATE POLICY finance_import_plans_retention_select
ON emdo.finance_import_plans
FOR SELECT TO emdo_finance_import_retention
USING (
	expires_at <= pg_catalog.clock_timestamp()
	AND NOT EXISTS (
		SELECT 1 FROM emdo.finance_import_receipts AS receipt
		WHERE receipt.plan_id = finance_import_plans.plan_id
	)
);
CREATE POLICY finance_import_plans_retention_lock
ON emdo.finance_import_plans
FOR UPDATE TO emdo_finance_import_retention
USING (
	expires_at <= pg_catalog.clock_timestamp()
	AND NOT EXISTS (
		SELECT 1 FROM emdo.finance_import_receipts AS receipt
		WHERE receipt.plan_id = finance_import_plans.plan_id
	)
)
WITH CHECK (
	expires_at <= pg_catalog.clock_timestamp()
	AND NOT EXISTS (
		SELECT 1 FROM emdo.finance_import_receipts AS receipt
		WHERE receipt.plan_id = finance_import_plans.plan_id
	)
);
CREATE POLICY finance_import_fingerprints_executor_scope
ON emdo.finance_import_fingerprints
FOR ALL TO emdo_finance_import_executor
USING (true) WITH CHECK (true);
CREATE POLICY finance_import_receipts_executor_scope
ON emdo.finance_import_receipts
FOR ALL TO emdo_finance_import_executor
USING (true) WITH CHECK (true);
CREATE POLICY finance_import_receipts_retention_check
ON emdo.finance_import_receipts
FOR SELECT TO emdo_finance_import_retention
USING (true);
CREATE POLICY sync_entities_finance_import_executor_insert
ON emdo.sync_entities
FOR INSERT TO emdo_finance_import_executor
WITH CHECK (true);
CREATE POLICY sync_entities_finance_import_executor_select
ON emdo.sync_entities
FOR SELECT TO emdo_finance_import_executor
USING (true);
CREATE POLICY sync_entities_finance_import_executor_lock
ON emdo.sync_entities
FOR UPDATE TO emdo_finance_import_executor
USING (
	entity_type IN ('finance.account', 'finance.category', 'finance.transaction')
	AND emdo.is_active_request_scope(household_id, space_id, NULL)
)
WITH CHECK (
	entity_type IN ('finance.account', 'finance.category', 'finance.transaction')
	AND emdo.is_active_request_scope(household_id, space_id, NULL)
);
CREATE POLICY spaces_finance_import_executor_select
ON emdo.spaces
FOR SELECT TO emdo_finance_import_executor
USING (true);
CREATE POLICY spaces_finance_import_executor_lock
ON emdo.spaces
FOR UPDATE TO emdo_finance_import_executor
USING (emdo.is_active_request_scope(household_id, id, NULL))
WITH CHECK (emdo.is_active_request_scope(household_id, id, NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.is_bounded_finance_import_metadata(
	p_metadata jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
	SELECT COALESCE(
		pg_catalog.jsonb_typeof(p_metadata) = 'object'
		AND pg_catalog.octet_length(p_metadata::text) <= 4096
		AND p_metadata ?& ARRAY['format', 'hasDefaultCategory']
		AND (p_metadata - 'format' - 'dateFormat' - 'fields'
			- 'hasDefaultCategory') = '{}'::jsonb
		AND pg_catalog.jsonb_typeof(p_metadata -> 'format') = 'string'
		AND p_metadata ->> 'format' IN ('csv', 'ofx')
		AND pg_catalog.jsonb_typeof(p_metadata -> 'hasDefaultCategory') = 'boolean'
		AND (
			(p_metadata ->> 'format' = 'ofx'
				AND NOT p_metadata ? 'dateFormat' AND NOT p_metadata ? 'fields')
			OR (
				p_metadata ->> 'format' = 'csv'
				AND p_metadata ?& ARRAY['format', 'dateFormat', 'fields', 'hasDefaultCategory']
				AND p_metadata ->> 'dateFormat' IN (
					'yyyy-mm-dd', 'mm/dd/yyyy', 'dd/mm/yyyy'
				)
				AND pg_catalog.jsonb_typeof(p_metadata -> 'fields') = 'object'
				AND p_metadata -> 'fields' ?& ARRAY['postedOn', 'description', 'amount', 'debit', 'credit', 'externalId', 'categoryId']
				AND ((p_metadata -> 'fields') - 'postedOn' - 'description' - 'amount'
					- 'debit' - 'credit' - 'externalId' - 'categoryId') = '{}'::jsonb
				AND NOT EXISTS (
					SELECT 1 FROM pg_catalog.jsonb_each(p_metadata -> 'fields') AS entry(key, value)
					WHERE pg_catalog.jsonb_typeof(entry.value) <> 'boolean'
				)
			)
		), false);
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.is_bounded_finance_import_diagnostics(
	p_diagnostics jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
	SELECT COALESCE(
		pg_catalog.jsonb_typeof(p_diagnostics) = 'object'
		AND pg_catalog.octet_length(p_diagnostics::text) <= 1048576
		AND p_diagnostics ?& ARRAY['rejectedRows', 'duplicateRows']
		AND (p_diagnostics - 'rejectedRows' - 'duplicateRows') = '{}'::jsonb
		AND pg_catalog.jsonb_typeof(p_diagnostics -> 'rejectedRows') = 'array'
		AND pg_catalog.jsonb_typeof(p_diagnostics -> 'duplicateRows') = 'array'
		AND pg_catalog.jsonb_array_length(p_diagnostics -> 'rejectedRows') <= 100000
		AND pg_catalog.jsonb_array_length(p_diagnostics -> 'duplicateRows') <= 100000
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.jsonb_array_elements(p_diagnostics -> 'rejectedRows') AS row(value)
			WHERE pg_catalog.jsonb_typeof(row.value) <> 'object'
				OR NOT row.value ?& ARRAY['sourceRow', 'code']
				OR (row.value - 'sourceRow' - 'code') <> '{}'::jsonb
				OR pg_catalog.jsonb_typeof(row.value -> 'sourceRow') <> 'number'
				OR row.value ->> 'sourceRow' !~ '^[1-9][0-9]*$'
				OR pg_catalog.length(row.value ->> 'sourceRow') > 6
				OR pg_catalog.jsonb_typeof(row.value -> 'code') <> 'string'
				OR pg_catalog.length(row.value ->> 'code') NOT BETWEEN 1 AND 160
				OR row.value ->> 'code' ~ '[[:cntrl:]]'
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.jsonb_array_elements(p_diagnostics -> 'duplicateRows') AS row(value)
			WHERE pg_catalog.jsonb_typeof(row.value) <> 'object'
				OR NOT row.value ?& ARRAY['sourceRow', 'reason']
				OR (row.value - 'sourceRow' - 'reason') <> '{}'::jsonb
				OR pg_catalog.jsonb_typeof(row.value -> 'sourceRow') <> 'number'
				OR row.value ->> 'sourceRow' !~ '^[1-9][0-9]*$'
				OR pg_catalog.length(row.value ->> 'sourceRow') > 6
				OR row.value ->> 'reason' NOT IN ('existing', 'within-source')
		), false);
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.is_valid_finance_import_date(p_value text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
DECLARE
	v_date date;
BEGIN
	IF p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
		RETURN false;
	END IF;
	BEGIN
		v_date := p_value::date;
	EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
		RETURN false;
	END;
	RETURN pg_catalog.to_char(v_date, 'YYYY-MM-DD') = p_value;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.is_valid_finance_import_timestamp(p_value text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
DECLARE
	v_timestamp timestamptz;
BEGIN
	IF p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' THEN
		RETURN false;
	END IF;
	BEGIN
		v_timestamp := p_value::timestamptz;
	EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
		RETURN false;
	END;
	RETURN pg_catalog.to_char(
		v_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
	) = p_value;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.is_valid_finance_import_plan(
	p_plan jsonb,
	p_plan_id uuid,
	p_source_hash text,
	p_plan_hash text,
	p_account_id text,
	p_space_id uuid,
	p_owner_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
DECLARE
	v_transaction jsonb;
	v_ids text[] := ARRAY[]::text[];
	v_fingerprints text[] := ARRAY[]::text[];
	v_expected_fingerprint text;
BEGIN
	IF pg_catalog.jsonb_typeof(p_plan) <> 'object'
		OR pg_catalog.octet_length(p_plan::text) > 1048576
		OR NOT p_plan ?& ARRAY['schemaVersion', 'planId', 'idempotencyKey',
			'sourceHash', 'createdAt', 'accountId', 'spaceId', 'ownerUserId',
			'transactionCount', 'rejectedRowCount', 'duplicateRowCount',
			'transactions', 'planHash']
		OR (p_plan - 'schemaVersion' - 'planId' - 'idempotencyKey'
			- 'sourceHash' - 'createdAt' - 'accountId' - 'spaceId'
			- 'ownerUserId' - 'transactionCount' - 'rejectedRowCount'
			- 'duplicateRowCount' - 'transactions' - 'planHash') <> '{}'::jsonb
		OR pg_catalog.jsonb_typeof(p_plan -> 'schemaVersion') <> 'number'
		OR pg_catalog.jsonb_typeof(p_plan -> 'planId') <> 'string'
		OR pg_catalog.jsonb_typeof(p_plan -> 'idempotencyKey') <> 'string'
		OR pg_catalog.jsonb_typeof(p_plan -> 'sourceHash') <> 'string'
		OR pg_catalog.jsonb_typeof(p_plan -> 'planHash') <> 'string'
		OR pg_catalog.jsonb_typeof(p_plan -> 'createdAt') <> 'string'
		OR pg_catalog.jsonb_typeof(p_plan -> 'accountId') <> 'string'
		OR pg_catalog.jsonb_typeof(p_plan -> 'spaceId') <> 'string'
		OR pg_catalog.jsonb_typeof(p_plan -> 'ownerUserId') <> 'string'
		OR p_plan ->> 'schemaVersion' <> '1'
		OR p_plan ->> 'planId' IS DISTINCT FROM p_plan_id::text
		OR p_plan ->> 'sourceHash' IS DISTINCT FROM p_source_hash
		OR p_plan ->> 'planHash' IS DISTINCT FROM p_plan_hash
		OR p_plan ->> 'accountId' IS DISTINCT FROM p_account_id
		OR pg_catalog.octet_length(p_plan ->> 'accountId') NOT BETWEEN 1 AND 512
		OR p_plan ->> 'accountId' ~ '[[:cntrl:]]'
		OR p_plan ->> 'spaceId' IS DISTINCT FROM p_space_id::text
		OR p_plan ->> 'ownerUserId' IS DISTINCT FROM p_owner_user_id::text
		OR p_plan ->> 'planHash' IS DISTINCT FROM emdo.canonical_json_hash(p_plan - 'planHash')
		OR p_plan ->> 'idempotencyKey' !~ '^[A-Za-z0-9:._-]{16,200}$'
		OR NOT emdo.is_valid_finance_import_timestamp(p_plan ->> 'createdAt')
		OR pg_catalog.jsonb_typeof(p_plan -> 'transactions') <> 'array'
		OR pg_catalog.jsonb_typeof(p_plan -> 'transactionCount') <> 'number'
		OR pg_catalog.jsonb_typeof(p_plan -> 'rejectedRowCount') <> 'number'
		OR pg_catalog.jsonb_typeof(p_plan -> 'duplicateRowCount') <> 'number'
		OR (p_plan ->> 'transactionCount') !~ '^[1-9][0-9]*$'
		OR (p_plan ->> 'rejectedRowCount') !~ '^[0-9]+$'
		OR (p_plan ->> 'duplicateRowCount') !~ '^[0-9]+$'
		OR pg_catalog.length(p_plan ->> 'transactionCount') > 6
		OR pg_catalog.length(p_plan ->> 'rejectedRowCount') > 6
		OR pg_catalog.length(p_plan ->> 'duplicateRowCount') > 6
		OR (p_plan ->> 'transactionCount')::integer <> pg_catalog.jsonb_array_length(p_plan -> 'transactions')
		OR pg_catalog.jsonb_array_length(p_plan -> 'transactions') NOT BETWEEN 1 AND 100000
	THEN
		RETURN false;
	END IF;

	FOR v_transaction IN SELECT value FROM pg_catalog.jsonb_array_elements(p_plan -> 'transactions') AS transaction(value)
	LOOP
		IF pg_catalog.jsonb_typeof(v_transaction) <> 'object'
			OR NOT v_transaction ?& ARRAY['schemaVersion', 'id', 'spaceId', 'ownerUserId',
				'createdAt', 'updatedAt', 'recordType', 'accountId', 'categoryId',
				'postedOn', 'description', 'currency', 'originalAmountCadMinor',
				'effectiveAmountCadMinor', 'adjustments', 'reversal', 'appliedOperationIds', 'source']
			OR (v_transaction - 'schemaVersion' - 'id' - 'spaceId' - 'ownerUserId'
				- 'createdAt' - 'updatedAt' - 'recordType' - 'accountId'
				- 'categoryId' - 'postedOn' - 'description' - 'currency'
				- 'originalAmountCadMinor' - 'effectiveAmountCadMinor'
				- 'adjustments' - 'reversal' - 'appliedOperationIds' - 'source') <> '{}'::jsonb
			OR pg_catalog.jsonb_typeof(v_transaction -> 'schemaVersion') <> 'number'
			OR pg_catalog.jsonb_typeof(v_transaction -> 'id') <> 'string'
			OR pg_catalog.jsonb_typeof(v_transaction -> 'spaceId') <> 'string'
			OR pg_catalog.jsonb_typeof(v_transaction -> 'ownerUserId') <> 'string'
			OR pg_catalog.jsonb_typeof(v_transaction -> 'createdAt') <> 'string'
			OR pg_catalog.jsonb_typeof(v_transaction -> 'updatedAt') <> 'string'
			OR pg_catalog.jsonb_typeof(v_transaction -> 'recordType') <> 'string'
			OR pg_catalog.jsonb_typeof(v_transaction -> 'accountId') <> 'string'
			OR pg_catalog.jsonb_typeof(v_transaction -> 'postedOn') <> 'string'
			OR pg_catalog.jsonb_typeof(v_transaction -> 'currency') <> 'string'
			OR v_transaction ->> 'schemaVersion' <> '1'
			OR v_transaction ->> 'recordType' <> 'transaction'
			OR v_transaction ->> 'createdAt' IS DISTINCT FROM p_plan ->> 'createdAt'
			OR v_transaction ->> 'updatedAt' IS DISTINCT FROM p_plan ->> 'createdAt'
			OR v_transaction ->> 'spaceId' IS DISTINCT FROM p_space_id::text
			OR v_transaction ->> 'ownerUserId' IS DISTINCT FROM p_owner_user_id::text
			OR v_transaction ->> 'accountId' IS DISTINCT FROM p_account_id
			OR pg_catalog.octet_length(v_transaction ->> 'accountId') NOT BETWEEN 1 AND 512
			OR v_transaction ->> 'accountId' ~ '[[:cntrl:]]'
			OR v_transaction ->> 'currency' <> 'CAD'
			OR NOT emdo.is_valid_finance_import_date(v_transaction ->> 'postedOn')
			OR pg_catalog.jsonb_typeof(v_transaction -> 'description') <> 'string'
			OR pg_catalog.length(v_transaction ->> 'description') NOT BETWEEN 1 AND 2000
			OR pg_catalog.octet_length(v_transaction ->> 'description') > 8000
			OR pg_catalog.btrim(v_transaction ->> 'description') IS DISTINCT FROM v_transaction ->> 'description'
			OR pg_catalog.jsonb_typeof(v_transaction -> 'originalAmountCadMinor') <> 'number'
			OR pg_catalog.jsonb_typeof(v_transaction -> 'effectiveAmountCadMinor') <> 'number'
			OR v_transaction ->> 'originalAmountCadMinor' !~ '^-?[0-9]+$'
			OR v_transaction ->> 'effectiveAmountCadMinor' IS DISTINCT FROM v_transaction ->> 'originalAmountCadMinor'
			OR (v_transaction ->> 'originalAmountCadMinor')::numeric NOT BETWEEN -9007199254740991 AND 9007199254740991
			OR pg_catalog.jsonb_typeof(v_transaction -> 'adjustments') <> 'array'
			OR pg_catalog.jsonb_array_length(v_transaction -> 'adjustments') <> 0
			OR v_transaction -> 'reversal' <> 'null'::jsonb
			OR pg_catalog.jsonb_typeof(v_transaction -> 'appliedOperationIds') <> 'array'
			OR pg_catalog.jsonb_array_length(v_transaction -> 'appliedOperationIds') <> 0
			OR pg_catalog.jsonb_typeof(v_transaction -> 'source') <> 'object'
			OR NOT (v_transaction -> 'source') ?& ARRAY['kind', 'sourceHash', 'sourceRow', 'fingerprint', 'externalId']
			OR ((v_transaction -> 'source') - 'kind' - 'sourceHash' - 'sourceRow'
				- 'fingerprint' - 'externalId') <> '{}'::jsonb
			OR pg_catalog.jsonb_typeof(v_transaction -> 'source' -> 'kind') <> 'string'
			OR pg_catalog.jsonb_typeof(v_transaction -> 'source' -> 'sourceHash') <> 'string'
			OR pg_catalog.jsonb_typeof(v_transaction -> 'source' -> 'fingerprint') <> 'string'
			OR v_transaction -> 'source' ->> 'kind' <> 'import'
			OR v_transaction -> 'source' ->> 'sourceHash' IS DISTINCT FROM p_source_hash
			OR v_transaction -> 'source' ->> 'fingerprint' !~ '^[a-f0-9]{64}$'
			OR pg_catalog.jsonb_typeof(v_transaction -> 'source' -> 'sourceRow') <> 'number'
			OR v_transaction -> 'source' ->> 'sourceRow' !~ '^[1-9][0-9]*$'
			OR pg_catalog.length(v_transaction -> 'source' ->> 'sourceRow') > 6
			OR (v_transaction -> 'source' ->> 'sourceRow')::integer NOT BETWEEN 1 AND 100000
			OR (pg_catalog.jsonb_typeof(v_transaction -> 'source' -> 'externalId') NOT IN ('string', 'null'))
			OR (pg_catalog.jsonb_typeof(v_transaction -> 'source' -> 'externalId') = 'string'
				AND (pg_catalog.length(v_transaction -> 'source' ->> 'externalId') NOT BETWEEN 1 AND 512
					OR pg_catalog.octet_length(v_transaction -> 'source' ->> 'externalId') > 512
					OR v_transaction -> 'source' ->> 'externalId' ~ '[[:cntrl:]]'
					OR pg_catalog.btrim(v_transaction -> 'source' ->> 'externalId') IS DISTINCT FROM v_transaction -> 'source' ->> 'externalId'))
			OR (pg_catalog.jsonb_typeof(v_transaction -> 'categoryId') NOT IN ('string', 'null'))
			OR (pg_catalog.jsonb_typeof(v_transaction -> 'categoryId') = 'string'
				AND (pg_catalog.octet_length(v_transaction ->> 'categoryId') NOT BETWEEN 1 AND 512
					OR v_transaction ->> 'categoryId' ~ '[[:cntrl:]]'))
		THEN
			RETURN false;
		END IF;
		v_expected_fingerprint := CASE
			WHEN v_transaction -> 'source' -> 'externalId' = 'null'::jsonb THEN
				emdo.canonical_json_hash(pg_catalog.jsonb_build_array(
					'finance-import-fingerprint-v2', 'derived', p_space_id::text,
					p_owner_user_id::text, p_account_id, v_transaction ->> 'postedOn',
					v_transaction ->> 'originalAmountCadMinor', v_transaction ->> 'description'
				))
			ELSE emdo.canonical_json_hash(pg_catalog.jsonb_build_array(
				'finance-import-fingerprint-v2', 'external-id', p_space_id::text,
				p_owner_user_id::text, p_account_id, v_transaction -> 'source' ->> 'externalId'
			))
		END;
		IF v_transaction -> 'source' ->> 'fingerprint' IS DISTINCT FROM v_expected_fingerprint
			OR v_transaction ->> 'id' IS DISTINCT FROM
				'finance-import-' || pg_catalog.left(v_expected_fingerprint, 40)
		THEN
			RETURN false;
		END IF;
		v_ids := v_ids || (v_transaction ->> 'id');
		v_fingerprints := v_fingerprints || (v_transaction -> 'source' ->> 'fingerprint');
	END LOOP;
	RETURN pg_catalog.cardinality(v_ids) = (
		SELECT pg_catalog.count(DISTINCT entry) FROM pg_catalog.unnest(v_ids) AS entry
	) AND pg_catalog.cardinality(v_fingerprints) = (
		SELECT pg_catalog.count(DISTINCT entry) FROM pg_catalog.unnest(v_fingerprints) AS entry
	);
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.resolve_finance_import_scope(
	p_account_id text,
	p_household_id uuid,
	p_space_access_grant_id uuid,
	p_authorization_scope_fingerprint text,
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
	v_authority record;
	v_account record;
BEGIN
	IF p_account_id IS NULL OR p_household_id IS NULL
		OR p_authorization_scope_fingerprint !~ '^[a-f0-9]{64}$'
		OR p_role NOT IN ('owner', 'member')
		OR NOT emdo.lock_active_request_scope(p_household_id, NULL, NULL)
	THEN
		RETURN NULL;
	END IF;

	SELECT authority.* INTO v_authority
	FROM emdo.lock_current_authorization_scope(
		p_space_access_grant_id, NULL, NULL
	) AS authority;
	IF NOT FOUND
		OR v_authority.household_id IS DISTINCT FROM p_household_id
		OR v_authority.role IS DISTINCT FROM p_role
		OR v_authority.authorization_scope_fingerprint IS DISTINCT FROM
			p_authorization_scope_fingerprint
	THEN
		RETURN NULL;
	END IF;

	SELECT account.household_id, account.space_id,
		account.original_owner_user_id
	INTO v_account
	FROM emdo.sync_entities AS account
	JOIN emdo.spaces AS space
		ON space.household_id = account.household_id
		AND space.id = account.space_id
	JOIN emdo.resolve_space_access_grant(
		p_space_access_grant_id, p_household_id, v_authority.user_id,
		v_authority.session_id, v_authority.request_id, account.space_id
	) AS resolved_grant ON true
	WHERE account.household_id = p_household_id
		AND account.entity_type = 'finance.account'
		AND account.entity_id = p_account_id
		AND account.tombstoned_at IS NULL
		AND space.visibility = 'private'
		AND space.original_owner_user_id = v_authority.user_id
		AND account.original_owner_user_id = v_authority.user_id
	FOR SHARE OF account, space;
	IF NOT FOUND
		OR NOT emdo.lock_active_request_scope(
			p_household_id, v_account.space_id, NULL
		)
	THEN
		RETURN NULL;
	END IF;

	RETURN pg_catalog.jsonb_build_object(
		'accountId', p_account_id,
		'spaceId', v_account.space_id,
		'ownerUserId', v_account.original_owner_user_id,
		'scopeFingerprint', v_authority.authorization_scope_fingerprint,
		'existingFingerprints', COALESCE((
			WITH locked_fingerprints AS (
				SELECT fingerprint
				FROM emdo.finance_import_fingerprints
				WHERE household_id = p_household_id
					AND space_id = v_account.space_id
					AND owner_user_id = v_account.original_owner_user_id
					AND account_id = p_account_id
				FOR SHARE
			)
			SELECT pg_catalog.jsonb_agg(fingerprint ORDER BY fingerprint)
			FROM locked_fingerprints
		), '[]'::jsonb)
	);
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.read_finance_import_preview_scope(
	p_account_id text,
	p_household_id uuid,
	p_space_access_grant_id uuid,
	p_authorization_scope_fingerprint text,
	p_role text
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
	SELECT emdo.resolve_finance_import_scope(
		p_account_id, p_household_id, p_space_access_grant_id,
		p_authorization_scope_fingerprint, p_role
	);
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.is_valid_finance_import_destination(
	p_payload jsonb,
	p_entity_type text,
	p_entity_id text,
	p_space_id uuid,
	p_owner_user_id uuid
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
	SELECT COALESCE(
		pg_catalog.jsonb_typeof(p_payload) = 'object'
		AND p_entity_type IN ('finance.account', 'finance.category')
		AND p_payload ?& ARRAY['schemaVersion', 'id', 'spaceId', 'ownerUserId',
			'createdAt', 'updatedAt', 'recordType', 'name', 'active']
		AND pg_catalog.jsonb_typeof(p_payload -> 'schemaVersion') = 'number'
		AND pg_catalog.jsonb_typeof(p_payload -> 'id') = 'string'
		AND pg_catalog.jsonb_typeof(p_payload -> 'spaceId') = 'string'
		AND pg_catalog.jsonb_typeof(p_payload -> 'ownerUserId') = 'string'
		AND pg_catalog.jsonb_typeof(p_payload -> 'createdAt') = 'string'
		AND pg_catalog.jsonb_typeof(p_payload -> 'updatedAt') = 'string'
		AND pg_catalog.jsonb_typeof(p_payload -> 'recordType') = 'string'
		AND pg_catalog.jsonb_typeof(p_payload -> 'name') = 'string'
		AND pg_catalog.jsonb_typeof(p_payload -> 'active') = 'boolean'
		AND p_payload ->> 'schemaVersion' = '1'
		AND p_payload ->> 'id' IS NOT DISTINCT FROM p_entity_id
		AND pg_catalog.octet_length(p_payload ->> 'id') BETWEEN 1 AND 512
		AND p_payload ->> 'id' !~ '[[:cntrl:]]'
		AND p_payload ->> 'spaceId' IS NOT DISTINCT FROM p_space_id::text
		AND p_payload ->> 'ownerUserId' IS NOT DISTINCT FROM p_owner_user_id::text
		AND emdo.is_valid_finance_import_timestamp(p_payload ->> 'createdAt')
		AND emdo.is_valid_finance_import_timestamp(p_payload ->> 'updatedAt')
		AND pg_catalog.length(p_payload ->> 'name') BETWEEN 1 AND 200
		AND pg_catalog.octet_length(p_payload ->> 'name') BETWEEN 1 AND 800
		AND p_payload ->> 'name' !~ '[[:cntrl:]]'
		AND pg_catalog.btrim(p_payload ->> 'name') IS NOT DISTINCT FROM p_payload ->> 'name'
		AND p_payload ->> 'active' = 'true'
		AND CASE p_entity_type
			WHEN 'finance.account' THEN
				p_payload ?& ARRAY['currency', 'openingBalanceCadMinor', 'accountKind', 'source']
				AND (p_payload - 'schemaVersion' - 'id' - 'spaceId' - 'ownerUserId'
					- 'createdAt' - 'updatedAt' - 'recordType' - 'name' - 'active'
					- 'currency' - 'openingBalanceCadMinor' - 'accountKind' - 'source') = '{}'::jsonb
				AND p_payload ->> 'recordType' = 'account'
				AND pg_catalog.jsonb_typeof(p_payload -> 'currency') = 'string'
				AND p_payload ->> 'currency' = 'CAD'
				AND pg_catalog.jsonb_typeof(p_payload -> 'openingBalanceCadMinor') = 'number'
				AND p_payload ->> 'openingBalanceCadMinor' ~ '^-?[0-9]+$'
				AND (p_payload ->> 'openingBalanceCadMinor')::numeric BETWEEN -9007199254740991 AND 9007199254740991
				AND pg_catalog.jsonb_typeof(p_payload -> 'accountKind') = 'string'
				AND p_payload ->> 'accountKind' IN ('cash', 'chequing', 'savings', 'credit', 'other')
				AND pg_catalog.jsonb_typeof(p_payload -> 'source') = 'string'
				AND p_payload ->> 'source' = 'manual'
			WHEN 'finance.category' THEN
				p_payload ?& ARRAY['categoryKind', 'parentCategoryId']
				AND (p_payload - 'schemaVersion' - 'id' - 'spaceId' - 'ownerUserId'
					- 'createdAt' - 'updatedAt' - 'recordType' - 'name' - 'active'
					- 'categoryKind' - 'parentCategoryId') = '{}'::jsonb
				AND p_payload ->> 'recordType' = 'category'
				AND pg_catalog.jsonb_typeof(p_payload -> 'categoryKind') = 'string'
				AND p_payload ->> 'categoryKind' IN ('income', 'expense')
				AND pg_catalog.jsonb_typeof(p_payload -> 'parentCategoryId') IN ('string', 'null')
				AND (
					p_payload -> 'parentCategoryId' = 'null'::jsonb
					OR (
						pg_catalog.octet_length(p_payload ->> 'parentCategoryId') BETWEEN 1 AND 512
						AND p_payload ->> 'parentCategoryId' !~ '[[:cntrl:]]'
					)
				)
			ELSE false
		END,
		false
	);
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.read_finance_import_destinations(
	p_household_id uuid,
	p_space_access_grant_id uuid,
	p_authorization_scope_fingerprint text,
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
	v_authority record;
	v_accounts jsonb;
	v_categories jsonb;
BEGIN
	IF p_household_id IS NULL
		OR p_authorization_scope_fingerprint !~ '^[a-f0-9]{64}$'
		OR p_role NOT IN ('owner', 'member')
		OR NOT emdo.lock_active_request_scope(p_household_id, NULL, NULL)
	THEN
		RAISE EXCEPTION USING ERRCODE = '42501',
			MESSAGE = 'emdo:authorization-revoked';
	END IF;

	SELECT authority.* INTO v_authority
	FROM emdo.lock_current_authorization_scope(
		p_space_access_grant_id, NULL, NULL
	) AS authority;
	IF NOT FOUND
		OR v_authority.household_id IS DISTINCT FROM p_household_id
		OR v_authority.role IS DISTINCT FROM p_role
		OR v_authority.authorization_scope_fingerprint IS DISTINCT FROM
			p_authorization_scope_fingerprint
		OR NOT emdo.lock_active_request_scope(
			p_household_id, v_authority.private_space_id, NULL
		)
	THEN
		RAISE EXCEPTION USING ERRCODE = '42501',
			MESSAGE = 'emdo:authorization-revoked';
	END IF;

	WITH locked_accounts AS MATERIALIZED (
		SELECT account.entity_id AS id, account.payload ->> 'name' AS name,
			account.payload ->> 'accountKind' AS account_kind
		FROM emdo.sync_entities AS account
		WHERE account.household_id = p_household_id
			AND account.space_id = v_authority.private_space_id
			AND account.original_owner_user_id = v_authority.user_id
			AND account.entity_type = 'finance.account'
			AND account.tombstoned_at IS NULL
			AND account.payload ->> 'currency' = 'CAD'
			AND account.payload ->> 'source' = 'manual'
			AND account.payload ->> 'active' = 'true'
			AND emdo.is_valid_finance_import_destination(
				account.payload, account.entity_type, account.entity_id,
				v_authority.private_space_id, v_authority.user_id
			)
		ORDER BY (account.payload ->> 'name') COLLATE "C",
			account.entity_id COLLATE "C"
		LIMIT 100
		FOR SHARE OF account
	)
	SELECT COALESCE(pg_catalog.jsonb_agg(
		pg_catalog.jsonb_build_object(
			'id', id, 'name', name, 'accountKind', account_kind
		) ORDER BY name COLLATE "C", id COLLATE "C"
	), '[]'::jsonb) INTO v_accounts
	FROM locked_accounts;

	WITH locked_categories AS MATERIALIZED (
		SELECT category.entity_id AS id, category.payload ->> 'name' AS name,
			category.payload ->> 'categoryKind' AS category_kind
		FROM emdo.sync_entities AS category
		WHERE category.household_id = p_household_id
			AND category.space_id = v_authority.private_space_id
			AND category.original_owner_user_id = v_authority.user_id
			AND category.entity_type = 'finance.category'
			AND category.tombstoned_at IS NULL
			AND category.payload ->> 'active' = 'true'
			AND emdo.is_valid_finance_import_destination(
				category.payload, category.entity_type, category.entity_id,
				v_authority.private_space_id, v_authority.user_id
			)
		ORDER BY (category.payload ->> 'name') COLLATE "C",
			category.entity_id COLLATE "C"
		LIMIT 100
		FOR SHARE OF category
	)
	SELECT COALESCE(pg_catalog.jsonb_agg(
		pg_catalog.jsonb_build_object(
			'id', id, 'name', name, 'categoryKind', category_kind
		) ORDER BY name COLLATE "C", id COLLATE "C"
	), '[]'::jsonb) INTO v_categories
	FROM locked_categories;

	RETURN pg_catalog.jsonb_build_object(
		'schemaVersion', 1, 'accounts', v_accounts, 'categories', v_categories
	);
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.persist_finance_import_plan(
	p_plan_id uuid,
	p_source_hash text,
	p_plan_hash text,
	p_canonical_plan jsonb,
	p_diagnostics jsonb,
	p_mapping_metadata jsonb,
	p_household_id uuid,
	p_space_access_grant_id uuid,
	p_authorization_scope_fingerprint text,
	p_role text,
	p_ttl_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
DECLARE
	v_scope jsonb;
	v_existing_plan emdo.finance_import_plans%ROWTYPE;
	v_now timestamptz := pg_catalog.clock_timestamp();
	v_expires_at timestamptz;
BEGIN
	IF p_plan_id IS NULL OR p_source_hash !~ '^[a-f0-9]{64}$'
		OR p_plan_hash !~ '^[a-f0-9]{64}$'
		OR p_ttl_seconds NOT BETWEEN 60 AND 1800
		OR emdo.is_bounded_finance_import_metadata(p_mapping_metadata) IS NOT TRUE
		OR emdo.is_bounded_finance_import_diagnostics(p_diagnostics) IS NOT TRUE
		OR pg_catalog.jsonb_typeof(p_canonical_plan) <> 'object'
		OR pg_catalog.octet_length(p_canonical_plan::text) > 1048576
		OR pg_catalog.length(p_canonical_plan ->> 'accountId') NOT BETWEEN 1 AND 512
		OR p_canonical_plan ->> 'accountId' ~ '[[:cntrl:]]'
	THEN
		RAISE EXCEPTION USING ERRCODE = '22023',
			MESSAGE = 'emdo:finance-import-plan-invalid';
	END IF;

	SELECT emdo.resolve_finance_import_scope(
		p_canonical_plan ->> 'accountId',
		p_household_id, p_space_access_grant_id,
		p_authorization_scope_fingerprint, p_role
	) INTO v_scope;
	IF v_scope IS NULL THEN
		RAISE EXCEPTION USING ERRCODE = '42501',
			MESSAGE = 'emdo:authorization-revoked';
	END IF;
	IF NOT emdo.is_valid_finance_import_plan(
			p_canonical_plan, p_plan_id, p_source_hash, p_plan_hash,
			v_scope ->> 'accountId', (v_scope ->> 'spaceId')::uuid,
			(v_scope ->> 'ownerUserId')::uuid
		) THEN
		RAISE EXCEPTION USING ERRCODE = '22023',
			MESSAGE = 'emdo:finance-import-plan-invalid';
	END IF;

	SELECT stored.* INTO v_existing_plan
	FROM emdo.finance_import_plans AS stored
	WHERE stored.plan_id = p_plan_id
	FOR SHARE;
	IF FOUND THEN
		IF v_existing_plan.scope_fingerprint IS DISTINCT FROM v_scope ->> 'scopeFingerprint' THEN
			RAISE EXCEPTION USING ERRCODE = '42501',
				MESSAGE = 'emdo:authorization-revoked';
		END IF;
		IF v_existing_plan.household_id IS NOT DISTINCT FROM p_household_id
			AND v_existing_plan.space_id::text IS NOT DISTINCT FROM v_scope ->> 'spaceId'
			AND v_existing_plan.owner_user_id::text IS NOT DISTINCT FROM v_scope ->> 'ownerUserId'
			AND v_existing_plan.account_id IS NOT DISTINCT FROM v_scope ->> 'accountId'
			AND v_existing_plan.source_hash IS NOT DISTINCT FROM p_source_hash
			AND v_existing_plan.plan_hash IS NOT DISTINCT FROM p_plan_hash
			AND v_existing_plan.canonical_plan IS NOT DISTINCT FROM p_canonical_plan
			AND v_existing_plan.diagnostics IS NOT DISTINCT FROM p_diagnostics
			AND v_existing_plan.mapping_metadata IS NOT DISTINCT FROM p_mapping_metadata
			AND v_existing_plan.origin_session_id IS NOT DISTINCT FROM emdo.current_session_id()
			AND v_existing_plan.origin_request_id IS NOT DISTINCT FROM emdo.current_request_id()
			AND v_existing_plan.origin_space_access_grant_id IS NOT DISTINCT FROM p_space_access_grant_id
		THEN
			RETURN pg_catalog.jsonb_build_object(
				'status', 'stored', 'planId', p_plan_id, 'expiresAt', v_existing_plan.expires_at
			);
		END IF;
		RAISE EXCEPTION USING ERRCODE = '23505',
			MESSAGE = 'emdo:finance-import-plan-id-conflict';
	END IF;
	v_expires_at := v_now + pg_catalog.make_interval(secs => p_ttl_seconds);
	INSERT INTO emdo.finance_import_plans (
		plan_id, household_id, space_id, owner_user_id, account_id,
		source_hash, plan_hash, canonical_plan, diagnostics, mapping_metadata,
		scope_fingerprint, origin_session_id, origin_request_id,
		origin_space_access_grant_id, created_at, expires_at
	) VALUES (
		p_plan_id, p_household_id, (v_scope ->> 'spaceId')::uuid,
		(v_scope ->> 'ownerUserId')::uuid, v_scope ->> 'accountId',
		p_source_hash, p_plan_hash, p_canonical_plan, p_diagnostics,
		p_mapping_metadata, v_scope ->> 'scopeFingerprint',
		emdo.current_session_id(), emdo.current_request_id(),
		p_space_access_grant_id, v_now, v_expires_at
	);
	RETURN pg_catalog.jsonb_build_object(
		'status', 'stored', 'planId', p_plan_id, 'expiresAt', v_expires_at
	);
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.commit_finance_import_plan(
	p_plan_id uuid,
	p_idempotency_key text,
	p_household_id uuid,
	p_space_access_grant_id uuid,
	p_authorization_scope_fingerprint text,
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
	v_plan emdo.finance_import_plans%ROWTYPE;
	v_scope jsonb;
	v_receipt emdo.finance_import_receipts%ROWTYPE;
	v_transaction jsonb;
	v_entity_id uuid;
	v_fingerprint text;
	v_category_id text;
	v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
	IF p_plan_id IS NULL OR p_idempotency_key IS NULL
		OR pg_catalog.length(p_idempotency_key) NOT BETWEEN 16 AND 200
		OR p_idempotency_key !~ '^[A-Za-z0-9:._-]+$'
	THEN
		RAISE EXCEPTION USING ERRCODE = '22023',
			MESSAGE = 'emdo:finance-import-plan-invalid';
	END IF;

	SELECT plan.* INTO v_plan
	FROM emdo.finance_import_plans AS plan
	WHERE plan.plan_id = p_plan_id
	FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = 'P0002',
			MESSAGE = 'emdo:finance-import-plan-not-found';
	END IF;
	SELECT emdo.resolve_finance_import_scope(
		v_plan.account_id, p_household_id, p_space_access_grant_id,
		p_authorization_scope_fingerprint, p_role
	) INTO v_scope;
	IF v_scope IS NULL
		OR v_plan.household_id IS DISTINCT FROM p_household_id
		OR v_plan.space_id::text IS DISTINCT FROM v_scope ->> 'spaceId'
		OR v_plan.owner_user_id::text IS DISTINCT FROM v_scope ->> 'ownerUserId'
		OR v_plan.scope_fingerprint IS DISTINCT FROM v_scope ->> 'scopeFingerprint'
	THEN
		RAISE EXCEPTION USING ERRCODE = '42501',
			MESSAGE = 'emdo:authorization-revoked';
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			v_plan.household_id::text || ':' || v_plan.owner_user_id::text
				|| ':' || p_idempotency_key,
			0
		)
	);
	SELECT receipt.* INTO v_receipt
	FROM emdo.finance_import_receipts AS receipt
	WHERE receipt.household_id = p_household_id
		AND receipt.owner_user_id = v_plan.owner_user_id
		AND receipt.idempotency_key = p_idempotency_key
	FOR SHARE;
	IF FOUND THEN
		IF v_receipt.plan_id = v_plan.plan_id
			AND v_receipt.plan_hash = v_plan.plan_hash
			AND v_receipt.scope_fingerprint = v_plan.scope_fingerprint
		THEN
			RETURN pg_catalog.jsonb_build_object(
				'status', 'replayed', 'receipt', pg_catalog.jsonb_build_object(
					'id', v_receipt.receipt_id, 'planId', v_receipt.plan_id,
					'transactionCount', v_receipt.transaction_count, 'verified', true
				)
			);
		END IF;
		RAISE EXCEPTION USING ERRCODE = '23505',
			MESSAGE = 'emdo:finance-import-idempotency-conflict';
	END IF;
	IF v_plan.expires_at <= v_now OR v_plan.redacted_at IS NOT NULL THEN
		RAISE EXCEPTION USING ERRCODE = '55000',
			MESSAGE = 'emdo:finance-import-plan-expired';
	END IF;
	IF NOT emdo.is_valid_finance_import_plan(
		v_plan.canonical_plan, v_plan.plan_id, v_plan.source_hash, v_plan.plan_hash,
		v_plan.account_id, v_plan.space_id, v_plan.owner_user_id
	) THEN
		RAISE EXCEPTION USING ERRCODE = '22023',
			MESSAGE = 'emdo:finance-import-plan-invalid';
	END IF;

	FOR v_category_id IN
		SELECT DISTINCT (transaction.value ->> 'categoryId') COLLATE "C" AS category_id
		FROM pg_catalog.jsonb_array_elements(v_plan.canonical_plan -> 'transactions')
			AS transaction(value)
		WHERE transaction.value -> 'categoryId' <> 'null'::jsonb
		ORDER BY category_id
	LOOP
		PERFORM 1
		FROM emdo.sync_entities AS category
		WHERE category.household_id = v_plan.household_id
			AND category.space_id = v_plan.space_id
			AND category.original_owner_user_id = v_plan.owner_user_id
			AND category.entity_type = 'finance.category'
			AND category.entity_id = v_category_id
			AND category.tombstoned_at IS NULL
		FOR SHARE;
		IF NOT FOUND THEN
			RAISE EXCEPTION USING ERRCODE = '42501',
				MESSAGE = 'emdo:finance-import-category-invalid';
		END IF;
	END LOOP;

	FOR v_transaction IN
		SELECT value FROM pg_catalog.jsonb_array_elements(
			v_plan.canonical_plan -> 'transactions'
		) AS transaction(value)
	LOOP
		v_fingerprint := v_transaction -> 'source' ->> 'fingerprint';
		IF v_fingerprint !~ '^[a-f0-9]{64}$'
			OR v_transaction ->> 'recordType' IS DISTINCT FROM 'transaction'
			OR EXISTS (
				SELECT 1 FROM emdo.sync_entities AS entity
				WHERE entity.household_id = v_plan.household_id
					AND entity.space_id = v_plan.space_id
					AND entity.entity_type = 'finance.transaction'
					AND entity.entity_id = v_transaction ->> 'id'
					AND entity.tombstoned_at IS NULL
				FOR SHARE
			)
			OR v_transaction ->> 'accountId' IS DISTINCT FROM v_plan.account_id::text
			OR v_transaction ->> 'spaceId' IS DISTINCT FROM v_plan.space_id::text
			OR v_transaction ->> 'ownerUserId' IS DISTINCT FROM v_plan.owner_user_id::text
			OR v_transaction -> 'source' ->> 'sourceHash' IS DISTINCT FROM v_plan.source_hash
			OR EXISTS (
				SELECT 1 FROM emdo.finance_import_fingerprints AS fingerprint
				WHERE fingerprint.household_id = v_plan.household_id
					AND fingerprint.space_id = v_plan.space_id
					AND fingerprint.account_id = v_plan.account_id
					AND fingerprint.fingerprint = v_fingerprint
				FOR SHARE
			)
		THEN
			RAISE EXCEPTION USING ERRCODE = '23505',
				MESSAGE = 'emdo:finance-import-duplicate-at-commit';
		END IF;
	END LOOP;

	FOR v_transaction IN
		SELECT value FROM pg_catalog.jsonb_array_elements(
			v_plan.canonical_plan -> 'transactions'
		) AS transaction(value)
	LOOP
		INSERT INTO emdo.sync_entities (
			household_id, space_id, original_owner_user_id, entity_type,
			entity_id, payload, actor_intent, revision, created_at, updated_at
		) VALUES (
			v_plan.household_id, v_plan.space_id, v_plan.owner_user_id,
			'finance.transaction', v_transaction ->> 'id', v_transaction,
			'finance import', 1, v_now, v_now
		) RETURNING id INTO v_entity_id;
		INSERT INTO emdo.finance_import_fingerprints (
			household_id, space_id, owner_user_id, account_id, fingerprint,
			transaction_entity_id, recorded_at
		) VALUES (
			v_plan.household_id, v_plan.space_id, v_plan.owner_user_id,
			v_plan.account_id, v_transaction -> 'source' ->> 'fingerprint',
			v_entity_id, v_now
		);
	END LOOP;

	INSERT INTO emdo.finance_import_receipts (
		household_id, space_id, owner_user_id, account_id, plan_id, plan_hash,
		idempotency_key, scope_fingerprint, origin_space_access_grant_id,
		transaction_count, committed_at
	) VALUES (
		v_plan.household_id, v_plan.space_id, v_plan.owner_user_id,
		v_plan.account_id, v_plan.plan_id, v_plan.plan_hash, p_idempotency_key,
		v_plan.scope_fingerprint, p_space_access_grant_id,
		pg_catalog.jsonb_array_length(v_plan.canonical_plan -> 'transactions'),
		v_now
	) RETURNING * INTO v_receipt;
	UPDATE emdo.finance_import_plans
	SET canonical_plan = '{}'::jsonb,
		diagnostics = '{}'::jsonb,
		mapping_metadata = '{}'::jsonb,
		redacted_at = v_now
	WHERE plan_id = v_plan.plan_id;

	RETURN pg_catalog.jsonb_build_object(
		'status', 'committed', 'receipt', pg_catalog.jsonb_build_object(
			'id', v_receipt.receipt_id, 'planId', v_receipt.plan_id,
			'transactionCount', v_receipt.transaction_count, 'verified', true
		)
	);
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.purge_expired_finance_import_plans(
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
	v_plan_ids uuid[];
	v_deleted integer := 0;
BEGIN
	IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
		RETURN 0;
	END IF;
	SELECT pg_catalog.array_agg(candidate.plan_id) INTO v_plan_ids
	FROM (
		SELECT plan.plan_id
		FROM emdo.finance_import_plans AS plan
		WHERE plan.expires_at <= pg_catalog.clock_timestamp()
			AND NOT EXISTS (
				SELECT 1 FROM emdo.finance_import_receipts AS receipt
				WHERE receipt.plan_id = plan.plan_id
			)
		ORDER BY plan.expires_at, plan.plan_id
		LIMIT p_limit
		FOR SHARE SKIP LOCKED
	) AS candidate;
	IF v_plan_ids IS NULL THEN
		RETURN 0;
	END IF;
	DELETE FROM emdo.finance_import_plans
	WHERE plan_id = ANY(v_plan_ids);
	GET DIAGNOSTICS v_deleted = ROW_COUNT;
	RETURN v_deleted;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION emdo.finance_imports_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
	SELECT pg_catalog.has_function_privilege(
		'emdo_app', 'emdo.read_finance_import_preview_scope(text,uuid,uuid,text,text)', 'EXECUTE'
	) AND pg_catalog.has_function_privilege(
		'emdo_app', 'emdo.read_finance_import_destinations(uuid,uuid,text,text)', 'EXECUTE'
	) AND pg_catalog.has_function_privilege(
		'emdo_app', 'emdo.persist_finance_import_plan(uuid,text,text,jsonb,jsonb,jsonb,uuid,uuid,text,text,integer)', 'EXECUTE'
	) AND pg_catalog.has_function_privilege(
		'emdo_app', 'emdo.commit_finance_import_plan(uuid,text,uuid,uuid,text,text)', 'EXECUTE'
	) AND NOT pg_catalog.has_function_privilege(
		'emdo_app', 'emdo.resolve_finance_import_scope(text,uuid,uuid,text,text)', 'EXECUTE'
	) AND NOT pg_catalog.has_function_privilege(
		'emdo_app', 'emdo.purge_expired_finance_import_plans(integer)', 'EXECUTE'
	) AND NOT pg_catalog.has_function_privilege(
		'public', 'emdo.read_finance_import_preview_scope(text,uuid,uuid,text,text)', 'EXECUTE'
	) AND NOT pg_catalog.has_function_privilege(
		'public', 'emdo.read_finance_import_destinations(uuid,uuid,text,text)', 'EXECUTE'
	) AND NOT pg_catalog.has_function_privilege(
		'public', 'emdo.persist_finance_import_plan(uuid,text,text,jsonb,jsonb,jsonb,uuid,uuid,text,text,integer)', 'EXECUTE'
	) AND NOT pg_catalog.has_function_privilege(
		'public', 'emdo.commit_finance_import_plan(uuid,text,uuid,uuid,text,text)', 'EXECUTE'
	) AND NOT pg_catalog.has_table_privilege('emdo_app', 'emdo.finance_import_plans', 'SELECT,INSERT,UPDATE,DELETE')
		AND NOT pg_catalog.has_table_privilege('emdo_app', 'emdo.finance_import_fingerprints', 'SELECT,INSERT,UPDATE,DELETE')
		AND NOT pg_catalog.has_table_privilege('emdo_app', 'emdo.finance_import_receipts', 'SELECT,INSERT,UPDATE,DELETE')
		AND pg_catalog.has_column_privilege(
			'emdo_finance_import_executor', 'emdo.sync_entities', 'updated_at', 'UPDATE'
		)
		AND pg_catalog.has_column_privilege(
			'emdo_finance_import_executor', 'emdo.spaces', 'updated_at', 'UPDATE'
		)
		AND pg_catalog.has_column_privilege(
			'emdo_finance_import_executor', 'emdo.finance_import_fingerprints',
			'recorded_at', 'UPDATE'
		)
		AND pg_catalog.has_column_privilege(
			'emdo_finance_import_executor', 'emdo.finance_import_receipts',
			'committed_at', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_finance_import_executor', 'emdo.sync_entities', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_finance_import_executor', 'emdo.spaces', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_finance_import_executor', 'emdo.finance_import_fingerprints', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_finance_import_executor', 'emdo.finance_import_receipts', 'UPDATE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_finance_import_executor',
			'emdo.is_active_request_scope(uuid,uuid,uuid)', 'EXECUTE'
		)
		AND pg_catalog.has_function_privilege(
			'emdo_finance_import_executor', 'emdo.canonical_json_text(jsonb)', 'EXECUTE'
		)
		AND pg_catalog.has_column_privilege(
			'emdo_finance_import_retention', 'emdo.finance_import_plans',
			'created_at', 'UPDATE'
		)
		AND NOT pg_catalog.has_table_privilege(
			'emdo_finance_import_retention', 'emdo.finance_import_plans', 'UPDATE'
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_policy policy
			WHERE policy.polname = 'finance_import_plans_retention_lock'
				AND policy.polrelid = 'emdo.finance_import_plans'::regclass
				AND policy.polcmd = 'w'
				AND 'emdo_finance_import_retention'::regrole = ANY(policy.polroles)
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_policy policy
			WHERE policy.polname = 'sync_entities_finance_import_executor_select'
				AND policy.polrelid = 'emdo.sync_entities'::regclass
				AND policy.polcmd = 'r'
				AND 'emdo_finance_import_executor'::regrole = ANY(policy.polroles)
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_policy policy
			WHERE policy.polname = 'sync_entities_finance_import_executor_lock'
				AND policy.polrelid = 'emdo.sync_entities'::regclass
				AND policy.polcmd = 'w'
				AND 'emdo_finance_import_executor'::regrole = ANY(policy.polroles)
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_policy policy
			WHERE policy.polname = 'sync_entities_finance_import_executor_insert'
				AND policy.polrelid = 'emdo.sync_entities'::regclass
				AND policy.polcmd = 'a'
				AND 'emdo_finance_import_executor'::regrole = ANY(policy.polroles)
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_policy policy
			WHERE policy.polname = 'spaces_finance_import_executor_lock'
				AND policy.polrelid = 'emdo.spaces'::regclass
				AND policy.polcmd = 'w'
				AND 'emdo_finance_import_executor'::regrole = ANY(policy.polroles)
		)
		AND EXISTS (
			SELECT 1 FROM pg_catalog.pg_policy policy
			WHERE policy.polname = 'spaces_finance_import_executor_select'
				AND policy.polrelid = 'emdo.spaces'::regclass
				AND policy.polcmd = 'r'
				AND 'emdo_finance_import_executor'::regrole = ANY(policy.polroles)
		)
	AND EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
	WHERE rolname = 'emdo_finance_import_executor'
			AND rolcanlogin = false AND rolinherit = false
			AND rolbypassrls = false AND rolsuper = false
	) AND EXISTS (
		SELECT 1 FROM pg_catalog.pg_roles
		WHERE rolname = 'emdo_finance_import_retention'
			AND rolcanlogin = false AND rolinherit = false
			AND rolbypassrls = false AND rolsuper = false
	) AND NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_auth_members membership
		JOIN pg_catalog.pg_roles role ON role.oid IN (membership.roleid, membership.member)
		WHERE role.rolname IN ('emdo_finance_import_executor', 'emdo_finance_import_retention')
	) AND (
		SELECT pg_catalog.count(*) FROM pg_catalog.pg_class relation
		WHERE relation.oid IN ('emdo.finance_import_plans'::regclass, 'emdo.finance_import_fingerprints'::regclass, 'emdo.finance_import_receipts'::regclass)
			AND relation.relrowsecurity AND relation.relforcerowsecurity
	) = 3 AND (
		SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc proc
		WHERE proc.oid IN (
			'emdo.resolve_finance_import_scope(text,uuid,uuid,text,text)'::regprocedure,
			'emdo.read_finance_import_preview_scope(text,uuid,uuid,text,text)'::regprocedure,
			'emdo.read_finance_import_destinations(uuid,uuid,text,text)'::regprocedure,
			'emdo.persist_finance_import_plan(uuid,text,text,jsonb,jsonb,jsonb,uuid,uuid,text,text,integer)'::regprocedure,
			'emdo.commit_finance_import_plan(uuid,text,uuid,uuid,text,text)'::regprocedure,
			'emdo.finance_imports_ready()'::regprocedure
		) AND proc.prosecdef
			AND proc.proowner = 'emdo_finance_import_executor'::regrole
			AND proc.proconfig @> ARRAY['row_security=on', 'search_path=pg_catalog, emdo']
	) = 6 AND EXISTS (
		SELECT 1 FROM pg_catalog.pg_proc proc
		WHERE proc.oid = 'emdo.purge_expired_finance_import_plans(integer)'::regprocedure
			AND proc.prosecdef
			AND proc.proowner = 'emdo_finance_import_retention'::regrole
			AND proc.proconfig @> ARRAY['row_security=on', 'search_path=pg_catalog, emdo']
	)
$function$;
--> statement-breakpoint
ALTER FUNCTION emdo.resolve_finance_import_scope(text, uuid, uuid, text, text)
	OWNER TO emdo_finance_import_executor;
ALTER FUNCTION emdo.read_finance_import_preview_scope(text, uuid, uuid, text, text)
	OWNER TO emdo_finance_import_executor;
ALTER FUNCTION emdo.read_finance_import_destinations(uuid, uuid, text, text)
	OWNER TO emdo_finance_import_executor;
ALTER FUNCTION emdo.persist_finance_import_plan(uuid, text, text, jsonb, jsonb, jsonb, uuid, uuid, text, text, integer)
	OWNER TO emdo_finance_import_executor;
ALTER FUNCTION emdo.commit_finance_import_plan(uuid, text, uuid, uuid, text, text)
	OWNER TO emdo_finance_import_executor;
ALTER FUNCTION emdo.purge_expired_finance_import_plans(integer)
	OWNER TO emdo_finance_import_retention;
ALTER FUNCTION emdo.finance_imports_ready() OWNER TO emdo_finance_import_executor;
GRANT USAGE ON SCHEMA emdo TO emdo_finance_import_executor, emdo_finance_import_retention;
GRANT SELECT, INSERT ON emdo.finance_import_plans, emdo.finance_import_fingerprints,
	emdo.finance_import_receipts, emdo.sync_entities TO emdo_finance_import_executor;
GRANT UPDATE (canonical_plan, diagnostics, mapping_metadata, redacted_at)
	ON emdo.finance_import_plans TO emdo_finance_import_executor;
GRANT SELECT ON emdo.spaces, emdo.household_memberships,
	emdo.space_access_grants TO emdo_finance_import_executor;
GRANT UPDATE (updated_at) ON emdo.sync_entities, emdo.spaces
	TO emdo_finance_import_executor;
GRANT UPDATE (recorded_at) ON emdo.finance_import_fingerprints
	TO emdo_finance_import_executor;
GRANT UPDATE (committed_at) ON emdo.finance_import_receipts
	TO emdo_finance_import_executor;
GRANT EXECUTE ON FUNCTION emdo.current_user_id(), emdo.current_session_id(),
	emdo.current_request_id(), emdo.lock_active_request_scope(uuid, uuid, uuid),
	emdo.is_active_request_scope(uuid, uuid, uuid),
	emdo.resolve_space_access_grant(uuid, uuid, uuid, uuid, uuid, uuid),
	emdo.lock_current_authorization_scope(uuid, uuid, uuid)
	TO emdo_finance_import_executor;
GRANT EXECUTE ON FUNCTION emdo.canonical_json_text(jsonb),
	emdo.canonical_json_hash(jsonb)
	TO emdo_finance_import_executor;
GRANT EXECUTE ON FUNCTION emdo.is_valid_finance_import_destination(
	jsonb, text, text, uuid, uuid
) TO emdo_finance_import_executor;
GRANT SELECT, DELETE ON emdo.finance_import_plans TO emdo_finance_import_retention;
GRANT UPDATE (created_at) ON emdo.finance_import_plans
	TO emdo_finance_import_retention;
GRANT SELECT ON emdo.finance_import_receipts TO emdo_finance_import_retention;
GRANT EXECUTE ON FUNCTION emdo.purge_expired_finance_import_plans(integer)
	TO emdo_finance_import_retention;
REVOKE ALL ON emdo.finance_import_plans, emdo.finance_import_fingerprints,
	emdo.finance_import_receipts FROM PUBLIC, emdo_app;
REVOKE ALL ON FUNCTION emdo.resolve_finance_import_scope(text, uuid, uuid, text, text),
	emdo.read_finance_import_preview_scope(text, uuid, uuid, text, text),
	emdo.read_finance_import_destinations(uuid, uuid, text, text),
	emdo.is_valid_finance_import_destination(jsonb, text, text, uuid, uuid),
	emdo.persist_finance_import_plan(uuid, text, text, jsonb, jsonb, jsonb, uuid, uuid, text, text, integer),
	emdo.commit_finance_import_plan(uuid, text, uuid, uuid, text, text),
	emdo.purge_expired_finance_import_plans(integer),
	emdo.finance_imports_ready() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emdo.read_finance_import_preview_scope(text, uuid, uuid, text, text),
	emdo.persist_finance_import_plan(uuid, text, text, jsonb, jsonb, jsonb, uuid, uuid, text, text, integer),
	emdo.commit_finance_import_plan(uuid, text, uuid, uuid, text, text),
	emdo.finance_imports_ready() TO emdo_app;
GRANT EXECUTE ON FUNCTION emdo.read_finance_import_destinations(uuid, uuid, text, text)
	TO emdo_app;
