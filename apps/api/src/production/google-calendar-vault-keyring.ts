import { timingSafeEqual } from 'node:crypto';

import { RotatingVaultKeyProvider } from '@emdo/integrations/google-oauth-server';
import { z } from 'zod';

const MAXIMUM_ENCODED_KEYRING_CHARACTERS = 8_192;
const MAXIMUM_DECODED_KEYRING_BYTES = 6_144;
const VAULT_KEK_BYTES = 32;

const KeyVersionSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);
const CanonicalBase64UrlSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u);
const KeyEntrySchema = z.strictObject({
  keyVersion: KeyVersionSchema,
  keyB64url: CanonicalBase64UrlSchema,
});
const GoogleCalendarVaultKeyringSchema = z.strictObject({
  schemaVersion: z.literal(1),
  current: KeyEntrySchema,
  previous: z.array(KeyEntrySchema).max(2),
});

const invalidKeyring = (): Error =>
  new Error('api-google-calendar-vault-keyring-invalid');

const decodeCanonicalBase64Url = (
  value: string,
  minimumBytes: number,
  maximumBytes: number,
): Buffer => {
  if (
    value.length === 0 ||
    value.length > maximumBytes * 2 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw invalidKeyring();
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.length < minimumBytes ||
    decoded.length > maximumBytes ||
    decoded.toString('base64url') !== value
  ) {
    decoded.fill(0);
    throw invalidKeyring();
  }
  return decoded;
};

export const createProductionGoogleCalendarVaultKeyProvider = (
  encoded: string,
): RotatingVaultKeyProvider => {
  const decodedKeys: Buffer[] = [];
  let provider: RotatingVaultKeyProvider | undefined;
  try {
    if (
      typeof encoded !== 'string' ||
      encoded.length > MAXIMUM_ENCODED_KEYRING_CHARACTERS
    ) {
      throw invalidKeyring();
    }
    const jsonBytes = decodeCanonicalBase64Url(
      encoded,
      1,
      MAXIMUM_DECODED_KEYRING_BYTES,
    );
    let raw: unknown;
    try {
      const json = new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes);
      raw = JSON.parse(json) as unknown;
    } finally {
      jsonBytes.fill(0);
    }
    const keyring = GoogleCalendarVaultKeyringSchema.parse(raw);
    const entries = [keyring.current, ...keyring.previous];
    if (
      new Set(entries.map(({ keyVersion }) => keyVersion)).size !==
      entries.length
    ) {
      throw invalidKeyring();
    }
    const decoded = entries.map((entry) => {
      const key = decodeCanonicalBase64Url(
        entry.keyB64url,
        VAULT_KEK_BYTES,
        VAULT_KEK_BYTES,
      );
      decodedKeys.push(key);
      return { keyVersion: entry.keyVersion, key };
    });
    for (let left = 0; left < decoded.length; left += 1) {
      for (let right = left + 1; right < decoded.length; right += 1) {
        if (timingSafeEqual(decoded[left]!.key, decoded[right]!.key)) {
          throw invalidKeyring();
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
    throw invalidKeyring();
  } finally {
    for (const key of decodedKeys) key.fill(0);
  }
};
