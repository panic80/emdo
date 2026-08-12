import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

import { z } from 'zod';

const MAXIMUM_ENCODED_KEYRING_CHARACTERS = 32_768;
const MAXIMUM_DECODED_KEYRING_BYTES = 24_576;
const MAXIMUM_DER_KEY_BYTES = 8_192;
const MINIMUM_PRIOR_KEY_GRACE_MS = 305_000;

const KeyIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);
const CanonicalBase64UrlSchema = z
  .string()
  .min(1)
  .max(MAXIMUM_DER_KEY_BYTES * 2)
  .regex(/^[A-Za-z0-9_-]+$/u);
const CanonicalInstantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return (
      Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    );
  });

const SyncJwtKeyringSchema = z.strictObject({
  schemaVersion: z.literal(1),
  current: z.strictObject({
    kid: KeyIdSchema,
    privatePkcs8DerB64url: CanonicalBase64UrlSchema,
  }),
  previous: z
    .array(
      z.strictObject({
        kid: KeyIdSchema,
        publicSpkiDerB64url: CanonicalBase64UrlSchema,
        retiredAt: CanonicalInstantSchema,
        verifyUntil: CanonicalInstantSchema,
      }),
    )
    .max(2),
});

const invalidKeyring = (): Error => new Error('api-sync-keyring-invalid');

const decodeCanonicalBase64Url = (
  value: string,
  maximumBytes: number,
): Buffer => {
  if (
    value.length === 0 ||
    !/^[A-Za-z0-9_-]+$/u.test(value) ||
    value.length > maximumBytes * 2
  ) {
    throw invalidKeyring();
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.length === 0 ||
    decoded.length > maximumBytes ||
    decoded.toString('base64url') !== value
  ) {
    decoded.fill(0);
    throw invalidKeyring();
  }
  return decoded;
};

const assertStrongRsaKey = (
  key: KeyObject,
  expectedType: 'private' | 'public',
): void => {
  if (
    key.type !== expectedType ||
    key.asymmetricKeyType !== 'rsa' ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2_048
  ) {
    throw invalidKeyring();
  }
};

export interface ProductionSyncJwtKeyring {
  readonly current: Readonly<{
    readonly kid: string;
    readonly privateKey: KeyObject;
  }>;
  readonly previous: readonly Readonly<{
    readonly kid: string;
    readonly publicKey: KeyObject;
    readonly retiredAt: string;
    readonly verifyUntil: string;
  }>[];
}

export const parseProductionSyncJwtKeyring = (
  encoded: string,
  options: { readonly now?: () => Date } = {},
): ProductionSyncJwtKeyring => {
  try {
    if (
      typeof encoded !== 'string' ||
      encoded.length > MAXIMUM_ENCODED_KEYRING_CHARACTERS
    ) {
      throw invalidKeyring();
    }
    const now = (options.now ?? (() => new Date()))();
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw invalidKeyring();

    const jsonBytes = decodeCanonicalBase64Url(
      encoded,
      MAXIMUM_DECODED_KEYRING_BYTES,
    );
    let raw: unknown;
    try {
      const json = new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes);
      raw = JSON.parse(json) as unknown;
    } finally {
      jsonBytes.fill(0);
    }
    const keyring = SyncJwtKeyringSchema.parse(raw);
    const keyIds = [
      keyring.current.kid,
      ...keyring.previous.map(({ kid }) => kid),
    ];
    if (new Set(keyIds).size !== keyIds.length) throw invalidKeyring();

    const privateDer = decodeCanonicalBase64Url(
      keyring.current.privatePkcs8DerB64url,
      MAXIMUM_DER_KEY_BYTES,
    );
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey({
        key: privateDer,
        format: 'der',
        type: 'pkcs8',
      });
    } finally {
      privateDer.fill(0);
    }
    assertStrongRsaKey(privateKey, 'private');
    const currentPublicKey = createPublicKey(privateKey);
    assertStrongRsaKey(currentPublicKey, 'public');

    const previous: Array<{
      readonly kid: string;
      readonly publicKey: KeyObject;
      readonly retiredAt: string;
      readonly verifyUntil: string;
    }> = [];
    for (const prior of keyring.previous) {
      const retiredAtMs = Date.parse(prior.retiredAt);
      const verifyUntilMs = Date.parse(prior.verifyUntil);
      if (
        retiredAtMs > nowMs ||
        verifyUntilMs - retiredAtMs < MINIMUM_PRIOR_KEY_GRACE_MS ||
        nowMs >= verifyUntilMs
      ) {
        throw invalidKeyring();
      }
      const publicDer = decodeCanonicalBase64Url(
        prior.publicSpkiDerB64url,
        MAXIMUM_DER_KEY_BYTES,
      );
      let publicKey: KeyObject;
      try {
        publicKey = createPublicKey({
          key: publicDer,
          format: 'der',
          type: 'spki',
        });
      } finally {
        publicDer.fill(0);
      }
      assertStrongRsaKey(publicKey, 'public');
      previous.push(
        Object.freeze({
          kid: prior.kid,
          publicKey,
          retiredAt: prior.retiredAt,
          verifyUntil: prior.verifyUntil,
        }),
      );
    }

    return Object.freeze({
      current: Object.freeze({ kid: keyring.current.kid, privateKey }),
      previous: Object.freeze(previous),
    });
  } catch {
    throw invalidKeyring();
  }
};
