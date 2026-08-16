import { describe, expect, it } from 'vitest';

import { InMemoryVaultKeyProvider, VaultCrypto } from '../../vault/crypto.js';
import {
  GOOGLE_CALENDAR_SCOPES,
  type GoogleCalendarCredential,
} from './service.js';
import {
  EncryptedGoogleCalendarCredentialVault,
  type EncryptedGoogleCalendarGrantRecord,
  type EncryptedGoogleCalendarGrantStore,
} from './vault.js';

const actor = Object.freeze({
  userId: 'user-1',
  householdId: 'household-1',
  privateSpaceId: 'private-space-1',
  sessionId: 'session-1',
});

const credential = (suffix = 'one'): GoogleCalendarCredential => ({
  schemaVersion: 1,
  grantReference: `gcal-grant-reference-${suffix}`,
  accessToken: `access-token-sensitive-${suffix}`,
  refreshToken: `refresh-token-sensitive-${suffix}`,
  tokenType: 'Bearer',
  scopes: [
    GOOGLE_CALENDAR_SCOPES.calendarListReadonly,
    GOOGLE_CALENDAR_SCOPES.eventsReadonly,
    GOOGLE_CALENDAR_SCOPES.freeBusy,
  ],
  expiresAt: '2026-08-09T17:00:00.000Z',
  connectedAt: '2026-08-09T16:00:00.000Z',
  updatedAt: '2026-08-09T16:00:00.000Z',
});

const exactKey = (record: {
  readonly scope: EncryptedGoogleCalendarGrantRecord['scope'];
  readonly ownerUserId: string;
}) =>
  JSON.stringify([
    record.scope.householdId,
    record.scope.spaceId,
    record.scope.recordId,
    record.scope.provider,
    record.scope.grantType,
    record.ownerUserId,
  ]);

class RecordingEncryptedStore implements EncryptedGoogleCalendarGrantStore {
  readonly records = new Map<string, EncryptedGoogleCalendarGrantRecord>();

  async load(input: {
    readonly scope: EncryptedGoogleCalendarGrantRecord['scope'];
    readonly ownerUserId: string;
  }) {
    return this.records.get(exactKey(input));
  }

  async compareAndSet(input: {
    readonly scope: EncryptedGoogleCalendarGrantRecord['scope'];
    readonly ownerUserId: string;
    readonly expectedRevision: number | null;
    readonly authorizationEpoch: number;
    readonly providerGrantReference: string;
    readonly payload: EncryptedGoogleCalendarGrantRecord['payload'];
    readonly now: Date;
  }) {
    const key = exactKey(input);
    const current = this.records.get(key);
    if ((current?.revision ?? null) !== input.expectedRevision) {
      return { status: 'conflict' as const };
    }
    const revision = (current?.revision ?? 0) + 1;
    this.records.set(key, {
      scope: input.scope,
      ownerUserId: input.ownerUserId,
      revision,
      authorizationEpoch: input.authorizationEpoch,
      providerGrantReference: input.providerGrantReference,
      payload: input.payload,
      createdAt: current?.createdAt ?? new Date(input.now),
      updatedAt: new Date(input.now),
    });
    return { status: 'stored' as const, revision };
  }

  async delete(input: {
    readonly scope: EncryptedGoogleCalendarGrantRecord['scope'];
    readonly ownerUserId: string;
    readonly expectedRevision: number;
  }) {
    const key = exactKey(input);
    const current = this.records.get(key);
    if (current?.revision !== input.expectedRevision) return false;
    return this.records.delete(key);
  }
}

const createVault = () => {
  const store = new RecordingEncryptedStore();
  const vault = new EncryptedGoogleCalendarCredentialVault({
    crypto: new VaultCrypto(
      new InMemoryVaultKeyProvider(Buffer.alloc(32, 12), 'oauth-test-key-v1'),
    ),
    store,
    clock: () => new Date('2026-08-09T16:00:00.000Z'),
  });
  return { store, vault };
};

describe('EncryptedGoogleCalendarCredentialVault', () => {
  it('stores token material only as ciphertext under the typed Calendar grant scope', async () => {
    const { store, vault } = createVault();

    await expect(
      vault.compareAndSet({
        actor,
        expectedRevision: null,
        authorizationEpoch: 0,
        credential: credential(),
      }),
    ).resolves.toEqual({ status: 'stored', revision: 1 });

    const record = [...store.records.values()][0];
    expect(record).toMatchObject({
      ownerUserId: actor.userId,
      revision: 1,
      authorizationEpoch: 0,
      providerGrantReference: credential().grantReference,
      scope: {
        householdId: actor.householdId,
        spaceId: actor.privateSpaceId,
        provider: 'google',
        grantType: 'calendar-authorization',
      },
    });
    expect(record?.scope.recordId).toMatch(/^google-calendar-oauth-v1-/);
    const serializedRecord = JSON.stringify(record);
    expect(serializedRecord).not.toMatch(
      /access-token-sensitive|refresh-token-sensitive/,
    );
    await expect(vault.load(actor)).resolves.toEqual({
      revision: 1,
      authorizationEpoch: 0,
      credential: credential(),
    });

    store.records.set(exactKey(record!), {
      ...record!,
      authorizationEpoch: 1,
    });
    await expect(vault.load(actor)).rejects.toThrow(/epoch mismatch/);

    store.records.set(exactKey(record!), {
      ...record!,
      providerGrantReference: credential('different').grantReference,
    });
    await expect(vault.load(actor)).rejects.toThrow(/reference mismatch/);
  });

  it('uses revision CAS and exact owner, household, and private-space scope', async () => {
    const { vault } = createVault();
    await vault.compareAndSet({
      actor,
      expectedRevision: null,
      authorizationEpoch: 0,
      credential: credential(),
    });

    await expect(
      vault.compareAndSet({
        actor,
        expectedRevision: null,
        authorizationEpoch: 0,
        credential: credential('stale'),
      }),
    ).resolves.toEqual({ status: 'conflict' });
    await expect(
      vault.load({ ...actor, userId: 'user-2' }),
    ).resolves.toBeUndefined();
    await expect(
      vault.load({ ...actor, householdId: 'household-2' }),
    ).resolves.toBeUndefined();
    await expect(
      vault.load({ ...actor, privateSpaceId: 'shared-space-1' }),
    ).resolves.toBeUndefined();
    await expect(vault.delete({ actor, expectedRevision: 2 })).resolves.toBe(
      false,
    );
    await expect(vault.delete({ actor, expectedRevision: 1 })).resolves.toBe(
      true,
    );
  });

  it('fails closed when a record is moved to an identity scope or its ciphertext is tampered', async () => {
    const { store, vault } = createVault();
    await vault.compareAndSet({
      actor,
      expectedRevision: null,
      authorizationEpoch: 0,
      credential: credential(),
    });
    const original = [...store.records.values()][0]!;
    store.records.clear();
    const identityRecord = {
      ...original,
      scope: { ...original.scope, grantType: 'identity-sign-in' as const },
    };
    store.records.set(exactKey(identityRecord), identityRecord as never);
    await expect(vault.load(actor)).resolves.toBeUndefined();

    store.records.clear();
    const tampered = {
      ...original,
      payload: {
        ...original.payload,
        ciphertext: `${original.payload.ciphertext.slice(0, -1)}${
          original.payload.ciphertext.endsWith('A') ? 'B' : 'A'
        }`,
      },
    };
    store.records.set(exactKey(tampered), tampered);
    await expect(vault.load(actor)).rejects.toThrow();
  });
});
