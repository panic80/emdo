import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createFinanceImportPlan,
  InMemoryFinanceImportPlanningService,
  previewFinanceImport,
} from './imports.js';

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const common = {
  accountId: 'account-chequing',
  spaceId: 'private-space-1',
  ownerUserId: 'user-1',
  previewedAt: '2026-08-09T14:00:00.000Z',
  existingFingerprints: [],
} as const;

const csvMapping = {
  dateFormat: 'yyyy-mm-dd' as const,
  defaultCategoryId: null,
  columns: {
    postedOn: 'Date',
    description: 'Description',
    amount: 'Amount',
    externalId: 'Reference',
    categoryId: 'Category',
  },
};

const csvSource = [
  'Date,Description,Amount,Reference,Category',
  '2026-08-01,"Market, Toronto",-42.05,fit-1,category-groceries',
  '2026-08-02,Salary,1000.00,fit-2,category-income',
  'not-a-date,SECRET-SOURCE-LINE,1.00,fit-3,category-other',
  '2026-08-01,Duplicate description,-42.05,fit-1,category-groceries',
].join('\n');

const csvInput = () => ({
  ...common,
  format: 'csv',
  sourceText: csvSource,
  sourceHash: sha256(csvSource),
  mapping: csvMapping,
});

const previewCsv = () => previewFinanceImport(csvInput());

describe('CSV import preview', () => {
  it('maps valid rows, isolates rejects, and detects source duplicates', () => {
    const preview = previewCsv();

    expect(preview).toMatchObject({
      status: 'ready',
      format: 'csv',
      summary: { accepted: 2, rejected: 1, duplicates: 1 },
      accepted: [
        {
          recordType: 'transaction',
          postedOn: '2026-08-01',
          description: 'Market, Toronto',
          originalAmountCadMinor: -4_205,
          effectiveAmountCadMinor: -4_205,
          currency: 'CAD',
          source: { kind: 'import', sourceRow: 2, externalId: 'fit-1' },
        },
        {
          postedOn: '2026-08-02',
          originalAmountCadMinor: 100_000,
        },
      ],
      rejected: [
        {
          sourceRow: 4,
          safeError: { code: 'finance-import-row-invalid' },
        },
      ],
      duplicates: [
        {
          sourceRow: 5,
          reason: 'within-source',
        },
      ],
    });
    expect(Object.isFrozen(preview)).toBe(true);
    expect(JSON.stringify(preview)).not.toContain('SECRET-SOURCE-LINE');
    expect(JSON.stringify(preview)).not.toContain(csvSource);
  });

  it('binds preview to the exact source hash and mapped headers', () => {
    expect(
      previewFinanceImport({
        ...common,
        format: 'csv',
        sourceText: csvSource,
        sourceHash: '0'.repeat(64),
        mapping: csvMapping,
      }),
    ).toMatchObject({
      status: 'rejected',
      safeError: { code: 'finance-import-source-hash-mismatch' },
    });

    const badHeaderSource = 'Date,Amount\n2026-08-01,-1.00';
    expect(
      previewFinanceImport({
        ...common,
        format: 'csv',
        sourceText: badHeaderSource,
        sourceHash: sha256(badHeaderSource),
        mapping: csvMapping,
      }),
    ).toMatchObject({
      status: 'rejected',
      safeError: { code: 'finance-import-mapping-invalid' },
    });
  });

  it('uses unambiguous tenant-scoped transaction fingerprints', () => {
    const left = previewFinanceImport({
      ...csvInput(),
      spaceId: 'scope|owner',
      ownerUserId: 'user',
    });
    const right = previewFinanceImport({
      ...csvInput(),
      spaceId: 'scope',
      ownerUserId: 'owner|user',
    });
    if (left.status !== 'ready' || right.status !== 'ready') {
      throw new Error('expected ready previews');
    }
    const leftRecord = left.accepted[0];
    const rightRecord = right.accepted[0];
    if (
      leftRecord?.recordType !== 'transaction' ||
      leftRecord.source.kind !== 'import' ||
      rightRecord?.recordType !== 'transaction' ||
      rightRecord.source.kind !== 'import'
    ) {
      throw new Error('expected imported transactions');
    }

    expect(leftRecord.source.fingerprint).not.toBe(
      rightRecord.source.fingerprint,
    );
  });

  it('maps separate debit and credit columns without decimal-number conversion', () => {
    const debitCreditSource = [
      'Date,Description,Debit,Credit,Reference',
      '2026-08-01,Groceries,12.34,,dc-1',
      '2026-08-02,Refund,,5.67,dc-2',
      '2026-08-03,Ambiguous,1.00,1.00,dc-3',
    ].join('\n');

    expect(
      previewFinanceImport({
        ...common,
        format: 'csv',
        sourceText: debitCreditSource,
        sourceHash: sha256(debitCreditSource),
        mapping: {
          dateFormat: 'yyyy-mm-dd',
          defaultCategoryId: null,
          columns: {
            postedOn: 'Date',
            description: 'Description',
            debit: 'Debit',
            credit: 'Credit',
            externalId: 'Reference',
          },
        },
      }),
    ).toMatchObject({
      status: 'ready',
      summary: { accepted: 2, rejected: 1, duplicates: 0 },
      accepted: [
        { originalAmountCadMinor: -1_234 },
        { originalAmountCadMinor: 567 },
      ],
    });
  });

  it('rejects excessive physical lines without throwing', () => {
    const excessiveLines = `${'\n'.repeat(100_001)}Date,Description,Amount,Reference,Category\nnot-a-date,Bad,1.00,row-1,category-other`;
    let result: ReturnType<typeof previewFinanceImport> | undefined;

    expect(() => {
      result = previewFinanceImport({
        ...common,
        format: 'csv',
        sourceText: excessiveLines,
        sourceHash: sha256(excessiveLines),
        mapping: csvMapping,
      });
    }).not.toThrow();
    expect(result).toMatchObject({
      status: 'rejected',
      safeError: { code: 'finance-import-source-invalid' },
    });
  });
});

