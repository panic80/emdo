import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(!url)(
  'legacy migration PostgreSQL structural invariants',
  () => {
    const db = new pg.Client({ connectionString: url });
    const workspace = randomUUID(),
      book = randomUUID(),
      owner = randomUUID(),
      space = randomUUID();
    beforeAll(async () => {
      await db.connect();
      // Isolate CHECK semantics from unrelated FK fixtures. FK shapes are
      // inspected separately below; this is not row-policy acceptance.
      await db.query(
        'create temporary table legacy_runs_checks (like emdo.finance_legacy_migration_runs including defaults including constraints)',
      );
      await db.query(
        'create temporary table legacy_record_checks (like emdo.finance_legacy_migration_records including defaults including constraints)',
      );
    });
    afterAll(async () => {
      await db.end();
    });
    const insertRun = (mapping: unknown) =>
      db.query(
        `insert into legacy_runs_checks(id,workspace_id,book_id,source_household_id,source_space_id,source_owner_user_id,target_owner_user_id,mapping,source_snapshot_hash,mapping_hash,inspect_idempotency_key,created_by) values($1,$2,$3,$2,$4,$5,$5,$6::jsonb,$7,$7,$8,$5)`,
        [
          randomUUID(),
          workspace,
          book,
          space,
          owner,
          JSON.stringify(mapping),
          'a'.repeat(64),
          randomUUID(),
        ],
      );
    it('requires every explicit source and target mapping identity, including absent JSON keys', async () => {
      const mapping = {
        source: {
          householdId: workspace,
          privateSpaceId: space,
          originalOwnerUserId: owner,
        },
        target: { workspaceId: workspace, bookId: book, ownerUserId: owner },
      };
      await expect(insertRun(mapping)).resolves.toBeDefined();
      for (const invalid of [
        {},
        { ...mapping, target: {} },
        { ...mapping, source: { ...mapping.source, privateSpaceId: null } },
        { ...mapping, target: { ...mapping.target, bookId: randomUUID() } },
      ])
        await expect(insertRun(invalid)).rejects.toMatchObject({
          code: '23514',
          constraint: 'finance_legacy_migration_runs_mapping_scope',
        });
    });
    it('requires source hash and fingerprint together', async () => {
      const insert = (sourceHash: string | null, fingerprint: string | null) =>
        db.query(
          `insert into legacy_record_checks(id,workspace_id,book_id,migration_id,source_household_id,source_space_id,source_owner_user_id,legacy_row_id,entity_type,entity_id,source_revision,tombstoned,payload,payload_hash,candidate_status,disposition,normalized,classification,blockers,target_record_id,source_hash,fingerprint) values($1,$2,$3,$4,$2,$5,$6,$7,'finance.transaction','synthetic',1,false,'{}'::jsonb,$8,'blocked','unresolved','{}'::jsonb,'{}'::jsonb,'[]'::jsonb,$9,$10,$11)`,
          [
            randomUUID(),
            workspace,
            book,
            randomUUID(),
            space,
            owner,
            randomUUID(),
            'a'.repeat(64),
            randomUUID(),
            sourceHash,
            fingerprint,
          ],
        );
      await expect(insert(null, null)).resolves.toBeDefined();
      await expect(
        insert('a'.repeat(64), 'b'.repeat(64)),
      ).resolves.toBeDefined();
      for (const pair of [
        [null, 'b'.repeat(64)],
        ['a'.repeat(64), null],
      ])
        await expect(insert(pair[0]!, pair[1]!)).rejects.toMatchObject({
          code: '23514',
          constraint: 'finance_legacy_migration_records_source_hashes',
        });
    });
    it('binds child run, record and comparison foreign keys to the same book', async () => {
      const result = await db.query(
        "select conname,pg_get_constraintdef(oid) as definition from pg_constraint where connamespace='emdo'::regnamespace and contype='f' and conname = any($1::text[])",
        [
          [
            'finance_legacy_migration_records_run',
            'finance_legacy_migration_reviews_run',
            'finance_legacy_migration_reviews_record',
            'finance_legacy_migration_comparisons_run',
            'finance_legacy_migration_cutovers_run',
            'finance_legacy_migration_cutovers_comparison',
          ],
        ],
      );
      expect(result.rows).toHaveLength(6);
      for (const row of result.rows)
        expect(row.definition).toMatch(
          /FOREIGN KEY \(workspace_id, book_id, migration_id(?:, (?:record_id|comparison_id))?\) REFERENCES/,
        );
    });
  },
);
