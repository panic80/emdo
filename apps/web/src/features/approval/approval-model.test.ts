import { describe, expect, it, vi } from 'vitest';

import {
  ApprovalClientError,
  createImmutableProposalView,
  fetchProposalDetail,
  fetchProposalList,
  getApprovalAvailability,
  issueProposalVisualProof,
  submitAuthenticatedVisualDecision,
  submitProposalDecision,
} from './approval-model.js';

const PROPOSAL_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f67';
const DECISION_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f68';
const PAYLOAD_HASH = 'a'.repeat(64);
const APPROVAL_HASH = 'b'.repeat(64);

const proposal = {
  schemaVersion: 1 as const,
  id: PROPOSAL_ID,
  version: 3,
  state: 'pending' as const,
  kind: 'scheduler.calendar.create' as const,
  title: 'Dentist appointment',
  summary: 'Create one event on Personal',
  createdAt: '2026-08-09T16:00:00.000Z',
  expiresAt: '2026-08-09T16:10:00.000Z',
  payloadHash: PAYLOAD_HASH,
  approvalHash: APPROVAL_HASH,
  beforePreview: { summary: 'No event' },
  afterPreview: { summary: '1 new Google Calendar event' },
  fields: [
    { label: 'Calendar', value: 'Personal' },
    { label: 'Date', value: 'Tuesday, August 11' },
  ],
};

