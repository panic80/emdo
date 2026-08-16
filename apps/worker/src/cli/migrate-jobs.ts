import { pathToFileURL } from 'node:url';

import { installPgBossSchema } from '../job-schema.js';

export interface JobSchemaCliResult {
  readonly schemaVersion: number;
}

export const runJobSchemaCli = async (input: {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly installer?: (input: {
    readonly databaseUrl: string;
  }) => Promise<JobSchemaCliResult>;
}): Promise<JobSchemaCliResult> => {
  const databaseUrl = input.environment.EMDO_JOB_MIGRATION_DATABASE_URL;
  if (
    input.argv.length !== 1 ||
    input.argv[0] !== '--install-only' ||
    typeof databaseUrl !== 'string' ||
    databaseUrl.length < 1
  ) {
    throw new Error('Job schema CLI configuration is invalid');
  }
  return (input.installer ?? installPgBossSchema)({ databaseUrl });
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  void runJobSchemaCli({
    argv: process.argv.slice(2),
    environment: process.env,
  })
    .then((result) => {
      process.stdout.write(
        `${JSON.stringify({ status: 'installed', schemaVersion: result.schemaVersion })}\n`,
      );
    })
    .catch(() => {
      process.stderr.write('Job schema installation failed.\n');
      process.exitCode = 1;
    });
}
