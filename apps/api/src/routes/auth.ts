import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  browserAuthRouteFor,
  GOOGLE_IDENTITY_CALLBACK_QUERY_NAMES,
  type BrowserAuthRoute,
} from '../auth-surface.js';
import { ApiProblem, serviceContractProblem } from '../problem.js';
import {
  parseRequest,
  parseServiceResponse,
  readHeader,
  requireIdempotencyKey,
  requireMutationProof,
  requirePrincipal,
} from '../request-context.js';
import {
  AuthCsrfIssueResultSchema,
  AuthCsrfResponseSchema,
  EmailSignInRequestSchema,
  InvitationRedeemRequestSchema,
  InvitationRedeemResponseSchema,
  PasskeyAuthenticationRequestSchema,
  PasskeyRegistrationQuerySchema,
  PasskeyRegistrationRequestSchema,
  SocialSignInRequestSchema,
} from '../schemas.js';
import type { ApiServices } from '../services/contracts.js';
import { resolveTrustedClientIp } from '../trusted-ingress.js';

const AuthUserViewSchema = z
  .object({
    id: z.string().min(1).max(200),
    email: z.string().email().max(320),
    emailVerified: z.boolean(),
    name: z.string().max(200).nullable().optional(),
  })
  .strip();

const AuthSessionViewSchema = z
  .object({
    id: z.string().min(1).max(200),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strip();

const BrowserSessionSourceSchema = z
  .object({
    session: AuthSessionViewSchema,
    user: AuthUserViewSchema,
  })
  .strip();

const EmailSignInSourceSchema = z.object({ user: AuthUserViewSchema }).strip();

const SocialSignInSourceSchema = z
  .object({
    redirect: z.literal(true),
    url: z.string().url().max(4_096),
  })
  .strip();

const PasskeyVerificationSourceSchema = BrowserSessionSourceSchema;
const PasskeyRegistrationSourceSchema = z
  .object({ id: z.string().min(1).max(200) })
  .strip();
const SignOutSourceSchema = z.object({ success: z.literal(true) }).strip();

const WebAuthnTransportSchema = z.enum([
  'ble',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
]);
const WebAuthnCredentialDescriptorSchema = z
  .object({
    id: z.string().min(1).max(8_192),
    type: z.literal('public-key'),
    transports: z.array(WebAuthnTransportSchema).max(8).optional(),
  })
  .strip();
const UserVerificationSchema = z.enum(['discouraged', 'preferred', 'required']);
const PasskeyAuthenticationOptionsSchema = z
  .object({
    challenge: z.string().min(1).max(8_192),
    timeout: z.number().int().positive().max(600_000).optional(),
    rpId: z.string().min(1).max(253).optional(),
    allowCredentials: z
      .array(WebAuthnCredentialDescriptorSchema)
      .max(128)
      .optional(),
    userVerification: UserVerificationSchema.optional(),
  })
  .strip();
const PasskeyRegistrationOptionsSchema = z
  .object({
    challenge: z.string().min(1).max(8_192),
    rp: z
      .object({
        id: z.string().min(1).max(253).optional(),
        name: z.string().min(1).max(200),
      })
      .strip(),
    user: z
      .object({
        id: z.string().min(1).max(8_192),
        name: z.string().min(1).max(320),
        displayName: z.string().min(1).max(200),
      })
      .strip(),
    pubKeyCredParams: z
      .array(
        z
          .object({
            type: z.literal('public-key'),
            alg: z.number().int(),
          })
          .strip(),
      )
      .min(1)
      .max(32),
    timeout: z.number().int().positive().max(600_000).optional(),
    excludeCredentials: z
      .array(WebAuthnCredentialDescriptorSchema)
      .max(128)
      .optional(),
    authenticatorSelection: z
      .object({
        authenticatorAttachment: z
          .enum(['cross-platform', 'platform'])
          .optional(),
        residentKey: z
          .enum(['discouraged', 'preferred', 'required'])
          .optional(),
        requireResidentKey: z.boolean().optional(),
        userVerification: UserVerificationSchema.optional(),
      })
      .strip()
      .optional(),
    attestation: z
      .enum(['direct', 'enterprise', 'indirect', 'none'])
      .optional(),
    hints: z.array(z.string().min(1).max(64)).max(8).optional(),
  })
  .strip();

const AUTH_RESPONSE_BYTE_CEILING = 262_144;
const MAXIMUM_AUTH_COOKIES = 16;
const MAXIMUM_AUTH_COOKIE_BYTES = 8_192;
const BETTER_AUTH_COOKIE_NAME =
  /^__Secure-emdo\.(?:account_data|better-auth-passkey|dont_remember|oauth_state|session_data|session_token|state)(?:\.\d{1,2})?$/u;

const containsControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });

