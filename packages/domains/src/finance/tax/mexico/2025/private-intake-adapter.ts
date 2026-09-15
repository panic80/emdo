import {
  deepFreeze,
  FinanceTaxIntakeSchema,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import {
  MEXICO_2025_CANDIDATES,
  evaluateMexico2025WorkingPapers,
} from './workflow.js';
import { buildMexico2025Report, mexico2025ReportHash } from './reporting.js';
import { MEXICO_2025_FIELD_APPLICABILITY } from './field-catalog.js';

export const MEXICO_2025_PRIVATE_ADAPTER_VERSION =
  '2025-private-mexico-inputs.2' as const;

/** One-to-one scalar keys: decimal money is never parsed through Number. */
export const MEXICO_2025_PRIVATE_QUESTIONNAIRES = deepFreeze(
  MEXICO_2025_CANDIDATES.map((candidate) => ({
    candidateId: candidate.id,
    scope: candidate.scope,
    complete: false as const,
    fileable: false as const,
    questions: candidate.requiredFacts.map((fact) => {
      const fields = MEXICO_2025_FIELD_APPLICABILITY.filter(
        (field) =>
          field.taxpayerType === candidate.scope.taxpayerType &&
          field.requiredFactKeys.includes(fact.key),
      );
      return {
        key: fact.key,
        type: fact.type,
        required: true as const,
        reviewRequired: true as const,
        label:
          fact.key === 'corporation.investments.rows'
            ? 'First-year office/computer assets (JSON list; [] for none): assetId, assetClass, acquisitionDate, firstUseDate, originalInvestment'
            : fact.key
                .replaceAll('.', ' · ')
                .replace(/([a-z])([A-Z])/g, '$1 $2'),
        locator: fields.length
          ? [...new Set(fields.map((field) => field.sourceLocator))].join('; ')
          : `Mexico 2025 ${candidate.scope.formVersion} reviewed working-paper input`,
        sourceReferenceIds: fields.length
          ? [...new Set(fields.flatMap((field) => field.sourceReferenceIds))]
          : candidate.references.map((source) => source.id),
        ...('equals' in fact && fact.equals !== undefined
          ? { requiredValue: fact.equals }
          : {}),
      };
    }),
  })),
);
export const MEXICO_2025_PRIVATE_QUESTIONS_BY_TAXPAYER_TYPE = deepFreeze(
  Object.fromEntries(
    MEXICO_2025_PRIVATE_QUESTIONNAIRES.map((entry) => [
      entry.scope.taxpayerType,
      entry.questions,
    ]),
  ) as Record<
    'individual' | 'sole-proprietor' | 'corporation',
    (typeof MEXICO_2025_PRIVATE_QUESTIONNAIRES)[number]['questions']
  >,
);

type Issue = { code: string; path: string; detail: string };

/**
 * Called only after private-case authorization by the caller. snapshotHash is
 * caller-supplied snapshot identity, not a claim that this adapter authenticated
 * the case or verified a remote snapshot. The separate inputHash binds every
 * exact reviewed fact/source revision to the calculation.
 */
export function adaptPrivateMexico2025(
  input: FinanceTaxIntake,
  snapshotHash: string,
) {
  const parsed = FinanceTaxIntakeSchema.safeParse(input);
  const base = {
    adapterVersion: MEXICO_2025_PRIVATE_ADAPTER_VERSION,
    complete: false as const,
    fileable: false as const,
    registryEligible: false as const,
  };
  if (!parsed.success || !/^[a-f0-9]{64}$/.test(snapshotHash)) {
    const invalid = {
      ...base,
      status: 'blocked-input' as const,
      binding: null,
      issues: [
        {
          code: 'invalid-private-intake',
          path: 'intake',
          detail:
            'A validated private case and a SHA-256 snapshot identity are required.',
        },
      ],
      result: null,
      report: null,
    };
    return deepFreeze({
      ...invalid,
      adapterHash: mexico2025ReportHash(invalid),
    });
  }
  const intake = parsed.data;
  const issues: Issue[] = [];
  const questionnaire = MEXICO_2025_PRIVATE_QUESTIONNAIRES.find((entry) =>
    Object.entries(entry.scope).every(
      ([key, value]) =>
        intake.scope[key as keyof typeof intake.scope] === value,
    ),
  );
  if (!questionnaire)
    issues.push({
      code: 'unsupported-scope',
      path: 'scope',
      detail: 'An exact Mexico 2025 candidate scope is required.',
    });
  for (const question of questionnaire?.questions ?? []) {
    const fact = intake.facts.find((entry) => entry.key === question.key);
    if (
      !fact ||
      fact.reviewState !== 'reviewed' ||
      fact.value.type !== question.type
    )
      issues.push({
        code: 'missing-or-unreviewed-fact',
        path: question.key,
        detail:
          'An exact reviewed scalar input of the requested type is required.',
      });
  }
  // The existing workflow independently validates scope, review state, all
  // exclusion/eligibility facts, precision, reconciliation and unmapped keys.
  const result = questionnaire ? evaluateMexico2025WorkingPapers(intake) : null;
  if (result)
    issues.push(
      ...result.evaluation.issues.map((issue) => ({
        code: issue.code,
        path: 'workflow',
        detail: issue.message,
      })),
    );
  const core = {
    ...base,
    status: result?.status ?? ('blocked-input' as const),
    binding: {
      caseId: intake.caseId,
      workspaceId: intake.workspaceId,
      taxSubjectId: intake.taxSubjectId,
      legalEntityId: intake.legalEntityId,
      snapshotRevision: intake.revision,
      snapshotHash,
      inputHash: mexico2025ReportHash(intake),
      sourceFacts: intake.facts.map((fact) => ({
        key: fact.key,
        reviewState: fact.reviewState,
        value: fact.value,
        source: fact.source,
      })),
    },
    issues,
    result,
    report: result ? buildMexico2025Report(result) : null,
  };
  return deepFreeze({ ...core, adapterHash: mexico2025ReportHash(core) });
}
export type Mexico2025PrivateIntakeResult = ReturnType<
  typeof adaptPrivateMexico2025
>;
