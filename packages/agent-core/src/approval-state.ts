import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const CHECKPOINT_FORMAT_VERSION = 1 as const;
const MAX_SERIALIZED_STATE_BYTES = 1_048_576;
const MAX_CHECKPOINT_LIFETIME_MS = 10 * 60 * 1000;
const MAX_KEYRING_KEYS = 16;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const KEY_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const CANONICAL_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_SEALED_STATE_CHARACTERS =
  2 +
  1 +
  80 +
  1 +
  16 +
  1 +
  22 +
  1 +
  Math.ceil(((MAX_SERIALIZED_STATE_BYTES + 16) * 4) / 3);

type CheckpointState = 'pending' | 'resumed' | 'cancelled' | 'expired';

const IDENTITY_KEYS = [
  'checkpointId',
  'householdId',
  'userId',
  'runId',
  'agentGraphHash',
  'sdkVersion',
] as const;

export interface ApprovalCheckpointIdentity {
  readonly checkpointId: string;
  readonly householdId: string;
  readonly userId: string;
  readonly runId: string;
  readonly agentGraphHash: string;
  readonly sdkVersion: string;
}

export interface ApprovalCheckpointView extends ApprovalCheckpointIdentity {
  readonly formatVersion: 1;
  readonly revision: number;
  readonly state: CheckpointState;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly updatedAt: string;
}

export interface StoredApprovalCheckpoint extends ApprovalCheckpointView {
  readonly sealedState: string;
}

export interface StagedApprovalCheckpoint {
  readonly checkpoint: ApprovalCheckpointView;
  readonly record: StoredApprovalCheckpoint;
}

interface ApprovalCheckpointAad extends ApprovalCheckpointIdentity {
  readonly formatVersion: 1;
  readonly createdAt: string;
  readonly expiresAt: string;
}

const CIPHER_SECURITY = Object.freeze({
  atRest: 'authenticated-encryption' as const,
  algorithm: 'AES-256-GCM' as const,
  keyRotation: 'versioned-keyring' as const,
});

export interface ApprovalCheckpointCipher {
  readonly security: typeof CIPHER_SECURITY;
  seal(plaintext: string, aad: ApprovalCheckpointAad): Promise<string>;
  open(sealed: string, aad: ApprovalCheckpointAad): Promise<string>;
}

type RepositoryCreateResult =
  'created' | 'already-exists' | 'expired' | 'clock-invalid';

type RepositoryConsumeResult =
  | { readonly status: 'consumed'; readonly record: StoredApprovalCheckpoint }
  | {
      readonly status:
        | 'already-consumed'
        | 'expired'
        | 'mismatch'
        | 'not-found'
        | 'clock-invalid';
    };

export interface ApprovalCheckpointRepository {
  create(record: StoredApprovalCheckpoint): Promise<RepositoryCreateResult>;
  get(checkpointId: string): Promise<StoredApprovalCheckpoint | undefined>;
  consume(input: {
    readonly checkpointId: string;
    readonly expectedRevision: number;
    readonly identity: ApprovalCheckpointIdentity;
  }): Promise<RepositoryConsumeResult>;
  cancel(input: {
    readonly checkpointId: string;
    readonly householdId: string;
    readonly userId: string;
  }): Promise<
    StoredApprovalCheckpoint | 'clock-invalid' | 'mismatch' | 'not-found'
  >;
}

const snapshotDataObject = (
  input: unknown,
  expectedKeys: readonly string[],
  errorCode: string,
): Readonly<Record<string, unknown>> => {
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
    const keys = Reflect.ownKeys(input);
    if (
      keys.length !== expectedKeys.length ||
      !keys.every(
        (key) => typeof key === 'string' && expectedKeys.includes(key),
      )
    ) {
      throw new Error('invalid');
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        throw new Error('invalid');
      }
      snapshot[key] = descriptor.value as unknown;
    }
    return Object.freeze(snapshot);
  } catch {
    throw new Error(errorCode);
  }
};

const assertUuid = (value: string) => {
  if (!UUID_PATTERN.test(value)) throw new Error('invalid-approval-checkpoint');
};

