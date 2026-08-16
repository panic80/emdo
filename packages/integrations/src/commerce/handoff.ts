import {
  IsoDateTimeSchema,
  deepFreeze,
  type DeepReadonly,
} from '@emdo/contracts';

import {
  parseCommerceOfferRequest,
  parseCommerceRefreshResponse,
  resolveApprovedCommerceConnector,
  type CommerceConnectorRegistry,
} from './connectors.js';
import {
  createSafeRetailerLinkOut,
  normalizeCommerceOfferCandidate,
  type NormalizedCommerceOffer,
} from './offers.js';

type RefreshErrorCode =
  | 'commerce-connector-not-approved'
  | 'commerce-refresh-aborted'
  | 'commerce-refresh-failed'
  | 'commerce-refresh-invalid';

export type CommerceHandoffResult =
  | DeepReadonly<{
      status: 'ready';
      refreshedAt: string;
      offers: Array<
        NormalizedCommerceOffer & {
          handoff: {
            url: string;
            rel: 'noopener noreferrer external';
          };
        }
      >;
    }>
  | DeepReadonly<{
      status: 'blocked';
      safeError: {
        code: RefreshErrorCode;
        message: string;
        retryable: boolean;
      };
    }>;

const blocked = (
  code: RefreshErrorCode,
  retryable: boolean,
): CommerceHandoffResult =>
  deepFreeze({
    status: 'blocked',
    safeError: {
      code,
      message: {
        'commerce-connector-not-approved':
          'No approved live connector is available for handoff.',
        'commerce-refresh-aborted': 'The offer refresh was cancelled.',
        'commerce-refresh-failed': 'The live offer refresh failed.',
        'commerce-refresh-invalid':
          'The refreshed offer batch could not be verified.',
      }[code],
      retryable,
    },
  });

const readClock = (clock: () => Date): string | undefined => {
  try {
    const value = clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      return undefined;
    }
    const iso = value.toISOString();
    return IsoDateTimeSchema.safeParse(iso).success ? iso : undefined;
  } catch {
    return undefined;
  }
};

export const refreshOffersBeforeHandoff = async (input: {
  readonly registry: CommerceConnectorRegistry;
  readonly providerId: string;
  readonly request: unknown;
  readonly signal: AbortSignal;
  readonly clock: () => Date;
  readonly maximumAgeMs: number;
}): Promise<CommerceHandoffResult> => {
  const registration = resolveApprovedCommerceConnector(
    input.registry,
    input.providerId,
  );
  if (registration === undefined) {
    return blocked('commerce-connector-not-approved', false);
  }
  const request = parseCommerceOfferRequest(input.request);
  if (
    request === undefined ||
    !Number.isSafeInteger(input.maximumAgeMs) ||
    input.maximumAgeMs <= 0 ||
    input.maximumAgeMs > 86_400_000
  ) {
    return blocked('commerce-refresh-invalid', false);
  }
  if (input.signal.aborted) return blocked('commerce-refresh-aborted', true);

  const refreshStartedAt = readClock(input.clock);
  if (refreshStartedAt === undefined) {
    return blocked('commerce-refresh-invalid', false);
  }

  let rawResponse: unknown;
  try {
    rawResponse = await registration.connector.refreshOffers(request, {
      signal: input.signal,
    });
  } catch {
    return input.signal.aborted
      ? blocked('commerce-refresh-aborted', true)
      : blocked('commerce-refresh-failed', true);
  }
  if (input.signal.aborted) return blocked('commerce-refresh-aborted', true);

  const refreshedAt = readClock(input.clock);
  const response = parseCommerceRefreshResponse(rawResponse);
  if (
    refreshedAt === undefined ||
    Date.parse(refreshedAt) < Date.parse(refreshStartedAt) ||
    response === undefined
  ) {
    return blocked('commerce-refresh-invalid', false);
  }

  const offers: Array<
    NormalizedCommerceOffer & {
      handoff: {
        url: string;
        rel: 'noopener noreferrer external';
      };
    }
  > = [];
  for (const candidate of response.candidates) {
    const normalized = normalizeCommerceOfferCandidate({
      candidate,
      providerId: registration.approval.providerId,
      productUrlPolicy: registration.approval.productUrlPolicy,
      now: refreshedAt,
      maximumAgeMs: input.maximumAgeMs,
      authoritativeFetchedAt: refreshedAt,
    });
    if (normalized.status !== 'accepted') {
      return blocked('commerce-refresh-invalid', false);
    }
    const link = createSafeRetailerLinkOut({
      url: normalized.normalized.offer.sourceUrl,
      policy: registration.approval.productUrlPolicy,
    });
    if (link.status !== 'accepted') {
      return blocked('commerce-refresh-invalid', false);
    }
    offers.push({ ...normalized.normalized, handoff: link.link });
  }
  if (input.signal.aborted) return blocked('commerce-refresh-aborted', true);

  offers.sort(
    (left, right) =>
      (left.offer.provider === right.offer.provider
        ? 0
        : left.offer.provider < right.offer.provider
          ? -1
          : 1) ||
      (left.offer.id === right.offer.id
        ? 0
        : left.offer.id < right.offer.id
          ? -1
          : 1),
  );
  return deepFreeze({ status: 'ready' as const, refreshedAt, offers });
};
