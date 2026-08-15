import { describe, expect, it } from 'vitest';

import { createProductionGoogleCalendarVaultKeyProvider } from './google-calendar-vault-keyring.js';

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const validKeyring = () => ({
  schemaVersion: 1 as const,
  current: {
    keyVersion: 'calendar-vault.current-2',
    keyB64url: Buffer.alloc(32, 23).toString('base64url'),
  },
  previous: [
    {
      keyVersion: 'calendar-vault.previous-1',
      keyB64url: Buffer.alloc(32, 19).toString('base64url'),
    },
  ],
});

describe('production Google Calendar vault keyring', () => {
  it('wraps with current, unwraps a retained version, and disposes provider-owned keys', async () => {
    const dataKey = Buffer.alloc(32, 7);
    const previous = createProductionGoogleCalendarVaultKeyProvider(
      encode({
        schemaVersion: 1,
        current: validKeyring().previous[0],
        previous: [],
      }),
    );
    const oldWrapped = await previous.wrap(dataKey);
    previous.dispose();

    const provider = createProductionGoogleCalendarVaultKeyProvider(
      encode(validKeyring()),
    );
    const newWrapped = await provider.wrap(dataKey);
    const unwrapped = await provider.unwrap(oldWrapped);

    expect(newWrapped.keyVersion).toBe('calendar-vault.current-2');
    expect(Buffer.from(unwrapped)).toEqual(dataKey);
    unwrapped.fill(0);
    provider.dispose();
    await expect(provider.unwrap(newWrapped)).rejects.toThrow(
      'Vault key provider unavailable',
    );
  });

  it.each([
    ['empty envelope', ''],
    ['oversized envelope', 'A'.repeat(8_193)],
    ['padded envelope', `${encode(validKeyring())}=`],
    [
      'short KEK',
      encode({
        ...validKeyring(),
        current: {
          ...validKeyring().current,
          keyB64url: Buffer.alloc(31, 23).toString('base64url'),
        },
      }),
    ],
    [
      'long KEK',
      encode({
        ...validKeyring(),
        current: {
          ...validKeyring().current,
          keyB64url: Buffer.alloc(33, 23).toString('base64url'),
        },
      }),
    ],
    [
      'padded KEK',
      encode({
        ...validKeyring(),
        current: {
          ...validKeyring().current,
          keyB64url: `${validKeyring().current.keyB64url}=`,
        },
      }),
    ],
    [
      'duplicate key version',
      encode({
        ...validKeyring(),
        previous: [
          {
            ...validKeyring().previous[0],
            keyVersion: validKeyring().current.keyVersion,
          },
        ],
      }),
    ],
    [
      'duplicate key material under distinct versions',
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
    [
      'too many previous keys',
      encode({
        ...validKeyring(),
        previous: [
          validKeyring().previous[0],
          {
            keyVersion: 'calendar-vault.previous-2',
            keyB64url: Buffer.alloc(32, 29).toString('base64url'),
          },
          {
            keyVersion: 'calendar-vault.previous-3',
            keyB64url: Buffer.alloc(32, 31).toString('base64url'),
          },
        ],
      }),
    ],
    [
      'noncanonical key version',
      encode({
        ...validKeyring(),
        current: { ...validKeyring().current, keyVersion: ' Calendar V2 ' },
      }),
    ],
    ['unknown field', encode({ ...validKeyring(), unexpected: true })],
    ['malformed JSON', Buffer.from('{', 'utf8').toString('base64url')],
  ])('rejects a %s with one generic error', (_name, encoded) => {
    expect(() =>
      createProductionGoogleCalendarVaultKeyProvider(encoded),
    ).toThrow('api-google-calendar-vault-keyring-invalid');
  });

  it('rejects vault material reused as another Google connector secret', () => {
    const stateSigningKey = Buffer.alloc(32, 23);
    expect(() =>
      createProductionGoogleCalendarVaultKeyProvider(encode(validKeyring()), [
        stateSigningKey,
      ]),
    ).toThrow('api-google-calendar-vault-keyring-invalid');
    expect(stateSigningKey).toEqual(Buffer.alloc(32, 23));
  });
});
