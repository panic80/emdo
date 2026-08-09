import { describe, expect, it } from 'vitest';

import {
  InMemorySessionRepository,
  RotatingSessionService,
} from './session.js';

describe('RotatingSessionService', () => {
  it('stores token hashes and atomically invalidates the previous token on rotation', async () => {
    const repository = new InMemorySessionRepository();
    const service = new RotatingSessionService(repository);
    const now = new Date('2026-08-09T16:00:00.000Z');
    const issued = await service.issue({
      userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f101',
      now,
      expiresAt: new Date('2026-08-10T16:00:00.000Z'),
    });

    expect(
      JSON.stringify(await repository.get(issued.session.id)),
    ).not.toContain(issued.token);
    const rotated = await service.rotate({
      token: issued.token,
      now: new Date('2026-08-09T17:00:00.000Z'),
      expiresAt: new Date('2026-08-10T17:00:00.000Z'),
    });
    await expect(
      service.authenticate(issued.token, now),
    ).resolves.toBeUndefined();
    await expect(
      service.authenticate(rotated.token, now),
    ).resolves.toMatchObject({
      id: issued.session.id,
      rotation: 1,
    });

    const results = await Promise.allSettled([
      service.rotate({
        token: rotated.token,
        now: new Date('2026-08-09T18:00:00.000Z'),
        expiresAt: new Date('2026-08-10T18:00:00.000Z'),
      }),
      service.rotate({
        token: rotated.token,
        now: new Date('2026-08-09T18:00:00.000Z'),
        expiresAt: new Date('2026-08-10T18:00:00.000Z'),
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
  });

  it('rejects a token at its exact expiry and revokes the current token', async () => {
    const service = new RotatingSessionService(new InMemorySessionRepository());
    const issued = await service.issue({
      userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f101',
      now: new Date('2026-08-09T16:00:00.000Z'),
      expiresAt: new Date('2026-08-09T17:00:00.000Z'),
    });
    await expect(
      service.authenticate(issued.token, new Date('2026-08-09T17:00:00.000Z')),
    ).resolves.toBeUndefined();
    await expect(
      service.revoke(issued.token, new Date('2026-08-09T16:30:00.000Z')),
    ).resolves.toBe(true);
    await expect(
      service.authenticate(issued.token, new Date('2026-08-09T16:31:00.000Z')),
    ).resolves.toBeUndefined();
  });
});
