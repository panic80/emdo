import { describe, expect, it } from 'vitest';

import { createProductionApprovalCheckpointCipher } from './approval-checkpoint-keyring.js';

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const encodeBytes = (value: Uint8Array): string =>
  Buffer.from(value).toString('base64url');

const key = (fill: number, length = 32): Buffer => Buffer.alloc(length, fill);

const validKeyring = () => ({
  schemaVersion: 1 as const,
  current: {
    keyId: 'checkpoint-current',
    keyB64url: encodeBytes(key(11)),
  },
  previous: [],
});

const aad = {
  formatVersion: 1 as const,
  checkpointId: '91000000-0000-4000-8000-000000000001',
  householdId: '91000000-0000-4000-8000-000000000002',
  userId: '91000000-0000-4000-8000-000000000003',
  runId: '91000000-0000-4000-8000-000000000004',
  agentGraphHash: 'a'.repeat(64),
  sdkVersion: '1.0.0',
  createdAt: '2026-08-15T14:00:00.000Z',
  expiresAt: '2026-08-15T14:10:00.000Z',
};

describe('production approval checkpoint keyring', () => {
  it('constructs a cipher that seals and opens with the current key', async () => {
    const cipher = createProductionApprovalCheckpointCipher(
      encode(validKeyring()),
    );

    const sealed = await cipher.seal('checkpoint-state', aad);

    await expect(cipher.open(sealed, aad)).resolves.toBe('checkpoint-state');
    expect(sealed.split('.')[1]).toBe('checkpoint-current');
    cipher.dispose();
  });

  it('opens a retained v1 ciphertext after rotation and seals new data with v2', async () => {
    const v1Key = key(21);
    const v2Key = key(22);
    const v1 = createProductionApprovalCheckpointCipher(
      encode({
        schemaVersion: 1,
        current: {
          keyId: 'checkpoint-v1',
          keyB64url: encodeBytes(v1Key),
        },
        previous: [],
      }),
    );
    const oldSealed = await v1.seal('old-state', aad);
    v1.dispose();

    const rotated = createProductionApprovalCheckpointCipher(
      encode({
        schemaVersion: 1,
        current: {
          keyId: 'checkpoint-v2',
          keyB64url: encodeBytes(v2Key),
        },
        previous: [
          {
            keyId: 'checkpoint-v1',
            keyB64url: encodeBytes(v1Key),
          },
        ],
      }),
    );

    await expect(rotated.open(oldSealed, aad)).resolves.toBe('old-state');
    const newSealed = await rotated.seal('new-state', aad);
    expect(newSealed.split('.')[1]).toBe('checkpoint-v2');
    await expect(rotated.open(newSealed, aad)).resolves.toBe('new-state');
    rotated.dispose();
  });

  it.each([
    ['empty envelope', ''],
    ['oversized envelope', 'A'.repeat(8_193)],
    ['padded envelope', `${encode(validKeyring())}=`],
    ['noncanonical envelope alphabet', `${encode(validKeyring())}+`],
    ['malformed JSON', encodeBytes(Buffer.from('{', 'utf8'))],
    [
      'unknown top-level field',
      encode({ ...validKeyring(), unexpected: true }),
    ],
    [
      'unknown current field',
      encode({
        ...validKeyring(),
        current: { ...validKeyring().current, unexpected: true },
      }),
    ],
    [
      'unknown previous field',
      encode({
        ...validKeyring(),
        previous: [
          {
            keyId: 'checkpoint-previous',
            keyB64url: encodeBytes(key(12)),
            unexpected: true,
          },
        ],
      }),
    ],
    [
      '31-byte key',
      encode({
        ...validKeyring(),
        current: {
          ...validKeyring().current,
          keyB64url: encodeBytes(key(11, 31)),
        },
      }),
    ],
    [
      '33-byte key',
      encode({
        ...validKeyring(),
        current: {
          ...validKeyring().current,
          keyB64url: encodeBytes(key(11, 33)),
        },
      }),
    ],
    [
      'padded key',
      encode({
        ...validKeyring(),
        current: {
          ...validKeyring().current,
          keyB64url: `${validKeyring().current.keyB64url}=`,
        },
      }),
    ],
    [
      'too many previous keys',
      encode({
        ...validKeyring(),
        previous: [
          {
            keyId: 'checkpoint-previous-1',
            keyB64url: encodeBytes(key(12)),
          },
          {
            keyId: 'checkpoint-previous-2',
            keyB64url: encodeBytes(key(13)),
          },
          {
            keyId: 'checkpoint-previous-3',
            keyB64url: encodeBytes(key(14)),
          },
        ],
      }),
    ],
    [
      'duplicate key id',
      encode({
        ...validKeyring(),
        previous: [
          {
            keyId: validKeyring().current.keyId,
            keyB64url: encodeBytes(key(12)),
          },
        ],
      }),
    ],
    [
      'duplicate key material',
      encode({
        ...validKeyring(),
        previous: [
          {
            keyId: 'checkpoint-previous',
            keyB64url: validKeyring().current.keyB64url,
          },
        ],
      }),
    ],
    [
      'invalid uppercase key id',
      encode({
        ...validKeyring(),
        current: { ...validKeyring().current, keyId: 'Checkpoint-current' },
      }),
    ],
    [
      'invalid key id segment',
      encode({
        ...validKeyring(),
        current: { ...validKeyring().current, keyId: 'checkpoint current' },
      }),
    ],
    [
      'key id too long',
      encode({
        ...validKeyring(),
        current: { ...validKeyring().current, keyId: 'c'.repeat(65) },
      }),
    ],
  ])('rejects %s with one generic error', (_name, encoded) => {
    expect(() => createProductionApprovalCheckpointCipher(encoded)).toThrow(
      'api-approval-checkpoint-keyring-invalid',
    );
  });

  it('rejects forbidden material reuse without retaining or mutating the caller buffer', async () => {
    const forbidden = key(11);
    const snapshot = Buffer.from(forbidden);

    expect(() =>
      createProductionApprovalCheckpointCipher(encode(validKeyring()), [
        forbidden,
      ]),
    ).toThrow('api-approval-checkpoint-keyring-invalid');
    expect(forbidden).toEqual(snapshot);

    const cipher = createProductionApprovalCheckpointCipher(
      encode({
        ...validKeyring(),
        current: {
          keyId: 'checkpoint-new',
          keyB64url: encodeBytes(key(12)),
        },
      }),
      [forbidden],
    );
    forbidden.fill(0);
    await expect(cipher.seal('still-works', aad)).resolves.toEqual(
      expect.any(String),
    );
    cipher.dispose();
  });

  it('fails closed after disposal', async () => {
    const cipher = createProductionApprovalCheckpointCipher(
      encode(validKeyring()),
    );
    const sealed = await cipher.seal('before-dispose', aad);
    cipher.dispose();

    await expect(cipher.seal('after-dispose', aad)).rejects.toThrow(
      'approval-checkpoint-keyring-disposed',
    );
    await expect(cipher.open(sealed, aad)).rejects.toThrow(
      'approval-checkpoint-keyring-disposed',
    );
  });
});
