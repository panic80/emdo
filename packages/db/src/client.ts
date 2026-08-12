import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import { z } from 'zod';

import { foundationTables } from './schema.js';
import type { DatabasePool } from './scoped-repository.js';

const DatabaseClientConfigSchema = z.strictObject({
  connectionString: z
    .string()
    .url()
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === 'postgres:' || protocol === 'postgresql:';
    }),
  max: z.number().int().positive().max(50).default(10),
  idleTimeoutMillis: z.number().int().positive().max(300_000).default(30_000),
  connectionTimeoutMillis: z
    .number()
    .int()
    .positive()
    .max(60_000)
    .default(10_000),
  applicationName: z.string().trim().min(1).max(63).default('emdo-api'),
});

export interface EmdoDatabaseClient {
  readonly pool: Pool;
  readonly database: NodePgDatabase<typeof foundationTables>;
  readonly scopedPool: DatabasePool;
  close(): Promise<void>;
}

const asScopedPool = (pool: Pool): DatabasePool => ({
  async connect() {
    const client = await pool.connect();
    return {
      async query(text, values) {
        const result = await client.query(
          text,
          values === undefined ? [] : [...values],
        );
        return {
          rowCount: result.rowCount,
          rows: result.rows as readonly Record<string, unknown>[],
        };
      },
      release: (destroy = false) => client.release(destroy),
    };
  },
});

export const createDatabaseClient = (input: {
  readonly connectionString: string;
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
  readonly applicationName?: string;
}): EmdoDatabaseClient => {
  const config = DatabaseClientConfigSchema.parse(input);
  const poolConfig: PoolConfig = {
    connectionString: config.connectionString,
    max: config.max,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    application_name: config.applicationName,
    allowExitOnIdle: true,
  };
  const pool = new Pool(poolConfig);

  return Object.freeze({
    pool,
    database: drizzle(pool, { schema: foundationTables }),
    scopedPool: asScopedPool(pool),
    close: () => pool.end(),
  });
};
