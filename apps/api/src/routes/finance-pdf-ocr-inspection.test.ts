import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { createApp } from '../app.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';
const uuid = (n: number) =>
  `19000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const principal: AuthenticatedPrincipal = {
  userId: uuid(1),
  sessionId: uuid(2),
  householdId: uuid(3),
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: uuid(4),
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('7'.repeat(64)),
};
const bytes = Buffer.from('%PDF-original');
const digest = createHash('sha256').update(bytes).digest('hex');
const base = `/api/v2/finance/books/${uuid(5)}/evidence/${uuid(6)}/pdf-ocr-inspection`;
async function fixture() {
  const authenticate = vi.fn(
    async () => principal as AuthenticatedPrincipal | undefined,
  );
  const ready = vi.fn(async () => true);
  const inspection = {
    evidenceId: uuid(6),
    standardizationRunId: uuid(7),
    extractionRevision: 1,
    extractionDigest: 'a'.repeat(64),
    sourceDigest: digest,
    inventory: {
      sourceDigest: digest,
      pageCount: 1,
      complete: false,
      pages: [{ kind: 'unresolved', pageNumber: 1, reason: 'render-failed' }],
    },
  };
  const read = vi.fn(async () => inspection);
  const app = await createApp({
    services: {
      ...createFailClosedApiServices({
        auth: { authenticate } as unknown as ApiServices['auth'],
      }),
      financeV2: {
        checkReady: ready,
        readPdfOcrInspection: read,
        downloadBookEvidence: async () => ({
          format: 'pdf',
          filename: 'source.pdf',
          sourceBase64: bytes.toString('base64'),
        }),
      } as unknown as ApiServices['financeV2'],
    },
  });
  const request = {
    method: 'GET' as const,
    url: base + `?standardizationRunId=${uuid(7)}&extractionRevision=1`,
    headers: { cookie: '__Secure-emdo.session_token=current' },
  };
  return { app, request, read, inspection, authenticate, ready };
}
describe('saved PDF OCR inspection endpoint', () => {
  it('forwards trusted scope and exact saved extraction and returns uncertainty', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject(f.request);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(f.inspection);
      expect(f.read).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: principal.householdId,
          userId: principal.userId,
        }),
        uuid(5),
        uuid(6),
        { standardizationRunId: uuid(7), extractionRevision: 1 },
      );
      expect(response.headers['cache-control']).toBe('no-store, private');
    } finally {
      await f.app.close();
    }
  });
  it.each([
    'unauthenticated',
    'unavailable',
    'revoked',
    'missing-binding',
    'wrong-evidence',
    'wrong-run',
    'wrong-source',
    'wrong-inventory',
  ] as const)('fails closed for %s', async (kind) => {
    const f = await fixture();
    try {
      let expected = 502;
      if (kind === 'unauthenticated') {
        f.authenticate.mockResolvedValue(undefined);
        expected = 401;
      }
      if (kind === 'revoked') {
        f.read.mockRejectedValue(new Error('finance-book-forbidden'));
        expected = 500;
      }
      if (kind === 'unavailable') {
        f.ready.mockResolvedValue(false);
        expected = 503;
      }
      if (kind === 'missing-binding') {
        f.request.url = base;
        expected = 400;
      }
      if (kind === 'wrong-evidence') f.inspection.evidenceId = uuid(8);
      if (kind === 'wrong-run') f.inspection.standardizationRunId = uuid(8);
      if (kind === 'wrong-source') {
        f.inspection.sourceDigest = 'f'.repeat(64);
        f.inspection.inventory.sourceDigest = 'f'.repeat(64);
      }
      if (kind === 'wrong-inventory')
        f.inspection.inventory.sourceDigest = 'f'.repeat(64);
      expect((await f.app.inject(f.request)).statusCode).toBe(expected);
    } finally {
      await f.app.close();
    }
  });
});
