import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CalendarWriteExecutor,
  InMemoryCalendarWriteReceiptStore,
  RecordedGoogleCalendarGateway,
  hashGoogleCalendarPayload,
  type CalendarWriteReceiptStore,
} from './calendar-write.js';

const payload = {
  eventId: 'emdodentist20260810',
  summary: 'Dentist',
  start: '2026-08-10T15:00:00.000Z',
  end: '2026-08-10T16:00:00.000Z',
  timeZone: 'America/Toronto' as const,
};

const createCommand = {
  schemaVersion: 1 as const,
  operation: 'create' as const,
  calendarId: 'primary',
  eventId: payload.eventId,
  expectedCalendarVersion: 'calendar-v7',
  expectedEventVersion: 'absent' as const,
  payload,
  payloadHash: hashGoogleCalendarPayload(payload),
  idempotencyKey: 'a'.repeat(64),
};

const targetId = (calendarId: string, eventId: string): string =>
  `${calendarId.length}:${calendarId}${eventId.length}:${eventId}`;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
};

const hashJson = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

interface TestCalendarCommand {
  schemaVersion: 1;
  readonly calendarId: string;
  readonly eventId: string;
  readonly expectedCalendarVersion: string;
  readonly expectedEventVersion: string;
  readonly operation: 'create' | 'update' | 'delete';
  readonly payload: unknown;
  readonly payloadHash: string;
  readonly idempotencyKey: string;
}

const canonicalArgumentsForCommand = (command: TestCalendarCommand) => {
  const common = {
    operation: command.operation,
    calendarId: command.calendarId,
    expectedCalendarVersion: command.expectedCalendarVersion,
  };
  if (command.operation === 'create') {
    return { ...common, operation: 'create' as const, event: command.payload };
  }
  if (command.operation === 'update') {
    return {
      ...common,
      operation: 'update' as const,
      eventId: command.eventId,
      expectedEventVersion: command.expectedEventVersion,
      replacement: command.payload,
    };
  }
  return {
    ...common,
    operation: 'delete' as const,
    eventId: command.eventId,
    expectedEventVersion: command.expectedEventVersion,
  };
};

const approvedContext = (command: TestCalendarCommand) => {
  const approvedCanonicalArguments = canonicalArgumentsForCommand(command);
  const approvalBinding = {
    decisionId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004',
    userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f005',
    agentId: 'scheduler',
    runId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f006',
    capabilityId: `google-calendar.event.${command.operation}`,
    capabilityFingerprint: '3'.repeat(64),
    disclosureGrantId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002',
    payloadHash: hashJson(approvedCanonicalArguments),
    idempotencyTtlMs: 86_400_000,
  };
  return {
    approvedCanonicalArguments,
    approvalBinding,
    providerWritePermit: {
      proposalId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
      approvalHash: '1'.repeat(64),
      approvalBindingHash: hashJson({
        domain: 'emdo.provider-write-approval-binding.v1',
        binding: approvalBinding,
      }),
      capabilityFingerprint: '3'.repeat(64),
      proposalCreatedAt: '2026-08-09T12:00:00.000Z',
      expiresAt: '2026-08-09T12:10:00.000Z',
      disclosureGrantId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002',
      disclosureGrantHash: '4'.repeat(64),
      providerIdempotencyKey: command.idempotencyKey,
      idempotencyExpiresAt: '2026-08-10T12:01:00.000Z',
      attemptId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003',
      attemptVersion: 1,
      issuedAt: '2026-08-09T12:01:00.000Z',
      targets: [
        {
          kind: 'google-calendar.event' as const,
          id: targetId(command.calendarId, command.eventId),
          expectedVersion: command.expectedEventVersion,
        },
      ],
      providerPreconditions: [
        {
          kind: 'calendar-version' as const,
          targetId: command.calendarId,
          expectedValue: command.expectedCalendarVersion,
        },
        {
          kind:
            command.operation === 'create'
              ? ('event-absence' as const)
              : ('event-version' as const),
          targetId: targetId(command.calendarId, command.eventId),
          expectedValue: command.expectedEventVersion,
        },
      ],
    },
  };
};

const createAuthorization = approvedContext(createCommand);

