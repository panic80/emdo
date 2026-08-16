import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import { PostgresInvitationDeliveryRepository } from './invitation-delivery.js';
import { WorkerJobPayloadSchema } from './scope.js';

const ids = {
  invitation: '84000000-0000-4000-8000-000000000001',
  secret: '84000000-0000-4000-8000-000000000002',
  queue: '84000000-0000-4000-8000-000000000003',
  lease: '84000000-0000-4000-8000-000000000004',
};
const operationId = `invitation-delivery:${ids.invitation}`;
const signal = new AbortController().signal;
const context = {
  execution: {
    jobName: 'emdo.invitation.delivery.v1' as const,
    operationId,
    queueJobId: ids.queue,
    payloadHash: 'a'.repeat(64),
    leaseToken: ids.lease,
    leaseExpiresAt: '2026-08-10T14:00:00.000Z',
  },
  signal,
};
const envelope = {
  schemaVersion: 1,
  algorithm: 'RSA-OAEP-256',
  keyId: 'invitation-delivery-key-2026-08',
  ciphertext: 'B'.repeat(342),
  bindingHash: 'b'.repeat(64),
} as const;
const activeDelivery = {
  schemaVersion: 1,
  status: 'active',
  invitationId: ids.invitation,
  deliverySecretId: ids.secret,
  recipient: 'member@example.ca',
  role: 'member',
  tokenHash: 'c'.repeat(64),
  templateVersion: 'invitation-redemption.v1',
  envelope,
} as const;

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

describe('PostgresInvitationDeliveryRepository', () => {
  it('captures the exact sealed delivery reference through a protected routine', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('claim_worker_operation_scope')
        ? [{ authorized: true }]
        : sql.includes('capture_invitation_delivery_secret')
          ? [{ delivery: activeDelivery }]
          : [],
    );

    await expect(
      new PostgresInvitationDeliveryRepository(pool).captureForDelivery(
        {
          operationId,
          invitationId: ids.invitation,
          deliverySecretId: ids.secret,
        },
        context,
      ),
    ).resolves.toEqual(activeDelivery);

    const claim = query.mock.calls.find(([sql]) =>
      sql.includes('claim_worker_operation_scope'),
    );
    expect(claim?.[1]?.slice(5, 8)).toEqual(['invitation', ids.invitation, 1]);
    const capture = query.mock.calls.find(([sql]) =>
      sql.includes('capture_invitation_delivery_secret'),
    );
    expect(capture?.[0]).toContain(
      'emdo.capture_invitation_delivery_secret($1::uuid, $2::uuid)',
    );
    expect(capture?.[0]).not.toContain('from emdo.invitation_delivery_secrets');
    expect(capture?.[1]).toEqual([ids.invitation, ids.secret]);
    expect(JSON.stringify(query.mock.calls)).not.toContain('invitationToken');
  });

  it('returns the strict terminal expired result without secret material', async () => {
    const expired = {
      schemaVersion: 1,
      status: 'expired',
      invitationId: ids.invitation,
      deliverySecretId: ids.secret,
    } as const;
    const { pool } = poolFor((sql) =>
      sql.includes('claim_worker_operation_scope')
        ? [{ authorized: true }]
        : sql.includes('capture_invitation_delivery_secret')
          ? [{ delivery: expired }]
          : [],
    );

    await expect(
      new PostgresInvitationDeliveryRepository(pool).captureForDelivery(
        {
          operationId,
          invitationId: ids.invitation,
          deliverySecretId: ids.secret,
        },
        context,
      ),
    ).resolves.toEqual(expired);
  });

  it('fails closed when the protected routine returns malformed or rebound data', async () => {
    const rebound = {
      ...activeDelivery,
      deliverySecretId: '84000000-0000-4000-8000-000000000099',
    };
    const { pool } = poolFor((sql) =>
      sql.includes('claim_worker_operation_scope')
        ? [{ authorized: true }]
        : sql.includes('capture_invitation_delivery_secret')
          ? [{ delivery: rebound }]
          : [],
    );

    await expect(
      new PostgresInvitationDeliveryRepository(pool).captureForDelivery(
        {
          operationId,
          invitationId: ids.invitation,
          deliverySecretId: ids.secret,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'invalid-result' });
  });

  it.each(['confirmed', 'indeterminate', 'expired'] as const)(
    'settles %s through the protected routine and accepts only a strict receipt',
    async (disposition) => {
      const { pool, query } = poolFor((sql) =>
        sql.includes('claim_worker_operation_scope')
          ? [{ authorized: true }]
          : sql.includes('settle_invitation_delivery_secret')
            ? [{ settlement: { status: 'settled' } }]
            : [],
      );

      await expect(
        new PostgresInvitationDeliveryRepository(pool).settleDelivery(
          {
            operationId,
            invitationId: ids.invitation,
            deliverySecretId: ids.secret,
            disposition,
          },
          context,
        ),
      ).resolves.toEqual({ status: 'settled' });

      const settlement = query.mock.calls.find(([sql]) =>
        sql.includes('settle_invitation_delivery_secret'),
      );
      expect(settlement?.[0]).toContain(
        'emdo.settle_invitation_delivery_secret($1::uuid, $2::uuid, $3::text)',
      );
      expect(settlement?.[0]).not.toContain(
        'update emdo.invitation_delivery_secrets',
      );
      expect(settlement?.[1]).toEqual([
        ids.invitation,
        ids.secret,
        disposition,
      ]);
    },
  );

  it('preserves an exact duplicate settlement receipt', async () => {
    const { pool } = poolFor((sql) =>
      sql.includes('claim_worker_operation_scope')
        ? [{ authorized: true }]
        : sql.includes('settle_invitation_delivery_secret')
          ? [{ settlement: { status: 'duplicate' } }]
          : [],
    );

    await expect(
      new PostgresInvitationDeliveryRepository(pool).settleDelivery(
        {
          operationId,
          invitationId: ids.invitation,
          deliverySecretId: ids.secret,
          disposition: 'confirmed',
        },
        context,
      ),
    ).resolves.toEqual({ status: 'duplicate' });
  });

  it('rejects plaintext invitation tokens in the durable job payload', () => {
    const payload = {
      jobName: 'emdo.invitation.delivery.v1',
      payload: {
        schemaVersion: 1,
        origin: 'deterministic-worker',
        operationId,
        invitationId: ids.invitation,
        deliverySecretId: ids.secret,
      },
    } as const;

    expect(WorkerJobPayloadSchema.safeParse(payload).success).toBe(true);
    expect(
      WorkerJobPayloadSchema.safeParse({
        ...payload,
        payload: { ...payload.payload, invitationToken: 'A'.repeat(43) },
      }).success,
    ).toBe(false);
  });
});
