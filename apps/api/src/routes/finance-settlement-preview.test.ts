import { describe, expect, it, vi } from 'vitest';
import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { planInvestmentStockSplitSettlement } from '@emdo/domains/finance';
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
const headers = { cookie: '__Secure-emdo.session_token=current' };
const url = `/api/v2/finance/books/${principal.householdId}/investments/corporate-actions/stock-splits/settlement-preview`;
const fraction = (numerator: string, denominator = '1') => ({
  numerator,
  denominator,
});
const action = {
  id: principal.sessionId,
  actionType: 'reverse-split' as const,
  financialAccountId: principal.userId,
  instrumentId: principal.householdId,
  effectiveOn: '2026-09-13',
  numerator: '1',
  denominator: '3',
  fractionalTreatment: 'cash-in-lieu' as const,
  evidenceId: principal.spaceAccessGrantId,
  sourceReference: 'Broker reverse split advice',
  cashInLieu: {
    consideration: { amount: '30', currency: 'USD' as const },
    evidenceId: principal.spaceAccessGrantId,
    sourceReference: 'Broker cash settlement',
  },
};
const lot = {
  id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f75',
  financialAccountId: action.financialAccountId,
  instrumentId: action.instrumentId,
  acquiredOn: '2026-01-01',
  acquisitionSequence: 1,
  originalQuantity: '5',
  disposedQuantity: '1',
  originalNativeCost: '112.5',
  allocatedNativeCost: '22.5',
  originalFunctionalCost: '168.75',
  allocatedFunctionalCost: '33.75',
  nativeCurrency: 'USD' as const,
  functionalCurrency: 'CAD' as const,
  sourceReference: 'Authoritative acquisition with prior disposal',
};
const allocation = {
  sourceLotId: lot.id,
  retainedQuantity: fraction('1'),
  cashDisposedQuantity: fraction('1', '3'),
  retainedNativeCost: '67.5',
  retainedFunctionalCost: '101.25',
  disposedNativeCost: '22.5',
  disposedFunctionalCost: '33.75',
};
const payload = {
  action,
  expectedSourceRevision: 4,
  sourceSnapshotHash: 'a'.repeat(64),
  deliveredQuantity: fraction('1'),
  cashDisposedQuantity: fraction('1', '3'),
  allocations: [allocation],
  allocationReview: {
    evidenceId: principal.spaceAccessGrantId,
    sourceReference: 'Reviewed broker allocation',
  },
  cashConsideration: {
    native: { amount: '30', currency: 'USD' },
    functional: { amount: '45', currency: 'CAD' },
    evidenceId: principal.spaceAccessGrantId,
    sourceReference: 'Broker cash settlement',
    settledOn: '2026-09-14',
    fx: { rate: '1.5', source: 'Broker settlement FX' },
  },
};

function fixture() {
  const authenticate = vi.fn(
    async (): Promise<AuthenticatedPrincipal | undefined> => principal,
  );
  const auth = {
    authenticate,
    verifyMutation: vi.fn(async () => true),
  } as unknown as ApiServices['auth'];
  const readSource = vi.fn(async () => ({
    sourceRevision: 4,
    sourceSnapshotHash: 'a'.repeat(64),
    sourceAsOf: action.effectiveOn,
    sourceBoundary: 'immediately-before-action' as const,
    sourceLots: [lot],
  }));
  const checkReady = vi.fn(async () => true);
  const financeV2 = {
    checkReady,
    readInvestmentStockSplitSource: readSource,
  } as unknown as NonNullable<ApiServices['financeV2']>;
  return {
    authenticate,
    readSource,
    checkReady,
    services: { ...createFailClosedApiServices({ auth }), financeV2 },
  };
}

