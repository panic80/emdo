import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';

import {
  IdentifierSchema,
  SchemaVersionSchema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly,
} from '@emdo/contracts';
import { z } from 'zod';

const SyncRoleSchema = z.enum(['owner', 'member']);

const SyncSpaceClaimSchema = z.strictObject({
  id: UuidSchema,
  visibility: z.enum(['private', 'shared']),
  originalOwnerUserId: UuidSchema,
});

const ResolvedSyncAccessSchema = z.strictObject({
  userId: UuidSchema,
  householdId: UuidSchema,
  role: SyncRoleSchema,
  schemaVersion: SchemaVersionSchema,
  spaces: z.array(SyncSpaceClaimSchema).min(1).max(256),
});

const SyncTokenIssueInputSchema = z.strictObject({
  sessionId: UuidSchema,
  clientId: UuidSchema,
});

const SyncTokenHeaderSchema = z.strictObject({
  alg: z.literal('RS256'),
  typ: z.literal('JWT'),
  kid: IdentifierSchema,
});

const SyncTokenClaimsBaseSchema = z.strictObject({
  iss: z.string().trim().min(1).max(512),
  aud: z.string().trim().min(1).max(160),
  sub: UuidSchema,
  jti: UuidSchema,
  iat: z.number().int().nonnegative().safe(),
  exp: z.number().int().positive().safe(),
  userId: UuidSchema,
  clientId: UuidSchema,
  householdId: UuidSchema,
  role: SyncRoleSchema,
  schemaVersion: SchemaVersionSchema,
  spaces: z.array(SyncSpaceClaimSchema).min(1).max(256),
});

export type SyncTokenClaims = DeepReadonly<
  z.infer<typeof SyncTokenClaimsBaseSchema>
>;

export interface ResolvedSyncAccess {
  readonly userId: string;
  readonly householdId: string;
  readonly role: 'owner' | 'member';
  readonly schemaVersion: 1;
  readonly spaces: readonly {
    readonly id: string;
    readonly visibility: 'private' | 'shared';
    readonly originalOwnerUserId: string;
  }[];
}

export interface SyncAccessRepository {
  resolveSyncAccess(input: {
    readonly sessionId: string;
    readonly clientId: string;
  }): Promise<ResolvedSyncAccess | undefined>;
}

export interface SyncTokenClock {
  now(): Date;
}

type CryptoKey = KeyObject | string | Buffer;

export const SYNC_TOKEN_AUDIENCE = 'emdo-powersync' as const;
export const SYNC_TOKEN_TTL_SECONDS = 300 as const;

export type SyncTokenErrorCode =
  | 'invalid-configuration'
  | 'scope-unavailable'
  | 'invalid-scope'
  | 'invalid-token'
  | 'unknown-key'
  | 'invalid-signature'
  | 'not-active'
  | 'expired';

export class SyncTokenError extends Error {
  constructor(
    readonly code: SyncTokenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SyncTokenError';
  }
}

export interface SyncTokenServiceOptions {
  readonly issuer: string;
  readonly audience?: typeof SYNC_TOKEN_AUDIENCE;
  readonly keyId: string;
  readonly privateKey: CryptoKey;
  readonly verificationKeys: ReadonlyMap<string, CryptoKey>;
  readonly repository: SyncAccessRepository;
  readonly clock: SyncTokenClock;
  readonly ttlSeconds: number;
  readonly maximumTtlSeconds: number;
  readonly clockSkewSeconds?: number;
  readonly idFactory?: () => string;
}

const encodeJson = (value: unknown) =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const decodeJson = (segment: string): unknown => {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new SyncTokenError('invalid-token', 'Sync token is not valid JSON');
  }
};

const isCanonicalBase64Url = (segment: string, maximumLength: number) => {
  if (
    segment.length === 0 ||
    segment.length > maximumLength ||
    !/^[A-Za-z0-9_-]+$/u.test(segment)
  ) {
    return false;
  }
  try {
    return Buffer.from(segment, 'base64url').toString('base64url') === segment;
  } catch {
    return false;
  }
};

const assertValidScope = (
  input: unknown,
): z.infer<typeof ResolvedSyncAccessSchema> => {
  const parsed = ResolvedSyncAccessSchema.safeParse(input);
  if (!parsed.success) {
    throw new SyncTokenError(
      'invalid-scope',
      'Server-side sync access state is malformed',
    );
  }

  const seen = new Set<string>();
  for (const space of parsed.data.spaces) {
    if (seen.has(space.id)) {
      throw new SyncTokenError(
        'invalid-scope',
        'Server-side sync access contains a duplicate space',
      );
    }
    seen.add(space.id);
    if (
      space.visibility === 'private' &&
      space.originalOwnerUserId !== parsed.data.userId
    ) {
      throw new SyncTokenError(
        'invalid-scope',
        'A private sync space must belong to the authenticated user',
      );
    }
  }

  return parsed.data;
};