describe('OFX import preview', () => {
  const ofxSource = `OFXHEADER:100
DATA:OFXSGML

<OFX>
<CURDEF>CAD
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260803120000[-4:EDT]
<TRNAMT>-15.75
<FITID>ofx-1
<NAME>Cafe
<MEMO>Lunch
</STMTTRN>
<STMTTRN>
<DTPOSTED>20260804
<FITID>ofx-broken
<NAME>Missing amount
</STMTTRN>
</BANKTRANLIST>
</OFX>`;

  it('normalizes standard OFX fields and isolates malformed transactions', () => {
    expect(
      previewFinanceImport({
        ...common,
        format: 'ofx',
        sourceText: ofxSource,
        sourceHash: sha256(ofxSource),
        mapping: { defaultCategoryId: 'category-dining' },
      }),
    ).toMatchObject({
      status: 'ready',
      format: 'ofx',
      summary: { accepted: 1, rejected: 1, duplicates: 0 },
      accepted: [
        {
          postedOn: '2026-08-03',
          description: 'Cafe — Lunch',
          categoryId: 'category-dining',
          originalAmountCadMinor: -1_575,
          source: { sourceRow: 1, externalId: 'ofx-1' },
        },
      ],
      rejected: [
        {
          sourceRow: 2,
          safeError: { code: 'finance-import-row-invalid' },
        },
      ],
    });
  });

  it('rejects an OFX statement that is not explicitly CAD', () => {
    const usd = ofxSource.replace('<CURDEF>CAD', '<CURDEF>USD');
    expect(
      previewFinanceImport({
        ...common,
        format: 'ofx',
        sourceText: usd,
        sourceHash: sha256(usd),
        mapping: { defaultCategoryId: null },
      }),
    ).toMatchObject({
      status: 'rejected',
      safeError: { code: 'finance-import-currency-unsupported' },
    });
  });

  it('rejects a mixed-currency multi-statement OFX file', () => {
    const mixedCurrency = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS><STMTRS><CURDEF>CAD<BANKTRANLIST>
<STMTTRN><DTPOSTED>20260803<TRNAMT>-1.00<FITID>cad-1<NAME>CAD row</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS>
<STMTTRNRS><STMTRS><CURDEF>USD<BANKTRANLIST>
<STMTTRN><DTPOSTED>20260804<TRNAMT>-2.00<FITID>usd-1<NAME>USD row</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

    expect(
      previewFinanceImport({
        ...common,
        format: 'ofx',
        sourceText: mixedCurrency,
        sourceHash: sha256(mixedCurrency),
        mapping: { defaultCategoryId: null },
      }),
    ).toMatchObject({
      status: 'rejected',
      safeError: { code: 'finance-import-currency-unsupported' },
    });
  });

  it('normalizes an offset OFX timestamp to its Toronto calendar date', () => {
    const boundary = `<OFX><CURDEF>CAD<BANKTRANLIST>
<STMTTRN><DTPOSTED>20260901003000[0:GMT]<TRNAMT>-1.00<FITID>boundary-1<NAME>Boundary</STMTTRN>
</BANKTRANLIST></OFX>`;

    expect(
      previewFinanceImport({
        ...common,
        format: 'ofx',
        sourceText: boundary,
        sourceHash: sha256(boundary),
        mapping: { defaultCategoryId: null },
      }),
    ).toMatchObject({
      status: 'ready',
      accepted: [{ postedOn: '2026-08-31' }],
    });
  });

  it('treats a timed OFX value without an offset as GMT', () => {
    const implicitGmt = `<OFX><CURDEF>CAD<BANKTRANLIST>
<STMTTRN><DTPOSTED>20260901003000<TRNAMT>-1.00<FITID>implicit-gmt-1<NAME>Boundary</STMTTRN>
</BANKTRANLIST></OFX>`;

    expect(
      previewFinanceImport({
        ...common,
        format: 'ofx',
        sourceText: implicitGmt,
        sourceHash: sha256(implicitGmt),
        mapping: { defaultCategoryId: null },
      }),
    ).toMatchObject({
      status: 'ready',
      accepted: [{ postedOn: '2026-08-31' }],
    });
  });

  it('isolates OFX timestamps outside the supported twelve-hour offset', () => {
    const invalidOffset = `<OFX><CURDEF>CAD<BANKTRANLIST>
<STMTTRN><DTPOSTED>20260901120000[13:GMT]<TRNAMT>-1.00<FITID>bad-offset-1<NAME>Bad offset</STMTTRN>
</BANKTRANLIST></OFX>`;

    expect(
      previewFinanceImport({
        ...common,
        format: 'ofx',
        sourceText: invalidOffset,
        sourceHash: sha256(invalidOffset),
        mapping: { defaultCategoryId: null },
      }),
    ).toMatchObject({
      status: 'ready',
      summary: { accepted: 0, rejected: 1, duplicates: 0 },
    });
  });

  it('isolates an invalid offset-less OFX clock value', () => {
    const invalidClock = `<OFX><CURDEF>CAD<BANKTRANLIST>
<STMTTRN><DTPOSTED>20260831999999<TRNAMT>-1.00<FITID>bad-time-1<NAME>Bad time</STMTTRN>
</BANKTRANLIST></OFX>`;

    expect(
      previewFinanceImport({
        ...common,
        format: 'ofx',
        sourceText: invalidClock,
        sourceHash: sha256(invalidClock),
        mapping: { defaultCategoryId: null },
      }),
    ).toMatchObject({
      status: 'ready',
      summary: { accepted: 0, rejected: 1, duplicates: 0 },
      rejected: [
        { sourceRow: 1, safeError: { code: 'finance-import-row-invalid' } },
      ],
    });
  });
});

