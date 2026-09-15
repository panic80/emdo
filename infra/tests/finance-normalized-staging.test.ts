import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
describe('normalized synthetic staging isolation', () => {
  it('requires an explicit separate overlay and isolated credential files', () => {
    const overlay = read('compose/compose.finance-normalized-staging.yml');
    expect(overlay).toContain('EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING:?');
    expect(overlay).toContain('FINANCE_NORMALIZED_STAGING_WORKER_ENV_FILE:?');
    expect(overlay).toContain('networks: !override');
    expect(overlay).toContain('finance-normalized-egress');
    expect(overlay).toContain("EMDO_FINANCE_SCHEDULES_ENABLED: 'false'");
    expect(read('compose/compose.staging.yml')).not.toContain(
      'EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING',
    );
    expect(read('compose/compose.finance-staging.yml')).not.toContain(
      'EMDO_FINANCE_STANDARDIZATION_ENABLED',
    );
  });
  it('bounds deployment-owned readiness to an explicitly matched empty synthetic workspace', () => {
    const sql = read('scripts/finance-normalized-staging-provision.sql');
    for (const boundary of [
      'normalized-synthetic-staging-only',
      'b.workspace_id <>',
      "m.role='owner'",
      'u.email=current_setting',
      'count(*) FROM emdo.workspaces',
      'finance_journals',
      'r > 100',
      'd > 500',
    ])
      expect(sql).toContain(boundary);
    expect(sql).toContain("'finance.standardizations.run'");
  });
});
