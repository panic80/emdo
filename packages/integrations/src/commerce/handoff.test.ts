import { describe, expect, it, vi } from 'vitest';

import { fixtureOfficialApiOfferCandidate } from '../../../agents/shopping/src/fixtures/official-api-offer.js';
import {
  createCommerceConnectorRegistry,
  type CommerceReadConnector,
} from './connectors.js';
import { refreshOffersBeforeHandoff } from './handoff.js';

const refreshedCandidate = {
  ...fixtureOfficialApiOfferCandidate,
  offer: {
    ...fixtureOfficialApiOfferCandidate.offer,
    upstreamAt: '2026-08-09T16:00:30.000Z',
    fetchedAt: '2026-08-09T16:01:00.000Z',
    expiresAt: '2026-08-09T16:16:00.000Z',
  },
};

const manifest = {
  schemaVersion: 1,
  providerId: 'fixture-official-api',
  retailerId: 'fixture-merchant-ca',
  sourceKind: 'official-api',
  environment: 'provider',
  capabilities: ['offers.read', 'product.link-out'],
  productUrlPolicy: {
    exactHosts: ['shop.example.test'],
    pathTemplates: ['/products/{product}'],
    allowedQueryParameters: ['variant'],
  },
} as const;

const deploymentApproval = {
  schemaVersion: 1,
  approvalId: 'fixture-deployment-approval-v1',
  providerId: 'fixture-official-api',
  retailerId: 'fixture-merchant-ca',
  sourceKind: 'official-api',
  productUrlPolicy: manifest.productUrlPolicy,
  accessApprovalReference: 'deployment-secret-reference',
  termsReviewedAt: '2026-08-01T12:00:00.000Z',
  conformance: {
    suiteVersion: '1.0.0',
    fixtureDigest: 'a'.repeat(64),
    verifiedAt: '2026-08-01T12:00:00.000Z',
  },
} as const;

const registryFor = (connector: CommerceReadConnector) =>
  createCommerceConnectorRegistry({
    connectors: [connector],
    deploymentApprovals: [deploymentApproval],
  });

