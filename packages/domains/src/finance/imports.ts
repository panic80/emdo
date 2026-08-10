import { createHash } from 'node:crypto';

import {
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  SchemaVersionSchema,
  Sha256Schema,
  deepFreeze,
  type DeepReadonly,
} from '@emdo/contracts';
import { z } from 'zod';

import {
  boundedFinanceParse,
  financeSafeError,
  type FinanceSafeError,
} from './guard.js';
import { parseCadDecimal } from './money.js';
import {
  FinanceRecordSchema,
  validateFinanceRecord,
  type FinanceTransactionRecord,
} from './records.js';

type ImportedFinanceTransactionRecord = FinanceTransactionRecord & {
  readonly source: Extract<
    FinanceTransactionRecord['source'],
    { readonly kind: 'import' }
  >;
};

const MAX_SOURCE_CHARACTERS = 5_000_000;
const MAX_IMPORT_ROWS = 100_000;
const MAX_CSV_COLUMNS = 128;
const MAX_CELL_CHARACTERS = 10_000;

const ImportCommonFields = {
  sourceText: z.string().min(1).max(MAX_SOURCE_CHARACTERS),
  sourceHash: Sha256Schema,
  accountId: OpaqueReferenceSchema,
  spaceId: OpaqueReferenceSchema,
  ownerUserId: OpaqueReferenceSchema,
  previewedAt: IsoDateTimeSchema,
  existingFingerprints: z.array(Sha256Schema).max(MAX_IMPORT_ROWS),
} as const;

const CsvMappingSchema = z
  .strictObject({
    dateFormat: z.enum(['yyyy-mm-dd', 'mm/dd/yyyy', 'dd/mm/yyyy']),
    defaultCategoryId: OpaqueReferenceSchema.nullable(),
    columns: z.strictObject({
      postedOn: z.string().trim().min(1).max(200),
      description: z.string().trim().min(1).max(200),
      amount: z.string().trim().min(1).max(200).optional(),
      debit: z.string().trim().min(1).max(200).optional(),
      credit: z.string().trim().min(1).max(200).optional(),
      externalId: z.string().trim().min(1).max(200).optional(),
      categoryId: z.string().trim().min(1).max(200).optional(),
    }),
  })
  .superRefine((mapping, context) => {
    const hasSignedAmount = mapping.columns.amount !== undefined;
    const hasDebitCredit =
      mapping.columns.debit !== undefined &&
      mapping.columns.credit !== undefined;
    if (
      hasSignedAmount === hasDebitCredit ||
      (hasSignedAmount &&
        (mapping.columns.debit !== undefined ||
          mapping.columns.credit !== undefined))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['columns'],
        message:
          'Map one signed amount column or both debit and credit columns',
      });
    }
  });

const ImportInputSchema = z.discriminatedUnion('format', [
  z.strictObject({
    ...ImportCommonFields,
    format: z.literal('csv'),
    mapping: CsvMappingSchema,
  }),
  z.strictObject({
    ...ImportCommonFields,
    format: z.literal('ofx'),
    mapping: z.strictObject({
      defaultCategoryId: OpaqueReferenceSchema.nullable(),
    }),
  }),
]);

const SafeImportErrorSchema = z.strictObject({
  code: z.string().min(1).max(160),
  message: z.string().min(1).max(500),
});

const RejectedImportRowSchema = z.strictObject({
  sourceRow: z
    .number()
    .int()
    .positive()
    .max(MAX_IMPORT_ROWS + 1),
  safeError: SafeImportErrorSchema,
});

const DuplicateImportRowSchema = z.strictObject({
  sourceRow: z
    .number()
    .int()
    .positive()
    .max(MAX_IMPORT_ROWS + 1),
  fingerprint: Sha256Schema,
  reason: z.enum(['existing', 'within-source']),
});

const FinanceImportPreviewReadySchema = z
  .strictObject({
    status: z.literal('ready'),
    format: z.enum(['csv', 'ofx']),
    sourceHash: Sha256Schema,
    accountId: OpaqueReferenceSchema,
    spaceId: OpaqueReferenceSchema,
    ownerUserId: OpaqueReferenceSchema,
    previewedAt: IsoDateTimeSchema,
    accepted: z.array(FinanceRecordSchema).max(MAX_IMPORT_ROWS),
    rejected: z.array(RejectedImportRowSchema).max(MAX_IMPORT_ROWS),
    duplicates: z.array(DuplicateImportRowSchema).max(MAX_IMPORT_ROWS),
    summary: z.strictObject({
      accepted: z.number().int().nonnegative().max(MAX_IMPORT_ROWS),
      rejected: z.number().int().nonnegative().max(MAX_IMPORT_ROWS),
      duplicates: z.number().int().nonnegative().max(MAX_IMPORT_ROWS),
    }),
  })
  .superRefine((preview, context) => {
    if (
      preview.summary.accepted !== preview.accepted.length ||
      preview.summary.rejected !== preview.rejected.length ||
      preview.summary.duplicates !== preview.duplicates.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['summary'],
        message: 'Preview counts do not match preview rows',
      });
    }
    for (const [index, record] of preview.accepted.entries()) {
      if (
        record.recordType !== 'transaction' ||
        record.accountId !== preview.accountId ||
        record.spaceId !== preview.spaceId ||
        record.ownerUserId !== preview.ownerUserId ||
        record.source.kind !== 'import' ||
        record.source.sourceHash !== preview.sourceHash
      ) {
        context.addIssue({
          code: 'custom',
          path: ['accepted', index],
          message: 'Preview transaction is outside the import scope',
        });
      }
    }
  })
  .transform(deepFreeze);

export type FinanceImportPreviewReady = DeepReadonly<
  z.output<typeof FinanceImportPreviewReadySchema>
>;
export type FinanceImportPreviewResult =
  | FinanceImportPreviewReady
  | DeepReadonly<{ status: 'rejected'; safeError: FinanceSafeError }>;

