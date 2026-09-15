import { createHash } from 'node:crypto';
import {
  deepFreeze,
  FinanceTaxFactSchema,
  FinanceTaxIntakeSchema,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import { z } from 'zod';
import { JAPAN_2025_SOURCES } from './sources.js';

export const JAPAN_2025_LOCAL_TAX_HANDOFF_VERSION = '2025-local-tax-handoff.1';

export const JAPAN_2025_LOCAL_TAX_HANDOFF_SCOPE = deepFreeze({
  country: 'JP',
  subdivision: 'JP-LOCAL-UNSPECIFIED',
  taxpayerType: 'individual' as const,
  year: 2025,
  regime: 'resident-tax-handoff',
  formVersion: 'r07-form-2-local-tax',
});

type LocalFactType = 'text' | 'boolean';
type LocalRequirement = {
  key: string;
  type: LocalFactType;
  sourceId: string;
  equals?: boolean;
};

/**
 * NTA proves the Form 2 local-tax handoff fields and says that the municipality
 * and prefecture calculate and notify the actual tax.  These facts therefore
 * prepare the handoff without inventing a municipality rate or liability.
 */
export const JAPAN_2025_LOCAL_TAX_REQUIRED_FACTS = deepFreeze([
  {
    key: 'localTax.prefecture',
    type: 'text',
    sourceId: 'nta-jp-r07-local-tax-guidance',
  },
  {
    key: 'localTax.municipality',
    type: 'text',
    sourceId: 'nta-jp-r07-local-tax-guidance',
  },
  {
    key: 'localTax.addressAt2026-01-01',
    type: 'text',
    sourceId: 'nta-jp-r07-local-tax-guidance',
  },
  {
    key: 'localTax.noNonSalaryIncome',
    type: 'boolean',
    sourceId: 'nta-jp-r07-local-tax-input',
    equals: true,
  },
  {
    key: 'localTax.collectionMethodAcknowledged',
    type: 'text',
    sourceId: 'nta-jp-r07-local-tax-input',
  },
  {
    key: 'localTax.noMinorDependants',
    type: 'boolean',
    sourceId: 'nta-jp-r07-local-tax-input',
    equals: true,
  },
  {
    key: 'localTax.noRetirementRelatives',
    type: 'boolean',
    sourceId: 'nta-jp-r07-local-tax-input',
    equals: true,
  },
  {
    key: 'localTax.noDesignatedDonations',
    type: 'boolean',
    sourceId: 'nta-jp-r07-local-tax-guidance',
    equals: true,
  },
  {
    key: 'localTax.noResidentTaxCreditAdjustments',
    type: 'boolean',
    sourceId: 'nta-jp-r07-local-tax-guidance',
    equals: true,
  },
] as const satisfies readonly LocalRequirement[]);

export const JAPAN_2025_LOCAL_TAX_RELEASE_BLOCKERS = deepFreeze([
  'prefectural-and-municipal-authority-calculation-required',
  'municipality-specific-resident-tax-rates-and-deductions-not-pinned',
  'individual-enterprise-tax-rules-not-implemented',
  'corporate-local-inhabitant-enterprise-and-per-capita-tax-not-implemented',
  'local-tax-not-a-fileable-return-or-notice',
] as const);

type LocalIssue = { code: string; message: string };
type LocalField = {
  id: string;
  fieldPath: string;
  label: string;
  sourceId: string;
  value: string | boolean | null;
  decision: 'reviewed-input' | 'unresolved';
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const hash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

function validFact(
  fact: z.infer<typeof FinanceTaxFactSchema> | undefined,
  requirement: LocalRequirement,
): boolean {
  if (
    !fact ||
    fact.reviewState !== 'reviewed' ||
    fact.value.type !== requirement.type
  )
    return false;
  if (requirement.type === 'text' && !String(fact.value.value).trim())
    return false;
  if (requirement.equals !== undefined)
    return (
      fact.value.type === 'boolean' && fact.value.value === requirement.equals
    );
  return true;
}

/** Prepare explicit NTA Form 2 local-tax handoff facts. */
export function prepareJapan2025LocalTaxHandoff(raw: unknown) {
  const parsed = FinanceTaxIntakeSchema.safeParse(raw);
  const issues: LocalIssue[] = [];
  const addIssue = (code: string, message: string) =>
    issues.push({ code, message });
  if (!parsed.success) {
    addIssue(
      'invalid-intake',
      'Generic tax intake or source lineage is invalid.',
    );
    return finish(null, issues, null);
  }
  const intake = parsed.data;
  if (
    intake.scope.country !== 'JP' ||
    intake.scope.subdivision !== 'JP-NATIONAL' ||
    intake.scope.taxpayerType !== 'individual' ||
    intake.scope.year !== 2025 ||
    intake.domesticResident !== true ||
    intake.hasCrossBorderActivity !== false
  )
    addIssue(
      'unsupported-scope',
      'Local handoff requires a domestic-resident 2025 Japanese individual national-return intake; municipality rates remain unselected.',
    );
  const sourceFacts = new Map(intake.facts.map((fact) => [fact.key, fact]));
  const requirements: readonly LocalRequirement[] =
    JAPAN_2025_LOCAL_TAX_REQUIRED_FACTS;
  const required = new Set<string>(
    requirements.map((requirement) => requirement.key),
  );
  for (const fact of intake.facts)
    if (!required.has(fact.key))
      addIssue(
        'unsupported-fact',
        `Unmapped local-tax fact is not silently ignored: ${fact.key}`,
      );
  const fields: LocalField[] = requirements.map((requirement) => {
    const fact = sourceFacts.get(requirement.key);
    const satisfied = validFact(fact, requirement);
    if (!satisfied)
      addIssue('missing-or-unreviewed-local-tax-fact', requirement.key);
    return {
      id: `JP-Form-2.localTax.${requirement.key.slice('localTax.'.length)}`,
      fieldPath: `JP-Form-2.localTax.${requirement.key.slice('localTax.'.length)}`,
      label: requirement.key,
      sourceId: requirement.sourceId,
      value: satisfied ? (fact?.value.value ?? null) : null,
      decision: satisfied ? 'reviewed-input' : 'unresolved',
    };
  });
  return finish(intake, issues, fields);
}

function finish(
  intake: FinanceTaxIntake | null,
  issues: LocalIssue[],
  fields: LocalField[] | null,
) {
  const selectedComplete = Boolean(fields && !issues.length);
  const body = {
    candidate: {
      id: 'jp-2025-local-tax-handoff',
      version: JAPAN_2025_LOCAL_TAX_HANDOFF_VERSION,
      enabled: false,
      registryEligible: false,
      complete: false,
      scope: JAPAN_2025_LOCAL_TAX_HANDOFF_SCOPE,
      references: JAPAN_2025_SOURCES.filter((source) =>
        [
          'nta-jp-r07-local-tax-guidance',
          'nta-jp-r07-local-tax-input',
        ].includes(source.id),
      ),
      releaseBlockers: JAPAN_2025_LOCAL_TAX_RELEASE_BLOCKERS,
    },
    scope: JAPAN_2025_LOCAL_TAX_HANDOFF_SCOPE,
    packageVersion: JAPAN_2025_LOCAL_TAX_HANDOFF_VERSION,
    enabled: false as const,
    registryEligible: false as const,
    complete: false as const,
    selectedComplete,
    formDataReady: selectedComplete,
    calculationComplete: false as const,
    reportable: false as const,
    fileable: false as const,
    status:
      fields && fields.length && !issues.length
        ? ('handoff-working-papers' as const)
        : ('blocked-input' as const),
    inputSnapshot: intake,
    inputHash: intake ? hash(intake) : null,
    fields: fields ?? [],
    taxLiability: null,
    authorityCalculationRequired: true as const,
    municipalityRateSchedule: null,
    issues,
    releaseBlockers: JAPAN_2025_LOCAL_TAX_RELEASE_BLOCKERS,
    remainingProof: [
      'pin-prefecture-and-municipality-official-2026-resident-tax-schedule',
      'authority-calculation-and-notice',
      'individual-enterprise-tax-and-corporate-local-tax-branches',
    ],
  };
  return deepFreeze({ ...body, outputHash: hash(body) });
}

export type Japan2025LocalTaxHandoff = ReturnType<
  typeof prepareJapan2025LocalTaxHandoff
>;
