import {
  IdentifierSchema,
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  SemanticVersionSchema,
  Sha256Schema,
  deepFreeze,
  type DeepReadonly,
} from '@emdo/contracts';
import { z } from 'zod';

import { isBoundedAcyclicData } from './bounded.js';
import {
  normalizeCommerceOfferCandidate,
  ProductUrlPolicySchema,
  type NormalizedCommerceOffer,
  type ProductUrlPolicy,
} from './offers.js';

const ConnectorCapabilitiesSchema = z
  .array(z.enum(['offers.read', 'product.link-out']))
  .length(2)
  .superRefine((capabilities, context) => {
    if (
      new Set(capabilities).size !== 2 ||
      !capabilities.includes('offers.read') ||
      !capabilities.includes('product.link-out')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Commerce connectors are read and link-out only',
      });
    }
  });

const ManifestBase = {
  schemaVersion: z.literal(1),
  providerId: IdentifierSchema,
  retailerId: IdentifierSchema,
  sourceKind: z.enum(['official-api', 'affiliate-feed']),
  capabilities: ConnectorCapabilitiesSchema,
  productUrlPolicy: ProductUrlPolicySchema,
} as const;

export const CommerceConnectorManifestSchema = z.discriminatedUnion(
  'environment',
  [
    z.strictObject({
      ...ManifestBase,
      environment: z.literal('fixture'),
    }),
    z.strictObject({
      ...ManifestBase,
      environment: z.literal('provider'),
    }),
  ],
);

export const CommerceOfferRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(300),
  postalCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/)
    .optional(),
  limit: z.number().int().positive().max(50),
});

const CommerceRefreshResponseSchema = z.strictObject({
  candidates: z.array(z.unknown()).max(50),
});

export type CommerceOfferRequest = DeepReadonly<
  z.output<typeof CommerceOfferRequestSchema>
>;
export type CommerceConnectorManifest = DeepReadonly<
  z.output<typeof CommerceConnectorManifestSchema>
>;

export const CommerceConnectorDeploymentApprovalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  approvalId: IdentifierSchema,
  providerId: IdentifierSchema,
  retailerId: IdentifierSchema,
  sourceKind: z.enum(['official-api', 'affiliate-feed']),
  productUrlPolicy: ProductUrlPolicySchema,
  accessApprovalReference: OpaqueReferenceSchema,
  termsReviewedAt: IsoDateTimeSchema,
  conformance: z.strictObject({
    suiteVersion: SemanticVersionSchema,
    fixtureDigest: Sha256Schema,
    verifiedAt: IsoDateTimeSchema,
  }),
});

export type CommerceConnectorDeploymentApproval = DeepReadonly<
  z.output<typeof CommerceConnectorDeploymentApprovalSchema>
>;

export interface CommerceReadConnector {
  readonly manifest: CommerceConnectorManifest;
  /** Read-only provider operation. No login, cart, purchase, or checkout API. */
  refreshOffers(
    request: CommerceOfferRequest,
    context: { readonly signal: AbortSignal },
  ): Promise<unknown>;
}

export interface FixtureCommerceConnector extends CommerceReadConnector {
  readonly manifest: Extract<
    CommerceConnectorManifest,
    { readonly environment: 'fixture' }
  >;
}

export interface ResolvedApprovedCommerceConnector {
  readonly connector: CommerceReadConnector;
  readonly approval: CommerceConnectorDeploymentApproval;
}

interface CommerceConnectorRegistryState {
  readonly approved: ReadonlyMap<string, ResolvedApprovedCommerceConnector>;
}

const connectorRegistryStates = new WeakMap<
  CommerceConnectorRegistry,
  CommerceConnectorRegistryState
>();
const connectorRegistryConstructorToken = Symbol('commerce-registry');

export class CommerceConnectorRegistry {
  constructor(token: symbol, state: CommerceConnectorRegistryState) {
    if (token !== connectorRegistryConstructorToken) {
      throw new Error('Commerce connector registry construction is private');
    }
    connectorRegistryStates.set(this, state);
    Object.freeze(this);
  }
}

export const resolveApprovedCommerceConnector = (
  registry: CommerceConnectorRegistry,
  providerId: string,
): ResolvedApprovedCommerceConnector | undefined => {
  const parsed = IdentifierSchema.safeParse(providerId);
  if (!parsed.success) return undefined;
  return connectorRegistryStates.get(registry)?.approved.get(parsed.data);
};

const connectorApprovalBinding = (input: {
  readonly providerId: string;
  readonly retailerId: string;
  readonly sourceKind: 'official-api' | 'affiliate-feed';
  readonly productUrlPolicy: ProductUrlPolicy;
}): string =>
  JSON.stringify({
    providerId: input.providerId,
    retailerId: input.retailerId,
    sourceKind: input.sourceKind,
    productUrlPolicy: input.productUrlPolicy,
  });

