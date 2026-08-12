import type {
  ActionDecision,
  ActionDecisionRequest,
  ActivityPage,
  EffectiveAuthorizationScopeFingerprint,
  FinancePage,
  JsonValue,
  NotificationPreferencesUpdateRequest,
  NotificationPreferencesView,
  SchedulePage,
  SettingsView,
  ShoppingPage,
  SyncOperation,
  TodayView,
} from '@emdo/contracts';

export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly householdId: string;
  readonly role: 'owner' | 'member';
  readonly emailVerified: true;
  /**
   * Server-issued grant for this exact request. It is never accepted from a
   * client body and must not be reused as authority by a later request/phase.
   * Durable transitions retain prior grant IDs only as lineage; each phase
   * uses a fresh grant to re-prove the same server-derived effective scope.
   */
  readonly spaceAccessGrantId: string;
  /**
   * Canonical scope for collection queries only (`proposalSpaceId: null`). It
   * is derived by trusted authentication/current-grant middleware and is MAC
   * binding material, never client input or standalone authority. Proposal,
   * proof, decision, resume, and provider phases must derive their own
   * non-null proposal/run-space fingerprint under durable locks.
   */
  readonly collectionAuthorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
}

export interface RequestAuthenticationInput {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly cookie?: string;
}

export interface AuthenticationBoundary {
  authenticate(
    input: RequestAuthenticationInput,
  ): Promise<AuthenticatedPrincipal | undefined>;
  verifyMutation(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly method: string;
    readonly path: string;
    readonly origin?: string;
    readonly cookie?: string;
    readonly csrfToken?: string;
  }): Promise<boolean>;
  /**
   * Forwards only the bounded Better Auth HTTP surface. Production adapters
   * must derive this handler and authenticate() from the same Better Auth
   * instance so cookie/session interpretation cannot drift.
   */
  handleBrowserRequest(input: {
    readonly request: Request;
    readonly requestId: string;
  }): Promise<Response>;
  issueMutationCsrf(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<{ readonly token: string; readonly cookie: string }>;
  issueInvitationCsrf(input: {
    readonly requestId: string;
  }): Promise<{ readonly token: string; readonly cookie: string }>;
  redeemInvitation(input: {
    readonly request: {
      readonly schemaVersion: 1;
      readonly displayName: string;
      readonly email: string;
      readonly invitationId: string;
      readonly invitationToken: string;
      readonly password: string;
    };
    readonly origin?: string;
    readonly cookie?: string;
    readonly invitationCsrfToken?: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
    /** Invitation onboarding is deliberately pre-session. */
    readonly principal: undefined;
  }): Promise<{
    readonly schemaVersion: 1;
    readonly userId: string;
    readonly householdId: string;
    readonly role: 'owner' | 'member';
    readonly emailVerified: true;
  }>;
}

export interface TurnRequest {
  readonly schemaVersion: 1;
  readonly conversationId?: string;
  readonly message: string;
  /** A routing hint only. The manager remains authoritative. */
  readonly routeHint?: 'scheduler' | 'finance' | 'shopping';
}

export interface ManagerTurnAcceptance {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly status: 'accepted';
  readonly replayed: boolean;
  readonly eventsPath: string;
}

/**
 * The API is deliberately wired to one manager boundary. Implementations may
 * adapt this to agent-core's TurnOrchestrator, but must never expose specialist
 * runners, raw capabilities, credentials, or provider clients to the route.
 */
