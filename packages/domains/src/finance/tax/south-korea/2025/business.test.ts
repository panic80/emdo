import { describe, expect, it } from 'vitest';
import {
  calculateSouthKorea2025Corporation,
  calculateSouthKorea2025SoleProprietor,
  evaluateSouthKorea2025CorporationWorkingPapers,
  evaluateSouthKorea2025SoleProprietorWorkingPapers,
  SOUTH_KOREA_2025_CORPORATION_REQUIRED_FACTS,
  SOUTH_KOREA_2025_CORPORATION_SCOPE,
  SOUTH_KOREA_2025_SOLE_PROPRIETOR_REQUIRED_FACTS,
  SOUTH_KOREA_2025_SOLE_PROPRIETOR_SCOPE,
} from './business.js';
import {
  SOUTH_KOREA_2025_CORPORATION_FIXTURES,
  SOUTH_KOREA_2025_SOLE_PROPRIETOR_FIXTURES,
} from './business-fixtures.js';
import {
  findSouthKorea2025CorporateTaxBand,
  southKorea2025CorporateIncomeTax,
} from './tables.js';
import { decimal } from './exact.js';

describe('South Korea 2025 sole-proprietor working papers', () => {
  it('matches every independently authored ledger fixture', () => {
    for (const fixture of SOUTH_KOREA_2025_SOLE_PROPRIETOR_FIXTURES) {
      const result = calculateSouthKorea2025SoleProprietor(fixture.input);
      expect(result.status, fixture.id).toBe('calculated');
      expect(result.selectedComplete, fixture.id).toBe(true);
      expect(result.complete, fixture.id).toBe(false);
      expect(result.reportable, fixture.id).toBe(false);
      expect(result.filingAuthorized, fixture.id).toBe(false);
      expect(result.values, fixture.id).toEqual(fixture.expectedValues);
    }
  });

  it('retains the fractional ledger chain before whole-won reporting', () => {
    const fixture = SOUTH_KOREA_2025_SOLE_PROPRIETOR_FIXTURES.find(
      (candidate) =>
        candidate.id === 'sole-proprietor-fractional-intermediates',
    )!;
    const result = calculateSouthKorea2025SoleProprietor(fixture.input);
    expect(result.exactAmounts['business.netIncome']).toEqual({
      numerator: '700000001',
      denominator: '200',
      exactDecimal: '3500000.005',
    });
    expect(result.values['business.netIncome']).toBe('3500000');
  });

  it('blocks simplified-rate, loss and special-income cases', () => {
    const fixture = SOUTH_KOREA_2025_SOLE_PROPRIETOR_FIXTURES[0]!;
    const result = calculateSouthKorea2025SoleProprietor({
      ...fixture.input,
      usesSimplifiedExpenseRate: true,
    });
    expect(result.status).toBe('blocked-input');
    expect(result.lines).toEqual([]);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unsupported-scope' }),
      ]),
    );
  });

  it('maps a complete generic reviewed-fact envelope to the same chain', () => {
    const input = SOUTH_KOREA_2025_SOLE_PROPRIETOR_FIXTURES[0]!.input;
    const facts = SOUTH_KOREA_2025_SOLE_PROPRIETOR_REQUIRED_FACTS.map(
      (requirement) => ({
        key: requirement.key,
        value:
          requirement.type === 'boolean'
            ? {
                type: 'boolean' as const,
                value: input[
                  requirement.directKey as keyof typeof input
                ] as boolean,
              }
            : {
                type: 'decimal' as const,
                value: String(
                  input[requirement.directKey as keyof typeof input],
                ),
              },
        reviewState: 'reviewed' as const,
        source: {
          kind: 'declaration' as const,
          reference: 'independent sole proprietor fixture',
          revision: 1,
          contentHash: 'a'.repeat(64),
        },
      }),
    );
    const intake = {
      schemaVersion: 1 as const,
      caseId: '00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-000000000002',
      taxSubjectId: '00000000-0000-4000-8000-000000000003',
      legalEntityId: null,
      sourceBooks: [],
      revision: 1,
      scope: { ...SOUTH_KOREA_2025_SOLE_PROPRIETOR_SCOPE },
      domesticResident: true,
      hasCrossBorderActivity: false,
      standaloneCorporation: null,
      requestedFeatures: ['income-tax-return' as const],
      facts,
    };
    const result = evaluateSouthKorea2025SoleProprietorWorkingPapers(intake);
    expect(result.status).toBe('calculated');
    expect(result.values['business.determinedTax']).toBe('3395000');
  });
});

describe('South Korea 2025 standalone corporation working papers', () => {
  it('matches every independently authored corporate fixture', () => {
    for (const fixture of SOUTH_KOREA_2025_CORPORATION_FIXTURES) {
      const result = calculateSouthKorea2025Corporation(fixture.input);
      expect(result.status, fixture.id).toBe('calculated');
      expect(result.selectedComplete, fixture.id).toBe(true);
      expect(result.complete, fixture.id).toBe(false);
      expect(result.reportable, fixture.id).toBe(false);
      expect(result.filingAuthorized, fixture.id).toBe(false);
      expect(result.values, fixture.id).toEqual(fixture.expectedValues);
    }
  });

  it('uses exact published corporation rate boundaries', () => {
    expect(findSouthKorea2025CorporateTaxBand(decimal('200000000')).id).toBe(
      'up-to-200-million',
    );
    expect(findSouthKorea2025CorporateTaxBand(decimal('200000000.01')).id).toBe(
      'over-200-million-to-20-billion',
    );
    expect(
      southKorea2025CorporateIncomeTax(decimal('200000000.01')).amount,
    ).toEqual({
      n: 180000000019n,
      d: 10000n,
    });
  });

  it('blocks tax-adjustment and group cases', () => {
    const fixture = SOUTH_KOREA_2025_CORPORATION_FIXTURES[0]!;
    const result = calculateSouthKorea2025Corporation({
      ...fixture.input,
      consolidatedGroup: true,
    });
    expect(result.status).toBe('blocked-input');
    expect(result.lines).toEqual([]);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unsupported-scope' }),
      ]),
    );
  });

  it('requires the exact standalone-corporation generic scope', () => {
    expect(SOUTH_KOREA_2025_CORPORATION_SCOPE.taxpayerType).toBe('corporation');
    expect(SOUTH_KOREA_2025_CORPORATION_REQUIRED_FACTS.length).toBeGreaterThan(
      0,
    );
    const result = evaluateSouthKorea2025CorporationWorkingPapers({});
    expect(result.status).toBe('blocked-input');
    expect(result.issues[0]?.code).toBe('invalid-intake');
  });
});
