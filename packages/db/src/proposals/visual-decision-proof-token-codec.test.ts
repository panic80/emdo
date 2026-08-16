import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  VisualDecisionProofTokenCodec,
  VisualDecisionProofTokenCodecError,
  type VisualDecisionProofTokenBinding,
  type VisualDecisionProofHmacKey,
  type VisualDecisionProofPreviousHmacKey,
} from './visual-decision-proof-token-codec.js';

const ids = {
  user: '95000000-0000-4000-8000-000000000001',
  session: '95000000-0000-4000-8000-000000000002',
  household: '95000000-0000-4000-8000-000000000003',
  spaceGrant: '95000000-0000-4000-8000-000000000004',
  proposal: '95000000-0000-4000-8000-000000000005',
  proof: '95000000-0000-4000-8000-000000000006',
} as const;

const now = new Date('2026-08-10T14:00:00.000Z');
const currentKey: VisualDecisionProofHmacKey = {
  keyId: 'visual-proof-2026-08-b',
  secret: new Uint8Array(32).fill(2),
};
const previousKey: VisualDecisionProofPreviousHmacKey = {
  keyId: 'visual-proof-2026-08-a',
  secret: new Uint8Array(32).fill(1),
  issueUntil: '2026-08-10T14:00:00.000Z',
  verifyUntil: '2026-08-10T14:02:30.000Z',
};
const binding = {
  bindingVersion: 1 as const,
  issuanceFingerprint: 'c'.repeat(64),
  authorizationScopeFingerprint: 'd'.repeat(64),
  initialRequestId: '95000000-0000-4000-8000-000000000007',
  issuedAt: '2026-08-10T14:00:00.000Z',
  expiresAt: '2026-08-10T14:02:00.000Z',
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  proposalId: ids.proposal,
  proposalVersion: 4,
  payloadHash: 'a'.repeat(64),
  approvalHash: 'b'.repeat(64),
  channel: 'authenticated-visual' as const,
  idempotencyKey: 'visual-proof:proposal:calendar-create',
};

const codec = (
  overrides: {
    current?: VisualDecisionProofHmacKey;
    previous?: readonly VisualDecisionProofPreviousHmacKey[];
    clock?: () => Date;
    proofId?: string;
    nonce?: string;
  } = {},
) =>
  new VisualDecisionProofTokenCodec({
    current: overrides.current ?? currentKey,
    previous: overrides.previous ?? [previousKey],
    clock: overrides.clock ?? (() => now),
    generateProofId: () => overrides.proofId ?? ids.proof,
    generateNonce: () => overrides.nonce ?? 'N'.repeat(43),
  });

