import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const durableMigrationUrl = new URL(
  '../../drizzle/0003_durable_runtime_repositories.sql',
  import.meta.url,
);
const compatibilityMigrationUrl = new URL(
  '../../drizzle/0019_manager_turn_spend_warning.sql',
  import.meta.url,
);

const completeManagerTurn = (sql: string) => {
  const complete = sql.match(
    /CREATE OR REPLACE FUNCTION "emdo"\."complete_manager_turn"\([\s\S]+?\n\$function\$;/u,
  )?.[0];
  if (complete === undefined) {
    throw new Error('Expected complete_manager_turn migration function.');
  }
  return complete;
};

const legacyUsageValidation = `\t\tOR NOT emdo.jsonb_object_has_exact_keys(
\t\t\tp_result -> 'usage',
\t\t\tARRAY['inputTokens', 'outputTokens', 'modelCostCadMinor']::text[]
\t\t)
\t\tOR pg_catalog.jsonb_typeof(p_result #> '{usage,inputTokens}')
\t\t\tIS DISTINCT FROM 'number'
\t\tOR pg_catalog.jsonb_typeof(p_result #> '{usage,outputTokens}')
\t\t\tIS DISTINCT FROM 'number'
\t\tOR pg_catalog.jsonb_typeof(p_result #> '{usage,modelCostCadMinor}')
\t\t\tIS DISTINCT FROM 'number'`;

const spendWarningUsageValidation = `\t\tOR emdo.jsonb_object_has_exact_keys(
\t\t\tp_result -> 'usage',
\t\t\tCASE WHEN p_result -> 'usage' ? 'spendWarning' THEN ARRAY[
\t\t\t\t'inputTokens', 'outputTokens', 'modelCostCadMinor', 'spendWarning'
\t\t\t]::text[] ELSE ARRAY[
\t\t\t\t'inputTokens', 'outputTokens', 'modelCostCadMinor'
\t\t\t]::text[] END
\t\t) IS DISTINCT FROM true
\t\tOR pg_catalog.jsonb_typeof(p_result #> '{usage,inputTokens}')
\t\t\tIS DISTINCT FROM 'number'
\t\tOR pg_catalog.jsonb_typeof(p_result #> '{usage,outputTokens}')
\t\t\tIS DISTINCT FROM 'number'
\t\tOR pg_catalog.jsonb_typeof(p_result #> '{usage,modelCostCadMinor}')
\t\t\tIS DISTINCT FROM 'number'
\t\tOR (
\t\t\tp_result -> 'usage' ? 'spendWarning'
\t\t\tAND p_result -> 'usage' -> 'spendWarning'
\t\t\t\tIS DISTINCT FROM 'true'::jsonb
\t\t)`;

const executorColumnGrants = [
  'GRANT UPDATE (checkpoint_id) ON emdo.approval_checkpoints TO emdo_manager_turn_executor;',
  'GRANT UPDATE (id) ON emdo.action_proposals TO emdo_manager_turn_executor;',
  'GRANT UPDATE (proposal_id) ON emdo.proposal_states TO emdo_manager_turn_executor;',
  'GRANT UPDATE (proposal_id) ON emdo.proposal_preparations TO emdo_manager_turn_executor;',
  'GRANT UPDATE (id) ON emdo.disclosure_grants TO emdo_manager_turn_executor;',
] as const;

const executorUpdatePolicies = [
  `CREATE POLICY manager_turn_checkpoints_update
ON emdo.approval_checkpoints
FOR UPDATE TO emdo_manager_turn_executor
USING (true) WITH CHECK (true);`,
  `CREATE POLICY manager_turn_proposals_update
ON emdo.action_proposals
FOR UPDATE TO emdo_manager_turn_executor
USING (true) WITH CHECK (true);`,
  `CREATE POLICY manager_turn_proposal_states_update
ON emdo.proposal_states
FOR UPDATE TO emdo_manager_turn_executor
USING (true) WITH CHECK (true);`,
  `CREATE POLICY manager_turn_preparations_update
ON emdo.proposal_preparations
FOR UPDATE TO emdo_manager_turn_executor
USING (true) WITH CHECK (true);`,
  `CREATE POLICY manager_turn_disclosures_update
ON emdo.disclosure_grants
FOR UPDATE TO emdo_manager_turn_executor
USING (true) WITH CHECK (true);`,
] as const;

const compatibilityDdl = [
  ...executorColumnGrants,
  ...executorUpdatePolicies,
].join('\n--> statement-breakpoint\n');

describe('manager turn spend-warning compatibility migration', () => {
  it('adds only the audited executor UPDATE grants and RLS policies after the two function fixes', async () => {
    const [durableSql, compatibilitySql] = await Promise.all([
      readFile(durableMigrationUrl, 'utf8'),
      readFile(compatibilityMigrationUrl, 'utf8'),
    ]);
    const durableComplete = completeManagerTurn(durableSql);
    const compatibilityComplete = completeManagerTurn(compatibilitySql);

    expect(durableComplete).toContain(legacyUsageValidation);
    expect(durableComplete.match(/pg_catalog\.least\(/gu)).toHaveLength(1);

    const expectedCompatibilityComplete = durableComplete
      .replace(legacyUsageValidation, spendWarningUsageValidation)
      .replace('pg_catalog.least(', 'least(');

    expect(compatibilitySql.trim()).toBe(
      `${expectedCompatibilityComplete}\n--> statement-breakpoint\n${compatibilityDdl}`,
    );
    expect(compatibilityComplete).toBe(expectedCompatibilityComplete);
    expect(compatibilityComplete).toContain('VOLATILE');
    expect(compatibilityComplete).toContain('SECURITY DEFINER');
    expect(compatibilityComplete).toContain(
      'SET search_path = pg_catalog, emdo',
    );
    expect(compatibilityComplete).toContain('SET row_security = on');
    expect(compatibilityComplete).toContain(spendWarningUsageValidation);
    expect(compatibilityComplete).toContain("IS DISTINCT FROM 'true'::jsonb");
    expect(compatibilityComplete).not.toContain('pg_catalog.least(');
    expect(executorColumnGrants).toHaveLength(5);
    expect(executorUpdatePolicies).toHaveLength(5);
    for (const grant of executorColumnGrants) {
      expect(compatibilitySql).toContain(grant);
    }
    for (const policy of executorUpdatePolicies) {
      expect(compatibilitySql).toContain(policy);
    }
    expect(
      compatibilitySql.match(
        /^GRANT UPDATE \([a-z_]+\) ON emdo\.[a-z_]+ TO emdo_manager_turn_executor;$/gmu,
      ) ?? [],
    ).toHaveLength(5);
    expect(
      compatibilitySql.match(
        /^CREATE POLICY manager_turn_[a-z_]+_update\nON emdo\.[a-z_]+\nFOR UPDATE TO emdo_manager_turn_executor\nUSING \(true\) WITH CHECK \(true\);$/gmu,
      ) ?? [],
    ).toHaveLength(5);
    expect(compatibilitySql).not.toMatch(/\bGRANT\s+UPDATE\s+ON\s+emdo\./u);
    expect(compatibilitySql).not.toMatch(
      /\bGRANT\s+(?:SELECT|INSERT|DELETE|REFERENCES|TRIGGER|EXECUTE|USAGE|ALL)\b/u,
    );
    expect(compatibilitySql).not.toMatch(
      /\b(?:ALTER\s+(?:ROLE|TABLE|FUNCTION)|CREATE\s+ROLE|REVOKE)\b/u,
    );
    expect(compatibilitySql).not.toMatch(/\bTO\s+(?:PUBLIC|emdo_app)\b/u);
  });
});
