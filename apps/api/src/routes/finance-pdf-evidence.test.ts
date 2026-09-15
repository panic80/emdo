import { describe, expect, it, vi } from 'vitest';
import {
  EffectiveAuthorizationScopeFingerprintSchema,
  UploadFinanceBookEvidenceSchema,
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
describe('PDF book evidence HTTP authority', () => {
  it.each([true, false])(
    'preserves binary evidence and trusted scope with mutation verification=%s',
    async (verified) => {
      const payload = {
        filename: 'statement.pdf',
        format: 'pdf',
        sourceBase64: financePdfFixture().toString('base64'),
      };
      const auth = {
        authenticate: vi.fn(async () => principal),
        verifyMutation: vi.fn(async () => verified),
      } as unknown as ApiServices['auth'];
      const uploadBookEvidence = vi.fn(
        async (
          _scope: unknown,
          _book: unknown,
          _key: unknown,
          input: unknown,
        ) => {
          expect(UploadFinanceBookEvidenceSchema.parse(input)).toEqual(payload);
          return { id: principal.sessionId };
        },
      );
      const downloadBookEvidence = vi.fn(async () => payload);
      const financeV2 = {
        checkReady: async () => true,
        uploadBookEvidence,
        downloadBookEvidence,
      } as unknown as NonNullable<ApiServices['financeV2']>;
      const app = await createApp({
        services: { ...createFailClosedApiServices({ auth }), financeV2 },
      });
      try {
        const saved = await app.inject({
          method: 'POST',
          url: `/api/v2/finance/books/${principal.householdId}/evidence`,
          headers: {
            cookie: '__Secure-emdo.session_token=current',
            'idempotency-key': 'pdf-evidence-upload',
          },
          payload,
        });
        expect(saved.statusCode).toBe(verified ? 200 : 403);
        if (!verified) {
          expect(uploadBookEvidence).not.toHaveBeenCalled();
          return;
        }
        expect(uploadBookEvidence).toHaveBeenCalledWith(
          expect.objectContaining({
            workspaceId: principal.householdId,
            userId: principal.userId,
          }),
          principal.householdId,
          'pdf-evidence-upload',
          payload,
        );
        const original = await app.inject({
          method: 'GET',
          url: `/api/v2/finance/books/${principal.householdId}/evidence/${principal.sessionId}`,
          headers: { cookie: '__Secure-emdo.session_token=current' },
        });
        expect(original.statusCode).toBe(200);
        expect(original.json()).toEqual(payload);
        expect(original.headers['cache-control']).toBe('no-store, private');
        expect(downloadBookEvidence).toHaveBeenCalledWith(
          expect.objectContaining({
            workspaceId: principal.householdId,
            userId: principal.userId,
          }),
          principal.householdId,
          principal.sessionId,
        );
      } finally {
        await app.close();
      }
    },
  );
});
