import { describe, expect, it } from 'vitest';

import { InMemoryGoogleOAuthFlowStore } from './state.js';
import type { GoogleOAuthFlowRecord } from './service.js';

const actor = Object.freeze({
  userId: 'user-1',
  householdId: 'household-1',
  privateSpaceId: 'private-space-1',
  sessionId: 'session-1',
});

const flow = (): GoogleOAuthFlowRecord => ({
  id: 'a'.repeat(43),
  actor,
  redirectUri: 'https://emdo.example/api/v1/connectors/google/callback',
  purpose: 'calendar-read',
  requestedScopes: ['https://www.googleapis.com/auth/calendar.events.readonly'],
  credentialRevisionAtStart: null,
  authorizationEpochAtStart: 0,
  codeVerifier: 'b'.repeat(43),
  createdAt: new Date('2026-08-09T16:00:00.000Z'),
  expiresAt: new Date('2026-08-09T16:10:00.000Z'),
});

describe('InMemoryGoogleOAuthFlowStore', () => {
  it('atomically consumes a flow once for the exact authenticated actor', async () => {
    const store = new InMemoryGoogleOAuthFlowStore(
      () => new Date('2026-08-09T16:05:00.000Z'),
    );
    await expect(store.put(flow())).resolves.toBe(true);
    await expect(store.put(flow())).resolves.toBe(false);

    await expect(
      store.consume({
        id: 'a'.repeat(43),
        actor: { ...actor, userId: 'user-2' },
      }),
    ).resolves.toEqual({ status: 'binding-mismatch' });

    const consumed = await store.consume({ id: 'a'.repeat(43), actor });
    expect(consumed).toMatchObject({ status: 'consumed' });
    if (consumed.status !== 'consumed') throw new Error('expected flow');
    expect(consumed.flow.actor).toEqual(actor);
    expect(Object.isFrozen(consumed.flow)).toBe(true);
    expect(Object.isFrozen(consumed.flow.actor)).toBe(true);
    await expect(store.consume({ id: 'a'.repeat(43), actor })).resolves.toEqual(
      { status: 'missing' },
    );
  });

  it('consumes expired flows without returning their PKCE verifier', async () => {
    const store = new InMemoryGoogleOAuthFlowStore(
      () => new Date('2026-08-09T16:10:00.000Z'),
    );
    await store.put(flow());

    await expect(store.consume({ id: 'a'.repeat(43), actor })).resolves.toEqual(
      { status: 'expired' },
    );
    await expect(store.consume({ id: 'a'.repeat(43), actor })).resolves.toEqual(
      { status: 'missing' },
    );
  });

  it('invalidates every pending flow for the exact private grant actor', async () => {
    const store = new InMemoryGoogleOAuthFlowStore(
      () => new Date('2026-08-09T16:05:00.000Z'),
    );
    await store.put(flow());
    await store.put({
      ...flow(),
      id: 'c'.repeat(43),
      actor: { ...actor, sessionId: 'session-2' },
    });
    await store.put({
      ...flow(),
      id: 'd'.repeat(43),
      actor: { ...actor, userId: 'user-2' },
    });

    await expect(store.invalidateActor(actor)).resolves.toBe(2);
    await expect(store.consume({ id: 'a'.repeat(43), actor })).resolves.toEqual(
      { status: 'missing' },
    );
    await expect(
      store.consume({
        id: 'd'.repeat(43),
        actor: { ...actor, userId: 'user-2' },
      }),
    ).resolves.toMatchObject({ status: 'consumed' });
  });

  it('enforces the ten-minute lifetime and purpose-specific scope ceiling', async () => {
    const store = new InMemoryGoogleOAuthFlowStore(
      () => new Date('2026-08-09T16:05:00.000Z'),
    );
    await expect(
      store.put({
        ...flow(),
        expiresAt: new Date('2026-08-09T16:10:00.001Z'),
      }),
    ).rejects.toThrow(/ten minutes/);
    await expect(
      store.put({
        ...flow(),
        requestedScopes: ['https://www.googleapis.com/auth/calendar.events'],
      }),
    ).rejects.toThrow(/purpose/);
  });

  it('clones dates and rejects malformed, accessor-backed, or mutable record input', async () => {
    const store = new InMemoryGoogleOAuthFlowStore(
      () => new Date('2026-08-09T16:05:00.000Z'),
    );
    const candidate = flow();
    await store.put(candidate);
    candidate.expiresAt.setUTCFullYear(2035);
    const consumed = await store.consume({ id: candidate.id, actor });
    expect(consumed).toMatchObject({ status: 'consumed' });
    if (consumed.status !== 'consumed') throw new Error('expected flow');
    expect(consumed.flow.expiresAt.toISOString()).toBe(
      '2026-08-09T16:10:00.000Z',
    );

    const hostile = Object.defineProperty({}, 'id', {
      enumerable: true,
      get: () => {
        throw new Error('getter must not execute');
      },
    });
    await expect(store.put(hostile as never)).rejects.toThrow(/plain data/);
    await expect(
      store.consume({ id: '../not-a-state', actor }),
    ).rejects.toThrow();

    let dateMethodCalls = 0;
    class HostileDate extends Date {
      override getTime() {
        dateMethodCalls += 1;
        return super.getTime();
      }
    }
    await expect(
      store.put({
        ...flow(),
        createdAt: new HostileDate('2026-08-09T16:00:00.000Z'),
      }),
    ).rejects.toThrow(/plain data/);
    expect(dateMethodCalls).toBe(0);
  });
});
