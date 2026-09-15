import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinanceBookDocuments } from './finance-book-documents.js';
vi.mock('../auth/auth-context.js', () => ({
  useAuth: () => ({ csrfToken: 'test-token' }),
}));
afterEach(() => vi.unstubAllGlobals());
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const posting = () => ({
  functionalCurrency: 'CAD',
  economicTransactionId: id(8),
  journalId: id(9),
  effectiveOn: '2026-03-01',
  description: 'Saved payment',
  sourceReference: `evidence:${id(4)}`,
  reversalOf: null,
  lines: [
    {
      lineNumber: 1,
      accountId: id(2),
      side: 'debit',
      amount: '135.1200',
      currency: 'USD',
      nativeAmount: '100.00',
      fxRate: '1.3512',
      fxSource: 'Reviewed bank rate',
      description: 'Payment',
    },
    {
      lineNumber: 2,
      accountId: id(6),
      side: 'credit',
      amount: '135.1200',
      currency: 'USD',
      nativeAmount: '100.00',
      fxRate: '1.3512',
      fxSource: 'Reviewed bank rate',
      description: null,
    },
  ],
});
async function postedReview(value: unknown, status = 'committed') {
  const state = { denied: false };
  vi.stubGlobal('fetch', async (path: string) => {
    if (state.denied) return new Response('{}', { status: 403 });
    return new Response(
      JSON.stringify(
        path.endsWith('/financial-accounts')
          ? { accounts: [] }
          : path.endsWith('/imports')
            ? {
                imports: [
                  {
                    id: id(3),
                    filename: 'posted.csv',
                    status: 'committed',
                    revision: 4,
                  },
                ],
              }
            : {
                batch: {
                  id: id(3),
                  status: 'committed',
                  revision: 4,
                  evidence_id: id(4),
                },
                rows: [
                  {
                    id: id(5),
                    source_row: 2,
                    date: '2026-03-01',
                    amount: '100.00',
                    description: 'Payment',
                    external_id: null,
                    issues: [],
                    status,
                    revision: 3,
                    counter_account_id: id(2),
                    match_journal_id: null,
                    fxRate: '1.3512',
                    fx_source: 'Reviewed bank rate',
                    source_facts: {},
                    economic_transaction_id: id(8),
                    ...(value === undefined ? {} : { posting: value }),
                  },
                ],
              },
      ),
    );
  });
  render(
    <FinanceBookDocuments
      bookId={id(1)}
      currency="CAD"
      role="viewer"
      accounts={[
        { id: id(2), code: '1000', name: 'Bank', kind: 'asset' },
        { id: id(6), code: '4000', name: 'Sales', kind: 'income' },
      ]}
      onSaved={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open documents' }));
  fireEvent.click(await screen.findByRole('button', { name: /posted.csv/ }));
  return state;
}
describe('durable book document review', () => {
  it('sends only an explicitly selected authorized private source with account creation', async () => {
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          writes.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ id: id(8) }));
        }
        return new Response(
          JSON.stringify(
            path.endsWith('/financial-account-sources')
              ? {
                  sources: [
                    { sourceSpaceId: id(6), name: 'My private finances' },
                  ],
                }
              : path.endsWith('/financial-accounts')
                ? { accounts: [] }
                : { imports: [], documents: [] },
          ),
        );
      }),
    );
    render(
      <FinanceBookDocuments
        bookId={id(1)}
        currency="CAD"
        role="administrator"
        accounts={[{ id: id(2), code: '1000', name: 'Bank', kind: 'asset' }]}
        onSaved={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open documents' }));
    fireEvent.click(await screen.findByText('Add a financial account'));
    const source = await screen.findByLabelText('Private finance view');
    expect(source).toHaveValue('');
    expect(screen.queryByLabelText('Account classification')).toBeNull();
    fireEvent.change(source, { target: { value: id(6) } });
    fireEvent.change(screen.getByLabelText('Account classification'), {
      target: { value: 'savings' },
    });
    fireEvent.change(screen.getByLabelText('Reason for inclusion'), {
      target: { value: 'Personal savings account' },
    });
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Savings' },
    });
    fireEvent.change(screen.getByLabelText('Ledger account'), {
      target: { value: id(2) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      name: 'Savings',
      kind: 'bank',
      currency: 'CAD',
      ledgerAccountId: id(2),
      privateSourceAssignment: {
        sourceSpaceId: id(6),
        compatibilityAccountKind: 'savings',
        reason: 'Personal savings account',
      },
    });
  });

  it.each(['committed', 'failed', 'uncertain'] as const)(
    'refreshes accounting only after confirmed committed readback (%s)',
    async (outcome) => {
      const onSaved = vi.fn();
      let revision = 1,
        status = 'review',
        rowRevision = 1,
        rowStatus = 'review';
      const writes: { path: string; body: Record<string, unknown> }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (path: string, init?: RequestInit) => {
          if (init?.method === 'POST') {
            const body = JSON.parse(String(init.body));
            writes.push({ path, body });
            expect(new Headers(init.headers).get('x-csrf-token')).toBe(
              'test-token',
            );
            if (path.endsWith('/review')) {
              rowRevision++;
              revision++;
              rowStatus = 'ready';
            } else {
              if (outcome === 'failed')
                return new Response('{}', { status: 409 });
              status = outcome === 'committed' ? 'committed' : 'review';
              rowStatus = 'committed';
              revision++;
            }
            return new Response(JSON.stringify({ id: id(3) }));
          }
          const result = path.endsWith('/financial-accounts')
            ? { accounts: [] }
            : path.endsWith('/imports')
              ? {
                  imports: [
                    { id: id(3), filename: 'saved.csv', status, revision },
                  ],
                }
              : {
                  batch: { id: id(3), status, revision, evidence_id: id(4) },
                  rows: [
                    {
                      id: id(5),
                      source_row: 2,
                      date: '2026-03-01',
                      amount: '27.13',
                      description: 'Service',
                      external_id: null,
                      issues: [],
                      status: rowStatus,
                      revision: rowRevision,
                      counter_account_id: id(2),
                      match_journal_id: null,
                      fxRate: null,
                      fx_source: null,
                      source_facts: { description: 'Original label' },
                    },
                  ],
                };
          return new Response(JSON.stringify(result));
        }),
      );
      render(
        <FinanceBookDocuments
          bookId={id(1)}
          currency="CAD"
          role="administrator"
          accounts={[
            { id: id(2), code: '4000', name: 'Sales', kind: 'income' },
          ]}
          onSaved={onSaved}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Open documents' }));
      fireEvent.click(await screen.findByRole('button', { name: /saved.csv/ }));
      await screen.findByText('Statement review · revision 1');
      expect(
        screen.getByRole('button', { name: 'Commit reviewed statement' }),
      ).toBeDisabled();
      fireEvent.click(screen.getByText(/Row 2:/));
      fireEvent.change(screen.getByLabelText('Review reason'), {
        target: { value: 'Checked against original' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save row review' }));
      await screen.findByText('Statement review · revision 2');
      expect(writes[0]!.body).toMatchObject({
        expectedRevision: 1,
        counterAccountId: id(2),
        action: 'post',
      });
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Commit reviewed statement' }),
        ).not.toBeDisabled(),
      );
      expect(onSaved).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole('button', { name: 'Commit reviewed statement' }),
      );
      if (outcome === 'failed') {
        await screen.findByText(
          /The records changed or require further review/,
        );
      } else {
        await screen.findByText('Statement review · revision 3');
      }
      expect(writes[1]!.body).toEqual({ expectedRevision: 2 });
      if (outcome === 'committed') {
        expect(onSaved).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/Row 2: Service/)).toBeVisible();
        expect(
          screen.getByText(
            'Statement committed. Expand each row to review its saved accounting trail.',
          ),
        ).toBeVisible();
        expect(
          screen.queryByRole('button', { name: 'Commit reviewed statement' }),
        ).not.toBeInTheDocument();
      } else {
        expect(onSaved).not.toHaveBeenCalled();
        expect(
          screen.queryByText(
            'Statement committed. Expand each row to review its saved accounting trail.',
          ),
        ).not.toBeInTheDocument();
      }
    },
  );
  it('does not expose preparation controls to viewers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (path: string) =>
          new Response(
            JSON.stringify(
              path.endsWith('/imports') ? { imports: [] } : { accounts: [] },
            ),
          ),
      ),
    );
    render(
      <FinanceBookDocuments
        bookId={id(1)}
        currency="CAD"
        role="viewer"
        accounts={[]}
        onSaved={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open documents' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Refresh documents' }),
      ).not.toBeDisabled(),
    );
    expect(screen.queryByText('Upload a statement')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Add a financial account'),
    ).not.toBeInTheDocument();
  });
  it.each(['committed', 'matched'])(
    'shows exact saved accounting for %s rows with named accounts',
    async (status) => {
      await postedReview(posting(), status);
      await screen.findByText('Statement review · revision 4');
      expect(screen.getByText(/1000 · Bank/)).toBeInTheDocument();
      expect(screen.getByText(/4000 · Sales/)).toBeInTheDocument();
      expect(screen.getAllByText('135.1200')).toHaveLength(2);
      expect(screen.getAllByText('100.00')).toHaveLength(2);
      expect(screen.getAllByText('Functional amount (CAD)')).toHaveLength(2);
      expect(screen.getAllByText('Native amount (USD)')).toHaveLength(2);
      expect(screen.getByText(`evidence:${id(4)}`)).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Commit reviewed statement' }),
      ).not.toBeInTheDocument();
    },
  );
  it.each([
    [undefined, 'Saved posting details unavailable in this response.'],
    [null, 'No saved posting is linked to this row.'],
  ])('distinguishes absent posting evidence', async (value, message) => {
    await postedReview(value);
    expect(await screen.findByText(String(message))).toBeInTheDocument();
  });
  it.each(['identity', 'duplicate'])(
    'rejects %s mismatches before rendering saved lines',
    async (kind) => {
      const value = posting();
      if (kind === 'identity') value.economicTransactionId = id(10);
      else value.lines[1]!.lineNumber = 1;
      await postedReview(value);
      await screen.findByRole('alert');
      expect(
        screen.queryByText('Statement review · revision 4'),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/1000 · Bank/)).not.toBeInTheDocument();
    },
  );
  it('does not label a saved posting with a different current-book currency', async () => {
    const value = { ...posting(), functionalCurrency: 'USD' };
    await postedReview(value);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Saved posting currency does not match the current book.',
    );
    expect(screen.queryByText(/1000 · Bank/)).not.toBeInTheDocument();
  });
  it('clears saved trail on revoked read access', async () => {
    const state = await postedReview(posting());
    await screen.findByText('Statement review · revision 4');
    state.denied = true;
    fireEvent.click(screen.getByRole('button', { name: /posted.csv/ }));
    await screen.findByRole('alert');
    expect(screen.queryByText(/1000 · Bank/)).not.toBeInTheDocument();
  });
});
