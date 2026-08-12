import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  AesGcmApprovalCheckpointCipher,
  ApprovalCheckpointService,
  InMemoryApprovalCheckpointRepository,
  type ApprovalCheckpointCipher,
  type ApprovalCheckpointRepository,
  type StoredApprovalCheckpoint,
} from './approval-state.js';

const identity = Object.freeze({
  checkpointId: '8b90f12c-1d71-40e4-9fe7-b3536f751860',
  householdId: '746e598b-3f57-45cc-bf99-652e34572fb7',
  userId: 'f8275de4-ae76-410a-84ee-33bb5e35ff44',
  runId: 'f2e7d135-6214-4cb0-8986-e0e262b6dd32',
  agentGraphHash:
    '2ce5736b1ae912686ca3e56f9e1d885fecd91b8af0c4f7b2efacf62a12b7a700',
  sdkVersion: '0.14.3',
});

const createCipher = () =>
  new AesGcmApprovalCheckpointCipher({
    activeKeyId: 'approval-state-key-v1',
    keys: { 'approval-state-key-v1': randomBytes(32) },
  });

const createFixture = (initialNow = '2026-08-09T15:00:00.000Z') => {
  let now = new Date(initialNow);
  const clock = () => new Date(now);
  const repository = new InMemoryApprovalCheckpointRepository(clock);
  const cipher = createCipher();
  return {
    cipher,
    repository,
    service: new ApprovalCheckpointService(repository, cipher, clock),
    setNow: (value: string) => {
      now = new Date(value);
    },
  };
};

const createCheckpoint = (
  service: ApprovalCheckpointService,
  serializedState = JSON.stringify({ currentTurn: 3 }),
) =>
  service.create({
    ...identity,
    ttlMs: 10 * 60 * 1000,
    serializedState,
  });

