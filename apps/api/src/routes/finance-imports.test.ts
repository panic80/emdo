import { createHash } from 'node:crypto';

import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import { createOpenApiDocument } from '../openapi.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';

const USER_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70';
const SESSION_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71';
const HOUSEHOLD_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f72';
const SPACE_GRANT_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f73';
const ACCOUNT_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f74';
const PLAN_ID = 'finance-import-plan-a1';
const IDEMPOTENCY_KEY = 'request:018f1f5e:finance-import';
const SOURCE_TEXT = 'Date,Description,Amount\\n2026-08-10,Farm Boy,-12.34\\n';
const SOURCE_HASH = createHash('sha256').update(SOURCE_TEXT).digest('hex');

const principal: AuthenticatedPrincipal = Object.freeze({
  userId: USER_ID,
  sessionId: SESSION_ID,
  householdId: HOUSEHOLD_ID,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: SPACE_GRANT_ID,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('7'.repeat(64)),
});

const headers = Object.freeze({
  cookie: '__Secure-emdo.session_token=current',
  origin: 'https://emdo.example',
  'x-csrf-token': 'csrf-token',
  'idempotency-key': IDEMPOTENCY_KEY,
});

const previewRequest = Object.freeze({
  schemaVersion: 1,
  format: 'csv',
  sourceText: SOURCE_TEXT,
  accountId: ACCOUNT_ID,
  mapping: {
    dateFormat: 'yyyy-mm-dd',
    defaultCategoryId: null,
    columns: {
      postedOn: 'Date',
      description: 'Description',
      amount: 'Amount',
    },
  },
});

const buildServices = () => {
  const financeImports = {
    listDestinations: vi.fn(async () => ({
      schemaVersion: 1 as const,
      accounts: [
        {
          id: 'account::chequing',
          name: 'Everyday chequing',
          accountKind: 'chequing' as const,
        },
      ],
      categories: [
        {
          id: 'category::groceries',
          name: 'Groceries',
          categoryKind: 'expense' as const,
        },
      ],
    })),
    preview: vi.fn(async () => ({
      schemaVersion: 1 as const,
      plan: {
        id: PLAN_ID,
        sourceHash: SOURCE_HASH,
        expiresAt: '2026-08-13T15:10:00.000Z',
        summary: { accepted: 1, rejected: 0, duplicates: 0 },
        rejectedRows: [],
        duplicateRows: [],
      },
    })),
    commit: vi.fn(async () => ({
      schemaVersion: 1 as const,
      status: 'committed' as const,
      receipt: {
        id: 'finance-import-receipt-a1',
        planId: PLAN_ID,
        transactionCount: 1,
        verified: true as const,
      },
      sourceDeletionAuthorized: true as const,
    })),
  };
  const auth = {
    authenticate: vi.fn(async ({ cookie }: { readonly cookie?: string }) =>
      cookie === '__Secure-emdo.session_token=current' ? principal : undefined,
    ),
    verifyMutation: vi.fn(
      async (input: {
        readonly csrfToken?: string;
        readonly origin?: string;
      }) =>
        input.csrfToken === 'csrf-token' &&
        input.origin === 'https://emdo.example',
    ),
  };
  return {
    services: { auth, financeImports } as unknown as ApiServices,
    financeImports,
  };
};

