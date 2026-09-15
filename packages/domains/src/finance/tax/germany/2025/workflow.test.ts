import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type FinanceTaxIntake } from '@emdo/contracts';
import {
  evaluateGermany2025WorkingPapers,
  GERMANY_2025_CANDIDATE,
  GERMANY_2025_FORM_DEFINITIONS,
  GERMANY_2025_REQUIRED_FACTS,
  incomeTax2025,
  solidaritySurcharge2025,
} from './workflow.js';
import { formatEuros, q } from './exact.js';
import { GERMANY_2025_SOURCES } from './sources.js';

function fixture(
  overrides: Record<string, string | boolean> = {},
): FinanceTaxIntake {
  const values: Record<string, string | boolean> = {
    'employment.grossWages': '50000',
    ...overrides,
  };
  return {
    schemaVersion: 1,
    caseId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    taxSubjectId: '00000000-0000-4000-8000-000000000003',
    legalEntityId: null,
    sourceBooks: [],
    revision: 1,
    scope: { ...GERMANY_2025_CANDIDATE.scope },
    domesticResident: true,
    hasCrossBorderActivity: false,
    standaloneCorporation: null,
    requestedFeatures: ['income-tax-return'],
    facts: GERMANY_2025_REQUIRED_FACTS.map((definition) => {
      const value =
        values[definition.key] ??
        ('equals' in definition
          ? definition.equals
          : definition.key === 'business.kind'
            ? 'professional'
            : definition.type === 'boolean'
              ? false
              : definition.type === 'text'
                ? 'declared'
                : '0');
      return {
        key: definition.key,
        reviewState: 'reviewed',
        value: {
          type: definition.type,
          value,
        } as FinanceTaxIntake['facts'][number]['value'],
        source: {
          kind: 'declaration',
          reference: 'Independently reviewed Germany 2025 fixture',
          revision: 1,
          contentHash: 'a'.repeat(64),
        },
      };
    }),
  };
}

function lines(input: FinanceTaxIntake) {
  const result = evaluateGermany2025WorkingPapers(input);
  return {
    result,
    values: Object.fromEntries(
      result.evaluation.forms.flatMap((form) =>
        form.fields.map((field) => [
          `${form.id}.${field.key}`,
          field.value.value,
        ]),
      ),
    ),
  };
}

