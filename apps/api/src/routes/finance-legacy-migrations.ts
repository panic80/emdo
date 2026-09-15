import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FinanceLegacyMigrationBackfillInputSchema,
  FinanceLegacyMigrationBackfillResultSchema,
  FinanceLegacyMigrationCompareInputSchema,
  FinanceLegacyMigrationComparisonSchema,
  FinanceLegacyMigrationCutoverInputSchema,
  FinanceLegacyMigrationCutoverSchema,
  FinanceLegacyMigrationInspectInputSchema,
  FinanceLegacyMigrationInspectionSchema,
  FinanceLegacyMigrationMappingSchema,
  FinanceLegacyMigrationPlanSchema,
  FinanceLegacyMigrationRecordSchema,
  FinanceLegacyMigrationReviewInputSchema,
  FinanceLegacyMigrationReviewSchema,
  FinanceLegacyMigrationRunSchema,
  UuidSchema,
  workspaceContextFromLegacyPrincipal,
  type FinanceLegacyMigrationMapping,
  type WorkspaceContext,
} from '@emdo/contracts';
import { ApiProblem, serviceContractProblem } from '../problem.js';
import {
  parseRequest,
  parseServiceResponse,
  prepareAuthenticatedMutation,
  requirePrincipal,
  takePreparedMutation,
} from '../request-context.js';
import type { ApiServices } from '../services/contracts.js';

/** Directly implemented by PostgresFinanceLegacyMigrationRepository. */
export interface FinanceLegacyMigrationRouteService {
  checkReady(): Promise<boolean>;
  listSources(context: WorkspaceContext, bookId: string): Promise<unknown>;
  list(context: WorkspaceContext, bookId: string): Promise<unknown>;
  get(context: WorkspaceContext, migrationId: string): Promise<unknown>;
  inspect(context: WorkspaceContext, input: unknown): Promise<unknown>;
  review(context: WorkspaceContext, input: unknown): Promise<unknown>;
  backfill(context: WorkspaceContext, input: unknown): Promise<unknown>;
  compare(context: WorkspaceContext, input: unknown): Promise<unknown>;
  approveCutover(context: WorkspaceContext, input: unknown): Promise<unknown>;
}
export type FinanceLegacyMigrationRouteServices = ApiServices & {
  readonly financeLegacyMigration?: FinanceLegacyMigrationRouteService;
};
const Params = z.strictObject({
  bookId: UuidSchema,
  migrationId: UuidSchema.optional(),
});
const EmptyQuery = z.strictObject({});
const RunList = z.array(FinanceLegacyMigrationRunSchema).max(1_000);
const ReviewResult = z.strictObject({
  run: FinanceLegacyMigrationRunSchema,
  plan: FinanceLegacyMigrationPlanSchema,
  records: z.array(FinanceLegacyMigrationRecordSchema).max(100_000),
  review: FinanceLegacyMigrationReviewSchema,
});
const badInput = () =>
  new ApiProblem({
    status: 400,
    code: 'finance-legacy-migration-invalid-input',
    title: 'Migration request is invalid',
    detail:
      'The route, current owner scope, and idempotency header must match the reviewed request.',
  });

const call = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      cause.name !== 'FinanceLegacyMigrationPersistenceError'
    )
      throw cause;
    const code = 'code' in cause ? String(cause.code) : 'unavailable';
    throw new ApiProblem({
      status:
        code === 'forbidden'
          ? 403
          : code === 'invalid-input'
            ? 400
            : ['conflict', 'blocked'].includes(code)
              ? 409
              : 503,
      code: `finance-legacy-migration-${code}`,
      title: 'Finance migration could not be completed',
      detail:
        code === 'forbidden'
          ? 'Current private source and book access are required.'
          : ['conflict', 'blocked'].includes(code)
            ? 'Refresh the migration and resolve its outstanding review or changed source before continuing.'
            : code === 'invalid-input'
              ? 'Check the reviewed migration inputs.'
              : 'The migration service is unavailable.',
    });
  }
};
const requireReady = async (services: FinanceLegacyMigrationRouteServices) => {
  const service = services.financeLegacyMigration;
  if (!service || !(await service.checkReady().catch(() => false)))
    throw new ApiProblem({
      status: 503,
      code: 'finance-legacy-migration-unavailable',
      title: 'Finance migration unavailable',
      detail: 'The migration service is not enabled or ready.',
    });
  return service;
};
const mappingMatches = (
  mapping: FinanceLegacyMigrationMapping,
  context: WorkspaceContext,
  bookId: string,
) =>
  mapping.source.householdId === context.workspaceId &&
  mapping.source.originalOwnerUserId === context.userId &&
  mapping.target.workspaceId === context.workspaceId &&
  mapping.target.bookId === bookId &&
  mapping.target.ownerUserId === context.userId;
