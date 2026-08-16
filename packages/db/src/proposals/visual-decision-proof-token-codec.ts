import { Buffer } from 'node:buffer';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import {
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
} from '@emdo/contracts';
import { z } from 'zod';

const MINIMUM_KEY_BYTES = 32;
const MAXIMUM_KEY_BYTES = 64;
const MAXIMUM_PREVIOUS_KEYS = 2;
const MAXIMUM_PROOF_LIFETIME_MS = 120_000;
const KEY_ROTATION_CLOCK_SKEW_MS = 30_000;
const MINIMUM_PREVIOUS_KEY_DRAIN_MS =
  MAXIMUM_PROOF_LIFETIME_MS + KEY_ROTATION_CLOCK_SKEW_MS;

const KeyIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);
const NonceSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const BindingSchema = z
  .strictObject({
    bindingVersion: z.number().int().positive().safe(),
    issuanceFingerprint: Sha256Schema,
    authorizationScopeFingerprint: Sha256Schema,
    initialRequestId: UuidSchema,
    issuedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    userId: UuidSchema,
    sessionId: UuidSchema,
    householdId: UuidSchema,
    proposalId: UuidSchema,
    proposalVersion: z.number().int().positive().safe(),
    payloadHash: Sha256Schema,
    approvalHash: Sha256Schema,
    channel: z.literal('authenticated-visual'),
    idempotencyKey: IdempotencyKeySchema,
  })
  .superRefine((value, context) => {
    const lifetime = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
    if (lifetime <= 0 || lifetime > 120_000) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Visual proof token binding lifetime is invalid',
      });
    }
  });
const SeedSchema = z.strictObject({
  proofId: UuidSchema,
  nonce: NonceSchema,
  keyId: KeyIdSchema,
});
const StoredMaterialSchema = z.strictObject({
  proofId: UuidSchema,
  nonce: NonceSchema,
  keyId: KeyIdSchema,
  tokenHash: Sha256Schema,
});
const ProofTokenSchema = z
  .string()
  .min(32)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u);

export interface VisualDecisionProofTokenBinding {
  readonly bindingVersion: number;
  readonly issuanceFingerprint: string;
  readonly authorizationScopeFingerprint: string;
  readonly initialRequestId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly householdId: string;
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly payloadHash: string;
  readonly approvalHash: string;
  readonly channel: 'authenticated-visual';
  readonly idempotencyKey: string;
}

export interface VisualDecisionProofTokenSeed {
  readonly proofId: string;
  readonly nonce: string;
  readonly keyId: string;
}

export interface VisualDecisionProofStoredTokenMaterial {
  readonly proofId: string;
  readonly nonce: string;
  readonly keyId: string;
  readonly tokenHash: string;
}

export interface VisualDecisionProofCreatedTokenMaterial extends VisualDecisionProofStoredTokenMaterial {
  readonly proofToken: string;
}

export interface VisualDecisionProofHmacKey {
  readonly keyId: string;
  readonly secret: Uint8Array;
}

export interface VisualDecisionProofPreviousHmacKey extends VisualDecisionProofHmacKey {
  readonly issueUntil: string;
  readonly verifyUntil: string;
}

export class VisualDecisionProofTokenCodecError extends Error {
  constructor(
    readonly code:
      | 'invalid-config'
      | 'invalid-input'
      | 'key-unavailable'
      | 'integrity-check-failed',
    message: string,
  ) {
    super(message);
    this.name = 'VisualDecisionProofTokenCodecError';
  }
}

interface InternalKey {
  readonly keyId: string;
  readonly secret: Uint8Array;
  readonly issueUntil?: number;
  readonly verifyUntil?: number;
}

const parseSecret = (secret: Uint8Array): Uint8Array => {
  if (
    !(secret instanceof Uint8Array) ||
    secret.byteLength < MINIMUM_KEY_BYTES ||
    secret.byteLength > MAXIMUM_KEY_BYTES
  ) {
    throw new VisualDecisionProofTokenCodecError(
      'invalid-config',
      'Visual proof HMAC keys must contain 32 to 64 bytes',
    );
  }
  return new Uint8Array(secret);
};

