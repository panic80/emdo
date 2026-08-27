import {
  EffectiveAuthorizationScopeFingerprintSchema,
  IdempotencyKeySchema,
  UuidSchema,
} from '@emdo/contracts';
import { z } from 'zod';

import { AuthenticatedPrincipalSchema } from '../schemas.js';
import type { AuthenticatedPrincipal } from '../services/contracts.js';

export const SYNTHETIC_FINANCE_ACCOUNT_ID =
  'synthetic-finance-account-v1' as const;

const SyntheticFinanceStagingConfigurationSchema = z.strictObject({
  allowLoopbackApiIngress: z.literal('true'),
  environment: z.literal('staging'),
  financeDocumentsEnabled: z.literal('true'),
  financeSyntheticStaging: z.literal('true'),
  syntheticDataOnly: z.literal('true'),
});

const OwnerPrincipalSchema = AuthenticatedPrincipalSchema.extend({
  privateSpaceId: UuidSchema,
  role: z.literal('owner'),
});

const AbortSignalSchema = z.custom<AbortSignal>(
  (value) =>
    value !== null &&
    typeof value === 'object' &&
    typeof (value as AbortSignal).aborted === 'boolean',
);

const ProvisionScopeSchema = z.strictObject({
  requestId: UuidSchema,
  userId: UuidSchema,
  sessionId: UuidSchema,
  householdId: UuidSchema,
  privateSpaceId: UuidSchema,
  spaceAccessGrantId: UuidSchema,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema,
  abortSignal: AbortSignalSchema,
});

const ProvisionReceiptSchema = z.object({
  status: z.enum(['applied', 'duplicate']),
});

const ProvisionResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  accountId: z.literal(SYNTHETIC_FINANCE_ACCOUNT_ID),
  status: z.enum(['applied', 'duplicate']),
});

export type SyntheticFinanceAccountProvisionerScope = z.output<
  typeof ProvisionScopeSchema
>;

/**
 * This intentionally structural port is the sole persistence authority made
 * available to the synthetic staging route. Its implementation owns the fixed
 * account payload; callers can provide neither account fields nor a scope.
 */
export interface SyntheticFinanceAccountProvisionerRepository {
  provisionSyntheticStagingAccount(input: {
    readonly scope: SyntheticFinanceAccountProvisionerScope;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export interface SyntheticFinanceAccountProvisioner {
  provision(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
    /** Bound by the internal HTTP route to the client connection lifecycle. */
    readonly abortSignal: AbortSignal;
  }): Promise<z.output<typeof ProvisionResponseSchema> | undefined>;
}

const ownerScope = (input: {
  readonly principal: AuthenticatedPrincipal;
  readonly requestId: string;
  readonly abortSignal: AbortSignal;
}): SyntheticFinanceAccountProvisionerScope | undefined => {
  const principal = OwnerPrincipalSchema.safeParse(input.principal);
  const requestId = UuidSchema.safeParse(input.requestId);
  if (!principal.success || !requestId.success || input.abortSignal.aborted) {
    return undefined;
  }
  return ProvisionScopeSchema.parse({
    requestId: requestId.data,
    userId: principal.data.userId,
    sessionId: principal.data.sessionId,
    householdId: principal.data.householdId,
    privateSpaceId: principal.data.privateSpaceId,
    spaceAccessGrantId: principal.data.spaceAccessGrantId,
    collectionAuthorizationScopeFingerprint:
      principal.data.collectionAuthorizationScopeFingerprint,
    abortSignal: input.abortSignal,
  });
};

/**
 * Creates the one fixed Finance account provisioner only for the exact local
 * synthetic Finance staging composition. The repository receives a complete
 * server-derived scope and constructs the fixed record internally.
 */
export const createSyntheticFinanceAccountProvisioner = (input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly repository: {
    provisionSyntheticStagingAccount(input: unknown): Promise<unknown>;
  };
}): SyntheticFinanceAccountProvisioner | undefined => {
  const configuration = SyntheticFinanceStagingConfigurationSchema.safeParse({
    allowLoopbackApiIngress: input.environment.EMDO_ALLOW_LOOPBACK_API_INGRESS,
    environment: input.environment.EMDO_ENVIRONMENT,
    financeDocumentsEnabled: input.environment.EMDO_FINANCE_DOCUMENTS_ENABLED,
    financeSyntheticStaging: input.environment.EMDO_FINANCE_SYNTHETIC_STAGING,
    syntheticDataOnly: input.environment.EMDO_SYNTHETIC_DATA_ONLY,
  });
  if (
    !configuration.success ||
    typeof input.repository?.provisionSyntheticStagingAccount !== 'function'
  ) {
    return undefined;
  }
  const repository =
    input.repository as SyntheticFinanceAccountProvisionerRepository;

  return Object.freeze({
    async provision(input: {
      readonly principal: AuthenticatedPrincipal;
      readonly requestId: string;
      readonly idempotencyKey: string;
      readonly abortSignal: AbortSignal;
    }) {
      const idempotencyKey = IdempotencyKeySchema.safeParse(
        input.idempotencyKey,
      );
      const abortSignal = AbortSignalSchema.safeParse(input.abortSignal);
      if (!idempotencyKey.success || !abortSignal.success) return undefined;

      const scope = ownerScope({
        principal: input.principal,
        requestId: input.requestId,
        abortSignal: abortSignal.data,
      });
      if (scope === undefined || abortSignal.data.aborted) {
        return undefined;
      }

      const receipt = ProvisionReceiptSchema.parse(
        await repository.provisionSyntheticStagingAccount({
          scope,
          idempotencyKey: idempotencyKey.data,
        }),
      );
      return ProvisionResponseSchema.parse({
        schemaVersion: 1,
        accountId: SYNTHETIC_FINANCE_ACCOUNT_ID,
        status: receipt.status,
      });
    },
  });
};
