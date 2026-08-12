/**
 * Side-effect-free public surface for workspace consumers and contract checks.
 *
 * Browser bootstrapping stays in `main.tsx`; importing this module must never
 * mount React, register a service worker, or touch `document`.
 */
export {
  DESKTOP_NAV_ITEMS,
  MOBILE_PRIMARY_ITEMS,
  MOBILE_SECONDARY_ITEMS,
  resolveNavigationState,
  type AppRouteId,
  type NavigationItem,
  type NavigationState,
  type ShellIconName,
} from './app-shell-model.js';
export {
  createImmutableProposalView,
  getApprovalAvailability,
  submitProposalDecision,
  type ApprovalSource,
  type ProposalView,
} from './features/approval/approval-model.js';
export {
  ChatClientError,
  PersistedRunEventBuffer,
  createTurn,
  parseEventStream,
  readRunEvents,
  type AssistantSpecialist,
  type HttpDependencies,
  type PersistedRunEvent,
  type TurnAccepted,
  type TurnRequest,
} from './features/chat/sse-client.js';
export {
  LogoutFlowController,
  SafeUpdateCoordinator,
  type LogoutBoundaryAdapter,
  type LogoutBoundaryStatus,
  type LogoutFlowSnapshot,
  type UpdateState,
} from './features/sync/update-coordinator.js';
