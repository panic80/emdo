import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../drizzle/0003_durable_runtime_repositories.sql',
  import.meta.url,
);
const managerSpecialistMigrationUrl = new URL(
  '../../drizzle/0020_manager_specialist_disclosure.sql',
  import.meta.url,
);

const readMigration = async () =>
  (await readFile(migrationUrl, 'utf8')).toLowerCase().replaceAll('"', '');
const readManagerSpecialistMigration = async () =>
  (await readFile(managerSpecialistMigrationUrl, 'utf8'))
    .toLowerCase()
    .replaceAll('"', '');

describe('durable model disclosure migration', () => {
  it('resolves and commits disclosure only through a principal-bound executor', async () => {
    const sql = await readMigration();

    expect(sql).toContain('create role emdo_disclosure_executor nologin');
    expect(sql).toContain(
      'create or replace function emdo.issue_model_disclosure_grant',
    );
    expect(sql).toContain(
      'create or replace function emdo.resolve_model_disclosure_grant',
    );
    expect(sql).toContain(
      'create or replace function emdo.commit_model_disclosure_authorization',
    );
    expect(sql).toContain(
      'create or replace function emdo.record_model_disclosure_denial',
    );
    expect(sql).toMatch(
      /resolve_model_disclosure_grant[\s\S]+lock_active_request_scope/,
    );
    expect(sql).toMatch(
      /commit_model_disclosure_authorization[\s\S]+lock_active_request_scope/,
    );
    expect(sql).toMatch(
      /issue_model_disclosure_grant[\s\S]+lock_active_request_scope/,
    );
    expect(sql).toMatch(
      /issue_model_disclosure_grant[\s\S]+space_access_grants[\s\S]+agent_runs/,
    );
    expect(sql).toMatch(
      /grant execute on function[\s\S]+resolve_model_disclosure_grant[\s\S]+to emdo_app/,
    );
    expect(sql).not.toMatch(
      /grant (?:select|insert|update|delete)[^;]+disclosure_grants[^;]+to emdo_app\b/,
    );
    expect(sql).toMatch(
      /revoke (?:all|[a-z, ]*insert[a-z, ]*) on emdo\.disclosure_grants[\s\S]+from[^;]*emdo_app[^;]*emdo_worker/,
    );
    expect(sql).toMatch(
      /grant execute on function[\s\S]+issue_model_disclosure_grant[\s\S]+to emdo_app/,
    );
  });

  it('derives an immutable ten-minute one-run grant and canonical hash with DB time', async () => {
    const sql = await readMigration();
    const issue = sql.match(
      /create or replace function emdo\.issue_model_disclosure_grant[\s\S]+?end\s*\$function\$/,
    )?.[0];

    expect(issue).toContain('pg_catalog.gen_random_uuid()');
    expect(issue).toContain('pg_catalog.clock_timestamp()');
    expect(issue).toContain("interval '10 minutes'");
    expect(issue).toContain('pg_catalog.sha256');
    expect(issue).toContain('record_allowlist');
    expect(issue).toContain('on conflict');
    expect(issue).toContain("'model.disclosure.granted'");
    expect(sql).toContain('disclosure_grants_run_phase_agent_unique');
  });

  it('preserves the exact class-record-field binding in tenant audit metadata', async () => {
    const sql = await readMigration();
    const commit = sql.match(
      /create or replace function emdo\.commit_model_disclosure_authorization[\s\S]+?end\s*\$function\$/,
    )?.[0];

    expect(commit).toContain("record ->> 'dataclass'");
    expect(commit).toContain("record ->> 'recordid'");
    expect(commit).toContain("record -> 'fields'");
    expect(commit).toContain("'model.disclosure.sent'");
    expect(commit).toContain('pg_catalog.clock_timestamp()');
  });

  it('revalidates the canonical space grant and database time at every disclosure mutation boundary', async () => {
    const sql = await readMigration();
    const functions = [
      'issue_model_disclosure_grant',
      'resolve_model_disclosure_grant',
      'commit_model_disclosure_authorization',
      'record_model_disclosure_denial',
    ].map(
      (name) =>
        sql.match(
          new RegExp(
            `create or replace function emdo\\.${name}[\\s\\S]+?end\\s*\\$function\\$`,
            'u',
          ),
        )?.[0],
    );

    for (const body of functions) {
      expect(body).toContain('emdo.resolve_space_access_grant');
      expect(body).toContain('pg_catalog.clock_timestamp()');
    }
    expect(sql).toMatch(
      /grant execute on function\s+emdo\.resolve_space_access_grant\(uuid, uuid, uuid, uuid, uuid, uuid\)\s+to emdo_disclosure_executor/,
    );
  });

  it('limits manager-owned runs to scheduler or finance specialist execution while retaining the same-agent path', async () => {
    const sql = await readManagerSpecialistMigration();
    const issue = sql.match(
      /create or replace function emdo\.issue_model_disclosure_grant[\s\S]+?end\s*\$function\$/,
    )?.[0];
    const resolve = sql.match(
      /create or replace function emdo\.resolve_model_disclosure_grant[\s\S]+?end\s*\$function\$/,
    )?.[0];

    expect(issue).toMatch(
      /and \(\s*run\.agent_id = p_agent_id\s*or \(\s*run\.agent_id = 'manager'\s*and p_agent_id in \('scheduler', 'finance'\)\s*and p_phase_purpose = 'specialist-execution'\s*\)\s*\)/,
    );
    expect(issue).toContain("and run.status in ('queued', 'running')");
    expect(issue).not.toContain("'shopping'");
    expect(issue).toContain('security definer');
    expect(issue).toContain('set search_path = pg_catalog, emdo');
    expect(issue).toContain('set row_security = on');
    expect(resolve).toMatch(
      /and \(\s*run\.agent_id = v_grant\.agent_id\s*or \(\s*run\.agent_id = 'manager'\s*and v_grant\.phase_purpose = 'specialist-execution'\s*and v_grant\.agent_id in \('scheduler', 'finance'\)\s*\)\s*\);/,
    );
    expect(resolve).not.toContain("'shopping'");
    expect(resolve).toContain('security definer');
    expect(resolve).toContain('set search_path = pg_catalog, emdo');
    expect(resolve).toContain('set row_security = on');
    expect(sql).toMatch(
      /alter function emdo\.issue_model_disclosure_grant\(uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb\)\s+owner to emdo_disclosure_executor;/,
    );
    expect(sql).toMatch(
      /alter function emdo\.resolve_model_disclosure_grant\(uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb\)\s+owner to emdo_disclosure_executor;/,
    );
    expect(sql).toMatch(
      /revoke all on function\s+emdo\.issue_model_disclosure_grant[\s\S]+emdo\.resolve_model_disclosure_grant[\s\S]+from public, emdo_app, emdo_auth, emdo_worker, emdo_workflow,[\s\S]+emdo_disclosure_executor;/,
    );
    expect(sql).toMatch(
      /grant execute on function\s+emdo\.issue_model_disclosure_grant[\s\S]+emdo\.resolve_model_disclosure_grant[\s\S]+to emdo_app;/,
    );
  });
});
