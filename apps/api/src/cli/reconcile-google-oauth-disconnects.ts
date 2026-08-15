import { pathToFileURL } from 'node:url';

import { Pool, type PoolConfig } from 'pg';
import { z } from 'zod';

const RECONCILIATION_LOGIN =
  'emdo_google_oauth_disconnect_reconciliation_login';
const RECONCILIATION_ROLE = 'emdo_google_oauth_disconnect_reconciliation';

const ReconciliationDatabaseUrlSchema = z
  .string()
  .max(2_048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      url.username === RECONCILIATION_LOGIN &&
      url.password.length > 0 &&
      url.hostname === 'postgres' &&
      url.port === '5432' &&
      url.pathname === '/emdo_app' &&
      url.search === '?sslmode=disable' &&
      url.hash === ''
    );
  });

const ReconciliationConfigurationSchema = z.strictObject({
  databaseUrl: ReconciliationDatabaseUrlSchema,
  deploymentEnvironment: z.literal('production'),
  limit: z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/u)
    .transform(Number)
    .pipe(z.number().int().min(1).max(100)),
});

interface ReconciliationQueryResult {
  readonly rows: readonly unknown[];
  readonly rowCount: number | null;
}

interface ReconciliationClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<ReconciliationQueryResult>;
  release(error?: Error | boolean): void;
}

interface ReconciliationPool {
  connect(): Promise<ReconciliationClient>;
  end(): Promise<void>;
}

type ReconciliationPoolFactory = (config: PoolConfig) => ReconciliationPool;

const createPostgresPool: ReconciliationPoolFactory = (config) =>
  new Pool(config) as unknown as ReconciliationPool;

const ReadyRowSchema = z.strictObject({ ready: z.literal(true) });
const RoleRowSchema = z.strictObject({
  current_user_name: z.literal(RECONCILIATION_ROLE),
  session_user_name: z.literal(RECONCILIATION_LOGIN),
});

const requireOneRow = <Output>(
  schema: z.ZodType<Output>,
  rows: readonly unknown[],
): Output => z.array(schema).length(1).parse(rows)[0]!;

const executeReconciliation = async (input: {
  readonly createPool: ReconciliationPoolFactory;
  readonly databaseUrl: string;
  readonly limit: number;
}): Promise<number> => {
  const pool = input.createPool({
    allowExitOnIdle: true,
    application_name: 'emdo-google-oauth-disconnect-reconciliation',
    connectionString: input.databaseUrl,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    max: 1,
  });
  let client: ReconciliationClient | undefined;
  let succeeded = false;
  let reconciled = 0;
  try {
    client = await pool.connect();
    await client.query('begin');
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '5s'");
    const readiness = await client.query(
      'select emdo.google_oauth_disconnect_reconciliation_runner_ready() as ready',
    );
    requireOneRow(ReadyRowSchema, readiness.rows);
    await client.query(`set local role ${RECONCILIATION_ROLE}`);
    const role = await client.query(
      `select session_user::text as session_user_name,
              current_user::text as current_user_name`,
    );
    requireOneRow(RoleRowSchema, role.rows);
    const result = await client.query(
      'select emdo.reconcile_stranded_google_oauth_disconnects($1::integer) as reconciled',
      [input.limit],
    );
    reconciled = requireOneRow(
      z.strictObject({
        reconciled: z.number().int().min(0).max(input.limit),
      }),
      result.rows,
    ).reconciled;
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
    throw new Error('Google OAuth disconnect reconciliation failed');
  }
  return reconciled;
};

export const runGoogleOAuthDisconnectReconciliationCommand = async (input: {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly createPool?: ReconciliationPoolFactory;
}): Promise<{
  readonly reconciled: number;
  readonly status: 'reconciled';
}> => {
  const parsed = ReconciliationConfigurationSchema.safeParse({
    databaseUrl:
      input.environment
        .EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_DATABASE_URL,
    deploymentEnvironment: input.environment.EMDO_ENVIRONMENT,
    limit: input.environment.EMDO_GOOGLE_OAUTH_DISCONNECT_RECONCILIATION_LIMIT,
  });
  if (
    input.argv.length !== 1 ||
    input.argv[0] !== '--reconcile-stranded-disconnects' ||
    !parsed.success
  ) {
    throw new Error(
      'Google OAuth disconnect reconciliation configuration is invalid',
    );
  }
  const reconciled = await executeReconciliation({
    createPool: input.createPool ?? createPostgresPool,
    databaseUrl: parsed.data.databaseUrl,
    limit: parsed.data.limit,
  });
  return Object.freeze({ reconciled, status: 'reconciled' as const });
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  void runGoogleOAuthDisconnectReconciliationCommand({
    argv: process.argv.slice(2),
    environment: process.env,
  })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write('Google OAuth disconnect reconciliation failed.\n');
      process.exitCode = 1;
    });
}
