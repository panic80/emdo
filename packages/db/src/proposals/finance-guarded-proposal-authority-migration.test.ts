import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../drizzle/0018_finance_guarded_proposal_authority.sql',
  import.meta.url,
);

const readMigration = async (): Promise<string> =>
  (await readFile(migrationUrl, 'utf8'))
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .toLowerCase()
    .replaceAll('"', '');

const extractFunction = (sql: string, name: string): string => {
  const match = sql.match(
    new RegExp(
      `create or replace function emdo\\.${name}\\s*\\([\\s\\S]+?\\$function\\$;`,
    ),
  );
  expect(match, `${name} must be present`).not.toBeNull();
  return match?.[0] ?? '';
};

describe('Finance guarded proposal authority migration', () => {
  it('stores only exact v1 Finance guard material and pairs operations to capabilities', async () => {
    const sql = await readMigration();
    const guardedActionCheck = sql.match(
      /action_proposals_guarded_action_check[\s\S]+?\n\);/u,
    )?.[0];

    expect(guardedActionCheck).toBeDefined();
    expect(guardedActionCheck).toContain("capabilityversion' = '1.0.0'");
    expect(guardedActionCheck).toContain("'finance.records.write'");
    expect(guardedActionCheck).toContain("'finance.statement.import'");
    expect(guardedActionCheck).toContain("'finance-adjustment'");
    expect(guardedActionCheck).toContain("'finance-reversal'");
    expect(guardedActionCheck).toContain("'finance-statement-import-commit'");
    for (const operation of [
      'finance-document-review-commit',
      'finance-document-match-accept',
      'finance-document-delete',
    ]) {
      expect(guardedActionCheck).toContain(`'${operation}'`);
    }
    for (const digest of [
      'actionhash',
      'executionbindinghash',
      'targetbindinghash',
    ]) {
      expect(guardedActionCheck).toContain(`guarded_action -> '${digest}'`);
      expect(guardedActionCheck).toContain("= 'string'");
      expect(guardedActionCheck).toContain("~\n\t\t\t\t\t'^[a-f0-9]{64}$'");
    }
    expect(guardedActionCheck).toContain("? 'targetbindinghash'");
    expect(guardedActionCheck).toContain(
      "and not (emdo.action_proposals.guarded_action ? 'targetbindinghash')",
    );
    expect(guardedActionCheck).toMatch(
      /payload_hash\s*=\s*emdo\.canonical_json_hash\(\s*emdo\.action_proposals\.canonical_arguments\s*\)/u,
    );
  });

  it('keeps Calendar proposal shapes legacy while matching guarded Finance shapes exactly', async () => {
    const sql = await readMigration();
    const matcher = extractFunction(sql, 'proposal_row_matches_input');
    const create = extractFunction(sql, 'commit_provider_proposal_create');

    for (const body of [matcher, create]) {
      expect(body).toContain("'guardedaction'");
      expect(body).toContain("'payloadhash'");
      expect(body).toContain("'state'");
    }
    expect(matcher).toContain("case when p_input ? 'guardedaction'");
    expect(create).toContain(
      "case when (p_input -> 'proposal') ? 'guardedaction'",
    );
    expect(matcher).toContain('p_proposal.guarded_action is not null');
    expect(matcher).toContain('p_proposal.guarded_action is null');
    expect(create).toContain('finance_guarded_action_proposal_is_valid');
    expect(create).toContain(
      "'finance.records.write', 'finance.statement.import'",
    );
    expect(create).toContain("not ((p_input -> 'proposal') ? 'guardedaction')");
  });

  it('persists immutable bounded Finance authority only for the two non-provider phases', async () => {
    const sql = await readMigration();
    const transition = extractFunction(
      sql,
      'enforce_workflow_operation_claim_transition',
    );

    expect(sql).toContain('add column finance_guarded_authority jsonb');
    expect(sql).toContain(
      'workflow_operation_claims_finance_guarded_authority_check',
    );
    expect(sql).toContain("phase in ('proposal-create', 'visual-decision')");
    expect(sql).toContain('finance_guarded_authority_material_is_valid');
    expect(sql).toContain(
      "'schemaversion', 'capabilityid', 'capabilityfingerprint',",
    );
    expect(sql).toContain("'guardedaction'");
    expect(transition).toContain('old.finance_guarded_authority is null');
    expect(transition).toContain('new.finance_guarded_authority is not null');
    expect(transition).toContain(
      'finance guarded authority is immutable once set',
    );
    expect(sql).toContain('grant update (finance_guarded_authority)');
  });

  it('recomputes Finance v2 authority from fresh collection scope only within bounded issue and claim wrappers', async () => {
    const sql = await readMigration();
    const issuer = extractFunction(sql, 'issue_workflow_operation_claim');
    const claimant = extractFunction(sql, 'claim_workflow_operation_scope');
    const financeIssue = extractFunction(
      sql,
      'lock_current_finance_guarded_action_authority',
    );
    const financeClaim = extractFunction(
      sql,
      'lock_current_finance_guarded_claim_authority',
    );
    const googleWrapper = extractFunction(
      sql,
      'lock_current_google_calendar_authority',
    );

    for (const body of [financeIssue, financeClaim]) {
      expect(body).toContain('lock_current_authorization_scope');
      expect(body).toMatch(
        /lock_current_authorization_scope\(\s*[^,]+, null, null\s*\)/u,
      );
      expect(body).toContain(
        'emdo.finance-guarded-action-execution-binding.v2',
      );
      expect(body).toContain('canonical_json_hash');
      expect(body).toContain('targetbindinghash');
    }
    expect(issuer).toContain(
      "'finance.records.write', 'finance.statement.import'",
    );
    expect(issuer).toContain(
      "v_phase not in ('proposal-create', 'visual-decision')",
    );
    expect(issuer).toContain(
      'finance_guarded_authority = v_finance_guarded_authority',
    );
    expect(issuer).toContain(
      "set_config(\n\t\t'emdo.finance_guarded_action_authority', '', true",
    );
    expect(claimant).toContain(
      "set_config(\n\t\t'emdo.finance_guarded_claim_verification', '', true",
    );
    expect(claimant).toContain(
      "'emdo.finance_guarded_claim_verification', '1', true",
    );
    expect(googleWrapper).toContain(
      'lock_current_google_calendar_authority_calendar',
    );
    expect(googleWrapper).toContain(
      'lock_current_finance_guarded_claim_authority',
    );
  });
});
