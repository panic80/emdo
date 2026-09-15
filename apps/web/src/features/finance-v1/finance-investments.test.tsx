import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { FinanceInvestments } from './finance-investments.js';
vi.mock('../auth/auth-context.js', () => ({
  useAuth: () => ({
    state: 'authenticated',
    sessionBinding: 'investment-test',
    csrfToken: 'test-csrf',
  }),
}));
afterEach(() => vi.unstubAllGlobals());
const id = '00000000-0000-4000-8000-000000000001';
it('preserves missing totals and exact observed differences with saved source details', async () => {
  const summary = {
    id,
    asOf: '2026-03-31',
    calculationVersion: 'investment-valuation.v1',
    status: 'incomplete',
    currency: 'JPY',
    total: null,
    valuationScope: 'selected-positions',
  };
  const fetcher = vi.fn(
    async (path: string) =>
      new Response(
        JSON.stringify(
          path.includes('?')
            ? { runs: [summary], nextOffset: null }
            : {
                ...summary,
                inputSnapshot: { price: null },
                result: {
                  ...summary,
                  mode: 'saved',
                  availableSubtotal: '99999999999999999999',
                  unavailableCount: 1,
                  positions: [
                    {
                      financialAccountId: id,
                      instrumentId: id,
                      quantity: '12.125',
                      nativeCurrency: null,
                      nativeValue: null,
                      functionalValue: null,
                      status: 'unavailable',
                      reason: 'missing-price',
                      sourceReferences: [],
                    },
                  ],
                  reconciliations: [
                    {
                      observedPositionId: id,
                      evidenceId: id,
                      sourceRow: 3,
                      observedQuantity: '12.25',
                      calculatedQuantity: '12.125',
                      difference: '0.125',
                      status: 'difference',
                    },
                  ],
                  calculations: [],
                },
              },
        ),
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<FinanceInvestments bookId={id} />);
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Open investment valuations' }),
  );
  fireEvent.click(
    await screen.findByRole('button', {
      name: `2026-03-31 · JPY · incomplete · ${id}`,
    }),
  );
  await screen.findByText('Total: Unavailable');
  expect(
    screen.getByText(/Available subtotal: 99999999999999999999 JPY/),
  ).toBeInTheDocument();
  expect(screen.getByText('0.125')).toBeInTheDocument();
  expect(screen.getByText('missing-price')).toBeInTheDocument();
  expect(screen.getByText(/Selected positions only/)).toBeInTheDocument();
  expect(fetcher).toHaveBeenLastCalledWith(
    `/api/v2/finance/books/${id}/investments/valuation-runs/${id}`,
    expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
  );
});
it('shows unavailable storage without manufacturing empty holdings', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 503 })),
  );
  render(<FinanceInvestments bookId={id} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Open investment valuations' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('not available');
  expect(
    screen.queryByText('No saved valuations on this page.'),
  ).not.toBeInTheDocument();
});
