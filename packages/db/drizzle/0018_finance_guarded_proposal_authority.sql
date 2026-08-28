ALTER TABLE "emdo"."action_proposals" ADD COLUMN "guarded_action" jsonb;--> statement-breakpoint
ALTER TABLE "emdo"."action_proposals" ADD CONSTRAINT "action_proposals_guarded_action_check" CHECK (
	"emdo"."action_proposals"."guarded_action" IS NULL OR (
		pg_catalog.jsonb_typeof("emdo"."action_proposals"."guarded_action") = 'object'
		AND pg_catalog.octet_length("emdo"."action_proposals"."guarded_action"::text) <= 2048
		AND "emdo"."action_proposals"."capability_id" IN (
			'finance.records.write', 'finance.statement.import'
		)
		AND emdo.jsonb_object_has_exact_keys(
			"emdo"."action_proposals"."guarded_action",
			CASE WHEN "emdo"."action_proposals"."guarded_action" ? 'targetBindingHash'
				THEN ARRAY[
					'capabilityVersion', 'operation', 'actionHash',
					'executionBindingHash', 'targetBindingHash'
				]::text[]
				ELSE ARRAY[
					'capabilityVersion', 'operation', 'actionHash',
					'executionBindingHash'
				]::text[]
			END
		)
		AND pg_catalog.jsonb_typeof(
			"emdo"."action_proposals"."guarded_action" -> 'capabilityVersion'
		) = 'string'
		AND "emdo"."action_proposals"."guarded_action" ->> 'capabilityVersion' = '1.0.0'
		AND pg_catalog.jsonb_typeof(
			"emdo"."action_proposals"."guarded_action" -> 'operation'
		) = 'string'
		AND "emdo"."action_proposals"."guarded_action" ->> 'operation' ~
			'^[a-z0-9]+([._:-][a-z0-9]+)*$'
		AND pg_catalog.jsonb_typeof(
			"emdo"."action_proposals"."guarded_action" -> 'actionHash'
		) = 'string'
		AND "emdo"."action_proposals"."guarded_action" ->> 'actionHash' ~
			'^[a-f0-9]{64}$'
		AND pg_catalog.jsonb_typeof(
			"emdo"."action_proposals"."guarded_action" -> 'executionBindingHash'
		) = 'string'
		AND "emdo"."action_proposals"."guarded_action" ->> 'executionBindingHash' ~
			'^[a-f0-9]{64}$'
		AND "emdo"."action_proposals"."guarded_action" ->> 'actionHash' =
			"emdo"."action_proposals"."payload_hash"
		AND "emdo"."action_proposals"."payload_hash" =
			emdo.canonical_json_hash(
				"emdo"."action_proposals"."canonical_arguments"
			)
		AND "emdo"."action_proposals"."guarded_action" ->> 'executionBindingHash' =
			"emdo"."action_proposals"."provider_authority_binding_hash"
		AND (
			("emdo"."action_proposals"."capability_id" = 'finance.records.write'
				AND "emdo"."action_proposals"."guarded_action" ->> 'operation' IN (
					'finance-adjustment', 'finance-reversal',
					'finance-document-review-commit',
					'finance-document-match-accept',
					'finance-document-delete'
				))
			OR ("emdo"."action_proposals"."capability_id" = 'finance.statement.import'
				AND "emdo"."action_proposals"."guarded_action" ->> 'operation' =
					'finance-statement-import-commit')
		)
		AND (
			("emdo"."action_proposals"."guarded_action" ->> 'operation' IN (
				'finance-document-review-commit',
				'finance-document-match-accept',
				'finance-document-delete'
			) AND "emdo"."action_proposals"."guarded_action" ? 'targetBindingHash'
				AND pg_catalog.jsonb_typeof(
					"emdo"."action_proposals"."guarded_action" -> 'targetBindingHash'
				) = 'string'
				AND "emdo"."action_proposals"."guarded_action" ->> 'targetBindingHash' ~
					'^[a-f0-9]{64}$')
			OR ("emdo"."action_proposals"."guarded_action" ->> 'operation' NOT IN (
				'finance-document-review-commit',
				'finance-document-match-accept',
				'finance-document-delete'
			) AND NOT ("emdo"."action_proposals"."guarded_action" ? 'targetBindingHash'))
		)
	)
);--> statement-breakpoint

