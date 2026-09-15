import { z } from 'zod';
import {
  FinanceDecimalSchema,
  UploadNormalizedStatementSchema,
  type FinanceCurrency,
  type NormalizedCsvMapping,
} from '@emdo/contracts';
import { parseFinanceCsvTable } from './imports.js';
import {
  formatFinanceDecimal,
  moneyValue,
  parseFinanceDecimal,
} from './decimal.js';

export interface NormalizedStatementRow {
  sourceRow: number;
  date: string | null;
  description: string;
  amount: string | null;
  currency: FinanceCurrency;
  externalId: string | null;
  issues: string[];
  provenance: Record<
    string,
    { sourceRow: number; column: string; raw: string }
  >;
}
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function parseReportDecimal(
  input: string,
  decimal = '.',
  grouping = '',
): string {
  let text = input.trim().replace(/\u00a0/g, ' '),
    negative = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1);
  } else if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith('+')) text = text.slice(1);
  const parts = text.split(decimal);
  if (parts.length > 2) throw new Error('amount-format');
  let whole = parts[0] ?? '';
  const fraction = parts[1];
  if (grouping && whole.includes(grouping)) {
    if (
      !new RegExp(`^\\d{1,3}(?:${escapeRegex(grouping)}\\d{3})+$`).test(whole)
    )
      throw new Error('amount-grouping');
    whole = whole.split(grouping).join('');
  }
  if (
    !/^\d+$/.test(whole) ||
    (fraction !== undefined && !/^\d{1,12}$/.test(fraction))
  )
    throw new Error('amount-format');
  const canonical = `${negative ? '-' : ''}${whole.replace(/^0+(?=\d)/, '')}${fraction === undefined ? '' : `.${fraction}`}`;
  FinanceDecimalSchema.parse(canonical);
  return formatFinanceDecimal(parseFinanceDecimal(canonical));
}
export function parseStatementAmount(
  input: string,
  currency: FinanceCurrency,
  decimal = '.',
  grouping = '',
): string {
  const canonical = parseReportDecimal(input, decimal, grouping);
  const value = moneyValue(canonical, currency);
  if (value === 0n) throw new Error('zero-amount');
  return formatFinanceDecimal(value);
}
export function parseReportDate(
  value: string,
  format: NormalizedCsvMapping['dateFormat'] | 'ofx',
): string {
  let date = value.trim();
  if (format === 'ofx') {
    // OFX bank business date is retained verbatim; never shift it into Toronto time.
    if (!/^\d{8}(?:\d{6}(?:\.\d{1,3})?(?:\[[^\]]+\])?)?$/.test(date))
      throw new Error('date-format');
    date = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  } else if (format === 'yyyy/mm/dd') {
    const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(date);
    if (!match) throw new Error('date-format');
    date = `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`;
  } else if (format !== 'yyyy-mm-dd') {
    const pattern =
      format === 'dd.mm.yyyy'
        ? /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/
        : /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
    const match = pattern.exec(date);
    if (!match) throw new Error('date-format');
    const month = format === 'mm/dd/yyyy' ? match[1] : match[2],
      day = format === 'mm/dd/yyyy' ? match[2] : match[1];
    date = `${match[3]}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
  }
  return z.iso.date().parse(date);
}
function normalized(
  raw: {
    sourceRow: number;
    date: string;
    description: string;
    amount: string;
    externalId: string;
    columns: Record<string, string>;
  },
  currency: FinanceCurrency,
  format: NormalizedCsvMapping['dateFormat'] | 'ofx',
  decimal = '.',
  grouping = '',
): NormalizedStatementRow {
  const issues: string[] = [];
  let date: string | null = null,
    amount: string | null = null;
  try {
    date = parseReportDate(raw.date, format);
  } catch {
    issues.push('invalid-date');
  }
  try {
    amount = parseStatementAmount(raw.amount, currency, decimal, grouping);
  } catch {
    issues.push('invalid-amount');
  }
  const description = raw.description.trim();
  if (!description || description.length > 500)
    issues.push('invalid-description');
  const externalId = raw.externalId.trim() || null;
  if (externalId && externalId.length > 200) issues.push('invalid-external-id');
  const provenance: NormalizedStatementRow['provenance'] = {};
  for (const [field, column] of Object.entries(raw.columns))
    provenance[field] = {
      sourceRow: raw.sourceRow,
      column,
      raw: String(
        raw[field as 'date' | 'description' | 'amount' | 'externalId'] ?? '',
      ),
    };
  return {
    sourceRow: raw.sourceRow,
    date,
    description: description.slice(0, 500),
    amount,
    currency,
    externalId: externalId?.slice(0, 200) ?? null,
    issues,
    provenance,
  };
}
export function normalizeStatement(
  input: unknown,
  currency: FinanceCurrency,
): NormalizedStatementRow[] {
  const data = UploadNormalizedStatementSchema.parse(input);
  if (new TextEncoder().encode(data.sourceText).byteLength > 2_097_152)
    throw new Error('finance-normalized-import-too-large');
  if (data.format === 'csv') {
    const mapping = data.mapping!;
    const parsed = parseFinanceCsvTable(data.sourceText.replace(/^\uFEFF/, ''));
    if (
      parsed.status !== 'parsed' ||
      parsed.rows.length < 2 ||
      parsed.rows.length > 2001
    )
      throw new Error('finance-normalized-csv-invalid');
    const [header, ...rows] = parsed.rows;
    const columns = header!.cells;
    if (new Set(columns).size !== columns.length || columns.some((c) => !c))
      throw new Error('finance-normalized-csv-header-invalid');
    if (
      Object.values(mapping.columns).some((column) => !columns.includes(column))
    )
      throw new Error('finance-normalized-csv-mapping-invalid');
    return rows.map((row) => {
      const value = (column: string | undefined) =>
        column === undefined ? '' : (row.cells[columns.indexOf(column)] ?? '');
      const c = mapping.columns;
      let amount = value(c.amount);
      if (c.amount === undefined) {
        const rawDebit = value(c.debit),
          rawCredit = value(c.credit);
        const blankOrZero = (v: string) =>
          v.trim() === '' || /^0(?:[.,]0+)?$/.test(v.trim());
        const debit = blankOrZero(rawDebit) ? '' : rawDebit,
          credit = blankOrZero(rawCredit) ? '' : rawCredit;
        if (debit !== '' && credit === '') amount = `-${debit}`;
        else if (credit !== '' && debit === '') amount = credit;
        else amount = '';
      }
      const result = normalized(
        {
          sourceRow: row.sourceRow,
          date: value(c.date),
          description: value(c.description),
          amount,
          externalId: value(c.externalId),
          columns: {
            date: c.date,
            description: c.description,
            amount: c.amount ?? `${c.debit}/${c.credit}`,
            externalId: c.externalId ?? '',
          },
        },
        currency,
        mapping.dateFormat,
        mapping.decimalSeparator,
        mapping.groupingSeparator,
      );
      if (row.cells.length !== columns.length)
        result.issues.push('column-count-mismatch');
      return result;
    });
  }
  const source = data.sourceText;
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error('finance-normalized-ofx-unsafe-xml');
  const containers = [...source.matchAll(/<(STMTRS|CCSTMTRS)>/gi)];
  const currencies = [...source.matchAll(/<CURDEF>\s*([^<\r\n]*)/gi)];
  if (
    containers.length !== 1 ||
    currencies.length !== 1 ||
    currencies[0]![1]!.trim().toUpperCase() !== currency
  )
    throw new Error('finance-normalized-ofx-account-or-currency-mismatch');
  const blocks = [
    ...source.matchAll(
      /<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>|<\/BANKTRANLIST>|<\/OFX>|$))/gi,
    ),
  ];
  if (blocks.length < 1 || blocks.length > 2000)
    throw new Error('finance-normalized-ofx-rows-invalid');
  return blocks.map((block, index) => {
    const tag = (name: string) =>
      new RegExp(`<${name}>\\s*([^<\\r\\n]*)`, 'i')
        .exec(block[1]!)?.[1]
        ?.trim() ?? '';
    return normalized(
      {
        sourceRow: index + 1,
        date: tag('DTPOSTED'),
        description: [tag('NAME'), tag('MEMO')].filter(Boolean).join(' — '),
        amount: tag('TRNAMT'),
        externalId: tag('FITID'),
        columns: {
          date: 'DTPOSTED',
          description: 'NAME/MEMO',
          amount: 'TRNAMT',
          externalId: 'FITID',
        },
      },
      currency,
      'ofx',
    );
  });
}
