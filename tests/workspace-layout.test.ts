import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');

const workspacePaths = [
  'apps/web',
  'apps/api',
  'apps/worker',
  'packages/contracts',
  'packages/db',
  'packages/auth',
  'packages/agent-core',
  'packages/toolbox',
  'packages/integrations',
  'packages/domains',
  'packages/agents/manager',
  'packages/agents/scheduler',
  'packages/agents/finance',
  'packages/agents/shopping',
  'infra/compose',
  'infra/caddy',
  'infra/powersync',
  'evals',
];

const codeWorkspaces = workspacePaths.filter(
  (workspacePath) =>
    workspacePath.startsWith('apps/') || workspacePath.startsWith('packages/'),
);

const architectureDocuments = [
  'docs/architecture/overview.md',
  'docs/architecture/security-boundaries.md',
  'docs/architecture/data-lifecycle.md',
  'docs/architecture/adr/0001-modular-monolith.md',
];

describe('EMDO workspace layout', () => {
  test('provides the approved workspace directories and code package placeholders', () => {
    for (const workspacePath of workspacePaths) {
      expect(existsSync(resolve(root, workspacePath))).toBe(true);
    }

    for (const workspacePath of codeWorkspaces) {
      expect(existsSync(resolve(root, workspacePath, 'package.json'))).toBe(
        true,
      );
      expect(existsSync(resolve(root, workspacePath, 'src/index.ts'))).toBe(
        true,
      );
    }
  });

  test('pins Node 24 and pnpm 9', () => {
    expect(readFileSync(resolve(root, '.nvmrc'), 'utf8').trim()).toBe('24');

    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    );
    expect(manifest.engines).toMatchObject({ node: '>=24 <26', pnpm: '9.x' });
    expect(manifest.packageManager).toMatch(/^pnpm@9\./);
    expect(manifest.type).toBe('module');
    expect(manifest.devDependencies['@types/node']).toMatch(/^24\.\d+\.\d+$/);
  });

  test('exposes the required root developer commands', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    );

    for (const script of [
      'format',
      'format:check',
      'lint',
      'typecheck',
      'test',
      'test:integration',
      'evals',
      'build',
      'dev',
    ]) {
      expect(manifest.scripts[script]).toEqual(expect.any(String));
    }
  });

  test('explicitly typechecks the web TSX graph from the root command', () => {
    const rootManifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    );
    const webManifest = JSON.parse(
      readFileSync(resolve(root, 'apps/web/package.json'), 'utf8'),
    );
    expect(webManifest.scripts.typecheck).toBe(
      'tsc --project tsconfig.json --noEmit',
    );
    expect(rootManifest.scripts.typecheck).toBe(
      'tsc --project tsconfig.base.json --noEmit && pnpm --filter @emdo/web typecheck',
    );

    const webConfigPath = resolve(root, 'apps/web/tsconfig.json');
    const config = ts.readConfigFile(webConfigPath, ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      dirname(webConfigPath),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.fileNames).toContain(resolve(root, 'apps/web/src/main.tsx'));
  });

  test('keeps the shared Vitest runner out of the web package importer', () => {
    const rootManifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    );
    const webManifest = JSON.parse(
      readFileSync(resolve(root, 'apps/web/package.json'), 'utf8'),
    );

    expect(rootManifest.devDependencies.vitest).toEqual(expect.any(String));
    expect(webManifest.devDependencies).not.toHaveProperty('vitest');
  });

  test('records the architectural boundaries', () => {
    for (const documentPath of architectureDocuments) {
      expect(existsSync(resolve(root, documentPath))).toBe(true);
    }
  });

  test('documents privacy scope and approval-class provider mutations', () => {
    const architectureSecurity = readFileSync(
      resolve(root, 'docs/architecture/security-boundaries.md'),
      'utf8',
    );
    const security = readFileSync(resolve(root, 'SECURITY.md'), 'utf8');

    for (const document of [architectureSecurity, security]) {
      expect(document).toContain('Google Calendar writes');
      expect(document).toContain('visual approval');
      expect(document).toMatch(
        /Deterministic reminders,\s+notifications, and\s+retries/,
      );
    }

    expect(architectureSecurity).toMatch(
      /Every record belongs to\s+exactly one server-derived space/,
    );
    expect(architectureSecurity).toContain('retains its original owner');
    expect(architectureSecurity).toMatch(
      /Household\s+owners cannot read member-private content/,
    );
  });
});
