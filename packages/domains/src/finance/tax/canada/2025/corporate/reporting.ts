import { deepFreeze } from '@emdo/contracts';
import {
  CORPORATE_XFA_FIELDS,
  type CorporateXfaField,
} from './xfa-inventory.js';
import { CANADA_CORPORATE_2025_SOURCES } from './sources.js';
import type { CorporateForm } from './workflow.js';

/** Field precision is proven by that field's control; it does not establish a rounding method. */
export function encodeCorporateFieldLosslessly(
  value: string,
  evidence: CorporateXfaField,
) {
  const parsed = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);
  if (!parsed) throw new Error('invalid-corporate-exact-decimal');
  const places = evidence.decimalPlaces,
    digits = evidence.maxIntegerDigits;
  if (places === null || digits === null)
    return { status: 'precision-unproven' as const, encodedAmount: null };
  if (
    parsed[2]!.length > digits ||
    (evidence.positiveOnly && parsed[1] === '-' && /[1-9]/.test(value))
  )
    return {
      status: 'outside-proven-field-range' as const,
      encodedAmount: null,
    };
  const fraction = (parsed[3] ?? '').replace(/0+$/, '');
  if (fraction.length > places)
    return { status: 'rounding-rule-required' as const, encodedAmount: null };
  const isZero = !/[1-9]/.test(parsed[2]! + fraction);
  return {
    status: 'lossless-at-proven-precision' as const,
    encodedAmount: `${parsed[1] && !isZero ? '-' : ''}${parsed[2]}${places ? `.${fraction.padEnd(places, '0')}` : ''}`,
  };
}

type Money = {
  currency: 'CAD';
  exactDecimal: string;
  numerator: string;
  denominator: string;
  reportableAmount: string | null;
};
const isMoney = (v: unknown): v is Money =>
  v !== null && typeof v === 'object' && 'exactDecimal' in v;
