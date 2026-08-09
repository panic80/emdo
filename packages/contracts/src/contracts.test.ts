import { describe, expect, it } from 'vitest';

import {
  ActionProposalSchema,
  AgentManifestSchema,
  AgentResultSchema,
  CapabilityDescriptorSchema,
  CommerceOfferSchema,
  DataDisclosureGrantSchema,
  JsonValueSchema,
  SyncOperationSchema,
} from './index.js';

const ids = {
  proposal: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
  grant: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002',
  user: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003',
  household: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004',
  run: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f005',
  client: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f006',
  operation: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f007',
  request: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f008',
} as const;

const grant = {
  schemaVersion: 1,
  id: ids.grant,
  version: 1,
  userId: ids.user,
  householdId: ids.household,
  agentId: 'scheduler',
  purpose: 'Find an appointment time for this run.',
  runId: ids.run,
  recordAllowlist: [
    {
      dataClass: 'calendar.events',
      recordId: 'event-123',
      fields: ['starts-at', 'ends-at', 'title'],
    },
  ],
  provider: 'openai',
  createdAt: '2026-08-09T16:00:00.000Z',
  expiresAt: '2026-08-09T16:10:00.000Z',
  oneRunOnly: true,
} as const;

const proposal = {
  schemaVersion: 1,
  id: ids.proposal,
  version: 1,
  runId: ids.run,
  capabilityId: 'google-calendar.event.create',
  canonicalArguments: {
    calendarId: 'primary',
    startsAt: '2026-08-11T14:00:00-04:00',
  },
  targets: [
    {
      kind: 'google-calendar.event',
      id: 'event-target-1',
      expectedVersion: 'etag-1',
    },
  ],
  beforePreview: null,
  afterPreview: {
    title: 'Dentist appointment',
    startsAt: '2026-08-11T14:00:00-04:00',
  },
  providerPreconditions: [
    {
      kind: 'calendar-version',
      targetId: 'primary',
      expectedValue: 'sync-token-1',
    },
  ],
  payloadHash: 'a'.repeat(64),
  disclosureGrant: grant,
  createdAt: '2026-08-09T16:00:00.000Z',
  expiresAt: '2026-08-09T16:10:00.000Z',
  idempotencyKey: 'proposal:018f1f5e:calendar-write',
  state: 'pending',
} as const;

const manifest = {
  schemaVersion: 1,
  id: 'scheduler',
  version: '1.0.0',
  kind: 'specialist',
  intents: ['schedule.appointment'],
  instructionIds: ['scheduler.instructions.v1'],
  skillIds: ['privacy.v1', 'toronto-time.v1'],
  capabilityAllowlist: ['calendar.events.read', 'google-calendar.event.create'],
  readableDataClasses: ['calendar.events', 'scheduler.tasks'],
  modelPolicy: {
    defaultModel: 'gpt-5.6-luna',
    complexModel: 'gpt-5.6-terra',
    escalationReasons: ['dependent-cross-domain', 'failed-output-validation'],
  },
  executionBudget: {
    maxTurns: 8,
    maxCapabilityCalls: 12,
    maxParallelCalls: 3,
    timeoutMs: 60_000,
    maxInputTokens: 20_000,
    maxOutputTokens: 4_000,
  },
  schemaRefs: {
    input: { id: 'scheduler.input', version: '1.0.0' },
    output: { id: 'scheduler.output', version: '1.0.0' },
  },
  riskCeiling: 'provider-write',
  evalSuite: { id: 'scheduler.evals', version: '1.0.0' },
} as const;

