import { z } from 'zod';
import {
  CommitInvestmentCashDividendSchema,
  FinanceCashDividendDraftSchema,
  FinanceCashDividendSavedActionSchema,
  FinanceCashDividendSourceSnapshotSchema,
  ReadInvestmentCashDividendSourceSchema,
  type FinanceCashDividendSavedAction,
} from '@emdo/contracts/browser';
import {
  formatFinanceDecimal,
  parseFinanceDecimal,
  planInvestmentCashDividend,
} from '@emdo/domains/finance';

const id = (n: number) =>
  `75000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const dividendIds = {
  book: id(1),
  account: id(2),
  instrument: id(3),
  evidence: id(4),
  batch: id(5),
  row: id(6),
  cash: id(7),
  income: id(8),
  tax: id(9),
  journal: id(10),
  transaction: id(11),
  user: id(12),
};
export const dividendCsrf = 'e2e-csrf-token-01234567890123456789';
export function dividendFixture() {
  const source = FinanceCashDividendSourceSnapshotSchema.parse({
    sourceRowId: dividendIds.row,
    batchId: dividendIds.batch,
    sourceRow: 8,
    evidenceId: dividendIds.evidence,
    financialAccountId: dividendIds.account,
    instrumentId: dividendIds.instrument,
    sourceRevision: 3,
    sourceSnapshotHash: 'a'.repeat(64),
    status: 'ready',
    effectiveOn: '2026-08-15',
    description: 'ACME cash dividend received',
    nativeAmount: '85.00',
    currency: 'CAD',
    fxRate: '1',
    fxSource: 'identity',
    issues: [],
    financialAccountLedgerId: dividendIds.cash,
    functionalCurrency: 'CAD',
  });
  const accounts = [
    {
      id: dividendIds.account,
      name: 'Northstar Brokerage',
      kind: 'brokerage',
      currency: 'CAD',
      ledgerAccountId: dividendIds.cash,
      active: true,
    },
  ];
  const instruments = [
    { id: dividendIds.instrument, name: 'Acme Industries', symbol: 'ACME' },
  ];
  const ledger = [
    {
      id: dividendIds.cash,
      code: '1100',
      name: 'Brokerage cash',
      kind: 'asset',
      active: true,
    },
    {
      id: dividendIds.income,
      code: '4100',
      name: 'Dividend income',
      kind: 'income',
      active: true,
    },
    {
      id: dividendIds.tax,
      code: '1350',
      name: 'Tax withheld',
      kind: 'asset',
      active: true,
    },
  ];
  const state = {
    role: 'administrator',
    listStatus: 200,
    sourceStatus: 200,
    previewStatus: 200,
    commitStatus: 200,
    detailStatus: 200,
    loseCommitResponse: false,
    skipCommitOnce: false,
    previewMismatch: false,
  };
  const actions: FinanceCashDividendSavedAction[] = [],
    writes: Array<{
      path: string;
      body: Record<string, unknown>;
      key: string;
    }> = [];
  const journal = {
    id: dividendIds.journal,
    effectiveOn: source.effectiveOn,
    description: source.description,
    sourceReference: 'dividend:ACME:2026-08',
    reversalOf: null,
  };
  const book = () => ({
    id: dividendIds.book,
    name: 'Investment book',
    entityName: 'Northstar Holdings',
    country: 'CA',
    functionalCurrency: 'CAD',
    role: state.role,
  });
  const overview = () => ({
    book: book(),
    accounts: ledger,
    periods: [],
    journals: actions.length ? [journal] : [],
    trialBalance: ledger.map((account) => ({
      ...account,
      debit: '0',
      credit: '0',
      balance: '0',
    })),
  });
  const result = (json: unknown, status = 200) => ({ status, json });
  const savedKeys = new Map<string, { body: string; receipt: unknown }>();
  function save(raw: unknown, key: string) {
    const input = CommitInvestmentCashDividendSchema.parse(raw),
      action = input.action;
    const { ledger: mapping, ...actionFacts } = action;
    const replay = savedKeys.get(key);
    if (replay)
      return replay.body === JSON.stringify(input)
        ? result({ ...(replay.receipt as object), replayed: true })
        : result({}, 409);
    if (
      input.expectedSourceRevision !== source.sourceRevision ||
      input.sourceSnapshotHash !== source.sourceSnapshotHash
    )
      return result({}, 409);
    const plan = planInvestmentCashDividend({ action, source });
    if (plan.commitReadiness !== 'ready') return result({}, 409);
    const canonical = (amount: string) =>
      formatFinanceDecimal(parseFinanceDecimal(amount));
    const amount = (kind: 'gross' | 'withholding' | 'net', n: number) => ({
      id: id(20 + n),
      kind,
      ...action[kind],
      nativeAmount: canonical(action[kind].nativeAmount),
      functionalAmount: canonical(action[kind].functionalAmount),
      ledgerAccountId:
        kind === 'gross'
          ? action.ledger.dividendIncomeLedgerAccountId
          : kind === 'net'
            ? action.ledger.cashLedgerAccountId
            : action.ledger.withholdingLedgerAccountId,
      postingSide: kind === 'gross' ? 'credit' : 'debit',
      journalId: dividendIds.journal,
      journalLineNumber: /^0(?:\.0+)?$/u.test(action[kind].functionalAmount)
        ? null
        : n,
    });
    const saved = FinanceCashDividendSavedActionSchema.parse({
      ...actionFacts,
      workspaceId: dividendIds.book,
      bookId: dividendIds.book,
      cashLedgerAccountId: mapping.cashLedgerAccountId,
      dividendIncomeLedgerAccountId: mapping.dividendIncomeLedgerAccountId,
      withholdingLedgerAccountId: mapping.withholdingLedgerAccountId,
      sourceRevision: source.sourceRevision,
      nextSourceRevision: source.sourceRevision + 1,
      sourceSnapshotHash: source.sourceSnapshotHash,
      idempotencyKey: key,
      commandHash: 'c'.repeat(64),
      economicTransactionId: dividendIds.transaction,
      journalId: dividendIds.journal,
      status: 'committed',
      createdBy: dividendIds.user,
      createdAt: '2026-09-14T16:00:00.000Z',
      source: {
        ...source,
        status: 'committed',
        currentRevision: source.sourceRevision + 1,
      },
      gross: amount('gross', 3),
      withholding: amount('withholding', 2),
      net: amount('net', 1),
    });
    actions.unshift(saved);
    const receipt = {
      actionId: action.id,
      workspaceId: dividendIds.book,
      bookId: dividendIds.book,
      sourceRowId: source.sourceRowId,
      sourceRevision: source.sourceRevision,
      nextSourceRevision: source.sourceRevision + 1,
      sourceSnapshotHash: source.sourceSnapshotHash,
      economicTransactionId: dividendIds.transaction,
      journalId: dividendIds.journal,
      grossFunctionalAmount: saved.gross.functionalAmount,
      withholdingFunctionalAmount: saved.withholding.functionalAmount,
      netFunctionalAmount: saved.net.functionalAmount,
      status: 'committed',
      replayed: false,
    };
    savedKeys.set(key, { body: JSON.stringify(input), receipt });
    source.status = 'committed';
    source.sourceRevision++;
    source.sourceSnapshotHash = 'd'.repeat(64);
    return result(receipt);
  }
  function handle(method: string, url: string, raw: unknown = {}, key = '') {
    const path = new URL(url, 'http://localhost').pathname;
    const body = raw as Record<string, unknown>;
    if (method === 'POST') {
      writes.push({ path, body, key });
      if (path.endsWith('/cash-dividends/source')) {
        const input = ReadInvestmentCashDividendSourceSchema.parse(body);
        if (state.sourceStatus !== 200) return result({}, state.sourceStatus);
        if (
          input.sourceRowId !== source.sourceRowId ||
          input.financialAccountId !== source.financialAccountId ||
          input.instrumentId !== source.instrumentId ||
          input.evidenceId !== source.evidenceId
        )
          return result({}, 404);
        return result(source);
      }
      if (path.endsWith('/cash-dividends/preview')) {
        const input = z
          .strictObject({
            action: FinanceCashDividendDraftSchema,
            expectedSourceRevision: z.number(),
            sourceSnapshotHash: z.string(),
          })
          .parse(body);
        if (state.previewStatus !== 200) return result({}, state.previewStatus);
        if (
          input.expectedSourceRevision !== source.sourceRevision ||
          input.sourceSnapshotHash !== source.sourceSnapshotHash
        )
          return result({ code: 'finance-dividend-source-changed' }, 409);
        const plan = planInvestmentCashDividend({
          action: input.action,
          source,
        });
        return result(
          state.previewMismatch
            ? { ...plan, source: { ...source, sourceRowId: id(99) } }
            : plan,
        );
      }
      if (path.endsWith('/cash-dividends/commit')) {
        if (state.commitStatus !== 200) return result({}, state.commitStatus);
        if (state.skipCommitOnce) {
          state.skipCommitOnce = false;
          throw new TypeError('Posting request interrupted');
        }
        const value = save(body, key);
        if (state.loseCommitResponse) {
          state.loseCommitResponse = false;
          throw new TypeError('Posting response lost');
        }
        return value;
      }
      throw new Error(`Unexpected dividend fixture write: ${path}`);
    }
    if (path.endsWith('/books')) return result({ books: [book()] });
    if (path.endsWith('/cash-dividends'))
      return state.listStatus === 200
        ? result({ actions, nextOffset: null })
        : result({}, state.listStatus);
    if (path.includes('/cash-dividends/')) {
      if (state.detailStatus !== 200) return result({}, state.detailStatus);
      const action = actions.find((item) => path.endsWith(`/${item.id}`));
      return action
        ? result(action)
        : result({ code: 'finance-dividend-not-found' }, 404);
    }
    if (path.endsWith('/financial-accounts')) return result({ accounts });
    if (path.endsWith('/investments'))
      return result({
        instruments,
        prices: [],
        fx: [],
        openings: [],
        observedPositions: [],
      });
    if (path.endsWith('/imports'))
      return result({
        imports: [
          {
            id: dividendIds.batch,
            financialAccountId: dividendIds.account,
            evidenceId: dividendIds.evidence,
            filename: 'brokerage-dividend.csv',
            status: 'review',
            revision: source.sourceRevision,
          },
        ],
      });
    if (path.endsWith(`/imports/${dividendIds.batch}`))
      return result({
        batch: {
          id: dividendIds.batch,
          book_id: dividendIds.book,
          financial_account_id: dividendIds.account,
          evidence_id: dividendIds.evidence,
          status: 'review',
          revision: source.sourceRevision,
        },
        rows: [
          {
            id: source.sourceRowId,
            source_row: source.sourceRow,
            date: source.effectiveOn,
            amount: source.nativeAmount,
            description: source.description,
            status: source.status,
            revision: source.sourceRevision,
            issues: source.issues,
          },
        ],
      });
    if (path.endsWith(`/evidence/${dividendIds.evidence}`))
      return result({
        filename: 'brokerage-dividend.csv',
        format: 'csv',
        sourceText:
          'Date,Description,Gross,Tax,Net,Currency\n2026-08-15,ACME dividend,100.00,15.00,85.00,CAD\n',
      });
    if (path.endsWith(`/${dividendIds.book}`)) return result(overview());
    return result({});
  }
  return {
    source,
    accounts,
    instruments,
    ledger,
    state,
    actions,
    writes,
    overview,
    book,
    handle,
  };
}
