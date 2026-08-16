/**
 * Curated Node-only API persistence surface.
 *
 * Key-rotation stores remain intentionally absent until their durable ports
 * land. Manager-turn idempotency is exposed only through its aggregate store.
 */
export { createDatabaseClient } from './client.js';
export type { EmdoDatabaseClient } from './client.js';

export { createPostgresBetterAuthOrganizationClaimBridge } from './better-auth-claim-transaction.js';
export type {
  BetterAuthOrganizationClaimIdentity,
  PostgresBetterAuthOrganizationClaimBridge,
  PostgresBetterAuthOrganizationClaimBridgeDependencies,
  PostgresBetterAuthOrganizationClaimTransaction,
} from './better-auth-claim-transaction.js';
export { PostgresInvitationRedemptionCoordinator } from './invitation-redemption-coordinator.js';
export type {
  InvitationPasswordHasher,
  InvitationRedemptionResult,
} from './invitation-redemption-coordinator.js';

export {
  PostgresSpaceAccessGrantService,
  SpaceAccessGrantError,
} from './auth/space-access-grants.js';
export type {
  ActiveSpaceAccessGrant,
  SpaceAccessGrantVerifier,
} from './auth/space-access-grants.js';
export {
  HouseholdAdministrationError,
  PostgresHouseholdAdministrationService,
} from './auth/household-administration.js';
export type {
  HouseholdAdministrationErrorCode,
  HouseholdAdministrationPrincipal,
  HouseholdInvitationView,
  HouseholdMembershipView,
  InvitationDeliverySecretSealer,
} from './auth/household-administration.js';

export {
  CanonicalRecordEnvelopeDisclosureFilter,
  DataDisclosureGrantIssueError,
  hashDataDisclosureGrant,
  ModelDisclosureGatewayError,
  PostgresDataDisclosureGrantIssuer,
  PostgresModelDisclosureGateway,
  PostgresSchedulerDisclosureGrantResolver,
  SchedulerDisclosureGrantResolverError,
} from './agent/disclosure-gateway.js';
export type {
  DisclosureFilterGrant,
  DisclosurePayloadFilter,
  DisclosurePayloadFilterResult,
  IssuedDataDisclosureGrant,
  ModelDisclosureDenialReason,
  SchedulerDisclosureGrantResolverScope,
} from './agent/disclosure-gateway.js';
export { PostgresApprovalCheckpointRepository } from './agent/approval-checkpoint-repository.js';
export type {
  PostgresApprovalCheckpointConsumeResult,
  PostgresApprovalCheckpointIdentity,
  PostgresStoredApprovalCheckpoint,
} from './agent/approval-checkpoint-repository.js';
export {
  ApprovalResumePersistenceError,
  PostgresApprovalResumeBoundary,
} from './agent/approval-resume-boundary.js';
export type {
  PostgresApprovalResumeBinding,
  PostgresApprovalResumeBoundaryOptions,
  PostgresApprovalResumeClaim,
  PostgresApprovalResumeCompletion,
  PostgresApprovalResumePrincipal,
} from './agent/approval-resume-boundary.js';
export {
  ManagerTurnPersistenceError,
  PostgresManagerTurnStore,
} from './agent/manager-turn-store.js';
export type {
  PostgresManagerTurnClaim,
  PostgresManagerTurnCompletion,
  PostgresManagerTurnIndeterminate,
  PostgresManagerTurnPrincipal,
  PostgresManagerTurnRequest,
  PostgresManagerTurnStoreOptions,
} from './agent/manager-turn-store.js';
export { PostgresAgentMemoryRepository } from './agent/memory-repository.js';
export type { AgentRunRecord } from './agent/memory-repository.js';
export { PostgresRunEventSource } from './agent/run-event-source.js';
export {
  PostgresSpendLedger,
  checkPostgresAudioSpendReadiness,
} from './agent/spend-ledger.js';
export type {
  PostgresSpendReservationRequest,
  PostgresSpendReservationResult,
} from './agent/spend-ledger.js';

export { PostgresCalendarWriteReceiptStore } from './scheduler/calendar-write-receipts.js';
export type {
  PostgresCalendarReceiptAcquisition,
  PostgresCalendarWriteResult,
} from './scheduler/calendar-write-receipts.js';

