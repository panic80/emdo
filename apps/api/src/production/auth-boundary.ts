import type { CsrfProtector } from '@emdo/auth/server';
import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { z } from 'zod';

import { browserAuthRouteFor } from '../auth-surface.js';
import type {
  AuthenticatedPrincipal,
  AuthenticationBoundary,
} from '../services/contracts.js';
import { ApiProblem } from '../problem.js';
import { canonicalizeIpAddress } from '../trusted-ingress.js';
import {
  AuthenticatedPrincipalSchema,
  CanonicalAppOriginSchema,
  IdempotencyHeaderSchema,
  InvitationRedeemRequestSchema,
  InvitationRedeemResponseSchema,
} from '../schemas.js';

const VerifiedSessionSchema = z.object({
  session: z.object({
    id: z.uuid(),
    userId: z.uuid(),
  }),
  user: z.object({
    emailVerified: z.literal(true),
    id: z.uuid(),
  }),
});

const ActiveMemberSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  role: z.enum(['owner', 'member']),
  userId: z.uuid(),
});

const ActivePrincipalScopeSchema = z.strictObject({
  householdId: z.uuid(),
  role: z.enum(['owner', 'member']),
  spaceAccessGrantId: z.uuid(),
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema,
});
const RequestIdSchema = z.uuid();
const MUTATING_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);
const MUTATION_CSRF_COOKIE = 'emdo.csrf_token';
const INVITATION_CSRF_COOKIE = 'emdo.invitation_csrf';
const CSRF_MAX_AGE_SECONDS = 600;
const InvitationRedemptionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.enum(['provisioned', 'replay']),
    result: InvitationRedeemResponseSchema,
  }),
  z.strictObject({ status: z.literal('invalid') }),
  z.strictObject({
    status: z.literal('in-progress'),
    retryAfterMs: z.number().int().min(100).max(60_000),
  }),
  z.strictObject({ status: z.literal('conflict') }),
]);

export interface InvitationRedemptionCoordinator {
  /**
   * Verifies, provisions, consumes, audits, and stores the replay result in
   * one database transaction. The API must never split those effects.
   */
  redeem(input: {
    readonly idempotencyKey: string;
    readonly request: z.output<typeof InvitationRedeemRequestSchema>;
    readonly requestId: string;
  }): Promise<unknown>;
}

export interface BetterAuthBoundaryRuntime {
  readonly api: {
    readonly getSession: (input: {
      readonly headers: Headers;
      readonly query: {
        readonly disableCookieCache: true;
        readonly disableRefresh: true;
      };
    }) => Promise<unknown>;
    readonly getActiveMember: (input: {
      readonly headers: Headers;
    }) => Promise<unknown>;
  };
  readonly handler: (request: Request) => Promise<Response>;
}

export interface ActivePrincipalScopeResolver {
  /**
   * This resolver must revalidate the active membership and issue a
   * server-owned, request-current space grant. It must not accept scope from a
   * request body, query string, model, or other client-controlled value.
   */
  resolveActivePrincipalScope(input: {
    readonly activeMembershipId: string;
    readonly householdId: string;
    readonly requestId: string;
    readonly role: 'owner' | 'member';
    readonly sessionId: string;
    readonly userId: string;
  }): Promise<unknown>;
}

export interface ProductionAuthenticationBoundaryOptions {
  readonly auth: BetterAuthBoundaryRuntime;
  readonly csrfProtector: CsrfProtector;
  readonly invitationRedemptions: InvitationRedemptionCoordinator;
  readonly publicOrigin: string;
  readonly scopeResolver: ActivePrincipalScopeResolver;
}

const createSessionHeaders = (input: { readonly cookie?: string }): Headers => {
  const headers = new Headers();
  if (input.cookie !== undefined) headers.set('cookie', input.cookie);
  return headers;
};

const createBrowserHeaders = (
  request: Request,
  publicOrigin: string,
): Headers => {
  const forwardedFor = request.headers.get('x-forwarded-for');
  const clientIp =
    forwardedFor === null ? undefined : canonicalizeIpAddress(forwardedFor);
  if (
    forwardedFor === null ||
    forwardedFor.length > 64 ||
    forwardedFor.includes(',') ||
    clientIp === undefined ||
    request.headers.has('forwarded') ||
    request.headers.has('x-real-ip')
  ) {
    throw new Error('Better Auth request boundary rejected the request');
  }
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== publicOrigin) {
    throw new Error('Better Auth request boundary rejected the request');
  }

  const headers = new Headers();
  for (const [name, maximumLength] of [
    ['accept', 1_024],
    ['content-type', 256],
    ['cookie', 16_384],
    ['origin', 512],
    ['user-agent', 1_024],
  ] as const) {
    const value = request.headers.get(name);
    if (value === null) continue;
    if (value.length > maximumLength || /[\r\n]/u.test(value)) {
      throw new Error('Better Auth request boundary rejected the request');
    }
    headers.set(name, value);
  }
  headers.set('x-forwarded-for', clientIp);
  return headers;
};