const parseKeyId = (keyId: string): string => {
  const parsed = KeyIdSchema.safeParse(keyId);
  if (!parsed.success) {
    throw new VisualDecisionProofTokenCodecError(
      'invalid-config',
      'Visual proof HMAC key ID is malformed',
    );
  }
  return parsed.data;
};

const canonicalMessage = (
  material: Pick<
    VisualDecisionProofStoredTokenMaterial,
    'proofId' | 'nonce' | 'keyId'
  >,
  binding: z.output<typeof BindingSchema>,
): string =>
  JSON.stringify([
    'emdo.visual-decision-proof.v1',
    material.keyId,
    material.proofId,
    material.nonce,
    binding.bindingVersion,
    binding.issuanceFingerprint,
    binding.authorizationScopeFingerprint,
    binding.initialRequestId,
    binding.issuedAt,
    binding.expiresAt,
    binding.userId,
    binding.sessionId,
    binding.householdId,
    binding.proposalId,
    binding.proposalVersion,
    binding.payloadHash,
    binding.approvalHash,
    binding.channel,
    binding.idempotencyKey,
  ]);

const deriveToken = (
  key: InternalKey,
  material: Pick<
    VisualDecisionProofStoredTokenMaterial,
    'proofId' | 'nonce' | 'keyId'
  >,
  binding: z.output<typeof BindingSchema>,
): { readonly proofToken: string; readonly tokenHash: string } => {
  const authenticationCode = createHmac('sha256', key.secret)
    .update(canonicalMessage(material, binding), 'utf8')
    .digest('base64url');
  const proofToken = Buffer.from(
    JSON.stringify([
      1,
      material.keyId,
      material.proofId,
      material.nonce,
      authenticationCode,
    ]),
    'utf8',
  ).toString('base64url');
  const parsedToken = ProofTokenSchema.safeParse(proofToken);
  if (!parsedToken.success) {
    throw new VisualDecisionProofTokenCodecError(
      'invalid-input',
      'Derived visual proof token is outside its public contract',
    );
  }
  return {
    proofToken: parsedToken.data,
    tokenHash: createHash('sha256').update(parsedToken.data).digest('hex'),
  };
};

export class VisualDecisionProofTokenCodec {
  readonly #current: InternalKey;
  readonly #previous: ReadonlyMap<string, InternalKey>;
  readonly #clock: () => Date;
  readonly #generateProofId: () => string;
  readonly #generateNonce: () => string;

