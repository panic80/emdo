import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../drizzle/0003_durable_runtime_repositories.sql',
  import.meta.url,
);

describe('approval resume durable aggregate migration', () => {
  it('persists one non-reclaimable owner and both approval and terminal event lineage', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();

    for (const column of [
      'approval_event_sequence',
      'disclosure_policy_version',
      'authenticated_session_id',
      'resume_request_id',
      'resume_space_access_grant_id',
      'collection_authorization_scope_fingerprint',
      'claimed_at',
      'claim_expires_at',
      'terminal_reason_code',
      'terminal_result_hash',
    ]) {
      expect(sql).toContain(`"${column}"`);
    }
    for (const constraint of [
      'approval_resume_jobs_checkpoint_unique',
      'approval_resume_jobs_ownership_digest_unique',
      'approval_resume_jobs_resume_request_unique',
      'approval_resume_jobs_resume_grant_unique',
      'approval_resume_jobs_approval_event_fk',
      'approval_resume_jobs_terminal_event_fk',
      'approval_resume_jobs_claim_lifetime_check',
      'approval_resume_jobs_disclosure_policy_version_check',
    ]) {
      expect(sql).toContain(`"${constraint}"`);
    }
  });

  it('exposes only strict security-definer claim and terminal CAS functions to the app', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();

    expect(sql).toMatch(
      /create or replace function "emdo"\."claim_approval_resume_job"\([\s\S]+?security definer[\s\S]+?set row_security = on/,
    );
    expect(sql).toMatch(
      /create or replace function "emdo"\."settle_approval_resume_job"\([\s\S]+?security definer[\s\S]+?set row_security = on/,
    );
    expect(sql).toContain('issue_space_access_grant');
    expect(sql).toContain('lock_current_authorization_scope');
    expect(sql).toContain('ownership_token_digest');
    expect(sql).toContain('agent_run_events');
    expect(sql).toContain('approval-resume-binding-invalid');
    expect(sql).toContain('approval-resume-failed');
    expect(sql).toMatch(
      /row\(resume\.\*\)::emdo\.approval_resume_jobs as job,[\s\S]+?into v_locked[\s\S]+?v_job := v_locked\.job;/,
    );
    expect(sql).not.toMatch(/into v_job,\s*v_decision,\s*v_proposal/);
    expect(sql).toMatch(
      /'disclosuregrantversion',\s+v_job\.disclosure_policy_version/,
    );
    expect(sql).not.toContain("v_job.disclosure_grant_version::text || '.0.0'");
    expect(sql).toMatch(
      /grant execute on function[\s\S]+claim_approval_resume_job[\s\S]+to emdo_app/,
    );
    expect(sql).toMatch(
      /grant execute on function[\s\S]+settle_approval_resume_job[\s\S]+to emdo_app/,
    );
    expect(sql).toMatch(
      /revoke all on "emdo"\."approval_resume_jobs"[\s\S]+from public, emdo_app/,
    );
    expect(sql).not.toMatch(
      /grant (?:select|insert|update|delete)[^;]+"emdo"\."approval_resume_jobs"[^;]+to emdo_app(?![a-z0-9_])/,
    );
  });
});
