import { describe, expect, it } from 'vitest';

import {
  installPgBossSchema,
  type PgBossMigrationRuntime,
  type PgBossMigrationRuntimeModule,
} from './job-schema.js';

class FakeMigrationRuntime implements PgBossMigrationRuntime {
  static instances: FakeMigrationRuntime[] = [];
  readonly options: unknown;
  readonly events: string[] = [];
  readonly statements: string[] = [];
  installed = true;
  version: number | null = 37;
  drift: unknown = { ok: true, building: [] };
  bamStatuses: unknown[] = [
    [{ status: 'completed', count: 1, lastCreatedOn: new Date() }],
  ];

  constructor(options: unknown) {
    this.options = options;
    FakeMigrationRuntime.instances.push(this);
  }

  on(): this {
    this.events.push('on:error');
    return this;
  }

  async start(): Promise<void> {
    this.events.push('start');
  }

  getDb() {
    return {
      executeSql: async (statement: string) => {
        this.statements.push(statement);
        return { rows: [] };
      },
    };
  }

  async isInstalled(): Promise<boolean> {
    this.events.push('verify:installed');
    return this.installed;
  }

  async schemaVersion(): Promise<number | null> {
    this.events.push('verify:version');
    return this.version;
  }

  async detectSchemaDrift(): Promise<unknown> {
    this.events.push('verify:drift');
    return this.drift;
  }

  async getBamStatus(): Promise<unknown> {
    this.events.push('verify:bam');
    return this.bamStatuses.shift() ?? [];
  }

  async stop(): Promise<void> {
    this.events.push('stop');
  }
}

const loader = async (): Promise<PgBossMigrationRuntimeModule> => ({
  PgBoss: FakeMigrationRuntime,
});

describe('pg-boss schema installer', () => {
  it('migrates with the operations DSN, grants the worker login, and verifies drift', async () => {
    FakeMigrationRuntime.instances.length = 0;

    await expect(
      installPgBossSchema({
        databaseUrl: 'postgresql://migration:secret@postgres/emdo_app',
        moduleLoader: loader,
      }),
    ).resolves.toEqual({ schemaVersion: 37 });

    const runtime = FakeMigrationRuntime.instances[0]!;
    expect(runtime.options).toEqual({
      connectionString: 'postgresql://migration:secret@postgres/emdo_app',
      schema: 'pgboss',
      application_name: 'emdo-job-schema',
      migrate: true,
      createSchema: true,
      supervise: false,
      schedule: false,
      useListenNotify: false,
      bamIntervalSeconds: 10,
    });
    const grants = runtime.statements.join('\n');
    expect(grants).toMatch(
      /REVOKE ALL PRIVILEGES ON SCHEMA pgboss FROM PUBLIC/u,
    );
    expect(grants).toMatch(
      /GRANT USAGE ON SCHEMA pgboss TO emdo_worker_login/u,
    );
    expect(grants).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO emdo_worker_login/u,
    );
    expect(grants).toMatch(/ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss/u);
    expect(grants).not.toMatch(/TO emdo_(?:api|auth|workflow)_login/u);
    expect(runtime.events).toEqual([
      'on:error',
      'start',
      'verify:bam',
      'verify:installed',
      'verify:version',
      'verify:drift',
      'stop',
    ]);
  });

  it('waits for pending BAM work to complete before accepting the schema', async () => {
    class BuildingRuntime extends FakeMigrationRuntime {
      constructor(options: unknown) {
        super(options);
        this.bamStatuses = [
          [{ status: 'pending', count: 1, lastCreatedOn: new Date() }],
          [{ status: 'in_progress', count: 1, lastCreatedOn: new Date() }],
          [{ status: 'completed', count: 1, lastCreatedOn: new Date() }],
        ];
      }
    }
    const waits: number[] = [];
    const buildingLoader = async (): Promise<PgBossMigrationRuntimeModule> => ({
      PgBoss: BuildingRuntime,
    });

    await expect(
      installPgBossSchema({
        databaseUrl: 'postgresql://migration:secret@postgres/emdo_app',
        moduleLoader: buildingLoader,
        bamPolling: {
          intervalMilliseconds: 1,
          maximumAttempts: 3,
          async wait(milliseconds) {
            waits.push(milliseconds);
          },
        },
      }),
    ).resolves.toEqual({ schemaVersion: 37 });
    expect(waits).toEqual([1, 1]);
  });

  it('stops and fails safely when schema verification reports drift', async () => {
    class DriftedRuntime extends FakeMigrationRuntime {
      constructor(options: unknown) {
        super(options);
        this.drift = { ok: false, missing: ['private table detail'] };
      }
    }
    const instances: DriftedRuntime[] = [];
    const driftedLoader = async (): Promise<PgBossMigrationRuntimeModule> => ({
      PgBoss: class extends DriftedRuntime {
        constructor(options: unknown) {
          super(options);
          instances.push(this);
        }
      },
    });

    await expect(
      installPgBossSchema({
        databaseUrl: 'postgresql://migration:secret@postgres/emdo_app',
        moduleLoader: driftedLoader,
      }),
    ).rejects.toThrow('pg-boss schema installation failed');
    expect(instances[0]?.events.at(-1)).toBe('stop');
  });

  it('fails on stuck or failed BAM work and on shutdown failure', async () => {
    class FailedBamRuntime extends FakeMigrationRuntime {
      constructor(options: unknown) {
        super(options);
        this.bamStatuses = [
          [{ status: 'failed', count: 1, lastCreatedOn: new Date() }],
        ];
      }
    }
    await expect(
      installPgBossSchema({
        databaseUrl: 'postgresql://migration:secret@postgres/emdo_app',
        moduleLoader: async () => ({ PgBoss: FailedBamRuntime }),
      }),
    ).rejects.toThrow('pg-boss schema installation failed');

    class StopFailureRuntime extends FakeMigrationRuntime {
      override async stop(): Promise<void> {
        this.events.push('stop');
        throw new Error('private shutdown detail');
      }
    }
    await expect(
      installPgBossSchema({
        databaseUrl: 'postgresql://migration:secret@postgres/emdo_app',
        moduleLoader: async () => ({ PgBoss: StopFailureRuntime }),
      }),
    ).rejects.toThrow('pg-boss schema installation failed');
  });

  it('rejects a runtime DSN or malformed module before migration', async () => {
    await expect(
      installPgBossSchema({
        databaseUrl: 'https://postgres/emdo_app',
        moduleLoader: loader,
      }),
    ).rejects.toThrow('Job schema database configuration is invalid');
    await expect(
      installPgBossSchema({
        databaseUrl: 'postgresql://migration:secret@postgres/emdo_app',
        moduleLoader: async () => ({}),
      }),
    ).rejects.toThrow('pg-boss migration runtime is unavailable');
  });
});
