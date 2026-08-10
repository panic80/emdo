import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

import {
  IdentifierSchema,
  OpaqueReferenceSchema,
  deepFreeze,
} from '@emdo/contracts';

export const VaultScopeSchema = z
  .strictObject({
    householdId: OpaqueReferenceSchema,
    spaceId: OpaqueReferenceSchema,
    recordId: OpaqueReferenceSchema,
    provider: IdentifierSchema,
    grantType: z.enum([
      'identity-sign-in',
      'calendar-authorization',
      'maps-authorization',
      'commerce-authorization',
      'notification-authorization',
    ]),
  })
  .transform(deepFreeze);

export type VaultScope = z.input<typeof VaultScopeSchema>;

export interface WrappedDataKey {
  readonly wrappedKey: string;
  readonly keyVersion: string;
}

export interface VaultKeyProvider {
  wrap(dataKey: Uint8Array): Promise<WrappedDataKey>;
  unwrap(wrapped: WrappedDataKey): Promise<Uint8Array>;
}

const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]*$/);

export const EncryptedVaultPayloadSchema = z
  .strictObject({
    algorithm: z.literal('aes-256-gcm'),
    aadVersion: z.literal(1),
    ciphertext: Base64UrlSchema,
    nonce: Base64UrlSchema.min(1),
    authenticationTag: Base64UrlSchema.min(1),
    wrappedKey: Base64UrlSchema.min(1),
    keyVersion: OpaqueReferenceSchema,
  })
  .transform(deepFreeze);

export type EncryptedVaultPayload = z.input<typeof EncryptedVaultPayloadSchema>;

const aadFor = (rawScope: VaultScope) => {
  const scope = VaultScopeSchema.parse(rawScope);
  return Buffer.from(
    JSON.stringify({
      version: 1,
      householdId: scope.householdId,
      spaceId: scope.spaceId,
      recordId: scope.recordId,
      provider: scope.provider,
      grantType: scope.grantType,
    }),
  );
};

const decodeCanonicalBase64Url = (
  value: string,
  name: string,
  expectedLength?: number,
): Buffer => {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`${name} is not canonical base64url`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) {
    throw new Error(`${name} is not canonical base64url`);
  }
  if (expectedLength !== undefined && bytes.byteLength !== expectedLength) {
    throw new Error(`${name} has an invalid length`);
  }
  return bytes;
};

export class VaultCrypto {
  constructor(private readonly keyProvider: VaultKeyProvider) {}

  async encrypt(
    plaintext: string,
    scope: VaultScope,
  ): Promise<EncryptedVaultPayload> {
    const validatedScope = VaultScopeSchema.parse(scope);
    const dataKey = randomBytes(32);
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', dataKey, nonce, {
        authTagLength: 16,
      });
      cipher.setAAD(aadFor(validatedScope));
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(plaintext, 'utf8')),
        cipher.final(),
      ]);
      const authenticationTag = cipher.getAuthTag();
      const wrapped = await this.keyProvider.wrap(dataKey);
      return EncryptedVaultPayloadSchema.parse({
        algorithm: 'aes-256-gcm',
        aadVersion: 1,
        ciphertext: ciphertext.toString('base64url'),
        nonce: nonce.toString('base64url'),
        authenticationTag: authenticationTag.toString('base64url'),
        wrappedKey: wrapped.wrappedKey,
        keyVersion: wrapped.keyVersion,
      });
    } finally {
      dataKey.fill(0);
    }
  }

  async decrypt(payload: EncryptedVaultPayload, scope: VaultScope) {
    const validatedScope = VaultScopeSchema.parse(scope);
    const validatedPayload = EncryptedVaultPayloadSchema.parse(payload);
    const nonce = decodeCanonicalBase64Url(
      validatedPayload.nonce,
      'Vault nonce',
      12,
    );
    const authenticationTag = decodeCanonicalBase64Url(
      validatedPayload.authenticationTag,
      'Vault authentication tag',
      16,
    );
    const ciphertext = decodeCanonicalBase64Url(
      validatedPayload.ciphertext,
      'Vault ciphertext',
    );
    const dataKey = await this.keyProvider.unwrap({
      wrappedKey: validatedPayload.wrappedKey,
      keyVersion: validatedPayload.keyVersion,
    });
    try {
      if (dataKey.byteLength !== 32) {
        throw new Error('Vault data key has an invalid length');
      }
      const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce, {
        authTagLength: 16,
      });
      decipher.setAAD(aadFor(validatedScope));
      decipher.setAuthTag(authenticationTag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } finally {
      dataKey.fill(0);
    }
  }
}

export class InMemoryVaultKeyProvider implements VaultKeyProvider {
  private readonly masterKey: Buffer;
  private readonly keyVersion: string;

  constructor(masterKey: Uint8Array, keyVersion: string) {
    if (masterKey.byteLength !== 32)
      throw new Error('Vault KEK must be 32 bytes');
    this.masterKey = Buffer.from(masterKey);
    this.keyVersion = OpaqueReferenceSchema.parse(keyVersion);
  }

  async wrap(dataKey: Uint8Array) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(Buffer.from(this.keyVersion));
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Object.freeze({
      wrappedKey: Buffer.concat([
        nonce,
        cipher.getAuthTag(),
        ciphertext,
      ]).toString('base64url'),
      keyVersion: this.keyVersion,
    });
  }

  async unwrap(wrapped: WrappedDataKey) {
    if (wrapped.keyVersion !== this.keyVersion)
      throw new Error('Unknown vault key');
    const bytes = decodeCanonicalBase64Url(
      wrapped.wrappedKey,
      'Wrapped vault key',
      60,
    );
    const nonce = bytes.subarray(0, 12);
    const tag = bytes.subarray(12, 28);
    const ciphertext = bytes.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from(this.keyVersion));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
