import { z } from 'zod';

import {
  IdentifierSchema,
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  SchemaVersionSchema,
  SemanticVersionSchema,
  Sha256Schema,
  UuidSchema,
  VersionedSchemaReferenceSchema,
  deepFreeze,
  type DeepReadonly,
  type JsonValue,
  type VersionedSchemaReference,
} from './primitives.js';

export * from './primitives.js';

/** Server-derived stable scope binding; callers may compare but never mint it. */
export const EffectiveAuthorizationScopeFingerprintSchema =
  Sha256Schema.brand<'EffectiveAuthorizationScopeFingerprint'>();

export type EffectiveAuthorizationScopeFingerprint = z.infer<
  typeof EffectiveAuthorizationScopeFingerprintSchema
>;

export const DataClassSchema = IdentifierSchema;
export const ScopeSchema = IdentifierSchema;

export const RiskClassSchema = z.enum([
  'none',
  'read',
  'local-write',
  'provider-write',
]);

export const CapabilityKindSchema = z.enum([
  'delegation',
  'read',
  'local-write',
  'provider-write',
  'import',
]);

declare const providerWriteCapabilityIdBrand: unique symbol;

/**
 * Nominal identifier granted only by validated provider-write descriptor
 * parsing. It remains a primitive string at runtime and on every wire.
 */
export type ProviderWriteCapabilityId = string & {
  readonly [providerWriteCapabilityIdBrand]: 'provider-write-capability-id';
};

const FreshnessPolicySchema = z.strictObject({
  required: z.boolean(),
  maxAgeMs: z.number().int().nonnegative().max(86_400_000),
  revalidateBeforeExecution: z.boolean(),
});

const IdempotencyPolicySchema = z.strictObject({
  required: z.boolean(),
  scope: z.enum(['request', 'actor', 'provider-target']),
  ttlMs: z.number().int().nonnegative().max(31_536_000_000),
});

export const ApprovalRuleSchema = z.strictObject({
  rule: z.enum(['none', 'authenticated-visual-proposal', 'forbidden']),
  expiresInSeconds: z.number().int().nonnegative().max(600),
});

const AuditPolicySchema = z.strictObject({
  required: z.boolean(),
  eventType: IdentifierSchema,
  redactFields: z.array(IdentifierSchema).max(64),
});

const CapabilityDescriptorBaseSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  id: IdentifierSchema,
  version: SemanticVersionSchema,
  capabilityKind: CapabilityKindSchema,
  inputSchema: VersionedSchemaReferenceSchema,
  outputSchema: VersionedSchemaReferenceSchema,
  requiredScopes: z.array(ScopeSchema).max(32),
  requiredDataClasses: z.array(DataClassSchema).max(32),
  riskClass: RiskClassSchema,
  timeoutMs: z.number().int().positive().max(120_000),
  freshness: FreshnessPolicySchema,
  idempotency: IdempotencyPolicySchema,
  approval: ApprovalRuleSchema,
  audit: AuditPolicySchema,
  executorId: IdentifierSchema,
});

type CapabilityDescriptorFields = DeepReadonly<
  z.input<typeof CapabilityDescriptorBaseSchema>
>;

export type StandardCapabilityDescriptor = Omit<
  CapabilityDescriptorFields,
  'capabilityKind'
> & {
  readonly capabilityKind: Exclude<
    z.output<typeof CapabilityKindSchema>,
    'provider-write'
  >;
};

export type ProviderWriteCapabilityDescriptor = Omit<
  CapabilityDescriptorFields,
  'id' | 'capabilityKind' | 'riskClass'
> & {
  readonly id: ProviderWriteCapabilityId;
  readonly capabilityKind: 'provider-write';
  readonly riskClass: 'provider-write';
};

export type CapabilityDescriptor =
  StandardCapabilityDescriptor | ProviderWriteCapabilityDescriptor;

