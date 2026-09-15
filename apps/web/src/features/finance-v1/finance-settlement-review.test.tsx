import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FinanceStockSplitSettlementReview,
  type FinanceStockSplitSettlementReviewProps,
} from './finance-settlement-review.js';
const auth = vi.hoisted(() => ({ sessionBinding: 'session-a' }));
vi.mock('../auth/auth-context.js', () => ({ useAuth: () => auth }));
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const q = (numerator: string, denominator = '1') => ({
  numerator,
  denominator,
});
const props: FinanceStockSplitSettlementReviewProps = {
  bookId: id(1),
  role: 'administrator',
  evidence: [{ id: id(4), filename: 'Broker.pdf' }],
  source: {
    action: {
      id: id(6),
      actionType: 'reverse-split',
      financialAccountId: id(2),
      instrumentId: id(3),
      effectiveOn: '2026-09-13',
      numerator: '1',
      denominator: '3',
      fractionalTreatment: 'cash-in-lieu',
      evidenceId: id(4),
      sourceReference: 'Broker advice',
      cashInLieu: null,
    },
    sourceRevision: 4,
    sourceSnapshotHash: 'a'.repeat(64),
    sourceAsOf: '2026-09-13',
    sourceBoundary: 'immediately-before-action',
    sourceLots: [
      {
        id: id(5),
        financialAccountId: id(2),
        instrumentId: id(3),
        acquiredOn: '2026-01-01',
        acquisitionSequence: 0,
        originalQuantity: '4',
        disposedQuantity: '0',
        originalNativeCost: '90',
        allocatedNativeCost: '0',
        originalFunctionalCost: '135',
        allocatedFunctionalCost: '0',
        nativeCurrency: 'USD',
        functionalCurrency: 'CAD',
        sourceReference: 'Opening lot',
      },
    ],
  },
};
const allocation = {
  sourceLotId: id(5),
  retainedQuantity: q('1'),
  cashDisposedQuantity: q('1', '3'),
  retainedNativeCost: '67.5',
  disposedNativeCost: '22.5',
  retainedFunctionalCost: '101.25',
  disposedFunctionalCost: '33.75',
};
const cash = {
  native: { amount: '30', currency: 'USD' },
  functional: { amount: '45', currency: 'CAD' },
  settledOn: '2026-09-14',
  evidenceId: id(4),
  sourceReference: 'Cash notice',
  fx: { rate: '1.5', source: 'Broker FX' },
};
const review = { evidenceId: id(4), sourceReference: 'Reviewed allocation' };
const result = {
  sourceRevision: 4,
  sourceSnapshotHash: props.source.sourceSnapshotHash,
  plan: {
    calculationVersion: 'investment-corporate-action-settlement.v1',
    actionId: id(6),
    financialAccountId: id(2),
    instrumentId: id(3),
    effectiveOn: '2026-09-13',
    settledOn: '2026-09-14',
    accountEntitlement: q('4', '3'),
    deliveredQuantity: q('1'),
    cashDisposedQuantity: q('1', '3'),
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
    allocations: [allocation],
    cashConsideration: cash,
    allocationReview: review,
    status: 'validated-plan',
    persistence: 'not-implemented',
    taxTreatment: 'not-assessed',
  },
};
function fill() {
  const values: Record<string, string> = {
    'Delivered shares numerator': '1',
    'Delivered shares denominator': '1',
    'Cash-disposed shares numerator': '1',
    'Cash-disposed shares denominator': '3',
    'Lot 1 retained shares numerator': '1',
    'Lot 1 retained shares denominator': '1',
    'Lot 1 cash-disposed shares numerator': '1',
    'Lot 1 cash-disposed shares denominator': '3',
    'Lot 1 retained native cost (USD)': '67.5',
    'Lot 1 disposed native cost (USD)': '22.5',
    'Lot 1 retained functional cost (CAD)': '101.25',
    'Lot 1 disposed functional cost (CAD)': '33.75',
    'Allocation evidence': id(4),
    'Allocation reference': 'Reviewed allocation',
    'Native cash (USD)': '30',
    'Functional cash (CAD)': '45',
    'Settlement date': '2026-09-14',
    'Cash evidence': id(4),
    'Cash reference': 'Cash notice',
    'Cash FX rate': '1.5',
    'Cash FX source': 'Broker FX',
  };
  Object.entries(values).forEach(([label, value]) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } }),
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  auth.sessionBinding = 'session-a';
});
describe('cash-in-lieu settlement review', () => {
  it('requires explicit allocations and previews authoritative source tokens without client lots', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(result)));
    vi.stubGlobal('fetch', fetcher);
    render(<FinanceStockSplitSettlementReview {...props} />);
    expect(screen.getByLabelText('Delivered shares numerator')).toHaveValue('');
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview settlement' }));
    await screen.findByText('Validated settlement plan');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      `/api/v2/finance/books/${props.bookId}/investments/corporate-actions/stock-splits/settlement-preview`,
    );
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    expect(JSON.parse(String(init.body))).toEqual({
      action: props.source.action,
      expectedSourceRevision: 4,
      sourceSnapshotHash: props.source.sourceSnapshotHash,
      deliveredQuantity: q('1'),
      cashDisposedQuantity: q('1', '3'),
      allocations: [allocation],
      allocationReview: review,
      cashConsideration: cash,
    });
    expect(
      screen.getByText(/Native basis conserved: 90 = 67.5 retained/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^(commit|post reviewed)/i }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Native cash (USD)'), {
      target: { value: '31' },
    });
    expect(
      screen.queryByText('Validated settlement plan'),
    ).not.toBeInTheDocument();
  });
  it.each(['book', 'session', 'source', 'role'])(
    'aborts and clears a pending private preview when %s changes',
    async (kind) => {
      let signal: AbortSignal | undefined;
      let resolve!: (response: Response) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init: RequestInit) => {
          signal = init.signal as AbortSignal;
          return new Promise<Response>((done) => {
            resolve = done;
          });
        }),
      );
      const view = render(<FinanceStockSplitSettlementReview {...props} />);
      fill();
      fireEvent.click(
        screen.getByRole('button', { name: 'Preview settlement' }),
      );
      await waitFor(() => expect(signal).toBeDefined());
      if (kind === 'session') auth.sessionBinding = 'session-b';
      view.rerender(
        <FinanceStockSplitSettlementReview
          {...props}
          bookId={kind === 'book' ? id(9) : props.bookId}
          role={kind === 'role' ? 'viewer' : props.role}
          source={
            kind === 'source'
              ? { ...props.source, sourceRevision: 5 }
              : props.source
          }
        />,
      );
      expect(signal?.aborted).toBe(true);
      resolve(new Response(JSON.stringify(result)));
      await waitFor(() =>
        expect(
          screen.queryByText('Validated settlement plan'),
        ).not.toBeInTheDocument(),
      );
      if (kind !== 'role')
        expect(screen.getByLabelText('Delivered shares numerator')).toHaveValue(
          '',
        );
      else expect(screen.queryByRole('button')).not.toBeInTheDocument();
    },
  );
  it('rejects a zero denominator locally before sending any request', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    render(<FinanceStockSplitSettlementReview {...props} />);
    fill();
    fireEvent.change(screen.getByLabelText('Delivered shares denominator'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview settlement' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Denominators must be positive integers',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires refreshed source after a conflict', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 409 })),
    );
    render(<FinanceStockSplitSettlementReview {...props} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Preview settlement' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'source lots changed',
    );
    expect(
      screen.getByRole('button', { name: 'Preview settlement' }),
    ).toBeDisabled();
  });
});
