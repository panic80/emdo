export type ToolboxPolicyErrorCode =
  | 'duplicate-capability'
  | 'unknown-capability'
  | 'capability-not-allowlisted'
  | 'manager-capability-denied'
  | 'risk-ceiling-exceeded'
  | 'data-class-denied'
  | 'capability-registration-invalid'
  | 'provider-write-approval-required'
  | 'provider-write-approval-store-required'
  | 'provider-write-approval-missing'
  | 'provider-write-approval-invalid'
  | 'provider-write-approval-expired'
  | 'provider-write-recovery-required'
  | 'provider-write-precondition-stale'
  | 'provider-write-not-applied'
  | 'provider-write-outcome-indeterminate'
  | 'provider-write-output-invalid'
  | 'provider-write-finalization-failed';

export class ToolboxPolicyError extends Error {
  readonly code: ToolboxPolicyErrorCode;

  constructor(code: ToolboxPolicyErrorCode, message: string) {
    super(message);
    this.name = 'ToolboxPolicyError';
    this.code = code;
  }
}