const requestPath = (request: FastifyRequest) =>
  request.url.split('?', 1)[0] ?? '/';

const requireBrowserAuthRoute = (request: FastifyRequest): BrowserAuthRoute => {
  const route = browserAuthRouteFor(request.method, requestPath(request));
  if (route === undefined) throw authRouteUnavailable();
  return route;
};

const authRouteUnavailable = () =>
  new ApiProblem({
    status: 404,
    code: 'auth-route-unavailable',
    title: 'Authentication route unavailable',
    detail: 'This authentication operation is not available.',
  });

const invitationProblem = (error: unknown): ApiProblem | undefined => {
  if (error === null || typeof error !== 'object') return undefined;
  const code = (error as { readonly code?: unknown }).code;
  if (code === 'invitation-invalid') {
    return new ApiProblem({
      status: 400,
      code,
      title: 'Invitation invalid',
      detail: 'Invitation onboarding could not be completed.',
    });
  }
  if (code === 'onboarding-unavailable') {
    return new ApiProblem({
      status: 503,
      code,
      title: 'Onboarding unavailable',
      detail: 'Invitation onboarding is temporarily unavailable.',
    });
  }
  return undefined;
};

const requireExactBrowserOrigin = (
  request: FastifyRequest,
  publicOrigin: string,
): void => {
  const origin = readHeader(request, 'origin', 512);
  if (origin !== publicOrigin) {
    throw new ApiProblem({
      status: 403,
      code: 'browser-origin-invalid',
      title: 'Browser origin invalid',
      detail: 'This browser request did not originate from the EMDO app.',
    });
  }
};

const hasAuthRequestBodySignal = (request: FastifyRequest): boolean =>
  request.body !== undefined ||
  request.headers['content-length'] !== undefined ||
  request.headers['content-type'] !== undefined ||
  request.headers['transfer-encoding'] !== undefined;

const rejectAuthRequestBody = (): never => {
  throw new ApiProblem({
    status: 400,
    code: 'auth-request-body-invalid',
    title: 'Authentication request invalid',
    detail: 'This authentication route does not accept a request body.',
  });
};

const guardBrowserAuthBeforeBody = async (
  request: FastifyRequest,
  services: ApiServices,
  publicOrigin: string,
  edgeProxySecret?: string,
  allowLoopbackApiIngress?: boolean,
): Promise<void> => {
  const route = requireBrowserAuthRoute(request);
  if (
    (route.method === 'GET' || route.responseKind === 'sign-out') &&
    hasAuthRequestBodySignal(request)
  ) {
    rejectAuthRequestBody();
  }
  resolveTrustedClientIp(request, edgeProxySecret, allowLoopbackApiIngress);
  if (route.requiresBrowserOrigin) {
    requireExactBrowserOrigin(request, publicOrigin);
    requireIdempotencyKey(request);
  }
  if (!route.requiresPrincipal) return;
  const principal = await requirePrincipal(request, services);
  if (route.requiresMutationProof) {
    await requireMutationProof(request, services, principal);
  }
};

const hasForbiddenSocialIdentityInput = (body: unknown): boolean => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }
  return Object.keys(body).some((key) =>
    [
      'additionalData',
      'additionalScopes',
      'disableRedirect',
      'errorCallbackURL',
      'idToken',
      'newUserCallbackURL',
      'scope',
      'scopes',
    ].includes(key),
  );
};