const assertIdentity = (identity: ApprovalCheckpointIdentity) => {
  assertUuid(identity.checkpointId);
  assertUuid(identity.householdId);
  assertUuid(identity.userId);
  assertUuid(identity.runId);
  if (!SHA256_PATTERN.test(identity.agentGraphHash)) {
    throw new Error('invalid-approval-checkpoint');
  }
  if (!SEMVER_PATTERN.test(identity.sdkVersion)) {
    throw new Error('invalid-approval-checkpoint');
  }
};

const identityFromSnapshot = (
  snapshot: Readonly<Record<string, unknown>>,
): Readonly<ApprovalCheckpointIdentity> => {
  if (
    typeof snapshot.checkpointId !== 'string' ||
    typeof snapshot.householdId !== 'string' ||
    typeof snapshot.userId !== 'string' ||
    typeof snapshot.runId !== 'string' ||
    typeof snapshot.agentGraphHash !== 'string' ||
    typeof snapshot.sdkVersion !== 'string'
  ) {
    throw new Error('invalid-approval-checkpoint');
  }
  const identity = Object.freeze({
    checkpointId: snapshot.checkpointId,
    householdId: snapshot.householdId,
    userId: snapshot.userId,
    runId: snapshot.runId,
    agentGraphHash: snapshot.agentGraphHash,
    sdkVersion: snapshot.sdkVersion,
  });
  assertIdentity(identity);
  return identity;
};

const dateToIso = (date: Date): string => {
  if (!Number.isFinite(date.getTime())) {
    throw new Error('invalid-approval-checkpoint');
  }
  return date.toISOString();
};

const assertSerializedState = (serializedState: string) => {
  if (
    serializedState.length === 0 ||
    Buffer.byteLength(serializedState, 'utf8') > MAX_SERIALIZED_STATE_BYTES
  ) {
    throw new Error('invalid-approval-checkpoint');
  }
  try {
    const parsed: unknown = JSON.parse(serializedState);
    if (parsed === null || typeof parsed !== 'object')
      throw new Error('invalid');
  } catch {
    throw new Error('invalid-approval-checkpoint');
  }
};

export type ApprovalCheckpointStatePredicate = (
  state: Readonly<unknown>,
) => boolean | Promise<boolean>;

const parseFrozenCheckpointState = (
  serializedState: string,
): Readonly<unknown> => {
  const parsed: unknown = JSON.parse(serializedState);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('invalid-approval-checkpoint');
  }
  const stack: Array<{ value: object; depth: number }> = [
    { value: parsed, depth: 0 },
  ];
  const objects: object[] = [];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > 16_384 || current.depth > 64) {
      throw new Error('invalid-approval-checkpoint');
    }
    objects.push(current.value);
    for (const nested of Object.values(current.value)) {
      if (nested !== null && typeof nested === 'object') {
        stack.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }
  for (const value of objects.reverse()) Object.freeze(value);
  return parsed;
};

const identityMatches = (
  record: ApprovalCheckpointIdentity,
  identity: ApprovalCheckpointIdentity,
) =>
  record.checkpointId === identity.checkpointId &&
  record.householdId === identity.householdId &&
  record.userId === identity.userId &&
  record.runId === identity.runId &&
  record.agentGraphHash === identity.agentGraphHash &&
  record.sdkVersion === identity.sdkVersion;

const aadFor = (record: StoredApprovalCheckpoint): ApprovalCheckpointAad =>
  Object.freeze({
    formatVersion: record.formatVersion,
    checkpointId: record.checkpointId,
    householdId: record.householdId,
    userId: record.userId,
    runId: record.runId,
    agentGraphHash: record.agentGraphHash,
    sdkVersion: record.sdkVersion,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  });

const cloneRecord = (
  record: StoredApprovalCheckpoint,
): StoredApprovalCheckpoint => Object.freeze({ ...record });

const viewOf = (record: StoredApprovalCheckpoint): ApprovalCheckpointView =>
  Object.freeze({
    formatVersion: record.formatVersion,
    checkpointId: record.checkpointId,
    householdId: record.householdId,
    userId: record.userId,
    runId: record.runId,
    agentGraphHash: record.agentGraphHash,
    sdkVersion: record.sdkVersion,
    revision: record.revision,
    state: record.state,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    updatedAt: record.updatedAt,
  });

