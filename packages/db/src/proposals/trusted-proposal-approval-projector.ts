import {
  ActionProposalApprovalDisplayFieldSchema,
  ActionProposalApprovalDisplaySchema,
  deepFreeze,
  type ActionProposalApprovalDisplay,
  type ActionProposalApprovalDisplayField,
} from '@emdo/contracts';

export const PersistedProposalApprovalDisplayFieldSchema =
  ActionProposalApprovalDisplayFieldSchema;

/**
 * The only proposal display material that a read adapter may accept from the
 * database. It is constructed by the owning capability before persistence and
 * is covered by the proposal approval hash. Validation is deliberately
 * non-transforming so the display bytes are not changed after hashing.
 */
export const PersistedProposalApprovalDisplaySchema =
  ActionProposalApprovalDisplaySchema;

/**
 * Compatibility name retained for query-adapter imports. The trusted source
 * is now exactly the persisted approval display, never a capability preview or
 * provider record from which display text is reconstructed at read time.
 */
export const TrustedProposalApprovalSourceSchema =
  PersistedProposalApprovalDisplaySchema;

export type PersistedProposalApprovalDisplay = ActionProposalApprovalDisplay;
export type TrustedProposalApprovalSource = PersistedProposalApprovalDisplay;
export type TrustedProposalApprovalProjection =
  PersistedProposalApprovalDisplay;
export type TrustedProposalApprovalField = ActionProposalApprovalDisplayField;

export class TrustedProposalApprovalProjectionError extends Error {
  constructor(
    readonly code: 'invalid-source',
    message: string,
  ) {
    super(message);
    this.name = 'TrustedProposalApprovalProjectionError';
  }
}

/**
 * Validates and freezes the already-materialized, approval-hash-bound display.
 *
 * There is intentionally no raw argument/preview traversal, capability switch,
 * text denylist, trimming, or other normalization here. Capability-owned
 * materialization is the trust boundary; this read seam only proves the strict
 * persisted shape and returns an immutable copy.
 */
export const projectTrustedProposalApproval = (
  approvalDisplayInput: unknown,
): TrustedProposalApprovalProjection => {
  const parsed =
    PersistedProposalApprovalDisplaySchema.safeParse(approvalDisplayInput);
  if (!parsed.success) {
    throw new TrustedProposalApprovalProjectionError(
      'invalid-source',
      'Persisted proposal approval display is malformed',
    );
  }

  return deepFreeze(parsed.data);
};
