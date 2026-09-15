import {
  deepFreeze,
  type FinanceTaxEvaluation,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import { createHash } from 'node:crypto';
import {
  evaluateFrance2025Return,
  FRANCE_2025_CANDIDATE,
  FRANCE_2025_FIELD_DEFINITIONS,
  FRANCE_2025_REQUIRED_FACTS,
  FRANCE_2025_SCOPE,
  FRANCE_2025_VERSION,
} from './workflow.js';
export {
  FRANCE_2025_PLATFORM_CONTRACT_NEEDS,
  FRANCE_2025_SELECTED_FIELD_CATALOG,
  FRANCE_2025_SELECTED_REQUIRED_FACTS,
  FRANCE_2025_SELECTED_RETURN_GAPS,
  FRANCE_2025_SELECTED_RETURN_METADATA,
  FRANCE_2025_SELECTED_RETURN_VERSION,
  FRANCE_2025_SELECTED_SCOPES,
  FRANCE_2025_SELECTED_RULES,
  assessFrance2025SelectedReturnFacts,
  buildFrance2025SelectedFormApplicability,
  evaluateFrance2025SelectedReturn,
  exportFrance2025Return,
  runFrance2025SelectedReturn,
  serializeFrance2025ReturnExport,
} from './full-return.js';
export type {
  France2025CorporationCalculation,
  France2025ReturnExport,
  France2025ReturnKind,
  France2025SelectedCalculation,
  France2025SelectedFactRequirement,
  France2025SelectedFieldDecision,
  France2025SelectedFormApplicability,
  France2025SelectedFormCoverage,
  France2025SelectedFormField,
  France2025SelectedIssue,
  France2025SelectedReturnRun,
  France2025SoleProprietorCalculation,
} from './full-return.js';

/** Stable implementation identity for the development-only candidate. */
export const FRANCE_2025_IMPLEMENTATION_HASH =
  'c8bb486d3f330f9b239cc08e4629b026014eb8399ec2d9e7d76381183d05b9a4';

/**
 * Development metadata for a future explicit registry owner. This deliberately
 * has no full-return manifest or registration side effect: the candidate is
 * bounded and remains unavailable until its release gaps are cleared.
 */
export const FRANCE_2025_PACKAGE = deepFreeze({
  packageId: FRANCE_2025_CANDIDATE.id,
  version: FRANCE_2025_VERSION,
  scope: { ...FRANCE_2025_SCOPE },
  implementationHash: FRANCE_2025_IMPLEMENTATION_HASH,
  fieldIds: FRANCE_2025_FIELD_DEFINITIONS.map((field) => field.key),
  requiredFactKeys: FRANCE_2025_REQUIRED_FACTS.map((fact) => fact.key),
});

const digest = (value: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, entry) =>
        typeof entry === 'bigint' ? `${entry}n` : entry,
      ),
    )
    .digest('hex');

const source = {
  kind: 'declaration' as const,
  reference: 'Independently reviewed France 2025-income fixture',
  revision: 1,
  contentHash: 'a'.repeat(64),
};

const ids = {
  caseId: '00000000-0000-4000-8000-000000000101',
  workspaceId: '00000000-0000-4000-8000-000000000102',
  taxSubjectId: '00000000-0000-4000-8000-000000000103',
};

type FixtureOverrides = {
  salary: string;
  pas: string;
  children: string;
  raisingAlone: boolean;
  livesAlone: boolean;
};