export const createCommerceConnectorRegistry = (input: {
  readonly connectors: readonly CommerceReadConnector[];
  readonly deploymentApprovals: readonly unknown[];
}): CommerceConnectorRegistry => {
  try {
    if (input.connectors.length > 64 || input.deploymentApprovals.length > 64) {
      throw new Error('invalid');
    }
    const connectors = new Map<
      string,
      {
        readonly connector: CommerceReadConnector;
        readonly manifest: CommerceConnectorManifest;
      }
    >();
    for (const connector of input.connectors) {
      const manifest = CommerceConnectorManifestSchema.parse(
        connector.manifest,
      );
      if (connectors.has(manifest.providerId)) throw new Error('invalid');
      connectors.set(manifest.providerId, { connector, manifest });
    }

    const approvals = new Map<string, CommerceConnectorDeploymentApproval>();
    for (const value of input.deploymentApprovals) {
      const approval = deepFreeze(
        CommerceConnectorDeploymentApprovalSchema.parse(value),
      );
      if (approvals.has(approval.providerId)) throw new Error('invalid');
      approvals.set(approval.providerId, approval);
    }

    const approved = new Map<string, ResolvedApprovedCommerceConnector>();
    for (const [providerId, approval] of approvals) {
      const registration = connectors.get(providerId);
      if (
        registration === undefined ||
        registration.manifest.environment !== 'provider' ||
        connectorApprovalBinding(registration.manifest) !==
          connectorApprovalBinding(approval)
      ) {
        throw new Error('binding');
      }
      approved.set(
        providerId,
        Object.freeze({ connector: registration.connector, approval }),
      );
    }

    return new CommerceConnectorRegistry(connectorRegistryConstructorToken, {
      approved,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'binding') {
      throw new Error('Commerce connector approval binding is invalid');
    }
    throw new Error('Commerce connector registry configuration is invalid');
  }
};

export const parseCommerceOfferRequest = (
  input: unknown,
): CommerceOfferRequest | undefined => {
  if (!isBoundedAcyclicData(input)) return undefined;
  const parsed = CommerceOfferRequestSchema.safeParse(input);
  return parsed.success ? deepFreeze(parsed.data) : undefined;
};

export const parseCommerceRefreshResponse = (
  input: unknown,
): DeepReadonly<{ candidates: unknown[] }> | undefined => {
  if (!isBoundedAcyclicData(input)) return undefined;
  const parsed = CommerceRefreshResponseSchema.safeParse(input);
  return parsed.success ? deepFreeze(parsed.data) : undefined;
};

export const RETAILER_CONNECTOR_STATUSES = deepFreeze(
  [
    ['amazon-canada', 'Amazon Canada'],
    ['best-buy-ca', 'Best Buy Canada'],
    ['canadian-tire-ca', 'Canadian Tire'],
    ['costco-ca', 'Costco Canada'],
    ['no-frills-ca', 'No Frills'],
    ['walmart-ca', 'Walmart Canada'],
  ].map(([retailerId, retailerName]) => ({
    schemaVersion: 1 as const,
    retailerId: retailerId!,
    retailerName: retailerName!,
    accessReview: 'required' as const,
    termsReview: 'required' as const,
    liveOffers: 'disabled' as const,
    ordinaryLinkOut: 'disabled-pending-review' as const,
    localPrice: 'unavailable' as const,
    localInventory: 'unavailable' as const,
  })),
);

type FixtureConformanceResult =
  | DeepReadonly<{
      status: 'conformant';
      environment: 'fixture';
      handoffEligible: false;
      normalizedOffers: NormalizedCommerceOffer[];
    }>
  | DeepReadonly<{
      status: 'rejected';
      safeError: {
        code: 'commerce-connector-invalid';
        message: 'The commerce connector failed fixture conformance.';
        retryable: false;
      };
    }>;

const invalidConnector = (): FixtureConformanceResult =>
  deepFreeze({
    status: 'rejected',
    safeError: {
      code: 'commerce-connector-invalid',
      message: 'The commerce connector failed fixture conformance.',
      retryable: false,
    },
  });

export const runFixtureConnectorConformance = async (input: {
  readonly connector: FixtureCommerceConnector;
  readonly request: unknown;
  readonly now: string;
  readonly maximumAgeMs: number;
  readonly expectedOfferIds: readonly string[];
}): Promise<FixtureConformanceResult> => {
  try {
    const manifest = CommerceConnectorManifestSchema.safeParse(
      input.connector.manifest,
    );
    const request = parseCommerceOfferRequest(input.request);
    const expectedOfferIds = z
      .array(IdentifierSchema)
      .min(1)
      .max(50)
      .safeParse(input.expectedOfferIds);
    if (
      !manifest.success ||
      manifest.data.environment !== 'fixture' ||
      request === undefined ||
      !expectedOfferIds.success ||
      new Set(expectedOfferIds.data).size !== expectedOfferIds.data.length ||
      !Number.isSafeInteger(input.maximumAgeMs) ||
      input.maximumAgeMs <= 0 ||
      input.maximumAgeMs > 86_400_000 ||
      !IsoDateTimeSchema.safeParse(input.now).success
    ) {
      return invalidConnector();
    }

    const response = parseCommerceRefreshResponse(
      await input.connector.refreshOffers(request, {
        signal: new AbortController().signal,
      }),
    );
    if (response === undefined || response.candidates.length === 0) {
      return invalidConnector();
    }

    const normalizedOffers: NormalizedCommerceOffer[] = [];
    for (const candidate of response.candidates) {
      const normalized = normalizeCommerceOfferCandidate({
        candidate,
        providerId: manifest.data.providerId,
        productUrlPolicy: manifest.data.productUrlPolicy,
        now: input.now,
        maximumAgeMs: input.maximumAgeMs,
      });
      if (normalized.status !== 'accepted') return invalidConnector();
      normalizedOffers.push(normalized.normalized);
    }

    const actualOfferIds = normalizedOffers
      .map((offer) => offer.offer.id)
      .sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
    const expectedIds = [...expectedOfferIds.data].sort((left, right) =>
      left === right ? 0 : left < right ? -1 : 1,
    );
    if (JSON.stringify(actualOfferIds) !== JSON.stringify(expectedIds)) {
      return invalidConnector();
    }

    return deepFreeze({
      status: 'conformant' as const,
      environment: 'fixture' as const,
      handoffEligible: false as const,
      normalizedOffers,
    });
  } catch {
    return invalidConnector();
  }
};
