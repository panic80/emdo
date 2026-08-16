export const DATABASE_ROLES = Object.freeze({
  application: 'emdo_app',
  authentication: 'emdo_auth',
  worker: 'emdo_worker',
} as const);

/**
 * Only these server-resolved identifiers are allowed in transaction-local
 * context. Household, membership role, space visibility, and ownership are
 * always derived from canonical rows inside PostgreSQL.
 */
export const TRUSTED_IDENTITY_SETTINGS = Object.freeze({
  userId: 'emdo.user_id',
  sessionId: 'emdo.session_id',
  requestId: 'emdo.request_id',
} as const);
