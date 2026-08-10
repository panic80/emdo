import { createHash, randomBytes, randomUUID } from 'node:crypto';

export interface RotatingSessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly rotation: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt?: Date;
}

export interface RotatingSessionRepository {
  create(record: RotatingSessionRecord): Promise<void>;
  get(id: string): Promise<RotatingSessionRecord | undefined>;
  findByHash(hash: string): Promise<RotatingSessionRecord | undefined>;
  rotate(
    id: string,
    expectedHash: string,
    nextHash: string,
    expiresAt: Date,
  ): Promise<RotatingSessionRecord | undefined>;
  revoke(id: string, expectedHash: string, revokedAt: Date): Promise<boolean>;
}

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

const finiteDateValue = (date: Date, name: string): number => {
  const value = date.getTime();
  if (!Number.isFinite(value))
    throw new TypeError(`${name} must be a valid date`);
  return value;
};

const cloneRecord = (record: RotatingSessionRecord): RotatingSessionRecord =>
  Object.freeze({
    ...record,
    createdAt: new Date(record.createdAt),
    expiresAt: new Date(record.expiresAt),
    ...(record.revokedAt === undefined
      ? {}
      : { revokedAt: new Date(record.revokedAt) }),
  });

export class RotatingSessionService {
  constructor(private readonly repository: RotatingSessionRepository) {}

  async issue(input: {
    readonly userId: string;
    readonly now: Date;
    readonly expiresAt: Date;
  }) {
    if (input.userId.trim().length === 0) {
      throw new TypeError('Session user id is required');
    }
    const nowMs = finiteDateValue(input.now, 'Session issue time');
    const expiresAtMs = finiteDateValue(input.expiresAt, 'Session expiry');
    if (expiresAtMs <= nowMs) throw new Error('Session expiry is invalid');
    const token = newToken();
    const session = Object.freeze({
      id: randomUUID(),
      userId: input.userId,
      tokenHash: hashToken(token),
      rotation: 0,
      createdAt: new Date(input.now),
      expiresAt: new Date(input.expiresAt),
    });
    await this.repository.create(session);
    return Object.freeze({ session: cloneRecord(session), token });
  }

  async authenticate(token: string, now: Date) {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) return undefined;
    const session = await this.repository.findByHash(hashToken(token));
    if (
      session === undefined ||
      session.revokedAt !== undefined ||
      !Number.isFinite(session.expiresAt.getTime()) ||
      session.expiresAt.getTime() <= nowMs
    ) {
      return undefined;
    }
    return session;
  }

  async rotate(input: {
    readonly token: string;
    readonly now: Date;
    readonly expiresAt: Date;
  }) {
    const nowMs = finiteDateValue(input.now, 'Session rotation time');
    const expiresAtMs = finiteDateValue(input.expiresAt, 'Session expiry');
    const currentHash = hashToken(input.token);
    const current = await this.repository.findByHash(currentHash);
    if (
      current === undefined ||
      current.revokedAt !== undefined ||
      !Number.isFinite(current.expiresAt.getTime()) ||
      current.expiresAt.getTime() <= nowMs ||
      expiresAtMs <= nowMs
    ) {
      throw new Error('Session is not rotatable');
    }
    const token = newToken();
    const session = await this.repository.rotate(
      current.id,
      currentHash,
      hashToken(token),
      input.expiresAt,
    );
    if (session === undefined) throw new Error('Session rotation lost a race');
    return Object.freeze({ session: cloneRecord(session), token });
  }

  async revoke(token: string, now: Date): Promise<boolean> {
    finiteDateValue(now, 'Session revocation time');
    const session = await this.repository.findByHash(hashToken(token));
    if (session === undefined || session.revokedAt !== undefined) {
      return false;
    }
    return this.repository.revoke(session.id, session.tokenHash, now);
  }
}

export class InMemorySessionRepository implements RotatingSessionRepository {
  private readonly records = new Map<string, RotatingSessionRecord>();

  async create(record: RotatingSessionRecord) {
    if (this.records.has(record.id)) throw new Error('Duplicate session');
    this.records.set(record.id, cloneRecord(record));
  }
  async get(id: string) {
    const record = this.records.get(id);
    return record === undefined ? undefined : cloneRecord(record);
  }
  async findByHash(hash: string) {
    const record = [...this.records.values()].find(
      (candidate) => candidate.tokenHash === hash,
    );
    return record === undefined ? undefined : cloneRecord(record);
  }
  async rotate(
    id: string,
    expectedHash: string,
    nextHash: string,
    expiresAt: Date,
  ) {
    const current = this.records.get(id);
    if (
      current === undefined ||
      current.tokenHash !== expectedHash ||
      current.revokedAt !== undefined
    )
      return undefined;
    const next = Object.freeze({
      ...current,
      tokenHash: nextHash,
      rotation: current.rotation + 1,
      expiresAt: new Date(expiresAt),
    });
    this.records.set(id, next);
    return cloneRecord(next);
  }
  async revoke(id: string, expectedHash: string, revokedAt: Date) {
    const current = this.records.get(id);
    if (
      current === undefined ||
      current.tokenHash !== expectedHash ||
      current.revokedAt !== undefined
    ) {
      return false;
    }
    this.records.set(
      id,
      Object.freeze({ ...current, revokedAt: new Date(revokedAt) }),
    );
    return true;
  }
}
