import { hashPassword as betterAuthHashPassword } from 'better-auth/crypto';
import { Pool } from 'pg';
import { z } from 'zod';

export const OWNER_BOOTSTRAP_CONFIRMATION = 'bootstrap-initial-owner-v1';

const BetterAuthPasswordHashSchema = z
  .string()
  .regex(/^[a-f0-9]{32}:[a-f0-9]{128}$/);
const BootstrapEnvironmentSchema = z.strictObject({
  confirmation: z.literal(OWNER_BOOTSTRAP_CONFIRMATION),
  connectionString: z
    .url()
    .refine((value) =>
      ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
    ),
  householdName: z.string().trim().min(1).max(100),
  householdSlug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  ownerEmail: z.string().trim().toLowerCase().email().max(320),
  ownerName: z.string().trim().min(1).max(100),
  ownerPassword: z.string().min(12).max(128),
});
const DatabaseRoleSchema = z.strictObject({
  is_member: z.boolean(),
  rolbypassrls: z.boolean(),
  rolsuper: z.boolean(),
});
const BootstrapResultSchema = z.strictObject({
  user_id: z.uuid(),
  household_id: z.uuid(),
  membership_id: z.uuid(),
  private_space_id: z.uuid(),
  completed_at: z.coerce.date(),
});

export interface BootstrapOwnerEnvironment {
  EMDO_BOOTSTRAP_CONFIRM?: string;
  EMDO_BOOTSTRAP_DATABASE_URL?: string;
  EMDO_BOOTSTRAP_HOUSEHOLD_NAME?: string;
  EMDO_BOOTSTRAP_HOUSEHOLD_SLUG?: string;
  EMDO_BOOTSTRAP_OWNER_EMAIL?: string;
  EMDO_BOOTSTRAP_OWNER_NAME?: string;
  EMDO_BOOTSTRAP_OWNER_PASSWORD?: string;
}

interface BootstrapOwnerQueryResult {
  readonly rowCount: number | null;
  readonly rows: readonly Record<string, unknown>[];
}

interface BootstrapOwnerClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<BootstrapOwnerQueryResult>;
  release(): void;
}

export interface BootstrapOwnerPool {
  connect(): Promise<BootstrapOwnerClient>;
  end(): Promise<void>;
}

export interface BootstrapOwnerDependencies {
  readonly createPool: (configuration: {
    readonly application_name: string;
    readonly connectionString: string;
    readonly connectionTimeoutMillis: number;
    readonly max: number;
  }) => BootstrapOwnerPool;
  readonly hashPassword: (password: string) => Promise<string>;
}

export interface BootstrapOwnerLogger {
  error(message: string): void;
  info(message: string): void;
}

const defaultDependencies: BootstrapOwnerDependencies = {
  createPool: (configuration) => new Pool(configuration),
  hashPassword: betterAuthHashPassword,
};

const defaultLogger: BootstrapOwnerLogger = {
  error: (message) => console.error(message),
  info: (message) => console.info(message),
};

class UnsafeBootstrapDatabaseRoleError extends Error {}

const sqlState = (error: unknown): string | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string'
    ? error.code
    : undefined;

const readEnvironment = (environment: BootstrapOwnerEnvironment) => {
  const ownerPassword = environment.EMDO_BOOTSTRAP_OWNER_PASSWORD;
  delete environment.EMDO_BOOTSTRAP_OWNER_PASSWORD;
  return BootstrapEnvironmentSchema.parse({
    confirmation: environment.EMDO_BOOTSTRAP_CONFIRM,
    connectionString: environment.EMDO_BOOTSTRAP_DATABASE_URL,
    householdName: environment.EMDO_BOOTSTRAP_HOUSEHOLD_NAME,
    householdSlug: environment.EMDO_BOOTSTRAP_HOUSEHOLD_SLUG,
    ownerEmail: environment.EMDO_BOOTSTRAP_OWNER_EMAIL,
    ownerName: environment.EMDO_BOOTSTRAP_OWNER_NAME,
    ownerPassword,
  });
};

