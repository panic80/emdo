import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const apiRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(apiRoot, '../..');
const defaultOutputRoot = join(apiRoot, 'dist');
const migrationsSource = join(repositoryRoot, 'packages/db/drizzle');

const workspaceResolver = {
  name: 'emdo-workspace-source-resolver',
  setup(context) {
    context.onResolve({ filter: /^@emdo\// }, (arguments_) => {
      if (arguments_.path === '@emdo/agent-core') {
        return {
          path: join(repositoryRoot, 'packages/agent-core/src/index.ts'),
        };
      }
      const parent = pathToFileURL(
        join(arguments_.resolveDir || apiRoot, '__resolver__.mjs'),
      ).href;
      const resolved = import.meta.resolve(arguments_.path, parent);
      return { path: fileURLToPath(resolved) };
    });
  },
};

const readMigrationJournal = async () => {
  const journalPath = join(migrationsSource, 'meta/_journal.json');
  const raw = JSON.parse(await readFile(journalPath, 'utf8'));
  if (
    raw === null ||
    typeof raw !== 'object' ||
    !Array.isArray(raw.entries) ||
    raw.entries.length === 0
  ) {
    throw new Error('API migration journal is invalid');
  }
  const tags = raw.entries.map((entry, index) => {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      entry.idx !== index ||
      typeof entry.tag !== 'string' ||
      !/^\d{4}_[a-z0-9_]+$/u.test(entry.tag) ||
      !entry.tag.startsWith(String(index).padStart(4, '0'))
    ) {
      throw new Error('API migration journal is invalid');
    }
    return entry.tag;
  });
  return Object.freeze({ journalPath, tags: Object.freeze(tags) });
};

const listFiles = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files;
};

const allowedExternal = (specifier) =>
  specifier.startsWith('node:') ||
  [
    '@better-auth/passkey',
    '@better-auth/core',
    '@better-auth/utils',
    '@better-fetch/fetch',
    '@openai/agents',
    'better-call',
    'better-auth',
    'drizzle-orm',
    'fastify',
    'jose',
    'kysely',
    'nanostores',
    'pg',
    'zod',
  ].some(
    (packageName) =>
      specifier === packageName || specifier.startsWith(`${packageName}/`),
  );

const validateOutput = async (outputRoot, journal, metafile) => {
  const expected = [
    'index.js',
    'cli/bootstrap-owner.js',
    'cli/migrate.js',
    'cli/purge-finance-imports.js',
    'cli/reconcile-google-oauth-disconnects.js',
    'cli/seed-synthetic.js',
    'cli/staging-acceptance.js',
    'drizzle/meta/_journal.json',
    ...journal.tags.map((tag) => `drizzle/${tag}.sql`),
  ].sort();
  const actual = (await listFiles(outputRoot))
    .map((path) => relative(outputRoot, path))
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('API build artifact allowlist mismatch');
  }

  const forbiddenRuntimeText = [
    /(?:from\s*|import\s*\(|require\s*\()\s*["']@emdo\//u,
    /sourceMappingURL=/u,
    /agentEvalCatalog|agentFixtureCatalog/u,
    /statement-mixed\.csv|private-calendar-evidence\.json|official-api-offer\.ts/u,
    /InMemory(?:Proposal|Invitation|Session)Repository/u,
    /WORKER_JOB_NAMES|Postgres(?:WorkerOutbox|WorkerOperationOutbox|Reminder|NotificationDelivery|DeterministicJobExecution)Repository/u,
    /packages\/(?:agents|agent-core|contracts|db|domains|integrations|toolbox)\/src\//u,
  ];
  for (const relativePath of actual.filter((path) => path.endsWith('.js'))) {
    const source = await readFile(join(outputRoot, relativePath), 'utf8');
    if (forbiddenRuntimeText.some((pattern) => pattern.test(source))) {
      throw new Error(
        `API bundle contains forbidden source content: ${relativePath}`,
      );
    }
    if (
      relativePath === 'index.js' &&
      /loadOrderedMigrations|applyLockedDatabaseMigrations/u.test(source)
    ) {
      throw new Error('API server bundle contains deployment migration code');
    }
  }

  const externals = new Set();
  const bundledInputs = Object.keys(metafile.inputs);
  if (
    bundledInputs.some((path) => /packages\/agent-core\/dist\//u.test(path)) ||
    !bundledInputs.some((path) =>
      /packages\/agent-core\/src\/index\.ts$/u.test(path),
    )
  ) {
    throw new Error('API bundle must resolve agent-core from source');
  }
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external) externals.add(imported.path);
    }
  }
  for (const external of externals) {
    if (external.startsWith('@emdo/') || !allowedExternal(external)) {
      throw new Error(
        `API bundle external import is not allowlisted: ${external}`,
      );
    }
  }
  return Object.freeze({ artifacts: Object.freeze(actual), externals });
};

export const buildApi = async ({ outputRoot = defaultOutputRoot } = {}) => {
  const exactOutputRoot = resolve(outputRoot);
  if (
    exactOutputRoot === repositoryRoot ||
    exactOutputRoot === apiRoot ||
    !exactOutputRoot.startsWith(`${apiRoot}/`)
  ) {
    throw new Error('API build output must remain inside apps/api');
  }
  await rm(exactOutputRoot, { force: true, recursive: true });
  await mkdir(exactOutputRoot, { recursive: true });
  const result = await build({
    absWorkingDir: apiRoot,
    bundle: true,
    entryNames: '[dir]/[name]',
    entryPoints: {
      index: 'src/index.ts',
      'cli/bootstrap-owner': 'src/cli/bootstrap-owner.ts',
      'cli/migrate': 'src/cli/migrate.ts',
      'cli/purge-finance-imports': 'src/cli/purge-finance-imports.ts',
      'cli/reconcile-google-oauth-disconnects':
        'src/cli/reconcile-google-oauth-disconnects.ts',
      'cli/seed-synthetic': 'src/cli/seed-synthetic.ts',
      'cli/staging-acceptance': 'src/cli/staging-acceptance.ts',
    },
    external: [],
    format: 'esm',
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
    minifyIdentifiers: false,
    minifySyntax: true,
    minifyWhitespace: true,
    outdir: exactOutputRoot,
    packages: 'external',
    platform: 'node',
    plugins: [workspaceResolver],
    sourcemap: false,
    target: 'node24',
    treeShaking: true,
  });

  const journal = await readMigrationJournal();
  const journalDestination = join(
    exactOutputRoot,
    'drizzle/meta/_journal.json',
  );
  await mkdir(dirname(journalDestination), { recursive: true });
  await copyFile(journal.journalPath, journalDestination);
  for (const tag of journal.tags) {
    await copyFile(
      join(migrationsSource, `${tag}.sql`),
      join(exactOutputRoot, 'drizzle', `${tag}.sql`),
    );
  }
  return validateOutput(exactOutputRoot, journal, result.metafile);
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  await buildApi();
}
