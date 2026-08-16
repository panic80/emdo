import { timingSafeEqual } from 'node:crypto';

import { AesGcmApprovalCheckpointCipher } from '@emdo/agent-core';
import { z } from 'zod';

const MAXIMUM_ENCODED_KEYRING_CHARACTERS = 8_192;
const MAXIMUM_DECODED_KEYRING_BYTES = 6_144;
const APPROVAL_CHECKPOINT_KEY_BYTES = 32;

const KeyIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);
const CanonicalBase64UrlSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u);
const KeyEntrySchema = z.strictObject({
  keyId: KeyIdSchema,
  keyB64url: CanonicalBase64UrlSchema,
});
const ApprovalCheckpointKeyringSchema = z.strictObject({
  schemaVersion: z.literal(1),
  current: KeyEntrySchema,
  previous: z.array(KeyEntrySchema).max(2),
});

const invalidKeyring = (): Error =>
  new Error('api-approval-checkpoint-keyring-invalid');

const decodeCanonicalBase64Url = (
  value: string,
  minimumBytes: number,
  maximumBytes: number,
  maximumCharacters: number,
): Buffer => {
  if (
    value.length === 0 ||
    value.length > maximumCharacters ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw invalidKeyring();
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.byteLength < minimumBytes ||
    decoded.byteLength > maximumBytes ||
    decoded.toString('base64url') !== value
  ) {
    decoded.fill(0);
    throw invalidKeyring();
  }
  return decoded;
};

/**
 * Parses the private approval-checkpoint keyring and transfers only owned key
 * copies to the cipher. The encoded envelope and all parser-owned material
 * are wiped on every exit path.
 */
export const createProductionApprovalCheckpointCipher = (
  encoded: string,
  forbiddenKeyMaterials: readonly Uint8Array[] = [],
): AesGcmApprovalCheckpointCipher => {
  const decodedKeys: Buffer[] = [];
  const forbiddenKeys: Buffer[] = [];
  let cipher: AesGcmApprovalCheckpointCipher | undefined;
  try {
    for (const material of forbiddenKeyMaterials) {
      if (!(material instanceof Uint8Array) || material.byteLength === 0) {
        throw invalidKeyring();
      }
      forbiddenKeys.push(Buffer.from(material));
    }
    if (
      typeof encoded !== 'string' ||
      encoded.length === 0 ||
      encoded.length > MAXIMUM_ENCODED_KEYRING_CHARACTERS
    ) {
      throw invalidKeyring();
    }
    const jsonBytes = decodeCanonicalBase64Url(
      encoded,
      1,
      MAXIMUM_DECODED_KEYRING_BYTES,
      MAXIMUM_ENCODED_KEYRING_CHARACTERS,
    );
    let raw: unknown;
    try {
      const json = new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes);
      raw = JSON.parse(json) as unknown;
    } finally {
      jsonBytes.fill(0);
    }
    const keyring = ApprovalCheckpointKeyringSchema.parse(raw);
    const entries = [keyring.current, ...keyring.previous];
    const keyIds = entries.map(({ keyId }) => keyId);
    if (new Set(keyIds).size !== keyIds.length) {
      throw invalidKeyring();
    }

    const decoded = entries.map((entry) => {
      const material = decodeCanonicalBase64Url(
        entry.keyB64url,
        APPROVAL_CHECKPOINT_KEY_BYTES,
        APPROVAL_CHECKPOINT_KEY_BYTES,
        43,
      );
      decodedKeys.push(material);
      return { keyId: entry.keyId, material };
    });
    for (let left = 0; left < decoded.length; left += 1) {
      for (let right = left + 1; right < decoded.length; right += 1) {
        if (
          timingSafeEqual(decoded[left]!.material, decoded[right]!.material)
        ) {
          throw invalidKeyring();
        }
      }
      for (const forbidden of forbiddenKeys) {
        if (
          decoded[left]!.material.byteLength === forbidden.byteLength &&
          timingSafeEqual(decoded[left]!.material, forbidden)
        ) {
          throw invalidKeyring();
        }
      }
    }

    const keys = Object.fromEntries(
      decoded.map(({ keyId, material }) => [keyId, material]),
    );
    cipher = new AesGcmApprovalCheckpointCipher({
      activeKeyId: keyring.current.keyId,
      keys,
    });
    return cipher;
  } catch {
    cipher?.dispose();
    throw invalidKeyring();
  } finally {
    for (const key of decodedKeys) key.fill(0);
    for (const key of forbiddenKeys) key.fill(0);
  }
};