const rejectedPreview = (
  code: string,
  message: string,
): FinanceImportPreviewResult =>
  deepFreeze({
    status: 'rejected' as const,
    safeError: financeSafeError(code, message),
  });

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

interface CsvRow {
  readonly sourceRow: number;
  readonly cells: readonly string[];
}

type CsvParseResult =
  | { readonly status: 'parsed'; readonly rows: readonly CsvRow[] }
  | { readonly status: 'rejected' };

const parseCsv = (source: string): CsvParseResult => {
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let afterQuote = false;
  let line = 1;
  let rowStart = 1;

  const appendCell = (): boolean => {
    if (cell.length > MAX_CELL_CHARACTERS || cells.length >= MAX_CSV_COLUMNS) {
      return false;
    }
    cells.push(cell.trim());
    cell = '';
    afterQuote = false;
    return true;
  };
  const appendRow = (): boolean => {
    if (!appendCell()) return false;
    if (cells.some((value) => value !== '')) {
      if (rows.length >= MAX_IMPORT_ROWS + 1) return false;
      rows.push({ sourceRow: rowStart, cells });
    }
    cells = [];
    rowStart = line + 1;
    return true;
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        cell += character;
        if (character === '\n') {
          line += 1;
          if (line > MAX_IMPORT_ROWS + 1) return { status: 'rejected' };
        }
        if (cell.length > MAX_CELL_CHARACTERS) return { status: 'rejected' };
      }
      continue;
    }

    if (character === '"') {
      if (cell !== '' || afterQuote) return { status: 'rejected' };
      inQuotes = true;
    } else if (character === ',') {
      if (!appendCell()) return { status: 'rejected' };
    } else if (character === '\n') {
      if (!appendRow()) return { status: 'rejected' };
      line += 1;
      if (line > MAX_IMPORT_ROWS + 1) return { status: 'rejected' };
    } else if (character === '\r' && source[index + 1] === '\n') {
      if (!appendRow()) return { status: 'rejected' };
      index += 1;
      line += 1;
      if (line > MAX_IMPORT_ROWS + 1) return { status: 'rejected' };
    } else if (afterQuote) {
      if (!/\s/.test(character)) return { status: 'rejected' };
    } else {
      cell += character;
      if (cell.length > MAX_CELL_CHARACTERS) return { status: 'rejected' };
    }
  }
  if (inQuotes) return { status: 'rejected' };
  if (cell !== '' || cells.length > 0) {
    if (!appendRow()) return { status: 'rejected' };
  }
  return rows.length === 0
    ? { status: 'rejected' }
    : { status: 'parsed', rows };
};

interface ImportCandidate {
  readonly sourceRow: number;
  readonly postedOnRaw: string;
  readonly descriptionRaw: string;
  readonly amountRaw: string;
  readonly externalIdRaw?: string;
  readonly categoryIdRaw?: string;
}

type CandidateExtractionResult =
  | { readonly status: 'extracted'; readonly candidates: ImportCandidate[] }
  | {
      readonly status: 'rejected';
      readonly code: string;
      readonly message: string;
    };

const extractCsvCandidates = (
  source: string,
  mapping: z.output<typeof CsvMappingSchema>,
): CandidateExtractionResult => {
  const parsed = parseCsv(source);
  if (parsed.status === 'rejected') {
    return {
      status: 'rejected',
      code: 'finance-import-source-invalid',
      message: 'The CSV source could not be parsed safely.',
    };
  }

  const [headerRow, ...dataRows] = parsed.rows;
  if (headerRow === undefined) {
    return {
      status: 'rejected',
      code: 'finance-import-mapping-invalid',
      message: 'The CSV mapping does not match the source.',
    };
  }
  const headerIndexes = new Map<string, number>();
  for (const [index, header] of headerRow.cells.entries()) {
    if (header === '' || headerIndexes.has(header)) {
      return {
        status: 'rejected',
        code: 'finance-import-mapping-invalid',
        message: 'The CSV mapping does not match the source.',
      };
    }
    headerIndexes.set(header, index);
  }
  const requiredColumns = [
    mapping.columns.postedOn,
    mapping.columns.description,
    ...(mapping.columns.amount === undefined ? [] : [mapping.columns.amount]),
    ...(mapping.columns.debit === undefined ? [] : [mapping.columns.debit]),
    ...(mapping.columns.credit === undefined ? [] : [mapping.columns.credit]),
    ...(mapping.columns.externalId === undefined
      ? []
      : [mapping.columns.externalId]),
    ...(mapping.columns.categoryId === undefined
      ? []
      : [mapping.columns.categoryId]),
  ];
  if (requiredColumns.some((column) => !headerIndexes.has(column))) {
    return {
      status: 'rejected',
      code: 'finance-import-mapping-invalid',
      message: 'The CSV mapping does not match the source.',
    };
  }

  const valueAt = (row: CsvRow, column: string | undefined): string =>
    column === undefined ? '' : (row.cells[headerIndexes.get(column)!] ?? '');
  const amountAt = (row: CsvRow): string => {
    if (mapping.columns.amount !== undefined) {
      return valueAt(row, mapping.columns.amount);
    }
    const debit = valueAt(row, mapping.columns.debit);
    const credit = valueAt(row, mapping.columns.credit);
    if (debit !== '' && credit === '') return `(${debit})`;
    if (credit !== '' && debit === '') return credit;
    return '';
  };
  return {
    status: 'extracted',
    candidates: dataRows.map((row) => ({
      sourceRow: row.sourceRow,
      postedOnRaw: valueAt(row, mapping.columns.postedOn),
      descriptionRaw: valueAt(row, mapping.columns.description),
      amountRaw: amountAt(row),
      externalIdRaw: valueAt(row, mapping.columns.externalId),
      categoryIdRaw: valueAt(row, mapping.columns.categoryId),
    })),
  };
};

