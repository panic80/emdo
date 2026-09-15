import { createHash } from 'node:crypto';
import { deepFreeze, type FinanceTaxScope } from '@emdo/contracts';
import {
  evaluateMexico2025ProfessionalSoleProprietor,
  evaluateMexico2025SalariedIndividual,
  evaluateMexico2025StandaloneCorporation,
} from './workflow.js';
import {
  MEXICO_2025_FIELD_APPLICABILITY,
  type Mexico2025FieldApplicability,
} from './field-catalog.js';
import { MEXICO_2025_SOURCES } from './sources.js';

export const MEXICO_2025_REPORTING_VERSION =
  '2025.2-source-bound-return-report-v2' as const;
export const MX_2025_REPORTING_VERSION = MEXICO_2025_REPORTING_VERSION;

type Mexico2025EvaluationResult =
  | ReturnType<typeof evaluateMexico2025SalariedIndividual>
  | ReturnType<typeof evaluateMexico2025ProfessionalSoleProprietor>
  | ReturnType<typeof evaluateMexico2025StandaloneCorporation>;

type ReportField = Mexico2025FieldApplicability & {
  resolution: 'emitted' | 'unsupported' | 'unresolved';
  output: {
    value: string | boolean;
    ruleIds: readonly string[];
    sourceFactKeys: readonly string[];
    exactNumerator: string;
    exactDenominator: string;
    reportedValue: string | boolean;
  } | null;
};

export type Mexico2025SourceBoundReport = {
  schemaVersion: 1;
  reportingVersion: typeof MEXICO_2025_REPORTING_VERSION;
  candidateId: string;
  candidateVersion: string;
  scope: FinanceTaxScope;
  status: 'blocked-input' | 'incomplete-working-papers';
  complete: false;
  inputHash: string | null;
  outputHash: string;
  definitionHash: string;
  sourceReferences: readonly (typeof MEXICO_2025_SOURCES)[number][];
  forms: Mexico2025EvaluationResult['evaluation']['forms'];
  trace: readonly Mexico2025EvaluationResult['trace'][number][];
  investmentSchedule: Mexico2025EvaluationResult['investmentSchedule'];
  issues: Mexico2025EvaluationResult['evaluation']['issues'];
  fieldApplicability: readonly ReportField[];
  coverage: {
    catalogFields: number;
    emittedFields: number;
    unsupportedFields: number;
    unresolvedFields: number;
  };
  reportHash: string;
};

export type Mexico2025ReportExport = {
  report: Mexico2025SourceBoundReport;
  json: string;
  reportHash: string;
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

export const mexico2025ReportHash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

const traceKey = (formId: string, fieldKey: string) => `${formId}.${fieldKey}`;

/**
 * Builds a deterministic report for review/export. It includes every source
 * bound field in the applicable SAT section, including unresolved fields, so a
 * consumer cannot mistake a sparse evaluation for a complete return.
 */
export function buildMexico2025Report(
  result: Mexico2025EvaluationResult,
): Mexico2025SourceBoundReport {
  const taxpayerType = result.candidate.scope.taxpayerType;
  const catalog = MEXICO_2025_FIELD_APPLICABILITY.filter(
    (entry) => entry.taxpayerType === taxpayerType,
  );
  const emitted = new Map(
    result.evaluation.forms.flatMap((form) =>
      form.fields.map(
        (field) => [traceKey(form.id, field.key), field] as const,
      ),
    ),
  );
  const trace = new Map(
    result.trace.map((entry) => [traceKey(entry.formId, entry.line), entry]),
  );
  const fieldApplicability = catalog.map((definition) => {
    const output = emitted.get(
      traceKey(definition.formId, definition.fieldKey),
    );
    const exact = trace.get(traceKey(definition.formId, definition.fieldKey));
    const resolution = output
      ? ('emitted' as const)
      : definition.status === 'unsupported'
        ? ('unsupported' as const)
        : ('unresolved' as const);
    return {
      ...definition,
      resolution,
      output:
        output && exact
          ? {
              value: output.value.value,
              ruleIds: output.ruleIds,
              sourceFactKeys: output.sourceFactKeys,
              exactNumerator: exact.exactNumerator,
              exactDenominator: exact.exactDenominator,
              reportedValue: output.value.value,
            }
          : null,
    } satisfies ReportField;
  });
  const sourceIds = new Set(
    fieldApplicability.flatMap((entry) => entry.sourceReferenceIds),
  );
  const sourceReferences = MEXICO_2025_SOURCES.filter((source) =>
    sourceIds.has(source.id),
  );
  const core = {
    schemaVersion: 1 as const,
    reportingVersion: MEXICO_2025_REPORTING_VERSION,
    candidateId: result.candidate.id,
    candidateVersion: result.candidate.version,
    scope: result.candidate.scope,
    status: result.status,
    complete: false as const,
    inputHash: result.binding?.inputHash ?? null,
    outputHash: result.outputHash,
    definitionHash: result.definitionHash,
    sourceReferences,
    forms: result.evaluation.forms,
    trace: result.trace,
    investmentSchedule: result.investmentSchedule,
    issues: result.evaluation.issues,
    fieldApplicability,
    coverage: {
      catalogFields: fieldApplicability.length,
      emittedFields: fieldApplicability.filter(
        (entry) => entry.resolution === 'emitted',
      ).length,
      unsupportedFields: fieldApplicability.filter(
        (entry) => entry.resolution === 'unsupported',
      ).length,
      unresolvedFields: fieldApplicability.filter(
        (entry) => entry.resolution === 'unresolved',
      ).length,
    },
  };
  return deepFreeze({
    ...core,
    reportHash: mexico2025ReportHash(core),
  }) as Mexico2025SourceBoundReport;
}

export const createMexico2025Report = buildMexico2025Report;
export const createMexico2025SourceBoundReport = buildMexico2025Report;

export function serializeMexico2025Report(
  report: Mexico2025SourceBoundReport,
): string {
  return canonical(report);
}

export function exportMexico2025Report(
  result: Mexico2025EvaluationResult,
): Mexico2025ReportExport {
  const report = buildMexico2025Report(result);
  const json = serializeMexico2025Report(report);
  return deepFreeze({ report, json, reportHash: report.reportHash });
}

export function exportMexico2025ReportJson(
  result: Mexico2025EvaluationResult,
): string {
  return exportMexico2025Report(result).json;
}

export const exportMx2025Report = exportMexico2025Report;
export const serializeMx2025Report = serializeMexico2025Report;
