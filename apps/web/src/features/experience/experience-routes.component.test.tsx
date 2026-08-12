import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  ActivityPage,
  FinancePage,
  NotificationPreferencesView,
  SchedulePage,
  SettingsView,
  ShoppingPage,
  TodayView,
} from '@emdo/contracts/browser';

import { createAppRouter } from '../../router.js';
import { createReadyDomainRuntimeFactory } from '../../test/fake-domain-runtime.js';
import type { EmdoAuthClient } from '../auth/auth-client.js';
import { AuthProvider } from '../auth/auth-context.js';
import { DomainDataProvider } from '../domains/domain-data.js';
import {
  ExperienceApiError,
  ExperienceApiProvider,
  type ExperienceApiClient,
} from './experience-api.js';

const authClient: EmdoAuthClient = {
  getSession: vi.fn(async () => ({
    session: { id: 'session-1', expiresAt: '2999-08-16T12:00:00.000Z' },
    user: {
      id: '22222222-2222-4222-8222-222222222222',
      email: 'member@example.ca',
      emailVerified: true,
      name: 'Member',
    },
  })),
  getMutationCsrf: vi.fn(async () => 'csrf-token-01234567890123456789'),
  signInEmail: vi.fn(async () => undefined),
  signInGoogle: vi.fn(async () => undefined),
  signInPasskey: vi.fn(async () => 'authenticated' as const),
  registerPasskey: vi.fn(async () => undefined),
  redeemInvitation: vi.fn(async () => ({
    status: 'provisioned' as const,
    email: 'member@example.ca',
    role: 'member' as const,
  })),
  signOut: vi.fn(async () => undefined),
};

const today: TodayView = {
  schemaVersion: 1,
  date: '2026-08-10',
  timezone: 'America/Toronto',
  schedule: { status: 'unavailable', items: [] },
  reminders: {
    status: 'available',
    items: [
      {
        id: 'reminder-1',
        title: 'Pick up parcel',
        sensitivity: 'standard',
        dueAt: '2026-08-10T14:00:00.000Z',
        state: 'scheduled',
      },
    ],
  },
  notifications: { status: 'available', items: [] },
  finance: { status: 'unavailable', budgetCount: 0, transactionCount: 0 },
  shopping: { status: 'unavailable', itemCount: 0, retailerCount: 0 },
};

const schedule: SchedulePage = {
  schemaVersion: 1,
  timezone: 'America/Toronto',
  from: '2026-08-10',
  to: '2026-08-17',
  items: { status: 'unavailable', items: [] },
  calendar: { status: 'unavailable' },
};

const settings: SettingsView = {
  schemaVersion: 1,
  household: { name: 'Riverside household', role: 'member' },
  privateSpaces: [{ name: 'Personal' }],
  calendar: { status: 'disconnected' },
};

const preferences: NotificationPreferencesView = {
  schemaVersion: 1,
  version: 3,
  inApp: true,
  push: false,
  email: true,
  spokenReplies: false,
  updatedAt: '2026-08-10T14:00:00.000Z',
};

const finance: FinancePage = {
  schemaVersion: 1,
  items: [
    {
      recordType: 'transaction',
      id: 'transaction-api-1',
      description: 'API groceries',
      category: 'groceries',
      postedOn: '2026-08-10',
      currency: 'CAD',
      amountCadMinor: 1_234,
      state: 'active',
    },
    {
      recordType: 'budget',
      id: 'budget-api-1',
      currency: 'CAD',
      allocationsCadMinor: { groceries: 65_000 },
    },
  ],
};

const shopping: ShoppingPage = {
  schemaVersion: 1,
  items: [
    {
      id: 'shopping-api-1',
      name: 'API milk',
      unit: 'carton',
      retailer: 'Market',
      quantityMinorUnits: 2_000,
      state: 'active',
    },
  ],
};

