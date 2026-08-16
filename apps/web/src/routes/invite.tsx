import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '../components/button.js';
import { AuthClientError } from '../features/auth/auth-client.js';
import { useAuth } from '../features/auth/auth-context.js';

const InviteFormSchema = z
  .object({
    displayName: z.string().trim().min(1, 'Enter your display name.').max(100),
    password: z.string().min(12, 'Use at least 12 characters.').max(128),
    confirmPassword: z.string(),
  })
  .refine(({ password, confirmPassword }) => password === confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match.',
  });

type InviteFormValues = z.input<typeof InviteFormSchema>;

export function InviteRoute() {
  const auth = useAuth();
  const search = useSearch({ from: '/invite' });
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string>();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<InviteFormValues>({
    resolver: zodResolver(InviteFormSchema),
    defaultValues: { displayName: '', password: '', confirmPassword: '' },
  });
  const validLink = Boolean(
    search.invitationId && search.token && search.email,
  );

  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="invite-heading">
        <Link className="auth-wordmark" to="/sign-in" aria-label="EMDO sign in">
          EMDO
        </Link>
        <header>
          <p className="auth-eyebrow">Invitation onboarding</p>
          <h1 id="invite-heading">Join your household</h1>
          <p>
            Your private space stays private; shared household spaces are
            explicit.
          </p>
        </header>

        {!validLink ? (
          <div className="auth-alert" role="alert">
            This invitation link is invalid or incomplete. Ask the household
            owner for a new invitation.
          </div>
        ) : complete ? (
          <div className="auth-complete" role="status">
            <strong>Your invited account is ready. Sign in to continue.</strong>
            <p>Onboarding does not sign you in automatically.</p>
            <Link className="button button--primary" to="/sign-in">
              Continue to sign in
            </Link>
          </div>
        ) : (
          <>
            <div className="auth-invite-email">
              <span>Invited email</span>
              <strong>{search.email}</strong>
            </div>
            <form
              className="auth-form"
              noValidate
              onSubmit={handleSubmit(async ({ displayName, password }) => {
                setError(undefined);
                try {
                  await auth.client.redeemInvitation({
                    schemaVersion: 1,
                    displayName,
                    email: search.email ?? '',
                    invitationId: search.invitationId ?? '',
                    invitationToken: search.token ?? '',
                    password,
                  });
                  setComplete(true);
                } catch (caught) {
                  setError(
                    caught instanceof AuthClientError
                      ? caught.message
                      : 'EMDO could not redeem this invitation. Try again.',
                  );
                }
              })}
            >
              <label htmlFor="invite-name">Display name</label>
              <input
                {...register('displayName')}
                autoComplete="name"
                id="invite-name"
              />
              {errors.displayName ? (
                <p className="field-error" role="alert">
                  {errors.displayName.message}
                </p>
              ) : null}

              <label htmlFor="invite-password">Create password</label>
              <input
                {...register('password')}
                autoComplete="new-password"
                id="invite-password"
                type="password"
              />
              {errors.password ? (
                <p className="field-error" role="alert">
                  {errors.password.message}
                </p>
              ) : null}

              <label htmlFor="invite-password-confirmation">
                Confirm password
              </label>
              <input
                {...register('confirmPassword')}
                autoComplete="new-password"
                id="invite-password-confirmation"
                type="password"
              />
              {errors.confirmPassword ? (
                <p className="field-error" role="alert">
                  {errors.confirmPassword.message}
                </p>
              ) : null}

              <Button busy={isSubmitting} type="submit">
                Create invited account
              </Button>
            </form>
            {error ? (
              <p className="inline-error" role="alert">
                {error}
              </p>
            ) : null}
          </>
        )}
        <p className="auth-boundary">
          No public sign-up or household creation is available.
        </p>
      </section>
    </main>
  );
}
