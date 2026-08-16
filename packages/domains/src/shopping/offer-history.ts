import {
  CommerceOfferSchema,
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  deepFreeze,
  type CommerceOffer,
  type DeepReadonly,
} from '@emdo/contracts';
import { z } from 'zod';

import { isBoundedAcyclicData } from './bounded.js';

// This is an input-validation/page-size limit, not a retention limit. Older
// entries remain repository-owned and are addressed through continuation state.
const MAX_OFFER_HISTORY_TAIL_ENTRIES = 256;

const OfferHistoryEntrySchema = z
  .strictObject({
    itemId: OpaqueReferenceSchema,
    offer: CommerceOfferSchema,
    recordedAt: IsoDateTimeSchema,
  })
  .superRefine((entry, context) => {
    if (Date.parse(entry.recordedAt) < Date.parse(entry.offer.fetchedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['recordedAt'],
        message: 'An offer cannot be recorded before it was fetched',
      });
    }
  });

const OfferHistoryCursorSchema = z.strictObject({
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  recordedAt: IsoDateTimeSchema,
  itemId: OpaqueReferenceSchema,
  provider: OpaqueReferenceSchema,
  offerId: OpaqueReferenceSchema,
  offerVersion: z.number().int().positive(),
});

const OfferHistoryRetentionSchema = z
  .strictObject({
    retainedEntryCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    lastAppendSequence: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    latestRecordedAt: IsoDateTimeSchema.nullable(),
    latestCursor: OfferHistoryCursorSchema.nullable(),
  })
  .superRefine((retention, context) => {
    const isEmpty = retention.retainedEntryCount === 0;
    if (
      isEmpty !==
      (retention.latestRecordedAt === null && retention.latestCursor === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Retention continuation is inconsistent',
      });
    }
    if (
      retention.latestCursor !== null &&
      retention.latestCursor.recordedAt !== retention.latestRecordedAt
    ) {
      context.addIssue({
        code: 'custom',
        path: ['latestCursor'],
        message: 'The latest cursor must identify the latest timestamp',
      });
    }
    if (
      retention.latestCursor !== null &&
      retention.latestCursor.sequence > retention.lastAppendSequence
    ) {
      context.addIssue({
        code: 'custom',
        path: ['latestCursor', 'sequence'],
        message: 'The latest cursor cannot exceed the repository sequence',
      });
    }
  });

const OfferHistoryRecordSchema = z.strictObject({
  entry: OfferHistoryEntrySchema,
  cursor: OfferHistoryCursorSchema,
});

const CandidateRepositoryLookupSchema = z.strictObject({
  // This lookup is scoped to the candidate provider/id/version and must be
  // read in the same repository transaction that commits the returned append.
  versionBinding: CommerceOfferSchema.nullable(),
  exactSnapshot: OfferHistoryRecordSchema.nullable(),
});

const PrepareOfferHistoryAppendInputSchema = z.strictObject({
  tail: z.array(OfferHistoryEntrySchema).max(MAX_OFFER_HISTORY_TAIL_ENTRIES),
  retention: OfferHistoryRetentionSchema,
  candidateLookup: CandidateRepositoryLookupSchema,
  appendSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  itemId: OpaqueReferenceSchema,
  offer: CommerceOfferSchema,
  recordedAt: IsoDateTimeSchema,
});

export type OfferHistoryEntry = DeepReadonly<
  z.output<typeof OfferHistoryEntrySchema>
>;
export type OfferHistoryCursor = DeepReadonly<
  z.output<typeof OfferHistoryCursorSchema>
>;
export type OfferHistoryRetention = DeepReadonly<
  z.output<typeof OfferHistoryRetentionSchema>
>;

type OfferHistorySafeErrorCode =
  'offer-history-invalid' | 'offer-history-version-conflict';

export type PrepareOfferHistoryAppendResult =
  | DeepReadonly<{
      status: 'appended';
      entry: OfferHistoryEntry;
      cursor: OfferHistoryCursor;
      nextRetention: OfferHistoryRetention;
      versionBinding: CommerceOffer;
    }>
  | DeepReadonly<{
      status: 'duplicate';
      entry: OfferHistoryEntry;
      cursor: OfferHistoryCursor;
      retention: OfferHistoryRetention;
    }>
  | DeepReadonly<{
      status: 'rejected';
      safeError: {
        code: OfferHistorySafeErrorCode;
        message: string;
        retryable: false;
      };
    }>;

const invalidHistory = (
  code: OfferHistorySafeErrorCode = 'offer-history-invalid',
): PrepareOfferHistoryAppendResult =>
  deepFreeze({
    status: 'rejected',
    safeError: {
      code,
      message:
        code === 'offer-history-version-conflict'
          ? 'The offer version is already bound to different content.'
          : 'The offer history request is invalid.',
      retryable: false,
    },
  });

const offerVersionKey = (entry: { readonly offer: CommerceOffer }): string =>
  `${entry.offer.provider}\u0000${entry.offer.id}\u0000${entry.offer.version}`;

const canonicalEntry = (entry: OfferHistoryEntry): string =>
  JSON.stringify(entry);
const canonicalOffer = (entry: { readonly offer: CommerceOffer }): string =>
  JSON.stringify(entry.offer);

const cursorFor = (
  entry: OfferHistoryEntry,
  sequence: number,
): OfferHistoryCursor => ({
  sequence,
  recordedAt: entry.recordedAt,
  itemId: entry.itemId,
  provider: entry.offer.provider,
  offerId: entry.offer.id,
  offerVersion: entry.offer.version,
});

