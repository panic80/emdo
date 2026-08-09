import { z } from 'zod';

import {
  AgentManifestSchema,
  CapabilityDescriptorSchema,
  IdentifierSchema,
  UuidSchema,
  type AgentManifest,
  type RegisteredCapability,
  type ResolvedCapability,
  type RuntimeSchemaRegistry,
} from '@emdo/contracts';

import { ToolboxPolicyError } from './errors.js';
import { assertCapabilityAllowed, hashCanonicalJson } from './policy.js';

const ResolutionRequestSchema = z.strictObject({
  manifest: AgentManifestSchema,
  requestedCapabilityIds: z.array(IdentifierSchema).max(128),
});

export interface CapabilityRegistry {
  readonly size: number;
  resolveForAgent(request: {
    readonly manifest: AgentManifest;
    readonly requestedCapabilityIds: readonly string[];
  }): readonly ResolvedCapability[];
}

export type ProviderWriteApprovalStatus =
  'authorized' | 'not-found' | 'mismatch' | 'expired' | 'consumed';

export interface ProviderWriteApprovalBinding {
  readonly decisionId: string;
  readonly userId: string;
  readonly runId: string;
  readonly capabilityId: string;
  readonly payloadHash: string;
  readonly checkedAt: string;
}

export interface ProviderWriteApprovalStore {
  /** Atomically verifies persisted visual approval and consumes it for this binding. */
  consume(
    binding: ProviderWriteApprovalBinding,
  ): Promise<ProviderWriteApprovalStatus>;
}

export interface CapabilityRegistryOptions {
  readonly providerWriteApprovalStore?: ProviderWriteApprovalStore;
}

export const createCapabilityRegistry = (
  registrations: readonly RegisteredCapability[],
  runtimeSchemas: RuntimeSchemaRegistry,
  options: CapabilityRegistryOptions = {},
): CapabilityRegistry => {
  const byId = new Map<string, ResolvedCapability>();

  for (const registration of registrations) {
    const descriptor = CapabilityDescriptorSchema.parse(
      registration.descriptor,
    );
    if (byId.has(descriptor.id)) {
      throw new ToolboxPolicyError(
        'duplicate-capability',
        `Capability ${descriptor.id} is already registered`,
      );
    }
    runtimeSchemas.schema(descriptor.inputSchema);
    runtimeSchemas.schema(descriptor.outputSchema);
    const invoke: ResolvedCapability['invoke'] = async (rawInput, context) => {
      const parsedInput = runtimeSchemas.parse(
        descriptor.inputSchema,
        rawInput,
      );

      if (descriptor.capabilityKind === 'provider-write') {
        const approvalStore = options.providerWriteApprovalStore;
        if (approvalStore === undefined) {
          throw new ToolboxPolicyError(
            'provider-write-approval-store-required',
            'Provider-write execution requires the server approval store',
          );
        }
        const decisionId = UuidSchema.safeParse(context.approvalDecisionId);
        if (!decisionId.success) {
          throw new ToolboxPolicyError(
            'provider-write-approval-missing',
            'Provider-write execution requires an approved proposal',
          );
        }

        const approvalStatus = await approvalStore.consume({
          decisionId: decisionId.data,
          userId: context.userId,
          runId: context.runId,
          capabilityId: descriptor.id,
          payloadHash: hashCanonicalJson(parsedInput),
          checkedAt: new Date().toISOString(),
        });
        if (approvalStatus !== 'authorized') {
          const [code, message] =
            approvalStatus === 'expired'
              ? ([
                  'provider-write-approval-expired',
                  'Provider-write approval is no longer valid',
                ] as const)
              : approvalStatus === 'consumed'
                ? ([
                    'provider-write-approval-consumed',
                    'Provider-write approval was already consumed',
                  ] as const)
                : ([
                    'provider-write-approval-invalid',
                    'Provider-write approval does not match this execution',
                  ] as const);
          throw new ToolboxPolicyError(code, message);
        }
      }

      const rawOutput = await registration.execute(parsedInput, context);
      return runtimeSchemas.parse(descriptor.outputSchema, rawOutput);
    };

    byId.set(descriptor.id, Object.freeze({ descriptor, invoke }));
  }

  const resolveForAgent: CapabilityRegistry['resolveForAgent'] = (
    rawRequest,
  ) => {
    const request = ResolutionRequestSchema.parse(rawRequest);
    const seen = new Set<string>();

    return Object.freeze(
      request.requestedCapabilityIds.map((capabilityId) => {
        if (seen.has(capabilityId)) {
          throw new ToolboxPolicyError(
            'duplicate-capability',
            `Capability ${capabilityId} was requested more than once`,
          );
        }
        seen.add(capabilityId);

        const registration = byId.get(capabilityId);
        if (registration === undefined) {
          throw new ToolboxPolicyError(
            'unknown-capability',
            `Capability ${capabilityId} is not registered`,
          );
        }

        assertCapabilityAllowed(request.manifest, registration.descriptor);
        return registration;
      }),
    );
  };

  return Object.freeze({ size: byId.size, resolveForAgent });
};
