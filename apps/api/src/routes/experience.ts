import type { FastifyInstance } from 'fastify';

import { ApiProblem, serviceContractProblem } from '../problem.js';
import {
  parseRequest,
  parseServiceResponse,
  prepareAuthenticatedMutation,
  requirePrincipal,
  takePreparedMutation,
} from '../request-context.js';
import {
  ActivityPageSchema,
  ActivityReadQuerySchema,
  ExperiencePageQuerySchema,
  FinancePageSchema,
  NotificationPreferencesUpdateRequestSchema,
  NotificationPreferencesViewSchema,
  SchedulePageSchema,
  ScheduleReadQuerySchema,
  SettingsViewSchema,
  ShoppingPageSchema,
  TodayReadQuerySchema,
  TodayViewSchema,
} from '../schemas.js';
import type { ApiServices } from '../services/contracts.js';

const uniqueIds = (items: readonly { readonly id: string }[]): boolean =>
  new Set(items.map(({ id }) => id)).size === items.length;

const experienceProblem = (error: unknown): ApiProblem | undefined => {
  const code =
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : undefined;
  switch (code) {
    case 'authorization-revoked':
      return new ApiProblem({
        status: 403,
        code,
        title: 'Experience authority unavailable',
        detail: 'Current household authority is required.',
      });
    case 'conflict':
      return new ApiProblem({
        status: 409,
        code,
        title: 'Experience state changed',
        detail: 'Refresh the current state and try again.',
      });
    case 'invalid-input':
      return new ApiProblem({
        status: 400,
        code,
        title: 'Invalid experience request',
        detail: 'The experience request is invalid.',
      });
    case 'invalid-result':
      return new ApiProblem({
        status: 503,
        code,
        title: 'Experience unavailable',
        detail: 'The experience data could not be returned safely.',
      });
    default:
      return undefined;
  }
};

const invokeExperience = async <Result>(
  operation: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    throw experienceProblem(error) ?? error;
  }
};

export const registerExperienceRoutes = (
  app: FastifyInstance,
  services: ApiServices,
  maximumJsonBodyBytes: number,
): void => {
  app.get('/api/v1/experience/today', async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const query = parseRequest(TodayReadQuerySchema, request.query);
    const result = parseServiceResponse(
      TodayViewSchema,
      await invokeExperience(() =>
        services.todayRead.read({
          date: query.date,
          principal,
          requestId: request.id,
        }),
      ),
    );
    if (
      result.date !== query.date ||
      !uniqueIds(result.schedule.items) ||
      !uniqueIds(result.reminders.items) ||
      !uniqueIds(result.notifications.items)
    ) {
      throw serviceContractProblem();
    }
    return reply.header('cache-control', 'no-store').send(result);
  });

  app.get('/api/v1/experience/activity', async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const query = parseRequest(ActivityReadQuerySchema, request.query);
    const result = parseServiceResponse(
      ActivityPageSchema,
      await invokeExperience(() =>
        services.activityRead.list({
          cursor: query.cursor,
          limit: query.limit,
          principal,
          requestId: request.id,
        }),
      ),
    );
    if (
      result.items.length > query.limit ||
      !uniqueIds(result.items) ||
      (query.cursor !== undefined && result.nextCursor === query.cursor)
    ) {
      throw serviceContractProblem();
    }
    return reply.header('cache-control', 'no-store').send(result);
  });

  app.get('/api/v1/experience/finance', async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const query = parseRequest(ExperiencePageQuerySchema, request.query);
    const result = parseServiceResponse(
      FinancePageSchema,
      await invokeExperience(() =>
        services.financeRead.list({
          cursor: query.cursor,
          limit: query.limit,
          principal,
          requestId: request.id,
        }),
      ),
    );
    if (
      result.items.length > query.limit ||
      !uniqueIds(result.items) ||
      (query.cursor !== undefined && result.nextCursor === query.cursor)
    ) {
      throw serviceContractProblem();
    }
    return reply.header('cache-control', 'no-store').send(result);
  });

  app.get('/api/v1/experience/shopping', async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const query = parseRequest(ExperiencePageQuerySchema, request.query);
    const result = parseServiceResponse(
      ShoppingPageSchema,
      await invokeExperience(() =>
        services.shoppingRead.list({
          cursor: query.cursor,
          limit: query.limit,
          principal,
          requestId: request.id,
        }),
      ),
    );
    if (
      result.items.length > query.limit ||
      !uniqueIds(result.items) ||
      (query.cursor !== undefined && result.nextCursor === query.cursor)
    ) {
      throw serviceContractProblem();
    }
    return reply.header('cache-control', 'no-store').send(result);
  });

  app.get('/api/v1/experience/schedule', async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const query = parseRequest(ScheduleReadQuerySchema, request.query);
    const result = parseServiceResponse(
      SchedulePageSchema,
      await invokeExperience(() =>
        services.scheduleRead.list({
          from: query.from,
          to: query.to,
          cursor: query.cursor,
          limit: query.limit,
          principal,
          requestId: request.id,
        }),
      ),
    );
    if (
      result.from !== query.from ||
      result.to !== query.to ||
      result.items.items.length > query.limit ||
      !uniqueIds(result.items.items) ||
      (query.cursor !== undefined && result.nextCursor === query.cursor)
    ) {
      throw serviceContractProblem();
    }
    return reply.header('cache-control', 'no-store').send(result);
  });

  app.get('/api/v1/experience/settings', async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const result = parseServiceResponse(
      SettingsViewSchema,
      await invokeExperience(() =>
        services.settingsRead.read({ principal, requestId: request.id }),
      ),
    );
    return reply.header('cache-control', 'no-store').send(result);
  });

  app.get(
    '/api/v1/experience/notification-preferences',
    async (request, reply) => {
      const principal = await requirePrincipal(request, services);
      const result = parseServiceResponse(
        NotificationPreferencesViewSchema,
        await invokeExperience(() =>
          services.notificationPreferences.get({
            principal,
            requestId: request.id,
          }),
        ),
      );
      return reply.header('cache-control', 'no-store').send(result);
    },
  );

  app.put(
    '/api/v1/experience/notification-preferences',
    {
      bodyLimit: maximumJsonBodyBytes,
      onRequest: (request) => prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { idempotencyKey, principal } = takePreparedMutation(request);
      const input = parseRequest(
        NotificationPreferencesUpdateRequestSchema,
        request.body,
      );
      const result = parseServiceResponse(
        NotificationPreferencesViewSchema,
        await invokeExperience(() =>
          services.notificationPreferences.update({
            expectedVersion: input.expectedVersion,
            preferences: input.preferences,
            idempotencyKey,
            principal,
            requestId: request.id,
          }),
        ),
      );
      return reply.header('cache-control', 'no-store').send(result);
    },
  );
};
