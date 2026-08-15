import {
  EffectiveAuthorizationScopeFingerprintSchema,
  type EffectiveAuthorizationScopeFingerprint,
} from '@emdo/contracts';

import {
  RotatingVaultKeyProvider,
  VaultCrypto,
  type VaultKeyProvider,
} from '../../vault/crypto.js';
import {
  FetchGoogleCalendarConditionalGateway,
  GoogleCalendarFreeBusyClient,
  GoogleCalendarReadClient,
  type GoogleCalendarCredentialBroker,
  type GoogleCalendarFetch,
} from '../calendar-fetch.js';
import {
  createGoogleCalendarCredentialedLiveSmokeTarget,
  type GoogleCalendarCredentialedLiveSmokeTarget,
} from '../calendar-smoke.js';
import {
  GOOGLE_OAUTH_ENDPOINTS,
  GOOGLE_OAUTH_FETCH_LIMITS,
  FetchGoogleOAuthTransport,
  type GoogleOAuthFetch,
} from './fetch-transport.js';
import {
  GoogleCalendarOAuthService,
  type GoogleCalendarOAuthActor,
  type GoogleOAuthAuditSink,
  type GoogleOAuthAuthorizationEpochStore,
  type GoogleOAuthFlowStore,
  type GoogleOAuthGrantLease,
  type GoogleOAuthTransport,
} from './service.js';
import {
  EncryptedGoogleCalendarCredentialVault,
  type EncryptedGoogleCalendarGrantStore,
} from './vault.js';
import {
  createGoogleCalendarOAuthRouteService,
  type GoogleCalendarOAuthRouteService,
} from './routes.js';

export {
  GOOGLE_OAUTH_ENDPOINTS,
  GOOGLE_OAUTH_FETCH_LIMITS,
  FetchGoogleOAuthTransport,
  RotatingVaultKeyProvider,
};
export type {
  EncryptedGoogleCalendarGrantStore,
  GoogleCalendarCredentialedLiveSmokeTarget,
  GoogleCalendarOAuthActor,
  GoogleOAuthAuditSink,
  GoogleOAuthAuthorizationEpochStore,
  GoogleOAuthFetch,
  GoogleOAuthFlowStore,
  GoogleOAuthGrantLease,
  GoogleOAuthTransport,
  VaultKeyProvider,
};

export interface GoogleCalendarConditionalGatewayScope {
  readonly actor: GoogleCalendarOAuthActor;
  readonly authorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
}

const snapshotConditionalGatewayScope = (
  raw: unknown,
): GoogleCalendarConditionalGatewayScope => {
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Object.prototype
  ) {
    throw new Error('invalid-google-calendar-conditional-gateway-scope');
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(descriptors, 'actor') ||
    !Object.hasOwn(descriptors, 'authorizationScopeFingerprint') ||
    keys.some((key) => typeof key === 'symbol')
  ) {
    throw new Error('invalid-google-calendar-conditional-gateway-scope');
  }
  const actor = descriptors.actor;
  const authorizationScopeFingerprint =
    descriptors.authorizationScopeFingerprint;
  if (
    actor === undefined ||
    authorizationScopeFingerprint === undefined ||
    !('value' in actor) ||
    !('value' in authorizationScopeFingerprint)
  ) {
    throw new Error('invalid-google-calendar-conditional-gateway-scope');
  }
  const fingerprint = EffectiveAuthorizationScopeFingerprintSchema.safeParse(
    authorizationScopeFingerprint.value,
  );
  if (!fingerprint.success) {
    throw new Error('invalid-google-calendar-conditional-gateway-scope');
  }
  return Object.freeze({
    actor: actor.value as GoogleCalendarOAuthActor,
    authorizationScopeFingerprint: fingerprint.data,
  });
};

export interface GoogleCalendarOAuthServerRuntime {
  readonly routes: GoogleCalendarOAuthRouteService;
  readonly calendar: Readonly<{
    readonly read: GoogleCalendarReadClient;
    readonly freeBusy: GoogleCalendarFreeBusyClient;
    readonly smokeTarget: GoogleCalendarCredentialedLiveSmokeTarget;
    createConditionalGateway(
      scope: GoogleCalendarConditionalGatewayScope,
    ): FetchGoogleCalendarConditionalGateway;
  }>;
}

export interface GoogleCalendarOAuthServerRuntimeOptions {
  readonly configuration: {
    readonly calendarClientId: string;
    readonly calendarClientSecret: string;
    readonly identityClientId: string;
    readonly redirectUri: string;
    readonly stateSigningKey: Uint8Array;
  };
  readonly flowStore: GoogleOAuthFlowStore;
  readonly authorizationEpochStore: GoogleOAuthAuthorizationEpochStore;
  readonly grantStore: EncryptedGoogleCalendarGrantStore;
  readonly keyProvider: VaultKeyProvider;
  readonly transport: GoogleOAuthTransport;
  readonly calendarFetch: GoogleCalendarFetch;
  readonly calendarTimeoutMs?: number;
  readonly audit: GoogleOAuthAuditSink;
  readonly grantLease: GoogleOAuthGrantLease;
  readonly clock: () => Date;
  readonly entropy: (length: number) => Uint8Array;
}

/**
 * Node-only composition boundary. The underlying OAuth service, decrypted
 * credential records, vault crypto, and token transport are never returned.
 */
export const createGoogleCalendarOAuthServerRuntime = (
  options: GoogleCalendarOAuthServerRuntimeOptions,
): GoogleCalendarOAuthServerRuntime => {
  const service = new GoogleCalendarOAuthService({
    configuration: options.configuration,
    flowStore: options.flowStore,
    credentialVault: new EncryptedGoogleCalendarCredentialVault({
      crypto: new VaultCrypto(options.keyProvider),
      store: options.grantStore,
      clock: options.clock,
    }),
    authorizationEpochStore: options.authorizationEpochStore,
    transport: options.transport,
    audit: options.audit,
    grantLease: options.grantLease,
    clock: options.clock,
    entropy: options.entropy,
  });
  const broker: GoogleCalendarCredentialBroker = Object.freeze({
    acquireAccessTokenForCapability: (input: unknown) =>
      service.acquireAccessTokenForCapability(input),
  });
  const calendarClientOptions = {
    fetch: options.calendarFetch,
    broker,
    ...(options.calendarTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.calendarTimeoutMs }),
    clock: options.clock,
  } as const;
  const read = new GoogleCalendarReadClient(calendarClientOptions);
  const freeBusy = new GoogleCalendarFreeBusyClient(calendarClientOptions);
  return Object.freeze({
    routes: createGoogleCalendarOAuthRouteService(service),
    calendar: Object.freeze({
      read,
      freeBusy,
      smokeTarget: createGoogleCalendarCredentialedLiveSmokeTarget({
        readClient: read,
        freeBusyClient: freeBusy,
      }),
      createConditionalGateway: (
        rawScope: GoogleCalendarConditionalGatewayScope,
      ) => {
        const scope = snapshotConditionalGatewayScope(rawScope);
        return new FetchGoogleCalendarConditionalGateway({
          actor: scope.actor,
          authorizationScopeFingerprint: scope.authorizationScopeFingerprint,
          fetch: options.calendarFetch,
          broker,
          ...(options.calendarTimeoutMs === undefined
            ? {}
            : { timeoutMs: options.calendarTimeoutMs }),
          clock: options.clock,
        });
      },
    }),
  });
};
