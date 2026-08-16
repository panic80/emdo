import { pathToFileURL } from 'node:url';

import { Pool, type PoolConfig } from 'pg';
import { z } from 'zod';

const RETENTION_LOGIN = 'emdo_google_oauth_disconnect_retention_login';
const RETENTION_ROLE = 'emdo_google_oauth_disconnect_retention';

const RetentionDatabaseUrlSchema = z
  .string()
  .max(2_048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      url.username === RETENTION_LOGIN &&
      url.password.length > 0 &&
      url.hostname === 'postgres' &&
      url.port === '5432' &&
      url.pathname === '/emdo_app' &&
      url.search === '?sslmode=disable' &&
      url.hash === ''
    );
  });

const RetentionConfigurationSchema = z.strictObject({
  databaseUrl: RetentionDatabaseUrlSchema,
  deploymentEnvironment: z.literal('production'),
  limit: z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/u)
    .transform(Number)
    .pipe(z.number().int().min(1).max(100)),
});

interface RetentionQueryResult {
  readonly rows: readonly unknown[];
  readonly rowCount: number | null;
}

interface RetentionClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<RetentionQueryResult>;
  release(error?: Error | boolean): void;
}

interface RetentionPool {
  connect(): Promise<RetentionClient>;
  end(): Promise<void>;
}

type RetentionPoolFactory = (config: PoolConfig) => RetentionPool;

const createPostgresPool: RetentionPoolFactory = (config) =>
  new Pool(config) as unknown as RetentionPool;

const ReadyRowSchema = z.strictObject({ ready: z.literal(true) });
const RoleRowSchema = z.strictObject({
  current_user_name: z.literal(RETENTION_ROLE),
  session_user_name: z.literal(RETENTION_LOGIN),
});

const requireOneRow = <Output>(
  schema: z.ZodType<Output>,
  rows: readonly unknown[],
): Output => z.array(schema).length(1).parse(rows)[0]!;

const executeRetention = async (input: {
  readonly createPool: RetentionPoolFactory;
  readonly databaseUrl: string;
  readonly limit: number;
}): Promise<number> => {
  const pool = input.createPool({
    allowExitOnIdle: true,
    application_name: 'emdo-google-oauth-disconnect-retention',
    connectionString: input.databaseUrl,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    max: 1,
  });
  let client: RetentionClient | undefined;
  let succeeded = false;
  let purged = 0;
  try {
    client = await pool.connect();
    await client.query('begin');
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '5s'");
    const readiness = await client.query(
      'select emdo.google_oauth_disconnect_retention_runner_ready() as ready',
    );
    requireOneRow(ReadyRowSchema, readiness.rows);
    await client.query(`set local role ${RETENTION_ROLE}`);
    const role = await client.query(
      `select session_user::text as session_user_name,
              current_user::text as current_user_name`,
    );
    requireOneRow(RoleRowSchema, role.rows);
    const result = await client.query(
      'select emdo.purge_completed_google_oauth_disconnects($1::integer) as purged',
      [input.limit],
    );
    purged = requireOneRow(
      z.strictObject({
        purged: z.number().int().min(0).max(input.limit),
      }),
      result.rows,
    ).purged;
    await client.query('commit');
    succeeded = true;
  } catch {
    if (client !== undefined) {
      await client.query('rollback').catch(() => undefined);
    }
  } finally {
    if (client !== undefined) {
      if (succeeded) client.release();
      else client.release(true);
    }
    try {
      await pool.end();
    } catch {
      succeeded = false;
    }
  }
  if (!succeeded) {
    throw new Error('Google OAuth disconnect receipt retention failed');
  }
  return purged;
};

export const runGoogleOAuthDisconnectReceiptRetentionCommand = async (input: {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly createPool?: RetentionPoolFactory;
}): Promise<{ readonly purged: number; readonly status: 'purged' }> => {
  const parsed = RetentionConfigurationSchema.safeParse({
    databaseUrl:
      input.environment.EMDO_GOOGLE_OAUTH_DISCONNECT_RETENTION_DATABASE_URL,
    deploymentEnvironment: input.environment.EMDO_ENVIRONMENT,
    limit: input.environment.EMDO_GOOGLE_OAUTH_DISCONNECT_RETENTION_LIMIT,
  });
  if (
    input.argv.length !== 1 ||
    input.argv[0] !== '--purge-completed-disconnects' ||
    !parsed.success
  ) {
    throw new Error(
      'Google OAuth disconnect receipt retention configuration is invalid',
    );
  }
  const purged = await executeRetention({
    createPool: input.createPool ?? createPostgresPool,
    databaseUrl: parsed.data.databaseUrl,
    limit: parsed.data.limit,
  });
  return Object.freeze({ purged, status: 'purged' as const });
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  void runGoogleOAuthDisconnectReceiptRetentionCommand({
    argv: process.argv.slice(2),
    environment: process.env,
  })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write(
        'Google OAuth disconnect receipt retention failed.\n',
      );
      process.exitCode = 1;
    });
}