describe('refreshOffersBeforeHandoff', () => {
  it('refreshes after the handoff starts and returns only normalized product links', async () => {
    const refreshOffers = vi.fn(async () => ({
      candidates: [refreshedCandidate],
    }));
    const connector: CommerceReadConnector = {
      manifest,
      refreshOffers,
    };
    const times = [
      new Date('2026-08-09T16:00:00.000Z'),
      new Date('2026-08-09T16:02:00.000Z'),
    ];

    const result = await refreshOffersBeforeHandoff({
      registry: registryFor(connector),
      providerId: 'fixture-official-api',
      request: { query: 'dish soap', limit: 10 },
      signal: new AbortController().signal,
      clock: () => times.shift()!,
      maximumAgeMs: 5 * 60 * 1_000,
    });

    expect(refreshOffers).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'ready',
      refreshedAt: '2026-08-09T16:02:00.000Z',
      offers: [
        {
          offer: {
            id: 'fixture-offer-1',
            fetchedAt: '2026-08-09T16:02:00.000Z',
          },
          costs: {
            item: { minorUnits: 799 },
            tax: { status: 'unknown' },
          },
          stock: { status: 'unknown' },
          handoff: {
            url: 'https://shop.example.test/products/dish-soap',
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/cart|checkout|inventoryCount/i);
  });

  it('does not let an adapter self-approve handoff access', async () => {
    const refreshOffers = vi.fn(async () => ({ candidates: [] }));
    const connector: CommerceReadConnector = {
      manifest,
      refreshOffers,
    };
    const registry = createCommerceConnectorRegistry({
      connectors: [connector],
      deploymentApprovals: [],
    });

    const result = await refreshOffersBeforeHandoff({
      registry,
      providerId: 'fixture-official-api',
      request: { query: 'dish soap', limit: 10 },
      signal: new AbortController().signal,
      clock: () => new Date('2026-08-09T16:00:00.000Z'),
      maximumAgeMs: 300_000,
    });

    expect(result).toMatchObject({
      status: 'blocked',
      safeError: { code: 'commerce-connector-not-approved' },
    });
    expect(refreshOffers).not.toHaveBeenCalled();

    const forgedRegistryResult = await refreshOffersBeforeHandoff({
      registry: {
        resolveApproved: () => ({ connector, approval: deploymentApproval }),
      } as never,
      providerId: 'fixture-official-api',
      request: { query: 'dish soap', limit: 10 },
      signal: new AbortController().signal,
      clock: () => new Date('2026-08-09T16:00:00.000Z'),
      maximumAgeMs: 300_000,
    });
    expect(forgedRegistryResult).toMatchObject({
      status: 'blocked',
      safeError: { code: 'commerce-connector-not-approved' },
    });
    expect(refreshOffers).not.toHaveBeenCalled();
  });

  it('fails closed on an aborted request, stale refresh, or partial invalid batch', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const connector: CommerceReadConnector = {
      manifest,
      refreshOffers: async () => ({ candidates: [refreshedCandidate] }),
    };

    await expect(
      refreshOffersBeforeHandoff({
        registry: registryFor(connector),
        providerId: 'fixture-official-api',
        request: { query: 'dish soap', limit: 10 },
        signal: aborted.signal,
        clock: () => new Date('2026-08-09T16:00:00.000Z'),
        maximumAgeMs: 300_000,
      }),
    ).resolves.toMatchObject({
      status: 'blocked',
      safeError: { code: 'commerce-refresh-aborted' },
    });

    const staleConnector: CommerceReadConnector = {
      manifest,
      refreshOffers: async () => ({
        candidates: [
          {
            ...refreshedCandidate,
            offer: {
              ...refreshedCandidate.offer,
              upstreamAt: '2026-08-09T15:00:00.000Z',
            },
          },
        ],
      }),
    };
    const times = [
      new Date('2026-08-09T16:00:00.000Z'),
      new Date('2026-08-09T16:02:00.000Z'),
    ];
    await expect(
      refreshOffersBeforeHandoff({
        registry: registryFor(staleConnector),
        providerId: 'fixture-official-api',
        request: { query: 'dish soap', limit: 10 },
        signal: new AbortController().signal,
        clock: () => times.shift()!,
        maximumAgeMs: 300_000,
      }),
    ).resolves.toMatchObject({
      status: 'blocked',
      safeError: { code: 'commerce-refresh-invalid' },
    });

    const invalidBatch: CommerceReadConnector = {
      manifest,
      refreshOffers: async () => ({
        candidates: [refreshedCandidate, { secret: 'do-not-reflect-me' }],
      }),
    };
    const validTimes = [
      new Date('2026-08-09T16:00:00.000Z'),
      new Date('2026-08-09T16:02:00.000Z'),
    ];
    const result = await refreshOffersBeforeHandoff({
      registry: registryFor(invalidBatch),
      providerId: 'fixture-official-api',
      request: { query: 'dish soap', limit: 10 },
      signal: new AbortController().signal,
      clock: () => validTimes.shift()!,
      maximumAgeMs: 300_000,
    });
    expect(result).toMatchObject({
      status: 'blocked',
      safeError: { code: 'commerce-refresh-invalid' },
    });
    expect(JSON.stringify(result)).not.toContain('do-not-reflect-me');
  });

  it('rejects a deployment approval whose policy is not bound to the adapter', () => {
    const connector: CommerceReadConnector = {
      manifest,
      refreshOffers: async () => ({ candidates: [] }),
    };

    expect(() =>
      createCommerceConnectorRegistry({
        connectors: [connector],
        deploymentApprovals: [
          {
            ...deploymentApproval,
            productUrlPolicy: {
              ...deploymentApproval.productUrlPolicy,
              pathTemplates: ['/different-products/{product}'],
            },
          },
        ],
      }),
    ).toThrow(/binding/i);
  });

  it('sanitizes a throwing clock dependency', async () => {
    const connector: CommerceReadConnector = {
      manifest,
      refreshOffers: async () => ({ candidates: [refreshedCandidate] }),
    };

    await expect(
      refreshOffersBeforeHandoff({
        registry: registryFor(connector),
        providerId: 'fixture-official-api',
        request: { query: 'dish soap', limit: 10 },
        signal: new AbortController().signal,
        clock: () => {
          throw new Error('do-not-reflect-clock-fault');
        },
        maximumAgeMs: 300_000,
      }),
    ).resolves.toEqual({
      status: 'blocked',
      safeError: {
        code: 'commerce-refresh-invalid',
        message: 'The refreshed offer batch could not be verified.',
        retryable: false,
      },
    });
  });

  it('does not imply a cheapest ranking from item price alone', async () => {
    const candidate = (
      id: string,
      itemMinorUnits: number,
      shippingMinorUnits: number,
    ) => ({
      ...refreshedCandidate,
      offer: {
        ...refreshedCandidate.offer,
        id,
        price: { minorUnits: itemMinorUnits, currency: 'CAD' },
        shipping: {
          status: 'known',
          minorUnits: shippingMinorUnits,
          currency: 'CAD',
        },
        sourceUrl: `https://shop.example.test/products/${id}`,
      },
      costs: {
        ...refreshedCandidate.costs,
        item: {
          status: 'known',
          minorUnits: itemMinorUnits,
          currency: 'CAD',
        },
        shipping: {
          status: 'known',
          minorUnits: shippingMinorUnits,
          currency: 'CAD',
        },
      },
    });
    const connector: CommerceReadConnector = {
      manifest,
      refreshOffers: async () => ({
        candidates: [
          candidate('z-low-item-high-shipping', 100, 10_000),
          candidate('a-higher-item-delivered', 200, 0),
        ],
      }),
    };
    const times = [
      new Date('2026-08-09T16:00:00.000Z'),
      new Date('2026-08-09T16:02:00.000Z'),
    ];

    const result = await refreshOffersBeforeHandoff({
      registry: registryFor(connector),
      providerId: 'fixture-official-api',
      request: { query: 'dish soap', limit: 10 },
      signal: new AbortController().signal,
      clock: () => times.shift()!,
      maximumAgeMs: 300_000,
    });

    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.offers.map((offer) => offer.offer.id)).toEqual([
        'a-higher-item-delivered',
        'z-low-item-high-shipping',
      ]);
    }
  });
});
