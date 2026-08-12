import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual, webcrypto } from 'node:crypto';

import {
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly,
} from '@emdo/contracts';
import { z } from 'zod';

const KeyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);

export const InvitationDeliverySecretBindingSchema = z.strictObject({
  invitationId: UuidSchema,
  normalizedRecipient: z
    .email()
    .max(320)
    .refine(
      (value) => value === value.trim().toLowerCase(),
      'Expected a normalized recipient',
    ),
  role: z.enum(['owner', 'member']),
  tokenHash: Sha256Schema,
  templateVersion: z.literal('invitation-redemption.v1'),
});

export type InvitationDeliverySecretBinding = DeepReadonly<
  z.output<typeof InvitationDeliverySecretBindingSchema>
>;

export const InvitationDeliverySecretSealingBindingSchema = z.strictObject({
  invitationId: UuidSchema,
  recipient: z
    .email()
    .max(320)
    .refine(
      (value) => value === value.trim().toLowerCase(),
      'Expected a normalized recipient',
    ),
  role: z.enum(['owner', 'member']),
  tokenHash: Sha256Schema,
  templateVersion: z.literal('invitation-redemption.v1'),
});

export type InvitationDeliverySecretSealingBinding = DeepReadonly<
  z.output<typeof InvitationDeliverySecretSealingBindingSchema>
>;

export const InvitationDeliverySecretEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  algorithm: z.literal('RSA-OAEP-256'),
  keyId: KeyIdSchema,
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]{300,1024}$/u),
  bindingHash: Sha256Schema,
});

export type InvitationDeliverySecretEnvelope = DeepReadonly<
  z.output<typeof InvitationDeliverySecretEnvelopeSchema>
>;

export interface InvitationDeliverySecretOpeningBoundary {
  withOpenedSecret<Result>(
    input: {
      readonly envelope: InvitationDeliverySecretEnvelope;
      readonly binding: InvitationDeliverySecretBinding;
    },
    useSecret: (secret: Uint8Array) => Promise<Result>,
  ): Promise<Result>;
}

const BINDING_DOMAIN = 'emdo.invitation.delivery.binding.v1\0';
const INVALID_ENVELOPE = 'Invitation delivery envelope is invalid';

const bindingHash = (binding: InvitationDeliverySecretBinding): string =>
  createHash('sha256')
    .update(BINDING_DOMAIN, 'utf8')
    .update(
      JSON.stringify({
        invitationId: binding.invitationId,
        normalizedRecipient: binding.normalizedRecipient,
        role: binding.role,
        tokenHash: binding.tokenHash,
        templateVersion: binding.templateVersion,
      }),
      'utf8',
    )
    .digest('hex');

const constantTimeDigestMatch = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return (
    leftBytes.byteLength === 32 &&
    rightBytes.byteLength === 32 &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

const constantTimeSecretHashMatch = (
  secret: Uint8Array,
  expectedHash: string,
): boolean => {
  const actual = createHash('sha256').update(secret).digest();
  const expected = Buffer.from(expectedHash, 'hex');
  try {
    return (
      actual.byteLength === 32 &&
      expected.byteLength === 32 &&
      timingSafeEqual(actual, expected)
    );
  } finally {
    actual.fill(0);
    expected.fill(0);
  }
};

const isTokenBytes = (value: unknown): value is Uint8Array => {
  if (
    !(value instanceof Uint8Array) ||
    !(value.buffer instanceof ArrayBuffer) ||
    value.byteLength < 40 ||
    value.byteLength > 128
  ) {
    return false;
  }
  for (const byte of value) {
    const safe =
      (byte >= 48 && byte <= 57) ||
      (byte >= 65 && byte <= 90) ||
      byte === 95 ||
      (byte >= 97 && byte <= 122) ||
      byte === 45;
    if (!safe) return false;
  }
  return true;
};

const ownSecretBytes = (input: unknown): Uint8Array | undefined => {
  try {
    if (
      input === null ||
      typeof input !== 'object' ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null)
    ) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, 'secret');
    return descriptor !== undefined &&
      descriptor.get === undefined &&
      descriptor.set === undefined &&
      descriptor.value instanceof Uint8Array
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
};

