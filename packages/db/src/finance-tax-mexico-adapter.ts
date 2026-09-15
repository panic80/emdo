import {
  FinanceTaxRunFieldSchema,
  deepFreeze,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import {
  adaptPrivateMexico2025,
  MEXICO_2025_VERSION,
  MEXICO_2025_SOURCES,
  mexico2025ReportHash,
} from '@emdo/domains/finance';

export const MEXICO_WORKING_OUTPUT_VERSION = '2025-private-mexico-output.1';
const reportingPolicyVersion = 'mexico-2025-sat-field-reporting-unproven.1';

/** Terminating decimal only; repeating fractions retain their exact rational. */
function exactDecimal(numerator: string, denominator: string): string | null {
  const numeratorValue = BigInt(numerator);
  let rest = BigInt(denominator);
  let twos = 0;
  let fives = 0;
  while (rest % 2n === 0n) {
    rest /= 2n;
    twos++;
  }
  while (rest % 5n === 0n) {
    rest /= 5n;
    fives++;
  }
  if (rest !== 1n) return null;
  const places = Math.max(twos, fives);
  const scaled =
    numeratorValue * 2n ** BigInt(places - twos) * 5n ** BigInt(places - fives);
  if (places === 0) return scaled.toString();
  const digits = (scaled < 0n ? -scaled : scaled)
    .toString()
    .padStart(places + 1, '0');
  const fraction = digits.slice(-places).replace(/0+$/, '');
  return `${scaled < 0n ? '-' : ''}${digits.slice(0, -places)}${fraction ? `.${fraction}` : ''}`;
}

export function runPrivateMexicoWorkingPapers(
  intake: FinanceTaxIntake,
  snapshotHash: string,
) {
  const adapted = adaptPrivateMexico2025(intake, snapshotHash);
  const fields = (adapted.result?.trace ?? []).map((trace) => {
    const id = `${trace.formId}.${trace.line}`;
    const definition = adapted.report?.fieldApplicability.find(
      (field) => field.formId === trace.formId && field.fieldKey === trace.line,
    );
    const sourceId =
      definition?.sourceReferenceIds[0] ?? trace.referenceIds[0] ?? '';
    return FinanceTaxRunFieldSchema.parse({
      id,
      form: trace.formId,
      line: trace.line,
      label: definition?.satLabel ?? id,
      dependencies: trace.dependsOn,
      sourceId,
      locator: definition?.sourceLocator ?? trace.line,
      exactRational: {
        numerator: trace.exactNumerator,
        denominator: trace.exactDenominator,
      },
      exactDecimal: exactDecimal(trace.exactNumerator, trace.exactDenominator),
      // Existing whole-peso displays are review values, not certified SAT field encodings.
      reportableAmount: null,
      reporting: {
        target: 'sat-2025-working-paper-field',
        policyVersion: reportingPolicyVersion,
        status: 'rounding-unproven',
        rounding: null,
        blockedDependencies: trace.dependsOn,
        sourceId: sourceId || null,
        fieldPath: definition?.sourceLocator ?? null,
      },
    });
  });
  const body = {
    adapterVersion: MEXICO_WORKING_OUTPUT_VERSION,
    packageVersion: MEXICO_2025_VERSION,
    complete: false as const,
    fileable: false as const,
    enabled: false as const,
    reportable: false as const,
    status:
      adapted.status === 'blocked-input'
        ? ('blocked' as const)
        : ('review-calculation-produced' as const),
    inputSnapshot: structuredClone(intake),
    inputHash: mexico2025ReportHash(intake),
    fields,
    sources: MEXICO_2025_SOURCES.map((source) => ({
      id: source.id,
      url: source.url,
      formVersion: MEXICO_2025_VERSION,
      documentHash: source.documentHash,
      retrievedAt: source.retrievedAt,
    })),
    reportingPolicyVersion,
    issues: adapted.issues.map((issue) => ({
      code: issue.code,
      path: issue.path,
      message: issue.detail,
    })),
    releaseBlockers: [
      ...new Set([
        ...(adapted.result?.candidate.releaseBlockers ?? []),
        ...(adapted.status === 'blocked-input'
          ? ['mexico-private-inputs-blocked']
          : []),
        'mexico-sat-field-reporting-unproven',
      ]),
    ],
    finalAmounts: { refund: null, balanceOwing: null },
    // Preserve every report field, exact trace, authority, source fact and revision.
    mexicoResult: adapted,
  };
  return deepFreeze({ ...body, runHash: mexico2025ReportHash(body) });
}

export function exportPrivateMexicoWorkingPapers(
  run: ReturnType<typeof runPrivateMexicoWorkingPapers>,
) {
  const { runHash, ...body } = run;
  if (
    mexico2025ReportHash(body) !== runHash ||
    run.status === 'blocked' ||
    !run.mexicoResult.report
  )
    throw Error('mexico-export-integrity-or-inputs');
  const quote = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return `"${(/^[\s]*[=+@-]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`;
  };
  const content = [
    'Private Mexico working papers; incomplete and not fileable; signature unperformed',
    ['Run hash', runHash].map(quote).join(','),
    ['Package version', run.packageVersion].map(quote).join(','),
    ['Input hash', run.inputHash].map(quote).join(','),
    ...run.sources.map((source) =>
      ['Source', source.id, source.documentHash, source.url]
        .map(quote)
        .join(','),
    ),
    'Form,Field,Exact numerator,Exact denominator,Exact decimal,Reportable amount',
    ...run.fields.map((field) =>
      [
        field.form,
        field.line,
        field.exactRational.numerator,
        field.exactRational.denominator,
        field.exactDecimal,
        field.reportableAmount,
      ]
        .map(quote)
        .join(','),
    ),
    // Full JSON preserves nonnumeric/unresolved fields and original source provenance.
    ['Complete private adapter and source-bound report', run.mexicoResult]
      .map(quote)
      .join(','),
  ].join('\n');
  return {
    filename: `mx-federal-2025-${run.inputSnapshot.caseId}-review.csv`,
    mimeType: 'text/csv' as const,
    content,
  };
}
