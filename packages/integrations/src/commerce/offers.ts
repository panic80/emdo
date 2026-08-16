import { isIP } from 'node:net';

import {
  CommerceOfferSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  deepFreeze,
  type CommerceOffer,
  type DeepReadonly,
} from '@emdo/contracts';
import { z } from 'zod';

import { isBoundedAcyclicData } from './bounded.js';

const KnownCostSchema = z.strictObject({
  status: z.literal('known'),
  minorUnits: z.number().int().safe().nonnegative(),
  currency: z.literal('CAD'),
});
const UnknownCostSchema = z.strictObject({
  status: z.literal('unknown'),
  reason: z.string().trim().min(1).max(300),
});
const NotApplicableCostSchema = z.strictObject({
  status: z.literal('not-applicable'),
});
const VariableCostSchema = z.discriminatedUnion('status', [
  KnownCostSchema,
  UnknownCostSchema,
  NotApplicableCostSchema,
]);
const MembershipCostSchema = z.discriminatedUnion('status', [
  NotApplicableCostSchema,
  KnownCostSchema.extend({
    condition: z.string().trim().min(1).max(300),
  }),
  UnknownCostSchema.extend({
    condition: z.string().trim().min(1).max(300),
  }),
]);
const UnknownCostDisclosureSchema = z.strictObject({
  component: z.enum(['shipping', 'tax', 'fees', 'membership', 'other']),
  reason: z.string().trim().min(1).max(300),
});

const OfferCostsSchema = z
  .strictObject({
    item: KnownCostSchema,
    shipping: VariableCostSchema,
    tax: VariableCostSchema,
    fees: VariableCostSchema,
    membership: MembershipCostSchema,
    unknown: z.array(UnknownCostDisclosureSchema).max(16),
  })
  .superRefine((costs, context) => {
    const disclosures = new Map<string, string>();
    for (const disclosure of costs.unknown) {
      if (disclosures.has(disclosure.component)) {
        context.addIssue({
          code: 'custom',
          path: ['unknown'],
          message: 'Unknown cost disclosures must be unique by component',
        });
      }
      disclosures.set(disclosure.component, disclosure.reason);
    }

    for (const component of [
      'shipping',
      'tax',
      'fees',
      'membership',
    ] as const) {
      const cost = costs[component];
      const disclosure = disclosures.get(component);
      if (
        (cost.status === 'unknown' && disclosure !== cost.reason) ||
        (cost.status !== 'unknown' && disclosure !== undefined)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['unknown'],
          message: 'Unknown cost disclosures must match unknown components',
        });
      }
    }
  });

const OfferCandidateSchema = z
  .strictObject({
    offer: CommerceOfferSchema,
    costs: OfferCostsSchema,
  })
  .superRefine((candidate, context) => {
    if (
      candidate.costs.item.minorUnits !== candidate.offer.price.minorUnits ||
      candidate.costs.item.currency !== candidate.offer.price.currency
    ) {
      context.addIssue({
        code: 'custom',
        path: ['costs', 'item'],
        message: 'Item cost must exactly match the offer price',
      });
    }

    const shipping = candidate.offer.shipping;
    const normalizedShipping = candidate.costs.shipping;
    if (
      shipping.status === 'known'
        ? normalizedShipping.status !== 'known' ||
          normalizedShipping.minorUnits !== shipping.minorUnits ||
          normalizedShipping.currency !== shipping.currency
        : normalizedShipping.status !== 'unknown' ||
          normalizedShipping.reason !== shipping.reason
    ) {
      context.addIssue({
        code: 'custom',
        path: ['costs', 'shipping'],
        message: 'Shipping cost must exactly match the offer',
      });
    }
  });

const AllowedHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
  .refine(
    (host) =>
      host !== 'localhost' && !host.endsWith('.local') && isIP(host) === 0,
    'Host must be a public DNS name',
  );