-- A Finance guard is valid only for the two registered v1 capabilities. The
-- live authority binding itself is re-derived later under current locks.
CREATE OR REPLACE FUNCTION "emdo"."finance_guarded_action_proposal_is_valid"(
	p_capability_id text,
	p_payload_hash text,
	p_provider_authority_binding_hash text,
	p_canonical_arguments jsonb,
	p_guarded_action jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, emdo
AS $function$
	SELECT COALESCE(
		p_capability_id IN ('finance.records.write', 'finance.statement.import')
		AND p_payload_hash ~ '^[a-f0-9]{64}$'
		AND p_provider_authority_binding_hash ~ '^[a-f0-9]{64}$'
		AND p_payload_hash = emdo.canonical_json_hash(p_canonical_arguments)
		AND pg_catalog.jsonb_typeof(p_guarded_action) = 'object'
		AND pg_catalog.octet_length(p_guarded_action::text) <= 2048
		AND emdo.jsonb_object_has_exact_keys(
			p_guarded_action,
			CASE WHEN p_guarded_action ? 'targetBindingHash' THEN ARRAY[
				'capabilityVersion', 'operation', 'actionHash',
				'executionBindingHash', 'targetBindingHash'
			]::text[] ELSE ARRAY[
				'capabilityVersion', 'operation', 'actionHash',
				'executionBindingHash'
			]::text[] END
		)
		AND pg_catalog.jsonb_typeof(p_guarded_action -> 'capabilityVersion') = 'string'
		AND p_guarded_action ->> 'capabilityVersion' = '1.0.0'
		AND pg_catalog.jsonb_typeof(p_guarded_action -> 'operation') = 'string'
		AND p_guarded_action ->> 'operation' ~ '^[a-z0-9]+([._:-][a-z0-9]+)*$'
		AND pg_catalog.jsonb_typeof(p_guarded_action -> 'actionHash') = 'string'
		AND p_guarded_action ->> 'actionHash' ~ '^[a-f0-9]{64}$'
		AND pg_catalog.jsonb_typeof(
			p_guarded_action -> 'executionBindingHash'
		) = 'string'
		AND p_guarded_action ->> 'executionBindingHash' ~ '^[a-f0-9]{64}$'
		AND p_guarded_action ->> 'actionHash' = p_payload_hash
		AND p_guarded_action ->> 'executionBindingHash' =
			p_provider_authority_binding_hash
		AND (
			(p_capability_id = 'finance.records.write'
				AND p_guarded_action ->> 'operation' IN (
					'finance-adjustment', 'finance-reversal',
					'finance-document-review-commit',
					'finance-document-match-accept',
					'finance-document-delete'
				))
			OR (p_capability_id = 'finance.statement.import'
				AND p_guarded_action ->> 'operation' =
					'finance-statement-import-commit')
		)
		AND (
			(p_guarded_action ->> 'operation' IN (
				'finance-document-review-commit',
				'finance-document-match-accept',
				'finance-document-delete'
			) AND p_guarded_action ? 'targetBindingHash'
				AND pg_catalog.jsonb_typeof(
					p_guarded_action -> 'targetBindingHash'
				) = 'string'
				AND p_guarded_action ->> 'targetBindingHash' ~ '^[a-f0-9]{64}$')
			OR (p_guarded_action ->> 'operation' NOT IN (
				'finance-document-review-commit',
				'finance-document-match-accept',
				'finance-document-delete'
			) AND NOT (p_guarded_action ? 'targetBindingHash'))
		), false)
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."finance_guarded_authority_material_is_valid"(
	p_material jsonb,
	p_provider_authority_binding_hash text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, emdo
AS $function$
	SELECT COALESCE(
		pg_catalog.jsonb_typeof(p_material) = 'object'
		AND pg_catalog.octet_length(p_material::text) <= 4096
		AND emdo.jsonb_object_has_exact_keys(
			p_material,
			ARRAY[
				'schemaVersion', 'capabilityId', 'capabilityFingerprint',
				'guardedAction'
			]::text[]
		)
		AND p_material -> 'schemaVersion' = '1'::jsonb
		AND pg_catalog.jsonb_typeof(p_material -> 'capabilityId') = 'string'
		AND p_material ->> 'capabilityId' IN (
			'finance.records.write', 'finance.statement.import'
		)
		AND pg_catalog.jsonb_typeof(
			p_material -> 'capabilityFingerprint'
		) = 'string'
		AND p_material ->> 'capabilityFingerprint' ~ '^[a-f0-9]{64}$'
		AND p_provider_authority_binding_hash ~ '^[a-f0-9]{64}$'
		AND pg_catalog.jsonb_typeof(p_material -> 'guardedAction') = 'object'
		AND pg_catalog.octet_length(
			(p_material -> 'guardedAction')::text
		) <= 2048
		AND emdo.jsonb_object_has_exact_keys(
			p_material -> 'guardedAction',
			CASE WHEN p_material #> '{guardedAction,targetBindingHash}' IS NOT NULL
				THEN ARRAY[
					'capabilityVersion', 'operation', 'actionHash',
					'executionBindingHash', 'targetBindingHash'
				]::text[] ELSE ARRAY[
					'capabilityVersion', 'operation', 'actionHash',
					'executionBindingHash'
				]::text[] END
		)
		AND pg_catalog.jsonb_typeof(
			p_material #> '{guardedAction,capabilityVersion}'
		) = 'string'
		AND p_material #>> '{guardedAction,capabilityVersion}' = '1.0.0'
		AND pg_catalog.jsonb_typeof(
			p_material #> '{guardedAction,operation}'
		) = 'string'
		AND p_material #>> '{guardedAction,operation}' ~
			'^[a-z0-9]+([._:-][a-z0-9]+)*$'
		AND pg_catalog.jsonb_typeof(
			p_material #> '{guardedAction,actionHash}'
		) = 'string'
		AND p_material #>> '{guardedAction,actionHash}' ~ '^[a-f0-9]{64}$'
		AND pg_catalog.jsonb_typeof(
			p_material #> '{guardedAction,executionBindingHash}'
		) = 'string'
		AND p_material #>> '{guardedAction,executionBindingHash}' ~
			'^[a-f0-9]{64}$'
		AND p_material #>> '{guardedAction,executionBindingHash}' =
			p_provider_authority_binding_hash
		AND (
			(p_material ->> 'capabilityId' = 'finance.records.write'
				AND p_material #>> '{guardedAction,operation}' IN (
					'finance-adjustment', 'finance-reversal',
					'finance-document-review-commit',
					'finance-document-match-accept',
					'finance-document-delete'
				))
			OR (p_material ->> 'capabilityId' = 'finance.statement.import'
				AND p_material #>> '{guardedAction,operation}' =
					'finance-statement-import-commit')
		)
		AND (
			(p_material #>> '{guardedAction,operation}' IN (
				'finance-document-review-commit',
				'finance-document-match-accept',
				'finance-document-delete'
			) AND p_material #> '{guardedAction,targetBindingHash}' IS NOT NULL
				AND pg_catalog.jsonb_typeof(
					p_material #> '{guardedAction,targetBindingHash}'
				) = 'string'
				AND p_material #>> '{guardedAction,targetBindingHash}' ~
					'^[a-f0-9]{64}$')
			OR (p_material #>> '{guardedAction,operation}' NOT IN (
				'finance-document-review-commit',
				'finance-document-match-accept',
				'finance-document-delete'
			) AND p_material #> '{guardedAction,targetBindingHash}' IS NULL)
		), false)
