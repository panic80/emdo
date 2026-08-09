import { z } from 'zod';

import {
  AgentManifestSchema,
  CapabilityDescriptorSchema,
  IdentifierSchema,
  type AgentManifest,
  type RegisteredCapability,
  type ResolvedCapability,
} from '@emdo/contracts';

import { ToolboxPolicyError } from './errors.js';
import { assertCapabilityAllowed } from './policy.js';

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

    const input = Object.freeze({
      reference: descriptor.inputSchema,
      schema: registration.inputSchema,
    });
    const output = Object.freeze({
      reference: descriptor.outputSchema,
      schema: registration.outputSchema,
    });
    const invoke: ResolvedCapability['invoke'] = async (rawInput, context) => {
      const parsedInput = registration.inputSchema.parse(rawInput);
      const rawOutput = await registration.execute(parsedInput, context);
      return registration.outputSchema.parse(rawOutput);
    };

    byId.set(
      descriptor.id,
      Object.freeze({ descriptor, input, output, invoke }),
    );
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
