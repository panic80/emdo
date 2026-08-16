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

describe('canonical effective authorization scope migration', () => {
  it('hashes the exact v1 canonical JSON material under current locked scope', async () => {
    const sql = await readMigration();
    const helper = extractFunction(sql, 'lock_current_authorization_scope');

    expect(helper).toContain('security definer');
    expect(helper).toContain('set search_path = pg_catalog, emdo');
    expect(helper).toContain('set row_security = on');
    expect(helper).toContain('fingerprint_domain constant text');
    expect(helper).toContain('canonical_keys constant text[]');
    expect(helper).not.toMatch(/\b(?:text|text\[\])\s+constant\b/u);
    expect(helper).toContain('emdo.authorization-scope.v1');
    expect(helper).toContain('membership.administration_version');
    expect(helper).toContain('lock_active_request_scope');
    expect(helper).toContain('for share');
    expect(helper).toContain('collate c');
    expect(helper).toContain("'proposalspaceid',");
    expect(helper).toContain('v_operation_space_id is null');
    expect(helper).not.toContain("pg_catalog.decode('00', 'hex')");

    const orderedKeys = [
      'domain',
      'householdid',
      'membershipadministrationversion',
      'membershipid',
      'privatespaceid',
      'proposalspaceid',
      'role',
      'sessionid',
      'userid',
      'writablespaceids',
    ];
    let offset = -1;
    for (const key of orderedKeys) {
      const next = helper.indexOf(key, offset + 1);
      expect(next, `${key} must occur in canonical order`).toBeGreaterThan(
        offset,
      );
      offset = next;
    }
  });

  it('keeps the helper internal under the isolated space-grant executor', async () => {
    const sql = await readMigration();
    const statements = sql.split(';');

    expect(sql).toContain(
      'alter function emdo.lock_current_authorization_scope(uuid, uuid, uuid)\n\towner to emdo_space_grant_executor',
    );
    expect(sql).toMatch(
      /revoke all on function[\s\S]+lock_current_authorization_scope\(uuid, uuid, uuid\)[\s\S]+from public, emdo_app/,
    );
    expect(
      statements.some(
        (statement) =>
          statement.includes('grant execute on function') &&
          statement.includes(
            'lock_current_authorization_scope(uuid, uuid, uuid)',
          ) &&
          /\bto emdo_app\b/u.test(statement),
      ),
    ).toBe(false);
    expect(sql).toContain('proposals_space_grant_executor_read');
    expect(sql).toContain('runs_space_grant_executor_read');
    expect(sql).toContain('space_access_grants_executor_lock');
  });

  it('returns the trusted collection scope only through a narrow app callable wrapper', async () => {
    const sql = await readMigration();
    const statements = sql.split(';');
    const wrapper = extractFunction(sql, 'issue_active_principal_scope');

    expect(wrapper).toContain('security definer');
    expect(wrapper).toContain('set search_path = pg_catalog, emdo');
    expect(wrapper).toContain('set row_security = on');
    expect(wrapper).toContain('issue_space_access_grant');
    expect(wrapper).toContain('lock_current_authorization_scope');
    expect(wrapper).toContain('email_verified');
    expect(wrapper).toContain('user_id');
    expect(wrapper).toContain('session_id');
    expect(wrapper).toContain('request_id');
    expect(wrapper).toContain('membership_id');
    expect(wrapper).toContain('collection_authorization_scope_fingerprint');
    expect(wrapper).toMatch(
      /returns table \([\s\S]*private_space_id uuid[\s\S]*collection_authorization_scope_fingerprint text[\s\S]*\)/u,
    );
    expect(sql).toContain(
      'alter function emdo.issue_active_principal_scope(uuid, uuid, text)\n\towner to emdo_space_grant_executor',
    );
    expect(sql).toMatch(
      /revoke all on function[\s\S]+issue_active_principal_scope\(uuid, uuid, text\)[\s\S]+from public, emdo_app/,
    );
    expect(
      statements.some(
        (statement) =>
          statement.includes('grant execute on function') &&
          statement.includes(
            'issue_active_principal_scope(uuid, uuid, text)',
          ) &&
          /\bto emdo_app\b/u.test(statement),
      ),
    ).toBe(true);
    expect(
      statements.some(
        (statement) =>
          statement.includes('grant execute on function') &&
          statement.includes('issue_space_access_grant(uuid, uuid, text)') &&
          /\bto emdo_app\b/u.test(statement),
      ),
    ).toBe(false);
    expect(
      statements.some(
        (statement) =>
          statement.includes('grant execute on function') &&
          statement.includes('issue_space_access_grant(uuid, uuid, text)') &&
          /\bto emdo_space_grant_executor\b/u.test(statement),
      ),
    ).toBe(true);
    expect(
      statements.some(
        (statement) =>
          statement.includes('grant execute on function') &&
          statement.includes(
            'lock_current_authorization_scope(uuid, uuid, uuid)',
          ) &&
          /\bto emdo_space_grant_executor\b/u.test(statement),
      ),
    ).toBe(true);
  });
});
