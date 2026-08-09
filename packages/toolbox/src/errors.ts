export type ToolboxPolicyErrorCode =
  | 'duplicate-capability'
  | 'unknown-capability'
  | 'capability-not-allowlisted'
  | 'manager-capability-denied'
  | 'risk-ceiling-exceeded'
  | 'data-class-denied'
  | 'provider-write-approval-required'
  | 'provider-write-approval-missing'
  | 'provider-write-approval-invalid'
  | 'provider-write-approval-expired'
  | 'provider-write-approval-consumed';

export class ToolboxPolicyError extends Error {
  readonly code: ToolboxPolicyErrorCode;

  constructor(code: ToolboxPolicyErrorCode, message: string) {
    super(message);
    this.name = 'ToolboxPolicyError';
    this.code = code;
  }
}
