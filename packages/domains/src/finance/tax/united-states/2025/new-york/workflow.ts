import {
  calculateNyShortPenalty2025,
  NY_PENALTY_REQUIRED_FACTS,
} from './penalty.js';
import {
  FinanceTaxIntakeSchema,
  FinanceTaxEvaluationSchema,
  deepFreeze,
  type FinanceTaxIntake,
} from '@emdo/contracts';
import { evaluateUs2025WorkingPapers } from '../workflow.js';
import { usReviewContentHash } from '../review-bundle.js';
import { roundNonnegativeRatio, usdCents } from '../rounding.js';
import { NY_2025_SINGLE_TABLES } from './tables-data.js';
import {
  calculateNySingleEic2025,
  NY_2025_CHILDLESS_IT270,
} from './credits.js';
import { NY_2025_SOURCES } from './sources.js';
import { NY_FIELD_CATALOG_DATA } from './field-catalog-data.js';
import { NY_SCHOOL_DISTRICTS } from './school-district-data.js';
import { prepareNyAttachmentPhysicalFields } from './attachment-fields.js';
import {
  NY_REGULAR_PENALTY_FACTS,
  calculateNyRegularPenalty2025,
} from './regular-penalty.js';
import {
  NY_FORM_REQUIRED_FACTS,
  prepareNy201PhysicalFields,
} from './form-fields.js';

export const NY_2025_REQUIRED_FACTS = deepFreeze([
  ...NY_PENALTY_REQUIRED_FACTS,
  ...NY_REGULAR_PENALTY_FACTS,
  ...NY_FORM_REQUIRED_FACTS,
  { key: 'federalInputHash', type: 'text' },
  { key: 'residency', type: 'text', equals: 'full-year-NY' },
  { key: 'localResidence', type: 'text' }, // outside-NYC-Yonkers | NYC | Yonkers | part-year
  { key: 'businessLocation', type: 'text' }, // outside-MCTD | zone1 | zone2 | mixed
  { key: 'standardDeductionElection', type: 'boolean', equals: true },
  ...[
    'noncustodialParentCreditEligible',
    'lateFilingOrPayment',
    'nyModifications',
    'otherStateIncomeOrCredits',
    'itemizedDeductionClaim',
    'otherCreditsOrTaxes',
    'yonkersNonresidentEarnings',
    'startupNy',
    'nycBusinessActivity',
  ].map((key) => ({ key, type: 'boolean', equals: false })),
  ...[
    'stateWithholding',
    'cityWithholding',
    'yonkersWithholding',
    'estimatedPayments',
    'useTax',
    'voluntaryContributions',
    'applyTo2026',
  ].map((key) => ({ key, type: 'decimal' })),
]);
export const NY_2025_CANDIDATE = deepFreeze({
  version: '2025.4-new-york-working-papers',
  scope: 'US-NY',
  physicalFieldCatalogHash: usReviewContentHash(NY_FIELD_CATALOG_DATA),
  schoolDistrictCatalogHash: usReviewContentHash(NY_SCHOOL_DISTRICTS),
  enabled: false,
  coverage:
    'single full-year NY resident; federal ordinary sole-proprietor candidate dependencies; explicit local residence/activity',
  references: NY_2025_SOURCES,
  remaining: [
    'IT-215 negative-line16 reporting boundary pending explicit source rule',
    'IT-2105.9 annualized, early-return-substitution and special-relief cases; June16 payments against earlier April underpayment; late-filing/late-payment interest',
    'IT-2 approved-supplement resolution and NY intake total binding',
    'Full supported-return independent review and approved NY attachment composition',
    'IT-227 detailed contribution allocation when voluntary contributions are positive',
    'NYC business tax, part-year local residency, mixed MCTD allocation, other modifications/credits',
  ],
});
/** IT-201-I2025 single rate schedule and tax computation worksheets7–11.
 * Each dollar line is rounded; explicitly four-decimal ratios remain basis points.
 */
