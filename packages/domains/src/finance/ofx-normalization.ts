import {
  FinanceOfxStatementSchema,
  type FinanceCurrency,
  type FinanceOfxStatement,
} from '@emdo/contracts';
import {
  parseStatementAmount,
  type NormalizedStatementRow,
} from './normalized-imports.js';
export interface FinanceOfxRowSource {
  version: 'finance-ofx-normalized.v1';
  sourceDigest: string;
  identityVersion: 'ofx-fitid-scope.v1';
  rawFitid: string | null;
  scopedFitid: string | null;
  institution: FinanceOfxStatement['institution'];
  account: FinanceOfxStatement['account'];
  statementCurrency: string | null;
  statementStart: FinanceOfxStatement['statementStart'];
  statementEnd: FinanceOfxStatement['statementEnd'];
  posted: FinanceOfxStatement['transactions'][number]['posted'];
  fields: FinanceOfxStatement['fields'];
  statementFields: FinanceOfxStatement['fields'];
  blockingIssues: string[];
}
export type NormalizedFinanceOfxRow = NormalizedStatementRow & {
  ofxSource: FinanceOfxRowSource;
};
/** Deterministic bank/card normalization. Unsupported source semantics remain blocked,
 * even when an ordinary amount/date edit would otherwise make the row postable. */
export function normalizeFinanceOfxStatement(
  input: unknown,
  currency: FinanceCurrency,
): NormalizedFinanceOfxRow[] {
  const source = FinanceOfxStatementSchema.parse(input);
  if (source.statementKind === 'unsupported' || !source.transactions.length)
    throw new Error('finance-ofx-bank-or-card-statement-required');
  const statementFields = source.fields.filter(
    (f) => !f.path.includes('/STMTTRN['),
  );
  const rows = source.transactions.map((transaction) => {
    const value = (tag: string) =>
      transaction.fields.find((f) => f.tag === tag)?.value ?? '';
    const raw = (tag: string) =>
      transaction.fields.find((f) => f.tag === tag)?.raw ?? '';
    const blockingIssues = [...transaction.issues];
    if (source.currency !== currency)
      blockingIssues.push('source-account-currency-mismatch');
    let amount: string | null = null;
    try {
      amount = parseStatementAmount(value('TRNAMT'), currency);
    } catch {
      blockingIssues.push('invalid-amount');
    }
    const description = [value('NAME'), value('MEMO')]
      .filter(Boolean)
      .join(' — ');
    if (!description || description.length > 500)
      blockingIssues.push('invalid-description');
    const externalId = transaction.scopedFitid
      ? `ofx.v1:${transaction.scopedFitid}`
      : null;
    return {
      sourceRow: transaction.sourceRow,
      date: transaction.posted.valid ? transaction.posted.businessDate : null,
      description: description.slice(0, 500),
      amount,
      currency,
      externalId,
      issues: [...new Set(blockingIssues)],
      provenance: {
        date: {
          sourceRow: transaction.sourceRow,
          column: 'DTPOSTED',
          raw: raw('DTPOSTED'),
        },
        amount: {
          sourceRow: transaction.sourceRow,
          column: 'TRNAMT',
          raw: raw('TRNAMT'),
        },
        description: {
          sourceRow: transaction.sourceRow,
          column: 'NAME/MEMO',
          raw: [raw('NAME'), raw('MEMO')].filter(Boolean).join(' — '),
        },
        externalId: {
          sourceRow: transaction.sourceRow,
          column: 'FITID',
          raw: raw('FITID'),
        },
      },
      ofxSource: {
        version: 'finance-ofx-normalized.v1' as const,
        sourceDigest: source.sourceDigest,
        identityVersion: 'ofx-fitid-scope.v1' as const,
        rawFitid: transaction.fitid,
        scopedFitid: transaction.scopedFitid,
        institution: source.institution,
        account: source.account,
        statementCurrency: source.currency,
        statementStart: source.statementStart,
        statementEnd: source.statementEnd,
        posted: transaction.posted,
        fields: transaction.fields,
        statementFields: transaction.sourceRow === 1 ? statementFields : [],
        blockingIssues: [...new Set(blockingIssues)],
      },
    };
  });
  if (new TextEncoder().encode(JSON.stringify(rows)).length > 4194304)
    throw new Error('finance-ofx-normalized-output-limit');
  return rows;
}
/** Generic row correction cannot replace source identity, corrections/splits or other
 * unsupported semantics. It may repair a date/description/amount with recorded review. */
export function assertFinanceOfxRowReviewable(
  facts: unknown,
  externalId: unknown,
) {
  if (!facts || typeof facts !== 'object' || !('ofxSource' in facts)) return;
  const source = (facts as { ofxSource: FinanceOfxRowSource }).ofxSource;
  if (
    source?.version !== 'finance-ofx-normalized.v1' ||
    !Array.isArray(source.blockingIssues)
  )
    throw new Error('finance-ofx-source-review-required');
  if (
    source.blockingIssues.some(
      (issue) =>
        ![
          'invalid-amount',
          'invalid-description',
          'invalid-posted-timestamp',
        ].includes(issue),
    )
  )
    throw new Error('finance-ofx-source-review-required');
  if (!source.scopedFitid || externalId !== `ofx.v1:${source.scopedFitid}`)
    throw new Error('finance-ofx-source-identity-immutable');
}
