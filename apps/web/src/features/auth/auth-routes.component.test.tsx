import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '../../router.js';
import type { AuthSession, EmdoAuthClient } from './auth-client.js';
import { AuthProvider } from './auth-context.js';
import { DomainDataProvider } from '../domains/domain-data.js';
import { createReadyDomainRuntimeFactory } from '../../test/fake-domain-runtime.js';

const authenticatedSession = {
  session: { id: 'session-1', expiresAt: '2999-08-16T12:00:00.000Z' },
  user: {
    id: 'user-1',
    email: 'member@example.ca',
    emailVerified: true,
    name: 'Member',
  },
} satisfies AuthSession;

function authClient(overrides: Partial<EmdoAuthClient> = {}): EmdoAuthClient {
  return {
    getSession: vi.fn(async () => null),
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
    ...overrides,
  };
}

async function renderPath(path: string, client: EmdoAuthClient) {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(
    <AuthProvider client={client}>
      <DomainDataProvider runtimeFactory={createReadyDomainRuntimeFactory()}>
        <RouterProvider router={router} />
      </DomainDataProvider>
    </AuthProvider>,
  );
  await router.load();
  return router;
}

describe('invite-only authentication routes', () => {
  it('redirects an anonymous root visit once without a router update loop', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      const router = await renderPath('/', authClient());

      expect(
        await screen.findByRole('heading', { name: 'Welcome back' }),
      ).toBeVisible();
      expect(router.state.location.pathname).toBe('/sign-in');
      expect(
        consoleError.mock.calls.some((call) =>
          call.some((value) =>
            String(value).includes('Maximum update depth exceeded'),
          ),
        ),
      ).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('signs in with verified email/password and exposes no public sign-up path', async () => {
    let session: AuthSession | null = null;
    const client = authClient({
      getSession: vi.fn(async () => session),
      signInEmail: vi.fn(async () => {
        session = authenticatedSession;
      }),
    });
    await renderPath('/sign-in', client);

    expect(
      await screen.findByRole('heading', { name: 'Welcome back' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('link', { name: /sign up|create account/iu }),
    ).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Email'), 'MEMBER@example.ca');
    await userEvent.type(
      screen.getByLabelText('Password'),
      'correct horse battery staple',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Good morning' }),
      ).toBeVisible(),
    );
    expect(client.signInEmail).toHaveBeenCalledWith({
      email: 'MEMBER@example.ca',
      password: 'correct horse battery staple',
      rememberMe: false,
    });
  });

  it('handles passkey cancellation as a retryable, nonfatal state', async () => {
    const client = authClient({
      signInPasskey: vi.fn(async () => 'cancelled' as const),
    });
    await renderPath('/sign-in', client);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Use a passkey' }),
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'Passkey sign-in was cancelled. Nothing changed; you can try again.',
    );
    expect(
      screen.getByText(
        'Google identity only · Calendar access stays separate.',
      ),
    ).toBeVisible();
  });

  it('redeems a single-use email-bound invitation without auto-signing in', async () => {
    const client = authClient();
    const path =
      '/invite?invitationId=11111111-1111-4111-8111-111111111111&token=single-use-secret-012345&email=member%40example.ca';
    await renderPath(path, client);

    expect(
      await screen.findByRole('heading', { name: 'Join your household' }),
    ).toBeVisible();
    expect(screen.getByText('member@example.ca')).toBeVisible();
    await userEvent.type(
      screen.getByLabelText('Display name'),
      'Household Member',
    );
    await userEvent.type(
      screen.getByLabelText('Create password'),
      'correct horse battery staple',
    );
    await userEvent.type(
      screen.getByLabelText('Confirm password'),
      'correct horse battery staple',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Create invited account' }),
    );

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Your invited account is ready. Sign in to continue.',
    );
    expect(client.redeemInvitation).toHaveBeenCalledWith({
      schemaVersion: 1,
      displayName: 'Household Member',
      email: 'member@example.ca',
      invitationId: '11111111-1111-4111-8111-111111111111',
      invitationToken: 'single-use-secret-012345',
      password: 'correct horse battery staple',
    });
    expect(client.signInEmail).not.toHaveBeenCalled();
  });
});
