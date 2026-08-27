import { deepFreeze, type DeepReadonly } from '@emdo/contracts';
import { z } from 'zod';

const DateOnlySchema = z.iso.date();
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/u);
const RankSchema = z.number().int().positive().max(100_000);

const RetrievalCandidateSchema = z.strictObject({
  evidenceId: z.string().trim().min(1).max(512),
  structuredRank: RankSchema.nullable(),
  fullTextRank: RankSchema.nullable(),
  vectorRank: RankSchema.nullable(),
});

export interface FinanceEvidenceRankCandidate {
  readonly evidenceId: string;
  readonly structuredRank: number | null;
  readonly fullTextRank: number | null;
  readonly vectorRank: number | null;
}

export interface RankedFinanceEvidence {
  readonly evidenceId: string;
  readonly scoreMillionths: number;
}

/**
 * Deterministic reciprocal-rank fusion. The server applies uploader filters
 * before constructing these candidates; this function performs no I/O and
 * cannot broaden a query scope.
 */
export const fuseFinanceEvidenceRanks = (input: {
  readonly candidates: readonly FinanceEvidenceRankCandidate[];
  readonly limit: number;
}): readonly DeepReadonly<RankedFinanceEvidence>[] => {
  const parsed = z
    .strictObject({
      candidates: z.array(RetrievalCandidateSchema).max(2_000),
      limit: z.number().int().min(1).max(50),
    })
    .parse(input);
  const deduplicated = new Map<
    string,
    {
      structuredRank: number | null;
      fullTextRank: number | null;
      vectorRank: number | null;
    }
  >();
  for (const candidate of parsed.candidates) {
    const previous = deduplicated.get(candidate.evidenceId);
    deduplicated.set(candidate.evidenceId, {
      structuredRank:
        previous?.structuredRank === undefined ||
        previous.structuredRank === null
          ? candidate.structuredRank
          : candidate.structuredRank === null
            ? previous.structuredRank
            : Math.min(previous.structuredRank, candidate.structuredRank),
      fullTextRank:
        previous?.fullTextRank === undefined || previous.fullTextRank === null
          ? candidate.fullTextRank
          : candidate.fullTextRank === null
            ? previous.fullTextRank
            : Math.min(previous.fullTextRank, candidate.fullTextRank),
      vectorRank:
        previous?.vectorRank === undefined || previous.vectorRank === null
          ? candidate.vectorRank
          : candidate.vectorRank === null
            ? previous.vectorRank
            : Math.min(previous.vectorRank, candidate.vectorRank),
    });
  }

  const reciprocal = (rank: number | null, weight: number): number =>
    rank === null ? 0 : Math.round((weight * 1_000_000) / (60 + rank));
  return deepFreeze(
    [...deduplicated.entries()]
      .map(([evidenceId, ranks]) => ({
        evidenceId,
        // Structured facts lead; text and semantic similarity are supporting
        // signals only. Integer math keeps the ranking reproducible.
        scoreMillionths:
          reciprocal(ranks.structuredRank, 5) +
          reciprocal(ranks.fullTextRank, 3) +
          reciprocal(ranks.vectorRank, 2),
      }))
      .filter(({ scoreMillionths }) => scoreMillionths > 0)
      .sort(
        (left, right) =>
          right.scoreMillionths - left.scoreMillionths ||
          left.evidenceId.localeCompare(right.evidenceId),
      )
      .slice(0, parsed.limit),
  );
};

const MatchSourceSchema = z.strictObject({
  documentId: z.uuid(),
  extractionRevision: z.number().int().positive(),
  documentType: z.enum([
    'receipt',
    'invoice',
    'bank-statement',
    'credit-statement',
    'pay-stub',
    'tax-slip',
    'insurance',
    'loan',
    'investment-statement',
    'other',
  ]),
  currency: CurrencySchema.nullable(),
  amountMinorUnits: z.number().int().safe().nullable(),
  occurredOn: DateOnlySchema.nullable(),
  merchantOrPayee: z.string().trim().min(1).max(2_000).nullable(),
});

const MatchRecordSchema = z.strictObject({
  recordType: z.enum(['transaction', 'bill']),
  recordId: z.string().trim().min(1).max(512),
  currency: CurrencySchema,
  amountMinorUnits: z.number().int().safe(),
  occurredOn: DateOnlySchema,
  merchantOrPayee: z.string().trim().min(1).max(2_000),
});

