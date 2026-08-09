import { describe, expect, it } from 'vitest';

import { InMemoryAuditLedger } from './audit.js';
import {
  MVP_RETENTION_POLICY,
  isEligibleForRetentionPurge,
} from './retention.js';

describe('audit and retention', () => {
  it('clones and deeply freezes append-only audit payloads', () => {
    const ledger = new InMemoryAuditLedger();
    const payload = { result: { status: 'approved' } };
    ledger.append({
      id: 'audit-1',
      householdId: 'household-1',
      actorUserId: 'user-1',
      eventType: 'proposal.approved',
      occurredAt: '2026-08-09T16:00:00.000Z',
      payload,
    });
    payload.result.status = 'tampered';

    const persisted = ledger.list()[0];
    expect(persisted?.payload).toEqual({ result: { status: 'approved' } });
    expect(Object.isFrozen((persisted?.payload as typeof payload).result)).toBe(
      true,
    );
    expect(() =>
      ledger.append({
        id: 'audit-1',
        householdId: 'household-1',
        actorUserId: null,
        eventType: 'duplicate',
        occurredAt: '2026-08-09T16:01:00.000Z',
        payload: {},
      }),
    ).toThrow(/already exists/);
  });

  it('honors retention periods and legal holds', () => {
    const now = new Date('2026-08-09T16:00:00.000Z');
    expect(MVP_RETENTION_POLICY).toEqual({
      auditMetadataDays: 365,
      operationalTraceDays: 90,
    });
    expect(
      isEligibleForRetentionPurge(
        { createdAt: '2025-08-09T16:00:00.000Z', legalHold: false },
        365,
        now,
      ),
    ).toBe(true);
    expect(
      isEligibleForRetentionPurge(
        { createdAt: '2025-08-09T16:00:00.000Z', legalHold: true },
        365,
        now,
      ),
    ).toBe(false);
  });
});
