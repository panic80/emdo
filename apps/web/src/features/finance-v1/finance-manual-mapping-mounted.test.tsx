import { webcrypto } from 'node:crypto';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinanceReportMappings } from './finance-report-mappings.js';
import {
  standardizationFixture,
  standardizationBookId,
} from '../../../test/finance-standardization-fixture.js';
vi.mock('../auth/auth-context.js', () => ({
  useAuth: () => ({
    state: 'authenticated',
    sessionBinding: 'manual-review',
    csrfToken: 'manual-csrf',
  }),
}));
afterEach(() => vi.unstubAllGlobals());
describe('extraction-only manual mapping route', () => {
  it.each(['csv', 'xlsx'])(
    'opens a human-authored %s mapping without a proposal or model provenance',
    async (format) => {
      vi.stubGlobal('crypto', webcrypto);
      const fixture = standardizationFixture();
      const run = fixture.createRun('blocked', format);
      fixture.updateRun(run, 'extracted');
      run.blockers = [];
      const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url, 'http://localhost').pathname;
        if (path.endsWith('/financial-accounts'))
          return new Response(JSON.stringify({ accounts: [] }));
        if (path.endsWith('/report-mappings'))
          return new Response(
            JSON.stringify({ mappings: [], nextOffset: null }),
          );
        const response = fixture.handle(url, init?.method);
        return new Response(JSON.stringify(response.json), {
          status: response.status,
        });
      });
      vi.stubGlobal('fetch', fetcher);
      render(
        <FinanceReportMappings
          bookId={standardizationBookId}
          role="preparer"
        />,
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Open report standardization' }),
      );
      fireEvent.click(
        await screen.findByRole('button', {
          name: `Open saved analysis: activity.${format}`,
        }),
      );
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'Open original for manual review',
        }),
      );
      await screen.findByRole('region', {
        name: 'Create a manual source mapping',
      });
      expect(screen.getByLabelText('Report type')).toHaveValue('');
      if (format === 'csv') {
        await waitFor(() =>
          expect(
            screen.getByLabelText('Exact source headings, one per line'),
          ).toHaveValue('Date\nMemo\nAmount\nCurrency'),
        );
        expect(
          screen.getByText(/digest-verified original CSV/),
        ).toBeInTheDocument();
      } else
        fireEvent.change(
          screen.getByLabelText('Exact source headings, one per line'),
          { target: { value: 'Date\nMemo\nAmount\nCurrency' } },
        );
      for (const [label, value] of [
        ['Provider name', 'My bank'],
        ['Report name', 'Activity'],
        ['Report type', 'bank-transactions'],
        ['Layout version', '1'],
      ])
        fireEvent.change(screen.getByLabelText(label!), { target: { value } });
      fireEvent.click(
        screen.getByLabelText(
          /I checked the original document and these report details/,
        ),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Continue to field review' }),
      );
      if (format === 'xlsx') {
        expect(await screen.findByLabelText('Worksheet name')).toHaveValue('');
        expect(screen.getByLabelText('transactionDate')).toHaveValue('');
      } else {
        await screen.findByLabelText('Original CSV text');
        expect(screen.getByLabelText('Transaction date')).toHaveValue('');
      }
      expect(
        fetcher.mock.calls.every(([, init]) => init?.method !== 'POST'),
      ).toBe(true);
      expect(run.proposal).toBeNull();
      expect(run.modelProvenance).toBeNull();
    },
  );
});
