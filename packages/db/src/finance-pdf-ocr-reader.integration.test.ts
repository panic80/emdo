import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
describe.skipIf(!url)('saved PDF OCR reader authority', () => {
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());
  it('grants only the app role and enforces current book authority', async () => {
    const signature =
      'emdo.read_finance_pdf_ocr_extraction(uuid,uuid,uuid,uuid,integer)';
    const rows = (
      await pool.query(
        `select rolname, has_function_privilege(oid,$1,'EXECUTE') as allowed from pg_roles where rolname=any($2)`,
        [
          signature,
          [
            'emdo_app',
            'emdo_worker',
            'emdo_workflow',
            'emdo_worker_executor',
            'emdo_worker_dispatch_executor',
          ],
        ],
      )
    ).rows;
    expect(rows.find((row) => row.rolname === 'emdo_app')?.allowed).toBe(true);
    expect(
      rows
        .filter((row) => row.rolname !== 'emdo_app')
        .every((row) => row.allowed === false),
    ).toBe(true);
    const properties = (
      await pool.query(
        `select prosecdef, proconfig, exists(select from aclexplode(proacl) where grantee=0 and privilege_type='EXECUTE') as public_access from pg_proc where oid=$1::regprocedure`,
        [signature],
      )
    ).rows[0];
    expect(properties.prosecdef).toBe(true);
    expect(properties.proconfig).toContain('row_security=on');
    expect(properties.public_access).toBe(false);
    const client = await pool.connect();
    try {
      await client.query('set role emdo_app');
      await expect(
        client.query(
          'select emdo.read_finance_pdf_ocr_extraction($1,$2,$3,$4,1)',
          [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('reset role');
      client.release();
    }
  });
});
