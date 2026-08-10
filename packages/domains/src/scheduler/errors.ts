export type SchedulerDomainErrorCode =
  | 'ambiguous-local-time'
  | 'calendar-arguments-invalid'
  | 'calendar-authorization-invalid'
  | 'calendar-capability-mismatch'
  | 'calendar-evidence-duplicate'
  | 'calendar-evidence-invalid'
  | 'calendar-evidence-missing'
  | 'calendar-evidence-stale'
  | 'calendar-evidence-unauthorized'
  | 'calendar-event-already-exists'
  | 'calendar-event-not-found'
  | 'calendar-precondition-failed'
  | 'invalid-local-time'
  | 'nonexistent-local-time'
  | 'planning-input-invalid'
  | 'recurrence-out-of-bounds'
  | 'travel-input-invalid';

export class SchedulerDomainError extends Error {
  constructor(
    readonly code: SchedulerDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SchedulerDomainError';
  }
}