const key = (form: string, line: string) => `${form}.${line}`;
const expenseCodes = [
  '8521',
  '8690',
  '8760',
  '8810',
  '8910',
  '9060',
  '9130',
  '9220',
];
const dependencies: Record<string, string[]> = {
  'GIFI100.1599': ['GIFI100.1001', 'GIFI100.1060', 'GIFI100.1483'],
  'GIFI100.2599': ['GIFI100.1599'],
  'GIFI100.3139': ['GIFI100.2621', 'GIFI100.2680'],
  'GIFI100.3499': ['GIFI100.3139'],
  'GIFI100.3620': ['GIFI100.3500', 'GIFI100.3600'],
  'GIFI100.3640': ['GIFI100.3499', 'GIFI100.3620'],
  'GIFI100.3680': ['GIFI125.9999'],
  'GIFI100.3849': ['GIFI100.3660', 'GIFI100.3680'],
  'GIFI125.8299': ['GIFI125.8000'],
  'GIFI125.9367': expenseCodes.map((c) => `GIFI125.${c}`),
  'GIFI125.8518': ['GIFI125.8320', 'GIFI125.8340', 'GIFI125.8360'],
  'GIFI125.9368': ['GIFI125.9367', 'GIFI125.8518'],
  'S500.odfOntarioIncome': ['S500.1A'],
  'S500.odfAllIncome': ['T2.360'],
  'GIFI125.9369': ['GIFI125.8299', 'GIFI125.9368'],
  'GIFI125.9970': ['GIFI125.9369'],
  'GIFI125.9999': ['GIFI125.9970', 'GIFI125.9990'],
  'S1.A': ['GIFI125.9999'],
  'S1.101': ['GIFI125.9990'],
  'S1.500': ['S1.101'],
  'S1.B': ['S1.A', 'S1.500'],
  'S1.C': ['S1.B', 'S1.510'],
  'T2.300': ['S1.C'],
  'T2.360': ['T2.300'],
  'T2.400': ['T2.300'],
  'T2.405': ['T2.360'],
  'T2.426': ['T2.410', 'T2.422'],
  'T2.428': ['T2.426'],
  'T2.430': ['T2.400', 'T2.405', 'T2.410', 'T2.428'],
  'T2.550': ['T2.360'],
  'T2.608': ['T2.360'],
  'T2.700': ['T2.550', 'T2.608', 'T2.430', 'T2.638'],
  'T2.760': ['S5.255'],
  'T2.770': ['T2.700', 'T2.760'],
  'T2.890': ['T2.840', 'T2.784'],
  'T2.refund': ['T2.770', 'T2.890'],
  'T2.balanceOwing': ['T2.770', 'T2.890'],
  'S500.1A': ['T2.360'],
  'S500.1C': ['S500.1A'],
  'S500.2A': ['T2.400'],
  'S500.2B': ['T2.405'],
  'S500.2C': ['T2.410'],
  'S500.2D': ['T2.415'],
  'S500.2F': ['S500.2C', 'S500.2D'],
  'S500.2G': ['S500.2F'],
  'S500.2I': ['S500.2C', 'S500.2G', 'S500.2H'],
  'S500.2J': ['S500.2A', 'S500.2B', 'S500.2I'],
  'S500.2L': ['S500.2J'],
  'S500.2M': ['S500.1A'],
  'S500.2N': ['S500.2L', 'S500.2M'],
  'S500.2O': ['S500.2N'],
  'S5.270': ['S500.1C'],
  'S5.402': ['S500.2O'],
  'S5.290': ['S5.270', 'S5.402'],
  'S5.255': ['S5.290'],
};
const leaves = new Set([
  ...['1001', '1060', '1483', '2621', '2680', '3500', '3600', '3660'].map(
    (c) => `GIFI100.${c}`,
  ),
  ...['8000', '9990', '8320', '8340', '8360', ...expenseCodes].map(
    (c) => `GIFI125.${c}`,
  ),
  'S1.510',
  ...['410', '415', '417', '422', '604', '638', '840'].map((c) => `T2.${c}`),
  'S500.2H',
]);
type Binding = {
  field: CorporateXfaField;
  companionCodeField: CorporateXfaField | null;
  companionCodeValue: string | null;
};
function bindings(forms: readonly CorporateForm[]) {
  const result = new Map<string, Binding[]>();
  for (const form of forms) {
    const inventory = CORPORATE_XFA_FIELDS.filter((f) => f.form === form.id);
    const rows = new Map<string, number>();
    for (const [line, value] of Object.entries(form.fields)) {
      let matches: CorporateXfaField[] = [];
      let codeField: CorporateXfaField | null = null;
      let codeValue: string | null = null;
      if (isMoney(value) && (form.id === 'GIFI100' || form.id === 'GIFI125')) {
        let category: string;
        if (form.id === 'GIFI100')
          category =
            Number(line) < 2600
              ? 'Assets'
              : Number(line) < 3500
                ? 'Liabilities'
                : Number(line) < 3660
                  ? 'Shareholder equity'
                  : 'Retained earnings';
        else
          category = ['8000', '8299'].includes(line)
            ? 'Non-farming revenue'
            : ['8320', '8340', '8360', '8518'].includes(line)
              ? 'Non-farming expenses. Cost of sales'
              : Number(line) < 9970
                ? 'Non-farming expenses. Operating expenses'
                : 'Extraordinary items and income taxes';
        const fixed = inventory.filter(
          (f) =>
            new RegExp(`^Field [Cc]ode ${line}\\.`).test(f.assist ?? '') &&
            f.assist?.endsWith('Amount.') &&
            !f.path.includes('Sch140'),
        );
        if (fixed.length) {
          matches = fixed;
        } else if (form.id === 'GIFI125' && ['9970', '9999'].includes(line)) {
          matches = inventory.filter(
            (f) =>
              f.assist?.startsWith(`Field code ${line}.`) &&
              f.assist.endsWith('Amount.') &&
              !f.path.includes('Sch140'),
          );
        } else {
          const row = (rows.get(category) ?? 0) + 1;
          rows.set(category, row);
          matches = inventory.filter(
            (f) => f.assist === `${category}. Amount. Row ${row}.`,
          );
          codeField =
            inventory.find(
              (f) =>
                f.assist?.toLowerCase() ===
                `${category}. Field code. Row ${row}.`.toLowerCase(),
            ) ?? null;
          codeValue = line;
        }
      } else {
        const section = /^p([3456789])\.([A-Z]+)$/.exec(line);
        const special = {
          'p4.minimum': 'Amount A, B, C, or K, whichever is the least.',
          'p9.totalFederal': 'Total federal tax.',
          'p9.balance': 'Balance.',
          odfOntarioIncome: 'Taxable income for Ontario.',
          odfAllIncome: 'Taxable income for all provinces.',
        }[
          line as
            | 'p4.minimum'
            | 'p9.totalFederal'
            | 'p9.balance'
            | 'odfOntarioIncome'
            | 'odfAllIncome'
        ];
        const prefix =
          special ??
          (section
            ? `Amount ${section[2]}.`
            : line === 'refund'
              ? 'Refund.'
              : line === 'balanceOwing'
                ? 'Balance owing.'
                : /^[0-9]{3,4}$/.test(line)
                  ? `Line ${line}.`
                  : `Amount ${line}.`);
        matches = inventory.filter(
          (f) =>
            (f.assist?.startsWith(prefix) ||
              (section && f.assist?.includes(`. ${prefix}`))) &&
            (!section || f.path.includes(`.Page${section[1]}.`)) &&
            (!isMoney(value) || f.decimalPlaces !== null),
        );
        if (form.id === 'T2' && ['632', '636'].includes(line))
          matches.push(
            ...inventory.filter(
              (f) =>
                f.path.includes('.Page6.') &&
                f.assist?.startsWith(
                  line === '632'
                    ? 'Foreign non-business income tax credit from line 632'
                    : 'Foreign business income tax credit from line 636',
                ),
            ),
          );
        if (form.id === 'S50')
          matches = matches.filter((f) => f.assist?.includes('Row 1.'));
      }
      if (matches.length)
        result.set(
          key(form.id, line),
          matches.map((field) => ({
            field,
            companionCodeField: codeField,
            companionCodeValue: codeValue,
          })),
        );
    }
  }
  return result;
}

