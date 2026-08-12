import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadOrderedMigrations } from '../migrations.js';

const migrationUrl = new URL(
  '../../drizzle/0007_experience_notification_preferences.sql',
  import.meta.url,
);
const schemaUrl = new URL('../schema.ts', import.meta.url);
const snapshotUrl = new URL(
  '../../drizzle/meta/0007_snapshot.json',
  import.meta.url,
);
const previousSnapshotUrl = new URL(
  '../../drizzle/meta/0006_snapshot.json',
  import.meta.url,
);

const readNormalized = async (url: URL) =>
  (await readFile(url, 'utf8')).toLowerCase().replaceAll('"', '');

describe('experience notification preferences migration', () => {
  it('is journaled as an additive 0007 upgrade and has schema/snapshot parity', async () => {
    const [migrations, schema, snapshot] = await Promise.all([
      loadOrderedMigrations(),
      readNormalized(schemaUrl),
      readNormalized(snapshotUrl),
    ]);

    expect(migrations.at(-1)?.id).toBe(
      '0007_experience_notification_preferences',
    );
    expect(migrations.at(-1)?.index).toBe(7);
    expect(schema).toContain("'notification_preferences'");
    expect(schema).toContain("'notification_preference_commands'");
    expect(snapshot).toContain('emdo.notification_preferences');
    expect(snapshot).toContain('emdo.notification_preference_commands');
  });

  it('is an exact two-table mechanical successor to the frozen 0006 snapshot', async () => {
    const [previousText, currentText] = await Promise.all([
      readFile(previousSnapshotUrl, 'utf8'),
      readFile(snapshotUrl, 'utf8'),
    ]);
    const previous = JSON.parse(previousText) as {
      readonly id: string;
      readonly tables: Readonly<Record<string, unknown>>;
      readonly [key: string]: unknown;
    };
    const current = JSON.parse(currentText) as {
      readonly prevId: string;
      readonly tables: Readonly<Record<string, unknown>>;
      readonly [key: string]: unknown;
    };

    expect(current.prevId).toBe(previous.id);
    const previousTableNames = Object.keys(previous.tables).sort();
    const currentTableNames = Object.keys(current.tables).sort();
    expect(
      currentTableNames.filter((name) => !previousTableNames.includes(name)),
    ).toEqual([
      'emdo.notification_preference_commands',
      'emdo.notification_preferences',
    ]);
    expect(
      previousTableNames.filter((name) => !currentTableNames.includes(name)),
    ).toEqual([]);
    for (const name of previousTableNames) {
      expect(current.tables[name]).toEqual(previous.tables[name]);
    }

    const withoutIdentity = (snapshot: Readonly<Record<string, unknown>>) => {
      return Object.fromEntries(
        Object.entries(snapshot).filter(
          ([key]) => key !== 'id' && key !== 'prevId' && key !== 'tables',
        ),
      );
    };
    expect(withoutIdentity(current)).toEqual(withoutIdentity(previous));
  });

  it('creates forced-RLS user preferences with positive CAS versioning', async () => {
    const sql = await readNormalized(migrationUrl);

    expect(sql).toContain('create table emdo.notification_preferences');
    expect(sql).toMatch(/primary key\s*\(household_id,\s*user_id\)/u);
    expect(sql).toContain('version integer default 1 not null');
    expect(sql).toContain('notification_preferences_version_positive');
    for (const table of [
      'notification_preferences',
      'notification_preference_commands',
    ]) {
      expect(sql).toContain(
        `alter table emdo.${table} enable row level security`,
      );
      expect(sql).toContain(
        `alter table emdo.${table} force row level security`,
      );
    }
  });

  it('provides request-scoped reads and atomic CAS/idempotency updates', async () => {
    const sql = await readNormalized(migrationUrl);

    expect(sql).toContain(
      'create or replace function emdo.read_experience_notification_preferences',
    );
    expect(sql).toContain(
      'create or replace function emdo.update_experience_notification_preferences',
    );
    expect(sql).toContain('emdo.lock_active_request_scope');
    expect(sql).toContain('for update');
    expect(sql).toContain('version = p_expected_version');
    expect(sql).toContain('version = preference.version + 1');
    expect(sql).toContain('request_hash');
    expect(sql).toContain('idempotency_key');
    expect(sql).toContain('response is not null');
    expect(sql).toContain("message = 'emdo:idempotency-conflict'");
    expect(sql).toContain("message = 'emdo:version-conflict'");
    const readRoutine = sql.match(
      /create or replace function emdo\.read_experience_notification_preferences[\s\S]+?end\s+\$function\$/u,
    )?.[0];
    expect(readRoutine).toBeDefined();
    expect(readRoutine).not.toContain('insert into');
    expect(readRoutine).toContain("'version', coalesce(preference.version, 1)");
    expect(readRoutine).toContain("'1970-01-01 00:00:00+00'::timestamptz");
  });

  it('uses an isolated executor and exposes only narrow routine execution', async () => {
    const sql = await readNormalized(migrationUrl);

    expect(sql).toContain(
      'create role emdo_experience_preferences_executor nologin',
    );
    expect(sql).toMatch(
      /alter role emdo_experience_preferences_executor nologin nosuperuser\s+nocreatedb nocreaterole noinherit nobypassrls noreplication/u,
    );
    expect(sql).toContain(
      'experience preferences executor must not have role memberships',
    );
    expect(sql).toContain('security definer');
    expect(sql).toContain('set row_security = on');
    expect(sql).toMatch(
      /grant execute on function[\s\S]+read_experience_notification_preferences[\s\S]+to emdo_app/u,
    );
    const helperGrant = sql.match(
      /grant execute on function\s+([\s\S]+?)\s+to emdo_experience_preferences_executor;/u,
    )?.[1];
    expect(helperGrant).toBeDefined();
    for (const helper of [
      'current_user_id()',
      'current_request_id()',
      'is_active_request_scope(uuid, uuid, uuid)',
      'lock_active_request_scope(uuid, uuid, uuid)',
    ]) {
      expect(helperGrant).toContain(helper);
    }
    expect(sql).not.toMatch(
      /grant (?:select|insert|update|delete)[^;]+notification_preferences[^;]+to emdo_app/u,
    );
    expect(sql).not.toMatch(/provider|oauth|token|authority|credential/u);
  });

  it('re-checks current consent inside the exact active notification delivery operation', async () => {
    const sql = await readNormalized(migrationUrl);

    expect(sql).toContain(
      'create or replace function emdo.read_worker_notification_delivery_preferences',
    );
    expect(sql).toContain(
      "emdo.current_worker_job_name() = 'emdo.notification.delivery.v1'",
    );
    expect(sql).toContain("emdo.current_worker_target_type() = 'notification'");
    expect(sql).toContain('emdo.current_worker_target_id()');
    expect(sql).toContain('emdo.current_worker_target_revision()');
    expect(sql).toContain('emdo.is_active_worker_operation_scope');
    expect(sql).toMatch(/coalesce\(preference\.in_app,\s*true\)/u);
    expect(sql).toMatch(/coalesce\(preference\.email,\s*false\)/u);
    expect(sql).toMatch(/coalesce\(preference\.push,\s*false\)/u);
    expect(sql).toContain("'recipient', case");
    expect(sql).toContain('then account_user.email');
    expect(sql).toContain("'subscriptionreference', null::text");
    expect(sql).toContain(
      "'enabled', false and coalesce(preference.push, false)",
    );
    expect(sql).toMatch(
      /grant execute on function\s+emdo\.read_worker_notification_delivery_preferences\(uuid\)\s+to emdo_worker_executor/u,
    );
    expect(sql).not.toMatch(
      /grant (?:select|insert|update|delete)[^;]+notification_preferences[^;]+to emdo_worker_executor/u,
    );
  });
});
