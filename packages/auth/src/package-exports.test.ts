import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const authRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('auth package production boundary', () => {
  it('declares the complete passkey runtime dependency closure', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(authRoot, 'package.json'), 'utf8'),
    ) as {
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly devDependencies?: Readonly<Record<string, string>>;
    };
    const expectedRuntimeDependencies = {
      '@better-auth/core': '1.6.26',
      '@better-auth/utils': '0.4.2',
      '@better-fetch/fetch': '1.3.1',
      'better-call': '1.3.7',
      nanostores: '1.4.2',
    } as const;

    expect(packageJson.dependencies).toMatchObject(expectedRuntimeDependencies);
    for (const dependency of Object.keys(expectedRuntimeDependencies)) {
      expect(packageJson.devDependencies?.[dependency]).toBeUndefined();
    }
  });

  it('exposes a curated server facade without in-memory adapters', async () => {
    const serverSpecifier: string = '@emdo/auth/server';
    const [root, server] = await Promise.all([
      import('@emdo/auth'),
      import(serverSpecifier),
    ]);

    for (const facade of [root, server]) {
      expect(facade).toHaveProperty('createEmdoBetterAuth');
      expect(facade).toHaveProperty('InvitedAccountOnboardingService');
      expect(facade).toHaveProperty('CsrfProtector');
      expect(facade).toHaveProperty('InvitationService');
      expect(facade).toHaveProperty('RotatingSessionService');
      expect(facade).not.toHaveProperty('InMemoryInvitationRepository');
      expect(facade).not.toHaveProperty('InMemorySessionRepository');
    }
  });
});
