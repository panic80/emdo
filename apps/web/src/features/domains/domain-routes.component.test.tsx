import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  JsonValue,
  SchedulePage,
  SyncOperation,
} from '@emdo/contracts/browser';

import { createAppRouter } from '../../router.js';
import type { EmdoAuthClient } from '../auth/auth-client.js';
import { AuthProvider } from '../auth/auth-context.js';
import {
  ExperienceApiProvider,
  type ExperienceApiClient,
} from '../experience/experience-api.js';
import {
  DomainDataProvider,
  type DomainDataRuntime,
  type DomainName,
  type DomainRecord,
  type DomainRuntimeFactory,
} from './domain-data.js';
import {
  cadInputToMinorUnits,
  localDateInputValue,
} from '../../routes/finance.js';
import { createDomainRuntimeSnapshot } from '../../test/fake-domain-runtime.js';

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

const unavailableExperienceClient: ExperienceApiClient = {
  readToday: async () => Promise.reject(new Error('unavailable')),
  listActivity: async () => Promise.reject(new Error('unavailable')),
  listSchedule: async () => Promise.reject(new Error('unavailable')),
  listFinance: async () => Promise.reject(new Error('unavailable')),
  listShopping: async () => Promise.reject(new Error('unavailable')),
  readSettings: async () => Promise.reject(new Error('unavailable')),
  getNotificationPreferences: async () =>
    Promise.reject(new Error('unavailable')),
  updateNotificationPreferences: async () =>
    Promise.reject(new Error('unavailable')),
};

const scheduleExperienceClient = (
  item: SchedulePage['items']['items'][number],
): ExperienceApiClient => ({
  ...unavailableExperienceClient,
  listSchedule: async ({ from, to }) => ({
    schemaVersion: 1,
    timezone: 'America/Toronto',
    from,
    to,
    items: { status: 'available', items: [item] },
    calendar: { status: 'disconnected' },
  }),
});

function domainFor(entityType: string): DomainName {
  if (entityType.startsWith('scheduler.')) return 'scheduler';
  if (entityType.startsWith('finance.')) return 'finance';
  return 'shopping';
}

function payloadData(
  operation: SyncOperation,
): Readonly<Record<string, JsonValue>> {
  const envelope = operation.mutation.payload as Record<string, JsonValue>;
  const key =
    operation.mutation.kind === 'create'
      ? 'value'
      : operation.mutation.kind === 'update'
        ? 'patch'
        : operation.mutation.kind === 'delta'
          ? 'delta'
          : undefined;
  if (!key) return {};
  const value = envelope[key];
  return value && !Array.isArray(value) && typeof value === 'object'
    ? (value as Record<string, JsonValue>)
    : {};
}

function capturingRuntimeFactory(
  operations: SyncOperation[],
  initialRecords: readonly DomainRecord[] = [],
): DomainRuntimeFactory {
  return async () => {
    let records: DomainRecord[] = [...initialRecords];
    const runtime: DomainDataRuntime = {
      clientId: '33333333-3333-4333-8333-333333333333',
      inspect: async () =>
        createDomainRuntimeSnapshot({
          records,
          pendingCount: operations.length,
        }),
      applyLocalMutation: async (operation) => {
        operations.push(operation);
        const existing = records.find(
          (record) =>
            record.entityType === operation.entity.type &&
            record.id === operation.entity.id,
        );
        const nextData = payloadData(operation);
        const nextValue =
          operation.mutation.kind === 'delta'
            ? Object.fromEntries(
                Object.entries({ ...existing?.value, ...nextData }).map(
                  ([key, value]) => {
                    const prior = existing?.value[key];
                    return [
                      key,
                      typeof value === 'number' && typeof prior === 'number'
                        ? prior + value
                        : value,
                    ];
                  },
                ),
              )
            : nextData;
        records = [
          ...records.filter(
            (record) =>
              record.entityType !== operation.entity.type ||
              record.id !== operation.entity.id,
          ),
          {
            domain: domainFor(operation.entity.type),
            entityType: operation.entity.type,
            id: operation.entity.id,
            value: nextValue,
            revision: operation.baseRevision + 1,
            tombstoned: operation.mutation.kind === 'delete',
            updatedAt: operation.createdAt,
            lastOperationId: operation.operationId,
          },
        ];
      },
      syncNow: async () => ({
        status: 'complete',
        submittedCount: operations.length,
        acceptedOperationIds: operations.map(({ operationId }) => operationId),
        terminalConflicts: [],
        retryableOperations: [],
      }),
      dismissTerminalConflict: async () => undefined,
      subscribeSnapshotInvalidation: () => () => undefined,
      logout: async () => ({ status: 'complete' }),
      dispose: async () => undefined,
    };
    return runtime;
  };
}

