import { z } from 'zod';

import { createBetterAuthPasskeyCeremonies } from './better-auth-passkeys.js';

const AuthSessionSchema = z
  .object({
    session: z
      .object({
        id: z.string().min(1),
        expiresAt: z.string().datetime({ offset: true }),
      })
      .strip(),
    user: z
      .object({
        id: z.string().min(1),
        email: z.string().email(),
        emailVerified: z.boolean(),
        name: z.string().nullable().optional(),
      })
      .strip(),
  })
  .strip();

const EmailSignInSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(512),
  rememberMe: z.boolean(),
});

const SocialRedirectSchema = z
  .object({ redirect: z.literal(true), url: z.string().url() })
  .strip();

export const InvitationRedemptionSchema = z.object({
  schemaVersion: z.literal(1),
  displayName: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email(),
  invitationId: z.string().uuid(),
  invitationToken: z.string().min(20).max(512),
  password: z.string().min(12).max(128),
});

const InvitationResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    userId: z.string().uuid(),
    householdId: z.string().uuid(),
    role: z.enum(['owner', 'member']),
    emailVerified: z.literal(true),
  })
  .strip();

const CsrfResponseSchema = z.object({
  schemaVersion: z.literal(1),
  token: z.string().min(24).max(512),
});

export type AuthSession = z.output<typeof AuthSessionSchema>;
export type InvitationRedemption = z.input<typeof InvitationRedemptionSchema>;

export type AuthClientErrorCode =
  | 'session-unavailable'
  | 'session-network-unavailable'
  | 'sign-in-failed'
  | 'social-sign-in-failed'
  | 'passkey-cancelled'
  | 'passkey-failed'
  | 'invitation-invalid'
  | 'onboarding-unavailable'
  | 'sign-out-failed'
  | 'invalid-response';

export class AuthClientError extends Error {
  public constructor(
    public readonly code: AuthClientErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AuthClientError';
  }
}

export interface PasskeyCeremonies {
  readonly signIn: (options: {
    readonly idempotencyKey: string;
  }) => Promise<{ readonly status: 'authenticated' | 'cancelled' }>;
  readonly register: (options: {
    readonly name: string;
    readonly authenticatorAttachment: 'platform';
    readonly idempotencyKey: string;
    readonly csrfToken: string;
  }) => Promise<{ readonly status: 'registered' }>;
}

export interface EmdoAuthClient {
  readonly getSession: () => Promise<AuthSession | null>;
  /** Returns a short-lived mutation proof held in memory only. */
  readonly getMutationCsrf: () => Promise<string>;
  readonly signInEmail: (request: {
    readonly email: string;
    readonly password: string;
    readonly rememberMe: boolean;
  }) => Promise<void>;
  readonly signInGoogle: (callbackURL: string) => Promise<void>;
  readonly signInPasskey: () => Promise<'authenticated' | 'cancelled'>;
  readonly registerPasskey: (name: string, csrfToken: string) => Promise<void>;
  readonly redeemInvitation: (request: InvitationRedemption) => Promise<{
    readonly status: 'provisioned';
    readonly email: string;
    readonly role: 'owner' | 'member';
  }>;
  readonly signOut: (signal?: AbortSignal) => Promise<void>;
}

interface AuthClientDependencies {
  readonly fetcher?: typeof fetch;
  readonly navigate?: (url: string) => void;
  readonly passkeys?: PasskeyCeremonies;
}

function newIdempotencyKey(kind: string): string {
  return `web.${kind}.${crypto.randomUUID()}`;
}

