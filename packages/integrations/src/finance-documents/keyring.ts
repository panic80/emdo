import { timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { RotatingVaultKeyProvider } from '../vault/crypto.js';

const MAXIMUM_ENCODED_CHARACTERS = 8_192;
const MAXIMUM_DECODED_BYTES = 6_144;
const KEY_BYTES = 32;

const KeyEntrySchema = z.strictObject({
  keyVersion: z
    .string()
    .min(2)
    .max(64)
    .regex(/^finance-documents\.v[1-9][0-9]*$/u),
  keyB64url: z
    .string()
    .length(43)
    .regex(/^[A-Za-z0-9_-]+$/u),
});
const FinanceDocumentKeyringSchema = z.strictObject({
  schemaVersion: z.literal(1),
  current: KeyEntrySchema,
  previous: z.array(KeyEntrySchema).max(2),
});

const invalid = (): Error => new Error('finance-document-keyring-invalid');

const decodeCanonical = (
  value: string,
  minimumBytes: number,
  maximumBytes: number,
): Buffer => {
  if (
    value.length === 0 ||
    value.length > maximumBytes * 2 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw invalid();
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.byteLength < minimumBytes ||
    decoded.byteLength > maximumBytes ||
    decoded.toString('base64url') !== value
  ) {
    decoded.fill(0);
    throw invalid();
  }
  return decoded;
};

/** Loads only the versioned Finance-document KEK set and zeroizes decoded keys. */
export const createFinanceDocumentKeyProvider = (
  encoded: string,
  forbiddenKeyMaterials: readonly Uint8Array[] = [],
): RotatingVaultKeyProvider => {
  const decodedKeys: Buffer[] = [];
  const forbiddenKeys: Buffer[] = [];
  let provider: RotatingVaultKeyProvider | undefined;
  try {
    for (const material of forbiddenKeyMaterials) {
      if (!(material instanceof Uint8Array) || material.byteLength === 0) {
        throw invalid();
      }
      forbiddenKeys.push(Buffer.from(material));
    }
    if (
      typeof encoded !== 'string' ||
      encoded.length === 0 ||
      encoded.length > MAXIMUM_ENCODED_CHARACTERS
    ) {
      throw invalid();
    }
    const bytes = decodeCanonical(encoded, 1, MAXIMUM_DECODED_BYTES);
    let raw: unknown;
    try {
      raw = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as unknown;
    } finally {
      bytes.fill(0);
    }
    const keyring = FinanceDocumentKeyringSchema.parse(raw);
    const entries = [keyring.current, ...keyring.previous];
    if (
      new Set(entries.map(({ keyVersion }) => keyVersion)).size !==
      entries.length
    ) {
      throw invalid();
    }
    const decoded = entries.map((entry) => {
      const key = decodeCanonical(entry.keyB64url, KEY_BYTES, KEY_BYTES);
      decodedKeys.push(key);
      return { keyVersion: entry.keyVersion, key };
    });
    for (let left = 0; left < decoded.length; left += 1) {
      for (let right = left + 1; right < decoded.length; right += 1) {
        if (timingSafeEqual(decoded[left]!.key, decoded[right]!.key)) {
          throw invalid();
        }
      }
      for (const forbidden of forbiddenKeys) {
        if (
          forbidden.byteLength === decoded[left]!.key.byteLength &&
          timingSafeEqual(forbidden, decoded[left]!.key)
        ) {
          throw invalid();
        }
      }
    }
    provider = new RotatingVaultKeyProvider({
      current: decoded[0]!,
      previous: decoded.slice(1),
    });
    return provider;
  } catch {
    provider?.dispose();
    throw invalid();
  } finally {
    for (const key of decodedKeys) key.fill(0);
    for (const key of forbiddenKeys) key.fill(0);
  }
};