describe('ApprovalCheckpointService', () => {
  it('stages an encrypted checkpoint without making it resumable or persisting it', async () => {
    const { repository, service } = createFixture();
    const serializedState = JSON.stringify({ currentTurn: 3 });

    const staged = await service.stage({
      ...identity,
      ttlMs: 10 * 60 * 1000,
      serializedState,
    });

    expect(staged.checkpoint).toMatchObject({
      ...identity,
      formatVersion: 1,
      revision: 1,
      state: 'pending',
    });
    expect(staged.record.sealedState).not.toContain('currentTurn');
    expect(Object.isFrozen(staged)).toBe(true);
    expect(Object.isFrozen(staged.record)).toBe(true);
    await expect(
      repository.get(identity.checkpointId),
    ).resolves.toBeUndefined();
    await expect(service.consumeForResume(identity)).resolves.toEqual({
      status: 'not-found',
    });
  });

  it('persists only encrypted, versioned SDK state bound to actor, run, and graph', async () => {
    const { repository, service } = createFixture();
    const serializedState = JSON.stringify({
      interruptions: [{ toolName: 'manager.await-proposal-decision' }],
      privatePrompt: 'must not be stored as plaintext',
    });

    const checkpoint = await createCheckpoint(service, serializedState);
    expect(checkpoint).toMatchObject({
      ...identity,
      formatVersion: 1,
      revision: 1,
      state: 'pending',
    });
    const stored = await repository.get(identity.checkpointId);
    expect(stored?.sealedState).not.toContain('privatePrompt');
    expect(stored?.sealedState).not.toContain(
      'manager.await-proposal-decision',
    );
    expect(stored === undefined ? false : 'serializedState' in stored).toBe(
      false,
    );
    expect(stored === undefined ? false : 'stateHash' in stored).toBe(false);
    expect(Object.isFrozen(checkpoint)).toBe(true);
  });

  it('resumes exactly once for the same authenticated scope and graph', async () => {
    const { service, setNow } = createFixture();
    const serializedState = JSON.stringify({ currentTurn: 3 });
    await createCheckpoint(service, serializedState);
    setNow('2026-08-09T15:05:00.000Z');

    await expect(service.consumeForResume(identity)).resolves.toMatchObject({
      status: 'resumed',
      serializedState,
      checkpoint: { state: 'resumed', revision: 2 },
    });
    await expect(service.consumeForResume(identity)).resolves.toEqual({
      status: 'already-consumed',
    });
  });

  it('leaves a checkpoint pending when the trusted decrypted-state predicate rejects or throws', async () => {
    const { service } = createFixture();
    await createCheckpoint(
      service,
      JSON.stringify({
        proposalId: identity.checkpointId,
        nested: { ok: true },
      }),
    );

    await expect(
      service.consumeForResume(identity, async () => false),
    ).resolves.toEqual({ status: 'mismatch' });
    await expect(
      service.consumeForResume(identity, async () => {
        throw new Error('private decision-store failure');
      }),
    ).resolves.toEqual({ status: 'mismatch' });
    await expect(
      service.consumeForResume(identity, async (state) => {
        expect(Object.isFrozen(state)).toBe(true);
        expect(Object.isFrozen((state as { nested: object }).nested)).toBe(
          true,
        );
        expect(() => {
          (state as { proposalId: string }).proposalId = 'tampered';
        }).toThrow();
        return true;
      }),
    ).resolves.toMatchObject({ status: 'resumed' });
  });

  it.each([
    ['householdId', '746e598b-3f57-45cc-bf99-652e34572fb8'],
    ['userId', 'f8275de4-ae76-410a-84ee-33bb5e35ff45'],
    ['runId', 'f2e7d135-6214-4cb0-8986-e0e262b6dd33'],
    [
      'agentGraphHash',
      '3ce5736b1ae912686ca3e56f9e1d885fecd91b8af0c4f7b2efacf62a12b7a700',
    ],
    ['sdkVersion', '0.14.4'],
  ] as const)(
    'rejects mismatched %s without consuming state',
    async (field, value) => {
      const { service, setNow } = createFixture();
      await createCheckpoint(service);
      setNow('2026-08-09T15:05:00.000Z');

      await expect(
        service.consumeForResume({ ...identity, [field]: value }),
      ).resolves.toEqual({ status: 'mismatch' });
      await expect(service.consumeForResume(identity)).resolves.toMatchObject({
        status: 'resumed',
      });
    },
  );

  it('uses trusted clocks for creation, expiry, and cancellation', async () => {
    const { service, setNow } = createFixture();
    await createCheckpoint(service);
    setNow('2026-08-09T15:10:00.000Z');

    await expect(service.consumeForResume(identity)).resolves.toEqual({
      status: 'expired',
    });
    await expect(
      service.create({
        ...identity,
        checkpointId: '8b90f12c-1d71-40e4-9fe7-b3536f751861',
        ttlMs: 0,
        serializedState: JSON.stringify({ currentTurn: 3 }),
      }),
    ).rejects.toThrow('invalid-approval-checkpoint');

    const late = createFixture();
    await createCheckpoint(late.service);
    late.setNow('2026-08-09T15:10:00.000Z');
    await expect(
      late.service.cancel({
        checkpointId: identity.checkpointId,
        householdId: identity.householdId,
        userId: identity.userId,
      }),
    ).resolves.toMatchObject({ state: 'expired', revision: 2 });
  });

  it('never resumes invalid or oversized state', async () => {
    const { service } = createFixture();
    await expect(createCheckpoint(service, '{not-json')).rejects.toThrow(
      'invalid-approval-checkpoint',
    );
    await expect(
      service.create({
        ...identity,
        checkpointId: '8b90f12c-1d71-40e4-9fe7-b3536f751862',
        ttlMs: 10 * 60 * 1000,
        serializedState: JSON.stringify({ large: 'x'.repeat(1_048_576) }),
      }),
    ).rejects.toThrow('invalid-approval-checkpoint');
  });

  it('rechecks repository time atomically after slow decryption', async () => {
    const fixture = createFixture();
    await createCheckpoint(fixture.service);
    fixture.setNow('2026-08-09T15:09:59.900Z');
    const delayedCipher: ApprovalCheckpointCipher = {
      security: fixture.cipher.security,
      seal: fixture.cipher.seal.bind(fixture.cipher),
      open: async (sealed, aad) => {
        const plaintext = await fixture.cipher.open(sealed, aad);
        fixture.setNow('2026-08-09T15:10:00.000Z');
        return plaintext;
      },
    };
    const service = new ApprovalCheckpointService(
      fixture.repository,
      delayedCipher,
      () => new Date('2026-08-09T15:09:59.900Z'),
    );

    await expect(service.consumeForResume(identity)).resolves.toEqual({
      status: 'expired',
    });
  });

  it('rejects tampering, truncated tags, and AAD substitution before transition', async () => {
    const fixture = createFixture();
    await createCheckpoint(fixture.service);
    fixture.setNow('2026-08-09T15:05:00.000Z');
    const corruptingRepository = new CorruptingRepository(fixture.repository);
    const service = new ApprovalCheckpointService(
      corruptingRepository,
      fixture.cipher,
      () => new Date('2026-08-09T15:05:00.000Z'),
    );

    corruptingRepository.mode = 'truncated-tag';
    await expect(service.consumeForResume(identity)).rejects.toThrow(
      'approval-checkpoint-decryption-failed',
    );
    expect((await fixture.repository.get(identity.checkpointId))?.state).toBe(
      'pending',
    );

    corruptingRepository.mode = 'changed-household';
    await expect(
      service.consumeForResume({
        ...identity,
        householdId: '746e598b-3f57-45cc-bf99-652e34572fb8',
      }),
    ).rejects.toThrow('approval-checkpoint-decryption-failed');
  });

  it('cancels pending state idempotently without disclosing SDK state', async () => {
    const { service, setNow } = createFixture();
    await createCheckpoint(service);
    setNow('2026-08-09T15:03:00.000Z');
    const input = {
      checkpointId: identity.checkpointId,
      householdId: identity.householdId,
      userId: identity.userId,
    };

    await expect(service.cancel(input)).resolves.toMatchObject({
      state: 'cancelled',
      revision: 2,
    });
    await expect(service.cancel(input)).resolves.toMatchObject({
      state: 'cancelled',
      revision: 2,
    });
  });

  it('returns a confirmed absence when cancellation finds no checkpoint', async () => {
    const { service } = createFixture();

    await expect(
      service.cancel({
        checkpointId: identity.checkpointId,
        householdId: identity.householdId,
        userId: identity.userId,
      }),
    ).resolves.toEqual({ status: 'not-found' });
  });

  it('uses non-enumerable, versioned, rotatable keys and supports disposal', async () => {
    const keyV1 = randomBytes(32);
    const keyV2 = randomBytes(32);
    const cipherV1 = new AesGcmApprovalCheckpointCipher({
      activeKeyId: 'approval-state-key-v1',
      keys: { 'approval-state-key-v1': keyV1 },
    });
    const aad = {
      ...identity,
      formatVersion: 1 as const,
      createdAt: '2026-08-09T15:00:00.000Z',
      expiresAt: '2026-08-09T15:10:00.000Z',
    };
    const sealedV1 = await cipherV1.seal('{"turn":1}', aad);
    expect(sealedV1.split('.')[1]).toBe('approval-state-key-v1');
    expect(JSON.stringify(cipherV1)).not.toContain(keyV1.toString('hex'));
    expect(Object.keys(cipherV1)).toEqual([]);

    const rotated = new AesGcmApprovalCheckpointCipher({
      activeKeyId: 'approval-state-key-v2',
      keys: {
        'approval-state-key-v1': keyV1,
        'approval-state-key-v2': keyV2,
      },
    });
    await expect(rotated.open(sealedV1, aad)).resolves.toBe('{"turn":1}');
    const sealedV2 = await rotated.seal('{"turn":2}', aad);
    expect(sealedV2.split('.')[1]).toBe('approval-state-key-v2');
    rotated.dispose();
    await expect(rotated.open(sealedV2, aad)).rejects.toThrow(
      'approval-checkpoint-keyring-disposed',
    );
  });

  it('rejects accessor-backed checkpoint identities before encryption', async () => {
    const { service, repository } = createFixture();
    let householdReads = 0;
    const descriptors: Record<string, PropertyDescriptor> = Object.fromEntries(
      Object.entries({
        ...identity,
        ttlMs: 60_000,
        serializedState: JSON.stringify({ currentTurn: 3 }),
      }).map(([key, value]) => [
        key,
        { configurable: true, enumerable: true, value },
      ]),
    );
    descriptors.householdId = {
      configurable: true,
      enumerable: true,
      get: () => {
        householdReads += 1;
        return householdReads === 1 ? identity.householdId : 'not-a-uuid';
      },
    };
    const input = Object.defineProperties({}, descriptors);

    await expect(service.create(input as never)).rejects.toThrow(
      'invalid-approval-checkpoint',
    );
    expect(await repository.get(identity.checkpointId)).toBeUndefined();
  });

  it('rejects accessor-backed keyring configuration without reading it', () => {
    const key = randomBytes(32);
    let keyringReads = 0;
    const input = Object.defineProperties(
      {},
      {
        activeKeyId: {
          enumerable: true,
          value: 'approval-state-key-v1',
        },
        keys: {
          enumerable: true,
          get: () => {
            keyringReads += 1;
            return { 'approval-state-key-v1': key };
          },
        },
      },
    );

    expect(() => new AesGcmApprovalCheckpointCipher(input as never)).toThrow(
      'invalid-approval-checkpoint-keyring',
    );
    expect(keyringReads).toBe(0);
  });

  it('normalizes exceptional keyring objects to a safe configuration error', () => {
    const keys = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('provider-specific secret');
        },
      },
    );

    expect(
      () =>
        new AesGcmApprovalCheckpointCipher({
          activeKeyId: 'approval-state-key-v1',
          keys,
        }),
    ).toThrow('invalid-approval-checkpoint-keyring');
  });
});

class CorruptingRepository implements ApprovalCheckpointRepository {
  mode: 'none' | 'truncated-tag' | 'changed-household' = 'none';

  constructor(private readonly base: ApprovalCheckpointRepository) {}

  create: ApprovalCheckpointRepository['create'] = (record) =>
    this.base.create(record);

  consume: ApprovalCheckpointRepository['consume'] = (input) =>
    this.base.consume(input);

  cancel: ApprovalCheckpointRepository['cancel'] = (input) =>
    this.base.cancel(input);

  async get(
    checkpointId: string,
  ): Promise<StoredApprovalCheckpoint | undefined> {
    const stored = await this.base.get(checkpointId);
    if (stored === undefined || this.mode === 'none') return stored;
    if (this.mode === 'changed-household') {
      return Object.freeze({
        ...stored,
        householdId: '746e598b-3f57-45cc-bf99-652e34572fb8',
      });
    }
    const parts = stored.sealedState.split('.');
    const tag = Buffer.from(parts[3] ?? '', 'base64url');
    return Object.freeze({
      ...stored,
      sealedState: [
        parts[0],
        parts[1],
        parts[2],
        tag.subarray(0, 4).toString('base64url'),
        parts[4],
      ].join('.'),
    });
  }
}
