import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';
import {
  FinanceOfxStatementSchema,
  FinanceOfxTimestampSchema,
  type FinanceOfxStatement,
} from '@emdo/contracts';
const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
function fail(reason: string): never {
  throw new Error(`finance-ofx-${reason}`);
}
const aggregates = new Set(
  'OFX SIGNONMSGSRSV1 SONRS STATUS FI BANKMSGSRSV1 STMTTRNRS STMTRS BANKACCTFROM BANKTRANLIST STMTTRN LEDGERBAL AVAILBAL CREDITCARDMSGSRSV1 CCSTMTTRNRS CCSTMTRS CCACCTFROM BANKACCTTO CCACCTTO PAYEE CURRENCY ORIGCURRENCY'.split(
    ' ',
  ),
);
const scalarTags = new Set(
  'CODE SEVERITY MESSAGE DTSERVER LANGUAGE DTPROFUP FI ORG FID INTU.BID TRNUID STATUS CURDEF BANKID BRANCHID ACCTID ACCTTYPE ACCTKEY DTSTART DTEND TRNTYPE DTPOSTED DTUSER DTAVAIL TRNAMT FITID CORRECTFITID CORRECTACTION SRVRTID CHECKNUM REFNUM SIC PAYEEID NAME MEMO BALAMT DTASOF CURRATE CURSYM'.split(
    ' ',
  ),
);
interface Node {
  tag: string;
  path: string;
  start: number;
  textStart: number;
  end: number;
  textEnd: number;
  raw: string;
  children: Node[];
}
function decode(value: string) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/u.test(value))
    fail('unknown-entity');
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/gu,
    (entity) => {
      const fixed: Record<string, string> = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
      };
      if (fixed[entity]) return fixed[entity];
      const code = entity.startsWith('&#x')
        ? Number.parseInt(entity.slice(3, -1), 16)
        : Number(entity.slice(2, -1));
      if (
        code === 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff) ||
        (code < 32 && ![9, 10, 13].includes(code))
      )
        fail('invalid-character-entity');
      return String.fromCodePoint(code);
    },
  );
}
/** Preserve provider business date and raw offset separately; never shift into a local workspace timezone. */
export function parseFinanceOfxTimestamp(raw: string) {
  const text = raw.trim();
  const m =
    /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:\.(\d{1,3}))?)?)?)?(?:\[([+-]?\d{1,2}(?:\.\d{1,2})?)(?::([^\]\r\n]{1,30}))?\])?$/.exec(
      text,
    );
  let valid = !!m,
    businessDate: string | null = null,
    time: string | null = null,
    fraction: string | null = null,
    offsetMinutes: number | null = null,
    zoneLabel: string | null = null;
  if (m) {
    const year = Number(m[1]),
      month = Number(m[2]),
      day = Number(m[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    valid =
      year >= 1900 &&
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day;
    businessDate = `${m[1]}-${m[2]}-${m[3]}`;
    if (m[4]) {
      const hour = Number(m[4]),
        minute = Number(m[5] ?? 0),
        second = Number(m[6] ?? 0);
      valid &&= hour <= 23 && minute <= 59 && second <= 59;
      time = `${m[4]}:${m[5] ?? '00'}:${m[6] ?? '00'}`;
      fraction = m[7] ?? null;
    }
    if (m[8]) {
      offsetMinutes = Number(m[8]) * 60;
      valid &&=
        Number.isInteger(offsetMinutes) && Math.abs(offsetMinutes) <= 840;
      zoneLabel = m[9] ?? null;
    } else if (time) offsetMinutes = 0;
    if (m[8] && !time) valid = false;
  }
  return FinanceOfxTimestampSchema.parse({
    raw,
    businessDate,
    time,
    fraction,
    offsetMinutes: valid ? offsetMinutes : null,
    zoneLabel,
    offsetBasis: !valid
      ? 'invalid'
      : m?.[8]
        ? 'explicit'
        : time
          ? 'ofx-default-gmt'
          : 'date-only',
    valid,
  });
}
/** Bounded bank/card statement extraction. Unknown financial aggregates remain
 * explicit unsupported facts; no model, credential, URL, external entity or action runs. */
export function extractFinanceOfxStatement(
  bytes: Uint8Array,
  format: 'ofx' | 'qfx',
): FinanceOfxStatement {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 2097152)
    fail('bytes-limit');
  let source: string;
  try {
    source = new TextDecoder('utf8', { fatal: true }).decode(bytes);
  } catch {
    fail('utf8-required');
  }
  if (
    source.includes('\ufffd') ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(source)
  )
    fail('unsafe-text');
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/iu.test(source))
    fail('unsafe-or-unsupported-xml-declaration');
  const rootStart = source.search(/<OFX(?:\s|>)/u);
  if (rootStart < 0) fail('root-missing');
  const prefix = source.slice(0, rootStart);
  const sgml = /OFXHEADER\s*:\s*100/u.test(prefix);
  const headers: FinanceOfxStatement['headers'] = [];
  if (sgml) {
    for (const line of prefix.trim().split(/\r?\n/u)) {
      const m = /^([A-Z][A-Z0-9]*):([^\r\n]*)$/u.exec(line.trim());
      if (!m) fail('sgml-header-invalid');
      headers.push({ name: m[1]!, value: m[2]!.trim() });
    }
    if (new Set(headers.map((h) => h.name)).size !== headers.length)
      fail('duplicate-header');
    if (
      headers.find((h) => h.name === 'DATA')?.value !== 'OFXSGML' ||
      !['100', '102', '103', '151', '160'].includes(
        headers.find((h) => h.name === 'VERSION')?.value ?? '',
      )
    )
      fail('sgml-version-unsupported');
    for (const h of headers) {
      if (['SECURITY', 'COMPRESSION'].includes(h.name) && h.value !== 'NONE')
        fail('unsupported-header');
    }
    const encoding = headers.find((h) => h.name === 'ENCODING')?.value;
    if (
      /[^\x00-\x7f]/u.test(source) &&
      !['UTF-8', 'UTF8', 'UNICODE'].includes(encoding ?? '')
    )
      fail('legacy-encoding-requires-original-decoding');
  } else {
    if (prefix.replace(/<\?(?:xml|OFX)\b[\s\S]*?\?>/gu, '').trim())
      fail('xml-header-invalid');
    if (/encoding\s*=\s*["'](?!UTF-8["']|utf-8["']|US-ASCII["'])/u.test(prefix))
      fail('xml-encoding-unsupported');
    const parser = new SaxesParser({ xmlns: false });
    parser.on('error', () => fail('malformed-xml'));
    parser.on('doctype', () => fail('unsafe-xml'));
    try {
      parser.write(source).close();
    } catch {
      fail('malformed-xml');
    }
  }
  const stack: Node[] = [],
    all: Node[] = [];
  let root: Node | undefined;
  let cursor = rootStart;
  const close = (end: number) => {
    const node = stack.pop();
    if (!node) fail('malformed-nesting');
    node.end = end;
    return node;
  };
  const token = /<[^>]*>/gu;
  token.lastIndex = rootStart;
  let found: RegExpExecArray | null;
  while ((found = token.exec(source))) {
    const start = found.index;
    const between = source.slice(cursor, start);
    const top = stack.at(-1);
    if (between.trim() && (!top || top.children.length))
      fail('mixed-or-outside-text');
    if (top && !top.children.length) {
      top.raw += between;
      top.textEnd = start;
    }
    const text = found[0];
    cursor = token.lastIndex;
    if (text.startsWith('<!--')) fail('comment-unsupported');
    const m = /^<(\/)?([A-Z][A-Z0-9_.-]*)(\/)?>$/u.exec(text);
    if (!m) fail('unsupported-tag-or-attribute');
    const closing = !!m[1],
      tag = m[2]!;
    if (sgml && stack.length) {
      const current = stack.at(-1)!;
      if (
        current.tag !== tag &&
        !current.children.length &&
        !aggregates.has(current.tag) &&
        (current.raw.trim().length || scalarTags.has(current.tag))
      )
        close(start);
    }
    if (closing) {
      if (stack.at(-1)?.tag !== tag) fail('malformed-nesting');
      close(cursor);
      continue;
    }
    if (stack.length >= 24 || all.length >= 30000) fail('structure-limit');
    const parent = stack.at(-1);
    if (!parent && root) fail('multiple-roots');
    const ordinal =
      1 + (parent?.children.filter((c) => c.tag === tag).length ?? 0);
    const node: Node = {
      tag,
      path: `${parent?.path ?? ''}/${tag}[${ordinal}]`,
      start,
      textStart: cursor,
      textEnd: cursor,
      end: cursor,
      raw: '',
      children: [],
    };
    if (parent) parent.children.push(node);
    else {
      if (tag !== 'OFX') fail('root-invalid');
      root = node;
    }
    all.push(node);
    if (!m[3]) stack.push(node);
  }
  if (stack.length || source.slice(cursor).trim() || !root)
    fail('unclosed-document');
  const leaf = (node: Node) => ({
    tag: node.tag,
    path: node.path,
    value: decode(node.raw).trim(),
    raw: node.raw,
    start: node.textStart,
    end: node.textEnd,
  });
  const fields = all.filter((n) => !n.children.length).map(leaf);
  if (fields.length > 20000) fail('field-limit');
  const statements = all.filter((n) => ['STMTRS', 'CCSTMTRS'].includes(n.tag));
  const issues: string[] = [];
  if (statements.length !== 1)
    issues.push('exactly-one-bank-or-card-statement-required');
  const statement = statements.length === 1 ? statements[0] : undefined;
  const unique = (parent: Node | undefined, tag: string): string | null => {
    const nodes = parent?.children.filter((n) => n.tag === tag) ?? [];
    if (nodes.length > 1) fail(`ambiguous-${tag}`);
    return nodes[0] ? leaf(nodes[0]).value : null;
  };
  const child = (parent: Node | undefined, tag: string) => {
    const nodes = parent?.children.filter((n) => n.tag === tag) ?? [];
    if (nodes.length > 1) fail(`ambiguous-${tag}`);
    return nodes[0];
  };
  const fi = all.filter((n) => n.tag === 'FI');
  if (fi.length > 1) fail('ambiguous-institution');
  const accountNode = child(
    statement,
    statement?.tag === 'CCSTMTRS' ? 'CCACCTFROM' : 'BANKACCTFROM',
  );
  const institution = {
    org: unique(fi[0], 'ORG'),
    fid: unique(fi[0], 'FID'),
    bankId: unique(accountNode, 'BANKID'),
    branchId: unique(accountNode, 'BRANCHID'),
  };
  const account = {
    id: unique(accountNode, 'ACCTID'),
    type: unique(accountNode, 'ACCTTYPE'),
  };
  const currency = unique(statement, 'CURDEF');
  if (!currency) issues.push('source-currency-missing');
  if (all.some((n) => n.tag === 'STATUS' && unique(n, 'CODE') !== '0'))
    issues.push('provider-status-not-success');
  if (!account.id) issues.push('source-account-identity-missing');
  if (!institution.bankId && !institution.fid && !institution.org)
    issues.push('source-institution-identity-missing');
  const unsupportedAggregates = all
    .filter((n) => n.children.length && !aggregates.has(n.tag))
    .map((n) => n.path);
  if (unsupportedAggregates.length)
    issues.push('unsupported-aggregate-semantics');
  const list = child(statement, 'BANKTRANLIST');
  const transactionNodes =
    list?.children.filter((n) => n.tag === 'STMTTRN') ?? [];
  if (transactionNodes.length < 1)
    issues.push('statement-transactions-missing');
  if (transactionNodes.length > 2000) fail('transaction-limit');
  const descendantFields = (node: Node): ReturnType<typeof leaf>[] =>
    node.children.flatMap((child) =>
      child.children.length ? descendantFields(child) : [leaf(child)],
    );
  const transactions = transactionNodes.map((node, index) => {
    const fields = descendantFields(node);
    const fitid = unique(node, 'FITID');
    const rowIssues = [...issues];
    if (!fitid) rowIssues.push('fitid-missing');
    if (
      node.children.some((n) => n.children.length) ||
      unique(node, 'CORRECTFITID') ||
      unique(node, 'CORRECTACTION')
    )
      rowIssues.push('transaction-aggregate-or-correction-review-required');
    const supported = new Set(
      'TRNTYPE DTPOSTED DTUSER DTAVAIL TRNAMT FITID NAME MEMO CHECKNUM REFNUM SIC PAYEEID SRVRTID'.split(
        ' ',
      ),
    );
    if (fields.some((f) => !supported.has(f.tag)))
      rowIssues.push('unmapped-transaction-fields-require-review');
    const posted = parseFinanceOfxTimestamp(unique(node, 'DTPOSTED') ?? '');
    if (!posted.valid) rowIssues.push('invalid-posted-timestamp');
    const scopedFitid =
      fitid &&
      account.id &&
      (institution.bankId || institution.fid || institution.org)
        ? hash(
            JSON.stringify({
              version: 'ofx-fitid-scope.v1',
              institution: institution.bankId
                ? { bankId: institution.bankId, branchId: institution.branchId }
                : { fid: institution.fid, org: institution.org },
              accountId: account.id,
              fitid,
            }),
          )
        : null;
    return {
      sourceRow: index + 1,
      path: node.path,
      fields,
      posted,
      fitid,
      scopedFitid,
      issues: [...new Set(rowIssues)],
    };
  });
  const counts = new Map<string, number>();
  for (const row of transactions)
    if (row.scopedFitid)
      counts.set(row.scopedFitid, (counts.get(row.scopedFitid) ?? 0) + 1);
  for (const row of transactions)
    if (row.scopedFitid && (counts.get(row.scopedFitid) ?? 0) > 1)
      row.issues.push('repeated-fitid-in-statement');
  const start = unique(list, 'DTSTART'),
    end = unique(list, 'DTEND');
  const result = FinanceOfxStatementSchema.parse({
    version: 'finance-ofx-source.v1',
    format,
    syntax: sgml ? 'ofx1-sgml' : 'ofx2-xml',
    sourceDigest: hash(bytes),
    sourceOffsetUnit: 'utf16-code-units-in-utf8-decoded-source',
    headers,
    statementKind:
      statement?.tag === 'STMTRS'
        ? 'bank'
        : statement?.tag === 'CCSTMTRS'
          ? 'credit-card'
          : 'unsupported',
    institution,
    account,
    currency,
    statementStart: start ? parseFinanceOfxTimestamp(start) : null,
    statementEnd: end ? parseFinanceOfxTimestamp(end) : null,
    fields,
    transactions,
    issues,
    unsupportedAggregates,
    balanceAuthority: 'reported-source-only-no-opening-balance',
  });
  if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024)
    fail('extraction-output-limit');
  return result;
}
