import { ProviderWriteAuthorizationSchema } from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import {
  PostgresCalendarMaintenanceService,
  type CalendarProviderAttemptReconciler,
  type CalendarMaintenanceReadGateway,
} from './calendar-maintenance.js';
import { PostgresDeterministicJobExecutionStore } from './execution-store.js';
import { PostgresNotificationDeliveryRepository } from './notifications.js';
import { PostgresWorkerOutboxRepository } from './outbox.js';
import { PostgresReminderDeliveryService } from './reminders.js';

const ids = {
  outbox: '80000000-0000-4000-8000-000000000001',
  lease: '80000000-0000-4000-8000-000000000002',
  notification: '80000000-0000-4000-8000-000000000003',
  queue: '80000000-0000-4000-8000-000000000004',
  attempt: '80000000-0000-4000-8000-000000000005',
  proposal: '80000000-0000-4000-8000-000000000006',
  decision: '80000000-0000-4000-8000-000000000007',
  user: '80000000-0000-4000-8000-000000000008',
  run: '80000000-0000-4000-8000-000000000009',
  grant: '80000000-0000-4000-8000-000000000010',
  household: '80000000-0000-4000-8000-000000000011',
  privateSpace: '80000000-0000-4000-8000-000000000012',
};
const signal = new AbortController().signal;
const reconciliationAuthorization = ProviderWriteAuthorizationSchema.parse({
  proposalId: ids.proposal,
  approvalHash: 'b'.repeat(64),
  approvalBindingHash: 'c'.repeat(64),
  capabilityFingerprint: 'd'.repeat(64),
  proposalCreatedAt: '2026-08-10T13:00:00.000Z',
  expiresAt: '2026-08-10T14:30:00.000Z',
  disclosureGrantId: ids.grant,
  disclosureGrantHash: 'e'.repeat(64),
  approvalBinding: {
    decisionId: ids.decision,
    userId: ids.user,
    agentId: 'scheduler',
    runId: ids.run,
    capabilityId: 'scheduler.calendar.create',
    capabilityFingerprint: 'd'.repeat(64),
    disclosureGrantId: ids.grant,
    payloadHash: 'f'.repeat(64),
    idempotencyTtlMs: 86_400_000,
    authorityBinding: {
      kind: 'google-calendar-grant-v2',
      householdId: ids.household,
      privateSpaceId: ids.privateSpace,
      authorizationScopeFingerprint: '9'.repeat(64),
      providerGrantReference: 'calendar-grant-reference-1',
      authorizationEpoch: 7,
    },
  },
  providerIdempotencyKey: '1'.repeat(64),
  idempotencyExpiresAt: '2026-08-11T13:00:00.000Z',
  attemptId: ids.attempt,
  attemptVersion: 1,
  issuedAt: '2026-08-10T13:01:00.000Z',
  targets: [
    {
      kind: 'calendar-event',
      id: 'calendar-event-opaque-1',
      expectedVersion: 'none',
    },
  ],
  providerPreconditions: [],
});
const indeterminateCompletion = Object.freeze({
  state: 'indeterminate' as const,
  application: 'indeterminate' as const,
  reason: 'timeout-after-dispatch' as const,
  reconciliationRequired: true as const,
});
const unusedReconciler: CalendarProviderAttemptReconciler = Object.freeze({
  async reconcile() {
    return 'mismatch' as const;
  },
});
const executionContext = (
  jobName:
    | 'emdo.reminder.delivery.v1'
    | 'emdo.notification.delivery.v1'
    | 'emdo.calendar.sync.v1'
    | 'emdo.calendar.retry.v1'
    | 'emdo.calendar.reconciliation.v1',
  operationId: string,
) => ({
  execution: {
    jobName,
    operationId,
    queueJobId: ids.queue,
    payloadHash: 'a'.repeat(64),
    leaseToken: ids.lease,
    leaseExpiresAt: '2026-08-10T14:00:00.000Z',
  },
  signal,
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

describe('durable worker PostgreSQL runtime', () => {
  it('claims bounded due outbox rows through SKIP LOCKED and returns strict reference-only payloads', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('claim_due_worker_outbox')
        ? [
            {
              outbox_id: ids.outbox,
              job_name: 'emdo.reminder.delivery.v1',
              payload: {
                schemaVersion: 1,
                origin: 'deterministic-worker',
                operationId: 'reminder-operation:0001',
                reminderId: 'reminder-42',
                dueRevision: 7,
              },
              payload_hash: 'a'.repeat(64),
              start_after: new Date('2026-08-10T13:00:00.000Z'),
              lease_token: ids.lease,
            },
          ]
        : [],
    );

    await expect(
      new PostgresWorkerOutboxRepository(pool).listDue({
        dispatcherId: 'dispatcher-1',
        now: new Date('2026-08-10T13:00:01.000Z'),
        limit: 10,
        leaseMs: 30_000,
        signal,
      }),
    ).resolves.toEqual([
      {
        outboxId: ids.outbox,
        jobName: 'emdo.reminder.delivery.v1',
        payload: {
          schemaVersion: 1,
          origin: 'deterministic-worker',
          operationId: 'reminder-operation:0001',
          reminderId: 'reminder-42',
          dueRevision: 7,
        },
        payloadHash: 'a'.repeat(64),
        startAfter: '2026-08-10T13:00:00.000Z',
        leaseToken: ids.lease,
      },
    ]);
    expect(query.mock.calls[0]?.[0]).toContain('claim_due_worker_outbox');
    expect(query.mock.calls[0]?.[1]).not.toContain(
      new Date('2026-08-10T13:00:01.000Z'),
    );
  });

  it('never invokes a completed operation twice and records callback completion before returning executed', async () => {
    let existing = true;
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('acquire_worker_job_execution')) {
        return [
          {
            status: existing ? 'duplicate' : 'acquired',
            job_name: 'emdo.reminder.delivery.v1',
            operation_id: 'reminder-operation:0001',
            queue_job_id: ids.queue,
            payload_hash: 'a'.repeat(64),
            lease_token: existing ? null : ids.lease,
            lease_expires_at: existing
              ? null
              : new Date('2026-08-10T14:00:00.000Z'),
          },
        ];
      }
      if (sql.includes('complete_worker_job_execution')) {
        return [{ completion_status: 'applied' }];
      }
      return [];
    });
    const store = new PostgresDeterministicJobExecutionStore(pool);
    const operation = vi.fn(async () => undefined);
    const input = {
      jobId: ids.queue,
      jobName: 'emdo.reminder.delivery.v1' as const,
      operationId: 'reminder-operation:0001',
      payloadHash: 'a'.repeat(64),
      signal,
    };

    await expect(store.executeOnce(input, operation)).resolves.toEqual({
      status: 'duplicate',
    });
    expect(operation).not.toHaveBeenCalled();

    existing = false;
    await expect(store.executeOnce(input, operation)).resolves.toEqual({
      status: 'executed',
    });
    expect(operation).toHaveBeenCalledOnce();
    expect(
      query.mock.calls.some(([sql]) => sql === 'set local row_security = on'),
    ).toBe(true);
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('acquire_worker_job_execution'),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.every(
        ([sql]) =>
          !sql.includes('acquire_worker_job_execution') ||
          !sql.includes('set local row_security'),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(
        ([sql, values]) =>
          sql.includes('complete_worker_job_execution') &&
          values?.includes('reminder-operation:0001'),
      ),
    ).toBe(true);
  });

  it('commits terminal attempt exhaustion before surfacing the safe queue boundary error', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('acquire_worker_job_execution')) {
        return [
          {
            status: 'acquired',
            job_name: 'emdo.reminder.delivery.v1',
            operation_id: 'reminder-operation:0001',
            queue_job_id: ids.queue,
            payload_hash: 'a'.repeat(64),
            lease_token: ids.lease,
            lease_expires_at: new Date('2026-08-10T14:00:00.000Z'),
          },
        ];
      }
      if (sql.includes('complete_worker_job_execution')) {
        return [{ completion_status: 'exhausted' }];
      }
      return [];
    });
    const store = new PostgresDeterministicJobExecutionStore(pool);

    await expect(
      store.executeOnce(
        {
          jobId: ids.queue,
          jobName: 'emdo.reminder.delivery.v1',
          operationId: 'reminder-operation:0001',
          payloadHash: 'a'.repeat(64),
          signal,
        },
        async () => {
          throw new Error('retry-safe failure');
        },
      ),
    ).rejects.toMatchObject({ code: 'attempt-exhausted' });

    const completionIndex = query.mock.calls.findIndex(([sql]) =>
      sql.includes('complete_worker_job_execution'),
    );
    const commitAfterCompletion = query.mock.calls.findIndex(
      ([sql], index) => index > completionIndex && sql === 'commit',
    );
    expect(completionIndex).toBeGreaterThanOrEqual(0);
    expect(commitAfterCompletion).toBeGreaterThan(completionIndex);
    expect(
      query.mock.calls.some(
        ([sql], index) => index > completionIndex && sql === 'rollback',
      ),
    ).toBe(false);
  });

  it('CAS-delivers one due reminder and creates one notification plus delivery outbox atomically', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('claim_worker_operation_scope')) {
        return [{ authorized: true }];
      }
      if (sql.includes('insert into emdo.notifications')) {
        return [{ notification_id: ids.notification, revision: 1 }];
      }
      if (sql.includes('from emdo.scheduler_reminders')) {
        return [
          {
            state: 'scheduled',
            due_revision: 7,
            due_at: new Date('2026-08-10T12:59:00.000Z'),
            sensitivity: 'sensitive',
            title: 'Private reminder',
            body: 'Private body',
            in_app: true,
            email_recipient: 'member@example.ca',
            push_subscription_reference: null,
            email_outcome: null,
            push_outcome: null,
          },
        ];
      }
      if (sql.includes('insert into emdo.worker_operation_outbox')) {
        return [{ outbox_id: ids.outbox }];
      }
      if (sql.includes('clock_timestamp() as now')) {
        return [{ now: new Date('2026-08-10T13:00:00.000Z') }];
      }
      if (sql.includes('update emdo.scheduler_reminders')) {
        return [{ reminder_id: 'reminder-42' }];
      }
      return [];
    });

    await expect(
      new PostgresReminderDeliveryService(pool).deliverReminder(
        {
          operationId: 'reminder-operation:0001',
          reminderId: 'reminder-42',
          dueRevision: 7,
        },
        executionContext(
          'emdo.reminder.delivery.v1',
          'reminder-operation:0001',
        ),
      ),
    ).resolves.toBeUndefined();

    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining('insert into emdo.notifications'),
        expect.stringContaining('insert into emdo.worker_operation_outbox'),
        expect.stringContaining('update emdo.scheduler_reminders'),
      ]),
    );
    expect(statements.at(-1)).toBe('commit');
  });

  it('loads only current notification delivery preferences and suppresses disabled external channels', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('claim_worker_operation_scope')) {
        return [{ authorized: true }];
      }
      if (sql.includes('insert into emdo.notification_deliveries')) {
        return [{ delivery_id: 'notification:abc' }];
      }
      if (sql.includes('read_worker_notification_delivery_preferences')) {
        return [
          {
            delivery_preferences: {
              schemaVersion: 1,
              notificationId: ids.notification,
              revision: 3,
              sensitivity: 'sensitive',
              title: 'Private title',
              body: 'Private body',
              channels: {
                inApp: true,
                email: { enabled: false, recipient: null },
                push: { enabled: false, subscriptionReference: null },
              },
            },
            email_outcome: null,
            push_outcome: null,
          },
        ];
      }
      return [];
    });
    const repository = new PostgresNotificationDeliveryRepository(pool);

    await expect(
      repository.loadForDelivery(
        {
          operationId: 'notification-operation:0001',
          notificationId: ids.notification,
        },
        executionContext(
          'emdo.notification.delivery.v1',
          'notification-operation:0001',
        ),
      ),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      notificationId: ids.notification,
      title: 'Private title',
      channels: { inApp: true, email: null, push: null },
      externalOutcomes: { email: null, push: null },
    });

    const preferenceRead = query.mock.calls.find(([sql]) =>
      sql.includes('read_worker_notification_delivery_preferences'),
    );
    expect(preferenceRead?.[0]).not.toMatch(
      /\b(?:email_recipient|push_subscription_reference)\b/u,
    );
    expect(preferenceRead?.[0]).not.toContain('from emdo.notifications');
    await repository.recordExternalOutcome(
      {
        operationId: 'notification-operation:0001',
        deliveryId: 'notification:abc',
        notificationId: ids.notification,
        channel: 'email',
        status: 'indeterminate',
      },
      executionContext(
        'emdo.notification.delivery.v1',
        'notification-operation:0001',
      ),
    );

    const outcome = query.mock.calls.find(([sql]) =>
      sql.includes('insert into emdo.notification_deliveries'),
    );
    expect(outcome?.[0]).toContain(
      "notification_deliveries.status in ('sent', 'duplicate')",
    );
    expect(outcome?.[0]).toContain("excluded.status in ('sent', 'duplicate')");
    expect(outcome?.[1]).toEqual(
      expect.arrayContaining(['email', 'indeterminate']),
    );
    expect(JSON.stringify(outcome?.[1])).not.toMatch(
      /Private title|Private body/,
    );
  });

  it('advances Calendar sync state by generation CAS using read-only provider evidence', async () => {
    const gateway: CalendarMaintenanceReadGateway = {
      synchronize: vi.fn(async () => ({
        status: 'advanced',
        sealedCursor: 'v1.key.nonce.tag.ciphertext',
        providerVersion: 'calendar-v10',
        evidenceHash: 'a'.repeat(64),
      })),
      readBackAttempt: vi.fn(async () => ({
        application: 'not-applied',
        resultHash: 'b'.repeat(64),
        evidenceHash: 'c'.repeat(64),
      })),
    };
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('claim_worker_operation_scope')) {
        return [{ authorized: true }];
      }
      if (sql.includes('from emdo.calendar_sync_states')) {
        return [
          {
            provider_id: 'google-calendar',
            household_id: ids.household,
            space_id: ids.privateSpace,
            original_owner_user_id: ids.user,
            sync_generation: 9,
            sealed_cursor: 'v1.old',
            state: 'ready',
            retry_sequence: 0,
          },
        ];
      }
      if (sql.includes('update emdo.calendar_sync_states')) {
        return [{ connection_id: 'google-connection-42' }];
      }
      if (sql.includes('insert into emdo.calendar_maintenance_receipts')) {
        return [{ operation_id: 'calendar-sync-operation:0001' }];
      }
      return [];
    });

    await expect(
      new PostgresCalendarMaintenanceService(
        pool,
        gateway,
        unusedReconciler,
      ).synchronize(
        {
          operationId: 'calendar-sync-operation:0001',
          connectionId: 'google-connection-42',
          syncGeneration: 9,
        },
        executionContext(
          'emdo.calendar.sync.v1',
          'calendar-sync-operation:0001',
        ),
      ),
    ).resolves.toBeUndefined();
    expect(gateway.synchronize).toHaveBeenCalledWith({
      jobAuthority: expect.objectContaining({
        jobName: 'emdo.calendar.sync.v1',
        operationId: 'calendar-sync-operation:0001',
        queueJobId: ids.queue,
        payloadHash: 'a'.repeat(64),
        leaseToken: ids.lease,
      }),
      connectionAuthority: {
        providerId: 'google-calendar',
        connectionId: 'google-connection-42',
        householdId: ids.household,
        spaceId: ids.privateSpace,
        originalOwnerUserId: ids.user,
        syncGeneration: 9,
        sealedCursor: 'v1.old',
      },
      signal,
    });
    const brokerRequest = vi.mocked(gateway.synchronize).mock.calls[0]?.[0] as
      Record<string, unknown> | undefined;
    expect(Object.isFrozen(brokerRequest)).toBe(true);
    expect(Object.isFrozen(brokerRequest?.jobAuthority)).toBe(true);
    expect(Object.isFrozen(brokerRequest?.connectionAuthority)).toBe(true);
    expect(Object.keys(brokerRequest ?? {}).sort()).toEqual([
      'connectionAuthority',
      'jobAuthority',
      'signal',
    ]);
    expect(JSON.stringify(brokerRequest)).not.toMatch(
      /access.?token|refresh.?token|client.?secret|encrypted.?grant|grant.?body/iu,
    );
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('sync_generation = sync_generation + 1'),
      ),
    ).toBe(true);
  });

  it('terminalizes Calendar retry sequence 20 without creating another retry outbox', async () => {
    const gateway: CalendarMaintenanceReadGateway = {
      synchronize: vi.fn(async () => {
        throw new Error('provider unavailable');
      }),
      readBackAttempt: vi.fn(async () => undefined),
    };
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('claim_worker_operation_scope')) {
        return [{ authorized: true }];
      }
      if (sql.includes('from emdo.calendar_sync_states')) {
        return [
          {
            provider_id: 'google-calendar',
            household_id: ids.household,
            space_id: ids.privateSpace,
            original_owner_user_id: ids.user,
            sync_generation: 9,
            sealed_cursor: 'v1.old',
            state: 'retry-pending',
            retry_sequence: 20,
          },
        ];
      }
      if (sql.includes('update emdo.calendar_sync_states')) {
        return [
          {
            household_id: '10000000-0000-4000-8000-000000000001',
            space_id: '20000000-0000-4000-8000-000000000001',
            original_owner_user_id: '30000000-0000-4000-8000-000000000001',
          },
        ];
      }
      if (sql.includes('insert into emdo.calendar_maintenance_receipts')) {
        return [{ operation_id: 'calendar-retry-operation:0020' }];
      }
      return [];
    });

    await expect(
      new PostgresCalendarMaintenanceService(
        pool,
        gateway,
        unusedReconciler,
      ).retrySynchronization(
        {
          operationId: 'calendar-retry-operation:0020',
          failedOperationId: 'calendar-retry-operation:0019',
          connectionId: 'google-connection-42',
          retrySequence: 20,
        },
        executionContext(
          'emdo.calendar.retry.v1',
          'calendar-retry-operation:0020',
        ),
      ),
    ).resolves.toBeUndefined();

    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('insert into emdo.worker_operation_outbox'),
      ),
    ).toBe(false);
    expect(
      query.mock.calls.some(
        ([sql, values]) =>
          sql.includes('update emdo.calendar_sync_states') &&
          values?.includes(20),
      ),
    ).toBe(true);
  });

  it('closes preflight before provider readback and delegates the full completion to the durable proposal reconciler', async () => {
    const events: string[] = [];
    const authorization = reconciliationAuthorization;
    const completion = {
      state: 'executed' as const,
      application: 'applied' as const,
      outputStatus: 'valid' as const,
      resultHash: '2'.repeat(64),
      evidenceHash: '3'.repeat(64),
    };
    let brokerRequest: Record<string, unknown> | undefined;
    const gateway: CalendarMaintenanceReadGateway = {
      async synchronize() {
        throw new Error('not used');
      },
      async readBackAttempt(input) {
        brokerRequest = input as unknown as Record<string, unknown>;
        events.push('provider:readback');
        return completion;
      },
    };
    const reconciler: CalendarProviderAttemptReconciler = {
      async reconcile(input) {
        events.push('proposal:reconcile');
        expect(input).toEqual({
          providerAttemptId: ids.attempt,
          approvalBinding: authorization.approvalBinding,
          completion,
          execution: expect.objectContaining({
            jobName: 'emdo.calendar.reconciliation.v1',
            operationId: 'calendar-reconcile-operation:0001',
          }),
        });
        return 'finalized';
      },
    };
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('claim_worker_operation_scope')) {
        return [{ authorized: true }];
      }
      if (sql.includes('from emdo.provider_attempts')) {
        events.push('database:preflight');
        return [
          {
            id: ids.attempt,
            attempt_state: 'indeterminate',
            authorization,
            outcome_application: 'indeterminate',
            outcome_completion: indeterminateCompletion,
          },
        ];
      }
      if (sql.includes('insert into emdo.calendar_maintenance_receipts')) {
        events.push('database:receipt');
        return [{ operation_id: 'calendar-reconcile-operation:0001' }];
      }
      if (sql === 'commit') events.push('database:commit');
      return [];
    });

    await expect(
      new PostgresCalendarMaintenanceService(
        pool,
        gateway,
        reconciler,
      ).reconcileProviderAttempt(
        {
          operationId: 'calendar-reconcile-operation:0001',
          providerAttemptId: ids.attempt,
        },
        executionContext(
          'emdo.calendar.reconciliation.v1',
          'calendar-reconcile-operation:0001',
        ),
      ),
    ).resolves.toBeUndefined();

    expect(events).toEqual([
      'database:preflight',
      'database:commit',
      'provider:readback',
      'proposal:reconcile',
      'database:receipt',
      'database:commit',
    ]);
    expect(brokerRequest).toEqual({
      jobAuthority: expect.objectContaining({
        jobName: 'emdo.calendar.reconciliation.v1',
        operationId: 'calendar-reconcile-operation:0001',
        queueJobId: ids.queue,
        payloadHash: 'a'.repeat(64),
        leaseToken: ids.lease,
      }),
      attemptAuthority: {
        providerId: 'google-calendar',
        providerAttemptId: ids.attempt,
        decisionId: ids.decision,
        userId: ids.user,
        agentId: 'scheduler',
        runId: ids.run,
        capabilityId: 'scheduler.calendar.create',
        capabilityFingerprint: 'd'.repeat(64),
        payloadHash: 'f'.repeat(64),
        householdId: ids.household,
        spaceId: ids.privateSpace,
        connectionId: 'calendar-grant-reference-1',
        authorizationEpoch: 7,
      },
      signal,
    });
    expect(Object.isFrozen(brokerRequest)).toBe(true);
    expect(Object.isFrozen(brokerRequest?.jobAuthority)).toBe(true);
    expect(Object.isFrozen(brokerRequest?.attemptAuthority)).toBe(true);
    expect(Object.keys(brokerRequest ?? {}).sort()).toEqual([
      'attemptAuthority',
      'jobAuthority',
      'signal',
    ]);
    expect(JSON.stringify(brokerRequest)).not.toMatch(
      /approvalBinding|authorityBinding|spaceAccessGrantId|disclosureGrantId|access.?token|refresh.?token|client.?secret|encrypted.?grant|canonical.?arg|provider.?response/iu,
    );
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('insert into emdo.proposal_reconciliations'),
      ),
    ).toBe(false);
  });

  it('never invents a not-applied reason from the legacy partial readback envelope', async () => {
    const reconcile = vi.fn(async () => 'finalized' as const);
    const gateway: CalendarMaintenanceReadGateway = {
      async synchronize() {
        throw new Error('not used');
      },
      async readBackAttempt() {
        return {
          application: 'not-applied',
          resultHash: '4'.repeat(64),
          evidenceHash: '5'.repeat(64),
        };
      },
    };
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('claim_worker_operation_scope')) {
        return [{ authorized: true }];
      }
      if (sql.includes('insert into emdo.proposal_reconciliations')) {
        return [{ attempt_id: ids.attempt }];
      }
      if (sql.includes('from emdo.provider_attempts')) {
        return [
          {
            id: ids.attempt,
            attempt_state: 'indeterminate',
            authorization: reconciliationAuthorization,
            outcome_application: 'indeterminate',
            outcome_completion: indeterminateCompletion,
          },
        ];
      }
      if (sql.includes('insert into emdo.calendar_maintenance_receipts')) {
        return [{ operation_id: 'calendar-reconcile-operation:0002' }];
      }
      return [];
    });

    await expect(
      new PostgresCalendarMaintenanceService(pool, gateway, {
        reconcile,
      }).reconcileProviderAttempt(
        {
          operationId: 'calendar-reconcile-operation:0002',
          providerAttemptId: ids.attempt,
        },
        executionContext(
          'emdo.calendar.reconciliation.v1',
          'calendar-reconcile-operation:0002',
        ),
      ),
    ).resolves.toBeUndefined();

    expect(reconcile).not.toHaveBeenCalled();
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('insert into emdo.proposal_reconciliations'),
      ),
    ).toBe(false);
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes('insert into emdo.calendar_maintenance_receipts'),
      )?.[1],
    ).toEqual(
      expect.arrayContaining(['indeterminate', 'readback-indeterminate']),
    );
  });

  it('fails closed before provider readback when the stored authorization attempt is mismatched', async () => {
    const mismatchedAuthorization = ProviderWriteAuthorizationSchema.parse({
      ...reconciliationAuthorization,
      attemptId: ids.outbox,
    });
    const readBackAttempt = vi.fn(async () => ({
      state: 'executed',
      application: 'applied',
      outputStatus: 'valid',
      resultHash: '6'.repeat(64),
    }));
    const { pool } = poolFor((sql) => {
      if (sql.includes('claim_worker_operation_scope')) {
        return [{ authorized: true }];
      }
      if (sql.includes('from emdo.provider_attempts')) {
        return [
          {
            id: ids.attempt,
            attempt_state: 'indeterminate',
            authorization: mismatchedAuthorization,
            outcome_application: 'indeterminate',
            outcome_completion: indeterminateCompletion,
          },
        ];
      }
      return [];
    });

    await expect(
      new PostgresCalendarMaintenanceService(
        pool,
        {
          async synchronize() {
            throw new Error('not used');
          },
          readBackAttempt,
        },
        unusedReconciler,
      ).reconcileProviderAttempt(
        {
          operationId: 'calendar-reconcile-operation:0003',
          providerAttemptId: ids.attempt,
        },
        executionContext(
          'emdo.calendar.reconciliation.v1',
          'calendar-reconcile-operation:0003',
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid-result' });
    expect(readBackAttempt).not.toHaveBeenCalled();
  });
});
