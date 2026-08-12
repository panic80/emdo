import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../drizzle/0003_durable_runtime_repositories.sql',
  import.meta.url,
);

const readMigration = async () =>
  (await readFile(migrationUrl, 'utf8')).toLowerCase().replaceAll('"', '');

const extractFunction = (sql: string, name: string): string => {
  const match = sql.match(
    new RegExp(
      `create or replace function emdo\\.${name}\\s*\\([\\s\\S]+?\\$function\\$;`,
    ),
  );
  expect(match, `${name} must be present`).not.toBeNull();
  return match?.[0] ?? '';
};

const extractVisualProofBlock = (sql: string): string => {
  const start = sql.indexOf('create table emdo.visual_decision_proofs');
  const end = sql.indexOf(
    '-- a workflow login receives no data-plane role membership',
  );
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
};

describe('visual proposal persistence migration', () => {
  it('stores only deterministic proof token material and immutable authority bindings', async () => {
    const sql = await readMigration();
    const block = extractVisualProofBlock(sql);
    const protector = extractFunction(sql, 'protect_visual_decision_proof');

    expect(sql).toContain('create table emdo.visual_decision_proofs');
    for (const column of [
      'proof_id',
      'nonce',
      'key_id',
      'token_hash',
      'binding_version',
      'issuance_fingerprint',
      'authorization_scope_fingerprint',
      'user_id',
      'session_id',
      'household_id',
      'space_id',
      'initial_request_id',
      'latest_request_id',
      'initial_issued_at',
      'issued_at',
      'expires_at',
      'consumed_at',
      'decision_id',
      'row_version',
      'retain_until',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).not.toMatch(/visual_decision_proofs[\s\S]+proof_token/);
    expect(sql).toContain('visual_decision_proofs_token_hash_unique');
    expect(sql).toContain('visual_decision_proofs_idempotency_unique');
    expect(sql).toContain('visual_decision_proofs_terminal_check');
    expect(sql).toContain('visual_decision_proofs_proposal_fk');
    expect(sql).toContain('visual_decision_proofs_owner_membership_fk');
    expect(sql).toContain('visual_decision_proofs_proposal_idx');
    expect(sql).toContain('visual_decision_proofs_session_fk');
    expect(sql).toContain('visual_decision_proofs_decision_unique');
    expect(sql).toContain('visual_decision_proofs_token_material_check');
    expect(sql).toContain('visual_decision_proofs_binding_check');
    expect(sql).toContain('visual_decision_proofs_lifetime_check');
    expect(sql).toContain('visual_decision_proofs_immutable');
    for (const material of ['nonce', 'key_id', 'token_hash']) {
      expect(block).toMatch(new RegExp(`${material} text not null`));
    }
    expect(protector).toContain('latest_request_id');
    expect(protector).toContain('old.consumed_at is not null');
    expect(protector).toContain(
      'new.latest_request_id is distinct from old.latest_request_id',
    );
    expect(sql).toMatch(
      /alter table emdo\.visual_decision_proofs[\s\S]+force row level security/,
    );
  });

  it('derives one reusable stable authorization scope from locked canonical rows', async () => {
    const sql = await readMigration();
    const helper = extractFunction(sql, 'lock_current_authorization_scope');

    expect(helper).toContain('security definer');
    expect(helper).toContain('set search_path = pg_catalog, emdo');
    expect(helper).toContain('set row_security = on');
    expect(helper).toContain('emdo.current_user_id()');
    expect(helper).toContain('emdo.current_session_id()');
    expect(helper).toContain('emdo.current_request_id()');
    expect(helper).toContain('lock_active_request_scope');
    expect(helper).toContain('space_access_grants');
    expect(helper).toContain('household_memberships');
    expect(helper).toContain('agent_runs');
    expect(helper).toContain('membership_id');
    expect(helper).toContain('administration_version');
    expect(helper).toContain('private_space_id');
    expect(helper).toContain('proposal_space_id');
    expect(helper).toContain('writable_space_ids');
    expect(helper).toContain('order by');
    expect(helper).toContain('for share');
    expect(helper).toContain('emdo.authorization-scope.v1');
    expect(helper).toMatch(
      /p_proposal_id is not null\s+and p_run_id is not null[\s\S]+?return/,
    );
    expect(helper).toMatch(/if p_proposal_id is not null then/);
    expect(helper).toMatch(/elsif p_run_id is not null then/);
    expect(helper).toMatch(/else[\s\S]+?private_space_id/);
    expect(helper).toContain('v_grant.private_space_id');
    expect(helper).toContain(
      "pg_catalog.sha256(pg_catalog.convert_to(v_material, 'utf8'))",
    );
    expect(helper).not.toContain("pg_catalog.decode('00', 'hex')");
    expect(helper).not.toContain('p_user_id');
    expect(helper).not.toContain('p_session_id');
    expect(helper).not.toContain('p_household_id');
    expect(helper).not.toContain('p_private_space_id');
    expect(helper).not.toContain('p_writable_space_ids');
    expect(helper).not.toContain('p_grant_id');
  });

  it('prepares and finalizes proofs under locked current authority without receiving bearer material', async () => {
    const sql = await readMigration();
    const prepare = extractFunction(sql, 'prepare_visual_decision_proof');
    const finalize = extractFunction(sql, 'finalize_visual_decision_proof');

    for (const body of [prepare, finalize]) {
      expect(body).toContain('security definer');
      expect(body).toContain('set search_path = pg_catalog, emdo');
      expect(body).toContain('set row_security = on');
      expect(body).toContain('lock_current_authorization_scope');
      expect(body).toContain('authorization_scope_fingerprint');
      expect(body).toContain(
        'v_proposal.authorization_scope_fingerprint is distinct from',
      );
      expect(body).toContain(
        'row(proposal.*)::emdo.action_proposals as proposal_row',
      );
      expect(body).not.toContain('space_access_grants');
      expect(body).not.toContain('lock_active_request_scope');
      expect(body).not.toContain('proof_token');
    }
    expect(prepare).toContain('pg_catalog.clock_timestamp()');
    expect(prepare).toContain('proposal_states');
    expect(prepare).toContain('for update');
    expect(prepare).toContain('lock_current_authorization_scope');
    expect(prepare).toContain('resolve_visual_decision_proof_replay');
    expect(prepare).toContain('pg_advisory_xact_lock');
    expect(prepare).toContain("interval '120 seconds'");
    expect(prepare).toMatch(/(?<!pg_catalog\.)least\(/u);
    expect(prepare).not.toContain('insert into emdo.visual_decision_proofs');
    expect(finalize).toContain('token_hash');
    expect(finalize).toContain('lock_current_authorization_scope');
    expect(finalize).toContain('for update');
    expect(finalize).toContain('insert into emdo.visual_decision_proofs');
    expect(finalize).toContain('on conflict');
    expect(finalize).toContain('authorization_scope_fingerprint');
    expect(finalize).toContain('issuance_fingerprint');
    expect(finalize).toContain('initial_request_id');
    expect(finalize).toContain('issued_at');
    expect(finalize).toContain('expires_at');
    expect(finalize).not.toContain('update emdo.visual_decision_proofs');
    expect(sql).toContain('pg_catalog.timestamptz_send(p_issued_at)');
    expect(sql).toContain('pg_catalog.timestamptz_send(p_expires_at)');
    expect(sql).toMatch(
      /grant execute on function[\s\S]+prepare_visual_decision_proof[\s\S]+finalize_visual_decision_proof[\s\S]+to emdo_app/,
    );
    expect(sql).not.toMatch(
      /grant (?:insert|update|delete)[^;]+visual_decision_proofs[^;]+to emdo_app/,
    );
  });

  it('resolves replay from immutable finalized material and changes only lineage', async () => {
    const sql = await readMigration();
    const replay = extractFunction(sql, 'resolve_visual_decision_proof_replay');

    expect(replay).toContain('security definer');
    expect(replay).toContain('set row_security = on');
    expect(replay).toContain('visual_decision_proofs');
    expect(replay).toContain('for update');
    expect(replay).toContain('token_hash');
    expect(replay).toMatch(/v_proof\.consumed_at is not null/);
    expect(replay).toMatch(/v_proof\.expires_at <= v_now/);
    expect(replay).toContain('authorization_scope_fingerprint');
    expect(replay).toContain('issuance_fingerprint');
    expect(replay).toContain(
      'v_proposal.authorization_scope_fingerprint is distinct from',
    );
    expect(replay).toMatch(
      /update emdo\.visual_decision_proofs[\s\S]+set latest_request_id =/,
    );
    expect(replay).not.toMatch(
      /set (?:proof_id|nonce|key_id|token_hash|binding_version|issuance_fingerprint|authorization_scope_fingerprint|initial_request_id|initial_issued_at|issued_at|expires_at|consumed_at|decision_id|row_version)\s*=/,
    );
    expect(sql).not.toMatch(
      /grant execute on function[^;]+resolve_visual_decision_proof_replay[^;]+to emdo_app/,
    );
  });

  it('uses one membership-free owner and grants the app only the public proof functions', async () => {
    const sql = await readMigration();
    const block = extractVisualProofBlock(sql);

    expect(block).toContain('create role emdo_visual_proof_executor nologin');
    expect(block).toContain('noinherit');
    expect(block).toContain('nobypassrls');
    expect(block).toContain(
      'visual proof executor must not have role memberships',
    );
    expect(sql).toMatch(
      /grant execute on function[\s\S]+?lock_current_authorization_scope\(uuid, uuid, uuid\)[\s\S]+?to emdo_visual_proof_executor/,
    );
    expect(sql).toMatch(
      /grant execute on function[\s\S]+?current_session_id\(\)[\s\S]+?to emdo_visual_proof_executor/,
    );
    expect(block).toContain(
      'alter function emdo.resolve_visual_decision_proof_replay',
    );
    expect(block).toContain('owner to emdo_visual_proof_executor');
    expect(block).toContain('revoke all on emdo.visual_decision_proofs');
    expect(block).toContain('revoke insert, update, delete');
    expect(block).toContain('from emdo_app');
    expect(block).toMatch(
      /grant execute on function[\s\S]+?emdo\.prepare_visual_decision_proof/,
    );
    expect(block).toContain('emdo.finalize_visual_decision_proof');
  });

  it('consumes one exact proof atomically with the visual decision CAS and exact replay link', async () => {
    const sql = await readMigration();
    const decision = extractFunction(sql, 'commit_provider_proposal_decision');

    expect(decision).toContain('claim_workflow_operation_scope');
    expect(decision).toContain('visualdecisionproofhash');
    expect(decision).toContain('visual_decision_proofs');
    expect(decision).toContain('token_hash');
    expect(decision).toContain('consumed_at');
    expect(decision).toContain('decision_id');
    expect(decision).toContain('for update');
    expect(decision).toContain('insert into emdo.action_decisions');
    expect(decision).toContain('insert into emdo.proposal_events');
    expect(decision).toContain("'duplicate'");
    expect(decision).toContain("'conflict'");
  });

  it('keeps proof issuance idempotency separate from decision-command idempotency', async () => {
    const sql = await readMigration();
    const decision = extractFunction(sql, 'commit_provider_proposal_decision');
    const replay = extractFunction(
      sql,
      'resolve_provider_proposal_decision_replay',
    );

    expect(decision).not.toMatch(
      /v_proof\.idempotency_key is distinct from[\s\S]+?decision,idempotencykey/u,
    );
    expect(replay).not.toContain('proof.idempotency_key = p_idempotency_key');
    expect(replay).toContain('decision.idempotency_key = p_idempotency_key');
    expect(sql).toMatch(
      /grant update \(id\) on emdo\.action_decisions[\s\S]+?to emdo_visual_proof_executor/u,
    );
    expect(sql).toContain('visual_proof_decisions_executor_update');
  });
});