const cursorMatchesEntry = (
  cursor: OfferHistoryCursor,
  entry: OfferHistoryEntry,
): boolean =>
  cursor.recordedAt === entry.recordedAt &&
  cursor.itemId === entry.itemId &&
  cursor.provider === entry.offer.provider &&
  cursor.offerId === entry.offer.id &&
  cursor.offerVersion === entry.offer.version;

/**
 * Validates one append against a bounded repository tail plus candidate-scoped
 * global lookup evidence. The caller persists `entry`, `versionBinding`, and
 * `nextRetention` atomically. No retained history is returned, evicted, or
 * capped by this operation; full history remains queryable in repository pages.
 */
export const prepareOfferHistorySnapshotAppend = (
  input: unknown,
): PrepareOfferHistoryAppendResult => {
  if (!isBoundedAcyclicData(input)) return invalidHistory();

  try {
    const parsed = PrepareOfferHistoryAppendInputSchema.safeParse(input);
    if (!parsed.success) return invalidHistory();

    const { tail, retention, candidateLookup } = parsed.data;
    if (tail.length > retention.retainedEntryCount) return invalidHistory();
    if (parsed.data.appendSequence <= retention.lastAppendSequence) {
      return invalidHistory();
    }

    let previousRecordedAt = Number.NEGATIVE_INFINITY;
    const tailVersionBindings = new Map<string, string>();
    const exactTailEntries = new Set<string>();
    for (const entry of tail) {
      const recordedAt = Date.parse(entry.recordedAt);
      if (recordedAt < previousRecordedAt) return invalidHistory();
      previousRecordedAt = recordedAt;

      const key = offerVersionKey(entry);
      const canonical = canonicalOffer(entry);
      const exactEntry = canonicalEntry(entry);
      if (exactTailEntries.has(exactEntry)) return invalidHistory();
      exactTailEntries.add(exactEntry);
      const existing = tailVersionBindings.get(key);
      if (existing !== undefined && existing !== canonical) {
        return invalidHistory('offer-history-version-conflict');
      }
      tailVersionBindings.set(key, canonical);
    }

    if (tail.length > 0) {
      const latestTailEntry = tail.at(-1);
      if (
        latestTailEntry === undefined ||
        latestTailEntry.recordedAt !== retention.latestRecordedAt ||
        retention.latestCursor === null ||
        !cursorMatchesEntry(retention.latestCursor, latestTailEntry)
      ) {
        return invalidHistory();
      }
    }

    const candidateResult = OfferHistoryEntrySchema.safeParse({
      itemId: parsed.data.itemId,
      offer: parsed.data.offer,
      recordedAt: parsed.data.recordedAt,
    });
    if (!candidateResult.success) return invalidHistory();
    const candidate = candidateResult.data as OfferHistoryEntry;
    const candidateKey = offerVersionKey(candidate);
    const candidateOfferCanonical = canonicalOffer(candidate);
    const candidateEntryCanonical = canonicalEntry(candidate);

    const lookupBinding = candidateLookup.versionBinding;
    if (
      lookupBinding !== null &&
      offerVersionKey({ offer: lookupBinding }) !== candidateKey
    ) {
      return invalidHistory();
    }

    const tailBinding = tailVersionBindings.get(candidateKey);
    if (tailBinding !== undefined && lookupBinding === null) {
      return invalidHistory();
    }
    if (
      lookupBinding !== null &&
      JSON.stringify(lookupBinding) !== candidateOfferCanonical
    ) {
      return invalidHistory('offer-history-version-conflict');
    }
    if (tailBinding !== undefined && tailBinding !== candidateOfferCanonical) {
      return invalidHistory('offer-history-version-conflict');
    }

    const lookupExact = candidateLookup.exactSnapshot;
    if (lookupExact !== null) {
      if (
        canonicalEntry(lookupExact.entry as OfferHistoryEntry) !==
          candidateEntryCanonical ||
        lookupBinding === null ||
        !cursorMatchesEntry(lookupExact.cursor, lookupExact.entry) ||
        lookupExact.cursor.sequence > retention.lastAppendSequence
      ) {
        return invalidHistory();
      }
      return deepFreeze({
        status: 'duplicate' as const,
        entry: candidate,
        cursor: lookupExact.cursor,
        retention,
      });
    }
    if (exactTailEntries.has(candidateEntryCanonical)) {
      return invalidHistory();
    }

    if (
      retention.latestRecordedAt !== null &&
      Date.parse(candidate.recordedAt) < Date.parse(retention.latestRecordedAt)
    ) {
      return invalidHistory();
    }

    const cursor = cursorFor(candidate, parsed.data.appendSequence);
    const nextRetention: OfferHistoryRetention = {
      retainedEntryCount: retention.retainedEntryCount + 1,
      lastAppendSequence: parsed.data.appendSequence,
      latestRecordedAt: candidate.recordedAt,
      latestCursor: cursor,
    };
    if (nextRetention.retainedEntryCount > Number.MAX_SAFE_INTEGER) {
      return invalidHistory();
    }

    return deepFreeze({
      status: 'appended' as const,
      entry: candidate,
      cursor,
      nextRetention,
      versionBinding: candidate.offer,
    });
  } catch {
    return invalidHistory();
  }
};
