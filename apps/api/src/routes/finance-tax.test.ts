import { describe, expect, it, vi } from 'vitest';
import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { FinanceTaxPersistenceError } from '@emdo/db/api';
import { createApp } from '../app.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';
const id = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70';
const principal: AuthenticatedPrincipal = {
  userId: id,
  sessionId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71',
  householdId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f72',
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f74',
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('7'.repeat(64)),
};
const headers = {
  cookie: '__Secure-emdo.session_token=current',
  'idempotency-key': id,
};
const base = '/api/v2/finance/tax/cases';
const answer = {
  expectedCaseRevision: 7,
  expectedAnswerRevision: null,
  sourceId: id,
  expectedSourceRevision: 3,
  relatedPartyId: null,
};
async function fixture(
  options: {
    authenticated?: boolean;
    verified?: boolean;
    ready?: boolean;
    taxReady?: boolean;
    missing?: boolean;
    error?: Error;
  } = {},
) {
  const call = () =>
    vi.fn(async () => {
      if (options.error) throw options.error;
      return { status: 'incomplete', revision: 8 };
    });
  const tax = {
    getWageEvidencePreparation: call(),
    getWageOriginal: call(),
    reviewWageEvidence: call(),
    getWorkingPaperPreparation: call(),
    reviewWorkingPaperInputs: call(),
    createCalculationRun: call(),
    listCalculationRuns: vi.fn(async () => []),
    getCalculationRun: call(),
    reviewCalculationRun: call(),
    exportCalculationRun: call(),
    checkReady: vi.fn(async () => options.taxReady !== false),
    resetInputsAfterSourceRevocation: call(),
    bindLegalEntity: call(),
    createCase: call(),
    listCases: vi.fn(async () => []),
    getCase: call(),
    assessCase: call(),
    recordDeclaration: call(),
    listDeclarations: call(),
    listCaseGrants: call(),
    saveAnswer: call(),
    reviewAnswer: call(),
    withdrawAnswer: call(),
    grantCaseAccess: call(),
    revokeCaseAccess: call(),
    authorizeBookSource: call(),
    revokeBookSource: call(),
  };
  const auth = {
    authenticate: vi.fn(async () =>
      options.authenticated === false ? null : principal,
    ),
    verifyMutation: vi.fn(async () => options.verified !== false),
  } as unknown as ApiServices['auth'];
  const services = {
    ...createFailClosedApiServices({ auth }),
    financeV2: {
      checkReady: async () => options.ready !== false,
    } as NonNullable<ApiServices['financeV2']>,
    ...(options.missing
      ? {}
      : {
          financeTax: tax as unknown as NonNullable<ApiServices['financeTax']>,
        }),
  };
  return { app: await createApp({ services }), tax };
}
describe('private case-scoped tax routes', () => {
  it('pins wage evidence reviews to saved sources and rejects browser authority claims', async () => {
    const { app, tax } = await fixture();
    const input = {
      workflowId: 'us-fed-2025-working-papers',
      expectedPackageVersion: '2025.3-federal-working-papers',
      expectedCaseRevision: 7,
      expectedSnapshotHash: 'a'.repeat(64),
      input: { sourceId: id, sourceRevision: 2, contentHash: 'b'.repeat(64) },
      acknowledgement: 'verified-saved-boxes-against-original-documents',
    };
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/working-papers/wage-evidence-reviews`,
            headers,
            payload: input,
          })
        ).statusCode,
      ).toBe(200);
      expect(tax.reviewWageEvidence).toHaveBeenCalledWith(
        expect.objectContaining({ userId: principal.userId }),
        id,
        id,
        input,
      );
      for (const field of [
        'boxes',
        'reviewedBy',
        'bytes',
        'permission',
        'manifestHash',
      ])
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${base}/${id}/working-papers/wage-evidence-reviews`,
              headers,
              payload: { ...input, [field]: 'untrusted' },
            })
          ).statusCode,
        ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `${base}/${id}/working-papers/wage-evidence`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `${base}/${id}/working-papers/wage-original?bookId=${id}&evidenceId=${id}`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it.each([
    'ca-on-2025-personal-working-papers',
    'ca-on-2025-corporate-working-papers',
    'us-fed-2025-working-papers',
  ])(
    'authenticates and pins %s mutations; rejects caller outputs and review identities',
    async (workflowId) => {
      const { app, tax } = await fixture();
      const input = {
        workflowId,
        expectedPackageVersion: '2025.1-personal-workflow.3',
        expectedCaseRevision: 7,
        expectedSnapshotHash: 'a'.repeat(64),
      };
      try {
        const created = await app.inject({
          method: 'POST',
          url: `${base}/${id}/runs`,
          headers,
          payload: input,
        });
        expect(created.statusCode).toBe(200);
        expect(tax.createCalculationRun).toHaveBeenCalledWith(
          expect.objectContaining({ userId: principal.userId }),
          id,
          id,
          input,
        );
        for (const field of ['output', 'createdBy', 'package', 'facts'])
          expect(
            (
              await app.inject({
                method: 'POST',
                url: `${base}/${id}/runs`,
                headers,
                payload: { ...input, [field]: {} },
              })
            ).statusCode,
          ).toBe(400);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${base}/${id}/runs/${id}/reviews`,
              headers,
              payload: {
                expectedOutputHash: 'b'.repeat(64),
                acknowledgement:
                  'reviewed-incomplete-working-papers-not-fileable',
              },
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${base}/${id}/runs/${id}/reviews`,
              headers,
              payload: {
                expectedOutputHash: 'b'.repeat(64),
                acknowledgement: 'complete',
              },
            })
          ).statusCode,
        ).toBe(400);
        for (const path of [
          'working-papers',
          'runs',
          `runs/${id}`,
          `runs/${id}/export?reviewId=${id}`,
        ]) {
          const result = await app.inject({
            method: 'GET',
            url: `${base}/${id}/${path}`,
            headers,
          });
          expect(result.statusCode).toBe(200);
          expect(result.headers['cache-control']).toBe('no-store, private');
        }
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `${base}/${id}/runs/${id}/export`,
              headers,
            })
          ).statusCode,
        ).toBe(400);
      } finally {
        await app.close();
      }
    },
  );
  it('creates intake-only cases without caller-invented rule package identifiers', async () => {
    const { app, tax } = await fixture();
    const payload = {
      mode: 'intake-only',
      title: 'Personal return inputs',
      taxSubjectName: 'Taxpayer',
      scope: {
        country: 'CA',
        subdivision: 'ON',
        taxpayerType: 'individual',
        year: 2025,
        regime: 'resident',
        formVersion: '2025',
      },
      domesticResident: true,
      hasCrossBorderActivity: false,
      standaloneCorporation: null,
      relatedParties: [],
    };
    try {
      const response = await app.inject({
        method: 'POST',
        url: base,
        headers,
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(tax.createCase).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: principal.householdId,
          userId: principal.userId,
        }),
        id,
        payload,
      );
      for (const invalid of [
        { ...payload, packageId: 'invented', packageVersion: '1' },
        { ...payload, mode: 'complete-return' },
        { ...payload, enabled: true },
        { ...payload, workspaceId: id },
      ]) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: base,
              headers,
              payload: invalid,
            })
          ).statusCode,
        ).toBe(400);
      }
      expect(tax.createCase).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('keeps grant inspection private and delegates only the authenticated case scope', async () => {
    const { app, tax } = await fixture({
      error: new FinanceTaxPersistenceError('forbidden', 'private-owner-only'),
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `${base}/${id}/grants`,
        headers,
      });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain('private-owner-only');
      expect(tax.listCaseGrants).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: principal.householdId,
          userId: principal.userId,
        }),
        id,
      );
      const invalid = await app.inject({
        method: 'GET',
        url: `${base}/${id}/grants?userId=${id}`,
        headers,
      });
      expect(invalid.statusCode).toBe(400);
      expect(tax.listCaseGrants).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('creates an explicitly scoped incomplete case and exposes read-only assessment and declarations', async () => {
    const { app, tax } = await fixture();
    const payload = {
      title: 'Private preparation',
      taxSubjectName: 'Subject',
      scope: {
        country: 'CA',
        subdivision: 'ON',
        taxpayerType: 'individual',
        year: 2026,
        regime: 'resident',
        formVersion: '2026',
      },
      domesticResident: null,
      hasCrossBorderActivity: null,
      standaloneCorporation: null,
      packageId: 'package',
      packageVersion: '1',
      relatedParties: [],
    };
    try {
      const result = await app.inject({
        method: 'POST',
        url: base,
        headers,
        payload,
      });
      expect(result.statusCode).toBe(200);
      expect(tax.createCase).toHaveBeenCalledWith(
        expect.objectContaining({ userId: id }),
        id,
        payload,
      );
      for (const [path, method] of [
        ['assessment', 'assessCase'],
        ['declarations', 'listDeclarations'],
        ['grants', 'listCaseGrants'],
      ] as const) {
        const response = await app.inject({
          method: 'GET',
          url: `${base}/${id}/${path}`,
          headers,
        });
        expect(response.statusCode).toBe(200);
        expect(tax[method]).toHaveBeenCalledWith(expect.any(Object), id);
        expect(response.headers['cache-control']).toBe('no-store, private');
      }
      expect(
        (await app.inject({ method: 'GET', url: `${base}?limit=101`, headers }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/grants`,
            headers,
            payload: { userId: id, role: 'owner', expectedGrantRevision: null },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('forwards trusted identity, exact source and case revisions without book context', async () => {
    const { app, tax } = await fixture();
    try {
      const result = await app.inject({
        method: 'POST',
        url: `${base}/${id}/answers`,
        headers,
        payload: answer,
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ status: 'incomplete', revision: 8 });
      expect(tax.saveAnswer).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: principal.householdId,
          userId: principal.userId,
          sessionId: principal.sessionId,
        }),
        id,
        id,
        answer,
      );
      expect(result.headers['cache-control']).toBe('no-store, private');
      await app.inject({
        method: 'GET',
        url: `${base}/${id}?revision=4`,
        headers,
      });
      expect(tax.getCase).toHaveBeenCalledWith(expect.any(Object), id, 4);
      await app.inject({
        method: 'GET',
        url: `${base}?offset=2&limit=10`,
        headers,
      });
      expect(tax.listCases).toHaveBeenCalledWith(expect.any(Object), 2, 10);
    } finally {
      await app.close();
    }
  });
  it.each([
    { authenticated: false, status: 401 },
    { verified: false, status: 403 },
    { ready: false, status: 503 },
    { taxReady: false, status: 503 },
    { missing: true, status: 503 },
  ])('fails closed for %j', async (options) => {
    const { app, tax } = await fixture(options);
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${base}/${id}/answers`,
        headers,
        payload: answer,
      });
      expect(response.statusCode).toBe(options.status);
      expect(tax.saveAnswer).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each([
    { payload: { ...answer, access: { actorId: id } } },
    { payload: { ...answer, expectedCaseRevision: 0 } },
    { payload: answer, key: 'not-a-uuid' },
    { payload: answer, caseId: 'bad-id' },
  ])('rejects malformed or caller-authority payload %j', async (input) => {
    const { app, tax } = await fixture();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${base}/${input.caseId ?? id}/answers`,
        headers: { ...headers, 'idempotency-key': input.key ?? id },
        payload: input.payload,
      });
      expect(response.statusCode).toBe(400);
      expect(tax.saveAnswer).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each([
    ['forbidden', 403],
    ['conflict', 409],
    ['source-revoked', 409],
    ['invalid-input', 400],
  ] as const)(
    'maps persistence %s without exposing private details',
    async (code, status) => {
      const { app } = await fixture({
        error: new FinanceTaxPersistenceError(code, 'private source value'),
      });
      try {
        const response = await app.inject({
          method: 'POST',
          url: `${base}/${id}/answers`,
          headers,
          payload: answer,
        });
        expect(response.statusCode).toBe(status);
        expect(response.body).not.toContain('private source value');
      } finally {
        await app.close();
      }
    },
  );
  it('maps questionnaire revision conflicts and protects reads from anonymous access', async () => {
    const { app } = await fixture({
      error: new Error('finance-tax-questionnaire-answer-revision-conflict'),
    });
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/answers`,
            headers,
            payload: answer,
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
    const anonymous = await fixture({ authenticated: false });
    try {
      expect(
        (await anonymous.app.inject({ method: 'GET', url: base, headers }))
          .statusCode,
      ).toBe(401);
      expect(anonymous.tax.listCases).not.toHaveBeenCalled();
    } finally {
      await anonymous.app.close();
    }
  });
  it.each([
    [
      'legal-entity',
      'bindLegalEntity',
      { expectedCaseRevision: 7, legalEntityId: id },
    ],
    [
      'reset-after-source-revocation',
      'resetInputsAfterSourceRevocation',
      { expectedCaseRevision: 7 },
    ],
    [
      'declarations',
      'recordDeclaration',
      {
        expectedCaseRevision: 7,
        expectedSourceRevision: null,
        factKey: 'residency',
        category: 'residency',
        value: { type: 'boolean', value: true },
      },
    ],
    [
      'answers/review',
      'reviewAnswer',
      {
        expectedCaseRevision: 7,
        expectedAnswerRevision: 2,
        factKey: 'residency',
        decision: 'reviewed',
      },
    ],
    [
      'answers/withdraw',
      'withdrawAnswer',
      {
        expectedCaseRevision: 7,
        expectedAnswerRevision: 2,
        factKey: 'residency',
      },
    ],
    [
      'grants',
      'grantCaseAccess',
      { userId: id, role: 'viewer', expectedGrantRevision: null },
    ],
    [
      'grants/revoke',
      'revokeCaseAccess',
      { userId: id, expectedGrantRevision: 2 },
    ],
    [
      'book-sources',
      'authorizeBookSource',
      { bookId: id, expectedCaseRevision: 7 },
    ],
  ] as const)(
    'forwards explicit %s revision command',
    async (path, method, payload) => {
      const { app, tax } = await fixture();
      try {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${base}/${id}/${path}`,
              headers,
              payload,
            })
          ).statusCode,
        ).toBe(200);
        expect(tax[method]).toHaveBeenCalledWith(
          expect.any(Object),
          id,
          id,
          payload,
        );
      } finally {
        await app.close();
      }
    },
  );
  it('revokes a specific book source authorization revision', async () => {
    const { app, tax } = await fixture();
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/book-sources/${id}/revoke`,
            headers,
            payload: { expectedAuthorizationRevision: 3 },
          })
        ).statusCode,
      ).toBe(200);
      expect(tax.revokeBookSource).toHaveBeenCalledWith(
        expect.any(Object),
        id,
        id,
        id,
        3,
      );
    } finally {
      await app.close();
    }
  });
});