describe('atomic finance import plan and result', () => {
  it('creates a canonical plan from a safe preview without retaining source text', () => {
    const preview = previewCsv();
    if (preview.status !== 'ready') throw new Error('expected preview');

    const result = createFinanceImportPlan({
      planId: 'finance-import-plan-exported',
      idempotencyKey: 'finance-import:2026-08:exported',
      preview,
    });

    expect(result).toMatchObject({
      status: 'planned',
      plan: {
        planId: 'finance-import-plan-exported',
        transactionCount: 2,
        sourceHash: sha256(csvSource),
      },
    });
    expect(JSON.stringify(result)).not.toContain(csvSource);
  });

  it('derives public transaction IDs from the canonical fingerprint for mixed-case Unicode imports', () => {
    const source = [
      'Date,Description,Amount,Reference,Category',
      '2026-08-11,Café ÉLAN,-12.34,unicode-1,',
    ].join('\n');
    const preview = previewFinanceImport({
      ...csvInput(),
      sourceText: source,
      sourceHash: sha256(source),
    });
    if (preview.status !== 'ready') throw new Error('expected preview');
    const result = createFinanceImportPlan({
      planId: 'finance-import-plan-unicode',
      idempotencyKey: 'finance-import:2026-08:unicode',
      preview,
    });
    if (result.status !== 'planned') throw new Error('expected plan');
    const transaction = result.plan.transactions[0];
    if (transaction?.source.kind !== 'import')
      throw new Error('expected import');
    expect(transaction.id).toBe(
      `finance-import-${transaction.source.fingerprint.slice(0, 40)}`,
    );
  });

  it('enforces the shared UTF-8 account and category identifier ceiling', () => {
    const oversized = 'é'.repeat(257);
    const account = previewFinanceImport({
      ...csvInput(),
      accountId: oversized,
    });
    expect(account).toMatchObject({
      status: 'rejected',
      safeError: { code: 'finance-import-input-invalid' },
    });

    const source = [
      'Date,Description,Amount,Reference,Category',
      `2026-08-11,Groceries,-12.34,reference-1,${oversized}`,
    ].join('\n');
    const category = previewFinanceImport({
      ...csvInput(),
      sourceText: source,
      sourceHash: sha256(source),
    });
    expect(category).toMatchObject({
      status: 'ready',
      summary: { accepted: 0, rejected: 1, duplicates: 0 },
    });
  });

  it('commits all normalized transactions once and authorizes source deletion', async () => {
    const service = new InMemoryFinanceImportPlanningService();
    const registered = service.preview(csvInput());
    expect(registered).toMatchObject({
      status: 'ready',
      preview: { summary: { accepted: 2, rejected: 1, duplicates: 1 } },
    });
    if (registered.status !== 'ready') throw new Error('expected preview');
    const planned = service.createPlan({
      planId: 'finance-import-plan-1',
      idempotencyKey: 'finance-import:2026-08:one',
      previewId: registered.previewId,
      sourceHash: registered.preview.sourceHash,
      spaceId: registered.preview.spaceId,
      ownerUserId: registered.preview.ownerUserId,
    });
    expect(planned).toMatchObject({
      status: 'planned',
      plan: {
        transactionCount: 2,
        rejectedRowCount: 1,
        duplicateRowCount: 1,
      },
    });

    if (planned.status !== 'planned') throw new Error('expected plan');
    const committed = await service.commitAtomically({
      planId: planned.plan.planId,
      planHash: planned.plan.planHash,
      spaceId: planned.plan.spaceId,
      ownerUserId: planned.plan.ownerUserId,
    });
    expect(committed).toMatchObject({
      status: 'committed',
      receipt: { verified: true, transactionCount: 2 },
      sourceDeletionAuthorized: true,
    });
    expect(service.listTransactions()).toHaveLength(2);

    expect(
      await service.commitAtomically({
        planId: planned.plan.planId,
        planHash: planned.plan.planHash,
        spaceId: planned.plan.spaceId,
        ownerUserId: planned.plan.ownerUserId,
      }),
    ).toMatchObject({
      status: 'replayed',
      receipt: committed.receipt,
      sourceDeletionAuthorized: true,
    });
  });

  it('reserves completed plan IDs without consuming a conflicting preview', async () => {
    const service = new InMemoryFinanceImportPlanningService();
    const firstPreview = service.preview(csvInput());
    if (firstPreview.status !== 'ready') throw new Error('expected preview');
    const firstPlan = service.createPlan({
      planId: 'finance-import-completed-id',
      idempotencyKey: 'finance-import:completed-id:first',
      previewId: firstPreview.previewId,
      sourceHash: firstPreview.preview.sourceHash,
      spaceId: firstPreview.preview.spaceId,
      ownerUserId: firstPreview.preview.ownerUserId,
    });
    if (firstPlan.status !== 'planned') throw new Error('expected plan');
    await service.commitAtomically({
      planId: firstPlan.plan.planId,
      planHash: firstPlan.plan.planHash,
      spaceId: firstPlan.plan.spaceId,
      ownerUserId: firstPlan.plan.ownerUserId,
    });

    const conflictingSource = csvSource.replaceAll('fit-', 'new-fit-');
    const conflictingPreview = service.preview({
      ...csvInput(),
      sourceText: conflictingSource,
      sourceHash: sha256(conflictingSource),
    });
    if (conflictingPreview.status !== 'ready') {
      throw new Error('expected conflicting preview');
    }
    expect(
      service.createPlan({
        planId: firstPlan.plan.planId,
        idempotencyKey: 'finance-import:completed-id:second',
        previewId: conflictingPreview.previewId,
        sourceHash: conflictingPreview.preview.sourceHash,
        spaceId: conflictingPreview.preview.spaceId,
        ownerUserId: conflictingPreview.preview.ownerUserId,
      }),
    ).toMatchObject({
      status: 'rejected',
      safeError: { code: 'finance-import-plan-id-conflict' },
    });
    expect(service.retentionSnapshot()).toEqual({
      pendingPreviews: 1,
      pendingPlans: 0,
      completedPlans: 1,
      retainedPendingRows: 4,
    });
  });

  it('derives existing duplicate rows from the authoritative repository', async () => {
    const service = new InMemoryFinanceImportPlanningService();
    const registered = service.preview(csvInput());
    if (registered.status !== 'ready') throw new Error('expected preview');
    const planned = service.createPlan({
      planId: 'finance-import-existing-preview',
      idempotencyKey: 'finance-import:existing-preview',
      previewId: registered.previewId,
      sourceHash: registered.preview.sourceHash,
      spaceId: registered.preview.spaceId,
      ownerUserId: registered.preview.ownerUserId,
    });
    if (planned.status !== 'planned') throw new Error('expected plan');
    await service.commitAtomically({
      planId: planned.plan.planId,
      planHash: planned.plan.planHash,
      spaceId: planned.plan.spaceId,
      ownerUserId: planned.plan.ownerUserId,
    });

    const repeated = service.preview({
      ...csvInput(),
      existingFingerprints: [],
    });
    if (repeated.status !== 'ready') throw new Error('expected preview');
    expect(repeated.preview.summary).toEqual({
      accepted: 0,
      rejected: 1,
      duplicates: 3,
    });
    expect(repeated.preview.duplicates).toMatchObject([
      { sourceRow: 2, reason: 'existing' },
      { sourceRow: 3, reason: 'existing' },
      { sourceRow: 5, reason: 'existing' },
    ]);
  });

  it('rejects a duplicate-containing batch without committing its unique rows', async () => {
    const service = new InMemoryFinanceImportPlanningService();
    const firstPreview = service.preview(csvInput());
    if (firstPreview.status !== 'ready') throw new Error('expected preview');
    const first = service.createPlan({
      planId: 'finance-import-plan-1',
      idempotencyKey: 'finance-import:2026-08:one',
      previewId: firstPreview.previewId,
      sourceHash: firstPreview.preview.sourceHash,
      spaceId: firstPreview.preview.spaceId,
      ownerUserId: firstPreview.preview.ownerUserId,
    });
    if (first.status !== 'planned') throw new Error('expected first plan');

    const secondSource = [
      'Date,Description,Amount,Reference,Category',
      '2026-08-05,Unique,-2.00,fit-new,category-other',
      '2026-08-01,Existing,-42.05,fit-1,category-groceries',
    ].join('\n');
    const secondPreview = service.preview({
      ...common,
      format: 'csv',
      sourceText: secondSource,
      sourceHash: sha256(secondSource),
      mapping: csvMapping,
    });
    if (secondPreview.status !== 'ready') throw new Error('expected preview');
    const second = service.createPlan({
      planId: 'finance-import-plan-2',
      idempotencyKey: 'finance-import:2026-08:two',
      previewId: secondPreview.previewId,
      sourceHash: secondPreview.preview.sourceHash,
      spaceId: secondPreview.preview.spaceId,
      ownerUserId: secondPreview.preview.ownerUserId,
    });
    if (second.status !== 'planned') throw new Error('expected second plan');

    await service.commitAtomically({
      planId: first.plan.planId,
      planHash: first.plan.planHash,
      spaceId: first.plan.spaceId,
      ownerUserId: first.plan.ownerUserId,
    });

    expect(
      await service.commitAtomically({
        planId: second.plan.planId,
        planHash: second.plan.planHash,
        spaceId: second.plan.spaceId,
        ownerUserId: second.plan.ownerUserId,
      }),
    ).toMatchObject({
      status: 'rejected',
      sourceDeletionAuthorized: false,
      safeError: { code: 'finance-import-duplicate-at-commit' },
    });
    expect(service.listTransactions()).toHaveLength(2);
    expect(
      service
        .listTransactions()
        .some((transaction) => transaction.description === 'Unique'),
    ).toBe(false);
  });

  it('scopes fingerprints and idempotency keys to the owning space', async () => {
    const service = new InMemoryFinanceImportPlanningService();
    const firstPreview = service.preview(csvInput());
    const secondPreview = service.preview({
      ...common,
      spaceId: 'private-space-2',
      ownerUserId: 'user-2',
      format: 'csv',
      sourceText: csvSource,
      sourceHash: sha256(csvSource),
      mapping: csvMapping,
    });
    if (firstPreview.status !== 'ready' || secondPreview.status !== 'ready') {
      throw new Error('expected tenant-scoped previews');
    }
    const first = service.createPlan({
      planId: 'finance-import-plan-space-1',
      idempotencyKey: 'finance-import:same-client-key',
      previewId: firstPreview.previewId,
      sourceHash: firstPreview.preview.sourceHash,
      spaceId: firstPreview.preview.spaceId,
      ownerUserId: firstPreview.preview.ownerUserId,
    });
    const second = service.createPlan({
      planId: 'finance-import-plan-space-2',
      idempotencyKey: 'finance-import:same-client-key',
      previewId: secondPreview.previewId,
      sourceHash: secondPreview.preview.sourceHash,
      spaceId: secondPreview.preview.spaceId,
      ownerUserId: secondPreview.preview.ownerUserId,
    });
    if (first.status !== 'planned' || second.status !== 'planned') {
      throw new Error('expected tenant-scoped plans');
    }

    expect(
      await service.commitAtomically({
        planId: first.plan.planId,
        planHash: first.plan.planHash,
        spaceId: first.plan.spaceId,
        ownerUserId: first.plan.ownerUserId,
      }),
    ).toMatchObject({ status: 'committed' });
    expect(
      await service.commitAtomically({
        planId: second.plan.planId,
        planHash: second.plan.planHash,
        spaceId: second.plan.spaceId,
        ownerUserId: second.plan.ownerUserId,
      }),
    ).toMatchObject({ status: 'committed' });
    expect(service.listTransactions()).toHaveLength(4);
  });

  it('cannot create or commit from a caller-forged preview or plan', async () => {
    const service = new InMemoryFinanceImportPlanningService();
    const registered = service.preview(csvInput());
    if (registered.status !== 'ready') throw new Error('expected preview');
    const first = registered.preview.accepted[0];
    if (first?.recordType !== 'transaction' || first.source.kind !== 'import') {
      throw new Error('expected imported transaction');
    }
    const forgedPreview = {
      ...registered.preview,
      accepted: [
        {
          ...first,
          id: 'forged-transaction',
          source: { ...first.source, fingerprint: 'f'.repeat(64) },
        },
        ...registered.preview.accepted.slice(1),
      ],
    };

    expect(
      service.createPlan({
        planId: 'finance-import-forged',
        idempotencyKey: 'finance-import:forged-preview',
        previewId: registered.previewId,
        sourceHash: registered.preview.sourceHash,
        spaceId: registered.preview.spaceId,
        ownerUserId: registered.preview.ownerUserId,
        preview: forgedPreview,
      }),
    ).toMatchObject({
      status: 'rejected',
      safeError: { code: 'finance-import-plan-invalid' },
    });

    const planned = service.createPlan({
      planId: 'finance-import-authentic',
      idempotencyKey: 'finance-import:authentic-preview',
      previewId: registered.previewId,
      sourceHash: registered.preview.sourceHash,
      spaceId: registered.preview.spaceId,
      ownerUserId: registered.preview.ownerUserId,
    });
    if (planned.status !== 'planned') throw new Error('expected plan');
    expect(
      await service.commitAtomically({
        planId: planned.plan.planId,
        planHash: 'f'.repeat(64),
        spaceId: planned.plan.spaceId,
        ownerUserId: planned.plan.ownerUserId,
      }),
    ).toMatchObject({
      status: 'rejected',
      sourceDeletionAuthorized: false,
      safeError: { code: 'finance-import-plan-not-found' },
    });
    expect(service.listTransactions()).toHaveLength(0);
  });

  it('consumes large pending payloads and expires compact replay state', async () => {
    let nowMs = Date.parse('2026-08-09T14:00:00.000Z');
    const service = new InMemoryFinanceImportPlanningService(
      () => new Date(nowMs),
    );
    const registered = service.preview(csvInput());
    if (registered.status !== 'ready') throw new Error('expected preview');
    const planned = service.createPlan({
      planId: 'finance-import-retention',
      idempotencyKey: 'finance-import:retention-test',
      previewId: registered.previewId,
      sourceHash: registered.preview.sourceHash,
      spaceId: registered.preview.spaceId,
      ownerUserId: registered.preview.ownerUserId,
    });
    if (planned.status !== 'planned') throw new Error('expected plan');
    await service.commitAtomically({
      planId: planned.plan.planId,
      planHash: planned.plan.planHash,
      spaceId: planned.plan.spaceId,
      ownerUserId: planned.plan.ownerUserId,
    });

    expect(service.retentionSnapshot()).toEqual({
      pendingPreviews: 0,
      pendingPlans: 0,
      completedPlans: 1,
      retainedPendingRows: 0,
    });

    nowMs += 31 * 60 * 1_000;
    expect(service.preview(csvInput())).toMatchObject({ status: 'ready' });
    expect(service.retentionSnapshot()).toEqual({
      pendingPreviews: 1,
      pendingPlans: 0,
      completedPlans: 0,
      retainedPendingRows: 4,
    });
  });

  it('applies pending-import quotas per owning space', () => {
    const service = new InMemoryFinanceImportPlanningService();
    const register = (index: number, spaceId: string = common.spaceId) => {
      const source = [
        'Date,Description,Amount,Reference,Category',
        `2026-08-01,Item ${index},-1.00,quota-${index},category-other`,
      ].join('\n');
      return service.preview({
        ...common,
        spaceId,
        sourceText: source,
        sourceHash: sha256(source),
        format: 'csv',
        mapping: csvMapping,
      });
    };

    for (let index = 0; index < 4; index += 1) {
      expect(register(index)).toMatchObject({ status: 'ready' });
    }
    expect(register(4)).toMatchObject({
      status: 'rejected',
      safeError: { code: 'finance-import-preview-capacity-reached' },
    });
    expect(register(5, 'private-space-2')).toMatchObject({ status: 'ready' });
  });

  it("rejects new row pressure without evicting another space's live plan", async () => {
    const service = new InMemoryFinanceImportPlanningService(
      () => new Date('2026-08-09T14:00:00.000Z'),
      {
        maxPendingImportsPerScope: 4,
        maxPendingRowsPerScope: 8,
        maxRetainedPendingRows: 8,
      },
    );
    const victimPreview = service.preview(csvInput());
    if (victimPreview.status !== 'ready') throw new Error('expected preview');
    const victimPlan = service.createPlan({
      planId: 'finance-import-victim-plan',
      idempotencyKey: 'finance-import:victim-plan',
      previewId: victimPreview.previewId,
      sourceHash: victimPreview.preview.sourceHash,
      spaceId: victimPreview.preview.spaceId,
      ownerUserId: victimPreview.preview.ownerUserId,
    });
    if (victimPlan.status !== 'planned') throw new Error('expected plan');

    const competingInput = (index: number) => {
      const sourceText = csvSource.replaceAll('fit-', `competing-${index}-`);
      return {
        ...csvInput(),
        spaceId: 'private-space-2',
        ownerUserId: 'user-2',
        sourceText,
        sourceHash: sha256(sourceText),
      };
    };
    expect(service.preview(competingInput(1))).toMatchObject({
      status: 'ready',
    });
    expect(service.preview(competingInput(2))).toMatchObject({
      status: 'rejected',
      safeError: { code: 'finance-import-preview-capacity-reached' },
    });

    expect(
      await service.commitAtomically({
        planId: victimPlan.plan.planId,
        planHash: victimPlan.plan.planHash,
        spaceId: victimPlan.plan.spaceId,
        ownerUserId: victimPlan.plan.ownerUserId,
      }),
    ).toMatchObject({ status: 'committed' });
  });

  it('plans and commits a large authoritative preview within row limits', async () => {
    const largeSource = [
      'Date,Description,Amount,Reference,Category',
      ...Array.from(
        { length: 4_000 },
        (_, index) =>
          `2026-08-01,Item ${index},-1.00,large-${index},category-other`,
      ),
    ].join('\n');
    const service = new InMemoryFinanceImportPlanningService();
    const registered = service.preview({
      ...csvInput(),
      sourceText: largeSource,
      sourceHash: sha256(largeSource),
    });
    if (registered.status !== 'ready') throw new Error('expected preview');
    expect(registered.preview.summary.accepted).toBe(4_000);

    const planned = service.createPlan({
      planId: 'finance-import-large-plan',
      idempotencyKey: 'finance-import:large-plan',
      previewId: registered.previewId,
      sourceHash: registered.preview.sourceHash,
      spaceId: registered.preview.spaceId,
      ownerUserId: registered.preview.ownerUserId,
    });
    if (planned.status !== 'planned') throw new Error('expected plan');
    expect(
      await service.commitAtomically({
        planId: planned.plan.planId,
        planHash: planned.plan.planHash,
        spaceId: planned.plan.spaceId,
        ownerUserId: planned.plan.ownerUserId,
      }),
    ).toMatchObject({ status: 'committed' });
  });

  it('fails closed for cyclic import input without invoking accessors', () => {
    const cyclic: Record<string, unknown> = {
      ...common,
      format: 'csv',
      sourceText: csvSource,
      sourceHash: sha256(csvSource),
      mapping: csvMapping,
    };
    cyclic.self = cyclic;
    expect(previewFinanceImport(cyclic)).toMatchObject({
      status: 'rejected',
      safeError: { code: 'finance-import-input-invalid' },
    });

    let accessed = false;
    const accessor = { ...cyclic };
    delete accessor.self;
    Object.defineProperty(accessor, 'sourceText', {
      enumerable: true,
      get() {
        accessed = true;
        return csvSource;
      },
    });
    expect(previewFinanceImport(accessor)).toMatchObject({
      status: 'rejected',
    });
    expect(accessed).toBe(false);
  });
});
