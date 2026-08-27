import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';

const principal: AuthenticatedPrincipal = Object.freeze({
  userId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70',
  sessionId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71',
  householdId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f72',
  privateSpaceId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f73',
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f74',
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('7'.repeat(64)),
});
const cookie = '__Secure-emdo.session_token=current';

const buildServices = (
  options: { readonly authenticated?: AuthenticatedPrincipal | undefined } = {},
) => {
  const financeDocuments = {
    list: vi.fn(),
    get: vi.fn(),
    upload: vi.fn(),
    downloadOriginal: vi.fn(),
    retry: vi.fn(),
    getReview: vi.fn(),
    updateReview: vi.fn(),
    commitReview: vi.fn(),
    listMatches: vi.fn(),
    decideMatch: vi.fn(),
    getEvidence: vi.fn(),
    delete: vi.fn(),
    readExperience: vi.fn(async (input: { readonly locale?: string }) => ({
      schemaVersion: 1 as const,
      locale: input.locale ?? 'en-CA',
      connectivity: 'online' as const,
      quota: {
        documentsUsed: 0,
        documentsLimit: 10_000,
        bytesUsed: 0,
        bytesLimit: 50 * 1024 * 1024 * 1024,
      },
      reviewedCadTotals: [],
      recentActivity: [],
      budgets: [],
    })),
  };
  const financeRead = {
    list: vi.fn(async () => ({ schemaVersion: 1 as const, items: [] })),
    readSnapshot: vi.fn(async () => ({
      reviewedCadTotals: [],
      budgets: [],
    })),
  };
  const auth = {
    authenticate: vi.fn(async () =>
      Object.hasOwn(options, 'authenticated')
        ? options.authenticated
        : principal,
    ),
    verifyMutation: vi.fn(async () => true),
  };
  return {
    services: createFailClosedApiServices({
      auth: auth as unknown as ApiServices['auth'],
      bindings: {
        financeDocuments: {
          service:
            financeDocuments as unknown as ApiServices['financeDocuments'],
          check: async () => true,
        },
        financeRead: { service: financeRead, check: async () => true },
      },
    }),
    auth,
    financeDocuments,
    financeRead,
  };
};

describe('finance v1 experience HTTP boundary', () => {
  it('uses the private finance v1 reader only for the exact no-query endpoint and preserves server identity', async () => {
    const { services, financeDocuments, financeRead } = buildServices();
    const app = await createApp({ services });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/experience/finance',
      headers: {
        cookie,
        'accept-language': 'ja-JP, en-CA;q=0.7',
        'x-request-id': '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f75',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schemaVersion: 1,
      locale: 'ja-JP',
    });
    expect(response.headers['cache-control']).toContain('no-store');
    expect(financeDocuments.readExperience).toHaveBeenCalledWith({
      locale: 'ja-JP',
      principal,
      requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f75',
    });
    expect(financeRead.list).not.toHaveBeenCalled();
    await app.close();
  });

  it('falls back to the service default for unknown or excessive locale headers and keeps ?limit=25 on the legacy reader', async () => {
    const { services, financeDocuments, financeRead } = buildServices();
    const app = await createApp({ services });
    const fallback = await app.inject({
      method: 'GET',
      url: '/api/v1/experience/finance',
      headers: { cookie, 'accept-language': 'de-DE, en-US;q=0.9' },
    });
    expect(fallback.statusCode).toBe(200);
    expect(financeDocuments.readExperience).toHaveBeenLastCalledWith(
      expect.objectContaining({
        locale: undefined,
        principal,
        requestId: expect.any(String),
      }),
    );
    const legacy = await app.inject({
      method: 'GET',
      url: '/api/v1/experience/finance?limit=25',
      headers: { cookie, 'accept-language': 'fr-CA' },
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json()).toEqual({ schemaVersion: 1, items: [] });
    expect(financeRead.list).toHaveBeenCalledWith({
      cursor: undefined,
      limit: 25,
      principal: expect.not.objectContaining({
        privateSpaceId: expect.anything(),
      }),
      requestId: expect.any(String),
    });
    expect(financeDocuments.readExperience).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('requires authentication before either finance experience reader runs', async () => {
    const { services, financeDocuments, financeRead } = buildServices({
      authenticated: undefined,
    });
    const app = await createApp({ services });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/experience/finance',
    });
    expect(response.statusCode).toBe(401);
    expect(financeDocuments.readExperience).not.toHaveBeenCalled();
    expect(financeRead.list).not.toHaveBeenCalled();
    await app.close();
  });
});
