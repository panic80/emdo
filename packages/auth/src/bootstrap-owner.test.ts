import { describe, expect, it } from 'vitest';

import {
  BootstrapOwnerService,
  InMemoryBootstrapOwnerRepository,
} from './bootstrap-owner.js';

describe('BootstrapOwnerService', () => {
  it('requires the deployment secret and creates exactly one verified owner/private space', async () => {
    const repository = new InMemoryBootstrapOwnerRepository();
    const service = new BootstrapOwnerService(
      repository,
      'deployment-secret-123',
    );

    await expect(
      service.bootstrap({
        providedSecret: 'wrong-secret',
        email: 'owner@example.com',
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: 'bootstrap-unauthorized' });
    const result = await service.bootstrap({
      providedSecret: 'deployment-secret-123',
      email: 'owner@example.com',
      emailVerified: true,
    });
    expect(result.membership.role).toBe('owner');
    expect(result.space).toMatchObject({
      visibility: 'private',
      originalOwnerUserId: result.user.id,
    });
    await expect(
      service.bootstrap({
        providedSecret: 'deployment-secret-123',
        email: 'second@example.com',
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: 'bootstrap-already-complete' });
  });
});