describe('Finance settlement commit HTTP authority', () => {
  const key = 'reviewed-settlement-1';
  const {
    action: requestAction,
    expectedSourceRevision,
    sourceSnapshotHash,
    ...details
  } = payload;
  const command = {
    settlement: {
      ...details,
      source: {
        action: requestAction,
        sourceAsOf: requestAction.effectiveOn,
        sourceBoundary: 'immediately-before-action',
        sourceLots: [lot],
      },
    },
    expectedSourceRevision,
    sourceSnapshotHash,
    ledger: {
      cashLedgerAccountId: principal.userId,
      investmentLedgerAccountId: principal.householdId,
      gainLedgerAccountId: principal.sessionId,
      lossLedgerAccountId: principal.spaceAccessGrantId,
      receivableLedgerAccountId: lot.id,
      fxGainLedgerAccountId: principal.sessionId,
      fxLossLedgerAccountId: principal.spaceAccessGrantId,
    },
    actionDateConsideration: null,
    receipt: {
      sourceRowId: principal.sessionId,
      expectedRevision: 1,
      snapshotHash: 'b'.repeat(64),
    },
    evidenceHashes: [
      { evidenceId: principal.spaceAccessGrantId, sha256: 'c'.repeat(64) },
    ],
    idempotencyKey: key,
  };
  const outcome = {
    actionId: action.id,
    workspaceId: principal.householdId,
    bookId: principal.householdId,
    sourceRevision: 4,
    nextSourceRevision: 5,
    sourceSnapshotHash,
    successorLotIds: [lot.id],
    effectCount: 1,
    settlementId: principal.userId,
    economicTransactionId: principal.sessionId,
    journalIds: [principal.userId],
    status: 'committed' as const,
    replayed: false,
  };

  it.each(['found', 'missing', 'wrong-scope'] as const)(
    'reads %s saved results within the current book',
    async (scenario) => {
      const { services } = fixture();
      const saved = {
        result:
          scenario === 'wrong-scope'
            ? { ...outcome, workspaceId: principal.sessionId }
            : outcome,
        settlement: planInvestmentStockSplitSettlement(command.settlement),
        accounting: {
          actionDateFunctionalConsideration: '42',
          settlementDateFunctionalConsideration: '45',
          bookGainLoss: '8.25',
          fxGainLoss: '3',
        },
        createdAt: '2026-09-14T12:00:00.000Z',
      };
      const read = vi.fn(async () => (scenario === 'missing' ? null : saved));
      const app = await createApp({
        services: {
          ...services,
          financeV2: {
            ...services.financeV2!,
            checkStockSplitSettlementReady: vi.fn(async () => true),
            getInvestmentStockSplitSettlement: read,
          },
        },
      });
      try {
        const response = await app.inject({
          method: 'GET',
          headers,
          url: `/api/v2/finance/books/${principal.householdId}/investments/corporate-actions/settlements/${outcome.settlementId}`,
        });
        expect(response.statusCode).toBe(
          scenario === 'found' ? 200 : scenario === 'missing' ? 404 : 503,
        );
        expect(read).toHaveBeenCalledWith(
          expect.objectContaining({
            workspaceId: principal.householdId,
            userId: principal.userId,
          }),
          principal.householdId,
          outcome.settlementId,
        );
        if (scenario === 'found') expect(response.json()).toEqual(saved);
      } finally {
        await app.close();
      }
    },
  );

  it.each([
    'success',
    'not-ready',
    'key-mismatch',
    'wrong-result-scope',
    'csrf-rejected',
  ] as const)('enforces %s at the commit boundary', async (scenario) => {
    const { services } = fixture();
    const commit = vi.fn(async () =>
      scenario === 'wrong-result-scope'
        ? { ...outcome, workspaceId: principal.sessionId }
        : outcome,
    );
    const ready = vi.fn(async () => scenario !== 'not-ready');
    if (scenario === 'csrf-rejected')
      vi.mocked(services.auth.verifyMutation).mockResolvedValueOnce(false);
    const app = await createApp({
      services: {
        ...services,
        financeV2: {
          ...services.financeV2!,
          checkStockSplitSettlementReady: ready,
          commitInvestmentStockSplitSettlement: commit,
        },
      },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: url.replace('settlement-preview', 'settlement-commit'),
        headers: { ...headers, 'idempotency-key': key },
        payload:
          scenario === 'key-mismatch'
            ? { ...command, idempotencyKey: 'different' }
            : command,
      });
      expect(response.statusCode).toBe(
        scenario === 'success'
          ? 200
          : scenario === 'key-mismatch'
            ? 400
            : scenario === 'csrf-rejected'
              ? 403
              : 503,
      );
      if (scenario === 'success') {
        expect(response.json()).toEqual(outcome);
        expect(response.headers['cache-control']).toBe('no-store, private');
        expect(commit).toHaveBeenCalledWith(
          expect.objectContaining({
            workspaceId: principal.householdId,
            userId: principal.userId,
          }),
          principal.householdId,
          command,
        );
      } else if (scenario !== 'wrong-result-scope')
        expect(commit).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('Finance stock split settlement preview HTTP acceptance', () => {
  it('rereads authoritative remaining lots with authenticated scope and returns an exact reviewed plan', async () => {
    const { services, readSource } = fixture();
    const app = await createApp({ services });
    try {
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(readSource).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: principal.householdId,
          userId: principal.userId,
        }),
        principal.householdId,
        action,
      );
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect(response.json()).toEqual({
        sourceRevision: 4,
        sourceSnapshotHash: payload.sourceSnapshotHash,
        plan: {
          calculationVersion: 'investment-corporate-action-settlement.v1',
          actionId: action.id,
          financialAccountId: action.financialAccountId,
          instrumentId: action.instrumentId,
          effectiveOn: action.effectiveOn,
          settledOn: payload.cashConsideration.settledOn,
          accountEntitlement: fraction('4', '3'),
          deliveredQuantity: fraction('1'),
          cashDisposedQuantity: fraction('1', '3'),
          nativeCurrency: 'USD',
          functionalCurrency: 'CAD',
          sourceNativeCost: '90',
          sourceFunctionalCost: '135',
          retainedNativeCost: '67.5',
          retainedFunctionalCost: '101.25',
          disposedNativeCost: '22.5',
          disposedFunctionalCost: '33.75',
          nativeBookGainLoss: '7.5',
          functionalBookGainLoss: '11.25',
          allocations: [allocation],
          cashConsideration: payload.cashConsideration,
          allocationReview: payload.allocationReview,
          status: 'validated-plan',
          persistence: 'not-implemented',
          taxTreatment: 'not-assessed',
        },
      });
    } finally {
      await app.close();
    }
  });

  it('requires authentication before reading source lots', async () => {
    const { services, authenticate, readSource } = fixture();
    authenticate.mockResolvedValueOnce(undefined);
    const app = await createApp({ services });
    try {
      expect(
        (await app.inject({ method: 'POST', url, payload })).statusCode,
      ).toBe(401);
      expect(readSource).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('fails closed when the accounting service is not ready', async () => {
    const { services, checkReady, readSource } = fixture();
    checkReady.mockResolvedValueOnce(false);
    const app = await createApp({ services });
    try {
      expect(
        (await app.inject({ method: 'POST', url, headers, payload }))
          .statusCode,
      ).toBe(503);
      expect(readSource).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    { expectedSourceRevision: 3 },
    { sourceSnapshotHash: 'b'.repeat(64) },
  ])('rejects stale reviewed source tokens: %j', async (stale) => {
    const { services, readSource } = fixture();
    const app = await createApp({ services });
    try {
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { ...payload, ...stale },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'finance-corporate-action-source-conflict',
      });
      expect(readSource).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it.each(['source', 'sourceLots'])(
    'rejects client-injected %s instead of accepting client lot costs',
    async (field) => {
      const { services, readSource } = fixture();
      const app = await createApp({ services });
      try {
        const forgedLots = [{ ...lot, originalNativeCost: '1' }];
        const injected =
          field === 'sourceLots'
            ? forgedLots
            : {
                action,
                sourceAsOf: action.effectiveOn,
                sourceBoundary: 'immediately-before-action',
                sourceLots: forgedLots,
              };
        const response = await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...payload, [field]: injected },
        });
        expect(response.statusCode).toBe(400);
        expect(readSource).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it('rejects allocation costs that do not conserve the authoritative remaining basis', async () => {
    const { services, readSource } = fixture();
    const app = await createApp({ services });
    try {
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: {
          ...payload,
          allocations: [
            {
              ...allocation,
              retainedNativeCost: '0.75',
              disposedNativeCost: '0.25',
            },
          ],
        },
      });
      expect(response.statusCode).toBe(400);
      expect(readSource).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
  it.each([
    ['authorization-revoked', 403],
    ['conflict', 409],
    ['unavailable', 503],
  ] as const)(
    'maps %s persistence failures without exposing internals',
    async (code, status) => {
      const { services, readSource } = fixture();
      readSource.mockRejectedValueOnce(
        Object.assign(new Error('private database details'), {
          name: 'FinanceCorporateActionPersistenceError',
          code,
        }),
      );
      const app = await createApp({ services });
      try {
        const response = await app.inject({
          method: 'POST',
          url,
          headers,
          payload,
        });
        expect(response.statusCode).toBe(status);
        expect(response.body).not.toContain('private database details');
      } finally {
        await app.close();
      }
    },
  );
});
