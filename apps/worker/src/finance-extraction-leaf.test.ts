import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FinanceAutomationRunSchema } from '@emdo/contracts';
import { FinanceExtractionNotAppliedError } from '@emdo/db/worker';
import { createFinanceExtractionLeaf } from './finance-extraction-leaf.js';
const hash = (v: string | Uint8Array) =>
  createHash('sha256').update(v).digest('hex');
function fixture() {
  const bytes = Buffer.from('Date,Amount\n2026-09-15,123.45\n'),
    evidenceId = randomUUID();
  const extraction = {
    schemaVersion: 1 as const,
    evidenceId,
    expectedSourceDigest: hash(bytes),
    standardizationRunId: randomUUID(),
    expectedRunRevision: 1,
    expectedExtractionRevision: 0,
  };
  const run = FinanceAutomationRunSchema.parse({
    request: {
      operationId: randomUUID(),
      grantId: randomUUID(),
      grantRevision: 1,
      workspaceId: randomUUID(),
      bookId: randomUUID(),
      capability: 'finance.documents.extract',
      requestHash: 'a'.repeat(64),
      itemCount: 1,
      currency: 'CAD',
      amount: '0',
      extraction,
    },
    revision: 2,
    attempts: 1,
    status: 'executing',
    outcomeReference: null,
  });
  const input = {
    run,
    targets: [evidenceId],
    leaseToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    signal: new AbortController().signal,
  };
  const store = {
    read: vi.fn(async () => ({
      format: 'csv',
      bytes,
      summary: null as unknown,
      envelope: null as unknown,
    })),
    save: vi.fn(async (input: unknown) => {
      expect(input).toBeDefined();
      return { resultId: run.request.operationId };
    }),
  };
  return { input, store, bytes };
}
describe('deterministic extraction automation leaf', () => {
  it('saves complete bounded canonical observations without model or posting', async () => {
    const f = fixture(),
      leaf = createFinanceExtractionLeaf(f.store as never, {});
    expect(await leaf.execute(f.input)).toEqual({
      application: 'applied',
      outcomeReference: f.input.run.request.operationId,
    });
    expect(f.store.save).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 2,
        leaseToken: f.input.leaseToken,
        envelope: expect.objectContaining({
          kind: 'csv-table',
          complete: false,
          documentInstructions: 'untrusted-source-data',
        }),
      }),
    );
  });
  it('reuses verified saved image observations without native OCR dependency', async () => {
    const f = fixture();
    const facts = {
      status: 'no-text',
      qualityStatus: 'unreadable',
      sourceDigest: hash(f.bytes),
      format: 'png',
      width: 100,
      height: 100,
      coordinateSpace: 'image-pixels-top-left',
      engine: {
        id: 'tesseract',
        version: 'fixture',
        languages: ['eng'],
        trainedData: [{ language: 'eng', sha256: 'b'.repeat(64) }],
      },
      text: '',
      words: [],
      issues: [],
      truncated: false,
      textBasis: 'machine-transcription-requires-review',
    };
    const factsJson = JSON.stringify(facts),
      common = {
        revision: 1,
        adapterId: 'finance.image-ocr',
        adapterVersion: '1',
        sourceDigest: hash(f.bytes),
        extractionDigest: hash(factsJson),
      };
    const envelope = {
      ...common,
      kind: 'image-ocr',
      factsJson,
      issues: [],
      complete: false,
      documentInstructions: 'untrusted-source-data',
    };
    const summary = {
      ...common,
      status: 'needs-source-review',
      tableCount: 0,
      sheetCount: 0,
      pageCount: 1,
      truncated: false,
      issues: [],
    };
    f.input.run.request.extraction!.expectedExtractionRevision = 1;
    f.store.read.mockResolvedValue({
      format: 'png',
      bytes: f.bytes,
      summary,
      envelope,
    });
    expect(
      await createFinanceExtractionLeaf(f.store as never, {}).execute(f.input),
    ).toMatchObject({ application: 'applied' });
    expect(f.store.save.mock.calls[0]?.[0]).toMatchObject({ envelope });
  });
  it('does not save fresh images without isolated OCR and distinguishes confirmed denial from unknown writes', async () => {
    const f = fixture();
    f.store.read.mockResolvedValue({
      format: 'png',
      bytes: f.bytes,
      summary: null,
      envelope: null,
    });
    expect(
      await createFinanceExtractionLeaf(f.store as never, {}).execute(f.input),
    ).toEqual({
      application: 'blocked',
      reason: 'finance-extraction-ocr-unavailable',
    });
    expect(f.store.save).not.toHaveBeenCalled();
    f.store.read.mockRejectedValue(
      new FinanceExtractionNotAppliedError('revoked'),
    );
    expect(
      await createFinanceExtractionLeaf(f.store as never, {}).execute(f.input),
    ).toEqual({ application: 'not-applied' });
    const other = fixture();
    other.store.save.mockRejectedValue(new Error('connection-lost'));
    expect(
      await createFinanceExtractionLeaf(other.store as never, {}).execute(
        other.input,
      ),
    ).toEqual({ application: 'indeterminate' });
  });
  it.each([
    'extraction-source-binding',
    'extraction-original-integrity',
    'extraction-integrity',
    'extraction-image-binding',
    'extraction-not-applied',
  ])(
    'blocks known permanent rejection %s without copying exception text',
    async (message) => {
      const f = fixture();
      f.store.read.mockRejectedValue(
        new FinanceExtractionNotAppliedError(message),
      );
      expect(
        await createFinanceExtractionLeaf(f.store as never, {}).execute(
          f.input,
        ),
      ).toEqual({
        application: 'blocked',
        reason:
          message === 'extraction-not-applied'
            ? 'finance-extraction-source-or-authority-invalid'
            : 'finance-extraction-source-invalid',
      });
      expect(f.store.save).not.toHaveBeenCalled();
    },
  );
  it('blocks malformed intent and wrong targets before reading any source', async () => {
    const f = fixture();
    const originalTargets = f.input.targets;
    f.input.targets = [randomUUID()];
    expect(
      await createFinanceExtractionLeaf(f.store as never, {}).execute(f.input),
    ).toEqual({
      application: 'blocked',
      reason: 'finance-extraction-invalid-intent',
    });
    f.input.targets = originalTargets;
    f.input.run.request.extraction!.expectedSourceDigest = 'invalid';
    expect(
      await createFinanceExtractionLeaf(f.store as never, {}).execute(f.input),
    ).toEqual({
      application: 'blocked',
      reason: 'finance-extraction-invalid-intent',
    });
    expect(f.store.read).not.toHaveBeenCalled();
  });
  it('keeps abort and transient reads retryable without leaking their messages', async () => {
    const f = fixture();
    f.store.read.mockRejectedValue(
      new Error('private source contents network timeout'),
    );
    expect(
      await createFinanceExtractionLeaf(f.store as never, {}).execute(f.input),
    ).toEqual({ application: 'not-applied' });
    f.store.read.mockClear();
    f.input.signal = AbortSignal.abort();
    expect(
      await createFinanceExtractionLeaf(f.store as never, {}).execute(f.input),
    ).toEqual({ application: 'not-applied' });
    expect(f.store.read).not.toHaveBeenCalled();
  });
  it('blocks mismatched original bytes before extraction and saving', async () => {
    const f = fixture();
    f.store.read.mockResolvedValue({
      format: 'csv',
      bytes: Buffer.from('changed'),
      summary: null,
      envelope: null,
    });
    expect(
      await createFinanceExtractionLeaf(f.store as never, {}).execute(f.input),
    ).toEqual({
      application: 'blocked',
      reason: 'finance-extraction-source-invalid',
    });
    expect(f.store.save).not.toHaveBeenCalled();
  });
  it('blocks confirmed save rejection but preserves uncertain save outcomes', async () => {
    const f = fixture();
    f.store.save.mockRejectedValue(
      new FinanceExtractionNotAppliedError('extraction-not-applied'),
    );
    expect(
      await createFinanceExtractionLeaf(f.store as never, {}).execute(f.input),
    ).toEqual({
      application: 'blocked',
      reason: 'finance-extraction-source-or-authority-invalid',
    });
    f.store.save.mockRejectedValue(new Error('unknown acknowledgement'));
    expect(
      await createFinanceExtractionLeaf(f.store as never, {}).execute(f.input),
    ).toEqual({ application: 'indeterminate' });
  });
});
