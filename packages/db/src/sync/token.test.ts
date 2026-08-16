import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  SyncTokenError,
  SyncTokenService,
  type SyncAccessRepository,
} from './token.js';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const SESSION_ID = '10000000-0000-4000-8000-000000000002';
const CLIENT_ID = '10000000-0000-4000-8000-000000000003';
const HOUSEHOLD_ID = '10000000-0000-4000-8000-000000000004';
const PRIVATE_SPACE_ID = '10000000-0000-4000-8000-000000000005';
const SHARED_SPACE_ID = '10000000-0000-4000-8000-000000000006';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });

const createFixture = () => {
  let now = new Date('2026-08-09T12:00:00.000Z');
  const repository: SyncAccessRepository = {
    resolveSyncAccess: vi.fn(async ({ sessionId, clientId }) => {
      if (sessionId !== SESSION_ID || clientId !== CLIENT_ID) return undefined;
      return {
        userId: USER_ID,
        householdId: HOUSEHOLD_ID,
        role: 'owner' as const,
        schemaVersion: 1 as const,
        spaces: [
          {
            id: PRIVATE_SPACE_ID,
            visibility: 'private' as const,
            originalOwnerUserId: USER_ID,
          },
          {
            id: SHARED_SPACE_ID,
            visibility: 'shared' as const,
            originalOwnerUserId: USER_ID,
          },
        ],
      };
    }),
  };
  const service = new SyncTokenService({
    issuer: 'https://api.emdo.test',
    audience: 'emdo-powersync',
    keyId: 'sync-key-v1',
    privateKey: keys.privateKey,
    verificationKeys: new Map([['sync-key-v1', keys.publicKey]]),
    repository,
    clock: { now: () => now },
    ttlSeconds: 300,
    maximumTtlSeconds: 300,
    idFactory: () => '10000000-0000-4000-8000-000000000007',
  });

  return {
    repository,
    service,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
    invalidateClock() {
      now = new Date(Number.NaN);
    },
  };
};