export function newYorkSingleRecapture2025(taxable: bigint, agi: bigint) {
  if (taxable < 0n || agi < 0n) throw new Error('ny-negative-tax-base');
  const rates = [
    [8500n, 0n, 0n, 400n],
    [11700n, 8500n, 340n, 450n],
    [13900n, 11700n, 484n, 525n],
    [80650n, 13900n, 600n, 550n],
    [215400n, 80650n, 4271n, 600n],
    [1077550n, 215400n, 12356n, 685n],
    [5000000n, 1077550n, 71413n, 965n],
    [25000000n, 5000000n, 449929n, 1030n],
  ];
  const [, floor, base, rate] = rates.find(
    ([ceiling]) => taxable <= ceiling!,
  ) ?? [taxable, 25000000n, 2509929n, 1090n];
  const regular = roundNonnegativeRatio(
    base! * 10000n + (taxable - floor!) * rate!,
    10000n,
  );
  const fields: Record<string, string> = {
    '1': agi.toString(),
    '2': taxable.toString(),
  };
  if (agi <= 107650n) return { worksheet: null, tax: regular, fields };
  if (agi > 25000000n) {
    const tax = roundNonnegativeRatio(taxable * 109n, 1000n);
    return {
      worksheet: 11,
      tax,
      fields: { '1': taxable.toString(), '2': tax.toString() },
    };
  }
  if (taxable <= 215400n) {
    const flat = roundNonnegativeRatio(taxable * 6n, 100n);
    fields['3'] = flat.toString();
    if (agi >= 157650n) {
      fields['9'] = flat.toString();
      return { worksheet: 7, tax: flat, fields };
    }
    const benefit = flat - regular,
      excess = agi - 107650n,
      ratio = roundNonnegativeRatio(excess, 5n);
    const recapture = roundNonnegativeRatio(benefit * ratio, 10000n),
      tax = regular + recapture;
    Object.assign(fields, {
      '4': regular.toString(),
      '5': benefit.toString(),
      '6': excess.toString(),
      '7': `${ratio / 10000n}.${(ratio % 10000n).toString().padStart(4, '0')}`,
      '8': recapture.toString(),
      '9': tax.toString(),
    });
    return { worksheet: 7, tax, fields };
  }
  const [worksheet, threshold, baseCapture, increment] =
    taxable <= 1077550n
      ? ([8, 215400n, 568n, 1831n] as const)
      : taxable <= 5000000n
        ? ([9, 1077550n, 2399n, 30172n] as const)
        : ([10, 5000000n, 32571n, 32500n] as const);
  const excess = agi - threshold;
  if (excess < 0n) throw new Error('ny-taxable-exceeds-supported-agi');
  const capped = excess < 50000n ? excess : 50000n,
    ratio = roundNonnegativeRatio(capped, 5n);
  const incremental = roundNonnegativeRatio(increment * ratio, 10000n),
    tax = regular + baseCapture + incremental;
  Object.assign(fields, {
    '3': regular.toString(),
    '4': baseCapture.toString(),
    '5': increment.toString(),
    '6': excess.toString(),
    '7': capped.toString(),
    '8': `${ratio / 10000n}.${(ratio % 10000n).toString().padStart(4, '0')}`,
    '9': incremental.toString(),
    '10': tax.toString(),
  });
  return { worksheet, tax, fields };
}
export function newYorkSingleTax2025(
  taxable: bigint,
  agi: bigint,
  city = false,
): bigint {
  if (taxable < 0n || agi < 0n) throw new Error('ny-negative-tax-base');
  if (!city && agi > 107650n)
    return newYorkSingleRecapture2025(taxable, agi).tax;
  if (taxable < 65000n) {
    const row = NY_2025_SINGLE_TABLES[city ? 'city' : 'state'].find(
      ([low, high]) => taxable >= BigInt(low) && taxable < BigInt(high),
    );
    if (!row) throw new Error('ny-table-gap');
    return BigInt(row[2]);
  }
  if (city)
    return roundNonnegativeRatio(
      1813n * 100000n + (taxable - 50000n) * 3876n,
      100000n,
    );
  return newYorkSingleRecapture2025(taxable, agi).tax;
}
/** Exact source-backed component, useful also for the two published allocation examples.
 * Inputs are reviewed net earnings allocated to each zone, not business gross revenue.
 * The threshold applies separately before rounding; no tax at exactly50000.
 */