const parseSealRequest = (
  input: unknown,
): {
  readonly secret: Uint8Array;
  readonly binding: InvitationDeliverySecretSealingBinding;
} => {
  try {
    if (
      input === null ||
      typeof input !== 'object' ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null)
    ) {
      throw new Error('invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const expected = ['secret', 'binding'] as const;
    if (
      Reflect.ownKeys(descriptors).length !== expected.length ||
      expected.some((name) => {
        const descriptor = descriptors[name];
        return (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        );
      })
    ) {
      throw new Error('invalid');
    }
    const secret = descriptors.secret!.value as unknown;
    const parsedBinding =
      InvitationDeliverySecretSealingBindingSchema.safeParse(
        descriptors.binding!.value,
      );
    if (!isTokenBytes(secret) || !parsedBinding.success) {
      throw new Error('invalid');
    }
    return Object.freeze({
      secret,
      binding: deepFreeze(parsedBinding.data),
    });
  } catch {
    throw new Error('Invitation delivery secret is invalid');
  }
};

const parseRsaAlgorithm = (
  key: CryptoKey,
): RsaHashedKeyAlgorithm | undefined => {
  try {
    const algorithm = key.algorithm;
    if (
      algorithm.name !== 'RSA-OAEP' ||
      !('hash' in algorithm) ||
      !('modulusLength' in algorithm) ||
      !('publicExponent' in algorithm)
    ) {
      return undefined;
    }
    const rsa = algorithm as RsaHashedKeyAlgorithm;
    if (
      rsa.hash.name !== 'SHA-256' ||
      rsa.modulusLength < 2_048 ||
      rsa.modulusLength > 4_096 ||
      rsa.publicExponent.byteLength !== 3 ||
      rsa.publicExponent[0] !== 1 ||
      rsa.publicExponent[1] !== 0 ||
      rsa.publicExponent[2] !== 1
    ) {
      return undefined;
    }
    return rsa;
  } catch {
    return undefined;
  }
};

const isPublicEncryptionKey = (key: unknown): key is CryptoKey =>
  key instanceof CryptoKey &&
  key.type === 'public' &&
  parseRsaAlgorithm(key) !== undefined &&
  key.usages.includes('encrypt') &&
  !key.usages.includes('decrypt');

const isPrivateDecryptionKey = (key: unknown): key is CryptoKey =>
  key instanceof CryptoKey &&
  key.type === 'private' &&
  key.extractable === false &&
  parseRsaAlgorithm(key) !== undefined &&
  key.usages.includes('decrypt') &&
  !key.usages.includes('encrypt');

const parseSealerConfiguration = (input: unknown) => {
  try {
    if (
      input === null ||
      typeof input !== 'object' ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      throw new Error('invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(descriptors).length !== 2 ||
      descriptors.keyId === undefined ||
      descriptors.publicKey === undefined ||
      descriptors.keyId.get !== undefined ||
      descriptors.keyId.set !== undefined ||
      descriptors.publicKey.get !== undefined ||
      descriptors.publicKey.set !== undefined
    ) {
      throw new Error('invalid');
    }
    const keyId = KeyIdSchema.safeParse(descriptors.keyId.value);
    const publicKey = descriptors.publicKey.value as unknown;
    if (!keyId.success || !isPublicEncryptionKey(publicKey)) {
      throw new Error('invalid');
    }
    return Object.freeze({ keyId: keyId.data, publicKey });
  } catch {
    throw new Error('Invitation delivery public key is invalid');
  }
};

export class InvitationDeliverySecretSealer {
  readonly #keyId: string;
  readonly #publicKey: CryptoKey;

  constructor(configuration: {
    readonly keyId: string;
    readonly publicKey: CryptoKey;
  }) {
    const parsed = parseSealerConfiguration(configuration);
    this.#keyId = parsed.keyId;
    this.#publicKey = parsed.publicKey;
  }

  async seal(input: unknown): Promise<InvitationDeliverySecretEnvelope> {
    const callerBytes = ownSecretBytes(input);
    try {
      const request = parseSealRequest(input);
      const ciphertext = await webcrypto.subtle.encrypt(
        { name: 'RSA-OAEP' },
        this.#publicKey,
        request.secret,
      );
      return deepFreeze(
        InvitationDeliverySecretEnvelopeSchema.parse({
          schemaVersion: 1,
          algorithm: 'RSA-OAEP-256',
          keyId: this.#keyId,
          ciphertext: Buffer.from(ciphertext).toString('base64url'),
          bindingHash: bindingHash({
            invitationId: request.binding.invitationId,
            normalizedRecipient: request.binding.recipient,
            role: request.binding.role,
            tokenHash: request.binding.tokenHash,
            templateVersion: request.binding.templateVersion,
          }),
        }),
      );
    } finally {
      callerBytes?.fill(0);
    }
  }
}

const parsePrivateKeyring = (
  input: unknown,
): ReadonlyMap<string, CryptoKey> => {
  try {
    if (
      input === null ||
      typeof input !== 'object' ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      throw new Error('invalid');
    }
    const configuration = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(configuration).length !== 1 ||
      configuration.privateKeys === undefined ||
      configuration.privateKeys.get !== undefined ||
      configuration.privateKeys.set !== undefined ||
      !Array.isArray(configuration.privateKeys.value)
    ) {
      throw new Error('invalid');
    }
    const entries = configuration.privateKeys.value as unknown[];
    if (entries.length < 1 || entries.length > 16) {
      throw new Error('invalid');
    }
    const keyring = new Map<string, CryptoKey>();
    for (const entry of entries) {
      if (
        entry === null ||
        typeof entry !== 'object' ||
        Object.getPrototypeOf(entry) !== Object.prototype
      ) {
        throw new Error('invalid');
      }
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      if (
        Reflect.ownKeys(descriptors).length !== 2 ||
        descriptors.keyId === undefined ||
        descriptors.privateKey === undefined ||
        descriptors.keyId.get !== undefined ||
        descriptors.keyId.set !== undefined ||
        descriptors.privateKey.get !== undefined ||
        descriptors.privateKey.set !== undefined
      ) {
        throw new Error('invalid');
      }
      const keyId = KeyIdSchema.safeParse(descriptors.keyId.value);
      const privateKey = descriptors.privateKey.value as unknown;
      if (
        !keyId.success ||
        !isPrivateDecryptionKey(privateKey) ||
        keyring.has(keyId.data)
      ) {
        throw new Error('invalid');
      }
      keyring.set(keyId.data, privateKey);
    }
    return keyring;
  } catch {
    throw new Error('Invitation delivery private keyring is invalid');
  }
};

const parseOpenRequest = (input: unknown) => {
  try {
    if (
      input === null ||
      typeof input !== 'object' ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null)
    ) {
      throw new Error('invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(descriptors).length !== 2 ||
      descriptors.envelope === undefined ||
      descriptors.binding === undefined ||
      descriptors.envelope.get !== undefined ||
      descriptors.envelope.set !== undefined ||
      descriptors.binding.get !== undefined ||
      descriptors.binding.set !== undefined
    ) {
      throw new Error('invalid');
    }
    const envelope = InvitationDeliverySecretEnvelopeSchema.safeParse(
      descriptors.envelope.value,
    );
    const binding = InvitationDeliverySecretBindingSchema.safeParse(
      descriptors.binding.value,
    );
    if (!envelope.success || !binding.success) {
      throw new Error('invalid');
    }
    return Object.freeze({
      envelope: deepFreeze(envelope.data),
      binding: deepFreeze(binding.data),
    });
  } catch {
    throw new Error(INVALID_ENVELOPE);
  }
};

const decodeCanonicalCiphertext = (value: string): Buffer => {
  const ciphertext = Buffer.from(value, 'base64url');
  if (ciphertext.toString('base64url') !== value) {
    throw new Error(INVALID_ENVELOPE);
  }
  return ciphertext;
};

export class InvitationDeliverySecretOpener implements InvitationDeliverySecretOpeningBoundary {
  readonly #privateKeys: ReadonlyMap<string, CryptoKey>;

  constructor(configuration: {
    readonly privateKeys: readonly {
      readonly keyId: string;
      readonly privateKey: CryptoKey;
    }[];
  }) {
    this.#privateKeys = parsePrivateKeyring(configuration);
  }

  async withOpenedSecret<Result>(
    input: {
      readonly envelope: InvitationDeliverySecretEnvelope;
      readonly binding: InvitationDeliverySecretBinding;
    },
    useSecret: (secret: Uint8Array) => Promise<Result>,
  ): Promise<Result> {
    const request = parseOpenRequest(input);
    const privateKey = this.#privateKeys.get(request.envelope.keyId);
    if (
      privateKey === undefined ||
      !constantTimeDigestMatch(
        request.envelope.bindingHash,
        bindingHash(request.binding),
      ) ||
      typeof useSecret !== 'function'
    ) {
      throw new Error(INVALID_ENVELOPE);
    }

    let secret: Uint8Array | undefined;
    try {
      let plaintext: ArrayBuffer;
      try {
        plaintext = await webcrypto.subtle.decrypt(
          { name: 'RSA-OAEP' },
          privateKey,
          decodeCanonicalCiphertext(request.envelope.ciphertext),
        );
      } catch {
        throw new Error(INVALID_ENVELOPE);
      }
      secret = new Uint8Array(plaintext);
      if (
        !isTokenBytes(secret) ||
        !constantTimeSecretHashMatch(secret, request.binding.tokenHash)
      ) {
        throw new Error(INVALID_ENVELOPE);
      }
      return await useSecret(secret);
    } finally {
      secret?.fill(0);
    }
  }
}