describe('Germany 2025 federal income-tax working papers', () => {
  it('uses the official §32a tariff boundaries and independent exact formulas', () => {
    expect(incomeTax2025(12096n).n).toBe(0n);
    expect(incomeTax2025(12097n).n).toBe(0n);
    expect(incomeTax2025(17443n).n).toBe(1015n);
    expect(incomeTax2025(17444n).n).toBe(1015n);
    expect(incomeTax2025(68480n).n).toBe(17849n);
    expect(incomeTax2025(68481n).n).toBe(17850n);
    expect(incomeTax2025(277825n).n).toBe(105774n);
    expect(incomeTax2025(277826n).n).toBe(105775n);
  });

  it('calculates a professional activity with employment, insurance, tax and settlement chain', () => {
    const { result, values } = lines(
      fixture({
        'employment.grossWages': '60000',
        'employment.workExpensesActual': '1500',
        'business.grossReceipts': '40000',
        'business.expense.advertising': '1000',
        'business.expense.professionalFees': '2000',
        'business.expense.rent': '3000',
        'business.expense.utilities': '500',
        'business.expense.insurance': '1000',
        'business.expense.office': '500',
        'business.expense.travel': '500',
        'business.expense.supplies': '500',
        'insurance.pensionEmployee': '5000',
        'insurance.healthWithSickPay': '4000',
        'insurance.healthWithoutSickPay': '1000',
        'insurance.longTermCare': '1200',
        'insurance.healthRefunds': '100',
        'employment.incomeTaxWithheld': '20000',
      }),
    );
    expect(values).toMatchObject({
      'AnlageN.workExpenses': '1500.00',
      'AnlageN.employmentIncome': '58500.00',
      'AnlageS.deductibleExpenses': '9000.00',
      'AnlageS.profit': '31000.00',
      'Vorsorgeaufwand.healthContributions': '4840.00',
      'Vorsorgeaufwand.eligibleVorsorge': '10940.00',
      'ESt1A.totalIncome': '89500.00',
      'ESt1A.specialDeductions': '10976.00',
      'ESt1A.taxableIncome': '78524.00',
      'ESt1A.incomeTax': '22068.00',
      'ESt1A.solidaritySurcharge': '252.04',
      'ESt1A.balanceDue': '2320.04',
      'ESt1A.refund': '0.00',
    });
    expect(result.evaluation.forms.some((form) => form.id === 'AnlageG')).toBe(
      false,
    );
    const settlement = result.trace.find(
      (row) => row.formId === 'ESt1A' && row.line === 'balanceDue',
    )!;
    expect(settlement.sourceFactKeys).toContain('employment.incomeTaxWithheld');
    expect(settlement.sourceFactKeys).toContain('insurance.healthWithSickPay');
    expect(settlement.referenceIds).toContain('de-solzg-2025');
    expect(result.complete).toBe(false);
    expect(result.status).toBe('incomplete-working-papers');
    expect(
      result.evaluation.issues.some(
        (issue) =>
          issue.code === 'independent-complete-return-validation-not-complete',
      ),
    ).toBe(true);
  });

  it('routes a trade to Anlage G and applies Gewerbesteuer plus the §35 credit', () => {
    const { result, values } = lines(
      fixture({
        'business.kind': 'trade',
        'business.municipalityHebesatz': '400',
        'employment.grossWages': '60000',
        'business.grossReceipts': '70000',
        'business.expense.advertising': '10000',
      }),
    );
    expect(values).toMatchObject({
      'AnlageG.profit': '60000.00',
      'AnlageG.gewerbeertrag': '60000.00',
      'AnlageG.tradeTaxMeasure': '1242.00',
      'AnlageG.tradeTax': '4968.00',
      'AnlageG.incomeTaxReduction35': '4968.00',
    });
    expect(result.evaluation.forms.some((form) => form.id === 'AnlageS')).toBe(
      false,
    );
    expect(values['ESt1A.incomeTax']).toBe('33988.00');
    expect(values['ESt1A.solidaritySurcharge']).toBe('1670.52');
  });

  it('applies the 2025 employee allowance only when actual expenses are lower', () => {
    expect(
      lines(fixture({ 'employment.grossWages': '2000' })).values[
        'AnlageN.workExpenses'
      ],
    ).toBe('1230.00');
    expect(
      lines(fixture({ 'employment.workExpensesActual': '1230' })).values[
        'AnlageN.workExpenses'
      ],
    ).toBe('1230.00');
    expect(
      lines(fixture({ 'employment.workExpensesActual': '1230.01' })).values[
        'AnlageN.workExpenses'
      ],
    ).toBe('1230.01');
  });

  it('uses the single solidarity-surcharge threshold and cap with cents omitted', () => {
    expect(solidaritySurcharge2025(q(19950n)).n).toBe(0n);
    expect(formatEuros(solidaritySurcharge2025(q(20000n)))).toBe('5.95');
    expect(solidaritySurcharge2025(q(40000n)).n).toBe(2200n);
  });

  it.each(['missing', 'unreviewed', 'extra', 'negative', 'church', 'other'])(
    'fails closed for %s input',
    (problem) => {
      const input = fixture();
      if (problem === 'missing') input.facts.pop();
      if (problem === 'unreviewed') input.facts[0]!.reviewState = 'unreviewed';
      if (problem === 'extra')
        input.facts.push({ ...input.facts[0]!, key: 'unmapped-income' });
      if (problem === 'negative')
        input.facts.find(
          (fact) => fact.key === 'business.grossReceipts',
        )!.value = { type: 'decimal', value: '-1' };
      if (problem === 'church')
        input.facts.find((fact) => fact.key === 'churchTax.member')!.value = {
          type: 'boolean',
          value: true,
        };
      if (problem === 'other')
        input.facts.find((fact) => fact.key === 'other.income')!.value = {
          type: 'boolean',
          value: true,
        };
      const { result } = lines(input);
      expect(result.complete).toBe(false);
      expect(result.status).toBe('blocked-input');
      expect(result.evaluation.forms).toEqual([]);
      expect(result.evaluation.issues.length).toBeGreaterThan(0);
    },
  );

  it('requires an explicit municipality rate for trade and preserves professional/trade distinction', () => {
    const result = evaluateGermany2025WorkingPapers(
      fixture({ 'business.kind': 'trade' }),
    );
    expect(result.status).toBe('blocked-input');
    expect(
      result.evaluation.issues.some(
        (issue) => issue.code === 'invalid-municipality-rate',
      ),
    ).toBe(true);
  });

  it('binds source captures to their declared hashes', () => {
    const sourceDir = new URL('./sources/', import.meta.url);
    const files: Record<string, string> = {
      'de-estg-2025': 'estg-current.pdf',
      'de-solzg-2025': 'bmf-lsth-2025-solzg.html',
      'de-gewstg-2025': 'gewstg-current.pdf',
      'de-bmf-32a-2025': 'bmf-lsth-2025-estg-32a.html',
      'de-bmf-9a-2025': 'bmf-lsth-2025-estg-9a.html',
      'de-bmf-35-2025': 'bmf-esth-2025-estg-35.html',
      'de-bmf-tax-changes-2025': 'bmf-tax-changes-2025.html',
      'de-bmf-tariff-table-2025': 'bmf-esth-2025-table.html',
      'de-bmf-vorsorge-2025': 'bmf-esth-2025-vorsorge.html',
      'de-elster-forms-2025': 'elster-income-tax-instructions-2025.html',
      'de-elster-form-catalogue-2025': 'elster-all-forms.html',
      'de-est1a-2025': 'est1a-2025-forms-and-instructions.pdf',
      'de-bmf-pap-2025': 'bmf-pap-2025.html',
    };
    for (const source of GERMANY_2025_SOURCES) {
      const file = files[source.id];
      if (!file) continue;
      const bytes = readFileSync(new URL(file, sourceDir));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        source.documentHash,
      );
    }
  });

  it('keeps the candidate disabled and advertises unresolved return coverage', () => {
    expect(GERMANY_2025_CANDIDATE.enabled).toBe(false);
    expect(GERMANY_2025_CANDIDATE.registryEligible).toBe(false);
    expect(GERMANY_2025_CANDIDATE.complete).toBe(false);
    expect(GERMANY_2025_CANDIDATE.releaseBlockers).toContain(
      'church-tax-and-religion-specific-handling-not-implemented',
    );
    expect(GERMANY_2025_FORM_DEFINITIONS.length).toBe(5);
  });
});
