#!/usr/bin/env node

import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import process from 'node:process';

const requestedRoot = process.argv[2];
if (requestedRoot === undefined) {
  throw new Error('usage: validate-runtime-package.mjs <api|worker>');
}

const packageRoot = await realpath(requestedRoot);
const packageName = basename(packageRoot);
if (!['api', 'worker', 'web'].includes(packageName)) {
  throw new Error('runtime package must be named api, worker, or web');
}

const requiredArtifacts = {
  api: [
    'dist/index.js',
    'dist/cli/migrate.js',
    'dist/cli/seed-synthetic.js',
    'dist/cli/staging-acceptance.js',
  ],
  worker: ['dist/index.js', 'dist/cli/migrate-jobs.js'],
  web: ['dist/index.html'],
};

for (const relativePath of [
  'package.json',
  ...(packageName === 'web' ? [] : ['node_modules']),
  ...requiredArtifacts[packageName],
]) {
  const artifact = join(packageRoot, relativePath);
  const metadata = await lstat(artifact);
  if (metadata.isSymbolicLink()) {
    throw new Error(`runtime artifact cannot be a symlink: ${relativePath}`);
  }
}

const workspaceSpecifier =
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']@emdo\//;

const inspectDist = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`runtime dist cannot contain symlink: ${path}`);
    }
    if (entry.isDirectory()) {
      await inspectDist(path);
      continue;
    }
    if (/\.(?:map|ts|tsx)$/.test(entry.name)) {
      throw new Error(`runtime dist contains source artifact: ${path}`);
    }
    if (!/\.(?:css|html|js|json|webmanifest)$/.test(entry.name)) continue;
    const source = await readFile(path, 'utf8');
    if (source.includes('sourceMappingURL=')) {
      throw new Error(`runtime JavaScript references a source map: ${path}`);
    }
    if (entry.name.endsWith('.js') && workspaceSpecifier.test(source)) {
      throw new Error(
        `runtime JavaScript retains a workspace runtime import: ${path}`,
      );
    }
  }
};

const inspectNodeModules = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '@emdo' || entry.name.startsWith('@emdo+')) {
      throw new Error(
        `runtime node_modules retains workspace package: ${entry.name}`,
      );
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await inspectNodeModules(join(directory, entry.name));
    }
  }
};

await inspectDist(join(packageRoot, 'dist'));
if (packageName !== 'web') {
  await inspectNodeModules(join(packageRoot, 'node_modules'));
}
