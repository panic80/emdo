import { webcrypto } from 'node:crypto';

import {
  ExperienceQueryCursorCodec,
  PostgresFinanceImportRepository,
  PostgresAudioRequestCoordinator,
  PostgresHouseholdAdministrationService,
  PostgresProviderFreeShoppingService,
  PostgresProposalQueryRepository,
  PostgresRunEventSource,
  PostgresVisualDecisionProofStore,
  ProposalQueryCursorCodec,
  type VisualDecisionProofTokenCodec,
  createDatabaseClient,
  createPostgresExperienceReadGateways,
  createPostgresExperienceReadinessChecks,
  checkPostgresProposalWorkflowReadiness,
  type EmdoDatabaseClient,
  type InvitationDeliverySecretSealer as HouseholdInvitationSecretSealer,
  type PostgresExperienceReadinessChecks,
} from '@emdo/db/api';
import {
  createPostgresSyncGatewayRuntime,
  type PostgresSyncGatewayKeyRing,
  type PostgresSyncGatewayRuntime,
} from '@emdo/db/sync';
import { InvitationDeliverySecretSealer } from '@emdo/integrations/email';
import { z } from 'zod';

import type { ApiServices } from '../services/contracts.js';
import {
  createProductionAgentPersistence,
  createProviderFreeAgentPersistence,
} from '../agents/production-persistence.js';
import type { ProductionAgentRuntimeFactory } from '../agents/production-runtime.js';
import { createProductionApprovalCheckpointCipher } from './approval-checkpoint-keyring.js';
import { createRequestScopedCoreAgentRuntimeFactory } from './core-agent-services.js';
import { createProductionOpenAiAgentServiceBundle } from './core-openai-services.js';
import { parseProductionExperienceCursorKeyring } from './experience-cursor-keyring.js';
import {
  createProductionGoogleConnectorBinding,
  type ProductionGoogleConnectorComposition,
} from './google-services.js';
import { parseProductionProposalCursorKeyring } from './proposal-cursor-keyring.js';
import { parseProductionSyncJwtKeyring } from './sync-keyring.js';
import type { ProductionApiServiceBindings } from './unavailable-services.js';
import { PostgresVisualProposalDecisionGateway } from './visual-approval-services.js';
import { createProductionVisualProofTokenCodec } from './visual-proof-keyring.js';
import {
  createProductionVoiceProviderBinding,
  type ProductionVoiceProviderComposition,
} from './voice-services.js';

type DatabaseRuntime = Pick<EmdoDatabaseClient, 'scopedPool' | 'close'>;
type ExperienceReadGateways = Pick<
  ApiServices,
  | 'activityRead'
  | 'financeRead'
  | 'notificationPreferences'
  | 'scheduleRead'
  | 'settingsRead'
  | 'shoppingRead'
  | 'todayRead'
>;
type ReadyAudioCoordinator = ApiServices['audioRequests'] & {
  checkReady(): Promise<boolean>;
};
type ReadyFinanceImportRepository = ApiServices['financeImports'] & {
  checkReady(): Promise<boolean>;
};
type ReadyHouseholdAdministration = ApiServices['householdAdministration'] & {
  checkReady(): Promise<boolean>;
};
type ReadyProposalQueryRepository = ApiServices['proposalQueries'] & {
  check(): Promise<boolean>;
};
type ReadyRunEventSource = ApiServices['runEvents'] & {
  check(): Promise<boolean>;
};
type ReadyVisualProofIssuanceGateway = ApiServices['visualProofs'] & {
  check(): Promise<boolean>;
};
type ReadyVisualProposalDecisionGateway = ApiServices['proposals'] & {
  checkReady(): Promise<boolean>;
};

