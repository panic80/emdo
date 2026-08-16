import { ProblemDetailsSchema, deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

import { GOOGLE_IDENTITY_CALLBACK_QUERY_NAMES } from './auth-surface.js';
import {
  ApiReadinessHttpSuccessSchema,
  ApiReadinessHttpUnavailableSchema,
} from './readiness-contract.js';
import {
  ActionDecisionReceiptSchema,
  ActionDecisionRequestSchema,
  ActivityPageSchema,
  EmailSignInRequestSchema,
  FinanceImportCommitRequestSchema,
  FinanceImportCommitResponseSchema,
  FinanceImportDestinationsSchema,
  FinanceImportPreviewRequestSchema,
  FinanceImportPreviewResponseSchema,
  FinancePageSchema,
  GoogleAuthorizeRequestSchema,
  GoogleCallbackQuerySchema,
  GoogleDisconnectRequestSchema,
  HouseholdInvitationIssueRequestSchema,
  HouseholdInvitationIssueResponseSchema,
  HouseholdInvitationListResponseSchema,
  HouseholdInvitationRevokeResponseSchema,
  HouseholdMembershipDeactivationResponseSchema,
  HouseholdMembershipListResponseSchema,
  HouseholdMembershipMutationResponseSchema,
  HouseholdMembershipRoleRequestSchema,
  HouseholdVersionedMutationRequestSchema,
  InvitationRedeemRequestSchema,
  NotificationPreferencesUpdateRequestSchema,
  NotificationPreferencesViewSchema,
  PasskeyAuthenticationRequestSchema,
  PasskeyRegistrationRequestSchema,
  ProposalApprovalViewSchema,
  ProposalListResponseSchema,
  SchedulePageSchema,
  SocialSignInRequestSchema,
  SpeechRequestSchema,
  SettingsViewSchema,
  ShoppingPageSchema,
  SyncClientRegistrationRequestSchema,
  SyncTokenQuerySchema,
  SyncUploadRequestSchema,
  TodayViewSchema,
  TurnRequestSchema,
  VisualProofIssueRequestSchema,
  VisualProofSchema,
} from './schemas.js';

const schemaFor = (schema: z.ZodType): Readonly<Record<string, unknown>> => {
  const generated = z.toJSONSchema(schema, {
    io: 'input',
    target: 'draft-2020-12',
  }) as Record<string, unknown>;
  const portable = { ...generated };
  delete portable.$schema;
  return Object.freeze(portable);
};

const problemResponse = {
  description: 'Problem details',
  content: {
    'application/problem+json': { schema: schemaFor(ProblemDetailsSchema) },
  },
};

const jsonBody = (schema: z.ZodType) => ({
  required: true,
  content: { 'application/json': { schema: schemaFor(schema) } },
});

const idempotencyParameter = {
  in: 'header',
  name: 'Idempotency-Key',
  required: true,
  schema: { type: 'string', minLength: 16, maxLength: 200 },
};

const originParameter = {
  in: 'header',
  name: 'Origin',
  required: true,
  schema: { type: 'string', format: 'uri' },
};

const csrfParameter = {
  in: 'header',
  name: 'X-CSRF-Token',
  required: true,
  schema: { type: 'string', minLength: 1, maxLength: 512 },
};

const mutationParameters = [
  idempotencyParameter,
  originParameter,
  csrfParameter,
];

const browserMutationParameters = [idempotencyParameter, originParameter];

const googleIdentityCallbackParameters =
  GOOGLE_IDENTITY_CALLBACK_QUERY_NAMES.map((name) => ({
    in: 'query',
    name,
    required: name === 'state',
    schema: {
      type: 'string',
      ...(name === 'code' || name === 'error' || name === 'state'
        ? { minLength: 1 }
        : {}),
      maxLength: 8_192,
    },
  }));

const authenticated = [{ sessionAuth: [] }];

const standardResponses = (successStatus: string, description: string) => ({
  [successStatus]: { description },
  '400': problemResponse,
  '401': problemResponse,
  '403': problemResponse,
  '409': problemResponse,
  '413': problemResponse,
  '429': problemResponse,
  '500': problemResponse,
  '502': problemResponse,
  '503': problemResponse,
});

const standardJsonResponses = (
  successStatus: string,
  description: string,
  schema: z.ZodType,
) => ({
  ...standardResponses(successStatus, description),
  [successStatus]: {
    description,
    content: { 'application/json': { schema: schemaFor(schema) } },
  },
});

const uuidPathParameter = {
  in: 'path',
  name: 'id',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

export const createOpenApiDocument = () =>
  deepFreeze({
    openapi: '3.1.0',
    info: {
      title: 'EMDO Household Assistant API',
      version: '1.0.0',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        sessionAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: '__Secure-emdo.session_token',
        },
        metricsBearer: { type: 'http', scheme: 'bearer' },
      },
    },
    paths: {
      '/api/auth/get-session': {
        get: {
          operationId: 'getBrowserSession',
          responses: standardResponses('200', 'Current browser session'),
        },
      },
      '/api/auth/sign-in/email': {
        post: {
          operationId: 'signInWithEmail',
          parameters: browserMutationParameters,
          requestBody: jsonBody(EmailSignInRequestSchema),
          responses: standardResponses('200', 'Email sign-in response'),
        },
      },
      '/api/auth/sign-in/social': {
        post: {
          operationId: 'signInWithGoogleIdentity',
          parameters: browserMutationParameters,
          requestBody: jsonBody(SocialSignInRequestSchema),
          responses: standardResponses(
            '200',
            'Google identity sign-in response',
          ),
        },
      },
      '/api/auth/passkey/generate-authenticate-options': {
        get: {
          operationId: 'generatePasskeyAuthenticationOptions',
          responses: standardResponses('200', 'Passkey authentication options'),
        },
      },
      '/api/auth/passkey/verify-authentication': {
        post: {
          operationId: 'verifyPasskeyAuthentication',
          parameters: browserMutationParameters,
          requestBody: jsonBody(PasskeyAuthenticationRequestSchema),
          responses: standardResponses('200', 'Passkey sign-in response'),
        },
      },
      '/api/auth/passkey/generate-register-options': {
        get: {
          operationId: 'generatePasskeyRegistrationOptions',
          security: authenticated,
          parameters: [
            {
              in: 'query',
              name: 'authenticatorAttachment',
              required: false,
              schema: {
                type: 'string',
                enum: ['cross-platform', 'platform'],
              },
            },
            {
              in: 'query',
              name: 'name',
              required: false,
              schema: { type: 'string', minLength: 1, maxLength: 80 },
            },
          ],
          responses: standardResponses('200', 'Passkey registration options'),
        },
      },
      '/api/auth/passkey/verify-registration': {
        post: {
          operationId: 'verifyPasskeyRegistration',
          security: authenticated,
          parameters: mutationParameters,
          requestBody: jsonBody(PasskeyRegistrationRequestSchema),
          responses: standardResponses('200', 'Passkey registered'),
        },
      },
      '/api/auth/sign-out': {
        post: {
          operationId: 'signOutBrowserSession',
          security: authenticated,
          parameters: mutationParameters,
          responses: standardResponses('200', 'Browser session signed out'),
        },
      },
      '/api/auth/callback/google': {
        get: {
          operationId: 'completeGoogleIdentitySignIn',
          description:
            'Requires state and exactly one of code or error; duplicate and unknown query fields are rejected.',
          parameters: googleIdentityCallbackParameters,
          responses: {
            ...standardResponses('302', 'Identity callback redirect'),
            '303': { description: 'Identity callback redirect' },
          },
        },
      },
      '/api/v1/auth/csrf': {
        get: {
          operationId: 'issueMutationCsrf',
          security: authenticated,
          responses: standardResponses('200', 'Session-bound CSRF token'),
        },
      },
      '/api/v1/auth/invitations/csrf': {
        get: {
          operationId: 'issueInvitationCsrf',
          responses: standardResponses(
            '200',
            'Invitation onboarding CSRF token',
          ),
        },
      },
      '/api/v1/auth/invitations/redeem': {
        post: {
          operationId: 'redeemHouseholdInvitation',
          parameters: mutationParameters,
          requestBody: jsonBody(InvitationRedeemRequestSchema),
          responses: standardResponses('201', 'Invited account created'),
        },
      },
      '/api/v1/household/invitations': {
        get: {
          operationId: 'listHouseholdInvitations',
          security: authenticated,
          responses: standardJsonResponses(
            '200',
            'Household invitations',
            HouseholdInvitationListResponseSchema,
          ),
        },
        post: {
          operationId: 'issueHouseholdInvitation',
          security: authenticated,
          parameters: mutationParameters,
          requestBody: jsonBody(HouseholdInvitationIssueRequestSchema),
          responses: standardJsonResponses(
            '201',
            'Household invitation queued for delivery',
            HouseholdInvitationIssueResponseSchema,
          ),
        },
      },
      '/api/v1/household/invitations/{id}/revoke': {
        post: {
          operationId: 'revokeHouseholdInvitation',
          security: authenticated,
          parameters: [...mutationParameters, uuidPathParameter],
          requestBody: jsonBody(HouseholdVersionedMutationRequestSchema),
          responses: standardJsonResponses(
            '200',
            'Household invitation revoked',
            HouseholdInvitationRevokeResponseSchema,
          ),
        },
      },
      '/api/v1/household/memberships': {
        get: {
          operationId: 'listHouseholdMemberships',
          security: authenticated,
          responses: standardJsonResponses(
            '200',
            'Household memberships',
            HouseholdMembershipListResponseSchema,
          ),
        },
      },
      '/api/v1/household/memberships/{id}/role': {
        patch: {
          operationId: 'changeHouseholdMembershipRole',
          security: authenticated,
          parameters: [...mutationParameters, uuidPathParameter],
          requestBody: jsonBody(HouseholdMembershipRoleRequestSchema),
          responses: standardJsonResponses(
            '200',
            'Household membership role changed',
            HouseholdMembershipMutationResponseSchema,
          ),
        },
      },
      '/api/v1/household/memberships/{id}/deactivate': {
        post: {
          operationId: 'deactivateHouseholdMembership',
          security: authenticated,
          parameters: [...mutationParameters, uuidPathParameter],
          requestBody: jsonBody(HouseholdVersionedMutationRequestSchema),
          responses: standardJsonResponses(
            '200',
            'Household membership deactivated',
            HouseholdMembershipDeactivationResponseSchema,
          ),
        },
      },
      '/api/v1/turns': {
        post: {
          operationId: 'createTurn',
          security: authenticated,
          parameters: mutationParameters,
          requestBody: jsonBody(TurnRequestSchema),
          responses: standardResponses('202', 'Turn accepted by the manager'),
        },
      },
      '/api/v1/runs/{id}/events': {
        get: {
          operationId: 'replayRunEvents',
          security: authenticated,
          parameters: [
            {
              in: 'path',
              name: 'id',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              in: 'header',
              name: 'Last-Event-ID',
              required: false,
              schema: { type: 'integer', minimum: 0 },
            },
          ],
          responses: {
            '200': {
              description: 'Persisted and live run events',
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            },
            '400': problemResponse,
            '401': problemResponse,
            '404': problemResponse,
          },
        },
      },
      '/api/v1/proposals': {
        get: {
          operationId: 'listProposals',
          security: authenticated,
          parameters: [
            {
              in: 'query',
              name: 'state',
              required: false,
              schema: {
                type: 'string',
                enum: [
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
                ],
              },
            },
            {
              in: 'query',
              name: 'cursor',
              required: false,
              schema: { type: 'string', minLength: 1, maxLength: 512 },
            },
            {
              in: 'query',
              name: 'limit',
              required: false,
              schema: {
                type: 'integer',
                minimum: 1,
                maximum: 50,
                default: 25,
              },
            },
          ],
          responses: {
            ...standardResponses('200', 'Scoped proposal projections'),
            '200': {
              description: 'Scoped proposal projections',
              content: {
                'application/json': {
                  schema: schemaFor(ProposalListResponseSchema),
                },
              },
            },
          },
        },
      },
      '/api/v1/proposals/{id}': {
        get: {
          operationId: 'getProposal',
          security: authenticated,
          parameters: [
            {
              in: 'path',
              name: 'id',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            ...standardResponses('200', 'Scoped proposal approval view'),
            '200': {
              description: 'Scoped proposal approval view',
              content: {
                'application/json': {
                  schema: schemaFor(ProposalApprovalViewSchema),
                },
              },
            },
            '404': problemResponse,
          },
        },
      },
      '/api/v1/proposals/{id}/visual-proof': {
        post: {
          operationId: 'issueProposalVisualProof',
          security: authenticated,
          parameters: [
            ...mutationParameters,
            {
              in: 'path',
              name: 'id',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          requestBody: jsonBody(VisualProofIssueRequestSchema),
          responses: {
            ...standardResponses('200', 'Short-lived visual proof'),
            '200': {
              description: 'Short-lived visual proof',
              content: {
                'application/json': { schema: schemaFor(VisualProofSchema) },
              },
            },
            '404': problemResponse,
          },
        },
      },
      '/api/v1/proposals/{id}/decision': {
        post: {
          operationId: 'decideProposalVisually',
          security: authenticated,
          parameters: [
            ...mutationParameters,
            {
              in: 'header',
              name: 'X-EMDO-Visual-Confirmation',
              required: true,
              schema: {
                type: 'string',
                minLength: 32,
                maxLength: 512,
                pattern: '^[A-Za-z0-9_-]+$',
              },
            },
            {
              in: 'path',
              name: 'id',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          requestBody: jsonBody(ActionDecisionRequestSchema),
          responses: {
            ...standardResponses('200', 'Proposal decision persisted'),
            '200': {
              description: 'Proposal decision persisted',
              content: {
                'application/json': {
                  schema: schemaFor(ActionDecisionReceiptSchema),
                },
              },
            },
            '404': problemResponse,
          },
        },
      },
      '/api/v1/sync/token': {
        get: {
          operationId: 'issueSyncToken',
          security: authenticated,
          parameters: [
            {
              in: 'query',
              name: 'clientId',
              required: true,
              schema: schemaFor(SyncTokenQuerySchema).properties && {
                type: 'string',
                format: 'uuid',
              },
            },
          ],
          responses: standardResponses('200', 'Short-lived PowerSync token'),
        },
      },
      '/api/v1/sync/clients': {
        post: {
          operationId: 'registerSyncClient',
          security: authenticated,
          parameters: mutationParameters,
          requestBody: jsonBody(SyncClientRegistrationRequestSchema),
          responses: standardResponses('201', 'Sync client registered'),
        },
      },
      '/api/v1/sync/ops': {
        post: {
          operationId: 'applySyncOperations',
          security: authenticated,
          parameters: mutationParameters,
          requestBody: jsonBody(SyncUploadRequestSchema),
          responses: standardResponses('200', 'Per-operation sync outcomes'),
        },
      },
      '/api/v1/experience/today': {
        get: {
          operationId: 'getTodayView',
          security: authenticated,
          parameters: [
            {
              in: 'query',
              name: 'date',
              required: true,
              schema: { type: 'string', format: 'date' },
            },
          ],
          responses: standardJsonResponses(
            '200',
            'Principal-scoped Today view',
            TodayViewSchema,
          ),
        },
      },
      '/api/v1/experience/activity': {
        get: {
          operationId: 'listActivity',
          security: authenticated,
          parameters: [
            {
              in: 'query',
              name: 'cursor',
              required: false,
              schema: { type: 'string', minLength: 1, maxLength: 512 },
            },
            {
              in: 'query',
              name: 'limit',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 50, default: 25 },
            },
          ],
          responses: standardJsonResponses(
            '200',
            'Principal-scoped activity page',
            ActivityPageSchema,
          ),
        },
      },
      '/api/v1/experience/finance': {
        get: {
          operationId: 'listFinance',
          security: authenticated,
          parameters: [
            {
              in: 'query',
              name: 'cursor',
              required: false,
              schema: { type: 'string', minLength: 1, maxLength: 512 },
            },
            {
              in: 'query',
              name: 'limit',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 50, default: 25 },
            },
          ],
          responses: standardJsonResponses(
            '200',
            'Principal-scoped finance page',
            FinancePageSchema,
          ),
        },
      },
      '/api/v1/finance/imports/preview': {
        post: {
          operationId: 'previewFinanceImport',
          security: authenticated,
          parameters: [originParameter, csrfParameter],
          requestBody: jsonBody(FinanceImportPreviewRequestSchema),
          responses: standardJsonResponses(
            '200',
            'Authenticated finance statement preview',
            FinanceImportPreviewResponseSchema,
          ),
        },
      },
      '/api/v1/finance/imports/options': {
        get: {
          operationId: 'listFinanceImportDestinations',
          security: authenticated,
          responses: standardJsonResponses(
            '200',
            'Authenticated finance import account and category destinations',
            FinanceImportDestinationsSchema,
          ),
        },
      },
      '/api/v1/finance/imports/commit': {
        post: {
          operationId: 'commitFinanceImport',
          security: authenticated,
          parameters: mutationParameters,
          requestBody: jsonBody(FinanceImportCommitRequestSchema),
          responses: standardJsonResponses(
            '200',
            'Committed or exactly replayed finance import',
            FinanceImportCommitResponseSchema,
          ),
        },
      },
      '/api/v1/experience/schedule': {
        get: {
          operationId: 'listSchedule',
          security: authenticated,
          parameters: [
            ...['from', 'to'].map((name) => ({
              in: 'query',
              name,
              required: true,
              schema: { type: 'string', format: 'date' },
            })),
            {
              in: 'query',
              name: 'cursor',
              required: false,
              schema: { type: 'string', minLength: 1, maxLength: 512 },
            },
            {
              in: 'query',
              name: 'limit',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 50, default: 25 },
            },
          ],
          responses: standardJsonResponses(
            '200',
            'Principal-scoped schedule page',
            SchedulePageSchema,
          ),
        },
      },
      '/api/v1/experience/settings': {
        get: {
          operationId: 'getSettingsView',
          security: authenticated,
          responses: standardJsonResponses(
            '200',
            'Principal-scoped settings view',
            SettingsViewSchema,
          ),
        },
      },
      '/api/v1/experience/shopping': {
        get: {
          operationId: 'listShopping',
          security: authenticated,
          parameters: [
            {
              in: 'query',
              name: 'cursor',
              required: false,
              schema: { type: 'string', minLength: 1, maxLength: 512 },
            },
            {
              in: 'query',
              name: 'limit',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 50, default: 25 },
            },
          ],
          responses: standardJsonResponses(
            '200',
            'Principal-scoped shopping page',
            ShoppingPageSchema,
          ),
        },
      },
      '/api/v1/experience/notification-preferences': {
        get: {
          operationId: 'getNotificationPreferences',
          security: authenticated,
          responses: standardJsonResponses(
            '200',
            'Principal-scoped notification preferences',
            NotificationPreferencesViewSchema,
          ),
        },
        put: {
          operationId: 'updateNotificationPreferences',
          security: authenticated,
          parameters: mutationParameters,
          requestBody: jsonBody(NotificationPreferencesUpdateRequestSchema),
          responses: standardJsonResponses(
            '200',
            'Updated notification preferences',
            NotificationPreferencesViewSchema,
          ),
        },
      },
      '/api/v1/voice/transcribe': {
        post: {
          operationId: 'transcribeVoice',
          security: authenticated,
          parameters: [
            ...mutationParameters,
            {
              in: 'query',
              name: 'durationMs',
              required: true,
              schema: { type: 'integer', minimum: 1, maximum: 60_000 },
            },
            {
              in: 'query',
              name: 'attempt',
              required: false,
              schema: {
                type: 'string',
                enum: ['default', 'accuracy-retry'],
                default: 'default',
              },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'audio/webm': { schema: { type: 'string', format: 'binary' } },
              'audio/mpeg': { schema: { type: 'string', format: 'binary' } },
              'audio/mp4': { schema: { type: 'string', format: 'binary' } },
              'audio/ogg': { schema: { type: 'string', format: 'binary' } },
              'audio/wav': { schema: { type: 'string', format: 'binary' } },
              'audio/x-wav': { schema: { type: 'string', format: 'binary' } },
            },
          },
          responses: standardResponses('200', 'Correctable transcript'),
        },
      },
      '/api/v1/voice/speak': {
        post: {
          operationId: 'speakSummary',
          security: authenticated,
          parameters: mutationParameters,
          requestBody: jsonBody(SpeechRequestSchema),
          responses: standardResponses('200', 'Ephemeral spoken summary'),
        },
      },
      '/api/v1/connectors/google/authorize': {
        post: {
          operationId: 'authorizeGoogleCalendar',
          security: authenticated,
          parameters: mutationParameters,
          requestBody: jsonBody(GoogleAuthorizeRequestSchema),
          responses: standardResponses('200', 'OAuth authorization URL'),
        },
      },
      '/api/v1/connectors/google/callback': {
        get: {
          operationId: 'completeGoogleCalendarAuthorization',
          security: authenticated,
          parameters: Object.keys(
            (schemaFor(GoogleCallbackQuerySchema).properties ?? {}) as object,
          ).map((name) => ({
            in: 'query',
            name,
            required: name === 'state',
            schema: { type: 'string' },
          })),
          responses: standardResponses('200', 'OAuth callback consumed'),
        },
      },
      '/api/v1/connectors/google/disconnect': {
        post: {
          operationId: 'disconnectGoogleCalendar',
          security: authenticated,
          parameters: mutationParameters,
          requestBody: jsonBody(GoogleDisconnectRequestSchema),
          responses: standardResponses('200', 'Google Calendar disconnected'),
        },
      },
      '/.well-known/jwks.json': {
        get: {
          operationId: 'getPublicJwks',
          responses: { '200': { description: 'Public signing keys' } },
        },
      },
      '/healthz': {
        get: {
          operationId: 'getLiveness',
          responses: { '200': { description: 'Process is live' } },
        },
      },
      '/readyz': {
        get: {
          operationId: 'getReadiness',
          responses: {
            ...standardJsonResponses(
              '200',
              'Dependencies are ready',
              ApiReadinessHttpSuccessSchema,
            ),
            '503': {
              description: 'Dependencies are unavailable',
              content: {
                'application/problem+json': {
                  schema: schemaFor(ApiReadinessHttpUnavailableSchema),
                },
              },
            },
          },
        },
      },
      '/metrics': {
        get: {
          operationId: 'getMetrics',
          security: [{ metricsBearer: [] }],
          responses: {
            '200': { description: 'Prometheus metrics' },
            '401': problemResponse,
            '503': problemResponse,
          },
        },
      },
    },
  });
