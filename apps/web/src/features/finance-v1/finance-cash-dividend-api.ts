import { z } from 'zod';
import {
  CommitInvestmentCashDividendSchema,
  FinanceCashDividendCommitResultSchema,
  FinanceCashDividendDraftSchema,
  FinanceCashDividendListSchema,
  FinanceCashDividendPlanSchema,
  FinanceCashDividendSavedActionSchema,
  FinanceCashDividendSourceSnapshotSchema,
  FinanceCurrencySchema,
  FinanceBookRoleSchema,
  FinanceDecimalSchema,
  ReadInvestmentCashDividendSourceSchema,
  UuidSchema,
  type FinanceCashDividendSourceSnapshot,
  type ReadInvestmentCashDividendSource,
} from '@emdo/contracts/browser';
import { saveMemoryFile } from '../../downloads/save-memory-file.js';
import { downloadBinaryBookOriginal } from './finance-book-evidence-files.js';
import { parseFinanceDecimal } from '@emdo/domains/finance/decimal';

const FinancialAccount = z.object({
  id: UuidSchema,
  name: z.string(),
  kind: z.string(),
  currency: FinanceCurrencySchema,
  ledgerAccountId: UuidSchema,
  active: z.boolean().optional(),
});
const Instrument = z.object({
  id: UuidSchema,
  name: z.string().optional(),
  symbol: z.string().optional(),
  ticker: z.string().optional(),
});
const LedgerAccount = z.object({
  id: UuidSchema,
  code: z.string(),
  name: z.string(),
  kind: z.string(),
  active: z.boolean(),
});
const ImportSummary = z.object({
  id: UuidSchema,
  financialAccountId: UuidSchema,
  evidenceId: UuidSchema,
  filename: z.string(),
  status: z.string(),
  revision: z.number().int().positive(),
});
const ImportReview = z.object({
  batch: z.object({
    id: UuidSchema,
    book_id: UuidSchema,
    financial_account_id: UuidSchema,
    evidence_id: UuidSchema,
    revision: z.number().int().positive(),
    status: z.string(),
  }),
  rows: z
    .array(
      z.object({
        id: UuidSchema,
        source_row: z.number().int().positive(),
        date: z.string().nullable(),
        amount: FinanceDecimalSchema.nullable(),
        description: z.string(),
        status: z.string(),
        revision: z.number().int().positive(),
        issues: z.array(z.string()),
      }),
    )
    .max(10_000),
});
export const DividendPreviewInputSchema = z.strictObject({
  action: FinanceCashDividendDraftSchema,
  expectedSourceRevision: z.number().int().positive().safe(),
  sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type DividendCatalog = {
  role: z.infer<typeof FinanceBookRoleSchema>;
  accounts: z.infer<typeof FinancialAccount>[];
  instruments: z.infer<typeof Instrument>[];
  ledger: z.infer<typeof LedgerAccount>[];
  imports: z.infer<typeof ImportSummary>[];
};
export type DividendImport = z.infer<typeof ImportReview>;
export type DividendPlan = z.infer<typeof FinanceCashDividendPlanSchema>;
export type SavedDividend = z.infer<
  typeof FinanceCashDividendSavedActionSchema
>;
export type DividendReceipt = z.infer<
  typeof FinanceCashDividendCommitResultSchema
>;
export type DividendCommitInput = z.infer<
  typeof CommitInvestmentCashDividendSchema
>;
const equalDecimal = (left: string, right: string) =>
  parseFinanceDecimal(left) === parseFinanceDecimal(right);
export function savedDividendMatchesCommit(
  record: SavedDividend,
  input: DividendCommitInput,
) {
  const action = input.action;
  return (
    record.id === action.id &&
    record.sourceRowId === action.sourceRowId &&
    record.sourceSnapshotHash === input.sourceSnapshotHash &&
    record.sourceRevision === input.expectedSourceRevision &&
    record.sourceReference === action.sourceReference &&
    record.reviewReason === action.reviewReason &&
    record.declaredOn === action.declaredOn &&
    record.exDate === action.exDate &&
    record.payableOn === action.payableOn &&
    record.evidenceId === action.evidenceId &&
    record.instrumentId === action.instrumentId &&
    record.financialAccountId === action.financialAccountId &&
    record.cashLedgerAccountId === action.ledger.cashLedgerAccountId &&
    record.dividendIncomeLedgerAccountId ===
      action.ledger.dividendIncomeLedgerAccountId &&
    record.withholdingLedgerAccountId ===
      action.ledger.withholdingLedgerAccountId &&
    (['gross', 'withholding', 'net'] as const).every(
      (kind) =>
        equalDecimal(record[kind].nativeAmount, action[kind].nativeAmount) &&
        equalDecimal(
          record[kind].functionalAmount,
          action[kind].functionalAmount,
        ) &&
        equalDecimal(record[kind].fxRate, action[kind].fxRate) &&
        record[kind].currency === action[kind].currency &&
        record[kind].fxSource === action[kind].fxSource &&
        JSON.stringify(record[kind].provenance) ===
          JSON.stringify(action[kind].provenance),
    )
  );
}
export const dividendBase = (bookId: string) =>
  `/api/v2/finance/books/${bookId}/investments/cash-dividends`;

export class DividendApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = '',
  ) {
    super(message);
  }
}
export const dividendError = (cause: unknown) =>
  cause instanceof z.ZodError
    ? 'The dividend data could not be verified. Refresh this book before continuing.'
    : cause instanceof Error
      ? cause.message
      : 'Unable to load this dividend review.';
