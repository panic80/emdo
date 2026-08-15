import {
  ActionDecisionRequestSchema,
  ActionDecisionSchema,
  ActivityPageSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
  FinanceImportDestinationsSchema,
  FinanceImportReferenceSchema,
  FinancePageSchema,
  IdentifierSchema,
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  OpaqueReferenceSchema,
  NotificationPreferencesUpdateRequestSchema,
  NotificationPreferencesViewSchema,
  SchedulePageSchema,
  Sha256Schema,
  SyncOperationSchema,
  SettingsViewSchema,
  ShoppingPageSchema,
  TodayViewSchema,
  UuidSchema,
} from '@emdo/contracts';
import { z } from 'zod';

import { DEFAULT_API_LIMITS } from './config.js';

export { ActionDecisionRequestSchema, ActionDecisionSchema };
export {
  ActivityPageSchema,
  FinanceImportDestinationsSchema,
  FinancePageSchema,
  NotificationPreferencesUpdateRequestSchema,
  NotificationPreferencesViewSchema,
  SchedulePageSchema,
  SettingsViewSchema,
  ShoppingPageSchema,
  TodayViewSchema,
};

const ExperienceReadLimitSchema = z
  .string()
  .regex(/^(?:[1-9]|[1-4]\d|50)$/u)
  .default('25')
  .transform(Number);

export const TodayReadQuerySchema = z.strictObject({
  date: z.iso.date(),
});

export const ActivityReadQuerySchema = z.strictObject({
  cursor: OpaqueReferenceSchema.optional(),
  limit: ExperienceReadLimitSchema,
});

export const ExperiencePageQuerySchema = ActivityReadQuerySchema;

const FinanceImportSourceTextSchema = z
  .string()
  .min(1)
  .max(DEFAULT_API_LIMITS.maximumJsonBodyBytes);
const FinanceImportCsvMappingSchema = z.strictObject({
  dateFormat: z.enum(['yyyy-mm-dd', 'mm/dd/yyyy', 'dd/mm/yyyy']),
  defaultCategoryId: FinanceImportReferenceSchema.nullable(),
  columns: z
    .strictObject({
      postedOn: z.string().trim().min(1).max(200),
      description: z.string().trim().min(1).max(200),
      amount: z.string().trim().min(1).max(200).optional(),
      debit: z.string().trim().min(1).max(200).optional(),
      credit: z.string().trim().min(1).max(200).optional(),
      externalId: z.string().trim().min(1).max(200).optional(),
      categoryId: z.string().trim().min(1).max(200).optional(),
    })
    .superRefine((columns, context) => {
      const signed = columns.amount !== undefined;
      const split = columns.debit !== undefined && columns.credit !== undefined;
      if (
        signed === split ||
        (signed &&
          (columns.debit !== undefined || columns.credit !== undefined))
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Map one signed amount column or both debit and credit columns',
        });
      }
    }),
});

export const FinanceImportPreviewRequestSchema = z.discriminatedUnion(
  'format',
  [
    z.strictObject({
      schemaVersion: z.literal(1),
      format: z.literal('csv'),
      sourceText: FinanceImportSourceTextSchema,
      accountId: FinanceImportReferenceSchema,
      mapping: FinanceImportCsvMappingSchema,
    }),
    z.strictObject({
      schemaVersion: z.literal(1),
      format: z.literal('ofx'),
      sourceText: FinanceImportSourceTextSchema,
      accountId: FinanceImportReferenceSchema,
      mapping: z.strictObject({
        defaultCategoryId: FinanceImportReferenceSchema.nullable(),
      }),
    }),
  ],
);

const FinanceImportDiagnosticsSchema = z
  .array(
    z.strictObject({
      sourceRow: z.number().int().positive().max(100_001),
      code: z.string().trim().min(1).max(160),
    }),
  )
  .max(100_000);

const FinanceImportPlanViewSchema = z.strictObject({
  id: OpaqueReferenceSchema,
  sourceHash: Sha256Schema,
  expiresAt: IsoDateTimeSchema,
  summary: z.strictObject({
    accepted: z.number().int().nonnegative().max(100_000),
    rejected: z.number().int().nonnegative().max(100_000),
    duplicates: z.number().int().nonnegative().max(100_000),
  }),
  rejectedRows: FinanceImportDiagnosticsSchema,
  duplicateRows: z
    .array(
      z.strictObject({
        sourceRow: z.number().int().positive().max(100_001),
        reason: z.enum(['existing', 'within-source']),
      }),
    )
    .max(100_000),
});