  constructor(options: {
    readonly current: VisualDecisionProofHmacKey;
    readonly previous?: readonly VisualDecisionProofPreviousHmacKey[];
    readonly clock?: () => Date;
    readonly generateProofId?: () => string;
    readonly generateNonce?: () => string;
  }) {
    this.#clock = options.clock ?? (() => new Date());
    this.#generateProofId = options.generateProofId ?? randomUUID;
    this.#generateNonce =
      options.generateNonce ?? (() => randomBytes(32).toString('base64url'));
    const now = this.#clock().getTime();
    if (!Number.isFinite(now)) {
      throw new VisualDecisionProofTokenCodecError(
        'invalid-config',
        'Visual proof HMAC clock is invalid',
      );
    }
    this.#current = {
      keyId: parseKeyId(options.current.keyId),
      secret: parseSecret(options.current.secret),
    };
    const previous = options.previous ?? [];
    if (previous.length > MAXIMUM_PREVIOUS_KEYS) {
      throw new VisualDecisionProofTokenCodecError(
        'invalid-config',
        'Visual proof HMAC key ring has too many previous keys',
      );
    }
    const parsedPrevious = new Map<string, InternalKey>();
    for (const candidate of previous) {
      const keyId = parseKeyId(candidate.keyId);
      const issueUntil = Date.parse(candidate.issueUntil);
      const verifyUntil = Date.parse(candidate.verifyUntil);
      if (
        keyId === this.#current.keyId ||
        parsedPrevious.has(keyId) ||
        !Number.isFinite(issueUntil) ||
        !Number.isFinite(verifyUntil) ||
        verifyUntil <= now ||
        verifyUntil - issueUntil < MINIMUM_PREVIOUS_KEY_DRAIN_MS
      ) {
        throw new VisualDecisionProofTokenCodecError(
          'invalid-config',
          'Visual proof previous key is ambiguous or outside its drain window',
        );
      }
      parsedPrevious.set(keyId, {
        keyId,
        secret: parseSecret(candidate.secret),
        issueUntil,
        verifyUntil,
      });
    }
    this.#previous = parsedPrevious;
  }

  create(
    bindingInput: VisualDecisionProofTokenBinding,
  ): Readonly<VisualDecisionProofCreatedTokenMaterial> {
    return this.derive(this.createSeed(), bindingInput);
  }

  createSeed(): Readonly<VisualDecisionProofTokenSeed> {
    const proofId = UuidSchema.safeParse(this.#generateProofId());
    const nonce = NonceSchema.safeParse(this.#generateNonce());
    if (!proofId.success || !nonce.success) {
      throw new VisualDecisionProofTokenCodecError(
        'invalid-input',
        'Generated visual proof token seed is malformed',
      );
    }
    return deepFreeze({
      proofId: proofId.data,
      nonce: nonce.data,
      keyId: this.#current.keyId,
    });
  }

  derive(
    seedInput: VisualDecisionProofTokenSeed,
    bindingInput: VisualDecisionProofTokenBinding,
  ): Readonly<VisualDecisionProofCreatedTokenMaterial> {
    const binding = BindingSchema.safeParse(bindingInput);
    const seed = SeedSchema.safeParse(seedInput);
    if (!binding.success || !seed.success) {
      throw new VisualDecisionProofTokenCodecError(
        'invalid-input',
        'Visual proof token binding or seed is malformed',
      );
    }
    if (seed.data.keyId !== this.#current.keyId) {
      throw new VisualDecisionProofTokenCodecError(
        'key-unavailable',
        'Only the current visual proof key may issue bearer material',
      );
    }
    return deepFreeze({
      ...seed.data,
      ...deriveToken(this.#current, seed.data, binding.data),
    });
  }

  reproduce(
    materialInput: VisualDecisionProofStoredTokenMaterial,
    bindingInput: VisualDecisionProofTokenBinding,
  ): string {
    const material = StoredMaterialSchema.safeParse(materialInput);
    const binding = BindingSchema.safeParse(bindingInput);
    if (!material.success || !binding.success) {
      throw new VisualDecisionProofTokenCodecError(
        'invalid-input',
        'Stored visual proof material or binding is malformed',
      );
    }
    const key = this.#resolveKey(
      material.data.keyId,
      Date.parse(binding.data.issuedAt),
    );
    const derived = deriveToken(key, material.data, binding.data);
    const expectedHash = Buffer.from(material.data.tokenHash, 'hex');
    const actualHash = Buffer.from(derived.tokenHash, 'hex');
    if (
      expectedHash.byteLength !== actualHash.byteLength ||
      !timingSafeEqual(expectedHash, actualHash)
    ) {
      throw new VisualDecisionProofTokenCodecError(
        'integrity-check-failed',
        'Stored visual proof digest does not match its deterministic token',
      );
    }
    return derived.proofToken;
  }

  #resolveKey(keyId: string, issuedAt: number): InternalKey {
    const key =
      keyId === this.#current.keyId ? this.#current : this.#previous.get(keyId);
    const now = this.#clock().getTime();
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(issuedAt) ||
      key === undefined ||
      (key.issueUntil !== undefined &&
        (!Number.isFinite(key.issueUntil) || issuedAt > key.issueUntil)) ||
      (key.verifyUntil !== undefined &&
        (!Number.isFinite(key.verifyUntil) || now >= key.verifyUntil))
    ) {
      throw new VisualDecisionProofTokenCodecError(
        'key-unavailable',
        'Visual proof HMAC key is unavailable or retired',
      );
    }
    return key;
  }
}
