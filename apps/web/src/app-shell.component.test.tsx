import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { EmdoAuthClient } from './features/auth/auth-client.js';
import { AuthProvider } from './features/auth/auth-context.js';
import {
  DomainDataProvider,
  type DomainRuntimeFactory,
} from './features/domains/domain-data.js';
import { createAppRouter } from './router.js';
import { createReadyDomainRuntimeFactory } from './test/fake-domain-runtime.js';

afterEach(cleanup);

async function renderPath(
  path: string,
  runtimeFactory: DomainRuntimeFactory = createReadyDomainRuntimeFactory(),
) {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
  );
  const client = {
    getSession: async () => ({
      session: { id: 'session-1', expiresAt: '2999-08-16T12:00:00.000Z' },
      user: {
        id: 'user-1',
        email: 'member@example.ca',
        emailVerified: true,
        name: 'Member',
      },
    }),
    getMutationCsrf: async () => 'csrf-token-01234567890123456789',
    signInEmail: async () => undefined,
    signInGoogle: async () => undefined,
    signInPasskey: async () => 'authenticated' as const,
    registerPasskey: async () => undefined,
    redeemInvitation: async () => ({
      status: 'provisioned' as const,
      email: 'member@example.ca',
      role: 'member' as const,
    }),
    signOut: async () => undefined,
  } satisfies EmdoAuthClient;
  render(
    <AuthProvider client={client}>
      <DomainDataProvider runtimeFactory={runtimeFactory}>
        <RouterProvider router={router} />
      </DomainDataProvider>
    </AuthProvider>,
  );
  await router.load();
  return router;
}

describe('responsive EMDO app shell', () => {
  it('renders all desktop routes in accepted order and five mobile destinations', async () => {
    await renderPath('/today');
    const desktop = await screen.findByTestId('desktop-navigation');
    const mobile = screen.getByTestId('mobile-navigation');

    expect(
      within(desktop)
        .getAllByRole('link')
        .map((link) => link.textContent?.trim()),
    ).toEqual([
      'Today',
      'Ask EMDO',
      'Schedule',
      'Finance',
      'Shopping',
      'Approvals',
      'Activity',
      'Settings',
    ]);
    expect(
      within(mobile)
        .getAllByRole('link')
        .map((link) => link.textContent?.trim()),
    ).toEqual(['Today', 'Ask', 'Schedule', 'Finance']);
    expect(
      within(mobile).getByRole('button', { name: 'More' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Offline-ready · Sync starting', undefined, {
        timeout: 5_000,
      }),
    ).toBeVisible();
    expect(screen.queryByText(/synced just now/iu)).not.toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Good morning' }),
    ).toBeVisible();
  }, 10_000);

  it('marks More and the current secondary destination on an approval route', async () => {
    await renderPath('/approvals');

    expect(
      await screen.findByRole(
        'button',
        { name: 'More, current section: Approvals' },
        { timeout: 5_000 },
      ),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      within(screen.getByTestId('desktop-navigation')).getByRole('link', {
        name: 'Approvals',
      }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('shows a timestamp only after a verified live replication receipt', async () => {
    await renderPath(
      '/today',
      createReadyDomainRuntimeFactory({
        mode: 'online',
        state: 'verified',
        liveReplicationVerified: true,
        verifiedAt: '2026-08-10T14:30:00.000Z',
      }),
    );

    expect(
      await screen.findByText(/Offline-ready · Synced at/iu),
    ).toBeVisible();
    expect(screen.queryByText(/synced just now/iu)).not.toBeInTheDocument();
  });

  it.each([
    ['/today', 'Good morning'],
    ['/ask', 'Ask EMDO'],
    ['/schedule', 'Schedule'],
    ['/finance', 'Finance'],
    ['/shopping', 'Shopping'],
    ['/activity', 'Activity'],
    ['/settings', 'Settings'],
  ])('renders the direct route %s', async (path, heading) => {
    await renderPath(path);
    expect(await screen.findByRole('heading', { name: heading })).toBeVisible();
  });
});
