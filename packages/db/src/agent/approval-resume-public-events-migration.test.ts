import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from '../migrations.js';

const migrationUrl = new URL(
  '../../drizzle/0017_approval_resume_public_events.sql',
  import.meta.url,
);

const normalizedSql = async (): Promise<string> =>
  (await readFile(migrationUrl, 'utf8'))
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .toLowerCase();

describe('approval resume public run-event migration', () => {
  it('is the forward-only migration immediately after Finance document knowledge', async () => {
    const migrations = await loadOrderedMigrations();
    expect(migrations.at(16)).toMatchObject({
      id: '0016_finance_document_knowledge',
      index: 16,
    });
    expect(migrations.at(17)).toMatchObject({
      id: '0017_approval_resume_public_events',
      index: 17,
    });
  });

  it('emits the canonical terminal vocabulary with the direct turn result', async () => {
    const sql = await normalizedSql();
    const validator = sql.slice(
      sql.indexOf(
        'create or replace function "emdo"."approval_resume_turn_result_is_valid"',
      ),
      sql.indexOf(
        'alter function "emdo"."approval_resume_turn_result_is_valid"',
      ),
    );
    const settlement = sql.slice(
      sql.indexOf(
        'create or replace function "emdo"."settle_approval_resume_job"',
      ),
      sql.indexOf('alter function "emdo"."settle_approval_resume_job"'),
    );

    expect(settlement).toContain(
      `v_event_type := case p_mode when 'complete' then case p_result ->> 'status' when 'completed' then 'run.completed' else 'run.failed' end else 'run.failed' end`,
    );
    expect(settlement).toContain(
      `v_event_payload := case when p_mode = 'complete' then p_result`,
    );
    expect(settlement).toContain(
      `emdo.approval_resume_turn_result_is_valid(p_result) is distinct from true`,
    );
    expect(validator).toContain(`immutable parallel safe security invoker`);
    expect(validator).toContain(`set search_path = pg_catalog`);
    expect(validator).toContain(`p_result -> 'localtracereference'`);
    expect(validator).toContain(`p_result -> 'specialistoutcomes'`);
    expect(validator).toContain(`outcome.value -> 'safeerror'`);
    expect(validator).toContain(`v_usage -> 'spendwarning'`);
    expect(validator).toContain(`9007199254740991::numeric`);
    expect(validator).toContain(`pg_catalog.trunc(v_input_tokens)`);
    expect(validator).toContain(`v_outcome ->> 'status' = 'failed'`);
    expect(validator).toContain(`not (v_outcome ? 'safeerror')`);
    expect(validator).toContain(`'terra-unavailable'`);
    expect(validator).toContain(`'escalationtrigger'`);
    expect(validator).toContain(`'no-configured-model-available'`);
    expect(validator).toContain(`'configured-model-fallback-not-allowed'`);
    expect(validator).toMatch(
      /pg_catalog\.jsonb_typeof\(\s*v_outcome -> 'status'\s*\) is distinct from 'string'/,
    );
    expect(validator).toContain(`emdo.jsonb_object_has_exact_keys`);
    expect(validator).not.toContain(`'needs-approval'`);
    expect(validator).not.toContain(`from emdo.`);
    expect(validator).not.toContain(`insert into emdo.`);
    expect(validator).not.toContain(`update emdo.`);
    expect(settlement).toContain(
      'v_terminal_audit_payload := pg_catalog.jsonb_strip_nulls',
    );
    expect(settlement).toContain(
      'pg_catalog.convert_to(v_terminal_audit_payload::text',
    );
    expect(settlement).not.toContain("'agent.turn.completed'");
    expect(settlement).not.toContain("'agent.turn.failed'");
    expect(settlement).not.toContain("'agent.turn.indeterminate'");
  });

  it('normalizes only legacy approval-resume rows at the authorized read boundary', async () => {
    const sql = await normalizedSql();

    expect(sql).toContain(`when 'agent.turn.completed' then 'run.completed'`);
    expect(sql).toContain(`when 'agent.turn.needs-approval' then 'run.failed'`);
    expect(sql).toContain('approval-resume-nested-approval-unsupported');
    expect(sql).toContain(`when 'agent.turn.failed' then 'run.failed'`);
    expect(sql).toContain(`when 'agent.turn.indeterminate' then 'run.failed'`);
    expect(sql).toContain(`then bounded.payload -> 'result'`);
    expect(sql).not.toContain('update emdo.agent_run_events');
  });

  it('preserves the exact owner-token CAS, terminal lineage, and least privilege', async () => {
    const sql = await normalizedSql();
    const validatorAcl = sql.slice(
      sql.indexOf(
        'alter function "emdo"."approval_resume_turn_result_is_valid"',
      ),
      sql.indexOf(
        'create or replace function "emdo"."settle_approval_resume_job"',
      ),
    );

    expect(sql).toContain('security definer');
    expect(sql).toContain('set search_path = pg_catalog, emdo');
    expect(sql).toContain('set row_security = on');
    expect(sql).toContain('ownership_token_digest');
    expect(sql).toContain('for update of resume');
    expect(sql).toContain('terminal_event_sequence = v_terminal_sequence');
    expect(sql).toContain('terminal_result_hash = v_terminal_result_hash');
    expect(sql).toContain("resume.state = 'claimed'");
    expect(sql).toContain('owner to emdo_approval_resume_executor');
    expect(sql).toMatch(
      /revoke all on function[\s\S]+settle_approval_resume_job[\s\S]+from public, emdo_app/,
    );
    expect(sql).toMatch(
      /grant execute on function[\s\S]+settle_approval_resume_job[\s\S]+to emdo_app/,
    );
    expect(validatorAcl).toContain('owner to emdo_approval_resume_executor');
    expect(validatorAcl).toMatch(
      /revoke all on function[\s\S]+approval_resume_turn_result_is_valid[\s\S]+from public, emdo_app/,
    );
    expect(validatorAcl).toMatch(
      /grant execute on function[\s\S]+approval_resume_turn_result_is_valid[\s\S]+to emdo_approval_resume_executor/,
    );
    expect(validatorAcl).toMatch(
      /grant execute on function[\s\S]+jsonb_object_has_exact_keys[\s\S]+json_text_utf16_length[\s\S]+to emdo_approval_resume_executor/,
    );
    expect(validatorAcl).not.toMatch(
      /grant execute on function[\s\S]+approval_resume_turn_result_is_valid[\s\S]+to emdo_app(?:[;\s])/,
    );
    expect(sql).toMatch(
      /create or replace function "emdo"\."read_agent_run_events"\([\s\S]+?security definer[\s\S]+?set row_security = on/,
    );
    expect(sql).toMatch(
      /grant execute on function[\s\S]+read_agent_run_events[\s\S]+to emdo_app/,
    );
  });
});
