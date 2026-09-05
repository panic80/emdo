import { describe, expect, it } from 'vitest';

import { createProductionFinanceDocumentKeyProvider } from './finance-document-keyring.js';

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

describe('finance document keyring', () => {
  it('loads a distinct current and bounded previous key set', async () => {
    const provider = createProductionFinanceDocumentKeyProvider(
      encode({
        schemaVersion: 1,
        current: {
          keyVersion: 'finance-documents.v2',
          keyB64url: Buffer.alloc(32, 2).toString('base64url'),
        },
        previous: [
          {
            keyVersion: 'finance-documents.v1',
            keyB64url: Buffer.alloc(32, 1).toString('base64url'),
          },
        ],
      }),
    );
    const wrapped = await provider.wrap(new Uint8Array(32).fill(9));
    expect(wrapped.keyVersion).toBe('finance-documents.v2');
    await expect(provider.unwrap(wrapped)).resolves.toEqual(
      Buffer.alloc(32, 9),
    );
    provider.dispose();
  });

  it('rejects malformed, duplicate, or forbidden key material', () => {
    const current = Buffer.alloc(32, 3);
    const keyring = {
      schemaVersion: 1,
      current: {
        keyVersion: 'finance-documents.v1',
        keyB64url: current.toString('base64url'),
      },
      previous: [],
    };
    expect(() => createProductionFinanceDocumentKeyProvider('invalid')).toThrow(
      'api-finance-document-keyring-invalid',
    );
    expect(() =>
      createProductionFinanceDocumentKeyProvider(encode(keyring), [current]),
    ).toThrow('api-finance-document-keyring-invalid');
    expect(() =>
      createProductionFinanceDocumentKeyProvider(
        encode({
          ...keyring,
          previous: [{ ...keyring.current }],
        }),
      ),
    ).toThrow('api-finance-document-keyring-invalid');
  });
});
