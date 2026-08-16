import { z } from 'zod';

import { ActionProposalSchema } from './action.js';
import {
  DataClassSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  RiskClassSchema,
  SchemaVersionSchema,
  SemanticVersionSchema,
  UuidSchema,
  VersionedSchemaReferenceSchema,
  deepFreeze,
  type DeepReadonly,
  type RuntimeSchemaRegistry,
} from './capability.js';

export const ModelIdSchema = z.enum(['gpt-5.6-luna', 'gpt-5.6-terra']);

const ModelPolicySchema = z.strictObject({
  defaultModel: z.literal('gpt-5.6-luna'),
  complexModel: z.literal('gpt-5.6-terra'),
  escalationReasons: z
    .array(
      z.enum([
        'dependent-cross-domain',
        'failed-output-validation',
        'low-confidence-reconciliation',
        'luna-unavailable',
        'complex-reasoning',
      ]),
    )
    .min(1),
});

const ExecutionBudgetSchema = z.strictObject({
  maxTurns: z.number().int().positive().max(64),
  maxCapabilityCalls: z.number().int().nonnegative().max(128),
  maxParallelCalls: z.number().int().min(1).max(3),
  timeoutMs: z.number().int().positive().max(600_000),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
});

const AgentManifestBaseSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    id: IdentifierSchema,
    version: SemanticVersionSchema,
    kind: z.enum(['manager', 'specialist']),
    intents: z.array(IdentifierSchema).min(1).max(64),
    instructionIds: z.array(IdentifierSchema).min(1).max(64),
    skillIds: z.array(IdentifierSchema).min(1).max(64),
    capabilityAllowlist: z.array(IdentifierSchema).max(128),
    readableDataClasses: z.array(DataClassSchema).max(128),
    modelPolicy: ModelPolicySchema,
    executionBudget: ExecutionBudgetSchema,
    schemaRefs: z.strictObject({
      input: VersionedSchemaReferenceSchema,
      output: VersionedSchemaReferenceSchema,
    }),
    riskCeiling: RiskClassSchema,
    evalSuite: VersionedSchemaReferenceSchema,
  })
  .superRefine((value, context) => {
    for (const [path, values] of [
      ['intents', value.intents],
      ['instructionIds', value.instructionIds],
      ['skillIds', value.skillIds],
      ['capabilityAllowlist', value.capabilityAllowlist],
      ['readableDataClasses', value.readableDataClasses],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: 'custom',
          path: [path],
          message: `${path} must not contain duplicates`,
        });
      }
    }
  });

export const AgentManifestSchema =
  AgentManifestBaseSchema.transform(deepFreeze);
export type AgentManifest = DeepReadonly<
  z.input<typeof AgentManifestBaseSchema>
>;

const EvidenceSchema = z
  .strictObject({
    id: IdentifierSchema,
    source: IdentifierSchema,
    observedAt: IsoDateTimeSchema,
    upstreamAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
  })
  .superRefine((value, context) => {
    const upstreamAt = Date.parse(value.upstreamAt);
    const observedAt = Date.parse(value.observedAt);
    const expiresAt = Date.parse(value.expiresAt);
    if (upstreamAt > observedAt || observedAt > expiresAt) {
      context.addIssue({
        code: 'custom',
        path: ['observedAt'],
        message: 'Evidence freshness chronology is invalid',
      });
    }
  });

const DerivedValueSchema = z.strictObject({
  id: IdentifierSchema,
  value: JsonValueSchema,
  computation: IdentifierSchema,
  inputEvidenceIds: z.array(IdentifierSchema).min(1).max(128),
});

const UsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  modelCostCadMinor: z.number().int().safe().nonnegative(),
  capabilityCalls: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});

export const SafeErrorSchema = z.strictObject({
  code: IdentifierSchema,
  message: z.string().trim().min(1).max(500),
  retryable: z.boolean(),
});

const ResolvedModelResolutionSchema = z.strictObject({
  status: z.literal('resolved'),
  requestedModel: ModelIdSchema,
  resolvedModel: ModelIdSchema,
  reason: z.enum([
    'default',
    'dependent-cross-domain',
    'failed-output-validation',
    'low-confidence-reconciliation',
    'complex-reasoning',
    'luna-unavailable',
  ]),
});

const TerraFallbackModelResolutionSchema = z.strictObject({
  status: z.literal('resolved'),
  requestedModel: z.literal('gpt-5.6-terra'),
  resolvedModel: z.literal('gpt-5.6-luna'),
  reason: z.literal('terra-unavailable'),
  escalationTrigger: z.literal('complex-reasoning'),
});

const NoConfiguredModelResolutionSchema = z
  .strictObject({
    status: z.literal('unavailable'),
    requestedModel: ModelIdSchema,
    attemptedModels: z.array(ModelIdSchema).length(2),
    reason: z.literal('no-configured-model-available'),
    safeError: z.strictObject({
      code: z.literal('agent-model-unavailable'),
      message: z.literal(
        'AI is temporarily unavailable. Local features still work.',
      ),
      retryable: z.literal(true),
    }),
  })
  .superRefine((value, context) => {
    if (
      value.attemptedModels[0] !== value.requestedModel ||
      new Set(value.attemptedModels).size !== value.attemptedModels.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['attemptedModels'],
        message:
          'Unavailable model resolution must record the requested model first and each configured attempt once',
      });
    }
  });