export interface ManagerTurnGateway {
  start(input: {
    readonly request: TurnRequest;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<ManagerTurnAcceptance>;
}

export interface RunEvent {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly data: JsonValue;
}

export interface PersistedRunEventGateway {
  /** Implementations must authorize the run against this exact principal before replay. */
  open(input: {
    readonly runId: string;
    readonly afterSequence: number;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly abortSignal: AbortSignal;
  }): Promise<AsyncIterable<RunEvent>>;
}

/**
 * This is one atomic boundary: it consumes a current, single-use visual proof
 * bound to the exact proposal/user/session/household/hashes and the stable
 * server-derived effective-authorization scope re-proved by the request-current
 * grant, then persists the decision. Keeping proof consumption and decision
 * persistence together prevents a TOCTOU gap. An exact decision-idempotency
 * replay may return the existing receipt only when the same proof digest is
 * already consumed and linked to that exact decision; its age does not create
 * a new mutation, but current session/scope authority must still be re-proved.
 * Missing, different, or unconsumed proof material fails closed.
 */
export interface VisualProposalDecisionGateway {
  decideWithVisualProof(input: {
    readonly request: ActionDecisionRequest;
    readonly visualProofToken: string;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<VisualProposalDecisionResult>;
}

export type VisualProposalDecisionResult =
  | { readonly status: 'decided'; readonly decision: ActionDecision }
  | {
      readonly status:
        | 'proposal-not-found'
        | 'proposal-not-pending'
        | 'proposal-expired'
        | 'proposal-binding-mismatch'
        | 'visual-proof-invalid'
        | 'visual-proof-expired'
        | 'visual-proof-consumed'
        | 'idempotency-conflict';
    };

export type ProposalQueryState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'prepared'
  | 'executing'
  | 'executed'
  | 'not-applied'
  | 'indeterminate'
  | 'expired'
  | 'failed';

export interface ProposalListItem {
  readonly id: string;
  readonly version: number;
  readonly state: ProposalQueryState;
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ProposalApprovalView extends ProposalListItem {
  readonly schemaVersion: 1;
  readonly payloadHash: string;
  readonly approvalHash: string;
  readonly beforePreview: { readonly summary: string };
  readonly afterPreview: { readonly summary: string };
  readonly fields: readonly {
    readonly label: string;
    readonly value: string;
  }[];
}

export interface ProposalListPage {
  readonly schemaVersion: 1;
  readonly items: readonly ProposalListItem[];
  readonly nextCursor?: string;
}

export type ProposalListQueryResult =
  | { readonly status: 'ok'; readonly page: ProposalListPage }
  | { readonly status: 'invalid-cursor' };

/**
 * Read-only, principal-scoped approval projections. Implementations must derive
 * household/user/space scope from the principal and return no raw provider
 * records, canonical provider arguments, secrets, or disclosure-grant bodies.
 * Display strings come only from the immutable `approvalDisplay` projection
 * built by the registered capability at proposal materialization, strict-schema
 * validated, persisted with the proposal, and included in `approvalHash`.
 * Query implementations must never rebuild display data from canonical
 * arguments, provider previews/records, or token/keyword heuristics.
 */
export interface ProposalQueryGateway {
  list(input: {
    readonly state?: ProposalQueryState;
    /**
     * Server-issued authenticated cursor. Implementations must bind it to a
     * stable, server-derived authorization-scope fingerprint (user, household,
     * private space, sorted writable spaces, and membership role/version), the
     * exact authenticated session, filter/sort, issue/expiry times, and the
     * stable created-at/id position. Principal and authorization identifiers
     * are MAC inputs supplied from trusted request context and must not be
     * serialized into the client-visible cursor envelope.
     * Every request-current grant must independently re-prove an equivalent
     * scope. Unsigned, expired, tampered, or cross-scope cursors fail closed
     * and must never be treated as raw SQL/keyset input. Rotating grant IDs and
     * client-supplied scope aliases are not cursor authority. All cursor
     * verification failures collapse to `invalid-cursor`; storage/backend
     * failures throw and must not be disguised as client input errors.
     */
    readonly cursor?: string;
    readonly limit: number;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<ProposalListQueryResult>;
  getDetail(input: {
    readonly proposalId: string;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<ProposalApprovalView | undefined>;
}

export interface IssuedVisualProof {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly payloadHash: string;
  readonly approvalHash: string;
  /**
   * Opaque bearer material. Durable stores persist only its digest and key ID.
   * An exact idempotent issuance replay returns this byte-identical token.
   */
  readonly proofToken: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** True only for a byte-identical replay with unchanged issuance/expiry. */
  readonly replayed: boolean;
}

export type VisualProofIssueResult =
  | { readonly status: 'issued'; readonly proof: IssuedVisualProof }
  | {
      readonly status:
        | 'proposal-not-found'
        | 'proposal-not-pending'
        | 'proposal-expired'
        | 'proposal-binding-mismatch'
        | 'idempotency-conflict';
    };

/**
 * Issues a short-lived proof for one exact authenticated visual proposal view.
 * User, session, household, and request-current space authority are accepted
 * only from the server principal. The durable boundary must derive and bind a
 * stable effective-authorization fingerprint; each retry and decision request
 * uses its fresh grant only to re-prove equivalent active scope under DB locks.
 * Ephemeral grant IDs and client scope aliases are not proof authority.
 * Consumption belongs inside the same durable transaction as
 * VisualProposalDecisionGateway.decideWithVisualProof(). Exact idempotent
 * replay must deterministically reproduce the same token under a versioned
 * server-side HMAC key and must never rotate or extend its lifetime.
 */
export interface VisualProofIssuanceGateway {
  issue(input: {
    readonly proposalId: string;
    readonly expectedProposalVersion: number;
    readonly expectedPayloadHash: string;
    readonly expectedApprovalHash: string;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<VisualProofIssueResult>;
}

export interface SyncGateway {
  registerClient(input: {
    readonly clientId: string;
    readonly displayName: string;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly schemaVersion: 1;
    readonly clientId: string;
    readonly status: 'registered';
    readonly replayed: boolean;
  }>;
  issueToken(input: {
    readonly clientId: string;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<{
    readonly schemaVersion: 1;
    /** Server-configured same-origin PowerSync service endpoint. */
    readonly endpoint: string;
    readonly token: string;
    readonly expiresAt: string;
    readonly writeScope: {
      readonly clientId: string;
      readonly spaces: readonly {
        readonly id: string;
        readonly visibility: 'private' | 'shared';
        readonly originalOwnerUserId: string;
      }[];
    };
  }>;
  applyOperations(input: {
    readonly clientId: string;
    readonly operations: readonly SyncOperation[];
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly schemaVersion: 1;
    readonly clientId: string;
    readonly results: readonly SyncOperationOutcome[];
  }>;
}

export type SyncOperationOutcome =
  | {
      readonly operationId: string;
      readonly status: 'applied';
      readonly revision: number;
      readonly resolution:
        'created' | 'applied' | 'merged' | 'ignored' | 'duplicate';
      readonly conflicts: readonly SyncConflictDetail[];
      readonly replayed: boolean;
    }
  | {
      readonly operationId: string;
      readonly status: 'conflict';
      readonly code:
        | 'entity-exists'
        | 'entity-not-found'
        | 'revision-mismatch'
        | 'tombstoned'
        | 'mutation-invalid'
        | 'repository-rejected'
        | 'domain-operation-invalid'
        | 'domain-operation-unsupported'
        | 'base-revision-unavailable'
        | 'base-state-mismatch'
        | 'material-conflict'
        | 'idempotency-key-reused'
        | 'operation-in-progress';
      readonly disposition: 'terminal' | 'retryable';
      readonly currentRevision?: number;
      readonly conflicts: readonly SyncConflictDetail[];
      readonly replayed: boolean;
    }
  | {
      readonly operationId: string;
      readonly status: 'blocked';
      readonly code:
        | 'authorization-revoked'
        | 'dependency-missing'
        | 'dependency-failed'
        | 'dependency-cycle';
      readonly dependencyOperationId?: string;
      readonly disposition: 'terminal' | 'retryable';
      readonly conflicts: readonly SyncConflictDetail[];
      readonly replayed: false;
    };

export interface SyncConflictDetail {
  readonly field: string;
  readonly material: boolean;
}

export type AudioRunKind = 'transcription' | 'speech';

export type OpenAiSpeechModel =
  'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts' | 'gpt-4o-mini-tts-2025-12-15';

export interface AudioTranscriptionReplayResult {
  readonly kind: 'transcription';
  readonly transcript: string;
  readonly model: 'gpt-4o-mini-transcribe' | 'gpt-4o-transcribe';
  readonly spendWarning: boolean;
}

export type AudioRunClaim =
  | {
      /** This caller exclusively owns the not-yet-completed provider dispatch. */
      readonly status: 'claimed';
      readonly claimId: string;
      readonly ownershipToken: string;
      readonly executionId: string;
      readonly reservationId: string;
    }
  | {
      readonly status: 'replay';
      readonly result: AudioTranscriptionReplayResult;
    }
  | { readonly status: 'in-progress'; readonly retryAfterMs: number }
  | { readonly status: 'completed-nonreplayable' }
  | { readonly status: 'indeterminate' }
  | { readonly status: 'conflict' };

export interface AudioRequestCoordinator {
  /**
   * Atomically binds principal, key, and payload fingerprint. It owns request
   * replay only; the provider adapter exclusively owns the spend lifecycle.
   */
  claim(input: {
    readonly kind: AudioRunKind;
    readonly model: string;
    readonly inputUnits: number;
    readonly requestFingerprint: string;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<AudioRunClaim>;
  completeTranscription(input: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly transcript: string;
    readonly model: 'gpt-4o-mini-transcribe' | 'gpt-4o-transcribe';
    readonly spendWarning: boolean;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<void>;
  /** Persists metadata only. Generated audio bytes must never be persisted. */
  completeSpeech(input: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly model: OpenAiSpeechModel;
    readonly contentType: 'audio/mpeg' | 'audio/wav' | 'audio/ogg';
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<void>;
  /** Reopens an exact request only when the provider adapter proves no dispatch. */
  releaseKnownNoDispatch(input: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly reasonCode:
      | 'transcription-provider-not-dispatched'
      | 'speech-provider-not-dispatched';
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<void>;
  markIndeterminate(input: {
    readonly claimId: string;
    readonly ownershipToken: string;
    readonly reasonCode:
      | 'transcription-provider-state-unknown'
      | 'speech-provider-state-unknown'
      | 'transcription-settlement-state-unknown'
      | 'speech-settlement-state-unknown';
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<void>;
  /** Fails closed unless the durable receipt migration and command ACLs exist. */
  checkReady(): Promise<boolean>;
}

export interface VoiceGatewaySafeError {
  readonly code:
    | 'ai-spend-limit-reached'
    | 'audio-provider-unavailable'
    | 'audio-request-invalid'
    | 'audio-provider-failed';
  readonly message: string;
  readonly retryable: boolean;
}

export interface VoiceGateway {
  /**
   * Parses the declared container from owned in-memory bytes, derives a
   * server-trusted duration, and rejects MIME/container mismatches. It must not
   * write files, log bytes, or delegate to OpenAI.
   */
  inspectRecording(input: {
    readonly audio: Uint8Array;
    readonly declaredContentType: string;
    readonly durationHintMs: number;
    readonly maximumDurationMs: 60_000;
  }): Promise<
    | {
        readonly status: 'verified';
        readonly verifiedContentType:
          | 'audio/webm'
          | 'audio/mpeg'
          | 'audio/mp4'
          | 'audio/ogg'
          | 'audio/wav'
          | 'audio/x-wav';
        readonly durationMs: number;
      }
    | {
        readonly status: 'rejected';
        readonly code:
          | 'audio-container-invalid'
          | 'audio-duration-invalid'
          | 'audio-inspector-unavailable';
      }
  >;
  getSpeechConfiguration(): Promise<{
    readonly model: OpenAiSpeechModel;
    readonly configurationVersion: string;
  }>;
  /** The caller zeroes this transient view immediately after completion. */
  transcribe(input: {
    readonly audio: Uint8Array;
    readonly contentType: string;
    /** Client claim that the gateway must independently validate against media. */
    readonly durationMs: number;
    readonly attempt: 'default' | 'accuracy-retry';
    readonly model: 'gpt-4o-mini-transcribe' | 'gpt-4o-transcribe';
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly executionId: string;
    readonly reservationId: string;
  }): Promise<
    | {
        readonly status: 'completed';
        readonly transcript: string;
        readonly model: 'gpt-4o-mini-transcribe' | 'gpt-4o-transcribe';
        readonly spendWarning: boolean;
      }
    | {
        readonly status: 'failed';
        readonly safeError: VoiceGatewaySafeError;
        readonly reconciliationRequired: boolean;
      }
  >;
  speak(input: {
    readonly text: string;
    readonly voice: string;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly executionId: string;
    readonly reservationId: string;
  }): Promise<
    | {
        readonly status: 'completed';
        readonly audio: Uint8Array;
        readonly contentType: 'audio/mpeg' | 'audio/wav' | 'audio/ogg';
        readonly model: OpenAiSpeechModel;
        readonly spendWarning: boolean;
      }
    | {
        readonly status: 'failed';
        readonly safeError: VoiceGatewaySafeError;
        readonly reconciliationRequired: boolean;
      }
  >;
}

export interface GoogleConnectorGateway {
  /** Scopes and exact redirect URI are server configuration, never request input. */
  beginAuthorization(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly returnTo?: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly authorizationUrl: string;
    readonly expiresAt: string;
  }>;
  /** Must consume state once, verify PKCE, and use the configured exact redirect. */
  completeAuthorization(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly code?: string;
    readonly state: string;
    readonly error?: string;
    readonly errorDescription?: string;
    readonly requestId: string;
  }): Promise<
    | {
        readonly status: 'connected';
        readonly connectionId: string;
        readonly grantedScopes: readonly string[];
      }
    | { readonly status: 'denied' }
  >;
  /** Must revoke upstream authorization and remove encrypted vault material. */
  disconnect(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly status: 'disconnected' }>;
}

export type HouseholdRole = 'owner' | 'member';

export interface HouseholdInvitationSummary {
  readonly id: string;
  readonly email: string;
  readonly role: HouseholdRole;
  readonly status: 'pending' | 'consumed' | 'revoked' | 'expired';
  readonly version: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface HouseholdMembershipSummary {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly role: HouseholdRole;
  readonly status: 'active' | 'inactive';
  readonly version: number;
  readonly joinedAt: string;
  readonly endedAt?: string;
}

/**
 * Owner administration is scoped only by the current server-authenticated
 * principal. Implementations must revalidate that owner authority inside the
 * same durable operation; routes also deny non-owner principals before use.
 */
export interface HouseholdAdministrationGateway {
  issueInvitation(input: {
    readonly email: string;
    readonly role: HouseholdRole;
    readonly expiresInSeconds: number;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly schemaVersion: 1;
    readonly invitation: HouseholdInvitationSummary & {
      readonly status: 'pending';
      readonly deliveryStatus: 'queued';
    };
    readonly replayed: boolean;
  }>;
  listInvitations(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<{
    readonly schemaVersion: 1;
    readonly invitations: readonly HouseholdInvitationSummary[];
  }>;
  revokeInvitation(input: {
    readonly invitationId: string;
    readonly expectedVersion: number;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly schemaVersion: 1;
    readonly invitation: HouseholdInvitationSummary & {
      readonly status: 'revoked';
    };
    readonly replayed: boolean;
  }>;
  listMemberships(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<{
    readonly schemaVersion: 1;
    readonly memberships: readonly HouseholdMembershipSummary[];
  }>;
  changeMembershipRole(input: {
    readonly membershipId: string;
    readonly expectedVersion: number;
    readonly role: HouseholdRole;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly schemaVersion: 1;
    readonly membership: HouseholdMembershipSummary;
    readonly replayed: boolean;
  }>;
  deactivateMembership(input: {
    readonly membershipId: string;
    readonly expectedVersion: number;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly schemaVersion: 1;
    readonly membership: HouseholdMembershipSummary & {
      readonly status: 'inactive';
      readonly endedAt: string;
    };
    readonly replayed: boolean;
  }>;
}

export interface JwksGateway {
  getPublicJwks(): Promise<unknown>;
}

export interface TodayReadGateway {
  read(input: {
    readonly date: string;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<TodayView>;
}

export interface ActivityReadGateway {
  list(input: {
    readonly cursor?: string;
    readonly limit: number;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<ActivityPage>;
}

export interface ScheduleReadGateway {
  list(input: {
    readonly from: string;
    readonly to: string;
    readonly cursor?: string;
    readonly limit: number;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<SchedulePage>;
}

export interface FinanceReadGateway {
  list(input: {
    readonly cursor?: string;
    readonly limit: number;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<FinancePage>;
}

export interface ShoppingReadGateway {
  list(input: {
    readonly cursor?: string;
    readonly limit: number;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<ShoppingPage>;
}

export interface SettingsReadGateway {
  read(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<SettingsView>;
}

export interface NotificationPreferencesGateway {
  get(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<NotificationPreferencesView>;
  update(input: {
    readonly expectedVersion: number;
    readonly preferences: NotificationPreferencesUpdateRequest['preferences'];
    readonly idempotencyKey: string;
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
  }): Promise<NotificationPreferencesView>;
}

export interface ReadinessGateway {
  check(): Promise<{
    readonly ready: boolean;
    readonly checks: Readonly<Record<string, 'ok' | 'unavailable'>>;
  }>;
}

export interface MetricsGateway {
  authorize(input: {
    readonly authorization?: string;
    readonly requestId: string;
  }): Promise<boolean>;
  render(): Promise<string>;
}

export interface ApiServices {
  readonly auth: AuthenticationBoundary;
  readonly activityRead: ActivityReadGateway;
  readonly financeRead: FinanceReadGateway;
  readonly managerTurns: ManagerTurnGateway;
  readonly notificationPreferences: NotificationPreferencesGateway;
  readonly runEvents: PersistedRunEventGateway;
  readonly proposalQueries: ProposalQueryGateway;
  readonly visualProofs: VisualProofIssuanceGateway;
  readonly proposals: VisualProposalDecisionGateway;
  readonly sync: SyncGateway;
  readonly audioRequests: AudioRequestCoordinator;
  readonly voice: VoiceGateway;
  readonly google: GoogleConnectorGateway;
  readonly householdAdministration: HouseholdAdministrationGateway;
  readonly scheduleRead: ScheduleReadGateway;
  readonly settingsRead: SettingsReadGateway;
  readonly shoppingRead: ShoppingReadGateway;
  readonly todayRead: TodayReadGateway;
  readonly jwks: JwksGateway;
  readonly readiness: ReadinessGateway;
  readonly metrics: MetricsGateway;
}
