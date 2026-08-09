import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

export type InvitationRole = 'owner' | 'member';

export interface InvitationRecord {
  readonly id: string;
  readonly householdId: string;
  readonly invitedByUserId: string;
  readonly email: string;
  readonly role: InvitationRole;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt?: Date;
  readonly revokedAt?: Date;
}

export interface InvitationRepository {
  create(record: InvitationRecord): Promise<void>;
  get(id: string): Promise<InvitationRecord | undefined>;
  consume(id: string, consumedAt: Date): Promise<InvitationRecord | undefined>;
  revoke(id: string, revokedAt: Date): Promise<InvitationRecord | undefined>;
}

export type InvitationErrorCode =
  | 'invitation-invalid'
  | 'invitation-expired'
  | 'invitation-used'
  | 'invitation-expiry-invalid'
  | 'invitation-issuer-unauthorized';

export class InvitationError extends Error {
  constructor(
    readonly code: InvitationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InvitationError';
  }
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
const safeHashEqual = (left: string, right: string) => {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

const cloneRecord = (record: InvitationRecord): InvitationRecord =>
  Object.freeze({
    ...record,
    createdAt: new Date(record.createdAt),
    expiresAt: new Date(record.expiresAt),
    ...(record.consumedAt === undefined
      ? {}
      : { consumedAt: new Date(record.consumedAt) }),
    ...(record.revokedAt === undefined
      ? {}
      : { revokedAt: new Date(record.revokedAt) }),
  });

export class InvitationService {
  constructor(private readonly repository: InvitationRepository) {}

  async issue(input: {
    readonly issuer: {
      readonly userId: string;
      readonly householdId: string;
      readonly role: InvitationRole;
      readonly activeMember: boolean;
    };
    readonly email: string;
    readonly role: InvitationRole;
    readonly now: Date;
    readonly expiresAt: Date;
  }) {
    if (!input.issuer.activeMember || input.issuer.role !== 'owner') {
      throw new InvitationError(
        'invitation-issuer-unauthorized',
        'Only an active household owner may issue invitations',
      );
    }
    if (
      input.issuer.userId.trim().length === 0 ||
      input.issuer.householdId.trim().length === 0
    ) {
      throw new InvitationError(
        'invitation-issuer-unauthorized',
        'Invitation issuer scope is invalid',
      );
    }
    const lifetimeMs = input.expiresAt.getTime() - input.now.getTime();
    if (lifetimeMs <= 0 || lifetimeMs > 7 * 24 * 60 * 60 * 1000) {
      throw new InvitationError(
        'invitation-expiry-invalid',
        'Invitation expiry must be within seven days',
      );
    }
    const email = normalizeEmail(input.email);
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      throw new InvitationError(
        'invitation-invalid',
        'Invitation email is invalid',
      );
    }
    const token = randomBytes(32).toString('base64url');
    const invitation = Object.freeze({
      id: randomUUID(),
      householdId: input.issuer.householdId,
      invitedByUserId: input.issuer.userId,
      email,
      role: input.role,
      tokenHash: tokenHash(token),
      createdAt: new Date(input.now),
      expiresAt: new Date(input.expiresAt),
    });
    await this.repository.create(invitation);
    return Object.freeze({ invitation: cloneRecord(invitation), token });
  }

  async consume(input: {
    readonly invitationId: string;
    readonly email: string;
    readonly token: string;
    readonly now: Date;
  }) {
    const invitation = await this.repository.get(input.invitationId);
    const suppliedHash = tokenHash(input.token);
    if (
      invitation === undefined ||
      invitation.email !== normalizeEmail(input.email) ||
      !safeHashEqual(invitation.tokenHash, suppliedHash)
    ) {
      throw new InvitationError('invitation-invalid', 'Invitation is invalid');
    }
    if (
      invitation.consumedAt !== undefined ||
      invitation.revokedAt !== undefined
    ) {
      throw new InvitationError(
        'invitation-used',
        'Invitation is no longer available',
      );
    }
    if (invitation.expiresAt.getTime() <= input.now.getTime()) {
      throw new InvitationError('invitation-expired', 'Invitation has expired');
    }
    const consumed = await this.repository.consume(invitation.id, input.now);
    if (consumed === undefined) {
      throw new InvitationError(
        'invitation-used',
        'Invitation is no longer available',
      );
    }
    return consumed;
  }

  async revoke(id: string, now: Date) {
    const revoked = await this.repository.revoke(id, now);
    if (revoked === undefined) {
      throw new InvitationError(
        'invitation-used',
        'Invitation cannot be revoked',
      );
    }
    return revoked;
  }
}

export class InMemoryInvitationRepository implements InvitationRepository {
  private readonly records = new Map<string, InvitationRecord>();

  async create(record: InvitationRecord) {
    if (this.records.has(record.id)) throw new Error('Duplicate invitation');
    this.records.set(record.id, cloneRecord(record));
  }

  async get(id: string) {
    const record = this.records.get(id);
    return record === undefined ? undefined : cloneRecord(record);
  }

  async consume(id: string, consumedAt: Date) {
    const current = this.records.get(id);
    if (
      current === undefined ||
      current.consumedAt !== undefined ||
      current.revokedAt !== undefined
    ) {
      return undefined;
    }
    const next = Object.freeze({
      ...current,
      consumedAt: new Date(consumedAt),
    });
    this.records.set(id, next);
    return cloneRecord(next);
  }

  async revoke(id: string, revokedAt: Date) {
    const current = this.records.get(id);
    if (
      current === undefined ||
      current.consumedAt !== undefined ||
      current.revokedAt !== undefined
    ) {
      return undefined;
    }
    const next = Object.freeze({ ...current, revokedAt: new Date(revokedAt) });
    this.records.set(id, next);
    return cloneRecord(next);
  }
}