$function$;
--> statement-breakpoint

ALTER TABLE "emdo"."workflow_operation_claims"
	ADD COLUMN "finance_guarded_authority" jsonb;
ALTER TABLE "emdo"."workflow_operation_claims"
	ADD CONSTRAINT "workflow_operation_claims_finance_guarded_authority_check"
	CHECK (
		"finance_guarded_authority" IS NULL
		OR (
			"phase" IN ('proposal-create', 'visual-decision')
			AND emdo.finance_guarded_authority_material_is_valid(
				"finance_guarded_authority",
				"provider_authority_binding_hash"
			)
		)
	);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."enforce_workflow_operation_claim_transition"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
	IF TG_OP = 'DELETE'
		OR (pg_catalog.to_jsonb(NEW) - ARRAY[
			'claimed_at', 'finance_guarded_authority'
		]) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY[
			'claimed_at', 'finance_guarded_authority'
		])
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'workflow operation claim binding is immutable';
	END IF;
	IF NEW.finance_guarded_authority IS DISTINCT FROM
		OLD.finance_guarded_authority
		AND NOT (
			OLD.finance_guarded_authority IS NULL
			AND NEW.finance_guarded_authority IS NOT NULL
			AND OLD.claimed_at IS NULL
			AND NEW.claimed_at IS NULL
		)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'finance guarded authority is immutable once set';
	END IF;
	IF NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
		AND (
			OLD.claimed_at IS NOT NULL
			OR NEW.claimed_at IS NULL
			OR NEW.claimed_at < OLD.issued_at
			OR NEW.claimed_at > OLD.expires_at
		)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'invalid workflow operation claim transition';
	END IF;
	RETURN NEW;
END
$function$;
--> statement-breakpoint

GRANT UPDATE ("finance_guarded_authority")
	ON "emdo"."workflow_operation_claims" TO emdo_workflow_executor;
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
		AND emdo.jsonb_object_has_exact_keys(
			p_input,
			CASE WHEN p_input ? 'guardedAction' THEN ARRAY[
				'schemaVersion', 'id', 'version', 'runId', 'capabilityId',
				'capabilityFingerprint', 'authorizationScopeFingerprint',
				'canonicalArguments', 'targets', 'beforePreview', 'afterPreview',
				'providerPreconditions', 'approvalDisplay',
				'providerAuthorityBindingHash', 'providerSdkCallId',
				'guardedAction', 'payloadHash', 'approvalHash',
				'disclosureGrant', 'createdAt', 'expiresAt', 'idempotencyKey',
				'state'
			]::text[] ELSE ARRAY[
				'schemaVersion', 'id', 'version', 'runId', 'capabilityId',
				'capabilityFingerprint', 'authorizationScopeFingerprint',
				'canonicalArguments', 'targets', 'beforePreview', 'afterPreview',
				'providerPreconditions', 'approvalDisplay',
				'providerAuthorityBindingHash', 'providerSdkCallId', 'payloadHash',
				'approvalHash', 'disclosureGrant', 'createdAt', 'expiresAt',
				'idempotencyKey', 'state'
			]::text[] END
		)
		AND (p_input ->> 'schemaVersion')::smallint = p_proposal.schema_version
		AND (p_input ->> 'id')::uuid = p_proposal.id
		AND (p_input ->> 'version')::integer = p_version
		AND (p_input ->> 'runId')::uuid = p_proposal.run_id
		AND p_input ->> 'capabilityId' = p_proposal.capability_id
		AND p_input ->> 'capabilityFingerprint' = p_proposal.capability_fingerprint
		AND p_input ->> 'authorizationScopeFingerprint' =
			p_proposal.authorization_scope_fingerprint
		AND p_input -> 'canonicalArguments' = p_proposal.canonical_arguments
		AND p_input -> 'targets' = p_proposal.targets
		AND p_input -> 'beforePreview' = p_proposal.before_preview
		AND p_input -> 'afterPreview' = p_proposal.after_preview
		AND p_input -> 'providerPreconditions' = p_proposal.provider_preconditions
		AND p_input -> 'approvalDisplay' = p_proposal.approval_display
		AND p_input ->> 'providerAuthorityBindingHash' =
			p_proposal.provider_authority_binding_hash
		AND p_input ->> 'providerSdkCallId' = p_proposal.provider_sdk_call_id
		AND (CASE WHEN p_input ? 'guardedAction'
			THEN p_proposal.guarded_action IS NOT NULL
				AND p_input -> 'guardedAction' = p_proposal.guarded_action
			ELSE p_proposal.guarded_action IS NULL
			END)
		AND p_input ->> 'payloadHash' = p_proposal.payload_hash
		AND p_input ->> 'approvalHash' = p_proposal.approval_hash
		AND p_input -> 'disclosureGrant' = p_proposal.disclosure_grant
		AND (p_input ->> 'createdAt')::timestamptz = p_proposal.created_at
		AND (p_input ->> 'expiresAt')::timestamptz = p_proposal.expires_at
		AND p_input ->> 'idempotencyKey' = p_proposal.idempotency_key
		AND p_input ->> 'state' = p_state
$function$;
--> statement-breakpoint

