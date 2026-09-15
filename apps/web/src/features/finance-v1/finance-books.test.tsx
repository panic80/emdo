vi.mock('./finance-commercial.js', () => ({ FinanceCommercial: () => null }));
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinanceBooks } from './finance-books.js';
vi.mock('../auth/auth-context.js', () => ({
  useAuth: () => ({ sessionBinding: 'current', csrfToken: 'test-token' }),
}));
afterEach(() => vi.unstubAllGlobals());
describe('Books accounting panel', () => {
  it('loads accessible books and drills into exact decimal reports', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const fetcher = vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path.endsWith('/books')
              ? {
                  books: [
                    {
                      id,
                      name: 'Company',
                      entityName: 'Example',
                      country: 'JP',
                      functionalCurrency: 'JPY',
                      role: 'viewer',
                    },
                  ],
                }
              : {
                  trialBalance: [
                    {
                      id,
                      code: '1000',
                      name: 'Cash',
                      kind: 'asset',
                      debit: '99999999999999999999',
                      credit: '0',
                      balance: '99999999999999999999',
                    },
                  ],
                  periods: [],
                  journals: [],
                },
          ),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    render(<FinanceBooks />);
    await screen.findByRole('option', { name: 'Company · Example · JPY' });
    fireEvent.change(screen.getByLabelText('Accounting book'), {
      target: { value: id },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Books' }));
    await screen.findByText('Company — trial balance (JPY)');
    expect(
      within(screen.getByRole('tabpanel')).getAllByText('99999999999999999999'),
    ).toHaveLength(2);
    expect(fetcher).toHaveBeenLastCalledWith(
      `/api/v2/finance/books/${id}`,
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'same-origin',
      }),
    );
  });
  it('shows disabled accounting without inventing balances', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 503 })),
    );
    render(<FinanceBooks />);
    expect(await screen.findByRole('alert')).toHaveTextContent('not enabled');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