const aadBytes = (aad: ApprovalCheckpointAad, keyId: string) =>
  Buffer.from(
    JSON.stringify({
      keyId,
      formatVersion: aad.formatVersion,
      checkpointId: aad.checkpointId,
      householdId: aad.householdId,
      userId: aad.userId,
      runId: aad.runId,
      agentGraphHash: aad.agentGraphHash,
      sdkVersion: aad.sdkVersion,
      createdAt: aad.createdAt,
      expiresAt: aad.expiresAt,
    }),
    'utf8',
  );

const decodeBase64Url = (
  value: string,
  expectedBytes: number | undefined,
  maximumBytes: number,
) => {
  if (
    value.length === 0 ||
    !CANONICAL_BASE64URL_PATTERN.test(value) ||
    value.length > Math.ceil((maximumBytes * 4) / 3)
  ) {
    throw new Error('approval-checkpoint-decryption-failed');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.length > maximumBytes ||
    (expectedBytes !== undefined && decoded.length !== expectedBytes) ||
    decoded.toString('base64url') !== value
  ) {
    decoded.fill(0);
    throw new Error('approval-checkpoint-decryption-failed');
  }
  return decoded;
};

export class AesGcmApprovalCheckpointCipher implements ApprovalCheckpointCipher {
  readonly #keys = new Map<string, Buffer>();
  readonly #activeKeyId: string;
  #disposed = false;

  constructor(input: {
    readonly activeKeyId: string;
    readonly keys: Readonly<Record<string, Uint8Array>>;
  }) {
    const config = snapshotDataObject(
      input,
      ['activeKeyId', 'keys'],
      'invalid-approval-checkpoint-keyring',
    );
    const activeKeyId = config.activeKeyId;
    const rawKeys = config.keys;
    try {
      if (
        typeof activeKeyId !== 'string' ||
        !KEY_ID_PATTERN.test(activeKeyId) ||
        activeKeyId.length > 80 ||
        rawKeys === null ||
        typeof rawKeys !== 'object' ||
        (Object.getPrototypeOf(rawKeys) !== Object.prototype &&
          Object.getPrototypeOf(rawKeys) !== null)
      ) {
        throw new Error('invalid-approval-checkpoint-keyring');
      }
      const descriptors = Object.getOwnPropertyDescriptors(rawKeys);
      const keyIds = Reflect.ownKeys(rawKeys);
      if (keyIds.length === 0 || keyIds.length > MAX_KEYRING_KEYS) {
        throw new Error('invalid-approval-checkpoint-keyring');
      }
      for (const keyId of keyIds) {
        if (
          typeof keyId !== 'string' ||
          !KEY_ID_PATTERN.test(keyId) ||
          keyId.length > 80 ||
          descriptors[keyId]?.get !== undefined ||
          descriptors[keyId]?.set !== undefined
        ) {
          throw new Error('invalid-approval-checkpoint-keyring');
        }
        const key = descriptors[keyId]?.value as unknown;
        if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
          throw new Error('invalid-approval-checkpoint-keyring');
        }
        this.#keys.set(keyId, Buffer.from(key));
      }
      if (!this.#keys.has(activeKeyId)) {
        throw new Error('invalid-approval-checkpoint-keyring');
      }
      this.#activeKeyId = activeKeyId;
    } catch {
      this.dispose();
      throw new Error('invalid-approval-checkpoint-keyring');
    }
  }

  get security(): typeof CIPHER_SECURITY {
    return CIPHER_SECURITY;
  }

  dispose(): void {
    for (const key of this.#keys.values()) key.fill(0);
    this.#keys.clear();
    this.#disposed = true;
  }

  async seal(plaintext: string, aad: ApprovalCheckpointAad): Promise<string> {
    if (this.#disposed) {
      throw new Error('approval-checkpoint-keyring-disposed');
    }
    const key = this.#keys.get(this.#activeKeyId);
    if (key === undefined) {
      throw new Error('approval-checkpoint-encryption-failed');
    }
    if (
      typeof plaintext !== 'string' ||
      plaintext.length === 0 ||
      Buffer.byteLength(plaintext, 'utf8') > MAX_SERIALIZED_STATE_BYTES
    ) {
      throw new Error('approval-checkpoint-encryption-failed');
    }
    const nonce = randomBytes(12);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, nonce, {
        authTagLength: 16,
      });
      cipher.setAAD(aadBytes(aad, this.#activeKeyId));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      try {
        return [
          'v1',
          this.#activeKeyId,
          nonce.toString('base64url'),
          tag.toString('base64url'),
          ciphertext.toString('base64url'),
        ].join('.');
      } finally {
        tag.fill(0);
        ciphertext.fill(0);
      }
    } finally {
      nonce.fill(0);
    }
  }

  async open(sealed: string, aad: ApprovalCheckpointAad): Promise<string> {
    if (this.#disposed) {
      throw new Error('approval-checkpoint-keyring-disposed');
    }
    if (
      typeof sealed !== 'string' ||
      sealed.length === 0 ||
      sealed.length > MAX_SEALED_STATE_CHARACTERS
    ) {
      throw new Error('approval-checkpoint-decryption-failed');
    }
    const ciphertextSeparator = sealed.lastIndexOf('.');
    const tagSeparator = sealed.lastIndexOf('.', ciphertextSeparator - 1);
    const nonceSeparator = sealed.lastIndexOf('.', tagSeparator - 1);
    if (
      !sealed.startsWith('v1.') ||
      nonceSeparator <= 3 ||
      !KEY_ID_PATTERN.test(sealed.slice(3, nonceSeparator)) ||
      sealed.slice(3, nonceSeparator).length > 80
    ) {
      throw new Error('approval-checkpoint-decryption-failed');
    }
    const keyId = sealed.slice(3, nonceSeparator);
    const key = this.#keys.get(keyId);
    if (key === undefined) {
      throw new Error('approval-checkpoint-decryption-failed');
    }
    const nonce = decodeBase64Url(
      sealed.slice(nonceSeparator + 1, tagSeparator),
      12,
      12,
    );
    const tag = decodeBase64Url(
      sealed.slice(tagSeparator + 1, ciphertextSeparator),
      16,
      16,
    );
    const ciphertext = decodeBase64Url(
      sealed.slice(ciphertextSeparator + 1),
      undefined,
      MAX_SERIALIZED_STATE_BYTES + 16,
    );
    const unauthenticatedPlaintext: Buffer[] = [];
    let authenticatedPlaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce, {
        authTagLength: 16,
      });
      decipher.setAAD(aadBytes(aad, keyId));
      decipher.setAuthTag(tag);
      unauthenticatedPlaintext.push(decipher.update(ciphertext));
      unauthenticatedPlaintext.push(decipher.final());
      authenticatedPlaintext = Buffer.concat(unauthenticatedPlaintext);
      return authenticatedPlaintext.toString('utf8');
    } catch {
      throw new Error('approval-checkpoint-decryption-failed');
    } finally {
      for (const chunk of unauthenticatedPlaintext) chunk.fill(0);
      authenticatedPlaintext?.fill(0);
      nonce.fill(0);
      tag.fill(0);
      ciphertext.fill(0);
    }
  }
}