function fixtureIntake(overrides: FixtureOverrides): FinanceTaxIntake {
  const values: Record<string, string | boolean> = {
    'residency.region': 'metropolitan-france',
    'filing.incomeYear': '2025',
    'filing.declarationYear': '2026',
    'employment.incomeType': 'ordinary-salary',
    'employment.employerCount': '1',
    'employment.grossSalary': overrides.salary,
    'deduction.method': 'standard-10-percent',
    'deduction.actualExpenses': '0',
    'income.otherTaxableIncome': '0',
    'income.otherDeductions': '0',
    'income.otherCredits': '0',
    'income.foreignTaxCredit': '0',
    'income.exceptionalOrDeferred': '0',
    'income.advanceOrInstalments': '0',
    'pas.calendarYear': '2025',
    'pas.withheld': overrides.pas,
    'family.status': 'single',
    'family.dependentChildren': overrides.children,
    'family.raisingFirstChildAlone': overrides.raisingAlone,
    'family.livesAlone': overrides.livesAlone,
    'family.alternatingResidence': false,
    'family.otherDependants': '0',
    'family.specialHalfParts': false,
    'family.invalidityOrVeteran': false,
    'family.formerSingleParent': false,
  };
  return {
    schemaVersion: 1,
    ...ids,
    legalEntityId: null,
    sourceBooks: [],
    revision: 1,
    scope: { ...FRANCE_2025_SCOPE },
    domesticResident: true,
    hasCrossBorderActivity: false,
    standaloneCorporation: null,
    requestedFeatures: ['income-tax-return'],
    facts: FRANCE_2025_REQUIRED_FACTS.map((requirement) => {
      const raw = values[requirement.key];
      const value =
        requirement.type === 'boolean'
          ? { type: 'boolean' as const, value: raw as boolean }
          : requirement.type === 'decimal'
            ? { type: 'decimal' as const, value: raw as string }
            : requirement.type === 'text'
              ? { type: 'text' as const, value: raw as string }
              : { type: 'date' as const, value: raw as string };
      return {
        key: requirement.key,
        value,
        reviewState: 'reviewed' as const,
        source,
      };
    }),
  };
}

/**
 * Expected values are written as independent fixture data. The evaluator is
 * intentionally never called to construct the expected side of a fixture.
 */
function expectedEvaluation(
  values: Record<string, string>,
): FinanceTaxEvaluation {
  const sourceFactKeys: Record<string, string[]> = {
    '1AJ.grossSalary': ['employment.grossSalary'],
    'calc.standardDeduction10': ['deduction.method', 'employment.grossSalary'],
    'calc.netTaxableSalary': ['deduction.method', 'employment.grossSalary'],
    'calc.familyParts': [
      'family.dependentChildren',
      'family.livesAlone',
      'family.raisingFirstChildAlone',
      'family.status',
    ],
    'calc.taxableIncomePerPart': [
      'deduction.method',
      'employment.grossSalary',
      'family.dependentChildren',
      'family.livesAlone',
      'family.raisingFirstChildAlone',
      'family.status',
    ],
    'calc.taxBeforeFamilyCap': [
      'deduction.method',
      'employment.grossSalary',
      'family.dependentChildren',
      'family.livesAlone',
      'family.raisingFirstChildAlone',
      'family.status',
    ],
    'calc.familyQuotientCap': [
      'family.dependentChildren',
      'family.livesAlone',
      'family.raisingFirstChildAlone',
      'family.status',
    ],
    'calc.taxAfterFamilyCap': [
      'deduction.method',
      'employment.grossSalary',
      'family.dependentChildren',
      'family.livesAlone',
      'family.raisingFirstChildAlone',
      'family.status',
    ],
    'calc.decote': [
      'deduction.method',
      'employment.grossSalary',
      'family.dependentChildren',
      'family.livesAlone',
      'family.raisingFirstChildAlone',
      'family.status',
    ],
    'calc.taxAfterDecote': [
      'deduction.method',
      'employment.grossSalary',
      'family.dependentChildren',
      'family.livesAlone',
      'family.raisingFirstChildAlone',
      'family.status',
    ],
    'calc.collectionThresholdTax': [
      'deduction.method',
      'employment.grossSalary',
      'family.dependentChildren',
      'family.livesAlone',
      'family.raisingFirstChildAlone',
      'family.status',
    ],
    '8HV.pasWithheld2025': ['pas.calendarYear', 'pas.withheld'],
    'calc.balanceAfterWithholding': [
      'deduction.method',
      'employment.grossSalary',
      'family.dependentChildren',
      'family.livesAlone',
      'family.raisingFirstChildAlone',
      'family.status',
      'pas.calendarYear',
      'pas.withheld',
    ],
  };
  return {
    forms: [
      {
        id: '2042',
        version: '2042-2026',
        fields: FRANCE_2025_FIELD_DEFINITIONS.map((definition) => ({
          key: definition.key,
          value: { type: 'decimal' as const, value: values[definition.key]! },
          ruleIds: [...definition.ruleIds],
          sourceFactKeys: sourceFactKeys[definition.key]!,
        })),
      },
    ],
    issues: [],
  };
}

