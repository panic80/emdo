import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import { PostgresApprovalResumeBoundary } from './approval-resume-boundary.js';

const ids = Object.freeze({
  user: '018f1f5e-3000-7000-8000-000000000001',
  session: '018f1f5e-3000-7000-8000-000000000002',
  household: '018f1f5e-3000-7000-8000-000000000003',
  decisionRequest: '018f1f5e-3000-7000-8000-000000000004',
  decisionGrant: '018f1f5e-3000-7000-8000-000000000005',
  decision: '018f1f5e-3000-7000-8000-000000000006',
  proposal: '018f1f5e-3000-7000-8000-000000000007',
  run: '018f1f5e-3000-7000-8000-000000000008',
  conversation: '018f1f5e-3000-7000-8000-000000000009',
  checkpoint: '018f1f5e-3000-7000-8000-00000000000a',
  resumeRequest: '018f1f5e-3000-7000-8000-00000000000b',
  resumeGrant: '018f1f5e-3000-7000-8000-00000000000c',
  disclosureGrant: '018f1f5e-3000-7000-8000-00000000000d',
});

const fingerprints = Object.freeze({
  decisionCollection: EffectiveAuthorizationScopeFingerprintSchema.parse(
    'f'.repeat(64),
  ),
  resumeCollection: EffectiveAuthorizationScopeFingerprintSchema.parse(
    'd'.repeat(64),
  ),
  operation: EffectiveAuthorizationScopeFingerprintSchema.parse('e'.repeat(64)),
});

const principal = Object.freeze({
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  role: 'owner' as const,
  emailVerified: true as const,
  spaceAccessGrantId: ids.decisionGrant,
  collectionAuthorizationScopeFingerprint: fingerprints.decisionCollection,
});

const decision = Object.freeze({
  schemaVersion: 1 as const,
  id: ids.decision,
  proposalId: ids.proposal,
  userId: ids.user,
  authenticatedSessionId: ids.session,
  payloadHash: 'a'.repeat(64),
  approvalHash: 'b'.repeat(64),
  decision: 'approved' as const,
  channel: 'authenticated-visual' as const,
  decidedAt: '2026-08-10T14:00:00.000Z',
  idempotencyKey: 'decision-key-0001',
});

const binding = Object.freeze({
  turnRequestId: ids.resumeRequest,
  runId: ids.run,
  conversationId: ids.conversation,
  checkpointId: ids.checkpoint,
  interruptionId: 'delegation-1:approval:call-1',
  proposalId: ids.proposal,
  approvalDecisionId: ids.decision,
  decision: 'approve' as const,
  householdId: ids.household,
  userId: ids.user,
  authenticatedSessionId: ids.session,
  spaceAccessGrantId: ids.resumeGrant,
  disclosureGrantId: ids.disclosureGrant,
  disclosureGrantVersion: '1.0.0',
  collectionAuthorizationScopeFingerprint: fingerprints.resumeCollection,
  authorizationScopeFingerprint: fingerprints.operation,
  payloadHash: 'a'.repeat(64),
  approvalHash: 'b'.repeat(64),
});

const poolFor = (
  respond: (
    sql: string,
    values: readonly unknown[],
  ) => readonly Record<string, unknown>[],
) => {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => ({
    rowCount: 1,
    rows: respond(sql, values),
  }));
  const client: DatabaseClient = { query, release: vi.fn() };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query };
};

