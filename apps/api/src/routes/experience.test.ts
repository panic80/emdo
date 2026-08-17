import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';

const principal: AuthenticatedPrincipal = {
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('c'.repeat(64)),
  userId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f60',
  sessionId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f61',
  householdId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f62',
  privateSpaceId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f63',
};
const experiencePrincipal = {
  collectionAuthorizationScopeFingerprint:
    principal.collectionAuthorizationScopeFingerprint,
  userId: principal.userId,
  sessionId: principal.sessionId,
  householdId: principal.householdId,
  role: principal.role,
  emailVerified: principal.emailVerified,
  spaceAccessGrantId: principal.spaceAccessGrantId,
};

const cookie = { cookie: '__Secure-emdo.session_token=current' };
const mutationHeaders = {
  ...cookie,
  origin: 'https://emdo.example',
  'x-csrf-token': 'csrf-token',
  'idempotency-key': 'preferences:018f1f5e:update',
};

const today = {
  schemaVersion: 1 as const,
  date: '2026-08-10',
  timezone: 'America/Toronto' as const,
  schedule: { status: 'available' as const, items: [] },
  reminders: { status: 'available' as const, items: [] },
  notifications: { status: 'available' as const, items: [] },
  finance: {
    status: 'available' as const,
    budgetCount: 0,
    transactionCount: 0,
  },
  shopping: {
    status: 'available' as const,
    itemCount: 0,
    retailerCount: 0,
  },
};

const preferences = {
  schemaVersion: 1 as const,
  version: 3,
  inApp: true,
  push: false,
  email: true,
  spokenReplies: false,
  updatedAt: '2026-08-10T12:00:00.000Z',
};

const buildServices = () => {
  const todayRead = { read: vi.fn(async () => today) };
  const activityRead = {
    list: vi.fn(
      async (): Promise<{
        readonly schemaVersion: 1;
        readonly items: readonly {
          readonly id: string;
          readonly category: 'audit';
          readonly title: string;
          readonly occurredAt: string;
        }[];
      }> => ({ schemaVersion: 1 as const, items: [] }),
    ),
  };
  const scheduleRead = {
    list: vi.fn(async () => ({
      schemaVersion: 1 as const,
      timezone: 'America/Toronto' as const,
      from: '2026-08-10',
      to: '2026-08-17',
      items: { status: 'unavailable' as const, items: [] },
      calendar: { status: 'disconnected' as const },
    })),
  };
  const settingsRead = {
    read: vi.fn(async () => ({
      schemaVersion: 1 as const,
      household: { name: 'Johnson household', role: 'owner' as const },
      privateSpaces: [{ name: 'My private space' }],
      calendar: { status: 'disconnected' as const },
    })),
  };
  const notificationPreferences = {
    get: vi.fn(async () => preferences),
    update: vi.fn(async () => preferences),
  };
  const financeRead = {
    list: vi.fn(async () => ({
      schemaVersion: 1 as const,
      items: [
        {
          recordType: 'transaction' as const,
          id: 'transaction-1',
          description: 'Farm Boy',
          category: 'groceries',
          postedOn: '2026-08-10',
          currency: 'CAD' as const,
          amountCadMinor: 1_234,
          state: 'active' as const,
        },
      ],
    })),
  };
  const shoppingRead = {
    list: vi.fn(async () => ({
      schemaVersion: 1 as const,
      items: [
        {
          id: 'shopping-1',
          name: 'Milk',
          quantityMinorUnits: 2_000,
          state: 'active' as const,
        },
      ],
    })),
  };
  const services = {
    auth: {
      authenticate: vi.fn(
        async ({ cookie: value }: { readonly cookie?: string }) =>
          value === cookie.cookie ? principal : undefined,
      ),
      verifyMutation: vi.fn(
        async ({
          csrfToken,
          origin,
        }: {
          readonly csrfToken?: string;
          readonly origin?: string;
        }) => csrfToken === 'csrf-token' && origin === 'https://emdo.example',
      ),
    },
    todayRead,
    activityRead,
    scheduleRead,
    settingsRead,
    notificationPreferences,
    financeRead,
    shoppingRead,
  } as unknown as ApiServices;
  return {
    activityRead,
    financeRead,
    notificationPreferences,
    scheduleRead,
    services,
    settingsRead,
    shoppingRead,
    todayRead,
  };
};

