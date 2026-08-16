import { generateKeyPairSync } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { SyncStreamAuthorizer, SyncStreamError } from './streams.js';
import { SyncTokenService } from './token.js';

const USER_A = '20000000-0000-4000-8000-000000000001';
const USER_B = '20000000-0000-4000-8000-000000000002';
const SESSION_A = '20000000-0000-4000-8000-000000000003';
const CLIENT_A = '20000000-0000-4000-8000-000000000004';
const HOUSEHOLD = '20000000-0000-4000-8000-000000000005';
const PRIVATE_A = '20000000-0000-4000-8000-000000000006';
const PRIVATE_B = '20000000-0000-4000-8000-000000000007';
const SHARED = '20000000-0000-4000-8000-000000000008';

describe('SyncStreamAuthorizer', () => {
  let token = '';
  let authorizer: SyncStreamAuthorizer;

  beforeEach(async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const tokens = new SyncTokenService({
      issuer: 'https://api.emdo.test',
      audience: 'emdo-powersync',
      keyId: 'sync-v1',
      privateKey: keys.privateKey,
      verificationKeys: new Map([['sync-v1', keys.publicKey]]),
      repository: {
        resolveSyncAccess: async () => ({
          userId: USER_A,
          householdId: HOUSEHOLD,
          role: 'member',
          schemaVersion: 1,
          spaces: [
            {
              id: PRIVATE_A,
              visibility: 'private',
              originalOwnerUserId: USER_A,
            },
            {
              id: SHARED,
              visibility: 'shared',
              originalOwnerUserId: USER_B,
            },
          ],
        }),
      },
      clock: { now: () => new Date('2026-08-09T12:00:00.000Z') },
      ttlSeconds: 300,
      maximumTtlSeconds: 300,
    });
    token = (await tokens.issue({ sessionId: SESSION_A, clientId: CLIENT_A }))
      .token;
    authorizer = new SyncStreamAuthorizer(tokens);
  });

  it('binds household and readable-space predicates to verified claims', () => {
    expect(
      authorizer.authorize(token, { resource: 'household-metadata' }),
    ).toMatchObject({
      streamName: `household:${HOUSEHOLD}:metadata`,
      predicate: { sql: 'household_id = $1', parameters: [HOUSEHOLD] },
    });

    expect(
      authorizer.authorize(token, {
        resource: 'space-records',
        spaceId: SHARED,
      }),
    ).toMatchObject({
      predicate: {
        sql: 'household_id = $1 AND space_id = $2',
        parameters: [HOUSEHOLD, SHARED],
      },
    });

    expect(
      authorizer.authorize(token, {
        resource: 'space-records',
        spaceId: PRIVATE_A,
      }),
    ).toMatchObject({
      predicate: {
        sql: 'household_id = $1 AND space_id = $2 AND original_owner_user_id = $3',
        parameters: [HOUSEHOLD, PRIVATE_A, USER_A],
      },
    });
  });

  it('denies global streams, unreadable spaces, and client-supplied tenant scope', () => {
    expect(() => authorizer.authorize(token, { resource: 'global' })).toThrow(
      expect.objectContaining({ code: 'global-stream-denied' }),
    );
    expect(() =>
      authorizer.authorize(token, {
        resource: 'space-records',
        spaceId: PRIVATE_B,
      }),
    ).toThrow(expect.objectContaining({ code: 'space-not-readable' }));
    expect(() =>
      authorizer.authorize(token, {
        resource: 'household-metadata',
        householdId: '20000000-0000-4000-8000-000000000099',
      }),
    ).toThrow(SyncStreamError);
  });
});
