import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../drizzle/0003_durable_runtime_repositories.sql',
  import.meta.url,
);

const readMigration = async () =>
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

describe('durable proposal persistence migration', () => {
  it('persists immutable provider authority, SDK call, preparation, and full approval binding material', async () => {
    const sql = await readMigration();

    expect(sql).toMatch(
      /alter table emdo\.household_memberships[\s\S]+add column if not exists administration_version[\s\S]+integer default 1 not null[\s\S]+household_memberships_administration_version_positive/,
    );
    expect(
      sql.indexOf('add column if not exists administration_version'),
    ).toBeLessThan(sql.indexOf('create table emdo.workflow_operation_claims'));
    expect(sql).toMatch(
      /alter table emdo\.action_proposals[\s\S]+provider_authority_binding_hash[\s\S]+provider_sdk_call_id[\s\S]+disclosure_grant/,
    );
    expect(sql).toContain('create table emdo.proposal_preparations');
    expect(sql).toContain('preparation_binding');
    expect(sql).toContain('preparation_binding_hash');
    expect(sql).toMatch(
      /alter table emdo\.provider_attempts[\s\S]+authorization[\s\S]+approval_binding[\s\S]+provider_authority_binding_hash[\s\S]+provider_sdk_call_id/,
    );
    expect(sql).toMatch(
      /alter table emdo\.provider_outcomes[\s\S]+completion jsonb/,
    );
    expect(sql).toMatch(
      /alter table emdo\.proposal_reconciliations[\s\S]+completion jsonb/,
    );
  });

  it('persists and matches the operation authorization fingerprint as approval-hash input', async () => {
    const sql = await readMigration();
    const matcher = extractFunction(sql, 'proposal_row_matches_input');
    const create = extractFunction(sql, 'commit_provider_proposal_create');

    expect(matcher).toContain(') = 22');
    expect(matcher).toContain("p_input ->> 'authorizationscopefingerprint'");
    expect(matcher).toContain('p_proposal.authorization_scope_fingerprint');
    expect(create).toContain("'authorizationscopefingerprint'");
    expect(create).toContain(
      "p_input #>> '{proposal,authorizationscopefingerprint}'",
    );
  });

  it('validates the exact Google authority v2 binding against the trusted proposal fingerprint', async () => {
    const sql = await readMigration();
    const prepare = extractFunction(sql, 'commit_provider_proposal_prepare');

    expect(prepare).toContain("'google-calendar-grant-v2'");
    for (const key of [
      'kind',
      'householdid',
      'privatespaceid',
      'authorizationscopefingerprint',
      'providergrantreference',
      'authorizationepoch',
    ]) {
      expect(prepare).toContain(key);
    }
    expect(prepare).not.toContain("'spaceaccessgrantid'");
    expect(prepare).toMatch(
      /authoritybinding,authorizationscopefingerprint[\s\S]+v_proposal\.authorization_scope_fingerprint/,
    );
    expect(prepare).toMatch(
      /authoritybinding,authorizationscopefingerprint[\s\S]+v_claim\.authorization_scope_fingerprint/,
    );
  });

  it('revalidates the exact workflow, session, space grant, and disclosure grant under transaction locks', async () => {
    const sql = await readMigration();
    const issuer = extractFunction(sql, 'issue_workflow_operation_claim');
    const lock = extractFunction(sql, 'claim_workflow_operation_scope');

    expect(sql).toContain('workflow_operation_claims_phase_check');
    expect(sql).toMatch(/phase text not null/);
    expect(sql).toMatch(/proposal_id uuid not null/);
    expect(sql).toMatch(/decision_id uuid/);
    expect(sql).toMatch(/provider_attempt_id uuid/);
    expect(sql).toMatch(
      /phase = 'proposal-create'[\s\S]+decision_id is null[\s\S]+provider_attempt_id is null[\s\S]+binding_hash is null/,
    );
    expect(sql).toMatch(
      /phase = 'visual-decision'[\s\S]+decision_id is not null[\s\S]+provider_attempt_id is null/,
    );
    expect(sql).not.toContain('workflow_operation_claims_proposal_fk');
    expect(lock).toContain('pg_catalog.clock_timestamp()');
    expect(issuer).toContain('emdo.lock_active_request_scope');
    expect(issuer).toContain('emdo.lock_current_google_calendar_authority');
    expect(issuer).toContain('space_access_grants');
    expect(issuer).toContain('disclosure_grants');
    expect(issuer).toContain('scope_assertion');
    expect(issuer).toContain('mutation_hash');
    expect(lock).toContain('emdo.workflow_operation_id');
    expect(lock).toContain('emdo.workflow_household_id');
    expect(lock).toContain('emdo.workflow_run_id');
    expect(lock).toContain('emdo.workflow_proposal_id');
    expect(lock).toContain('emdo.workflow_decision_id');
    expect(lock).toContain('emdo.workflow_provider_attempt_id');
    expect(lock).toContain('emdo.workflow_binding_hash');
    expect(lock).toContain('emdo.space_access_grants');
    expect(lock).toContain('emdo.disclosure_grants');
    expect(lock).toContain('grant_hash');
    expect(lock).toContain('version');
    expect(lock).toContain('revoked_at is null');
    expect(lock).toMatch(/for (?:no key update|update|key share|share)[^;]*/);
    expect(lock).not.toMatch(/current_timestamp|\bnow\(\)/);
  });

  it('uses security-definer commit functions for exact CAS, events, completion, and reconciliation', async () => {
    const sql = await readMigration();
    const functions = [
      'commit_provider_proposal_create',
      'commit_provider_proposal_abandonment',
      'commit_provider_proposal_transition',
      'commit_provider_proposal_decision',
      'commit_provider_proposal_prepare',
      'commit_provider_proposal_dispatch',
      'commit_provider_proposal_completion',
      'commit_provider_proposal_reconciliation',
    ];

    for (const name of functions) {
      const body = extractFunction(sql, name);
      expect(body).toContain('security definer');
      expect(body).toContain('set search_path = pg_catalog, emdo');
      expect(body).toContain('set row_security = on');
      expect(body).toContain("'created'");
      expect(body).toContain("'duplicate'");
      expect(body).toContain("'conflict'");
    }
    expect(sql).toContain('for update of state');
    expect(sql).toContain('expected_version');
    expect(sql).toContain('expected_state');
    expect(sql).toContain('expected_approval_hash');
    expect(sql).toContain('insert into emdo.proposal_events');
    expect(sql).toContain('insert into emdo.provider_outcomes');
    expect(sql).toContain('insert into emdo.proposal_reconciliations');
    expect(sql).toContain('completion_hash');
  });

  it('exposes only narrow functions and no direct proposal-table mutation grant to runtime logins', async () => {
    const sql = await readMigration();

    expect(sql).toContain('create role emdo_workflow_executor nologin');
    expect(sql).toContain('workflow executor must not have role memberships');
    expect(sql).toMatch(
      /alter function emdo\.commit_provider_proposal_create\(text, jsonb\)[^;]+owner to emdo_workflow_executor/,
    );
    for (const signature of [
      'commit_provider_proposal_abandonment\\(jsonb\\)',
      'commit_provider_proposal_transition\\(jsonb\\)',
      'commit_provider_proposal_decision\\(text, jsonb\\)',
      'commit_provider_proposal_prepare\\(text, jsonb\\)',
      'commit_provider_proposal_dispatch\\(text, jsonb\\)',
      'commit_provider_proposal_completion\\(jsonb\\)',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `alter function emdo\\.${signature}[^;]+owner to emdo_workflow_executor`,
        ),
      );
    }
    expect(sql).toMatch(
      /grant execute on function[^;]+commit_provider_proposal_create[^;]+to emdo_workflow_login/,
    );
    expect(sql).toMatch(
      /grant execute on function[^;]+commit_provider_proposal_reconciliation[^;]+to emdo_worker_executor/,
    );
    expect(sql).not.toMatch(/grant all/);
    expect(sql).not.toMatch(
      /grant (?:insert|update|delete)[^;]+(?:action_proposals|proposal_states|action_decisions|provider_attempts|provider_outcomes|proposal_reconciliations)[^;]+to (?:emdo_api_login|emdo_worker_executor_login|emdo_workflow_login)/,
    );
    expect(sql).not.toMatch(
      /grant execute on function[^;]+commit_provider_proposal_create[^;]+to emdo_app/,
    );
  });

  it('binds every post-approval commit to an exact claim or terminal authority and isolates reconciliation', async () => {
    const sql = await readMigration();
    const abandonment = extractFunction(
      sql,
      'commit_provider_proposal_abandonment',
    );
    const transition = extractFunction(
      sql,
      'commit_provider_proposal_transition',
    );
    const prepare = extractFunction(sql, 'commit_provider_proposal_prepare');
    const dispatch = extractFunction(sql, 'commit_provider_proposal_dispatch');
    const completion = extractFunction(
      sql,
      'commit_provider_proposal_completion',
    );
    const reconciliation = extractFunction(
      sql,
      'commit_provider_proposal_reconciliation',
    );

    expect(prepare).toContain("'provider-write-prepare'");
    expect(prepare).toContain('provider_proposal_mutation_hash');
    expect(prepare).toContain('claim_workflow_operation_scope');
    expect(prepare).toContain("p_input -> 'authorization'");
    expect(prepare).toContain("p_input -> 'approvalbinding'");
    expect(dispatch).toContain("'provider-write-dispatch'");
    expect(dispatch).toContain('provider_proposal_mutation_hash');
    expect(dispatch).toContain('claim_workflow_operation_scope');

    expect(abandonment).toContain("claim.phase = 'proposal-create'");
    expect(transition).toContain("claim.phase = 'proposal-create'");
    expect(completion).toContain('claim.phase = v_prior_phase');
    expect(completion).toContain(
      "when 'pre-dispatch' then 'provider-write-prepare'",
    );
    expect(completion).toContain("else 'provider-write-dispatch'");
    expect(completion).not.toContain('claim_workflow_operation_scope');

    expect(reconciliation).toContain("'emdo.calendar.reconciliation.v1'");
    expect(reconciliation).toContain('emdo.current_worker_target_id()');
    expect(reconciliation).toContain('emdo.is_active_worker_operation_scope');
    expect(sql).toContain(
      'create role emdo_proposal_reconciliation_executor nologin',
    );
    expect(sql).toMatch(
      /alter function emdo\.commit_provider_proposal_reconciliation\(jsonb\)[\s\S]+owner to emdo_proposal_reconciliation_executor/,
    );
    expect(sql).toMatch(
      /grant execute on function[\s\S]+emdo\.current_worker_job_name\(\)[\s\S]+emdo\.current_worker_target_type\(\)[\s\S]+emdo\.current_worker_target_id\(\)[\s\S]+emdo\.is_active_worker_operation_scope\(uuid, uuid, uuid\)[\s\S]+to emdo_proposal_reconciliation_executor/,
    );
    expect(sql).toMatch(
      /revoke all on function\s+emdo\.commit_provider_proposal_reconciliation\(jsonb\)[^;]+from public[^;]+;[\s\S]+?grant execute on function\s+emdo\.commit_provider_proposal_reconciliation\(jsonb\)[^;]+to emdo_worker_executor/,
    );
    expect(sql).not.toMatch(
      /grant execute on function\s+emdo\.commit_provider_proposal_reconciliation\(jsonb\)[^;]+to emdo_app/,
    );
    expect(sql).toMatch(
      /revoke insert on emdo\.proposal_reconciliations[^;]+from emdo_worker(?:, emdo_worker_executor|_executor)/,
    );
  });
});
