import { describe, expect, it } from 'vitest';

import { fixtureOfficialApiOfferCandidate } from '../../../agents/shopping/src/fixtures/official-api-offer.js';
import {
  createSafeRetailerLinkOut,
  normalizeCommerceOfferCandidate,
} from './offers.js';

const normalizationInput = {
  candidate: fixtureOfficialApiOfferCandidate,
  providerId: 'fixture-official-api',
  productUrlPolicy: {
    exactHosts: ['shop.example.test'],
    pathTemplates: ['/products/{product}'],
    allowedQueryParameters: ['variant'],
  },
  now: '2026-08-09T16:01:00.000Z',
  maximumAgeMs: 5 * 60 * 1_000,
} as const;

describe('normalizeCommerceOfferCandidate', () => {
  it('normalizes a current CAD offer with separated costs and unknown stock', () => {
    const result = normalizeCommerceOfferCandidate(normalizationInput);

    expect(result).toEqual({
      status: 'accepted',
      normalized: {
        offer: fixtureOfficialApiOfferCandidate.offer,
        costs: fixtureOfficialApiOfferCandidate.costs,
        stock: {
          status: 'unknown',
          reason: 'The connector did not provide verified inventory.',
        },
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status === 'accepted') {
      expect(Object.isFrozen(result.normalized.costs.unknown)).toBe(true);
      expect('handoff' in result.normalized).toBe(false);
    }
  });

  it.each([
    [
      'item cost mismatch',
      {
        ...fixtureOfficialApiOfferCandidate,
        costs: {
          ...fixtureOfficialApiOfferCandidate.costs,
          item: { status: 'known', minorUnits: 800, currency: 'CAD' },
        },
      },
      'commerce-offer-invalid',
    ],
    [
      'missing unknown disclosure',
      {
        ...fixtureOfficialApiOfferCandidate,
        costs: { ...fixtureOfficialApiOfferCandidate.costs, unknown: [] },
      },
      'commerce-offer-invalid',
    ],
    [
      'unapproved comparison',
      {
        ...fixtureOfficialApiOfferCandidate,
        offer: {
          ...fixtureOfficialApiOfferCandidate.offer,
          comparisonPermission: 'not-authorized',
        },
      },
      'commerce-offer-not-comparable',
    ],
  ] as const)('rejects %s', (_name, candidate, code) => {
    expect(
      normalizeCommerceOfferCandidate({ ...normalizationInput, candidate }),
    ).toMatchObject({ status: 'rejected', safeError: { code } });
  });

  it.each([
    ['stale', { now: '2026-08-09T16:06:00.001Z' }, 'commerce-offer-stale'],
    [
      'upstream-stale',
      {
        candidate: {
          ...fixtureOfficialApiOfferCandidate,
          offer: {
            ...fixtureOfficialApiOfferCandidate.offer,
            upstreamAt: '2026-08-09T15:00:00.000Z',
          },
        },
      },
      'commerce-offer-stale',
    ],
    ['expired', { now: '2026-08-09T16:15:00.000Z' }, 'commerce-offer-expired'],
    ['future', { now: '2026-08-09T15:59:59.999Z' }, 'commerce-offer-invalid'],
  ] as const)('rejects a %s offer', (_name, override, code) => {
    expect(
      normalizeCommerceOfferCandidate({
        ...normalizationInput,
        ...override,
      }),
    ).toMatchObject({ status: 'rejected', safeError: { code } });
  });

  it('rejects provider and exact-host mismatches', () => {
    expect(
      normalizeCommerceOfferCandidate({
        ...normalizationInput,
        providerId: 'another-provider',
      }),
    ).toMatchObject({
      status: 'rejected',
      safeError: { code: 'commerce-offer-invalid' },
    });
    expect(
      normalizeCommerceOfferCandidate({
        ...normalizationInput,
        productUrlPolicy: {
          ...normalizationInput.productUrlPolicy,
          exactHosts: ['example.test'],
        },
      }),
    ).toMatchObject({
      status: 'rejected',
      safeError: { code: 'commerce-offer-source-forbidden' },
    });
  });

  it('rejects cyclic and accessor-bearing candidates safely', () => {
    const cyclic: Record<string, unknown> = {
      ...normalizationInput,
      candidate: { ...fixtureOfficialApiOfferCandidate },
    };
    (cyclic.candidate as Record<string, unknown>).self = cyclic.candidate;
    expect(normalizeCommerceOfferCandidate(cyclic)).toMatchObject({
      status: 'rejected',
      safeError: { code: 'commerce-offer-invalid' },
    });

    const candidate = { ...fixtureOfficialApiOfferCandidate };
    Object.defineProperty(candidate, 'offer', {
      enumerable: true,
      get: () => {
        throw new Error('must not execute');
      },
    });
    expect(
      normalizeCommerceOfferCandidate({ ...normalizationInput, candidate }),
    ).toMatchObject({ status: 'rejected' });
  });
});

describe('createSafeRetailerLinkOut', () => {
  const productUrlPolicy = {
    exactHosts: ['shop.example.test'],
    pathTemplates: ['/products/{product}'],
    allowedQueryParameters: ['variant'],
  } as const;

  it('creates only an inert HTTPS product link for an exact audited host', () => {
    expect(
      createSafeRetailerLinkOut({
        url: 'https://shop.example.test/products/dish-soap?variant=700ml',
        policy: productUrlPolicy,
      }),
    ).toEqual({
      status: 'accepted',
      link: {
        url: 'https://shop.example.test/products/dish-soap?variant=700ml',
        rel: 'noopener noreferrer external',
      },
    });
  });

  it.each([
    'http://shop.example.test/products/1',
    'https://user:secret@shop.example.test/products/1',
    'https://shop.example.test:8443/products/1',
    'https://shop.example.test/cart',
    'https://shop.example.test/checkout/1',
    'https://shop.example.test/account/login',
    'https://shop.example.test/basket/add',
    'https://shop.example.test/buy-now/1',
    'https://shop.example.test/products/1?redirect=checkout',
    'https://shop.example.test/products/%252e%252e%252fbasket%252fadd',
    'https://shop.example.test/products/%5Ccheckout',
    'https://shop.example.test/products/%00checkout',
    'https://shop.example.test/products/1?variant=https%3A%2F%2Fevil.test',
    'https://shop.example.test/products/1?variant=%252Fcheckout',
    'https://evilshop.example.test/products/1',
    'https://shop.example.test/products/1#checkout',
  ])('rejects unsafe link-out %s', (url) => {
    expect(
      createSafeRetailerLinkOut({
        url,
        policy: productUrlPolicy,
      }),
    ).toEqual({
      status: 'rejected',
      safeError: {
        code: 'retailer-link-unsafe',
        message: 'The retailer link is unavailable.',
        retryable: false,
      },
    });
  });
});