const statusMessage = (status: number) =>
  status === 401
    ? 'Sign in again to access dividend records. Loaded review details have been cleared.'
    : status === 403
      ? 'Current book access does not permit this dividend operation. Loaded review details have been cleared.'
      : status === 404 || status === 503
        ? 'This dividend record or review capability is not available right now. No posting has been confirmed.'
        : status === 409
          ? 'The source row or book changed, or the dividend requires further review. Refresh the source and check the current amounts, dates and accounts before posting.'
          : 'The dividend request could not be completed. Check its saved status before trying again.';
async function request(
  path: string,
  signal: AbortSignal,
  init: RequestInit = {},
) {
  if (signal.aborted) throw new DOMException('Request aborted', 'AbortError');
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    signal,
  });
  if (!response.ok) {
    const problem = z
      .object({ code: z.string().optional() })
      .safeParse(await response.json().catch(() => null));
    throw new DividendApiError(
      response.status,
      statusMessage(response.status),
      problem.success ? problem.data.code : undefined,
    );
  }
  const result: unknown = await response.json();
  if (signal.aborted) throw new DOMException('Request aborted', 'AbortError');
  return result;
}
function sourceMatches(
  source: FinanceCashDividendSourceSnapshot,
  expected: ReadInvestmentCashDividendSource,
) {
  return (
    source.sourceRowId === expected.sourceRowId &&
    source.evidenceId === expected.evidenceId &&
    source.financialAccountId === expected.financialAccountId &&
    source.instrumentId === expected.instrumentId
  );
}
export function verifySavedDividend(
  raw: unknown,
  bookId: string,
  actionId?: string,
) {
  const record = FinanceCashDividendSavedActionSchema.parse(raw);
  if (
    record.bookId !== bookId ||
    (actionId && record.id !== actionId) ||
    record.source.sourceRowId !== record.sourceRowId ||
    record.source.evidenceId !== record.evidenceId ||
    record.source.sourceSnapshotHash !== record.sourceSnapshotHash ||
    record.source.sourceRevision !== record.sourceRevision ||
    record.source.financialAccountId !== record.financialAccountId ||
    record.source.instrumentId !== record.instrumentId ||
    (['gross', 'withholding', 'net'] as const).some(
      (kind) =>
        record[kind].kind !== kind ||
        record[kind].journalId !== record.journalId,
    )
  )
    throw new Error(
      'The saved dividend and its source proof do not match the selected book or action.',
    );
  return record;
}
export const dividendApi = {
  async list(bookId: string, offset: number, signal: AbortSignal) {
    const page = FinanceCashDividendListSchema.parse(
      await request(
        `${dividendBase(bookId)}?offset=${offset}&limit=20`,
        signal,
      ),
    );
    page.actions.forEach((action) => verifySavedDividend(action, bookId));
    if (
      new Set(page.actions.map((action) => action.id)).size !==
        page.actions.length ||
      (page.nextOffset !== null && page.nextOffset <= offset)
    )
      throw new Error('The saved dividend page could not be verified.');
    return page;
  },
  async detail(bookId: string, actionId: string, signal: AbortSignal) {
    return verifySavedDividend(
      await request(`${dividendBase(bookId)}/${actionId}`, signal),
      bookId,
      actionId,
    );
  },
  async catalog(bookId: string, signal: AbortSignal): Promise<DividendCatalog> {
    const base = `/api/v2/finance/books/${bookId}`;
    const results = await Promise.all([
      request(`${base}/financial-accounts`, signal),
      request(`${base}/investments`, signal),
      request(base, signal),
      request(`${base}/imports`, signal),
    ]);
    const accounts = z
      .object({ accounts: z.array(FinancialAccount).max(10_000) })
      .parse(results[0]).accounts;
    const instruments = z
      .object({ instruments: z.array(Instrument).max(10_000) })
      .parse(results[1]).instruments;
    const overview = z
      .object({
        book: z.object({ id: UuidSchema, role: FinanceBookRoleSchema }),
        accounts: z.array(LedgerAccount).max(10_000),
      })
      .parse(results[2]);
    if (overview.book.id !== bookId)
      throw new Error(
        'The ledger accounts do not belong to the selected book.',
      );
    return {
      role: overview.book.role,
      accounts,
      instruments,
      ledger: overview.accounts,
      imports: z
        .object({ imports: z.array(ImportSummary).max(10_000) })
        .parse(results[3]).imports,
    };
  },
  async import(
    bookId: string,
    summary: DividendCatalog['imports'][number],
    signal: AbortSignal,
  ) {
    const result = ImportReview.parse(
      await request(
        `/api/v2/finance/books/${bookId}/imports/${summary.id}`,
        signal,
      ),
    );
    if (
      result.batch.id !== summary.id ||
      result.batch.book_id !== bookId ||
      result.batch.financial_account_id !== summary.financialAccountId ||
      result.batch.evidence_id !== summary.evidenceId
    )
      throw new Error(
        'The statement rows do not match the selected book and original. Refresh sources.',
      );
    return result;
  },
  async source(bookId: string, input: unknown, signal: AbortSignal) {
    const body = ReadInvestmentCashDividendSourceSchema.parse(input);
    const source = FinanceCashDividendSourceSnapshotSchema.parse(
      await request(`${dividendBase(bookId)}/source`, signal, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (!sourceMatches(source, body))
      throw new Error(
        'The dividend source does not match the selected statement row.',
      );
    return source;
  },
  async preview(bookId: string, input: unknown, signal: AbortSignal) {
    const body = DividendPreviewInputSchema.parse(input);
    const plan = FinanceCashDividendPlanSchema.parse(
      await request(`${dividendBase(bookId)}/preview`, signal, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (
      !sourceMatches(plan.source, body.action) ||
      plan.source.sourceRevision !== body.expectedSourceRevision ||
      plan.source.sourceSnapshotHash !== body.sourceSnapshotHash ||
      JSON.stringify(plan.action) !== JSON.stringify(body.action)
    )
      throw new Error(
        'The dividend preview does not match the reviewed amounts and source revision. Refresh sources.',
      );
    return plan;
  },
  async commit(
    bookId: string,
    input: unknown,
    csrfToken: string | undefined,
    signal: AbortSignal,
  ) {
    if (!csrfToken)
      throw new Error('Sign in again before posting a reviewed dividend.');
    const body = CommitInvestmentCashDividendSchema.parse(input);
    const receipt = FinanceCashDividendCommitResultSchema.parse(
      await request(`${dividendBase(bookId)}/commit`, signal, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
          'idempotency-key': body.idempotencyKey,
        },
        body: JSON.stringify(body),
      }),
    );
    if (
      receipt.bookId !== bookId ||
      receipt.actionId !== body.action.id ||
      receipt.sourceRowId !== body.action.sourceRowId ||
      receipt.sourceRevision !== body.expectedSourceRevision ||
      receipt.sourceSnapshotHash !== body.sourceSnapshotHash ||
      !equalDecimal(
        receipt.grossFunctionalAmount,
        body.action.gross.functionalAmount,
      ) ||
      !equalDecimal(
        receipt.withholdingFunctionalAmount,
        body.action.withholding.functionalAmount,
      ) ||
      !equalDecimal(
        receipt.netFunctionalAmount,
        body.action.net.functionalAmount,
      )
    )
      throw new Error(
        'The posting response could not be matched to this dividend. Check the saved action before retrying.',
      );
    return receipt;
  },
  async downloadOriginal(
    bookId: string,
    evidenceId: string,
    signal: AbortSignal,
  ) {
    const raw = z
      .object({
        filename: z.string().min(1).max(200),
        format: z.string(),
        sourceText: z.string().max(2_097_152).optional(),
      })
      .passthrough()
      .parse(
        await request(
          `/api/v2/finance/books/${bookId}/evidence/${evidenceId}`,
          signal,
        ),
      );
    if (signal.aborted) return;
    if (raw.format === 'pdf' || raw.format === 'xlsx')
      return downloadBinaryBookOriginal(raw, raw.format);
    if (
      !['csv', 'ofx', 'qfx'].includes(raw.format) ||
      !raw.sourceText ||
      new TextEncoder().encode(raw.sourceText).length > 2_097_152
    )
      throw new Error(
        'The original document could not be verified for download.',
      );
    saveMemoryFile(
      raw.filename,
      raw.sourceText,
      raw.format === 'csv' ? 'text/csv' : 'application/x-ofx',
    );
  },
};
