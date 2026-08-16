import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseProductionSyncJwtKeyring } from './sync-keyring.js';

const keyPair = (modulusLength = 2_048) => {
  const pair = generateKeyPairSync('rsa', { modulusLength });
  return {
    privatePkcs8DerB64url: pair.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64url'),
    publicSpkiDerB64url: pair.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64url'),
  };
};

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const current = keyPair();
const previous = keyPair();
const retiredAt = '2026-08-10T12:00:00.000Z';
const verifyUntil = '2026-08-10T12:05:05.000Z';

const validKeyring = () => ({
  schemaVersion: 1,
  current: {
    kid: 'sync.current-1',
    privatePkcs8DerB64url: current.privatePkcs8DerB64url,
  },
  previous: [
    {
      kid: 'sync.previous-1',
      publicSpkiDerB64url: previous.publicSpkiDerB64url,
      retiredAt,
      verifyUntil,
    },
  ],
});

describe('production sync JWT key ring', () => {
  it('loads one signing key and still-valid prior verification keys', () => {
    const parsed = parseProductionSyncJwtKeyring(encode(validKeyring()), {
      now: () => new Date('2026-08-10T12:05:04.999Z'),
    });

    expect(parsed.current.kid).toBe('sync.current-1');
    expect(parsed.current.privateKey.type).toBe('private');
    expect(parsed.previous).toMatchObject([
      {
        kid: 'sync.previous-1',
        retiredAt,
        verifyUntil,
      },
    ]);
    expect(Object.keys(parsed).sort()).toEqual(['current', 'previous']);
    expect(parsed).not.toHaveProperty('verificationKeys');
  });

  it.each([
    ['padded outer base64url', () => `${encode(validKeyring())}=`],
    [
      'unknown JSON field',
      () => encode({ ...validKeyring(), rawPem: 'must-not-be-accepted' }),
    ],
    [
      'duplicate key ID',
      () =>
        encode({
          ...validKeyring(),
          previous: [{ ...validKeyring().previous[0], kid: 'sync.current-1' }],
        }),
    ],
    [
      'noncanonical current DER base64url',
      () =>
        encode({
          ...validKeyring(),
          current: {
            ...validKeyring().current,
            privatePkcs8DerB64url: `${current.privatePkcs8DerB64url}=`,
          },
        }),
    ],
    [
      'weak current RSA key',
      () => {
        const weak = keyPair(1_024);
        return encode({
          ...validKeyring(),
          current: {
            kid: 'sync.current-1',
            privatePkcs8DerB64url: weak.privatePkcs8DerB64url,
          },
        });
      },
    ],
    [
      'more than two prior keys',
      () =>
        encode({
          ...validKeyring(),
          previous: [
            validKeyring().previous[0],
            { ...validKeyring().previous[0], kid: 'sync.previous-2' },
            { ...validKeyring().previous[0], kid: 'sync.previous-3' },
          ],
        }),
    ],
  ])('rejects %s without exposing configuration', (_label, encoded) => {
    expect(() =>
      parseProductionSyncJwtKeyring(encoded(), {
        now: () => new Date('2026-08-10T12:01:00.000Z'),
      }),
    ).toThrow('api-sync-keyring-invalid');
  });

  it('enforces retirement grace and the exact startup boundary', () => {
    const insufficientGrace = validKeyring();
    insufficientGrace.previous[0]!.verifyUntil = '2026-08-10T12:05:04.999Z';
    expect(() =>
      parseProductionSyncJwtKeyring(encode(insufficientGrace), {
        now: () => new Date('2026-08-10T12:01:00.000Z'),
      }),
    ).toThrow('api-sync-keyring-invalid');

    expect(() =>
      parseProductionSyncJwtKeyring(encode(validKeyring()), {
        now: () => new Date(verifyUntil),
      }),
    ).toThrow('api-sync-keyring-invalid');

    expect(() =>
      parseProductionSyncJwtKeyring(encode(validKeyring()), {
        now: () => new Date('2026-08-10T11:59:59.999Z'),
      }),
    ).toThrow('api-sync-keyring-invalid');
  });

  it('rejects calendar-normalized instants that are not exact UTC timestamps', () => {
    const impossibleRetirement = validKeyring();
    impossibleRetirement.previous[0]!.retiredAt = '2026-02-31T12:00:00.000Z';
    impossibleRetirement.previous[0]!.verifyUntil = '2026-03-03T12:05:05.000Z';

    expect(() =>
      parseProductionSyncJwtKeyring(encode(impossibleRetirement), {
        now: () => new Date('2026-03-03T12:01:00.000Z'),
      }),
    ).toThrow('api-sync-keyring-invalid');
  });
});