export function calculateNyMctmt2025(zone1: string, zone2: string) {
  const a = usdCents(zone1),
    b = usdCents(zone2);
  const tax1 =
    a > 5000000n
      ? roundNonnegativeRatio(roundNonnegativeRatio(a, 100n) * 60n, 10000n)
      : 0n;
  const tax2 =
    b > 5000000n
      ? roundNonnegativeRatio(roundNonnegativeRatio(b, 100n) * 34n, 10000n)
      : 0n;
  return deepFreeze({
    zone1Tax: tax1.toString(),
    zone2Tax: tax2.toString(),
    total: (tax1 + tax2).toString(),
  });
}
export function evaluateNewYork2025WorkingPapers(
  federalInput: FinanceTaxIntake,
  input: FinanceTaxIntake,
) {
  const federal = evaluateUs2025WorkingPapers(federalInput);
  const parsed = FinanceTaxIntakeSchema.safeParse(input);
  const blockers: string[] = [];
  let penaltyProof:
    | ReturnType<typeof calculateNyShortPenalty2025>
    | ReturnType<typeof calculateNyRegularPenalty2025>
    | null = null;
  let recaptureProof: {
    worksheet: number | null;
    tax: string;
    fields: Record<string, string>;
    sourceId: string;
  } | null = null;
  let creditProof: ReturnType<typeof calculateNySingleEic2025> | null = null;
  const rows: {
    key: string;
    value: string;
    dependencies: string[];
    sourceId: string;
    locator: string;
  }[] = [];
  const sourceKeys = (
    dependencies: string[],
    seen = new Set<string>(),
  ): string[] => [
    ...new Set(
      dependencies.flatMap((key): string[] => {
        if (seen.has(key)) return [];
        const next = new Set([...seen, key]);
        if (NY_2025_REQUIRED_FACTS.some((fact) => fact.key === key))
          return [key];
        if (key.includes('.')) return ['federalInputHash'];
        const previous = rows.find((row) => row.key === key);
        if (previous) return sourceKeys(previous.dependencies, next);
        return NY_2025_REQUIRED_FACTS.some((fact) => fact.key === key)
          ? [key]
          : [];
      }),
    ),
  ];
  const finish = () => {
    const scheduleC = federal.evaluation.forms.find((form) => form.id === 'C');
    const federalScheduleCAttachment =
      rows.length && scheduleC
        ? {
            formId: 'C',
            version: '2025',
            required: true,
            reason:
              'IT-201 line6 expressly requires a copy of federal Schedule C',
            sourceId: 'ny-2025-it201',
            sourceHash: NY_2025_SOURCES.find(
              (source) => source.id === 'ny-2025-it201',
            )!.documentHash,
            content: scheduleC,
            contentHash: usReviewContentHash(scheduleC),
            federalInputHash: federal.binding?.inputHash ?? null,
            federalOutputHash: federal.outputHash,
          }
        : null;
    const physicalCoverage =
      parsed.success && rows.length
        ? prepareNy201PhysicalFields(federalInput, parsed.data, rows)
        : null;
    const attachmentCoverage =
      parsed.success && rows.length
        ? prepareNyAttachmentPhysicalFields(
            federalInput,
            parsed.data,
            rows,
            creditProof,
            penaltyProof,
          )
        : null;
    if (physicalCoverage) blockers.push(...physicalCoverage.issues);
    if (attachmentCoverage) blockers.push(...attachmentCoverage.issues);
    return deepFreeze({
      candidate: NY_2025_CANDIDATE,
      definitionHash: usReviewContentHash(NY_2025_CANDIDATE),
      complete: false as const,
      status: rows.length
        ? ('incomplete-working-papers' as const)
        : ('blocked-input' as const),
      binding: parsed.success
        ? {
            caseId: parsed.data.caseId,
            workspaceId: parsed.data.workspaceId,
            taxSubjectId: parsed.data.taxSubjectId,
            revision: parsed.data.revision,
            inputHash: usReviewContentHash(parsed.data),
            federalInputHash: federal.binding?.inputHash ?? null,
            federalOutputHash: federal.outputHash,
          }
        : null,
      evaluation: FinanceTaxEvaluationSchema.parse({
        forms: [
          ...(penaltyProof
            ? [
                {
                  id: 'IT-2105.9',
                  version: '2025',
                  fields: Object.entries(penaltyProof.fields).map(
                    ([key, value]) => ({
                      key,
                      value: { type: 'decimal' as const, value },
                      ruleIds: [`ny2025.IT2105.9.${key}`],
                      sourceFactKeys: NY_PENALTY_REQUIRED_FACTS.map(
                        (entry) => entry.key,
                      ),
                    }),
                  ),
                },
              ]
            : []),
          ...(creditProof
            ? [
                {
                  id: 'IT-215',
                  version: '2025',
                  fields: Object.entries(creditProof.fields).map(
                    ([key, value]) => ({
                      key,
                      value: { type: 'decimal' as const, value },
                      ruleIds: [`ny2025.IT215.${key}`],
                      sourceFactKeys: [
                        'federalInputHash',
                        'otherCreditsOrTaxes',
                        'localResidence',
                      ],
                    }),
                  ),
                },
              ]
            : []),
          {
            id: 'IT-201',
            version: '2025',
            fields: rows.map((row) => ({
              key: row.key,
              value: { type: 'decimal' as const, value: row.value },
              ruleIds: [`ny2025.IT201.${row.key}`],
              sourceFactKeys: sourceKeys(row.dependencies),
            })),
          },
        ],
        issues: blockers.map((code) => ({ code, message: code })),
      }),
      trace: rows,
      physicalCoverage,
      attachmentCoverage,
      federalScheduleCAttachment,
      creditProof,
      penaltyProof,
      recaptureProof,
      applicability: [NY_2025_CHILDLESS_IT270],
      unresolved: [...new Set([...blockers, ...NY_2025_CANDIDATE.remaining])],
      outputHash: usReviewContentHash({
        rows,
        physicalCoverage,
        attachmentCoverage,
        federalScheduleCAttachment,
        creditProof,
        penaltyProof,
        recaptureProof,
        applicability: NY_2025_CHILDLESS_IT270,
        blockers,
        federalOutputHash: federal.outputHash,
        input: parsed.success ? parsed.data : null,
      }),
    });
  };
  if (!parsed.success) {
    blockers.push('invalid-ny-intake');
    return finish();
  }
  const intake = parsed.data;
  if (
    intake.scope.country !== 'US' ||
    intake.scope.subdivision !== 'US-NY' ||
    intake.scope.year !== 2025 ||
    intake.scope.formVersion !== 'IT201-2025' ||
    intake.scope.regime !== 'income-tax-return' ||
    intake.scope.taxpayerType !== 'sole-proprietor' ||
    intake.domesticResident !== true ||
    intake.hasCrossBorderActivity !== false ||
    intake.requestedFeatures.length !== 1 ||
    intake.requestedFeatures[0] !== 'income-tax-return'
  )
    blockers.push('unsupported-ny-scope');
  for (const key of [
    'workspaceId',
    'caseId',
    'taxSubjectId',
    'revision',
  ] as const)
    if (intake[key] !== federalInput[key])
      blockers.push('ny-federal-binding-mismatch');
  const facts = new Map(intake.facts.map((entry) => [entry.key, entry]));
  for (const required of NY_2025_REQUIRED_FACTS) {
    const entry = facts.get(required.key);
    if (
      !entry ||
      entry.reviewState !== 'reviewed' ||
      entry.value.type !== required.type ||
      ('equals' in required && entry.value.value !== required.equals)
    )
      blockers.push(`required-ny-${required.key}`);
    if (entry?.value.type === 'decimal')
      try {
        usdCents(entry.value.value);
      } catch {
        blockers.push(`invalid-ny-${required.key}`);
      }
  }
  for (const entry of intake.facts)
    if (!NY_2025_REQUIRED_FACTS.some((required) => required.key === entry.key))
      blockers.push(`unmapped-ny-${entry.key}`);
  const fact = (key: string) => facts.get(key)?.value.value;
  if (
    !['short-method', 'regular-method'].includes(String(fact('penalty.method')))
  )
    blockers.push('ny-penalty-method-required');
  if (
    !blockers.length &&
    fact('penalty.method') === 'short-method' &&
    (fact('penalty.returnFiledOn') !== 'not-filed' ||
      fact('penalty.returnBalancePaidOn') !== 'unpaid' ||
      usdCents(String(fact('penalty.returnBalancePaid'))) !== 0n)
  )
    blockers.push('ny-short-method-requires-legacy-full-balance-payment-fact');
  if (fact('federalInputHash') !== federal.binding?.inputHash)
    blockers.push('ny-federal-hash-mismatch');
  if (
    !['outside-NYC-Yonkers', 'NYC', 'Yonkers', 'part-year'].includes(
      String(fact('localResidence')),
    )
  )
    blockers.push('ny-local-residence-required');
  if (
    !['outside-MCTD', 'zone1', 'zone2', 'mixed'].includes(
      String(fact('businessLocation')),
    )
  )
    blockers.push('ny-business-location-required');
  if (fact('localResidence') === 'part-year') blockers.push('IT3601-required');
  if (fact('businessLocation') === 'mixed') blockers.push('IT203A-required');
  const values = new Map<string, string | boolean>(
    federal.evaluation.forms.flatMap((form) =>
      form.fields.map(
        (field) => [`${form.id}.${field.key}`, field.value.value] as const,
      ),
    ),
  );
  if (federal.status === 'blocked-input' || !values.has('F1040.24'))
    blockers.push('federal-calculation-incomplete');
  if (!blockers.length)
    blockers.push(
      ...prepareNy201PhysicalFields(federalInput, intake, []).issues,
    );
  if (blockers.length) return finish();
  const source = (key: string) => BigInt(String(values.get(key)));
  const money = (key: string) =>
    roundNonnegativeRatio(usdCents(String(fact(key))), 100n);
  const emit = (
    key: string,
    value: bigint,
    dependencies: string[],
    locator = `IT-201 line${key}`,
  ) => {
    rows.push({
      key,
      value: value.toString(),
      dependencies,
      sourceId:
        (key === '39' || key === '47a') &&
        rows.find((row) => row.key === '38') &&
        BigInt(rows.find((row) => row.key === '38')!.value) < 65000n
          ? 'ny-2025-tables'
          : 'ny-2025-instructions',
      locator,
    });
    return value;
  };
  const pos = (value: bigint) => (value < 0n ? 0n : value);
  const agi = emit('19', source('F1040.11a'), ['F1040.11a']);
  emit('1', source('F1040.1a'), ['F1040.1a']);
  emit('6', source('C.31'), ['C.31']);
  emit('17', source('F1040.9'), ['F1040.9']);
  emit('18', source('F1040.10'), ['F1040.10']);
  for (const key of [
    '2',
    '3',
    '4',
    '5',
    '7',
    '8',
    '9',
    '10',
    '11',
    '12',
    '13',
    '14',
    '15',
    '16',
  ])
    emit(
      key,
      0n,
      ['federalInputHash'],
      `IT-201 line${key}: reviewed federal ordinary-income exclusions`,
    );
  for (const key of [
    '20',
    '21',
    '22',
    '23',
    '25',
    '26',
    '27',
    '28',
    '29',
    '30',
    '31',
  ])
    emit(
      key,
      0n,
      ['nyModifications'],
      `IT-201 line${key}: reviewed absence of NY additions/subtractions`,
    );
  emit('24', agi, ['19', '23']);
  emit('32', 0n, ['nyModifications']);
  emit('33', agi, ['24', '32']);
  emit(
    '34',
    8000n,
    ['standardDeductionElection'],
    'single not dependent standard deduction table',
  );
  const taxable = emit('35', pos(agi - 8000n), ['33', '34']);
  emit('36', 0n, ['federal.dependants']);
  emit('37', taxable, ['35', '36']);
  emit('38', taxable, ['37']);
  const state = newYorkSingleTax2025(taxable, agi);
  if (agi > 107650n) {
    const proof = newYorkSingleRecapture2025(taxable, agi);
    recaptureProof = {
      ...proof,
      tax: proof.tax.toString(),
      sourceId: 'ny-2025-instructions',
    };
  }
  if (state === null) {
    blockers.push('ny-high-agi-recapture-required');
    return finish();
  }
  emit(
    '39',
    state,
    ['33', '38'],
    'NYS single table/rate schedule; high-AGI worksheets7–11',
  );
  const household =
    agi <= 5000n
      ? 75n
      : agi <= 6000n
        ? 60n
        : agi <= 7000n
          ? 50n
          : agi <= 20000n
            ? 45n
            : agi <= 25000n
              ? 40n
              : agi <= 28000n
                ? 20n
                : 0n;
  emit('40', household, ['19'], 'NYS household credit table1');
  emit('41', 0n, ['otherStateIncomeOrCredits']);
  emit('42', 0n, ['otherCreditsOrTaxes']);
  emit('43', household, ['40', '41', '42']);
  const afterHousehold = emit('44', pos(state - household), ['39', '43']);
  emit('45', 0n, ['otherCreditsOrTaxes']);
  const stateTax = emit('46', afterHousehold, ['44', '45']);
  const city = fact('localResidence') === 'NYC';
  const yonkers = fact('localResidence') === 'Yonkers';
  emit('47', city ? taxable : 0n, ['localResidence', '38']);
  const cityTax = emit(
    '47a',
    city ? newYorkSingleTax2025(taxable, agi, true)! : 0n,
    ['47'],
  );
  const cityHouse = emit(
    '48',
    city ? (agi <= 10000n ? 15n : agi <= 12500n ? 10n : 0n) : 0n,
    ['19', 'localResidence'],
    'NYC household credit table4',
  );
  const cityNet = emit('49', pos(cityTax - cityHouse), ['47a', '48']);
  emit('50', 0n, ['localResidence']);
  emit('51', 0n, ['otherCreditsOrTaxes']);
  emit('52', cityNet, ['49', '50', '51']);
  emit('53', 0n, ['otherCreditsOrTaxes']);
  const cityTotal = emit('54', cityNet, ['52', '53']);
  // Exact ordinary net earnings, independent of Social Security wage cap.
  const profit = federal.trace.find(
    (row) => row.formId === 'C' && row.line === '31',
  )!;
  const netNumerator = BigInt(profit.exactNumerator) * 9235n,
    netDenominator = BigInt(profit.exactDenominator) * 10000n;
  const liable = netNumerator > 50000n * netDenominator;
  const zone = fact('businessLocation');
  emit(
    '54a',
    zone === 'zone1' && liable
      ? roundNonnegativeRatio(netNumerator, netDenominator)
      : 0n,
    ['businessLocation', 'C.31'],
  );
  emit(
    '54b',
    zone === 'zone2' && liable
      ? roundNonnegativeRatio(netNumerator, netDenominator)
      : 0n,
    ['businessLocation', 'C.31'],
  );
  const z1 = emit(
    '54c',
    zone === 'zone1' && liable
      ? roundNonnegativeRatio(
          roundNonnegativeRatio(netNumerator, netDenominator) * 60n,
          10000n,
        )
      : 0n,
    ['54a'],
  );
  const z2 = emit(
    '54d',
    zone === 'zone2' && liable
      ? roundNonnegativeRatio(
          roundNonnegativeRatio(netNumerator, netDenominator) * 34n,
          10000n,
        )
      : 0n,
    ['54b'],
  );
  const mctmt = emit('54e', z1 + z2, ['54c', '54d']);
  const school = emit('69', city && agi <= 250000n ? 63n : 0n, [
    '19',
    'localResidence',
  ]);
  const schoolRate = emit(
    '69a',
    !city || agi > 500000n
      ? 0n
      : taxable <= 12000n
        ? roundNonnegativeRatio(taxable * 171n, 100000n)
        : roundNonnegativeRatio(
            21n * 100000n + (taxable - 12000n) * 228n,
            100000n,
          ),
    ['47', '19'],
  );
  const federalEic = source('F1040.27a');
  let stateEic = 0n,
    cityEic = 0n;
  if (federalEic > 0n) {
    creditProof = calculateNySingleEic2025({
      agi,
      federalEic,
      stateTax: state,
      household,
      wages: source('F1040.1z'),
      business: BigInt(
        String(values.get('EICB.1e') ?? values.get('EICB.2c') ?? '0'),
      ),
      city,
    });
    if (creditProof.stateEic === null) {
      blockers.push(...creditProof.unresolved);
      return finish();
    }
    stateEic = BigInt(creditProof.stateEic);
    cityEic = BigInt(creditProof.cityEic);
  }
  emit('65', stateEic, ['federalInputHash', '39', '40'], 'IT-215 line16');
  emit(
    '70',
    cityEic,
    ['federalInputHash', '33', 'localResidence'],
    'IT-215 line27',
  );
  emit(
    '70a',
    0n,
    ['federalInputHash'],
    'IT-270 Part1 A: no dependants, not eligible',
  );
  const surcharge = emit(
    '55',
    yonkers
      ? roundNonnegativeRatio(pos(stateTax - stateEic) * 1675n, 10000n)
      : 0n,
    ['46', '65', 'localResidence'],
    'Yonkers worksheet: ordinary case other credits zero; rate16.75%',
  );
  emit('56', 0n, ['yonkersNonresidentEarnings']);
  emit('57', 0n, ['localResidence']);
  const combined = emit('58', cityTotal + mctmt + surcharge, [
    '54',
    '54e',
    '55',
    '56',
    '57',
  ]);
  const use = emit('59', money('useTax'), ['useTax']);
  const donations = emit('60', money('voluntaryContributions'), [
    'voluntaryContributions',
  ]);
  if (donations > 0n) blockers.push('IT227-contribution-allocation-required');
  const total = emit('61', stateTax + combined + use + donations, [
    '46',
    '58',
    '59',
    '60',
  ]);
  emit('62', total, ['61']);
  for (const key of ['63', '64', '66', '67', '68', '71'])
    emit(
      key,
      0n,
      ['otherCreditsOrTaxes', 'federalInputHash'],
      `IT-201 line${key}: reviewed absence of other credits and dependants`,
    );

  const sw = emit('72', money('stateWithholding'), ['stateWithholding']);
  const cw = emit('73', money('cityWithholding'), ['cityWithholding']);
  const yw = emit('74', money('yonkersWithholding'), ['yonkersWithholding']);
  const est = emit('75', money('estimatedPayments'), ['estimatedPayments']);
  const payments = emit(
    '76',
    sw + cw + yw + est + school + schoolRate + stateEic + cityEic,
    ['72', '73', '74', '75', '69', '69a', '65', '70'],
  );
  try {
    const penaltyInput = {
      taxBeforeRefundableCredits: stateTax + combined,
      refundableCredits:
        stateEic +
        cityEic +
        school +
        schoolRate +
        money('penalty.starCreditReceived'),
      withholding: sw + cw + yw,
      estimatedPayments: String(fact('estimatedPayments')),
      priorYearTaxAfterCredits: money('penalty.priorYearTaxAfterCredits'),
      priorYearAgi: money('penalty.priorYearAgi'),
      priorYearMctdEarnings: money('penalty.priorYearMctdEarnings'),
      priorYearReturnFiled: fact('penalty.priorYearReturnFiled') === true,
      priorYearFull12Months: fact('penalty.priorYearFull12Months') === true,
      priorYearNyResidentOrSourceIncome:
        fact('penalty.priorYearNyResidentOrSourceIncome') === true,
      subjectIncomeTaxCount: city || yonkers ? (2 as const) : (1 as const),
      paymentLedger: String(fact('penalty.paymentLedger')),
      balancePaidOn: String(fact('penalty.balancePaidOn')),
    };
    penaltyProof =
      fact('penalty.method') === 'regular-method'
        ? calculateNyRegularPenalty2025({
            ...penaltyInput,
            returnFiledOn: String(fact('penalty.returnFiledOn')),
            returnBalancePaidOn: String(fact('penalty.returnBalancePaidOn')),
            returnBalancePaid: String(fact('penalty.returnBalancePaid')),
          })
        : calculateNyShortPenalty2025(penaltyInput);
  } catch (error) {
    blockers.push(
      error instanceof Error
        ? error.message
        : 'ny-penalty-calculation-unavailable',
    );
    return finish();
  }
  const penalty = emit(
    '81',
    BigInt(penaltyProof.penalty),
    [
      ...[...NY_PENALTY_REQUIRED_FACTS, ...NY_REGULAR_PENALTY_FACTS].map(
        (entry) => entry.key,
      ),
      '46',
      '58',
      '65',
      '70',
      '69',
      '69a',
      '72',
      '73',
      '74',
    ],
    penaltyProof.method === 'regular-method'
      ? 'IT-2105.9 line39'
      : 'IT-2105.9 line24',
  );
  const over = emit('77', pos(payments - total - penalty), ['76', '62', '81']);
  const applied = money('applyTo2026');
  if (applied > over) {
    blockers.push('ny-refund-allocation-exceeds-overpayment');
    return finish();
  }
  emit('78', over - applied, ['77', 'applyTo2026']);
  emit('79', applied, ['applyTo2026']);
  emit('80', pos(total + penalty - payments), ['62', '81', '76']);
  emit('82', 0n, ['lateFilingOrPayment']);
  return finish();
}
