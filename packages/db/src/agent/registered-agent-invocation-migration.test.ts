import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../drizzle/0022_registered_agent_invocation_lineage.sql',
  import.meta.url,
);
const legacyProposalMigrationUrl = new URL(
  '../../drizzle/0018_finance_guarded_proposal_authority.sql',
  import.meta.url,
);

const readRawMigration = async () =>
  (await readFile(migrationUrl, 'utf8')).toLowerCase();

const readMigration = async () =>
  (await readRawMigration()).replaceAll('"', '');

const readLegacyProposalMigration = async () =>
  (await readFile(legacyProposalMigrationUrl, 'utf8'))
    .toLowerCase()
    .replaceAll('"', '');

const functionBody = (sql: string, name: string): string | undefined =>
  sql.match(
    new RegExp(
      `create (?:or replace )?function emdo\\.${name}[\\s\\S]+?end\\s*\\$function\\$`,
      'u',
    ),
  )?.[0];

const normalizeWhitespace = (value: string): string =>
  value.replaceAll(/\s+/gu, ' ').trim();

const executeGrantStatements = (sql: string): string[] =>
  [...sql.matchAll(/grant execute on function[\s\S]*?;/gu)].map((statement) =>
    normalizeWhitespace(statement[0]),
  );

describe('registered agent invocation lineage migration', () => {
  it('adds only the immutable context and hash columns to the existing grant aggregate', async () => {
    const sql = await readMigration();

    expect(sql).toMatch(
      /alter table emdo\.disclosure_grants add column invocation_context jsonb/,
    );
    expect(sql).toMatch(
      /alter table emdo\.disclosure_grants add column invocation_context_hash text/,
    );
    expect(
      sql.match(/alter table emdo\.disclosure_grants add column/g),
    ).toHaveLength(2);
    expect(sql).not.toContain('create table emdo.agent_invocations');
    expect(sql).toContain('disclosure_grants_run_phase_agent_unique');
  });

  it('mints and verifies the exact canonical ten-field authority envelope', async () => {
    const sql = await readMigration();
    const issue = functionBody(sql, 'issue_model_disclosure_grant');
    const resolve = functionBody(sql, 'resolve_model_disclosure_grant');

    expect(issue).toContain('p_invocation_identity jsonb');
    expect(issue).toContain('p_record_allowlist jsonb');
    expect(issue).toContain('rootmanagerinvocationid');
    expect(issue).toContain("'locale'");
    expect(issue).toContain("'disclosedcontextrefs'");
    expect(issue).toContain("'idempotencyscope'");
    expect(issue).toContain("'emdo.agent-invocation-scope.v1'");
    expect(issue).toContain("'context-ref-' || emdo.canonical_json_hash");
    expect(issue).toContain('invocation_context_hash');
    expect(issue).toContain('registered_agent_invocation_context_matches');
    expect(resolve).toContain('grant-invocation-mismatch');
    expect(resolve).toContain('registered_agent_invocation_context_matches');
    expect(resolve).toContain('p_invocation_identity');
  });

  it('allows only the four canonical manager delegation profiles', async () => {
    const sql = await readMigration();
    const rawSql = await readRawMigration();
    const identity = functionBody(
      sql,
      'registered_agent_invocation_identity_is_valid',
    );
    const managerCapabilityGuard = rawSql.match(
      /p_invocation_identity -> 'grantedcapabilities' not in \(\s*(?<profiles>(?:'[^']+'::jsonb,\s*)*'[^']+'::jsonb)\s*\)/u,
    )?.groups?.profiles;
    const allowedProfiles = [
      '[]',
      '["agent.finance.delegate"]',
      '["agent.scheduler.delegate"]',
      '["agent.finance.delegate","agent.scheduler.delegate"]',
    ];
    const guardedProfiles = [
      ...(managerCapabilityGuard ?? '').matchAll(/'([^']+)'::jsonb/gu),
    ].map((match) => match[1]);
    const allowsManagerProfile = (profile: string[]) =>
      guardedProfiles.includes(JSON.stringify(profile));

    expect(guardedProfiles).toEqual(allowedProfiles);
    for (const profile of [
      [],
      ['agent.finance.delegate'],
      ['agent.scheduler.delegate'],
      ['agent.finance.delegate', 'agent.scheduler.delegate'],
    ]) {
      expect(allowsManagerProfile(profile)).toBe(true);
    }
    expect(
      allowsManagerProfile([
        'agent.finance.delegate',
        'agent.scheduler.delegate',
        'finance.records.read',
      ]),
    ).toBe(false);
    expect(allowsManagerProfile(['finance.records.read'])).toBe(false);
    expect(allowsManagerProfile(['agent.unknown.delegate'])).toBe(false);
    expect(allowsManagerProfile(['agent.shopping.delegate'])).toBe(false);
    expect(
      allowsManagerProfile([
        'agent.scheduler.delegate',
        'agent.finance.delegate',
      ]),
    ).toBe(false);
    expect(
      allowsManagerProfile([
        'agent.finance.delegate',
        'agent.finance.delegate',
      ]),
    ).toBe(false);
    expect(identity).toContain('v_previous >= v_value');
  });

  it('requires the registered exact capability profile for each specialist', async () => {
    const rawSql = await readRawMigration();
    const schedulerProfile = rawSql.match(
      /p_agent_id = 'scheduler'\s+and p_invocation_identity -> 'grantedcapabilities' is distinct from\s*'(?<profile>[^']+)'::jsonb/u,
    )?.groups?.profile;
    const financeProfile = rawSql.match(
      /p_agent_id = 'finance'\s+and p_invocation_identity -> 'grantedcapabilities' is distinct from\s*'(?<profile>[^']+)'::jsonb/u,
    )?.groups?.profile;
    const outcomeFinanceProfile = rawSql.match(
      /p_outcome ->> 'specialistid' = 'finance'\s+and v_context -> 'grantedcapabilities' is distinct from\s*'(?<profile>[^']+)'::jsonb/u,
    )?.groups?.profile;
    const registeredFinanceCapabilities = [
      'finance.analytics.calculate',
      'finance.documents.read',
      'finance.documents.search',
      'finance.matches.read',
      'finance.records.read',
      'finance.records.write',
      'finance.statement.import',
    ];
    const allowsFinanceSpecialistProfile = (profile: string[]) =>
      financeProfile === JSON.stringify(profile);

    expect(schedulerProfile).toBe('["google-calendar.event.create"]');
    expect(financeProfile).toBe(JSON.stringify(registeredFinanceCapabilities));
    expect(outcomeFinanceProfile).toBe(financeProfile);
    expect(allowsFinanceSpecialistProfile(registeredFinanceCapabilities)).toBe(
      true,
    );
    expect(
      allowsFinanceSpecialistProfile([
        'finance.documents.search',
        'finance.records.read',
        'finance.records.write',
        'finance.statement.import',
      ]),
    ).toBe(false);
    expect(
      allowsFinanceSpecialistProfile([
        'agent.shopping.delegate',
        ...registeredFinanceCapabilities,
      ]),
    ).toBe(false);
    expect(
      allowsFinanceSpecialistProfile([
        'finance.documents.read',
        'finance.analytics.calculate',
        'finance.documents.search',
        'finance.matches.read',
        'finance.records.read',
        'finance.records.write',
        'finance.statement.import',
      ]),
    ).toBe(false);
  });

  it('fails closed for historic null context, root/locale drift, and widening at every mutation boundary', async () => {
    const sql = await readMigration();
    const commit = functionBody(sql, 'commit_model_disclosure_authorization');
    const denial = functionBody(sql, 'record_model_disclosure_denial');
    const lineage = functionBody(
      sql,
      'registered_specialist_outcomes_match_lineage',
    );

    expect(commit).toContain('p_invocation_context is null');
    expect(commit).toContain('v_grant.invocation_context is distinct from');
    expect(denial).toContain('p_invocation_context is null');
    expect(denial).toContain(
      'v_grant.invocation_context_hash is distinct from',
    );
    expect(lineage).toContain('parentinvocationid');
    expect(lineage).toContain('phaseinvocationid');
    expect(lineage).toContain("v_outcome ->> 'status' = 'unavailable'");
    expect(lineage).toContain('registered_agent_invocation_context_matches');
  });

  it('finalizes provider proposals against the persisted invocation envelope without widening its execution boundary', async () => {
    const sql = await readMigration();
    const legacySql = await readLegacyProposalMigration();
    const commit = functionBody(sql, 'commit_provider_proposal_create');
    const legacyCommit = functionBody(
      legacySql,
      'commit_provider_proposal_create',
    );

    if (commit === undefined || legacyCommit === undefined) {
      throw new Error('provider proposal create definition was not found');
    }

    const expectedCommit = legacyCommit
      .replace(
        "'onerunonly', v_disclosure.one_run_only",
        [
          "'onerunonly', v_disclosure.one_run_only,",
          "'invocationcontext', v_disclosure.invocation_context,",
          "'invocationcontexthash', v_disclosure.invocation_context_hash",
        ].join('\n\t\t\t\t'),
      )
      .replace(
        'if v_created_at > v_now or v_expires_at <= v_now',
        "if v_created_at > v_now + interval '5 seconds' or v_expires_at <= v_now",
      );
    const orderedCommitTail = sql.slice(
      sql.indexOf(
        'create or replace function emdo.commit_provider_proposal_create',
      ),
    );
    const commitGrants = executeGrantStatements(orderedCommitTail).filter(
      (statement) => statement.includes('commit_provider_proposal_create'),
    );

    expect(commit).toBe(expectedCommit);
    expect(commit).toContain('security definer');
    expect(commit).toContain('set search_path = pg_catalog, emdo');
    expect(commit).toContain('set row_security = on');
    expect(commit).toContain('v_disclosure.invocation_context');
    expect(commit).toContain('v_disclosure.invocation_context_hash');
    expect(commit).toContain(
      "if v_created_at > v_now + interval '5 seconds' or v_expires_at <= v_now",
    );
    expect(commit).not.toContain('if v_created_at > v_now or');
    expect(commit).not.toMatch(
      /v_created_at > v_now \+ interval '(?:[6-9]|[1-9][0-9]+) seconds'/u,
    );
    expect(orderedCommitTail).toContain(
      'alter function emdo.commit_provider_proposal_create(text, jsonb)\n\towner to emdo_workflow_executor;',
    );
    expect(orderedCommitTail).toMatch(
      /revoke all on function\s+emdo\.commit_provider_proposal_create\(text, jsonb\)\s+from public, emdo_app,[\s\S]+?emdo_manager_turn_executor;/u,
    );
    expect(commitGrants).toEqual([
      'grant execute on function emdo.commit_provider_proposal_create(text, jsonb) to emdo_workflow_login;',
    ]);
    expect(orderedCommitTail).not.toMatch(
      /grant (?:all|execute) on function\s+emdo\.commit_provider_proposal_create\(text, jsonb\)[\s\S]*?\bto\s+[^;]*\bemdo_app\b/u,
    );
  });

  it('persists locale and a durable root in the manager request and validates five-way outcomes before writes', async () => {
    const sql = await readMigration();
    const claim = functionBody(sql, 'claim_manager_turn');
    const complete = functionBody(sql, 'complete_manager_turn');
    const outcome = functionBody(sql, 'registered_specialist_outcome_is_valid');
    const lineage = functionBody(
      sql,
      'registered_specialist_outcomes_match_lineage',
    );

    expect(claim).toContain("'locale', 'rootmanagerinvocationid'");
    expect(claim).toContain("'rootmanagerinvocationid', p_request ->>");
    expect(claim).toContain('rootmanagerinvocationid');
    expect(claim).toContain("request_payload - 'rootmanagerinvocationid'");
    expect(complete).toContain('registered_manager_turn_result_is_valid');
    expect(complete).toContain('registered_specialist_outcomes_match_lineage');
    expect(complete).toContain('needs_confirmation');
    expect(complete).toContain('approval.required');
    expect(complete).toContain("'shopping-list-v1'");
    expect(complete).toContain(
      "v_turn.requested_model is distinct from 'provider-free-mvp-v1'",
    );
    expect(complete).toContain('agent_run_events');
    expect(outcome).toContain(
      "jsonb_typeof(p_outcome -> 'reasoncode') is distinct from 'string'",
    );
    expect(outcome).toContain("jsonb_array_elements(p_outcome -> 'evidence')");
    expect(outcome).toContain(
      "jsonb_typeof(evidence.value) is distinct from 'string'",
    );
    expect(lineage).toContain('volatile');
  });

  it('exposes only new security-definer entrypoints and binds approval resume to the stored root', async () => {
    const sql = await readMigration();
    const claim = functionBody(sql, 'claim_approval_resume_job');
    const settle = functionBody(sql, 'settle_approval_resume_job');
    const binding = functionBody(
      sql,
      'registered_approval_resume_binding_is_valid',
    );

    expect(claim).toContain('rootmanagerinvocationid');
    expect(claim).toContain('registered_approval_resume_binding_is_valid');
    expect(settle).toContain('approval_resume_turn_result_is_valid(p_result)');
    expect(settle).toContain('registered_specialist_outcomes_match_lineage');
    expect(binding).toContain('volatile');
    expect(sql).toContain('claim_approval_resume_job_legacy_v5');
    expect(sql).toContain('settle_approval_resume_job_legacy_v5');
    expect(sql).toMatch(
      /revoke all on function[\s\S]+issue_model_disclosure_grant[\s\S]+from public, emdo_app/,
    );
    expect(sql).toMatch(
      /grant execute on function[\s\S]+commit_model_disclosure_authorization[\s\S]+to emdo_app/,
    );
    expect(sql).toMatch(
      /grant execute on function[\s\S]+claim_manager_turn[\s\S]+complete_manager_turn[\s\S]+claim_approval_resume_job[\s\S]+to emdo_app/,
    );
    expect(sql).toContain('registered_disclosure_run_is_current');
    expect(sql).toContain('approval_resume_manager_turns_executor_lock');
    expect(sql).toContain('approval_resume_disclosures_executor_lock');
  });

  it('rejects every malformed completed resume result before a state lookup or legacy delegation', async () => {
    const sql = await readMigration();
    const settle = functionBody(sql, 'settle_approval_resume_job');

    if (settle === undefined) {
      throw new Error('approval resume settlement definition was not found');
    }

    const resultPrevalidation = settle.indexOf(
      "if p_mode = 'complete'\n\t\tand emdo.approval_resume_turn_result_is_valid(p_result)",
    );
    const stateLookup = settle.indexOf('select resume.* into v_job');
    const legacyDelegation = settle.indexOf(
      'settle_approval_resume_job_legacy_v5(',
    );

    expect(resultPrevalidation).toBeGreaterThanOrEqual(0);
    expect(stateLookup).toBeGreaterThanOrEqual(0);
    expect(legacyDelegation).toBeGreaterThanOrEqual(0);
    expect(resultPrevalidation).toBeLessThan(stateLookup);
    expect(resultPrevalidation).toBeLessThan(legacyDelegation);
    expect(settle.slice(resultPrevalidation, stateLookup)).toContain(
      "return pg_catalog.jsonb_build_object('status', 'conflict')",
    );
  });

  it('restores strict terminal result validation while retaining registered specialist outcomes', async () => {
    const sql = await readMigration();
    const validator = functionBody(sql, 'approval_resume_turn_result_is_valid');

    if (validator === undefined) {
      throw new Error('approval resume result validator was not found');
    }

    expect(validator).toContain(
      "'status', 'requestedmodel', 'resolvedmodel', 'reason'",
    );
    expect(validator).toContain(
      "octet_length(v_usage ->> 'inputtokens') not between 1 and 64",
    );
    expect(validator).toContain('9007199254740991::numeric');
    expect(validator).toContain(
      "v_safe_error, array['code', 'message', 'retryable']::text[]",
    );
    expect(validator).toContain(
      'registered_specialist_outcome_is_valid(v_outcome)',
    );
    expect(validator).toContain("v_status = 'completed'");
    expect(validator).toContain("v_status = 'failed'");
    expect(validator).not.toContain(
      'registered_manager_turn_result_is_valid(p_result)',
    );
  });

  it('grants only the missing shared helper chain to each new security-definer owner', async () => {
    const sql = await readMigration();
    const sharedHelperGrants = executeGrantStatements(sql).filter(
      (statement) =>
        statement.includes('canonical_json_text(jsonb)') ||
        statement.includes('canonical_json_hash(jsonb)') ||
        statement.includes('jsonb_object_has_exact_keys(jsonb, text[])'),
    );

    expect(sharedHelperGrants).toEqual([
      'grant execute on function emdo.canonical_json_text(jsonb), emdo.canonical_json_hash(jsonb), emdo.jsonb_object_has_exact_keys(jsonb, text[]) to emdo_disclosure_executor;',
      'grant execute on function emdo.canonical_json_text(jsonb), emdo.canonical_json_hash(jsonb) to emdo_approval_resume_executor;',
    ]);
    expect(sharedHelperGrants.join(' ')).not.toMatch(
      /\bto emdo_app(?:[;,]|\s*$)/u,
    );
    expect(sharedHelperGrants.join(' ')).not.toContain(
      'emdo_manager_turn_executor',
    );
  });

  it('keeps preserved approval-resume bodies private except to their fixed wrapper owner', async () => {
    const sql = await readMigration();
    const legacyResumeGrants = executeGrantStatements(sql).filter(
      (statement) =>
        statement.includes('claim_approval_resume_job_legacy_v5') ||
        statement.includes('settle_approval_resume_job_legacy_v5'),
    );

    expect(legacyResumeGrants).toEqual([
      'grant execute on function emdo.claim_approval_resume_job_legacy_v5(uuid, uuid, uuid), emdo.settle_approval_resume_job_legacy_v5( uuid, text, text, text, jsonb ) to emdo_approval_resume_executor;',
    ]);
    expect(sql).toMatch(
      /revoke all on function[\s\S]+claim_approval_resume_job_legacy_v5\(uuid, uuid, uuid\),[\s\S]+settle_approval_resume_job_legacy_v5\([\s\S]+\)[\s\S]+from public, emdo_app,[\s\S]+emdo_workflow_login,[\s\S]+emdo_approval_resume_executor,[\s\S]+emdo_manager_turn_executor;/u,
    );
  });

  it('gives the disclosure executor an owner-scoped manager-turn share lock only', async () => {
    const sql = await readMigration();
    const accessControl = sql.slice(
      sql.indexOf('grant select, update (run_id) on emdo.manager_turns'),
      sql.indexOf('revoke all on function\n\temdo.claim_manager_turn'),
    );

    expect(accessControl).toContain(
      'grant select, update (run_id) on emdo.manager_turns\n\tto emdo_disclosure_executor;',
    );
    expect(accessControl).toContain(
      'create policy disclosure_manager_turns_executor_select',
    );
    expect(accessControl).toContain(
      'create policy disclosure_manager_turns_executor_lock',
    );
    expect(accessControl).toContain(
      'using (user_id = (select emdo.current_user_id()))',
    );
    expect(accessControl).toContain(
      'with check (user_id = (select emdo.current_user_id()))',
    );
    expect(accessControl).not.toContain('using (true)');
    expect(accessControl).not.toContain('grant select, insert');
  });

  it('qualifies the disclosure consumption mutation against output-column ambiguity', async () => {
    const sql = await readMigration();
    const commit = functionBody(sql, 'commit_model_disclosure_authorization');
    const denial = functionBody(sql, 'record_model_disclosure_denial');

    expect(commit).toContain(
      'update emdo.disclosure_grants as disclosure_grant',
    );
    expect(commit).toContain('where disclosure_grant.id = v_grant.id');
    expect(commit).toContain('disclosure_grant.consumed_at is null');
    expect(commit).toContain('disclosure_grant.revoked_at is null');
    expect(commit).toContain('disclosure_grant.expires_at > v_now');
    expect(commit).not.toContain('where id = v_grant.id');
    expect(denial).not.toContain('update emdo.disclosure_grants');
  });

  it('uses a separate, read-only consumed-grant resolver for proposal materialization', async () => {
    const sql = await readMigration();
    const modelResolve = functionBody(sql, 'resolve_model_disclosure_grant');
    const proposalResolve = functionBody(
      sql,
      'resolve_consumed_disclosure_grant_for_proposal',
    );
    const proposalGrants = executeGrantStatements(sql).filter((statement) =>
      statement.includes('resolve_consumed_disclosure_grant_for_proposal'),
    );

    expect(modelResolve).toContain('v_grant.consumed_at is not null');
    expect(proposalResolve).toContain('security definer');
    expect(proposalResolve).toContain('set search_path = pg_catalog, emdo');
    expect(proposalResolve).toContain('set row_security = on');
    expect(proposalResolve).toContain(
      "p_phase_purpose is distinct from 'specialist-execution'",
    );
    expect(proposalResolve).toContain(
      "p_agent_id not in ('scheduler', 'finance')",
    );
    expect(proposalResolve).toContain('p_invocation_context jsonb');
    expect(proposalResolve).toContain('p_invocation_context_hash text');
    expect(proposalResolve).toContain('v_grant.consumed_at is null');
    expect(proposalResolve).toContain('v_grant.revoked_at is not null');
    expect(proposalResolve).toContain(
      'registered_disclosure_allowlist_is_canonical',
    );
    expect(proposalResolve).toContain(
      'registered_agent_invocation_context_matches',
    );
    expect(proposalResolve).toContain('registered_disclosure_run_is_current');
    expect(proposalResolve).toContain('rootmanagerinvocationid');
    expect(proposalResolve).toContain(
      "audit.event_type = 'model.disclosure.sent'",
    );
    expect(proposalResolve).toContain("v_status := 'consumed'");
    expect(proposalResolve).not.toContain('update emdo.disclosure_grants');
    expect(proposalResolve).not.toContain('insert into emdo.audit_events');
    expect(sql).toContain(
      'alter function emdo.resolve_consumed_disclosure_grant_for_proposal(\n\tuuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, text\n) owner to emdo_disclosure_executor;',
    );
    expect(sql).toContain('create policy disclosure_sent_audit_executor_read');
    expect(sql).toContain("event_type = 'model.disclosure.sent'");
    expect(proposalGrants).toHaveLength(1);
    expect(proposalGrants[0]).toContain(
      'emdo.resolve_consumed_disclosure_grant_for_proposal( uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, text )',
    );
    expect(proposalGrants[0]).toContain('to emdo_app;');
    expect(sql).toMatch(
      /revoke all on function\s+emdo\.issue_model_disclosure_grant[\s\S]+?emdo\.resolve_consumed_disclosure_grant_for_proposal[\s\S]+?from public, emdo_app,/u,
    );
  });

  it('uses a non-keyword disclosure-grant alias in lock validators', async () => {
    const sql = await readMigration();

    expect(
      sql.match(/from emdo\.disclosure_grants as disclosure_grant/g),
    ).toHaveLength(3);
    expect(sql).not.toMatch(/from emdo\.disclosure_grants as grant\b/);
  });
});