const readUniqueCookie = (
  cookieHeader: string | undefined,
  cookieName: string,
): string | undefined => {
  if (cookieHeader === undefined || /[\r\n]/u.test(cookieHeader)) {
    return undefined;
  }
  let found: string | undefined;
  for (const rawPart of cookieHeader.split(';')) {
    const part = rawPart.trim();
    const equalsIndex = part.indexOf('=');
    if (equalsIndex <= 0 || part.slice(0, equalsIndex).trim() !== cookieName) {
      continue;
    }
    const value = part.slice(equalsIndex + 1).trim();
    if (value.length === 0 || found !== undefined) return undefined;
    found = value;
  }
  return found;
};

const csrfCookie = (name: string, token: string, path: string): string =>
  `${name}=${token}; Path=${path}; Max-Age=${CSRF_MAX_AGE_SECONDS}; Secure; HttpOnly; SameSite=Strict`;

export const createProductionAuthenticationBoundary = (
  options: ProductionAuthenticationBoundaryOptions,
): AuthenticationBoundary => {
  if (
    options.auth === undefined ||
    options.auth.api === undefined ||
    typeof options.auth.api.getSession !== 'function' ||
    typeof options.auth.api.getActiveMember !== 'function' ||
    typeof options.auth.handler !== 'function'
  ) {
    throw new Error('A complete Better Auth server runtime is required');
  }
  if (
    options.scopeResolver === undefined ||
    typeof options.scopeResolver.resolveActivePrincipalScope !== 'function'
  ) {
    throw new Error('An active principal scope resolver is required');
  }
  const resolveActivePrincipalScope =
    options.scopeResolver.resolveActivePrincipalScope.bind(
      options.scopeResolver,
    );
  const getSession = options.auth.api.getSession.bind(options.auth.api);
  const getActiveMember = options.auth.api.getActiveMember.bind(
    options.auth.api,
  );
  const handleBetterAuthRequest = options.auth.handler.bind(options.auth);
  const publicOrigin = CanonicalAppOriginSchema.parse(options.publicOrigin);
  if (
    options.csrfProtector === undefined ||
    typeof options.csrfProtector.issue !== 'function' ||
    typeof options.csrfProtector.verify !== 'function'
  ) {
    throw new Error('A CSRF protector is required');
  }
  if (
    options.invitationRedemptions === undefined ||
    typeof options.invitationRedemptions.redeem !== 'function'
  ) {
    throw new Error('A durable invitation redemption coordinator is required');
  }
  const issueCsrf = options.csrfProtector.issue.bind(options.csrfProtector);
  const verifyCsrf = options.csrfProtector.verify.bind(options.csrfProtector);
  const redeemInvitationAtomically = options.invitationRedemptions.redeem.bind(
    options.invitationRedemptions,
  );
  const invitationCsrfSubject = `emdo-invitation-v1:${publicOrigin}`;

  return {
    async authenticate(input) {
      if (!RequestIdSchema.safeParse(input.requestId).success) return undefined;
      const credentialHeaders = createSessionHeaders(input);
      const session = VerifiedSessionSchema.safeParse(
        await getSession({
          headers: new Headers(credentialHeaders),
          query: { disableCookieCache: true, disableRefresh: true },
        }),
      );
      if (
        !session.success ||
        session.data.session.userId !== session.data.user.id
      ) {
        return undefined;
      }
      const activeMember = ActiveMemberSchema.safeParse(
        await getActiveMember({ headers: new Headers(credentialHeaders) }),
      );
      if (
        !activeMember.success ||
        activeMember.data.userId !== session.data.user.id
      ) {
        return undefined;
      }
      const scope = ActivePrincipalScopeSchema.safeParse(
        await resolveActivePrincipalScope({
          activeMembershipId: activeMember.data.id,
          householdId: activeMember.data.organizationId,
          requestId: input.requestId,
          role: activeMember.data.role,
          sessionId: session.data.session.id,
          userId: session.data.user.id,
        }),
      );
      if (
        !scope.success ||
        scope.data.householdId !== activeMember.data.organizationId ||
        scope.data.role !== activeMember.data.role
      ) {
        return undefined;
      }
      return Object.freeze<AuthenticatedPrincipal>({
        collectionAuthorizationScopeFingerprint:
          scope.data.collectionAuthorizationScopeFingerprint,
        emailVerified: true,
        householdId: scope.data.householdId,
        role: scope.data.role,
        sessionId: session.data.session.id,
        spaceAccessGrantId: scope.data.spaceAccessGrantId,
        userId: session.data.user.id,
      });
    },
    async verifyMutation(input) {
      const principal = AuthenticatedPrincipalSchema.safeParse(input.principal);
      if (
        !principal.success ||
        !RequestIdSchema.safeParse(input.requestId).success ||
        !MUTATING_METHODS.has(input.method) ||
        !input.path.startsWith('/api/') ||
        input.path.includes('\\') ||
        input.path.includes('?') ||
        input.path.includes('#') ||
        input.origin !== publicOrigin ||
        input.csrfToken === undefined
      ) {
        return false;
      }
      const cookieToken = readUniqueCookie(input.cookie, MUTATION_CSRF_COOKIE);
      if (cookieToken === undefined) return false;
      return verifyCsrf({
        sessionId: principal.data.sessionId,
        origin: input.origin,
        cookieToken,
        headerToken: input.csrfToken,
      });
    },
    async handleBrowserRequest(input) {
      if (
        !(input.request instanceof Request) ||
        !RequestIdSchema.safeParse(input.requestId).success
      ) {
        throw new Error('Better Auth request boundary rejected the request');
      }
      const url = new URL(input.request.url);
      if (
        url.origin !== publicOrigin ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.hash.length > 0 ||
        browserAuthRouteFor(input.request.method, url.pathname) === undefined ||
        url.pathname.includes('\\') ||
        /%5c/iu.test(url.pathname)
      ) {
        throw new Error('Better Auth request boundary rejected the request');
      }
      const request = new Request(input.request, {
        headers: createBrowserHeaders(input.request, publicOrigin),
      });
      const response = await handleBetterAuthRequest(request);
      if (!(response instanceof Response)) {
        throw new Error(
          'Better Auth request boundary returned an invalid response',
        );
      }
      return response;
    },
    async issueMutationCsrf(input) {
      const principal = AuthenticatedPrincipalSchema.parse(input.principal);
      RequestIdSchema.parse(input.requestId);
      const token = issueCsrf(principal.sessionId);
      return Object.freeze({
        token,
        cookie: csrfCookie(MUTATION_CSRF_COOKIE, token, '/api/'),
      });
    },
    async issueInvitationCsrf(input) {
      RequestIdSchema.parse(input.requestId);
      const token = issueCsrf(invitationCsrfSubject);
      return Object.freeze({
        token,
        cookie: csrfCookie(
          INVITATION_CSRF_COOKIE,
          token,
          '/api/v1/auth/invitations/',
        ),
      });
    },
    async redeemInvitation(input) {
      const requestId = RequestIdSchema.safeParse(input.requestId);
      const idempotencyKey = IdempotencyHeaderSchema.safeParse(
        input.idempotencyKey,
      );
      const invitationRequest = InvitationRedeemRequestSchema.safeParse(
        input.request,
      );
      const cookieToken = readUniqueCookie(
        input.cookie,
        INVITATION_CSRF_COOKIE,
      );
      const csrfValid =
        requestId.success &&
        idempotencyKey.success &&
        invitationRequest.success &&
        input.principal === undefined &&
        input.origin === publicOrigin &&
        input.invitationCsrfToken !== undefined &&
        cookieToken !== undefined &&
        verifyCsrf({
          sessionId: invitationCsrfSubject,
          origin: input.origin,
          cookieToken,
          headerToken: input.invitationCsrfToken,
        });
      if (!csrfValid) {
        throw new ApiProblem({
          status: 403,
          code: 'invitation-csrf-invalid',
          title: 'Invitation request verification failed',
          detail: 'This invitation request could not be verified.',
        });
      }
      let rawRedemption: unknown;
      try {
        rawRedemption = await redeemInvitationAtomically({
          idempotencyKey: idempotencyKey.data,
          request: invitationRequest.data,
          requestId: requestId.data,
        });
      } catch {
        throw new ApiProblem({
          status: 503,
          code: 'invitation-onboarding-unavailable',
          title: 'Invitation onboarding unavailable',
          detail: 'Invitation onboarding is temporarily unavailable.',
        });
      }
      const redemption =
        InvitationRedemptionResultSchema.safeParse(rawRedemption);
      if (!redemption.success) {
        throw new ApiProblem({
          status: 503,
          code: 'invitation-onboarding-unavailable',
          title: 'Invitation onboarding unavailable',
          detail: 'Invitation onboarding is temporarily unavailable.',
        });
      }
      if (
        redemption.data.status === 'provisioned' ||
        redemption.data.status === 'replay'
      ) {
        return Object.freeze(redemption.data.result);
      }
      if (redemption.data.status === 'invalid') {
        throw new ApiProblem({
          status: 400,
          code: 'invitation-invalid',
          title: 'Invitation invalid',
          detail: 'Invitation onboarding could not be completed.',
        });
      }
      if (redemption.data.status === 'conflict') {
        throw new ApiProblem({
          status: 409,
          code: 'invitation-idempotency-conflict',
          title: 'Invitation request conflict',
          detail: 'This idempotency key is already bound to another request.',
        });
      }
      if (redemption.data.status !== 'in-progress') {
        throw new ApiProblem({
          status: 503,
          code: 'invitation-onboarding-unavailable',
          title: 'Invitation onboarding unavailable',
          detail: 'Invitation onboarding is temporarily unavailable.',
        });
      }
      throw new ApiProblem({
        status: 409,
        code: 'invitation-onboarding-in-progress',
        title: 'Invitation onboarding in progress',
        detail: 'An identical invitation request is already in progress.',
        extensions: { retryAfterMs: redemption.data.retryAfterMs },
      });
    },
  };
};
