/**
 * Deterministic conformance data only. This is not evidence of live provider
 * access and must never be presented as a current retailer offer.
 */
const deepFreezeFixture = <Value>(value: Value): Readonly<Value> => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreezeFixture(nested);
    Object.freeze(value);
  }
  return value;
};

export const fixtureOfficialApiOfferCandidate = deepFreezeFixture({
  offer: {
    schemaVersion: 1,
    id: 'fixture-offer-1',
    version: 1,
    provider: 'fixture-official-api',
    merchant: { id: 'fixture-merchant-ca', name: 'Fixture Merchant Canada' },
    product: { id: 'dish-soap-1', title: 'Dish soap' },
    variant: { id: 'unscented-700ml', title: 'Unscented 700 mL' },
    price: { minorUnits: 799, currency: 'CAD' },
    shipping: { status: 'known', minorUnits: 0, currency: 'CAD' },
    availabilityScope: { kind: 'online' },
    sourceUrl: 'https://shop.example.test/products/dish-soap',
    upstreamAt: '2026-08-09T15:59:00.000Z',
    fetchedAt: '2026-08-09T16:00:00.000Z',
    expiresAt: '2026-08-09T16:15:00.000Z',
    comparisonPermission: 'allowed',
  },
  costs: {
    item: { status: 'known', minorUnits: 799, currency: 'CAD' },
    shipping: { status: 'known', minorUnits: 0, currency: 'CAD' },
    tax: {
      status: 'unknown',
      reason: 'Calculated by the retailer at handoff.',
    },
    fees: { status: 'not-applicable' },
    membership: { status: 'not-applicable' },
    unknown: [
      { component: 'tax', reason: 'Calculated by the retailer at handoff.' },
    ],
  },
});
