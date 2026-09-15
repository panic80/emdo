import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FinanceFecMappingCreateSchema,
  FinanceFecExportRequestSchema,
  UuidSchema,
  workspaceContextFromLegacyPrincipal,
  type FinanceFecMappingCreate,
  type FinanceFecExportRequest,
  type WorkspaceContext,
} from '@emdo/contracts';
import { FRANCE_FEC_COLUMNS, FRANCE_FEC_STANDARD } from '@emdo/domains/finance';
import { ApiProblem, serviceContractProblem } from '../problem.js';
import {
  parseRequest,
  parseServiceResponse,
  prepareAuthenticatedMutation,
  requirePrincipal,
  takePreparedMutation,
} from '../request-context.js';
import type { ApiServices } from '../services/contracts.js';

export interface FinanceFecRouteService {
  checkReady(): Promise<boolean>;
  getSavedExport(
    context: WorkspaceContext,
    bookId: string,
    idempotencyKey: string,
  ): Promise<unknown>;
  create(
    context: WorkspaceContext,
    bookId: string,
    input: FinanceFecMappingCreate,
  ): Promise<unknown>;
  getLatest(context: WorkspaceContext, bookId: string): Promise<unknown>;
  export(
    context: WorkspaceContext,
    bookId: string,
    input: FinanceFecExportRequest,
  ): Promise<unknown>;
}
const Params = z.strictObject({ bookId: UuidSchema });
const Revision = z.number().int().positive().max(2_147_483_647);
export const FinanceFecMappingResponseSchema = z.strictObject({
  workspaceId: UuidSchema,
  bookId: UuidSchema,
  revision: Revision,
  reviewedBy: UuidSchema,
  reviewedAt: z.iso.datetime(),
  mapping: FinanceFecMappingCreateSchema,
});
const Lineage = z.strictObject({
  sourceReference: z.string().min(1),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  entryId: z.string().min(1),
  entryNumber: z.string().min(1),
  lineId: z.string().min(1),
  pieceReference: z.string().min(1),
});
const Review = z.strictObject({
  status: z.enum(['ready', 'blocked']),
  errors: z.array(
    z.strictObject({ code: z.string(), path: z.string(), message: z.string() }),
  ),
  entryCount: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
  sourceLineage: z.array(Lineage),
  fileName: z.string().nullable(),
  standard: z.strictObject({
    article: z.literal(FRANCE_FEC_STANDARD.article),
    format: z.literal(FRANCE_FEC_STANDARD.format),
    separator: z.literal(FRANCE_FEC_STANDARD.separator),
    separatorName: z.literal(FRANCE_FEC_STANDARD.separatorName),
    encoding: z.literal(FRANCE_FEC_STANDARD.encoding),
    lineEnding: z.literal(FRANCE_FEC_STANDARD.lineEnding),
    lineEndingName: z.literal(FRANCE_FEC_STANDARD.lineEndingName),
    headerRequired: z.literal(true),
    currency: z.literal('EUR'),
  }),
});
const Export = z
  .discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('blocked'),
      review: Review,
      file: z.null(),
    }),
    z.strictObject({
      status: z.literal('ready'),
      review: Review,
      file: z.strictObject({
        fileName: z.string().min(1),
        content: z.string(),
        byteLength: z.number().int().nonnegative(),
        columns: z.array(z.enum(FRANCE_FEC_COLUMNS)),
        encoding: z.literal('UTF-8'),
        separator: z.literal('\t'),
        lineEnding: z.literal('\r\n'),
      }),
      sourceLineage: z.array(Lineage),
    }),
  ])
  .superRefine((value, context) => {
    if (
      value.review.status !== value.status ||
      (value.status === 'ready' &&
        (value.review.errors.length > 0 ||
          JSON.stringify(value.sourceLineage) !==
            JSON.stringify(value.review.sourceLineage) ||
          value.file.fileName !== value.review.fileName ||
          value.file.byteLength !== Buffer.byteLength(value.file.content) ||
          JSON.stringify(value.file.columns) !==
            JSON.stringify(FRANCE_FEC_COLUMNS)))
    )
      context.addIssue({
        code: 'custom',
        message: 'Inconsistent FEC export response',
      });
  });
