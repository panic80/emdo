import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const packageUrl = new URL('../package.json', import.meta.url);

describe('@emdo/db production export boundaries', () => {
  it('keeps the bare root inert and exposes only the curated Node API surface', async () => {
    const [root, api] = await Promise.all([
      import('@emdo/db'),
      import('@emdo/db/api'),
    ]);

    expect(Object.keys(root)).toEqual([]);
    expect(Object.keys(api)).toEqual(
      expect.arrayContaining([
        'createDatabaseClient',
        'PostgresSpaceAccessGrantService',
        'PostgresDataDisclosureGrantIssuer',
        'PostgresModelDisclosureGateway',
        'CanonicalRecordEnvelopeDisclosureFilter',
        'PostgresAgentMemoryRepository',
        'PostgresRunEventSource',
        'PostgresApprovalCheckpointRepository',
        'PostgresApprovalResumeBoundary',
        'PostgresSpendLedger',
        'PostgresHouseholdAdministrationService',
        'PostgresInvitationRedemptionCoordinator',
        'PostgresGoogleCalendarProviderAuthorityResolver',
        'checkPostgresGoogleOAuthRuntimeReadiness',
        'PostgresAudioRequestCoordinator',
        'PostgresAudioRequestReconciliationStore',
        'AudioRequestCoordinatorError',
        'PostgresFinanceImportRepository',
        'FinanceImportPersistenceError',
      ]),
    );
    expect(api).not.toHaveProperty('PostgresDeterministicJobExecutionStore');
    expect(api).not.toHaveProperty('PostgresScopedDomainEntityRepository');
    expect(api).not.toHaveProperty('ScopedDomainEntityError');
    expect(api).not.toHaveProperty('PostgresInvitedAccountProvisioner');
    expect(api).not.toHaveProperty('applyLockedDatabaseMigrations');
    expect(api).not.toHaveProperty('schema');
  });

  it('keeps synchronization behind its dedicated server subpath', async () => {
    const sync = await import('@emdo/db/sync');

    expect(Object.keys(sync).sort()).toEqual([
      'CanonicalSyncUploadValidator',
      'PostgresSyncRepository',
      'SyncStreamAuthorizer',
      'SyncStreamError',
      'SyncTokenService',
      'SyncUploadProcessor',
      'createPostgresSyncGatewayRuntime',
    ]);
    expect(sync).not.toHaveProperty('PostgresDataDisclosureGrantIssuer');
    expect(sync).not.toHaveProperty('createDatabaseClient');
  });

  it('marks API and sync facades as Node-only package conditions', async () => {
    const packageJson = JSON.parse(await readFile(packageUrl, 'utf8')) as {
      readonly exports: Readonly<
        Record<string, string | Readonly<Record<string, string>>>
      >;
    };

    expect(packageJson.exports['./api']).toEqual({ node: './src/api.ts' });
    expect(packageJson.exports['./sync']).toEqual({
      node: './src/sync/runtime.ts',
    });
  });
});
