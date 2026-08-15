import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
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
export const VaultKeyVersionSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);

export const EncryptedVaultPayloadSchema = z
  .strictObject({
    algorithm: z.literal('aes-256-gcm'),
    aadVersion: z.literal(1),
    ciphertext: Base64UrlSchema,
    nonce: Base64UrlSchema.min(1),
    authenticationTag: Base64UrlSchema.min(1),
    wrappedKey: Base64UrlSchema.min(1),
    keyVersion: VaultKeyVersionSchema,
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

const VaultKekSchema = z.strictObject({
  keyVersion: VaultKeyVersionSchema,
  key: z.instanceof(Uint8Array),
});
const RotatingVaultKeyProviderOptionsSchema = z.strictObject({
  current: VaultKekSchema,
  previous: z.array(VaultKekSchema).max(2).optional(),
});
const WrappedDataKeySchema = z.strictObject({
  wrappedKey: Base64UrlSchema.min(1),
  keyVersion: VaultKeyVersionSchema,
});

const invalidVaultKeyProvider = (): Error =>
  new Error('Vault key provider unavailable');

export class RotatingVaultKeyProvider implements VaultKeyProvider {
  readonly #currentKeyVersion: string;
  readonly #keys = new Map<string, Buffer>();
  #disposed = false;

  constructor(optionsInput: {
    readonly current: {
      readonly keyVersion: string;
      readonly key: Uint8Array;
    };
    readonly previous?: readonly {
      readonly keyVersion: string;
      readonly key: Uint8Array;
    }[];
  }) {
    const options =
      RotatingVaultKeyProviderOptionsSchema.safeParse(optionsInput);
    if (!options.success) throw invalidVaultKeyProvider();
    const entries = [options.data.current, ...(options.data.previous ?? [])];
    if (
      entries.some(({ key }) => key.byteLength !== 32) ||
      new Set(entries.map(({ keyVersion }) => keyVersion)).size !==
        entries.length
    ) {
      throw invalidVaultKeyProvider();
    }
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        if (timingSafeEqual(entries[left]!.key, entries[right]!.key)) {
          throw invalidVaultKeyProvider();
        }
      }
    }
    try {
      for (const entry of entries) {
        this.#keys.set(entry.keyVersion, Buffer.from(entry.key));
      }
      this.#currentKeyVersion = options.data.current.keyVersion;
    } catch {
      for (const key of this.#keys.values()) key.fill(0);
      this.#keys.clear();
      throw invalidVaultKeyProvider();
    }
    Object.freeze(this);
  }

  async wrap(dataKey: Uint8Array): Promise<WrappedDataKey> {
    const masterKey = this.#keyFor(this.#currentKeyVersion);
    if (!(dataKey instanceof Uint8Array) || dataKey.byteLength !== 32) {
      throw invalidVaultKeyProvider();
    }
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', masterKey, nonce, {
        authTagLength: 16,
      });
      cipher.setAAD(Buffer.from(this.#currentKeyVersion));
      const ciphertext = Buffer.concat([
        cipher.update(dataKey),
        cipher.final(),
      ]);
      return Object.freeze({
        wrappedKey: Buffer.concat([
          nonce,
          cipher.getAuthTag(),
          ciphertext,
        ]).toString('base64url'),
        keyVersion: this.#currentKeyVersion,
      });
    } catch {
      throw invalidVaultKeyProvider();
    }
  }

  async unwrap(wrappedInput: WrappedDataKey): Promise<Uint8Array> {
    const wrapped = WrappedDataKeySchema.safeParse(wrappedInput);
    if (!wrapped.success) throw invalidVaultKeyProvider();
    const masterKey = this.#keyFor(wrapped.data.keyVersion);
    let bytes: Buffer | undefined;
    try {
      bytes = decodeCanonicalBase64Url(
        wrapped.data.wrappedKey,
        'Wrapped vault key',
        60,
      );
      const nonce = bytes.subarray(0, 12);
      const tag = bytes.subarray(12, 28);
      const ciphertext = bytes.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce, {
        authTagLength: 16,
      });
      decipher.setAAD(Buffer.from(wrapped.data.keyVersion));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw invalidVaultKeyProvider();
    } finally {
      bytes?.fill(0);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const key of this.#keys.values()) key.fill(0);
    this.#keys.clear();
  }

  #keyFor(keyVersion: string): Buffer {
    if (this.#disposed) throw invalidVaultKeyProvider();
    const key = this.#keys.get(keyVersion);
    if (key === undefined) throw invalidVaultKeyProvider();
    return key;
  }
}

export class InMemoryVaultKeyProvider implements VaultKeyProvider {
  readonly #provider: RotatingVaultKeyProvider;

  constructor(masterKey: Uint8Array, keyVersion: string) {
    this.#provider = new RotatingVaultKeyProvider({
      current: { keyVersion, key: masterKey },
    });
  }

  wrap(dataKey: Uint8Array): Promise<WrappedDataKey> {
    return this.#provider.wrap(dataKey);
  }

  unwrap(wrapped: WrappedDataKey): Promise<Uint8Array> {
    return this.#provider.unwrap(wrapped);
  }
}
