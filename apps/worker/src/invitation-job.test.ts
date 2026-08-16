import { describe, expect, it } from 'vitest';

import {
  WORKER_JOB_NAMES,
  createWorkerJobHandlers,
  hashWorkerJobPayload,
  type WorkerJobDependencies,
} from './jobs.js';

const name = WORKER_JOB_NAMES.invitationDelivery;
const payload = {
  schemaVersion: 1,
  origin: 'deterministic-worker',
  operationId: 'invitation:11111111-1111-4111-8111-111111111111',
  invitationId: '11111111-1111-4111-8111-111111111111',
  deliverySecretId: '22222222-2222-4222-8222-222222222222',
} as const;
const jobId = '20000000-0000-8000-8000-000000000006';

const dependencies = (calls: unknown[]): WorkerJobDependencies => ({
  executions: {
    async executeOnce(input, operation) {
      await operation({
        jobName: input.jobName,
        operationId: input.operationId,
        queueJobId: input.jobId,
        payloadHash: input.payloadHash,
        leaseToken: '30000000-0000-4000-8000-000000000001',
        leaseExpiresAt: '2026-08-10T12:05:00.000Z',
      });
      return { status: 'executed' };
    },
  },
  reminders: { async deliverReminder() {} },
  calendar: {
    async synchronize() {},
    async retrySynchronization() {},
    async reconcileProviderAttempt() {},
  },
  notifications: {
    async deliver() {
      return { status: 'delivered', attemptedChannels: 1 };
    },
  },
  invitations: {
    async deliver(input, context) {
      calls.push({ input, context });
      return { status: 'delivered' };
    },
  },
});

describe('invitation delivery worker job', () => {
  it('uses the exact versioned name and a strict reference-only payload', () => {
    expect(name).toBe('emdo.invitation.delivery.v1');
    expect(hashWorkerJobPayload(name, payload)).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(payload)).not.toMatch(/token|ciphertext|envelope/iu);
    for (const invalid of [
      { ...payload, extra: 'forbidden' },
      { ...payload, origin: 'api' },
      { ...payload, invitationId: 'not-a-uuid' },
      { ...payload, deliverySecretId: 'not-a-uuid' },
      { ...payload, invitationToken: 'A'.repeat(43) },
      { ...payload, envelope: { ciphertext: 'secret' } },
    ]) {
      expect(() => hashWorkerJobPayload(name, invalid)).toThrow(
        'Background job payload is invalid',
      );
    }
  });

  it('dispatches only the exact durable references through deterministic execution', async () => {
    const calls: unknown[] = [];
    const handler = createWorkerJobHandlers(dependencies(calls))[name];

    await expect(
      handler([
        {
          id: jobId,
          name,
          data: payload,
          signal: new AbortController().signal,
        },
      ]),
    ).resolves.toEqual({ status: 'executed' });

    expect(calls).toEqual([
      {
        input: {
          operationId: payload.operationId,
          invitationId: payload.invitationId,
          deliverySecretId: payload.deliverySecretId,
        },
        context: expect.objectContaining({
          execution: expect.objectContaining({
            jobName: name,
            operationId: payload.operationId,
          }),
        }),
      },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(
      /invitationToken|ciphertext|envelope/iu,
    );
  });
});
