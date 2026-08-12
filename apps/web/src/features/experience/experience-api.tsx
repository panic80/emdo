import {
  ActivityPageSchema,
  FinancePageSchema,
  NotificationPreferencesUpdateRequestSchema,
  NotificationPreferencesViewSchema,
  SchedulePageSchema,
  SettingsViewSchema,
  ShoppingPageSchema,
  TodayViewSchema,
  type ActivityPage,
  type FinancePage,
  type NotificationPreferencesUpdateRequest,
  type NotificationPreferencesView,
  type SchedulePage,
  type SettingsView,
  type ShoppingPage,
  type TodayView,
} from '@emdo/contracts/browser';
import { createContext, useContext, type PropsWithChildren } from 'react';

interface RequestOptions {
  readonly signal?: AbortSignal;
}

export interface ExperienceApiClient {
  readToday(
    input: { readonly date: string },
    options?: RequestOptions,
  ): Promise<TodayView>;
  listActivity(
    input: { readonly cursor?: string; readonly limit: number },
    options?: RequestOptions,
  ): Promise<ActivityPage>;
  listSchedule(
    input: {
      readonly from: string;
      readonly to: string;
      readonly cursor?: string;
      readonly limit: number;
    },
    options?: RequestOptions,
  ): Promise<SchedulePage>;
  listFinance(
    input: { readonly cursor?: string; readonly limit: number },
    options?: RequestOptions,
  ): Promise<FinancePage>;
  listShopping(
    input: { readonly cursor?: string; readonly limit: number },
    options?: RequestOptions,
  ): Promise<ShoppingPage>;
  readSettings(options?: RequestOptions): Promise<SettingsView>;
  getNotificationPreferences(
    options?: RequestOptions,
  ): Promise<NotificationPreferencesView>;
  updateNotificationPreferences(
    input: {
      readonly expectedVersion: number;
      readonly preferences: NotificationPreferencesUpdateRequest['preferences'];
      readonly csrfToken: string;
      readonly idempotencyKey: string;
    },
    options?: RequestOptions,
  ): Promise<NotificationPreferencesView>;
}

export class ExperienceApiError extends Error {
  constructor(
    readonly code: 'unavailable' | 'invalid-response',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ExperienceApiError';
  }
}

const parseJson = async (response: Response): Promise<unknown> => {
  if (
    !response.headers
      .get('content-type')
      ?.toLowerCase()
      .includes('application/json')
  ) {
    throw new ExperienceApiError(
      'invalid-response',
      'EMDO returned an invalid experience response.',
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ExperienceApiError(
      'invalid-response',
      'EMDO returned an invalid experience response.',
    );
  }
};

const fetchJson = async (
  fetcher: typeof fetch,
  path: string,
  init: RequestInit,
): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetcher.call(globalThis, path, init);
  } catch {
    throw new ExperienceApiError(
      'unavailable',
      'EMDO could not reach the experience service.',
    );
  }
  if (!response.ok) {
    throw new ExperienceApiError(
      'unavailable',
      'The requested experience data is unavailable.',
      response.status,
    );
  }
  return parseJson(response);
};

const getInit = (signal: AbortSignal | undefined): RequestInit => ({
  method: 'GET',
  cache: 'no-store',
  credentials: 'include',
  headers: { accept: 'application/json' },
  ...(signal === undefined ? {} : { signal }),
});

const parseResponse = <Output,>(
  schema: { safeParse(input: unknown): { success: boolean; data?: Output } },
  input: unknown,
): Output => {
  const parsed = schema.safeParse(input);
  if (!parsed.success || parsed.data === undefined) {
    throw new ExperienceApiError(
      'invalid-response',
      'EMDO returned an invalid experience response.',
    );
  }
  return parsed.data;
};

export const createExperienceApiClient = (
  dependencies: { readonly fetcher?: typeof fetch } = {},
): ExperienceApiClient => {
  const fetcher = dependencies.fetcher ?? fetch;
  const client: ExperienceApiClient = {
    async readToday(input, options) {
      const search = new URLSearchParams({ date: input.date });
      return parseResponse(
        TodayViewSchema,
        await fetchJson(
          fetcher,
          `/api/v1/experience/today?${search.toString()}`,
          getInit(options?.signal),
        ),
      );
    },
    async listActivity(input, options) {
      const search = new URLSearchParams({ limit: String(input.limit) });
      if (input.cursor !== undefined) search.set('cursor', input.cursor);
      return parseResponse(
        ActivityPageSchema,
        await fetchJson(
          fetcher,
          `/api/v1/experience/activity?${search.toString()}`,
          getInit(options?.signal),
        ),
      );
    },
    async listSchedule(input, options) {
      const search = new URLSearchParams({
        from: input.from,
        to: input.to,
        limit: String(input.limit),
      });
      if (input.cursor !== undefined) search.set('cursor', input.cursor);
      return parseResponse(
        SchedulePageSchema,
        await fetchJson(
          fetcher,
          `/api/v1/experience/schedule?${search.toString()}`,
          getInit(options?.signal),
        ),
      );
    },
    async listFinance(input, options) {
      const search = new URLSearchParams({ limit: String(input.limit) });
      if (input.cursor !== undefined) search.set('cursor', input.cursor);
      return parseResponse(
        FinancePageSchema,
        await fetchJson(
          fetcher,
          `/api/v1/experience/finance?${search.toString()}`,
          getInit(options?.signal),
        ),
      );
    },
    async listShopping(input, options) {
      const search = new URLSearchParams({ limit: String(input.limit) });
      if (input.cursor !== undefined) search.set('cursor', input.cursor);
      return parseResponse(
        ShoppingPageSchema,
        await fetchJson(
          fetcher,
          `/api/v1/experience/shopping?${search.toString()}`,
          getInit(options?.signal),
        ),
      );
    },
    async readSettings(options) {
      return parseResponse(
        SettingsViewSchema,
        await fetchJson(
          fetcher,
          '/api/v1/experience/settings',
          getInit(options?.signal),
        ),
      );
    },
    async getNotificationPreferences(options) {
      return parseResponse(
        NotificationPreferencesViewSchema,
        await fetchJson(
          fetcher,
          '/api/v1/experience/notification-preferences',
          getInit(options?.signal),
        ),
      );
    },
    async updateNotificationPreferences(input, options) {
      const body = NotificationPreferencesUpdateRequestSchema.parse({
        schemaVersion: 1,
        expectedVersion: input.expectedVersion,
        preferences: input.preferences,
      });
      return parseResponse(
        NotificationPreferencesViewSchema,
        await fetchJson(
          fetcher,
          '/api/v1/experience/notification-preferences',
          {
            method: 'PUT',
            credentials: 'include',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              'idempotency-key': input.idempotencyKey,
              'x-csrf-token': input.csrfToken,
            },
            body: JSON.stringify(body),
            ...(options?.signal === undefined
              ? {}
              : { signal: options.signal }),
          },
        ),
      );
    },
  };
  return Object.freeze(client);
};

const productionClient = createExperienceApiClient();
const ExperienceApiContext =
  createContext<ExperienceApiClient>(productionClient);

export function ExperienceApiProvider({
  children,
  client,
}: PropsWithChildren<{ readonly client: ExperienceApiClient }>) {
  return (
    <ExperienceApiContext.Provider value={client}>
      {children}
    </ExperienceApiContext.Provider>
  );
}

export const useExperienceApi = (): ExperienceApiClient =>
  useContext(ExperienceApiContext);
