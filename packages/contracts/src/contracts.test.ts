import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ActionDecisionSchema,
  ActionProposalSchema,
  ActionProposalApprovalDisplaySchema,
  AgentManifestSchema,
  AgentResultSchema,
  CapabilityDescriptorSchema,
  CommerceOfferSchema,
  DataDisclosureGrantSchema,
  EffectiveAuthorizationScopeFingerprintSchema,
  GuardedActionPermitSchema,
  JsonValueSchema,
  ProviderWriteAuthorizationSchema,
  SyncOperationSchema,
  createAgentResultSchemaForManifest,
  createRuntimeSchemaRegistry,
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
  parentInvocation: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f009',
  agentInvocation: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f010',
  phaseInvocation: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f011',
} as const;

const invocationContext = {
  orchestrationRunId: ids.run,
  parentInvocationId: ids.parentInvocation,
  agentInvocationId: ids.agentInvocation,
  phaseInvocationId: ids.phaseInvocation,
  actorId: ids.user,
  locale: 'en-CA',
  grantedCapabilities: ['calendar.events.read', 'google-calendar.event.create'],
  disclosedContextRefs: [`context-ref-${'1'.repeat(64)}`],
  deadline: '2026-08-09T16:10:00.000Z',
  idempotencyScope: '2'.repeat(64),
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
  invocationContext,
  invocationContextHash: '3'.repeat(64),
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

const approvalDisplay = {
  schemaVersion: 1,
  title: 'Create Google Calendar event',
  summary: 'Review the event details before creating it in Google Calendar.',
  beforeSummary: 'No event exists at the proposed target.',
  afterSummary: 'One event will be created.',
  fields: [
    { label: 'Title', value: 'Dentist appointment' },
    { label: 'Starts', value: '2026-08-11 14:00' },
  ],
} as const;

const proposal = {
  schemaVersion: 1,
  id: ids.proposal,
  version: 1,
  runId: ids.run,
  capabilityId: 'google-calendar.event.create',
  capabilityFingerprint: 'c'.repeat(64),
  authorizationScopeFingerprint: 'e'.repeat(64),
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
  approvalDisplay,
  providerPreconditions: [
    {
      kind: 'calendar-version',
      targetId: 'primary',
      expectedValue: 'sync-token-1',
    },
  ],
  providerAuthorityBindingHash: '9'.repeat(64),
  providerSdkCallId: 'call-google-calendar-create-1',
  payloadHash: 'a'.repeat(64),
  approvalHash: 'b'.repeat(64),
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
    expect(parsed.authorizationScopeFingerprint).toBe('e'.repeat(64));
    expect(Object.isFrozen(parsed.canonicalArguments)).toBe(true);
    expect(parsed.approvalDisplay).toEqual(approvalDisplay);
    expect(Object.isFrozen(parsed.approvalDisplay)).toBe(true);
    expect(Object.isFrozen(parsed.approvalDisplay.fields)).toBe(true);
    expect(Object.isFrozen(parsed.approvalDisplay.fields[0])).toBe(true);
    expect(() =>
      ActionProposalSchema.parse({
        ...proposal,
        expiresAt: '2026-08-09T16:10:00.001Z',
      }),
    ).toThrow(/ten minutes/i);
  });

  it('binds guarded local actions to an optional server-materialized target', () => {
    const guarded = {
      ...proposal,
      capabilityId: 'finance.records.write',
      providerAuthorityBindingHash: '9'.repeat(64),
      payloadHash: 'a'.repeat(64),
      guardedAction: {
        capabilityVersion: '1.0.0',
        operation: 'finance-document-review-commit',
        actionHash: 'a'.repeat(64),
        executionBindingHash: '9'.repeat(64),
        targetBindingHash: '8'.repeat(64),
      },
    } as const;

    expect(ActionProposalSchema.parse(guarded).guardedAction).toEqual(
      guarded.guardedAction,
    );
    expect(() =>
      ActionProposalSchema.parse({
        ...guarded,
        guardedAction: {
          ...guarded.guardedAction,
          targetBindingHash: 'not-a-hash',
        },
      }),
    ).toThrow();
    expect(() =>
      ActionProposalSchema.parse({
        ...guarded,
        guardedAction: {
          ...guarded.guardedAction,
          targetBindingHash: undefined,
        },
      }),
    ).toThrow(/target binding/i);
    expect(() =>
      ActionProposalSchema.parse({
        ...guarded,
        guardedAction: {
          ...guarded.guardedAction,
          operation: 'finance-adjustment',
        },
      }),
    ).toThrow(/target binding/i);

    const permit = {
      proposalId: ids.proposal,
      decisionId: ids.operation,
      capabilityId: 'finance.records.write',
      capabilityVersion: '1.0.0',
      capabilityFingerprint: '7'.repeat(64),
      operation: guarded.guardedAction.operation,
      actionHash: guarded.guardedAction.actionHash,
      executionBindingHash: guarded.guardedAction.executionBindingHash,
      targetBindingHash: guarded.guardedAction.targetBindingHash,
    } as const;
    expect(GuardedActionPermitSchema.parse(permit)).toEqual(permit);
    expect(() =>
      GuardedActionPermitSchema.parse({
        ...permit,
        targetBindingHash: undefined,
      }),
    ).toThrow(/target binding/i);
    expect(() =>
      ActionProposalSchema.parse({
        ...guarded,
        capabilityId: 'finance.statement.import',
      }),
    ).toThrow(/approved capability/i);
    expect(() =>
      GuardedActionPermitSchema.parse({
        ...permit,
        capabilityId: 'finance.statement.import',
      }),
    ).toThrow(/approved capability/i);
  });

  it('requires an exact, deeply frozen, bounded approval display without kind or capability ID', () => {
    const schema = ActionProposalApprovalDisplaySchema;

    const boundaryDisplay = {
      schemaVersion: 1,
      title: 't'.repeat(200),
      summary: 's'.repeat(1_000),
      beforeSummary: 'b'.repeat(2_000),
      afterSummary: 'a'.repeat(2_000),
      fields: Array.from({ length: 32 }, () => ({
        label: 'l'.repeat(120),
        value: 'v'.repeat(2_000),
      })),
    } as const;
    const parsed = schema.parse(boundaryDisplay);

    expect(parsed).toEqual(boundaryDisplay);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.fields)).toBe(true);
    expect(Object.isFrozen(parsed.fields[0])).toBe(true);
    expect(schema.safeParse({ ...approvalDisplay, title: '' }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ ...approvalDisplay, title: 't'.repeat(201) }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...approvalDisplay, summary: '' }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ ...approvalDisplay, summary: 's'.repeat(1_001) })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...approvalDisplay,
        beforeSummary: 'b'.repeat(2_001),
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...approvalDisplay,
        afterSummary: 'a'.repeat(2_001),
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...approvalDisplay,
        fields: Array.from({ length: 33 }, () => ({ label: 'L', value: '' })),
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...approvalDisplay,
        fields: [{ label: '', value: '' }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...approvalDisplay,
        fields: [{ label: 'l'.repeat(121), value: '' }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...approvalDisplay,
        fields: [{ label: 'L', value: 'v'.repeat(2_001) }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...approvalDisplay,
        kind: 'scheduler.calendar.create',
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...approvalDisplay,
        capabilityId: 'google-calendar.event.create',
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...approvalDisplay,
        fields: [{ label: 'Title', value: 'Dentist', raw: true }],
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...approvalDisplay, title: '   ' }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ ...approvalDisplay, summary: '\t' }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...approvalDisplay,
        fields: [{ label: '  ', value: '' }],
      }).success,
    ).toBe(false);

    for (const hostile of [
      '\u0000',
      '\u001f',
      '\u007f',
      '\u0080',
      '\u009f',
      '\u00ad',
      '\u061c',
      '\u200b',
      '\u200c',
      '\u200d',
      '\u200e',
      '\u200f',
      '\u202a',
      '\u202e',
      '\u2060',
      '\u2066',
      '\u2069',
      '\ufeff',
    ]) {
      expect(
        schema.safeParse({
          ...approvalDisplay,
          title: `Review${hostile}event`,
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ...approvalDisplay,
          beforeSummary: `Before${hostile}`,
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ...approvalDisplay,
          fields: [{ label: 'Title', value: `Dentist${hostile}` }],
        }).success,
      ).toBe(false);
    }

    for (const blankLooking of [
      '\u00ad',
      '\u200b',
      '\u200c\u200d',
      '\u2060',
      '\ufeff',
      ' \u200b ',
    ]) {
      expect(
        schema.safeParse({ ...approvalDisplay, title: blankLooking }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...approvalDisplay, summary: blankLooking }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ...approvalDisplay,
          fields: [{ label: blankLooking, value: '' }],
        }).success,
      ).toBe(false);
    }

    const multilingual = {
      ...approvalDisplay,
      title: '  إنشاء موعد 📅  ',
      summary: 'סקירת פרטי האירוע ✅',
      beforeSummary: '',
      afterSummary: '',
      fields: [{ label: 'כותרת 🦷', value: '' }],
    } as const;
    const multilingualParsed = schema.parse(multilingual);
    expect(multilingualParsed).toEqual(multilingual);
    expect(multilingualParsed.title).toBe(multilingual.title);
    const { approvalDisplay: _omitted, ...withoutApprovalDisplay } = proposal;
    expect(_omitted).toBeDefined();
    expect(() => ActionProposalSchema.parse(withoutApprovalDisplay)).toThrow();
  });

  it('binds a provider proposal to one immutable SDK call', () => {
    expect(
      ActionProposalSchema.parse({
        ...proposal,
        providerSdkCallId: 'call-google-calendar-create-1',
      }).providerSdkCallId,
    ).toBe('call-google-calendar-create-1');
  });

  it('requires a lowercase effective authorization-scope fingerprint', () => {
    const { authorizationScopeFingerprint: _omitted, ...withoutFingerprint } =
      proposal;
    expect(_omitted).toBeDefined();

    expect(() => ActionProposalSchema.parse(withoutFingerprint)).toThrow();
    expect(() =>
      ActionProposalSchema.parse({
        ...proposal,
        authorizationScopeFingerprint: 'E'.repeat(64),
      }),
    ).toThrow(/lowercase|SHA-256/i);
  });

  it('requires the server disclosure grant to predate proposal creation', () => {
    expect(() =>
      ActionProposalSchema.parse({
        ...proposal,
        disclosureGrant: {
          ...proposal.disclosureGrant,
          createdAt: '2026-08-09T16:00:00.001Z',
        },
      }),
    ).toThrow(/grant.*before.*proposal/i);
  });

  it('keeps provider idempotency alive through approval and execution recovery', () => {
    expect(() =>
      CapabilityDescriptorSchema.parse({
        ...descriptor,
        idempotency: { ...descriptor.idempotency, ttlMs: 0 },
      }),
    ).toThrow(/idempotency.*ttl/i);
    expect(() =>
      CapabilityDescriptorSchema.parse({
        ...descriptor,
        idempotency: {
          ...descriptor.idempotency,
          ttlMs: descriptor.approval.expiresInSeconds * 1000,
        },
      }),
    ).toThrow(/approval.*execution/i);
  });

  it('requires a closed trusted authority binding on provider-write permits', () => {
    const authorization = {
      proposalId: ids.proposal,
      approvalHash: 'a'.repeat(64),
      approvalBindingHash: 'b'.repeat(64),
      capabilityFingerprint: 'c'.repeat(64),
      proposalCreatedAt: '2026-08-09T16:00:00.000Z',
      expiresAt: '2026-08-09T16:10:00.000Z',
      disclosureGrantId: ids.grant,
      disclosureGrantHash: 'd'.repeat(64),
      approvalBinding: {
        decisionId: ids.request,
        userId: ids.user,
        agentId: 'scheduler',
        runId: ids.run,
        capabilityId: 'google-calendar.event.create',
        capabilityFingerprint: 'c'.repeat(64),
        disclosureGrantId: ids.grant,
        payloadHash: 'f'.repeat(64),
        idempotencyTtlMs: 86_400_000,
        authorityBinding: {
          kind: 'google-calendar-grant-v2',
          householdId: ids.household,
          privateSpaceId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f009',
          authorizationScopeFingerprint: '9'.repeat(64),
          providerGrantReference: 'google-grant-reference-1',
          authorizationEpoch: 1,
        },
      },
      providerIdempotencyKey: 'e'.repeat(64),
      idempotencyExpiresAt: '2026-08-10T16:02:00.000Z',
      attemptId: ids.operation,
      attemptVersion: 1,
      issuedAt: '2026-08-09T16:02:00.000Z',
      targets: [
        {
          kind: 'google-calendar.event',
          id: 'primary',
          expectedVersion: 'etag-v1',
        },
      ],
      providerPreconditions: [],
    } as const;

    expect(
      ProviderWriteAuthorizationSchema.parse(authorization).approvalBinding
        .authorityBinding,
    ).toEqual(authorization.approvalBinding.authorityBinding);
    expect(
      EffectiveAuthorizationScopeFingerprintSchema.parse('9'.repeat(64)),
    ).toBe('9'.repeat(64));
    expect(() =>
      ProviderWriteAuthorizationSchema.parse({
        ...authorization,
        approvalBinding: {
          ...authorization.approvalBinding,
          authorityBinding: {
            ...authorization.approvalBinding.authorityBinding,
            kind: 'client-supplied-provider-context',
          },
        },
      }),
    ).toThrow();
    expect(() =>
      ProviderWriteAuthorizationSchema.parse({
        ...authorization,
        approvalBinding: {
          ...authorization.approvalBinding,
          authorityBinding: {
            ...authorization.approvalBinding.authorityBinding,
            spaceAccessGrantId: 'rotating-grant-must-not-enter-v2',
          },
        },
      }),
    ).toThrow();
    expect(() =>
      ProviderWriteAuthorizationSchema.parse({
        ...authorization,
        approvalBinding: {
          ...authorization.approvalBinding,
          authorityBinding: {
            ...authorization.approvalBinding.authorityBinding,
            accessToken: 'must-never-enter-the-permit',
          },
        },
      }),
    ).toThrow();
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
        status: 'resolved',
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

    const unavailable = {
      ...result,
      status: 'failed',
      output: undefined,
      actionProposals: [],
      modelResolution: {
        status: 'unavailable',
        requestedModel: 'gpt-5.6-luna',
        attemptedModels: ['gpt-5.6-luna', 'gpt-5.6-terra'],
        reason: 'no-configured-model-available',
        safeError: {
          code: 'agent-model-unavailable',
          message: 'AI is temporarily unavailable. Local features still work.',
          retryable: true,
        },
      },
      safeError: {
        code: 'agent-model-unavailable',
        message: 'AI is temporarily unavailable. Local features still work.',
        retryable: true,
      },
    } as const;
    expect(AgentResultSchema.parse(unavailable).modelResolution.status).toBe(
      'unavailable',
    );
    expect(() =>
      AgentResultSchema.parse({
        ...unavailable,
        status: 'completed',
      }),
    ).toThrow(/unavailable.*failed/i);
    expect(() =>
      AgentResultSchema.parse({
        ...unavailable,
        modelResolution: {
          ...unavailable.modelResolution,
          resolvedModel: 'gpt-5.6-luna',
        },
      }),
    ).toThrow();

    const requiredModelUnavailable = {
      ...unavailable,
      modelResolution: {
        status: 'unavailable',
        requestedModel: 'gpt-5.6-terra',
        attemptedModels: ['gpt-5.6-terra'],
        reason: 'required-complex-model-unavailable',
        escalationTrigger: 'failed-output-validation',
        safeError: {
          code: 'required-agent-model-unavailable',
          message:
            'The model required to complete this request safely is temporarily unavailable.',
          retryable: true,
        },
      },
      safeError: {
        code: 'required-agent-model-unavailable',
        message:
          'The model required to complete this request safely is temporarily unavailable.',
        retryable: true,
      },
    } as const;
    expect(
      AgentResultSchema.parse(requiredModelUnavailable).modelResolution.reason,
    ).toBe('required-complex-model-unavailable');

    expect(
      AgentResultSchema.parse({
        ...result,
        modelResolution: {
          status: 'resolved',
          requestedModel: 'gpt-5.6-terra',
          resolvedModel: 'gpt-5.6-luna',
          reason: 'terra-unavailable',
          escalationTrigger: 'complex-reasoning',
        },
      }).modelResolution,
    ).toMatchObject({
      reason: 'terra-unavailable',
      escalationTrigger: 'complex-reasoning',
    });

    const policyDenied = {
      ...unavailable,
      modelResolution: {
        status: 'unavailable',
        requestedModel: 'gpt-5.6-terra',
        attemptedModels: [],
        reason: 'configured-model-escalation-not-allowed',
        escalationTrigger: 'failed-output-validation',
        safeError: {
          code: 'agent-model-escalation-not-allowed',
          message:
            'The active agent policy does not allow the required model escalation.',
          retryable: false,
        },
      },
      safeError: {
        code: 'agent-model-escalation-not-allowed',
        message:
          'The active agent policy does not allow the required model escalation.',
        retryable: false,
      },
    } as const;
    expect(AgentResultSchema.parse(policyDenied).modelResolution).toMatchObject(
      {
        reason: 'configured-model-escalation-not-allowed',
        attemptedModels: [],
      },
    );

    const fallbackDenied = {
      ...unavailable,
      modelResolution: {
        status: 'unavailable',
        requestedModel: 'gpt-5.6-luna',
        attemptedModels: ['gpt-5.6-luna'],
        reason: 'configured-model-fallback-not-allowed',
        safeError: {
          code: 'agent-model-fallback-not-allowed',
          message: 'The active agent policy does not allow a model fallback.',
          retryable: false,
        },
      },
      safeError: {
        code: 'agent-model-fallback-not-allowed',
        message: 'The active agent policy does not allow a model fallback.',
        retryable: false,
      },
    } as const;
    expect(AgentResultSchema.parse(fallbackDenied).modelResolution.reason).toBe(
      'configured-model-fallback-not-allowed',
    );

    expect(() =>
      AgentResultSchema.parse({
        ...result,
        runId: ids.request,
      }),
    ).toThrow(/proposal.*run/i);
    expect(() =>
      AgentResultSchema.parse({
        ...result,
        actionProposals: [{ ...proposal, state: 'approved' }],
      }),
    ).toThrow(/must be pending/i);

    const typedRuntimeSchemas = createRuntimeSchemaRegistry([
      {
        reference: manifest.schemaRefs.output,
        schema: z.strictObject({ message: z.string().min(1) }),
      },
    ]);
    const typedResultSchema = createAgentResultSchemaForManifest(
      AgentManifestSchema.parse(manifest),
      typedRuntimeSchemas,
    );

    expect(typedResultSchema.parse(result).output).toEqual({
      message: 'A proposed time is ready.',
    });
    expect(() =>
      typedResultSchema.parse({
        ...result,
        output: { message: 'Ready', capabilityOverride: 'calendar.delete' },
      }),
    ).toThrow();
    expect(() =>
      createAgentResultSchemaForManifest(
        AgentManifestSchema.parse(manifest),
        createRuntimeSchemaRegistry([
          {
            reference: { id: 'other.output', version: '1.0.0' },
            schema: z.unknown(),
          },
        ]),
      ),
    ).toThrow(/not registered/i);

    expect(
      ActionDecisionSchema.parse({
        schemaVersion: 1,
        id: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f009',
        proposalId: ids.proposal,
        userId: ids.user,
        authenticatedSessionId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f010',
        payloadHash: 'a'.repeat(64),
        approvalHash: 'b'.repeat(64),
        decision: 'approved',
        channel: 'authenticated-visual',
        decidedAt: '2026-08-09T16:01:00.000Z',
        idempotencyKey: 'decision:018f1f5e:calendar-write',
      }).channel,
    ).toBe('authenticated-visual');
  });
});
