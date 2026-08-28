import { z } from 'zod';

import {
  IdentifierSchema,
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  OpaqueReferenceSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
  SchemaVersionSchema,
  SemanticVersionSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly,
} from './capability.js';
import { DataDisclosureGrantSchema } from './disclosure.js';
import {
  isApprovedFinanceGuardedCapabilityOperation,
  isFinanceDocumentGuardedOperation,
} from './guarded-action.js';

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

// Approval text is a security-sensitive visual projection. Reject every
// control and format code point (including bidi controls and zero-width
// default-ignorables) instead of maintaining an incomplete denylist.
const ApprovalDisplayUnsafeCharacterPattern = /[\p{Cc}\p{Cf}]/u;

const hasVisibleApprovalText = (value: string): boolean =>
  value.replace(/[\p{White_Space}\p{Default_Ignorable_Code_Point}]/gu, '')
    .length > 0;

const approvalDisplayTextSchema = (
  maxLength: number,
  requireVisibleText: boolean,
) =>
  z
    .string()
    .max(maxLength)
    .superRefine((value, context) => {
      if (requireVisibleText && !hasVisibleApprovalText(value)) {
        context.addIssue({
          code: 'custom',
          message: 'Approval display text must contain a visible character',
        });
      }
      if (ApprovalDisplayUnsafeCharacterPattern.test(value)) {
        context.addIssue({
          code: 'custom',
          message: 'Approval display text contains a control character',
        });
      }
    });

const ActionProposalApprovalDisplayFieldBaseSchema = z.strictObject({
  label: approvalDisplayTextSchema(120, true),
  value: approvalDisplayTextSchema(2_000, false),
});

export const ActionProposalApprovalDisplayFieldSchema =
  ActionProposalApprovalDisplayFieldBaseSchema.transform(deepFreeze);

export type ActionProposalApprovalDisplayField = DeepReadonly<
  z.input<typeof ActionProposalApprovalDisplayFieldBaseSchema>
>;

const ActionProposalApprovalDisplayBaseSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  title: approvalDisplayTextSchema(200, true),
  summary: approvalDisplayTextSchema(1_000, true),
  beforeSummary: approvalDisplayTextSchema(2_000, false),
  afterSummary: approvalDisplayTextSchema(2_000, false),
  fields: z.array(ActionProposalApprovalDisplayFieldSchema).max(32),
});

export const ActionProposalApprovalDisplaySchema =
  ActionProposalApprovalDisplayBaseSchema.transform(deepFreeze);

export type ActionProposalApprovalDisplay = DeepReadonly<
  z.input<typeof ActionProposalApprovalDisplayBaseSchema>
>;

/**
 * Present only for an EMDO-owned local action that was dynamically determined
 * to need visual approval. The execution binding itself stays server-owned;
 * this immutable digest lets every later boundary detect a substituted actor,
 * session, private space, grant, scope, or canonical action.
 */
const GuardedActionBindingSchema = z
  .strictObject({
    capabilityVersion: SemanticVersionSchema,
    operation: IdentifierSchema,
    actionHash: Sha256Schema,
    executionBindingHash: Sha256Schema,
    /** Present only when execution is bound to server-materialized target state. */
    targetBindingHash: Sha256Schema.optional(),
  })
  .superRefine((value, context) => {
    if (
      isFinanceDocumentGuardedOperation(value.operation) !==
      (value.targetBindingHash !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['targetBindingHash'],
        message:
          'Finance document guarded actions require an exact target binding',
      });
    }
  });

export type GuardedActionBinding = DeepReadonly<
  z.input<typeof GuardedActionBindingSchema>
>;

const ActionProposalBaseSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    id: UuidSchema,
    version: z.number().int().positive(),
    runId: UuidSchema,
    capabilityId: IdentifierSchema,
    capabilityFingerprint: Sha256Schema,
    authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprintSchema,
    canonicalArguments: JsonValueSchema,
    targets: z.array(ProposalTargetSchema).min(1).max(64),
    beforePreview: JsonValueSchema,
    afterPreview: JsonValueSchema,
    approvalDisplay: ActionProposalApprovalDisplaySchema,
    providerPreconditions: z.array(ProviderPreconditionSchema).max(64),
    providerAuthorityBindingHash: Sha256Schema,
    providerSdkCallId: OpaqueReferenceSchema,
    guardedAction: GuardedActionBindingSchema.optional(),
    payloadHash: Sha256Schema,
    approvalHash: Sha256Schema,
    disclosureGrant: DataDisclosureGrantSchema,
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    idempotencyKey: IdempotencyKeySchema,
    state: z.enum([
      'pending',
      'approved',
      'rejected',
      'prepared',
      'executing',
      'executed',
      'not-applied',
      'indeterminate',
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
    if (Date.parse(value.disclosureGrant.createdAt) > createdAt) {
      context.addIssue({
        code: 'custom',
        path: ['disclosureGrant', 'createdAt'],
        message: 'Disclosure grant must be created before the proposal',
      });
    }
    if (Date.parse(value.disclosureGrant.expiresAt) < expiresAt) {
      context.addIssue({
        code: 'custom',
        path: ['disclosureGrant', 'expiresAt'],
        message: 'Disclosure grant must remain valid through proposal expiry',
      });
    }
    if (
      value.guardedAction !== undefined &&
      (value.guardedAction.actionHash !== value.payloadHash ||
        value.guardedAction.executionBindingHash !==
          value.providerAuthorityBindingHash)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['guardedAction'],
        message:
          'Guarded action binding must match the canonical payload and execution binding',
      });
    }
    if (
      value.guardedAction !== undefined &&
      !isApprovedFinanceGuardedCapabilityOperation(
        value.capabilityId,
        value.guardedAction.operation,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['guardedAction', 'operation'],
        message: 'Guarded Finance operation must match its approved capability',
      });
    }
  });

export const ActionProposalSchema =
  ActionProposalBaseSchema.transform(deepFreeze);

export type ActionProposal = DeepReadonly<
  z.output<typeof ActionProposalBaseSchema>
>;

const ActionDecisionBaseSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  id: UuidSchema,
  proposalId: UuidSchema,
  userId: UuidSchema,
  authenticatedSessionId: UuidSchema,
  payloadHash: Sha256Schema,
  approvalHash: Sha256Schema,
  decision: z.enum(['approved', 'rejected']),
  channel: z.literal('authenticated-visual'),
  decidedAt: IsoDateTimeSchema,
  idempotencyKey: IdempotencyKeySchema,
});

const ActionDecisionRequestBaseSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  proposalId: UuidSchema,
  payloadHash: Sha256Schema,
  approvalHash: Sha256Schema,
  decision: z.enum(['approved', 'rejected']),
  idempotencyKey: IdempotencyKeySchema,
});

export const ActionDecisionRequestSchema =
  ActionDecisionRequestBaseSchema.transform(deepFreeze);
export type ActionDecisionRequest = DeepReadonly<
  z.input<typeof ActionDecisionRequestBaseSchema>
>;

export const ActionDecisionSchema =
  ActionDecisionBaseSchema.transform(deepFreeze);
export type ActionDecision = DeepReadonly<
  z.input<typeof ActionDecisionBaseSchema>
>;
