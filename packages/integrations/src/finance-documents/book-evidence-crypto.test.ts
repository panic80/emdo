import { describe, expect, it } from 'vitest';
import { InMemoryVaultKeyProvider } from '../vault/crypto.js';
import { FinanceBookEvidenceCrypto } from './book-evidence-crypto.js';
const scope = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  bookId: '00000000-0000-4000-8000-000000000002',
  documentId: '00000000-0000-4000-8000-000000000003',
};
describe('book evidence encryption', () => {
  it('authenticates workspace, book, and document identity', async () => {
    const crypto = new FinanceBookEvidenceCrypto(
      new InMemoryVaultKeyProvider(
        new Uint8Array(32).fill(8),
        'finance-documents.v1',
      ),
    );
    const original = {
      sourceText: 'Date,Private account,Amount\n2026-01-01,secret,10',
    };
    const encrypted = await crypto.encrypt(original, scope);
    expect(JSON.stringify(encrypted)).not.toContain('secret');
    expect(await crypto.decrypt(encrypted, scope)).toEqual(original);
    for (const field of ['workspaceId', 'bookId', 'documentId'] as const) {
      await expect(
        crypto.decrypt(encrypted, {
          ...scope,
          [field]: '00000000-0000-4000-8000-000000000099',
        }),
      ).rejects.toThrow('crypto-unavailable');
    }
    await expect(
      crypto.decrypt(
        { ...encrypted, ciphertext: encrypted.ciphertext + 'A' },
        scope,
      ),
    ).rejects.toThrow();
  });
});
