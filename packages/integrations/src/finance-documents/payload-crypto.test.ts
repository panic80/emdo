import { describe, expect, it } from 'vitest';

import { InMemoryVaultKeyProvider } from '../vault/crypto.js';
import { FinanceDocumentPayloadCrypto } from './payload-crypto.js';

const scope = {
  householdId: '018f1f5e-2000-7000-8000-000000000001',
  privateSpaceId: '018f1f5e-2000-7000-8000-000000000002',
  ownerUserId: '018f1f5e-2000-7000-8000-000000000003',
  documentId: '018f1f5e-2000-7000-8000-000000000004',
  extractionRevision: 1,
  purpose: 'unreviewed-extraction' as const,
};

describe('FinanceDocumentPayloadCrypto', () => {
  it('round trips JSON under exact document/revision AAD', async () => {
    const provider = new InMemoryVaultKeyProvider(
      new Uint8Array(32).fill(7),
      'finance-documents.v1',
    );
    const crypto = new FinanceDocumentPayloadCrypto(provider);
    const encrypted = await crypto.encrypt(
      { hidden: 'full identifier' },
      scope,
    );

    await expect(crypto.decrypt(encrypted, scope)).resolves.toEqual({
      hidden: 'full identifier',
    });
    await expect(
      crypto.decrypt(encrypted, { ...scope, extractionRevision: 2 }),
    ).rejects.toThrow('finance-document-payload-crypto-unavailable');
  });

  it('rejects tampering and non-JSON values without exposing payloads', async () => {
    const provider = new InMemoryVaultKeyProvider(
      new Uint8Array(32).fill(8),
      'finance-documents.v1',
    );
    const crypto = new FinanceDocumentPayloadCrypto(provider);
    const encrypted = await crypto.encrypt({ fact: 'safe' }, scope);
    await expect(
      crypto.decrypt(
        { ...encrypted, ciphertext: `${encrypted.ciphertext}A` },
        scope,
      ),
    ).rejects.toThrow('finance-document-payload-crypto-unavailable');
    await expect(crypto.encrypt(new Map(), scope)).rejects.toThrow();
  });
});
