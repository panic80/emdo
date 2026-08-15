import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { ApiServices } from '../services/contracts.js';
import {
  createProductionDurableServiceBindings,
  type ProductionDurableServiceDependencies,
} from './durable-services.js';

const databaseUrl =
  'postgresql://emdo_api_login:secret@postgres:5432/emdo_app?sslmode=disable';
const visualDecisionDatabaseUrl =
  'postgresql://emdo_visual_decision_login:secret@postgres:5432/emdo_app?sslmode=disable';
const experienceCursorKeyring = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    current: {
      keyId: 'experience.current-1',
      keyB64url: Buffer.alloc(32, 31).toString('base64url'),
    },
    previous: [],
  }),
  'utf8',
).toString('base64url');
const proposalCursorKeyring = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    current: {
      keyId: 'proposal.current-1',
      keyB64url: Buffer.alloc(32, 43).toString('base64url'),
    },
    previous: [],
  }),
  'utf8',
).toString('base64url');
const visualProofKeyring = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    current: {
      keyId: 'visual.current-1',
      keyB64url: Buffer.alloc(32, 47).toString('base64url'),
    },
    previous: [],
  }),
  'utf8',
).toString('base64url');

const experienceServices = () => ({
  activityRead: { list: vi.fn() },
  financeRead: { list: vi.fn() },
  notificationPreferences: { get: vi.fn(), update: vi.fn() },
  scheduleRead: { list: vi.fn() },
  settingsRead: { read: vi.fn() },
  shoppingRead: { list: vi.fn() },
  todayRead: { read: vi.fn() },
});

const experienceReadinessChecks = () => ({
  activityRead: vi.fn(async () => true),
  financeRead: vi.fn(async () => true),
  notificationPreferences: vi.fn(async () => true),
  scheduleRead: vi.fn(async () => true),
  settingsRead: vi.fn(async () => true),
  shoppingRead: vi.fn(async () => true),
  todayRead: vi.fn(async () => true),
});

const householdService = () => ({
  issueInvitation: vi.fn(),
  listInvitations: vi.fn(),
  revokeInvitation: vi.fn(),
  listMemberships: vi.fn(),
  changeMembershipRole: vi.fn(),
  deactivateMembership: vi.fn(),
  checkReady: vi.fn(async () => true),
});

const financeImportService = () => ({
  listDestinations: vi.fn(),
  preview: vi.fn(),
  commit: vi.fn(),
  checkReady: vi.fn(async () => true),
});

const dependencies = (): ProductionDurableServiceDependencies => {
  const services = experienceServices();
  const readinessChecks = experienceReadinessChecks();
  return {
    createDatabaseClient: vi.fn(() => ({
      scopedPool: Object.freeze({ connect: vi.fn() }) as never,
      close: vi.fn(async () => undefined),
    })),
    createExperienceReadGateways: vi.fn(() => services as never),
    createExperienceReadinessChecks: vi.fn(() => readinessChecks),
    createAudioRequestCoordinator: vi.fn(
      () =>
        ({
          checkReady: vi.fn(async () => true),
        }) as unknown as ApiServices['audioRequests'] & {
          checkReady(): Promise<boolean>;
        },
    ),
    createFinanceImportRepository: vi.fn(() => financeImportService() as never),
    createHouseholdAdministrationService: vi.fn(
      () => householdService() as never,
    ),
    createProposalQueryRepository: vi.fn(
      () =>
        ({
          list: vi.fn(),
          getDetail: vi.fn(),
          check: vi.fn(async () => true),
        }) as unknown as ApiServices['proposalQueries'] & {
          check(): Promise<boolean>;
        },
    ),
    createRunEventSource: vi.fn(
      () =>
        ({
          open: vi.fn(),
          check: vi.fn(async () => true),
        }) as unknown as ApiServices['runEvents'] & {
          check(): Promise<boolean>;
        },
    ),
    createVisualProofIssuanceGateway: vi.fn(
      () =>
        ({
          issue: vi.fn(),
          check: vi.fn(async () => true),
        }) as never,
    ),
    createVisualProposalDecisionGateway: vi.fn(
      () =>
        ({
          decideWithVisualProof: vi.fn(),
          checkReady: vi.fn(async () => true),
        }) as never,
    ),
    createSyncGatewayRuntime: vi.fn(
      () =>
        ({
          gateway: {
            registerClient: vi.fn(),
            issueToken: vi.fn(),
            applyOperations: vi.fn(),
          },
          jwks: { getPublicJwks: vi.fn() },
          checkReady: vi.fn(async () => true),
        }) as never,
    ),
  };
};

