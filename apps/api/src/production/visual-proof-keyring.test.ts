import { describe, expect, it } from 'vitest';

import { createProductionVisualProofTokenCodec } from './visual-proof-keyring.js';

const now = new Date('2026-08-13T12:00:00.000Z');

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const validKeyring = () => ({
  schemaVersion: 1 as const,
  current: {
    keyId: 'visual.current-2',
    keyB64url: Buffer.alloc(32, 61).toString('base64url'),
  },
  previous: [
    {
      keyId: 'visual.previous-1',
      keyB64url: Buffer.alloc(32, 62).toString('base64url'),
      issueUntil: '2026-08-13T12:00:00.000Z',
      verifyUntil: '2026-08-13T12:02:30.000Z',
    },
  ],
});

const binding = {
  bindingVersion: 1,
  issuanceFingerprint: 'a'.repeat(64),
  authorizationScopeFingerprint: 'b'.repeat(64),
  initialRequestId: '95000000-0000-4000-8000-000000000001',
  issuedAt: '2026-08-13T12:00:00.000Z',
  expiresAt: '2026-08-13T12:02:00.000Z',
  userId: '95000000-0000-4000-8000-000000000002',
  sessionId: '95000000-0000-4000-8000-000000000003',
  householdId: '95000000-0000-4000-8000-000000000004',
  proposalId: '95000000-0000-4000-8000-000000000005',
  proposalVersion: 1,
  payloadHash: 'c'.repeat(64),
  approvalHash: 'd'.repeat(64),
  channel: 'authenticated-visual' as const,
  idempotencyKey: 'visual-proof:proposal:calendar-write',
};

describe('production visual proof HMAC keyring', () => {
  it('constructs the proof codec only from a strict versioned keyring', () => {
    const codec = createProductionVisualProofTokenCodec(
      encode(validKeyring()),
      { clock: () => now },
    );

    expect(codec.create(binding)).toMatchObject({
      keyId: 'visual.current-2',
      proofToken: expect.stringMatching(/^[A-Za-z0-9_-]{32,512}$/u),
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it.each([
    ['padded envelope', `${encode(validKeyring())}=`],
    [
      'short key',
      encode({
        ...validKeyring(),
        current: {
          ...validKeyring().current,
          keyB64url: Buffer.alloc(31, 61).toString('base64url'),
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
    [
      'prior key without the full proof drain window',
      encode({
        ...validKeyring(),
        previous: [
          {
            ...validKeyring().previous[0],
            verifyUntil: '2026-08-13T12:02:29.999Z',
          },
        ],
      }),
    ],
    [
      'already retired prior key',
      encode({
        ...validKeyring(),
        previous: [
          {
            ...validKeyring().previous[0],
            issueUntil: '2026-08-13T11:57:30.000Z',
            verifyUntil: '2026-08-13T12:00:00.000Z',
          },
        ],
      }),
    ],
    ['unknown field', encode({ ...validKeyring(), unexpected: true })],
  ])('rejects a %s', (_name, encoded) => {
    expect(() =>
      createProductionVisualProofTokenCodec(encoded, { clock: () => now }),
    ).toThrow('api-visual-proof-keyring-invalid');
  });
});