export interface ProductionDurableServiceDependencies {
  readonly createDatabaseClient: (input: {
    readonly connectionString: string;
    readonly applicationName?: string;
  }) => DatabaseRuntime;
  readonly createExperienceReadGateways: (
    pool: DatabaseRuntime['scopedPool'],
    cursorCodec: ExperienceQueryCursorCodec,
  ) => ExperienceReadGateways;
  readonly createExperienceReadinessChecks: (
    pool: DatabaseRuntime['scopedPool'],
  ) => PostgresExperienceReadinessChecks;
  readonly createAudioRequestCoordinator: (
    pool: DatabaseRuntime['scopedPool'],
  ) => ReadyAudioCoordinator;
  readonly createFinanceImportRepository: (
    pool: DatabaseRuntime['scopedPool'],
  ) => ReadyFinanceImportRepository;
  readonly createHouseholdAdministrationService: (
    pool: DatabaseRuntime['scopedPool'],
    sealer: HouseholdInvitationSecretSealer,
  ) => ReadyHouseholdAdministration;
  readonly createProposalQueryRepository: (
    pool: DatabaseRuntime['scopedPool'],
    cursorCodec: ProposalQueryCursorCodec,
  ) => ReadyProposalQueryRepository;
  readonly createRunEventSource: (
    pool: DatabaseRuntime['scopedPool'],
  ) => ReadyRunEventSource;
  readonly createVisualProofIssuanceGateway: (
    pool: DatabaseRuntime['scopedPool'],
    tokenCodec: VisualDecisionProofTokenCodec,
  ) => ReadyVisualProofIssuanceGateway;
  readonly createVisualProposalDecisionGateway: (input: {
    readonly readPool: DatabaseRuntime['scopedPool'];
    readonly decisionPool: DatabaseRuntime['scopedPool'];
  }) => ReadyVisualProposalDecisionGateway;
  readonly createSyncGatewayRuntime: (input: {
    readonly pool: DatabaseRuntime['scopedPool'];
    readonly publicOrigin: string;
    readonly powerSyncEndpoint: string;
    readonly keyRing: PostgresSyncGatewayKeyRing;
  }) => PostgresSyncGatewayRuntime;
  readonly createGoogleConnectorBinding: (input: {
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly pool: DatabaseRuntime['scopedPool'];
  }) => ProductionGoogleConnectorComposition;
  readonly createVoiceProviderBinding: (input: {
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly pool: DatabaseRuntime['scopedPool'];
  }) => ProductionVoiceProviderComposition;
  readonly createProviderFreeShoppingService: (
    pool: DatabaseRuntime['scopedPool'],
  ) => PostgresProviderFreeShoppingService;
}

const defaultDependencies: ProductionDurableServiceDependencies = Object.freeze(
  {
    createDatabaseClient: (input: {
      readonly connectionString: string;
      readonly applicationName?: string;
    }) => createDatabaseClient(input),
    createExperienceReadGateways: (
      pool: DatabaseRuntime['scopedPool'],
      cursorCodec: ExperienceQueryCursorCodec,
    ) => createPostgresExperienceReadGateways(pool, cursorCodec),
    createExperienceReadinessChecks: (pool: DatabaseRuntime['scopedPool']) =>
      createPostgresExperienceReadinessChecks(pool),
    createAudioRequestCoordinator: (pool: DatabaseRuntime['scopedPool']) =>
      new PostgresAudioRequestCoordinator(pool),
    createFinanceImportRepository: (pool: DatabaseRuntime['scopedPool']) =>
      new PostgresFinanceImportRepository(pool),
    createHouseholdAdministrationService: (
      pool: DatabaseRuntime['scopedPool'],
      sealer: HouseholdInvitationSecretSealer,
    ) => new PostgresHouseholdAdministrationService(pool, sealer),
    createProposalQueryRepository: (
      pool: DatabaseRuntime['scopedPool'],
      cursorCodec: ProposalQueryCursorCodec,
    ) => new PostgresProposalQueryRepository(pool, cursorCodec),
    createRunEventSource: (pool: DatabaseRuntime['scopedPool']) =>
      new PostgresRunEventSource(pool),
    createVisualProofIssuanceGateway: (
      pool: DatabaseRuntime['scopedPool'],
      tokenCodec: VisualDecisionProofTokenCodec,
    ) => new PostgresVisualDecisionProofStore(pool, tokenCodec),
    createVisualProposalDecisionGateway: (input: {
      readonly readPool: DatabaseRuntime['scopedPool'];
      readonly decisionPool: DatabaseRuntime['scopedPool'];
    }) => new PostgresVisualProposalDecisionGateway(input),
    createSyncGatewayRuntime: (input: {
      readonly pool: DatabaseRuntime['scopedPool'];
      readonly publicOrigin: string;
      readonly powerSyncEndpoint: string;
      readonly keyRing: PostgresSyncGatewayKeyRing;
    }) => createPostgresSyncGatewayRuntime(input),
    createGoogleConnectorBinding: (input: {
      readonly environment: Readonly<Record<string, string | undefined>>;
      readonly pool: DatabaseRuntime['scopedPool'];
    }) => createProductionGoogleConnectorBinding(input),
    createVoiceProviderBinding: (input: {
      readonly environment: Readonly<Record<string, string | undefined>>;
      readonly pool: DatabaseRuntime['scopedPool'];
    }) => createProductionVoiceProviderBinding(input),
    createProviderFreeShoppingService: (pool: DatabaseRuntime['scopedPool']) =>
      new PostgresProviderFreeShoppingService(pool),
  },
);

