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

export interface ServerCapabilityContext {
  readonly requestId: string;
  readonly runId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly spaceAccessGrantId: string;
  readonly approvedProposalId?: string;
  readonly abortSignal: AbortSignal;
}

export type CapabilityExecutor<Input, Output> = (
  input: DeepReadonly<Input>,
  context: ServerCapabilityContext,
) => Promise<Output>;

export interface RegisteredCapability<Input = unknown, Output = unknown> {
  readonly descriptor: CapabilityDescriptor;
  readonly inputSchema: z.ZodType<Input>;
  readonly outputSchema: z.ZodType<Output>;
  readonly execute: CapabilityExecutor<Input, Output>;
}
