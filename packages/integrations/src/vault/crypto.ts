import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface VaultScope {
  readonly householdId: string;
  readonly spaceId: string;
  readonly recordId: string;
}

export interface WrappedDataKey {
  readonly wrappedKey: string;
  readonly keyVersion: string;
}

export interface VaultKeyProvider {
  wrap(dataKey: Uint8Array): Promise<WrappedDataKey>;
  unwrap(wrapped: WrappedDataKey): Promise<Uint8Array>;
}

export interface EncryptedVaultPayload {
  readonly algorithm: 'aes-256-gcm';
  readonly aadVersion: 1;
  readonly ciphertext: string;
  readonly nonce: string;
  readonly authenticationTag: string;
  readonly wrappedKey: string;
  readonly keyVersion: string;
}

const aadFor = (scope: VaultScope) =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      householdId: scope.householdId,
      spaceId: scope.spaceId,
      recordId: scope.recordId,
    }),
  );

export class VaultCrypto {
  constructor(private readonly keyProvider: VaultKeyProvider) {}

  async encrypt(
    plaintext: string,
    scope: VaultScope,
  ): Promise<EncryptedVaultPayload> {
    const dataKey = randomBytes(32);
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
      cipher.setAAD(aadFor(scope));
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(plaintext, 'utf8')),
        cipher.final(),
      ]);
      const authenticationTag = cipher.getAuthTag();
      const wrapped = await this.keyProvider.wrap(dataKey);
      return Object.freeze({
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
    if (payload.algorithm !== 'aes-256-gcm' || payload.aadVersion !== 1) {
      throw new Error('Unsupported vault payload');
    }
    const dataKey = Buffer.from(
      await this.keyProvider.unwrap({
        wrappedKey: payload.wrappedKey,
        keyVersion: payload.keyVersion,
      }),
    );
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        dataKey,
        Buffer.from(payload.nonce, 'base64url'),
      );
      decipher.setAAD(aadFor(scope));
      decipher.setAuthTag(Buffer.from(payload.authenticationTag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } finally {
      dataKey.fill(0);
    }
  }
}

export class InMemoryVaultKeyProvider implements VaultKeyProvider {
  private readonly masterKey: Buffer;

  constructor(
    masterKey: Uint8Array,
    private readonly keyVersion: string,
  ) {
    if (masterKey.byteLength !== 32)
      throw new Error('Vault KEK must be 32 bytes');
    this.masterKey = Buffer.from(masterKey);
  }

  async wrap(dataKey: Uint8Array) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, nonce);
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
    const bytes = Buffer.from(wrapped.wrappedKey, 'base64url');
    if (bytes.byteLength !== 60) throw new Error('Invalid wrapped vault key');
    const nonce = bytes.subarray(0, 12);
    const tag = bytes.subarray(12, 28);
    const ciphertext = bytes.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, nonce);
    decipher.setAAD(Buffer.from(this.keyVersion));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
