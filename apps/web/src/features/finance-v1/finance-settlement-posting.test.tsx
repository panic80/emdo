import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FinanceSettlementPosting,
  type SettlementPostingProps,
} from './finance-settlement-posting.js';
const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  statement: vi.fn(),
  source: vi.fn(),
  evidence: vi.fn(),
  auth: { csrfToken: 'test-csrf', sessionBinding: 'session' },
}));
vi.mock('../auth/auth-context.js', () => ({ useAuth: () => mocks.auth }));
vi.mock('./finance-cash-dividend-api.js', () => ({
  dividendApi: {
    catalog: mocks.catalog,
    import: mocks.statement,
    source: mocks.source,
  },
}));
vi.mock('./finance-corporate-action-api.js', () => ({
  financeCorporateActionApi: { readEvidence: mocks.evidence },
}));
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const props: SettlementPostingProps = {
  bookId: id(1),
  sourceRevision: 4,
  sourceSnapshotHash: 'a'.repeat(64),
  settlement: {
    source: {
      action: {
        id: id(2),
        actionType: 'reverse-split',
        financialAccountId: id(3),
        instrumentId: id(4),
        effectiveOn: '2026-09-13',
        numerator: '1',
        denominator: '3',
        fractionalTreatment: 'cash-in-lieu',
        evidenceId: id(5),
        sourceReference: 'Action',
        cashInLieu: null,
      },
      sourceAsOf: '2026-09-13',
      sourceBoundary: 'immediately-before-action',
      sourceLots: [
        {
          id: id(6),
          financialAccountId: id(3),
          instrumentId: id(4),
          acquiredOn: '2026-01-01',
          acquisitionSequence: 0,
          originalQuantity: '4',
          disposedQuantity: '0',
          originalNativeCost: '90',
          originalFunctionalCost: '90',
          allocatedNativeCost: '0',
          allocatedFunctionalCost: '0',
          nativeCurrency: 'CAD',
          functionalCurrency: 'CAD',
          sourceReference: 'Lot',
        },
      ],
    },
    deliveredQuantity: { numerator: '1', denominator: '1' },
    cashDisposedQuantity: { numerator: '1', denominator: '3' },
    allocations: [
      {
        sourceLotId: id(6),
        retainedQuantity: { numerator: '1', denominator: '1' },
        cashDisposedQuantity: { numerator: '1', denominator: '3' },
        retainedNativeCost: '67.5',
        retainedFunctionalCost: '67.5',
        disposedNativeCost: '22.5',
        disposedFunctionalCost: '22.5',
      },
    ],
    cashConsideration: {
      native: { amount: '30', currency: 'CAD' },
      functional: { amount: '30', currency: 'CAD' },
      settledOn: '2026-09-13',
      evidenceId: id(5),
      sourceReference: 'Cash',
      fx: null,
    },
    allocationReview: {
      evidenceId: id(5),
      sourceReference: 'Reviewed allocation',
    },
  },
};
const saved = {
  actionId: id(2),
  workspaceId: id(90),
  bookId: id(1),
  sourceRevision: 4,
  nextSourceRevision: 5,
  sourceSnapshotHash: 'a'.repeat(64),
  successorLotIds: [id(7)],
  effectCount: 1,
  settlementId: id(8),
  economicTransactionId: id(9),
  journalIds: [id(10)],
  status: 'committed',
  replayed: false,
};
const ledger = [
  ['11', 'asset', 'Cash'],
  ['12', 'asset', 'Investments'],
  ['13', 'income', 'Gains'],
  ['14', 'expense', 'Losses'],
  ['15', 'asset', 'Receivable'],
  ['16', 'income', 'FX gain'],
  ['17', 'expense', 'FX loss'],
].map(([n, kind, name]) => ({
  id: id(Number(n)),
  code: n,
  name,
  kind,
  active: true,
}));
const source = {
  sourceRowId: id(20),
  batchId: id(21),
  sourceRow: 1,
  evidenceId: id(5),
  financialAccountId: id(3),
  instrumentId: id(4),
  sourceRevision: 2,
  sourceSnapshotHash: 'b'.repeat(64),
  status: 'ready',
  effectiveOn: '2026-09-13',
  description: 'Cash receipt',
  nativeAmount: '30',
  currency: 'CAD',
  functionalCurrency: 'CAD',
  fxRate: '1',
  fxSource: null,
  issues: [],
  financialAccountLedgerId: id(11),
};
beforeEach(() => {
  mocks.catalog.mockResolvedValue({
    role: 'administrator',
    ledger,
    imports: [
      {
        id: id(21),
        financialAccountId: id(3),
        evidenceId: id(5),
        filename: 'Broker.csv',
        status: 'reviewed',
        revision: 1,
      },
    ],
    accounts: [],
    instruments: [],
  });
  mocks.evidence.mockResolvedValue([
    { id: id(5), filename: 'Broker.csv', sourceDigest: 'c'.repeat(64) },
  ]);
  mocks.statement.mockResolvedValue({
    batch: { id: id(21), evidence_id: id(5), financial_account_id: id(3) },
    rows: [
      {
        id: id(20),
        source_row: 1,
        date: '2026-09-13',
        amount: '30',
        description: 'Cash receipt',
        status: 'ready',
        issues: [],
      },
    ],
  });
  mocks.source.mockResolvedValue(source);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
function api(
  commit: (init: RequestInit) => Promise<Response> = async () =>
    response(saved),
) {
  const fetcher = vi.fn(async (url: string, init: RequestInit) =>
    url === '/api/v2/workspace'
      ? response({ workspace: { id: id(90) } })
      : commit(init),
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
async function prepare() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Prepare settlement posting' }),
  );
  await screen.findByLabelText('Settlement statement');
  fireEvent.change(screen.getByLabelText('Settlement statement'), {
    target: { value: id(21) },
  });
  await waitFor(() =>
    expect(screen.getByLabelText('Settlement receipt row')).not.toBeDisabled(),
  );
  fireEvent.change(screen.getByLabelText('Settlement receipt row'), {
    target: { value: id(20) },
  });
  await screen.findByText(/Verified receipt:/);
  const fields = {
    'Settlement cash account': id(11),
    'Investment carrying account': id(12),
    'Investment gain account': id(13),
    'Investment loss account': id(14),
  };
  Object.entries(fields).forEach(([label, value]) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } }),
  );
}
function confirm() {
  fireEvent.click(screen.getByRole('checkbox'));
}
describe('reviewed settlement posting', () => {
  it('posts selected receipt and evidence hashes with CSRF, then shows only verified saved journal IDs', async () => {
    const fetcher = api();
    render(<FinanceSettlementPosting {...props} />);
    await prepare();
    expect(
      screen.getByRole('button', { name: 'Post reviewed settlement' }),
    ).toBeDisabled();
    confirm();
    fireEvent.click(
      screen.getByRole('button', { name: 'Post reviewed settlement' }),
    );
    await screen.findByText('Settlement committed');
    const init = fetcher.mock.calls[1]![1];
    const body = JSON.parse(String(init.body));
    expect(init.headers).toMatchObject({
      'x-csrf-token': 'test-csrf',
      'idempotency-key': body.idempotencyKey,
    });
    expect(body.receipt).toEqual({
      sourceRowId: id(20),
      expectedRevision: 2,
      snapshotHash: 'b'.repeat(64),
    });
    expect(body.evidenceHashes).toEqual([
      { evidenceId: id(5), sha256: 'c'.repeat(64) },
    ]);
    expect(body.actionDateConsideration).toBeNull();
    expect(screen.getByText(id(10))).toBeInTheDocument();
  });
  it('retries the identical command and idempotency key after an uncertain network outcome', async () => {
    let count = 0;
    const fetcher = api(async () => {
      if (count++ === 0) throw new Error('Connection lost');
      return response({ ...saved, replayed: true });
    });
    render(<FinanceSettlementPosting {...props} />);
    await prepare();
    confirm();
    fireEvent.click(
      screen.getByRole('button', { name: 'Post reviewed settlement' }),
    );
    await screen.findByRole('alert');
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry same settlement request' }),
    );
    await screen.findByText('Settlement posting recovered');
    expect(fetcher.mock.calls[1]![1].body).toBe(fetcher.mock.calls[2]![1].body);
  });
  it('does not claim success for a response from another workspace', async () => {
    api(async () => response({ ...saved, workspaceId: id(99) }));
    render(<FinanceSettlementPosting {...props} />);
    await prepare();
    confirm();
    fireEvent.click(
      screen.getByRole('button', { name: 'Post reviewed settlement' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'does not match',
    );
    expect(screen.queryByText('Settlement committed')).not.toBeInTheDocument();
  });
  it('distinguishes storage readiness503 and retains the same retry command', async () => {
    api(async () => response({}, 503));
    render(<FinanceSettlementPosting {...props} />);
    await prepare();
    confirm();
    fireEvent.click(
      screen.getByRole('button', { name: 'Post reviewed settlement' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('not ready');
    expect(
      screen.getByRole('button', { name: 'Retry same settlement request' }),
    ).toBeEnabled();
  });
  it('blocks posting when document digests are missing', async () => {
    mocks.evidence.mockResolvedValue([{ id: id(5), filename: 'Broker.csv' }]);
    const fetcher = api();
    render(<FinanceSettlementPosting {...props} />);
    await prepare();
    confirm();
    fireEvent.click(
      screen.getByRole('button', { name: 'Post reviewed settlement' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'no verified source digest',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('requires explicit action-date recognition and receivable/FX accounts for differing dates', async () => {
    mocks.source.mockResolvedValue({ ...source, effectiveOn: '2026-09-14' });
    const fetcher = api(async () =>
      response({ ...saved, journalIds: [id(10), id(30)] }),
    );
    render(
      <FinanceSettlementPosting
        {...props}
        settlement={{
          ...props.settlement,
          cashConsideration: {
            ...props.settlement.cashConsideration,
            settledOn: '2026-09-14',
          },
        }}
      />,
    );
    await prepare();
    const fields = {
      'Settlement receivable account': id(15),
      'Settlement FX gain account': id(16),
      'Settlement FX loss account': id(17),
      'Action-date native amount (CAD)': '30',
      'Action-date functional amount (CAD)': '30',
      'Action-date evidence': id(5),
      'Action-date reference': 'Recognition advice',
    };
    Object.entries(fields).forEach(([label, value]) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } }),
    );
    confirm();
    fireEvent.click(
      screen.getByRole('button', { name: 'Post reviewed settlement' }),
    );
    await screen.findByText('Settlement committed');
    expect(
      JSON.parse(String(fetcher.mock.calls[1]![1].body))
        .actionDateConsideration,
    ).toMatchObject({
      native: { amount: '30', currency: 'CAD' },
      functional: { amount: '30', currency: 'CAD' },
      fx: null,
      sourceReference: 'Recognition advice',
    });
  });
  it('displays delayed settlement accounting from saved journals rather than the receipt-value difference', async () => {
    const delayed: SettlementPostingProps = {
      ...props,
      settlement: {
        ...props.settlement,
        source: {
          ...props.settlement.source,
          sourceLots: props.settlement.source.sourceLots.map((lot) => ({
            ...lot,
            nativeCurrency: 'USD',
            originalFunctionalCost: '135',
          })),
        },
        cashConsideration: {
          ...props.settlement.cashConsideration,
          native: { amount: '30', currency: 'USD' },
          functional: { amount: '45', currency: 'CAD' },
          settledOn: '2026-09-14',
          fx: { rate: '1.5', source: 'Receipt FX' },
        },
        allocations: props.settlement.allocations.map((allocation) => ({
          ...allocation,
          retainedFunctionalCost: '101.25',
          disposedFunctionalCost: '33.75',
        })),
      },
    };
    mocks.source.mockResolvedValue({
      ...source,
      effectiveOn: '2026-09-14',
      currency: 'USD',
      fxRate: '1.5',
      fxSource: 'Receipt FX',
    });
    const delayedSaved = { ...saved, journalIds: [id(10), id(30)] };
    const plan = {
      calculationVersion: 'investment-corporate-action-settlement.v1',
      actionId: id(2),
      financialAccountId: id(3),
      instrumentId: id(4),
      effectiveOn: '2026-09-13',
      settledOn: '2026-09-14',
      accountEntitlement: { numerator: '4', denominator: '3' },
      deliveredQuantity: props.settlement.deliveredQuantity,
      cashDisposedQuantity: props.settlement.cashDisposedQuantity,
      nativeCurrency: 'USD',
      functionalCurrency: 'CAD',
      sourceNativeCost: '90',
      sourceFunctionalCost: '135',
      retainedNativeCost: '67.5',
      retainedFunctionalCost: '101.25',
      disposedNativeCost: '22.5',
      disposedFunctionalCost: '33.75',
      nativeBookGainLoss: '7.5',
      functionalBookGainLoss: '11.25',
      allocations: delayed.settlement.allocations,
      cashConsideration: delayed.settlement.cashConsideration,
      allocationReview: props.settlement.allocationReview,
      status: 'validated-plan',
      persistence: 'not-implemented',
      taxTreatment: 'not-assessed',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/v2/workspace'
          ? response({ workspace: { id: id(90) } })
          : url.endsWith('/settlement-commit')
            ? response(delayedSaved)
            : response({
                result: delayedSaved,
                settlement: plan,
                createdAt: '2026-09-14T00:00:00Z',
                accounting: {
                  actionDateFunctionalConsideration: '42',
                  settlementDateFunctionalConsideration: '45',
                  bookGainLoss: '8.25',
                  fxGainLoss: '3',
                },
              }),
      ),
    );
    render(<FinanceSettlementPosting {...delayed} />);
    await prepare();
    const fields = {
      'Settlement receivable account': id(15),
      'Settlement FX gain account': id(16),
      'Settlement FX loss account': id(17),
      'Action-date native amount (USD)': '30',
      'Action-date functional amount (CAD)': '42',
      'Action-date evidence': id(5),
      'Action-date reference': 'Action recognition',
      'Action-date FX rate': '1.4',
      'Action-date FX source': 'Action FX',
    };
    Object.entries(fields).forEach(([label, value]) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } }),
    );
    confirm();
    fireEvent.click(
      screen.getByRole('button', { name: 'Post reviewed settlement' }),
    );
    await screen.findByText('Settlement committed');
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh saved settlement' }),
    );
    await screen.findByText('Saved settlement readback verified.');
    expect(
      screen.getByText('Posted book gain/loss: 8.25 CAD.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Posted settlement FX gain/loss: 3 CAD.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Posted book gain/loss: 11.25 CAD.'),
    ).not.toBeInTheDocument();
  });
  it('aborts pending posting and suppresses late success on unmount', async () => {
    let resolve!: (value: Response) => void;
    let signal: AbortSignal | undefined;
    api(async (init) => {
      signal = init.signal as AbortSignal;
      return new Promise((done) => {
        resolve = done;
      });
    });
    const view = render(<FinanceSettlementPosting {...props} />);
    await prepare();
    confirm();
    fireEvent.click(
      screen.getByRole('button', { name: 'Post reviewed settlement' }),
    );
    await waitFor(() => expect(signal).toBeDefined());
    view.unmount();
    expect(signal?.aborted).toBe(true);
    resolve(response(saved));
    expect(screen.queryByText('Settlement committed')).not.toBeInTheDocument();
  });
});