export class ApprovalCheckpointService {
  readonly #repositoryCreate: ApprovalCheckpointRepository['create'];
  readonly #repositoryGet: ApprovalCheckpointRepository['get'];
  readonly #repositoryConsume: ApprovalCheckpointRepository['consume'];
  readonly #repositoryCancel: ApprovalCheckpointRepository['cancel'];
  readonly #seal: ApprovalCheckpointCipher['seal'];
  readonly #open: ApprovalCheckpointCipher['open'];
  readonly #clock: () => Date;

  constructor(
    repository: ApprovalCheckpointRepository,
    cipher: ApprovalCheckpointCipher,
    clock: () => Date = () => new Date(),
  ) {
    if (
      cipher.security.atRest !== 'authenticated-encryption' ||
      cipher.security.algorithm !== 'AES-256-GCM' ||
      cipher.security.keyRotation !== 'versioned-keyring' ||
      typeof clock !== 'function'
    ) {
      throw new Error('invalid-approval-checkpoint-dependency');
    }
    this.#repositoryCreate = repository.create.bind(repository);
    this.#repositoryGet = repository.get.bind(repository);
    this.#repositoryConsume = repository.consume.bind(repository);
    this.#repositoryCancel = repository.cancel.bind(repository);
    this.#seal = cipher.seal.bind(cipher);
    this.#open = cipher.open.bind(cipher);
    this.#clock = clock;
  }

