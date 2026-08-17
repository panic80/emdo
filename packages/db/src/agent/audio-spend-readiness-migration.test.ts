import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from '../migrations.js';

const migrationUrl = new URL(
  '../../drizzle/0014_audio_spend_readiness.sql',
  import.meta.url,
);

const readNormalized = async (): Promise<string> =>
  (await readFile(migrationUrl, 'utf8')).toLowerCase().replaceAll('"', '');

const extractFunction = (sql: string, name: string): string => {
  const start = sql.indexOf(`create or replace function emdo.${name}`);
  if (start < 0) throw new Error(`missing function ${name}`);
  const end = sql.indexOf('--> statement-breakpoint', start);
  return sql.slice(start, end < 0 ? undefined : end);
};

describe('audio spend readiness migration', () => {
  it('is journaled as the additive no-table 0014 boundary', async () => {
    const migrations = await loadOrderedMigrations();

    expect(migrations[14]).toMatchObject({
      id: '0014_audio_spend_readiness',
      index: 14,
    });
    expect(await readNormalized()).not.toMatch(
      /\b(?:create|alter|drop)\s+table\b/u,
    );
  });

  it('removes raw application table reads and preserves execute-only spend commands', async () => {
    const sql = await readNormalized();

    expect(sql).toMatch(
      /revoke all privileges on table emdo\.ai_spend_reservations\s+from public, emdo_app/u,
    );
    expect(sql).toMatch(
      /grant select, insert, update on table emdo\.ai_spend_reservations\s+to emdo_metering_executor/u,
    );
    expect(sql).not.toMatch(
      /grant (?:select|insert|update|delete)[^;]+emdo\.ai_spend_reservations[^;]+to emdo_app/u,
    );
    for (const signature of [
      'reserve_ai_spend(text,uuid,text,text,text,text,text,bigint,bigint,bigint)',
      'transition_ai_spend(text,text,text)',
      'settle_ai_spend(text,text,bigint)',
    ]) {
      expect(sql).toContain(`emdo.${signature}`);
    }
  });

  it('proves the exact role, forced-RLS, function configuration, and ACL lattice', async () => {
    const sql = await readNormalized();
    const readiness = extractFunction(sql, 'audio_spend_ready');

    expect(readiness).toContain("session_user = 'emdo_api_login'");
    expect(readiness).toContain(
      "pg_has_role(session_user, 'emdo_app', 'member')",
    );
    expect(readiness).toContain("role.rolname = 'emdo_metering_executor'");
    expect(readiness).toContain('role.rolcanlogin = false');
    expect(readiness).toContain('role.rolinherit = false');
    expect(readiness).toContain('role.rolbypassrls = false');
    expect(readiness).toContain('role.rolsuper = false');
    expect(readiness).toMatch(
      /parent\.rolname = 'emdo_metering_executor'[\s\S]+child\.rolname = 'emdo_metering_executor'/u,
    );
    expect(readiness).toContain("relation.relname = 'ai_spend_reservations'");
    expect(readiness).toContain('relation.relrowsecurity');
    expect(readiness).toContain('relation.relforcerowsecurity');
    expect(readiness).toMatch(
      /has_schema_privilege\(\s*'emdo_metering_executor',\s*'emdo',\s*'usage'\s*\)/u,
    );
    expect(readiness).toContain(
      "policy.polname = 'ai_spend_metering_executor_update'",
    );
    expect(readiness).toContain("policy.polcmd = '*'");
    expect(readiness).toContain('policy.polpermissive');
    expect(readiness).toMatch(
      /policy\.polroles\s*=\s*array\['emdo_metering_executor'::regrole\]::oid\[\]/u,
    );
    expect(readiness).toMatch(
      /pg_catalog\.pg_get_expr\(\s*policy\.polqual,\s*policy\.polrelid\s*\)\s*=\s*'true'/u,
    );
    expect(readiness).toMatch(
      /pg_catalog\.pg_get_expr\(\s*policy\.polwithcheck,\s*policy\.polrelid\s*\)\s*=\s*'true'/u,
    );
    expect(readiness).toMatch(
      /not pg_catalog\.has_table_privilege\(\s*session_user,[\s\S]+?'select,insert,update,delete'/u,
    );
    for (const privilege of ['select', 'insert', 'update']) {
      expect(readiness).toMatch(
        new RegExp(
          `pg_catalog\\.has_table_privilege\\(\\s*'emdo_metering_executor',[\\s\\S]+?'${privilege}'`,
          'u',
        ),
      );
    }
    expect(readiness).toContain(
      "'delete,truncate,references,trigger,maintain'",
    );
    expect(readiness).toContain('procedure.prosecdef');
    expect(readiness).toContain("procedure.provolatile = 'v'");
    expect(readiness).toMatch(
      /procedure\.proconfig @> array\[\s*'search_path=pg_catalog, emdo',\s*'row_security=on'\s*\]::text\[\]/u,
    );
    expect(readiness).toContain('select pg_catalog.count(*) = 3');
    expect(readiness).toMatch(
      /has_function_privilege\(\s*session_user,\s*procedure\.oid,\s*'execute'\s*\)/u,
    );
    expect(readiness).toContain('privilege.grantee = 0');
    expect(readiness).toContain("privilege.privilege_type = 'execute'");
  });

  it('owns and exposes only the bounded readiness probe', async () => {
    const sql = await readNormalized();

    expect(sql).toMatch(
      /alter function emdo\.audio_spend_ready\(\)\s+owner to emdo_metering_executor/u,
    );
    expect(sql).toMatch(
      /revoke all on function emdo\.audio_spend_ready\(\)\s+from public/u,
    );
    expect(sql).toMatch(
      /grant execute on function emdo\.audio_spend_ready\(\)\s+to emdo_app/u,
    );
    expect(sql).not.toMatch(/\bcreate role\b/u);
  });
});