describe('SyncTokenService', () => {
  it('issues short-lived signed claims from server-side access state only', async () => {
    const fixture = createFixture();

    const issued = await fixture.service.issue({
      sessionId: SESSION_ID,
      clientId: CLIENT_ID,
    });
    const verified = fixture.service.verify(issued.token);

    expect(fixture.repository.resolveSyncAccess).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      clientId: CLIENT_ID,
    });
    expect(verified).toMatchObject({
      iss: 'https://api.emdo.test',
      aud: 'emdo-powersync',
      sub: USER_ID,
      userId: USER_ID,
      clientId: CLIENT_ID,
      householdId: HOUSEHOLD_ID,
      role: 'owner',
      schemaVersion: 1,
      iat: Date.parse('2026-08-09T12:00:00.000Z') / 1000,
      exp: Date.parse('2026-08-09T12:05:00.000Z') / 1000,
      spaces: [
        { id: PRIVATE_SPACE_ID, visibility: 'private' },
        { id: SHARED_SPACE_ID, visibility: 'shared' },
      ],
    });
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.spaces)).toBe(true);
  });

  it('rejects unavailable sessions, tampering, and expired tokens', async () => {
    const fixture = createFixture();
    await expect(
      fixture.service.issue({
        sessionId: '10000000-0000-4000-8000-000000000099',
        clientId: CLIENT_ID,
      }),
    ).rejects.toMatchObject({ code: 'scope-unavailable' });

    const { token } = await fixture.service.issue({
      sessionId: SESSION_ID,
      clientId: CLIENT_ID,
    });
    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect(() => fixture.service.verify(tampered)).toThrow(SyncTokenError);
    expect(() => fixture.service.verify(tampered)).toThrow(
      expect.objectContaining({ code: 'invalid-signature' }),
    );

    fixture.advance(301_000);
    expect(() => fixture.service.verify(token)).toThrow(
      expect.objectContaining({ code: 'expired' }),
    );

    fixture.invalidateClock();
    expect(() => fixture.service.verify(token)).toThrow(
      expect.objectContaining({ code: 'invalid-configuration' }),
    );
  });

  it('refuses malformed server scope, including another member private space', async () => {
    const fixture = createFixture();
    vi.mocked(fixture.repository.resolveSyncAccess).mockResolvedValueOnce({
      userId: USER_ID,
      householdId: HOUSEHOLD_ID,
      role: 'member',
      schemaVersion: 1,
      spaces: [
        {
          id: PRIVATE_SPACE_ID,
          visibility: 'private',
          originalOwnerUserId: '10000000-0000-4000-8000-000000000099',
        },
      ],
    });

    await expect(
      fixture.service.issue({ sessionId: SESSION_ID, clientId: CLIENT_ID }),
    ).rejects.toMatchObject({ code: 'invalid-scope' });
  });

  it('publishes sanitized public JWKS and verifies tokens across key rotation', async () => {
    const oldKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fixture = createFixture();
    const oldService = new SyncTokenService({
      issuer: 'https://api.emdo.test',
      audience: 'emdo-powersync',
      keyId: 'sync-key-old',
      privateKey: oldKeys.privateKey,
      verificationKeys: new Map([['sync-key-old', oldKeys.publicKey]]),
      repository: fixture.repository,
      clock: { now: () => new Date('2026-08-09T12:00:00.000Z') },
      ttlSeconds: 300,
      maximumTtlSeconds: 300,
    });
    const rotatingService = new SyncTokenService({
      issuer: 'https://api.emdo.test',
      audience: 'emdo-powersync',
      keyId: 'sync-key-v1',
      privateKey: keys.privateKey,
      verificationKeys: new Map([
        ['sync-key-old', oldKeys.publicKey],
        ['sync-key-v1', keys.publicKey],
      ]),
      repository: fixture.repository,
      clock: { now: () => new Date('2026-08-09T12:00:00.000Z') },
      ttlSeconds: 300,
      maximumTtlSeconds: 300,
    });

    const oldToken = (
      await oldService.issue({ sessionId: SESSION_ID, clientId: CLIENT_ID })
    ).token;
    expect(rotatingService.verify(oldToken).userId).toBe(USER_ID);
    expect(rotatingService.getPublicJwks()).toEqual({
      keys: [
        expect.objectContaining({
          kid: 'sync-key-old',
          kty: 'RSA',
          alg: 'RS256',
          use: 'sig',
          n: expect.any(String),
          e: expect.any(String),
        }),
        expect.objectContaining({
          kid: 'sync-key-v1',
          kty: 'RSA',
          alg: 'RS256',
          use: 'sig',
        }),
      ],
    });
    for (const publicJwk of rotatingService.getPublicJwks().keys) {
      expect(Object.keys(publicJwk).sort()).toEqual([
        'alg',
        'e',
        'kid',
        'kty',
        'n',
        'use',
      ]);
      expect(publicJwk).not.toHaveProperty('d');
      expect(publicJwk).not.toHaveProperty('p');
      expect(publicJwk).not.toHaveProperty('q');
    }
  });

  it('rejects unknown key IDs, algorithm confusion, and the generic audience', async () => {
    const fixture = createFixture();
    const { token } = await fixture.service.issue({
      sessionId: SESSION_ID,
      clientId: CLIENT_ID,
    });
    const [, claims, signature] = token.split('.');
    const unknownKeyHeader = Buffer.from(
      JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'unknown-key' }),
    ).toString('base64url');
    expect(() =>
      fixture.service.verify(`${unknownKeyHeader}.${claims}.${signature}`),
    ).toThrow(expect.objectContaining({ code: 'unknown-key' }));

    const confusedHeader = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'sync-key-v1' }),
    ).toString('base64url');
    expect(() =>
      fixture.service.verify(`${confusedHeader}.${claims}.${signature}`),
    ).toThrow(expect.objectContaining({ code: 'invalid-token' }));
    expect(() =>
      fixture.service.verify(`${unknownKeyHeader}=.${claims}.${signature}`),
    ).toThrow(expect.objectContaining({ code: 'invalid-token' }));

    expect(
      () =>
        new SyncTokenService({
          issuer: 'https://api.emdo.test',
          audience: 'powersync' as 'emdo-powersync',
          keyId: 'sync-key-v1',
          privateKey: keys.privateKey,
          verificationKeys: new Map([['sync-key-v1', keys.publicKey]]),
          repository: fixture.repository,
          clock: { now: () => new Date('2026-08-09T12:00:00.000Z') },
          ttlSeconds: 300,
          maximumTtlSeconds: 300,
        }),
    ).toThrow(expect.objectContaining({ code: 'invalid-configuration' }));

    expect(
      () =>
        new SyncTokenService({
          issuer: 'http://api.emdo.test',
          audience: 'emdo-powersync',
          keyId: 'sync-key-v1',
          privateKey: keys.privateKey,
          verificationKeys: new Map([['sync-key-v1', keys.publicKey]]),
          repository: fixture.repository,
          clock: { now: () => new Date('2026-08-09T12:00:00.000Z') },
          ttlSeconds: 300,
          maximumTtlSeconds: 300,
        }),
    ).toThrow(expect.objectContaining({ code: 'invalid-configuration' }));
  });
});