const documentTypeAccepts = (
  documentType: z.output<typeof MatchSourceSchema>['documentType'],
  recordType: z.output<typeof MatchRecordSchema>['recordType'],
): boolean => {
  if (
    documentType === 'invoice' ||
    documentType === 'insurance' ||
    documentType === 'loan'
  ) {
    return recordType === 'transaction' || recordType === 'bill';
  }
  return (
    (documentType === 'receipt' || documentType === 'pay-stub') &&
    recordType === 'transaction'
  );
};

const normalizedTerms = (value: string): readonly string[] =>
  [
    ...new Set(
      value
        .normalize('NFKD')
        .toLocaleLowerCase('en-CA')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .split(/\s+/u)
        .filter((term) => term.length > 1),
    ),
  ].sort();

const merchantSimilarityBasisPoints = (left: string, right: string): number => {
  const leftTerms = normalizedTerms(left);
  const rightTerms = normalizedTerms(right);
  if (leftTerms.length === 0 || rightTerms.length === 0) return 0;
  const rightSet = new Set(rightTerms);
  const intersection = leftTerms.filter((term) => rightSet.has(term)).length;
  const union = new Set([...leftTerms, ...rightTerms]).size;
  return Math.floor((intersection * 10_000) / union);
};

const utcDay = (value: string): number => Date.parse(`${value}T00:00:00.000Z`);

export interface FinanceDocumentMatchSuggestion {
  readonly documentId: string;
  readonly extractionRevision: number;
  readonly recordType: 'transaction' | 'bill';
  readonly recordId: string;
  readonly scoreBasisPoints: number;
  readonly reasons: readonly [
    'currency-exact',
    'amount-exact',
    'date-window',
    'merchant-payee-normalized',
    'document-type-compatible',
  ];
  readonly state: 'suggested';
}

/** Returns suggestions only. Non-CAD sources never participate in matching. */
export const suggestFinanceDocumentMatches = (input: {
  readonly source: z.input<typeof MatchSourceSchema>;
  readonly records: readonly z.input<typeof MatchRecordSchema>[];
  readonly dateWindowDays?: number;
  readonly limit?: number;
}): readonly DeepReadonly<FinanceDocumentMatchSuggestion>[] => {
  const parsed = z
    .strictObject({
      source: MatchSourceSchema,
      records: z.array(MatchRecordSchema).max(100_000),
      dateWindowDays: z.number().int().min(0).max(31).default(7),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .parse(input);
  const source = parsed.source;
  if (
    source.currency !== 'CAD' ||
    source.amountMinorUnits === null ||
    source.occurredOn === null ||
    source.merchantOrPayee === null ||
    !['receipt', 'invoice', 'pay-stub', 'insurance', 'loan'].includes(
      source.documentType,
    )
  ) {
    return deepFreeze([]);
  }
  const sourceDay = utcDay(source.occurredOn);
  const maximumDistanceMs = parsed.dateWindowDays * 86_400_000;
  return deepFreeze(
    parsed.records
      .flatMap((record): DeepReadonly<FinanceDocumentMatchSuggestion>[] => {
        const similarity = merchantSimilarityBasisPoints(
          source.merchantOrPayee!,
          record.merchantOrPayee,
        );
        if (
          record.currency !== 'CAD' ||
          record.amountMinorUnits !== source.amountMinorUnits ||
          Math.abs(utcDay(record.occurredOn) - sourceDay) > maximumDistanceMs ||
          similarity < 5_000 ||
          !documentTypeAccepts(source.documentType, record.recordType)
        ) {
          return [];
        }
        const distanceDays =
          Math.abs(utcDay(record.occurredOn) - sourceDay) / 86_400_000;
        const dateScore = Math.max(
          0,
          10_000 -
            Math.floor(
              (distanceDays * 2_000) / Math.max(1, parsed.dateWindowDays),
            ),
        );
        const suggestion = {
          documentId: source.documentId,
          extractionRevision: source.extractionRevision,
          recordType: record.recordType,
          recordId: record.recordId,
          scoreBasisPoints: Math.floor(
            (similarity * 4 + dateScore * 2 + 40_000) / 10,
          ),
          reasons: [
            'currency-exact',
            'amount-exact',
            'date-window',
            'merchant-payee-normalized',
            'document-type-compatible',
          ] as const,
          state: 'suggested',
        } satisfies FinanceDocumentMatchSuggestion;
        return [deepFreeze(suggestion)];
      })
      .sort(
        (left, right) =>
          right.scoreBasisPoints - left.scoreBasisPoints ||
          left.recordType.localeCompare(right.recordType) ||
          left.recordId.localeCompare(right.recordId),
      )
      .slice(0, parsed.limit),
  );
};
