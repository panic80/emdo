import { passkeyClient } from '@better-auth/passkey/client';
import { createAuthClient } from 'better-auth/react';

import { AuthClientError, type PasskeyCeremonies } from './auth-client.js';

interface BetterAuthFailure {
  readonly code?: string;
  readonly message?: string;
  readonly status?: number;
}

const CANCELLATION_CODES = new Set([
  'AUTH_CANCELLED',
  'REGISTRATION_CANCELLED',
]);

function safePasskeyFailure(error: BetterAuthFailure | null): AuthClientError {
  if (error?.code && CANCELLATION_CODES.has(error.code)) {
    return new AuthClientError(
      'passkey-cancelled',
      'Passkey use was cancelled.',
      error.status,
    );
  }
  return new AuthClientError(
    'passkey-failed',
    'EMDO could not use that passkey. Try again or use email and password.',
    error?.status,
  );
}

export function createBetterAuthPasskeyCeremonies(): PasskeyCeremonies {
  const client = createAuthClient({
    baseURL: window.location.origin,
    plugins: [passkeyClient()],
  });

  return {
    async signIn({ idempotencyKey }) {
      const result = await client.signIn.passkey({
        fetchOptions: { headers: { 'idempotency-key': idempotencyKey } },
      });
      if (result.error) {
        const failure = safePasskeyFailure(result.error);
        if (failure.code === 'passkey-cancelled')
          return { status: 'cancelled' };
        throw failure;
      }
      return { status: 'authenticated' };
    },
    async register({ idempotencyKey, csrfToken, ...options }) {
      const result = await client.passkey.addPasskey({
        ...options,
        fetchOptions: {
          headers: {
            'idempotency-key': idempotencyKey,
            'x-csrf-token': csrfToken,
          },
        },
      });
      if (result.error) throw safePasskeyFailure(result.error);
      return { status: 'registered' };
    },
  };
}
