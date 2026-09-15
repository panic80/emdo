import { describe, expect, it, vi } from 'vitest';
import {
  EffectiveAuthorizationScopeFingerprintSchema,
  SaveFinanceReportMappingFromSourceSchema,
} from '@emdo/contracts';
import { createApp } from '../app.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';

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

const payload = SaveFinanceReportMappingFromSourceSchema.parse({
  evidenceId: principal.sessionId,
  expectedSourceDigest: 'a'.repeat(64),
  proposal: {
    definition: {
      providerKey: 'csv-bank',
      reportName: 'CSV activity',
      reportType: 'bank-transactions',
      layoutVersion: '1',
      headers: ['Date', 'Description', 'Amount', 'Currency'],
      bindings: [
        { field: 'transactionDate', column: 'Date', context: null },
        { field: 'description', column: 'Description', context: null },
        { field: 'amount', column: 'Amount', context: null },
        { field: 'currency', column: 'Currency', context: null },
      ],
      dateFormat: 'yyyy-mm-dd',
      decimalSeparator: '.',
      groupingSeparator: '',
      quantityUnit: null,
      valuationMultiplier: null,
      identifierScheme: null,
      identifierNamespace: null,
    },
    rationale: 'The source headings were checked against the bank export.',
    unresolvedQuestions: [],
  },
});

function fixture(verified: boolean) {
  const auth = {
    authenticate: vi.fn(async () => principal),
    verifyMutation: vi.fn(async () => verified),
  } as unknown as ApiServices['auth'];
  const saveSourceReportMapping = vi.fn(async () => ({
    id: principal.sessionId,
    version: 1,
    revision: 1,
    status: 'candidate',
    validationStatus: 'normalized',
    modelProvenance: null,
  }));
  const financeV2 = {
    checkReady: async () => true,
    saveSourceReportMapping,
  } as unknown as NonNullable<ApiServices['financeV2']>;
  return {
    saveSourceReportMapping,
    services: {
      ...createFailClosedApiServices({ auth }),
      financeV2,
    },
  };
}

describe('CSV report mapping source boundary', () => {
  it.each([true, false])(
    'requires current mutation verification and forwards only the declarative source request, verified=%s',
    async (verified) => {
      const { services, saveSourceReportMapping } = fixture(verified);
      const app = await createApp({ services });
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v2/finance/books/${principal.householdId}/report-mappings/from-source`,
          headers: {
            cookie: '__Secure-emdo.session_token=current',
            'idempotency-key': 'csv-source-candidate',
          },
          payload,
        });
        expect(response.statusCode).toBe(verified ? 200 : 403);
        if (verified) {
          expect(saveSourceReportMapping).toHaveBeenCalledWith(
            expect.objectContaining({
              workspaceId: principal.householdId,
              userId: principal.userId,
            }),
            principal.householdId,
            'csv-source-candidate',
            payload,
          );
          expect(response.headers['cache-control']).toBe('no-store, private');
        } else expect(saveSourceReportMapping).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it('rejects model or browser supplied example rows at the route boundary', async () => {
    const { services, saveSourceReportMapping } = fixture(true);
    const app = await createApp({ services });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v2/finance/books/${principal.householdId}/report-mappings/from-source`,
        headers: {
          cookie: '__Secure-emdo.session_token=current',
          'idempotency-key': 'csv-source-example',
        },
        payload: { ...payload, example: {} },
      });
      expect(response.statusCode).toBe(400);
      expect(saveSourceReportMapping).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
