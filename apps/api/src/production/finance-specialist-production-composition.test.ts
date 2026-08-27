import { describe, expect, it, vi } from 'vitest';

import { AuthenticatedPrincipalSchema } from '../schemas.js';
import type { AuthenticatedPrincipal } from '../services/contracts.js';
import { createProductionFinanceSpecialistComposition } from './finance-specialist-production-composition.js';

const principal = Object.freeze(
  AuthenticatedPrincipalSchema.parse({
    userId: '72000000-0000-4000-8000-000000000001',
    sessionId: '72000000-0000-4000-8000-000000000002',
    householdId: '72000000-0000-4000-8000-000000000003',
    privateSpaceId: '72000000-0000-4000-8000-000000000004',
    role: 'member' as const,
    emailVerified: true as const,
    spaceAccessGrantId: '72000000-0000-4000-8000-000000000005',
    collectionAuthorizationScopeFingerprint: 'a'.repeat(64),
  }),
);

const poolFor = (input: { recordsReady: boolean; documentsReady: boolean }) => {
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('finance_specialist_records_ready')
      ? [{ ready: input.recordsReady }]
      : sql.includes('finance_documents_ready')
        ? [{ ready: input.documentsReady }]
        : [],
    rowCount: 1,
  }));
  return {
    connect: vi.fn(async () => ({ query, release })),
  };
};

const importsFor = (ready: boolean) => ({
  checkReady: vi.fn(async () => ready),
  commit: vi.fn(),
});

const documentGatewayFor = (ready: boolean) => ({
  checkReady: vi.fn(async () => ready),
  createGuardedActionPort: vi.fn(() => ({
    materializeTarget: vi.fn(),
    executeApproved: vi.fn(),
  })),
});

describe('Finance specialist production composition', () => {
  it('requires both bounded record and committed-document persistence', async () => {
    const ready = createProductionFinanceSpecialistComposition({
      pool: poolFor({ recordsReady: true, documentsReady: true }),
      imports: importsFor(true),
      documentGateway: documentGatewayFor(true),
    });
    const unavailable = createProductionFinanceSpecialistComposition({
      pool: poolFor({ recordsReady: true, documentsReady: false }),
      imports: importsFor(true),
      documentGateway: documentGatewayFor(true),
    });

    await expect(ready.checkReady()).resolves.toBe(true);
    await expect(unavailable.checkReady()).resolves.toBe(false);
  });

  it('creates the exact seven Finance services for an uploader-bound member', () => {
    const composition = createProductionFinanceSpecialistComposition({
      pool: poolFor({ recordsReady: true, documentsReady: true }),
      imports: importsFor(true),
      documentGateway: documentGatewayFor(true),
      now: () => new Date('2026-08-26T12:00:00.000Z'),
    });

    expect(
      Object.keys(composition.createForPrincipal(principal)).sort(),
    ).toEqual([
      'executeStatementImport',
      'loadFinanceBudgetInputs',
      'readFinanceDocument',
      'readFinanceMatches',
      'readFinanceRecords',
      'searchFinanceDocuments',
      'writeFinanceRecord',
    ]);
    expect(() =>
      composition.createForPrincipal({
        ...principal,
        privateSpaceId: undefined,
      } as unknown as AuthenticatedPrincipal),
    ).toThrow('api-finance-specialist-composition-unavailable');
  });

  it('keeps guarded Finance actions unavailable when the import receipt boundary is absent', () => {
    expect(() =>
      createProductionFinanceSpecialistComposition({
        pool: poolFor({ recordsReady: true, documentsReady: true }),
      } as never),
    ).toThrow('api-finance-specialist-composition-unavailable');
  });
});