export {
  PostgresEncryptedGoogleCalendarGrantStore,
  PostgresGoogleCalendarProposalAuthorityResolver,
  PostgresGoogleCalendarProviderAuthorityResolver,
  PostgresGoogleOAuthAuditSink,
  PostgresGoogleOAuthAuthorizationEpochStore,
  PostgresGoogleOAuthDisconnectOperationStore,
  PostgresGoogleOAuthFlowStore,
  PostgresGoogleOAuthGrantLease,
  checkPostgresGoogleOAuthRuntimeReadiness,
} from './google/oauth-persistence.js';
export type {
  PostgresEncryptedGoogleCalendarGrantRecord,
  PostgresGoogleCalendarVaultScope,
  PostgresEncryptedVaultPayload,
  PostgresGoogleOAuthActor,
  PostgresGoogleOAuthFlowConsumeResult,
  PostgresGoogleOAuthFlowRecord,
  PostgresGoogleOAuthRequestAuthority,
} from './google/oauth-persistence.js';

export type { DurableRepositoryPrincipal } from './durable/scoped-transaction.js';

export { PostgresProviderFreeShoppingService } from './shopping/postgres-provider-free-shopping-service.js';
export type {
  ProviderFreeShoppingCreateInput,
  ProviderFreeShoppingCreateResult,
} from './shopping/postgres-provider-free-shopping-service.js';

export {
  FinanceImportPersistenceError,
  PostgresFinanceImportRepository,
} from './finance/postgres-finance-import-repository.js';

export {
  checkPostgresExperienceReadiness,
  createPostgresExperienceReadGateways,
  createPostgresExperienceReadinessChecks,
} from './experience/postgres-experience-read.js';
export type {
  ExperienceApiPrincipal,
  PostgresExperienceReadGateways,
  PostgresExperienceReadinessChecks,
} from './experience/postgres-experience-read.js';
export {
  ExperienceQueryCursorCodec,
  ExperienceQueryCursorCodecError,
} from './experience/experience-query-cursor-codec.js';
export type {
  ExperienceQueryCursorBinding,
  ExperienceQueryCursorExpectedBinding,
  ExperienceQueryCursorHmacKey,
  ExperienceQueryCursorPreviousHmacKey,
} from './experience/experience-query-cursor-codec.js';

export {
  AudioRequestCoordinatorError,
  PostgresAudioRequestCoordinator,
  PostgresAudioRequestReconciliationStore,
} from './audio/postgres-audio-request-coordinator.js';
export type {
  AudioIndeterminateReason,
  AudioKnownNoDispatchReason,
  AudioRequestClaim,
  AudioRequestPrincipal,
  AudioRequestReconciliationItem,
} from './audio/postgres-audio-request-coordinator.js';

export {
  checkPostgresProposalWorkflowReadiness,
  checkPostgresVisualDecisionReadiness,
  PostgresProposalRepository,
  ProposalPersistenceError,
} from './proposals/postgres-proposal-repository.js';
export type {
  DurableDecisionProposalRecord,
  DurablePreparedProposalRecord,
  PostgresProposalRepositoryOptions,
  ProposalRepository,
  ProposalRepositoryTransaction,
  StoredDecision,
  StoredProposalPreparation,
  StoredProviderWriteAttempt,
  StoredProviderWriteCompletion,
} from './proposals/postgres-proposal-repository.js';
export {
  PostgresProposalApprovalError,
  PostgresProposalQueryRepository,
} from './proposals/postgres-proposal-query-repository.js';
export type {
  ProposalApiPrincipal,
  ProposalApprovalView,
  ProposalListItem,
  ProposalListPage,
  ProposalListQueryResult,
  ProposalQueryState,
} from './proposals/postgres-proposal-query-repository.js';
export {
  ProposalQueryCursorCodec,
  ProposalQueryCursorCodecError,
} from './proposals/proposal-query-cursor-codec.js';
export type {
  ProposalQueryCursorBinding,
  ProposalQueryCursorHmacKey,
  ProposalQueryCursorPreviousHmacKey,
} from './proposals/proposal-query-cursor-codec.js';
export {
  hashVisualDecisionProofToken,
  PostgresVisualDecisionProofStore,
} from './proposals/postgres-visual-decision-proof-store.js';
export type {
  IssuedVisualDecisionProof,
  VisualDecisionProofIssueResult,
} from './proposals/postgres-visual-decision-proof-store.js';
export {
  VisualDecisionProofTokenCodec,
  VisualDecisionProofTokenCodecError,
} from './proposals/visual-decision-proof-token-codec.js';
export type {
  VisualDecisionProofHmacKey,
  VisualDecisionProofPreviousHmacKey,
  VisualDecisionProofTokenBinding,
} from './proposals/visual-decision-proof-token-codec.js';
export {
  projectTrustedProposalApproval,
  TrustedProposalApprovalProjectionError,
  TrustedProposalApprovalSourceSchema,
} from './proposals/trusted-proposal-approval-projector.js';
export type {
  TrustedProposalApprovalProjection,
  TrustedProposalApprovalSource,
} from './proposals/trusted-proposal-approval-projector.js';