const toWebHeaders = (
  request: FastifyRequest,
  edgeProxySecret?: string,
  allowLoopbackApiIngress?: boolean,
): Headers => {
  const headers = new Headers();
  for (const name of [
    'accept',
    'content-type',
    'cookie',
    'origin',
    'user-agent',
  ]) {
    const value = request.headers[name];
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  }
  headers.set(
    'x-forwarded-for',
    resolveTrustedClientIp(request, edgeProxySecret, allowLoopbackApiIngress),
  );
  return headers;
};

const safeRelativeCallback = (value: string, publicOrigin: string): string => {
  if (
    value.includes('\\') ||
    !value.startsWith('/') ||
    value.startsWith('//')
  ) {
    throw new ApiProblem({
      status: 400,
      code: 'identity-callback-invalid',
      title: 'Identity callback invalid',
      detail: 'The identity callback location is not allowed.',
    });
  }
  const parsed = new URL(value, publicOrigin);
  if (parsed.origin !== publicOrigin) {
    throw new ApiProblem({
      status: 400,
      code: 'identity-callback-invalid',
      title: 'Identity callback invalid',
      detail: 'The identity callback location is not allowed.',
    });
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
};

const assertNoQuery = (url: URL): void => {
  if ([...url.searchParams].length > 0) {
    throw new ApiProblem({
      status: 400,
      code: 'auth-query-invalid',
      title: 'Authentication query invalid',
      detail: 'This authentication route does not accept query parameters.',
    });
  }
};

const safeCallbackUrl = (requestUrl: URL): URL => {
  const allowed = new Set<string>(GOOGLE_IDENTITY_CALLBACK_QUERY_NAMES);
  const seen = new Set<string>();
  const entries = [...requestUrl.searchParams.entries()];
  if (entries.length === 0 || entries.length > 12) {
    throw new ApiProblem({
      status: 400,
      code: 'identity-callback-query-invalid',
      title: 'Identity callback invalid',
      detail: 'The identity callback query is invalid.',
    });
  }
  for (const [key, value] of entries) {
    if (
      !allowed.has(key) ||
      seen.has(key) ||
      key.length > 64 ||
      value.length > 8_192 ||
      (['code', 'error', 'state'].includes(key) && value.length === 0)
    ) {
      throw new ApiProblem({
        status: 400,
        code: 'identity-callback-query-invalid',
        title: 'Identity callback invalid',
        detail: 'The identity callback query is invalid.',
      });
    }
    seen.add(key);
  }
  const hasCode = seen.has('code');
  const hasError = seen.has('error');
  if (
    !seen.has('state') ||
    hasCode === hasError ||
    (hasCode && (seen.has('error_description') || seen.has('error_uri')))
  ) {
    throw new ApiProblem({
      status: 400,
      code: 'identity-callback-query-invalid',
      title: 'Identity callback invalid',
      detail: 'The identity callback query is invalid.',
    });
  }
  return requestUrl;
};

const browserAuthRequestUrl = (
  request: FastifyRequest,
  route: BrowserAuthRoute,
  publicOrigin: string,
): URL => {
  const url = new URL(request.url, publicOrigin);
  if (route.responseKind === 'callback') return safeCallbackUrl(url);
  if (route.responseKind !== 'passkey-registration-options') {
    assertNoQuery(url);
    return url;
  }

  const pairs = [...url.searchParams.entries()];
  if (new Set(pairs.map(([key]) => key)).size !== pairs.length) {
    throw new ApiProblem({
      status: 400,
      code: 'auth-query-invalid',
      title: 'Authentication query invalid',
      detail: 'The passkey registration query is invalid.',
    });
  }
  const query = parseRequest(
    PasskeyRegistrationQuerySchema,
    Object.fromEntries(pairs),
  );
  url.search = '';
  if (query.authenticatorAttachment !== undefined) {
    url.searchParams.set(
      'authenticatorAttachment',
      query.authenticatorAttachment,
    );
  }
  if (query.name !== undefined) url.searchParams.set('name', query.name);
  return url;
};

const browserAuthRequestBody = (
  request: FastifyRequest,
  route: BrowserAuthRoute,
  publicOrigin: string,
): BodyInit | undefined => {
  if (route.method === 'GET' && hasAuthRequestBodySignal(request)) {
    rejectAuthRequestBody();
  }
  let body: unknown;
  switch (route.responseKind) {
    case 'email-sign-in':
      body = parseRequest(EmailSignInRequestSchema, request.body);
      break;
    case 'social-sign-in': {
      if (hasForbiddenSocialIdentityInput(request.body)) {
        throw new ApiProblem({
          status: 400,
          code: 'identity-scope-input-forbidden',
          title: 'Identity scope input forbidden',
          detail: 'Google identity scopes are fixed by server configuration.',
        });
      }
      const parsed = parseRequest(SocialSignInRequestSchema, request.body);
      body = {
        provider: parsed.provider,
        ...(parsed.callbackURL === undefined
          ? {}
          : {
              callbackURL: safeRelativeCallback(
                parsed.callbackURL,
                publicOrigin,
              ),
            }),
      };
      break;
    }
    case 'passkey-authentication-result':
      body = parseRequest(PasskeyAuthenticationRequestSchema, request.body);
      break;
    case 'passkey-registration-result':
      body = parseRequest(PasskeyRegistrationRequestSchema, request.body);
      break;
    case 'sign-out':
      if (hasAuthRequestBodySignal(request)) rejectAuthRequestBody();
      return undefined;
    default:
      return undefined;
  }
  return JSON.stringify(body);
};

const readBoundedAuthResponse = async (
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> => {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      throw serviceContractProblem();
    }
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        value.fill(0);
        await reader.cancel().catch(() => undefined);
        throw serviceContractProblem();
      }
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
      chunk.fill(0);
    }
    return result;
  } finally {
    reader.releaseLock();
    for (const chunk of chunks) chunk.fill(0);
  }
};