const extractOfxTag = (block: string, tag: string): string | undefined => {
  const match = new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, 'i').exec(block);
  const value = match?.[1]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

const extractOfxCandidates = (source: string): CandidateExtractionResult => {
  const statementContainers = [
    ...source.matchAll(
      /<(STMTRS|CCSTMTRS)>([\s\S]*?)(?:<\/\1>|(?=<(?:STMTRS|CCSTMTRS)>|<\/OFX>|$))/gi,
    ),
  ];
  const statementBodies =
    statementContainers.length === 0
      ? [source]
      : statementContainers.map((match) => match[2] ?? '');
  const statementCurrencies = statementBodies.map((body) =>
    [...body.matchAll(/<CURDEF>\s*([^<\r\n]*)/gi)].map((match) =>
      (match[1] ?? '').trim().toUpperCase(),
    ),
  );
  if (
    statementCurrencies.some(
      (currencies) =>
        currencies.length !== 1 ||
        currencies.some((currency) => currency !== 'CAD'),
    )
  ) {
    return {
      status: 'rejected',
      code: 'finance-import-currency-unsupported',
      message: 'Only CAD finance statements are supported.',
    };
  }
  if (statementBodies.length > 1) {
    return {
      status: 'rejected',
      code: 'finance-import-multiple-accounts-unsupported',
      message: 'Import one OFX account statement at a time.',
    };
  }

  const statementBody = statementBodies[0]!;
  const globalTransactionCount = [...source.matchAll(/<STMTTRN>/gi)].length;
  const statementTransactionCount = [...statementBody.matchAll(/<STMTTRN>/gi)]
    .length;
  if (globalTransactionCount !== statementTransactionCount) {
    return {
      status: 'rejected',
      code: 'finance-import-source-invalid',
      message: 'The OFX transaction structure is invalid.',
    };
  }

  const candidates: ImportCandidate[] = [];
  const blockPattern =
    /<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>|<\/BANKTRANLIST>|<\/OFX>|$))/gi;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(statementBody)) !== null) {
    if (candidates.length >= MAX_IMPORT_ROWS) {
      return {
        status: 'rejected',
        code: 'finance-import-source-invalid',
        message: 'The OFX source exceeds the supported row limit.',
      };
    }
    const block = match[1] ?? '';
    const name = extractOfxTag(block, 'NAME') ?? '';
    const memo = extractOfxTag(block, 'MEMO') ?? '';
    candidates.push({
      sourceRow: candidates.length + 1,
      postedOnRaw: extractOfxTag(block, 'DTPOSTED') ?? '',
      amountRaw: extractOfxTag(block, 'TRNAMT') ?? '',
      externalIdRaw: extractOfxTag(block, 'FITID'),
      descriptionRaw:
        name !== '' && memo !== '' ? `${name} — ${memo}` : name || memo,
    });
  }
  return candidates.length === 0
    ? {
        status: 'rejected',
        code: 'finance-import-source-invalid',
        message: 'The OFX source contains no statement transactions.',
      }
    : { status: 'extracted', candidates };
};

const TORONTO_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Date-only OFX values are provider business dates. Values with a time and UTC
 * offset are normalized to the calendar date in America/Toronto.
 */
const parseOfxPostedOn = (source: string): string | undefined => {
  const match =
    /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?(?:\[([+-]?)(\d{1,2})(?:\.(\d{1,2}))?(?::[^\]]*)?\])?)?$/.exec(
      source.trim(),
    );
  if (match === null) return undefined;
  const canonicalDate = `${match[1]}-${match[2]}-${match[3]}`;
  if (!z.iso.date().safeParse(canonicalDate).success) return undefined;
  if (match[4] === undefined) return canonicalDate;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0') || '0');
  const naiveUtc = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond,
  );
  const check = new Date(naiveUtc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  const fractionText = match[10] ?? '';
  const fractionalMinutes =
    fractionText === ''
      ? 0n
      : (BigInt(fractionText) * 60n) / 10n ** BigInt(fractionText.length);
  const unsignedOffsetMinutes =
    BigInt(match[9] ?? '0') * 60n + fractionalMinutes;
  const signedOffsetMinutes =
    match[8] === '-' ? -unsignedOffsetMinutes : unsignedOffsetMinutes;
  if (signedOffsetMinutes < -720n || signedOffsetMinutes > 720n) {
    return undefined;
  }
  const instant = new Date(naiveUtc - Number(signedOffsetMinutes) * 60_000);
  const parts = Object.fromEntries(
    TORONTO_DATE_FORMATTER.formatToParts(instant).map((part) => [
      part.type,
      part.value,
    ]),
  );
  const torontoDate = `${parts.year}-${parts.month}-${parts.day}`;
  return z.iso.date().safeParse(torontoDate).success ? torontoDate : undefined;
};

const parseDateOnly = (
  source: string,
  format: 'yyyy-mm-dd' | 'mm/dd/yyyy' | 'dd/mm/yyyy' | 'ofx',
): string | undefined => {
  let canonical: string | undefined;
  if (format === 'yyyy-mm-dd') canonical = source.trim();
  else if (format === 'ofx') return parseOfxPostedOn(source);
  else {
    const parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(source.trim());
    if (parts !== null) {
      canonical =
        format === 'mm/dd/yyyy'
          ? `${parts[3]}-${parts[1]}-${parts[2]}`
          : `${parts[3]}-${parts[2]}-${parts[1]}`;
    }
  }
  return canonical !== undefined && z.iso.date().safeParse(canonical).success
    ? canonical
    : undefined;
};

const normalizedText = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ');

