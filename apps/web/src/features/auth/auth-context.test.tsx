import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  AuthProvider,
  useAuth,
  type AuthContextValue,
} from './auth-context.js';
import {
  AuthClientError,
  type AuthSession,
  type EmdoAuthClient,
} from './auth-client.js';
import type { BrowserOfflineSessionHint } from '../../offline/logout-purge.js';

const activeSession: AuthSession = {
  session: { id: 'session-1', expiresAt: '2999-08-16T12:00:00.000Z' },
  user: {
    id: 'user-1',
    email: 'member@example.ca',
    emailVerified: true,
    name: 'Member',
  },
};

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function client(session: AuthSession | null | Error): EmdoAuthClient {
  return {
    getSession: vi.fn(async () => {
      if (session instanceof Error) throw session;
      return session;
    }),
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
}

function Probe() {
  const auth = useAuth();
  return <output>{`${auth.state}:${auth.csrfToken ?? 'no-proof'}`}</output>;
}

function OfflineProbe() {
  const auth = useAuth();
  return (
    <>
      <output>{`${auth.state}:${auth.sessionBinding ?? 'locked'}:${auth.serverSessionKnownRevoked ? 'revoked' : 'unknown'}:${auth.memorySeal}`}</output>
      <button type="button" onClick={auth.sealForPeerTeardown}>
        Seal peer
      </button>
      <button type="button" onClick={() => auth.sealAfterLogout('incomplete')}>
        Seal incomplete
      </button>
    </>
  );
}

describe('AuthProvider', () => {
  describe.each(['complete', 'incomplete', 'peer'] as const)(
    '%s logout seal',
    (seal) => {
      it.each([
        'session',
        'csrf',
        'binding',
        'offline-hint',
        'anonymous-hint',
        'failed-hint',
      ] as const)('discards a refresh paused at %s', async (stage) => {
        let auth!: AuthContextValue;
        function Capture() {
          auth = useAuth();
          return null;
        }
        const authClient = client(activeSession);
        const inspect = vi.fn(
          async (): Promise<BrowserOfflineSessionHint | null> => null,
        );
        render(
          <AuthProvider client={authClient} inspectOfflineSession={inspect}>
            <Capture />
          </AuthProvider>,
        );
        await waitFor(() => expect(auth.state).toBe('authenticated'));
        const entered = vi.fn();
        const gate = deferred<void>();
        const pause = async () => {
          entered();
          await gate.promise;
        };
        if (stage === 'session') {
          vi.mocked(authClient.getSession).mockImplementationOnce(async () => {
            await pause();
            return activeSession;
          });
        } else if (stage === 'csrf') {
          vi.mocked(authClient.getMutationCsrf).mockImplementationOnce(
            async () => {
              await pause();
              return 'stale-csrf-proof';
            },
          );
        } else if (stage === 'binding') {
          vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async () => {
            await pause();
            return new Uint8Array(32).buffer;
          });
        } else {
          if (stage === 'anonymous-hint')
            vi.mocked(authClient.getSession).mockResolvedValueOnce(null);
          if (stage === 'failed-hint')
            vi.mocked(authClient.getSession).mockRejectedValueOnce(
              new AuthClientError('session-network-unavailable', 'offline'),
            );
          const binding = auth.sessionBinding!;
          inspect.mockImplementationOnce(async () => {
            await pause();
            return {
              version: 1,
              status: 'active',
              canEditOffline: true,
              sessionBinding: binding,
            };
          });
        }
        let refresh!: Promise<void>;
        act(() => {
          refresh = auth.refresh();
        });
        await waitFor(() => expect(entered).toHaveBeenCalledOnce());
        act(() => {
          if (seal === 'peer') auth.sealForPeerTeardown();
          else auth.sealAfterLogout(seal);
        });
        const sealed = auth;
        expect(sealed).toMatchObject({
          state: seal === 'complete' ? 'anonymous' : 'logout-pending',
          session: undefined,
          csrfToken: undefined,
          serverSessionKnownRevoked: seal !== 'peer',
          memorySeal:
            seal === 'peer'
              ? 'peer-teardown'
              : seal === 'incomplete'
                ? 'local-cleanup-pending'
                : 'none',
        });
        await act(async () => {
          gate.resolve();
          await refresh;
        });
        expect(auth).toBe(sealed);
      });

      it('allows a fresh sign-in only after local logout cleanup is complete', async () => {
        let auth!: AuthContextValue;
        function Capture() {
          auth = useAuth();
          return null;
        }
        const authClient = client(activeSession);
        const inspect = async () => null;
        render(
          <AuthProvider client={authClient} inspectOfflineSession={inspect}>
            <Capture />
          </AuthProvider>,
        );
        await waitFor(() => expect(auth.state).toBe('authenticated'));
        act(() => {
          if (seal === 'peer') auth.sealForPeerTeardown();
          else auth.sealAfterLogout(seal);
        });
        vi.mocked(authClient.getSession).mockClear();
        await act(() => auth.refresh());
        if (seal !== 'complete') {
          expect(authClient.getSession).not.toHaveBeenCalled();
          expect(auth.state).toBe('logout-pending');
          act(() => auth.sealAfterLogout('complete'));
          await act(() => auth.refresh());
        }
        expect(auth.state).toBe('authenticated');
      });
    },
  );

  it('keeps the newest refresh result when an older session request fails late', async () => {
    let auth!: AuthContextValue;
    function Capture() {
      auth = useAuth();
      return null;
    }
    const authClient = client(activeSession);
    const inspect = async () => null;
    render(
      <AuthProvider client={authClient} inspectOfflineSession={inspect}>
        <Capture />
      </AuthProvider>,
    );
    await waitFor(() => expect(auth.state).toBe('authenticated'));
    const gate = deferred<void>();
    vi.mocked(authClient.getSession).mockImplementationOnce(async () => {
      await gate.promise;
      throw new Error('late failure');
    });
    let oldRefresh!: Promise<void>;
    act(() => {
      oldRefresh = auth.refresh();
    });
    vi.mocked(authClient.getSession).mockResolvedValueOnce(null);
    await act(() => auth.refresh());
    expect(auth.state).toBe('anonymous');
    const latest = auth;
    await act(async () => {
      gate.resolve();
      await oldRefresh;
    });
    expect(auth).toBe(latest);
  });

  it('exposes an authenticated cookie-backed session without exposing a token', async () => {
    const session = {
      session: { id: 'session-1', expiresAt: '2999-08-16T12:00:00.000Z' },
      user: {
        id: 'user-1',
        email: 'member@example.ca',
        emailVerified: true,
        name: 'Member',
      },
    } satisfies AuthSession;

    render(
      <AuthProvider client={client(session)}>
        <Probe />
      </AuthProvider>,
    );

    expect(
      await screen.findByText('authenticated:csrf-token-01234567890123456789'),
    ).toBeVisible();
  });

  it.each([
    [null, 'anonymous'],
    [
      {
        session: { id: 'session-old', expiresAt: '2000-01-01T00:00:00.000Z' },
        user: {
          id: 'user-1',
          email: 'member@example.ca',
          emailVerified: true,
          name: null,
        },
      } satisfies AuthSession,
      'expired',
    ],
    [new Error('provider detail'), 'unavailable'],
  ] as const)('maps session result to %s state', async (session, expected) => {
    render(
      <AuthProvider client={client(session)}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText(`${expected}:no-proof`)).toBeVisible(),
    );
    expect(screen.queryByText('provider detail')).not.toBeInTheDocument();
  });

  it.each([
    ['active', true, 'offline-authenticated'],
    ['logout-pending', false, 'logout-pending'],
  ] as const)(
    'uses the opaque %s device binding only while the session endpoint is offline',
    async (status, canEditOffline, expected) => {
      const binding = 'a'.repeat(64);
      render(
        <AuthProvider
          client={client(new Error('offline'))}
          inspectOfflineSession={async () =>
            status === 'active'
              ? {
                  version: 1,
                  status: 'active',
                  canEditOffline: true,
                  sessionBinding: binding,
                }
              : {
                  version: 1,
                  status: 'logout-pending',
                  canEditOffline: false,
                  sessionBinding: binding,
                }
          }
          isOnline={() => false}
        >
          <OfflineProbe />
        </AuthProvider>,
      );

      expect(
        await screen.findByText(
          `${expected}:${binding}:unknown:${status === 'logout-pending' ? 'local-cleanup-pending' : 'none'}`,
        ),
      ).toBeVisible();
    },
  );

  it('uses a matching encrypted offline binding when transport fails despite an online hint', async () => {
    const binding = 'e'.repeat(64);
    render(
      <AuthProvider
        client={client(
          new AuthClientError(
            'session-network-unavailable',
            'EMDO could not reach the secure session endpoint.',
          ),
        )}
        inspectOfflineSession={async () => ({
          version: 1,
          status: 'active',
          canEditOffline: true,
          sessionBinding: binding,
        })}
        isOnline={() => true}
      >
        <OfflineProbe />
      </AuthProvider>,
    );

    expect(
      await screen.findByText(`offline-authenticated:${binding}:unknown:none`),
    ).toBeVisible();
  });

  it('never trusts an offline key hint while the server is reachable', async () => {
    render(
      <AuthProvider
        client={client(new Error('server rejected session'))}
        inspectOfflineSession={async () => ({
          version: 1,
          status: 'active',
          canEditOffline: true,
          sessionBinding: 'b'.repeat(64),
        })}
        isOnline={() => true}
      >
        <OfflineProbe />
      </AuthProvider>,
    );

    expect(
      await screen.findByText('unavailable:locked:unknown:none'),
    ).toBeVisible();
  });

  it('preserves logout recovery on an online reload with a still-valid server session', async () => {
    const session = {
      session: { id: 'session-1', expiresAt: '2999-08-16T12:00:00.000Z' },
      user: {
        id: 'user-1',
        email: 'member@example.ca',
        emailVerified: true,
        name: 'Member',
      },
    } satisfies AuthSession;
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(session.session.id),
    );
    const binding = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');

    render(
      <AuthProvider
        client={client(session)}
        inspectOfflineSession={async () => ({
          version: 1,
          status: 'logout-pending',
          canEditOffline: false,
          sessionBinding: binding,
        })}
        isOnline={() => true}
      >
        <OfflineProbe />
      </AuthProvider>,
    );

    expect(
      await screen.findByText(
        `logout-pending:${binding}:unknown:local-cleanup-pending`,
      ),
    ).toBeVisible();
  });

  it('preserves cleanup-only recovery after the server session was already revoked', async () => {
    const binding = 'c'.repeat(64);
    render(
      <AuthProvider
        client={client(null)}
        inspectOfflineSession={async () => ({
          version: 1,
          status: 'logout-pending',
          canEditOffline: false,
          sessionBinding: binding,
        })}
        isOnline={() => true}
      >
        <OfflineProbe />
      </AuthProvider>,
    );

    expect(
      await screen.findByText(
        `logout-pending:${binding}:revoked:local-cleanup-pending`,
      ),
    ).toBeVisible();
  });

  it('never turns an active local hint into authentication after an online anonymous response', async () => {
    render(
      <AuthProvider
        client={client(null)}
        inspectOfflineSession={async () => ({
          version: 1,
          status: 'active',
          canEditOffline: true,
          sessionBinding: 'd'.repeat(64),
        })}
        isOnline={() => true}
      >
        <OfflineProbe />
      </AuthProvider>,
    );

    expect(
      await screen.findByText('anonymous:locked:revoked:none'),
    ).toBeVisible();
  });

  it('clears the session proof immediately when another tab seals this context', async () => {
    const session = {
      session: { id: 'session-1', expiresAt: '2999-08-16T12:00:00.000Z' },
      user: {
        id: 'user-1',
        email: 'member@example.ca',
        emailVerified: true,
        name: 'Member',
      },
    } satisfies AuthSession;
    render(
      <AuthProvider client={client(session)}>
        <OfflineProbe />
      </AuthProvider>,
    );
    await screen.findByText(/authenticated:.*:unknown:none/u);

    screen.getByRole('button', { name: 'Seal peer' }).click();

    expect(
      await screen.findByText(/logout-pending:.*:unknown:peer-teardown/u),
    ).toBeVisible();
  });

  it('retains only the opaque binding for cleanup after server logout succeeds', async () => {
    const session = {
      session: { id: 'session-1', expiresAt: '2999-08-16T12:00:00.000Z' },
      user: {
        id: 'user-1',
        email: 'member@example.ca',
        emailVerified: true,
        name: 'Member',
      },
    } satisfies AuthSession;
    render(
      <AuthProvider client={client(session)}>
        <OfflineProbe />
      </AuthProvider>,
    );
    await screen.findByText(/authenticated:.*:unknown:none/u);

    screen.getByRole('button', { name: 'Seal incomplete' }).click();

    expect(
      await screen.findByText(
        /logout-pending:.*:revoked:local-cleanup-pending/u,
      ),
    ).toBeVisible();
  });
});