const parseBoundedAuthJson = async (
  response: Response,
  maximumBytes: number,
): Promise<unknown> => {
  if (
    !response.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  ) {
    throw serviceContractProblem();
  }
  const bytes = await readBoundedAuthResponse(response, maximumBytes);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof ApiProblem) throw error;
    throw serviceContractProblem();
  } finally {
    bytes.fill(0);
  }
};

const validateAuthCookie = (cookie: string): void => {
  if (containsControlCharacter(cookie)) throw serviceContractProblem();
  const segments = cookie.split(';').map((segment) => segment.trim());
  const pair = segments.shift();
  const pairSeparator = pair?.indexOf('=') ?? -1;
  if (pair === undefined || pairSeparator <= 0) throw serviceContractProblem();
  const name = pair.slice(0, pairSeparator);
  if (!BETTER_AUTH_COOKIE_NAME.test(name)) throw serviceContractProblem();

  const attributes = new Map<string, string | undefined>();
  for (const segment of segments) {
    if (segment.length === 0) throw serviceContractProblem();
    const separator = segment.indexOf('=');
    const attributeName = (
      separator < 0 ? segment : segment.slice(0, separator)
    ).toLowerCase();
    const attributeValue =
      separator < 0 ? undefined : segment.slice(separator + 1);
    if (attributes.has(attributeName)) throw serviceContractProblem();
    attributes.set(attributeName, attributeValue);
  }

  if (
    attributes.get('path') !== '/' ||
    attributes.get('secure') !== undefined ||
    !attributes.has('secure') ||
    attributes.get('httponly') !== undefined ||
    !attributes.has('httponly')
  ) {
    throw serviceContractProblem();
  }
  const sameSite = attributes.get('samesite')?.toLowerCase();
  if (sameSite !== 'lax' && sameSite !== 'strict') {
    throw serviceContractProblem();
  }
  if (attributes.has('domain')) throw serviceContractProblem();

  for (const [attributeName, attributeValue] of attributes) {
    if (
      ![
        'expires',
        'httponly',
        'max-age',
        'path',
        'samesite',
        'secure',
      ].includes(attributeName)
    ) {
      throw serviceContractProblem();
    }
    if (attributeName === 'max-age') {
      if (
        attributeValue === undefined ||
        !/^\d{1,8}$/u.test(attributeValue) ||
        Number(attributeValue) > 31_536_000
      ) {
        throw serviceContractProblem();
      }
    }
    if (
      attributeName === 'expires' &&
      (attributeValue === undefined ||
        attributeValue.length > 64 ||
        !Number.isFinite(Date.parse(attributeValue)))
    ) {
      throw serviceContractProblem();
    }
  }
};

