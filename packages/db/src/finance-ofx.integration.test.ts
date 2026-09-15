import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkspaceContext } from '@emdo/contracts';
import {
  EncryptedFinanceBookEvidenceSchema,
  FinanceBookEvidenceCrypto,
} from '../../integrations/src/finance-documents/book-evidence-crypto.js';
import { extractFinanceOfxStatement } from '../../integrations/src/finance-documents/ofx-statement-extraction.js';
import { InMemoryVaultKeyProvider } from '../../integrations/src/vault/crypto.js';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';

const url = process.env.FINANCE_V2_TEST_DATABASE_URL;
type DbRow = Record<string, unknown>;
type OfxField = { tag: string; value?: string };
type OfxSourceFacts = {
  ofxSource: {
    sourceDigest: string;
    rawFitid: string | null;
    identityVersion: string;
    statementCurrency: string | null;
    scopedFitid: string | null;
    statementFields: OfxField[];
    fields: OfxField[];
  };
};

describe.skipIf(!url)('native OFX/QFX import on restricted PostgreSQL', () => {
  const admin = new pg.Pool({ connectionString: url });
  const login = `ofx_${randomUUID().replaceAll('-', '')}`;
  let app: pg.Pool;
  const pool = {
    async connect() {
      const client = await app.connect();
      await client.query('set role emdo_app');
      return client;
    },
  };
  const cipher = new FinanceBookEvidenceCrypto(
    new InMemoryVaultKeyProvider(
      new Uint8Array(32).fill(31),
      'finance-documents.v1',
    ),
  );
  const repository = new PostgresFinanceV2Repository(pool, {
    evidenceCipher: {
      encrypt: (value, scope) => cipher.encrypt(value, scope),
      decrypt: (value, scope) =>
        cipher.decrypt(EncryptedFinanceBookEvidenceSchema.parse(value), scope),
    },
    ofxStatementExtractor: extractFinanceOfxStatement,
  });
  const context: WorkspaceContext = {
    workspaceId: randomUUID(),
    userId: randomUUID(),
    sessionId: randomUUID(),
    requestId: randomUUID(),
  };
  let bookId: string;
  let financialAccountId: string;
  let secondFinancialAccountId: string;
  let cashLedgerId: string;
  let secondCashLedgerId: string;
  let counterAccountId: string;

  async function sql(text: string, values: unknown[] = []) {
    const client = await admin.connect();
    try {
      await client.query('reset role');
      return await client.query(text, values);
    } finally {
      client.release();
    }
  }

  const report = (input: {
    account: string;
    fitid: string;
    amount?: string;
    description?: string;
    currency?: string;
  }) => {
    const currency = input.currency ?? 'CAD';
    return `<OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><STMTRS><CURDEF>${currency}</CURDEF><BANKACCTFROM><BANKID>001</BANKID><BRANCHID>009</BRANCHID><ACCTID>${input.account}</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>20260301</DTSTART><DTEND>20260331</DTEND><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260308003000[-5:EST]</DTPOSTED><TRNAMT>${input.amount ?? '-12.50'}</TRNAMT><FITID>${input.fitid}</FITID><NAME>${input.description ?? 'Imported service'}</NAME><MEMO>Source memo</MEMO></STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>100.25</BALAMT><DTASOF>20260331120000[-5:EST]</DTASOF></LEDGERBAL><AVAILBAL><BALAMT>95.25</BALAMT><DTASOF>20260331120000[-5:EST]</DTASOF></AVAILBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  };

  const qfxReport = (input: Parameters<typeof report>[0]) =>
    `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\n\n${report(
      input,
    ).replace(
      /<\/(?:CODE|SEVERITY|CURDEF|BANKID|BRANCHID|ACCTID|ACCTTYPE|DTSTART|DTEND|TRNTYPE|DTPOSTED|TRNAMT|FITID|NAME|MEMO|BALAMT|DTASOF)>/gu,
      '\n',
    )}`;

  const uploadInput = (
    sourceText: string,
    input: {
      financialAccountId?: string;
      filename?: string;
      format?: 'ofx' | 'qfx';
    } = {},
  ) => ({
    financialAccountId: input.financialAccountId ?? financialAccountId,
    filename: input.filename ?? 'statement.ofx',
    format: input.format ?? ('ofx' as const),
    sourceText,
  });

  async function sourceRow(batchId: string) {
    const review = await repository.getNormalizedImport(
      context,
      bookId,
      batchId,
    );
    const row = review.rows[0];
    if (!row) throw new Error('OFX acceptance row missing');
    return { review, row: row as DbRow };
  }

  async function reviewPost(
    batchId: string,
    rowId: string,
    key: string,
    expectedRevision = 1,
    extra: Record<string, unknown> = {},
  ) {
    return repository.reviewNormalizedImportRow(context, bookId, rowId, key, {
      expectedRevision,
      action: 'post',
      counterAccountId,
      reason: 'Reviewed native OFX source facts',
      ...extra,
    });
  }

  beforeAll(async () => {
    await admin.query(
      `create role "${login}" login nosuperuser nobypassrls noinherit`,
    );
    await admin.query(`grant emdo_app to "${login}"`);
    const connection = new URL(url!);
    connection.username = login;
    app = new pg.Pool({ connectionString: connection.toString() });
    const probe = await pool.connect();
    try {
      expect(
        (
          await probe.query(
            "select current_user='emdo_app' and not rolsuper and not rolbypassrls as restricted from pg_roles where rolname=current_user",
          )
        ).rows[0].restricted,
      ).toBe(true);
    } finally {
      probe.release();
    }

    await sql(
      `insert into emdo.auth_users(id,name,email,email_verified) values($1,'OFX acceptance owner',$2,true)`,
      [context.userId, `${context.userId}@example.test`],
    );
    await sql(
      `insert into emdo.households(id,name,slug,created_by_user_id) values($1,'OFX acceptance',$2,$3)`,
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
        await repository.createBook(context, 'ofx-book', {
          name: 'OFX acceptance book',
          entityName: 'OFX acceptance owner',
          entityKind: 'corporation',
          country: 'CA',
          functionalCurrency: 'CAD',
        })
      ).id,
    );
    cashLedgerId = String(
      (
        await repository.createAccount(context, bookId, 'ofx-cash', {
          code: '1000',
          name: 'OFX cash',
          kind: 'asset',
        })
      ).id,
    );
    secondCashLedgerId = String(
      (
        await repository.createAccount(context, bookId, 'ofx-cash-2', {
          code: '1010',
          name: 'OFX cash second source account',
          kind: 'asset',
        })
      ).id,
    );
    counterAccountId = String(
      (
        await repository.createAccount(context, bookId, 'ofx-expense', {
          code: '6000',
          name: 'OFX expense',
          kind: 'expense',
        })
      ).id,
    );
    await repository.createPeriod(context, bookId, 'ofx-period', {
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
    });
    financialAccountId = String(
      (
        await repository.createFinancialAccount(
          context,
          bookId,
          'ofx-financial-account',
          {
            name: 'Bank source account 123',
            kind: 'bank',
            currency: 'CAD',
            ledgerAccountId: cashLedgerId,
          },
        )
      ).id,
    );
    secondFinancialAccountId = String(
      (
        await repository.createFinancialAccount(
          context,
          bookId,
          'ofx-financial-account-2',
          {
            name: 'Bank source account 456',
            kind: 'bank',
            currency: 'CAD',
            ledgerAccountId: secondCashLedgerId,
          },
        )
      ).id,
    );
  });

  afterAll(async () => {
    await app?.end();
    await admin.query(`drop role if exists "${login}"`);
    await admin.end();
  });

  it('uploads original bytes, preserves native facts, reviews, and commits exactly once', async () => {
    const sourceText = report({ account: '123', fitid: 'ofx-accept-1' });
    const sourceSha = createHash('sha256')
      .update(new TextEncoder().encode(sourceText))
      .digest('hex');
    const upload = await repository.uploadNormalizedStatement(
      context,
      bookId,
      'ofx-upload',
      uploadInput(sourceText),
    );
    expect(
      await repository.uploadNormalizedStatement(
        context,
        bookId,
        'ofx-upload',
        uploadInput(sourceText),
      ),
    ).toEqual(upload);
    expect(
      (
        await sql(
          `select count(*)::int as count from emdo.finance_book_evidence where workspace_id=$1 and book_id=$2 and plaintext_sha256=$3`,
          [context.workspaceId, bookId, sourceSha],
        )
      ).rows[0]!.count,
    ).toBe(1);
    expect(
      (
        await sql(
          `select plaintext_sha256,byte_size from emdo.finance_book_evidence where id=$1`,
          [upload.evidenceId],
        )
      ).rows[0],
    ).toMatchObject({
      plaintext_sha256: sourceSha,
      byte_size: new TextEncoder().encode(sourceText).byteLength,
    });
    expect(
      (
        await repository.downloadBookEvidence(
          context,
          bookId,
          String(upload.evidenceId),
        )
      ).sourceText,
    ).toBe(sourceText);

    const { row } = await sourceRow(String(upload.id));
    const facts = row.source_facts as OfxSourceFacts;
    expect(facts.ofxSource).toMatchObject({
      sourceDigest: sourceSha,
      rawFitid: 'ofx-accept-1',
      identityVersion: 'ofx-fitid-scope.v1',
      statementCurrency: 'CAD',
    });
    expect(facts.ofxSource.scopedFitid).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      facts.ofxSource.statementFields.find((field) => field.tag === 'BALAMT')
        ?.value,
    ).toBe('100.25');
    expect(facts).not.toHaveProperty('openingBalance');
    expect(facts).not.toHaveProperty('fxRate');
    expect(
      facts.ofxSource.fields.some((field) => field.tag === 'CURRATE'),
    ).toBe(false);

    await reviewPost(String(upload.id), String(row.id), 'ofx-review');
    const committed = await repository.commitNormalizedImport(
      context,
      bookId,
      String(upload.id),
      'ofx-commit',
      { expectedRevision: 2 },
    );
    expect(committed).toMatchObject({ posted: 1, matched: 0, revision: 3 });
    expect(
      await repository.commitNormalizedImport(
        context,
        bookId,
        String(upload.id),
        'ofx-commit',
        { expectedRevision: 2 },
      ),
    ).toEqual(committed);
    const transaction = (
      await sql(
        `select native_amount::text,functional_amount::text,fx_rate::text,fx_source,external_id from emdo.finance_economic_transactions where financial_account_id=$1`,
        [financialAccountId],
      )
    ).rows[0];
    expect(transaction).toMatchObject({
      native_amount: '-12.500000000000',
      functional_amount: '-12.500000000000',
      fx_rate: '1.000000000000',
      fx_source: 'identity',
      external_id: expect.stringMatching(/^ofx\.v1:[a-f0-9]{64}$/u),
    });
  });

  it('deduplicates a repeated QFX report and keeps FITID scoped to the source account', async () => {
    const repeated = qfxReport({ account: '123', fitid: 'ofx-accept-1' });
    const duplicate = await repository.uploadNormalizedStatement(
      context,
      bookId,
      'ofx-qfx-repeat',
      uploadInput(repeated, { format: 'qfx', filename: 'statement.qfx' }),
    );
    const duplicateRow = (await sourceRow(String(duplicate.id))).row;
    await reviewPost(
      String(duplicate.id),
      String(duplicateRow.id),
      'ofx-qfx-repeat-review',
    );
    expect(
      await repository.commitNormalizedImport(
        context,
        bookId,
        String(duplicate.id),
        'ofx-qfx-repeat-commit',
        { expectedRevision: 2 },
      ),
    ).toMatchObject({ posted: 0, matched: 1 });
    expect(
      (
        await sql(
          `select count(*)::int as count from emdo.finance_economic_transactions where financial_account_id=$1`,
          [financialAccountId],
        )
      ).rows[0]!.count,
    ).toBe(1);

    const otherSource = await repository.uploadNormalizedStatement(
      context,
      bookId,
      'ofx-other-account',
      uploadInput(report({ account: '456', fitid: 'ofx-accept-1' }), {
        financialAccountId: secondFinancialAccountId,
        filename: 'other-account.ofx',
      }),
    );
    const otherRow = (await sourceRow(String(otherSource.id))).row;
    const firstFacts = (
      (await sourceRow(String(duplicate.id))).row.source_facts as OfxSourceFacts
    ).ofxSource;
    const secondFacts = (otherRow.source_facts as OfxSourceFacts).ofxSource;
    expect(secondFacts.rawFitid).toBe(firstFacts.rawFitid);
    expect(secondFacts.scopedFitid).not.toBe(firstFacts.scopedFitid);
    expect(otherRow.external_id).not.toBe(duplicateRow.external_id);
    await reviewPost(
      String(otherSource.id),
      String(otherRow.id),
      'ofx-other-account-review',
    );
    expect(
      await repository.commitNormalizedImport(
        context,
        bookId,
        String(otherSource.id),
        'ofx-other-account-commit',
        { expectedRevision: 2 },
      ),
    ).toMatchObject({ posted: 1, matched: 0 });
    expect(
      (
        await sql(
          `select count(*)::int as count from emdo.finance_economic_transactions where external_id like 'ofx.v1:%'`,
        )
      ).rows[0]!.count,
    ).toBe(2);
  });

  it('detects overlapping similar source facts and permits only explicit journal matching', async () => {
    const existingJournalId = (
      await sql(
        `select journal_id from emdo.finance_economic_transactions where financial_account_id=$1 order by created_at limit 1`,
        [financialAccountId],
      )
    ).rows[0]!.journal_id as string;
    const overlap = await repository.uploadNormalizedStatement(
      context,
      bookId,
      'ofx-overlap',
      uploadInput(report({ account: '123', fitid: 'overlap-different-fitid' })),
    );
    const overlapRow = (await sourceRow(String(overlap.id))).row;
    await reviewPost(
      String(overlap.id),
      String(overlapRow.id),
      'ofx-overlap-review',
    );
    await expect(
      repository.commitNormalizedImport(
        context,
        bookId,
        String(overlap.id),
        'ofx-overlap-commit',
        { expectedRevision: 2 },
      ),
    ).rejects.toThrow('possible-duplicate');
    await repository.reviewNormalizedImportRow(
      context,
      bookId,
      String(overlapRow.id),
      'ofx-overlap-match',
      {
        expectedRevision: 2,
        action: 'match',
        matchJournalId: existingJournalId,
        reason: 'Confirmed overlapping statement evidence for this journal',
      },
    );
    expect(
      await repository.commitNormalizedImport(
        context,
        bookId,
        String(overlap.id),
        'ofx-overlap-match-commit',
        { expectedRevision: 3 },
      ),
    ).toMatchObject({ posted: 0, matched: 1 });
  });

  it('requires an explicit match for a legacy raw FITID collision', async () => {
    const legacy = await repository.uploadNormalizedStatement(
      context,
      bookId,
      'ofx-legacy-csv',
      {
        financialAccountId,
        filename: 'legacy.csv',
        format: 'csv',
        sourceText:
          'Date,Description,Amount,ID\n2026-03-08,Legacy service,-12.50,legacy-fitid',
        mapping: {
          dateFormat: 'yyyy-mm-dd',
          columns: {
            date: 'Date',
            description: 'Description',
            amount: 'Amount',
            externalId: 'ID',
          },
        },
      },
    );
    const legacyRow = (await sourceRow(String(legacy.id))).row;
    await reviewPost(
      String(legacy.id),
      String(legacyRow.id),
      'ofx-legacy-csv-review',
    );
    await repository.commitNormalizedImport(
      context,
      bookId,
      String(legacy.id),
      'ofx-legacy-csv-commit',
      { expectedRevision: 2 },
    );
    const legacyJournalId = (
      await sql(
        `select journal_id from emdo.finance_economic_transactions where financial_account_id=$1 and external_id=$2`,
        [financialAccountId, 'legacy-fitid'],
      )
    ).rows[0]!.journal_id as string;

    const ofx = await repository.uploadNormalizedStatement(
      context,
      bookId,
      'ofx-legacy-collision',
      uploadInput(
        report({
          account: '123',
          fitid: 'legacy-fitid',
          description: 'Legacy service',
        }),
      ),
    );
    const ofxRow = (await sourceRow(String(ofx.id))).row;
    await reviewPost(
      String(ofx.id),
      String(ofxRow.id),
      'ofx-legacy-collision-review',
    );
    await expect(
      repository.commitNormalizedImport(
        context,
        bookId,
        String(ofx.id),
        'ofx-legacy-collision-commit',
        { expectedRevision: 2 },
      ),
    ).rejects.toThrow('legacy-identity-match-required');
    await repository.reviewNormalizedImportRow(
      context,
      bookId,
      String(ofxRow.id),
      'ofx-legacy-collision-match',
      {
        expectedRevision: 2,
        action: 'match',
        matchJournalId: legacyJournalId,
        reason: 'Confirmed this OFX FITID is the historical raw-ID movement',
      },
    );
    expect(
      await repository.commitNormalizedImport(
        context,
        bookId,
        String(ofx.id),
        'ofx-legacy-collision-match-commit',
        { expectedRevision: 3 },
      ),
    ).toMatchObject({ posted: 0, matched: 1 });
    expect(
      (
        await sql(
          `select count(*)::int as count from emdo.finance_economic_transactions where financial_account_id=$1 and external_id='legacy-fitid'`,
          [financialAccountId],
        )
      ).rows[0]!.count,
    ).toBe(1);
  });

  it('blocks source currency mismatch without inventing FX conversion', async () => {
    const mismatched = await repository.uploadNormalizedStatement(
      context,
      bookId,
      'ofx-currency-mismatch',
      uploadInput(
        report({
          account: '123',
          fitid: 'ofx-usd-1',
          currency: 'USD',
        }),
      ),
    );
    const row = (await sourceRow(String(mismatched.id))).row;
    expect(row.status).toBe('invalid');
    expect(row.issues).toContain('source-account-currency-mismatch');
    expect(
      (row.source_facts as OfxSourceFacts).ofxSource.statementCurrency,
    ).toBe('USD');
    expect(row.fx_rate).toBeNull();
    expect(row.fx_source).toBeNull();
    await expect(
      repository.reviewNormalizedImportRow(
        context,
        bookId,
        String(row.id),
        'ofx-currency-mismatch-review',
        {
          expectedRevision: 1,
          action: 'post',
          counterAccountId,
          reason: 'Attempting to post a source currency mismatch',
        },
      ),
    ).rejects.toThrow('source-review-required');
  });
});
