import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';
import type { DatabasePool } from './scoped-repository.js';
const id = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70';
const context = { workspaceId: id, userId: id, sessionId: id, requestId: id };
const selection = { standardizationRunId: id, extractionRevision: 1 };
function fixture() {
  let allowed = true;
  const factsJson = '{}';
  const saved = {
    factsJson,
    sourceDigest: 'a'.repeat(64),
    extractionDigest: createHash('sha256').update(factsJson).digest('hex'),
  };
  const inventory = {
    sourceDigest: saved.sourceDigest,
    pageCount: 1,
    complete: false as const,
    pages: [
      {
        kind: 'unresolved' as const,
        pageNumber: 1,
        reason: 'render-failed' as const,
      },
    ],
  };
  const verifier = vi.fn(() => ({ inventory }));
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('lock_active_request_scope'))
      return { rows: [{ authorized: true }] };
    if (sql.includes('lock_finance_book_grant')) return { rows: [{ allowed }] };
    if (sql.includes('select b.*,g.role'))
      return { rows: [{ role: 'viewer' }] };
    if (sql.includes('read_finance_pdf_ocr_extraction'))
      return { rows: [{ value: saved }] };
    return { rows: [] };
  });
  const release = vi.fn();
  const pool = {
    connect: async () => ({ query, release }),
  } as unknown as DatabasePool;
  const repository = new PostgresFinanceV2Repository(pool, {
    pdfOcrEvidenceVerifier: verifier,
  });
  return {
    repository,
    query,
    saved,
    verifier,
    inventory,
    revoke: () => {
      allowed = false;
    },
    pool,
  };
}
describe('saved PDF OCR inspection repository', () => {
  it('uses current book authority and exact saved extraction binding', async () => {
    const f = fixture();
    expect(
      await f.repository.readPdfOcrInspection(context, id, id, selection),
    ).toMatchObject({ evidenceId: id, ...selection, inventory: f.inventory });
    expect(f.query).toHaveBeenCalledWith(
      'select emdo.read_finance_pdf_ocr_extraction($1,$2,$3,$4,$5) as value',
      [id, id, id, id, 1],
    );
    expect(f.verifier).toHaveBeenCalledWith({
      factsJson: f.saved.factsJson,
      expectedExtractionDigest: f.saved.extractionDigest,
      expectedSourceDigest: f.saved.sourceDigest,
    });
    f.revoke();
    await expect(
      f.repository.readPdfOcrInspection(context, id, id, selection),
    ).rejects.toThrow('forbidden');
    expect(f.verifier).toHaveBeenCalledTimes(1);
  });
  it('rejects tampered saved digest before verifier and missing verifier', async () => {
    const f = fixture();
    f.saved.factsJson = '{"altered":true}';
    await expect(
      f.repository.readPdfOcrInspection(context, id, id, selection),
    ).rejects.toThrow('integrity');
    expect(f.verifier).not.toHaveBeenCalled();
    await expect(
      new PostgresFinanceV2Repository(f.pool, {}).readPdfOcrInspection(
        context,
        id,
        id,
        selection,
      ),
    ).rejects.toThrow('verifier-unavailable');
  });
  it('rejects invalid revision and mismatched verified source', async () => {
    const f = fixture();
    await expect(
      f.repository.readPdfOcrInspection(context, id, id, {
        ...selection,
        extractionRevision: 4,
      }),
    ).rejects.toThrow();
    f.inventory.sourceDigest = 'b'.repeat(64);
    await expect(
      f.repository.readPdfOcrInspection(context, id, id, selection),
    ).rejects.toThrow();
  });
});