describe('VisualDecisionProofTokenCodec', () => {
  it('derives a base64url bearer token from the versioned key, opaque seed, and exact binding', () => {
    const material = codec().create(binding);

    expect(material).toMatchObject({
      proofId: ids.proof,
      nonce: 'N'.repeat(43),
      keyId: currentKey.keyId,
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      proofToken: expect.stringMatching(/^[A-Za-z0-9_-]{32,512}$/u),
    });
    const decoded = JSON.parse(
      Buffer.from(material.proofToken, 'base64url').toString('utf8'),
    ) as readonly unknown[];
    expect(decoded.slice(0, 4)).toEqual([
      1,
      currentKey.keyId,
      ids.proof,
      'N'.repeat(43),
    ]);
    expect(decoded).toHaveLength(5);
    const decodedText = JSON.stringify(decoded);
    for (const forbidden of [
      binding.issuanceFingerprint,
      binding.authorizationScopeFingerprint,
      binding.initialRequestId,
      binding.issuedAt,
      binding.expiresAt,
      binding.userId,
      binding.sessionId,
      binding.householdId,
      binding.proposalId,
      binding.payloadHash,
      binding.approvalHash,
      binding.channel,
      binding.idempotencyKey,
    ]) {
      expect(decodedText).not.toContain(forbidden);
    }
  });

  it('reproduces the byte-identical token and verifies its stored digest in constant-time form', () => {
    const issuer = codec();
    const material = issuer.create(binding);

    expect(
      issuer.reproduce(
        {
          proofId: material.proofId,
          nonce: material.nonce,
          keyId: material.keyId,
          tokenHash: material.tokenHash,
        },
        binding,
      ),
    ).toBe(material.proofToken);
    expect(
      issuer.create({ ...binding, proposalVersion: 5 }).proofToken,
    ).not.toBe(material.proofToken);
  });

  it.each([
    ['bindingVersion', 2],
    ['issuanceFingerprint', 'd'.repeat(64)],
    ['authorizationScopeFingerprint', 'e'.repeat(64)],
    ['initialRequestId', '95000000-0000-4000-8000-000000000008'],
    ['issuedAt', '2026-08-10T14:00:00.001Z'],
    ['expiresAt', '2026-08-10T14:01:59.999Z'],
    ['userId', '95000000-0000-4000-8000-000000000008'],
    ['sessionId', '95000000-0000-4000-8000-000000000009'],
    ['householdId', '95000000-0000-4000-8000-000000000010'],
    ['proposalId', '95000000-0000-4000-8000-000000000011'],
    ['proposalVersion', 5],
    ['payloadHash', 'e'.repeat(64)],
    ['approvalHash', 'f'.repeat(64)],
    ['channel', 'other-channel'],
    ['idempotencyKey', 'visual-proof:proposal:different-key'],
  ] as const)('binds immutable issuance field %s', (field, changed) => {
    const issuer = codec();
    const material = issuer.create(binding);
    const changedBinding = {
      ...binding,
      [field]: changed,
    } as unknown as VisualDecisionProofTokenBinding;

    expect(() =>
      issuer.reproduce(
        {
          proofId: material.proofId,
          nonce: material.nonce,
          keyId: material.keyId,
          tokenHash: material.tokenHash,
        },
        changedBinding,
      ),
    ).toThrow(VisualDecisionProofTokenCodecError);
  });

  it('allows only the current key to derive new bearer material', () => {
    expect(() =>
      codec().derive(
        {
          proofId: ids.proof,
          nonce: 'N'.repeat(43),
          keyId: previousKey.keyId,
        },
        binding,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<VisualDecisionProofTokenCodecError>>({
        code: 'key-unavailable',
      }),
    );
  });

  it('reproduces an earlier-key token through the full proof lifetime grace window', () => {
    const oldCodec = codec({
      current: {
        keyId: previousKey.keyId,
        secret: previousKey.secret,
      },
      previous: [],
    });
    const oldMaterial = oldCodec.create(binding);

    const rotatedCodec = codec();
    expect(
      rotatedCodec.reproduce(
        {
          proofId: oldMaterial.proofId,
          nonce: oldMaterial.nonce,
          keyId: oldMaterial.keyId,
          tokenHash: oldMaterial.tokenHash,
        },
        binding,
      ),
    ).toBe(oldMaterial.proofToken);
  });

  it('fails closed after a prior key retires or when the same key ID has the wrong secret', () => {
    const oldCodec = codec({
      current: {
        keyId: previousKey.keyId,
        secret: previousKey.secret,
      },
      previous: [],
    });
    const material = oldCodec.create(binding);
    const seed = {
      proofId: material.proofId,
      nonce: material.nonce,
      keyId: material.keyId,
      tokenHash: material.tokenHash,
    };

    let activeTime = now;
    const rotated = codec({ clock: () => activeTime });
    activeTime = new Date(previousKey.verifyUntil);
    expect(() => rotated.reproduce(seed, binding)).toThrowError(
      expect.objectContaining<Partial<VisualDecisionProofTokenCodecError>>({
        code: 'key-unavailable',
      }),
    );

    expect(() =>
      codec({
        current: {
          keyId: previousKey.keyId,
          secret: new Uint8Array(32).fill(9),
        },
        previous: [],
      }).reproduce(seed, binding),
    ).toThrowError(
      expect.objectContaining<Partial<VisualDecisionProofTokenCodecError>>({
        code: 'integrity-check-failed',
      }),
    );
  });

  it('rejects a prior-key token issued after that key drain cutoff', () => {
    const lateBinding = {
      ...binding,
      issuedAt: '2026-08-10T14:00:00.001Z',
      expiresAt: '2026-08-10T14:02:00.001Z',
    };
    const oldCodec = codec({
      current: {
        keyId: previousKey.keyId,
        secret: previousKey.secret,
      },
      previous: [],
    });
    const material = oldCodec.create(lateBinding);

    expect(() =>
      codec().reproduce(
        {
          proofId: material.proofId,
          nonce: material.nonce,
          keyId: material.keyId,
          tokenHash: material.tokenHash,
        },
        lateBinding,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<VisualDecisionProofTokenCodecError>>({
        code: 'key-unavailable',
      }),
    );
  });

  it('fails closed if the runtime clock becomes non-finite', () => {
    let activeTime = now;
    const rotated = codec({ clock: () => activeTime });
    const oldCodec = codec({
      current: {
        keyId: previousKey.keyId,
        secret: previousKey.secret,
      },
      previous: [],
    });
    const material = oldCodec.create(binding);
    activeTime = new Date(Number.NaN);

    expect(() =>
      rotated.reproduce(
        {
          proofId: material.proofId,
          nonce: material.nonce,
          keyId: material.keyId,
          tokenHash: material.tokenHash,
        },
        binding,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<VisualDecisionProofTokenCodecError>>({
        code: 'key-unavailable',
      }),
    );
  });

  it('rejects weak, ambiguous, oversized, and under-grace key rings at startup', () => {
    const invalidOptions = [
      {
        current: { ...currentKey, secret: new Uint8Array(31) },
        previous: [],
      },
      {
        current: currentKey,
        previous: [{ ...previousKey, keyId: currentKey.keyId }],
      },
      {
        current: currentKey,
        previous: [previousKey, previousKey, previousKey],
      },
      {
        current: currentKey,
        previous: [
          {
            ...previousKey,
            verifyUntil: '2026-08-10T14:02:29.999Z',
          },
        ],
      },
      {
        current: currentKey,
        previous: [{ ...previousKey, issueUntil: 'not-a-date' }],
      },
      {
        current: currentKey,
        previous: [{ ...previousKey, verifyUntil: 'not-a-date' }],
      },
    ] as const;

    for (const invalid of invalidOptions) {
      expect(
        () =>
          new VisualDecisionProofTokenCodec({
            ...invalid,
            clock: () => now,
          }),
      ).toThrow(VisualDecisionProofTokenCodecError);
    }
  });
});
