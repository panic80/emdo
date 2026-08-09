import { describe, expect, it } from 'vitest';

import { InMemoryVaultKeyProvider, VaultCrypto } from './crypto.js';

const scope = {
  householdId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f001',
  spaceId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f002',
  recordId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f003',
};

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
      crypto.decrypt(
        { ...encrypted, ciphertext: flipBase64Byte(encrypted.ciphertext) },
        scope,
      ),
    ).rejects.toThrow();
  });
});

const cryptoRandomId = () => '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004';

const flipBase64Byte = (value: string) => {
  const bytes = Buffer.from(value, 'base64url');
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return bytes.toString('base64url');
};