describe('visual proposal approval', () => {
  it('deeply snapshots the preview so later caller mutation cannot change what is shown', () => {
    const mutable = structuredClone(proposal);
    const view = createImmutableProposalView(mutable);
    mutable.afterPreview.summary = 'Delete every calendar';
    mutable.fields[0]!.value = 'Attacker';

    expect(view.afterPreview.summary).toBe('1 new Google Calendar event');
    expect(view.fields[0]!.value).toBe('Personal');
    expect(Object.isFrozen(view.afterPreview)).toBe(true);
  });

  it('allows approval only for a pending, unexpired proposal in an authenticated visual session', () => {
    const now = new Date('2026-08-09T16:01:18.000Z');

    expect(
      getApprovalAvailability(createImmutableProposalView(proposal), {
        now,
        authenticated: true,
        visualSession: true,
      }),
    ).toEqual({ allowed: true, remainingSeconds: 522 });

    expect(
      getApprovalAvailability(createImmutableProposalView(proposal), {
        now,
        authenticated: true,
        visualSession: false,
      }),
    ).toEqual({ allowed: false, reason: 'visual-confirmation-required' });
  });

  it.each(['typed', 'voice', 'push', 'email'] as const)(
    'rejects %s attempts to approve before any network call',
    async (source) => {
      const fetcher = vi.fn();

      await expect(
        submitProposalDecision(
          {
            proposalId: PROPOSAL_ID,
            decision: 'approve',
            source,
            payloadHash: PAYLOAD_HASH,
            approvalHash: APPROVAL_HASH,
            idempotencyKey: 'decision:rejected-0001',
            csrfToken: 'csrf',
            visualConfirmationToken: 'visual-token',
          },
          { fetcher },
        ),
      ).rejects.toEqual(
        new ApprovalClientError(
          'visual-confirmation-required',
          'Use the authenticated approval button to approve this action.',
        ),
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('loads only the bounded approval projection and rejects extra provider fields', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            items: [
              {
                id: PROPOSAL_ID,
                version: 3,
                state: 'pending',
                kind: 'scheduler.calendar.create',
                title: 'Dentist appointment',
                summary: 'Create one event on Personal',
                createdAt: '2026-08-09T16:00:00.000Z',
                expiresAt: '2026-08-09T16:10:00.000Z',
              },
            ],
            nextCursor: 'cursor-next',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...proposal,
            canonicalArguments: { start: 'provider-only-secret' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    await expect(
      fetchProposalList({ state: 'pending', limit: 25 }, { fetcher }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ id: PROPOSAL_ID, version: 3 })],
      nextCursor: 'cursor-next',
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      '/api/v1/proposals?state=pending&limit=25',
      expect.objectContaining({
        credentials: 'same-origin',
        cache: 'no-store',
      }),
    );

    await expect(
      fetchProposalDetail(PROPOSAL_ID, { fetcher }),
    ).rejects.toMatchObject({
      code: 'invalid-response',
    });
  });

  it('preserves exact display bytes and accepts empty projected values', async () => {
    const exactProjection = {
      ...proposal,
      title: ' Dentist appointment ',
      summary: ' Create one event on Personal ',
      beforePreview: { summary: ' موعد 😀 ' },
      afterPreview: { summary: ' אירוע חדש 🗓️ ' },
      fields: [{ label: ' Location ', value: '' }],
    };
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(exactProjection), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await expect(
      fetchProposalDetail(PROPOSAL_ID, { fetcher }),
    ).resolves.toMatchObject({
      title: ' Dentist appointment ',
      summary: ' Create one event on Personal ',
      beforePreview: { summary: ' موعد 😀 ' },
      afterPreview: { summary: ' אירוע חדש 🗓️ ' },
      fields: [{ label: ' Location ', value: '' }],
    });
  });

  it.each([
    ['a bidi override', { title: `Dentist\u202Eappointment` }],
    ['a C1 control', { beforePreview: { summary: `before\u0085after` } }],
    [
      'a bidi isolate',
      { fields: [{ label: 'Location', value: `safe\u2066spoof` }] },
    ],
  ])(
    'rejects projected display strings containing %s',
    async (_case, patch) => {
      const fetcher = vi.fn(
        async () =>
          new Response(JSON.stringify({ ...proposal, ...patch }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );

      await expect(
        fetchProposalDetail(PROPOSAL_ID, { fetcher }),
      ).rejects.toMatchObject({ code: 'invalid-response' });
    },
  );

  it.each([
    ['title', { title: '   ' }],
    ['summary', { summary: '\t' }],
    ['field label', { fields: [{ label: '  ', value: '' }] }],
  ])(
    'rejects a trim-empty projected %s without transforming bytes',
    async (_case, patch) => {
      const fetcher = vi.fn(
        async () =>
          new Response(JSON.stringify({ ...proposal, ...patch }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );

      await expect(
        fetchProposalDetail(PROPOSAL_ID, { fetcher }),
      ).rejects.toMatchObject({ code: 'invalid-response' });
    },
  );

  it('maps a rejected list cursor to the restartable client error', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 'proposal-cursor-invalid',
            detail: 'Untrusted server detail must not be rendered.',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );

    await expect(
      fetchProposalList(
        { state: 'pending', cursor: 'expired-cursor', limit: 25 },
        { fetcher },
      ),
    ).rejects.toEqual(
      new ApprovalClientError(
        'proposal-cursor-invalid',
        'This approvals page expired. Restarting from the first page.',
        400,
      ),
    );
  });

  it('binds a short-lived visual proof to the exact immutable proposal view', async () => {
    const now = new Date('2026-08-09T16:01:18.000Z');
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            proposalId: PROPOSAL_ID,
            proposalVersion: 3,
            payloadHash: PAYLOAD_HASH,
            approvalHash: APPROVAL_HASH,
            proofToken: 'visual_proof_opaque_0123456789abcdefghijklmno',
            issuedAt: '2026-08-09T16:01:18.000Z',
            expiresAt: '2026-08-09T16:02:18.000Z',
            replayed: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await expect(
      issueProposalVisualProof(
        {
          proposal: createImmutableProposalView(proposal),
          csrfToken: 'csrf-1',
          idempotencyKey: 'visual-proof:request-0001',
        },
        { fetcher, now: () => now },
      ),
    ).resolves.toMatchObject({ proposalId: PROPOSAL_ID, proposalVersion: 3 });

    const [url, init] = fetcher.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`/api/v1/proposals/${PROPOSAL_ID}/visual-proof`);
    expect(init.headers).toEqual(
      expect.objectContaining({
        'idempotency-key': 'visual-proof:request-0001',
        'x-csrf-token': 'csrf-1',
      }),
    );
    expect(JSON.parse(String(init.body))).toEqual({
      schemaVersion: 1,
      proposalVersion: 3,
      payloadHash: PAYLOAD_HASH,
      approvalHash: APPROVAL_HASH,
    });
  });

  it('fails closed when a visual proof is stale or bound to different hashes', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            proposalId: PROPOSAL_ID,
            proposalVersion: 3,
            payloadHash: 'c'.repeat(64),
            approvalHash: APPROVAL_HASH,
            proofToken: 'visual_proof_opaque_0123456789abcdefghijklmno',
            issuedAt: '2026-08-09T16:00:00.000Z',
            expiresAt: '2026-08-09T16:01:00.000Z',
            replayed: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await expect(
      issueProposalVisualProof(
        {
          proposal: createImmutableProposalView(proposal),
          csrfToken: 'csrf-1',
          idempotencyKey: 'visual-proof:request-0001',
        },
        { fetcher, now: () => new Date('2026-08-09T16:01:18.000Z') },
      ),
    ).rejects.toEqual(
      new ApprovalClientError(
        'invalid-response',
        'EMDO returned a visual proof that does not match the reviewed proposal.',
      ),
    );
  });

  it('issues proof on demand and immediately consumes it for the exact visual decision', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            proposalId: PROPOSAL_ID,
            proposalVersion: 3,
            payloadHash: PAYLOAD_HASH,
            approvalHash: APPROVAL_HASH,
            proofToken: 'visual_proof_opaque_0123456789abcdefghijklmno',
            issuedAt: '2026-08-09T16:01:18.000Z',
            expiresAt: '2026-08-09T16:02:18.000Z',
            replayed: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            id: DECISION_ID,
            proposalId: PROPOSAL_ID,
            payloadHash: PAYLOAD_HASH,
            approvalHash: APPROVAL_HASH,
            decision: 'approved',
            channel: 'authenticated-visual',
            decidedAt: '2026-08-09T16:01:19.000Z',
            idempotencyKey: 'decision:decision-id-0001',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const ids = ['proof-id-0001', 'decision-id-0001'];

    await expect(
      submitAuthenticatedVisualDecision(
        {
          proposal: createImmutableProposalView(proposal),
          decision: 'approve',
          csrfToken: 'csrf-current',
        },
        {
          fetcher,
          now: () => new Date('2026-08-09T16:01:18.000Z'),
          createId: () => ids.shift()!,
        },
      ),
    ).resolves.toMatchObject({ decision: 'approved', proposalId: PROPOSAL_ID });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![0]).toBe(
      `/api/v1/proposals/${PROPOSAL_ID}/visual-proof`,
    );
    const decisionInit = fetcher.mock.calls[1]![1] as RequestInit;
    expect(fetcher.mock.calls[1]![0]).toBe(
      `/api/v1/proposals/${PROPOSAL_ID}/decision`,
    );
    expect(decisionInit.headers).toEqual(
      expect.objectContaining({
        'idempotency-key': 'decision:decision-id-0001',
        'x-emdo-visual-confirmation':
          'visual_proof_opaque_0123456789abcdefghijklmno',
      }),
    );
  });

  it('builds the visual channel and idempotency key internally for the exact decision endpoint', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            id: DECISION_ID,
            proposalId: PROPOSAL_ID,
            payloadHash: PAYLOAD_HASH,
            approvalHash: APPROVAL_HASH,
            decision: 'approved',
            channel: 'authenticated-visual',
            decidedAt: '2026-08-09T16:01:19.000Z',
            idempotencyKey: 'decision:request-0001',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await expect(
      submitProposalDecision(
        {
          proposalId: PROPOSAL_ID,
          decision: 'approve',
          source: 'visual-control',
          payloadHash: PAYLOAD_HASH,
          approvalHash: APPROVAL_HASH,
          idempotencyKey: 'decision:request-0001',
          csrfToken: 'csrf-1',
          visualConfirmationToken: 'visual-token-1',
        },
        { fetcher },
      ),
    ).resolves.toMatchObject({
      proposalId: PROPOSAL_ID,
      decision: 'approved',
      channel: 'authenticated-visual',
    });

    const [url, init] = fetcher.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`/api/v1/proposals/${PROPOSAL_ID}/decision`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(init.headers).toEqual(
      expect.objectContaining({
        'idempotency-key': 'decision:request-0001',
        'x-csrf-token': 'csrf-1',
        'x-emdo-visual-confirmation': 'visual-token-1',
      }),
    );
    expect(JSON.parse(String(init.body))).toEqual({
      schemaVersion: 1,
      proposalId: PROPOSAL_ID,
      payloadHash: PAYLOAD_HASH,
      approvalHash: APPROVAL_HASH,
      decision: 'approved',
      idempotencyKey: 'decision:request-0001',
    });
  });

  it('rejects a tampered decision receipt even when the HTTP request succeeds', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            id: DECISION_ID,
            proposalId: PROPOSAL_ID,
            payloadHash: 'c'.repeat(64),
            approvalHash: APPROVAL_HASH,
            decision: 'approved',
            channel: 'authenticated-visual',
            decidedAt: '2026-08-09T16:01:19.000Z',
            idempotencyKey: 'decision:request-0001',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await expect(
      submitProposalDecision(
        {
          proposalId: PROPOSAL_ID,
          decision: 'approve',
          source: 'visual-control',
          payloadHash: PAYLOAD_HASH,
          approvalHash: APPROVAL_HASH,
          idempotencyKey: 'decision:request-0001',
          csrfToken: 'csrf-1',
          visualConfirmationToken: 'visual-token-1',
        },
        { fetcher },
      ),
    ).rejects.toMatchObject({ code: 'invalid-response' });
  });
});