const executeBootstrap = async (
  pool: BootstrapOwnerPool,
  input: {
    readonly email: string;
    readonly householdName: string;
    readonly householdSlug: string;
    readonly name: string;
    readonly passwordHash: string;
  },
) => {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    const roleResult = await client.query(`select
      role.rolsuper,
      role.rolbypassrls,
      pg_catalog.pg_has_role(
        session_user,
        'emdo_owner_bootstrap',
        'MEMBER'
      ) as is_member
    from pg_catalog.pg_roles as role
    where role.rolname = session_user`);
    const role = DatabaseRoleSchema.safeParse(roleResult.rows[0]);
    if (
      !role.success ||
      role.data.rolsuper ||
      role.data.rolbypassrls ||
      !role.data.is_member
    ) {
      throw new UnsafeBootstrapDatabaseRoleError();
    }

    await client.query('begin');
    transactionOpen = true;
    await client.query('set local role emdo_owner_bootstrap');
    const result = await client.query(
      `select user_id, household_id, membership_id, private_space_id,
              completed_at
         from emdo.bootstrap_initial_owner(
           $1::text, $2::text, $3::text, $4::text, $5::text
         )`,
      [
        input.email,
        input.name,
        input.passwordHash,
        input.householdName,
        input.householdSlug,
      ],
    );
    const bootstrap = BootstrapResultSchema.safeParse(result.rows[0]);
    if (!bootstrap.success || result.rows.length !== 1) {
      throw new Error('Owner bootstrap returned an invalid result');
    }
    await client.query('commit');
    transactionOpen = false;
    return Object.freeze(bootstrap.data);
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('rollback');
      } catch {
        // Preserve the original error and keep all output redacted.
      }
    }
    throw error;
  } finally {
    client.release();
  }
};

export const runOwnerBootstrapCommand = async (input: {
  readonly environment: BootstrapOwnerEnvironment;
  readonly dependencies?: BootstrapOwnerDependencies;
  readonly logger?: BootstrapOwnerLogger;
}): Promise<number> => {
  const dependencies = input.dependencies ?? defaultDependencies;
  const logger = input.logger ?? defaultLogger;

  let configuration: z.infer<typeof BootstrapEnvironmentSchema>;
  try {
    configuration = readEnvironment(input.environment);
  } catch {
    logger.error('Owner bootstrap configuration is invalid.');
    return 64;
  }

  let passwordHash: string;
  try {
    passwordHash = BetterAuthPasswordHashSchema.parse(
      await dependencies.hashPassword(configuration.ownerPassword),
    );
  } catch {
    logger.error('Owner bootstrap credential hashing failed.');
    return 1;
  }

  let pool: BootstrapOwnerPool;
  try {
    pool = dependencies.createPool({
      application_name: 'emdo-owner-bootstrap',
      connectionString: configuration.connectionString,
      connectionTimeoutMillis: 10_000,
      max: 1,
    });
  } catch {
    logger.error('EMDO initial owner bootstrap failed.');
    return 1;
  }
  try {
    await executeBootstrap(pool, {
      email: configuration.ownerEmail,
      householdName: configuration.householdName,
      householdSlug: configuration.householdSlug,
      name: configuration.ownerName,
      passwordHash,
    });
    logger.info('EMDO initial owner bootstrap completed.');
    return 0;
  } catch (error) {
    if (error instanceof UnsafeBootstrapDatabaseRoleError) {
      logger.error(
        'A dedicated owner-bootstrap database credential is required.',
      );
      return 64;
    }
    if (sqlState(error) === '55000') {
      logger.error('EMDO initial owner bootstrap is already complete.');
      return 2;
    }
    if (sqlState(error) === '23505') {
      logger.error(
        'EMDO initial owner bootstrap conflicts with an existing identity or household.',
      );
      return 3;
    }
    if (sqlState(error) === 'P0001') {
      logger.error(
        'EMDO initial owner bootstrap requires an empty identity database.',
      );
      return 4;
    }
    logger.error('EMDO initial owner bootstrap failed.');
    return 1;
  } finally {
    try {
      await pool.end();
    } catch {
      // Never replace the sanitized command result with a driver error.
    }
  }
};
