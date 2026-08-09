import { z } from 'zod';

import {
  AgentManifestSchema,
  CapabilityDescriptorSchema,
  IdentifierSchema,
  ProviderWriteApprovalClaimsSchema,
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

export const createCapabilityRegistry = (
  registrations: readonly RegisteredCapability[],
  runtimeSchemas: RuntimeSchemaRegistry,
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
        const approval = context.providerWriteApproval;
        if (approval === undefined) {
          throw new ToolboxPolicyError(
            'provider-write-approval-missing',
            'Provider-write execution requires an approved proposal',
          );
        }

        const claimsResult = ProviderWriteApprovalClaimsSchema.safeParse(
          approval.claims,
        );
        if (!claimsResult.success) {
          throw new ToolboxPolicyError(
            'provider-write-approval-invalid',
            'Provider-write approval claims are invalid',
          );
        }
        const claims = claimsResult.data;
        const bindingIsValid =
          claims.userId === context.userId &&
          claims.runId === context.runId &&
          claims.capabilityId === descriptor.id &&
          claims.payloadHash === hashCanonicalJson(parsedInput);
        if (!bindingIsValid) {
          throw new ToolboxPolicyError(
            'provider-write-approval-invalid',
            'Provider-write approval does not match this execution',
          );
        }
        const now = Date.now();
        if (
          Date.parse(claims.approvedAt) > now ||
          Date.parse(claims.expiresAt) < now
        ) {
          throw new ToolboxPolicyError(
            'provider-write-approval-expired',
            'Provider-write approval is not currently valid',
          );
        }
        if (!(await approval.consume(claims.decisionId))) {
          throw new ToolboxPolicyError(
            'provider-write-approval-consumed',
            'Provider-write approval was already consumed',
          );
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