export const CapabilityDescriptorSchema =
  CapabilityDescriptorBaseSchema.superRefine((value, context) => {
    const expectedRisk = {
      delegation: 'none',
      read: 'read',
      'local-write': 'local-write',
      'provider-write': 'provider-write',
      import: 'local-write',
    } as const;
    if (value.riskClass !== expectedRisk[value.capabilityKind]) {
      context.addIssue({
        code: 'custom',
        path: ['riskClass'],
        message: 'Capability risk class does not match its capability kind',
      });
    }
    if (
      value.approval.rule === 'none' &&
      value.approval.expiresInSeconds !== 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['approval', 'expiresInSeconds'],
        message: 'An unapproved capability cannot have an approval expiry',
      });
    }
    if (
      value.approval.rule === 'authenticated-visual-proposal' &&
      value.approval.expiresInSeconds === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['approval', 'expiresInSeconds'],
        message: 'Visual approval must have a positive expiry',
      });
    }
    if (value.capabilityKind === 'provider-write') {
      if (
        !value.freshness.required ||
        !value.freshness.revalidateBeforeExecution
      ) {
        context.addIssue({
          code: 'custom',
          path: ['freshness'],
          message:
            'Provider writes require freshness and execution-time revalidation',
        });
      }
      if (
        !value.idempotency.required ||
        value.idempotency.scope !== 'provider-target'
      ) {
        context.addIssue({
          code: 'custom',
          path: ['idempotency'],
          message:
            'Provider writes require provider-target idempotency protection',
        });
      }
      const minimumIdempotencyTtlMs =
        value.approval.expiresInSeconds * 1000 + value.timeoutMs;
      if (value.idempotency.ttlMs < minimumIdempotencyTtlMs) {
        context.addIssue({
          code: 'custom',
          path: ['idempotency', 'ttlMs'],
          message:
            'Provider idempotency TTL must cover the approval window and execution recovery timeout',
        });
      }
      if (!value.audit.required) {
        context.addIssue({
          code: 'custom',
          path: ['audit', 'required'],
          message: 'Provider writes require an audit record',
        });
      }
    }
  }).transform((value): CapabilityDescriptor => {
    const validated = deepFreeze(value);
    if (validated.capabilityKind === 'provider-write') {
      // The nominal type is minted only after the complete descriptor policy
      // above has validated the high-risk branch.
      return validated as ProviderWriteCapabilityDescriptor;
    }
    return validated as StandardCapabilityDescriptor;
  });

export const parseProviderWriteCapabilityDescriptor = (
  value: unknown,
): ProviderWriteCapabilityDescriptor => {
  const descriptor = CapabilityDescriptorSchema.parse(value);
  if (descriptor.capabilityKind !== 'provider-write') {
    throw new TypeError('Expected a provider-write capability descriptor');
  }
  return descriptor;
};

export const CadMoneySchema = z
  .strictObject({
    minorUnits: z.number().int().safe().nonnegative(),
    currency: z.literal('CAD'),
  })
  .transform(deepFreeze);

export type CadMoney = DeepReadonly<z.input<typeof CadMoneySchema>>;

export interface CapabilityInvocationContext {
  readonly requestId: string;
  readonly runId: string;
  readonly userId: string;
  readonly householdId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly spaceAccessGrantId: string;
  readonly disclosureGrantId?: string;
  readonly approvalDecisionId?: string;
  readonly abortSignal: AbortSignal;
}

const GoogleCalendarGrantAuthorityBindingSchema = z.strictObject({
  kind: z.literal('google-calendar-grant-v2'),
  householdId: UuidSchema,
  privateSpaceId: UuidSchema,
  authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprintSchema,
  providerGrantReference: OpaqueReferenceSchema,
  authorizationEpoch: z.number().int().safe().nonnegative(),
});

/**
 * Closed, server-derived authority for an external provider write. OAuth
 * secrets never enter this value; reconnecting rotates the reference/epoch.
 */
export const ProviderWriteAuthorityBindingSchema =
  GoogleCalendarGrantAuthorityBindingSchema.transform(deepFreeze);

export type ProviderWriteAuthorityBinding = DeepReadonly<
  z.output<typeof GoogleCalendarGrantAuthorityBindingSchema>
>;

const ProviderWriteOperationScopeBaseSchema = z.strictObject({
  requestId: UuidSchema,
  sessionId: UuidSchema,
  householdId: UuidSchema,
  userId: UuidSchema,
  spaceAccessGrantId: UuidSchema,
  authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprintSchema,
});

export const ProviderWriteOperationScopeSchema =
  ProviderWriteOperationScopeBaseSchema.transform(deepFreeze);

export type ProviderWriteOperationScope = DeepReadonly<
  z.output<typeof ProviderWriteOperationScopeBaseSchema>
>;

const TrustedProviderWriteAuthorityResolutionBaseSchema = z
  .strictObject({
    authorityBinding: ProviderWriteAuthorityBindingSchema,
    operationScope: ProviderWriteOperationScopeSchema,
  })
  .superRefine((value, context) => {
    if (
      value.operationScope.householdId !== value.authorityBinding.householdId ||
      value.operationScope.authorizationScopeFingerprint !==
        value.authorityBinding.authorizationScopeFingerprint
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Provider authority resolution scope does not match',
      });
    }
  });

export const TrustedProviderWriteAuthorityResolutionSchema =
  TrustedProviderWriteAuthorityResolutionBaseSchema.transform(deepFreeze);

export type TrustedProviderWriteAuthorityResolution = DeepReadonly<
  z.output<typeof TrustedProviderWriteAuthorityResolutionBaseSchema>
>;

