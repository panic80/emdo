-- Approval resumes append to the same authenticated public run-event stream
-- as ordinary manager-turn completion. Keep the durable terminal CAS and
-- lineage unchanged, but emit the canonical public event vocabulary and the
-- same direct TurnResult payload shape used by complete_manager_turn.
-- This is intentionally private to the approval-resume executor: it is pure
-- JSONB validation only, so the security-definer settlement aggregate keeps
-- its table access and terminal CAS in one place.
CREATE OR REPLACE FUNCTION "emdo"."approval_resume_turn_result_is_valid"(
	p_result jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
	v_status text;
	v_usage jsonb;
	v_outcome jsonb;
	v_safe_error jsonb;
	v_model_resolution jsonb;
	v_input_tokens numeric;
	v_output_tokens numeric;
	v_model_cost_cad_minor numeric;
BEGIN
	IF p_result IS NULL
		OR pg_catalog.jsonb_typeof(p_result) IS DISTINCT FROM 'object'
		OR pg_catalog.octet_length(p_result::text) > 1400000
	THEN
		RETURN false;
	END IF;

	v_status := p_result ->> 'status';
	IF v_status = 'completed' THEN
		IF emdo.jsonb_object_has_exact_keys(
				p_result,
				ARRAY[
					'status', 'runId', 'localTraceReference', 'output',
					'specialistOutcomes', 'hasPartialFailures', 'usage',
					'modelResolution'
				]::text[]
			) IS DISTINCT FROM true
			OR pg_catalog.jsonb_typeof(
				p_result -> 'hasPartialFailures'
			) IS DISTINCT FROM 'boolean'
		THEN
			RETURN false;
		END IF;
	ELSIF v_status = 'failed' THEN
		IF emdo.jsonb_object_has_exact_keys(
				p_result,
				CASE WHEN p_result ? 'modelResolution' THEN ARRAY[
					'status', 'runId', 'localTraceReference', 'safeError',
					'specialistOutcomes', 'usage', 'modelResolution'
				]::text[] ELSE ARRAY[
					'status', 'runId', 'localTraceReference', 'safeError',
					'specialistOutcomes', 'usage'
				]::text[] END
			) IS DISTINCT FROM true
		THEN
			RETURN false;
		END IF;
	ELSE
		-- Approval resumes are terminal-only; nested approval is never valid.
		RETURN false;
	END IF;

	IF pg_catalog.jsonb_typeof(p_result -> 'runId') IS DISTINCT FROM 'string'
		OR pg_catalog.jsonb_typeof(
			p_result -> 'localTraceReference'
		) IS DISTINCT FROM 'string'
		OR (
			emdo.json_text_utf16_length(
				p_result ->> 'localTraceReference'
			) BETWEEN 1 AND 512
		) IS DISTINCT FROM true
		OR pg_catalog.btrim(p_result ->> 'localTraceReference')
			IS DISTINCT FROM p_result ->> 'localTraceReference'
		OR (p_result ->> 'localTraceReference') ~ '[[:cntrl:]]'
		OR pg_catalog.jsonb_typeof(
			p_result -> 'specialistOutcomes'
		) IS DISTINCT FROM 'array'
		OR pg_catalog.jsonb_array_length(
			p_result -> 'specialistOutcomes'
		) > 128
	THEN
		RETURN false;
	END IF;

	FOR v_outcome IN
		SELECT outcome.value
		FROM pg_catalog.jsonb_array_elements(
			p_result -> 'specialistOutcomes'
		) AS outcome(value)
	LOOP
		IF pg_catalog.jsonb_typeof(v_outcome) IS DISTINCT FROM 'object'
			OR emdo.jsonb_object_has_exact_keys(
				v_outcome,
				CASE
					WHEN v_outcome ? 'output' AND v_outcome ? 'safeError' THEN
						ARRAY[
							'delegationId', 'specialistId', 'status', 'output',
							'safeError', 'usage'
						]::text[]
					WHEN v_outcome ? 'output' THEN ARRAY[
						'delegationId', 'specialistId', 'status', 'output', 'usage'
					]::text[]
					WHEN v_outcome ? 'safeError' THEN ARRAY[
						'delegationId', 'specialistId', 'status', 'safeError', 'usage'
					]::text[]
					ELSE ARRAY[
						'delegationId', 'specialistId', 'status', 'usage'
					]::text[]
				END
			) IS DISTINCT FROM true
			OR pg_catalog.jsonb_typeof(
				v_outcome -> 'delegationId'
			) IS DISTINCT FROM 'string'
			OR (
				emdo.json_text_utf16_length(v_outcome ->> 'delegationId')
				BETWEEN 1 AND 512
			) IS DISTINCT FROM true
			OR pg_catalog.btrim(v_outcome ->> 'delegationId')
				IS DISTINCT FROM v_outcome ->> 'delegationId'
			OR (v_outcome ->> 'delegationId') ~ '[[:cntrl:]]'
			OR pg_catalog.jsonb_typeof(
				v_outcome -> 'specialistId'
			) IS DISTINCT FROM 'string'
			OR (
				emdo.json_text_utf16_length(v_outcome ->> 'specialistId')
				BETWEEN 1 AND 512
			) IS DISTINCT FROM true
			OR pg_catalog.btrim(v_outcome ->> 'specialistId')
				IS DISTINCT FROM v_outcome ->> 'specialistId'
				OR (v_outcome ->> 'specialistId') ~ '[[:cntrl:]]'
				OR pg_catalog.jsonb_typeof(
					v_outcome -> 'status'
				) IS DISTINCT FROM 'string'
				OR (v_outcome ->> 'status') NOT IN (
					'completed', 'failed', 'blocked'
				)
			OR (
				v_outcome ->> 'status' = 'failed'
				AND NOT (v_outcome ? 'safeError')
			)
		THEN
			RETURN false;
		END IF;
	END LOOP;

	FOR v_safe_error IN
		SELECT p_result -> 'safeError'
		WHERE p_result ? 'safeError'
		UNION ALL
		SELECT outcome.value -> 'safeError'
		FROM pg_catalog.jsonb_array_elements(
			p_result -> 'specialistOutcomes'
		) AS outcome(value)
		WHERE outcome.value ? 'safeError'
		UNION ALL
		SELECT (p_result -> 'modelResolution') -> 'safeError'
		WHERE p_result ? 'modelResolution'
			AND (p_result -> 'modelResolution') ? 'safeError'
	LOOP
		IF pg_catalog.jsonb_typeof(v_safe_error) IS DISTINCT FROM 'object'
			OR emdo.jsonb_object_has_exact_keys(
				v_safe_error, ARRAY['code', 'message', 'retryable']::text[]
			) IS DISTINCT FROM true
			OR pg_catalog.jsonb_typeof(
				v_safe_error -> 'code'
			) IS DISTINCT FROM 'string'
			OR (
				emdo.json_text_utf16_length(v_safe_error ->> 'code')
				BETWEEN 1 AND 256
			) IS DISTINCT FROM true
			OR pg_catalog.btrim(v_safe_error ->> 'code')
				IS DISTINCT FROM v_safe_error ->> 'code'
			OR (v_safe_error ->> 'code') ~ '[[:cntrl:]]'
			OR pg_catalog.jsonb_typeof(
				v_safe_error -> 'message'
			) IS DISTINCT FROM 'string'
			OR (
				emdo.json_text_utf16_length(v_safe_error ->> 'message')
				BETWEEN 1 AND 4096
			) IS DISTINCT FROM true
			OR pg_catalog.btrim(v_safe_error ->> 'message')
				IS DISTINCT FROM v_safe_error ->> 'message'
			OR (v_safe_error ->> 'message') ~ '[[:cntrl:]]'
			OR pg_catalog.jsonb_typeof(
				v_safe_error -> 'retryable'
			) IS DISTINCT FROM 'boolean'
		THEN
			RETURN false;
		END IF;
	END LOOP;

	FOR v_usage IN
		SELECT p_result -> 'usage'
		UNION ALL
		SELECT outcome.value -> 'usage'
		FROM pg_catalog.jsonb_array_elements(
			p_result -> 'specialistOutcomes'
		) AS outcome(value)
	LOOP
		IF pg_catalog.jsonb_typeof(v_usage) IS DISTINCT FROM 'object'
			OR emdo.jsonb_object_has_exact_keys(
				v_usage,
				CASE WHEN v_usage ? 'spendWarning' THEN ARRAY[
					'inputTokens', 'outputTokens', 'modelCostCadMinor', 'spendWarning'
				]::text[] ELSE ARRAY[
					'inputTokens', 'outputTokens', 'modelCostCadMinor'
				]::text[] END
			) IS DISTINCT FROM true
			OR pg_catalog.jsonb_typeof(
				v_usage -> 'inputTokens'
			) IS DISTINCT FROM 'number'
			OR pg_catalog.jsonb_typeof(
				v_usage -> 'outputTokens'
			) IS DISTINCT FROM 'number'
			OR pg_catalog.jsonb_typeof(
				v_usage -> 'modelCostCadMinor'
			) IS DISTINCT FROM 'number'
			OR pg_catalog.octet_length(v_usage ->> 'inputTokens') NOT BETWEEN 1 AND 64
			OR pg_catalog.octet_length(v_usage ->> 'outputTokens') NOT BETWEEN 1 AND 64
			OR pg_catalog.octet_length(
				v_usage ->> 'modelCostCadMinor'
			) NOT BETWEEN 1 AND 64
			OR (
				v_usage ? 'spendWarning'
				AND v_usage -> 'spendWarning' IS DISTINCT FROM 'true'::jsonb
			)
		THEN
			RETURN false;
		END IF;

		BEGIN
			v_input_tokens := (v_usage ->> 'inputTokens')::numeric;
			v_output_tokens := (v_usage ->> 'outputTokens')::numeric;
			v_model_cost_cad_minor :=
				(v_usage ->> 'modelCostCadMinor')::numeric;
		EXCEPTION
			WHEN data_exception THEN
				RETURN false;
		END;
		IF v_input_tokens < 0
			OR v_input_tokens > 9007199254740991::numeric
			OR v_input_tokens <> pg_catalog.trunc(v_input_tokens)
			OR v_output_tokens < 0
			OR v_output_tokens > 9007199254740991::numeric
			OR v_output_tokens <> pg_catalog.trunc(v_output_tokens)
			OR v_model_cost_cad_minor < 0
			OR v_model_cost_cad_minor > 9007199254740991::numeric
			OR v_model_cost_cad_minor <> pg_catalog.trunc(
				v_model_cost_cad_minor
			)
		THEN
			RETURN false;
		END IF;
	END LOOP;

	v_model_resolution := p_result -> 'modelResolution';
	IF v_status = 'completed' THEN
		IF pg_catalog.jsonb_typeof(v_model_resolution) IS DISTINCT FROM 'object'
			OR (
				(
					emdo.jsonb_object_has_exact_keys(
						v_model_resolution,
						ARRAY[
							'status', 'requestedModel', 'resolvedModel', 'reason'
						]::text[]
						)
						AND v_model_resolution ->> 'status' = 'resolved'
						AND v_model_resolution ->> 'requestedModel' IN (
							'gpt-5.6-luna', 'gpt-5.6-terra'
						)
						AND v_model_resolution ->> 'resolvedModel' IN (
							'gpt-5.6-luna', 'gpt-5.6-terra'
						)
						AND v_model_resolution ->> 'reason' IN (
							'default', 'dependent-cross-domain',
							'failed-output-validation',
							'low-confidence-reconciliation', 'complex-reasoning',
							'luna-unavailable'
						)
					) OR (
						emdo.jsonb_object_has_exact_keys(
						v_model_resolution,
						ARRAY[
							'status', 'requestedModel', 'resolvedModel', 'reason',
							'escalationTrigger'
						]::text[]
						)
						AND v_model_resolution ->> 'status' = 'resolved'
						AND v_model_resolution ->> 'requestedModel' = 'gpt-5.6-terra'
						AND v_model_resolution ->> 'resolvedModel' = 'gpt-5.6-luna'
						AND v_model_resolution ->> 'reason' = 'terra-unavailable'
						AND v_model_resolution ->> 'escalationTrigger' =
							'complex-reasoning'
					)
			) IS DISTINCT FROM true
		THEN
			RETURN false;
		END IF;
	ELSIF p_result ? 'modelResolution' THEN
		IF pg_catalog.jsonb_typeof(v_model_resolution) IS DISTINCT FROM 'object'
			OR (
				(
					emdo.jsonb_object_has_exact_keys(
						v_model_resolution,
						ARRAY[
							'status', 'requestedModel', 'resolvedModel', 'reason'
						]::text[]
						)
						AND v_model_resolution ->> 'status' = 'resolved'
						AND v_model_resolution ->> 'requestedModel' IN (
							'gpt-5.6-luna', 'gpt-5.6-terra'
						)
						AND v_model_resolution ->> 'resolvedModel' IN (
							'gpt-5.6-luna', 'gpt-5.6-terra'
						)
						AND v_model_resolution ->> 'reason' IN (
							'default', 'dependent-cross-domain',
							'failed-output-validation',
							'low-confidence-reconciliation', 'complex-reasoning',
							'luna-unavailable'
						)
					) OR (
						emdo.jsonb_object_has_exact_keys(
						v_model_resolution,
						ARRAY[
							'status', 'requestedModel', 'resolvedModel', 'reason',
							'escalationTrigger'
						]::text[]
						)
						AND v_model_resolution ->> 'status' = 'resolved'
						AND v_model_resolution ->> 'requestedModel' = 'gpt-5.6-terra'
						AND v_model_resolution ->> 'resolvedModel' = 'gpt-5.6-luna'
						AND v_model_resolution ->> 'reason' = 'terra-unavailable'
						AND v_model_resolution ->> 'escalationTrigger' =
							'complex-reasoning'
					) OR (
						emdo.jsonb_object_has_exact_keys(
						v_model_resolution,
						ARRAY[
							'status', 'requestedModel', 'attemptedModels', 'reason',
							'safeError'
						]::text[]
						)
						AND v_model_resolution ->> 'status' = 'unavailable'
						AND v_model_resolution ->> 'requestedModel' IN (
							'gpt-5.6-luna', 'gpt-5.6-terra'
						)
						AND pg_catalog.jsonb_typeof(
							v_model_resolution -> 'attemptedModels'
						) = 'array'
						AND pg_catalog.jsonb_array_length(
							v_model_resolution -> 'attemptedModels'
						) = 2
						AND v_model_resolution #>> '{attemptedModels,0}' =
							v_model_resolution ->> 'requestedModel'
						AND v_model_resolution #>> '{attemptedModels,0}' IN (
							'gpt-5.6-luna', 'gpt-5.6-terra'
						)
						AND v_model_resolution #>> '{attemptedModels,1}' IN (
							'gpt-5.6-luna', 'gpt-5.6-terra'
						)
						AND v_model_resolution #>> '{attemptedModels,0}' IS DISTINCT FROM
							v_model_resolution #>> '{attemptedModels,1}'
						AND v_model_resolution ->> 'reason' =
							'no-configured-model-available'
						AND emdo.jsonb_object_has_exact_keys(
							v_model_resolution -> 'safeError',
							ARRAY['code', 'message', 'retryable']::text[]
						)
						AND v_model_resolution #>> '{safeError,code}' =
							'agent-model-unavailable'
						AND v_model_resolution #>> '{safeError,message}' =
							'AI is temporarily unavailable. Local features still work.'
						AND v_model_resolution #> '{safeError,retryable}' =
							'true'::jsonb
					) OR (
						emdo.jsonb_object_has_exact_keys(
						v_model_resolution,
						ARRAY[
							'status', 'requestedModel', 'attemptedModels', 'reason',
							'escalationTrigger', 'safeError'
						]::text[]
						)
						AND v_model_resolution ->> 'status' = 'unavailable'
						AND v_model_resolution ->> 'requestedModel' = 'gpt-5.6-terra'
						AND pg_catalog.jsonb_typeof(
							v_model_resolution -> 'attemptedModels'
						) = 'array'
						AND pg_catalog.jsonb_array_length(
							v_model_resolution -> 'attemptedModels'
						) = 1
						AND v_model_resolution #>> '{attemptedModels,0}' =
							'gpt-5.6-terra'
						AND v_model_resolution ->> 'reason' =
							'required-complex-model-unavailable'
						AND v_model_resolution ->> 'escalationTrigger' IN (
							'dependent-cross-domain', 'failed-output-validation',
							'low-confidence-reconciliation', 'luna-unavailable'
						)
						AND emdo.jsonb_object_has_exact_keys(
							v_model_resolution -> 'safeError',
							ARRAY['code', 'message', 'retryable']::text[]
						)
						AND v_model_resolution #>> '{safeError,code}' =
							'required-agent-model-unavailable'
						AND v_model_resolution #>> '{safeError,message}' =
							'The model required to complete this request safely is temporarily unavailable.'
						AND v_model_resolution #> '{safeError,retryable}' =
							'true'::jsonb
					) OR (
						emdo.jsonb_object_has_exact_keys(
						v_model_resolution,
						ARRAY[
							'status', 'requestedModel', 'attemptedModels', 'reason',
							'escalationTrigger', 'safeError'
						]::text[]
						)
						AND v_model_resolution ->> 'status' = 'unavailable'
						AND v_model_resolution ->> 'requestedModel' = 'gpt-5.6-terra'
						AND pg_catalog.jsonb_typeof(
							v_model_resolution -> 'attemptedModels'
						) = 'array'
						AND pg_catalog.jsonb_array_length(
							v_model_resolution -> 'attemptedModels'
						) = 0
						AND v_model_resolution ->> 'reason' =
							'configured-model-escalation-not-allowed'
						AND v_model_resolution ->> 'escalationTrigger' IN (
							'dependent-cross-domain', 'failed-output-validation',
							'low-confidence-reconciliation', 'luna-unavailable',
							'complex-reasoning'
						)
						AND emdo.jsonb_object_has_exact_keys(
							v_model_resolution -> 'safeError',
							ARRAY['code', 'message', 'retryable']::text[]
						)
						AND v_model_resolution #>> '{safeError,code}' =
							'agent-model-escalation-not-allowed'
						AND v_model_resolution #>> '{safeError,message}' =
							'The active agent policy does not allow the required model escalation.'
						AND v_model_resolution #> '{safeError,retryable}' =
							'false'::jsonb
					) OR (
						emdo.jsonb_object_has_exact_keys(
						v_model_resolution,
						ARRAY[
							'status', 'requestedModel', 'attemptedModels', 'reason',
							'safeError'
						]::text[]
						)
						AND v_model_resolution ->> 'status' = 'unavailable'
						AND v_model_resolution ->> 'requestedModel' = 'gpt-5.6-luna'
						AND pg_catalog.jsonb_typeof(
							v_model_resolution -> 'attemptedModels'
						) = 'array'
						AND pg_catalog.jsonb_array_length(
							v_model_resolution -> 'attemptedModels'
						) = 1
						AND v_model_resolution #>> '{attemptedModels,0}' =
							'gpt-5.6-luna'
						AND v_model_resolution ->> 'reason' =
							'configured-model-fallback-not-allowed'
						AND emdo.jsonb_object_has_exact_keys(
							v_model_resolution -> 'safeError',
							ARRAY['code', 'message', 'retryable']::text[]
						)
						AND v_model_resolution #>> '{safeError,code}' =
							'agent-model-fallback-not-allowed'
						AND v_model_resolution #>> '{safeError,message}' =
							'The active agent policy does not allow a model fallback.'
						AND v_model_resolution #> '{safeError,retryable}' =
							'false'::jsonb
					)
			) IS DISTINCT FROM true
		THEN
			RETURN false;
		END IF;
	END IF;

	RETURN true;
