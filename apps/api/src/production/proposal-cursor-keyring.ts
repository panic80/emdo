import type {
  ProposalQueryCursorHmacKey,
  ProposalQueryCursorPreviousHmacKey,
} from '@emdo/db/api';
import { z } from 'zod';

const MAXIMUM_ENCODED_KEYRING_CHARACTERS = 8_192;
const MAXIMUM_DECODED_KEYRING_BYTES = 6_144;
const MINIMUM_KEY_BYTES = 32;
const MAXIMUM_KEY_BYTES = 64;

const KeyIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);
const CanonicalBase64UrlSchema = z
  .string()
  .min(43)
  .max(86)
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

const ProposalCursorKeyringSchema = z.strictObject({
  schemaVersion: z.literal(1),
  current: z.strictObject({
    keyId: KeyIdSchema,
    keyB64url: CanonicalBase64UrlSchema,
  }),
  previous: z
    .array(
      z.strictObject({
        keyId: KeyIdSchema,
        keyB64url: CanonicalBase64UrlSchema,
        issueUntil: CanonicalInstantSchema,
        verifyUntil: CanonicalInstantSchema,
      }),
    )
    .max(2),
});

const invalidKeyring = (): Error =>
  new Error('api-proposal-cursor-keyring-invalid');

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

export interface ProductionProposalCursorKeyring {
  readonly current: ProposalQueryCursorHmacKey;
  readonly previous: readonly ProposalQueryCursorPreviousHmacKey[];
}

export const parseProductionProposalCursorKeyring = (
  encoded: string,
): ProductionProposalCursorKeyring => {
  const decodedSecrets: Buffer[] = [];
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
    const keyring = ProposalCursorKeyringSchema.parse(raw);
    const keyIds = [
      keyring.current.keyId,
      ...keyring.previous.map(({ keyId }) => keyId),
    ];
    if (new Set(keyIds).size !== keyIds.length) throw invalidKeyring();
    const encodedKeys = [
      keyring.current.keyB64url,
      ...keyring.previous.map(({ keyB64url }) => keyB64url),
    ];
    if (new Set(encodedKeys).size !== encodedKeys.length) {
      throw invalidKeyring();
    }

    const currentSecret = decodeCanonicalBase64Url(
      keyring.current.keyB64url,
      MINIMUM_KEY_BYTES,
      MAXIMUM_KEY_BYTES,
    );
    decodedSecrets.push(currentSecret);
    const previous = keyring.previous.map((candidate) => {
      const secret = decodeCanonicalBase64Url(
        candidate.keyB64url,
        MINIMUM_KEY_BYTES,
        MAXIMUM_KEY_BYTES,
      );
      decodedSecrets.push(secret);
      return {
        keyId: candidate.keyId,
        secret,
        issueUntil: candidate.issueUntil,
        verifyUntil: candidate.verifyUntil,
      };
    });
    return Object.freeze({
      current: Object.freeze({
        keyId: keyring.current.keyId,
        secret: currentSecret,
      }),
      previous: Object.freeze(
        previous.map((candidate) => Object.freeze(candidate)),
      ),
    });
  } catch {
    for (const secret of decodedSecrets) secret.fill(0);
    throw invalidKeyring();
  }
};
