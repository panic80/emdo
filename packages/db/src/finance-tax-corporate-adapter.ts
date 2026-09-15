import { createHash } from 'node:crypto';
import type { FinanceTaxIntake } from '@emdo/contracts';
import { FinanceTaxRunFieldSchema } from '@emdo/contracts';
import {
  adaptPrivateCanadaCorporate2025,
  CANADA_CORPORATE_2025_SOURCES,
  CANADA_CORPORATE_2025_PACKAGE_VERSION,
  canonicalCorporateJson,
} from '@emdo/domains/finance';
export const CORPORATE_WORKING_OUTPUT_VERSION =
  '2025-private-corporate-output.1';
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalCorporateJson(value)).digest('hex');
export function runPrivateCorporateWorkingPapers(
  intake: FinanceTaxIntake,
  snapshotHash: string,
) {
  const adapted = adaptPrivateCanadaCorporate2025(intake, snapshotHash),
    result = adapted.result;
  const fields = [];
  if (result.status === 'incomplete-review')
    for (const form of result.forms)
      for (const [line, value] of Object.entries(form.fields)) {
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          !('exactDecimal' in value)
        )
          continue;
        const id = `${form.id}.${line}`;
        const report = result.reporting.fields.find((f) => f.id === id)!;
        const proof = report.bindings[0]?.field;
        const source = CANADA_CORPORATE_2025_SOURCES.find(
          (s) => s.file === proof?.sourceFile,
        );
        const status =
          report.reportableAmount !== null
            ? 'lossless-at-proven-precision'
            : report.blockingDependencies.length ||
                report.status === 'reporting-dependencies-unproven'
              ? 'dependency-unresolved'
              : report.status === 'rounding-rule-required'
                ? 'rounding-unproven'
                : report.status === 'outside-proven-field-range'
                  ? 'field-width-exceeded'
                  : 'field-proof-missing';
        fields.push(
          FinanceTaxRunFieldSchema.parse({
            id,
            form: form.id,
            line,
            label: id,
            dependencies: report.dependencies,
            sourceId: source?.file ?? form.sourceFile,
            locator: proof?.path ?? line,
            exactRational: {
              numerator: value.numerator,
              denominator: value.denominator,
            },
            exactDecimal: value.exactDecimal,
            reportableAmount: report.reportableAmount,
            reporting: {
              target: 'cra-2025-fillable-paper-field',
              policyVersion: 'corporate-2025-lossless-field-encoding',
              status,
              rounding:
                report.reportableAmount !== null ? 'none-lossless' : null,
              blockedDependencies: report.blockingDependencies,
              sourceId: source?.file ?? null,
              fieldPath: proof?.path ?? null,
            },
          }),
        );
      }
  const body = {
    adapterVersion: CORPORATE_WORKING_OUTPUT_VERSION,
    packageVersion: CANADA_CORPORATE_2025_PACKAGE_VERSION,
    complete: false as const,
    enabled: false as const,
    reportable: false as const,
    status:
      result.status === 'blocked-input'
        ? ('blocked' as const)
        : ('review-calculation-produced' as const),
    inputSnapshot: intake,
    inputHash: hash(intake),
    fields,
    sources: CANADA_CORPORATE_2025_SOURCES.map((s) => ({
      id: s.file,
      url: s.url,
      formVersion: s.file,
      documentHash: s.sha256,
      retrievedAt: s.capturedAt,
    })),
    reportingPolicyVersion: 'corporate-2025-lossless-field-encoding',
    issues: [...adapted.issues, ...result.issues].map((i) => ({
      code: i.code,
      path: i.path,
      message: i.detail,
    })),
    releaseBlockers: [...result.coverage.blockers],
    finalAmounts: { refund: null, balanceOwing: null },
    corporateResult: result,
  };
  return { ...body, runHash: hash(body) };
}
export function exportPrivateCorporateWorkingPapers(
  run: ReturnType<typeof runPrivateCorporateWorkingPapers>,
) {
  const { runHash, ...body } = run;
  if (
    hash(body) !== runHash ||
    run.status === 'blocked' ||
    !run.corporateResult.reviewExport
  )
    throw Error('corporate-export-integrity-or-inputs');
  const quote = (v: unknown) => {
    const s = typeof v === 'string' ? v : canonicalCorporateJson(v);
    return `"${(/^[\s]*[=+@-]/.test(s) ? "'" : '') + s.replaceAll('"', '""')}"`;
  };
  const content = [
    'Private corporate working papers; incomplete return; taxpayer signature unperformed',
    `Run hash,${runHash}`,
    `Package version,${run.packageVersion}`,
    `Input hash,${run.inputHash}`,
    `Corporate definition hash,${run.corporateResult.definitionHash}`,
    ...run.sources.map((s) =>
      ['Source', s.id, s.formVersion, s.documentHash, s.url]
        .map(quote)
        .join(','),
    ),
    `Corporate export hash,${run.corporateResult.reviewExport.sha256}`,
    'Form,Field,Value',
    ...run.corporateResult.forms.flatMap((f) =>
      Object.entries(f.fields).map(([k, v]) =>
        [f.id, k, v].map(quote).join(','),
      ),
    ),
  ].join('\n');
  return {
    filename: `ca-on-t2-2025-${run.inputSnapshot.caseId}-review.csv`,
    mimeType: 'text/csv' as const,
    content,
  };
}
