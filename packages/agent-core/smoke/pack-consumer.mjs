import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = resolve(packageRoot, '../..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'emdo-agent-core-pack-'));

const modules = [
  'approval-state',
  'budget',
  'factory',
  'index',
  'memory',
  'model-router',
  'runner',
  'trace',
];
const expectedArchiveEntries = [
  'package/package.json',
  ...modules.flatMap((name) => [
    `package/dist/${name}.d.ts`,
    `package/dist/${name}.d.ts.map`,
    `package/dist/${name}.js`,
    `package/dist/${name}.js.map`,
  ]),
].sort();

try {
  execFileSync('pnpm', ['pack', '--pack-destination', temporaryRoot], {
    cwd: packageRoot,
    stdio: 'pipe',
  });
  const archiveName = readdirSync(temporaryRoot).find((name) =>
    name.endsWith('.tgz'),
  );
  if (archiveName === undefined) {
    throw new Error('agent-core-pack-archive-missing');
  }
  const archivePath = join(temporaryRoot, archiveName);
  const archiveEntries = execFileSync('tar', ['-tzf', archivePath], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();
  if (
    JSON.stringify(archiveEntries) !== JSON.stringify(expectedArchiveEntries)
  ) {
    throw new Error(
      `unexpected-agent-core-pack-inventory:${JSON.stringify(archiveEntries)}`,
    );
  }

  execFileSync('tar', ['-xzf', archivePath, '-C', temporaryRoot]);
  const extractedPackage = join(temporaryRoot, 'package');
  const packedManifest = JSON.parse(
    readFileSync(join(extractedPackage, 'package.json'), 'utf8'),
  );
  if (
    packedManifest.exports?.['.']?.types !== './dist/index.d.ts' ||
    packedManifest.dependencies?.['@emdo/contracts'] !== '0.0.0' ||
    !existsSync(join(extractedPackage, 'dist/index.d.ts')) ||
    !existsSync(join(extractedPackage, 'dist/index.js')) ||
    existsSync(join(extractedPackage, 'src'))
  ) {
    throw new Error('agent-core-packed-export-invalid');
  }

  const extractedNodeModules = join(extractedPackage, 'node_modules');
  mkdirSync(extractedNodeModules, { recursive: true });
  mkdirSync(join(extractedNodeModules, '@emdo'), { recursive: true });
  mkdirSync(join(extractedNodeModules, '@openai'), { recursive: true });
  const packedContracts = join(extractedNodeModules, '@emdo/contracts');
  mkdirSync(packedContracts, { recursive: true });
  const contractsSource = resolve(workspaceRoot, 'packages/contracts/src');
  const contractsBuildConfiguration = join(
    temporaryRoot,
    'contracts.tsconfig.json',
  );
  writeFileSync(
    contractsBuildConfiguration,
    JSON.stringify({
      compilerOptions: {
        declaration: true,
        declarationMap: false,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        noEmit: false,
        outDir: join(packedContracts, 'dist'),
        rootDir: contractsSource,
        skipLibCheck: true,
        sourceMap: false,
        strict: true,
        target: 'ES2024',
        verbatimModuleSyntax: true,
      },
      files: [join(contractsSource, 'index.ts')],
    }),
  );
  execFileSync(
    resolve(workspaceRoot, 'node_modules/.bin/tsc'),
    ['--project', contractsBuildConfiguration],
    { stdio: 'pipe' },
  );
  writeFileSync(
    join(packedContracts, 'package.json'),
    JSON.stringify({
      name: '@emdo/contracts',
      version: '0.0.0',
      type: 'module',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          default: './dist/index.js',
        },
      },
    }),
  );
  symlinkSync(
    resolve(packageRoot, 'node_modules/@openai/agents'),
    join(extractedNodeModules, '@openai/agents'),
    'dir',
  );
  symlinkSync(
    resolve(packageRoot, 'node_modules/zod'),
    join(extractedNodeModules, 'zod'),
    'dir',
  );

  const runtime = await import(
    pathToFileURL(join(extractedPackage, 'dist/index.js')).href
  );
  if (
    typeof runtime.ApprovalCheckpointService !== 'function' ||
    typeof runtime.ModelRouter !== 'function' ||
    typeof runtime.SpendGuard !== 'function' ||
    typeof runtime.AgentFactory !== 'function' ||
    typeof runtime.AgentOrchestrator !== 'function' ||
    typeof runtime.OpenAiAgentsExecutionProvider !== 'function' ||
    typeof runtime.createOpenAiAgentsSdkFacade !== 'function' ||
    typeof runtime.createConservativeOpenAiInputTokenCounter !== 'function'
  ) {
    throw new Error('agent-core-packed-runtime-import-failed');
  }

  const consumerRoot = join(temporaryRoot, 'consumer');
  const consumerNodeModules = join(consumerRoot, 'node_modules');
  const consumerModules = join(consumerNodeModules, '@emdo');
  mkdirSync(consumerModules, { recursive: true });
  mkdirSync(join(consumerNodeModules, '@types'), { recursive: true });
  symlinkSync(extractedPackage, join(consumerModules, 'agent-core'), 'dir');
  symlinkSync(
    resolve(workspaceRoot, 'node_modules/@types/node'),
    join(consumerNodeModules, '@types/node'),
    'dir',
  );
  writeFileSync(
    join(consumerRoot, 'consumer.ts'),
    `import { AgentOrchestrator, type AgentSdkToolConfig, type ModelDisclosureGateway } from '@emdo/agent-core';\n` +
      `const gateway: ModelDisclosureGateway = { authorize: async () => ({ status: 'denied', grantId: '018f1f5e-1000-7000-8000-000000000001', reason: 'no-active-grant' }) };\n` +
      `type ProviderWriteTool = Extract<AgentSdkToolConfig, { capabilityKind: 'provider-write' }>;\n` +
      `const genericId = 'google-calendar.event.create' as string;\n` +
      `// @ts-expect-error packed declarations retain the nominal provider-write ID boundary\n` +
      `const invalidProviderId: ProviderWriteTool['canonicalCapabilityId'] = genericId;\n` +
      `void AgentOrchestrator; void gateway; void invalidProviderId;\n`,
  );
  writeFileSync(
    join(consumerRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        target: 'ES2024',
        types: ['node'],
      },
      include: ['consumer.ts'],
    }),
  );
  try {
    execFileSync(
      resolve(workspaceRoot, 'node_modules/.bin/tsc'),
      ['--project', join(consumerRoot, 'tsconfig.json')],
      { cwd: consumerRoot, encoding: 'utf8', stdio: 'pipe' },
    );
  } catch (error) {
    const output =
      error !== null &&
      typeof error === 'object' &&
      'stdout' in error &&
      typeof error.stdout === 'string'
        ? error.stdout.trim()
        : '';
    throw new Error(
      `agent-core-packed-consumer-typecheck-failed${output.length > 0 ? `:\n${output}` : ''}`,
      { cause: error },
    );
  }
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