  async stage(
    input: ApprovalCheckpointIdentity & {
      readonly ttlMs: number;
      readonly serializedState: string;
    },
  ): Promise<StagedApprovalCheckpoint> {
    const snapshot = snapshotDataObject(
      input,
      [...IDENTITY_KEYS, 'ttlMs', 'serializedState'],
      'invalid-approval-checkpoint',
    );
    const identity = identityFromSnapshot(snapshot);
    const ttlMs = snapshot.ttlMs;
    const serializedState = snapshot.serializedState;
    if (typeof serializedState !== 'string' || typeof ttlMs !== 'number') {
      throw new Error('invalid-approval-checkpoint');
    }
    assertSerializedState(serializedState);
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > MAX_CHECKPOINT_LIFETIME_MS
    ) {
      throw new Error('invalid-approval-checkpoint');
    }
    const createdDate = new Date(this.#clock());
    const createdAt = dateToIso(createdDate);
    const expiresDate = new Date(createdDate.getTime() + ttlMs);
    const expiresAt = dateToIso(expiresDate);
    const aad: ApprovalCheckpointAad = Object.freeze({
      formatVersion: CHECKPOINT_FORMAT_VERSION,
      ...identity,
      createdAt,
      expiresAt,
    });
    const sealedState = await this.#seal(serializedState, aad);
    const record: StoredApprovalCheckpoint = Object.freeze({
      ...aad,
      revision: 1,
      state: 'pending',
      updatedAt: createdAt,
      sealedState,
    });
    return Object.freeze({
      checkpoint: viewOf(record),
      record,
    });
  }

  async create(
    input: ApprovalCheckpointIdentity & {
      readonly ttlMs: number;
      readonly serializedState: string;
    },
  ): Promise<ApprovalCheckpointView> {
    const staged = await this.stage(input);
    const created = await this.#repositoryCreate(staged.record);
    if (created === 'already-exists') {
      throw new Error('approval-checkpoint-already-exists');
    }
    if (created !== 'created') {
      throw new Error('invalid-approval-checkpoint');
    }
    return staged.checkpoint;
  }

  async consumeForResume(
    input: ApprovalCheckpointIdentity,
    validateDecryptedState?: ApprovalCheckpointStatePredicate,
  ): Promise<
    | Readonly<{
        status: 'resumed';
        serializedState: string;
        checkpoint: ApprovalCheckpointView;
      }>
    | Readonly<{
        status: 'already-consumed' | 'expired' | 'mismatch' | 'not-found';
      }>
  > {
    if (
      validateDecryptedState !== undefined &&
      typeof validateDecryptedState !== 'function'
    ) {
      throw new Error('invalid-approval-checkpoint');
    }
    const validate = validateDecryptedState?.bind(undefined);
    const identity = identityFromSnapshot(
      snapshotDataObject(input, IDENTITY_KEYS, 'invalid-approval-checkpoint'),
    );
    const record = await this.#repositoryGet(identity.checkpointId);
    if (record === undefined) return Object.freeze({ status: 'not-found' });
    if (!identityMatches(record, identity)) {
      return Object.freeze({ status: 'mismatch' });
    }
    if (record.state !== 'pending') {
      return Object.freeze({ status: 'already-consumed' });
    }

    const serializedState = await this.#open(
      record.sealedState,
      aadFor(record),
    );
    assertSerializedState(serializedState);
    if (validate !== undefined) {
      let accepted = false;
      try {
        accepted =
          (await validate(parseFrozenCheckpointState(serializedState))) ===
          true;
      } catch {
        accepted = false;
      }
      if (!accepted) return Object.freeze({ status: 'mismatch' as const });
    }
    const consumed = await this.#repositoryConsume({
      checkpointId: identity.checkpointId,
      expectedRevision: record.revision,
      identity,
    });
    if (consumed.status === 'clock-invalid') {
      throw new Error('approval-checkpoint-clock-invalid');
    }
    if (consumed.status !== 'consumed') {
      return Object.freeze({ status: consumed.status });
    }
    return Object.freeze({
      status: 'resumed' as const,
      serializedState,
      checkpoint: viewOf(consumed.record),
    });
  }

  async cancel(input: {
    readonly checkpointId: string;
    readonly householdId: string;
    readonly userId: string;
  }): Promise<
    ApprovalCheckpointView | Readonly<{ readonly status: 'not-found' }>
  > {
    const snapshot = snapshotDataObject(
      input,
      ['checkpointId', 'householdId', 'userId'],
      'invalid-approval-checkpoint',
    );
    if (
      typeof snapshot.checkpointId !== 'string' ||
      typeof snapshot.householdId !== 'string' ||
      typeof snapshot.userId !== 'string'
    ) {
      throw new Error('invalid-approval-checkpoint');
    }
    assertUuid(snapshot.checkpointId);
    assertUuid(snapshot.householdId);
    assertUuid(snapshot.userId);
    const cancelled = await this.#repositoryCancel({
      checkpointId: snapshot.checkpointId,
      householdId: snapshot.householdId,
      userId: snapshot.userId,
    });
    if (cancelled === 'clock-invalid') {
      throw new Error('approval-checkpoint-clock-invalid');
    }
    if (cancelled === 'not-found') {
      return Object.freeze({ status: 'not-found' as const });
    }
    if (cancelled === 'mismatch') {
      throw new Error(`approval-checkpoint-${cancelled}`);
    }
    return viewOf(cancelled);
  }
}

