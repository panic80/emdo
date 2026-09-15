import { z } from 'zod';
import {
  CommitInvestmentStockSplitSchema,
  FinanceCurrencySchema,
  FinanceStockSplitActionSchema,
  FinanceStockSplitCommitResultSchema,
  InvestmentLotStateSchema,
  StartFinanceStandardizationSchema,
  UuidSchema,
} from '@emdo/contracts/browser';

const CatalogRecordSchema = z.object({ id: UuidSchema }).passthrough();

const FinancialAccountSchema = CatalogRecordSchema.extend({
  name: z.string(),
  kind: z.string(),
  currency: FinanceCurrencySchema,
  active: z.boolean().optional(),
}).passthrough();

const InvestmentCatalogSchema = z
  .object({
    instruments: z.array(CatalogRecordSchema).max(10_000),
    prices: z.array(CatalogRecordSchema).max(10_000),
    fx: z.array(CatalogRecordSchema).max(10_000),
    openings: z.array(CatalogRecordSchema).max(10_000),
    observedPositions: z.array(CatalogRecordSchema).max(10_000),
  })
  .passthrough();

const EvidenceSchema = z.strictObject({
  id: UuidSchema,
  filename: z.string().trim().min(1).max(255),
  format: z.string().trim().min(1).max(40),
  byteSize: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  sourceDigest:
    StartFinanceStandardizationSchema.shape.expectedSourceDigest.optional(),
});

const EvidencePageSchema = z.strictObject({
  documents: z.array(EvidenceSchema).max(50),
  nextOffset: z.number().int().nonnegative().nullable(),
});

const SourceSchema = z.strictObject({
  sourceRevision: z.number().int().nonnegative().safe(),
  sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceAsOf: z.iso.date(),
  sourceBoundary: z.literal('immediately-before-action'),
  sourceLots: z.array(InvestmentLotStateSchema).max(10_000),
});

const LotViewSchema = z
  .object({
    id: UuidSchema,
    movementId: UuidSchema,
    financialAccountId: UuidSchema,
    instrumentId: UuidSchema,
    nativeCurrency: FinanceCurrencySchema,
    functionalCurrency: FinanceCurrencySchema,
    originalQuantity: z.string(),
    remainingQuantity: z.string(),
    originalNativeCost: z.string(),
    remainingNativeCost: z.string(),
    originalFunctionalCost: z.string(),
    remainingFunctionalCost: z.string(),
    acquiredOn: z.iso.date(),
    sourceReference: z.string(),
  })
  .passthrough();

const LotsPageSchema = z.strictObject({
  lots: z.array(LotViewSchema).max(100),
  nextOffset: z.number().int().nonnegative().nullable(),
});

const RevisionSchema = z.strictObject({
  revision: z.number().int().nonnegative().safe(),
});

export type FinancialAccount = z.infer<typeof FinancialAccountSchema>;
export type InvestmentCatalog = z.infer<typeof InvestmentCatalogSchema>;
export type InvestmentEvidence = z.infer<typeof EvidenceSchema>;
export type CorporateActionSource = z.infer<typeof SourceSchema>;
export type InvestmentLotView = z.infer<typeof LotViewSchema>;
export type InvestmentStockSplitCommit = z.infer<
  typeof FinanceStockSplitCommitResultSchema
>;
export type CorporateActionApiInput = z.infer<
  typeof CommitInvestmentStockSplitSchema
>;

export class CorporateActionApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CorporateActionApiError';
  }
}

const messageForStatus = (status: number): string => {
  if (status === 401 || status === 403)
    return 'Current book access does not permit this investment action.';
  if (status === 409)
    return 'The book changed while this review was open. Refresh sources before committing.';
  if (status === 503)
    return 'Investment actions are not available in this environment.';
  return 'Unable to load the investment action sources. Check the book and try again.';
};

const request = async (
  url: string,
  init: RequestInit = {},
): Promise<unknown> => {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
  });
  if (!response.ok)
    throw new CorporateActionApiError(
      response.status,
      messageForStatus(response.status),
    );
  return response.json() as Promise<unknown>;
};

const readAllPages = async <T>(
  readPage: (
    offset: number,
  ) => Promise<{ items: T[]; nextOffset: number | null }>,
  maxItems: number,
): Promise<T[]> => {
  const items: T[] = [];
  let offset = 0;
  while (items.length < maxItems) {
    const page = await readPage(offset);
    items.push(...page.items);
    if (page.nextOffset === null || page.items.length === 0) break;
    if (page.nextOffset <= offset)
      throw new Error('The investment source pagination is invalid.');
    offset = page.nextOffset;
  }
  return items.slice(0, maxItems);
};

export const financeCorporateActionApi = {
  async readAccounts(
    bookId: string,
    signal?: AbortSignal,
  ): Promise<FinancialAccount[]> {
    const result = z
      .strictObject({ accounts: z.array(FinancialAccountSchema).max(10_000) })
      .parse(
        await request(`/api/v2/finance/books/${bookId}/financial-accounts`, {
          signal,
        }),
      );
    return result.accounts;
  },

  async readInvestments(
    bookId: string,
    signal?: AbortSignal,
  ): Promise<InvestmentCatalog> {
    return InvestmentCatalogSchema.parse(
      await request(`/api/v2/finance/books/${bookId}/investments`, { signal }),
    );
  },

  async readEvidence(
    bookId: string,
    signal?: AbortSignal,
  ): Promise<InvestmentEvidence[]> {
    return readAllPages(async (offset) => {
      const result = EvidencePageSchema.parse(
        await request(
          `/api/v2/finance/books/${bookId}/evidence?offset=${offset}`,
          { signal },
        ),
      );
      return { items: result.documents, nextOffset: result.nextOffset };
    }, 1_000);
  },

  async readLots(
    bookId: string,
    signal?: AbortSignal,
  ): Promise<InvestmentLotView[]> {
    return readAllPages(async (offset) => {
      const result = LotsPageSchema.parse(
        await request(
          `/api/v2/finance/books/${bookId}/investments/lots?offset=${offset}&limit=100`,
          { signal },
        ),
      );
      return { items: result.lots, nextOffset: result.nextOffset };
    }, 10_000);
  },

  async readRevision(bookId: string, signal?: AbortSignal): Promise<number> {
    const result = RevisionSchema.parse(
      await request(
        `/api/v2/finance/books/${bookId}/investments/corporate-actions/revision`,
        { signal },
      ),
    );
    return result.revision;
  },

  async readSource(
    bookId: string,
    action: unknown,
    signal?: AbortSignal,
  ): Promise<CorporateActionSource> {
    const parsed = FinanceStockSplitActionSchema.parse(action);
    return SourceSchema.parse(
      await request(
        `/api/v2/finance/books/${bookId}/investments/corporate-actions/stock-splits/source`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(parsed),
          signal,
        },
      ),
    );
  },

  async commit(
    bookId: string,
    input: unknown,
    csrfToken: string | undefined,
    signal?: AbortSignal,
  ): Promise<InvestmentStockSplitCommit> {
    if (!csrfToken)
      throw new Error('Sign in again before committing this action.');
    const parsed = CommitInvestmentStockSplitSchema.parse(input);
    return FinanceStockSplitCommitResultSchema.parse(
      await request(
        `/api/v2/finance/books/${bookId}/investments/corporate-actions/stock-splits/commit`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
            'idempotency-key': parsed.idempotencyKey,
          },
          body: JSON.stringify(parsed),
          signal,
        },
      ),
    );
  },
};
