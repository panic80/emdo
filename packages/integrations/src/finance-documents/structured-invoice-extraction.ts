import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';
import {
  StructuredInvoiceExtractionSchema,
  type StructuredInvoiceExtraction,
} from '@emdo/contracts';
const ns = {
  ubl: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  rsm: 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100',
  ram: 'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100',
  udt: 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100',
} as const;
type Node = {
  name: string;
  namespace: string;
  path: string;
  text: string;
  attributes: Record<string, string>;
  children: Node[];
};
type Fact = StructuredInvoiceExtraction['facts'][number];
const tag = (prefix: keyof typeof ns, name: string) => `{${ns[prefix]}}${name}`;
function children(node: Node | undefined, path: string): Node[] {
  let nodes = node ? [node] : [];
  for (const part of path.split('/'))
    nodes = nodes.flatMap((n) =>
      n.children.filter((c) => `{${c.namespace}}${c.name}` === part),
    );
  return nodes;
}
// Clark names include slash in some URIs only for unknown namespaces; known invoice URNs have none.
function one(
  node: Node | undefined,
  path: string,
  issues: string[],
): Node | undefined {
  const values = children(node, path);
  if (values.length > 1) issues.push(`Ambiguous singleton: ${values[0]!.path}`);
  return values.length === 1 ? values[0] : undefined;
}
const fact = (n: Node): Fact => ({
  path: n.path,
  namespace: n.namespace,
  name: n.name,
  text: n.text,
  attributes: Object.entries(n.attributes).map(([name, value]) => ({
    name,
    value,
  })),
});
const leaves = (node: Node | undefined): Fact[] =>
  node
    ? node.children.length
      ? node.children.flatMap(leaves)
      : [fact(node)]
    : [];
const field = (node: Node | undefined) =>
  node ? { value: node.text, path: node.path } : null;