async function renderPath(
  path: string,
  operations: SyncOperation[],
  initialRecords: readonly DomainRecord[] = [],
  experienceClient: ExperienceApiClient = unavailableExperienceClient,
) {
  await renderPathWithRuntimeFactory(
    path,
    capturingRuntimeFactory(operations, initialRecords),
    experienceClient,
  );
  await screen.findByText('Encrypted offline data is up to date', undefined, {
    timeout: 15_000,
  });
}

async function renderPathWithRuntimeFactory(
  path: string,
  runtimeFactory: DomainRuntimeFactory,
  experienceClient: ExperienceApiClient = unavailableExperienceClient,
) {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(
    <ExperienceApiProvider client={experienceClient}>
      <AuthProvider
        client={authClient}
        inspectOfflineSession={async () => null}
      >
        <DomainDataProvider runtimeFactory={runtimeFactory}>
          <RouterProvider router={router} />
        </DomainDataProvider>
      </AuthProvider>
    </ExperienceApiProvider>,
  );
  await router.load();
}

async function expectOneLocalChangePending(): Promise<void> {
  const statuses = await screen.findAllByText('1 local change waiting to sync');
  expect(statuses.length).toBeGreaterThan(0);
}

describe(
  'domain route to encrypted queue integration',
  { timeout: 20_000 },
  () => {
    it('saves a scheduler alternative locally without requesting a Calendar write', async () => {
      const operations: SyncOperation[] = [];
      await renderPath(
        '/schedule',
        operations,
        [],
        scheduleExperienceClient({
          id: 'appointment-plan-2026-08-11',
          title: 'Appointment option: More buffer',
          startsAt: '2026-08-11T16:00:00.000-04:00',
          endsAt: '2026-08-11T17:00:00.000-04:00',
          completion: 'pending',
        }),
      );

      await userEvent.click(
        await screen.findByRole('button', {
          name: 'Save offline copy of Appointment option: More buffer',
        }),
      );
      expect(
        await screen.findByText(
          'Schedule item saved locally. Google Calendar was not changed.',
        ),
      ).toBeVisible();
      await expectOneLocalChangePending();

      expect(operations).toHaveLength(1);
      expect(operations[0]).toMatchObject({
        entity: { type: 'scheduler.item', id: 'appointment-plan-2026-08-11' },
        mutation: {
          kind: 'create',
          payload: {
            value: {
              id: 'appointment-plan-2026-08-11',
              title: 'Appointment option: More buffer',
              notes: null,
              location: null,
              startsAt: '2026-08-11T16:00:00.000-04:00',
              endsAt: '2026-08-11T17:00:00.000-04:00',
              recurrence: null,
              attendees: [],
              completion: 'open',
            },
          },
        },
      });
      expect(JSON.stringify(operations[0])).not.toMatch(
        /google-calendar|providerWrite/iu,
      );
    });

    it('updates scheduler alternatives with the exact base/local merge envelope', async () => {
      const operations: SyncOperation[] = [];
      const base = {
        id: 'appointment-plan-2026-08-11',
        title: 'Appointment option: Best fit',
        notes: 'Leave by 1:55 PM',
        location: null,
        startsAt: '2026-08-11T14:30:00.000-04:00',
        endsAt: '2026-08-11T15:30:00.000-04:00',
        recurrence: null,
        attendees: [],
        completion: 'open',
      };
      await renderPath(
        '/schedule',
        operations,
        [
          {
            domain: 'scheduler',
            entityType: 'scheduler.item',
            id: base.id,
            value: base,
            revision: 3,
            tombstoned: false,
            updatedAt: '2026-08-10T12:00:00.000Z',
            spaceId: '11111111-1111-4111-8111-111111111111',
          },
        ],
        scheduleExperienceClient({
          id: base.id,
          title: 'Appointment option: More buffer',
          startsAt: '2026-08-11T16:00:00.000-04:00',
          endsAt: '2026-08-11T17:00:00.000-04:00',
          completion: 'pending',
        }),
      );

      await userEvent.click(
        await screen.findByRole('button', {
          name: 'Save offline copy of Appointment option: More buffer',
        }),
      );

      await waitFor(() => expect(operations).toHaveLength(1));
      await expectOneLocalChangePending();
      expect(operations[0]).toMatchObject({
        baseRevision: 3,
        mutation: {
          kind: 'update',
          payload: {
            patch: {
              base,
              local: {
                id: base.id,
                startsAt: '2026-08-11T16:00:00.000-04:00',
                endsAt: '2026-08-11T17:00:00.000-04:00',
              },
            },
          },
        },
      });
    });

    it('stores manual CAD money as exact integer minor units', async () => {
      const operations: SyncOperation[] = [];
      await renderPath('/finance', operations);

      await userEvent.click(
        screen.getByRole('button', { name: 'Add transaction' }),
      );
      await userEvent.type(screen.getByLabelText('Description'), 'Farm Boy');
      await userEvent.clear(screen.getByLabelText('Category'));
      await userEvent.type(screen.getByLabelText('Category'), 'Groceries');
      await userEvent.type(screen.getByLabelText('Amount (CAD)'), '12.34');
      await userEvent.click(
        screen.getByRole('button', { name: 'Save transaction' }),
      );

      await waitFor(() => expect(operations).toHaveLength(1));
      await expectOneLocalChangePending();
      expect(operations[0]?.mutation).toMatchObject({
        kind: 'create',
        payload: {
          value: { amountCadMinor: 1234, currency: 'CAD' },
        },
      });
      expect(screen.getByText('$12.34')).toBeVisible();
    });

    it('renders finance records from DomainData without seeded production fallbacks', async () => {
      const records: DomainRecord[] = [
        {
          domain: 'finance',
          entityType: 'finance.transaction',
          id: 'transaction-1',
          value: {
            recordType: 'transaction',
            description: 'Farm Boy',
            category: 'Groceries',
            amountCadMinor: 1_234,
            currency: 'CAD',
            postedOn: '2026-08-10',
          },
          revision: 1,
          tombstoned: false,
          updatedAt: '2026-08-10T12:00:00.000Z',
        },
        {
          domain: 'finance',
          entityType: 'finance.budget',
          id: 'budget-1',
          value: {
            id: 'budget-1',
            currency: 'CAD',
            allocationsCadMinor: { groceries: 65_000 },
          },
          revision: 1,
          tombstoned: false,
          updatedAt: '2026-08-10T12:00:00.000Z',
        },
        {
          domain: 'finance',
          entityType: 'finance.transaction',
          id: 'transaction-canonical-1',
          value: {
            recordType: 'transaction',
            description: 'Toronto Hydro',
            category: 'Utilities',
            effectiveAmountCadMinor: 2_500,
            currency: 'CAD',
            postedOn: '2026-08-09',
          },
          revision: 2,
          tombstoned: false,
          updatedAt: '2026-08-10T12:00:00.000Z',
        },
      ];

      await renderPath('/finance', [], records);

      expect(screen.getByText('Farm Boy')).toBeVisible();
      expect(screen.getByText('$12.34')).toBeVisible();
      expect(screen.getByText('Toronto Hydro')).toBeVisible();
      expect(screen.getByText('$25.00')).toBeVisible();
      expect(screen.getByText('$650.00 allocated')).toBeVisible();
      expect(screen.queryByText('No Frills')).not.toBeInTheDocument();
      expect(screen.queryByText('$482')).not.toBeInTheDocument();
    });

    it('shows truthful empty finance states when DomainData has no records', async () => {
      await renderPath('/finance', []);

      expect(screen.getByText('No budgets have been saved yet.')).toBeVisible();
      expect(
        screen.getByText('No transactions have been saved yet.'),
      ).toBeVisible();
      expect(
        screen.queryByRole('button', { name: 'Import statement' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('No Frills')).not.toBeInTheDocument();
    });

    it('reports finance records as loading while encrypted DomainData is opening', async () => {
      await renderPathWithRuntimeFactory(
        '/finance',
        () => new Promise<DomainDataRuntime>(() => undefined),
      );

      expect(await screen.findByText('Budget data is loading…')).toBeVisible();
      expect(screen.getByText('Transaction data is loading…')).toBeVisible();
    });

    it('queues an idempotent shopping delta for a persisted item before changing its quantity', async () => {
      const operations: SyncOperation[] = [];
      await renderPath('/shopping', operations, [
        {
          domain: 'shopping',
          entityType: 'shopping.item',
          id: 'oat-milk',
          value: {
            name: 'Oat milk',
            quantityMinorUnits: 2_000,
            unit: 'L',
            retailer: 'Local grocer',
          },
          revision: 1,
          tombstoned: false,
          updatedAt: '2026-08-10T12:00:00.000Z',
        },
      ]);

      expect(screen.queryByText('2% milk')).not.toBeInTheDocument();
      await userEvent.click(
        screen.getByRole('button', { name: 'Increase Oat milk' }),
      );

      await waitFor(() => expect(operations).toHaveLength(1));
      await expectOneLocalChangePending();
      expect(operations[0]).toMatchObject({
        entity: { type: 'shopping.item', id: 'oat-milk' },
        mutation: {
          kind: 'delta',
          payload: { delta: { quantityMinorUnits: 1000 } },
        },
      });
      expect(screen.getByText('3 L')).toBeVisible();
    });

    it('shows a truthful empty shopping state without seeded retailer items', async () => {
      await renderPath('/shopping', []);

      expect(
        screen.getByText('No shopping items have been saved yet.'),
      ).toBeVisible();
      expect(
        screen.queryByRole('button', { name: 'Add item' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('Large eggs')).not.toBeInTheDocument();
      expect(screen.queryByText('Laundry detergent')).not.toBeInTheDocument();
    });

    it('reports shopping records as unavailable when encrypted DomainData cannot open', async () => {
      await renderPathWithRuntimeFactory('/shopping', async () => {
        throw new Error('storage unavailable');
      });

      expect(
        await screen.findByText(
          'Shopping data is unavailable while encrypted storage is locked.',
        ),
      ).toBeVisible();
    });
  },
);

describe('CAD integer parsing', () => {
  it.each([
    ['0', 0],
    ['1.2', 120],
    ['12.34', 1234],
    ['999999999.99', 99_999_999_999],
  ])('parses %s without floating-point arithmetic', (input, expected) => {
    expect(cadInputToMinorUnits(input)).toBe(expected);
  });

  it('uses the browser-local calendar date for new manual transactions', () => {
    expect(localDateInputValue(new Date(2026, 7, 10, 23, 45))).toBe(
      '2026-08-10',
    );
  });
});
