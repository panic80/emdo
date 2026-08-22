import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '../components/button.js';
import { Icon } from '../components/icon.js';
import { ThemeToggle } from '../components/theme-toggle.js';
import { AuthClientError } from '../features/auth/auth-client.js';
import { useAuth } from '../features/auth/auth-context.js';
import { useDomainData } from '../features/domains/domain-data.js';
import { LogoutPanel } from '../features/sync/logout-panel.js';

const SignInSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.').max(512),
  rememberMe: z.boolean(),
});

type SignInValues = z.input<typeof SignInSchema>;

export function SignInRoute() {
  const auth = useAuth();
  const domain = useDomainData();
  const navigate = useNavigate();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInValues>({
    resolver: zodResolver(SignInSchema),
    defaultValues: { email: '', password: '', rememberMe: false },
  });

  useEffect(() => {
    if (
      auth.state === 'authenticated' ||
      auth.state === 'offline-authenticated'
    ) {
      void navigate({ to: '/today', replace: true });
    }
  }, [auth.state, navigate]);

  const safeError = (caught: unknown) =>
    caught instanceof AuthClientError
      ? caught.message
      : 'EMDO could not complete sign-in. Try again.';

  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="sign-in-heading">
        <div className="auth-masthead">
          <a
            className="auth-wordmark"
            href="/sign-in"
            aria-label="EMDO sign in"
          >
            EMDO
          </a>
          <ThemeToggle />
        </div>
        <header>
          <p className="auth-eyebrow">Invite-only household assistant</p>
          <h1 id="sign-in-heading">Welcome back</h1>
          <p>Sign in to your private household space.</p>
        </header>

        {auth.state === 'expired' ? (
          <p className="auth-alert" role="alert">
            Your session expired. Sign in again; unsynced local data remains
            protected on this device.
          </p>
        ) : null}
        {auth.state === 'unavailable' ? (
          <p className="auth-alert" role="alert">
            EMDO cannot verify a secure session right now. Check your connection
            and try again.
          </p>
        ) : null}
        {auth.state === 'logout-pending' ? (
          <p className="auth-alert" role="alert">
            {auth.memorySeal === 'peer-teardown'
              ? 'Another EMDO tab is finishing logout. This tab is locked; reload after the other tab completes.'
              : 'The server session is signed out, but local cleanup did not finish. Editing stays locked until cleanup succeeds.'}
          </p>
        ) : null}

        {auth.state === 'logout-pending' &&
        auth.memorySeal !== 'peer-teardown' ? (
          <LogoutPanel
            boundary={domain.logoutBoundary}
            onComplete={() => void auth.refresh()}
          />
        ) : auth.state !== 'logout-pending' ? (
          <>
            <form
              className="auth-form"
              noValidate
              onSubmit={handleSubmit(async (values) => {
                setError(undefined);
                setNotice(undefined);
                try {
                  await auth.client.signInEmail(values);
                  await auth.refresh();
                } catch (caught) {
                  setError(safeError(caught));
                }
              })}
            >
              <label htmlFor="sign-in-email">Email</label>
              <input
                {...register('email')}
                autoComplete="email"
                id="sign-in-email"
                inputMode="email"
                type="email"
              />
              {errors.email ? (
                <p className="field-error" role="alert">
                  {errors.email.message}
                </p>
              ) : null}

              <label htmlFor="sign-in-password">Password</label>
              <input
                {...register('password')}
                autoComplete="current-password"
                id="sign-in-password"
                type="password"
              />
              {errors.password ? (
                <p className="field-error" role="alert">
                  {errors.password.message}
                </p>
              ) : null}

              <label className="auth-check" htmlFor="remember-me">
                <input
                  {...register('rememberMe')}
                  id="remember-me"
                  type="checkbox"
                />
                <span>Keep me signed in on this device</span>
              </label>
              <Button busy={isSubmitting} type="submit">
                Sign in
              </Button>
            </form>

            <div className="auth-divider">
              <span>or</span>
            </div>
            <div className="auth-options">
              <Button
                variant="secondary"
                onClick={() => {
                  setError(undefined);
                  setNotice(undefined);
                  void auth.client
                    .signInGoogle('/today')
                    .catch((caught: unknown) => setError(safeError(caught)));
                }}
                type="button"
              >
                <Icon name="user" size={19} /> Continue with Google
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setError(undefined);
                  setNotice(undefined);
                  void auth.client
                    .signInPasskey()
                    .then(async (status) => {
                      if (status === 'cancelled') {
                        setNotice(
                          'Passkey sign-in was cancelled. Nothing changed; you can try again.',
                        );
                        return;
                      }
                      await auth.refresh();
                    })
                    .catch((caught: unknown) => setError(safeError(caught)));
                }}
                type="button"
              >
                <Icon name="lock" size={19} /> Use a passkey
              </Button>
            </div>
          </>
        ) : null}

        {notice ? (
          <p className="inline-notice" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="auth-boundary">
          Google identity only · Calendar access stays separate.
        </p>
        <p className="auth-invite-note">
          New members join only from a seven-day, single-use link emailed by the
          household owner.
        </p>
      </section>
    </main>
  );
}
