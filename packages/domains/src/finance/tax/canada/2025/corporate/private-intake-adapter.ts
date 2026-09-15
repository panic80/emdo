import { z } from 'zod';
import {
  deepFreeze,
  FinanceTaxIntakeSchema,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import {
  CanadaCorporate2025IntakeSchema,
  T2_2025_ADDITIONAL_SCHEDULE_TRIGGERS,
} from './intake.js';
import { prepareCanadaCorporate2025Review } from './workflow.js';

export const CORPORATE_PRIVATE_ADAPTER_VERSION =
  '2025-private-corporate-inputs.1';
export const CORPORATE_PRIVATE_SCOPE = deepFreeze({
  country: 'CA',
  subdivision: 'CA-ON',
  taxpayerType: 'corporation',
  year: 2025,
  regime: 'income-tax-return',
  formVersion: 'T2-2025_GIFI-2025_ON-2025',
} as const);
type Question = {
  key: string;
  path: string[];
  type: 'text' | 'date' | 'boolean' | 'decimal';
  required: true;
  label: string;
  locator: string;
  encoding: 'scalar' | 'nullable-text' | 'json';
  schema: z.ZodType;
};
const questions: Question[] = [];
function walk(schema: z.ZodType, path: string[]) {
  const dotted = path.join('.');
  if (
    [
      'schemaVersion',
      'currency',
      'binding',
      'sourceReferences',
      'priorYear.refundableTaxHistory.sourceReferenceId',
      'taxWithholding.sourceReferenceId',
    ].includes(dotted)
  )
    return;
  if (schema instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(schema.shape))
      walk(child as z.ZodType, [...path, key]);
    return;
  }
  if (schema instanceof z.ZodRecord && schema.keyType instanceof z.ZodEnum) {
    for (const key of schema.keyType.options)
      walk(schema.valueType as z.ZodType, [...path, String(key)]);
    return;
  }
  const nullable = schema instanceof z.ZodNullable;
  const inner = nullable ? schema.unwrap() : schema;
  const json = inner instanceof z.ZodArray;
  const type =
    inner instanceof z.ZodBoolean && !nullable
      ? 'boolean'
      : json || nullable || inner instanceof z.ZodEnum
        ? 'text'
        : /(?:taxYearStart|taxYearEnd)$/.test(dotted)
          ? 'date'
          : /(?:Percentage|Income|Capital|Limit|amount|payments|Provision|Paid|RdToh|Refund)$/.test(
                dotted,
              ) ||
              /(?:opening|closing|costOfSales|operatingExpenses)\.\d+$/.test(
                dotted,
              ) ||
              [
                'priorYear.taxableCapitalEmployedCanada',
                'financialStatements.tradeSales',
                'financialStatements.otherComprehensiveIncome',
              ].includes(dotted)
            ? 'decimal'
            : 'text';
  const trigger =
    path[0] === 'attachmentAnswers'
      ? T2_2025_ADDITIONAL_SCHEDULE_TRIGGERS[
          path[1] as keyof typeof T2_2025_ADDITIONAL_SCHEDULE_TRIGGERS
        ]
      : null;
  questions.push({
    key: path[0] === 'identity' ? dotted : `corporate.${dotted}`,
    path,
    type,
    required: true,
    label:
      (trigger ??
        dotted.replaceAll('.', ' · ').replace(/([a-z])([A-Z])/g, '$1 $2')) +
      (json
        ? ' (explicit list; [] for none)'
        : nullable && inner instanceof z.ZodBoolean
          ? ' (yes, no, or none if unknown)'
          : nullable && type === 'text'
            ? ' (enter none when not applicable)'
            : inner instanceof z.ZodEnum
              ? ` (${inner.options.join(', ')})`
              : ''),
    locator:
      path[0] === 'attachmentAnswers'
        ? `T2 line ${path[1]}`
        : '2025 T2, GIFI and Ontario package required facts',
    encoding: json
      ? 'json'
      : nullable && type === 'text'
        ? 'nullable-text'
        : 'scalar',
    schema,
  });
}
walk(CanadaCorporate2025IntakeSchema, []);
export const CORPORATE_PRIVATE_QUESTIONS = deepFreeze(
  questions.map((q) => ({
    key: q.key,
    type: q.type,
    required: q.required,
    label: q.label,
    locator: q.locator,
  })),
);
/** Binding and references are derived from already-authorized immutable case facts. */
export function adaptPrivateCanadaCorporate2025(
  intake: FinanceTaxIntake,
  snapshotHash: string,
) {
  const issues: Array<{ code: string; path: string; detail: string }> = [];
  const parsedIntake = FinanceTaxIntakeSchema.safeParse(intake);
  if (!parsedIntake.success || !/^[a-f0-9]{64}$/.test(snapshotHash))
    return {
      issues: [
        {
          code: 'invalid-private-intake',
          path: 'intake',
          detail: 'A validated private case snapshot is required.',
        },
      ],
      result: prepareCanadaCorporate2025Review({}),
    };
  intake = parsedIntake.data;
  const data: Record<string, unknown> = {
    schemaVersion: 1,
    currency: 'CAD',
    binding: {
      caseId: intake.caseId,
      snapshotRevision: intake.revision,
      snapshotHash,
    },
  };
  const seen = new Set<string>();
  for (const fact of intake.facts) {
    if (seen.has(fact.key))
      issues.push({
        code: 'duplicate-fact',
        path: fact.key,
        detail: 'A single exact source revision is required.',
      });
    seen.add(fact.key);
    if (!questions.some((q) => q.key === fact.key))
      issues.push({
        code: 'unknown-fact',
        path: fact.key,
        detail: 'Fact is not part of this corporate package.',
      });
  }
  for (const q of questions) {
    const fact = intake.facts.find((f) => f.key === q.key);
    if (
      !fact ||
      fact.reviewState !== 'reviewed' ||
      fact.value.type !== q.type
    ) {
      issues.push({
        code: 'missing-or-unreviewed-fact',
        path: q.key,
        detail: 'An exact reviewed input of the requested type is required.',
      });
      continue;
    }
    let value: unknown = fact.value.value;
    try {
      if (q.encoding === 'json') value = JSON.parse(String(value));
      else if (
        q.encoding === 'nullable-text' &&
        String(value).toLowerCase() === 'none'
      )
        value = null;
    } catch {
      issues.push({
        code: 'invalid-list',
        path: q.key,
        detail: 'A valid explicit list is required.',
      });
      continue;
    }
    if (
      q.schema instanceof z.ZodNullable &&
      q.schema.unwrap() instanceof z.ZodBoolean &&
      value !== null
    ) {
      if (['true', 'yes'].includes(String(value).toLowerCase())) value = true;
      else if (['false', 'no'].includes(String(value).toLowerCase()))
        value = false;
    }
    const parsed = q.schema.safeParse(value);
    if (!parsed.success) {
      issues.push({
        code: 'invalid-fact',
        path: q.key,
        detail: 'Value does not match the corporate form input requirements.',
      });
      continue;
    }
    let target = data;
    for (const part of q.path.slice(0, -1))
      target = (target[part] ??= {}) as Record<string, unknown>;
    target[q.path.at(-1)!] = parsed.data;
  }
  const refs: Array<{ id: string; sha256: string }> = [];
  for (const [key, section] of [
    ['corporate.priorYear.refundableTaxHistory.eligibleRdToh', 'priorYear'],
    ['corporate.taxWithholding.amount', 'taxWithholding'],
  ] as const) {
    const fact = intake.facts.find(
      (f) => f.key === key && f.reviewState === 'reviewed',
    );
    if (fact) {
      const ref = {
        id: fact.source.reference,
        sha256: fact.source.contentHash,
      };
      refs.push(ref);
      const target =
        section === 'priorYear'
          ? (data.priorYear as Record<string, unknown>)?.refundableTaxHistory
          : data.taxWithholding;
      if (target && typeof target === 'object')
        (target as Record<string, unknown>).sourceReferenceId = ref.id;
    }
  }
  data.sourceReferences = refs;
  if (
    JSON.stringify(intake.scope) !== JSON.stringify(CORPORATE_PRIVATE_SCOPE) &&
    Object.entries(CORPORATE_PRIVATE_SCOPE).some(
      ([k, v]) => intake.scope[k as keyof typeof intake.scope] !== v,
    )
  )
    issues.push({
      code: 'unsupported-scope',
      path: 'scope',
      detail: 'Exact Ontario2025 standalone corporate scope is required.',
    });
  if (
    intake.domesticResident !== true ||
    intake.hasCrossBorderActivity !== false ||
    intake.standaloneCorporation !== true ||
    intake.requestedFeatures.length !== 1 ||
    intake.requestedFeatures[0] !== 'income-tax-return'
  )
    issues.push({
      code: 'unsupported-case',
      path: 'intake',
      detail: 'A domestic standalone corporation income-tax case is required.',
    });
  return {
    issues,
    result: prepareCanadaCorporate2025Review(issues.length ? {} : data),
  };
}
