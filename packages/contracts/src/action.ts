import { z } from 'zod';

import {
  IdentifierSchema,
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  OpaqueReferenceSchema,
  SchemaVersionSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly,
} from './capability.js';
import { DataDisclosureGrantSchema } from './disclosure.js';

const ProposalTargetSchema = z.strictObject({
  kind: IdentifierSchema,
  id: OpaqueReferenceSchema,
  expectedVersion: z.string().trim().min(1).max(512),
});

const ProviderPreconditionSchema = z.strictObject({
  kind: IdentifierSchema,
  targetId: OpaqueReferenceSchema,
  expectedValue: z.string().min(1).max(2048),
});

const ActionProposalBaseSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    id: UuidSchema,
    version: z.number().int().positive(),
    runId: UuidSchema,
    capabilityId: IdentifierSchema,
    canonicalArguments: JsonValueSchema,
    targets: z.array(ProposalTargetSchema).min(1).max(64),
    beforePreview: JsonValueSchema,
    afterPreview: JsonValueSchema,
    providerPreconditions: z.array(ProviderPreconditionSchema).max(64),
    payloadHash: Sha256Schema,
    disclosureGrant: DataDisclosureGrantSchema,
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    idempotencyKey: IdempotencyKeySchema,
    state: z.enum([
      'pending',
      'approved',
      'rejected',
      'executing',
      'executed',
      'expired',
      'failed',
    ]),
  })
  .superRefine((value, context) => {
    const createdAt = Date.parse(value.createdAt);
    const expiresAt = Date.parse(value.expiresAt);
    const lifetimeMs = expiresAt - createdAt;
    if (lifetimeMs <= 0 || lifetimeMs > 600_000) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message:
          'Action proposal expiry must be within ten minutes of creation',
      });
    }
    if (value.disclosureGrant.runId !== value.runId) {
      context.addIssue({
        code: 'custom',
        path: ['disclosureGrant', 'runId'],
        message: 'Disclosure grant must be bound to the proposal run',
      });
    }
    if (Date.parse(value.disclosureGrant.expiresAt) < expiresAt) {
      context.addIssue({
        code: 'custom',
        path: ['disclosureGrant', 'expiresAt'],
        message: 'Disclosure grant must remain valid through proposal expiry',
      });
    }
  });

export const ActionProposalSchema =
  ActionProposalBaseSchema.transform(deepFreeze);

export type ActionProposal = DeepReadonly<
  z.input<typeof ActionProposalBaseSchema>
>;

const ActionDecisionBaseSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  id: UuidSchema,
  proposalId: UuidSchema,
  userId: UuidSchema,
  authenticatedSessionId: UuidSchema,
  payloadHash: Sha256Schema,
  decision: z.enum(['approved', 'rejected']),
  channel: z.literal('authenticated-visual'),
  decidedAt: IsoDateTimeSchema,
  idempotencyKey: IdempotencyKeySchema,
});

export const ActionDecisionSchema =
  ActionDecisionBaseSchema.transform(deepFreeze);
export type ActionDecision = DeepReadonly<
  z.input<typeof ActionDecisionBaseSchema>
>;