export const FinanceImportPreviewResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  plan: FinanceImportPlanViewSchema,
});

export const FinanceImportCommitRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  planId: OpaqueReferenceSchema,
});

export const FinanceImportCommitResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.enum(['committed', 'replayed']),
  receipt: z.strictObject({
    id: OpaqueReferenceSchema,
    planId: OpaqueReferenceSchema,
    transactionCount: z.number().int().positive().max(100_000),
    verified: z.literal(true),
  }),
  sourceDeletionAuthorized: z.literal(true),
});

export const ScheduleReadQuerySchema = z
  .strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
    cursor: OpaqueReferenceSchema.optional(),
    limit: ExperienceReadLimitSchema,
  })
  .refine(
    ({ from, to }) => {
      const range =
        Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`);
      return range >= 0 && range <= 31 * 86_400_000;
    },
    {
      path: ['to'],
      message: 'Schedule range must be ordered and at most 31 days',
    },
  );

export const VisualProposalDecisionResultSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({
      status: z.literal('decided'),
      decision: ActionDecisionSchema,
    }),
    z.strictObject({ status: z.literal('proposal-not-found') }),
    z.strictObject({ status: z.literal('proposal-not-pending') }),
    z.strictObject({ status: z.literal('proposal-expired') }),
    z.strictObject({ status: z.literal('proposal-binding-mismatch') }),
    z.strictObject({ status: z.literal('visual-proof-invalid') }),
    z.strictObject({ status: z.literal('visual-proof-expired') }),
    z.strictObject({ status: z.literal('visual-proof-consumed') }),
    z.strictObject({ status: z.literal('idempotency-conflict') }),
  ],
);

export const ActionDecisionReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: UuidSchema,
  proposalId: UuidSchema,
  payloadHash: Sha256Schema,
  approvalHash: Sha256Schema,
  decision: z.enum(['approved', 'rejected']),
  channel: z.literal('authenticated-visual'),
  decidedAt: IsoDateTimeSchema,
  idempotencyKey: IdempotencyKeySchema,
});

export const AuthenticatedPrincipalSchema = z.strictObject({
  userId: UuidSchema,
  sessionId: UuidSchema,
  householdId: UuidSchema,
  role: z.enum(['owner', 'member']),
  emailVerified: z.literal(true),
  spaceAccessGrantId: UuidSchema,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema,
});

export const AuthCsrfResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  token: z.string().min(24).max(512),
});

export const AuthCsrfIssueResultSchema = z.strictObject({
  token: z.string().min(24).max(512),
  cookie: z
    .string()
    .min(24)
    .max(2_048)
    .refine((value) => !/[\r\n]/u.test(value)),
});

export const EmailSignInRequestSchema = z.strictObject({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(12).max(128),
  rememberMe: z.boolean().optional(),
});

export const SocialSignInRequestSchema = z.strictObject({
  provider: z.literal('google'),
  callbackURL: z.string().min(1).max(512).optional(),
});

const WebAuthnTransportSchema = z.enum([
  'ble',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
]);
const WebAuthnByteStringSchema = z
  .string()
  .min(1)
  .max(262_144)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const PasskeyAuthenticationRequestSchema = z.strictObject({
  response: z.strictObject({
    id: z.string().min(1).max(8_192),
    rawId: z.string().min(1).max(8_192),
    type: z.literal('public-key'),
    authenticatorAttachment: z
      .enum(['cross-platform', 'platform'])
      .nullable()
      .optional(),
    response: z.strictObject({
      authenticatorData: WebAuthnByteStringSchema,
      clientDataJSON: WebAuthnByteStringSchema,
      signature: WebAuthnByteStringSchema,
      userHandle: WebAuthnByteStringSchema.nullable().optional(),
    }),
  }),
});

export const PasskeyRegistrationRequestSchema = z.strictObject({
  response: z.strictObject({
    id: z.string().min(1).max(8_192),
    rawId: z.string().min(1).max(8_192),
    type: z.literal('public-key'),
    authenticatorAttachment: z
      .enum(['cross-platform', 'platform'])
      .nullable()
      .optional(),
    response: z.strictObject({
      attestationObject: WebAuthnByteStringSchema,
      clientDataJSON: WebAuthnByteStringSchema,
      transports: z.array(WebAuthnTransportSchema).max(8).optional(),
      authenticatorData: WebAuthnByteStringSchema.optional(),
      publicKey: WebAuthnByteStringSchema.optional(),
      publicKeyAlgorithm: z.number().int().optional(),
    }),
  }),
  name: z.string().trim().min(1).max(80).optional(),
});

export const PasskeyRegistrationQuerySchema = z.strictObject({
  authenticatorAttachment: z.enum(['cross-platform', 'platform']).optional(),
  name: z.string().trim().min(1).max(80).optional(),
});

export const InvitationRedeemRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  displayName: z.string().trim().min(1).max(100),
  email: z.email().trim().toLowerCase().max(320),
  invitationId: UuidSchema,
  invitationToken: z.string().min(20).max(512),
  password: z.string().min(12).max(128),
});

export const InvitationRedeemResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  userId: UuidSchema,
  householdId: UuidSchema,
  role: z.enum(['owner', 'member']),
  emailVerified: z.literal(true),
});

const HouseholdRoleSchema = z.enum(['owner', 'member']);
const HouseholdRecordVersionSchema = z.number().int().positive().safe();
const HouseholdInvitationShape = {
  id: UuidSchema,
  email: z.string().trim().toLowerCase().email().max(320),
  role: HouseholdRoleSchema,
  status: z.enum(['pending', 'consumed', 'revoked', 'expired']),
  version: HouseholdRecordVersionSchema,
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
} as const;
const invitationLifetimeIsBounded = (value: {
  readonly createdAt: string;
  readonly expiresAt: string;
}) => {
  const lifetime =
    new Date(value.expiresAt).getTime() - new Date(value.createdAt).getTime();
  return lifetime > 0 && lifetime <= 604_800_000;
};

export const HouseholdInvitationParamsSchema = z.strictObject({
  id: UuidSchema,
});
export const HouseholdMembershipParamsSchema = z.strictObject({
  id: UuidSchema,
});
export const HouseholdInvitationIssueRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  email: z.string().trim().toLowerCase().email().max(320),
  role: HouseholdRoleSchema,
  expiresInSeconds: z.number().int().min(60).max(604_800),
});
export const HouseholdInvitationSchema = z
  .strictObject(HouseholdInvitationShape)
  .refine(invitationLifetimeIsBounded, {
    path: ['expiresAt'],
    message: 'Invitation lifetime must be within seven days',
  });
const IssuedHouseholdInvitationSchema = z
  .strictObject({
    ...HouseholdInvitationShape,
    status: z.literal('pending'),
    deliveryStatus: z.literal('queued'),
  })
  .refine(invitationLifetimeIsBounded, {
    path: ['expiresAt'],
    message: 'Invitation lifetime must be within seven days',
  });
export const HouseholdInvitationIssueResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  invitation: IssuedHouseholdInvitationSchema,
  replayed: z.boolean(),
});
export const HouseholdInvitationListResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    invitations: z.array(HouseholdInvitationSchema).max(1_000),
  })
  .refine(
    (value) =>
      new Set(value.invitations.map(({ id }) => id)).size ===
      value.invitations.length,
    { path: ['invitations'], message: 'Invitation identifiers must be unique' },
  );
export const HouseholdVersionedMutationRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  expectedVersion: HouseholdRecordVersionSchema,
});
export const HouseholdInvitationRevokeResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  invitation: z
    .strictObject({
      ...HouseholdInvitationShape,
      status: z.literal('revoked'),
    })
    .refine(invitationLifetimeIsBounded, {
      path: ['expiresAt'],
      message: 'Invitation lifetime must be within seven days',
    }),
  replayed: z.boolean(),
});

const HouseholdMembershipShape = {
  id: UuidSchema,
  userId: UuidSchema,
  email: z.string().trim().toLowerCase().email().max(320),
  role: HouseholdRoleSchema,
  status: z.enum(['active', 'inactive']),
  version: HouseholdRecordVersionSchema,
  joinedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema.optional(),
} as const;
export const HouseholdMembershipSchema = z.strictObject(
  HouseholdMembershipShape,
);
export const HouseholdMembershipListResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    memberships: z.array(HouseholdMembershipSchema).max(1_000),
  })
  .refine(
    (value) =>
      new Set(value.memberships.map(({ id }) => id)).size ===
      value.memberships.length,
    { path: ['memberships'], message: 'Membership identifiers must be unique' },
  );
export const HouseholdMembershipRoleRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  expectedVersion: HouseholdRecordVersionSchema,
  role: HouseholdRoleSchema,
});
export const HouseholdMembershipMutationResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  membership: HouseholdMembershipSchema,
  replayed: z.boolean(),
});
export const HouseholdMembershipDeactivationResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  membership: z.strictObject({
    ...HouseholdMembershipShape,
    status: z.literal('inactive'),
    endedAt: IsoDateTimeSchema,
  }),
  replayed: z.boolean(),
});

export const TurnRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  conversationId: UuidSchema.optional(),
  message: z
    .string()
    .trim()
    .min(1)
    .max(DEFAULT_API_LIMITS.maximumTurnCharacters),
  routeHint: z.enum(['scheduler', 'finance', 'shopping']).optional(),
});

export const TurnAcceptanceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    runId: UuidSchema,
    status: z.literal('accepted'),
    replayed: z.boolean(),
    eventsPath: z.string().regex(/^\/api\/v1\/runs\/[0-9a-f-]{36}\/events$/u),
  })
  .refine(
    (value) => value.eventsPath === `/api/v1/runs/${value.runId}/events`,
    {
      path: ['eventsPath'],
      message: 'Events path must match the accepted run',
    },
  );

export const RunEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: UuidSchema,
  sequence: z.number().int().positive().safe(),
  type: IdentifierSchema,
  occurredAt: IsoDateTimeSchema,
  data: JsonValueSchema,
});

export const RunParamsSchema = z.strictObject({ id: UuidSchema });
export const ProposalParamsSchema = z.strictObject({ id: UuidSchema });
export const ProposalEmptyQuerySchema = z.strictObject({});

export const ProposalStateSchema = z.enum([
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
]);

const ProposalQueryLimitSchema = z
  .string()
  .regex(/^(?:[1-9]|[1-4]\d|50)$/u)
  .default('25')
  .transform(Number);

// Signed proposal cursors are protocol material, not user-authored text. Do
// not trim or otherwise normalize them before the durable verifier sees the
// exact bytes supplied by the client.
export const ProposalCursorSchema = z
  .string()
  .min(32)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u);

const hasUnsafeApprovalDisplayControl = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x61c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });

const ProposalDisplayStringSchema = (
  maximumLength: number,
  requireVisibleText: boolean,
) =>
  z
    .string()
    .max(maximumLength)
    .refine(
      (value) => !hasUnsafeApprovalDisplayControl(value),
      'Proposal display contains unsafe control characters',
    )
    .refine(
      (value) => !requireVisibleText || value.trim().length > 0,
      'Proposal display text must not be blank',
    );

export const ProposalListQuerySchema = z.strictObject({
  state: ProposalStateSchema.optional(),
  cursor: ProposalCursorSchema.optional(),
  limit: ProposalQueryLimitSchema,
});

const ProposalListItemSchema = z.strictObject({
  id: UuidSchema,
  version: z.number().int().positive().safe(),
  state: ProposalStateSchema,
  kind: IdentifierSchema,
  title: ProposalDisplayStringSchema(200, true),
  summary: ProposalDisplayStringSchema(1_000, true),
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
});

export const ProposalListResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  items: z.array(ProposalListItemSchema).max(50),
  nextCursor: ProposalCursorSchema.optional(),
});

export const ProposalListQueryResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    page: ProposalListResponseSchema,
  }),
  z.strictObject({ status: z.literal('invalid-cursor') }),
]);

const ProposalPreviewSchema = z.strictObject({
  summary: ProposalDisplayStringSchema(2_000, false),
});

const ProposalDisplayFieldSchema = z.strictObject({
  label: ProposalDisplayStringSchema(120, true),
  value: ProposalDisplayStringSchema(2_000, false),
});

/**
 * Purpose-built, immutable, approval-hash-bound display projection persisted
 * at proposal materialization. Provider arguments, SDK call IDs, disclosure
 * grants, provider preconditions, raw previews, and provider records are not
 * members of this contract and are rejected by strict parsing.
 */
export const ProposalApprovalViewSchema = ProposalListItemSchema.extend({
  schemaVersion: z.literal(1),
  payloadHash: Sha256Schema,
  approvalHash: Sha256Schema,
  beforePreview: ProposalPreviewSchema,
  afterPreview: ProposalPreviewSchema,
  fields: z.array(ProposalDisplayFieldSchema).max(32),
});

export const VisualProofIssueRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  proposalVersion: z.number().int().positive().safe(),
  payloadHash: Sha256Schema,
  approvalHash: Sha256Schema,
});

const VisualProofSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    proposalId: UuidSchema,
    proposalVersion: z.number().int().positive().safe(),
    payloadHash: Sha256Schema,
    approvalHash: Sha256Schema,
    proofToken: z
      .string()
      .min(32)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/u),
    issuedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    replayed: z.boolean(),
  })
  .superRefine((value, context) => {
    const lifetimeMs = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
    if (lifetimeMs <= 0 || lifetimeMs > 120_000) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message:
          'Visual proof lifetime must be positive and at most two minutes',
      });
    }
  });

export const VisualProofIssueResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('issued'), proof: VisualProofSchema }),
  z.strictObject({ status: z.literal('proposal-not-found') }),
  z.strictObject({ status: z.literal('proposal-not-pending') }),
  z.strictObject({ status: z.literal('proposal-expired') }),
  z.strictObject({ status: z.literal('proposal-binding-mismatch') }),
  z.strictObject({ status: z.literal('idempotency-conflict') }),
]);

export { VisualProofSchema };

export const SyncTokenQuerySchema = z.strictObject({ clientId: UuidSchema });
export const SyncClientRegistrationRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  clientId: UuidSchema,
  displayName: z.string().trim().min(1).max(120),
});
export const SyncClientRegistrationResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  clientId: UuidSchema,
  status: z.literal('registered'),
  replayed: z.boolean(),
});
export const PowerSyncEndpointSchema = z
  .url({ protocol: /^https$/u })
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  }, 'PowerSync endpoint must not contain credentials, query, or fragment');
export const SyncTokenResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  endpoint: PowerSyncEndpointSchema,
  token: z.string().min(16).max(32_768),
  expiresAt: IsoDateTimeSchema,
  writeScope: z.strictObject({
    clientId: UuidSchema,
    spaces: z
      .array(
        z.strictObject({
          id: UuidSchema,
          visibility: z.enum(['private', 'shared']),
          originalOwnerUserId: UuidSchema,
        }),
      )
      .min(1)
      .max(256),
  }),
});

export const SyncUploadRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  clientId: UuidSchema,
  operations: z.array(SyncOperationSchema).max(1_000),
});

const SyncAppliedResultSchema = z.strictObject({
  operationId: UuidSchema,
  status: z.literal('applied'),
  revision: z.number().int().positive().safe(),
  resolution: z.enum(['created', 'applied', 'merged', 'ignored', 'duplicate']),
  conflicts: z
    .array(
      z.strictObject({
        field: z.string().trim().min(1).max(200),
        material: z.boolean(),
      }),
    )
    .max(0),
  replayed: z.boolean(),
});

const SyncConflictDetailSchema = z.strictObject({
  field: z.string().trim().min(1).max(200),
  material: z.boolean(),
});

const SyncConflictResultSchema = z
  .strictObject({
    operationId: UuidSchema,
    status: z.literal('conflict'),
    code: z.enum([
      'entity-exists',
      'entity-not-found',
      'revision-mismatch',
      'tombstoned',
      'mutation-invalid',
      'repository-rejected',
      'domain-operation-invalid',
      'domain-operation-unsupported',
      'base-revision-unavailable',
      'base-state-mismatch',
      'material-conflict',
      'idempotency-key-reused',
      'operation-in-progress',
    ]),
    disposition: z.enum(['terminal', 'retryable']),
    currentRevision: z.number().int().positive().safe().optional(),
    conflicts: z.array(SyncConflictDetailSchema).max(32),
    replayed: z.boolean(),
  })
  .superRefine((value, context) => {
    const expectedDisposition =
      value.code === 'operation-in-progress' ? 'retryable' : 'terminal';
    if (value.disposition !== expectedDisposition) {
      context.addIssue({
        code: 'custom',
        path: ['disposition'],
        message: 'Sync conflict disposition does not match its code',
      });
    }
  });

const SyncBlockedResultSchema = z
  .strictObject({
    operationId: UuidSchema,
    status: z.literal('blocked'),
    code: z.enum([
      'authorization-revoked',
      'dependency-missing',
      'dependency-failed',
      'dependency-cycle',
    ]),
    dependencyOperationId: UuidSchema.optional(),
    disposition: z.enum(['terminal', 'retryable']),
    conflicts: z.array(SyncConflictDetailSchema).max(0),
    replayed: z.literal(false),
  })
  .superRefine((value, context) => {
    const expectedDisposition =
      value.code === 'dependency-missing' ? 'retryable' : 'terminal';
    if (value.disposition !== expectedDisposition) {
      context.addIssue({
        code: 'custom',
        path: ['disposition'],
        message: 'Sync block disposition does not match its code',
      });
    }
  });

export const SyncOperationOutcomeSchema = z.discriminatedUnion('status', [
  SyncAppliedResultSchema,
  SyncConflictResultSchema,
  SyncBlockedResultSchema,
]);

export const SyncUploadResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  clientId: UuidSchema,
  results: z.array(SyncOperationOutcomeSchema).max(1_000),
});

export const TranscriptionQuerySchema = z.strictObject({
  durationMs: z.coerce.number().int().min(1).max(60_000),
  attempt: z.enum(['default', 'accuracy-retry']).default('default'),
});

export const TranscriptionResultSchema = z.strictObject({
  status: z.literal('completed'),
  transcript: z.string().max(50_000),
  model: z.enum(['gpt-4o-mini-transcribe', 'gpt-4o-transcribe']),
  spendWarning: z.boolean(),
});

export const VoiceGatewayFailureSchema = z.strictObject({
  status: z.literal('failed'),
  safeError: z.strictObject({
    code: z.enum([
      'ai-spend-limit-reached',
      'audio-provider-unavailable',
      'audio-request-invalid',
      'audio-provider-failed',
    ]),
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
  }),
  reconciliationRequired: z.boolean(),
});

export const TranscriptionGatewayResultSchema = z.discriminatedUnion('status', [
  TranscriptionResultSchema,
  VoiceGatewayFailureSchema,
]);

export const RecordingInspectionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('verified'),
    verifiedContentType: z.enum([
      'audio/webm',
      'audio/mpeg',
      'audio/mp4',
      'audio/ogg',
      'audio/wav',
      'audio/x-wav',
    ]),
    durationMs: z.number().int().min(1).max(60_000),
  }),
  z.strictObject({
    status: z.literal('rejected'),
    code: z.enum([
      'audio-container-invalid',
      'audio-duration-invalid',
      'audio-inspector-unavailable',
    ]),
  }),
]);

export const OpenAiSpeechModelSchema = z.enum([
  'tts-1',
  'tts-1-hd',
  'gpt-4o-mini-tts',
  'gpt-4o-mini-tts-2025-12-15',
]);

export const SpeechConfigurationSchema = z.strictObject({
  model: OpenAiSpeechModelSchema,
  configurationVersion: OpaqueReferenceSchema,
});

export const SpeechRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  voice: z.enum([
    'alloy',
    'ash',
    'ballad',
    'coral',
    'echo',
    'fable',
    'nova',
    'onyx',
    'sage',
    'shimmer',
  ]),
  text: z
    .string()
    .trim()
    .min(1)
    .max(DEFAULT_API_LIMITS.maximumSpeechCharacters),
});

export const SpeechResultSchema = z
  .strictObject({
    status: z.literal('completed'),
    audio: z.instanceof(Uint8Array),
    contentType: z.enum(['audio/mpeg', 'audio/wav', 'audio/ogg']),
    model: OpenAiSpeechModelSchema,
    spendWarning: z.boolean(),
  })
  .refine(
    (value) =>
      value.audio.byteLength > 0 &&
      value.audio.byteLength <= DEFAULT_API_LIMITS.maximumAudioBytes,
    {
      path: ['audio'],
      message: 'Generated audio is outside the bounded envelope',
    },
  );

export const SpeechGatewayResultSchema = z.union([
  SpeechResultSchema,
  VoiceGatewayFailureSchema,
]);

export const AudioRequestFingerprintSchema = Sha256Schema;

export const AudioReplayResultSchema = z.strictObject({
  kind: z.literal('transcription'),
  transcript: z.string().max(50_000),
  model: z.enum(['gpt-4o-mini-transcribe', 'gpt-4o-transcribe']),
  spendWarning: z.boolean(),
});

export const AudioRunClaimSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('claimed'),
    claimId: OpaqueReferenceSchema,
    ownershipToken: OpaqueReferenceSchema,
    executionId: OpaqueReferenceSchema,
    reservationId: OpaqueReferenceSchema,
  }),
  z.strictObject({
    status: z.literal('replay'),
    result: AudioReplayResultSchema,
  }),
  z.strictObject({
    status: z.literal('in-progress'),
    retryAfterMs: z.number().int().min(100).max(60_000),
  }),
  z.strictObject({ status: z.literal('completed-nonreplayable') }),
  z.strictObject({ status: z.literal('indeterminate') }),
  z.strictObject({ status: z.literal('conflict') }),
]);

export const CanonicalAppOriginSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.origin === value;
}, 'Expected an exact HTTPS application origin');

const createInternalReturnPathSchema = (rawOrigin: string) => {
  const origin = CanonicalAppOriginSchema.parse(rawOrigin);
  return z
    .string()
    .min(1)
    .max(512)
    .refine(
      (value) =>
        value.startsWith('/') &&
        !value.startsWith('//') &&
        !value.includes('\\') &&
        !/%5c/iu.test(value),
    )
    .refine((value) => {
      try {
        return new URL(value, origin).origin === origin;
      } catch {
        return false;
      }
    });
};

export const createGoogleAuthorizeRequestSchema = (origin: string) =>
  z.strictObject({
    schemaVersion: z.literal(1),
    returnTo: createInternalReturnPathSchema(origin).optional(),
  });

export const GoogleAuthorizeRequestSchema = createGoogleAuthorizeRequestSchema(
  'https://emdo.invalid',
);

export const GoogleAuthorizeResponseSchema = z.strictObject({
  authorizationUrl: z
    .url()
    .refine((value) => new URL(value).protocol === 'https:'),
  expiresAt: IsoDateTimeSchema,
});

export const GoogleCallbackQuerySchema = z
  .strictObject({
    code: z.string().min(1).max(8_192).optional(),
    state: z.string().min(16).max(8_192),
    error: z
      .string()
      .regex(/^[a-z0-9_]+$/u)
      .max(160)
      .optional(),
    error_description: z.string().max(1_000).optional(),
    authuser: z.string().regex(/^\d+$/u).max(8).optional(),
    prompt: z.string().max(160).optional(),
    scope: z.string().max(8_192).optional(),
  })
  .superRefine((value, context) => {
    if ((value.code === undefined) === (value.error === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['code'],
        message: 'OAuth callback requires exactly one of code or error',
      });
    }
  });

export const GoogleCallbackResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('connected'),
    connectionId: IdentifierSchema,
    grantedScopes: z.array(z.string().min(1).max(512)).max(32),
  }),
  z.strictObject({ status: z.literal('denied') }),
]);

export const GoogleDisconnectRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
});

export const GoogleDisconnectResponseSchema = z.strictObject({
  status: z.literal('disconnected'),
});

export const JwksSchema = z
  .strictObject({
    keys: z
      .array(
        z.strictObject({
          kty: z.literal('RSA'),
          use: z.literal('sig'),
          alg: z.literal('RS256'),
          kid: IdentifierSchema,
          n: z
            .string()
            .regex(/^[A-Za-z0-9_-]+$/u)
            .max(4_096),
          e: z
            .string()
            .regex(/^[A-Za-z0-9_-]+$/u)
            .max(64),
        }),
      )
      .min(1)
      .max(16),
  })
  .refine(
    (value) =>
      new Set(value.keys.map((key) => key.kid)).size === value.keys.length,
    { path: ['keys'], message: 'JWKS key identifiers must be unique' },
  );

export const ReadinessResultSchema = z.strictObject({
  ready: z.boolean(),
  checks: z.record(z.string(), z.enum(['ok', 'unavailable'])),
});

export const IdempotencyHeaderSchema = IdempotencyKeySchema;