const scopedInspection = (
  raw: unknown,
  context: WorkspaceContext,
  bookId: string,
  migrationId?: string,
) => {
  const result = parseServiceResponse(
    FinanceLegacyMigrationInspectionSchema,
    raw,
  );
  if (
    !mappingMatches(result.run.mapping, context, bookId) ||
    !mappingMatches(result.plan.mapping, context, bookId) ||
    (migrationId !== undefined && result.run.id !== migrationId) ||
    result.records.some(
      (record) =>
        record.migrationId !== result.run.id ||
        record.workspaceId !== context.workspaceId ||
        record.bookId !== bookId ||
        record.source.householdId !== context.workspaceId ||
        record.source.originalOwnerUserId !== context.userId ||
        record.source.privateSpaceId !==
          result.run.mapping.source.privateSpaceId,
    )
  )
    throw serviceContractProblem();
  return result;
};

export function registerFinanceLegacyMigrationRoutes(
  app: FastifyInstance,
  services: FinanceLegacyMigrationRouteServices,
  bodyLimit: number,
) {
  const base = '/api/v2/finance/books/:bookId/legacy-migrations';
  app.get(`${base}/sources`, async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const { bookId } = parseRequest(Params, request.params);
    parseRequest(EmptyQuery, request.query);
    const context = workspaceContextFromLegacyPrincipal(principal, request.id);
    const service = await requireReady(services);
    const sources = parseServiceResponse(
      z
        .array(
          z.strictObject({
            name: z.string(),
            source: z.strictObject({
              householdId: UuidSchema,
              privateSpaceId: UuidSchema,
              originalOwnerUserId: UuidSchema,
            }),
          }),
        )
        .max(1000),
      await call(() => service.listSources(context, bookId)),
    );
    if (
      sources.some(
        ({ source }) =>
          source.householdId !== context.workspaceId ||
          source.originalOwnerUserId !== context.userId,
      )
    )
      throw serviceContractProblem();
    return reply.header('cache-control', 'no-store, private').send({ sources });
  });
  app.get(base, async (request, reply) => {
    reply.header('cache-control', 'no-store, private');
    const principal = await requirePrincipal(request, services);
    const { bookId } = parseRequest(Params, request.params);
    parseRequest(EmptyQuery, request.query);
    const context = workspaceContextFromLegacyPrincipal(principal, request.id);
    const service = await requireReady(services);
    // Overflow rejects the response explicitly; this list never silently clips runs.
    const runs = parseServiceResponse(
      RunList,
      await call(() => service.list(context, bookId)),
    );
    if (runs.some((run) => !mappingMatches(run.mapping, context, bookId)))
      throw serviceContractProblem();
    return reply.send({ runs });
  });
  app.get(`${base}/:migrationId`, async (request, reply) => {
    reply.header('cache-control', 'no-store, private');
    const principal = await requirePrincipal(request, services);
    const { bookId, migrationId } = parseRequest(Params, request.params);
    parseRequest(EmptyQuery, request.query);
    const context = workspaceContextFromLegacyPrincipal(principal, request.id);
    const service = await requireReady(services);
    return reply.send(
      scopedInspection(
        await call(() => service.get(context, migrationId!)),
        context,
        bookId,
        migrationId,
      ),
    );
  });
  for (const operation of [
    'inspect',
    'review',
    'backfill',
    'compare',
    'approve-cutover',
  ] as const) {
    app.post(
      operation === 'inspect'
        ? `${base}/inspect`
        : `${base}/:migrationId/${operation}`,
      {
        bodyLimit,
        onRequest: (request, reply) => {
          reply.header('cache-control', 'no-store, private');
          return prepareAuthenticatedMutation(request, services);
        },
      },
      async (request, reply) => {
        const { principal, idempotencyKey } = takePreparedMutation(request);
        const { bookId, migrationId } = parseRequest(Params, request.params);
        parseRequest(EmptyQuery, request.query);
        const context = workspaceContextFromLegacyPrincipal(
          principal,
          request.id,
        );
        const service = await requireReady(services);
        if (operation === 'inspect') {
          const input = parseRequest(
            FinanceLegacyMigrationInspectInputSchema,
            request.body,
          );
          if (
            input.idempotencyKey !== idempotencyKey ||
            !mappingMatches(input.mapping, context, bookId)
          )
            throw badInput();
          return reply.send(
            scopedInspection(
              await call(() => service.inspect(context, input)),
              context,
              bookId,
            ),
          );
        }
        const input =
          operation === 'review'
            ? parseRequest(
                FinanceLegacyMigrationReviewInputSchema,
                request.body,
              )
            : operation === 'backfill'
              ? parseRequest(
                  FinanceLegacyMigrationBackfillInputSchema,
                  request.body,
                )
              : operation === 'compare'
                ? parseRequest(
                    FinanceLegacyMigrationCompareInputSchema,
                    request.body,
                  )
                : parseRequest(
                    FinanceLegacyMigrationCutoverInputSchema,
                    request.body,
                  );
        if (
          input.migrationId !== migrationId ||
          ('idempotencyKey' in input && input.idempotencyKey !== idempotencyKey)
        )
          throw badInput();
        // Repository methods address a migration ID, so bind it to this requested book
        // before any mutation; the repository rechecks current grants transactionally.
        const before = scopedInspection(
          await call(() => service.get(context, migrationId!)),
          context,
          bookId,
          migrationId,
        );
        if (operation === 'review') {
          const result = parseServiceResponse(
            ReviewResult,
            await call(() => service.review(context, input)),
          );
          const { review, ...inspection } = result;
          scopedInspection(inspection, context, bookId, migrationId);
          if (
            review.migrationId !== migrationId ||
            review.reviewedBy !== context.userId ||
            !('recordId' in input) ||
            review.recordId !== input.recordId
          )
            throw serviceContractProblem();
          return reply.send(result);
        }
        if (operation === 'backfill') {
          const result = parseServiceResponse(
            FinanceLegacyMigrationBackfillResultSchema,
            await call(() => service.backfill(context, input)),
          );
          if (result.migrationId !== migrationId)
            throw serviceContractProblem();
          return reply.send(result);
        }
        if (operation === 'compare') {
          const result = parseServiceResponse(
            FinanceLegacyMigrationComparisonSchema,
            await call(() => service.compare(context, input)),
          );
          if (
            result.migrationId !== migrationId ||
            result.createdBy !== context.userId
          )
            throw serviceContractProblem();
          return reply.send(result);
        }
        const result = parseServiceResponse(
          FinanceLegacyMigrationCutoverSchema,
          await call(() => service.approveCutover(context, input)),
        );
        const mapping = parseServiceResponse(
          FinanceLegacyMigrationMappingSchema,
          {
            ...before.run.mapping,
            source: result.source,
            target: result.target,
          },
        );
        if (
          result.migrationId !== migrationId ||
          !mappingMatches(mapping, context, bookId) ||
          result.source.privateSpaceId !==
            before.run.mapping.source.privateSpaceId ||
          result.approvedBy !== context.userId ||
          !('comparisonId' in input) ||
          result.comparisonId !== input.comparisonId
        )
          throw serviceContractProblem();
        // This durable approval deliberately does not activate legacy reader routing.
        return reply.send(result);
      },
    );
  }
}