END
$function$;
--> statement-breakpoint
ALTER FUNCTION "emdo"."approval_resume_turn_result_is_valid"(jsonb)
	OWNER TO emdo_approval_resume_executor;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
	"emdo"."approval_resume_turn_result_is_valid"(jsonb)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login,
	emdo_proposal_reconciliation_executor, emdo_approval_resume_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."approval_resume_turn_result_is_valid"(jsonb)
	TO emdo_approval_resume_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."jsonb_object_has_exact_keys"(jsonb, text[]),
	"emdo"."json_text_utf16_length"(text)
	TO emdo_approval_resume_executor;
--> statement-breakpoint

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
	v_terminal_audit_payload jsonb;
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
					OR emdo.approval_resume_turn_result_is_valid(p_result)
						IS DISTINCT FROM true
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
		WHEN 'complete' THEN CASE p_result ->> 'status'
			WHEN 'completed' THEN 'run.completed'
			ELSE 'run.failed'
		END
		ELSE 'run.failed'
	END;
	v_event_payload := CASE
		WHEN p_mode = 'complete' THEN p_result
		WHEN p_mode = 'terminalize-not-dispatched' THEN
			pg_catalog.jsonb_build_object(
				'status', 'failed',
				'runId', v_job.run_id,
				'localTraceReference',
					'approval-resume-terminalized-before-dispatch',
				'safeError', pg_catalog.jsonb_build_object(
					'code', 'approval-resume-binding-invalid',
					'message',
						'The approved action could not be resumed safely.',
					'retryable', false
				),
				'specialistOutcomes', '[]'::jsonb,
				'usage', pg_catalog.jsonb_build_object(
					'inputTokens', 0,
					'outputTokens', 0,
					'modelCostCadMinor', 0
				)
			)
		ELSE pg_catalog.jsonb_build_object(
			'status', 'failed',
			'runId', v_job.run_id,
			'localTraceReference', 'approval-resume-indeterminate',
			'safeError', pg_catalog.jsonb_build_object(
				'code', 'approval-resume-failed',
				'message',
					'The approved action could not be completed safely.',
				'retryable', false
			),
			'specialistOutcomes', '[]'::jsonb,
			'usage', pg_catalog.jsonb_build_object(
				'inputTokens', 0,
				'outputTokens', 0,
				'modelCostCadMinor', 0
			)
		)
	END;
	-- Preserve the established terminal lineage hash domain independently of
	-- the canonical public event representation.
	v_terminal_audit_payload := pg_catalog.jsonb_strip_nulls(
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
				|| pg_catalog.convert_to(v_terminal_audit_payload::text, 'UTF8')
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
ALTER FUNCTION "emdo"."settle_approval_resume_job"(
	uuid, text, text, text, jsonb
) OWNER TO emdo_approval_resume_executor;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
	"emdo"."settle_approval_resume_job"(uuid, text, text, text, jsonb)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login,
	emdo_proposal_reconciliation_executor, emdo_approval_resume_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."settle_approval_resume_job"(uuid, text, text, text, jsonb)
	TO emdo_app;
--> statement-breakpoint

-- Existing 90-day replay rows keep their immutable audit representation.
-- Normalize only the bounded authorized projection until those legacy rows
-- expire; canonical rows written above pass through unchanged.
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
	), normalized AS (
		SELECT bounded.sequence, bounded.occurred_at,
			CASE bounded.event_type
				WHEN 'agent.turn.completed' THEN 'run.completed'
				WHEN 'agent.turn.needs-approval' THEN 'run.failed'
				WHEN 'agent.turn.failed' THEN 'run.failed'
				WHEN 'agent.turn.indeterminate' THEN 'run.failed'
				ELSE bounded.event_type
			END AS event_type,
			CASE
				WHEN bounded.event_type = 'agent.turn.needs-approval' THEN
					pg_catalog.jsonb_build_object(
						'status', 'failed',
						'runId', p_run_id,
						'localTraceReference',
							'approval-resume-nested-approval-unsupported',
						'safeError', pg_catalog.jsonb_build_object(
							'code',
								'approval-resume-nested-approval-unsupported',
							'message',
								'A second approval requires a new EMDO turn.',
							'retryable', false
						),
						'specialistOutcomes', '[]'::jsonb,
						'usage', pg_catalog.jsonb_build_object(
							'inputTokens', 0,
							'outputTokens', 0,
							'modelCostCadMinor', 0
						)
					)
				WHEN bounded.event_type IN (
					'agent.turn.completed',
					'agent.turn.failed'
				)
					AND pg_catalog.jsonb_typeof(
						bounded.payload -> 'result'
					) = 'object'
				THEN bounded.payload -> 'result'
				WHEN bounded.event_type = 'agent.turn.failed' THEN
					pg_catalog.jsonb_build_object(
						'status', 'failed',
						'runId', p_run_id,
						'localTraceReference',
							'approval-resume-terminalized-before-dispatch',
						'safeError', pg_catalog.jsonb_build_object(
							'code', 'approval-resume-binding-invalid',
							'message',
								'The approved action could not be resumed safely.',
							'retryable', false
						),
						'specialistOutcomes', '[]'::jsonb,
						'usage', pg_catalog.jsonb_build_object(
							'inputTokens', 0,
							'outputTokens', 0,
							'modelCostCadMinor', 0
						)
					)
				WHEN bounded.event_type = 'agent.turn.indeterminate' THEN
					pg_catalog.jsonb_build_object(
						'status', 'failed',
						'runId', p_run_id,
						'localTraceReference',
							'approval-resume-indeterminate',
						'safeError', pg_catalog.jsonb_build_object(
							'code', 'approval-resume-failed',
							'message',
								'The approved action could not be completed safely.',
							'retryable', false
						),
						'specialistOutcomes', '[]'::jsonb,
						'usage', pg_catalog.jsonb_build_object(
							'inputTokens', 0,
							'outputTokens', 0,
							'modelCostCadMinor', 0
						)
					)
				ELSE bounded.payload
			END AS payload
		FROM bounded
	), projected AS (
		SELECT pg_catalog.jsonb_build_object(
			'schemaVersion', 1,
			'runId', p_run_id,
			'sequence', normalized.sequence,
			'type', normalized.event_type,
			'occurredAt', normalized.occurred_at,
			'data', normalized.payload
		) AS event,
		normalized.sequence
		FROM normalized
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
ALTER FUNCTION "emdo"."read_agent_run_events"(
	uuid, uuid, bigint, integer
) OWNER TO emdo_manager_turn_executor;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
	"emdo"."read_agent_run_events"(uuid, uuid, bigint, integer)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader, emdo_metering_executor, emdo_worker_executor,
	emdo_worker_dispatch_executor, emdo_worker_scope_executor,
	emdo_oauth_flow_executor, emdo_space_grant_executor,
	emdo_disclosure_executor, emdo_visual_proof_executor,
	emdo_workflow_executor, emdo_workflow_login,
	emdo_approval_resume_executor, emdo_proposal_reconciliation_executor,
	emdo_proposal_query_executor, emdo_manager_turn_executor;
GRANT EXECUTE ON FUNCTION
	"emdo"."read_agent_run_events"(uuid, uuid, bigint, integer)
	TO emdo_app;
