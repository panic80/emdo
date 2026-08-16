import { describe, expect, it } from 'vitest';

import {
  parseProviderWriteCapabilityDescriptor,
  type ProviderWriteCapabilityDescriptor,
  type ProviderWriteCapabilityId,
} from '@emdo/contracts';

import {
  sdkToolNameForCapability,
  type AgentSdkToolConfig,
  type ResolvedAgentCapability,
} from './factory.js';

type ProviderWriteToolConfig = Extract<
  AgentSdkToolConfig,
  { readonly capabilityKind: 'provider-write' }
>;
type StandardToolConfig = Exclude<AgentSdkToolConfig, ProviderWriteToolConfig>;
type ProviderWriteResolution = Extract<
  ResolvedAgentCapability,
  { readonly descriptor: { readonly capabilityKind: 'provider-write' } }
>;

const assertFactoryCapabilityBoundary = (
  providerWrite: ProviderWriteCapabilityDescriptor,
  standard: StandardToolConfig,
  arbitraryString: string,
): void => {
  const providerToolId: ProviderWriteToolConfig['canonicalCapabilityId'] =
    providerWrite.id;
  const providerResolutionId: ProviderWriteResolution['descriptor']['id'] =
    providerWrite.id;
  const standardToolId: StandardToolConfig['canonicalCapabilityId'] =
    arbitraryString;

  // @ts-expect-error Provider-write SDK tools require the nominal high-risk identifier.
  const arbitraryProviderToolId: ProviderWriteToolConfig['canonicalCapabilityId'] =
    arbitraryString;
  // @ts-expect-error Provider-write resolutions cannot carry a generic string ID.
  const arbitraryProviderResolutionId: ProviderWriteResolution['descriptor']['id'] =
    arbitraryString;

  void standard;
  void providerToolId;
  void providerResolutionId;
  void standardToolId;
  void arbitraryProviderToolId;
  void arbitraryProviderResolutionId;
};

void assertFactoryCapabilityBoundary;

const providerWriteDescriptorWire = {
  schemaVersion: 1,
  id: 'google-calendar.event.create',
  version: '1.0.0',
  capabilityKind: 'provider-write',
  inputSchema: { id: 'calendar.event-create.input', version: '1.0.0' },
  outputSchema: { id: 'calendar.event-create.output', version: '1.0.0' },
  requiredScopes: ['google-calendar.events.write'],
  requiredDataClasses: ['calendar.events'],
  riskClass: 'provider-write',
  timeoutMs: 30_000,
  freshness: {
    required: true,
    maxAgeMs: 0,
    revalidateBeforeExecution: true,
  },
  idempotency: {
    required: true,
    scope: 'provider-target',
    ttlMs: 86_400_000,
  },
  approval: {
    rule: 'authenticated-visual-proposal',
    expiresInSeconds: 600,
  },
  audit: {
    required: true,
    eventType: 'calendar.external-write',
    redactFields: ['description'],
  },
  executorId: 'google-calendar.event-create.v1',
} as const;

describe('agent factory provider-write identifier boundary', () => {
  it('keeps the branded identifier as a primitive canonical SDK tool name input', () => {
    const descriptor = parseProviderWriteCapabilityDescriptor(
      providerWriteDescriptorWire,
    );
    const id: ProviderWriteCapabilityId = descriptor.id;

    expect(id).toBe(providerWriteDescriptorWire.id);
    expect(sdkToolNameForCapability(id)).toBe('google_calendar_event_create');
  });
});