const ProviderWriteApprovalBindingBaseSchema = z.strictObject({
  decisionId: UuidSchema,
  userId: UuidSchema,
  agentId: IdentifierSchema,
  runId: UuidSchema,
  capabilityId: IdentifierSchema,
  capabilityFingerprint: Sha256Schema,
  disclosureGrantId: UuidSchema,
  payloadHash: Sha256Schema,
  idempotencyTtlMs: z.number().int().positive().safe().max(31_536_000_000),
  authorityBinding: ProviderWriteAuthorityBindingSchema,
});

export const ProviderWriteApprovalBindingSchema =
  ProviderWriteApprovalBindingBaseSchema.transform(deepFreeze);

export type ProviderWriteApprovalBinding = DeepReadonly<
  z.output<typeof ProviderWriteApprovalBindingBaseSchema>
>;

const ProviderWriteAuthorizationBaseSchema = z
  .strictObject({
    proposalId: UuidSchema,
    approvalHash: Sha256Schema,
    approvalBindingHash: Sha256Schema,
    capabilityFingerprint: Sha256Schema,
    proposalCreatedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    disclosureGrantId: UuidSchema,
    disclosureGrantHash: Sha256Schema,
    approvalBinding: ProviderWriteApprovalBindingSchema,
    providerIdempotencyKey: Sha256Schema,
    idempotencyExpiresAt: IsoDateTimeSchema,
    attemptId: UuidSchema,
    attemptVersion: z.number().int().positive().safe(),
    issuedAt: IsoDateTimeSchema,
    targets: z
      .array(
        z.strictObject({
          kind: IdentifierSchema,
          id: OpaqueReferenceSchema,
          expectedVersion: z.string().trim().min(1).max(512),
        }),
      )
      .min(1)
      .max(64),
    providerPreconditions: z
      .array(
        z.strictObject({
          kind: IdentifierSchema,
          targetId: OpaqueReferenceSchema,
          expectedValue: z.string().min(1).max(2048),
        }),
      )
      .max(64),
  })
  .superRefine((value, context) => {
    if (
      value.approvalBinding.capabilityFingerprint !==
      value.capabilityFingerprint
    ) {
      context.addIssue({
        code: 'custom',
        path: ['approvalBinding', 'capabilityFingerprint'],
        message: 'Approval binding capability does not match the permit',
      });
    }
    if (value.approvalBinding.disclosureGrantId !== value.disclosureGrantId) {
      context.addIssue({
        code: 'custom',
        path: ['approvalBinding', 'disclosureGrantId'],
        message: 'Approval binding disclosure grant does not match the permit',
      });
    }
    if (Date.parse(value.proposalCreatedAt) > Date.parse(value.issuedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['issuedAt'],
        message: 'Provider write permit cannot predate its proposal',
      });
    }
    if (Date.parse(value.issuedAt) >= Date.parse(value.expiresAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Provider write permit must be issued before approval expiry',
      });
    }
    if (Date.parse(value.idempotencyExpiresAt) <= Date.parse(value.issuedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['idempotencyExpiresAt'],
        message: 'Provider idempotency protection must outlive permit issuance',
      });
    }
  });

export const ProviderWriteAuthorizationSchema =
  ProviderWriteAuthorizationBaseSchema.transform(deepFreeze);

export type ProviderWriteAuthorization = DeepReadonly<
  z.output<typeof ProviderWriteAuthorizationBaseSchema>
>;

export interface ProviderWriteCapabilityContext extends Omit<
  CapabilityInvocationContext,
  'spaceAccessGrantId' | 'disclosureGrantId' | 'approvalDecisionId'
> {
  readonly providerWritePermit: ProviderWriteAuthorization;
  readonly providerWriteOperationScope: ProviderWriteOperationScope;
}

export const ProviderCommitOutcomeSchema = z.discriminatedUnion('application', [
  z.strictObject({
    application: z.literal('applied'),
    output: z.unknown(),
    evidence: z.unknown().optional(),
  }),
  z.strictObject({
    application: z.literal('not-applied'),
    reason: z.enum([
      'approval-expired-before-dispatch',
      'approval-policy-mismatch',
      'provider-precondition-failed',
      'provider-rejected-before-apply',
    ]),
    evidence: z.unknown().optional(),
  }),
  z.strictObject({
    application: z.literal('indeterminate'),
    reason: z.enum([
      'timeout-after-dispatch',
      'transport-lost-after-dispatch',
      'executor-threw-after-dispatch-boundary',
      'provider-outcome-envelope-invalid',
    ]),
    evidence: z.unknown().optional(),
  }),
]);

export type ProviderCommitOutcome<Output = unknown> =
  | {
      readonly application: 'applied';
      readonly output: Output;
      readonly evidence?: JsonValue;
    }
  | {
      readonly application: 'not-applied';
      readonly reason:
        | 'approval-expired-before-dispatch'
        | 'approval-policy-mismatch'
        | 'provider-precondition-failed'
        | 'provider-rejected-before-apply';
      readonly evidence?: JsonValue;
    }
  | {
      readonly application: 'indeterminate';
      readonly reason:
        | 'timeout-after-dispatch'
        | 'transport-lost-after-dispatch'
        | 'executor-threw-after-dispatch-boundary'
        | 'provider-outcome-envelope-invalid';
      readonly evidence?: JsonValue;
    };