export const FRANCE_2025_FIXTURES = deepFreeze([
  {
    id: 'france-2025-zero-income',
    intake: fixtureIntake({
      salary: '0',
      pas: '0',
      children: '0',
      raisingAlone: false,
      livesAlone: false,
    }),
    expected: expectedEvaluation({
      '1AJ.grossSalary': '0',
      'calc.standardDeduction10': '0',
      'calc.netTaxableSalary': '0',
      'calc.familyParts': '1',
      'calc.taxableIncomePerPart': '0',
      'calc.taxBeforeFamilyCap': '0',
      'calc.familyQuotientCap': '0',
      'calc.taxAfterFamilyCap': '0',
      'calc.decote': '0',
      'calc.taxAfterDecote': '0',
      'calc.collectionThresholdTax': '0',
      '8HV.pasWithheld2025': '0',
      'calc.balanceAfterWithholding': '0',
    }),
  },
  {
    id: 'france-2025-decote',
    intake: fixtureIntake({
      salary: '30000',
      pas: '1500',
      children: '0',
      raisingAlone: false,
      livesAlone: false,
    }),
    expected: expectedEvaluation({
      '1AJ.grossSalary': '30000',
      'calc.standardDeduction10': '3000',
      'calc.netTaxableSalary': '27000',
      'calc.familyParts': '1',
      'calc.taxableIncomePerPart': '27000',
      'calc.taxBeforeFamilyCap': '1694',
      'calc.familyQuotientCap': '0',
      'calc.taxAfterFamilyCap': '1694',
      'calc.decote': '130',
      'calc.taxAfterDecote': '1564',
      'calc.collectionThresholdTax': '1564',
      '8HV.pasWithheld2025': '1500',
      'calc.balanceAfterWithholding': '64',
    }),
  },
  {
    id: 'france-2025-single-parent-cap',
    intake: fixtureIntake({
      salary: '120000',
      pas: '24000',
      children: '1',
      raisingAlone: true,
      livesAlone: true,
    }),
    expected: expectedEvaluation({
      '1AJ.grossSalary': '120000',
      'calc.standardDeduction10': '12000',
      'calc.netTaxableSalary': '108000',
      'calc.familyParts': '2',
      'calc.taxableIncomePerPart': '54000',
      'calc.taxBeforeFamilyCap': '18608',
      'calc.familyQuotientCap': '4262',
      'calc.taxAfterFamilyCap': '23819',
      'calc.decote': '0',
      'calc.taxAfterDecote': '23819',
      'calc.collectionThresholdTax': '23819',
      '8HV.pasWithheld2025': '24000',
      'calc.balanceAfterWithholding': '-181',
    }),
  },
  {
    id: 'france-2025-maximum-salary-deduction',
    intake: fixtureIntake({
      salary: '220000',
      pas: '70000',
      children: '0',
      raisingAlone: false,
      livesAlone: false,
    }),
    expected: expectedEvaluation({
      '1AJ.grossSalary': '220000',
      'calc.standardDeduction10': '14555',
      'calc.netTaxableSalary': '205445',
      'calc.familyParts': '1',
      'calc.taxableIncomePerPart': '205445',
      'calc.taxBeforeFamilyCap': '68974',
      'calc.familyQuotientCap': '0',
      'calc.taxAfterFamilyCap': '68974',
      'calc.decote': '0',
      'calc.taxAfterDecote': '68974',
      'calc.collectionThresholdTax': '68974',
      '8HV.pasWithheld2025': '70000',
      'calc.balanceAfterWithholding': '-1026',
    }),
  },
] as const);

export type France2025PackageFixture = (typeof FRANCE_2025_FIXTURES)[number];

/** Registration object for a future explicit registry owner; this file does not mutate the shared registry. */
export const FRANCE_2025_EVALUATOR = evaluateFrance2025Return;

export const FRANCE_2025_FIXTURE_DIGEST = digest(
  FRANCE_2025_FIXTURES.map((fixture) => ({
    id: fixture.id,
    expected: fixture.expected,
  })),
);
