import { describe, expect, it } from 'vitest';

import {
  CapabilityDescriptorSchema,
  parseProviderWriteCapabilityDescriptor,
  type CapabilityDescriptor,
  type ProviderWriteCapabilityDescriptor,
  type ProviderWriteCapabilityId,
  type RegisteredCapability,
  type ResolvedCapability,
} from './index.js';

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

const readDescriptorWire = {
  ...providerWriteDescriptorWire,
  id: 'calendar.events.read',
  capabilityKind: 'read',
  requiredScopes: ['google-calendar.events.read'],
  riskClass: 'read',
  freshness: {
    required: true,
    maxAgeMs: 60_000,
    revalidateBeforeExecution: false,
  },
  idempotency: {
    required: false,
    scope: 'request',
    ttlMs: 60_000,
  },
  approval: { rule: 'none', expiresInSeconds: 0 },
  executorId: 'calendar.events-read.v1',
} as const;

type StandardCapabilityDescriptor = Exclude<
  CapabilityDescriptor,
  ProviderWriteCapabilityDescriptor
>;
type ProviderWriteRegistration = Extract<
  RegisteredCapability,
  { readonly descriptor: ProviderWriteCapabilityDescriptor }
>;
type ProviderWriteResolution = Extract<
  ResolvedCapability,
  { readonly descriptor: ProviderWriteCapabilityDescriptor }
>;

const assertCompileTimeBoundary = (
  providerWrite: ProviderWriteCapabilityDescriptor,
  standard: StandardCapabilityDescriptor,
  arbitraryString: string,
): void => {
  const accepted: ProviderWriteCapabilityId = providerWrite.id;
  const serialized: string = accepted;

  // @ts-expect-error Arbitrary strings have not crossed the validated descriptor boundary.
  const arbitraryProviderWriteId: ProviderWriteCapabilityId = arbitraryString;
  // @ts-expect-error Non-provider descriptor IDs must remain ordinary strings.
  const standardProviderWriteId: ProviderWriteCapabilityId = standard.id;
  // @ts-expect-error Provider-write registrations require a branded descriptor branch.
  const invalidRegistrationDescriptor: ProviderWriteRegistration['descriptor'] =
    standard;
  // @ts-expect-error Provider-write resolutions require a branded descriptor branch.
  const invalidResolutionDescriptor: ProviderWriteResolution['descriptor'] =
    standard;

  void serialized;
  void arbitraryProviderWriteId;
  void standardProviderWriteId;
  void invalidRegistrationDescriptor;
  void invalidResolutionDescriptor;
};

void assertCompileTimeBoundary;

describe('provider-write capability identifier boundary', () => {
  it('brands only a fully validated provider-write descriptor', () => {
    const parsed = parseProviderWriteCapabilityDescriptor(
      providerWriteDescriptorWire,
    );

    expect(parsed.id).toBe(providerWriteDescriptorWire.id);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(
      providerWriteDescriptorWire,
    );
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('keeps non-provider descriptor IDs unbranded and refuses the provider constructor', () => {
    const parsed = CapabilityDescriptorSchema.parse(readDescriptorWire);

    expect(parsed.capabilityKind).toBe('read');
    expect(parsed.id).toBe(readDescriptorWire.id);
    expect(() =>
      parseProviderWriteCapabilityDescriptor(readDescriptorWire),
    ).toThrow(/provider-write/i);
  });
});
