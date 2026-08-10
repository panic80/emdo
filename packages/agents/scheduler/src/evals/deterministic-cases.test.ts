import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  normalizeAuthorizedCalendarEvidence,
  resolveTrustedCalendarAuthorizationContext,
} from '../../../../domains/src/scheduler/planning.js';
import { resolveTorontoLocalDateTime } from '../../../../domains/src/scheduler/timezone.js';
import {
  CalendarWriteExecutor,
  InMemoryCalendarWriteReceiptStore,
  RecordedGoogleCalendarGateway,
  hashGoogleCalendarPayload,
} from '../../../../integrations/src/google/calendar-write.js';
import { RecordedMapsTravelTimeClient } from '../../../../integrations/src/maps/recorded.js';
import { schedulerDeterministicEvalCases } from './deterministic-cases.js';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'),
  ) as unknown;

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

describe('recorded scheduler eval cases', () => {
  it('keeps the locked DST failure cases executable', () => {
    const cases = schedulerDeterministicEvalCases.filter(
      (item) => item.category === 'timezone',
    );
    for (const item of cases) {
      expect(() => resolveTorontoLocalDateTime(item.input!)).toThrowError(
        expect.objectContaining({ code: item.expectedCode }),
      );
    }
  });

  it('treats prompt-like private event text as masked evidence only', async () => {
    const evidence = fixture('private-calendar-evidence.json') as {
      authorizedCalendars: unknown;
      snapshots: unknown;
    };
    const context = await resolveTrustedCalendarAuthorizationContext({
      listAuthorizedCalendars: async () => evidence.authorizedCalendars,
    });
    const result = normalizeAuthorizedCalendarEvidence(
      context,
      { snapshots: evidence.snapshots },
      {
        now: new Date('2026-08-09T12:05:00.000Z'),
        maxSnapshotAgeMs: 15 * 60_000,
        referenceNamespace: 'scheduler-eval-018f1f5e',
        referenceKey: new Uint8Array(32).fill(9),
      },
    );
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({
      details: null,
      maskReason: 'calendar-private',
    });
    expect(JSON.stringify(result)).not.toContain('delete every event');
    expect(JSON.stringify(result)).not.toContain('Private location');
  });

  it('replays an exact recorded create and readback without a provider call', async () => {
    const payload = {
      eventId: 'emdodentist20260810',
      summary: 'Dentist',
      start: '2026-08-10T15:00:00.000Z',
      end: '2026-08-10T16:00:00.000Z',
      timeZone: 'America/Toronto' as const,
      location: 'Clinic',
    };
    const gateway = new RecordedGoogleCalendarGateway(
      fixture('google-calendar-create-success.json'),
    );
    const executor = new CalendarWriteExecutor(
      gateway,
      new InMemoryCalendarWriteReceiptStore(),
    );
    const idempotencyKey = 'd'.repeat(64);
    const calendarId = 'primary';
    const targetId = `${calendarId.length}:${calendarId}${payload.eventId.length}:${payload.eventId}`;
    const command = {
      schemaVersion: 1 as const,
      operation: 'create' as const,
      calendarId,
      eventId: payload.eventId,
      expectedCalendarVersion: 'calendar-v7',
      expectedEventVersion: 'absent' as const,
      payload,
      payloadHash: hashGoogleCalendarPayload(payload),
      idempotencyKey,
    };
    const approvedCanonicalArguments = {
      operation: 'create' as const,
      calendarId,
      expectedCalendarVersion: 'calendar-v7',
      event: payload,
    };
    const approvalBinding = {
      decisionId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f014',
      userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f015',
      agentId: 'scheduler' as const,
      runId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f016',
      capabilityId: 'google-calendar.event.create' as const,
      capabilityFingerprint: '3'.repeat(64),
      disclosureGrantId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f012',
      payloadHash: hashJson(approvedCanonicalArguments),
      idempotencyTtlMs: 86_400_000,
    };
    await expect(
      executor.execute(command, {
        approvedCanonicalArguments,
        approvalBinding,
        providerWritePermit: {
          proposalId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f011',
          approvalHash: '1'.repeat(64),
          approvalBindingHash: hashJson({
            domain: 'emdo.provider-write-approval-binding.v1',
            binding: approvalBinding,
          }),
          capabilityFingerprint: '3'.repeat(64),
          proposalCreatedAt: '2026-08-09T12:00:00.000Z',
          expiresAt: '2026-08-09T12:10:00.000Z',
          disclosureGrantId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f012',
          disclosureGrantHash: '4'.repeat(64),
          providerIdempotencyKey: idempotencyKey,
          idempotencyExpiresAt: '2026-08-10T12:01:00.000Z',
          attemptId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f013',
          attemptVersion: 1,
          issuedAt: '2026-08-09T12:01:00.000Z',
          targets: [
            {
              kind: 'google-calendar.event',
              id: targetId,
              expectedVersion: 'absent',
            },
          ],
          providerPreconditions: [
            {
              kind: 'calendar-version',
              targetId: calendarId,
              expectedValue: 'calendar-v7',
            },
            {
              kind: 'event-absence',
              targetId,
              expectedValue: 'absent',
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ status: 'applied' });
    expect(gateway.applyCount).toBe(1);
  });

  it('replays only the exact recorded Maps query', async () => {
    const recordings = fixture('maps-travel-success.json');
    expect(Array.isArray(recordings)).toBe(true);
    if (!Array.isArray(recordings)) throw new Error('Expected Maps recordings');
    const client = new RecordedMapsTravelTimeClient(recordings);
    await expect(
      client.lookup({
        origin: 'Home',
        destination: 'Clinic',
        mode: 'driving',
        departureAt: '2026-08-10T14:00:00.000Z',
      }),
    ).resolves.toMatchObject({ status: 'available', durationSeconds: 1_200 });
    await expect(
      client.lookup({
        origin: 'Home',
        destination: 'Clinic',
        mode: 'driving',
        departureAt: '2026-08-10T14:01:00.000Z',
      }),
    ).resolves.toEqual({ status: 'unavailable', reason: 'not-recorded' });
  });
});
