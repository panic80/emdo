import { describe, expect, it } from 'vitest';

import {
  InMemoryVaultKeyProvider,
  RotatingVaultKeyProvider,
  VaultCrypto,
} from './crypto.js';

const scope = {
  householdId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
  spaceId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002',
  recordId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003',
  provider: 'google',
  grantType: 'calendar-authorization',
} as const;

describe('VaultCrypto', () => {
  it('round trips envelope encryption without storing plaintext and binds scope as AAD', async () => {
    const crypto = new VaultCrypto(
      new InMemoryVaultKeyProvider(Buffer.alloc(32, 9), 'test-key-v1'),
    );
    const encrypted = await crypto.encrypt('refresh-token-secret', scope);

    expect(JSON.stringify(encrypted)).not.toContain('refresh-token-secret');
    await expect(crypto.decrypt(encrypted, scope)).resolves.toBe(
      'refresh-token-secret',
    );
    await expect(
      crypto.decrypt(encrypted, { ...scope, spaceId: cryptoRandomId() }),
    ).rejects.toThrow();
    await expect(
      crypto.decrypt(encrypted, {
        ...scope,
        grantType: 'identity-sign-in',
      }),
    ).rejects.toThrow();
    await expect(
      crypto.decrypt(
        { ...encrypted, ciphertext: flipBase64Byte(encrypted.ciphertext) },
        scope,
      ),
    ).rejects.toThrow();
    await expect(
      crypto.decrypt(
        {
          ...encrypted,
          authenticationTag: truncateTag(encrypted.authenticationTag),
        },
        scope,
      ),
    ).rejects.toThrow(/authentication tag.*length/i);
  });

  it('erases the exact unwrapped data-key buffer after decryption', async () => {
    const wrappedKey = Buffer.alloc(32, 4);
    const provider = {
      wrap: async () => ({ wrappedKey: 'wrapped', keyVersion: 'v1' }),
      unwrap: async () => wrappedKey,
    };
    const encryptor = new VaultCrypto(
      new InMemoryVaultKeyProvider(Buffer.alloc(32, 9), 'test-key-v1'),
    );
    const encrypted = await encryptor.encrypt('secret', scope);
    const inMemoryProvider = new InMemoryVaultKeyProvider(
      Buffer.alloc(32, 9),
      'test-key-v1',
    );
    const actualKey = await inMemoryProvider.unwrap({
      wrappedKey: encrypted.wrappedKey,
      keyVersion: encrypted.keyVersion,
    });
    provider.unwrap = async () => {
      wrappedKey.set(actualKey);
      return wrappedKey;
    };

    await expect(
      new VaultCrypto(provider).decrypt(encrypted, scope),
    ).resolves.toBe('secret');
    expect(wrappedKey.every((byte) => byte === 0)).toBe(true);
    actualKey.fill(0);
  });

  it('rejects malformed or incomplete scopes at runtime', async () => {
    const crypto = new VaultCrypto(
      new InMemoryVaultKeyProvider(Buffer.alloc(32, 9), 'test-key-v1'),
    );
    await expect(
      crypto.encrypt('secret', { ...scope, provider: '' }),
    ).rejects.toThrow();
    await expect(
      crypto.encrypt('secret', {
        householdId: scope.householdId,
        spaceId: scope.spaceId,
        recordId: scope.recordId,
        provider: scope.provider,
      } as never),
    ).rejects.toThrow();
    await expect(
      crypto.encrypt('secret', { ...scope, grantType: 'oauth' } as never),
    ).rejects.toThrow();
  });

  it('wraps only with the current KEK and unwraps an exact retained version', async () => {
    const original = new VaultCrypto(
      new RotatingVaultKeyProvider({
        current: {
          keyVersion: 'calendar-vault.v1',
          key: Buffer.alloc(32, 11),
        },
      }),
    );
    const oldEnvelope = await original.encrypt('old-secret', scope);
    const rotated = new VaultCrypto(
      new RotatingVaultKeyProvider({
        current: {
          keyVersion: 'calendar-vault.v2',
          key: Buffer.alloc(32, 12),
        },
        previous: [
          {
            keyVersion: 'calendar-vault.v1',
            key: Buffer.alloc(32, 11),
          },
        ],
      }),
    );

    const newEnvelope = await rotated.encrypt('new-secret', scope);

    expect(oldEnvelope.keyVersion).toBe('calendar-vault.v1');
    expect(newEnvelope.keyVersion).toBe('calendar-vault.v2');
    await expect(rotated.decrypt(oldEnvelope, scope)).resolves.toBe(
      'old-secret',
    );
    await expect(rotated.decrypt(newEnvelope, scope)).resolves.toBe(
      'new-secret',
    );
    await expect(
      rotated.decrypt(
        { ...oldEnvelope, keyVersion: 'calendar-vault.unknown' },
        scope,
      ),
    ).rejects.toThrow('Vault key provider unavailable');
  });

  it('uses exact key versions, owns copied KEKs, and fails closed after disposal', async () => {
    const supplied = Buffer.alloc(32, 17);
    const provider = new RotatingVaultKeyProvider({
      current: { keyVersion: 'calendar-vault.current-1', key: supplied },
    });
    supplied.fill(0);
    const crypto = new VaultCrypto(provider);
    const encrypted = await crypto.encrypt('secret', scope);
    await expect(crypto.decrypt(encrypted, scope)).resolves.toBe('secret');

    provider.dispose();

    await expect(crypto.encrypt('next-secret', scope)).rejects.toThrow(
      'Vault key provider unavailable',
    );
    await expect(crypto.decrypt(encrypted, scope)).rejects.toThrow(
      'Vault key provider unavailable',
    );
    expect(
      () => new InMemoryVaultKeyProvider(Buffer.alloc(32, 9), 'test-key-v1 '),
    ).toThrow('Vault key provider unavailable');
  });
});

const cryptoRandomId = () => '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004';

const flipBase64Byte = (value: string) => {
  const bytes = Buffer.from(value, 'base64url');
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return bytes.toString('base64url');
};

const truncateTag = (value: string) =>
  Buffer.from(value, 'base64url').subarray(0, 4).toString('base64url');