const fingerprintCandidate = (input: {
  readonly spaceId: string;
  readonly ownerUserId: string;
  readonly accountId: string;
  readonly externalId: string | null;
  readonly postedOn: string;
  readonly amountCadMinor: number;
  readonly description: string;
}): string =>
  digest(
    JSON.stringify(
      input.externalId === null
        ? [
            'finance-import-fingerprint-v2',
            'derived',
            input.spaceId,
            input.ownerUserId,
            input.accountId,
            input.postedOn,
            String(input.amountCadMinor),
            input.description.toLocaleLowerCase('en-CA'),
          ]
        : [
            'finance-import-fingerprint-v2',
            'external-id',
            input.spaceId,
            input.ownerUserId,
            input.accountId,
            input.externalId,
          ],
    ),
  );

const invalidRow = (sourceRow: number) =>
  deepFreeze({
    sourceRow,
    safeError: financeSafeError(
      'finance-import-row-invalid',
      'This statement row could not be imported.',
    ),
  });

const previewFinanceImportAgainst = (
  input: unknown,
  authoritativeExistingFingerprints?: (scope: {
    readonly spaceId: string;
    readonly ownerUserId: string;
    readonly accountId: string;
  }) => readonly string[],
): FinanceImportPreviewResult => {
  const envelope = boundedFinanceParse(ImportInputSchema, input);
  if (!envelope.success) {
    return rejectedPreview(
      'finance-import-input-invalid',
      'The finance import request is invalid.',
    );
  }
  if (digest(envelope.data.sourceText) !== envelope.data.sourceHash) {
    return rejectedPreview(
      'finance-import-source-hash-mismatch',
      'The finance import source does not match its content hash.',
    );
  }

  const extracted =
    envelope.data.format === 'csv'
      ? extractCsvCandidates(envelope.data.sourceText, envelope.data.mapping)
      : extractOfxCandidates(envelope.data.sourceText);
  if (extracted.status === 'rejected') {
    return rejectedPreview(extracted.code, extracted.message);
  }

  const accepted: FinanceTransactionRecord[] = [];
  const rejected: z.output<typeof RejectedImportRowSchema>[] = [];
  const duplicates: z.output<typeof DuplicateImportRowSchema>[] = [];
  const seen = new Set<string>();
  const existing = new Set(
    authoritativeExistingFingerprints?.({
      spaceId: envelope.data.spaceId,
      ownerUserId: envelope.data.ownerUserId,
      accountId: envelope.data.accountId,
    }) ?? envelope.data.existingFingerprints,
  );
  for (const candidate of extracted.candidates) {
    const postedOn = parseDateOnly(
      candidate.postedOnRaw,
      envelope.data.format === 'csv' ? envelope.data.mapping.dateFormat : 'ofx',
    );
    const parsedAmount = parseCadDecimal(candidate.amountRaw);
    const description = normalizedText(candidate.descriptionRaw);
    const externalId = normalizedText(candidate.externalIdRaw ?? '') || null;
    const categoryId =
      normalizedText(candidate.categoryIdRaw ?? '') ||
      envelope.data.mapping.defaultCategoryId;
    if (
      postedOn === undefined ||
      parsedAmount.status !== 'parsed' ||
      description.length === 0 ||
      description.length > 2_000
    ) {
      rejected.push(invalidRow(candidate.sourceRow));
      continue;
    }

    const fingerprint = fingerprintCandidate({
      spaceId: envelope.data.spaceId,
      ownerUserId: envelope.data.ownerUserId,
      accountId: envelope.data.accountId,
      externalId,
      postedOn,
      amountCadMinor: parsedAmount.money.minorUnits,
      description,
    });
    if (existing.has(fingerprint) || seen.has(fingerprint)) {
      duplicates.push(
        deepFreeze({
          sourceRow: candidate.sourceRow,
          fingerprint,
          reason: existing.has(fingerprint)
            ? ('existing' as const)
            : ('within-source' as const),
        }),
      );
      continue;
    }

    const validated = validateFinanceRecord({
      schemaVersion: 1,
      id: `finance-import-${fingerprint.slice(0, 40)}`,
      spaceId: envelope.data.spaceId,
      ownerUserId: envelope.data.ownerUserId,
      createdAt: envelope.data.previewedAt,
      updatedAt: envelope.data.previewedAt,
      recordType: 'transaction',
      accountId: envelope.data.accountId,
      categoryId,
      postedOn,
      description,
      currency: 'CAD',
      originalAmountCadMinor: parsedAmount.money.minorUnits,
      effectiveAmountCadMinor: parsedAmount.money.minorUnits,
      adjustments: [],
      reversal: null,
      appliedOperationIds: [],
      source: {
        kind: 'import',
        sourceHash: envelope.data.sourceHash,
        sourceRow: candidate.sourceRow,
        fingerprint,
        externalId,
      },
    });
    if (
      validated.status !== 'accepted' ||
      validated.record.recordType !== 'transaction'
    ) {
      rejected.push(invalidRow(candidate.sourceRow));
      continue;
    }
    seen.add(fingerprint);
    accepted.push(validated.record);
  }

  const ready = FinanceImportPreviewReadySchema.safeParse({
    status: 'ready',
    format: envelope.data.format,
    sourceHash: envelope.data.sourceHash,
    accountId: envelope.data.accountId,
    spaceId: envelope.data.spaceId,
    ownerUserId: envelope.data.ownerUserId,
    previewedAt: envelope.data.previewedAt,
    accepted,
    rejected,
    duplicates,
    summary: {
      accepted: accepted.length,
      rejected: rejected.length,
      duplicates: duplicates.length,
    },
  });
  return ready.success
    ? ready.data
    : rejectedPreview(
        'finance-import-source-invalid',
        'The finance import source could not be previewed safely.',
      );
};

