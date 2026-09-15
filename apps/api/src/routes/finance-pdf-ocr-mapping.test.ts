import { describe, expect, it, vi } from 'vitest';
import {
  EffectiveAuthorizationScopeFingerprintSchema,
  SaveReviewedFinancePdfOcrMappingSchema,
} from '@emdo/contracts';
import { createApp } from '../app.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';
import { financePdfFixture } from '../../../../packages/integrations/src/finance-documents/test-fixtures/pdf.js';
import { extractFinancePdfReport } from '../../../../packages/integrations/src/finance-documents/pdf-report-extraction.js';
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

describe('reviewed PDF OCR mapping HTTP authority', () => {
  it.each([true, false])(
    'forwards source-only candidate with authenticated scope, mutation verified=%s',
    async (verified) => {
      const text = [
        'Date',
        'Memo',
        'Amount',
        'Currency',
        '2026-09-13',
        'Source item',
        '27.13',
        'CAD',
      ];
      const bytes = financePdfFixture([text]);
      const extracted = await extractFinancePdfReport(bytes);
      if (extracted.status !== 'extracted')
        throw new Error('fixture extraction failed');
      const cell = (value: string, index: number) => ({
        region: { x: 0, y: index * 20, width: 100, height: 10 },
        words: [],
        joiner: '',
        reviewedText: value,
        correctionReason: 'Verified original PDF',
        confirmedAgainstOriginal: true,
      });
      const payload = {
        evidenceId: principal.sessionId,
        proposal: {
          rationale: 'Reviewed complete selected source spans',
          unresolvedQuestions: ['Confirm financial interpretation'],
          definition: {
            providerKey: 'pdf-bank',
            reportName: 'PDF activity',
            reportType: 'bank-transactions',
            layoutVersion: '1',
            headers: text.slice(0, 4),
            bindings: [
              'transactionDate',
              'description',
              'amount',
              'currency',
            ].map((field, i) => ({ field, column: text[i], context: null })),
            dateFormat: 'yyyy-mm-dd',
            decimalSeparator: '.',
            groupingSeparator: '',
            quantityUnit: null,
            valuationMultiplier: null,
            identifierScheme: null,
            identifierNamespace: null,
            pdfOcrSelection: {
              expectedSourceDigest: 'a'.repeat(64),
              standardizationRunId: principal.sessionId,
              extractionRevision: 1,
              expectedExtractionDigest: 'b'.repeat(64),
              pageNumber: 1,
              acknowledgeOtherPages: true,
              imageSelection: {
                expectedSourceDigest: 'c'.repeat(64),
                standardizationRunId: principal.sessionId,
                extractionRevision: 1,
                expectedExtractionDigest: 'd'.repeat(64),
                width: 200,
                height: 200,
                coordinateSpace: 'image-pixels-top-left',
                reviewedWordInventoryDigest: 'e'.repeat(64),
                headerCells: text.slice(0, 4).map(cell),
                rows: [{ cells: text.slice(4).map((v, i) => cell(v, i + 4)) }],
                context: { asOf: null, currency: null },
                acknowledgeOcrUncertainty: true,
                acknowledgeUnselectedContent: true,
                confirmedHeaderAndContext: true,
              },
            },
          },
        },
      };
      const saveReportMapping = vi.fn(
        async (
          _scope: unknown,
          _book: unknown,
          _key: unknown,
          input: unknown,
        ) => {
          expect(SaveReviewedFinancePdfOcrMappingSchema.parse(input)).toEqual(
            payload,
          );
          return { id: principal.sessionId, status: 'candidate' };
        },
      );
      const reviewReportMapping = vi.fn();
      const importMappedReport = vi.fn();
      const auth = {
        authenticate: vi.fn(async () => principal),
        verifyMutation: vi.fn(async () => verified),
      } as unknown as ApiServices['auth'];
      const financeV2 = {
        checkReady: async () => true,
        saveReportMapping,
        reviewReportMapping,
        importMappedReport,
      } as unknown as NonNullable<ApiServices['financeV2']>;
      const app = await createApp({
        services: { ...createFailClosedApiServices({ auth }), financeV2 },
      });
      try {
        const result = await app.inject({
          method: 'POST',
          url: `/api/v2/finance/books/${principal.householdId}/report-mappings`,
          headers: {
            cookie: '__Secure-emdo.session_token=current',
            'idempotency-key': 'reviewed-pdf-ocr-candidate',
          },
          payload,
        });
        expect(result.statusCode).toBe(verified ? 200 : 403);
        if (verified)
          expect(saveReportMapping).toHaveBeenCalledWith(
            expect.objectContaining({
              workspaceId: principal.householdId,
              userId: principal.userId,
            }),
            principal.householdId,
            'reviewed-pdf-ocr-candidate',
            payload,
          );
        else expect(saveReportMapping).not.toHaveBeenCalled();
        expect(reviewReportMapping).not.toHaveBeenCalled();
        expect(importMappedReport).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
});
