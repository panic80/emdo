import { z } from 'zod';

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export const deepFreeze = <T>(value: T): DeepReadonly<T> => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }

  return value as DeepReadonly<T>;
};

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const SchemaVersionSchema = z.literal(1);

export const IdentifierSchema = z
  .string()
  .min(2)
  .max(160)
  .regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    'Identifier must contain only lowercase segments',
  );

export const OpaqueReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      }),
    'Opaque reference contains control characters',
  );

export const SemanticVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Expected a semantic version');

export const UuidSchema = z.uuid();

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA-256 digest');

export const IdempotencyKeySchema = z
  .string()
  .min(16)
  .max(200)
  .regex(/^[A-Za-z0-9:._-]+$/, 'Invalid idempotency key');

export const HttpsUrlSchema = z
  .url()
  .refine(
    (value) => new URL(value).protocol === 'https:',
    'Expected an HTTPS URL',
  );

export const VersionedSchemaReferenceSchema = z
  .strictObject({
    id: IdentifierSchema,
    version: SemanticVersionSchema,
  })
  .transform(deepFreeze);

export type VersionedSchemaReference = DeepReadonly<
  z.input<typeof VersionedSchemaReferenceSchema>
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
  }).transform(deepFreeze);

export type CapabilityDescriptor = DeepReadonly<
  z.input<typeof CapabilityDescriptorBaseSchema>
>;

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
  readonly agentId: string;
  readonly spaceAccessGrantId: string;
  readonly disclosureGrantId?: string;
  readonly approvalDecisionId?: string;
  readonly abortSignal: AbortSignal;
}

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
  z.input<typeof ProviderWriteAuthorizationBaseSchema>
>;

export interface ProviderWriteCapabilityContext extends Omit<
  CapabilityInvocationContext,
  'spaceAccessGrantId' | 'disclosureGrantId' | 'approvalDecisionId'
> {
  readonly providerWritePermit: ProviderWriteAuthorization;
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

export interface RegisteredCapability<Input = unknown, Output = unknown> {
  readonly descriptor: CapabilityDescriptor;
  readonly execute?: CapabilityExecutor<Input, Output>;
  readonly executeProviderWrite?: ProviderWriteCapabilityExecutor<
    Input,
    Output
  >;
  readonly providerWriteSafety?: ProviderWriteSafetyContract;
}

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

export interface ResolvedCapability<Output = unknown> {
  readonly descriptor: CapabilityDescriptor;
  invoke(input: unknown, context: CapabilityInvocationContext): Promise<Output>;
}