const ProductPathTemplateSchema = z
  .string()
  .trim()
  .min(11)
  .max(300)
  .regex(/^\/[A-Za-z0-9._~/-]*\{product\}[A-Za-z0-9._~/-]*$/)
  .refine(
    (template) =>
      template.indexOf('{product}') === template.lastIndexOf('{product}') &&
      !template.includes('//') &&
      !template.split('/').includes('..'),
    'Expected one safe product path placeholder',
  );

const QueryParameterSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._~-]+$/);

export const ProductUrlPolicySchema = z
  .strictObject({
    exactHosts: z.array(AllowedHostSchema).min(1).max(32),
    pathTemplates: z.array(ProductPathTemplateSchema).min(1).max(32),
    allowedQueryParameters: z.array(QueryParameterSchema).max(32),
  })
  .superRefine((policy, context) => {
    if (
      new Set(policy.exactHosts).size !== policy.exactHosts.length ||
      new Set(policy.pathTemplates).size !== policy.pathTemplates.length ||
      new Set(policy.allowedQueryParameters).size !==
        policy.allowedQueryParameters.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Product URL policy values must be unique',
      });
    }
  });

export type ProductUrlPolicy = DeepReadonly<
  z.output<typeof ProductUrlPolicySchema>
>;

const LinkOutInputSchema = z.strictObject({
  url: z.string().trim().min(1).max(4_096),
  policy: ProductUrlPolicySchema,
});

export type SafeRetailerLinkOutResult =
  | DeepReadonly<{
      status: 'accepted';
      link: { url: string; rel: 'noopener noreferrer external' };
    }>
  | DeepReadonly<{
      status: 'rejected';
      safeError: {
        code: 'retailer-link-unsafe';
        message: 'The retailer link is unavailable.';
        retryable: false;
      };
    }>;

const unsafeLink = (): SafeRetailerLinkOutResult =>
  deepFreeze({
    status: 'rejected',
    safeError: {
      code: 'retailer-link-unsafe',
      message: 'The retailer link is unavailable.',
      retryable: false,
    },
  });

export const createSafeRetailerLinkOut = (
  input: unknown,
): SafeRetailerLinkOutResult => {
  if (!isBoundedAcyclicData(input)) return unsafeLink();
  try {
    const parsed = LinkOutInputSchema.safeParse(input);
    if (!parsed.success) return unsafeLink();
    const url = new URL(parsed.data.url);
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      return unsafeLink();
    }
    const pathMatches = parsed.data.policy.pathTemplates.some((template) => {
      const [prefix, suffix] = template.split('{product}') as [string, string];
      if (
        !decodedPath.startsWith(prefix) ||
        !decodedPath.endsWith(suffix) ||
        !url.pathname.startsWith(prefix) ||
        !url.pathname.endsWith(suffix)
      ) {
        return false;
      }
      const product = decodedPath.slice(
        prefix.length,
        suffix.length === 0 ? undefined : -suffix.length,
      );
      const rawProduct = url.pathname.slice(
        prefix.length,
        suffix.length === 0 ? undefined : -suffix.length,
      );
      return /^[A-Za-z0-9._~-]{1,200}$/.test(product) && rawProduct === product;
    });
    const queryEntries = [...url.searchParams.entries()];
    const queryKeys = queryEntries.map(([key]) => key);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.hash !== '' ||
      !parsed.data.policy.exactHosts.includes(url.hostname.toLowerCase()) ||
      !pathMatches ||
      new Set(queryKeys).size !== queryKeys.length ||
      queryKeys.some(
        (key) => !parsed.data.policy.allowedQueryParameters.includes(key),
      ) ||
      queryEntries.some(([, value]) => !/^[A-Za-z0-9._~-]{1,200}$/.test(value))
    ) {
      return unsafeLink();
    }

    return deepFreeze({
      status: 'accepted' as const,
      link: {
        url: url.toString(),
        rel: 'noopener noreferrer external' as const,
      },
    });
  } catch {
    return unsafeLink();
  }
};

const NormalizationInputSchema = z.strictObject({
  candidate: z.unknown(),
  providerId: IdentifierSchema,
  productUrlPolicy: ProductUrlPolicySchema,
  now: IsoDateTimeSchema,
  maximumAgeMs: z.number().int().positive().max(86_400_000),
  authoritativeFetchedAt: IsoDateTimeSchema.optional(),
});

