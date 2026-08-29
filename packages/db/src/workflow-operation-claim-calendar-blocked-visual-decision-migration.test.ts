import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const originalIssuerMigrationUrl = new URL(
  '../drizzle/0003_durable_runtime_repositories.sql',
  import.meta.url,
);
const originalDisclosureMigrationUrl = new URL(
  '../drizzle/0020_manager_specialist_disclosure.sql',
  import.meta.url,
);
const originalApprovalResumeMigrationUrl = new URL(
  '../drizzle/0017_approval_resume_public_events.sql',
  import.meta.url,
);
const migrationUrl = new URL(
  '../drizzle/0021_blocked_visual_decision_claim.sql',
  import.meta.url,
);

const issuerPattern =
  /CREATE OR REPLACE FUNCTION "emdo"\."issue_workflow_operation_claim"\([\s\S]+?\$function\$;/u;
const calendarIssuerPattern =
  /CREATE OR REPLACE FUNCTION "emdo"\."issue_workflow_operation_claim_calendar"\([\s\S]+?\$function\$;/u;
const disclosureIssuerPattern =
  /CREATE OR REPLACE FUNCTION "emdo"\."issue_model_disclosure_grant"\([\s\S]+?\$function\$;/u;
const disclosureResolverPattern =
  /CREATE OR REPLACE FUNCTION "emdo"\."resolve_model_disclosure_grant"\([\s\S]+?\$function\$;/u;
const disclosureCommitPattern =
  /CREATE OR REPLACE FUNCTION "emdo"\."commit_model_disclosure_authorization"\([\s\S]+?\$function\$;/u;
const disclosureAclPattern =
  /ALTER FUNCTION "emdo"\."issue_model_disclosure_grant"\(uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb\)\n\tOWNER TO emdo_disclosure_executor;[\s\S]+?\n\tTO emdo_app;/u;
const disclosureResumePolicyPattern =
  /CREATE POLICY disclosure_approval_resume_jobs_select[\s\S]+?\n\t\);/u;
const approvalResumeSettlementPattern =
  /CREATE OR REPLACE FUNCTION "emdo"\."settle_approval_resume_job"\([\s\S]+?\$function\$;/u;
const approvalResumeSettlementAclPattern =
  /ALTER FUNCTION "emdo"\."settle_approval_resume_job"\(\n\tuuid, text, text, text, jsonb\n\) OWNER TO emdo_approval_resume_executor;[\s\S]+?\n\tTO emdo_app;/u;
const approvalResumeRunSelectPolicyPattern =
  /CREATE POLICY approval_resume_agent_runs_executor_select[\s\S]+?\n\t\);/u;
const approvalResumeRunUpdatePolicyPattern =
  /CREATE POLICY approval_resume_agent_runs_executor_update[\s\S]+?\n\t\);/u;
const legacyApprovalResumeRunProjectionPattern =
  /WITH canonical_legacy_terminal_resume_events AS \([\s\S]+?\n\tAND run\.completed_at IS NULL;/u;

const extract = (sql: string, pattern: RegExp): string => {
  const match = sql.match(pattern);
  expect(match).not.toBeNull();
  return match?.[0] ?? '';
};

const disclosureLifecyclePredicate = (indent: string): string => {
  const level1 = `${indent}\t`;
  const level2 = `${level1}\t`;
  const level3 = `${level2}\t`;
  const level4 = `${level3}\t`;
  const level5 = `${level4}\t`;
  const level6 = `${level5}\t`;
  const level7 = `${level6}\t`;
  return [
    `${indent}AND (`,
    `${level1}(`,
    `${level2}v_grant.phase_purpose IN (`,
    `${level3}'manager-plan', 'specialist-execution',`,
    `${level3}'manager-synthesis'`,
    `${level2})`,
    `${level2}AND run.status IN ('queued', 'running')`,
    `${level1})`,
    `${level1}OR (`,
    `${level2}v_grant.phase_purpose IN (`,
    `${level3}'specialist-execution', 'manager-synthesis'`,
    `${level2})`,
    `${level2}AND run.status = 'blocked'`,
    `${level2}AND EXISTS (`,
    `${level3}SELECT 1`,
    `${level3}FROM emdo.approval_resume_jobs AS resume`,
    `${level3}WHERE resume.run_id = v_grant.run_id`,
    `${level3}\tAND resume.household_id = v_grant.household_id`,
    `${level3}\tAND resume.space_id = v_grant.space_id`,
    `${level3}\tAND resume.user_id = v_grant.user_id`,
    `${level3}\tAND resume.user_id = run.original_owner_user_id`,
    `${level3}\tAND resume.state = 'claimed'`,
    `${level3}\tAND resume.decision_id IS NOT NULL`,
    `${level3}\tAND (`,
    `${level5}resume.decision_type = 'approved'`,
    `${level5}OR (`,
    `${level6}resume.decision_type = 'rejected'`,
    `${level6}AND v_grant.phase_purpose =`,
    `${level7}'manager-synthesis'`,
    `${level5})`,
    `${level3}\t)`,
    `${level3}\tAND resume.authenticated_session_id =`,
    `${level3}\t\temdo.current_session_id()`,
    `${level3}\tAND resume.resume_request_id =`,
    `${level3}\t\temdo.current_request_id()`,
    `${level3}\tAND resume.resume_space_access_grant_id =`,
    `${level3}\t\tp_space_access_grant_id`,
    `${level3}\tAND resume.approval_event_sequence IS NOT NULL`,
    `${level3}\tAND resume.claim_id IS NOT NULL`,
    `${level3}\tAND resume.ownership_token_digest ~ '^[a-f0-9]{64}$'`,
    `${level3}\tAND resume.collection_authorization_scope_fingerprint ~`,
    `${level3}\t\t'^[a-f0-9]{64}$'`,
    `${level3}\tAND resume.claimed_at IS NOT NULL`,
    `${level3}\tAND resume.claim_expires_at > pg_catalog.clock_timestamp()`,
    `${level3}\tAND resume.terminal_event_sequence IS NULL`,
    `${level3}\tAND resume.terminal_reason_code IS NULL`,
    `${level3}\tAND resume.terminal_result_hash IS NULL`,
    `${level3}\tAND resume.expires_at > pg_catalog.clock_timestamp()`,
    `${level2})`,
    `${level1})`,
    `${indent})`,
  ].join('\n');
};

describe('blocked visual-decision workflow claim migration', () => {
  it('redefines only the renamed calendar issuer and its visual-decision run predicate', async () => {
    const [originalSql, migrationSql] = await Promise.all([
      readFile(originalIssuerMigrationUrl, 'utf8'),
      readFile(migrationUrl, 'utf8'),
    ]);
    const originalIssuer = extract(originalSql, issuerPattern);
    const calendarIssuer = extract(migrationSql, calendarIssuerPattern);
    const expectedRunPredicate = [
      '\t\tAND (',
      "\t\t\trun.status IN ('queued', 'running')",
      '\t\t\tOR (',
      "\t\t\t\tv_phase = 'visual-decision'",
      "\t\t\t\tAND run.status = 'blocked'",
      '\t\t\t\tAND EXISTS (',
      '\t\t\t\t\tSELECT 1',
      '\t\t\t\t\tFROM emdo.approval_resume_jobs AS resume',
      '\t\t\t\t\tWHERE resume.run_id = v_run_id',
      '\t\t\t\t\t\tAND resume.proposal_id = v_proposal_id',
      '\t\t\t\t\t\tAND resume.household_id = v_household_id',
      '\t\t\t\t\t\tAND resume.space_id = run.space_id',
      '\t\t\t\t\t\tAND resume.user_id = v_user_id',
      '\t\t\t\t\t\tAND resume.user_id = run.original_owner_user_id',
      "\t\t\t\t\t\tAND resume.state = 'awaiting-decision'",
      '\t\t\t\t\t\tAND resume.decision_id IS NULL',
      '\t\t\t\t\t\tAND resume.decision_type IS NULL',
      '\t\t\t\t\t\tAND resume.claim_id IS NULL',
      '\t\t\t\t\t\tAND resume.ownership_token_digest IS NULL',
      '\t\t\t\t\t\tAND resume.terminal_event_sequence IS NULL',
      '\t\t\t\t\t\tAND resume.expires_at > pg_catalog.clock_timestamp()',
      '\t\t\t\t)',
      '\t\t\t)',
      '\t\t\tOR (',
      "\t\t\t\tv_phase IN ('provider-write-prepare', 'provider-write-dispatch')",
      "\t\t\t\tAND run.status = 'blocked'",
      '\t\t\t\tAND EXISTS (',
      '\t\t\t\t\tSELECT 1',
      '\t\t\t\t\tFROM emdo.approval_resume_jobs AS resume',
      '\t\t\t\t\tWHERE resume.run_id = v_run_id',
      '\t\t\t\t\t\tAND resume.proposal_id = v_proposal_id',
      '\t\t\t\t\t\tAND resume.household_id = v_household_id',
      '\t\t\t\t\t\tAND resume.space_id = run.space_id',
      '\t\t\t\t\t\tAND resume.user_id = v_user_id',
      '\t\t\t\t\t\tAND resume.user_id = run.original_owner_user_id',
      "\t\t\t\t\t\tAND resume.state = 'claimed'",
      '\t\t\t\t\t\tAND resume.decision_id = p_decision_id',
      "\t\t\t\t\t\tAND resume.decision_type = 'approved'",
      '\t\t\t\t\t\tAND resume.authenticated_session_id = v_session_id',
      '\t\t\t\t\t\tAND resume.resume_request_id = v_request_id',
      '\t\t\t\t\t\tAND resume.resume_space_access_grant_id =',
      '\t\t\t\t\t\t\tv_space_access_grant_id',
      '\t\t\t\t\t\tAND resume.authorization_scope_fingerprint =',
      '\t\t\t\t\t\t\tv_expected_authorization_scope_fingerprint',
      '\t\t\t\t\t\tAND resume.disclosure_grant_id = v_disclosure_grant_id',
      '\t\t\t\t\t\tAND resume.disclosure_grant_version =',
      '\t\t\t\t\t\t\tv_disclosure_grant_version',
      '\t\t\t\t\t\tAND resume.approval_event_sequence IS NOT NULL',
      '\t\t\t\t\t\tAND resume.claim_id IS NOT NULL',
      "\t\t\t\t\t\tAND resume.ownership_token_digest ~ '^[a-f0-9]{64}$'",
      '\t\t\t\t\t\tAND resume.collection_authorization_scope_fingerprint ~',
      "\t\t\t\t\t\t\t'^[a-f0-9]{64}$'",
      '\t\t\t\t\t\tAND resume.claimed_at IS NOT NULL',
      '\t\t\t\t\t\tAND resume.claim_expires_at > pg_catalog.clock_timestamp()',
      '\t\t\t\t\t\tAND resume.terminal_event_sequence IS NULL',
      '\t\t\t\t\t\tAND resume.terminal_reason_code IS NULL',
      '\t\t\t\t\t\tAND resume.terminal_result_hash IS NULL',
      '\t\t\t\t\t\tAND resume.expires_at > pg_catalog.clock_timestamp()',
      '\t\t\t\t)',
      '\t\t\t)',
      '\t\t)',
    ].join('\n');
    const expectedIssuer = originalIssuer
      .replace(
        '"emdo"."issue_workflow_operation_claim"',
        '"emdo"."issue_workflow_operation_claim_calendar"',
      )
      .replace(
        "\t\tAND run.status IN ('queued', 'running')",
        () => expectedRunPredicate,
      );

    expect(calendarIssuer).toBe(expectedIssuer);
  });

  it('allows blocked runs only for exact approval-resume phases and retains the issuer security boundary', async () => {
    const migrationSql = await readFile(migrationUrl, 'utf8');
    const calendarIssuer = extract(migrationSql, calendarIssuerPattern);

    expect(calendarIssuer).toContain('SECURITY DEFINER');
    expect(calendarIssuer).toContain('SET search_path = pg_catalog, emdo');
    expect(calendarIssuer).toContain('SET row_security = on');
    expect(calendarIssuer).toMatch(
      /v_phase = 'visual-decision'\s*AND run\.status = 'blocked'\s*AND EXISTS \(\s*SELECT 1\s*FROM emdo\.approval_resume_jobs AS resume/u,
    );
    for (const predicate of [
      'resume.run_id = v_run_id',
      'resume.proposal_id = v_proposal_id',
      'resume.household_id = v_household_id',
      'resume.space_id = run.space_id',
      'resume.user_id = v_user_id',
      'resume.user_id = run.original_owner_user_id',
      "resume.state = 'awaiting-decision'",
      'resume.decision_id IS NULL',
      'resume.decision_type IS NULL',
      'resume.claim_id IS NULL',
      'resume.ownership_token_digest IS NULL',
      'resume.terminal_event_sequence IS NULL',
      'resume.expires_at > pg_catalog.clock_timestamp()',
    ]) {
      expect(calendarIssuer).toContain(predicate);
    }
    expect(calendarIssuer).toContain('run.original_owner_user_id = v_user_id');
    expect(calendarIssuer).not.toMatch(/run\.status IN \([^)]*'blocked'/u);
    expect(calendarIssuer.match(/run\.status = 'blocked'/gu)).toHaveLength(2);
    expect(calendarIssuer).toMatch(
      /v_phase IN \('provider-write-prepare', 'provider-write-dispatch'\)\s*AND run\.status = 'blocked'\s*AND EXISTS \(\s*SELECT 1\s*FROM emdo\.approval_resume_jobs AS resume/u,
    );
    for (const predicate of [
      "resume.state = 'claimed'",
      'resume.decision_id = p_decision_id',
      "resume.decision_type = 'approved'",
      'resume.authenticated_session_id = v_session_id',
      'resume.resume_request_id = v_request_id',
      'resume.resume_space_access_grant_id =',
      'v_space_access_grant_id',
      'resume.authorization_scope_fingerprint =',
      'v_expected_authorization_scope_fingerprint',
      'resume.disclosure_grant_id = v_disclosure_grant_id',
      'resume.disclosure_grant_version =',
      'v_disclosure_grant_version',
      'resume.approval_event_sequence IS NOT NULL',
      'resume.claim_id IS NOT NULL',
      "resume.ownership_token_digest ~ '^[a-f0-9]{64}$'",
      'resume.collection_authorization_scope_fingerprint ~',
      'resume.claimed_at IS NOT NULL',
      'resume.claim_expires_at > pg_catalog.clock_timestamp()',
      'resume.terminal_reason_code IS NULL',
      'resume.terminal_result_hash IS NULL',
    ]) {
      expect(calendarIssuer).toContain(predicate);
    }
    expect(migrationSql).toContain(
      'ALTER FUNCTION "emdo"."issue_workflow_operation_claim_calendar"(text, jsonb, uuid, uuid, text, text, text, jsonb) OWNER TO emdo_workflow_executor;',
    );
    expect(migrationSql).toContain(
      'REVOKE ALL ON FUNCTION "emdo"."issue_workflow_operation_claim_calendar"(text, jsonb, uuid, uuid, text, text, text, jsonb) FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,',
    );
    expect(migrationSql).toContain(
      'GRANT EXECUTE ON FUNCTION "emdo"."issue_workflow_operation_claim_calendar"(text, jsonb, uuid, uuid, text, text, text, jsonb) TO emdo_workflow_executor;',
    );
  });

  it('redefines the model disclosure issuer only for a live claimed approval resume', async () => {
    const [originalDisclosureSql, migrationSql] = await Promise.all([
      readFile(originalDisclosureMigrationUrl, 'utf8'),
      readFile(migrationUrl, 'utf8'),
    ]);
    const originalIssuer = extract(
      originalDisclosureSql,
      disclosureIssuerPattern,
    );
    const disclosureIssuer = extract(migrationSql, disclosureIssuerPattern);
    const originalRunPredicate = "\t\tAND run.status IN ('queued', 'running')";
    const expectedRunPredicate = [
      '\t\tAND (',
      "\t\t\trun.status IN ('queued', 'running')",
      '\t\t\tOR (',
      "\t\t\t\trun.status = 'blocked'",
      '\t\t\t\tAND p_phase_purpose IN (',
      "\t\t\t\t\t'specialist-execution', 'manager-synthesis'",
      '\t\t\t\t)',
      '\t\t\t\tAND EXISTS (',
      '\t\t\t\t\tSELECT 1',
      '\t\t\t\t\tFROM emdo.approval_resume_jobs AS resume',
      '\t\t\t\t\tWHERE resume.run_id = p_run_id',
      '\t\t\t\t\t\tAND resume.household_id = p_household_id',
      '\t\t\t\t\t\tAND resume.space_id = p_space_id',
      '\t\t\t\t\t\tAND resume.user_id = p_user_id',
      "\t\t\t\t\t\tAND resume.state = 'claimed'",
      '\t\t\t\t\t\tAND resume.decision_id IS NOT NULL',
      '\t\t\t\t\t\tAND (',
      "\t\t\t\t\t\t\tresume.decision_type = 'approved'",
      '\t\t\t\t\t\t\tOR (',
      "\t\t\t\t\t\t\t\tresume.decision_type = 'rejected'",
      "\t\t\t\t\t\t\t\tAND p_phase_purpose = 'manager-synthesis'",
      '\t\t\t\t\t\t\t)',
      '\t\t\t\t\t\t)',
      '\t\t\t\t\t\tAND resume.authenticated_session_id = v_session_id',
      '\t\t\t\t\t\tAND resume.resume_request_id = v_request_id',
      '\t\t\t\t\t\tAND resume.resume_space_access_grant_id =',
      '\t\t\t\t\t\t\tp_space_access_grant_id',
      '\t\t\t\t\t\tAND resume.approval_event_sequence IS NOT NULL',
      '\t\t\t\t\t\tAND resume.claim_id IS NOT NULL',
      "\t\t\t\t\t\tAND resume.ownership_token_digest ~ '^[a-f0-9]{64}$'",
      '\t\t\t\t\t\tAND resume.collection_authorization_scope_fingerprint ~',
      "\t\t\t\t\t\t\t'^[a-f0-9]{64}$'",
      '\t\t\t\t\t\tAND resume.claimed_at IS NOT NULL',
      '\t\t\t\t\t\tAND resume.claim_expires_at > pg_catalog.clock_timestamp()',
      '\t\t\t\t\t\tAND resume.terminal_event_sequence IS NULL',
      '\t\t\t\t\t\tAND resume.terminal_reason_code IS NULL',
      '\t\t\t\t\t\tAND resume.terminal_result_hash IS NULL',
      '\t\t\t\t\t\tAND resume.expires_at > pg_catalog.clock_timestamp()',
      '\t\t\t\t)',
      '\t\t\t)',
      '\t\t)',
    ].join('\n');
    const expectedIssuer = originalIssuer.replace(
      originalRunPredicate,
      () => expectedRunPredicate,
    );

    expect(originalIssuer).toContain(originalRunPredicate);
    expect(disclosureIssuer).toBe(expectedIssuer);
    expect(disclosureIssuer.match(/run\.status = 'blocked'/gu)).toHaveLength(1);
    expect(disclosureIssuer).not.toMatch(/run\.status IN \([^)]*'blocked'/u);
    expect(disclosureIssuer).toContain(
      "\t\t\t\t\t'specialist-execution', 'manager-synthesis'",
    );
    expect(disclosureIssuer).toContain(
      "resume.decision_type = 'approved'\n\t\t\t\t\t\t\tOR (",
    );
    expect(disclosureIssuer).toContain(
      "resume.decision_type = 'rejected'\n\t\t\t\t\t\t\t\tAND p_phase_purpose = 'manager-synthesis'",
    );
    expect(disclosureIssuer).not.toMatch(
      /run\.status = 'blocked'\s*AND p_phase_purpose[^\n]*'manager-plan'/u,
    );
    expect(disclosureIssuer).toContain(
      "run.agent_id = 'manager'\n\t\t\t\tAND p_agent_id IN ('scheduler', 'finance')\n\t\t\t\tAND p_phase_purpose = 'specialist-execution'",
    );
    expect(extract(migrationSql, disclosureAclPattern)).toBe(
      extract(originalDisclosureSql, disclosureAclPattern),
    );
  });

  it('grants disclosure execution access only to a live claimed resume row', async () => {
    const migrationSql = await readFile(migrationUrl, 'utf8');
    const expectedPolicy = [
      'CREATE POLICY disclosure_approval_resume_jobs_select',
      '\tON "emdo"."approval_resume_jobs"',
      '\tFOR SELECT TO emdo_disclosure_executor',
      '\tUSING (',
      '\t\tuser_id = emdo.current_user_id()',
      '\t\tAND authenticated_session_id = emdo.current_session_id()',
      '\t\tAND resume_request_id = emdo.current_request_id()',
      "\t\tAND state = 'claimed'",
      '\t\tAND decision_id IS NOT NULL',
      "\t\tAND decision_type IN ('approved', 'rejected')",
      '\t\tAND resume_space_access_grant_id IS NOT NULL',
      '\t\tAND approval_event_sequence IS NOT NULL',
      '\t\tAND claim_id IS NOT NULL',
      '\t\tAND ownership_token_digest IS NOT NULL',
      "\t\tAND ownership_token_digest ~ '^[a-f0-9]{64}$'",
      '\t\tAND collection_authorization_scope_fingerprint IS NOT NULL',
      "\t\tAND collection_authorization_scope_fingerprint ~ '^[a-f0-9]{64}$'",
      '\t\tAND claimed_at IS NOT NULL',
      '\t\tAND claim_expires_at > pg_catalog.clock_timestamp()',
      '\t\tAND terminal_event_sequence IS NULL',
      '\t\tAND terminal_reason_code IS NULL',
      '\t\tAND terminal_result_hash IS NULL',
      '\t\tAND expires_at > pg_catalog.clock_timestamp()',
      '\t);',
    ].join('\n');

    expect(migrationSql).toContain(
      'GRANT SELECT ON TABLE "emdo"."approval_resume_jobs"\n\tTO emdo_disclosure_executor;',
    );
    expect(extract(migrationSql, disclosureResumePolicyPattern)).toBe(
      expectedPolicy,
    );
  });

  it('requires the exact live lifecycle at resolution and final disclosure commit', async () => {
    const [originalSql, migrationSql] = await Promise.all([
      readFile(originalIssuerMigrationUrl, 'utf8'),
      readFile(migrationUrl, 'utf8'),
    ]);
    const disclosureResolver = extract(migrationSql, disclosureResolverPattern);
    const disclosureCommit = extract(migrationSql, disclosureCommitPattern);
    const originalCommit = extract(originalSql, disclosureCommitPattern);
    const resolverLifecycle = disclosureLifecyclePredicate('\t\t\t\t\t');
    const commitLifecycle = disclosureLifecyclePredicate('\t\t');
    const commitLifecycleGuard = [
      '\tPERFORM 1',
      '\tFROM emdo.agent_runs AS run',
      '\tWHERE run.id = v_grant.run_id',
      '\t\tAND run.household_id = v_grant.household_id',
      '\t\tAND run.space_id = v_grant.space_id',
      '\t\tAND run.original_owner_user_id = v_grant.user_id',
      '\t\tAND (',
      '\t\t\trun.agent_id = v_grant.agent_id',
      '\t\t\tOR (',
      "\t\t\t\trun.agent_id = 'manager'",
      "\t\t\t\tAND v_grant.phase_purpose = 'specialist-execution'",
      "\t\t\t\tAND v_grant.agent_id IN ('scheduler', 'finance')",
      '\t\t\t)',
      '\t\t)',
      commitLifecycle,
      '\tFOR SHARE OF run;',
      '\tIF NOT FOUND THEN',
      '\t\tRETURN;',
      '\tEND IF;',
    ].join('\n');
    const expectedCommit = originalCommit.replace(
      '\tUPDATE emdo.disclosure_grants\n\tSET consumed_at = COALESCE(consumed_at, v_now)',
      () =>
        `${commitLifecycleGuard}\n\tUPDATE emdo.disclosure_grants\n\tSET consumed_at = COALESCE(consumed_at, v_now)`,
    );

    expect(disclosureResolver).toContain(resolverLifecycle);
    expect(disclosureCommit).toBe(expectedCommit);
    expect(disclosureCommit.indexOf(commitLifecycleGuard)).toBeLessThan(
      disclosureCommit.indexOf('UPDATE emdo.disclosure_grants'),
    );
    expect(
      migrationSql
        .split('--> statement-breakpoint')
        .filter(
          (statement) =>
            statement.includes('commit_model_disclosure_authorization') &&
            !statement.includes(
              'CREATE OR REPLACE FUNCTION "emdo"."commit_model_disclosure_authorization"',
            ),
        ),
    ).toEqual([]);
    for (const functionSql of [disclosureResolver, disclosureCommit]) {
      expect(functionSql).toContain('SECURITY DEFINER');
      expect(functionSql).toContain('SET search_path = pg_catalog, emdo');
      expect(functionSql).toContain('SET row_security = on');
      expect(functionSql).toContain('v_grant.phase_purpose IN (\n');
      expect(functionSql).toContain("'manager-plan', 'specialist-execution',");
      expect(functionSql).toContain(
        "'specialist-execution', 'manager-synthesis'",
      );
      expect(functionSql).toContain("run.status = 'blocked'");
      expect(functionSql).toContain("resume.decision_type = 'approved'");
      expect(functionSql).toContain("resume.decision_type = 'rejected'");
      expect(functionSql).toMatch(
        /resume\.decision_type = 'rejected'\s*AND v_grant\.phase_purpose =\s*'manager-synthesis'/u,
      );
      expect(functionSql).not.toContain(
        "resume.decision_type IN ('approved', 'rejected')",
      );
      expect(functionSql).toContain(
        'resume.claim_expires_at > pg_catalog.clock_timestamp()',
      );
      expect(functionSql).toContain(
        'resume.expires_at > pg_catalog.clock_timestamp()',
      );
      expect(functionSql).toContain('resume.terminal_event_sequence IS NULL');
      expect(functionSql).toContain('resume.terminal_reason_code IS NULL');
      expect(functionSql).toContain('resume.terminal_result_hash IS NULL');
      expect(functionSql).not.toContain(
        "v_grant.phase_purpose <> 'manager-synthesis'",
      );
      expect(functionSql).not.toMatch(
        /run\.status IN \('queued', 'running', 'blocked'\)/u,
      );
    }
  });

  it('projects an approval-resume terminal result onto its exact blocked manager run', async () => {
    const [originalSql, migrationSql] = await Promise.all([
      readFile(originalApprovalResumeMigrationUrl, 'utf8'),
      readFile(migrationUrl, 'utf8'),
    ]);
    const originalSettlement = extract(
      originalSql,
      approvalResumeSettlementPattern,
    );
    const settlement = extract(migrationSql, approvalResumeSettlementPattern);
    const runLock = [
      '\tSELECT run.* INTO v_run',
      '\tFROM emdo.agent_runs AS run',
      '\tWHERE run.id = v_job.run_id',
      '\t\tAND run.household_id = v_job.household_id',
      '\t\tAND run.space_id = v_job.space_id',
      '\t\tAND run.original_owner_user_id = v_job.user_id',
      "\t\tAND run.agent_id = 'manager'",
      "\t\tAND run.status = 'blocked'",
      '\t\tAND run.completed_at IS NULL',
      '\tFOR UPDATE OF run;',
      '\tIF NOT FOUND THEN',
      '\t\tRAISE EXCEPTION USING',
      "\t\t\tERRCODE = 'P0001',",
      "\t\t\tMESSAGE = 'approval resume run lock failed';",
      '\tEND IF;',
    ].join('\n');
    const runProjection = [
      '\tUPDATE emdo.agent_runs AS run',
      '\tSET status = CASE',
      "\t\t\tWHEN v_event_payload ->> 'status' = 'completed'",
      "\t\t\t\tTHEN 'completed'",
      "\t\t\tELSE 'failed'",
      '\t\tEND,',
      "\t\tresolved_model = CASE WHEN p_mode = 'complete'",
      "\t\t\tTHEN v_event_payload #>> '{modelResolution,resolvedModel}'",
      '\t\t\tELSE v_run.resolved_model END,',
      "\t\tmodel_reason = CASE WHEN p_mode = 'complete' THEN COALESCE(",
      "\t\t\tv_event_payload #>> '{modelResolution,reason}',",
      "\t\t\tv_event_payload #>> '{executionResolution,reason}'",
      '\t\t) ELSE v_run.model_reason END,',
      '\t\tlocal_trace_reference =',
      "\t\t\tv_event_payload ->> 'localTraceReference',",
      "\t\tsafe_error = v_event_payload -> 'safeError',",
      "\t\tusage = CASE WHEN p_mode = 'complete'",
      "\t\t\tTHEN v_event_payload -> 'usage' ELSE v_run.usage END,",
      '\t\tcompleted_at = v_now',
      '\tWHERE run.id = v_job.run_id',
      '\t\tAND run.household_id = v_job.household_id',
      '\t\tAND run.space_id = v_job.space_id',
      '\t\tAND run.original_owner_user_id = v_job.user_id',
      "\t\tAND run.agent_id = 'manager'",
      "\t\tAND run.status = 'blocked'",
      '\t\tAND run.completed_at IS NULL;',
      '\tIF NOT FOUND THEN',
      '\t\tRAISE EXCEPTION USING',
      "\t\t\tERRCODE = 'P0001',",
      "\t\t\tMESSAGE = 'approval resume run CAS failed';",
      '\tEND IF;',
    ].join('\n');
    const checkpointUpdate = [
      '\tUPDATE emdo.approval_checkpoints AS checkpoint',
      "\tSET state = 'cancelled', revision = checkpoint.revision + 1,",
      '\t\tupdated_at = v_now',
      '\tWHERE checkpoint.checkpoint_id = v_job.checkpoint_id',
      "\t\tAND checkpoint.state = 'pending';",
    ].join('\n');
    const terminalJobUpdate = [
      '\tUPDATE emdo.approval_resume_jobs AS resume',
      '\tSET state = v_terminal_state, revision = resume.revision + 1,',
      '\t\tterminal_event_sequence = v_terminal_sequence,',
      '\t\tterminal_reason_code = p_reason_code,',
      '\t\tterminal_result_hash = v_terminal_result_hash,',
      '\t\tupdated_at = v_now',
      '\tWHERE resume.job_id = v_job.job_id',
      '\t\tAND resume.revision = v_job.revision',
      "\t\tAND resume.state = 'claimed'",
      '\t\tAND resume.claim_id = p_claim_id',
      '\t\tAND resume.ownership_token_digest = v_ownership_token_digest;',
    ].join('\n');
    const expectedSettlement = originalSettlement
      .replace(
        '\tv_job emdo.approval_resume_jobs%ROWTYPE;',
        '\tv_job emdo.approval_resume_jobs%ROWTYPE;\n\tv_run emdo.agent_runs%ROWTYPE;',
      )
      .replace(
        [
          '\tPERFORM pg_catalog.pg_advisory_xact_lock(',
          '\t\tpg_catalog.hashtextextended(v_job.run_id::text, 0)',
          '\t);',
          '\tSELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1',
        ].join('\n'),
        [
          '\tPERFORM pg_catalog.pg_advisory_xact_lock(',
          '\t\tpg_catalog.hashtextextended(v_job.run_id::text, 0)',
          '\t);',
          runLock,
          '\tSELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1',
        ].join('\n'),
      )
      .replace(terminalJobUpdate, `${runProjection}\n${terminalJobUpdate}`);

    expect(settlement).toBe(expectedSettlement);
    expect(settlement.indexOf(runProjection)).toBeLessThan(
      settlement.indexOf(terminalJobUpdate),
    );
    expect(settlement.indexOf(checkpointUpdate)).toBeGreaterThan(
      settlement.indexOf(terminalJobUpdate),
    );
    expect(settlement).not.toContain(
      'v_job.claim_expires_at <= pg_catalog.clock_timestamp()',
    );
    expect(settlement).not.toContain(
      'v_job.expires_at <= pg_catalog.clock_timestamp()',
    );
    expect(extract(migrationSql, approvalResumeSettlementAclPattern)).toBe(
      extract(originalSql, approvalResumeSettlementAclPattern),
    );
  });

  it('backfills only exact canonical legacy terminal resume projections', async () => {
    const migrationSql = await readFile(migrationUrl, 'utf8');
    const projection = extract(
      migrationSql,
      legacyApprovalResumeRunProjectionPattern,
    );

    for (const predicate of [
      "resume.state IN ('terminal', 'indeterminate')",
      'canonical_legacy_terminal_resume_events',
      'legacy_terminal_resume_projection',
      'event.run_id = resume.run_id',
      'event.sequence = resume.terminal_event_sequence',
      'event.household_id = resume.household_id',
      'event.space_id = resume.space_id',
      'event.original_owner_user_id = resume.user_id',
      "pg_catalog.jsonb_typeof(event.payload) = 'object'",
      "event.payload ->> 'runId' = resume.run_id::text",
      "event.event_type = 'run.completed'",
      "event.payload ->> 'status' = 'completed'",
      "event.event_type = 'run.failed'",
      "event.payload ->> 'status' IN (\n\t\t\t\t\t\t\t'failed', 'needs-approval'\n\t\t\t\t\t\t)",
      "resume.terminal_reason_code = 'approval-resume-failed'",
      "run.agent_id = 'manager'",
      "run.status = 'blocked'",
      'run.completed_at IS NULL',
      'GROUP BY run_id, household_id, space_id, user_id',
      'HAVING pg_catalog.count(*) = 1',
      'pg_catalog.count(DISTINCT status) = 1',
      'pg_catalog.count(DISTINCT occurred_at) = 1',
    ]) {
      expect(projection).toContain(predicate);
    }
    expect(projection).toContain("WHEN 'run.completed' THEN 'completed'");
    expect(projection).toContain("WHEN 'run.failed' THEN 'failed'");
    expect(projection).not.toContain('INSERT INTO emdo.agent_run_events');
  });

  it('grants the approval-resume executor only an exact claimed-resume run projection', async () => {
    const migrationSql = await readFile(migrationUrl, 'utf8');
    const approvalResumeRunGrants = migrationSql.match(
      /^GRANT [^;]* ON "emdo"\."agent_runs"[^;]*;$/gmu,
    );
    const claimedResumePredicate = [
      '\t\tAND EXISTS (',
      '\t\t\tSELECT 1',
      '\t\t\tFROM emdo.approval_resume_jobs AS resume',
      '\t\t\tWHERE resume.run_id = agent_runs.id',
      '\t\t\t\tAND resume.household_id = agent_runs.household_id',
      '\t\t\t\tAND resume.space_id = agent_runs.space_id',
      '\t\t\t\tAND resume.user_id = agent_runs.original_owner_user_id',
      '\t\t\t\tAND resume.user_id = emdo.current_user_id()',
      "\t\t\t\tAND resume.state = 'claimed'",
      '\t\t\t\tAND resume.decision_id IS NOT NULL',
      "\t\t\t\tAND resume.decision_type IN ('approved', 'rejected')",
      '\t\t\t\tAND resume.approval_event_sequence IS NOT NULL',
      '\t\t\t\tAND resume.claim_id IS NOT NULL',
      "\t\t\t\tAND resume.ownership_token_digest ~ '^[a-f0-9]{64}$'",
      '\t\t\t\tAND resume.authenticated_session_id = emdo.current_session_id()',
      '\t\t\t\tAND resume.resume_request_id = emdo.current_request_id()',
      '\t\t\t\tAND resume.resume_space_access_grant_id IS NOT NULL',
      '\t\t\t\tAND resume.claimed_at IS NOT NULL',
      '\t\t\t\tAND resume.terminal_event_sequence IS NULL',
      '\t\t\t\tAND resume.terminal_reason_code IS NULL',
      '\t\t\t\tAND resume.terminal_result_hash IS NULL',
      '\t\t)',
    ].join('\n');
    const expectedSelectPolicy = [
      'CREATE POLICY approval_resume_agent_runs_executor_select',
      '\tON "emdo"."agent_runs"',
      '\tFOR SELECT TO emdo_approval_resume_executor',
      '\tUSING (',
      '\t\toriginal_owner_user_id = emdo.current_user_id()',
      claimedResumePredicate,
      '\t);',
    ].join('\n');
    const expectedUpdatePolicy = [
      'CREATE POLICY approval_resume_agent_runs_executor_update',
      '\tON "emdo"."agent_runs"',
      '\tFOR UPDATE TO emdo_approval_resume_executor',
      '\tUSING (',
      '\t\toriginal_owner_user_id = emdo.current_user_id()',
      claimedResumePredicate,
      '\t)',
      '\tWITH CHECK (',
      '\t\toriginal_owner_user_id = emdo.current_user_id()',
      claimedResumePredicate,
      '\t);',
    ].join('\n');

    expect(approvalResumeRunGrants).toEqual([
      'GRANT SELECT ON "emdo"."agent_runs" TO emdo_approval_resume_executor;',
      'GRANT UPDATE ("status", "completed_at") ON "emdo"."agent_runs"\n\tTO emdo_approval_resume_executor;',
      [
        'GRANT UPDATE (',
        '\t"resolved_model", "model_reason", "local_trace_reference",',
        '\t"safe_error", "usage"',
        ') ON "emdo"."agent_runs"',
        '\tTO emdo_approval_resume_executor;',
      ].join('\n'),
    ]);
    expect(extract(migrationSql, approvalResumeRunSelectPolicyPattern)).toBe(
      expectedSelectPolicy,
    );
    expect(extract(migrationSql, approvalResumeRunUpdatePolicyPattern)).toBe(
      expectedUpdatePolicy,
    );
  });
});
