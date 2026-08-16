#!/usr/bin/env node

import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

const requestedRoot = process.argv[2];
if (requestedRoot === undefined) {
  throw new Error('usage: prune-deployed-workspace.mjs <package>/node_modules');
}

const root = await realpath(requestedRoot);
const packageName = basename(dirname(root));
if (
  basename(root) !== 'node_modules' ||
  !['api', 'worker'].includes(packageName)
) {
  throw new Error('refusing to prune outside an api/worker node_modules tree');
}

const isWorkspacePackageEntry = (name) =>
  name === '@emdo' || name.startsWith('@emdo+');

const prune = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (isWorkspacePackageEntry(entry.name)) {
      await rm(path, { recursive: true, force: false });
      continue;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await prune(path);
    }
  }
};

await prune(root);

const assertPruned = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (isWorkspacePackageEntry(entry.name)) {
      throw new Error(
        `workspace package remained after pruning: ${entry.name}`,
      );
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await assertPruned(join(directory, entry.name));
    } else {
      await lstat(join(directory, entry.name));
    }
  }
};

await assertPruned(root);
