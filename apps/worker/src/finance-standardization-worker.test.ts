import { createHash } from 'node:crypto';
import { financePdfFixture } from '../../../packages/integrations/src/finance-documents/test-fixtures/pdf.js';
import { describe, it, expect, vi } from 'vitest';
import { FinanceStandardizationClaimSchema } from '@emdo/contracts';
import {
  createFinanceStandardizationWorker,
  type StandardizationStore,
} from './finance-standardization-worker.js';
import {
  standardizationCsv,
  standardizationDigest,
  standardizationProposal,
  standardizationProvenance,
} from './finance-standardization.test-fixtures.js';
const id = '00000000-0000-4000-8000-000000000001';
const claim = FinanceStandardizationClaimSchema.parse({
  runId: id,
  workspaceId: id,
  bookId: id,
  evidenceId: id,
  sourceDigest: standardizationDigest,
  revision: 2,
  leaseToken: id,
  leaseExpiresAt: '2099-01-01T00:00:00Z',
  authorizedByUserId: id,
  authorizationRevision: { membership: 1, bookAccess: 1, entitlement: 1 },
});
function fixture() {
  const store = {
    claim: vi.fn(async () => ({ status: 'claimed', claim })),
    readOriginal: vi.fn(async () => ({
      format: 'csv',
      bytes: Buffer.from(standardizationCsv),
    })),
    verifyAuthority: vi.fn(async () => true),
    saveExtraction: vi.fn(async () => {}),
    reserveModelSpend: vi.fn(async () => ({ reservationId: id })),
    markModelDispatch: vi.fn(async () => {}),
    settleModelSpend: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    block: vi.fn(async () => {}),
  } satisfies StandardizationStore;
  return store;
}
const job = { schemaVersion: 1, runId: id, deliveryRevision: 1 };
describe('durable review-only standardization worker', () => {
  it('attests exact saved extraction and derives candidate rows from original bytes', async () => {
    const store = fixture();
    const dispatch = createFinanceStandardizationWorker({
      store,
      propose: async (input, controls) => {
        expect(
          await controls.verifyAuthority(input.claim, {
            extractionRevision: input.extraction.revision,
            extractionDigest: input.extraction.extractionDigest,
          }),
        ).toBe(true);
        return {
          status: 'proposed',
          proposal: standardizationProposal,
          provenance: standardizationProvenance,
        };
      },
    });
    expect(await dispatch(job)).toBe('needs-review');
    expect(store.verifyAuthority).toHaveBeenCalledWith(claim, {
      extractionRevision: 1,
      extractionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(store.finish).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({ provenance: standardizationProvenance }),
      expect.objectContaining({
        example: expect.objectContaining({
          rows: [
            {
              sourceRow: 2,
              cells: ['2026-09-01', 'Payment fee included', '12.50', 'CAD'],
            },
          ],
        }),
      }),
    );
  });
  it('persists a blocked image run without model spend when the helper fails', async () => {
    const store = fixture();
    store.readOriginal.mockResolvedValue({
      format: 'png',
      bytes: Buffer.from(standardizationCsv),
    });
    const extract = vi
      .fn()
      .mockRejectedValue(
        new Error('synthetic helper stderr must remain private'),
      );
    const propose = vi.fn();
    expect(
      await createFinanceStandardizationWorker({
        store,
        propose,
        imageOcr: { extract },
      })(job),
    ).toBe('blocked');
    expect(extract).toHaveBeenCalledTimes(1);
    expect(propose).not.toHaveBeenCalled();
    expect(store.reserveModelSpend).not.toHaveBeenCalled();
    expect(store.saveExtraction).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled();
    expect(store.block).toHaveBeenCalledWith(
      claim,
      'blocked',
      'Extraction could not complete safely. Review the saved original or retry within the saved authorization.',
    );
  });
  it('stops before model dispatch after authority revocation', async () => {
    const store = fixture();
    store.verifyAuthority.mockResolvedValue(false);
    const propose = vi.fn();
    expect(
      await createFinanceStandardizationWorker({ store, propose })(job),
    ).toBe('blocked');
    expect(propose).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled();
    expect(store.block).toHaveBeenCalledWith(
      claim,
      'authority-revoked',
      expect.any(String),
    );
  });
  it('keeps a mismatched proposal for source review without inventing example rows', async () => {
    const store = fixture();
    const proposal = {
      ...standardizationProposal,
      definition: {
        ...standardizationProposal.definition,
        bindings: standardizationProposal.definition.bindings.map((b) => ({
          ...b,
          column: b.column === 'date' ? 'Different' : b.column,
        })),
        headers: [
          'Different',
          ...standardizationProposal.definition.headers.slice(1),
        ],
      },
    };
    expect(
      await createFinanceStandardizationWorker({
        store,
        propose: async () => ({
          status: 'proposed',
          proposal,
          provenance: standardizationProvenance,
        }),
      })(job),
    ).toBe('needs-review');
    expect(store.finish).toHaveBeenCalledWith(claim, expect.anything(), null);
  });
  it('does not repeat a model call when delivery is duplicate or outcome unconfirmed', async () => {
    const store = fixture();
    const propose = vi.fn(async () => {
      throw new Error('transport lost');
    });
    expect(
      await createFinanceStandardizationWorker({ store, propose })(job),
    ).toBe('indeterminate');
    expect(propose).toHaveBeenCalledTimes(1);
    expect(store.block).toHaveBeenCalledWith(
      claim,
      'indeterminate',
      expect.any(String),
    );
  });
  it('saves PDF OCR page evidence for manual review without model spend or a fabricated candidate', async () => {
    const store = fixture();
    const bytes = financePdfFixture([[], []]);
    const pdfClaim = {
      ...claim,
      sourceDigest: createHash('sha256').update(bytes).digest('hex'),
    };
    store.claim.mockResolvedValue({ status: 'claimed', claim: pdfClaim });
    store.readOriginal.mockResolvedValue({ format: 'pdf', bytes });
    const propose = vi.fn();
    const result = await createFinanceStandardizationWorker({
      store,
      propose,
      pdfRenderer: {
        render: async () => ({
          status: 'unavailable',
          reason: 'socket-unavailable',
        }),
      },
      imageOcr: {
        extract: async () => {
          throw Error('must not run');
        },
      },
    })(job);
    expect(result).toBe('blocked');
    expect(store.saveExtraction).toHaveBeenCalledWith(
      pdfClaim,
      expect.objectContaining({ status: 'needs-source-review', pageCount: 2 }),
      expect.objectContaining({ kind: 'pdf-ocr', complete: false }),
    );
    expect(store.verifyAuthority).toHaveBeenCalledWith(
      pdfClaim,
      expect.objectContaining({ extractionRevision: 1 }),
    );
    expect(propose).not.toHaveBeenCalled();
    expect(store.reserveModelSpend).not.toHaveBeenCalled();
    expect(store.markModelDispatch).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled();
    expect(store.block).toHaveBeenCalledWith(
      pdfClaim,
      'blocked',
      expect.stringContaining('observations were saved'),
    );
  });
  it('dispatches complete verified mixed-page facts once through the existing proposal lane without a materialized candidate', async () => {
    const store = fixture();
    const bytes = financePdfFixture([['Native transaction date amount'], []]);
    const pdfClaim = {
      ...claim,
      sourceDigest: createHash('sha256').update(bytes).digest('hex'),
    };
    store.claim.mockResolvedValue({ status: 'claimed', claim: pdfClaim });
    store.readOriginal.mockResolvedValue({ format: 'pdf', bytes });
    const propose = vi.fn(
      async (input: { extraction: { factsJson: string } }) => {
        const facts = JSON.parse(input.extraction.factsJson);
        expect(facts.inventory.pages).toMatchObject([
          { kind: 'embedded-text', pageNumber: 1 },
          { kind: 'unresolved', pageNumber: 2, reason: 'render-failed' },
        ]);
        expect(facts.embedded.pages).toHaveLength(2);
        return {
          status: 'proposed' as const,
          proposal: standardizationProposal,
          provenance: {
            ...standardizationProvenance,
            promptVersion: 'finance-standardization-proposal.v2' as const,
          },
        };
      },
    );
    const result = await createFinanceStandardizationWorker({
      store,
      propose,
      pdfRenderer: {
        render: async () => ({
          status: 'unavailable',
          reason: 'socket-unavailable',
        }),
      },
      imageOcr: {
        extract: async () => {
          throw Error('must not run');
        },
      },
    })(job);
    expect(result).toBe('needs-review');
    expect(propose).toHaveBeenCalledOnce();
    expect(store.finish).toHaveBeenCalledWith(
      pdfClaim,
      expect.objectContaining({
        proposal: expect.objectContaining({
          unresolvedQuestions: expect.arrayContaining([
            expect.stringContaining('Page 2 remains unresolved'),
          ]),
        }),
      }),
      null,
    );
    expect(store.block).not.toHaveBeenCalled();
  });
  it('rejects altered original/page facts before proposal dispatch even if a storage seam accepts them', async () => {
    const store = fixture();
    const bytes = financePdfFixture([['Native text'], []]);
    const pdfClaim = {
      ...claim,
      sourceDigest: createHash('sha256').update(bytes).digest('hex'),
    };
    store.claim.mockResolvedValue({ status: 'claimed', claim: pdfClaim });
    store.readOriginal.mockResolvedValue({ format: 'pdf', bytes });
    store.saveExtraction.mockImplementation(async (...args: unknown[]) => {
      const envelope = args[2] as {
        factsJson: string;
        extractionDigest: string;
      };
      const facts = JSON.parse(envelope.factsJson);
      facts.inventory.sourceDigest = 'f'.repeat(64);
      envelope.factsJson = JSON.stringify(facts);
      envelope.extractionDigest = createHash('sha256')
        .update(envelope.factsJson)
        .digest('hex');
    });
    const propose = vi.fn();
    expect(
      await createFinanceStandardizationWorker({
        store,
        propose,
        pdfRenderer: {
          render: async () => ({
            status: 'unavailable',
            reason: 'socket-unavailable',
          }),
        },
        imageOcr: {
          extract: async () => {
            throw Error('must not run');
          },
        },
      })(job),
    ).toBe('blocked');
    expect(propose).not.toHaveBeenCalled();
    expect(store.reserveModelSpend).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled();
  });
});
