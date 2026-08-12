import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../drizzle/0005_household_administration.sql',
  import.meta.url,
);

describe('atomic invitation redemption migration', () => {
  it('binds one exact request to one bounded non-secret replay receipt', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();
    const routine = sql.match(
      /create or replace function emdo\.redeem_household_invitation[\s\S]+?end\s*\$function\$;/,
    )?.[0];

    expect(sql).toContain('create table emdo.invitation_redemption_commands');
    expect(sql).toContain(
      'invitation_redemption_commands_origin_request_unique',
    );
    expect(sql).toContain('invitation_redemption_commands_result_check');
    expect(sql).toContain('invitation_redemption_commands_retention_check');
    expect(sql).toContain(
      'create or replace function emdo.is_safe_invitation_redemption_result',
    );
    expect(sql).toContain('emdo.invitation-redemption-request.v1');
    expect(sql).toContain("|| pg_catalog.decode('00', 'hex')");
    for (const field of [
      'displayName',
      'email',
      'invitationId',
      'invitationTokenHash',
      'passwordHash',
      'schemaVersion',
    ]) {
      expect(sql).toContain(field.toLowerCase());
    }
    expect(routine).toBeDefined();
    expect(routine).not.toContain('p_request_hash');
    expect(routine).toContain('p_invitation_token_hash is null');
    expect(routine).toContain('p_password_hash is null');
    expect(routine).toContain('p_idempotency_key is null');
    expect(routine).toContain(
      'v_command.origin_request_id is distinct from p_request_id',
    );
  });

  it('keeps validation, provisioning, consumption, audit, and receipt in one definer transaction', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();
    const routine = sql.match(
      /create or replace function emdo\.redeem_household_invitation[\s\S]+?end\s*\$function\$;/,
    )?.[0];

    expect(routine).toBeDefined();
    expect(routine).toContain('security definer');
    expect(routine).toContain('set row_security = on');
    expect(routine).toContain('pg_advisory_xact_lock');
    expect(routine).toContain('for update of invitation');
    expect(routine).toContain('for share of issuer');
    expect(routine?.match(/\bfor update\b/g)).toHaveLength(1);
    expect(routine).toContain("issuer.role = 'owner'");
    expect(routine).toContain("issuer.status = 'active'");
    expect(sql).toMatch(
      /create policy memberships_onboarding_issuer_lock[\s\S]+?for update to emdo_onboarding_executor[\s\S]+?using[\s\S]+?with check/,
    );
    expect(sql).toMatch(
      /grant update \(household_id\)[\s\S]+?on emdo\.household_memberships to emdo_onboarding_executor/,
    );
    expect(routine).toContain('emdo.provision_invited_account');
    expect(routine).toContain(
      'insert into emdo.invitation_redemption_commands',
    );
    expect(routine).toContain("return query select 'replay'");
    expect(routine).toContain("return query select 'conflict'");
    expect(routine).toContain("return query select 'invalid'");
  });

  it('exposes only the aggregate to onboarding and denies raw persistence authority', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();

    expect(sql).toMatch(
      /revoke all on function emdo\.provision_invited_account\([\s\S]+?from emdo_onboarding/,
    );
    expect(sql).toMatch(
      /grant execute on function emdo\.redeem_household_invitation\([\s\S]+?to emdo_onboarding/,
    );
    expect(sql).toMatch(
      /revoke all on function emdo\.redeem_household_invitation\([\s\S]+?from public, emdo_app, emdo_auth/,
    );
    expect(sql).toContain(
      'create or replace function emdo.invitation_redemption_ready',
    );
    expect(sql).toContain(
      "not pg_catalog.has_function_privilege(\n\t\t\tsession_user,\n\t\t\t'emdo.provision_invited_account",
    );
    expect(sql).toContain(
      "not pg_catalog.has_any_column_privilege(\n\t\t\tsession_user, 'emdo.invitation_redemption_commands', 'insert'",
    );
  });
});
