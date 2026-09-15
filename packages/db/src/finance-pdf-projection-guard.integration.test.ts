import pg from 'pg';
import { describe, expect, it } from 'vitest';

const url = process.env.FINANCE_AUTOMATION_TEST_DATABASE_URL;
describe.skipIf(!url)('migrated PDF spend projection guard', () => {
  it('validates complete facts, UTF-16 counts, receipt and bounded ceilings using the deployed guard body', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('begin');
      const definition = (
        await client.query(
          `select pg_get_functiondef('emdo.reserve_standardization_spend(uuid,integer,uuid,text,integer,integer,integer,text,jsonb,jsonb)'::regprocedure) as body`,
        )
      ).rows[0].body as string;
      const marker =
        "ELSIF ex.envelope->>'kind'='pdf-layout' AND lineage->>'promptVersion'='finance-standardization-proposal.v5' THEN";
      const start = definition.indexOf(marker);
      expect(start).toBeGreaterThan(0);
      const end = definition.indexOf(' ELSIF projection IS NOT NULL', start);
      expect(end).toBeGreaterThan(start);
      // Exercise the exact migrated guard. Authority/lease/budget gates remain covered by their own suites.
      const guard = definition.slice(start + marker.length, end);
      await client.query(`create function pg_temp.check_pdf_projection(facts jsonb, projection jsonb, input_ceiling integer, output_ceiling integer) returns boolean language plpgsql as $test$
        declare ex emdo.finance_standardization_extractions;
        begin
          ex.envelope := jsonb_build_object('kind','pdf-layout','factsJson',facts::text);
          ex.extraction_digest := repeat('a',64);
          ${guard}
          return true;
        end $test$`);
      const facts = {
        totalPages: 2,
        pages: [
          { text: 'A😀', spans: [{ text: 'A😀' }] },
          { text: 'é\nZ', spans: [{ text: 'é' }, { text: 'Z' }] },
        ],
      };
      const receipt = {
        kind: 'pdf-text.v1',
        extractionDigest: 'a'.repeat(64),
        projectionDigest: 'b'.repeat(64),
        pageCount: 2,
        spanCount: 3,
        textCharacters: 6,
        omittedPages: 0,
      };
      const check = async (
        projection: unknown,
        input = 64000,
        output = 4000,
      ) => {
        await client.query('savepoint guard');
        try {
          await client.query(
            'select pg_temp.check_pdf_projection($1::jsonb,$2::jsonb,$3,$4)',
            [JSON.stringify(facts), JSON.stringify(projection), input, output],
          );
          return true;
        } catch (error) {
          expect((error as { code: string }).code).toBe('23514');
          expect((error as Error).message).toBe(
            'standardization-pdf-projection-conflict',
          );
          return false;
        } finally {
          await client.query('rollback to savepoint guard');
        }
      };
      expect(await check(receipt)).toBe(true);
      expect(await check(null)).toBe(false);
      for (const patch of [
        { pageCount: 1 },
        { spanCount: 2 },
        { textCharacters: 5 },
        { omittedPages: 1 },
        { extractionDigest: 'c'.repeat(64) },
      ]) {
        expect(await check({ ...receipt, ...patch })).toBe(false);
      }
      expect(await check(receipt, 32000)).toBe(true);
      expect(await check(receipt, 0)).toBe(false);
      expect(await check(receipt, 64001)).toBe(false);
      expect(await check(receipt, 64000, 3999)).toBe(false);
      const missingField: Partial<typeof receipt> = { ...receipt };
      delete missingField.spanCount;
      expect(await check(missingField)).toBe(false);
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });
});