describe('authenticated experience read API', () => {
  it.each([
    ['finance', 'financeRead'],
    ['shopping', 'shoppingRead'],
  ] as const)(
    'returns a bounded no-store %s page',
    async (path, gatewayName) => {
      const fixtures = buildServices();
      const app = await createApp({
        services: fixtures.services,
        publicOrigin: 'https://emdo.example',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/experience/${path}?cursor=opaque-next&limit=2`,
        headers: cookie,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(fixtures[gatewayName].list).toHaveBeenCalledWith({
        cursor: 'opaque-next',
        limit: 2,
        principal: experiencePrincipal,
        requestId: expect.any(String),
      });
      await app.close();
    },
  );

  it('returns a strict no-store Today projection for the authenticated principal', async () => {
    const { services, todayRead } = buildServices();
    const app = await createApp({
      services,
      publicOrigin: 'https://emdo.example',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/experience/today?date=2026-08-10',
      headers: cookie,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual(today);
    expect(todayRead.read).toHaveBeenCalledWith({
      date: '2026-08-10',
      principal: experiencePrincipal,
      requestId: expect.any(String),
    });
    await app.close();
  });

  it('rejects unauthenticated reads before invoking an aggregate gateway', async () => {
    const { services, todayRead } = buildServices();
    const app = await createApp({
      services,
      publicOrigin: 'https://emdo.example',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/experience/today?date=2026-08-10',
    });

    expect(response.statusCode).toBe(401);
    expect(todayRead.read).not.toHaveBeenCalled();
    await app.close();
  });

  it('binds activity pagination and rejects an oversized service page', async () => {
    const { activityRead, services } = buildServices();
    activityRead.list.mockResolvedValueOnce({
      schemaVersion: 1,
      items: Array.from({ length: 3 }, (_, index) => ({
        id: `activity-${index}`,
        category: 'audit' as const,
        title: 'Activity recorded',
        occurredAt: '2026-08-10T12:00:00.000Z',
      })),
    });
    const app = await createApp({
      services,
      publicOrigin: 'https://emdo.example',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/experience/activity?cursor=opaque-cursor&limit=2',
      headers: cookie,
    });

    expect(response.statusCode).toBe(502);
    expect(activityRead.list).toHaveBeenCalledWith({
      cursor: 'opaque-cursor',
      limit: 2,
      principal: experiencePrincipal,
      requestId: expect.any(String),
    });
    await app.close();
  });

  it('rejects an invalid schedule range before querying durable data', async () => {
    const { scheduleRead, services } = buildServices();
    const app = await createApp({
      services,
      publicOrigin: 'https://emdo.example',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/experience/schedule?from=2026-08-10&to=2026-10-01&limit=25',
      headers: cookie,
    });

    expect(response.statusCode).toBe(400);
    expect(scheduleRead.list).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects provider secrets returned by the settings service', async () => {
    const { services, settingsRead } = buildServices();
    settingsRead.read.mockResolvedValueOnce({
      schemaVersion: 1,
      household: { name: 'Johnson household', role: 'owner' },
      privateSpaces: [],
      calendar: {
        status: 'connected',
        refreshToken: 'must-never-cross-the-read-boundary',
      },
    } as never);
    const app = await createApp({
      services,
      publicOrigin: 'https://emdo.example',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/experience/settings',
      headers: cookie,
    });

    expect(response.statusCode).toBe(502);
    await app.close();
  });

  it('requires current browser mutation proof and idempotency to update preferences', async () => {
    const { notificationPreferences, services } = buildServices();
    const app = await createApp({
      services,
      publicOrigin: 'https://emdo.example',
    });
    const payload = {
      schemaVersion: 1,
      expectedVersion: 3,
      preferences: {
        inApp: true,
        push: true,
        email: false,
        spokenReplies: false,
      },
    };

    const denied = await app.inject({
      method: 'PUT',
      url: '/api/v1/experience/notification-preferences',
      headers: cookie,
      payload,
    });
    expect(denied.statusCode).toBe(403);
    expect(notificationPreferences.update).not.toHaveBeenCalled();

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/v1/experience/notification-preferences',
      headers: mutationHeaders,
      payload,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.headers['cache-control']).toBe('no-store');
    expect(updated.json()).toEqual(preferences);
    expect(notificationPreferences.update).toHaveBeenCalledWith({
      expectedVersion: 3,
      preferences: payload.preferences,
      idempotencyKey: mutationHeaders['idempotency-key'],
      principal: experiencePrincipal,
      requestId: expect.any(String),
    });
    await app.close();
  });

  it('returns a bounded conflict when durable preferences changed', async () => {
    const { notificationPreferences, services } = buildServices();
    notificationPreferences.update.mockRejectedValueOnce(
      Object.assign(new Error('redacted'), { code: 'conflict' }),
    );
    const app = await createApp({
      services,
      publicOrigin: 'https://emdo.example',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/experience/notification-preferences',
      headers: mutationHeaders,
      payload: {
        schemaVersion: 1,
        expectedVersion: 3,
        preferences: {
          inApp: true,
          push: true,
          email: false,
          spokenReplies: false,
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'conflict', status: 409 });
    await app.close();
  });
});