export interface ProviderWriteSafetyContract {
  readonly atomicConditions: 'provider-native-single-request';
  readonly idempotency: 'provider-key' | 'deterministic-resource-id';
  /** All automatic mutation retries stay inside one approved invocation. */
  readonly retryOwnership: 'adapter-bounded-within-invocation';
  readonly reconciliation: 'required';
}

export type CapabilityExecutor<Input, Output> = (
  input: DeepReadonly<Input>,
  context: CapabilityInvocationContext,
) => Promise<Output>;

/**
 * Dispatches one provider-native conditional/idempotent mutation. Automatic
 * retries remain bounded inside this invocation and reuse the permit key.
 */
export type ProviderWriteCapabilityExecutor<Input, Output> = (
  input: DeepReadonly<Input>,
  context: ProviderWriteCapabilityContext,
) => Promise<ProviderCommitOutcome<Output>>;

export interface StandardRegisteredCapability<
  Input = unknown,
  Output = unknown,
> {
  readonly descriptor: StandardCapabilityDescriptor;
  readonly execute: CapabilityExecutor<Input, Output>;
  readonly executeProviderWrite?: never;
  readonly providerWriteSafety?: never;
}

export interface ProviderWriteRegisteredCapability<
  Input = unknown,
  Output = unknown,
> {
  readonly descriptor: ProviderWriteCapabilityDescriptor;
  readonly execute?: never;
  readonly executeProviderWrite: ProviderWriteCapabilityExecutor<Input, Output>;
  readonly providerWriteSafety: ProviderWriteSafetyContract;
}

export type RegisteredCapability<Input = unknown, Output = unknown> =
  | StandardRegisteredCapability<Input, Output>
  | ProviderWriteRegisteredCapability<Input, Output>;

export interface VersionedRuntimeSchema<Output = unknown> {
  readonly reference: VersionedSchemaReference;
  readonly schema: z.ZodType<Output>;
}

export interface RuntimeSchemaRegistry {
  readonly size: number;
  parse<Output = unknown>(
    reference: VersionedSchemaReference,
    value: unknown,
  ): Output;
  schema<Output = unknown>(
    reference: VersionedSchemaReference,
  ): z.ZodType<Output>;
}

const schemaKey = (reference: VersionedSchemaReference): string =>
  `${reference.id}@${reference.version}`;

export const createRuntimeSchemaRegistry = (
  registrations: readonly VersionedRuntimeSchema[],
): RuntimeSchemaRegistry => {
  const parsers = new Map<string, (value: unknown) => unknown>();

  for (const registration of registrations) {
    const reference = VersionedSchemaReferenceSchema.parse(
      registration.reference,
    );
    const key = schemaKey(reference);
    if (parsers.has(key)) {
      throw new Error(`Runtime schema ${key} is already registered`);
    }
    const parse = registration.schema.parse.bind(registration.schema);
    parsers.set(key, parse);
  }

  const parse = <Output = unknown>(
    rawReference: VersionedSchemaReference,
    value: unknown,
  ): Output => {
    const reference = VersionedSchemaReferenceSchema.parse(rawReference);
    const parser = parsers.get(schemaKey(reference));
    if (parser === undefined) {
      throw new Error(
        `Runtime schema ${schemaKey(reference)} is not registered`,
      );
    }
    return parser(value) as Output;
  };

  const schema: RuntimeSchemaRegistry['schema'] = (rawReference) => {
    const reference = VersionedSchemaReferenceSchema.parse(rawReference);
    if (!parsers.has(schemaKey(reference))) {
      throw new Error(
        `Runtime schema ${schemaKey(reference)} is not registered`,
      );
    }
    return z.unknown().transform((value) => parse(reference, value));
  };

  return Object.freeze({ size: parsers.size, parse, schema });
};

interface ResolvedCapabilityBase<
  Descriptor extends CapabilityDescriptor,
  Output,
> {
  readonly descriptor: Descriptor;
  invoke(input: unknown, context: CapabilityInvocationContext): Promise<Output>;
}

export type StandardResolvedCapability<Output = unknown> =
  ResolvedCapabilityBase<StandardCapabilityDescriptor, Output>;

export type ProviderWriteResolvedCapability<Output = unknown> =
  ResolvedCapabilityBase<ProviderWriteCapabilityDescriptor, Output>;

export type ResolvedCapability<Output = unknown> =
  StandardResolvedCapability<Output> | ProviderWriteResolvedCapability<Output>;
