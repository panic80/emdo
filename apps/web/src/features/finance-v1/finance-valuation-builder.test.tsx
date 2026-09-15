import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { FinanceValuationBuilder } from './finance-valuation-builder.js';
vi.mock('../auth/auth-context.js', () => ({
  useAuth: () => ({ csrfToken: 'csrf' }),
}));
afterEach(() => vi.unstubAllGlobals());
const id = '00000000-0000-4000-8000-000000000001';
it('saves the reviewed source fingerprint and invalidates preview when selections change', async () => {
  const fetcher = vi.fn(
    async (path: string, init?: RequestInit) =>
      new Response(
        JSON.stringify(
          path.endsWith('/financial-accounts')
            ? {
                accounts: [
                  { id, name: 'Broker', kind: 'brokerage', active: true },
                ],
              }
            : path.endsWith('/investments')
              ? {
                  instruments: [{ id, name: 'Fund' }],
                  openings: [],
                  prices: [],
                  fx: [],
                  observedPositions: [],
                }
              : path.endsWith('/valuation-preview') && init?.method === 'POST'
                ? {
                    inputHash: 'a'.repeat(64),
                    status: 'incomplete',
                    currency: 'CAD',
                    total: null,
                    availableSubtotal: '0',
                    unavailableCount: 1,
                    positions: [],
                  }
                : { id },
        ),
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const onSaved = vi.fn();
  render(<FinanceValuationBuilder bookId={id} onSaved={onSaved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create a valuation' }));
  await screen.findByLabelText('Valuation date');
  fireEvent.change(screen.getByLabelText('Valuation date'), {
    target: { value: '2026-03-31' },
  });
  fireEvent.change(screen.getByLabelText('Brokerage account'), {
    target: { value: id },
  });
  fireEvent.change(screen.getByLabelText('Instrument'), {
    target: { value: id },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview valuation' }));
  await screen.findByText('Selected-position total: Unavailable');
  fireEvent.change(screen.getByLabelText('Valuation date'), {
    target: { value: '2026-04-01' },
  });
  expect(
    screen.queryByRole('button', { name: 'Save reviewed valuation' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Preview valuation' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Save reviewed valuation' }),
  );
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(id));
  const save = fetcher.mock.calls.find(([path]) =>
    path.endsWith('/valuation-runs'),
  )!;
  expect(JSON.parse(save[1]!.body as string)).toEqual({
    asOf: '2026-04-01',
    positions: [
      {
        financialAccountId: id,
        instrumentId: id,
        openingId: null,
        priceId: null,
        fxId: null,
        observedPositionId: null,
      },
    ],
    expectedInputHash: 'a'.repeat(64),
  });
});
