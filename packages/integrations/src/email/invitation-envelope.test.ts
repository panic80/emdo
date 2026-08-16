import { createHash, webcrypto } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  InvitationDeliverySecretOpener,
  InvitationDeliverySecretSealer,
  type InvitationDeliverySecretBinding,
} from './index.js';

const token = 'A'.repeat(43);
const tokenHash = (value: string): string =>
  createHash('sha256').update(value, 'ascii').digest('hex');
const binding: InvitationDeliverySecretBinding = {
  invitationId: '11111111-1111-4111-8111-111111111111',
  normalizedRecipient: 'member@example.ca',
  role: 'member',
  tokenHash: tokenHash(token),
  templateVersion: 'invitation-redemption.v1',
};
const sealingBinding = {
  invitationId: binding.invitationId,
  recipient: binding.normalizedRecipient,
  role: binding.role,
  tokenHash: binding.tokenHash,
  templateVersion: binding.templateVersion,
} as const;

let keyPair: CryptoKeyPair;
let replacementKeyPair: CryptoKeyPair;
let sha1KeyPair: CryptoKeyPair;
let undersizedKeyPair: CryptoKeyPair;

beforeAll(async () => {
  keyPair = (await webcrypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2_048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    false,
    ['encrypt', 'decrypt'],
  )) as CryptoKeyPair;
  replacementKeyPair = (await webcrypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2_048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    false,
    ['encrypt', 'decrypt'],
  )) as CryptoKeyPair;
  sha1KeyPair = (await webcrypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2_048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-1',
    },
    false,
    ['encrypt', 'decrypt'],
  )) as CryptoKeyPair;
  undersizedKeyPair = (await webcrypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 1_024,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    false,
    ['encrypt', 'decrypt'],
  )) as CryptoKeyPair;
});

