import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { JsonValueSchema, UuidSchema, deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

import type { FinanceDocumentKeyProvider } from './storage.js';

const MAXIMUM_PAYLOAD_BYTES = 16 * 1024 * 1024;
const CanonicalBase64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);

export const FinanceBookEvidenceScopeSchema = z
  .strictObject({
    workspaceId: UuidSchema,
    bookId: UuidSchema,
    documentId: UuidSchema,
  })
  .transform(deepFreeze);

export type FinanceBookEvidenceScope = z.input<
  typeof FinanceBookEvidenceScopeSchema
>;

export const EncryptedFinanceBookEvidenceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    algorithm: z.literal('aes-256-gcm'),
    aadVersion: z.literal(1),
    ciphertext: CanonicalBase64UrlSchema,
    nonce: CanonicalBase64UrlSchema,
    authenticationTag: CanonicalBase64UrlSchema,
    wrappedKey: CanonicalBase64UrlSchema,
    keyVersion: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u),
  })
  .transform(deepFreeze);

export type EncryptedFinanceBookEvidence = z.input<
  typeof EncryptedFinanceBookEvidenceSchema
>;

const invalid = (): Error =>
  new Error('finance-book-evidence-crypto-unavailable');

const canonicalDecode = (value: string, expectedLength?: number): Buffer => {
  const bytes = Buffer.from(value, 'base64url');
  if (
    bytes.toString('base64url') !== value ||
    (expectedLength !== undefined && bytes.byteLength !== expectedLength)
  ) {
    bytes.fill(0);
    throw invalid();
  }
  return bytes;
};

const aadFor = (scopeInput: FinanceBookEvidenceScope): Buffer => {
  const scope = FinanceBookEvidenceScopeSchema.parse(scopeInput);
  return Buffer.from(
    JSON.stringify({
      domain: 'emdo.finance-book.original.v1',
      workspaceId: scope.workspaceId,
      bookId: scope.bookId,
      documentId: scope.documentId,
    }),
    'utf8',
  );
};

export class FinanceBookEvidenceCrypto {
  constructor(private readonly keyProvider: FinanceDocumentKeyProvider) {
    if (
      typeof keyProvider?.wrap !== 'function' ||
      typeof keyProvider.unwrap !== 'function'
    ) {
      throw invalid();
    }
  }

  async encrypt(
    value: unknown,
    scope: FinanceBookEvidenceScope,
  ): Promise<EncryptedFinanceBookEvidence> {
    const canonical = JsonValueSchema.parse(value);
    const plaintext = Buffer.from(JSON.stringify(canonical), 'utf8');
    if (
      plaintext.byteLength === 0 ||
      plaintext.byteLength > MAXIMUM_PAYLOAD_BYTES
    ) {
      plaintext.fill(0);
      throw invalid();
    }
    const dataKey = randomBytes(32);
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', dataKey, nonce, {
        authTagLength: 16,
      });
      cipher.setAAD(aadFor(scope));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      const wrapped = await this.keyProvider.wrap(dataKey);
      try {
        return EncryptedFinanceBookEvidenceSchema.parse({
          schemaVersion: 1,
          algorithm: 'aes-256-gcm',
          aadVersion: 1,
          ciphertext: ciphertext.toString('base64url'),
          nonce: nonce.toString('base64url'),
          authenticationTag: tag.toString('base64url'),
          wrappedKey: wrapped.wrappedKey,
          keyVersion: wrapped.keyVersion,
        });
      } finally {
        ciphertext.fill(0);
        tag.fill(0);
        nonce.fill(0);
      }
    } catch {
      throw invalid();
    } finally {
      plaintext.fill(0);
      dataKey.fill(0);
    }
  }

  async decrypt(
    payloadInput: EncryptedFinanceBookEvidence,
    scope: FinanceBookEvidenceScope,
  ): Promise<unknown> {
    const payload = EncryptedFinanceBookEvidenceSchema.parse(payloadInput);
    const nonce = canonicalDecode(payload.nonce, 12);
    const tag = canonicalDecode(payload.authenticationTag, 16);
    const ciphertext = canonicalDecode(payload.ciphertext);
    const dataKey = await this.keyProvider.unwrap({
      wrappedKey: payload.wrappedKey,
      keyVersion: payload.keyVersion,
    });
    let plaintext: Buffer | undefined;
    try {
      if (dataKey.byteLength !== 32) throw invalid();
      const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce, {
        authTagLength: 16,
      });
      decipher.setAAD(aadFor(scope));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      if (
        plaintext.byteLength === 0 ||
        plaintext.byteLength > MAXIMUM_PAYLOAD_BYTES
      ) {
        throw invalid();
      }
      return JsonValueSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)),
      );
    } catch {
      throw invalid();
    } finally {
      dataKey.fill(0);
      nonce.fill(0);
      tag.fill(0);
      ciphertext.fill(0);
      plaintext?.fill(0);
    }
  }
}
