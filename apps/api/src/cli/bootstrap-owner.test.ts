import { describe, expect, it, vi } from 'vitest';

import {
  API_OWNER_BOOTSTRAP_CONFIRMATION,
  runApiOwnerBootstrapCommand,
} from './bootstrap-owner.js';

describe('protected API owner bootstrap CLI', () => {
  it('passes only dedicated bootstrap variables with explicit fixed confirmation', async () => {
    const bootstrapOwner = vi.fn().mockResolvedValue(0);
    const environment = {
      EMDO_API_AUTH_SECRET: 'must-not-cross-bootstrap-boundary',
      EMDO_BOOTSTRAP_DATABASE_URL: 'postgresql://bootstrap:secret@db/emdo',
      EMDO_BOOTSTRAP_HOUSEHOLD_NAME: 'My household',
      EMDO_BOOTSTRAP_HOUSEHOLD_SLUG: 'my-household',
      EMDO_BOOTSTRAP_OWNER_EMAIL: 'owner@example.com',
      EMDO_BOOTSTRAP_OWNER_NAME: 'Owner',
      EMDO_BOOTSTRAP_OWNER_PASSWORD: 'correct horse battery staple',
      OPENAI_API_KEY: 'must-not-cross-bootstrap-boundary',
    };

    await expect(
      runApiOwnerBootstrapCommand({
        argv: ['--confirm', API_OWNER_BOOTSTRAP_CONFIRMATION],
        environment,
        bootstrapOwner,
      }),
    ).resolves.toBe(0);

    expect(bootstrapOwner).toHaveBeenCalledOnce();
    expect(bootstrapOwner).toHaveBeenCalledWith({
      environment: {
        EMDO_BOOTSTRAP_CONFIRM: API_OWNER_BOOTSTRAP_CONFIRMATION,
        EMDO_BOOTSTRAP_DATABASE_URL: environment.EMDO_BOOTSTRAP_DATABASE_URL,
        EMDO_BOOTSTRAP_HOUSEHOLD_NAME:
          environment.EMDO_BOOTSTRAP_HOUSEHOLD_NAME,
        EMDO_BOOTSTRAP_HOUSEHOLD_SLUG:
          environment.EMDO_BOOTSTRAP_HOUSEHOLD_SLUG,
        EMDO_BOOTSTRAP_OWNER_EMAIL: environment.EMDO_BOOTSTRAP_OWNER_EMAIL,
        EMDO_BOOTSTRAP_OWNER_NAME: environment.EMDO_BOOTSTRAP_OWNER_NAME,
        EMDO_BOOTSTRAP_OWNER_PASSWORD:
          environment.EMDO_BOOTSTRAP_OWNER_PASSWORD,
      },
    });
  });

  it('fails closed with one sanitized line when confirmation is absent', async () => {
    const bootstrapOwner = vi.fn();
    const error = vi.fn();

    await expect(
      runApiOwnerBootstrapCommand({
        argv: [],
        environment: {},
        bootstrapOwner,
        logger: { error },
      }),
    ).resolves.toBe(64);

    expect(bootstrapOwner).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      'Owner bootstrap configuration is invalid.',
    );
  });
});
