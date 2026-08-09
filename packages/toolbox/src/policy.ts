import type { AgentManifest, CapabilityDescriptor } from '@emdo/contracts';

import { ToolboxPolicyError } from './errors.js';

const RISK_RANK = {
  none: 0,
  read: 1,
  'local-write': 2,
  'provider-write': 3,
} as const;

export const assertCapabilityAllowed = (
  manifest: AgentManifest,
  descriptor: CapabilityDescriptor,
): void => {
  if (!manifest.capabilityAllowlist.includes(descriptor.id)) {
    throw new ToolboxPolicyError(
      'capability-not-allowlisted',
      `Capability ${descriptor.id} is not allowlisted for ${manifest.id}`,
    );
  }

  if (
    manifest.kind === 'manager' &&
    descriptor.capabilityKind !== 'delegation'
  ) {
    throw new ToolboxPolicyError(
      'manager-capability-denied',
      'The manager may resolve delegation capabilities only',
    );
  }

  if (RISK_RANK[descriptor.riskClass] > RISK_RANK[manifest.riskCeiling]) {
    throw new ToolboxPolicyError(
      'risk-ceiling-exceeded',
      `Capability ${descriptor.id} exceeds the agent risk ceiling`,
    );
  }

  const readableDataClasses = new Set(manifest.readableDataClasses);
  if (
    descriptor.requiredDataClasses.some(
      (dataClass) => !readableDataClasses.has(dataClass),
    )
  ) {
    throw new ToolboxPolicyError(
      'data-class-denied',
      `Capability ${descriptor.id} requires an unreadable data class`,
    );
  }

  if (
    descriptor.capabilityKind === 'provider-write' &&
    descriptor.approval.rule !== 'authenticated-visual-proposal'
  ) {
    throw new ToolboxPolicyError(
      'provider-write-approval-required',
      'Provider writes require an authenticated visual proposal',
    );
  }
};
