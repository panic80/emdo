import { createRequire } from 'node:module';

import { deepFreeze } from '@emdo/contracts';
import type { ConstructorOptions } from 'pg-boss';
import { z } from 'zod';

export interface PgBossMigrationRuntime {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  start(): Promise<unknown>;
  getDb(): {
    executeSql(
      statement: string,
      values?: readonly unknown[],
    ): Promise<{ readonly rows: readonly unknown[] }>;
  };
  isInstalled(): Promise<boolean>;
  schemaVersion(): Promise<number | null>;
  detectSchemaDrift(): Promise<unknown>;
  getBamStatus(): Promise<unknown>;
  stop(options?: { readonly graceful?: boolean }): Promise<unknown>;
}

export interface PgBossMigrationRuntimeModule {
  readonly PgBoss: new (options: unknown) => PgBossMigrationRuntime;
}

const isSafeDatabaseUrl = (input: string): boolean => {
  try {
    if (input !== input.trim() || input.length > 4_096) return false;
    if (
      Array.from(input).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      })
    ) {
      return false;
    }
    const url = new URL(input);
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      url.username.length > 0 &&
      url.hostname.length > 0 &&
      url.pathname.length > 1 &&
      url.hash === ''
    );
  } catch {
    return false;
  }
};

const defaultModuleLoader = async (): Promise<unknown> => {
  const require = createRequire(import.meta.url);
  return require('pg-boss') as unknown;
};

const parseModule = (
  input: unknown,
): new (options: unknown) => PgBossMigrationRuntime => {
  try {
    if (input === null || typeof input !== 'object') throw new Error('invalid');
    const descriptor = Object.getOwnPropertyDescriptor(input, 'PgBoss');
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      typeof descriptor.value !== 'function'
    ) {
      throw new Error('invalid');
    }
    return descriptor.value as new (options: unknown) => PgBossMigrationRuntime;
  } catch {
    throw new Error('pg-boss migration runtime is unavailable');
  }
};

const createOptions = (databaseUrl: string): ConstructorOptions => ({
  connectionString: databaseUrl,
  schema: 'pgboss',
  application_name: 'emdo-job-schema',
  migrate: true,
  createSchema: true,
  supervise: false,
  schedule: false,
  useListenNotify: false,
  bamIntervalSeconds: 10,
});

const RuntimeDriftResultSchema = z.object({
  ok: z.literal(true),
  building: z.array(z.unknown()).length(0),
});

const BamStatusSchema = z.array(
  z.strictObject({
    status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
    count: z.number().int().nonnegative(),
    lastCreatedOn: z.unknown(),
  }),
);

interface BamPollingOptions {
  readonly intervalMilliseconds: number;
  readonly maximumAttempts: number;
  readonly wait: (milliseconds: number) => Promise<void>;
}

const defaultBamPolling: BamPollingOptions = Object.freeze({
  intervalMilliseconds: 500,
  maximumAttempts: 1_200,
  wait: (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
});

const waitForBamCompletion = async (
  runtime: PgBossMigrationRuntime,
  options: BamPollingOptions,
  hasRuntimeError: () => boolean,
): Promise<void> => {
  if (
    !Number.isSafeInteger(options.intervalMilliseconds) ||
    options.intervalMilliseconds < 1 ||
    options.intervalMilliseconds > 5_000 ||
    !Number.isSafeInteger(options.maximumAttempts) ||
    options.maximumAttempts < 1 ||
    options.maximumAttempts > 1_200 ||
    typeof options.wait !== 'function'
  ) {
    throw new Error('invalid');
  }
  for (let attempt = 0; attempt < options.maximumAttempts; attempt += 1) {
    const parsed = BamStatusSchema.safeParse(await runtime.getBamStatus());
    if (!parsed.success || hasRuntimeError()) throw new Error('invalid');
    const failed = parsed.data.some(
      (status) => status.status === 'failed' && status.count > 0,
    );
    if (failed) throw new Error('invalid');
    const incomplete = parsed.data.some(
      (status) =>
        (status.status === 'pending' || status.status === 'in_progress') &&
        status.count > 0,
    );
    if (!incomplete) return;
    if (attempt === options.maximumAttempts - 1) throw new Error('invalid');
    await options.wait(options.intervalMilliseconds);
  }
  throw new Error('invalid');
};

const WORKER_GRANTS_SQL = `
REVOKE ALL PRIVILEGES ON SCHEMA pgboss FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA pgboss FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA pgboss FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA pgboss FROM PUBLIC;

GRANT USAGE ON SCHEMA pgboss TO emdo_worker_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO emdo_worker_login;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA pgboss TO emdo_worker_login;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO emdo_worker_login;

ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO emdo_worker_login;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO emdo_worker_login;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
  GRANT EXECUTE ON FUNCTIONS TO emdo_worker_login;
`;

export const installPgBossSchema = async (input: {
  readonly databaseUrl: string;
  readonly moduleLoader?: () => Promise<unknown>;
  readonly bamPolling?: BamPollingOptions;
}): Promise<{ readonly schemaVersion: number }> => {
  if (!isSafeDatabaseUrl(input.databaseUrl)) {
    throw new Error('Job schema database configuration is invalid');
  }

  let rawModule: unknown;
  try {
    rawModule = await (input.moduleLoader ?? defaultModuleLoader)();
  } catch {
    throw new Error('pg-boss migration runtime is unavailable');
  }
  const PgBoss = parseModule(rawModule);
  let runtime: PgBossMigrationRuntime;
  try {
    runtime = new PgBoss(createOptions(input.databaseUrl));
  } catch {
    throw new Error('pg-boss migration runtime is unavailable');
  }

  let runtimeErrored = false;
  let installedResult: { readonly schemaVersion: number } | undefined;
  let failed = false;
  try {
    runtime.on('error', () => {
      runtimeErrored = true;
    });
    await runtime.start();
    await waitForBamCompletion(
      runtime,
      input.bamPolling ?? defaultBamPolling,
      () => runtimeErrored,
    );
    await runtime.getDb().executeSql(WORKER_GRANTS_SQL);
    const installed = await runtime.isInstalled();
    const schemaVersion = await runtime.schemaVersion();
    const drift = await runtime.detectSchemaDrift();
    if (
      runtimeErrored ||
      !installed ||
      schemaVersion === null ||
      !Number.isSafeInteger(schemaVersion) ||
      schemaVersion < 1 ||
      !RuntimeDriftResultSchema.safeParse(drift).success
    ) {
      throw new Error('invalid');
    }
    installedResult = deepFreeze({ schemaVersion });
  } catch {
    failed = true;
  }
  try {
    await runtime.stop({ graceful: true });
  } catch {
    failed = true;
  }
  if (failed || installedResult === undefined) {
    throw new Error('pg-boss schema installation failed');
  }
  return installedResult;
};
