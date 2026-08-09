import { randomUUID, timingSafeEqual } from 'node:crypto';

export interface BootstrapOwnerResult {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly emailVerified: true;
  };
  readonly household: { readonly id: string };
  readonly membership: {
    readonly householdId: string;
    readonly userId: string;
    readonly role: 'owner';
  };
  readonly space: {
    readonly id: string;
    readonly householdId: string;
    readonly originalOwnerUserId: string;
    readonly visibility: 'private';
  };
}

export interface BootstrapOwnerRepository {
  createOnce(email: string): Promise<BootstrapOwnerResult | undefined>;
}

export class BootstrapOwnerError extends Error {
  constructor(
    readonly code:
      | 'bootstrap-unauthorized'
      | 'bootstrap-already-complete'
      | 'bootstrap-email-unverified',
  ) {
    super(code);
    this.name = 'BootstrapOwnerError';
  }
}

const secretEqual = (left: string, right: string) => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

export class BootstrapOwnerService {
  constructor(
    private readonly repository: BootstrapOwnerRepository,
    private readonly deploymentSecret: string,
  ) {
    if (deploymentSecret.length < 16)
      throw new Error('Bootstrap secret is too short');
  }

  async bootstrap(input: {
    readonly providedSecret: string;
    readonly email: string;
    readonly emailVerified: boolean;
  }) {
    if (!secretEqual(input.providedSecret, this.deploymentSecret)) {
      throw new BootstrapOwnerError('bootstrap-unauthorized');
    }
    if (!input.emailVerified) {
      throw new BootstrapOwnerError('bootstrap-email-unverified');
    }
    const email = input.email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      throw new BootstrapOwnerError('bootstrap-email-unverified');
    }
    const result = await this.repository.createOnce(email);
    if (result === undefined) {
      throw new BootstrapOwnerError('bootstrap-already-complete');
    }
    return result;
  }
}

export class InMemoryBootstrapOwnerRepository implements BootstrapOwnerRepository {
  private result?: BootstrapOwnerResult;

  async createOnce(email: string) {
    if (this.result !== undefined) return undefined;
    const userId = randomUUID();
    const householdId = randomUUID();
    this.result = Object.freeze({
      user: Object.freeze({ id: userId, email, emailVerified: true as const }),
      household: Object.freeze({ id: householdId }),
      membership: Object.freeze({
        householdId,
        userId,
        role: 'owner' as const,
      }),
      space: Object.freeze({
        id: randomUUID(),
        householdId,
        originalOwnerUserId: userId,
        visibility: 'private' as const,
      }),
    });
    return this.result;
  }
}
