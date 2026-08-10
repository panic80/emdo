import { describe, expect, it } from 'vitest';

import { fixtureOfficialApiOfferCandidate } from '../../../agents/shopping/src/fixtures/official-api-offer.js';
import { prepareOfferHistorySnapshotAppend } from './offer-history.js';

const offer = fixtureOfficialApiOfferCandidate.offer;
const entry = (
  recordedAt = '2026-08-09T16:01:00.000Z',
  itemId = 'shopping-item-1',
) => ({ itemId, offer, recordedAt });
const cursor = (value: ReturnType<typeof entry>, sequence: number) => ({
  sequence,
  recordedAt: value.recordedAt,
  itemId: value.itemId,
  provider: value.offer.provider,
  offerId: value.offer.id,
  offerVersion: value.offer.version,
});
const retention = (
  latest: ReturnType<typeof entry>,
  retainedEntryCount = 1,
  sequence = retainedEntryCount,
) => ({
  retainedEntryCount,
  lastAppendSequence: sequence,
  latestRecordedAt: latest.recordedAt,
  latestCursor: cursor(latest, sequence),
});
const emptyRetention = {
  retainedEntryCount: 0,
  lastAppendSequence: 0,
  latestRecordedAt: null,
  latestCursor: null,
} as const;
const noCandidateMatch = {
  versionBinding: null,
  exactSnapshot: null,
} as const;