/** Reporting eligibility propagates field by field; an exact integer cannot hide unresolved upstream rounding. */
export function buildCorporateReporting(
  forms: CorporateForm[],
  additionalDependencies: Record<string, string[]> = {},
) {
  const graph = { ...dependencies, ...additionalDependencies };
  const mapped = bindings(forms);
  const moneyValues = new Map<string, Money>();
  for (const form of forms)
    for (const [line, value] of Object.entries(form.fields))
      if (isMoney(value)) moneyValues.set(key(form.id, line), value);
  type Report = {
    id: string;
    status: string;
    encodingStatus: string;
    encodedAmount: string | null;
    reportableAmount: string | null;
    dependencies: string[];
    blockingDependencies: string[];
    precision: {
      decimalPlaces: number | null;
      maxIntegerDigits: number | null;
    } | null;
    bindings: Binding[];
  };
  const reports = new Map<string, Report>();
  const visiting = new Set<string>();
  function resolve(id: string): Report {
    const known = reports.get(id);
    if (known) return known;
    if (visiting.has(id))
      throw new Error(`corporate-reporting-dependency-cycle:${id}`);
    visiting.add(id);
    const value = moneyValues.get(id);
    if (!value) throw new Error(`corporate-reporting-missing-dependency:${id}`);
    const fieldBindings = mapped.get(id) ?? [];
    const evidence = fieldBindings[0]?.field;
    const encoding = evidence
      ? encodeCorporateFieldLosslessly(value.exactDecimal, evidence)
      : { status: 'field-mapping-unproven', encodedAmount: null };
    const deps = graph[id] ?? [];
    const blockers = deps.filter((d) => resolve(d).reportableAmount === null);
    const graphKnown = leaves.has(id) || id in graph;
    const status = !graphKnown
      ? 'reporting-dependencies-unproven'
      : blockers.length
        ? 'upstream-reporting-unresolved'
        : encoding.status;
    const report = {
      id,
      status,
      encodingStatus: encoding.status,
      encodedAmount: encoding.encodedAmount,
      reportableAmount:
        status === 'lossless-at-proven-precision'
          ? encoding.encodedAmount
          : null,
      dependencies: deps,
      blockingDependencies: blockers,
      precision: evidence
        ? {
            decimalPlaces: evidence.decimalPlaces,
            maxIntegerDigits: evidence.maxIntegerDigits,
          }
        : null,
      bindings: fieldBindings,
    };
    reports.set(id, report);
    visiting.delete(id);
    return report;
  }
  for (const id of moneyValues.keys()) resolve(id);
  const numericNonMoneyFields = [
    { form: 'S50', line: '400', unit: 'percentage', dependency: null },
    { form: 'S50', line: '500', unit: 'percentage', dependency: null },
    { form: 'S500', line: '1B', unit: 'percentage', dependency: null },
    { form: 'S500', line: '2K', unit: 'ratio', dependency: 'S500.1A' },
  ].map(({ form, line, unit, dependency }) => {
    const id = key(form, line);
    const raw = forms.find((f) => f.id === form)?.fields[line];
    if (typeof raw !== 'string')
      throw new Error(`corporate-numeric-scalar-required:${id}`);
    const exactDecimal = raw.endsWith('%') ? raw.slice(0, -1) : raw;
    const fieldBindings = mapped.get(id) ?? [];
    const evidence = fieldBindings[0]?.field;
    const encoded = evidence
      ? encodeCorporateFieldLosslessly(exactDecimal, evidence)
      : { status: 'field-mapping-unproven', encodedAmount: null };
    const blockingDependencies =
      dependency && resolve(dependency).reportableAmount === null
        ? [dependency]
        : [];
    return {
      id,
      unit,
      exactDecimal,
      encodedValue: encoded.encodedAmount,
      reportableValue:
        blockingDependencies.length === 0 ? encoded.encodedAmount : null,
      status: blockingDependencies.length
        ? 'upstream-reporting-unresolved'
        : encoded.status,
      blockingDependencies,
      bindings: fieldBindings,
    };
  });
  const mappedOrdinals = new Set(
    [...mapped.values()]
      .flat()
      .flatMap((b) => [
        `${b.field.form}:${b.field.ordinal}`,
        ...(b.companionCodeField
          ? [`${b.companionCodeField.form}:${b.companionCodeField.ordinal}`]
          : []),
      ]),
  );
  const coverage = [...new Set(forms.map((f) => f.id))].map((form) => {
    const inventory = CORPORATE_XFA_FIELDS.filter((f) => f.form === form);
    return {
      form,
      complete: false as const,
      inventoryFieldCount: inventory.length,
      mappedInventoryFieldCount: inventory.filter((f) =>
        mappedOrdinals.has(`${form}:${f.ordinal}`),
      ).length,
      // Includes unused repeating rows, buttons, other regimes and conditional fields; not a required-field count.
      unclassifiedInventoryFields: inventory
        .filter((f) => !mappedOrdinals.has(`${form}:${f.ordinal}`))
        .map((f) => ({ ordinal: f.ordinal, path: f.path, assist: f.assist })),
      unmappedLogicalFields: Object.keys(
        forms.find((f) => f.id === form)!.fields,
      ).filter((line) => !mapped.has(key(form, line))),
    };
  });
  return deepFreeze({
    proof: 'official-fillable-form-control-precision-only' as const,
    complete: false as const,
    roundingMethod: 'not-established' as const,
    forms: forms.map((form) => ({
      ...form,
      fields: Object.fromEntries(
        Object.entries(form.fields).map(([line, value]) => [
          line,
          isMoney(value)
            ? {
                ...value,
                reportableAmount: resolve(key(form.id, line)).reportableAmount,
              }
            : value,
        ]),
      ),
    })),
    fields: [...moneyValues.keys()].map((id) => resolve(id)),
    numericNonMoneyFields,
    coverage,
    sources: CANADA_CORPORATE_2025_SOURCES.filter((s) =>
      s.file.includes('-fill-'),
    ),
  });
}