const DatabaseUrlSchema = z
  .url()
  .max(2_048)
  .refine((value) =>
    ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
  );
const VisualDecisionDatabaseUrlSchema = DatabaseUrlSchema.refine((value) => {
  const url = new URL(value);
  return (
    url.username === 'emdo_visual_decision_login' &&
    url.password.length > 0 &&
    url.hostname.length > 0 &&
    url.pathname === '/emdo_app' &&
    url.hash === ''
  );
});
const WorkflowDatabaseUrlSchema = DatabaseUrlSchema.refine((value) => {
  const url = new URL(value);
  return (
    url.username === 'emdo_workflow_login' &&
    url.password.length > 0 &&
    url.hostname.length > 0 &&
    url.pathname === '/emdo_app' &&
    url.hash === ''
  );
});
const InvitationDeliveryKeyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const PublicOriginSchema = z
  .url({ protocol: /^https$/u })
  .max(512)
  .refine((value) => new URL(value).origin === value);

const decodeCanonicalPublicKey = (value: string): Buffer | undefined => {
  if (
    value.length === 0 ||
    value.length > 16_384 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    return undefined;
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.length === 0 ||
    decoded.length > 8_192 ||
    decoded.toString('base64url') !== value
  ) {
    decoded.fill(0);
    return undefined;
  }
  return decoded;
};

const createInvitationDeliverySealer = async (
  environment: Readonly<Record<string, string | undefined>>,
): Promise<HouseholdInvitationSecretSealer | undefined> => {
  const keyId = environment.EMDO_INVITATION_DELIVERY_KEY_ID;
  const encodedPublicKey =
    environment.EMDO_INVITATION_DELIVERY_PUBLIC_KEY_SPKI_BASE64URL;
  if (keyId === undefined && encodedPublicKey === undefined) return undefined;
  const parsedKeyId = InvitationDeliveryKeyIdSchema.safeParse(keyId);
  if (!parsedKeyId.success || encodedPublicKey === undefined) return undefined;
  const der = decodeCanonicalPublicKey(encodedPublicKey);
  if (der === undefined) return undefined;
  try {
    const publicKey = await webcrypto.subtle.importKey(
      'spki',
      der,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt'],
    );
    return new InvitationDeliverySecretSealer({
      keyId: parsedKeyId.data,
      publicKey: publicKey as unknown as CryptoKey,
    });
  } catch {
    return undefined;
  } finally {
    der.fill(0);
  }
};

