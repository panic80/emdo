import pg from 'pg';
import { describe, expect, it } from 'vitest';

const url = process.env.FINANCE_AUTOMATION_TEST_DATABASE_URL;
describe.skipIf(!url)('PDF extraction storage capacity', () => {
  it('stores escaped full facts at the boundary and rejects oversized PDF and non-PDF facts', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('begin');
      // Clone the actual migrated check without requiring or modifying customer rows.
      await client.query(
        'create temp table extraction_capacity (like emdo.finance_standardization_extractions including constraints including defaults)',
      );
      const insert = async (kind: string, factsJson: string) => {
        await client.query('savepoint capacity');
        try {
          await client.query(
            `insert into extraction_capacity(id,run_id,revision,source_digest,extraction_digest,envelope)
            values(gen_random_uuid(),gen_random_uuid(),1,repeat('a',64),repeat('b',64),$1::jsonb)`,
            [JSON.stringify({ kind, factsJson })],
          );
          return true;
        } catch (error) {
          if ((error as { code?: string }).code !== '23514') throw error;
          return false;
        } finally {
          await client.query('rollback to savepoint capacity');
        }
      };
      // Valid JSON full of backslash escapes nearly doubles when embedded in JSONB.
      const facts = '"' + '\\\\'.repeat((2097152 - 2) / 2) + '"';
      expect(Buffer.byteLength(facts)).toBe(2097152);
      expect(await insert('pdf-layout', facts)).toBe(true);
      expect(await insert('pdf-layout', facts + ' ')).toBe(false);
      for (const kind of [
        'csv-table',
        'xlsx-regions',
        'image-ocr',
        'pdf-ocr',
      ]) {
        expect(await insert(kind, '"' + 'x'.repeat(262142) + '"')).toBe(true);
        expect(await insert(kind, '"' + 'x'.repeat(262143) + '"')).toBe(false);
      }
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });
});