export class SyncTokenService {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly keyId: string;
  private readonly privateKey: KeyObject;
  private readonly verificationKeys: ReadonlyMap<string, KeyObject>;
  private readonly publicJwks: DeepReadonly<{
    keys: {
      kid: string;
      kty: 'RSA';
      alg: 'RS256';
      use: 'sig';
      n: string;
      e: string;
    }[];
  }>;
  private readonly repository: SyncAccessRepository;
  private readonly clock: SyncTokenClock;
  private readonly ttlSeconds: number;
  private readonly maximumTtlSeconds: number;
  private readonly clockSkewSeconds: number;
  private readonly idFactory: () => string;

  constructor(options: SyncTokenServiceOptions) {
    const issuer = z
      .url()
      .max(512)
      .refine((value) => new URL(value).protocol === 'https:')
      .safeParse(options.issuer);
    const audience = options.audience ?? SYNC_TOKEN_AUDIENCE;
    const keyId = IdentifierSchema.safeParse(options.keyId);
    const clockSkewSeconds = options.clockSkewSeconds ?? 5;
    if (
      !issuer.success ||
      audience !== SYNC_TOKEN_AUDIENCE ||
      !keyId.success ||
      !Number.isSafeInteger(options.ttlSeconds) ||
      options.ttlSeconds <= 0 ||
      !Number.isSafeInteger(options.maximumTtlSeconds) ||
      options.maximumTtlSeconds <= 0 ||
      options.maximumTtlSeconds > SYNC_TOKEN_TTL_SECONDS ||
      options.ttlSeconds > options.maximumTtlSeconds ||
      !Number.isSafeInteger(clockSkewSeconds) ||
      clockSkewSeconds < 0 ||
      clockSkewSeconds > 60 ||
      !options.verificationKeys.has(options.keyId)
    ) {
      throw new SyncTokenError(
        'invalid-configuration',
        'Sync token service configuration is invalid',
      );
    }

    let privateKey: KeyObject;
    const verificationKeys = new Map<string, KeyObject>();
    const publicJwks: {
      kid: string;
      kty: 'RSA';
      alg: 'RS256';
      use: 'sig';
      n: string;
      e: string;
    }[] = [];
    try {
      privateKey =
        options.privateKey instanceof KeyObject
          ? options.privateKey
          : createPrivateKey(options.privateKey);
      if (
        privateKey.type !== 'private' ||
        privateKey.asymmetricKeyType !== 'rsa' ||
        (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      ) {
        throw new Error('not an RSA private key');
      }
      if (
        options.verificationKeys.size === 0 ||
        options.verificationKeys.size > 16
      ) {
        throw new Error('invalid key count');
      }
      for (const [candidateKeyId, candidateKey] of options.verificationKeys) {
        const parsedCandidateKeyId = IdentifierSchema.parse(candidateKeyId);
        const publicKey =
          candidateKey instanceof KeyObject && candidateKey.type === 'public'
            ? candidateKey
            : createPublicKey(candidateKey);
        if (
          publicKey.asymmetricKeyType !== 'rsa' ||
          (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
        ) {
          throw new Error('not a strong RSA key');
        }
        const exported = publicKey.export({ format: 'jwk' });
        if (
          exported.kty !== 'RSA' ||
          typeof exported.n !== 'string' ||
          typeof exported.e !== 'string'
        ) {
          throw new Error('invalid public JWK');
        }
        verificationKeys.set(parsedCandidateKeyId, publicKey);
        publicJwks.push({
          kid: parsedCandidateKeyId,
          kty: 'RSA',
          alg: 'RS256',
          use: 'sig',
          n: exported.n,
          e: exported.e,
        });
      }
      const activeVerificationKey = verificationKeys.get(options.keyId);
      if (activeVerificationKey === undefined)
        throw new Error('missing active key');
      const probe = Buffer.from('emdo-sync-key-pair-check', 'utf8');
      if (
        !verify(
          'RSA-SHA256',
          probe,
          activeVerificationKey,
          sign('RSA-SHA256', probe, privateKey),
        )
      ) {
        throw new Error('active key pair mismatch');
      }
    } catch {
      throw new SyncTokenError(
        'invalid-configuration',
        'Sync token service requires a matching RSA signing key and public verification keys',
      );
    }

    this.issuer = issuer.data;
    this.audience = audience;
    this.keyId = keyId.data;
    this.privateKey = privateKey;
    this.verificationKeys = verificationKeys;
    this.publicJwks = deepFreeze({
      keys: publicJwks.sort((left, right) => left.kid.localeCompare(right.kid)),
    });
    this.repository = options.repository;
    this.clock = options.clock;
    this.ttlSeconds = options.ttlSeconds;
    this.maximumTtlSeconds = options.maximumTtlSeconds;
    this.clockSkewSeconds = clockSkewSeconds;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async issue(input: {
    readonly sessionId: string;
    readonly clientId: string;
  }) {
    const parsedInput = SyncTokenIssueInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new SyncTokenError(
        'scope-unavailable',
        'A valid authenticated session and registered client are required',
      );
    }

    const resolved = await this.repository.resolveSyncAccess(parsedInput.data);
    if (resolved === undefined) {
      throw new SyncTokenError(
        'scope-unavailable',
        'Sync access is unavailable for this session and client',
      );
    }
    const access = assertValidScope(resolved);
    let nowSeconds: number;
    try {
      nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    } catch {
      nowSeconds = Number.NaN;
    }
    if (!Number.isSafeInteger(nowSeconds)) {
      throw new SyncTokenError(
        'invalid-configuration',
        'Sync token clock returned an invalid time',
      );
    }

    const tokenId = UuidSchema.safeParse(this.idFactory());
    if (!tokenId.success) {
      throw new SyncTokenError(
        'invalid-configuration',
        'Sync token ID factory returned an invalid ID',
      );
    }
    const claims = SyncTokenClaimsBaseSchema.parse({
      iss: this.issuer,
      aud: this.audience,
      sub: access.userId,
      jti: tokenId.data,
      iat: nowSeconds,
      exp: nowSeconds + this.ttlSeconds,
      userId: access.userId,
      clientId: parsedInput.data.clientId,
      householdId: access.householdId,
      role: access.role,
      schemaVersion: access.schemaVersion,
      spaces: access.spaces,
    });
    const header = {
      alg: 'RS256' as const,
      typ: 'JWT' as const,
      kid: this.keyId,
    };
    const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
    const signature = sign(
      'RSA-SHA256',
      Buffer.from(signingInput, 'ascii'),
      this.privateKey,
    ).toString('base64url');
    const frozenClaims = deepFreeze(claims);

    return deepFreeze({
      token: `${signingInput}.${signature}`,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      claims: frozenClaims,
    });
  }

  verify(token: string): SyncTokenClaims {
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > 32_768
    ) {
      throw new SyncTokenError('invalid-token', 'Sync token is malformed');
    }
    const segments = token.split('.');
    if (
      segments.length !== 3 ||
      segments.some((segment) => segment.length === 0)
    ) {
      throw new SyncTokenError('invalid-token', 'Sync token is malformed');
    }
    const [headerSegment, claimsSegment, signatureSegment] = segments as [
      string,
      string,
      string,
    ];
    if (
      !isCanonicalBase64Url(headerSegment, 2_048) ||
      !isCanonicalBase64Url(claimsSegment, 24_576)
    ) {
      throw new SyncTokenError('invalid-token', 'Sync token is malformed');
    }
    if (!isCanonicalBase64Url(signatureSegment, 4_096)) {
      throw new SyncTokenError(
        'invalid-signature',
        'Sync token signature is malformed',
      );
    }
    const parsedHeader = SyncTokenHeaderSchema.safeParse(
      decodeJson(headerSegment),
    );
    if (!parsedHeader.success) {
      throw new SyncTokenError('invalid-token', 'Sync token header is invalid');
    }
    const verificationKey = this.verificationKeys.get(parsedHeader.data.kid);
    if (verificationKey === undefined) {
      throw new SyncTokenError('unknown-key', 'Sync token key is unavailable');
    }

    let signature: Buffer;
    try {
      signature = Buffer.from(signatureSegment, 'base64url');
    } catch {
      throw new SyncTokenError(
        'invalid-signature',
        'Sync token signature is malformed',
      );
    }
    const signingInput = `${headerSegment}.${claimsSegment}`;
    if (
      !verify(
        'RSA-SHA256',
        Buffer.from(signingInput, 'ascii'),
        verificationKey,
        signature,
      )
    ) {
      throw new SyncTokenError(
        'invalid-signature',
        'Sync token signature is invalid',
      );
    }

    const parsedClaims = SyncTokenClaimsBaseSchema.safeParse(
      decodeJson(claimsSegment),
    );
    if (!parsedClaims.success) {
      throw new SyncTokenError(
        'invalid-token',
        'Sync token claims are invalid',
      );
    }
    const claims = parsedClaims.data;
    if (
      claims.iss !== this.issuer ||
      claims.aud !== this.audience ||
      claims.sub !== claims.userId ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > this.maximumTtlSeconds
    ) {
      throw new SyncTokenError(
        'invalid-token',
        'Sync token claims are invalid',
      );
    }
    assertValidScope({
      userId: claims.userId,
      householdId: claims.householdId,
      role: claims.role,
      schemaVersion: claims.schemaVersion,
      spaces: claims.spaces,
    });

    let nowSeconds: number;
    try {
      nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    } catch {
      nowSeconds = Number.NaN;
    }
    if (!Number.isSafeInteger(nowSeconds)) {
      throw new SyncTokenError(
        'invalid-configuration',
        'Sync token clock returned an invalid time',
      );
    }
    if (claims.iat > nowSeconds + this.clockSkewSeconds) {
      throw new SyncTokenError('not-active', 'Sync token is not active yet');
    }
    if (claims.exp <= nowSeconds) {
      throw new SyncTokenError('expired', 'Sync token has expired');
    }

    return deepFreeze(claims);
  }

  getPublicJwks() {
    return this.publicJwks;
  }
}