const RequiredModelUnavailableSchema = z.strictObject({
  status: z.literal('unavailable'),
  requestedModel: z.literal('gpt-5.6-terra'),
  attemptedModels: z.tuple([z.literal('gpt-5.6-terra')]),
  reason: z.literal('required-complex-model-unavailable'),
  escalationTrigger: z.enum([
    'dependent-cross-domain',
    'failed-output-validation',
    'low-confidence-reconciliation',
    'luna-unavailable',
  ]),
  safeError: z.strictObject({
    code: z.literal('required-agent-model-unavailable'),
    message: z.literal(
      'The model required to complete this request safely is temporarily unavailable.',
    ),
    retryable: z.literal(true),
  }),
});

const ConfiguredEscalationDeniedSchema = z.strictObject({
  status: z.literal('unavailable'),
  requestedModel: z.literal('gpt-5.6-terra'),
  attemptedModels: z.tuple([]),
  reason: z.literal('configured-model-escalation-not-allowed'),
  escalationTrigger: z.enum([
    'dependent-cross-domain',
    'failed-output-validation',
    'low-confidence-reconciliation',
    'luna-unavailable',
    'complex-reasoning',
  ]),
  safeError: z.strictObject({
    code: z.literal('agent-model-escalation-not-allowed'),
    message: z.literal(
      'The active agent policy does not allow the required model escalation.',
    ),
    retryable: z.literal(false),
  }),
});

const ConfiguredFallbackDeniedSchema = z.strictObject({
  status: z.literal('unavailable'),
  requestedModel: z.literal('gpt-5.6-luna'),
  attemptedModels: z.tuple([z.literal('gpt-5.6-luna')]),
  reason: z.literal('configured-model-fallback-not-allowed'),
  safeError: z.strictObject({
    code: z.literal('agent-model-fallback-not-allowed'),
    message: z.literal(
      'The active agent policy does not allow a model fallback.',
    ),
    retryable: z.literal(false),
  }),
});

export const ModelResolutionSchema = z.union([
  ResolvedModelResolutionSchema,
  TerraFallbackModelResolutionSchema,
  NoConfiguredModelResolutionSchema,
  RequiredModelUnavailableSchema,
  ConfiguredEscalationDeniedSchema,
  ConfiguredFallbackDeniedSchema,
]);
export type ModelId = z.output<typeof ModelIdSchema>;
export type ModelResolution = DeepReadonly<
  z.output<typeof ModelResolutionSchema>
>;

const createAgentResultBaseSchema = <Output>(outputSchema: z.ZodType<Output>) =>
  z
    .strictObject({
      schemaVersion: SchemaVersionSchema,
      runId: UuidSchema,
      status: z.enum([
        'completed',
        'needs-approval',
        'blocked',
        'failed',
        'cancelled',
      ]),
      output: outputSchema.optional(),
      evidence: z.array(EvidenceSchema).max(512),
      derivedValues: z.array(DerivedValueSchema).max(256),
      actionProposals: z.array(ActionProposalSchema).max(64),
      usage: UsageSchema,
      modelResolution: ModelResolutionSchema,
      localTraceReference: IdentifierSchema,
      safeError: SafeErrorSchema.optional(),
    })
    .superRefine((value, context) => {
      if (value.status === 'failed' && value.safeError === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['safeError'],
          message: 'Failed agent results require a safe error',
        });
      }
      if (value.modelResolution.status === 'unavailable') {
        if (value.status !== 'failed') {
          context.addIssue({
            code: 'custom',
            path: ['status'],
            message: 'An unavailable model resolution requires a failed run',
          });
        }
        if (value.output !== undefined || value.actionProposals.length > 0) {
          context.addIssue({
            code: 'custom',
            path: ['modelResolution'],
            message:
              'An unavailable model cannot produce output or action proposals',
          });
        }
        if (
          value.safeError?.code !== value.modelResolution.safeError.code ||
          value.safeError.message !== value.modelResolution.safeError.message ||
          value.safeError.retryable !==
            value.modelResolution.safeError.retryable
        ) {
          context.addIssue({
            code: 'custom',
            path: ['safeError'],
            message:
              'The run safe error must match the unavailable model resolution',
          });
        }
      }
      const evidenceIds = new Set(value.evidence.map((item) => item.id));
      for (const [index, derived] of value.derivedValues.entries()) {
        if (derived.inputEvidenceIds.some((id) => !evidenceIds.has(id))) {
          context.addIssue({
            code: 'custom',
            path: ['derivedValues', index, 'inputEvidenceIds'],
            message: 'Derived value lineage references unknown evidence',
          });
        }
      }

      for (const [index, proposal] of value.actionProposals.entries()) {
        if (proposal.runId !== value.runId) {
          context.addIssue({
            code: 'custom',
            path: ['actionProposals', index, 'runId'],
            message: 'Action proposal run must match the agent result run',
          });
        }
        if (proposal.state !== 'pending') {
          context.addIssue({
            code: 'custom',
            path: ['actionProposals', index, 'state'],
            message: 'Agent-produced action proposals must be pending',
          });
        }
      }
    });

export const createAgentResultSchema = <Output>(
  outputSchema: z.ZodType<Output>,
) => createAgentResultBaseSchema(outputSchema).transform(deepFreeze);

export const AgentResultSchema = createAgentResultSchema(JsonValueSchema);

export const createAgentResultSchemaForManifest = <Output>(
  manifest: AgentManifest,
  runtimeSchemas: RuntimeSchemaRegistry,
) => {
  const outputSchema = runtimeSchemas.schema<Output>(
    manifest.schemaRefs.output,
  );
  return createAgentResultSchema(outputSchema);
};

export type AgentResult = DeepReadonly<z.output<typeof AgentResultSchema>>;