async function parseJson(response: Response): Promise<unknown> {
  if (
    !response.headers
      .get('content-type')
      ?.toLowerCase()
      .includes('application/json')
  ) {
    throw new AuthClientError(
      'invalid-response',
      'EMDO returned an invalid authentication response.',
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new AuthClientError(
      'invalid-response',
      'EMDO returned an invalid authentication response.',
    );
  }
}

function exactRelativeCallback(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//')) {
    throw new AuthClientError(
      'social-sign-in-failed',
      'EMDO rejected an unsafe return location.',
    );
  }
  const parsed = new URL(value, window.location.origin);
  if (parsed.origin !== window.location.origin) {
    throw new AuthClientError(
      'social-sign-in-failed',
      'EMDO rejected an unsafe return location.',
    );
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function createEmdoAuthClient(
  dependencies: AuthClientDependencies = {},
): EmdoAuthClient {
  const fetcher = dependencies.fetcher ?? fetch;
  const navigate =
    dependencies.navigate ?? ((url: string) => window.location.assign(url));
  let passkeys = dependencies.passkeys;
  const getPasskeys = () => (passkeys ??= createBetterAuthPasskeyCeremonies());
  const issueCsrf = async (
    path: '/api/v1/auth/csrf' | '/api/v1/auth/invitations/csrf',
  ) => {
    const response = await fetcher(path, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new AuthClientError(
        'session-unavailable',
        'EMDO could not establish a protected browser request.',
        response.status,
      );
    }
    const parsed = CsrfResponseSchema.safeParse(await parseJson(response));
    if (!parsed.success) {
      throw new AuthClientError(
        'invalid-response',
        'EMDO returned an invalid authentication response.',
      );
    }
    return parsed.data.token;
  };

  return {
    async getSession() {
      let response: Response;
      try {
        response = await fetcher('/api/auth/get-session', {
          method: 'GET',
          cache: 'no-store',
          credentials: 'include',
          headers: { accept: 'application/json' },
        });
      } catch {
        throw new AuthClientError(
          'session-network-unavailable',
          'EMDO could not reach the secure session endpoint.',
        );
      }
      if (!response.ok) {
        throw new AuthClientError(
          'session-unavailable',
          'EMDO could not verify your secure session.',
          response.status,
        );
      }
      const payload = await parseJson(response);
      if (payload === null) return null;
      const parsed = AuthSessionSchema.safeParse(payload);
      if (!parsed.success) {
        throw new AuthClientError(
          'invalid-response',
          'EMDO returned an invalid authentication response.',
        );
      }
      return parsed.data;
    },

    async getMutationCsrf() {
      return issueCsrf('/api/v1/auth/csrf');
    },

    async signInEmail(request) {
      const parsed = EmailSignInSchema.safeParse(request);
      if (!parsed.success) {
        throw new AuthClientError(
          'sign-in-failed',
          'Enter a valid email address and password.',
        );
      }
      const response = await fetcher('/api/auth/sign-in/email', {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': newIdempotencyKey('email-sign-in'),
        },
        body: JSON.stringify(parsed.data),
      });
      if (!response.ok) {
        throw new AuthClientError(
          'sign-in-failed',
          'We could not sign you in. Check your details or verify your email, then try again.',
          response.status,
        );
      }
      // Better Auth may include a raw token in this response. The browser client
      // deliberately leaves the body unread and relies only on the HttpOnly cookie.
    },

    async signInGoogle(callbackURL) {
      const response = await fetcher('/api/auth/sign-in/social', {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': newIdempotencyKey('google-sign-in'),
        },
        body: JSON.stringify({
          provider: 'google',
          callbackURL: exactRelativeCallback(callbackURL),
        }),
      });
      if (!response.ok) {
        throw new AuthClientError(
          'social-sign-in-failed',
          'Google sign-in could not start. Try again or use email and password.',
          response.status,
        );
      }
      const parsed = SocialRedirectSchema.safeParse(await parseJson(response));
      if (!parsed.success) {
        throw new AuthClientError(
          'invalid-response',
          'EMDO returned an invalid authentication response.',
        );
      }
      const redirect = new URL(parsed.data.url);
      if (redirect.protocol !== 'https:') {
        throw new AuthClientError(
          'social-sign-in-failed',
          'EMDO rejected an unsafe sign-in redirect.',
        );
      }
      navigate(redirect.toString());
    },

    async signInPasskey() {
      const result = await getPasskeys().signIn({
        idempotencyKey: newIdempotencyKey('passkey-sign-in'),
      });
      return result.status;
    },

    async registerPasskey(name, csrfToken) {
      const safeName = z.string().trim().min(1).max(80).parse(name);
      await getPasskeys().register({
        name: safeName,
        authenticatorAttachment: 'platform',
        idempotencyKey: newIdempotencyKey('passkey-register'),
        csrfToken,
      });
    },

    async redeemInvitation(request) {
      const parsed = InvitationRedemptionSchema.safeParse(request);
      if (!parsed.success) {
        throw new AuthClientError(
          'invitation-invalid',
          'This invitation is invalid, expired, or already used. Ask the household owner for a new invitation.',
        );
      }
      const invitationCsrfToken = await issueCsrf(
        '/api/v1/auth/invitations/csrf',
      );
      const response = await fetcher('/api/v1/auth/invitations/redeem', {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': newIdempotencyKey('invite-redeem'),
          'x-csrf-token': invitationCsrfToken,
        },
        body: JSON.stringify(parsed.data),
      });
      if (!response.ok) {
        const unavailable = response.status === 503;
        throw new AuthClientError(
          unavailable ? 'onboarding-unavailable' : 'invitation-invalid',
          unavailable
            ? 'Invite onboarding is temporarily unavailable. Try again later.'
            : 'This invitation is invalid, expired, or already used. Ask the household owner for a new invitation.',
          response.status,
        );
      }
      const result = InvitationResponseSchema.safeParse(
        await parseJson(response),
      );
      if (!result.success) {
        throw new AuthClientError(
          'invalid-response',
          'EMDO returned an invalid onboarding response.',
        );
      }
      return {
        status: 'provisioned',
        email: parsed.data.email,
        role: result.data.role,
      };
    },

    async signOut(signal) {
      const csrfToken = await issueCsrf('/api/v1/auth/csrf');
      const response = await fetcher('/api/auth/sign-out', {
        method: 'POST',
        credentials: 'include',
        signal,
        headers: {
          accept: 'application/json',
          'idempotency-key': newIdempotencyKey('sign-out'),
          'x-csrf-token': csrfToken,
        },
      });
      if (!response.ok) {
        throw new AuthClientError(
          'sign-out-failed',
          'EMDO could not revoke the server session. Local data was not purged.',
          response.status,
        );
      }
    },
  };
}