export const previewFinanceImport = (
  input: unknown,
): FinanceImportPreviewResult => previewFinanceImportAgainst(input);

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`;
};

const planPayload = (plan: {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly idempotencyKey: string;
  readonly sourceHash: string;
  readonly createdAt: string;
  readonly accountId: string;
  readonly spaceId: string;
  readonly ownerUserId: string;
  readonly transactionCount: number;
  readonly rejectedRowCount: number;
  readonly duplicateRowCount: number;
  readonly transactions: readonly FinanceTransactionRecord[];
}) => ({
  schemaVersion: plan.schemaVersion,
  planId: plan.planId,
  idempotencyKey: plan.idempotencyKey,
  sourceHash: plan.sourceHash,
  createdAt: plan.createdAt,
  accountId: plan.accountId,
  spaceId: plan.spaceId,
  ownerUserId: plan.ownerUserId,
  transactionCount: plan.transactionCount,
  rejectedRowCount: plan.rejectedRowCount,
  duplicateRowCount: plan.duplicateRowCount,
  transactions: plan.transactions,
});

const FinanceImportPlanBaseSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  planId: OpaqueReferenceSchema,
  idempotencyKey: IdempotencyKeySchema,
  sourceHash: Sha256Schema,
  createdAt: IsoDateTimeSchema,
  accountId: OpaqueReferenceSchema,
  spaceId: OpaqueReferenceSchema,
  ownerUserId: OpaqueReferenceSchema,
  transactionCount: z.number().int().positive().max(MAX_IMPORT_ROWS),
  rejectedRowCount: z.number().int().nonnegative().max(MAX_IMPORT_ROWS),
  duplicateRowCount: z.number().int().nonnegative().max(MAX_IMPORT_ROWS),
  transactions: z.array(FinanceRecordSchema).min(1).max(MAX_IMPORT_ROWS),
  planHash: Sha256Schema,
});

export const FinanceImportPlanSchema = FinanceImportPlanBaseSchema.superRefine(
  (plan, context) => {
    const fingerprints = new Set<string>();
    const transactionIds = new Set<string>();
    if (plan.transactionCount !== plan.transactions.length) {
      context.addIssue({
        code: 'custom',
        path: ['transactionCount'],
        message: 'Transaction count does not match plan records',
      });
    }
    for (const [index, record] of plan.transactions.entries()) {
      if (
        record.recordType !== 'transaction' ||
        record.accountId !== plan.accountId ||
        record.spaceId !== plan.spaceId ||
        record.ownerUserId !== plan.ownerUserId ||
        record.source.kind !== 'import' ||
        record.source.sourceHash !== plan.sourceHash ||
        fingerprints.has(record.source.fingerprint) ||
        transactionIds.has(record.id)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['transactions', index],
          message: 'Plan transaction is duplicate or outside import scope',
        });
      }
      if (
        record.recordType === 'transaction' &&
        record.source.kind === 'import'
      ) {
        fingerprints.add(record.source.fingerprint);
        transactionIds.add(record.id);
      }
    }
    const transactions = plan.transactions.filter(
      (record): record is FinanceTransactionRecord =>
        record.recordType === 'transaction',
    );
    const expectedHash = digest(
      canonicalJson(
        planPayload({
          ...plan,
          transactions,
        }),
      ),
    );
    if (plan.planHash !== expectedHash) {
      context.addIssue({
        code: 'custom',
        path: ['planHash'],
        message: 'Plan hash does not bind the import payload',
      });
    }
  },
).transform((plan) =>
  deepFreeze({
    ...plan,
    transactions: plan.transactions as readonly FinanceTransactionRecord[],
  }),
);

export type FinanceImportPlan = DeepReadonly<
  z.output<typeof FinanceImportPlanSchema>
>;
export type FinanceImportPlanResult =
  | DeepReadonly<{ status: 'planned'; plan: FinanceImportPlan }>
  | DeepReadonly<{ status: 'rejected'; safeError: FinanceSafeError }>;

const createTrustedFinanceImportPlan = (
  input: Readonly<{
    planId: string;
    idempotencyKey: string;
    preview: FinanceImportPreviewReady;
  }>,
): FinanceImportPlanResult => {
  const preview = input.preview;
  if (preview.accepted.length === 0) {
    return deepFreeze({
      status: 'rejected' as const,
      safeError: financeSafeError(
        'finance-import-plan-empty',
        'The finance import has no valid new transactions to commit.',
      ),
    });
  }

  const transactions = preview.accepted.filter(
    (record): record is FinanceTransactionRecord =>
      record.recordType === 'transaction',
  );
  const payload = planPayload({
    schemaVersion: 1,
    planId: input.planId,
    idempotencyKey: input.idempotencyKey,
    sourceHash: preview.sourceHash,
    createdAt: preview.previewedAt,
    accountId: preview.accountId,
    spaceId: preview.spaceId,
    ownerUserId: preview.ownerUserId,
    transactionCount: transactions.length,
    rejectedRowCount: preview.rejected.length,
    duplicateRowCount: preview.duplicates.length,
    transactions,
  });
  const plan = FinanceImportPlanSchema.parse({
    ...payload,
    planHash: digest(canonicalJson(payload)),
  });
  return deepFreeze({ status: 'planned' as const, plan });
};

export interface FinanceImportReceipt {
  readonly id: string;
  readonly planId: string;
  readonly planHash: string;
  readonly sourceHash: string;
  readonly transactionCount: number;
  readonly verified: true;
}

export type FinanceImportCommitResult =
  | DeepReadonly<{
      status: 'committed' | 'replayed';
      receipt: FinanceImportReceipt;
      sourceDeletionAuthorized: true;
    }>
  | DeepReadonly<{
      status: 'rejected';
      receipt: null;
      sourceDeletionAuthorized: false;
      safeError: FinanceSafeError;
    }>;

export interface TrustedAtomicFinanceImportRepository {
  /** Called only with a plan resolved from the server-owned plan store. */
  commitTrustedPlan(
    plan: FinanceImportPlan,
  ): Promise<FinanceImportCommitResult>;
}

interface StoredImportReceipt {
  readonly planHash: string;
  readonly receipt: DeepReadonly<FinanceImportReceipt>;
}

class InMemoryAtomicFinanceImportRepository implements TrustedAtomicFinanceImportRepository {
  #transactions = new Map<string, FinanceTransactionRecord>();
  #fingerprints = new Set<string>();
  #receipts = new Map<string, StoredImportReceipt>();

  listTransactions(): readonly FinanceTransactionRecord[] {
    return Object.freeze(
      [...this.#transactions.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    );
  }

  listFingerprints(scope: {
    readonly spaceId: string;
    readonly ownerUserId: string;
    readonly accountId: string;
  }): readonly string[] {
    return Object.freeze(
      [...this.#transactions.values()]
        .filter(
          (transaction) =>
            transaction.spaceId === scope.spaceId &&
            transaction.ownerUserId === scope.ownerUserId &&
            transaction.accountId === scope.accountId &&
            transaction.source.kind === 'import',
        )
        .flatMap((transaction) =>
          transaction.source.kind === 'import'
            ? [transaction.source.fingerprint]
            : [],
        )
        .sort(),
    );
  }

  async commitTrustedPlan(
    plan: FinanceImportPlan,
  ): Promise<FinanceImportCommitResult> {
    const transactions = plan.transactions.filter(
      (transaction): transaction is ImportedFinanceTransactionRecord =>
        transaction.recordType === 'transaction' &&
        transaction.source.kind === 'import',
    );
    if (transactions.length !== plan.transactionCount) {
      return deepFreeze({
        status: 'rejected' as const,
        receipt: null,
        sourceDeletionAuthorized: false as const,
        safeError: financeSafeError(
          'finance-import-plan-invalid',
          'The finance import plan is invalid.',
        ),
      });
    }
    const receiptScopeKey = digest(
      canonicalJson({
        spaceId: plan.spaceId,
        ownerUserId: plan.ownerUserId,
        idempotencyKey: plan.idempotencyKey,
      }),
    );
    const prior = this.#receipts.get(receiptScopeKey);
    if (prior !== undefined) {
      if (prior.planHash === plan.planHash) {
        return deepFreeze({
          status: 'replayed' as const,
          receipt: prior.receipt,
          sourceDeletionAuthorized: true as const,
        });
      }
      return deepFreeze({
        status: 'rejected' as const,
        receipt: null,
        sourceDeletionAuthorized: false as const,
        safeError: financeSafeError(
          'finance-import-idempotency-conflict',
          'The import key is already bound to another plan.',
        ),
      });
    }

    if (
      transactions.some(
        (transaction) =>
          this.#transactions.has(transaction.id) ||
          this.#fingerprints.has(transaction.source.fingerprint),
      )
    ) {
      return deepFreeze({
        status: 'rejected' as const,
        receipt: null,
        sourceDeletionAuthorized: false as const,
        safeError: financeSafeError(
          'finance-import-duplicate-at-commit',
          'The statement now overlaps an existing transaction.',
        ),
      });
    }

    const nextTransactions = new Map(this.#transactions);
    const nextFingerprints = new Set(this.#fingerprints);
    for (const transaction of transactions) {
      nextTransactions.set(transaction.id, transaction);
      nextFingerprints.add(transaction.source.fingerprint);
    }
    const receipt = deepFreeze({
      id: `finance-import-receipt-${plan.planHash.slice(0, 32)}`,
      planId: plan.planId,
      planHash: plan.planHash,
      sourceHash: plan.sourceHash,
      transactionCount: plan.transactionCount,
      verified: true as const,
    });
    const nextReceipts = new Map(this.#receipts);
    nextReceipts.set(receiptScopeKey, {
      planHash: plan.planHash,
      receipt,
    });

    this.#transactions = nextTransactions;
    this.#fingerprints = nextFingerprints;
    this.#receipts = nextReceipts;
    return deepFreeze({
      status: 'committed' as const,
      receipt,
      sourceDeletionAuthorized: true as const,
    });
  }
}

const RegisteredCreatePlanInputSchema = z.strictObject({
  planId: OpaqueReferenceSchema,
  idempotencyKey: IdempotencyKeySchema,
  previewId: OpaqueReferenceSchema,
  sourceHash: Sha256Schema,
  spaceId: OpaqueReferenceSchema,
  ownerUserId: OpaqueReferenceSchema,
});

const RegisteredCommitInputSchema = z.strictObject({
  planId: OpaqueReferenceSchema,
  planHash: Sha256Schema,
  spaceId: OpaqueReferenceSchema,
  ownerUserId: OpaqueReferenceSchema,
});

export type RegisteredFinanceImportPreviewResult =
  | DeepReadonly<{
      status: 'ready';
      previewId: string;
      preview: FinanceImportPreviewReady;
    }>
  | DeepReadonly<{ status: 'rejected'; safeError: FinanceSafeError }>;

const rejectedPlan = (code: string, message: string): FinanceImportPlanResult =>
  deepFreeze({
    status: 'rejected' as const,
    safeError: financeSafeError(code, message),
  });

const rejectedCommit = (
  code: string,
  message: string,
): FinanceImportCommitResult =>
  deepFreeze({
    status: 'rejected' as const,
    receipt: null,
    sourceDeletionAuthorized: false as const,
    safeError: financeSafeError(code, message),
  });

const planStoreKey = (input: {
  readonly spaceId: string;
  readonly ownerUserId: string;
  readonly planId: string;
}): string =>
  digest(
    canonicalJson({
      spaceId: input.spaceId,
      ownerUserId: input.ownerUserId,
      planId: input.planId,
    }),
  );

/**
 * Keeps verified previews and plans on the trusted side of the API boundary.
 * Callers receive immutable display data and opaque IDs, but commit resolves
 * the authoritative server-held plan rather than accepting returned objects.
 */
const PENDING_IMPORT_TTL_MS = 30 * 60 * 1_000;
const COMPLETED_IMPORT_TTL_MS = 30 * 60 * 1_000;
const MAX_PENDING_IMPORTS_PER_SCOPE = 4;
const MAX_PENDING_ROWS_PER_SCOPE = 100_000;
const MAX_RETAINED_PENDING_ROWS = 200_000;
const MAX_COMPLETED_IMPORTS = 1_000;
const MAX_COMPLETED_IMPORTS_PER_SCOPE = 100;

const FinanceImportPlanningLimitsSchema = z
  .strictObject({
    maxPendingImportsPerScope: z
      .number()
      .int()
      .positive()
      .max(1_000)
      .default(MAX_PENDING_IMPORTS_PER_SCOPE),
    maxPendingRowsPerScope: z
      .number()
      .int()
      .positive()
      .max(MAX_IMPORT_ROWS)
      .default(MAX_PENDING_ROWS_PER_SCOPE),
    maxRetainedPendingRows: z
      .number()
      .int()
      .positive()
      .max(MAX_IMPORT_ROWS * 10)
      .default(MAX_RETAINED_PENDING_ROWS),
  })
  .refine(
    (limits) => limits.maxRetainedPendingRows >= limits.maxPendingRowsPerScope,
    'Global pending rows must cover one complete scope allocation',
  );

export type FinanceImportPlanningLimits = z.input<
  typeof FinanceImportPlanningLimitsSchema
>;

interface RetainedPreview {
  readonly preview: FinanceImportPreviewReady;
  readonly scopeKey: string;
  readonly rowCount: number;
  readonly expiresAtMs: number;
  readonly order: number;
}

interface RetainedPlan {
  readonly plan: FinanceImportPlan;
  readonly previewId: string;
  readonly scopeKey: string;
  readonly rowCount: number;
  readonly expiresAtMs: number;
  readonly order: number;
}

interface CompletedPlan {
  readonly planHash: string;
  readonly result: FinanceImportCommitResult;
  readonly scopeKey: string;
  readonly expiresAtMs: number;
  readonly order: number;
}

const importScopeKey = (input: {
  readonly spaceId: string;
  readonly ownerUserId: string;
}): string =>
  digest(
    canonicalJson({
      spaceId: input.spaceId,
      ownerUserId: input.ownerUserId,
    }),
  );

export interface FinanceImportRetentionSnapshot {
  readonly pendingPreviews: number;
  readonly pendingPlans: number;
  readonly completedPlans: number;
  readonly retainedPendingRows: number;
}

export class InMemoryFinanceImportPlanningService {
  readonly #previews = new Map<string, RetainedPreview>();
  readonly #plans = new Map<string, RetainedPlan>();
  readonly #completedPlans = new Map<string, CompletedPlan>();
  readonly #repository = new InMemoryAtomicFinanceImportRepository();
  readonly #now: () => Date;
  readonly #limits: z.output<typeof FinanceImportPlanningLimitsSchema>;
  #nextOrder = 0;

  constructor(
    now: () => Date = () => new Date(),
    limits: FinanceImportPlanningLimits = {},
  ) {
    this.#now = now;
    this.#limits = FinanceImportPlanningLimitsSchema.parse(limits);
  }

  #nowMs(): number {
    const value = this.#now().getTime();
    if (!Number.isFinite(value))
      throw new Error('Finance import clock is invalid');
    return value;
  }

  #sweepExpired(nowMs: number): void {
    for (const [key, entry] of this.#previews) {
      if (entry.expiresAtMs <= nowMs) this.#previews.delete(key);
    }
    for (const [key, entry] of this.#plans) {
      if (entry.expiresAtMs <= nowMs) this.#plans.delete(key);
    }
    for (const [key, entry] of this.#completedPlans) {
      if (entry.expiresAtMs <= nowMs) this.#completedPlans.delete(key);
    }
  }

  #retainedPendingRows(): number {
    let rows = 0;
    for (const entry of this.#previews.values()) rows += entry.rowCount;
    for (const entry of this.#plans.values()) rows += entry.rowCount;
    return rows;
  }

  #pendingCountForScope(scopeKey: string): number {
    let count = 0;
    for (const entry of this.#previews.values()) {
      if (entry.scopeKey === scopeKey) count += 1;
    }
    for (const entry of this.#plans.values()) {
      if (entry.scopeKey === scopeKey) count += 1;
    }
    return count;
  }

  #pendingRowsForScope(scopeKey: string): number {
    let rows = 0;
    for (const entry of this.#previews.values()) {
      if (entry.scopeKey === scopeKey) rows += entry.rowCount;
    }
    for (const entry of this.#plans.values()) {
      if (entry.scopeKey === scopeKey) rows += entry.rowCount;
    }
    return rows;
  }

  #rememberCompleted(
    key: string,
    plan: RetainedPlan,
    result: FinanceImportCommitResult,
    nowMs: number,
  ): void {
    const sameScope = [...this.#completedPlans.entries()]
      .filter(([, entry]) => entry.scopeKey === plan.scopeKey)
      .sort(([, left], [, right]) => left.order - right.order);
    while (sameScope.length >= MAX_COMPLETED_IMPORTS_PER_SCOPE) {
      const oldest = sameScope.shift();
      if (oldest !== undefined) this.#completedPlans.delete(oldest[0]);
    }
    while (this.#completedPlans.size >= MAX_COMPLETED_IMPORTS) {
      const oldest = [...this.#completedPlans.entries()].sort(
        ([, left], [, right]) => left.order - right.order,
      )[0];
      if (oldest === undefined) break;
      this.#completedPlans.delete(oldest[0]);
    }
    this.#completedPlans.set(key, {
      planHash: plan.plan.planHash,
      result,
      scopeKey: plan.scopeKey,
      expiresAtMs: nowMs + COMPLETED_IMPORT_TTL_MS,
      order: this.#nextOrder++,
    });
  }

  preview(input: unknown): RegisteredFinanceImportPreviewResult {
    const preview = previewFinanceImportAgainst(input, (scope) =>
      this.#repository.listFingerprints(scope),
    );
    if (preview.status === 'rejected') return preview;

    const nowMs = this.#nowMs();
    this.#sweepExpired(nowMs);
    const previewId = `finance-import-preview-${digest(canonicalJson(preview))}`;
    const existing = this.#previews.get(previewId);
    if (existing !== undefined) {
      return deepFreeze({
        status: 'ready' as const,
        previewId,
        preview: existing.preview,
      });
    }
    const scopeKey = importScopeKey(preview);
    if (
      this.#pendingCountForScope(scopeKey) >=
      this.#limits.maxPendingImportsPerScope
    ) {
      return deepFreeze({
        status: 'rejected' as const,
        safeError: financeSafeError(
          'finance-import-preview-capacity-reached',
          'Too many finance imports are awaiting completion.',
        ),
      });
    }
    const rowCount =
      preview.summary.accepted +
      preview.summary.rejected +
      preview.summary.duplicates;
    if (
      this.#pendingRowsForScope(scopeKey) + rowCount >
        this.#limits.maxPendingRowsPerScope ||
      this.#retainedPendingRows() + rowCount >
        this.#limits.maxRetainedPendingRows
    ) {
      return deepFreeze({
        status: 'rejected' as const,
        safeError: financeSafeError(
          'finance-import-preview-capacity-reached',
          'Too many finance import rows are awaiting completion.',
        ),
      });
    }
    this.#previews.set(previewId, {
      preview,
      scopeKey,
      rowCount,
      expiresAtMs: nowMs + PENDING_IMPORT_TTL_MS,
      order: this.#nextOrder++,
    });
    return deepFreeze({ status: 'ready' as const, previewId, preview });
  }

  createPlan(input: unknown): FinanceImportPlanResult {
    const envelope = boundedFinanceParse(
      RegisteredCreatePlanInputSchema,
      input,
    );
    if (!envelope.success) {
      return rejectedPlan(
        'finance-import-plan-invalid',
        'The finance import plan is invalid.',
      );
    }
    const nowMs = this.#nowMs();
    this.#sweepExpired(nowMs);
    const key = planStoreKey(envelope.data);
    const existingPlan = this.#plans.get(key);
    if (existingPlan !== undefined) {
      return existingPlan.previewId === envelope.data.previewId &&
        existingPlan.plan.sourceHash === envelope.data.sourceHash &&
        existingPlan.plan.idempotencyKey === envelope.data.idempotencyKey
        ? deepFreeze({ status: 'planned' as const, plan: existingPlan.plan })
        : rejectedPlan(
            'finance-import-plan-id-conflict',
            'The finance import plan ID is already in use.',
          );
    }
    if (this.#completedPlans.has(key)) {
      return rejectedPlan(
        'finance-import-plan-id-conflict',
        'The finance import plan ID is already in use.',
      );
    }

    const retainedPreview = this.#previews.get(envelope.data.previewId);
    if (
      retainedPreview === undefined ||
      retainedPreview.preview.sourceHash !== envelope.data.sourceHash ||
      retainedPreview.preview.spaceId !== envelope.data.spaceId ||
      retainedPreview.preview.ownerUserId !== envelope.data.ownerUserId
    ) {
      return rejectedPlan(
        'finance-import-preview-not-found',
        'The verified finance import preview is unavailable.',
      );
    }
    const planned = createTrustedFinanceImportPlan({
      planId: envelope.data.planId,
      idempotencyKey: envelope.data.idempotencyKey,
      preview: retainedPreview.preview,
    });
    if (planned.status === 'rejected') return planned;

    this.#previews.delete(envelope.data.previewId);
    this.#plans.set(key, {
      plan: planned.plan,
      previewId: envelope.data.previewId,
      scopeKey: retainedPreview.scopeKey,
      rowCount: retainedPreview.rowCount,
      expiresAtMs: nowMs + PENDING_IMPORT_TTL_MS,
      order: this.#nextOrder++,
    });
    return planned;
  }

  async commitAtomically(input: unknown): Promise<FinanceImportCommitResult> {
    const envelope = boundedFinanceParse(RegisteredCommitInputSchema, input);
    if (!envelope.success) {
      return rejectedCommit(
        'finance-import-plan-invalid',
        'The finance import plan is invalid.',
      );
    }
    const nowMs = this.#nowMs();
    this.#sweepExpired(nowMs);
    const key = planStoreKey(envelope.data);
    const completed = this.#completedPlans.get(key);
    if (completed !== undefined) {
      if (completed.planHash !== envelope.data.planHash) {
        return rejectedCommit(
          'finance-import-plan-not-found',
          'The verified finance import plan is unavailable.',
        );
      }
      return completed.result.status === 'committed'
        ? deepFreeze({ ...completed.result, status: 'replayed' as const })
        : completed.result;
    }
    const retainedPlan = this.#plans.get(key);
    if (
      retainedPlan === undefined ||
      retainedPlan.plan.planHash !== envelope.data.planHash
    ) {
      return rejectedCommit(
        'finance-import-plan-not-found',
        'The verified finance import plan is unavailable.',
      );
    }
    const result = await this.#repository.commitTrustedPlan(retainedPlan.plan);
    this.#plans.delete(key);
    this.#rememberCompleted(key, retainedPlan, result, this.#nowMs());
    return result;
  }

  retentionSnapshot(): DeepReadonly<FinanceImportRetentionSnapshot> {
    this.#sweepExpired(this.#nowMs());
    return deepFreeze({
      pendingPreviews: this.#previews.size,
      pendingPlans: this.#plans.size,
      completedPlans: this.#completedPlans.size,
      retainedPendingRows: this.#retainedPendingRows(),
    });
  }

  /** Test adapter view; production repositories must enforce scoped reads. */
  listTransactions(): readonly FinanceTransactionRecord[] {
    return this.#repository.listTransactions();
  }
}
