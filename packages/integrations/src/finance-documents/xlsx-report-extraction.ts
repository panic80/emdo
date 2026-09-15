import { inflateRawSync } from 'node:zlib';
import { posix } from 'node:path';
import { SaxesParser } from 'saxes';

export interface XlsxExtractionLimits {
  maxBytes: number;
  maxExpandedBytes: number;
  maxEntries: number;
  maxSheets: number;
  maxRows: number;
  maxCells: number;
  maxColumns: number;
  maxCellCharacters: number;
}
const defaults: XlsxExtractionLimits = {
  maxBytes: 2_097_152,
  maxExpandedBytes: 16_777_216,
  maxEntries: 256,
  maxSheets: 20,
  maxRows: 2001,
  maxCells: 100_000,
  maxColumns: 100,
  maxCellCharacters: 10_000,
};
function fail(reason: string): never {
  throw new Error(`finance-xlsx-${reason}`);
}

/** Reads ZIP members in memory only. Central-directory sizes are checked before inflation. */
function unzip(bytes: Uint8Array, limits: XlsxExtractionLimits) {
  const b = Buffer.from(bytes);
  if (b.length > limits.maxBytes) fail('bytes-limit');
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (
      b.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + b.readUInt16LE(i + 20) === b.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) fail('invalid-zip');
  const count = b.readUInt16LE(end + 10),
    size = b.readUInt32LE(end + 12),
    start = b.readUInt32LE(end + 16);
  if (
    b.readUInt16LE(end + 4) ||
    b.readUInt16LE(end + 6) ||
    b.readUInt16LE(end + 8) !== count ||
    count > limits.maxEntries ||
    count === 65535 ||
    start + size !== end
  )
    fail('zip-limit-or-unsupported');
  const files = new Map<string, Buffer>();
  const spans: [number, number][] = [];
  const checkExtra = (from: number, length: number) => {
    const end = from + length;
    while (from < end) {
      if (from + 4 > end) fail('invalid-zip-extra');
      const id = b.readUInt16LE(from),
        size = b.readUInt16LE(from + 2);
      if (id === 1) fail('zip64-unsupported');
      from += 4 + size;
      if (from > end) fail('invalid-zip-extra');
    }
  };
  let offset = start,
    expanded = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || b.readUInt32LE(offset) !== 0x02014b50)
      fail('invalid-zip');
    const flags = b.readUInt16LE(offset + 8),
      method = b.readUInt16LE(offset + 10);
    const compressed = b.readUInt32LE(offset + 20),
      length = b.readUInt32LE(offset + 24);
    const nameLength = b.readUInt16LE(offset + 28),
      extra = b.readUInt16LE(offset + 30),
      comment = b.readUInt16LE(offset + 32),
      local = b.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength + extra + comment > end) fail('invalid-zip');
    checkExtra(offset + 46 + nameLength, extra);
    const name = b
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8');
    if (
      flags & ~0x0808 ||
      ![0, 8].includes(method) ||
      !name ||
      name.includes('\\') ||
      name.startsWith('/') ||
      name.split('/').some((p) => p === '..' || p === '.') ||
      name.includes('//') ||
      files.has(name) ||
      compressed === 0xffffffff ||
      length === 0xffffffff ||
      local === 0xffffffff ||
      b.readUInt16LE(offset + 34)
    )
      fail('unsupported-zip-member');
    expanded += length;
    if (expanded > limits.maxExpandedBytes) fail('expanded-bytes-limit');
    if (
      local + 30 > start ||
      b.readUInt32LE(local) !== 0x04034b50 ||
      b.readUInt16LE(local + 8) !== method ||
      b.readUInt16LE(local + 6) !== flags
    )
      fail('invalid-zip');
    const localNameLength = b.readUInt16LE(local + 26),
      data = local + 30 + localNameLength + b.readUInt16LE(local + 28);
    if (
      data + compressed > start ||
      b.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !==
        name
    )
      fail('invalid-zip');
    checkExtra(local + 30 + localNameLength, b.readUInt16LE(local + 28));
    if (
      !(flags & 8) &&
      (b.readUInt32LE(local + 14) !== b.readUInt32LE(offset + 16) ||
        b.readUInt32LE(local + 18) !== compressed ||
        b.readUInt32LE(local + 22) !== length)
    )
      fail('inconsistent-zip-metadata');
    let memberEnd = data + compressed;
    if (flags & 8) {
      if (memberEnd + 12 > start) fail('invalid-zip-descriptor');
      if (b.readUInt32LE(memberEnd) === 0x08074b50) memberEnd += 4;
      if (
        memberEnd + 12 > start ||
        b.readUInt32LE(memberEnd) !== b.readUInt32LE(offset + 16) ||
        b.readUInt32LE(memberEnd + 4) !== compressed ||
        b.readUInt32LE(memberEnd + 8) !== length
      )
        fail('invalid-zip-descriptor');
      memberEnd += 12;
    }
    if (spans.some(([from, to]) => local < to && memberEnd > from))
      fail('overlapping-zip-members');
    spans.push([local, memberEnd]);
    const packed = b.subarray(data, data + compressed);
    const unpacked =
      method === 0
        ? packed
        : inflateRawSync(packed, { maxOutputLength: Math.max(1, length) });
    if (unpacked.length !== length) fail('invalid-zip-size');
    let crc = 0xffffffff;
    for (const byte of unpacked) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    if ((crc ^ 0xffffffff) >>> 0 !== b.readUInt32LE(offset + 16))
      fail('invalid-zip-checksum');
    files.set(name, unpacked);
    offset += 46 + nameLength + extra + comment;
  }
  if (offset !== end) fail('invalid-zip');
  return files;
}

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
}
function xml(bytes: Buffer | undefined): XmlNode {
  if (!bytes) return fail('missing-xml-part');
  const parser = new SaxesParser({ xmlns: false });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined,
    nodes = 0;
  parser.on('doctype', () => fail('doctype-forbidden'));
  parser.on('error', () => fail('invalid-xml'));
  parser.on('opentag', (tag) => {
    if (++nodes > 500_000 || stack.length > 64) fail('xml-complexity-limit');
    const node: XmlNode = {
      name: tag.name.split(':').at(-1)!,
      attrs: tag.attributes as Record<string, string>,
      text: '',
      children: [],
    };
    if (stack.length) stack.at(-1)!.children.push(node);
    else root = node;
    stack.push(node);
  });
  parser.on('text', (text) => {
    if (stack.length) stack.at(-1)!.text += text;
  });
  parser.on('cdata', (text) => {
    if (stack.length) stack.at(-1)!.text += text;
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.write(bytes.toString('utf8')).close();
  return root ?? fail('invalid-xml');
}
const children = (n: XmlNode, name: string) =>
  n.children.filter((c) => c.name === name);
const child = (n: XmlNode, name: string): XmlNode | undefined =>
  children(n, name)[0];
const richText = (n: XmlNode): string =>
  n.name === 't'
    ? n.text
    : n.children
        .filter((c) => c.name !== 'rPh')
        .map(richText)
        .join('');
const columnName = (column: number) => {
  let result = '';
  while (column > 0) {
    column--;
    result = String.fromCharCode(65 + (column % 26)) + result;
    column = Math.floor(column / 26);
  }
  return result;
};
const builtInFormats: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  9: '0%',
  10: '0.00%',
  14: 'mm-dd-yy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yy h:mm',
  49: '@',
};

export interface XlsxSourceCell {
  address: string;
  sourceRow: number;
  column: number;
  type: string;
  raw: string | null;
  value: string | null;
  numberFormat: string | null;
  numberFormatId: number;
  formula: string | null;
  formulaAttributes: Record<string, string> | null;
  valueOrigin: 'source' | 'cached-formula' | 'unavailable';
}
export interface XlsxTableCandidate {
  tableId: string;
  sheet: string;
  range: string;
  headerRow: number;
  headers: string[];
  rows: { sourceRow: number; cells: string[] }[];
  cellProvenance: XlsxSourceCell[];
  issues: string[];
}

/** Grounded extraction only: first rows are tentative headers, never layout approval.
 * Formulas, macros, links and document instructions are data, never executed or fetched.
 * Numbers (including Excel date serials) and format codes remain original source facts.
 */
export function extractFinanceXlsxTables(
  bytes: Uint8Array,
  requested: Partial<XlsxExtractionLimits> = {},
) {
  const limits = { ...defaults, ...requested };
  for (const key of Object.keys(defaults) as (keyof XlsxExtractionLimits)[]) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > defaults[key]
    )
      fail('invalid-limit');
  }
  const files = unzip(bytes, limits),
    workbook = xml(files.get('xl/workbook.xml'));
  const rels = xml(files.get('xl/_rels/workbook.xml.rels'));
  const relationships = new Map<string, XmlNode>();
  for (const rel of children(rels, 'Relationship')) {
    if (!rel.attrs.Id || relationships.has(rel.attrs.Id))
      fail('ambiguous-relationship');
    relationships.set(rel.attrs.Id, rel);
  }
  const shared = files.has('xl/sharedStrings.xml')
    ? children(xml(files.get('xl/sharedStrings.xml')), 'si').map(richText)
    : [];
  const styles = files.has('xl/styles.xml')
    ? xml(files.get('xl/styles.xml'))
    : undefined;
  const formats = { ...builtInFormats };
  if (styles)
    for (const format of child(styles, 'numFmts')?.children ?? [])
      formats[Number(format.attrs.numFmtId)] = format.attrs.formatCode;
  const styleIds = styles
    ? (child(styles, 'cellXfs')?.children ?? []).map((n) =>
        Number(n.attrs.numFmtId ?? 0),
      )
    : [0];
  const sheetNodes = child(workbook, 'sheets')?.children ?? [];
  if (!sheetNodes.length || sheetNodes.length > limits.maxSheets)
    fail('sheets-limit-or-missing');
  const dateSystem = child(workbook, 'workbookPr')?.attrs.date1904;
  if (
    dateSystem !== undefined &&
    !['0', '1', 'false', 'true'].includes(dateSystem)
  )
    fail('invalid-date-system');
  const tables: XlsxTableCandidate[] = [],
    issues: string[] = [];
  if ([...files.keys()].some((n) => /vbaProject|externalLinks/i.test(n)))
    issues.push('active-or-external-content-ignored');
  let cellCount = 0,
    rowCount = 0;
  const names = new Set<string>();
  const sheets = sheetNodes.map((sheet, index) => {
    const name = sheet.attrs.name;
    if (!name || name.length > 200 || names.has(name)) fail('ambiguous-sheet');
    names.add(name);
    const rel = relationships.get(sheet.attrs['r:id']);
    if (
      !rel ||
      rel.attrs.TargetMode === 'External' ||
      !rel.attrs.Type.endsWith('/worksheet')
    )
      fail('unsupported-sheet-relationship');
    if (
      !rel.attrs.Target ||
      rel.attrs.Target.includes('\\') ||
      rel.attrs.Target.includes('%') ||
      rel.attrs.Target.includes('?') ||
      rel.attrs.Target.includes('#')
    )
      fail('invalid-sheet-path');
    const path = posix.normalize(
      rel.attrs.Target.startsWith('/')
        ? rel.attrs.Target.slice(1)
        : posix.join('xl', rel.attrs.Target),
    );
    if (!path.startsWith('xl/')) fail('invalid-sheet-path');
    const worksheet = xml(files.get(path));
    const data = child(worksheet, 'sheetData');
    if (!data) fail('missing-sheet-data');
    const mergedRanges = (child(worksheet, 'mergeCells')?.children ?? []).map(
      (merge) => merge.attrs.ref,
    );
    if (mergedRanges.some((range) => !range)) fail('invalid-merged-range');
    if (mergedRanges.length)
      issues.push(`merged-cells-present:sheet-${index + 1}`);
    const sourceCells: XlsxSourceCell[] = [];
    const sourceRows: { sourceRow: number; hidden: boolean }[] = [];
    const hiddenColumns = (child(worksheet, 'cols')?.children ?? [])
      .filter(
        (column) =>
          column.attrs.hidden === '1' || column.attrs.hidden === 'true',
      )
      .map((column) => ({
        firstColumn: Number(column.attrs.min),
        lastColumn: Number(column.attrs.max),
      }));
    if (
      hiddenColumns.some(
        (column) =>
          !Number.isSafeInteger(column.firstColumn) ||
          !Number.isSafeInteger(column.lastColumn) ||
          column.firstColumn < 1 ||
          column.lastColumn > 16384 ||
          column.firstColumn > column.lastColumn,
      )
    )
      fail('invalid-hidden-columns');
    let previousRow = 0;
    const regions: XlsxSourceCell[][] = [];
    let region: XlsxSourceCell[] = [];
    for (const row of children(data, 'row')) {
      const sourceRow = Number(row.attrs.r);
      if (
        !Number.isSafeInteger(sourceRow) ||
        sourceRow <= previousRow ||
        sourceRow > 1_048_576
      )
        fail('invalid-row-address');
      if (++rowCount > limits.maxRows) fail('rows-limit');
      sourceRows.push({
        sourceRow,
        hidden: row.attrs.hidden === '1' || row.attrs.hidden === 'true',
      });
      if (sourceRow > previousRow + 1 && region.length) {
        regions.push(region);
        region = [];
      }
      previousRow = sourceRow;
      let previousColumn = 0;
      const cells: XlsxSourceCell[] = [];
      for (const cell of children(row, 'c')) {
        if (++cellCount > limits.maxCells) fail('cells-limit');
        const address = cell.attrs.r,
          match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(address ?? '');
        if (!match || Number(match[2]) !== sourceRow)
          fail('invalid-cell-address');
        let column = 0;
        for (const letter of match[1])
          column = column * 26 + letter.charCodeAt(0) - 64;
        if (column <= previousColumn || column > limits.maxColumns)
          fail('columns-limit-or-order');
        previousColumn = column;
        const type = cell.attrs.t ?? 'n',
          raw = child(cell, 'v')?.text ?? null,
          formula = child(cell, 'f');
        if (!['n', 's', 'inlineStr', 'str', 'b', 'e', 'd'].includes(type))
          fail('unsupported-cell-type');
        let value = raw;
        if (type === 's' && raw !== null) {
          if (!/^\d+$/.test(raw) || shared[Number(raw)] === undefined)
            fail('invalid-shared-string');
          value = shared[Number(raw)];
        } else if (type === 'inlineStr')
          value = child(cell, 'is') ? richText(child(cell, 'is')!) : null;
        const style = Number(cell.attrs.s ?? 0);
        if (
          !Number.isSafeInteger(style) ||
          style < 0 ||
          styleIds[style] === undefined
        )
          fail('invalid-cell-style');
        const numberFormatId = styleIds[style];
        if (
          (value?.length ?? 0) > limits.maxCellCharacters ||
          (formula?.text.length ?? 0) > limits.maxCellCharacters
        )
          fail('cell-characters-limit');
        if (formula && raw === null) value = null;
        cells.push({
          address,
          sourceRow,
          column,
          type,
          raw,
          value,
          numberFormatId,
          numberFormat: formats[numberFormatId] ?? null,
          formula: formula?.text ?? null,
          formulaAttributes: formula?.attrs ?? null,
          valueOrigin: formula
            ? raw === null
              ? 'unavailable'
              : 'cached-formula'
            : 'source',
        });
      }
      sourceCells.push(...cells);
      if (
        !cells.some(
          (c) => (c.value !== null && c.value !== '') || c.formula !== null,
        )
      ) {
        // Explicit blank cells still belong to the preceding candidate as provenance.
        region.push(...cells);
        if (region.length) {
          regions.push(region);
          region = [];
        }
      } else region.push(...cells);
    }
    if (region.length) regions.push(region);
    for (const sourceCells of regions) {
      const meaningful = sourceCells.filter(
        (c) => (c.value !== null && c.value !== '') || c.formula !== null,
      );
      if (!meaningful.length) continue;
      const headerRow = meaningful[0].sourceRow,
        lastRow = meaningful.at(-1)!.sourceRow;
      const minColumn = Math.min(...sourceCells.map((c) => c.column)),
        maxColumn = Math.max(...sourceCells.map((c) => c.column));
      const rowMap = new Map<number, Map<number, string>>();
      for (const c of sourceCells) {
        if (!rowMap.has(c.sourceRow)) rowMap.set(c.sourceRow, new Map());
        rowMap.get(c.sourceRow)!.set(c.column, c.value ?? '');
      }
      const values = (r: number) =>
        Array.from(
          { length: maxColumn - minColumn + 1 },
          (_, col) => rowMap.get(r)?.get(minColumn + col) ?? '',
        );
      const headers = values(headerRow),
        candidateIssues = [
          'header-row-unconfirmed',
          'table-region-unconfirmed',
        ];
      if (
        headers.some((h) => !h.trim() || h.length > 200) ||
        new Set(headers).size !== headers.length
      )
        candidateIssues.push('ambiguous-headings');
      if (sourceCells.some((c) => c.formula !== null))
        candidateIssues.push('formula-caches-unverified');
      if (sourceCells.some((c) => c.valueOrigin === 'unavailable'))
        candidateIssues.push('formula-cache-unavailable');
      if (sourceCells.some((c) => c.type === 'e'))
        candidateIssues.push('source-cell-error');
      if (lastRow === headerRow) candidateIssues.push('no-data-rows');
      const rows = [...rowMap.keys()]
        .filter((r) => r > headerRow && r <= lastRow)
        .map((sourceRow) => ({ sourceRow, cells: values(sourceRow) }));
      tables.push({
        tableId: `xlsx-sheet-${index + 1}-region-${tables.filter((t) => t.sheet === name).length + 1}`,
        sheet: name,
        range: `${columnName(minColumn)}${headerRow}:${columnName(maxColumn)}${sourceCells.at(-1)!.sourceRow}`,
        headerRow,
        headers,
        rows,
        cellProvenance: sourceCells,
        issues: candidateIssues,
      });
    }
    return {
      name,
      index: index + 1,
      state: sheet.attrs.state ?? 'visible',
      cells: sourceCells,
      rows: sourceRows,
      mergedRanges,
      hiddenColumns,
    };
  });
  if (tables.length > 1) issues.push('multiple-table-candidates');
  return {
    format: 'xlsx' as const,
    dateSystem:
      dateSystem === '1' || dateSystem === 'true'
        ? ('1904' as const)
        : ('1900' as const),
    sheets,
    tables,
    issues,
  };
}