const value = (node: Node | undefined) => node?.text.trim();
/** Bounded UTF-8 XML parsing only. No DTD, entities, stylesheet, schema fetch or embedded attachment execution. */
export function extractStructuredFinanceInvoice(
  bytes: Uint8Array,
  expectedFormat?: 'ubl' | 'cii',
): StructuredInvoiceExtraction {
  if (bytes.length === 0 || bytes.length > 2097152)
    throw new Error('structured-invoice-byte-limit');
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('structured-invoice-unsafe-xml');
  const stack: Node[] = [],
    roots: Node[] = [];
  let count = 0,
    textCount = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => {
    throw new Error('structured-invoice-unsafe-xml');
  });
  parser.on('processinginstruction', () => {
    throw new Error('structured-invoice-processing-instruction-unsupported');
  });
  parser.on('xmldecl', (d) => {
    if (d.encoding && !/^utf-?8$/i.test(d.encoding))
      throw new Error('structured-invoice-encoding-unsupported');
  });
  parser.on('opentag', (t) => {
    if (++count > 15000 || stack.length >= 48)
      throw new Error('structured-invoice-node-limit');
    const parent = stack.at(-1),
      siblings = parent?.children ?? roots;
    const attrs: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const a of Object.values(t.attributes)) {
      if (a.uri === 'http://www.w3.org/2000/xmlns/') continue;
      const key = a.uri ? `{${a.uri}}${a.local}` : a.local;
      if (Object.keys(attrs).length >= 30 || a.value.length > 4096)
        throw new Error('structured-invoice-attribute-limit');
      attrs[key] = a.value;
    }
    const node: Node = {
      name: t.local,
      namespace: t.uri,
      path: `${parent?.path ?? ''}/${`{${t.uri}}${t.local}`}[${siblings.filter((n) => n.name === t.local && n.namespace === t.uri).length + 1}]`,
      text: '',
      attributes: attrs,
      children: [],
    };
    if (node.path.length > 4096)
      throw new Error('structured-invoice-path-limit');
    siblings.push(node);
    stack.push(node);
  });
  const text = (s: string) => {
    textCount += s.length;
    if (textCount > 1000000) throw new Error('structured-invoice-text-limit');
    const n = stack.at(-1);
    if (n) {
      n.text += s;
      if (n.text.length > 16384)
        throw new Error('structured-invoice-field-limit');
    }
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    const node = stack.pop();
    if (node?.children.length && node.text.trim())
      throw new Error('structured-invoice-mixed-content-unsupported');
  });
  parser.on('error', () => {
    throw new Error('structured-invoice-malformed-xml');
  });
  parser.write(xml).close();
  const root = roots[0];
  if (roots.length !== 1 || !root)
    throw new Error('structured-invoice-root-required');
  const format =
    root.namespace === ns.ubl && root.name === 'Invoice'
      ? 'ubl'
      : root.namespace === ns.rsm && root.name === 'CrossIndustryInvoice'
        ? 'cii'
        : null;
  if (!format || (expectedFormat && format !== expectedFormat))
    throw new Error('structured-invoice-format-unsupported');
  const issues: string[] = [],
    facts = leaves(root);
  if (facts.length > 10000) throw new Error('structured-invoice-fact-limit');
  const get = (n: Node | undefined, p: string) => one(n, p, issues),
    f = (n: Node | undefined, p: string) => field(get(n, p));
  const c = (name: string) => tag('cbc', name),
    a = (name: string) => tag('cac', name),
    r = (name: string) => tag('ram', name),
    u = (name: string) => tag('udt', name);
  const transaction =
    format === 'cii'
      ? get(root, tag('rsm', 'SupplyChainTradeTransaction'))
      : root;
  const document =
    format === 'cii' ? get(root, tag('rsm', 'ExchangedDocument')) : root;
  const settlement =
    format === 'cii'
      ? get(transaction, r('ApplicableHeaderTradeSettlement'))
      : root;
  const total =
    format === 'cii'
      ? get(settlement, r('SpecifiedTradeSettlementHeaderMonetarySummation'))
      : get(root, a('LegalMonetaryTotal'));
  const date = (node: Node | undefined) => {
    if (!node) return null;
    const raw = value(node)!;
    if (format === 'cii') {
      if (node.attributes.format !== '102' || !/^\d{8}$/.test(raw)) {
        issues.push(`Unsupported date representation: ${node.path}`);
        return field(node);
      }
      return {
        value: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
        path: node.path,
      };
    }
    return field(node);
  };
  const seller =
    format === 'ubl'
      ? get(root, `${a('AccountingSupplierParty')}/${a('Party')}`)
      : get(
          transaction,
          `${r('ApplicableHeaderTradeAgreement')}/${r('SellerTradeParty')}`,
        );
  const buyer =
    format === 'ubl'
      ? get(root, `${a('AccountingCustomerParty')}/${a('Party')}`)
      : get(
          transaction,
          `${r('ApplicableHeaderTradeAgreement')}/${r('BuyerTradeParty')}`,
        );
  const lineNodes = children(
    transaction,
    format === 'ubl' ? a('InvoiceLine') : r('IncludedSupplyChainTradeLineItem'),
  );
  if (lineNodes.length > 250) throw new Error('structured-invoice-line-limit');
  const taxNodes = children(
    settlement,
    format === 'ubl'
      ? `${a('TaxTotal')}/${a('TaxSubtotal')}`
      : r('ApplicableTradeTax'),
  );
  if (taxNodes.length > 100)
    throw new Error('structured-invoice-tax-group-limit');
  const result: StructuredInvoiceExtraction = {
    schemaVersion: 1,
    adapterVersion: 'structured-invoice.v1',
    format,
    sourceDigest: createHash('sha256').update(bytes).digest('hex'),
    conformance: 'not-validated',
    documentInstructions: 'untrusted-source-data',
    reviewRequired: true,
    invoiceId: f(document, format === 'ubl' ? c('ID') : r('ID')),
    typeCode: f(
      document,
      format === 'ubl' ? c('InvoiceTypeCode') : r('TypeCode'),
    ),
    profile:
      format === 'ubl'
        ? f(root, c('CustomizationID'))
        : f(
            root,
            `${tag('rsm', 'ExchangedDocumentContext')}/${r('GuidelineSpecifiedDocumentContextParameter')}/${r('ID')}`,
          ),
    issueDate: date(
      get(
        document,
        format === 'ubl'
          ? c('IssueDate')
          : `${r('IssueDateTime')}/${u('DateTimeString')}`,
      ),
    ),
    dueDate: date(
      get(
        settlement,
        format === 'ubl'
          ? c('DueDate')
          : `${r('SpecifiedTradePaymentTerms')}/${r('DueDateDateTime')}/${u('DateTimeString')}`,
      ),
    ),
    currency: f(
      settlement,
      format === 'ubl' ? c('DocumentCurrencyCode') : r('InvoiceCurrencyCode'),
    ),
    seller: leaves(seller),
    buyer: leaves(buyer),
    lines: lineNodes.map((n) => ({
      id: f(
        n,
        format === 'ubl'
          ? c('ID')
          : `${r('AssociatedDocumentLineDocument')}/${r('LineID')}`,
      ),
      description: f(
        n,
        format === 'ubl'
          ? `${a('Item')}/${c('Name')}`
          : `${r('SpecifiedTradeProduct')}/${r('Name')}`,
      ),
      netAmount: f(
        n,
        format === 'ubl'
          ? c('LineExtensionAmount')
          : `${r('SpecifiedLineTradeSettlement')}/${r('SpecifiedTradeSettlementLineMonetarySummation')}/${r('LineTotalAmount')}`,
      ),
      quantity: f(
        n,
        format === 'ubl'
          ? c('InvoicedQuantity')
          : `${r('SpecifiedLineTradeDelivery')}/${r('BilledQuantity')}`,
      ),
      facts: leaves(n),
    })),
    adjustments: [
      ...children(
        settlement,
        format === 'ubl'
          ? a('AllowanceCharge')
          : r('SpecifiedTradeAllowanceCharge'),
      ).map((n) => ({ scope: 'document' as const, node: n })),
      ...lineNodes.flatMap((line) =>
        children(
          line,
          format === 'ubl'
            ? a('AllowanceCharge')
            : `${r('SpecifiedLineTradeSettlement')}/${r('SpecifiedTradeAllowanceCharge')}`,
        ).map((n) => ({ scope: 'line' as const, node: n })),
      ),
    ].map(({ scope, node }) => ({
      scope,
      charge: f(
        node,
        format === 'ubl'
          ? c('ChargeIndicator')
          : `${r('ChargeIndicator')}/${u('Indicator')}`,
      ),
      amount: f(node, format === 'ubl' ? c('Amount') : r('ActualAmount')),
      facts: leaves(node),
    })),
    taxGroups: taxNodes.map((n) => ({
      key: n.path,
      category: f(
        n,
        format === 'ubl' ? `${a('TaxCategory')}/${c('ID')}` : r('CategoryCode'),
      ),
      rate: f(
        n,
        format === 'ubl'
          ? `${a('TaxCategory')}/${c('Percent')}`
          : r('RateApplicablePercent'),
      ),
      basis: f(n, format === 'ubl' ? c('TaxableAmount') : r('BasisAmount')),
      tax: f(n, format === 'ubl' ? c('TaxAmount') : r('CalculatedAmount')),
    })),
    totals: {
      lineNet: f(
        total,
        format === 'ubl' ? c('LineExtensionAmount') : r('LineTotalAmount'),
      ),
      net: f(
        total,
        format === 'ubl' ? c('TaxExclusiveAmount') : r('TaxBasisTotalAmount'),
      ),
      tax:
        format === 'ubl'
          ? f(root, `${a('TaxTotal')}/${c('TaxAmount')}`)
          : f(total, r('TaxTotalAmount')),
      gross: f(
        total,
        format === 'ubl' ? c('TaxInclusiveAmount') : r('GrandTotalAmount'),
      ),
      payable: f(
        total,
        format === 'ubl' ? c('PayableAmount') : r('DuePayableAmount'),
      ),
      allowances: f(
        total,
        format === 'ubl'
          ? c('AllowanceTotalAmount')
          : r('AllowanceTotalAmount'),
      ),
      charges: f(
        total,
        format === 'ubl' ? c('ChargeTotalAmount') : r('ChargeTotalAmount'),
      ),
      prepaid: f(
        total,
        format === 'ubl' ? c('PrepaidAmount') : r('TotalPrepaidAmount'),
      ),
      rounding: format === 'ubl' ? f(total, c('PayableRoundingAmount')) : null,
    },
    facts,
    blockingIssues: issues,
  };
  for (const [name, v] of Object.entries({
    invoiceId: result.invoiceId,
    issueDate: result.issueDate,
    dueDate: result.dueDate,
    currency: result.currency,
    profile: result.profile,
  }))
    if (!v?.value.trim()) issues.push(`Missing ${name}`);
  if (
    value(
      get(document, format === 'ubl' ? c('InvoiceTypeCode') : r('TypeCode')),
    ) !== '380'
  )
    issues.push('Only ordinary invoice type 380 is supported for posting');
  if (
    !seller ||
    !buyer ||
    [result.seller, result.buyer].some(
      (party) =>
        !party.some(
          (f) => ['Name', 'RegistrationName'].includes(f.name) && f.text.trim(),
        ),
    )
  )
    issues.push('Seller and buyer names are required');
  if (!lineNodes.length || result.lines.some((l) => !l.id || !l.netAmount))
    issues.push('Invoice lines require explicit identifiers and net amounts');
  if (
    new Set(result.lines.map((l) => l.id?.value)).size !== result.lines.length
  )
    issues.push('Duplicate invoice line identifiers');
  if (!result.taxGroups.length)
    issues.push('Explicit VAT breakdown groups are required');
  for (const n of taxNodes) {
    const type = value(
      get(
        n,
        format === 'ubl'
          ? `${a('TaxCategory')}/${a('TaxScheme')}/${c('ID')}`
          : r('TypeCode'),
      ),
    );
    if (type !== 'VAT') issues.push('Only source VAT breakdowns are supported');
  }
  const supportedNamespaces = new Set<string>(Object.values(ns));
  if (facts.some((f) => !supportedNamespaces.has(f.namespace)))
    issues.push('Unknown extension namespace requires manual handling');
  if (
    facts.some(
      (f) =>
        f.name === 'EmbeddedDocumentBinaryObject' ||
        f.name === 'AttachmentBinaryObject' ||
        f.name === 'URI',
    )
  )
    issues.push(
      'Attachments, external references or rounding require separate handling',
    );
  if (
    format === 'ubl' &&
    get(root, c('UBLVersionID')) &&
    value(get(root, c('UBLVersionID'))) !== '2.1'
  )
    issues.push('Only the UBL 2.1 invoice binding is supported');
  const currency = result.currency?.value.trim();
  if (
    facts.some(
      (f) => f.name === 'TaxCurrencyCode' && f.text.trim() !== currency,
    )
  )
    issues.push('Multiple or conflicting source currencies are unsupported');
  for (const item of facts)
    if (
      item.attributes.some(
        (a) => a.name === 'currencyID' && a.value !== currency,
      )
    )
      issues.push('Multiple or conflicting source currencies are unsupported');
  result.blockingIssues = [...new Set(issues)].slice(0, 100);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 2097152)
    throw new Error('structured-invoice-output-limit');
  return StructuredInvoiceExtractionSchema.parse(result);
}
