import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FinanceAutomationScheduleDefinitionSchema,
  FinanceAutomationScheduleSchema,
  FinanceAutomationScheduleCursorSchema,
  UuidSchema,
  workspaceContextFromLegacyPrincipal,
} from '@emdo/contracts';
import { SetFinanceScheduleStateSchema } from '@emdo/db/api';
import { ApiProblem, serviceContractProblem } from '../problem.js';
import {
  parseRequest,
  parseServiceResponse,
  prepareAuthenticatedMutation,
  requirePrincipal,
  takePreparedMutation,
} from '../request-context.js';
import type { ApiServices } from '../services/contracts.js';
const Params = z.strictObject({
  bookId: UuidSchema,
  scheduleId: UuidSchema.optional(),
});
const Definition = z
  .strictObject(FinanceAutomationScheduleDefinitionSchema.shape)
  .omit({ workspaceId: true, bookId: true });
const Query = z.strictObject({
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const Record = z.strictObject({
  schedule: FinanceAutomationScheduleSchema,
  cursor: FinanceAutomationScheduleCursorSchema,
  nextDueAt: z.iso.datetime({ offset: true }).nullable(),
  blockedReason: z.string().max(500).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
function identity(workspace: string, user: string, book: string, key: string) {
  const b = createHash('sha256')
    .update(JSON.stringify(['finance-schedule.v1', workspace, user, book, key]))
    .digest()
    .subarray(0, 16);
  b[6] = (b[6]! & 15) | 128;
  b[8] = (b[8]! & 63) | 128;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function registerFinanceScheduleRoutes(
  app: FastifyInstance,
  services: ApiServices,
  bodyLimit: number,
) {
  const ready = async () => {
    if (
      !services.financeSchedules ||
      !services.financeV2 ||
      !(await services.financeV2.checkReady().catch(() => false)) ||
      !(await services.financeSchedules.checkReady().catch(() => false))
    )
      throw new ApiProblem({
        status: 503,
        code: 'finance-schedules-unavailable',
        title: 'Finance schedules unavailable',
        detail: 'The schedule service is not enabled or ready.',
      });
    return services.financeSchedules;
  };
  const validate = (raw: unknown, w: string, b: string, id?: string) => {
    const record = parseServiceResponse(Record, raw);
    if (
      record.schedule.definition.workspaceId !== w ||
      record.schedule.definition.bookId !== b ||
      record.cursor.scheduleId !== record.schedule.id ||
      (id && record.schedule.id !== id)
    )
      throw serviceContractProblem();
    return record;
  };
  const base = '/api/v2/finance/books/:bookId/automations/schedules';
  app.get(`${base}/options`, async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const { bookId } = parseRequest(Params, request.params);
    const scope = workspaceContextFromLegacyPrincipal(principal, request.id);
    // The normal book-scoped read checks current administrator authority even for an empty list.
    await (await ready()).listSchedules(scope, bookId, 0, 1);
    const tzdbVersion = process.versions.tz;
    if (!tzdbVersion) throw serviceContractProblem();
    return reply
      .header('cache-control', 'no-store, private')
      .send({ tzdbVersion });
  });
  app.get(base, async (request, reply) => {
    const principal = await requirePrincipal(request, services),
      { bookId } = parseRequest(Params, request.params),
      query = parseRequest(Query, request.query),
      scope = workspaceContextFromLegacyPrincipal(principal, request.id);
    const rows = await (
      await ready()
    ).listSchedules(scope, bookId, query.offset, query.limit);
    if (rows.length > query.limit) throw serviceContractProblem();
    return reply.header('cache-control', 'no-store, private').send({
      schedules: rows.map((r) => validate(r, scope.workspaceId, bookId)),
    });
  });
  app.get(`${base}/:scheduleId`, async (request, reply) => {
    const principal = await requirePrincipal(request, services),
      { bookId, scheduleId } = parseRequest(Params, request.params),
      scope = workspaceContextFromLegacyPrincipal(principal, request.id);
    const raw = await (await ready()).getSchedule(scope, bookId, scheduleId!);
    return reply
      .header('cache-control', 'no-store, private')
      .send(
        raw === null
          ? null
          : validate(raw, scope.workspaceId, bookId, scheduleId),
      );
  });
  for (const action of ['create', 'state'] as const)
    app.post(
      action === 'create' ? base : `${base}/:scheduleId/state`,
      {
        bodyLimit,
        onRequest: (request) => prepareAuthenticatedMutation(request, services),
      },
      async (request, reply) => {
        const { principal, idempotencyKey } = takePreparedMutation(request),
          { bookId, scheduleId } = parseRequest(Params, request.params);
        parseRequest(UuidSchema, idempotencyKey);
        const scope = workspaceContextFromLegacyPrincipal(
            principal,
            request.id,
          ),
          api = await ready();
        let result;
        if (action === 'create') {
          const definition = parseRequest(
              FinanceAutomationScheduleDefinitionSchema,
              {
                ...parseRequest(Definition, request.body),
                workspaceId: scope.workspaceId,
                bookId,
              },
            ),
            id = identity(
              scope.workspaceId,
              scope.userId,
              bookId,
              idempotencyKey,
            );
          result = validate(
            await api.createSchedule(scope, bookId, id, definition),
            scope.workspaceId,
            bookId,
            id,
          );
        } else
          result = validate(
            await api.setScheduleState(
              scope,
              bookId,
              scheduleId!,
              parseRequest(SetFinanceScheduleStateSchema, request.body),
            ),
            scope.workspaceId,
            bookId,
            scheduleId,
          );
        return reply.header('cache-control', 'no-store, private').send(result);
      },
    );
}