const applyAuthCookies = (response: Response, reply: FastifyReply): void => {
  const cookies = response.headers.getSetCookie();
  if (
    cookies.length > MAXIMUM_AUTH_COOKIES ||
    cookies.some(
      (cookie) =>
        cookie.length === 0 || cookie.length > MAXIMUM_AUTH_COOKIE_BYTES,
    )
  ) {
    throw serviceContractProblem();
  }
  for (const cookie of cookies) validateAuthCookie(cookie);
  if (cookies.length > 0) reply.header('set-cookie', cookies);
};

const safeSameOriginLocation = (
  value: string | null,
  publicOrigin: string,
): string => {
  if (value === null || value.includes('\\')) throw serviceContractProblem();
  let location: URL;
  try {
    location = new URL(value, publicOrigin);
  } catch {
    throw serviceContractProblem();
  }
  if (
    location.origin !== publicOrigin ||
    location.username !== '' ||
    location.password !== ''
  ) {
    throw serviceContractProblem();
  }
  return location.toString();
};

const safeGoogleIdentityAuthorizationUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw serviceContractProblem();
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'accounts.google.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw serviceContractProblem();
  }
  return url.toString();
};

const browserAuthenticationFailure = (responseStatus: number): ApiProblem =>
  new ApiProblem({
    status:
      responseStatus >= 400 && responseStatus < 500 ? responseStatus : 503,
    code: 'authentication-failed',
    title: 'Authentication failed',
    detail: 'The authentication operation could not be completed.',
  });

const discardBoundedAuthResponse = async (
  response: Response,
  maximumBytes: number,
): Promise<void> => {
  const discarded = await readBoundedAuthResponse(response, maximumBytes);
  discarded.fill(0);
};

const sanitizeBrowserAuthResponse = async (
  route: BrowserAuthRoute,
  response: Response,
  reply: FastifyReply,
  maximumBytes: number,
  publicOrigin: string,
) => {
  if (route.responseKind === 'callback') {
    if (response.status !== 302 && response.status !== 303) {
      await discardBoundedAuthResponse(response, maximumBytes);
      throw response.status >= 400
        ? browserAuthenticationFailure(response.status)
        : serviceContractProblem();
    }
    const location = safeSameOriginLocation(
      response.headers.get('location'),
      publicOrigin,
    );
    await discardBoundedAuthResponse(response, maximumBytes);
    applyAuthCookies(response, reply);
    return reply
      .status(response.status)
      .header('location', location)
      .header('cache-control', 'no-store')
      .send();
  }

  if (!response.ok) {
    await discardBoundedAuthResponse(response, maximumBytes);
    throw browserAuthenticationFailure(response.status);
  }
  if (response.status !== 200) {
    await discardBoundedAuthResponse(response, maximumBytes);
    throw serviceContractProblem();
  }
  const source = await parseBoundedAuthJson(response, maximumBytes);
  let output: unknown;
  switch (route.responseKind) {
    case 'session':
      output =
        source === null
          ? null
          : parseServiceResponse(BrowserSessionSourceSchema, source);
      break;
    case 'email-sign-in':
      parseServiceResponse(EmailSignInSourceSchema, source);
      output = { status: 'authenticated' };
      break;
    case 'social-sign-in': {
      const parsed = parseServiceResponse(SocialSignInSourceSchema, source);
      output = {
        redirect: true,
        url: safeGoogleIdentityAuthorizationUrl(parsed.url),
      };
      break;
    }
    case 'passkey-authentication-options':
      output = parseServiceResponse(PasskeyAuthenticationOptionsSchema, source);
      break;
    case 'passkey-authentication-result':
      parseServiceResponse(PasskeyVerificationSourceSchema, source);
      output = { status: 'authenticated' };
      break;
    case 'passkey-registration-options':
      output = parseServiceResponse(PasskeyRegistrationOptionsSchema, source);
      break;
    case 'passkey-registration-result':
      parseServiceResponse(PasskeyRegistrationSourceSchema, source);
      output = { status: 'registered' };
      break;
    case 'sign-out':
      parseServiceResponse(SignOutSourceSchema, source);
      output = { success: true };
      break;
    default:
      throw serviceContractProblem();
  }
  applyAuthCookies(response, reply);
  return reply
    .status(200)
    .header('cache-control', 'no-store')
    .type('application/json')
    .send(output);
};

