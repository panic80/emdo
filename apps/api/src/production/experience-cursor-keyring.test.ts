import { describe, expect, it } from 'vitest';

import { parseProductionExperienceCursorKeyring } from './experience-cursor-keyring.js';

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const validKeyring = () => ({
  schemaVersion: 1 as const,
  current: {
    keyId: 'experience.current-1',
    keyB64url: Buffer.alloc(32, 17).toString('base64url'),
  },
  previous: [
    {
      keyId: 'experience.previous-1',
      keyB64url: Buffer.alloc(32, 23).toString('base64url'),
      issueUntil: '2026-08-12T12:00:00.000Z',
      verifyUntil: '2026-08-12T12:05:30.000Z',
    },
  ],
});

describe('production experience cursor HMAC keyring', () => {
  it('decodes only the strict versioned keyring with bounded distinct keys', () => {
    const parsed = parseProductionExperienceCursorKeyring(
      encode(validKeyring()),
    );

    expect(parsed.current).toMatchObject({
      keyId: 'experience.current-1',
      secret: expect.any(Uint8Array),
    });
    expect(parsed.current.secret).toHaveLength(32);
    expect(parsed.previous).toEqual([
      {
        keyId: 'experience.previous-1',
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
          keyB64url: Buffer.alloc(31, 17).toString('base64url'),
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
    ['unknown field', encode({ ...validKeyring(), unexpected: true })],
  ])('rejects a %s', (_name, encoded) => {
    expect(() => parseProductionExperienceCursorKeyring(encoded)).toThrow(
      'api-experience-cursor-keyring-invalid',
    );
  });
});
