import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

export const migrationsDirectoryUrl = new URL('../drizzle/', import.meta.url);
export const migrationsDirectoryPath = fileURLToPath(migrationsDirectoryUrl);
export interface DatabaseMigrationOptions {
  /** Absolute directory copied beside the deployed API bundle. */
  readonly migrationsFolder?: string;
}

const resolveMigrationsFolder = (
  options: DatabaseMigrationOptions = {},
): string => {
  const migrationsFolder = options.migrationsFolder ?? migrationsDirectoryPath;
  if (
    migrationsFolder.length === 0 ||
    migrationsFolder.length > 4_096 ||
    migrationsFolder.includes('\0') ||
    !isAbsolute(migrationsFolder)
  ) {
    throw new Error('Database migrations folder must be an absolute path');
  }
  return normalize(migrationsFolder);
};

interface MigrationJournalEntry {
  readonly idx: number;
  readonly tag: string;
}

const readJournalEntries = async (
  migrationsFolder: string,
): Promise<readonly MigrationJournalEntry[]> => {
  const journalUrl = pathToFileURL(
    join(migrationsFolder, 'meta/_journal.json'),
  );
  const raw: unknown = JSON.parse(await readFile(journalUrl, 'utf8'));
  if (typeof raw !== 'object' || raw === null || !('entries' in raw)) {
    throw new Error('Drizzle migration journal is malformed');
  }
  const entries = raw.entries;
  if (!Array.isArray(entries)) {
    throw new Error('Drizzle migration journal entries are malformed');
  }

  return entries.map((entry, index) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('idx' in entry) ||
      entry.idx !== index ||
      !('tag' in entry) ||
      typeof entry.tag !== 'string' ||
      !/^\d{4}_[a-z0-9_]+$/.test(entry.tag) ||
      !entry.tag.startsWith(index.toString().padStart(4, '0'))
    ) {
      throw new Error(`Drizzle migration journal entry ${index} is invalid`);
    }
    return Object.freeze({ idx: index, tag: entry.tag });
  });
};

export interface OrderedMigration {
  readonly id: string;
  readonly index: number;
  readonly sql: string;
}

/**
 * Loads exactly the SQL files named by Drizzle's journal. This is useful for
 * live integration tests and makes missing/reordered deployment artifacts fail
 * before any statement is applied.
 */
export const loadOrderedMigrations = async (): Promise<
  readonly OrderedMigration[]
> => {
  const migrationsFolder = resolveMigrationsFolder();
  const entries = await readJournalEntries(migrationsFolder);
  return Promise.all(
    entries.map(async ({ idx, tag }) =>
      Object.freeze({
        id: tag,
        index: idx,
        sql: await readFile(
          pathToFileURL(join(migrationsFolder, `${tag}.sql`)),
          'utf8',
        ),
      }),
    ),
  );
};

/** Applies every unapplied journal entry through Drizzle's tracked migrator. */
export const applyDatabaseMigrations = async (
  database: Parameters<typeof migrate>[0],
  options: DatabaseMigrationOptions = {},
): Promise<void> => {
  await migrate(database, {
    migrationsFolder: resolveMigrationsFolder(options),
  });
};

export interface MigrationLockClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{
    readonly rowCount: number | null;
    readonly rows: readonly unknown[];
  }>;
  release(destroy?: boolean): void;
}

export interface MigrationLockPool {
  connect(): Promise<MigrationLockClient>;
}

const migrationLockName = 'emdo.database.migrations.v1';

/**
 * Runs Drizzle's journal-aware migrator on the same dedicated PostgreSQL
 * session that owns the advisory lock. Concurrent deployment containers are
 * serialized, while Drizzle's migration journal keeps successful replays
 * idempotent.
 */
export const applyLockedDatabaseMigrations = async (
  pool: MigrationLockPool,
  options: DatabaseMigrationOptions = {},
): Promise<void> => {
  const client = await pool.connect();
  let locked = false;
  let failed = false;
  let destroyClient = false;
  try {
    await client.query('begin');
    await client.query(`set local statement_timeout = '30s'`);
    await client.query(
      `select pg_catalog.pg_advisory_lock(
         pg_catalog.hashtextextended($1, 0)
       )`,
      [migrationLockName],
    );
    locked = true;
    await client.query('commit');
    await applyDatabaseMigrations(drizzle(client as never), options);
  } catch {
    failed = true;
    if (!locked) {
      try {
        await client.query('rollback');
      } catch {
        destroyClient = true;
      }
    }
  } finally {
    if (locked) {
      try {
        await client.query(
          `select pg_catalog.pg_advisory_unlock(
             pg_catalog.hashtextextended($1, 0)
           )`,
          [migrationLockName],
        );
      } catch {
        failed = true;
        destroyClient = true;
      }
    }
    client.release(destroyClient);
  }
  if (failed) throw new Error('Database migration failed');
};
