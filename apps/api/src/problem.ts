import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

export class ApiProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly extensions: Readonly<Record<string, unknown>>;

  constructor(input: {
    readonly status: number;
    readonly code: string;
    readonly title: string;
    readonly detail: string;
    readonly extensions?: Readonly<Record<string, unknown>>;
  }) {
    super(input.detail);
    this.name = 'ApiProblem';
    this.status = input.status;
    this.code = input.code;
    this.title = input.title;
    this.extensions = Object.freeze({ ...(input.extensions ?? {}) });
  }
}

const instancePath = (request: FastifyRequest) =>
  request.url.split('?', 1)[0] ?? '/';

const validationExtensions = (error: z.ZodError) => ({
  issues: error.issues.slice(0, 32).map((issue) => ({
    code: issue.code,
    path: issue.path.map(String).join('.'),
    message: issue.message,
  })),
});

export const validationProblem = (error: z.ZodError) =>
  new ApiProblem({
    status: 400,
    code: 'request-validation-failed',
    title: 'Invalid request',
    detail: 'The request does not match the required contract.',
    extensions: validationExtensions(error),
  });

export const serviceContractProblem = () =>
  new ApiProblem({
    status: 502,
    code: 'service-contract-invalid',
    title: 'Invalid service response',
    detail:
      'A service returned an invalid response. The operation was stopped safely.',
  });

const normalizeError = (error: unknown): ApiProblem => {
  if (error instanceof ApiProblem) return error;
  if (
    error instanceof Error &&
    (error.name === 'FinanceV2PersistenceError' ||
      error.name === 'FinanceCorporateActionPersistenceError') &&
    'code' in error
  ) {
    const code = String(error.code);
    return new ApiProblem({
      status:
        code === 'unavailable'
          ? 503
          : code === 'authorization-revoked'
            ? 403
            : code === 'invalid-input'
              ? 400
              : 409,
      code: `finance-v2-${code}`,
      title: 'Accounting request could not be completed',
      detail:
        code === 'unavailable'
          ? 'The accounting service or its required storage is not ready.'
          : code === 'authorization-revoked'
            ? 'Current book access does not permit this operation.'
            : code === 'invalid-input'
              ? 'Check the supplied accounts, references, and amounts.'
              : 'The accounting records conflict with this operation. Refresh the book and verify dates, balances, and references.',
    });
  }
  if (
    error instanceof Error &&
    error.name === 'FinanceTaxPersistenceError' &&
    'code' in error
  ) {
    const code = String(error.code);
    return new ApiProblem({
      status: code === 'forbidden' ? 403 : code === 'invalid-input' ? 400 : 409,
      code: `finance-tax-${code}`,
      title: 'Private tax request could not be completed',
      detail:
        code === 'forbidden'
          ? 'Current case access does not permit this operation.'
          : code === 'invalid-input'
            ? 'Check the supplied case references and values.'
            : 'The case or source revision changed. Refresh the case before continuing.',
    });
  }
  if (
    error instanceof Error &&
    /^finance-tax-questionnaire-(?:case-revision-conflict|answer-revision-conflict|source-authorization-changed|source-revision-unavailable|package-binding-changed|scope-binding-changed|answer-review-stale|package-scope-mismatch|fact-not-in-package|metadata-not-in-package)$/.test(
      error.message,
    )
  ) {
    return new ApiProblem({
      status: 409,
      code: 'finance-tax-questionnaire-conflict',
      title: 'Private tax case requires review',
      detail:
        'The case, source, or package binding does not match the current state. Refresh the case before continuing.',
    });
  }
  if (error instanceof z.ZodError) return validationProblem(error);
  if (
    error !== null &&
    typeof error === 'object' &&
    'name' in error &&
    error.name === 'FinanceImportPersistenceError' &&
    'code' in error
  ) {
    const financeCode = String(error.code);
    const mapped: Readonly<Record<string, readonly [number, string, string]>> =
      {
        'authorization-revoked': [
          403,
          'Finance import authorization revoked',
          'The current finance import access is no longer valid.',
        ],
        'plan-not-found': [
          404,
          'Finance import plan not found',
          'The finance import plan is not available.',
        ],
        'plan-expired': [
          410,
          'Finance import plan expired',
          'The finance import plan is no longer available.',
        ],
        'idempotency-conflict': [
          409,
          'Finance import conflict',
          'This idempotency key is already bound to another finance import.',
        ],
        'plan-conflict': [
          409,
          'Finance import conflict',
          'The finance import could not be completed safely.',
        ],
        'invalid-input': [
          400,
          'Invalid finance import',
          'The finance import request is invalid.',
        ],
      };
    const selected = mapped[financeCode];
    if (selected !== undefined) {
      return new ApiProblem({
        status: selected[0],
        code: financeCode,
        title: selected[1],
        detail: selected[2],
      });
    }
  }
  const fastifyCode =
    error !== null && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  if (fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return new ApiProblem({
      status: 413,
      code: 'request-body-too-large',
      title: 'Request body too large',
      detail: 'The request body exceeds the allowed size.',
    });
  }
  if (fastifyCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
    return new ApiProblem({
      status: 415,
      code: 'unsupported-media-type',
      title: 'Unsupported media type',
      detail: 'The request content type is not supported.',
    });
  }
  return new ApiProblem({
    status: 500,
    code: 'internal-error',
    title: 'Internal error',
    detail: 'The request could not be completed safely.',
  });
};

export const installProblemHandler = (app: FastifyInstance): void => {
  app.setNotFoundHandler((request, reply) => {
    const problem = new ApiProblem({
      status: 404,
      code: 'route-not-found',
      title: 'Route not found',
      detail: 'The requested API route does not exist.',
    });
    return reply
      .status(problem.status)
      .header('cache-control', 'no-store')
      .type('application/problem+json')
      .send({
        type: 'about:blank',
        title: problem.title,
        status: problem.status,
        detail: problem.message,
        instance: instancePath(request),
        requestId: request.id,
        code: problem.code,
        extensions: problem.extensions,
      });
  });

  app.setErrorHandler((error, request, reply) => {
    const problem = normalizeError(error);
    if (reply.sent) return;
    return reply
      .status(problem.status)
      .header('cache-control', 'no-store')
      .type('application/problem+json')
      .send({
        type: 'about:blank',
        title: problem.title,
        status: problem.status,
        detail: problem.message,
        instance: instancePath(request),
        requestId: request.id,
        code: problem.code,
        extensions: problem.extensions,
      });
  });
};