describe('invitation delivery RSA-OAEP envelope', () => {
  it('seals with only a public key, binds exact canonical metadata, and zeroizes caller bytes', async () => {
    const tokenBytes = new TextEncoder().encode(token);
    const sealer = new InvitationDeliverySecretSealer({
      keyId: 'invitation-delivery-key-2026-08',
      publicKey: keyPair.publicKey,
    });

    const envelope = await sealer.seal({
      secret: tokenBytes,
      binding: sealingBinding,
    });

    expect(tokenBytes.every((value) => value === 0)).toBe(true);
    expect(envelope).toEqual({
      schemaVersion: 1,
      algorithm: 'RSA-OAEP-256',
      keyId: 'invitation-delivery-key-2026-08',
      ciphertext: expect.stringMatching(/^[A-Za-z0-9_-]{300,400}$/u),
      bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain(token);
    expect(sealer).not.toHaveProperty('privateKey');
  });

  it('opens only under the exact binding and key, then zeroizes on success or callback failure', async () => {
    const sealer = new InvitationDeliverySecretSealer({
      keyId: 'invitation-delivery-key-2026-08',
      publicKey: keyPair.publicKey,
    });
    const envelope = await sealer.seal({
      secret: new TextEncoder().encode(token),
      binding: sealingBinding,
    });
    const opener = new InvitationDeliverySecretOpener({
      privateKeys: [
        {
          keyId: 'invitation-delivery-key-2026-08',
          privateKey: keyPair.privateKey,
        },
      ],
    });
    let openedBytes: Uint8Array | undefined;

    await expect(
      opener.withOpenedSecret({ envelope, binding }, async (secret) => {
        openedBytes = secret;
        expect(new TextDecoder().decode(secret)).toBe(token);
        return { status: 'used' as const };
      }),
    ).resolves.toEqual({ status: 'used' });
    expect(openedBytes?.every((value) => value === 0)).toBe(true);

    let failedBytes: Uint8Array | undefined;
    await expect(
      opener.withOpenedSecret({ envelope, binding }, async (secret) => {
        failedBytes = secret;
        throw new Error('private provider failure');
      }),
    ).rejects.toThrow('private provider failure');
    expect(failedBytes?.every((value) => value === 0)).toBe(true);
  });

  it('fails closed on key-role, binding, envelope, or plaintext violations and still zeroizes inputs', async () => {
    expect(
      () =>
        new InvitationDeliverySecretSealer({
          keyId: 'wrong-role',
          publicKey: keyPair.privateKey,
        }),
    ).toThrow('Invitation delivery public key is invalid');
    expect(
      () =>
        new InvitationDeliverySecretOpener({
          privateKeys: [{ keyId: 'wrong-role', privateKey: keyPair.publicKey }],
        }),
    ).toThrow('Invitation delivery private keyring is invalid');
    for (const publicKey of [
      sha1KeyPair.publicKey,
      undersizedKeyPair.publicKey,
    ]) {
      expect(
        () =>
          new InvitationDeliverySecretSealer({
            keyId: 'insecure-key',
            publicKey,
          }),
      ).toThrow('Invitation delivery public key is invalid');
    }
    for (const privateKey of [
      sha1KeyPair.privateKey,
      undersizedKeyPair.privateKey,
    ]) {
      expect(
        () =>
          new InvitationDeliverySecretOpener({
            privateKeys: [{ keyId: 'insecure-key', privateKey }],
          }),
      ).toThrow('Invitation delivery private keyring is invalid');
    }

    const invalidBytes = new TextEncoder().encode('contains/unsafe?characters');
    const sealer = new InvitationDeliverySecretSealer({
      keyId: 'invitation-delivery-key-2026-08',
      publicKey: keyPair.publicKey,
    });
    await expect(
      sealer.seal({ secret: invalidBytes, binding: sealingBinding }),
    ).rejects.toThrow('Invitation delivery secret is invalid');
    expect(invalidBytes.every((value) => value === 0)).toBe(true);

    const envelope = await sealer.seal({
      secret: new TextEncoder().encode(token),
      binding: sealingBinding,
    });
    const opener = new InvitationDeliverySecretOpener({
      privateKeys: [
        {
          keyId: 'invitation-delivery-key-2026-08',
          privateKey: keyPair.privateKey,
        },
      ],
    });
    let calls = 0;
    await expect(
      opener.withOpenedSecret(
        {
          envelope,
          binding: {
            ...binding,
            invitationId: '33333333-3333-4333-8333-333333333333',
          },
        },
        async () => {
          calls += 1;
        },
      ),
    ).rejects.toThrow('Invitation delivery envelope is invalid');
    await expect(
      opener.withOpenedSecret(
        {
          envelope: {
            ...envelope,
            ciphertext: `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}`,
          },
          binding,
        },
        async () => {
          calls += 1;
        },
      ),
    ).rejects.toThrow('Invitation delivery envelope is invalid');
    expect(calls).toBe(0);
  });

  it('rejects a valid ciphertext substituted from another invitation before exposing plaintext', async () => {
    const sealer = new InvitationDeliverySecretSealer({
      keyId: 'invitation-delivery-key-2026-08',
      publicKey: keyPair.publicKey,
    });
    const expectedEnvelope = await sealer.seal({
      secret: new TextEncoder().encode(token),
      binding: sealingBinding,
    });
    const substitutedToken = 'B'.repeat(43);
    const substitutedEnvelope = await sealer.seal({
      secret: new TextEncoder().encode(substitutedToken),
      binding: {
        ...sealingBinding,
        invitationId: '33333333-3333-4333-8333-333333333333',
        tokenHash: tokenHash(substitutedToken),
      },
    });
    const opener = new InvitationDeliverySecretOpener({
      privateKeys: [
        {
          keyId: 'invitation-delivery-key-2026-08',
          privateKey: keyPair.privateKey,
        },
      ],
    });
    let calls = 0;

    await expect(
      opener.withOpenedSecret(
        {
          envelope: {
            ...expectedEnvelope,
            ciphertext: substitutedEnvelope.ciphertext,
          },
          binding,
        },
        async () => {
          calls += 1;
        },
      ),
    ).rejects.toThrow('Invitation delivery envelope is invalid');
    expect(calls).toBe(0);
  });

  it('supports an explicit key-rotation grace set but fails closed for wrong or retired keys', async () => {
    const oldSealer = new InvitationDeliverySecretSealer({
      keyId: 'invitation-delivery-key-old',
      publicKey: keyPair.publicKey,
    });
    const envelope = await oldSealer.seal({
      secret: new TextEncoder().encode(token),
      binding: sealingBinding,
    });
    let calls = 0;

    const graceOpener = new InvitationDeliverySecretOpener({
      privateKeys: [
        {
          keyId: 'invitation-delivery-key-current',
          privateKey: replacementKeyPair.privateKey,
        },
        {
          keyId: 'invitation-delivery-key-old',
          privateKey: keyPair.privateKey,
        },
      ],
    });
    await expect(
      graceOpener.withOpenedSecret({ envelope, binding }, async () => {
        calls += 1;
        return 'opened' as const;
      }),
    ).resolves.toBe('opened');

    const wrongKeyOpener = new InvitationDeliverySecretOpener({
      privateKeys: [
        {
          keyId: 'invitation-delivery-key-old',
          privateKey: replacementKeyPair.privateKey,
        },
      ],
    });
    await expect(
      wrongKeyOpener.withOpenedSecret({ envelope, binding }, async () => {
        calls += 1;
      }),
    ).rejects.toThrow('Invitation delivery envelope is invalid');

    const retiredKeyOpener = new InvitationDeliverySecretOpener({
      privateKeys: [
        {
          keyId: 'invitation-delivery-key-current',
          privateKey: replacementKeyPair.privateKey,
        },
      ],
    });
    await expect(
      retiredKeyOpener.withOpenedSecret({ envelope, binding }, async () => {
        calls += 1;
      }),
    ).rejects.toThrow('Invitation delivery envelope is invalid');
    expect(calls).toBe(1);
  });

  it('rejects oversized plaintext and ciphertext without disclosing either value', async () => {
    const oversizedSecret = new Uint8Array(129).fill(65);
    const sealer = new InvitationDeliverySecretSealer({
      keyId: 'invitation-delivery-key-2026-08',
      publicKey: keyPair.publicKey,
    });
    await expect(
      sealer.seal({ secret: oversizedSecret, binding: sealingBinding }),
    ).rejects.toThrow('Invitation delivery secret is invalid');
    expect(oversizedSecret.every((value) => value === 0)).toBe(true);

    const envelope = await sealer.seal({
      secret: new TextEncoder().encode(token),
      binding: sealingBinding,
    });
    const opener = new InvitationDeliverySecretOpener({
      privateKeys: [
        {
          keyId: 'invitation-delivery-key-2026-08',
          privateKey: keyPair.privateKey,
        },
      ],
    });
    const oversizedCiphertext = 'A'.repeat(1_025);
    let calls = 0;
    const failure = opener.withOpenedSecret(
      {
        envelope: { ...envelope, ciphertext: oversizedCiphertext },
        binding,
      },
      async () => {
        calls += 1;
      },
    );
    await expect(failure).rejects.toThrow(
      'Invitation delivery envelope is invalid',
    );
    await expect(failure).rejects.not.toThrow(token);
    await expect(failure).rejects.not.toThrow(oversizedCiphertext);
    expect(calls).toBe(0);
  });
});
