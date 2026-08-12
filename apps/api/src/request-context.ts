import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import {
  ApiProblem,
  serviceContractProblem,
  validationProblem,
} from './problem.js';
import {
  AuthenticatedPrincipalSchema,
  IdempotencyHeaderSchema,
} from './schemas.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from './services/contracts.js';

interface PreparedMutationContext {
  readonly principal: AuthenticatedPrincipal;
  readonly idempotencyKey: string;
}

const preparedMutationContexts = new WeakMap<
  FastifyRequest,
  PreparedMutationContext
>();

const optionalHeader = (
  request: FastifyRequest,
  name: string,
  maximumLength: number,
): string | undefined => {
  const value = request.headers[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maximumLength) {
    throw new ApiProblem({
      status: 400,
      code: 'request-header-invalid',
      title: 'Invalid request header',
      detail: `The ${name} header is invalid.`,
    });
  }
  return value;
};

export const requirePrincipal = async (
  request: FastifyRequest,
  services: ApiServices,
): Promise<AuthenticatedPrincipal> => {
  let candidate: AuthenticatedPrincipal | undefined;
  try {
    candidate = await services.auth.authenticate({
      requestId: request.id,
      method: request.method,
      path: request.url.split('?', 1)[0] ?? '/',
      cookie: optionalHeader(request, 'cookie', 16_384),
    });
  } catch {
    throw new ApiProblem({
      status: 503,
      code: 'authentication-unavailable',
      title: 'Authentication unavailable',
      detail: 'Authentication could not be verified. Try again shortly.',
    });
  }
  if (candidate === undefined) {
    throw new ApiProblem({
      status: 401,
      code: 'authentication-required',
      title: 'Authentication required',
      detail: 'A current authenticated session is required.',
    });
  }
  const parsed = AuthenticatedPrincipalSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ApiProblem({
      status: 401,
      code: 'authentication-invalid',
      title: 'Authentication invalid',
      detail: 'The authenticated session is not valid for this request.',
    });
  }
  return Object.freeze(parsed.data);
};

export const requireMutationProof = async (
  request: FastifyRequest,
  services: ApiServices,
  principal: AuthenticatedPrincipal,
): Promise<void> => {
  let valid = false;
  try {
    valid = await services.auth.verifyMutation({
      principal,
      requestId: request.id,
      method: request.method,
      path: request.url.split('?', 1)[0] ?? '/',
      origin: optionalHeader(request, 'origin', 512),
      cookie: optionalHeader(request, 'cookie', 16_384),
      csrfToken: optionalHeader(request, 'x-csrf-token', 512),
    });
  } catch {
    throw new ApiProblem({
      status: 503,
      code: 'mutation-verification-unavailable',
      title: 'Request verification unavailable',
      detail: 'The request could not be verified. Try again shortly.',
    });
  }
  if (!valid) {
    throw new ApiProblem({
      status: 403,
      code: 'mutation-proof-invalid',
      title: 'Request verification failed',
      detail:
        'This state-changing request requires current browser verification.',
    });
  }
};

export const requireIdempotencyKey = (request: FastifyRequest): string => {
  const raw = optionalHeader(request, 'idempotency-key', 256);
  if (raw === undefined) {
    throw new ApiProblem({
      status: 400,
      code: 'idempotency-key-required',
      title: 'Idempotency key required',
      detail: 'A valid Idempotency-Key header is required.',
    });
  }
  const parsed = IdempotencyHeaderSchema.safeParse(raw);
  if (!parsed.success) throw validationProblem(parsed.error);
  return parsed.data;
};

/** Runs in Fastify's onRequest phase, before any request body is parsed. */
export const prepareAuthenticatedMutation = async (
  request: FastifyRequest,
  services: ApiServices,
): Promise<void> => {
  const principal = await requirePrincipal(request, services);
  await requireMutationProof(request, services, principal);
  const idempotencyKey = requireIdempotencyKey(request);
  preparedMutationContexts.set(
    request,
    Object.freeze({ principal, idempotencyKey }),
  );
};

export const takePreparedMutation = (
  request: FastifyRequest,
): PreparedMutationContext => {
  const context = preparedMutationContexts.get(request);
  preparedMutationContexts.delete(request);
  if (context === undefined) {
    throw new ApiProblem({
      status: 500,
      code: 'mutation-context-missing',
      title: 'Request verification missing',
      detail: 'The request could not be completed safely.',
    });
  }
  return context;
};

export const requireVisualProofToken = (request: FastifyRequest): string => {
  const token = optionalHeader(request, 'x-emdo-visual-confirmation', 512);
  if (token === undefined || !/^[A-Za-z0-9_-]{32,512}$/u.test(token)) {
    throw new ApiProblem({
      status: 403,
      code: 'visual-approval-required',
      title: 'Visual approval required',
      detail: 'Use the authenticated approval screen to decide this proposal.',
    });
  }
  return token;
};

export const parseRequest = <Output>(
  schema: z.ZodType<Output>,
  input: unknown,
): Output => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw validationProblem(parsed.error);
  return parsed.data;
};

export const parseServiceResponse = <Output>(
  schema: z.ZodType<Output>,
  input: unknown,
): Output => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw serviceContractProblem();
  return parsed.data;
};

export const readHeader = optionalHeader;