const call = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      cause.name !== 'FinanceFranceFecPersistenceError'
    )
      throw cause;
    const code = 'code' in cause ? String(cause.code) : 'unavailable';
    throw new ApiProblem({
      status:
        code === 'authorization-revoked'
          ? 403
          : code === 'invalid-input'
            ? 400
            : code === 'conflict'
              ? 409
              : 503,
      code: `finance-fec-${code}`,
      title: 'FEC request could not be completed',
      detail:
        'Check book access, reviewed mappings, and posted ledger readiness.',
    });
  }
};
const ready = async (services: ApiServices) => {
  const service = services.financeFec;
  if (!service || !(await service.checkReady().catch(() => false)))
    throw new ApiProblem({
      status: 503,
      code: 'finance-fec-unavailable',
      title: 'FEC unavailable',
      detail: 'The FEC service is not enabled or ready.',
    });
  return service;
};
export function registerFinanceFecRoutes(
  app: FastifyInstance,
  services: ApiServices,
  bodyLimit: number,
) {
  const base = '/api/v2/finance/books/:bookId/fec';
  app.get(`${base}/exports/:idempotencyKey`, async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const { bookId, idempotencyKey } = parseRequest(
      z.strictObject({
        bookId: UuidSchema,
        idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
      }),
      request.params,
    );
    const scope = workspaceContextFromLegacyPrincipal(principal, request.id);
    const raw = await call(async () =>
      (await ready(services)).getSavedExport(scope, bookId, idempotencyKey),
    );
    if (raw === null)
      throw new ApiProblem({
        status: 404,
        code: 'finance-fec-export-not-found',
        title: 'Saved FEC export not found',
        detail: 'No saved export is available for this book and key.',
      });
    const result = parseServiceResponse(Export, raw);
    if (result.status !== 'ready') throw serviceContractProblem();
    return reply.header('cache-control', 'no-store, private').send(result);
  });
  app.get(`${base}/mappings/latest`, async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const { bookId } = parseRequest(Params, request.params);
    const scope = workspaceContextFromLegacyPrincipal(principal, request.id);
    const raw = await call(async () =>
      (await ready(services)).getLatest(scope, bookId),
    );
    if (raw === null)
      return reply.header('cache-control', 'no-store, private').send(null);
    const result = parseServiceResponse(FinanceFecMappingResponseSchema, raw);
    if (
      result.workspaceId !== scope.workspaceId ||
      result.bookId !== bookId ||
      result.revision !== result.mapping.expectedRevision
    )
      throw serviceContractProblem();
    return reply.header('cache-control', 'no-store, private').send(result);
  });
  app.post(
    `${base}/mappings`,
    {
      bodyLimit,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal } = takePreparedMutation(request);
      const { bookId } = parseRequest(Params, request.params);
      const input = parseRequest(FinanceFecMappingCreateSchema, request.body);
      const scope = workspaceContextFromLegacyPrincipal(principal, request.id);
      const result = parseServiceResponse(
        z.strictObject({ revision: Revision }),
        await call(async () =>
          (await ready(services)).create(scope, bookId, input),
        ),
      );
      if (result.revision !== input.expectedRevision + 1)
        throw serviceContractProblem();
      return reply.header('cache-control', 'no-store, private').send(result);
    },
  );
  app.post(
    `${base}/exports`,
    {
      bodyLimit,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      const { bookId } = parseRequest(Params, request.params);
      const input = parseRequest(FinanceFecExportRequestSchema, request.body);
      if (input.idempotencyKey !== idempotencyKey)
        throw new ApiProblem({
          status: 400,
          code: 'finance-fec-idempotency-mismatch',
          title: 'Idempotency key mismatch',
          detail: 'The payload and header idempotency keys must match.',
        });
      const scope = workspaceContextFromLegacyPrincipal(principal, request.id);
      const result = parseServiceResponse(
        Export,
        await call(async () =>
          (await ready(services)).export(scope, bookId, input),
        ),
      );
      return reply.header('cache-control', 'no-store, private').send(result);
    },
  );
}
