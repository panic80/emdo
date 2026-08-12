import { webcrypto } from 'node:crypto';

import {
  ExperienceQueryCursorCodec,
  PostgresAudioRequestCoordinator,
  PostgresHouseholdAdministrationService,
  PostgresProposalQueryRepository,
  ProposalQueryCursorCodec,
  createDatabaseClient,
  createPostgresExperienceReadGateways,
  createPostgresExperienceReadinessChecks,
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
import { parseProductionExperienceCursorKeyring } from './experience-cursor-keyring.js';
import { parseProductionProposalCursorKeyring } from './proposal-cursor-keyring.js';
import { parseProductionSyncJwtKeyring } from './sync-keyring.js';
import type { ProductionApiServiceBindings } from './unavailable-services.js';

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
type ReadyHouseholdAdministration = ApiServices['householdAdministration'] & {
  checkReady(): Promise<boolean>;
};
type ReadyProposalQueryRepository = ApiServices['proposalQueries'] & {
  check(): Promise<boolean>;
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
  readonly createHouseholdAdministrationService: (
    pool: DatabaseRuntime['scopedPool'],
    sealer: HouseholdInvitationSecretSealer,
  ) => ReadyHouseholdAdministration;
  readonly createProposalQueryRepository: (
    pool: DatabaseRuntime['scopedPool'],
    cursorCodec: ProposalQueryCursorCodec,
  ) => ReadyProposalQueryRepository;
  readonly createSyncGatewayRuntime: (input: {
    readonly pool: DatabaseRuntime['scopedPool'];
    readonly publicOrigin: string;
    readonly powerSyncEndpoint: string;
    readonly keyRing: PostgresSyncGatewayKeyRing;
  }) => PostgresSyncGatewayRuntime;
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
    createHouseholdAdministrationService: (
      pool: DatabaseRuntime['scopedPool'],
      sealer: HouseholdInvitationSecretSealer,
    ) => new PostgresHouseholdAdministrationService(pool, sealer),
    createProposalQueryRepository: (
      pool: DatabaseRuntime['scopedPool'],
      cursorCodec: ProposalQueryCursorCodec,
    ) => new PostgresProposalQueryRepository(pool, cursorCodec),
    createSyncGatewayRuntime: (input: {
      readonly pool: DatabaseRuntime['scopedPool'];
      readonly publicOrigin: string;
      readonly powerSyncEndpoint: string;
      readonly keyRing: PostgresSyncGatewayKeyRing;
    }) => createPostgresSyncGatewayRuntime(input),
  },
);

const DatabaseUrlSchema = z
  .url()
  .max(2_048)
  .refine((value) =>
    ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
  );
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
    await database.close().catch(() => undefined);
    return Object.freeze({ bindings: Object.freeze({}) });
  }
  return Object.freeze({
    bindings: Object.freeze(bindings),
    close: () => database.close(),
  });
};
