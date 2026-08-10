import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

export const migrationsDirectoryUrl = new URL('../drizzle/', import.meta.url);
export const migrationsDirectoryPath = fileURLToPath(migrationsDirectoryUrl);
const migrationJournalUrl = new URL(
  'meta/_journal.json',
  migrationsDirectoryUrl,
);

interface MigrationJournalEntry {
  readonly idx: number;
  readonly tag: string;
}

const readJournalEntries = async (): Promise<
  readonly MigrationJournalEntry[]
> => {
  const raw: unknown = JSON.parse(await readFile(migrationJournalUrl, 'utf8'));
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
  const entries = await readJournalEntries();
  return Promise.all(
    entries.map(async ({ idx, tag }) =>
      Object.freeze({
        id: tag,
        index: idx,
        sql: await readFile(
          new URL(`${tag}.sql`, migrationsDirectoryUrl),
          'utf8',
        ),
      }),
    ),
  );
};

/** Applies every unapplied journal entry through Drizzle's tracked migrator. */
export const applyDatabaseMigrations = async (
  database: Parameters<typeof migrate>[0],
): Promise<void> => {
  await migrate(database, { migrationsFolder: migrationsDirectoryPath });
};