describe('PostgresApprovalResumeBoundary', () => {
  it('claims only through the database aggregate that mints fresh phase authority', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('claim_approval_resume_job')
        ? [
            {
              claim_result: {
                status: 'claimed',
                claimId: 'approval-resume-claim-0001',
                ownershipToken: 'approval-resume-owner-0001',
                binding,
              },
            },
          ]
        : [],
    );
    const boundary = new PostgresApprovalResumeBoundary({
      pool,
      decideAndLink: vi.fn(),
    });

    await expect(
      boundary.claim({
        decision,
        principal,
        decisionRequestId: ids.decisionRequest,
      }),
    ).resolves.toEqual({
      status: 'claimed',
      claimId: 'approval-resume-claim-0001',
      ownershipToken: 'approval-resume-owner-0001',
      binding,
    });
    const aggregate = query.mock.calls.find(([sql]) =>
      sql.includes('claim_approval_resume_job'),
    );
    expect(aggregate?.[1]).toEqual([
      ids.decision,
      ids.decisionRequest,
      ids.decisionGrant,
    ]);
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('insert into emdo.approval_resume_jobs'),
      ),
    ).toBe(false);
  });

  it('settles an exact result through one ownership-token terminal CAS', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('settle_approval_resume_job')
        ? [
            {
              settle_result: {
                status: 'completed',
                terminalEventSequence: 17,
              },
            },
          ]
        : [],
    );
    const boundary = new PostgresApprovalResumeBoundary({
      pool,
      decideAndLink: vi.fn(),
    });
    const result = Object.freeze({
      status: 'failed',
      runId: ids.run,
      localTraceReference: 'local-trace-ref',
      safeError: {
        code: 'approval-rejection-failed',
        message: 'The proposal rejection could not be recorded safely.',
        retryable: false,
      },
      specialistOutcomes: [],
      usage: { inputTokens: 0, outputTokens: 0, modelCostCadMinor: 0 },
    });

    await expect(
      boundary.complete({
        claimId: 'approval-resume-claim-0001',
        ownershipToken: 'approval-resume-owner-0001',
        binding,
        result,
      }),
    ).resolves.toEqual({ status: 'completed', terminalEventSequence: 17 });
    const aggregate = query.mock.calls.find(([sql]) =>
      sql.includes('settle_approval_resume_job'),
    );
    expect(aggregate?.[1]).toEqual([
      'approval-resume-claim-0001',
      'approval-resume-owner-0001',
      'complete',
      null,
      result,
    ]);
  });

  it('rejects an incomplete terminal result before the settlement function', async () => {
    const { pool, query } = poolFor(() => []);
    const boundary = new PostgresApprovalResumeBoundary({
      pool,
      decideAndLink: vi.fn(),
    });

    expect(() =>
      boundary.complete({
        claimId: 'approval-resume-claim-0001',
        ownershipToken: 'approval-resume-owner-0001',
        binding,
        result: { status: 'failed', runId: ids.run },
      }),
    ).toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a nested approval result before the settlement function', async () => {
    const { pool, query } = poolFor(() => []);
    const boundary = new PostgresApprovalResumeBoundary({
      pool,
      decideAndLink: vi.fn(),
    });

    expect(() =>
      boundary.complete({
        claimId: 'approval-resume-claim-0001',
        ownershipToken: 'approval-resume-owner-0001',
        binding,
        result: {
          status: 'needs-approval',
          runId: ids.run,
          localTraceReference: 'nested-approval-trace',
          specialistOutcomes: [],
          usage: { inputTokens: 0, outputTokens: 0, modelCostCadMinor: 0 },
          checkpoint: {},
          interruptions: [],
          modelResolution: {},
        },
      }),
    ).toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an incomplete completed-model resolution before settlement', async () => {
    const { pool, query } = poolFor(() => []);
    const boundary = new PostgresApprovalResumeBoundary({
      pool,
      decideAndLink: vi.fn(),
    });

    expect(() =>
      boundary.complete({
        claimId: 'approval-resume-claim-0001',
        ownershipToken: 'approval-resume-owner-0001',
        binding,
        result: {
          status: 'completed',
          runId: ids.run,
          localTraceReference: 'completed-model-resolution-trace',
          output: { summary: 'Completed.' },
          specialistOutcomes: [],
          hasPartialFailures: false,
          usage: { inputTokens: 0, outputTokens: 0, modelCostCadMinor: 0 },
          modelResolution: {},
        },
      }),
    ).toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('treats a claimed job as in progress and never exposes another owner token', async () => {
    const { pool } = poolFor((sql) =>
      sql.includes('claim_approval_resume_job')
        ? [{ claim_result: { status: 'in-progress', runId: ids.run } }]
        : [],
    );
    const boundary = new PostgresApprovalResumeBoundary({
      pool,
      decideAndLink: vi.fn(),
    });

    await expect(
      boundary.claim({
        decision,
        principal,
        decisionRequestId: ids.decisionRequest,
      }),
    ).resolves.toEqual({ status: 'in-progress', runId: ids.run });
  });

  it('fails readiness closed unless both exact app functions are executable', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('to_regprocedure') ? [{ ready: true }] : [],
    );
    const boundary = new PostgresApprovalResumeBoundary({
      pool,
      decideAndLink: vi.fn(),
    });

    await expect(boundary.check()).resolves.toBe(true);
    expect(query.mock.calls[0]?.[0]).toContain('has_function_privilege');
    expect(query.mock.calls[0]?.[1]).toEqual([
      [
        'emdo.claim_approval_resume_job(uuid,uuid,uuid)',
        'emdo.settle_approval_resume_job(uuid,text,text,text,jsonb)',
      ],
    ]);
  });
});
