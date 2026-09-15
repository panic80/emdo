import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const workflowPath = new URL(
  '../../.github/workflows/staging.yml',
  import.meta.url,
);

const step = (source: string, name: string): string => {
  const start = source.indexOf(`      - name: ${name}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n      - ', start + 1);
  return source.slice(start, end === -1 ? undefined : end);
};

describe('normalized private staging workflow', () => {
  it('rejects capability mismatches and missing or unsafe budgets before remote actions', async () => {
    const source = await readFile(workflowPath, 'utf8');
    const validation = step(
      source,
      'Validate Finance capability and budget inputs',
    )
      .split('        run: |\n')[1]!
      .replace(/^ {10}/gm, '');
    const run = (
      finance: string,
      live: string,
      normalized: string,
      runBudget = '',
      dayBudget = '',
    ) =>
      spawnSync('bash', ['-e', '-c', validation], {
        encoding: 'utf8',
        env: {
          ...process.env,
          FINANCE_SYNTHETIC_STAGING: finance,
          FINANCE_LIVE_CHAT: live,
          FINANCE_NORMALIZED_STAGING: normalized,
          NORMALIZED_RUN_BUDGET: runBudget,
          NORMALIZED_DAY_BUDGET: dayBudget,
        },
      });
    for (const flags of [
      ['false', 'false', 'false'],
      ['true', 'false', 'false'],
      ['true', 'true', 'false'],
      ['true', 'false', 'true', '25', '100'],
      ['true', 'true', 'true', '100', '500'],
    ])
      expect(
        run(flags[0]!, flags[1]!, flags[2]!, flags[3], flags[4]).status,
      ).toBe(0);
    for (const flags of [
      ['false', 'false', 'true', '25', '100'],
      ['false', 'true', 'false'],
      ['true', 'false', 'true'],
      ['true', 'false', 'true', '101', '500'],
      ['true', 'false', 'true', '25', '24'],
      ['true', 'false', 'true', '25', '501'],
      ['true', 'false', 'true', '01', '100'],
      ['true', 'false', 'false', '1', '1'],
      ['true', 'false', 'true', "1'", '100'],
    ])
      expect(
        run(flags[0]!, flags[1]!, flags[2]!, flags[3], flags[4]).status,
        flags.join(','),
      ).not.toBe(0);
  });

  it('routes normalized proof separately while preserving the signed same-SHA release boundary', async () => {
    const source = await readFile(workflowPath, 'utf8');
    expect(source).toMatch(
      /finance_normalized_staging:\n[\s\S]*?default: false/,
    );
    const deployment = step(
      source,
      'Deploy isolated Finance synthetic staging',
    );
    expect(deployment).toContain(
      '"$FINANCE_LIVE_CHAT" == true || "$FINANCE_NORMALIZED_STAGING" == true',
    );
    expect(deployment).toContain(
      "true '$FINANCE_LIVE_CHAT' '$FINANCE_NORMALIZED_STAGING' '$NORMALIZED_RUN_BUDGET' '$NORMALIZED_DAY_BUDGET'",
    );
    const acceptance = step(source, 'Run staging health acceptance');
    expect(acceptance).toContain(
      'value.workflowRunId !== process.env.STAGING_RUN_ID',
    );
    expect(acceptance).toContain('value.releaseEligible !== false');
    expect(acceptance).toContain(
      'finance-normalized-synthetic-staging-probe.json',
    );
    for (const name of [
      'Fetch Finance backup/restore receipt',
      'Require complete Finance synthetic staging proof',
    ]) {
      expect(step(source, name)).toContain(
        'inputs.finance_synthetic_staging && !inputs.finance_normalized_staging',
      );
    }
    for (const name of [
      'Assemble, sign, and verify the complete release evidence',
      'Record tested digests',
    ]) {
      expect(step(source, name)).toContain('!inputs.finance_synthetic_staging');
    }
    expect(step(source, 'Verify the source publish run')).toContain(
      'run.head_sha !== context.sha',
    );
    expect(step(source, 'Verify the successful same-SHA CI run')).toContain(
      'run.head_sha !== process.env.SOURCE_SHA',
    );
    expect(step(source, 'Upload deployment assets')).toContain(
      'openssl pkeyutl -sign',
    );
  });
});
