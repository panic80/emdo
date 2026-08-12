import { describe, expect, it } from 'vitest';

import { parseProductionProposalCursorKeyring } from './proposal-cursor-keyring.js';

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const validKeyring = () => ({
  schemaVersion: 1 as const,
  current: {
    keyId: 'proposal.current-1',
    keyB64url: Buffer.alloc(32, 37).toString('base64url'),
  },
  previous: [
    {
      keyId: 'proposal.previous-1',
      keyB64url: Buffer.alloc(32, 41).toString('base64url'),
      issueUntil: '2026-08-12T12:00:00.000Z',
      verifyUntil: '2026-08-12T12:05:30.000Z',
    },
  ],
});

describe('production proposal cursor HMAC keyring', () => {
  it('decodes only the strict versioned keyring with bounded distinct keys', () => {
    const parsed = parseProductionProposalCursorKeyring(encode(validKeyring()));

    expect(parsed.current).toMatchObject({
      keyId: 'proposal.current-1',
      secret: expect.any(Uint8Array),
    });
    expect(parsed.current.secret).toHaveLength(32);
    expect(parsed.previous).toEqual([
      {
        keyId: 'proposal.previous-1',
        secret: expect.any(Uint8Array),
        issueUntil: '2026-08-12T12:00:00.000Z',
        verifyUntil: '2026-08-12T12:05:30.000Z',
      },
    ]);
  });

  it.each([
    ['padded envelope', `${encode(validKeyring())}=`],
    [
      'short key',
      encode({
        ...validKeyring(),
        current: {
          ...validKeyring().current,
          keyB64url: Buffer.alloc(31, 37).toString('base64url'),
        },
      }),
    ],
    [
      'duplicate key id',
      encode({
        ...validKeyring(),
        previous: [
          {
            ...validKeyring().previous[0],
            keyId: validKeyring().current.keyId,
          },
        ],
      }),
    ],
    [
      'duplicate key material under distinct ids',
      encode({
        ...validKeyring(),
        previous: [
          {
            ...validKeyring().previous[0],
            keyB64url: validKeyring().current.keyB64url,
          },
        ],
      }),
    ],
    ['unknown field', encode({ ...validKeyring(), unexpected: true })],
  ])('rejects a %s', (_name, encoded) => {
    expect(() => parseProductionProposalCursorKeyring(encoded)).toThrow(
      'api-proposal-cursor-keyring-invalid',
    );
  });
});