describe('finance import HTTP boundary', () => {
  it('lists only bounded import destinations for an authenticated current principal without CSRF', async () => {
    const { services, financeImports } = buildServices();
    const app = await createApp({ services });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/finance/imports/options',
      headers: { cookie: headers.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.json()).toEqual({
      schemaVersion: 1,
      accounts: [
        {
          id: 'account::chequing',
          name: 'Everyday chequing',
          accountKind: 'chequing',
        },
      ],
      categories: [
        {
          id: 'category::groceries',
          name: 'Groceries',
          categoryKind: 'expense',
        },
      ],
    });
    expect(financeImports.listDestinations).toHaveBeenCalledWith({
      principal,
      requestId: expect.any(String),
    });
    expect(services.auth.verifyMutation).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires a current mutation proof before parsing or dispatching a preview', async () => {
    const { services, financeImports } = buildServices();
    const app = await createApp({ services });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/finance/imports/preview',
      headers: { cookie: headers.cookie },
      payload: { ...previewRequest, format: 'qif' },
    });

    expect(response.statusCode).toBe(403);
    expect(financeImports.preview).not.toHaveBeenCalled();
    await app.close();
  });

  it('previews a mutation-proven CSV without returning raw statement text', async () => {
    const { services, financeImports } = buildServices();
    const app = await createApp({ services });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/finance/imports/preview',
      headers: {
        cookie: headers.cookie,
        origin: headers.origin,
        'x-csrf-token': headers['x-csrf-token'],
      },
      payload: previewRequest,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: 1,
      plan: {
        id: PLAN_ID,
        sourceHash: SOURCE_HASH,
        expiresAt: '2026-08-13T15:10:00.000Z',
        summary: { accepted: 1, rejected: 0, duplicates: 0 },
        rejectedRows: [],
        duplicateRows: [],
      },
    });
    expect(response.body).not.toContain(SOURCE_TEXT);
    expect(financeImports.preview).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      format: 'csv',
      mapping: previewRequest.mapping,
      principal,
      requestId: expect.any(String),
      sourceText: SOURCE_TEXT,
    });
    expect(services.auth.authenticate).toHaveBeenCalledOnce();

    await app.close();
  });

  it('passes authenticated preview and holds direct commit for EMDO confirmation', async () => {
    const { services: sparseServices, financeImports } = buildServices();
    const check = vi.fn(async () => true);
    const services = createFailClosedApiServices({
      auth: sparseServices.auth,
      bindings: { financeImports: { service: financeImports, check } },
    });
    const app = await createApp({ services });

    const preview = await app.inject({
      method: 'POST',
      url: '/api/v1/finance/imports/preview',
      headers: {
        cookie: headers.cookie,
        origin: headers.origin,
        'x-csrf-token': headers['x-csrf-token'],
      },
      payload: previewRequest,
    });
    expect(preview.statusCode).toBe(200);
    const commit = await app.inject({
      method: 'POST',
      url: '/api/v1/finance/imports/commit',
      headers,
      payload: { schemaVersion: 1, planId: PLAN_ID },
    });
    expect(commit.statusCode).toBe(409);
    expect(commit.json()).toMatchObject({ code: 'approval-required' });
    expect(financeImports.preview).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      format: 'csv',
      mapping: previewRequest.mapping,
      principal,
      requestId: expect.any(String),
      sourceText: SOURCE_TEXT,
    });
    expect(financeImports.commit).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledOnce();

    await app.close();
  });

  it('rejects an unknown import format before invoking the preview service', async () => {
    const { services, financeImports } = buildServices();
    const app = await createApp({ services });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/finance/imports/preview',
      headers: {
        cookie: headers.cookie,
        origin: headers.origin,
        'x-csrf-token': headers['x-csrf-token'],
      },
      payload: { ...previewRequest, format: 'qif' },
    });

    expect(response.statusCode).toBe(400);
    expect(financeImports.preview).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a multibyte account identifier above the shared 512-byte ceiling', async () => {
    const { services, financeImports } = buildServices();
    const app = await createApp({ services });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/finance/imports/preview',
      headers: {
        cookie: headers.cookie,
        origin: headers.origin,
        'x-csrf-token': headers['x-csrf-token'],
      },
      payload: { ...previewRequest, accountId: 'é'.repeat(257) },
    });

    expect(response.statusCode).toBe(400);
    expect(financeImports.preview).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires mutation proof and still holds direct commit for EMDO confirmation', async () => {
    const { services, financeImports } = buildServices();
    const app = await createApp({ services });

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/finance/imports/commit',
      headers: { cookie: headers.cookie },
      payload: { schemaVersion: 1, planId: PLAN_ID },
    });
    expect(rejected.statusCode).toBe(403);
    expect(financeImports.commit).not.toHaveBeenCalled();

    const held = await app.inject({
      method: 'POST',
      url: '/api/v1/finance/imports/commit',
      headers,
      payload: { schemaVersion: 1, planId: PLAN_ID },
    });
    expect(held.statusCode).toBe(409);
    expect(held.json()).toMatchObject({ code: 'approval-required' });
    expect(financeImports.commit).not.toHaveBeenCalled();

    await app.close();
  });

  it('does not expose durable commit outcomes through the direct HTTP route', async () => {
    const { services, financeImports } = buildServices();
    financeImports.commit.mockRejectedValueOnce(
      Object.assign(new Error('emdo:finance-import-plan-expired'), {
        name: 'FinanceImportPersistenceError',
        code: 'plan-expired',
      }),
    );
    const app = await createApp({ services });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/finance/imports/commit',
      headers,
      payload: { schemaVersion: 1, planId: PLAN_ID },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'approval-required' });
    expect(response.body).not.toContain('emdo:');
    expect(financeImports.commit).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps preview unavailable and direct commit held when the durable probe is unavailable', async () => {
    const { services: sparseServices, financeImports } = buildServices();
    const check = vi.fn(async () => false);
    const services = createFailClosedApiServices({
      auth: sparseServices.auth,
      bindings: { financeImports: { service: financeImports, check } },
    });
    const app = await createApp({ services });

    const preview = await app.inject({
      method: 'POST',
      url: '/api/v1/finance/imports/preview',
      headers: {
        cookie: headers.cookie,
        origin: headers.origin,
        'x-csrf-token': headers['x-csrf-token'],
      },
      payload: previewRequest,
    });
    expect(preview.statusCode).toBe(503);
    expect(preview.json()).toMatchObject({
      code: 'finance-import-unavailable',
    });

    const commit = await app.inject({
      method: 'POST',
      url: '/api/v1/finance/imports/commit',
      headers,
      payload: { schemaVersion: 1, planId: PLAN_ID },
    });
    expect(commit.statusCode).toBe(409);
    expect(commit.json()).toMatchObject({ code: 'approval-required' });
    expect(check).toHaveBeenCalledOnce();
    expect(financeImports.preview).not.toHaveBeenCalled();
    expect(financeImports.commit).not.toHaveBeenCalled();

    await app.close();
  });

  it('publishes authenticated preview and mutation-proof commit contracts', () => {
    const paths = createOpenApiDocument().paths as Record<string, unknown>;
    const previewPath = paths['/api/v1/finance/imports/preview'] as {
      readonly post: {
        readonly parameters?: readonly { readonly name?: string }[];
      };
    };
    expect(previewPath).toMatchObject({
      post: {
        operationId: 'previewFinanceImport',
        security: [{ sessionAuth: [] }],
        parameters: expect.arrayContaining([
          expect.objectContaining({ name: 'Origin', required: true }),
          expect.objectContaining({ name: 'X-CSRF-Token', required: true }),
        ]),
      },
    });
    expect(previewPath.post.parameters?.map(({ name }) => name)).not.toContain(
      'Idempotency-Key',
    );
    expect(paths['/api/v1/finance/imports/commit']).toMatchObject({
      post: {
        operationId: 'commitFinanceImport',
        security: [{ sessionAuth: [] }],
        parameters: expect.arrayContaining([
          expect.objectContaining({ name: 'Idempotency-Key', required: true }),
          expect.objectContaining({ name: 'Origin', required: true }),
          expect.objectContaining({ name: 'X-CSRF-Token', required: true }),
        ]),
      },
    });
  });
});
