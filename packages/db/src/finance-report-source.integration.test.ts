import { createHash, randomUUID } from 'node:crypto';
import {
  FinanceBookEvidenceCrypto,
  EncryptedFinanceBookEvidenceSchema,
} from '../../integrations/src/finance-documents/book-evidence-crypto.js';
import { InMemoryVaultKeyProvider } from '../../integrations/src/vault/crypto.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SaveFinanceReportMappingFromSourceSchema,
  type WorkspaceContext,
} from '@emdo/contracts';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';

const url = process.env.FINANCE_V2_TEST_DATABASE_URL;

describe.skipIf(!url)('CSV report source-only persistence', () => {
  const admin = new pg.Pool({ connectionString: url });
  const pool = {
    async connect() {
      const client = await admin.connect();
      await client.query('set role emdo_app');
      return client;
    },
  };
  const cipher = new FinanceBookEvidenceCrypto(
    new InMemoryVaultKeyProvider(
      new Uint8Array(32).fill(19),
      'finance-documents.v1',
    ),
  );
  const repository = new PostgresFinanceV2Repository(pool, {
    evidenceCipher: {
      encrypt: (value, scope) => cipher.encrypt(value, scope),
      decrypt: (value, scope) =>
        cipher.decrypt(EncryptedFinanceBookEvidenceSchema.parse(value), scope),
    },
  });
  const context: WorkspaceContext = {
    userId: randomUUID(),
    workspaceId: randomUUID(),
    sessionId: randomUUID(),
    requestId: randomUUID(),
  };
  let bookId: string;
  let evidenceId: string;
  let sourceDigest: string;
  const sourceText =
    'Date,Description,Amount,Currency\n2026-09-13,Source item,27.13,CAD\n';
  const definition = {
    providerKey: 'csv-bank',
    reportName: 'CSV activity',
    reportType: 'bank-transactions',
    layoutVersion: '1',
    headers: ['Date', 'Description', 'Amount', 'Currency'],
    bindings: [
      { field: 'transactionDate', column: 'Date', context: null },
      { field: 'description', column: 'Description', context: null },
      { field: 'amount', column: 'Amount', context: null },
      { field: 'currency', column: 'Currency', context: null },
    ],
    dateFormat: 'yyyy-mm-dd',
    decimalSeparator: '.',
    groupingSeparator: '',
    quantityUnit: null,
    valuationMultiplier: null,
    identifierScheme: null,
    identifierNamespace: null,
  } as const;
  const proposal = {
    definition,
    rationale: 'The source headings were checked against the bank export.',
    unresolvedQuestions: [],
  };
  async function sql(query: string, values: unknown[] = []) {
    const client = await admin.connect();
    try {
      await client.query('reset role');
      return await client.query(query, values);
    } finally {
      client.release();
    }
  }
  beforeAll(async () => {
    await sql(
      `insert into emdo.auth_users(id,name,email,email_verified) values($1,'CSV report tester',$2,true)`,
      [context.userId, `${context.userId}@example.test`],
    );
    await sql(
      `insert into emdo.households(id,name,slug,created_by_user_id) values($1,'CSV report test',$2,$3)`,
      [context.workspaceId, context.workspaceId, context.userId],
    );
    await sql(
      `insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,'owner')`,
      [context.workspaceId, context.userId],
    );
    await sql(
      `insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1,$2,$3,now()+interval '1 day',$4)`,
      [
        context.sessionId,
        context.userId,
        context.sessionId,
        context.workspaceId,
      ],
    );
    bookId = String(
      (
        await repository.createBook(context, 'csv-book', {
          name: 'CSV source book',
          entityName: 'CSV tester',
          entityKind: 'corporation',
          country: 'CA',
          functionalCurrency: 'CAD',
        })
      ).id,
    );
    const evidence = await repository.uploadBookEvidence(
      context,
      bookId,
      'csv-evidence',
      { filename: 'activity.csv', format: 'csv', sourceText },
    );
    evidenceId = String(evidence.id);
    sourceDigest = String(evidence.sourceDigest);
  });
  afterAll(async () => admin.end());

  it('re-extracts the stored source, binds the candidate, and is idempotent', async () => {
    const input = SaveFinanceReportMappingFromSourceSchema.parse({
      evidenceId,
      expectedSourceDigest: sourceDigest,
      proposal,
    });
    const candidate = await repository.saveSourceReportMapping(
      context,
      bookId,
      'csv-source-candidate',
      input,
    );
    expect(candidate).toMatchObject({
      version: 1,
      revision: 1,
      status: 'candidate',
      validationStatus: 'normalized',
      modelProvenance: null,
    });
    expect(
      await repository.saveSourceReportMapping(
        context,
        bookId,
        'csv-source-candidate',
        input,
      ),
    ).toEqual(candidate);
    const stored = (
      await sql(
        `select evidence_id,example from emdo.finance_report_mapping_versions where id=$1`,
        [candidate.id],
      )
    ).rows[0]!;
    expect(String(stored.evidence_id)).toBe(evidenceId);
    expect(stored.example).toMatchObject({
      documentId: evidenceId,
      extractionReview: {
        version: 'reviewed-csv.v1',
        sourceDigest,
      },
      rows: [
        { sourceRow: 2, cells: ['2026-09-13', 'Source item', '27.13', 'CAD'] },
      ],
    });
  });

  it.each([
    ['dd.mm.yyyy', '13.09.2026'],
    ['yyyy/mm/dd', '2026/09/13'],
  ] as const)(
    'persists explicit %s source mapping without changing original dates',
    async (dateFormat, rawDate) => {
      const original = sourceText.replace('2026-09-13', rawDate);
      const evidence = await repository.uploadBookEvidence(
        context,
        bookId,
        randomUUID(),
        {
          filename: 'localized-activity.csv',
          format: 'csv',
          sourceText: original,
        },
      );
      const request = SaveFinanceReportMappingFromSourceSchema.parse({
        evidenceId: evidence.id,
        expectedSourceDigest: evidence.sourceDigest,
        proposal: {
          ...proposal,
          definition: { ...definition, dateFormat, layoutVersion: dateFormat },
        },
      });
      const key = randomUUID();
      const saved = await repository.saveSourceReportMapping(
        context,
        bookId,
        key,
        request,
      );
      expect(saved).toMatchObject({
        status: 'candidate',
        validationStatus: 'normalized',
        modelProvenance: null,
      });
      expect(
        await repository.saveSourceReportMapping(context, bookId, key, request),
      ).toEqual(saved);
      const stored = (
        await sql(
          'select definition,example from emdo.finance_report_mapping_versions where id=$1',
          [saved.id],
        )
      ).rows[0]!;
      expect(stored.definition).toMatchObject({ dateFormat });
      expect(stored.example).toMatchObject({
        rows: [
          { sourceRow: 2, cells: [rawDate, 'Source item', '27.13', 'CAD'] },
        ],
      });
      expect(evidence.sourceDigest).toBe(
        createHash('sha256').update(original).digest('hex'),
      );
    },
  );

  it('rejects a stale digest and caller supplied extracted rows', async () => {
    const base = {
      evidenceId,
      expectedSourceDigest: sourceDigest,
      proposal,
    };
    await expect(
      repository.saveSourceReportMapping(context, bookId, 'csv-stale', {
        ...base,
        expectedSourceDigest: createHash('sha256')
          .update('different')
          .digest('hex'),
      }),
    ).rejects.toThrow('Expected source digest');
    expect(() =>
      repository.saveSourceReportMapping(context, bookId, 'csv-example', {
        ...base,
        example: {},
      }),
    ).toThrow();
  });
});
