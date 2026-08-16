import { describe, expect, it } from 'vitest';

import { fixtureOfficialApiOfferCandidate } from '../../../agents/shopping/src/fixtures/official-api-offer.js';
import {
  RETAILER_CONNECTOR_STATUSES,
  runFixtureConnectorConformance,
  type FixtureCommerceConnector,
} from './connectors.js';

describe('retailer connector status registry', () => {
  it('records the access and terms spike for every MVP target without enabling live data', () => {
    expect(RETAILER_CONNECTOR_STATUSES).toHaveLength(6);
    expect(
      RETAILER_CONNECTOR_STATUSES.map((status) => status.retailerId),
    ).toEqual([
      'amazon-canada',
      'best-buy-ca',
      'canadian-tire-ca',
      'costco-ca',
      'no-frills-ca',
      'walmart-ca',
    ]);
    for (const status of RETAILER_CONNECTOR_STATUSES) {
      expect(status).toMatchObject({
        accessReview: 'required',
        termsReview: 'required',
        liveOffers: 'disabled',
        ordinaryLinkOut: 'disabled-pending-review',
        localPrice: 'unavailable',
        localInventory: 'unavailable',
      });
      expect(Object.isFrozen(status)).toBe(true);
    }
  });
});

describe('runFixtureConnectorConformance', () => {
  const connector: FixtureCommerceConnector = {
    manifest: {
      schemaVersion: 1,
      providerId: 'fixture-official-api',
      retailerId: 'fixture-merchant-ca',
      sourceKind: 'official-api',
      environment: 'fixture',
      capabilities: ['offers.read', 'product.link-out'],
      productUrlPolicy: {
        exactHosts: ['shop.example.test'],
        pathTemplates: ['/products/{product}'],
        allowedQueryParameters: ['variant'],
      },
    },
    refreshOffers: async () => ({
      candidates: [fixtureOfficialApiOfferCandidate],
    }),
  };

  it('validates only fixture-backed official API or affiliate read adapters', async () => {
    await expect(
      runFixtureConnectorConformance({
        connector,
        request: { query: 'dish soap', limit: 10 },
        now: '2026-08-09T16:01:00.000Z',
        maximumAgeMs: 5 * 60 * 1_000,
        expectedOfferIds: ['fixture-offer-1'],
      }),
    ).resolves.toMatchObject({
      status: 'conformant',
      environment: 'fixture',
      handoffEligible: false,
      normalizedOffers: [{ offer: { id: 'fixture-offer-1' } }],
    });
  });

  it('rejects prohibited capabilities and never invokes the adapter', async () => {
    let invoked = false;
    const unsafe = {
      ...connector,
      manifest: {
        ...connector.manifest,
        capabilities: ['offers.read', 'checkout'] as const,
      },
      refreshOffers: async () => {
        invoked = true;
        return { candidates: [] };
      },
    };

    await expect(
      runFixtureConnectorConformance({
        connector: unsafe as never,
        request: { query: 'dish soap', limit: 10 },
        now: '2026-08-09T16:01:00.000Z',
        maximumAgeMs: 300_000,
        expectedOfferIds: ['fixture-offer-1'],
      }),
    ).resolves.toMatchObject({
      status: 'rejected',
      safeError: { code: 'commerce-connector-invalid' },
    });
    expect(invoked).toBe(false);
  });

  it('does not certify an adapter without an expected normalized fixture', async () => {
    await expect(
      runFixtureConnectorConformance({
        connector: {
          ...connector,
          refreshOffers: async () => ({ candidates: [] }),
        },
        request: { query: 'dish soap', limit: 10 },
        now: '2026-08-09T16:01:00.000Z',
        maximumAgeMs: 300_000,
        expectedOfferIds: ['fixture-offer-1'],
      }),
    ).resolves.toMatchObject({
      status: 'rejected',
      safeError: { code: 'commerce-connector-invalid' },
    });
  });

  it('keeps nested conformance fixtures immutable', () => {
    expect(Object.isFrozen(fixtureOfficialApiOfferCandidate.offer)).toBe(true);
    expect(Object.isFrozen(fixtureOfficialApiOfferCandidate.offer.price)).toBe(
      true,
    );
    expect(
      Object.isFrozen(fixtureOfficialApiOfferCandidate.costs.unknown),
    ).toBe(true);
  });
});
