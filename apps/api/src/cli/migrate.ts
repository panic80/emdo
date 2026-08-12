import { fileURLToPath, pathToFileURL } from 'node:url';

import { applyLockedDatabaseMigrations } from '@emdo/db/migrations';
import { Pool } from 'pg';
import { z } from 'zod';

const MigrationConfigurationSchema = z.strictObject({
  databaseUrl: z
    .url()
    .refine((value) =>
      ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
    ),
  deploymentEnvironment: z.enum(['staging', 'production']),
  mode: z.literal('expand-contract'),
});

const packagedMigrationsFolder = fileURLToPath(
  new URL('../drizzle/', import.meta.url),
);

type MigrationExecutor = (input: {
  readonly databaseUrl: string;
  readonly migrationsFolder: string;
}) => Promise<void>;

const migrateWithDedicatedPool: MigrationExecutor = async (input) => {
  const pool = new Pool({
    application_name: 'emdo-api-migration',
    connectionString: input.databaseUrl,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    max: 1,
    allowExitOnIdle: true,
  });
  try {
    await applyLockedDatabaseMigrations(pool, {
      migrationsFolder: input.migrationsFolder,
    });
  } finally {
    await pool.end().catch(() => undefined);
  }
};

export const runMigrationCommand = async (input: {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly migrate?: MigrationExecutor;
}): Promise<{ readonly status: 'migrated' }> => {
  const parsed = MigrationConfigurationSchema.safeParse({
    databaseUrl: input.environment.EMDO_MIGRATION_DATABASE_URL,
    deploymentEnvironment: input.environment.EMDO_ENVIRONMENT,
    mode: input.environment.EMDO_MIGRATION_MODE,
  });
  if (
    input.argv.length !== 1 ||
    input.argv[0] !== '--require-backward-compatible' ||
    !parsed.success
  ) {
    throw new Error('Migration CLI configuration is invalid');
  }
  await (input.migrate ?? migrateWithDedicatedPool)({
    databaseUrl: parsed.data.databaseUrl,
    migrationsFolder: packagedMigrationsFolder,
  });
  return Object.freeze({ status: 'migrated' as const });
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  void runMigrationCommand({
    argv: process.argv.slice(2),
    environment: process.env,
  })
    .then(() => process.stdout.write('{"status":"migrated"}\n'))
    .catch(() => {
      process.stderr.write('Database migration failed.\n');
      process.exitCode = 1;
    });
}