export const registerAuthRoutes = (
  app: FastifyInstance,
  services: ApiServices,
  maximumJsonBodyBytes: number,
  publicOrigin: string,
  edgeProxySecret?: string,
  allowLoopbackApiIngress?: boolean,
): void => {
  app.all(
    '/api/auth/*',
    {
      bodyLimit: maximumJsonBodyBytes,
      onRequest: async (request) =>
        guardBrowserAuthBeforeBody(
          request,
          services,
          publicOrigin,
          edgeProxySecret,
          allowLoopbackApiIngress,
        ),
    },
    async (request, reply) => {
      const route = requireBrowserAuthRoute(request);
      const url = browserAuthRequestUrl(request, route, publicOrigin);
      const body = browserAuthRequestBody(request, route, publicOrigin);

      let response: Response;
      try {
        response = await services.auth.handleBrowserRequest({
          request: new Request(url, {
            method: request.method,
            headers: toWebHeaders(
              request,
              edgeProxySecret,
              allowLoopbackApiIngress,
            ),
            body,
          }),
          requestId: request.id,
        });
      } catch {
        throw new ApiProblem({
          status: 503,
          code: 'authentication-unavailable',
          title: 'Authentication unavailable',
          detail: 'Authentication could not be completed. Try again shortly.',
        });
      }
      if (!(response instanceof Response)) throw serviceContractProblem();
      return sanitizeBrowserAuthResponse(
        route,
        response,
        reply,
        Math.min(maximumJsonBodyBytes, AUTH_RESPONSE_BYTE_CEILING),
        publicOrigin,
      );
    },
  );

  app.get('/api/v1/auth/csrf', async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const result = parseServiceResponse(
      AuthCsrfIssueResultSchema,
      await services.auth.issueMutationCsrf({
        principal,
        requestId: request.id,
      }),
    );
    return reply
      .header('set-cookie', result.cookie)
      .header('cache-control', 'no-store')
      .send(
        AuthCsrfResponseSchema.parse({ schemaVersion: 1, token: result.token }),
      );
  });

  app.get('/api/v1/auth/invitations/csrf', async (request, reply) => {
    const result = parseServiceResponse(
      AuthCsrfIssueResultSchema,
      await services.auth.issueInvitationCsrf({ requestId: request.id }),
    );
    return reply
      .header('set-cookie', result.cookie)
      .header('cache-control', 'no-store')
      .send(
        AuthCsrfResponseSchema.parse({ schemaVersion: 1, token: result.token }),
      );
  });

  app.post(
    '/api/v1/auth/invitations/redeem',
    {
      bodyLimit: maximumJsonBodyBytes,
      onRequest: async (request) => {
        requireExactBrowserOrigin(request, publicOrigin);
        requireIdempotencyKey(request);
      },
    },
    async (request, reply) => {
      const idempotencyKey = requireIdempotencyKey(request);
      const input = parseRequest(InvitationRedeemRequestSchema, request.body);
      let rawResult: unknown;
      try {
        rawResult = await services.auth.redeemInvitation({
          request: input,
          origin: readHeader(request, 'origin', 512),
          cookie: readHeader(request, 'cookie', 16_384),
          invitationCsrfToken: readHeader(request, 'x-csrf-token', 512),
          idempotencyKey,
          requestId: request.id,
          principal: undefined,
        });
      } catch (error) {
        throw (
          invitationProblem(error) ??
          new ApiProblem({
            status: 503,
            code: 'onboarding-unavailable',
            title: 'Onboarding unavailable',
            detail: 'Invitation onboarding is temporarily unavailable.',
          })
        );
      }
      const result = parseServiceResponse(
        InvitationRedeemResponseSchema,
        rawResult,
      );
      return reply.status(201).header('cache-control', 'no-store').send(result);
    },
  );
};