describe('CalendarWriteExecutor', () => {
  it('accepts the policy binding over canonical proposal arguments', async () => {
    const gateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'create',
      },
      before: { calendarVersion: 'calendar-v7', event: null },
      apply: { status: 'applied', providerRequestId: 'recorded-canonical-1' },
      after: {
        calendarVersion: 'calendar-v8',
        event: { ...payload, eventVersion: 'event-v1' },
      },
    });

    await expect(
      new CalendarWriteExecutor(
        gateway,
        new InMemoryCalendarWriteReceiptStore(),
      ).execute(createCommand, approvedContext(createCommand)),
    ).resolves.toMatchObject({ status: 'applied' });
  });

  it('executes concurrent identical commands exactly once and verifies readback', async () => {
    const gateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'create',
      },
      before: {
        calendarVersion: 'calendar-v7',
        event: null,
      },
      apply: { status: 'applied', providerRequestId: 'recorded-request-1' },
      after: {
        calendarVersion: 'calendar-v8',
        event: { ...payload, eventVersion: 'event-v1' },
      },
    });
    const executor = new CalendarWriteExecutor(
      gateway,
      new InMemoryCalendarWriteReceiptStore(),
    );

    const [first, second] = await Promise.all([
      executor.execute(createCommand, createAuthorization),
      executor.execute(createCommand, createAuthorization),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: 'applied',
      providerRequestId: 'recorded-request-1',
      readback: { eventVersion: 'event-v1' },
    });
    expect(gateway.applyCount).toBe(1);
    expect(gateway.readbackCount).toBe(1);
    await expect(
      executor.execute(createCommand, createAuthorization),
    ).resolves.toEqual(first);
    expect(gateway.applyCount).toBe(1);
  });

  it('does not dispatch stale commands and binds an idempotency key to one command', async () => {
    const gateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'create',
      },
      before: { calendarVersion: 'calendar-v8', event: null },
      apply: { status: 'applied', providerRequestId: 'must-not-run' },
      after: { calendarVersion: 'calendar-v9', event: null },
    });
    const executor = new CalendarWriteExecutor(
      gateway,
      new InMemoryCalendarWriteReceiptStore(),
    );
    await expect(
      executor.execute(createCommand, createAuthorization),
    ).resolves.toMatchObject({
      status: 'not-applied',
      safeError: { code: 'calendar-precondition-failed' },
    });
    expect(gateway.applyCount).toBe(0);

    const altered = {
      ...createCommand,
      expectedCalendarVersion: 'calendar-v8',
      payload: { ...payload, summary: 'Changed' },
      payloadHash: hashGoogleCalendarPayload({
        ...payload,
        summary: 'Changed',
      }),
    };
    await expect(
      executor.execute(altered, approvedContext(altered)),
    ).resolves.toMatchObject({
      status: 'not-applied',
      safeError: { code: 'calendar-idempotency-conflict' },
    });
    expect(gateway.applyCount).toBe(0);
  });

  it('returns indeterminate when exact readback cannot be proven', async () => {
    const gateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'create',
      },
      before: { calendarVersion: 'calendar-v7', event: null },
      apply: { status: 'applied', providerRequestId: 'recorded-request-2' },
      after: {
        calendarVersion: 'calendar-v8',
        event: {
          ...payload,
          summary: 'Provider changed this',
          eventVersion: 'event-v1',
        },
      },
    });
    const executor = new CalendarWriteExecutor(
      gateway,
      new InMemoryCalendarWriteReceiptStore(),
    );

    await expect(
      executor.execute(createCommand, createAuthorization),
    ).resolves.toMatchObject({
      status: 'indeterminate',
      reconciliationRequired: true,
      safeError: { code: 'calendar-readback-mismatch' },
    });
  });

  it('rejects payload tampering before any provider read', async () => {
    const gateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'create',
      },
      before: { calendarVersion: 'calendar-v7', event: null },
      apply: { status: 'applied', providerRequestId: 'must-not-run' },
      after: { calendarVersion: 'calendar-v8', event: null },
    });
    const executor = new CalendarWriteExecutor(
      gateway,
      new InMemoryCalendarWriteReceiptStore(),
    );
    await expect(
      executor.execute(
        {
          ...createCommand,
          payload: { ...payload, summary: 'Tampered' },
        },
        createAuthorization,
      ),
    ).resolves.toMatchObject({
      status: 'not-applied',
      safeError: { code: 'calendar-payload-hash-mismatch' },
    });
    expect(gateway.readCurrentCount).toBe(0);
    expect(gateway.applyCount).toBe(0);
  });

  it('rejects payload plus hash changes made after visual approval', async () => {
    const tamperedPayload = { ...payload, summary: 'Tampered after approval' };
    const tamperedCommand = {
      ...createCommand,
      payload: tamperedPayload,
      payloadHash: hashGoogleCalendarPayload(tamperedPayload),
    };
    const gateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'create',
      },
      before: { calendarVersion: 'calendar-v7', event: null },
      apply: { status: 'applied', providerRequestId: 'must-not-run' },
      after: {
        calendarVersion: 'calendar-v8',
        event: { ...tamperedPayload, eventVersion: 'event-v1' },
      },
    });

    await expect(
      new CalendarWriteExecutor(
        gateway,
        new InMemoryCalendarWriteReceiptStore(),
      ).execute(tamperedCommand, createAuthorization),
    ).resolves.toMatchObject({
      status: 'not-applied',
      safeError: { code: 'calendar-authorization-invalid' },
    });
    expect(gateway.readCurrentCount).toBe(0);
    expect(gateway.applyCount).toBe(0);
  });

  it('conditionally deletes once and proves absence on readback', async () => {
    const current = { ...payload, eventVersion: 'event-v1' };
    const gateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'delete',
      },
      before: { calendarVersion: 'calendar-v8', event: current },
      apply: { status: 'applied', providerRequestId: 'recorded-delete-1' },
      after: { calendarVersion: 'calendar-v9', event: null },
    });
    const receipts = new InMemoryCalendarWriteReceiptStore();
    const executor = new CalendarWriteExecutor(gateway, receipts);
    const command = {
      schemaVersion: 1 as const,
      operation: 'delete' as const,
      calendarId: 'primary',
      eventId: payload.eventId,
      expectedCalendarVersion: 'calendar-v8',
      expectedEventVersion: 'event-v1',
      payload: null,
      payloadHash: hashGoogleCalendarPayload(null),
      idempotencyKey: 'b'.repeat(64),
    };
    const authorization = approvedContext(command);
    const result = await executor.execute(command, authorization);
    expect(result).toMatchObject({
      status: 'applied',
      providerRequestId: 'recorded-delete-1',
      readback: null,
    });
    expect(gateway.applyCount).toBe(1);

    const secondGateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'delete',
      },
      before: { calendarVersion: 'wrong', event: null },
      apply: { status: 'applied', providerRequestId: 'must-not-run' },
      after: { calendarVersion: 'wrong', event: null },
    });
    await expect(
      new CalendarWriteExecutor(secondGateway, receipts).execute(
        command,
        authorization,
      ),
    ).resolves.toEqual(result);
    expect(secondGateway.readCurrentCount).toBe(0);
    expect(secondGateway.applyCount).toBe(0);
  });

  it('conditionally updates once and proves the exact replacement on readback', async () => {
    const replacement = { ...payload, summary: 'Dentist checkup' };
    const command = {
      schemaVersion: 1 as const,
      operation: 'update' as const,
      calendarId: 'primary',
      eventId: payload.eventId,
      expectedCalendarVersion: 'calendar-v8',
      expectedEventVersion: 'event-v1',
      payload: replacement,
      payloadHash: hashGoogleCalendarPayload(replacement),
      idempotencyKey: 'f'.repeat(64),
    };
    const gateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'update',
      },
      before: {
        calendarVersion: 'calendar-v8',
        event: { ...payload, eventVersion: 'event-v1' },
      },
      apply: { status: 'applied', providerRequestId: 'recorded-update-1' },
      after: {
        calendarVersion: 'calendar-v9',
        event: { ...replacement, eventVersion: 'event-v2' },
      },
    });
    await expect(
      new CalendarWriteExecutor(
        gateway,
        new InMemoryCalendarWriteReceiptStore(),
      ).execute(command, approvedContext(command)),
    ).resolves.toMatchObject({
      status: 'applied',
      providerRequestId: 'recorded-update-1',
      readback: { summary: 'Dentist checkup', eventVersion: 'event-v2' },
    });
    expect(gateway.applyCount).toBe(1);
  });

  it('rejects accessor and cyclic commands without invoking accessors', async () => {
    const gateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'create',
      },
      before: { calendarVersion: 'calendar-v7', event: null },
      apply: { status: 'applied', providerRequestId: 'must-not-run' },
      after: { calendarVersion: 'calendar-v8', event: null },
    });
    const executor = new CalendarWriteExecutor(
      gateway,
      new InMemoryCalendarWriteReceiptStore(),
    );
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, 'schemaVersion', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 1;
      },
    });
    await expect(
      executor.execute(hostile, createAuthorization),
    ).resolves.toMatchObject({
      safeError: { code: 'calendar-command-invalid' },
    });
    expect(getterCalls).toBe(0);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(
      executor.execute(cyclic, createAuthorization),
    ).resolves.toMatchObject({
      safeError: { code: 'calendar-command-invalid' },
    });
    expect(gateway.readCurrentCount).toBe(0);
  });

  it('requires exact visual-approval targets before reading provider state', async () => {
    const gateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'create',
      },
      before: { calendarVersion: 'calendar-v7', event: null },
      apply: { status: 'applied', providerRequestId: 'must-not-run' },
      after: { calendarVersion: 'calendar-v8', event: null },
    });
    const executor = new CalendarWriteExecutor(
      gateway,
      new InMemoryCalendarWriteReceiptStore(),
    );
    await expect(
      executor.execute(createCommand, undefined),
    ).resolves.toMatchObject({
      safeError: { code: 'calendar-authorization-invalid' },
    });
    await expect(
      executor.execute(createCommand, {
        ...createAuthorization,
        approvalBinding: {
          ...createAuthorization.approvalBinding,
          userId: 'different-user',
        },
        providerWritePermit: {
          ...createAuthorization.providerWritePermit,
          targets: [
            {
              ...createAuthorization.providerWritePermit.targets[0]!,
              id: 'tampered-target',
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      safeError: { code: 'calendar-authorization-invalid' },
    });
    expect(gateway.readCurrentCount).toBe(0);
    expect(gateway.applyCount).toBe(0);
  });

  it('binds readback to the exact calendar and provider-deduplicates across executors', async () => {
    const wrongCalendarCommand = { ...createCommand, calendarId: 'other' };
    const gateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'create',
      },
      before: { calendarVersion: 'calendar-v7', event: null },
      apply: { status: 'applied', providerRequestId: 'recorded-request-3' },
      after: {
        calendarVersion: 'calendar-v8',
        event: { ...payload, eventVersion: 'event-v1' },
      },
    });
    await expect(
      new CalendarWriteExecutor(
        gateway,
        new InMemoryCalendarWriteReceiptStore(),
      ).execute(wrongCalendarCommand, approvedContext(wrongCalendarCommand)),
    ).resolves.toMatchObject({
      status: 'not-applied',
      safeError: { code: 'calendar-precondition-failed' },
    });
    expect(gateway.applyCount).toBe(0);

    const [first, second] = await Promise.all([
      new CalendarWriteExecutor(
        gateway,
        new InMemoryCalendarWriteReceiptStore(),
      ).execute(createCommand, createAuthorization),
      new CalendarWriteExecutor(
        gateway,
        new InMemoryCalendarWriteReceiptStore(),
      ).execute(createCommand, createAuthorization),
    ]);
    expect(first).toMatchObject({ status: 'applied' });
    expect(second).toMatchObject({ status: 'applied' });
    expect(gateway.applyCount).toBe(1);
  });

  it('atomically rejects a second expected-absent create with another key', async () => {
    const gateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'create',
      },
      before: { calendarVersion: 'calendar-v7', event: null },
      apply: { status: 'applied', providerRequestId: 'recorded-create-cas' },
      after: {
        calendarVersion: 'calendar-v8',
        event: { ...payload, eventVersion: 'event-v1' },
      },
    });
    const secondCommand = { ...createCommand, idempotencyKey: 'c'.repeat(64) };
    const results = await Promise.all([
      new CalendarWriteExecutor(
        gateway,
        new InMemoryCalendarWriteReceiptStore(),
      ).execute(createCommand, createAuthorization),
      new CalendarWriteExecutor(
        gateway,
        new InMemoryCalendarWriteReceiptStore(),
      ).execute(secondCommand, approvedContext(secondCommand)),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'applied',
      'not-applied',
    ]);
    expect(gateway.applyCount).toBe(1);
  });

  it('atomically rejects a second stale update with another key', async () => {
    const replacement = { ...payload, summary: 'Replacement' };
    const command = {
      schemaVersion: 1 as const,
      operation: 'update' as const,
      calendarId: 'primary',
      eventId: payload.eventId,
      expectedCalendarVersion: 'calendar-v8',
      expectedEventVersion: 'event-v1',
      payload: replacement,
      payloadHash: hashGoogleCalendarPayload(replacement),
      idempotencyKey: 'd'.repeat(64),
    };
    const secondCommand = { ...command, idempotencyKey: 'e'.repeat(64) };
    const gateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'update',
      },
      before: {
        calendarVersion: 'calendar-v8',
        event: { ...payload, eventVersion: 'event-v1' },
      },
      apply: { status: 'applied', providerRequestId: 'recorded-update-cas' },
      after: {
        calendarVersion: 'calendar-v9',
        event: { ...replacement, eventVersion: 'event-v2' },
      },
    });
    const results = await Promise.all([
      new CalendarWriteExecutor(
        gateway,
        new InMemoryCalendarWriteReceiptStore(),
      ).execute(command, approvedContext(command)),
      new CalendarWriteExecutor(
        gateway,
        new InMemoryCalendarWriteReceiptStore(),
      ).execute(secondCommand, approvedContext(secondCommand)),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'applied',
      'not-applied',
    ]);
    expect(gateway.applyCount).toBe(1);
  });

  it('atomically rejects a second stale delete with another key', async () => {
    const command = {
      schemaVersion: 1 as const,
      operation: 'delete' as const,
      calendarId: 'primary',
      eventId: payload.eventId,
      expectedCalendarVersion: 'calendar-v8',
      expectedEventVersion: 'event-v1',
      payload: null,
      payloadHash: hashGoogleCalendarPayload(null),
      idempotencyKey: '6'.repeat(64),
    };
    const secondCommand = { ...command, idempotencyKey: '7'.repeat(64) };
    const gateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'delete',
      },
      before: {
        calendarVersion: 'calendar-v8',
        event: { ...payload, eventVersion: 'event-v1' },
      },
      apply: { status: 'applied', providerRequestId: 'recorded-delete-cas' },
      after: { calendarVersion: 'calendar-v9', event: null },
    });
    const results = await Promise.all([
      new CalendarWriteExecutor(
        gateway,
        new InMemoryCalendarWriteReceiptStore(),
      ).execute(command, approvedContext(command)),
      new CalendarWriteExecutor(
        gateway,
        new InMemoryCalendarWriteReceiptStore(),
      ).execute(secondCommand, approvedContext(secondCommand)),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'applied',
      'not-applied',
    ]);
    expect(gateway.applyCount).toBe(1);
  });

  it('returns indeterminate when durable receipt finalization fails', async () => {
    const gateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'create',
      },
      before: { calendarVersion: 'calendar-v7', event: null },
      apply: { status: 'applied', providerRequestId: 'recorded-request-4' },
      after: {
        calendarVersion: 'calendar-v8',
        event: { ...payload, eventVersion: 'event-v1' },
      },
    });
    const executor = new CalendarWriteExecutor(gateway, {
      acquire: async () => ({ status: 'acquired' as const }),
      complete: async () => {
        throw new Error('recorded receipt failure');
      },
    });
    await expect(
      executor.execute(createCommand, createAuthorization),
    ).resolves.toMatchObject({
      status: 'indeterminate',
      reconciliationRequired: true,
    });
    expect(gateway.applyCount).toBe(1);
  });

  it('awaits durable receipt acquisition and finalization boundaries', async () => {
    const gateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'create',
      },
      before: { calendarVersion: 'calendar-v7', event: null },
      apply: { status: 'applied', providerRequestId: 'recorded-durable-1' },
      after: {
        calendarVersion: 'calendar-v8',
        event: { ...payload, eventVersion: 'event-v1' },
      },
    });
    let releaseAcquire: (() => void) | undefined;
    let releaseComplete: (() => void) | undefined;
    const receipts = {
      acquire: () =>
        new Promise<{ status: 'acquired' }>((resolve) => {
          releaseAcquire = () => resolve({ status: 'acquired' });
        }),
      complete: () =>
        new Promise<void>((resolve) => {
          releaseComplete = resolve;
        }),
    } as unknown as CalendarWriteReceiptStore;
    let settled = false;
    const result = new CalendarWriteExecutor(gateway, receipts)
      .execute(createCommand, createAuthorization)
      .then((value) => {
        settled = true;
        return value;
      });

    expect(gateway.readCurrentCount).toBe(0);
    releaseAcquire?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(gateway.applyCount).toBe(1);
    expect(settled).toBe(false);
    releaseComplete?.();
    await expect(result).resolves.toMatchObject({ status: 'applied' });
  });

  it('fails closed on a malformed durable receipt acquisition', async () => {
    const gateway = new RecordedGoogleCalendarGateway({
      binding: {
        calendarId: 'primary',
        eventId: payload.eventId,
        operation: 'create',
      },
      before: { calendarVersion: 'calendar-v7', event: null },
      apply: { status: 'applied', providerRequestId: 'must-not-run' },
      after: {
        calendarVersion: 'calendar-v8',
        event: { ...payload, eventVersion: 'event-v1' },
      },
    });
    const receipts = {
      acquire: async () => ({ status: 'corrupt' }),
      complete: async () => undefined,
    } as unknown as CalendarWriteReceiptStore;

    await expect(
      new CalendarWriteExecutor(gateway, receipts).execute(
        createCommand,
        createAuthorization,
      ),
    ).resolves.toMatchObject({
      status: 'indeterminate',
      reconciliationRequired: true,
      safeError: { code: 'calendar-provider-indeterminate' },
    });
    expect(gateway.readCurrentCount).toBe(0);
    expect(gateway.applyCount).toBe(0);
  });
});
