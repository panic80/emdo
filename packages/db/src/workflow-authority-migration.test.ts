import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from './migrations.js';

const postgresInitUrl = new URL(
  '../../../infra/compose/postgres-init.sql',
  import.meta.url,
);
const provisionRuntimeUrl = new URL(
  '../../../infra/compose/provision-runtime.sql',
  import.meta.url,
);

const normalizeSql = (sql: string) => sql.toLowerCase().replaceAll('"', '');

const readMigrationSql = async () =>
  normalizeSql(
    (await loadOrderedMigrations())
      .map(({ sql }) => sql)
      .join('\n--> ordered-migration-boundary\n'),
  );

const readProvisioningSql = async () =>
  normalizeSql(
    `${await readFile(postgresInitUrl, 'utf8')}\n${await readFile(
      provisionRuntimeUrl,
      'utf8',
    )}`,
  );

const extractClaimFunction = (sql: string): string => {
  const match = sql.match(
    /create or replace function emdo\.claim_workflow_operation_scope\s*\([\s\S]+?\$function\$;/,
  );
  expect(
    match,
    'workflow operation claim function must be present',
  ).not.toBeNull();
  return match?.[0] ?? '';
};

const extractIssuerFunction = (sql: string): string => {
  const match = sql.match(
    /create or replace function emdo\.issue_workflow_operation_claim\s*\([\s\S]+?\$function\$;/,
  );
  expect(match, 'workflow operation issuer must be present').not.toBeNull();
  return match?.[0] ?? '';
};

describe('workflow authority migration', () => {
  it('creates a forced-RLS, immutable, single-use workflow operation authority', async () => {
    const sql = await readMigrationSql();

    expect(sql).toContain('create table emdo.workflow_operation_claims');
    expect(sql).toContain(
      'alter table emdo.workflow_operation_claims enable row level security',
    );
    expect(sql).toContain(
      'alter table emdo.workflow_operation_claims force row level security',
    );
    for (const column of [
      'operation_id',
      'phase',
      'scope_assertion',
      'origin_request_id',
      'origin_space_access_grant_id',
      'origin_session_id',
      'current_request_id',
      'current_space_access_grant_id',
      'current_session_id',
      'authorization_scope_fingerprint',
      'disclosure_grant_id',
      'disclosure_grant_version',
      'disclosure_grant_hash',
      'provider_sdk_call_id',
      'active_at',
      'require_active_disclosure_grant',
      'authenticated_session_id',
      'provider_authority_binding_hash',
      'preparation_binding_hash',
      'mutation_hash',
      'household_id',
      'space_id',
      'original_owner_user_id',
      'user_id',
      'run_id',
      'proposal_id',
      'decision_id',
      'provider_attempt_id',
      'binding_hash',
      'issued_at',
      'expires_at',
      'claimed_at',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `create table emdo\\.workflow_operation_claims[\\s\\S]+${column}`,
        ),
      );
    }
    expect(sql).toContain('workflow_operation_claims_operation_id_check');
    expect(sql).toContain('pg_catalog.length(operation_id) between 32 and 512');
    expect(sql).toContain("operation_id ~ '^[a-za-z0-9_-]+$'");
    expect(sql).toContain('workflow_operation_claims_binding_hash_check');
    expect(sql).toContain('workflow_operation_claims_lifetime_check');
    expect(sql).toMatch(
      /create trigger workflow_operation_claims_transition[\s\S]+before update or delete on emdo\.workflow_operation_claims/,
    );
    expect(sql).toContain('workflow operation claim binding is immutable');
  });

  it('binds each operation phase without requiring rows that do not exist yet', async () => {
    const sql = await readMigrationSql();

    expect(sql).toContain('workflow_operation_claims_phase_check');
    for (const phase of [
      'proposal-create',
      'visual-decision',
      'provider-write-prepare',
      'provider-write-dispatch',
    ]) {
      expect(sql).toContain(phase);
    }
    expect(sql).toMatch(
      /phase = 'proposal-create'[\s\S]+decision_id is null[\s\S]+provider_attempt_id is null/,
    );
    expect(sql).toMatch(
      /phase = 'visual-decision'[\s\S]+decision_id is not null[\s\S]+provider_attempt_id is null/,
    );
    expect(sql).toMatch(
      /phase = 'provider-write-prepare'[\s\S]+decision_id is not null[\s\S]+provider_attempt_id is not null/,
    );
    expect(sql).toMatch(
      /phase = 'provider-write-dispatch'[\s\S]+decision_id is not null[\s\S]+provider_attempt_id is not null/,
    );
    expect(sql).not.toContain('workflow_operation_claims_proposal_fk');
    expect(sql).not.toContain('workflow_operation_claims_decision_fk');
    expect(sql).not.toContain('workflow_operation_claims_attempt_fk');
  });

  it('mints claims only through a private canonical issuer owned by the workflow executor', async () => {
    const sql = await readMigrationSql();
    const issuer = extractIssuerFunction(sql);

    expect(issuer).toMatch(
      /issue_workflow_operation_claim\s*\(\s*p_operation_id text,\s*p_scope jsonb,\s*p_decision_id uuid,\s*p_provider_attempt_id uuid,\s*p_binding_hash text,\s*p_create_preparation_binding_hash text,\s*p_provider_authority_binding_hash text,\s*p_mutation jsonb\s*\)/,
    );
    expect(issuer).toContain('returns boolean');
    expect(issuer).toContain('security definer');
    expect(issuer).toContain('set search_path = pg_catalog, emdo');
    expect(issuer).toContain('set row_security = on');
    expect(issuer).toContain('emdo.current_user_id()');
    expect(issuer).toContain('emdo.current_session_id()');
    expect(issuer).toContain('emdo.current_request_id()');
    expect(issuer).toContain('emdo.lock_active_request_scope');
    expect(issuer).toContain('emdo.lock_current_authorization_scope');
    expect(issuer).toContain('emdo.lock_current_google_calendar_authority');
    expect(issuer).toContain('emdo.space_access_grants');
    expect(issuer).toContain('emdo.disclosure_grants');
    expect(issuer).toContain('emdo.agent_runs');
    expect(issuer).toContain('pg_catalog.clock_timestamp()');
    expect(issuer).toContain('grant_hash');
    expect(issuer).toContain('version');
    expect(issuer).toContain('revoked_at is null');
    expect(issuer).toContain('insert into emdo.workflow_operation_claims');
    expect(issuer).toContain('if found then');
    expect(issuer).not.toContain('return v_existing.claimed_at is null');
    expect(issuer).toContain('v_existing.expires_at > v_now');
    expect(issuer).toContain('v_has_existing_claim boolean := false');
    expect(issuer).toContain('v_has_existing_claim := found');
    expect(issuer).toContain('found and not v_has_existing_claim');
    expect(issuer).toContain('if not v_has_existing_claim then');
    expect(issuer).toMatch(
      /v_has_existing_claim[\s\S]{0,120}attempt\.attempt_state = 'prepared'/,
    );
    expect(issuer).toContain('origin_request_id');
    expect(issuer).toContain('origin_space_access_grant_id');
    expect(issuer).toContain('origin_session_id');
    expect(issuer).toContain('current_request_id');
    expect(issuer).toContain('current_space_access_grant_id');
    expect(issuer).toContain('current_session_id');
    expect(issuer).toContain('authorization_scope_fingerprint');
    expect(issuer).toMatch(
      /proposal\.authorization_scope_fingerprint[\s\S]{0,100}v_authorization_scope_fingerprint/,
    );
    expect(issuer).not.toMatch(
      /preparation_binding\s*->>\s*'spaceaccessgrantid'[\s\S]{0,100}v_space_access_grant_id/,
    );
    expect(issuer).toContain('emdo.workflow-mutation.v1');
    expect(issuer).toContain("pg_catalog.decode('00', 'hex')");
    expect(issuer).toContain('v_mutation_max_depth > 12');
    expect(issuer).toContain(
      'pg_catalog.octet_length(p_mutation::text) > 524288',
    );
    for (const exactTopLevelKeyCount of [4, 6, 8]) {
      expect(issuer).toContain(
        `v_mutation_key_count <> ${exactTopLevelKeyCount}`,
      );
    }
    expect(issuer).toContain(
      "p_mutation #>> '{decision,decision}' is distinct from 'rejected'",
    );
    expect(issuer).toMatch(
      /for (?:no key update|update|key share|share) of [^;]+/,
    );
    for (const key of [
      'phase',
      'currentRequestId',
      'currentSessionId',
      'runId',
      'householdId',
      'userId',
      'currentSpaceAccessGrantId',
      'authorizationScopeFingerprint',
      'disclosureGrantId',
      'disclosureGrantVersion',
      'disclosureGrantHash',
      'proposalId',
      'providerSdkCallId',
      'activeAt',
      'requireActiveDisclosureGrant',
    ]) {
      expect(issuer).toContain(key.toLowerCase());
    }
    expect(sql).toMatch(
      /alter function emdo\.issue_workflow_operation_claim\(text, jsonb, uuid, uuid, text, text, text, jsonb\)[\s\S]+owner to emdo_workflow_executor/,
    );
    const issuerStatements = sql
      .split(';')
      .filter((statement) =>
        statement.includes('issue_workflow_operation_claim'),
      );
    const issuerGrants = issuerStatements.filter((statement) =>
      statement.includes('grant execute on function'),
    );
    expect(sql).toContain('rename to issue_workflow_operation_claim_calendar');
    expect(issuerGrants).toHaveLength(3);
    expect(
      issuerGrants.filter((grant) =>
        grant.includes('issue_workflow_operation_claim_calendar'),
      ),
    ).toHaveLength(1);
    expect(
      issuerGrants.filter(
        (grant) =>
          grant.includes('issue_workflow_operation_claim(') &&
          !grant.includes('issue_workflow_operation_claim_calendar'),
      ),
    ).toHaveLength(2);
    for (const grant of issuerGrants) {
      expect(grant).toMatch(/to\s+emdo_workflow_executor\s*$/);
      expect(grant).not.toMatch(/emdo_app|emdo_workflow_login|public/);
    }
    expect(sql).toMatch(
      /lock_current_google_calendar_authority\(uuid, uuid, uuid, text, text\)/,
    );
    expect(sql).not.toMatch(
      /grant insert[^;]+workflow_operation_claims[^;]+to emdo_app/,
    );
  });

  it('owns the claim boundary with a hardened, membership-free NOLOGIN role', async () => {
    const sql = await readMigrationSql();

    expect(sql).toMatch(
      /create role emdo_workflow_executor nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication/,
    );
    expect(sql).toMatch(
      /alter role emdo_workflow_executor nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication/,
    );
    expect(sql).toContain('workflow executor must not have role memberships');
    expect(sql).toMatch(
      /alter function emdo\.claim_workflow_operation_scope\(text\)[\s\S]+owner to emdo_workflow_executor/,
    );
  });

  it('claims one opaque operation under canonical aggregate locks and transaction-local scope', async () => {
    const sql = await readMigrationSql();
    const claim = extractClaimFunction(sql);

    expect(claim).toMatch(
      /claim_workflow_operation_scope\s*\(\s*p_operation_id text\s*\)/,
    );
    expect(claim).toContain('returns boolean');
    expect(claim).toContain('security definer');
    expect(claim).toContain('set search_path = pg_catalog, emdo');
    expect(claim).toContain('set row_security = on');
    const lockClauses =
      claim
        .match(/for (?:no key update|update|key share|share) of [^;]+/g)
        ?.join('\n') ?? '';
    expect(lockClauses).toMatch(/for (?:no key )?update of [^;]*claim/);
    for (const lockedAlias of [
      'account_user',
      'session',
      'membership',
      'space',
      'run',
      'proposal',
      'decision',
      'attempt',
    ]) {
      expect(lockClauses).toMatch(new RegExp(`\\b${lockedAlias}\\b`));
    }
    expect(claim).toContain('pg_catalog.clock_timestamp()');
    expect(claim).toContain('emdo.lock_current_authorization_scope');
    expect(claim).toContain('emdo.lock_current_google_calendar_authority');
    expect(claim).toContain('authorization_scope_fingerprint');
    expect(claim).toContain('current_space_access_grant_id');
    expect(claim).toContain('origin_space_access_grant_id');
    expect(claim).not.toMatch(
      /preparation_binding\s*->>\s*'spaceaccessgrantid'[\s\S]{0,100}v_claim\.current_space_access_grant_id/,
    );
    expect(claim).toMatch(/claimed_at\s+is\s+null/);
    expect(claim).toMatch(/expires_at\s*>\s*pg_catalog\.clock_timestamp\(\)/);
    expect(claim).toMatch(
      /update emdo\.workflow_operation_claims[\s\S]+set claimed_at\s*=\s*pg_catalog\.clock_timestamp\(\)/,
    );

    for (const canonicalRelation of [
      'emdo.auth_users',
      'emdo.auth_sessions',
      'emdo.household_memberships',
      'emdo.spaces',
      'emdo.agent_runs',
      'emdo.action_proposals',
      'emdo.action_decisions',
      'emdo.provider_attempts',
    ]) {
      expect(claim).toContain(canonicalRelation);
    }
    for (const invariant of [
      'email_verified = true',
      "membership.status = 'active'",
      "decision.decision = 'approved'",
      "decision.channel = 'authenticated-visual'",
      'decision.authenticated_session_id = claim.current_session_id',
      'proposal.run_id = claim.run_id',
      'attempt.proposal_id = claim.proposal_id',
      'attempt.decision_id = claim.decision_id',
      'attempt.binding_hash = claim.binding_hash',
    ]) {
      expect(claim).toContain(invariant);
    }

    for (const setting of [
      'emdo.user_id',
      'emdo.session_id',
      'emdo.request_id',
      'emdo.workflow_operation_id',
      'emdo.workflow_phase',
      'emdo.workflow_household_id',
      'emdo.workflow_space_id',
      'emdo.workflow_original_owner_user_id',
      'emdo.workflow_run_id',
      'emdo.workflow_proposal_id',
      'emdo.workflow_decision_id',
      'emdo.workflow_provider_attempt_id',
      'emdo.workflow_origin_request_id',
      'emdo.workflow_origin_space_access_grant_id',
      'emdo.workflow_origin_session_id',
      'emdo.workflow_current_request_id',
      'emdo.workflow_current_space_access_grant_id',
      'emdo.workflow_current_session_id',
      'emdo.workflow_authorization_scope_fingerprint',
      'emdo.workflow_binding_hash',
      'emdo.workflow_mutation_hash',
    ]) {
      expect(claim).toMatch(
        new RegExp(`set_config\\(\\s*'${setting.replaceAll('.', '\\.')}'`),
      );
    }
    expect(claim).not.toMatch(/set_config\([\s\S]+?,\s*false\s*\)/);
  });

  it('removes the legacy workflow ACL and keeps the claim primitive private', async () => {
    const sql = await readMigrationSql();
    const claimStatements = sql
      .split(';')
      .filter((statement) =>
        statement.includes('claim_workflow_operation_scope'),
      );
    const grants = claimStatements.filter((statement) =>
      statement.includes('grant execute on function'),
    );

    expect(sql).toContain(
      'revoke all privileges on all tables in schema emdo from emdo_workflow',
    );
    expect(sql).toContain(
      'revoke all privileges on all sequences in schema emdo from emdo_workflow',
    );
    expect(sql).toContain(
      'revoke all privileges on all functions in schema emdo from emdo_workflow',
    );
    expect(sql).toContain('revoke all on schema emdo from emdo_workflow');
    expect(sql).toMatch(
      /revoke all on function[\s\S]+emdo\.claim_workflow_operation_scope\(text\)[\s\S]+from[\s\S]+public[\s\S]+emdo_workflow/,
    );
    expect(sql).toMatch(/grant usage on schema emdo to emdo_workflow_login/);
    expect(sql).toContain('rename to claim_workflow_operation_scope_calendar');
    expect(grants).toHaveLength(2);
    for (const grant of grants) {
      expect(grant).toMatch(/to\s+emdo_workflow_executor\s*$/);
      expect(grant).not.toMatch(/public|emdo_workflow_login/);
    }
    expect(sql).not.toMatch(
      /grant execute on function\s+emdo\.claim_workflow_operation_scope\(text\)[^;]+to\s+emdo_workflow_login/,
    );
    expect(sql).not.toMatch(/grant all/);
  });

  it('issues and consumes operation authority inside each assertion-bearing aggregate transaction', async () => {
    const sql = await readMigrationSql();

    for (const name of [
      'commit_provider_proposal_create',
      'commit_provider_proposal_decision',
      'commit_provider_proposal_prepare',
      'commit_provider_proposal_dispatch',
    ]) {
      const match = sql.match(
        new RegExp(
          `create or replace function emdo\\.${name}\\s*\\([\\s\\S]+?\\$function\\$;`,
        ),
      );
      expect(match, `${name} must be present`).not.toBeNull();
      const aggregate = match?.[0] ?? '';
      expect(aggregate).toContain('emdo.issue_workflow_operation_claim');
      expect(aggregate).toContain('emdo.claim_workflow_operation_scope');
      expect(
        aggregate.indexOf('emdo.issue_workflow_operation_claim'),
      ).toBeLessThan(aggregate.indexOf('emdo.claim_workflow_operation_scope'));
    }
  });

  it('lets an exact claimed operation reach aggregate replay validation without reclaiming it', async () => {
    const sql = await readMigrationSql();

    for (const name of [
      'commit_provider_proposal_create',
      'commit_provider_proposal_decision',
      'commit_provider_proposal_prepare',
      'commit_provider_proposal_dispatch',
    ]) {
      const match = sql.match(
        new RegExp(
          `create or replace function emdo\\.${name}\\s*\\([\\s\\S]+?\\$function\\$;`,
        ),
      );
      const aggregate = match?.[0] ?? '';
      const claimCall = aggregate.indexOf(
        'if not emdo.claim_workflow_operation_scope',
      );
      expect(claimCall).toBeGreaterThan(-1);
      if (name === 'commit_provider_proposal_decision') {
        expect(aggregate).toMatch(
          /if v_claim\.claimed_at is null then[\s\S]+if not emdo\.claim_workflow_operation_scope/,
        );
      } else {
        expect(aggregate).toContain('v_claim.claimed_at is not null');
        expect(
          aggregate.indexOf('v_claim.claimed_at is not null'),
        ).toBeLessThan(claimCall);
      }
    }
  });

  it('provisions the workflow login as NOINHERIT without legacy or executor membership', async () => {
    const provisioning = await readProvisioningSql();

    expect(provisioning).toMatch(
      /create role emdo_workflow_login login nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication/,
    );
    expect(provisioning).toMatch(
      /alter role emdo_workflow_login login nosuperuser nocreatedb nocreaterole[\s\n]+noinherit nobypassrls noreplication/,
    );
    expect(provisioning).toContain(
      'revoke emdo_workflow from emdo_workflow_login',
    );
    expect(provisioning).not.toMatch(
      /grant\s+emdo_(?:workflow|workflow_executor)\s+to\s+emdo_workflow_login/,
    );
    expect(provisioning).not.toMatch(
      /grant execute on function\s+emdo\.claim_workflow_operation_scope\(text\)[^;]+to\s+emdo_workflow_login/,
    );
    expect(provisioning).not.toMatch(
      /grant execute on function\s+emdo\.issue_workflow_operation_claim\(text, jsonb, uuid, uuid, text, text, text, jsonb\)[^;]+to\s+emdo_workflow_login/,
    );
    for (const aggregate of [
      'commit_provider_proposal_create(text, jsonb)',
      'commit_provider_proposal_decision(text, jsonb)',
      'commit_provider_proposal_prepare(text, jsonb)',
      'commit_provider_proposal_dispatch(text, jsonb)',
      'commit_provider_proposal_abandonment(jsonb)',
      'commit_provider_proposal_transition(jsonb)',
      'commit_provider_proposal_completion(jsonb)',
    ]) {
      expect(provisioning).toContain(`emdo.${aggregate}`);
    }
    expect(provisioning).not.toMatch(
      /grant\s+(?:create|select|insert|update|delete|truncate|references|trigger|maintain|all)[^;]+to\s+emdo_workflow_login/,
    );
  });
});
