import { spawn } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

import { build } from 'esbuild';

const packageRoot = new URL('./', import.meta.url);
const outputDirectory = new URL('dist/', packageRoot);

await rm(fileURLToPath(outputDirectory), { force: true, recursive: true });
await build({
  absWorkingDir: fileURLToPath(packageRoot),
  bundle: true,
  entryPoints: {
    index: 'src/index.ts',
    'cli/migrate-jobs': 'src/cli/migrate-jobs.ts',
  },
  external: ['pg', 'pg-boss', 'zod'],
  format: 'esm',
  logLevel: 'info',
  legalComments: 'none',
  minify: true,
  outdir: 'dist',
  platform: 'node',
  sourcemap: false,
  target: 'node24',
});

const listFiles = async (directory, prefix = '') => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(
        ...(await listFiles(new URL(`${entry.name}/`, directory), relative)),
      );
    } else {
      files.push(relative);
    }
  }
  return files.sort();
};

const artifacts = await listFiles(outputDirectory);
const expectedArtifacts = ['cli/migrate-jobs.js', 'index.js'];
if (JSON.stringify(artifacts) !== JSON.stringify(expectedArtifacts)) {
  throw new Error('Worker build produced an unexpected artifact set');
}
for (const artifact of artifacts) {
  const content = await readFile(new URL(artifact, outputDirectory), 'utf8');
  for (const forbidden of [
    '@emdo/',
    'sourceMappingURL',
    '/Users/mattermost',
    '// ../../packages/',
    'EMDO_WORKER_PROVIDER_MODULE',
    'google_oauth',
    'migrationsDirectoryUrl',
    'better-auth',
    'agent_run',
    'ai_spend',
    'approval_checkpoints',
  ]) {
    if (content.includes(forbidden)) {
      throw new Error('Worker build retained a forbidden runtime marker');
    }
  }
}

const assertSafeDirectExecutionFailure = async (artifact, expectedStderr) => {
  const artifactPath = fileURLToPath(new URL(artifact, outputDirectory));
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [artifactPath], {
      cwd: fileURLToPath(packageRoot),
      env: { NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill('SIGKILL');
      reject(new Error('Worker artifact direct-execution guard failed'));
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      fail();
    }, 5_000);
    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next) > 4_096) fail();
      return next;
    };
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', fail);
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (
        code !== 1 ||
        signal !== null ||
        stdout !== '' ||
        stderr !== expectedStderr
      ) {
        reject(new Error('Worker artifact direct-execution guard failed'));
        return;
      }
      resolve();
    });
  });
};

await Promise.all([
  assertSafeDirectExecutionFailure('index.js', 'Worker startup failed.\n'),
  assertSafeDirectExecutionFailure(
    'cli/migrate-jobs.js',
    'Job schema installation failed.\n',
  ),
]);

// Execute the bundled public boundary with honest unavailable providers. This
// proves that optional provider degradation does not block core readiness.
const worker = await import(
  new URL(`index.js?smoke=${Date.now()}`, outputDirectory)
);
const health = worker.createWorkerHealthResponder();
const smokeEnvironment = {
  EMDO_WORKER_DATABASE_URL:
    'postgresql://emdo_worker_login:queue-smoke@localhost/emdo',
  EMDO_WORKER_EXECUTOR_DATABASE_URL:
    'postgresql://emdo_worker_executor_login:executor-smoke@localhost/emdo',
  EMDO_WORKER_DISPATCHER_DATABASE_URL:
    'postgresql://emdo_worker_dispatcher_login:dispatcher-smoke@localhost/emdo',
  EMDO_APPLICATION_ORIGIN: 'https://artifact-smoke.invalid',
  EMDO_WORKER_DISPATCHER_ID: 'artifact-smoke',
  HEALTH_HOST: '127.0.0.1',
  HEALTH_PORT: '3001',
};
let providerFailure;
let providerFailureDatabaseCreations = 0;
try {
  await worker.createDirectProductionWorkerComposition({
    environment: {
      ...smokeEnvironment,
      EMDO_EXTERNAL_PROVIDERS_ENABLED: 'true',
    },
    createDatabase() {
      providerFailureDatabaseCreations += 1;
      throw new Error('direct provider failure opened a database pool');
    },
  });
} catch (error) {
  providerFailure = error;
}
if (
  !(providerFailure instanceof worker.ProductionWorkerProviderError) ||
  JSON.stringify(providerFailure.blockers) !==
    JSON.stringify([
      'worker-email-adapter-unavailable',
      'worker-push-adapter-unavailable',
      'worker-calendar-broker-unavailable',
    ]) ||
  providerFailureDatabaseCreations !== 0
) {
  throw new Error(
    'Worker artifact did not fail closed without provider adapters',
  );
}
const activatedRoles = [];
const composition = await worker.createDirectProductionWorkerComposition({
  environment: smokeEnvironment,
  createDatabase(input) {
    activatedRoles.push(
      `${new URL(input.connectionString).username}:${input.fixedRole}`,
    );
    return {
      scopedPool: {
        async connect() {
          return {
            async query() {
              return { rowCount: 0, rows: [] };
            },
            release() {},
          };
        },
      },
      async checkReady() {},
      async close() {},
    };
  },
});
if (
  JSON.stringify(activatedRoles) !==
  JSON.stringify([
    'emdo_worker_executor_login:emdo_worker_executor',
    'emdo_worker_dispatcher_login:emdo_worker_dispatch_executor',
  ])
) {
  throw new Error('Worker artifact did not activate fixed database roles');
}
const handle = await worker.startWorkerProcess({
  environment: smokeEnvironment,
  async createComposition() {
    return composition;
  },
  async createHealthServer() {
    return {
      port: 3001,
      setReady: (ready) => health.setReady(ready),
      setProviderStatus: (status) => health.setProviderStatus(status),
      async close() {
        health.setReady(false);
      },
    };
  },
  async startQueue() {
    return {
      async enqueue() {
        return { status: 'duplicate' };
      },
      async stop() {},
    };
  },
});
const readiness = health.respond({ method: 'GET', url: '/readyz' });
if (
  readiness.statusCode !== 200 ||
  !readiness.body.includes('"overall":"degraded"') ||
  !readiness.body.includes('"calendar":"unavailable"')
) {
  throw new Error('Worker artifact did not expose degraded readiness');
}
await handle.stop();