const createClient = (
  overrides: Partial<ExperienceApiClient> = {},
): ExperienceApiClient => ({
  readToday: vi.fn(async () => today),
  listActivity: vi.fn<ExperienceApiClient['listActivity']>(async () => ({
    schemaVersion: 1 as const,
    items: [],
  })),
  listSchedule: vi.fn(async () => schedule),
  listFinance: vi.fn(async () => finance),
  listShopping: vi.fn(async () => shopping),
  readSettings: vi.fn(async () => settings),
  getNotificationPreferences: vi.fn(async () => preferences),
  updateNotificationPreferences: vi.fn(async () => preferences),
  ...overrides,
});

async function renderPath(path: string, client: ExperienceApiClient) {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(
    <ExperienceApiProvider client={client}>
      <AuthProvider
        client={authClient}
        inspectOfflineSession={async () => null}
      >
        <DomainDataProvider runtimeFactory={createReadyDomainRuntimeFactory()}>
          <RouterProvider router={router} />
        </DomainDataProvider>
      </AuthProvider>
    </ExperienceApiProvider>,
  );
  await router.load();
}

describe('truthful experience routes', () => {
  it('renders Today only from the strict aggregate response', async () => {
    const client = createClient();
    await renderPath('/today', client);

    expect(
      await screen.findByText('Pick up parcel', undefined, { timeout: 5_000 }),
    ).toBeVisible();
    expect(screen.getByText('Schedule is unavailable.')).toBeVisible();
    expect(screen.getByText('Finance summary is unavailable.')).toBeVisible();
    expect(screen.getByText('Shopping summary is unavailable.')).toBeVisible();
    expect(screen.queryByText('Dentist appointment')).not.toBeInTheDocument();
    expect(screen.queryByText('Take out recycling')).not.toBeInTheDocument();
    expect(screen.queryByText('$482 of $650')).not.toBeInTheDocument();
    expect(client.readToday).toHaveBeenCalledOnce();
  });

  it('appends a bounded Activity page using only the returned cursor', async () => {
    const first: ActivityPage = {
      schemaVersion: 1,
      items: [
        {
          id: 'event-1',
          category: 'audit',
          title: 'Activity recorded',
          kind: 'finance.import.completed',
          occurredAt: '2026-08-10T14:00:00.000Z',
        },
      ],
      nextCursor: 'cursor-page-2',
    };
    const second: ActivityPage = {
      schemaVersion: 1,
      items: [
        {
          id: 'event-2',
          category: 'notification',
          title: 'Notification delivery recorded',
          status: 'sent',
          occurredAt: '2026-08-10T13:00:00.000Z',
        },
      ],
    };
    const listActivity = vi
      .fn<ExperienceApiClient['listActivity']>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    await renderPath('/activity', createClient({ listActivity }));

    expect(await screen.findByText('Activity recorded')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(
      await screen.findByText('Notification delivery recorded'),
    ).toBeVisible();
    expect(listActivity).toHaveBeenNthCalledWith(
      2,
      { cursor: 'cursor-page-2', limit: 25 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('renders durable Settings and persists preferences with current CSRF', async () => {
    const updateNotificationPreferences = vi.fn<
      ExperienceApiClient['updateNotificationPreferences']
    >(async ({ preferences: next }) => ({
      ...preferences,
      version: 4,
      ...next,
      updatedAt: '2026-08-10T14:01:00.000Z',
    }));
    const client = createClient({ updateNotificationPreferences });
    await renderPath('/settings', client);

    expect(
      await screen.findByText('Riverside household', undefined, {
        timeout: 5_000,
      }),
    ).toBeVisible();
    expect(screen.getByText('Personal')).toBeVisible();
    expect(screen.queryByText('Johnson household')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /Web Push/u }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Save preferences' }),
    );

    expect(await screen.findByText('Preferences saved.')).toBeVisible();
    expect(updateNotificationPreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 3,
        csrfToken: 'csrf-token-01234567890123456789',
        preferences: expect.objectContaining({ push: true }),
        idempotencyKey: expect.stringMatching(
          /^web\.notification-preferences\./u,
        ),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('refreshes a preference conflict without discarding the local choices', async () => {
    const getNotificationPreferences = vi
      .fn<ExperienceApiClient['getNotificationPreferences']>()
      .mockResolvedValueOnce(preferences)
      .mockResolvedValueOnce({
        ...preferences,
        version: 4,
        email: false,
        updatedAt: '2026-08-10T14:01:00.000Z',
      });
    const updateNotificationPreferences = vi
      .fn<ExperienceApiClient['updateNotificationPreferences']>()
      .mockRejectedValueOnce(
        new ExperienceApiError('unavailable', 'changed', 409),
      )
      .mockResolvedValueOnce({
        ...preferences,
        version: 5,
        push: true,
        email: true,
        updatedAt: '2026-08-10T14:02:00.000Z',
      });
    await renderPath(
      '/settings',
      createClient({
        getNotificationPreferences,
        updateNotificationPreferences,
      }),
    );

    await screen.findByText('Riverside household', undefined, {
      timeout: 5_000,
    });
    await userEvent.click(screen.getByRole('checkbox', { name: /Web Push/u }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Save preferences' }),
    );
    expect(
      await screen.findByText(
        'Preferences changed elsewhere. Review and save again.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /Web Push/u })).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: /Email reminders/u }),
    ).toBeChecked();

    await userEvent.click(
      screen.getByRole('button', { name: 'Save preferences' }),
    );
    expect(updateNotificationPreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedVersion: 4 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(await screen.findByText('Preferences saved.')).toBeVisible();
  });

  it('shows honest unavailable Settings and preference states without demo defaults', async () => {
    const client = createClient({
      readSettings: vi.fn(async () => Promise.reject(new Error('unavailable'))),
      getNotificationPreferences: vi.fn(async () =>
        Promise.reject(new Error('unavailable')),
      ),
    });
    await renderPath('/settings', client);

    expect(
      await screen.findByText('Household settings are unavailable.'),
    ).toBeVisible();
    expect(
      screen.getByText('Notification preferences are unavailable.'),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Save preferences' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Johnson household')).not.toBeInTheDocument();
  });

  it('renders Schedule only from its bounded aggregate response', async () => {
    const listSchedule = vi.fn<ExperienceApiClient['listSchedule']>(
      async () => ({
        schemaVersion: 1,
        timezone: 'America/Toronto',
        from: '2026-08-10',
        to: '2026-08-17',
        items: {
          status: 'available',
          items: [
            {
              id: 'schedule-api-1',
              title: 'API household planning',
              startsAt: '2026-08-11T13:00:00.000Z',
              endsAt: '2026-08-11T13:45:00.000Z',
              completion: 'pending',
            },
          ],
        },
        calendar: { status: 'disconnected' },
      }),
    );
    await renderPath('/schedule', createClient({ listSchedule }));

    expect(
      await screen.findByText('API household planning', undefined, {
        timeout: 5_000,
      }),
    ).toBeVisible();
    expect(screen.queryByText('Soccer practice')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Ranked appointment options'),
    ).not.toBeInTheDocument();
    expect(listSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('renders bounded Finance and Shopping projections without demo/provider fields', async () => {
    const client = createClient();
    await renderPath('/finance', client);
    expect(
      await screen.findByText('API groceries', undefined, { timeout: 5_000 }),
    ).toBeVisible();
    expect(screen.getByText('$12.34')).toBeVisible();
    expect(client.listFinance).toHaveBeenCalledWith(
      { limit: 25 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    cleanup();
    await renderPath('/shopping', client);
    expect(
      await screen.findByText('API milk', undefined, { timeout: 5_000 }),
    ).toBeVisible();
    expect(
      screen.queryByRole('link', { name: /Retailer link/u }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Offer updated/u)).not.toBeInTheDocument();
    expect(client.listShopping).toHaveBeenCalledWith(
      { limit: 25 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
