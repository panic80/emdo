import { createHash } from 'node:crypto';
import {
  ExtractedFinanceReportTableSchema,
  ReviewedFinanceXlsxSelectionSchema,
} from '@emdo/contracts';
import { z } from 'zod';
import {
  extractFinanceXlsxTables,
  type XlsxSourceCell,
} from './xlsx-report-extraction.js';

export { ReviewedFinanceXlsxSelectionSchema } from '@emdo/contracts';
export type { ReviewedFinanceXlsxSelection } from '@emdo/contracts';

function fail(reason: string): never {
  throw new Error(`finance-reviewed-xlsx-${reason}`);
}
const DAY = 86_400_000;
/** Excel's documented 1900/1904 epochs, including rejection of the fictional leap day.
 * https://support.microsoft.com/en-au/office/date-systems-in-excel-e7fe7167-48a9-4b96-bb53-5612a800b487
 */
export function excelSerialDateToIso(
  raw: string,
  dateSystem: '1900' | '1904',
): string {
  if (dateSystem !== '1900' && dateSystem !== '1904')
    fail('invalid-date-system');
  if (!/^\d+(?:\.0+)?$/.test(raw)) fail('date-serial-not-whole-day');
  const serial = Number(raw);
  if (
    !Number.isSafeInteger(serial) ||
    serial < (dateSystem === '1900' ? 1 : 0) ||
    serial > 2_958_465
  )
    fail('date-serial-out-of-range');
  if (dateSystem === '1900' && serial === 60) fail('fictitious-1900-leap-day');
  const timestamp =
    dateSystem === '1900'
      ? Date.UTC(1899, 11, 31) + (serial > 60 ? serial - 1 : serial) * DAY
      : Date.UTC(1904, 0, 1) + serial * DAY;
  const iso = new Date(timestamp).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) fail('date-serial-out-of-range');
  return iso;
}
function isoDateOnly(value: string): string {
  // No timezone conversion or dropping time-of-day information.
  const match = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.0+)?Z?)?$/.exec(value);
  if (!match) fail('date-text-not-iso-date-only');
  const parsed = new Date(`${match[1]}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== match[1]
  )
    fail('invalid-calendar-date');
  return match[1];
}
function columnName(index: number) {
  let name = '';
  while (index > 0) {
    index--;
    name = String.fromCharCode(65 + (index % 26)) + name;
    index = Math.floor(index / 26);
  }
  return name;
}
function mergedRectangle(ref: string) {
  const match = /^([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)$/.exec(ref);
  if (!match) fail('invalid-merged-range');
  const col = (letters: string) =>
    [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0);
  const firstColumn = col(match[1]),
    lastColumn = col(match[3]),
    firstRow = Number(match[2]),
    lastRow = Number(match[4]);
  if (
    firstColumn > lastColumn ||
    lastColumn > 16384 ||
    firstRow > lastRow ||
    lastRow > 1_048_576
  )
    fail('invalid-merged-range');
  return { firstColumn, lastColumn, firstRow, lastRow };
}
export interface ReviewedXlsxCellProvenance {
  address: string;
  sourceRow: number;
  column: number;
  /** Null is an absent XML cell, distinct from a source cell with a blank value. */
  source: XlsxSourceCell | null;
  normalizedValue: string;
  transformation: 'none' | 'excel-serial-date' | 'iso-date-only';
}
type SourceMetadata = Pick<
  z.infer<typeof ExtractedFinanceReportTableSchema>,
  'documentId' | 'extractionRevision' | 'providerKey' | 'reportType'
>;

/** Deterministic source extraction, not approval or financial semantic validation.
 * All selected data rows, including absent/blank rows and subtotal rows, are retained.
 * Only explicitly selected date columns are converted; financial decimals stay exact.
 */
export function extractReviewedFinanceXlsxTable(
  bytes: Uint8Array,
  selectionInput: unknown,
  source: SourceMetadata,
) {
  const selection = ReviewedFinanceXlsxSelectionSchema.parse(selectionInput);
  const workbook = extractFinanceXlsxTables(bytes);
  if (workbook.dateSystem !== selection.confirmedDateSystem)
    fail('date-system-mismatch');
  const sheet = workbook.sheets.find((sheet) => sheet.name === selection.sheet);
  if (!sheet) fail('sheet-not-found');
  const selectedRow = (r: number) =>
    r === selection.headerRow ||
    (r >= selection.firstDataRow && r <= selection.lastDataRow);
  const hiddenRows = sheet.rows
    .filter((row) => row.hidden && selectedRow(row.sourceRow))
    .map((row) => row.sourceRow);
  const hiddenColumns = sheet.hiddenColumns.filter(
    (range) =>
      range.firstColumn <= selection.lastColumn &&
      range.lastColumn >= selection.firstColumn,
  );
  if (
    (sheet.state !== 'visible' || hiddenRows.length || hiddenColumns.length) &&
    !selection.acknowledgeHiddenContent
  )
    fail('hidden-content-acknowledgement-required');
  for (const ref of sheet.mergedRanges) {
    const rectangle = mergedRectangle(ref);
    const intersectsColumns =
      rectangle.firstColumn <= selection.lastColumn &&
      rectangle.lastColumn >= selection.firstColumn;
    const intersectsHeader =
      rectangle.firstRow <= selection.headerRow &&
      rectangle.lastRow >= selection.headerRow;
    const intersectsData =
      rectangle.firstRow <= selection.lastDataRow &&
      rectangle.lastRow >= selection.firstDataRow;
    if (intersectsColumns && (intersectsHeader || intersectsData))
      fail('merged-cells-intersect-selection');
  }
  const cells = new Map(sheet.cells.map((cell) => [cell.address, cell]));
  const provenance: ReviewedXlsxCellProvenance[] = [];
  const cachedFormulaCells: string[] = [];
  const values = (sourceRow: number, header: boolean) =>
    Array.from(
      { length: selection.lastColumn - selection.firstColumn + 1 },
      (_, offset) => {
        const column = selection.firstColumn + offset,
          address = `${columnName(column)}${sourceRow}`;
        const cell = cells.get(address) ?? null;
        if (cell?.type === 'e') fail('source-cell-error');
        if (cell?.formula !== null && cell?.formula !== undefined) {
          if (
            cell.valueOrigin === 'unavailable' ||
            cell.raw === null ||
            (cell.raw === '' && cell.type !== 'str')
          )
            fail('formula-cache-unavailable');
          if (!selection.acknowledgeCachedFormulaValues)
            fail('formula-cache-acknowledgement-required');
          // Shared/array/data-table formulas reference cells outside the selected range;
          // original attributes remain in provenance and acknowledgement covers cached values only.
          cachedFormulaCells.push(address);
        }
        let value = cell?.value ?? '',
          transformation: ReviewedXlsxCellProvenance['transformation'] = 'none';
        if (!header && selection.dateColumns.includes(column) && value !== '') {
          if (cell?.type === 'n') {
            value = excelSerialDateToIso(value, workbook.dateSystem);
            transformation = 'excel-serial-date';
          } else if (
            cell &&
            ['d', 's', 'str', 'inlineStr'].includes(cell.type)
          ) {
            value = isoDateOnly(value);
            transformation = 'iso-date-only';
          } else fail('date-cell-type-unsupported');
        }
        provenance.push({
          address,
          sourceRow,
          column,
          source: cell,
          normalizedValue: value,
          transformation,
        });
        return value;
      },
    );
  const headers = values(selection.headerRow, true);
  if (
    headers.some((header) => !header.trim() || header.length > 200) ||
    new Set(headers).size !== headers.length
  )
    fail('headings-ambiguous');
  const rows = Array.from(
    { length: selection.lastDataRow - selection.firstDataRow + 1 },
    (_, offset) => {
      const sourceRow = selection.firstDataRow + offset;
      return { sourceRow, cells: values(sourceRow, false) };
    },
  );
  const selectionDigest = createHash('sha256')
    .update(JSON.stringify(selection))
    .digest('hex');
  const sourceDigest = createHash('sha256').update(bytes).digest('hex');
  const table = ExtractedFinanceReportTableSchema.parse({
    ...source,
    tableId: `xlsx-reviewed-${selectionDigest.slice(0, 32)}`,
    page: null,
    sheet: sheet.name,
    headers,
    rows,
    context: { asOf: null, currency: null },
  });
  if (Buffer.byteLength(JSON.stringify(table)) > 8 * 1024 * 1024)
    fail('table-bytes-limit');
  const selectedAddresses = new Set(provenance.map((cell) => cell.address));
  return {
    table,
    cellProvenance: provenance,
    reviewFacts: {
      selection,
      selectionDigest,
      sourceDigest,
      dateSystem: workbook.dateSystem,
      headerRange: `${columnName(selection.firstColumn)}${selection.headerRow}:${columnName(selection.lastColumn)}${selection.headerRow}`,
      dataRange: `${columnName(selection.firstColumn)}${selection.firstDataRow}:${columnName(selection.lastColumn)}${selection.lastDataRow}`,
      cachedFormulaCells,
      hiddenSheet: sheet.state !== 'visible',
      hiddenRows,
      hiddenColumns,
      absentCellAddresses: provenance
        .filter((cell) => cell.source === null)
        .map((cell) => cell.address),
      blankDataRows: rows
        .filter((row) => row.cells.every((cell) => cell === ''))
        .map((row) => row.sourceRow),
      unselectedSourceCellCount: sheet.cells.filter(
        (cell) => !selectedAddresses.has(cell.address),
      ).length,
      sourceIssues: workbook.issues,
      requiredMappingDateFormat: selection.dateColumns.length
        ? ('yyyy-mm-dd' as const)
        : null,
    },
  };
}
