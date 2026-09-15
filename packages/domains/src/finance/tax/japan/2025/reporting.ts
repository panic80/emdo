import { createHash } from 'node:crypto';
import { deepFreeze } from '@emdo/contracts';
import type { Japan2025Run } from './workflow.js';
import {
  auditJapan2025FormApplicability,
  type Japan2025FormDecision,
} from './form-applicability.js';

export const JAPAN_2025_REPORTING_POLICY_VERSION =
  '2025-selected-form-reporting.1';

export type Japan2025FieldReporting = {
  target: 'japan-2025-selected-form-field';
  policyVersion: string;
  status:
    | 'lossless-whole-yen'
    | 'reviewed-input'
    | 'blocked-input'
    | 'dependency-unresolved'
    | 'out-of-scope'
    | 'manual-unperformed';
  rounding: 'none-lossless' | null;
  blockedDependencies: string[];
  sourceId: string | null;
  fieldPath: string | null;
};

export type Japan2025ReportedField = {
  id: string;
  form: string;
  line: string;
  label: string;
  kind: string;
  decision: Japan2025FormDecision;
  value: string | boolean | null;
  exactRational: { numerator: string; denominator: string } | null;
  exactYen: string | null;
  reportableAmount: string | null;
  dependencies: string[];
  sourceFactKeys: string[];
  sourceId: string | null;
  fieldPath: string | null;
  reporting: Japan2025FieldReporting;
};

type Japan2025FormAudit = ReturnType<typeof auditJapan2025FormApplicability>;

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

const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

const runFieldMap = (run: Japan2025Run) =>
  new Map(run.fields.map((field) => [field.id, field]));

/**
 * Attach a local Japan reporting decision to every selected Form 1/Form 2
 * applicability record.  The selected branch becomes report-ready only when
 * the independent audit is complete; the returned object still advertises
 * `reportable: false` because it is a working report rather than a filed
 * return.
 */
export function applyJapan2025SelectedReporting(
  run: Japan2025Run,
  audit: Japan2025FormAudit,
) {
  if (audit.runHash !== run.outputHash)
    throw new Error('japan-reporting-run-hash-mismatch');
  const values = runFieldMap(run);
  const fields: Japan2025ReportedField[] = audit.fields.map((field) => {
    const calculation = field.fieldId ? values.get(field.fieldId) : undefined;
    const selectedReady = audit.selectedComplete;
    let status: Japan2025FieldReporting['status'];
    let reportableAmount: string | null = null;
    let exactRational = calculation?.exactRational ?? null;
    let exactYen = calculation?.exactYen ?? null;
    let blockedDependencies: string[] = [...(calculation?.dependencies ?? [])];
    if (field.decision === 'out-of-scope') {
      status = 'out-of-scope';
      exactRational = null;
      exactYen = null;
      blockedDependencies = [];
    } else if (field.decision === 'manual-unperformed') {
      status = 'manual-unperformed';
      exactRational = null;
      exactYen = null;
      blockedDependencies = [];
    } else if (!selectedReady) {
      status =
        run.status === 'blocked-input'
          ? 'blocked-input'
          : 'dependency-unresolved';
      reportableAmount = null;
    } else if (field.decision === 'calculated' && calculation) {
      status = 'lossless-whole-yen';
      reportableAmount = calculation.exactYen;
      blockedDependencies = [];
    } else if (field.decision === 'reviewed-input') {
      status = 'reviewed-input';
      reportableAmount =
        field.kind === 'decimal' && typeof field.value === 'string'
          ? field.value
          : null;
      exactRational = null;
      exactYen = null;
      blockedDependencies = [];
    } else {
      status = 'dependency-unresolved';
      exactRational = null;
      exactYen = null;
    }
    return {
      id: field.id,
      form: field.form,
      line: field.fieldPath,
      label: field.label,
      kind: field.kind,
      decision: field.decision,
      value: field.value,
      exactRational,
      exactYen,
      reportableAmount,
      dependencies: [...(calculation?.dependencies ?? [])],
      sourceFactKeys: calculation?.sourceFactKeys
        ? [...calculation.sourceFactKeys]
        : field.factKey
          ? [field.factKey]
          : [],
      sourceId: field.sourceId,
      fieldPath: field.fieldPath,
      reporting: {
        target: 'japan-2025-selected-form-field',
        policyVersion: JAPAN_2025_REPORTING_POLICY_VERSION,
        status,
        rounding: status === 'lossless-whole-yen' ? 'none-lossless' : null,
        blockedDependencies,
        sourceId: field.sourceId,
        fieldPath: field.fieldPath,
      },
    };
  });
  const body = {
    version: JAPAN_2025_REPORTING_POLICY_VERSION,
    runHash: run.outputHash,
    packageVersion: run.candidate.version,
    complete: audit.selectedComplete,
    selectedComplete: audit.selectedComplete,
    fullReturnComplete: false as const,
    reportable: false as const,
    fields,
    outOfScope: audit.fullReturnGaps,
    issues: audit.issues,
    remainingProof: audit.remainingProof,
  };
  return deepFreeze({ ...body, reportingHash: digest(body) });
}

export const reportJapan2025SelectedReturn = applyJapan2025SelectedReporting;