export type NormalizedCommerceOffer = DeepReadonly<{
  offer: CommerceOffer;
  costs: z.output<typeof OfferCostsSchema>;
  stock: {
    status: 'unknown';
    reason: 'The connector did not provide verified inventory.';
  };
}>;

type OfferNormalizationErrorCode =
  | 'commerce-offer-expired'
  | 'commerce-offer-invalid'
  | 'commerce-offer-not-comparable'
  | 'commerce-offer-source-forbidden'
  | 'commerce-offer-stale';

export type CommerceOfferNormalizationResult =
  | DeepReadonly<{
      status: 'accepted';
      normalized: NormalizedCommerceOffer;
    }>
  | DeepReadonly<{
      status: 'rejected';
      safeError: {
        code: OfferNormalizationErrorCode;
        message: string;
        retryable: false;
      };
    }>;

const invalidOffer = (
  code: OfferNormalizationErrorCode,
): CommerceOfferNormalizationResult =>
  deepFreeze({
    status: 'rejected',
    safeError: {
      code,
      message: {
        'commerce-offer-expired': 'The offer has expired.',
        'commerce-offer-invalid': 'The commerce offer is invalid.',
        'commerce-offer-not-comparable':
          'This source does not permit structured comparison.',
        'commerce-offer-source-forbidden':
          'The offer source is not approved for link-out.',
        'commerce-offer-stale': 'The offer is stale.',
      }[code],
      retryable: false,
    },
  });

export const normalizeCommerceOfferCandidate = (
  input: unknown,
): CommerceOfferNormalizationResult => {
  if (!isBoundedAcyclicData(input))
    return invalidOffer('commerce-offer-invalid');
  try {
    const outer = NormalizationInputSchema.safeParse(input);
    if (!outer.success) return invalidOffer('commerce-offer-invalid');
    const parsedCandidate = OfferCandidateSchema.safeParse(
      outer.data.candidate,
    );
    if (!parsedCandidate.success) return invalidOffer('commerce-offer-invalid');
    const candidate =
      outer.data.authoritativeFetchedAt === undefined
        ? parsedCandidate
        : OfferCandidateSchema.safeParse({
            ...parsedCandidate.data,
            offer: {
              ...parsedCandidate.data.offer,
              fetchedAt: outer.data.authoritativeFetchedAt,
            },
          });
    if (!candidate.success) return invalidOffer('commerce-offer-invalid');
    if (candidate.data.offer.provider !== outer.data.providerId) {
      return invalidOffer('commerce-offer-invalid');
    }
    if (candidate.data.offer.comparisonPermission !== 'allowed') {
      return invalidOffer('commerce-offer-not-comparable');
    }

    const sourceValidation = createSafeRetailerLinkOut({
      url: candidate.data.offer.sourceUrl,
      policy: outer.data.productUrlPolicy,
    });
    if (sourceValidation.status !== 'accepted') {
      return invalidOffer('commerce-offer-source-forbidden');
    }

    const now = Date.parse(outer.data.now);
    const upstreamAt = Date.parse(candidate.data.offer.upstreamAt);
    const fetchedAt = Date.parse(candidate.data.offer.fetchedAt);
    const expiresAt = Date.parse(candidate.data.offer.expiresAt);
    if (fetchedAt > now) return invalidOffer('commerce-offer-invalid');
    if (expiresAt <= now) return invalidOffer('commerce-offer-expired');
    if (
      now - fetchedAt > outer.data.maximumAgeMs ||
      now - upstreamAt > outer.data.maximumAgeMs
    ) {
      return invalidOffer('commerce-offer-stale');
    }

    return deepFreeze({
      status: 'accepted' as const,
      normalized: {
        offer: candidate.data.offer,
        costs: candidate.data.costs,
        stock: {
          status: 'unknown' as const,
          reason: 'The connector did not provide verified inventory.' as const,
        },
      },
    });
  } catch {
    return invalidOffer('commerce-offer-invalid');
  }
};