describe('prepareOfferHistorySnapshotAppend', () => {
  it('prepares one immutable, timestamped append and monotonic cursor', () => {
    const result = prepareOfferHistorySnapshotAppend({
      tail: [],
      retention: emptyRetention,
      candidateLookup: noCandidateMatch,
      appendSequence: 1,
      ...entry(),
    });

    expect(result).toMatchObject({
      status: 'appended',
      entry: entry(),
      cursor: {
        sequence: 1,
        recordedAt: '2026-08-09T16:01:00.000Z',
        itemId: 'shopping-item-1',
        provider: offer.provider,
        offerId: offer.id,
        offerVersion: offer.version,
      },
      nextRetention: {
        retainedEntryCount: 1,
        lastAppendSequence: 1,
        latestRecordedAt: '2026-08-09T16:01:00.000Z',
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status === 'appended') {
      expect(Object.isFrozen(result.entry.offer)).toBe(true);
      expect(result.nextRetention.latestCursor).toEqual(result.cursor);
    }
  });

  it('deduplicates the repository record and rejects a conflicting version binding', () => {
    const first = entry();
    const firstCursor = cursor(first, 7);
    const currentRetention = retention(first, 1, 7);

    expect(
      prepareOfferHistorySnapshotAppend({
        tail: [first],
        retention: currentRetention,
        candidateLookup: {
          versionBinding: offer,
          exactSnapshot: { entry: first, cursor: firstCursor },
        },
        appendSequence: 8,
        ...first,
      }),
    ).toMatchObject({
      status: 'duplicate',
      entry: first,
      cursor: firstCursor,
      retention: { lastAppendSequence: 7 },
    });

    expect(
      prepareOfferHistorySnapshotAppend({
        tail: [first],
        retention: currentRetention,
        candidateLookup: { versionBinding: offer, exactSnapshot: null },
        appendSequence: 8,
        itemId: first.itemId,
        offer: { ...offer, price: { minorUnits: 899, currency: 'CAD' } },
        recordedAt: '2026-08-09T16:02:00.000Z',
      }),
    ).toMatchObject({
      status: 'rejected',
      safeError: { code: 'offer-history-version-conflict' },
    });
  });

  it('records a later observation when the immutable offer version is unchanged', () => {
    const first = entry();

    expect(
      prepareOfferHistorySnapshotAppend({
        tail: [first],
        retention: retention(first),
        candidateLookup: { versionBinding: offer, exactSnapshot: null },
        appendSequence: 2,
        ...entry('2026-08-09T16:02:00.000Z'),
      }),
    ).toMatchObject({
      status: 'appended',
      cursor: { sequence: 2 },
      nextRetention: { retainedEntryCount: 2, lastAppendSequence: 2 },
    });
  });

  it('binds a provider offer version globally across shopping items', () => {
    const latest = entry();

    expect(
      prepareOfferHistorySnapshotAppend({
        tail: [],
        retention: retention(latest),
        candidateLookup: { versionBinding: offer, exactSnapshot: null },
        appendSequence: 2,
        itemId: 'shopping-item-2',
        offer: { ...offer, price: { minorUnits: 899, currency: 'CAD' } },
        recordedAt: '2026-08-09T16:02:00.000Z',
      }),
    ).toMatchObject({
      status: 'rejected',
      safeError: { code: 'offer-history-version-conflict' },
    });
  });

  it('allows retained history to grow beyond the bounded validation tail', () => {
    const latest = entry();

    expect(
      prepareOfferHistorySnapshotAppend({
        tail: [latest],
        retention: retention(latest, 10_000, 12_345),
        candidateLookup: {
          versionBinding: { ...offer, version: 2 },
          exactSnapshot: null,
        },
        appendSequence: 12_346,
        itemId: latest.itemId,
        offer: { ...offer, version: 2 },
        recordedAt: '2026-08-09T16:02:00.000Z',
      }),
    ).toMatchObject({
      status: 'appended',
      nextRetention: {
        retainedEntryCount: 10_001,
        lastAppendSequence: 12_346,
      },
    });
  });

  it('orders equal timestamps by repository sequence, never lexical payload order', () => {
    const latest = entry('2026-08-09T16:01:00.000Z', 'z-shopping-item');
    const input = {
      tail: [latest],
      retention: retention(latest, 1, 41),
      candidateLookup: { versionBinding: offer, exactSnapshot: null },
      appendSequence: 42,
      ...entry(latest.recordedAt, 'a-shopping-item'),
    };

    expect(prepareOfferHistorySnapshotAppend(input)).toMatchObject({
      status: 'appended',
      cursor: { sequence: 42 },
      nextRetention: { lastAppendSequence: 42 },
    });
    expect(
      prepareOfferHistorySnapshotAppend({ ...input, appendSequence: 41 }),
    ).toMatchObject({
      status: 'rejected',
      safeError: { code: 'offer-history-invalid' },
    });
  });

  it('returns the original cursor for a duplicate outside the validation tail', () => {
    const exactEntry = entry();
    const exactCursor = cursor(exactEntry, 1);
    const latest = entry('2026-08-09T17:00:00.000Z', 'shopping-item-2');

    expect(
      prepareOfferHistorySnapshotAppend({
        tail: [],
        retention: retention(latest, 10_000, 12_345),
        candidateLookup: {
          versionBinding: offer,
          exactSnapshot: { entry: exactEntry, cursor: exactCursor },
        },
        appendSequence: 12_346,
        ...exactEntry,
      }),
    ).toMatchObject({
      status: 'duplicate',
      entry: exactEntry,
      cursor: exactCursor,
      retention: { lastAppendSequence: 12_345 },
    });
  });

  it.each([
    {
      tail: [],
      retention: emptyRetention,
      candidateLookup: noCandidateMatch,
      appendSequence: 1,
      ...entry('2026-08-09T15:59:59.000Z'),
    },
    {
      tail: [entry('2026-08-09T16:10:00.000Z')],
      retention: retention(entry('2026-08-09T16:10:00.000Z')),
      candidateLookup: noCandidateMatch,
      appendSequence: 2,
      itemId: 'shopping-item-1',
      offer: { ...offer, version: 2 },
      recordedAt: '2026-08-09T16:09:00.000Z',
    },
  ])('rejects invalid history chronology', (input) => {
    expect(prepareOfferHistorySnapshotAppend(input)).toMatchObject({
      status: 'rejected',
      safeError: { code: 'offer-history-invalid' },
    });
  });

  it('rejects inconsistent repository continuation and exact-match evidence', () => {
    const first = entry();

    expect(
      prepareOfferHistorySnapshotAppend({
        tail: [],
        retention: {
          retainedEntryCount: 0,
          lastAppendSequence: 0,
          latestRecordedAt: first.recordedAt,
          latestCursor: null,
        },
        candidateLookup: noCandidateMatch,
        appendSequence: 1,
        ...entry('2026-08-09T16:02:00.000Z'),
      }),
    ).toMatchObject({
      status: 'rejected',
      safeError: { code: 'offer-history-invalid' },
    });

    expect(
      prepareOfferHistorySnapshotAppend({
        tail: [first],
        retention: retention(first),
        candidateLookup: {
          versionBinding: offer,
          exactSnapshot: { entry: first, cursor: cursor(first, 2) },
        },
        appendSequence: 2,
        ...first,
      }),
    ).toMatchObject({
      status: 'rejected',
      safeError: { code: 'offer-history-invalid' },
    });
  });

  it('rejects cyclic or oversized input before schema traversal', () => {
    const cyclic: Record<string, unknown> = {
      tail: [],
      retention: emptyRetention,
      candidateLookup: noCandidateMatch,
      appendSequence: 1,
      ...entry(),
    };
    cyclic.self = cyclic;

    expect(prepareOfferHistorySnapshotAppend(cyclic)).toMatchObject({
      status: 'rejected',
      safeError: { code: 'offer-history-invalid' },
    });
    expect(
      prepareOfferHistorySnapshotAppend({
        tail: [],
        retention: emptyRetention,
        candidateLookup: noCandidateMatch,
        appendSequence: 1,
        itemId: 'shopping-item-1',
        offer: {
          ...offer,
          sourceUrl: `https://shop.example.test/${'x'.repeat(25_000)}`,
        },
        recordedAt: '2026-08-09T16:01:00.000Z',
      }),
    ).toMatchObject({
      status: 'rejected',
      safeError: { code: 'offer-history-invalid' },
    });
  });

  it('bounds only the validation tail and never treats it as lifetime retention', () => {
    const tail = Array.from({ length: 257 }, (_, index) =>
      entry(new Date(Date.parse(offer.fetchedAt) + index).toISOString()),
    );

    expect(
      prepareOfferHistorySnapshotAppend({
        tail,
        retention: retention(tail[256]!, 257),
        candidateLookup: { versionBinding: offer, exactSnapshot: null },
        appendSequence: 258,
        ...entry('2026-08-09T17:00:00.000Z'),
      }),
    ).toMatchObject({
      status: 'rejected',
      safeError: { code: 'offer-history-invalid' },
    });
  });
});
