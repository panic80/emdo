import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../drizzle/0003_durable_runtime_repositories.sql',
  import.meta.url,
);

describe('proposal PostgreSQL portability regressions', () => {
  it('uses PostgreSQL grammar and typed composite locks accepted by PostgreSQL 17', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).not.toMatch(/pg_catalog\.extract\s*\(/iu);
    expect(sql).not.toMatch(/SELECT\s+proposal\s+AS\s+proposal_row/iu);
    expect(sql).not.toMatch(/,\s*state\s+AS\s+state_row/iu);
    expect(sql).toMatch(
      /INSERT INTO emdo\.provider_attempts\([\s\S]+?"authorization"/u,
    );
    expect(sql).toContain('ROW(state.*)::emdo.proposal_states AS state_row');
  });
});
