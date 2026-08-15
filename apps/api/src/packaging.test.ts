import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('API production package', () => {
  it('emits a clean exact bundle with no workspace/runtime fixture leakage', async () => {
    execFileSync(process.execPath, ['build.mjs'], {
      cwd: apiRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const listFiles = async (directory: string): Promise<string[]> => {
      const files: string[] = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...(await listFiles(path)));
        else files.push(path);
      }
      return files;
    };
    const dist = resolve(apiRoot, 'dist');
    const artifacts = (await listFiles(dist))
      .map((path) => relative(dist, path))
      .sort();
    const sourceJournal = JSON.parse(
      await readFile(
        resolve(apiRoot, '../../packages/db/drizzle/meta/_journal.json'),
        'utf8',
      ),
    ) as { readonly entries: readonly { readonly tag: string }[] };
    const expectedArtifacts = [
      'cli/bootstrap-owner.js',
      'cli/migrate.js',
      'cli/seed-synthetic.js',
      'cli/staging-acceptance.js',
      'drizzle/meta/_journal.json',
      ...sourceJournal.entries.map(({ tag }) => `drizzle/${tag}.sql`),
      'index.js',
    ].sort();
    expect(artifacts).toEqual(expectedArtifacts);
    expect(artifacts.some((path) => /\.(?:map|ts|tsx)$/u.test(path))).toBe(
      false,
    );
    for (const artifact of artifacts.filter((path) => path.endsWith('.js'))) {
      const source = await readFile(resolve(dist, artifact), 'utf8');
      expect(source).not.toMatch(
        /(?:from\s*|import\s*\(|require\s*\()\s*["']@emdo\//u,
      );
      expect(source).not.toMatch(
        /agentEvalCatalog|agentFixtureCatalog|statement-mixed\.csv|private-calendar-evidence\.json|official-api-offer/u,
      );
    }
    const apiSource = await readFile(resolve(dist, 'index.js'), 'utf8');
    expect(apiSource).not.toMatch(
      /InMemory(?:Invitation|Session|Proposal)|packages\/db\/src\/(?:schema|worker|migrations)/u,
    );
    const stagingAcceptanceSource = await readFile(
      resolve(dist, 'cli/staging-acceptance.js'),
      'utf8',
    );
    expect(stagingAcceptanceSource).toContain(
      'authority.household-administration',
    );
    expect(stagingAcceptanceSource).toContain(
      '/api/v1/experience/notification-preferences',
    );
    expect(stagingAcceptanceSource).toContain(
      'Readiness checks do not match synthetic HTTP subset contract version 1',
    );
    expect(stagingAcceptanceSource).toContain('/synthetic-staging/readyz');
    expect(stagingAcceptanceSource).toContain('syntheticHttpSubsetReadiness');
    expect(stagingAcceptanceSource).not.toContain('Core readiness gate failed');

    for (const entrypoint of [
      './dist/index.js',
      './dist/cli/bootstrap-owner.js',
      './dist/cli/migrate.js',
      './dist/cli/seed-synthetic.js',
      './dist/cli/staging-acceptance.js',
    ]) {
      expect(() =>
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '--eval',
            `await import(${JSON.stringify(entrypoint)})`,
          ],
          { cwd: apiRoot, encoding: 'utf8', stdio: 'pipe' },
        ),
      ).not.toThrow();
    }

    const apiExports = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `console.log(JSON.stringify(Object.keys(await import('./dist/index.js')).sort()))`,
        ],
        { cwd: apiRoot, encoding: 'utf8', stdio: 'pipe' },
      ),
    ) as string[];
    expect(apiExports).toContain('startApiFromEnvironment');
    expect(apiExports).not.toContain('startApiServer');

    const invalidApiStartup = spawnSync(process.execPath, ['./dist/index.js'], {
      cwd: apiRoot,
      encoding: 'utf8',
      env: Object.freeze({ PATH: process.env.PATH ?? '' }),
    });
    expect(invalidApiStartup.status).toBe(1);
    expect(invalidApiStartup.stdout).toBe('');
    expect(invalidApiStartup.stderr).toBe(
      `${JSON.stringify({ level: 'fatal', code: 'api-startup-failed' })}\n`,
    );

    for (const [entrypoint, argv, expectedError, expectedExit] of [
      [
        './dist/cli/bootstrap-owner.js',
        [],
        'Owner bootstrap configuration is invalid.',
        64,
      ],
      [
        './dist/cli/migrate.js',
        ['--require-backward-compatible'],
        'Database migration failed.',
        1,
      ],
      [
        './dist/cli/seed-synthetic.js',
        ['--fail-if-nonempty', '--staging-only'],
        'Synthetic staging seed failed.',
        1,
      ],
      [
        './dist/cli/staging-acceptance.js',
        [
          '--all-mvp-gates',
          '--require-synthetic',
          '--forbid-external-providers',
        ],
        'Staging acceptance failed.',
        1,
      ],
    ] as const) {
      const execution = spawnSync(process.execPath, [entrypoint, ...argv], {
        cwd: apiRoot,
        encoding: 'utf8',
        env: Object.freeze({ PATH: process.env.PATH ?? '' }),
      });
      expect(execution.status).toBe(expectedExit);
      expect(execution.stdout).toBe('');
      expect(execution.stderr).toBe(`${expectedError}\n`);
    }

    const packageJson = JSON.parse(
      await readFile(resolve(apiRoot, 'package.json'), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      exports?: unknown;
    };
    expect(packageJson.exports).toBeUndefined();
    expect(Object.keys(packageJson.dependencies).sort()).toEqual([
      '@better-auth/core',
      '@better-auth/passkey',
      '@better-auth/utils',
      '@better-fetch/fetch',
      '@openai/agents',
      'better-auth',
      'better-call',
      'drizzle-orm',
      'fastify',
      'jose',
      'kysely',
      'nanostores',
      'pg',
      'zod',
    ]);
    expect(
      Object.keys(packageJson.devDependencies)
        .filter((name) => name.startsWith('@emdo/'))
        .sort(),
    ).toEqual([
      '@emdo/agent-core',
      '@emdo/agent-finance',
      '@emdo/agent-manager',
      '@emdo/agent-scheduler',
      '@emdo/agent-shopping',
      '@emdo/auth',
      '@emdo/contracts',
      '@emdo/db',
      '@emdo/domains',
      '@emdo/integrations',
      '@emdo/toolbox',
    ]);
  }, 30_000);
});
