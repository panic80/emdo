import { describe, expect, it } from 'vitest';

import { InMemoryVaultKeyProvider, VaultCrypto } from './crypto.js';
import { InMemoryVaultRepository } from './repository.js';

const scope = {
  householdId: 'household-1',
  spaceId: 'space-1',
  recordId: 'google-calendar-credential',
  provider: 'google',
  grantType: 'calendar-authorization',
} as const;

describe('InMemoryVaultRepository', () => {
  it('requires the record owner and prevents ownership reassignment', async () => {
    const repository = new InMemoryVaultRepository();
    const crypto = new VaultCrypto(
      new InMemoryVaultKeyProvider(Buffer.alloc(32, 5), 'test-key-v1'),
    );
    const payload = await crypto.encrypt('refresh-token', scope);
    await repository.put({
      scope,
      ownerUserId: 'user-1',
      payload,
      createdAt: new Date('2026-08-09T16:00:00.000Z'),
    });

    await expect(repository.get(scope, 'user-2')).resolves.toBeUndefined();
    await expect(repository.get(scope, 'user-1')).resolves.toMatchObject({
      ownerUserId: 'user-1',
    });
    await expect(
      repository.put({
        scope,
        ownerUserId: 'user-2',
        payload,
        createdAt: new Date('2026-08-09T16:01:00.000Z'),
      }),
    ).rejects.toThrow(/ownership/);

    const identityScope = {
      ...scope,
      grantType: 'identity-sign-in',
    } as const;
    const identityPayload = await crypto.encrypt(
      'identity-token',
      identityScope,
    );
    await repository.put({
      scope: identityScope,
      ownerUserId: 'user-1',
      payload: identityPayload,
      createdAt: new Date('2026-08-09T16:02:00.000Z'),
    });
    await expect(repository.get(scope, 'user-1')).resolves.toMatchObject({
      scope: { grantType: 'calendar-authorization' },
    });
    await expect(
      repository.get(identityScope, 'user-1'),
    ).resolves.toMatchObject({
      scope: { grantType: 'identity-sign-in' },
    });
    await expect(
      repository.get({ ...scope, grantType: undefined } as never, 'user-1'),
    ).rejects.toThrow();
    await expect(
      repository.put({
        scope,
        ownerUserId: '',
        payload: { plaintext: 'secret' },
        createdAt: new Date(Number.NaN),
      } as never),
    ).rejects.toThrow();
  });
});