const descriptor = {
  schemaVersion: 1,
  id: 'google-calendar.event.create',
  version: '1.0.0',
  capabilityKind: 'provider-write',
  inputSchema: { id: 'calendar.event-create.input', version: '1.0.0' },
  outputSchema: { id: 'calendar.event-create.output', version: '1.0.0' },
  requiredScopes: ['google-calendar.events.write'],
  requiredDataClasses: ['calendar.events'],
  riskClass: 'provider-write',
  timeoutMs: 15_000,
  freshness: {
    required: true,
    maxAgeMs: 60_000,
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

describe('shared contract schemas', () => {
  it('strictly parses a complete agent manifest and freezes the result', () => {
    const parsed = AgentManifestSchema.parse(manifest);

    expect(parsed.id).toBe('scheduler');
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() =>
      AgentManifestSchema.parse({
        ...manifest,
        modelInstruction: 'grant access',
      }),
    ).toThrow();
  });

  it('strictly parses a capability descriptor and rejects nested unknown keys', () => {
    const parsed = CapabilityDescriptorSchema.parse(descriptor);

    expect(parsed.approval.rule).toBe('authenticated-visual-proposal');
    expect(() =>
      CapabilityDescriptorSchema.parse({
        ...descriptor,
        freshness: { ...descriptor.freshness, trustModelClaims: true },
      }),
    ).toThrow();
  });

  it('rejects understated capability risk while allowing opaque provider references', () => {
    expect(() =>
      CapabilityDescriptorSchema.parse({
        ...descriptor,
        capabilityKind: 'provider-write',
        riskClass: 'read',
      }),
    ).toThrow(/risk/i);

    expect(() =>
      ActionProposalSchema.parse({
        ...proposal,
        targets: [
          {
            ...proposal.targets[0],
            id: 'owner.name+calendar@example.com',
          },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects malformed identifiers, UUIDs, timestamps, hashes, and idempotency keys', () => {
    expect(() =>
      AgentManifestSchema.parse({ ...manifest, id: '../scheduler' }),
    ).toThrow();
    expect(() =>
      DataDisclosureGrantSchema.parse({ ...grant, id: 'not-a-uuid' }),
    ).toThrow();
    expect(() =>
      ActionProposalSchema.parse({
        ...proposal,
        createdAt: 'Sunday afternoon',
      }),
    ).toThrow();
    expect(() =>
      ActionProposalSchema.parse({ ...proposal, payloadHash: 'abc123' }),
    ).toThrow();
    expect(() =>
      ActionProposalSchema.parse({ ...proposal, idempotencyKey: 'short' }),
    ).toThrow();
  });

  it('accepts an exact ten-minute proposal window and rejects anything longer', () => {
    const parsed = ActionProposalSchema.parse(proposal);

    expect(parsed.state).toBe('pending');
    expect(Object.isFrozen(parsed.canonicalArguments)).toBe(true);
    expect(() =>
      ActionProposalSchema.parse({
        ...proposal,
        expiresAt: '2026-08-09T16:10:00.001Z',
      }),
    ).toThrow(/ten minutes/i);
  });

  it('binds a disclosure grant to one run and a field-level record allowlist', () => {
    expect(DataDisclosureGrantSchema.parse(grant).oneRunOnly).toBe(true);
    expect(() =>
      DataDisclosureGrantSchema.parse({ ...grant, oneRunOnly: false }),
    ).toThrow();
    expect(() =>
      DataDisclosureGrantSchema.parse({
        ...grant,
        recordAllowlist: [{ ...grant.recordAllowlist[0], fields: [] }],
      }),
    ).toThrow();
    expect(() =>
      DataDisclosureGrantSchema.parse({
        ...grant,
        recordAllowlist: [grant.recordAllowlist[0], grant.recordAllowlist[0]],
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      ActionProposalSchema.parse({ ...proposal, runId: ids.request }),
    ).toThrow(/run/i);
  });

  it('parses recursive finite JSON and rejects undefined and non-finite values', () => {
    expect(JsonValueSchema.parse({ nested: ['ok', 12, true, null] })).toEqual({
      nested: ['ok', 12, true, null],
    });
    expect(() => JsonValueSchema.parse({ missing: undefined })).toThrow();
    expect(() =>
      JsonValueSchema.parse({ value: Number.POSITIVE_INFINITY }),
    ).toThrow();
  });

  it('requires CAD integer minor units and valid offer freshness chronology', () => {
    const offer = {
      schemaVersion: 1,
      id: 'offer-123',
      version: 1,
      provider: 'approved-affiliate',
      merchant: { id: 'merchant-1', name: 'Example Canada' },
      product: { id: 'product-1', title: 'Dish soap' },
      variant: { id: 'variant-1', title: 'Unscented 700 mL' },
      price: { minorUnits: 799, currency: 'CAD' },
      shipping: { status: 'known', minorUnits: 0, currency: 'CAD' },
      availabilityScope: { kind: 'online' },
      sourceUrl: 'https://retailer.example/products/dish-soap',
      upstreamAt: '2026-08-09T15:55:00.000Z',
      fetchedAt: '2026-08-09T16:00:00.000Z',
      expiresAt: '2026-08-09T16:15:00.000Z',
      comparisonPermission: 'allowed',
    } as const;

    expect(CommerceOfferSchema.parse(offer).price.minorUnits).toBe(799);
    expect(() =>
      CommerceOfferSchema.parse({
        ...offer,
        price: { minorUnits: 7.99, currency: 'CAD' },
      }),
    ).toThrow();
    expect(() =>
      CommerceOfferSchema.parse({
        ...offer,
        price: { minorUnits: 799, currency: 'USD' },
      }),
    ).toThrow();
    expect(() =>
      CommerceOfferSchema.parse({
        ...offer,
        sourceUrl: 'http://retailer.example',
      }),
    ).toThrow();
    expect(() =>
      CommerceOfferSchema.parse({
        ...offer,
        upstreamAt: '2026-08-09T16:01:00.000Z',
      }),
    ).toThrow(/chronology/i);
    expect(() =>
      CommerceOfferSchema.parse({
        ...offer,
        expiresAt: '2026-08-09T15:59:00.000Z',
      }),
    ).toThrow(/chronology/i);
  });

  it('captures complete sync operation intent and rejects unknown client claims', () => {
    const operation = {
      schemaVersion: 1,
      clientId: ids.client,
      operationId: ids.operation,
      entity: { type: 'shopping.item', id: 'item-123' },
      mutation: { kind: 'delta', payload: { quantityDelta: 2 } },
      baseRevision: 7,
      dependencies: [],
      actorIntent: 'Add two bottles requested by the household member.',
      createdAt: '2026-08-09T16:00:00.000Z',
    } as const;

    expect(SyncOperationSchema.parse(operation).baseRevision).toBe(7);
    expect(() =>
      SyncOperationSchema.parse({ ...operation, role: 'owner' }),
    ).toThrow();
  });

  it('captures evidence, derived lineage, usage, model resolution, proposals, and safe errors', () => {
    const result = {
      schemaVersion: 1,
      runId: ids.run,
      status: 'completed',
      output: { message: 'A proposed time is ready.' },
      evidence: [
        {
          id: 'calendar-evidence-1',
          source: 'google-calendar',
          observedAt: '2026-08-09T16:00:00.000Z',
          upstreamAt: '2026-08-09T15:59:00.000Z',
          expiresAt: '2026-08-09T16:05:00.000Z',
        },
      ],
      derivedValues: [
        {
          id: 'available-slot-1',
          value: '2026-08-11T14:00:00-04:00',
          computation: 'scheduler.availability.v1',
          inputEvidenceIds: ['calendar-evidence-1'],
        },
      ],
      actionProposals: [proposal],
      usage: {
        inputTokens: 1200,
        outputTokens: 180,
        modelCostCadMinor: 4,
        capabilityCalls: 2,
        durationMs: 1400,
      },
      modelResolution: {
        requestedModel: 'gpt-5.6-luna',
        resolvedModel: 'gpt-5.6-luna',
        reason: 'default',
      },
      localTraceReference: 'trace-018f1f5e',
    } as const;

    expect(AgentResultSchema.parse(result).actionProposals).toHaveLength(1);
    expect(() =>
      AgentResultSchema.parse({
        ...result,
        evidence: [
          { ...result.evidence[0], upstreamAt: '2026-08-09T16:06:00.000Z' },
        ],
      }),
    ).toThrow(/chronology/i);
    expect(() =>
      AgentResultSchema.parse({
        ...result,
        status: 'failed',
        safeError: {
          code: 'provider-failed',
          message: 'The calendar provider is unavailable.',
          retryable: true,
          secret: 'must not be accepted',
        },
      }),
    ).toThrow();
  });
});