-- Keep the Calendar issuer and Google verifier intact. Finance is admitted
-- through a separate pre-verified branch that is scoped to this transaction.
ALTER FUNCTION "emdo"."lock_current_google_calendar_authority"(
	uuid, uuid, uuid, text, text
) RENAME TO lock_current_google_calendar_authority_calendar;
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
BEGIN
	IF p_expected_binding_hash ~ '^[a-f0-9]{64}$'
		AND pg_catalog.current_setting(
			'emdo.finance_guarded_action_authority', true
		) = p_expected_binding_hash
	THEN
		-- The issuer sets this only after it has recomputed the Finance v2
		-- digest, and clears it before returning to the aggregate.
		RETURN true;
	END IF;
	IF pg_catalog.current_setting(
		'emdo.finance_guarded_claim_verification', true
	) = '1'
		AND emdo.lock_current_finance_guarded_claim_authority(
			p_household_id, p_private_space_id, p_original_owner_user_id,
			p_authorization_scope_fingerprint, p_expected_binding_hash
		)
	THEN
		RETURN true;
	END IF;
	RETURN emdo.lock_current_google_calendar_authority_calendar(
		p_household_id, p_private_space_id, p_original_owner_user_id,
		p_authorization_scope_fingerprint, p_expected_binding_hash
	);
END
$function$;
--> statement-breakpoint

ALTER FUNCTION "emdo"."lock_current_google_calendar_authority"(
	uuid, uuid, uuid, text, text
) OWNER TO emdo_oauth_grant_executor;
REVOKE ALL ON FUNCTION "emdo"."lock_current_google_calendar_authority"(
	uuid, uuid, uuid, text, text
) FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login, emdo_visual_decision_login,
	emdo_proposal_reconciliation_executor, emdo_approval_resume_executor,
	emdo_proposal_query_executor, emdo_manager_turn_executor;