export class InMemoryApprovalCheckpointRepository implements ApprovalCheckpointRepository {
  readonly #records = new Map<string, StoredApprovalCheckpoint>();
  readonly #clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    if (typeof clock !== 'function') {
      throw new Error('invalid-approval-checkpoint-dependency');
    }
    this.#clock = clock;
  }

  #now(record: StoredApprovalCheckpoint): Date | undefined {
    const now = new Date(this.#clock());
    if (
      !Number.isFinite(now.getTime()) ||
      now.getTime() < Date.parse(record.createdAt)
    ) {
      return undefined;
    }
    return now;
  }

  async create(
    record: StoredApprovalCheckpoint,
  ): Promise<RepositoryCreateResult> {
    if (this.#records.has(record.checkpointId)) return 'already-exists';
    const now = this.#now(record);
    if (now === undefined) return 'clock-invalid';
    if (now.getTime() >= Date.parse(record.expiresAt)) return 'expired';
    this.#records.set(record.checkpointId, cloneRecord(record));
    return 'created';
  }

  async get(
    checkpointId: string,
  ): Promise<StoredApprovalCheckpoint | undefined> {
    const record = this.#records.get(checkpointId);
    return record === undefined ? undefined : cloneRecord(record);
  }

  async consume(input: {
    readonly checkpointId: string;
    readonly expectedRevision: number;
    readonly identity: ApprovalCheckpointIdentity;
  }): Promise<RepositoryConsumeResult> {
    const record = this.#records.get(input.checkpointId);
    if (record === undefined) return { status: 'not-found' };
    if (!identityMatches(record, input.identity)) return { status: 'mismatch' };
    if (record.state !== 'pending') return { status: 'already-consumed' };
    if (record.revision !== input.expectedRevision)
      return { status: 'mismatch' };
    const now = this.#now(record);
    if (now === undefined) return { status: 'clock-invalid' };
    const expired = now.getTime() >= Date.parse(record.expiresAt);
    const next = cloneRecord({
      ...record,
      revision: record.revision + 1,
      state: expired ? 'expired' : 'resumed',
      updatedAt: now.toISOString(),
    });
    this.#records.set(record.checkpointId, next);
    return expired
      ? { status: 'expired' }
      : { status: 'consumed', record: next };
  }

  async cancel(input: {
    readonly checkpointId: string;
    readonly householdId: string;
    readonly userId: string;
  }): Promise<
    StoredApprovalCheckpoint | 'clock-invalid' | 'mismatch' | 'not-found'
  > {
    const record = this.#records.get(input.checkpointId);
    if (record === undefined) return 'not-found';
    if (
      record.householdId !== input.householdId ||
      record.userId !== input.userId
    ) {
      return 'mismatch';
    }
    if (record.state === 'cancelled' || record.state === 'expired') {
      return cloneRecord(record);
    }
    if (record.state !== 'pending') return 'mismatch';
    const now = this.#now(record);
    if (now === undefined) return 'clock-invalid';
    const next = cloneRecord({
      ...record,
      revision: record.revision + 1,
      state:
        now.getTime() >= Date.parse(record.expiresAt) ? 'expired' : 'cancelled',
      updatedAt: now.toISOString(),
    });
    this.#records.set(record.checkpointId, next);
    return next;
  }
}