describe('production durable API service composition', () => {
  it('does not open a pool or invent adapters without the API database URL', async () => {
    const adapters = dependencies();
    const result = await createProductionDurableServiceBindings({}, adapters);

    expect(result.bindings).toEqual({});
    expect(result.close).toBeUndefined();
    expect(adapters.createDatabaseClient).not.toHaveBeenCalled();
  });

  it('shares one API pool across audio and all durable experience reads', async () => {
    const adapters = dependencies();
    const result = await createProductionDurableServiceBindings(
      {
        EMDO_API_DATABASE_URL: databaseUrl,
        EMDO_EXPERIENCE_CURSOR_HMAC_KEYRING_B64URL: experienceCursorKeyring,
      },
      adapters,
    );

    expect(adapters.createDatabaseClient).toHaveBeenCalledOnce();
    expect(adapters.createExperienceReadGateways).toHaveBeenCalledOnce();
    expect(adapters.createExperienceReadGateways).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
    );
    expect(adapters.createAudioRequestCoordinator).toHaveBeenCalledOnce();
    expect(result.bindings).toMatchObject({
      activityRead: {
        service: expect.any(Object),
        check: expect.any(Function),
      },
      financeRead: { service: expect.any(Object), check: expect.any(Function) },
      notificationPreferences: {
        service: expect.any(Object),
        check: expect.any(Function),
      },
      scheduleRead: {
        service: expect.any(Object),
        check: expect.any(Function),
      },
      settingsRead: {
        service: expect.any(Object),
        check: expect.any(Function),
      },
      shoppingRead: {
        service: expect.any(Object),
        check: expect.any(Function),
      },
      todayRead: { service: expect.any(Object), check: expect.any(Function) },
      audioRequests: {
        service: expect.any(Object),
        check: expect.any(Function),
      },
    });
    await expect(result.bindings.activityRead!.check()).resolves.toBe(true);
    await expect(result.bindings.audioRequests!.check()).resolves.toBe(true);
    expect(adapters.createExperienceReadinessChecks).toHaveBeenCalledOnce();
    const checks = vi.mocked(adapters.createExperienceReadinessChecks).mock
      .results[0]!.value;
    expect(checks.activityRead).toHaveBeenCalledOnce();
    expect(checks.financeRead).not.toHaveBeenCalled();
    await result.close?.();
    const database = vi.mocked(adapters.createDatabaseClient).mock.results[0]!
      .value;
    expect(database.close).toHaveBeenCalledOnce();
  });

  it('binds finance imports to the existing API scoped pool through its exact readiness probe', async () => {
    const adapters = dependencies();
    const imports = financeImportService();
    const createFinanceImportRepository = vi.fn(() => imports);
    Object.assign(adapters, { createFinanceImportRepository });

    const result = await createProductionDurableServiceBindings(
      { EMDO_API_DATABASE_URL: databaseUrl },
      adapters,
    );

    const database = vi.mocked(adapters.createDatabaseClient).mock.results[0]!
      .value;
    expect(createFinanceImportRepository).toHaveBeenCalledOnce();
    expect(createFinanceImportRepository).toHaveBeenCalledWith(
      database.scopedPool,
    );
    expect(result.bindings.financeImports).toMatchObject({
      service: imports,
      check: expect.any(Function),
    });
    await expect(result.bindings.financeImports!.check()).resolves.toBe(true);
    expect(imports.checkReady).toHaveBeenCalledOnce();

    await result.close?.();
    await result.close?.();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it('binds authenticated run-event replay to the existing API scoped pool', async () => {
    const adapters = dependencies();
    const result = await createProductionDurableServiceBindings(
      { EMDO_API_DATABASE_URL: databaseUrl },
      adapters,
    );

    const database = vi.mocked(adapters.createDatabaseClient).mock.results[0]!
      .value;
    expect(adapters.createRunEventSource).toHaveBeenCalledOnce();
    expect(adapters.createRunEventSource).toHaveBeenCalledWith(
      database.scopedPool,
    );
    expect(result.bindings.runEvents).toMatchObject({
      service: { open: expect.any(Function) },
      check: expect.any(Function),
    });
    await expect(result.bindings.runEvents!.check()).resolves.toBe(true);

    await result.close?.();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it('maps a false finance import repository probe to an unavailable binding result', async () => {
    const adapters = dependencies();
    const imports = financeImportService();
    imports.checkReady.mockResolvedValue(false);
    const createFinanceImportRepository = vi.fn(() => imports);
    Object.assign(adapters, { createFinanceImportRepository });

    const result = await createProductionDurableServiceBindings(
      { EMDO_API_DATABASE_URL: databaseUrl },
      adapters,
    );

    await expect(result.bindings.financeImports!.check()).resolves.toBe(false);
    expect(createFinanceImportRepository).toHaveBeenCalledOnce();
    expect(imports.checkReady).toHaveBeenCalledOnce();
  });

  it('keeps each experience readiness component isolated to its own exact probe', async () => {
    const adapters = dependencies();
    const checks = experienceReadinessChecks();
    checks.activityRead.mockResolvedValue(false);
    vi.mocked(adapters.createExperienceReadinessChecks).mockReturnValue(checks);
    const result = await createProductionDurableServiceBindings(
      {
        EMDO_API_DATABASE_URL: databaseUrl,
        EMDO_EXPERIENCE_CURSOR_HMAC_KEYRING_B64URL: experienceCursorKeyring,
      },
      adapters,
    );

    await expect(
      Promise.all([
        result.bindings.activityRead!.check(),
        result.bindings.financeRead!.check(),
        result.bindings.notificationPreferences!.check(),
        result.bindings.scheduleRead!.check(),
        result.bindings.settingsRead!.check(),
        result.bindings.shoppingRead!.check(),
        result.bindings.todayRead!.check(),
      ]),
    ).resolves.toEqual([false, true, true, true, true, true, true]);
    for (const check of Object.values(checks)) {
      expect(check).toHaveBeenCalledOnce();
    }
  });

  it('keeps independently constructed durable capabilities when one adapter cannot initialize', async () => {
    const audioFailure = dependencies();
    vi.mocked(audioFailure.createAudioRequestCoordinator).mockImplementation(
      () => {
        throw new Error('audio adapter unavailable');
      },
    );
    const experienceOnly = await createProductionDurableServiceBindings(
      {
        EMDO_API_DATABASE_URL: databaseUrl,
        EMDO_EXPERIENCE_CURSOR_HMAC_KEYRING_B64URL: experienceCursorKeyring,
      },
      audioFailure,
    );
    expect(experienceOnly.bindings).toMatchObject({
      activityRead: {
        service: expect.any(Object),
        check: expect.any(Function),
      },
      financeRead: { service: expect.any(Object), check: expect.any(Function) },
      notificationPreferences: {
        service: expect.any(Object),
        check: expect.any(Function),
      },
      shoppingRead: {
        service: expect.any(Object),
        check: expect.any(Function),
      },
    });
    expect(experienceOnly.bindings).not.toHaveProperty('audioRequests');
    expect(experienceOnly.close).toBeTypeOf('function');

    const experienceFailure = dependencies();
    vi.mocked(
      experienceFailure.createExperienceReadGateways,
    ).mockImplementation(() => {
      throw new Error('experience adapter unavailable');
    });
    const audioOnly = await createProductionDurableServiceBindings(
      {
        EMDO_API_DATABASE_URL: databaseUrl,
        EMDO_EXPERIENCE_CURSOR_HMAC_KEYRING_B64URL: experienceCursorKeyring,
      },
      experienceFailure,
    );
    expect(audioOnly.bindings).toMatchObject({
      audioRequests: {
        service: expect.any(Object),
        check: expect.any(Function),
      },
    });
    expect(audioOnly.bindings).not.toHaveProperty('activityRead');
    expect(audioOnly.close).toBeTypeOf('function');
  });

  it('binds authenticated proposal reads only with the dedicated cursor keyring', async () => {
    const adapters = dependencies();
    const result = await createProductionDurableServiceBindings(
      {
        EMDO_API_DATABASE_URL: databaseUrl,
        EMDO_PROPOSAL_CURSOR_HMAC_KEYRING_B64URL: proposalCursorKeyring,
      },
      adapters,
    );

    expect(adapters.createProposalQueryRepository).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
    );
    expect(result.bindings.proposalQueries).toMatchObject({
      service: {
        list: expect.any(Function),
        getDetail: expect.any(Function),
      },
      check: expect.any(Function),
    });
    await expect(result.bindings.proposalQueries!.check()).resolves.toBe(true);

    const malformedAdapters = dependencies();
    const malformed = await createProductionDurableServiceBindings(
      {
        EMDO_API_DATABASE_URL: databaseUrl,
        EMDO_PROPOSAL_CURSOR_HMAC_KEYRING_B64URL: `${proposalCursorKeyring}=`,
      },
      malformedAdapters,
    );
    expect(malformed.bindings).not.toHaveProperty('proposalQueries');
    expect(
      malformedAdapters.createProposalQueryRepository,
    ).not.toHaveBeenCalled();
  });

  it('binds visual proof issuance and decision commits through distinct API and decision-only pools', async () => {
    const adapters = dependencies();
    const result = await createProductionDurableServiceBindings(
      {
        EMDO_API_DATABASE_URL: databaseUrl,
        EMDO_VISUAL_DECISION_DATABASE_URL: visualDecisionDatabaseUrl,
        EMDO_VISUAL_PROOF_HMAC_KEYRING_B64URL: visualProofKeyring,
      },
      adapters,
    );

    expect(adapters.createDatabaseClient).toHaveBeenCalledTimes(2);
    expect(adapters.createDatabaseClient).toHaveBeenNthCalledWith(1, {
      connectionString: databaseUrl,
      applicationName: 'emdo-api',
    });
    expect(adapters.createDatabaseClient).toHaveBeenNthCalledWith(2, {
      connectionString: visualDecisionDatabaseUrl,
      applicationName: 'emdo-api-visual-decision',
    });
    const apiDatabase = vi.mocked(adapters.createDatabaseClient).mock
      .results[0]!.value;
    const decisionDatabase = vi.mocked(adapters.createDatabaseClient).mock
      .results[1]!.value;
    expect(adapters.createVisualProofIssuanceGateway).toHaveBeenCalledWith(
      apiDatabase.scopedPool,
      expect.any(Object),
    );
    expect(adapters.createVisualProposalDecisionGateway).toHaveBeenCalledWith({
      readPool: apiDatabase.scopedPool,
      decisionPool: decisionDatabase.scopedPool,
    });
    expect(result.bindings).toMatchObject({
      visualProofs: {
        service: { issue: expect.any(Function) },
        check: expect.any(Function),
      },
      proposals: {
        service: { decideWithVisualProof: expect.any(Function) },
        check: expect.any(Function),
      },
    });
    await expect(result.bindings.visualProofs!.check()).resolves.toBe(true);
    await expect(result.bindings.proposals!.check()).resolves.toBe(true);

    await result.close?.();
    expect(apiDatabase.close).toHaveBeenCalledOnce();
    expect(decisionDatabase.close).toHaveBeenCalledOnce();
  });

  it('does not open the decision pool for malformed visual authority configuration', async () => {
    const adapters = dependencies();
    const result = await createProductionDurableServiceBindings(
      {
        EMDO_API_DATABASE_URL: databaseUrl,
        EMDO_VISUAL_DECISION_DATABASE_URL: visualDecisionDatabaseUrl,
        EMDO_VISUAL_PROOF_HMAC_KEYRING_B64URL: `${visualProofKeyring}=`,
      },
      adapters,
    );

    expect(adapters.createDatabaseClient).toHaveBeenCalledOnce();
    expect(adapters.createVisualProofIssuanceGateway).not.toHaveBeenCalled();
    expect(adapters.createVisualProposalDecisionGateway).not.toHaveBeenCalled();
    expect(result.bindings).not.toHaveProperty('visualProofs');
    expect(result.bindings).not.toHaveProperty('proposals');
  });

  it('does not reuse the broad workflow login for the public visual-decision path', async () => {
    const adapters = dependencies();
    const result = await createProductionDurableServiceBindings(
      {
        EMDO_API_DATABASE_URL: databaseUrl,
        EMDO_WORKFLOW_DATABASE_URL:
          'postgresql://emdo_workflow_login:secret@postgres:5432/emdo_app?sslmode=disable',
        EMDO_VISUAL_PROOF_HMAC_KEYRING_B64URL: visualProofKeyring,
      },
      adapters,
    );

    expect(adapters.createDatabaseClient).toHaveBeenCalledOnce();
    expect(adapters.createVisualProofIssuanceGateway).not.toHaveBeenCalled();
    expect(adapters.createVisualProposalDecisionGateway).not.toHaveBeenCalled();
    expect(result.bindings).not.toHaveProperty('visualProofs');
    expect(result.bindings).not.toHaveProperty('proposals');
  });

  it('retains a failed partial workflow close for the process-level cleanup retry', async () => {
    const adapters = dependencies();
    const apiDatabase = {
      scopedPool: Object.freeze({ connect: vi.fn() }) as never,
      close: vi.fn(async () => undefined),
    };
    const decisionClose = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('decision close interrupted'))
      .mockResolvedValueOnce(undefined);
    const decisionDatabase = {
      scopedPool: Object.freeze({ connect: vi.fn() }) as never,
      close: decisionClose,
    };
    vi.mocked(adapters.createDatabaseClient)
      .mockReturnValueOnce(apiDatabase)
      .mockReturnValueOnce(decisionDatabase);
    vi.mocked(
      adapters.createVisualProposalDecisionGateway,
    ).mockImplementationOnce(() => {
      throw new Error('visual decision adapter unavailable');
    });

    const result = await createProductionDurableServiceBindings(
      {
        EMDO_API_DATABASE_URL: databaseUrl,
        EMDO_VISUAL_DECISION_DATABASE_URL: visualDecisionDatabaseUrl,
        EMDO_VISUAL_PROOF_HMAC_KEYRING_B64URL: visualProofKeyring,
      },
      adapters,
    );

    expect(decisionClose).toHaveBeenCalledOnce();
    expect(result.bindings).not.toHaveProperty('visualProofs');
    expect(result.bindings).not.toHaveProperty('proposals');
    await result.close?.();
    expect(decisionClose).toHaveBeenCalledTimes(2);
    expect(apiDatabase.close).toHaveBeenCalledOnce();
  });

  it('binds household administration only with a valid public delivery key', async () => {
    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2_048 });
    const publicKey = keyPair.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64url');
    const adapters = dependencies();
    const configured = await createProductionDurableServiceBindings(
      {
        EMDO_API_DATABASE_URL: databaseUrl,
        EMDO_INVITATION_DELIVERY_KEY_ID: 'invitation-delivery-2026-08',
        EMDO_INVITATION_DELIVERY_PUBLIC_KEY_SPKI_BASE64URL: publicKey,
      },
      adapters,
    );

    expect(
      adapters.createHouseholdAdministrationService,
    ).toHaveBeenCalledOnce();
    await expect(
      configured.bindings.householdAdministration!.check(),
    ).resolves.toBe(true);

    const malformedAdapters = dependencies();
    const malformed = await createProductionDurableServiceBindings(
      {
        EMDO_API_DATABASE_URL: databaseUrl,
        EMDO_INVITATION_DELIVERY_KEY_ID: 'invitation-delivery-2026-08',
        EMDO_INVITATION_DELIVERY_PUBLIC_KEY_SPKI_BASE64URL: `${publicKey}=`,
      },
      malformedAdapters,
    );
    expect(malformed.bindings).not.toHaveProperty('householdAdministration');
    expect(
      malformedAdapters.createHouseholdAdministrationService,
    ).not.toHaveBeenCalled();
  });

  it('decodes the versioned JWT key ring and binds same-origin sync plus JWKS', async () => {
    const signingPair = generateKeyPairSync('rsa', { modulusLength: 2_048 });
    const keyring = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        current: {
          kid: 'sync.current-1',
          privatePkcs8DerB64url: signingPair.privateKey
            .export({ format: 'der', type: 'pkcs8' })
            .toString('base64url'),
        },
        previous: [],
      }),
      'utf8',
    ).toString('base64url');
    const adapters = dependencies();
    const result = await createProductionDurableServiceBindings(
      {
        EMDO_API_DATABASE_URL: databaseUrl,
        EMDO_PUBLIC_ORIGIN: 'https://emdo.example',
        EMDO_SYNC_JWT_KEYRING_B64URL: keyring,
        EMDO_SYNC_JWT_PRIVATE_KEY: 'old-format-must-not-be-consumed',
      },
      adapters,
    );

    expect(adapters.createSyncGatewayRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        publicOrigin: 'https://emdo.example',
        powerSyncEndpoint: 'https://emdo.example/powersync',
        keyRing: {
          current: {
            kid: 'sync.current-1',
            privateKey: expect.objectContaining({ type: 'private' }),
          },
          previous: [],
        },
      }),
    );
    expect(result.bindings).toMatchObject({
      sync: { service: expect.any(Object), check: expect.any(Function) },
      jwks: { service: expect.any(Object), check: expect.any(Function) },
    });
    const syncRuntime = vi.mocked(adapters.createSyncGatewayRuntime).mock
      .results[0]!.value;
    await expect(
      Promise.all([
        result.bindings.sync!.check(),
        result.bindings.jwks!.check(),
      ]),
    ).resolves.toEqual([true, true]);
    expect(syncRuntime.checkReady).toHaveBeenCalledOnce();
  });
});