GRANT EXECUTE ON FUNCTION "emdo"."lock_current_google_calendar_authority"(
	uuid, uuid, uuid, text, text
) TO emdo_workflow_executor;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."lock_current_finance_guarded_action_authority"(
	p_phase text,
	p_scope jsonb,
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
	v_scope_user_id uuid;
	v_scope_session_id uuid;
	v_scope_request_id uuid;
	v_scope_household_id uuid;
	v_scope_run_id uuid;
	v_scope_space_access_grant_id uuid;
	v_scope_disclosure_grant_id uuid;
	v_scope_proposal_id uuid;
	v_scope_provider_sdk_call_id text;
	v_collection_scope record;
	v_candidate jsonb;
	v_proposal emdo.action_proposals%ROWTYPE;
	v_guarded_action jsonb;
	v_capability_id text;
	v_capability_version text;
	v_capability_fingerprint text;
	v_payload_hash text;
	v_canonical_arguments jsonb;
	v_preparation_agent_id text;
	v_disclosure_agent_id text;
	v_expected_binding_hash text;
BEGIN
	IF p_phase IS NULL
		OR p_phase NOT IN ('proposal-create', 'visual-decision')
		OR p_scope IS NULL
		OR pg_catalog.jsonb_typeof(p_scope) <> 'object'
		OR NOT emdo.jsonb_object_has_exact_keys(
			p_scope, ARRAY[
				'phase', 'currentRequestId', 'currentSessionId', 'runId',
				'householdId', 'userId', 'currentSpaceAccessGrantId',
				'authorizationScopeFingerprint', 'disclosureGrantId',
				'disclosureGrantVersion', 'disclosureGrantHash', 'proposalId',
				'providerSdkCallId', 'activeAt',
				'requireActiveDisclosureGrant'
			]::text[]
		)
		OR p_scope ->> 'phase' IS DISTINCT FROM p_phase
		OR p_scope ->> 'authorizationScopeFingerprint' !~ '^[a-f0-9]{64}$'
		OR p_scope ->> 'disclosureGrantHash' !~ '^[a-f0-9]{64}$'
		OR p_scope -> 'requireActiveDisclosureGrant' IS DISTINCT FROM 'true'::jsonb
		OR p_provider_authority_binding_hash !~ '^[a-f0-9]{64}$'
		OR p_mutation IS NULL
		OR pg_catalog.jsonb_typeof(p_mutation) <> 'object'
	THEN
		RETURN false;
	END IF;
	BEGIN
		v_scope_user_id := (p_scope ->> 'userId')::uuid;
		v_scope_session_id := (p_scope ->> 'currentSessionId')::uuid;
		v_scope_request_id := (p_scope ->> 'currentRequestId')::uuid;
		v_scope_household_id := (p_scope ->> 'householdId')::uuid;
		v_scope_run_id := (p_scope ->> 'runId')::uuid;
		v_scope_space_access_grant_id :=
			(p_scope ->> 'currentSpaceAccessGrantId')::uuid;
		v_scope_disclosure_grant_id :=
			(p_scope ->> 'disclosureGrantId')::uuid;
		v_scope_proposal_id := (p_scope ->> 'proposalId')::uuid;
		v_scope_provider_sdk_call_id := p_scope ->> 'providerSdkCallId';
	EXCEPTION WHEN invalid_text_representation THEN
		RETURN false;
	END;
	IF p_scope ->> 'userId' IS DISTINCT FROM v_scope_user_id::text
		OR p_scope ->> 'currentSessionId' IS DISTINCT FROM
			v_scope_session_id::text
		OR p_scope ->> 'currentRequestId' IS DISTINCT FROM
			v_scope_request_id::text
		OR p_scope ->> 'householdId' IS DISTINCT FROM
			v_scope_household_id::text
		OR p_scope ->> 'runId' IS DISTINCT FROM v_scope_run_id::text
		OR p_scope ->> 'currentSpaceAccessGrantId' IS DISTINCT FROM
			v_scope_space_access_grant_id::text
		OR p_scope ->> 'disclosureGrantId' IS DISTINCT FROM
			v_scope_disclosure_grant_id::text
		OR p_scope ->> 'proposalId' IS DISTINCT FROM
			v_scope_proposal_id::text
		OR pg_catalog.length(v_scope_provider_sdk_call_id) NOT BETWEEN 1 AND 512
		OR pg_catalog.btrim(v_scope_provider_sdk_call_id) <>
			v_scope_provider_sdk_call_id
		OR v_scope_provider_sdk_call_id ~ '[[:cntrl:]]'
	THEN
		RETURN false;
	END IF;

	-- Do not substitute the durable proposal/run operation scope below. The
	-- Finance digest intentionally binds the fresh collection scope instead.
	SELECT authority.* INTO v_collection_scope
	FROM emdo.lock_current_authorization_scope(
		v_scope_space_access_grant_id, NULL, NULL
	) AS authority;
	IF NOT FOUND
		OR v_collection_scope.user_id IS DISTINCT FROM v_scope_user_id
		OR v_collection_scope.session_id IS DISTINCT FROM v_scope_session_id
		OR v_collection_scope.request_id IS DISTINCT FROM v_scope_request_id
		OR v_collection_scope.household_id IS DISTINCT FROM
			v_scope_household_id
		OR v_collection_scope.private_space_id IS NULL
		OR v_collection_scope.authorization_scope_fingerprint !~
			'^[a-f0-9]{64}$'
	THEN
		RETURN false;
	END IF;

	IF p_phase = 'proposal-create' THEN
		v_candidate := p_mutation -> 'proposal';
		IF pg_catalog.jsonb_typeof(v_candidate) <> 'object'
			OR v_candidate ->> 'id' IS DISTINCT FROM v_scope_proposal_id::text
			OR v_candidate ->> 'runId' IS DISTINCT FROM v_scope_run_id::text
			OR v_candidate ->> 'providerSdkCallId' IS DISTINCT FROM
				v_scope_provider_sdk_call_id
			OR v_candidate ->> 'authorizationScopeFingerprint' IS DISTINCT FROM
				p_scope ->> 'authorizationScopeFingerprint'
			OR v_candidate #>> '{disclosureGrant,id}' IS DISTINCT FROM
				v_scope_disclosure_grant_id::text
			OR v_candidate #>> '{disclosureGrant,agentId}' IS DISTINCT FROM
				'finance'
			OR p_mutation #>> '{preparation,binding,agentId}' IS DISTINCT FROM
				'finance'
		THEN
			RETURN false;
		END IF;
		v_capability_id := v_candidate ->> 'capabilityId';
		v_capability_version := v_candidate #>> '{guardedAction,capabilityVersion}';
		v_capability_fingerprint := v_candidate ->> 'capabilityFingerprint';
		v_payload_hash := v_candidate ->> 'payloadHash';
		v_canonical_arguments := v_candidate -> 'canonicalArguments';
		v_guarded_action := v_candidate -> 'guardedAction';
	ELSE
		SELECT proposal.* INTO v_proposal
		FROM emdo.action_proposals AS proposal
		WHERE proposal.id = v_scope_proposal_id
			AND proposal.household_id = v_scope_household_id
			AND proposal.original_owner_user_id = v_scope_user_id
			AND proposal.run_id = v_scope_run_id
			AND proposal.disclosure_grant_id = v_scope_disclosure_grant_id
			AND proposal.provider_sdk_call_id = v_scope_provider_sdk_call_id
		FOR SHARE OF proposal;
		IF NOT FOUND
			OR p_mutation #>> '{next,id}' IS DISTINCT FROM v_proposal.id::text
			OR p_mutation #>> '{next,runId}' IS DISTINCT FROM v_proposal.run_id::text
			OR p_mutation #>> '{next,capabilityId}' IS DISTINCT FROM
				v_proposal.capability_id
			OR p_mutation #>> '{next,capabilityFingerprint}' IS DISTINCT FROM
				v_proposal.capability_fingerprint
			OR p_mutation #>> '{next,authorizationScopeFingerprint}' IS DISTINCT FROM
				v_proposal.authorization_scope_fingerprint
			OR p_mutation #>> '{next,providerSdkCallId}' IS DISTINCT FROM
				v_proposal.provider_sdk_call_id
			OR p_mutation #>> '{next,providerAuthorityBindingHash}' IS DISTINCT FROM
				v_proposal.provider_authority_binding_hash
			OR p_mutation #>> '{next,payloadHash}' IS DISTINCT FROM
				v_proposal.payload_hash
			OR p_mutation #>> '{next,disclosureGrant,id}' IS DISTINCT FROM
				v_proposal.disclosure_grant_id::text
			OR p_mutation #> '{next,guardedAction}' IS DISTINCT FROM
				v_proposal.guarded_action
		THEN
			RETURN false;
		END IF;
		v_candidate := p_mutation -> 'next';
		v_capability_id := v_proposal.capability_id;
		v_capability_version :=
			v_proposal.guarded_action ->> 'capabilityVersion';
		v_capability_fingerprint := v_proposal.capability_fingerprint;
		v_payload_hash := v_proposal.payload_hash;
		v_canonical_arguments := v_proposal.canonical_arguments;
		v_guarded_action := v_proposal.guarded_action;
		SELECT preparation.preparation_binding ->> 'agentId'
		INTO v_preparation_agent_id
		FROM emdo.proposal_preparations AS preparation
		WHERE preparation.proposal_id = v_scope_proposal_id
		FOR SHARE OF preparation;
		IF NOT FOUND OR v_preparation_agent_id IS DISTINCT FROM 'finance' THEN
			RETURN false;
		END IF;
	END IF;

	SELECT disclosure.agent_id INTO v_disclosure_agent_id
	FROM emdo.disclosure_grants AS disclosure
	WHERE disclosure.id = v_scope_disclosure_grant_id
		AND disclosure.household_id = v_scope_household_id
		AND disclosure.user_id = v_scope_user_id
		AND disclosure.run_id = v_scope_run_id
	FOR SHARE OF disclosure;
	IF NOT FOUND OR v_disclosure_agent_id IS DISTINCT FROM 'finance'
		OR NOT emdo.finance_guarded_action_proposal_is_valid(
			v_capability_id, v_payload_hash,
			p_provider_authority_binding_hash, v_canonical_arguments,
			v_guarded_action
		)
		OR v_capability_fingerprint !~ '^[a-f0-9]{64}$'
	THEN
		RETURN false;
	END IF;

	v_expected_binding_hash := emdo.canonical_json_hash(
		pg_catalog.jsonb_build_object(
			'schemaVersion', 1,
			'domain', 'emdo.finance-guarded-action-execution-binding.v2',
			'proposalId', v_scope_proposal_id,
			'runId', v_scope_run_id,
			'householdId', v_scope_household_id,
			'userId', v_scope_user_id,
			'authenticatedSessionId', v_scope_session_id,
			'privateSpaceId', v_collection_scope.private_space_id,
			'authorizationScopeFingerprint',
				v_collection_scope.authorization_scope_fingerprint,
			'disclosureGrantId', v_scope_disclosure_grant_id,
			'capabilityId', v_capability_id,
			'capabilityVersion', v_capability_version,
			'capabilityFingerprint', v_capability_fingerprint,
			'operation', v_guarded_action ->> 'operation',
			'actionHash', v_payload_hash
		) || CASE WHEN v_guarded_action ? 'targetBindingHash'
			THEN pg_catalog.jsonb_build_object(
				'targetBindingHash', v_guarded_action ->> 'targetBindingHash'
			)
			ELSE '{}'::jsonb END
	);
	RETURN v_expected_binding_hash IS NOT DISTINCT FROM
		p_provider_authority_binding_hash
		AND v_expected_binding_hash IS NOT DISTINCT FROM
			v_guarded_action ->> 'executionBindingHash';
EXCEPTION
	WHEN invalid_text_representation OR invalid_datetime_format
		OR datetime_field_overflow OR numeric_value_out_of_range
	THEN
		RETURN false;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "emdo"."lock_current_finance_guarded_claim_authority"(
	p_household_id uuid,
	p_private_space_id uuid,
	p_original_owner_user_id uuid,
	p_operation_authorization_scope_fingerprint text,
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
	v_user_id uuid := emdo.current_user_id();
	v_session_id uuid := emdo.current_session_id();
	v_request_id uuid := emdo.current_request_id();
	v_claim emdo.workflow_operation_claims%ROWTYPE;
	v_collection_scope record;
	v_material jsonb;
	v_guarded_action jsonb;
	v_expected_binding_hash text;
BEGIN
	IF p_household_id IS NULL OR p_private_space_id IS NULL
		OR p_original_owner_user_id IS NULL
		OR p_operation_authorization_scope_fingerprint !~
			'^[a-f0-9]{64}$'
		OR p_expected_binding_hash !~ '^[a-f0-9]{64}$'
		OR v_user_id IS NULL OR v_session_id IS NULL OR v_request_id IS NULL
		OR p_original_owner_user_id IS DISTINCT FROM v_user_id
	THEN
		RETURN false;
	END IF;

	SELECT claim.* INTO v_claim
	FROM emdo.workflow_operation_claims AS claim
	WHERE claim.household_id = p_household_id
		AND claim.user_id = v_user_id
		AND claim.original_owner_user_id = v_user_id
		AND claim.current_session_id = v_session_id
		AND claim.current_request_id = v_request_id
		AND claim.authorization_scope_fingerprint =
			p_operation_authorization_scope_fingerprint
		AND claim.provider_authority_binding_hash = p_expected_binding_hash
		AND claim.phase IN ('proposal-create', 'visual-decision')
		AND claim.finance_guarded_authority IS NOT NULL
		AND claim.claimed_at IS NULL
		AND claim.expires_at > pg_catalog.clock_timestamp()
	ORDER BY claim.operation_id
	LIMIT 1
	FOR SHARE OF claim;
	IF NOT FOUND THEN
		RETURN false;
	END IF;
	v_material := v_claim.finance_guarded_authority;
	IF NOT emdo.finance_guarded_authority_material_is_valid(
		v_material, p_expected_binding_hash
	) THEN
		RETURN false;
	END IF;

	SELECT authority.* INTO v_collection_scope
	FROM emdo.lock_current_authorization_scope(
		v_claim.current_space_access_grant_id, NULL, NULL
	) AS authority;
	IF NOT FOUND
		OR v_collection_scope.user_id IS DISTINCT FROM v_claim.user_id
		OR v_collection_scope.session_id IS DISTINCT FROM
			v_claim.current_session_id
		OR v_collection_scope.request_id IS DISTINCT FROM
			v_claim.current_request_id
		OR v_collection_scope.household_id IS DISTINCT FROM
			v_claim.household_id
		OR v_collection_scope.private_space_id IS DISTINCT FROM
			p_private_space_id
		OR v_collection_scope.authorization_scope_fingerprint !~
			'^[a-f0-9]{64}$'
	THEN
		RETURN false;
	END IF;
	v_guarded_action := v_material -> 'guardedAction';
	v_expected_binding_hash := emdo.canonical_json_hash(
		pg_catalog.jsonb_build_object(
			'schemaVersion', 1,
			'domain', 'emdo.finance-guarded-action-execution-binding.v2',
			'proposalId', v_claim.proposal_id,
			'runId', v_claim.run_id,
			'householdId', v_claim.household_id,
			'userId', v_claim.user_id,
			'authenticatedSessionId', v_claim.current_session_id,
			'privateSpaceId', v_collection_scope.private_space_id,
			'authorizationScopeFingerprint',
				v_collection_scope.authorization_scope_fingerprint,
			'disclosureGrantId', v_claim.disclosure_grant_id,
			'capabilityId', v_material ->> 'capabilityId',
			'capabilityVersion', v_guarded_action ->> 'capabilityVersion',
			'capabilityFingerprint', v_material ->> 'capabilityFingerprint',
			'operation', v_guarded_action ->> 'operation',
			'actionHash', v_guarded_action ->> 'actionHash'
		) || CASE WHEN v_guarded_action ? 'targetBindingHash'
			THEN pg_catalog.jsonb_build_object(
				'targetBindingHash', v_guarded_action ->> 'targetBindingHash'
			)
			ELSE '{}'::jsonb END
	);
	RETURN v_expected_binding_hash IS NOT DISTINCT FROM
		p_expected_binding_hash
		AND v_expected_binding_hash IS NOT DISTINCT FROM
			v_guarded_action ->> 'executionBindingHash';
EXCEPTION
	WHEN invalid_text_representation OR invalid_datetime_format
		OR datetime_field_overflow OR numeric_value_out_of_range
	THEN
		RETURN false;
END
$function$;
--> statement-breakpoint

ALTER FUNCTION "emdo"."issue_workflow_operation_claim"(
	text, jsonb, uuid, uuid, text, text, text, jsonb
) RENAME TO issue_workflow_operation_claim_calendar;
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
	v_phase text;
	v_capability_id text;
	v_issued boolean;
	v_finance_guarded_authority jsonb;
	v_updated integer;
BEGIN
	-- Never honor a marker a runtime login set before entering this aggregate.
	PERFORM pg_catalog.set_config(
		'emdo.finance_guarded_action_authority', '', true
	);
	PERFORM pg_catalog.set_config(
		'emdo.finance_guarded_claim_verification', '', true
	);
	IF pg_catalog.jsonb_typeof(p_scope) = 'object'
		AND pg_catalog.jsonb_typeof(p_mutation) = 'object'
	THEN
		v_phase := p_scope ->> 'phase';
		v_capability_id := CASE WHEN v_phase = 'proposal-create'
			THEN p_mutation #>> '{proposal,capabilityId}'
			ELSE p_mutation #>> '{next,capabilityId}' END;
	END IF;
	IF v_capability_id IN (
		'finance.records.write', 'finance.statement.import'
	) THEN
		-- Finance has no provider-write prepare/dispatch authority here.
		IF v_phase NOT IN ('proposal-create', 'visual-decision')
			OR NOT emdo.lock_current_finance_guarded_action_authority(
				v_phase, p_scope, p_provider_authority_binding_hash, p_mutation
			)
		THEN
			RETURN false;
		END IF;
		v_finance_guarded_authority := pg_catalog.jsonb_build_object(
			'schemaVersion', 1,
			'capabilityId', v_capability_id,
			'capabilityFingerprint', CASE WHEN v_phase = 'proposal-create'
				THEN p_mutation #>> '{proposal,capabilityFingerprint}'
				ELSE p_mutation #>> '{next,capabilityFingerprint}' END,
			'guardedAction', CASE WHEN v_phase = 'proposal-create'
				THEN p_mutation #> '{proposal,guardedAction}'
				ELSE p_mutation #> '{next,guardedAction}' END
		);
		IF NOT emdo.finance_guarded_authority_material_is_valid(
			v_finance_guarded_authority,
			p_provider_authority_binding_hash
		) THEN
			RETURN false;
		END IF;
		PERFORM pg_catalog.set_config(
			'emdo.finance_guarded_action_authority',
			p_provider_authority_binding_hash, true
		);
		v_issued := emdo.issue_workflow_operation_claim_calendar(
			p_operation_id, p_scope, p_decision_id, p_provider_attempt_id,
			p_binding_hash, p_create_preparation_binding_hash,
			p_provider_authority_binding_hash, p_mutation
		);
		PERFORM pg_catalog.set_config(
			'emdo.finance_guarded_action_authority', '', true
		);
		IF v_issued IS DISTINCT FROM true THEN
			RETURN false;
		END IF;
		UPDATE emdo.workflow_operation_claims AS claim
		SET finance_guarded_authority = v_finance_guarded_authority
		WHERE claim.operation_id = p_operation_id
			AND claim.phase = v_phase
			AND claim.provider_authority_binding_hash =
				p_provider_authority_binding_hash
			AND (
				claim.finance_guarded_authority IS NULL
				OR claim.finance_guarded_authority = v_finance_guarded_authority
			);
		GET DIAGNOSTICS v_updated = ROW_COUNT;
		IF v_updated <> 1 THEN
			RAISE EXCEPTION USING
				ERRCODE = '55000',
				MESSAGE = 'finance guarded claim material could not be persisted';
		END IF;
		RETURN true;
	END IF;
	RETURN emdo.issue_workflow_operation_claim_calendar(
		p_operation_id, p_scope, p_decision_id, p_provider_attempt_id,
		p_binding_hash, p_create_preparation_binding_hash,
		p_provider_authority_binding_hash, p_mutation
	);
EXCEPTION WHEN OTHERS THEN
	PERFORM pg_catalog.set_config(
		'emdo.finance_guarded_action_authority', '', true
	);
	PERFORM pg_catalog.set_config(
		'emdo.finance_guarded_claim_verification', '', true
	);
	RAISE;
END
$function$;
--> statement-breakpoint

ALTER FUNCTION "emdo"."claim_workflow_operation_scope"(text)
	RENAME TO claim_workflow_operation_scope_calendar;
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
	v_claimed boolean;
BEGIN
	-- The marker is function-local and cannot be supplied by a runtime login.
	PERFORM pg_catalog.set_config(
		'emdo.finance_guarded_claim_verification', '', true
	);
	PERFORM pg_catalog.set_config(
		'emdo.finance_guarded_claim_verification', '1', true
	);
	v_claimed := emdo.claim_workflow_operation_scope_calendar(p_operation_id);
	PERFORM pg_catalog.set_config(
		'emdo.finance_guarded_claim_verification', '', true
	);
	RETURN v_claimed;
EXCEPTION WHEN OTHERS THEN
	PERFORM pg_catalog.set_config(
		'emdo.finance_guarded_claim_verification', '', true
	);
	RAISE;
END
$function$;
--> statement-breakpoint

ALTER FUNCTION "emdo"."finance_guarded_action_proposal_is_valid"(
	text, text, text, jsonb, jsonb
) OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."finance_guarded_authority_material_is_valid"(
	jsonb, text
) OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."lock_current_finance_guarded_action_authority"(
	text, jsonb, text, jsonb
) OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."lock_current_finance_guarded_claim_authority"(
	uuid, uuid, uuid, text, text
) OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."issue_workflow_operation_claim"(
	text, jsonb, uuid, uuid, text, text, text, jsonb
) OWNER TO emdo_workflow_executor;
ALTER FUNCTION "emdo"."claim_workflow_operation_scope"(text)
	OWNER TO emdo_workflow_executor;
REVOKE ALL ON FUNCTION
	"emdo"."finance_guarded_action_proposal_is_valid"(text, text, text, jsonb, jsonb),
	"emdo"."finance_guarded_authority_material_is_valid"(jsonb, text),
	"emdo"."lock_current_finance_guarded_action_authority"(text, jsonb, text, jsonb),
	"emdo"."lock_current_finance_guarded_claim_authority"(
		uuid, uuid, uuid, text, text
	),
	"emdo"."issue_workflow_operation_claim"(
		text, jsonb, uuid, uuid, text, text, text, jsonb
	),
	"emdo"."claim_workflow_operation_scope"(text)
FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login, emdo_visual_decision_login,
	emdo_proposal_reconciliation_executor, emdo_approval_resume_executor,
	emdo_proposal_query_executor, emdo_manager_turn_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."finance_guarded_action_proposal_is_valid"(text, text, text, jsonb, jsonb),
	"emdo"."finance_guarded_authority_material_is_valid"(jsonb, text),
	"emdo"."lock_current_finance_guarded_action_authority"(text, jsonb, text, jsonb),
	"emdo"."lock_current_finance_guarded_claim_authority"(
		uuid, uuid, uuid, text, text
	),
	"emdo"."issue_workflow_operation_claim"(
		text, jsonb, uuid, uuid, text, text, text, jsonb
	),
	"emdo"."claim_workflow_operation_scope"(text)
TO emdo_workflow_executor;
GRANT EXECUTE ON FUNCTION "emdo"."lock_current_finance_guarded_claim_authority"(
	uuid, uuid, uuid, text, text
) TO emdo_oauth_grant_executor;
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
			CASE WHEN (p_input -> 'proposal') ? 'guardedAction' THEN ARRAY[
				'schemaVersion', 'id', 'version', 'runId', 'capabilityId',
				'capabilityFingerprint', 'authorizationScopeFingerprint',
				'canonicalArguments', 'targets', 'beforePreview', 'afterPreview',
				'providerPreconditions', 'approvalDisplay',
				'providerAuthorityBindingHash', 'providerSdkCallId',
				'guardedAction', 'payloadHash', 'approvalHash',
				'disclosureGrant', 'createdAt', 'expiresAt', 'idempotencyKey',
				'state'
			]::text[] ELSE ARRAY[
				'schemaVersion', 'id', 'version', 'runId', 'capabilityId',
				'capabilityFingerprint', 'authorizationScopeFingerprint',
				'canonicalArguments', 'targets', 'beforePreview', 'afterPreview',
				'providerPreconditions', 'approvalDisplay',
				'providerAuthorityBindingHash', 'providerSdkCallId', 'payloadHash',
				'approvalHash', 'disclosureGrant', 'createdAt', 'expiresAt',
				'idempotencyKey', 'state'
			]::text[] END
		)
		OR NOT emdo.proposal_approval_display_is_valid(
			p_input #> '{proposal,approvalDisplay}'
		)
		OR ((p_input -> 'proposal') ? 'guardedAction'
			AND NOT emdo.finance_guarded_action_proposal_is_valid(
				p_input #>> '{proposal,capabilityId}',
				p_input #>> '{proposal,payloadHash}',
				p_input #>> '{proposal,providerAuthorityBindingHash}',
				p_input #> '{proposal,canonicalArguments}',
				p_input #> '{proposal,guardedAction}'
			))
		OR (p_input #>> '{proposal,capabilityId}' IN (
			'finance.records.write', 'finance.statement.import'
		) AND NOT ((p_input -> 'proposal') ? 'guardedAction'))
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
	IF NOT emdo.issue_workflow_operation_claim(
		p_operation_id, p_input -> 'scope', NULL, NULL, NULL,
		p_input #>> '{preparation,bindingHash}',
		p_input #>> '{proposal,providerAuthorityBindingHash}', p_input
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
			IS DISTINCT FROM v_claim.origin_space_access_grant_id::text
		OR p_input #>> '{preparation,binding,originSessionId}'
			IS DISTINCT FROM v_claim.origin_session_id::text
		OR p_input #>> '{preparation,binding,disclosureGrantId}' IS DISTINCT FROM
			v_claim.disclosure_grant_id::text
		OR p_input #>> '{preparation,binding,disclosurePolicyVersion}' !~
			'^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
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
		provider_preconditions, approval_display, guarded_action,
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
		p_input #> '{proposal,guardedAction}',
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