const coalesceProbe = (probe: () => Promise<boolean>) => {
  let inFlight: Promise<boolean> | undefined;
  return (): Promise<boolean> => {
    inFlight ??= Promise.resolve()
      .then(probe)
      .then(
        (ready) => ready === true,
        () => false,
      )
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
};

const createDatabaseClose = (
  databases: readonly DatabaseRuntime[],
  additionalCloses: readonly (() => Promise<void>)[] = [],
) => {
  let closePromise: Promise<void> | undefined;
  return (): Promise<void> => {
    closePromise ??= (async () => {
      const failures: unknown[] = [];
      for (const close of additionalCloses) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
      for (const database of [...databases].reverse()) {
        try {
          await database.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          'Production durable databases could not all close',
        );
      }
    })();
    return closePromise;
  };
};

export interface ProductionDurableEnvironmentComposition {
  readonly bindings: ProductionApiServiceBindings;
  readonly close?: () => Promise<void>;
}

export const createProductionDurableServiceBindings = async (
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: ProductionDurableServiceDependencies = defaultDependencies,
): Promise<ProductionDurableEnvironmentComposition> => {
  const databaseUrl = DatabaseUrlSchema.safeParse(
    environment.EMDO_API_DATABASE_URL,
  );
  if (!databaseUrl.success) {
    return Object.freeze({ bindings: Object.freeze({}) });
  }

  let database: DatabaseRuntime;
  try {
    database = dependencies.createDatabaseClient({
      connectionString: databaseUrl.data,
      applicationName: 'emdo-api',
    });
  } catch {
    return Object.freeze({ bindings: Object.freeze({}) });
  }

  const bindings: ProductionApiServiceBindings = {};
  const databases: DatabaseRuntime[] = [database];
  const additionalCloses: Array<() => Promise<void>> = [];
  const agentResourceCloses: Array<() => Promise<void>> = [];

  const providerFreeSyntheticStaging =
    environment.EMDO_ENVIRONMENT === 'staging' &&
    environment.EMDO_ALLOW_LOOPBACK_API_INGRESS === 'true' &&
    environment.EMDO_SYNTHETIC_DATA_ONLY === 'true';
  if (providerFreeSyntheticStaging) {
    try {
      const shopping = dependencies.createProviderFreeShoppingService(
        database.scopedPool,
      );
      const providerFree = createProviderFreeAgentPersistence({
        pool: database.scopedPool,
        shopping,
      });
      Object.assign(bindings, providerFree.bindings);
    } catch {
      // Provider-free manager turns remain unavailable without all three
      // durable stores; independent read-only services may still compose.
    }
  }

  let google: ProductionGoogleConnectorComposition | undefined;
  let googleCloseIsOwnedByAgent = false;
  try {
    const encodedExperienceCursorKeyring =
      environment.EMDO_EXPERIENCE_CURSOR_HMAC_KEYRING_B64URL;
    if (encodedExperienceCursorKeyring === undefined) {
      throw new Error('api-experience-cursor-keyring-missing');
    }
    const experienceCursorKeyring = parseProductionExperienceCursorKeyring(
      encodedExperienceCursorKeyring,
    );
    let experienceCursorCodec: ExperienceQueryCursorCodec;
    try {
      experienceCursorCodec = new ExperienceQueryCursorCodec(
        experienceCursorKeyring,
      );
    } finally {
      experienceCursorKeyring.current.secret.fill(0);
      for (const previous of experienceCursorKeyring.previous) {
        previous.secret.fill(0);
      }
    }
    const experience = dependencies.createExperienceReadGateways(
      database.scopedPool,
      experienceCursorCodec,
    );
    const experienceChecks = dependencies.createExperienceReadinessChecks(
      database.scopedPool,
    );
    Object.assign(bindings, {
      activityRead: {
        service: experience.activityRead,
        check: coalesceProbe(experienceChecks.activityRead),
      },
      financeRead: {
        service: experience.financeRead,
        check: coalesceProbe(experienceChecks.financeRead),
      },
      notificationPreferences: {
        service: experience.notificationPreferences,
        check: coalesceProbe(experienceChecks.notificationPreferences),
      },
      scheduleRead: {
        service: experience.scheduleRead,
        check: coalesceProbe(experienceChecks.scheduleRead),
      },
      settingsRead: {
        service: experience.settingsRead,
        check: coalesceProbe(experienceChecks.settingsRead),
      },
      shoppingRead: {
        service: experience.shoppingRead,
        check: coalesceProbe(experienceChecks.shoppingRead),
      },
      todayRead: {
        service: experience.todayRead,
        check: coalesceProbe(experienceChecks.todayRead),
      },
    } satisfies ProductionApiServiceBindings);
  } catch {
    // A missing experience projection cannot disable unrelated durable ports.
  }

  try {
    const audioRequests = dependencies.createAudioRequestCoordinator(
      database.scopedPool,
    );
    bindings.audioRequests = {
      service: audioRequests,
      check: () => audioRequests.checkReady(),
    };
  } catch {
    // Voice remains fail-closed while other independently healthy ports load.
  }

  try {
    const financeImports = dependencies.createFinanceImportRepository(
      database.scopedPool,
    );
    bindings.financeImports = {
      service: financeImports,
      check: coalesceProbe(() => financeImports.checkReady()),
    };
  } catch {
    // Import mutations remain fail-closed while the receipt boundary is unavailable.
  }

  if (!providerFreeSyntheticStaging) {
    try {
    google = dependencies.createGoogleConnectorBinding({
      environment,
      pool: database.scopedPool,
    });
    if (google.binding !== undefined) bindings.google = google.binding;
    } catch {
      // Calendar remains fail-closed unless its complete secret and DB graph loads.
    }
  }

  if (!providerFreeSyntheticStaging) {
    try {
    const voice = dependencies.createVoiceProviderBinding({
      environment,
      pool: database.scopedPool,
    });
    if (voice.binding !== undefined) bindings.voice = voice.binding;
    if (voice.close !== undefined) additionalCloses.push(voice.close);
    } catch {
    // Voice remains fail-closed unless its complete secret, inspector, and spend graph load.
    }
  }

  if (!providerFreeSyntheticStaging) {
    try {
    const runEvents = dependencies.createRunEventSource(database.scopedPool);
    bindings.runEvents = {
      service: runEvents,
      check: coalesceProbe(() => runEvents.check()),
    };
    } catch {
    // Persisted replay remains unavailable without its grant-aware aggregate.
    }
  }

  if (!providerFreeSyntheticStaging) {
    try {
      const encodedProposalCursorKeyring =
        environment.EMDO_PROPOSAL_CURSOR_HMAC_KEYRING_B64URL;
      if (encodedProposalCursorKeyring === undefined) {
        throw new Error('api-proposal-cursor-keyring-missing');
      }
      const proposalCursorKeyring = parseProductionProposalCursorKeyring(
        encodedProposalCursorKeyring,
      );
      let proposalCursorCodec: ProposalQueryCursorCodec;
      try {
        proposalCursorCodec = new ProposalQueryCursorCodec(proposalCursorKeyring);
      } finally {
        proposalCursorKeyring.current.secret.fill(0);
        for (const previous of proposalCursorKeyring.previous) {
          previous.secret.fill(0);
        }
      }
      const proposalQueries = dependencies.createProposalQueryRepository(
        database.scopedPool,
        proposalCursorCodec,
      );
      bindings.proposalQueries = {
        service: proposalQueries,
        check: coalesceProbe(() => proposalQueries.check()),
      };
    } catch {
      // Proposal reads remain fail-closed without a valid independent key ring.
    }
  }

  let unusedDecisionDatabase: DatabaseRuntime | undefined;
  if (!providerFreeSyntheticStaging) {
    try {
    const encodedVisualProofKeyring =
      environment.EMDO_VISUAL_PROOF_HMAC_KEYRING_B64URL;
    const decisionDatabaseUrl = VisualDecisionDatabaseUrlSchema.safeParse(
      environment.EMDO_VISUAL_DECISION_DATABASE_URL,
    );
    if (
      encodedVisualProofKeyring === undefined ||
      !decisionDatabaseUrl.success
    ) {
      throw new Error('api-visual-approval-configuration-missing');
    }
    const tokenCodec = createProductionVisualProofTokenCodec(
      encodedVisualProofKeyring,
    );
    const decisionDatabase = dependencies.createDatabaseClient({
      connectionString: decisionDatabaseUrl.data,
      applicationName: 'emdo-api-visual-decision',
    });
    unusedDecisionDatabase = decisionDatabase;
    const visualProofs = dependencies.createVisualProofIssuanceGateway(
      database.scopedPool,
      tokenCodec,
    );
    const proposals = dependencies.createVisualProposalDecisionGateway({
      readPool: database.scopedPool,
      decisionPool: decisionDatabase.scopedPool,
    });
    Object.assign(bindings, {
      visualProofs: {
        service: visualProofs,
        check: coalesceProbe(() => visualProofs.check()),
      },
      proposals: {
        service: proposals,
        check: coalesceProbe(() => proposals.checkReady()),
      },
    } satisfies ProductionApiServiceBindings);
    databases.push(decisionDatabase);
    unusedDecisionDatabase = undefined;
    } catch {
    if (unusedDecisionDatabase !== undefined) {
      try {
        await unusedDecisionDatabase.close();
      } catch {
        databases.push(unusedDecisionDatabase);
      }
      unusedDecisionDatabase = undefined;
    }
    // Proof issuance and decision persistence activate only as one authority graph.
    }
  }

  let unusedWorkflowDatabase: DatabaseRuntime | undefined;
  let checkpointCipher:
    | ReturnType<typeof createProductionApprovalCheckpointCipher>
    | undefined;
  let openAi = undefined as
    | ReturnType<typeof createProductionOpenAiAgentServiceBundle>
    | undefined;
  if (!providerFreeSyntheticStaging) {
    try {
    const workflowDatabaseUrl = WorkflowDatabaseUrlSchema.safeParse(
      environment.EMDO_WORKFLOW_DATABASE_URL,
    );
    const encodedCheckpointKeyring =
      environment.EMDO_APPROVAL_CHECKPOINT_KEYRING_B64URL;
    const visualDecisions = bindings.proposals?.service;
    if (
      !workflowDatabaseUrl.success ||
      encodedCheckpointKeyring === undefined ||
      visualDecisions === undefined ||
      typeof visualDecisions.decideWithVisualProof !== 'function' ||
      google?.binding === undefined ||
      typeof google.binding.check !== 'function' ||
      google.calendarProposalTargetReaders === undefined ||
      google.calendarConditionalGateways === undefined
    ) {
      throw new Error('api-core-agent-configuration-unavailable');
    }
    openAi = createProductionOpenAiAgentServiceBundle({ environment });
    if (openAi === undefined) {
      throw new Error('api-core-agent-configuration-unavailable');
    }
    checkpointCipher = createProductionApprovalCheckpointCipher(
      encodedCheckpointKeyring,
    );
    const workflowDatabase = dependencies.createDatabaseClient({
      connectionString: workflowDatabaseUrl.data,
      applicationName: 'emdo-api-workflow',
    });
    unusedWorkflowDatabase = workflowDatabase;
    const configuredOpenAi = openAi;
    const configuredCheckpointCipher = checkpointCipher;
    const checkWorkflowAndGoogle = coalesceProbe(async () => {
      const [workflow, googleReady] = await Promise.all([
        checkPostgresProposalWorkflowReadiness(workflowDatabase.scopedPool),
        google.binding!.check(),
      ]);
      return workflow === true && googleReady === true;
    });
    const checkCoreAgent = coalesceProbe(async () => {
      const [workflowAndGoogle, luna, terra] = await Promise.all([
        checkWorkflowAndGoogle(),
        configuredOpenAi.modelAvailability.isAvailable('gpt-5.6-luna'),
        configuredOpenAi.modelAvailability.isAvailable('gpt-5.6-terra'),
      ]);
      return workflowAndGoogle === true && luna === true && terra === true;
    });
    const runtimeFactory: ProductionAgentRuntimeFactory = Object.freeze({
      create: async (
        input: Parameters<ProductionAgentRuntimeFactory['create']>[0],
      ) => {
        const factory = createRequestScopedCoreAgentRuntimeFactory({
          principal: input.principal,
          requestId: input.requestId,
          runId: input.runId,
          conversationId: input.conversationId,
          readPool: database.scopedPool,
          workflowPool: workflowDatabase.scopedPool,
          google: {
            createProposalTargetReader:
              google!.calendarProposalTargetReaders!
                .createProposalTargetReader,
            createConditionalGateway:
              google!.calendarConditionalGateways!.createConditionalGateway,
          },
          openAi: configuredOpenAi,
          checkpointCipher: configuredCheckpointCipher,
          checkGlobalDependencies: checkWorkflowAndGoogle,
        });
        if (factory === undefined) {
          throw new Error('api-core-agent-runtime-unavailable');
        }
        return factory.runtime;
      },
      check: checkCoreAgent,
    });
    const agentPersistence = createProductionAgentPersistence({
      pool: database.scopedPool,
      runtimeFactory,
      visualDecisions,
    });
    Object.assign(bindings, agentPersistence.bindings);
    databases.push(workflowDatabase);
    unusedWorkflowDatabase = undefined;
    agentResourceCloses.push(configuredOpenAi.close);
    if (google.close !== undefined) {
      agentResourceCloses.push(google.close);
      googleCloseIsOwnedByAgent = true;
    }
    agentResourceCloses.push(async () => {
      configuredCheckpointCipher.dispose();
    });
    checkpointCipher = undefined;
    openAi = undefined;
    } catch {
    if (checkpointCipher !== undefined) {
      const partialCheckpointCipher = checkpointCipher;
      try {
        partialCheckpointCipher.dispose();
      } catch {
        agentResourceCloses.push(async () => {
          partialCheckpointCipher.dispose();
        });
      }
      checkpointCipher = undefined;
    }
    if (openAi !== undefined) {
      try {
        await openAi.close();
      } catch {
        agentResourceCloses.push(openAi.close);
      }
      openAi = undefined;
    }
    if (unusedWorkflowDatabase !== undefined) {
      try {
        await unusedWorkflowDatabase.close();
      } catch {
        databases.push(unusedWorkflowDatabase);
      }
      unusedWorkflowDatabase = undefined;
    }
    // Agent turns remain unavailable unless every authenticated durable boundary loads.
    }
  }

  if (!googleCloseIsOwnedByAgent && google?.close !== undefined) {
    agentResourceCloses.push(google.close);
  }

  try {
    const sealer = await createInvitationDeliverySealer(environment);
    if (sealer !== undefined) {
      const householdAdministration =
        dependencies.createHouseholdAdministrationService(
          database.scopedPool,
          sealer,
        );
      bindings.householdAdministration = {
        service: householdAdministration,
        check: () => householdAdministration.checkReady(),
      };
    }
  } catch {
    // Invalid administration dependencies do not disable read-only adapters.
  }

  try {
    const publicOrigin = PublicOriginSchema.safeParse(
      environment.EMDO_PUBLIC_ORIGIN,
    );
    const encodedSyncKeyring = environment.EMDO_SYNC_JWT_KEYRING_B64URL;
    if (publicOrigin.success && encodedSyncKeyring !== undefined) {
      const parsedKeyring = parseProductionSyncJwtKeyring(encodedSyncKeyring);
      const syncRuntime = dependencies.createSyncGatewayRuntime({
        pool: database.scopedPool,
        publicOrigin: publicOrigin.data,
        powerSyncEndpoint: `${publicOrigin.data}/powersync`,
        keyRing: {
          current: parsedKeyring.current,
          previous: parsedKeyring.previous,
        },
      });
      const syncCheck = coalesceProbe(syncRuntime.checkReady);
      bindings.sync = {
        service: syncRuntime.gateway,
        check: syncCheck,
      };
      bindings.jwks = {
        service: syncRuntime.jwks,
        check: syncCheck,
      };
    }
  } catch {
    // A malformed key ring never falls back to the retired PEM variables.
  }

  if (Object.keys(bindings).length === 0) {
    await createDatabaseClose(
      databases,
      [...agentResourceCloses, ...additionalCloses],
    )().catch(
      () => undefined,
    );
    return Object.freeze({ bindings: Object.freeze({}) });
  }
  const close = createDatabaseClose(databases, [
    ...agentResourceCloses,
    ...additionalCloses,
  ]);
  return Object.freeze({
    bindings: Object.freeze(bindings),
    close,
  });
};
