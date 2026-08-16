export type BrowserAuthResponseKind =
  | 'callback'
  | 'email-sign-in'
  | 'passkey-authentication-options'
  | 'passkey-authentication-result'
  | 'passkey-registration-options'
  | 'passkey-registration-result'
  | 'session'
  | 'sign-out'
  | 'social-sign-in';

export interface BrowserAuthRoute {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly responseKind: BrowserAuthResponseKind;
  readonly requiresBrowserOrigin: boolean;
  readonly requiresPrincipal: boolean;
  readonly requiresMutationProof: boolean;
}

export const GOOGLE_IDENTITY_CALLBACK_QUERY_NAMES = Object.freeze([
  'authuser',
  'code',
  'error',
  'error_description',
  'error_uri',
  'hd',
  'iss',
  'prompt',
  'scope',
  'session_state',
  'state',
] as const);

const route = (
  method: BrowserAuthRoute['method'],
  path: string,
  responseKind: BrowserAuthResponseKind,
  options: {
    readonly requiresBrowserOrigin?: boolean;
    readonly requiresPrincipal?: boolean;
    readonly requiresMutationProof?: boolean;
  } = {},
): BrowserAuthRoute =>
  Object.freeze({
    method,
    path,
    responseKind,
    requiresBrowserOrigin: options.requiresBrowserOrigin ?? false,
    requiresPrincipal: options.requiresPrincipal ?? false,
    requiresMutationProof: options.requiresMutationProof ?? false,
  });

export const BROWSER_AUTH_ROUTES: readonly BrowserAuthRoute[] = Object.freeze([
  route('GET', '/api/auth/get-session', 'session'),
  route('POST', '/api/auth/sign-in/email', 'email-sign-in', {
    requiresBrowserOrigin: true,
  }),
  route('POST', '/api/auth/sign-in/social', 'social-sign-in', {
    requiresBrowserOrigin: true,
  }),
  route(
    'GET',
    '/api/auth/passkey/generate-authenticate-options',
    'passkey-authentication-options',
  ),
  route(
    'POST',
    '/api/auth/passkey/verify-authentication',
    'passkey-authentication-result',
    { requiresBrowserOrigin: true },
  ),
  route(
    'GET',
    '/api/auth/passkey/generate-register-options',
    'passkey-registration-options',
    { requiresPrincipal: true },
  ),
  route(
    'POST',
    '/api/auth/passkey/verify-registration',
    'passkey-registration-result',
    {
      requiresBrowserOrigin: true,
      requiresPrincipal: true,
      requiresMutationProof: true,
    },
  ),
  route('POST', '/api/auth/sign-out', 'sign-out', {
    requiresBrowserOrigin: true,
    requiresPrincipal: true,
    requiresMutationProof: true,
  }),
  route('GET', '/api/auth/callback/google', 'callback'),
]);

const routesByKey: ReadonlyMap<string, BrowserAuthRoute> = new Map(
  BROWSER_AUTH_ROUTES.map((entry) => [`${entry.method} ${entry.path}`, entry]),
);

export const browserAuthRouteFor = (
  method: string,
  path: string,
): BrowserAuthRoute | undefined =>
  routesByKey.get(`${method.toUpperCase()} ${path}`);
