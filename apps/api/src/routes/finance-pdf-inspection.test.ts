import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  EffectiveAuthorizationScopeFingerprintSchema,
  FinancePdfInspectionSchema,
} from '@emdo/contracts';
import { createApp } from '../app.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';
import { financePdfFixture } from '../../../../packages/integrations/src/finance-documents/test-fixtures/pdf.js';
const principal: AuthenticatedPrincipal = {
  userId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70',
  sessionId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71',
  householdId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f72',
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f74',
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('7'.repeat(64)),
};
const request = {
  method: 'GET' as const,
  url: `/api/v2/finance/books/${principal.householdId}/evidence/${principal.sessionId}/pdf-inspection`,
  headers: { cookie: '__Secure-emdo.session_token=current' },
};
async function fixture() {
  const original = {
    format: 'pdf' as const,
    filename: 'source.pdf',
    sourceBase64: financePdfFixture([
      ['Date CAD', '1.2300', 'i'.repeat(210)],
      [],
    ]).toString('base64'),
  };
  const authenticate = vi.fn(
    async () => principal as AuthenticatedPrincipal | undefined,
  );
  const download = vi.fn(async () => original);
  const app = await createApp({
    services: {
      ...createFailClosedApiServices({
        auth: { authenticate } as unknown as ApiServices['auth'],
      }),
      financeV2: {
        checkReady: async () => true,
        downloadBookEvidence: download,
      } as unknown as NonNullable<ApiServices['financeV2']>,
    },
  });
  return { app, original, authenticate, download };
}
describe('PDF source review inspection boundary', () => {
  it('returns complete exact page/spans and immutable byte digest after fresh book access', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject(request);
      expect(response.statusCode).toBe(200);
      const body = FinancePdfInspectionSchema.parse(response.json());
      expect(body.sourceDigest).toBe(
        createHash('sha256')
          .update(Buffer.from(f.original.sourceBase64, 'base64'))
          .digest('hex'),
      );
      expect(body.selectedPage!.text).toContain('1.2300');
      const long = body.selectedPage!.spans.find(
        (span) => span.textLength > 200,
      )!;
      expect(long.text).toHaveLength(210);
      expect(long.truncated).toBe(false);
      expect(
        body.selectedPage!.text.slice(
          long.textOffset,
          long.textOffset + long.textLength,
        ),
      ).toBe(long.text);
      expect(body.pages[1]).toMatchObject({
        page: 2,
        textStatus: 'no-extractable-text',
        textLength: 0,
        spanCount: 0,
      });
      expect(f.download).toHaveBeenCalledTimes(2);
      expect(f.download).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workspaceId: principal.householdId,
          userId: principal.userId,
        }),
        principal.householdId,
        principal.sessionId,
      );
      expect(response.headers['cache-control']).toBe('no-store, private');
      const blank = FinancePdfInspectionSchema.parse(
        (
          await f.app.inject({ ...request, url: request.url + '?page=2' })
        ).json(),
      );
      expect(blank.selectedPage?.spans).toEqual([]);
      expect(
        (await f.app.inject({ ...request, url: request.url + '?page=3' }))
          .statusCode,
      ).toBe(404);
    } finally {
      await f.app.close();
    }
  });
  it('does not expose extracted text after book access or session identity changes', async () => {
    const f = await fixture();
    try {
      f.download.mockResolvedValueOnce(f.original).mockRejectedValueOnce(
        Object.assign(new Error('finance-book-forbidden'), {
          name: 'FinanceV2PersistenceError',
          code: 'authorization-revoked',
        }),
      );
      const denied = await f.app.inject(request);
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain('1.2300');
      f.authenticate
        .mockResolvedValueOnce(principal)
        .mockResolvedValueOnce({ ...principal, householdId: principal.userId });
      const changed = await f.app.inject(request);
      expect(changed.statusCode).toBe(403);
      expect(changed.body).not.toContain('1.2300');
    } finally {
      await f.app.close();
    }
  });
  it('rejects changed original bytes and requires authentication before source reads', async () => {
    const f = await fixture();
    try {
      f.download.mockResolvedValueOnce(f.original).mockResolvedValueOnce({
        ...f.original,
        sourceBase64: financePdfFixture([['Changed']]).toString('base64'),
      });
      expect((await f.app.inject(request)).statusCode).toBe(502);
      f.authenticate.mockResolvedValueOnce(undefined);
      const count = f.download.mock.calls.length;
      expect((await f.app.inject(request)).statusCode).toBe(401);
      expect(f.download).toHaveBeenCalledTimes(count);
      expect(
        (await f.app.inject({ ...request, url: request.url + '?page=26' }))
          .statusCode,
      ).toBe(400);
    } finally {
      await f.app.close();
    }
  });
});
