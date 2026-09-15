import type { ReactNode } from 'react';
import type { FinancePage } from '@emdo/contracts/browser';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FinanceRoute } from './finance.js';

const fixture = vi.hoisted(() => ({
  api: { listFinance: vi.fn<() => Promise<FinancePage>>() },
  submit: vi.fn(),
  mutate: vi.fn(),
  experience: vi.fn(),
  records: [
    {
      id: 'server-transaction',
      entityType: 'finance.transaction',
      tombstoned: false,
      value: {
        description: 'Optimistic legacy overwrite',
        category: 'Legacy',
        postedOn: '2026-09-01',
        amountCadMinor: -99999,
      },
    },
    {
      id: 'cached-transaction',
      entityType: 'finance.transaction',
      tombstoned: false,
      value: {
        description: 'Cached legacy transaction',
        category: 'Legacy',
        postedOn: '2026-09-01',
        amountCadMinor: -2000,
      },
    },
    {
      id: 'cached-budget',
      entityType: 'finance.budget',
      tombstoned: false,
      value: {
        id: 'cached-budget',
        currency: 'CAD',
        allocationsCadMinor: { groceries: 99999 },
      },
    },
  ],
}));

vi.mock('../features/experience/experience-api.js', () => ({
  useExperienceApi: () => fixture.api,
}));
vi.mock('../features/auth/auth-context.js', () => ({
  useAuth: () => ({
    state: 'authenticated',
    csrfToken: 'test',
    sessionBinding: 'test-session',
  }),
}));
vi.mock('../features/domains/domain-data.js', () => ({
  useDomainData: () => ({
    state: 'ready',
    records: fixture.records,
    applyMutation: fixture.mutate,
  }),
}));
vi.mock('../features/domains/domain-status.js', () => ({
  DomainSyncStatus: () => null,
}));
vi.mock('../features/locale/locale-preference.js', () => ({
  useActiveLocale: () => 'en-CA',
}));
vi.mock('../features/chat/conversation.js', () => ({
  useConversation: () => ({ submit: fixture.submit }),
  ConversationPanel: () => null,
}));
vi.mock('../features/finance-v1/finance-experience-api.js', () => ({
  readFinanceExperience: (...args: unknown[]) => fixture.experience(...args),
}));
vi.mock('../features/finance-v1/finance-books.js', () => ({
  FinanceBooks: ({
    activity,
    planning,
  }: {
    activity: ReactNode;
    planning: ReactNode;
  }) => (
    <>
      {activity}
      {planning}
    </>
  ),
}));
vi.mock('../features/finance-v1/finance-documents.js', () => ({
  FinanceDocuments: () => null,
}));
vi.mock('../features/finance/finance-import-panel.js', () => ({
  FinanceImportPanel: () => null,
}));
vi.mock('../features/finance/finance-import-api.js', () => ({
  createFinanceImportApi: () => ({}),
}));

const page = (authority: 'legacy' | 'normalized'): FinancePage => ({
  schemaVersion: 1,
  ledgerAuthority: authority,
  items: [
    {
      recordType: 'transaction',
      id: 'server-transaction',
      description:
        authority === 'normalized'
          ? 'Posted normalized transaction'
          : 'Server legacy transaction',
      category: 'Groceries',
      postedOn: '2026-09-01',
      currency: 'CAD',
      amountCadMinor: -4205,
      state: 'active',
    },
  ],
});

beforeEach(() => {
  fixture.api = { listFinance: vi.fn() };
  fixture.submit.mockReset();
  fixture.mutate.mockReset();
  fixture.experience.mockReset().mockRejectedValue(new Error('unavailable'));
});

describe('mounted Finance authority transitions', () => {
  it('excludes cached and optimistic legacy values under normalized authority', async () => {
    fixture.api.listFinance.mockResolvedValue(page('normalized'));
    render(<FinanceRoute />);
    expect(
      await screen.findByText('Posted normalized transaction'),
    ).toBeVisible();
    expect(
      screen.queryByText('Optimistic legacy overwrite'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Cached legacy transaction'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('cached-budget')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add transaction' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Categorize or annotate' }),
    ).toBeDisabled();
  });

  it('removes open legacy editors at activation and keeps failed refresh locked', async () => {
    fixture.api.listFinance.mockResolvedValue(page('legacy'));
    const view = render(<FinanceRoute />);
    await screen.findByText('Cached legacy transaction');
    await userEvent.click(
      screen.getByRole('button', { name: 'Add transaction' }),
    );
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Categorize or annotate' })[0]!,
    );
    expect(
      screen.getByRole('button', { name: 'Save transaction' }),
    ).toBeVisible();
    expect(
      screen.getByLabelText('Category ID', {
        selector: '#activity-category-id',
      }),
    ).toBeVisible();
    fixture.api = {
      listFinance: vi.fn().mockResolvedValue(page('normalized')),
    };
    view.rerender(<FinanceRoute />);
    await screen.findByText('Posted normalized transaction');
    expect(
      screen.queryByRole('button', { name: 'Save transaction' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Category ID')).not.toBeInTheDocument();
    fixture.api = {
      listFinance: vi.fn().mockRejectedValue(new Error('refresh failed')),
    };
    await act(async () => view.rerender(<FinanceRoute />));
    await waitFor(() => expect(fixture.api.listFinance).toHaveBeenCalledOnce());
    expect(
      screen.getByRole('button', { name: 'Add transaction' }),
    ).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Save transaction' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Category ID')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Cached legacy transaction'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Finance data is unavailable.')).toBeVisible();
    expect(
      screen.queryByText('No transactions have been saved yet.'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('No budgets have been saved yet.'),
    ).not.toBeInTheDocument();
    expect(fixture.mutate).not.toHaveBeenCalled();
    expect(fixture.submit).not.toHaveBeenCalled();
  });
});
