import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createAvailableRegisteredAgentProfile } from '../agents/registered-agent-profile.js';
import {
  createDurableFinanceStandardizationHook,
  type DurableFinanceProposalProvider,
} from '@emdo/agent-core';

const uuid = (n: number) =>
  `73000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.parse('2026-09-14T00:00:00Z');
function fixture(clock = () => now) {
  const claim = {
    runId: uuid(1),
    workspaceId: uuid(2),
    bookId: uuid(3),
    evidenceId: uuid(4),
    sourceDigest: 'a'.repeat(64),
    revision: 1,
    leaseToken: uuid(5),
    leaseExpiresAt: new Date(now + 90000).toISOString(),
    authorizedByUserId: uuid(6),
    authorizationRevision: { membership: 1, bookAccess: 2, entitlement: 1 },
  };
  const factsJson = JSON.stringify({
    headers: ['Date', 'Details', 'Amount', 'Currency'],
    rows: [['2026-09-01', 'Rent', '-100', 'CAD']],
  });
  const extraction = {
    revision: 1,
    adapterId: 'csv',
    adapterVersion: '1',
    sourceDigest: claim.sourceDigest,
    extractionDigest: createHash('sha256').update(factsJson).digest('hex'),
    kind: 'csv-table',
    factsJson,
    issues: [],
    complete: true,
    documentInstructions: 'untrusted-source-data',
  };
  const proposal = {
    definition: {
      providerKey: 'bank',
      reportName: 'Statement',
      reportType: 'bank-transactions',
      layoutVersion: '1',
      headers: ['Date', 'Details', 'Amount', 'Currency'],
      bindings: [
        { field: 'transactionDate', column: 'Date', context: null },
        { field: 'description', column: 'Details', context: null },
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
    },
    rationale: 'Source headings match the candidate.',
    unresolvedQuestions: [],
  };
  const generate = vi.fn<DurableFinanceProposalProvider['generate']>(
    async () => ({
      proposal,
      providerResponseId: 'resp_actual',
      model: 'gpt-6-astra',
      inputTokens: 100,
      outputTokens: 200,
    }),
  );
  const controls = {
    signal: new AbortController().signal,
    verifyAuthority: vi.fn(async () => true),
    reserveModelSpend: vi.fn(async () => ({ reservationId: uuid(7) })),
    markModelDispatch: vi.fn(async () => {}),
    settleModelSpend: vi.fn(async () => {}),
  };
  const registration = createAvailableRegisteredAgentProfile({
    finance: { readiness: async () => ({ status: 'ready' }) },
  }).registrations[0]!;
  const hook = createDurableFinanceStandardizationHook({
    registration,
    provider: { generate },
    clock,
    pricing: {
      version: 'test-rates',
      inputCadMinorPerMillionTokens: 10000,
      outputCadMinorPerMillionTokens: 20000,
    },
  });
  return { claim, extraction, proposal, generate, controls, hook };
}
describe('EMDO durable Finance standardization delegation', () => {
  it('derives a bounded whole-line image projection from full bound facts and persists its receipt before one provider call', async () => {
    const f = fixture();
    const words = Array.from({ length: 500 }, (_, index) => ({
      id: `image-page-1-word-${index + 1}`,
      page: 1,
      block: 1,
      paragraph: 1,
      line: Math.floor(index / 2) + 1,
      word: (index % 2) + 1,
      text: `raw-${index}-001.2300`,
      box: {
        x: (index % 2) * 50,
        y: Math.floor(index / 2) * 10,
        width: 40,
        height: 8,
      },
      coordinateSpace: 'image-pixels-top-left',
      confidence: 0.6,
      confidenceStatus: 'uncertain',
      sourceAnchor: `box-${index}`,
    }));
    const facts = {
      status: 'extracted',
      qualityStatus: 'uncertain',
      sourceDigest: f.claim.sourceDigest,
      format: 'png',
      width: 200,
      height: 8000,
      coordinateSpace: 'image-pixels-top-left',
      engine: {
        id: 'tesseract',
        version: '5.5',
        languages: ['eng'],
        trainedData: [{ language: 'eng', sha256: 'b'.repeat(64) }],
      },
      text: words.map((w) => w.text).join(' '),
      words,
      issues: [],
      truncated: false,
      textBasis: 'machine-transcription-requires-review',
    };
    f.extraction.kind = 'image-ocr';
    f.extraction.complete = false;
    f.extraction.factsJson = JSON.stringify(facts);
    f.extraction.extractionDigest = createHash('sha256')
      .update(f.extraction.factsJson)
      .digest('hex');
    const result = await f.hook(f, f.controls);
    expect(result.status).toBe('proposed');
    if (result.status !== 'proposed') throw new Error(result.reason);
    const projection = result.provenance.promptProjection!;
    if (!('selectedWordCount' in projection))
      throw new Error('expected-image-projection');
    expect(projection.omittedWordCount).toBeGreaterThan(0);
    expect(projection.selectedWordCount + projection.omittedWordCount).toBe(
      500,
    );
    expect(f.controls.reserveModelSpend).toHaveBeenCalledWith(
      expect.objectContaining({
        lineage: expect.objectContaining({ promptProjection: projection }),
      }),
    );
    expect(
      f.controls.reserveModelSpend.mock.invocationCallOrder[0],
    ).toBeLessThan(f.generate.mock.invocationCallOrder[0]!);
    expect(f.generate).toHaveBeenCalledTimes(1);
    const generatedInput = f.generate.mock.calls[0]![0];
    const totalReservedInputBytes =
      Buffer.byteLength(
        generatedInput.prompt + generatedInput.instructions,
        'utf8',
      ) +
      8192 +
      2048;
    expect(totalReservedInputBytes).toBeLessThanOrEqual(20_000);
    expect(projection.selectedWordCount).toBeGreaterThan(0);
    expect(projection.selectedWordCount % 2).toBe(0);
    expect(result.provenance.promptVersion).toBe(
      'finance-standardization-proposal.v5',
    );
    expect(f.controls.reserveModelSpend).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokenCeiling: 20_000,
        outputTokenCeiling: 4000,
      }),
    );
    const prompt = JSON.parse(generatedInput.prompt);
    expect(prompt.extraction.facts.words).toEqual(
      words.slice(0, projection.selectedWordCount),
    );
    expect(prompt.extraction.complete).toBe(false);
    expect(
      createHash('sha256')
        .update(JSON.stringify(prompt.extraction.facts))
        .digest('hex'),
    ).toBe(projection.digest);
    expect(f.controls.verifyAuthority).toHaveBeenCalledWith(f.claim, {
      extractionRevision: 1,
      extractionDigest: f.extraction.extractionDigest,
    });
    expect(result.proposal.unresolvedQuestions.join(' ')).toContain('omitted');
  });

  it('keeps bounded PDF OCR page identities and uncertainty in the delegated prompt', async () => {
    const f = fixture();
    const facts = {
      inventory: {
        sourceDigest: f.claim.sourceDigest,
        pageCount: 1,
        complete: false,
        pages: [
          { kind: 'unresolved', pageNumber: 1, reason: 'ocr-unavailable' },
        ],
      },
      embedded: {
        status: 'needs-ocr',
        format: 'pdf',
        totalPages: 1,
        pages: [],
        issues: [],
      },
    };
    const factsJson = JSON.stringify(facts);
    const extraction = {
      ...f.extraction,
      kind: 'pdf-ocr',
      adapterId: 'finance.pdf-ocr',
      complete: false,
      factsJson,
      extractionDigest: createHash('sha256').update(factsJson).digest('hex'),
    };
    const result = await f.hook({ claim: f.claim, extraction }, f.controls);
    expect(result.status).toBe('proposed');
    const request = f.generate.mock.calls[0]![0];
    expect(JSON.parse(request.prompt).extraction.facts).toEqual(facts);
    expect(request.instructions).toContain('nested OCR page1');
    expect(request.instructions).toContain('dd.mm.yyyy');
    expect(request.instructions).toContain(
      'never infer full-document coverage',
    );
    expect(f.controls.reserveModelSpend).toHaveBeenCalledWith(
      expect.objectContaining({
        lineage: expect.objectContaining({
          promptVersion: 'finance-standardization-proposal.v5',
        }),
      }),
    );
  });

  it('delegates a bounded proposal without browser authority and settles actual usage', async () => {
    const f = fixture();
    const result = await f.hook(f, f.controls);
    expect(result).toMatchObject({
      status: 'proposed',
      provenance: {
        controller: 'emdo',
        orchestrationMode: 'registered-workflow',
        model: 'gpt-6-astra',
        reasoningEffort: 'medium',
        providerResponseId: 'resp_actual',
      },
    });
    expect(f.controls.reserveModelSpend).toHaveBeenCalledWith(
      expect.objectContaining({
        estimatedCadMinor: 280,
        pricingVersion: 'test-rates',
        pricing: {
          inputCadMinorPerMillionTokens: 10000,
          outputCadMinorPerMillionTokens: 20000,
        },
        inputTokenCeiling: 20000,
        outputTokenCeiling: 4000,
        lineage: expect.objectContaining({
          managerInvocationId:
            result.status === 'proposed'
              ? result.provenance.managerInvocationId
              : 'missing',
          financeInvocationId:
            result.status === 'proposed'
              ? result.provenance.financeInvocationId
              : 'missing',
          orchestrationMode: 'registered-workflow',
          promptVersion: 'finance-standardization-proposal.v5',
        }),
      }),
    );
    expect(f.controls.markModelDispatch).toHaveBeenCalledWith({
      reservationId: uuid(7),
    });
    expect(
      f.controls.reserveModelSpend.mock.invocationCallOrder[0],
    ).toBeLessThan(f.controls.markModelDispatch.mock.invocationCallOrder[0]!);
    expect(
      f.controls.markModelDispatch.mock.invocationCallOrder[0],
    ).toBeLessThan(f.generate.mock.invocationCallOrder[0]!);
    expect(f.controls.settleModelSpend).toHaveBeenCalledWith({
      reservationId: uuid(7),
      outcome: 'completed',
      actualCadMinor: 5,
      providerResponseId: 'resp_actual',
    });
    expect(f.generate.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-6-astra',
      reasoningEffort: 'medium',
      maxOutputTokens: 4000,
    });
    expect(f.controls.verifyAuthority).toHaveBeenCalledWith(f.claim, {
      extractionRevision: f.extraction.revision,
      extractionDigest: f.extraction.extractionDigest,
    });
    const sent = JSON.stringify(f.generate.mock.calls);
    for (const privateValue of [
      f.claim.leaseToken,
      f.claim.authorizedByUserId,
      f.claim.workspaceId,
      f.claim.bookId,
    ])
      expect(sent).not.toContain(privateValue);
  });
  it('rejects changed extraction bytes before spend or disclosure', async () => {
    const f = fixture();
    f.extraction.factsJson = '{}';
    expect(await f.hook(f, f.controls)).toMatchObject({
      status: 'blocked',
      reason: 'source-binding-mismatch',
    });
    expect(f.controls.reserveModelSpend).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
  });
  it('checks revoked authority after reservation and releases only a not-sent request', async () => {
    const f = fixture();
    f.controls.verifyAuthority
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    expect(await f.hook(f, f.controls)).toMatchObject({
      status: 'blocked',
      reason: 'authority-revoked-before-dispatch',
    });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.controls.settleModelSpend).toHaveBeenCalledWith({
      reservationId: uuid(7),
      outcome: 'not-sent',
    });
  });
  it('withholds output after revocation while settling the real incurred cost', async () => {
    const f = fixture();
    f.controls.verifyAuthority
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    expect(await f.hook(f, f.controls)).toMatchObject({
      status: 'blocked',
      reason: 'authority-revoked-after-dispatch',
    });
    expect(f.controls.settleModelSpend).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed', actualCadMinor: 5 }),
    );
  });
  it('keeps unknown provider outcomes charged or held instead of releasing for retry', async () => {
    const f = fixture();
    f.generate.mockRejectedValueOnce(new Error('connection-lost'));
    expect(await f.hook(f, f.controls)).toMatchObject({
      status: 'indeterminate',
    });
    expect(f.controls.reserveModelSpend).toHaveBeenCalledWith(
      expect.objectContaining({
        lineage: expect.objectContaining({
          managerInvocationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
          financeInvocationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
          orchestrationMode: 'registered-workflow',
          promptVersion: 'finance-standardization-proposal.v5',
        }),
      }),
    );
    expect(
      f.controls.reserveModelSpend.mock.invocationCallOrder[0],
    ).toBeLessThan(f.generate.mock.invocationCallOrder[0]!);
    expect(f.controls.settleModelSpend).toHaveBeenCalledTimes(1);
    expect(f.controls.settleModelSpend).toHaveBeenCalledWith({
      reservationId: uuid(7),
      outcome: 'indeterminate',
    });
  });
  it('retains extraction uncertainty in the unapproved candidate', async () => {
    const f = fixture();
    f.extraction.complete = false;
    const result = await f.hook(f, f.controls);
    expect(result).toMatchObject({
      status: 'proposed',
      proposal: {
        unresolvedQuestions: [
          'Source extraction is incomplete; review the original before approval.',
        ],
      },
    });
  });
  it('blocks oversized source facts without invoking the model', async () => {
    const f = fixture();
    f.extraction.factsJson = JSON.stringify({ text: 'a'.repeat(20000) });
    f.extraction.extractionDigest = createHash('sha256')
      .update(f.extraction.factsJson)
      .digest('hex');
    expect(await f.hook(f, f.controls)).toMatchObject({
      status: 'blocked',
      reason: 'extraction-needs-bounded-selection',
    });
    expect(f.controls.reserveModelSpend).not.toHaveBeenCalled();
  });
  it.each([2, 3, 4])(
    'rechecks cancellation after authority lookup %s',
    async (lookup) => {
      const f = fixture();
      const controller = new AbortController();
      f.controls.signal = controller.signal;
      let count = 0;
      f.controls.verifyAuthority.mockImplementation(async () => {
        count += 1;
        if (count === lookup) controller.abort();
        return true;
      });
      expect(await f.hook(f, f.controls)).toMatchObject({
        status: 'blocked',
        reason:
          lookup === 2
            ? 'authority-revoked-before-dispatch'
            : lookup === 3
              ? 'authority-revoked-before-provider'
              : 'authority-revoked-after-dispatch',
      });
      expect(f.generate).toHaveBeenCalledTimes(lookup < 4 ? 0 : 1);
      expect(f.controls.settleModelSpend).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: lookup < 4 ? 'not-sent' : 'completed',
        }),
      );
    },
  );
  it('records a proven no-send when marker acknowledgement is lost before provider invocation', async () => {
    const f = fixture();
    f.controls.markModelDispatch.mockRejectedValueOnce(
      new Error('commit acknowledgement lost'),
    );
    expect(await f.hook(f, f.controls)).toMatchObject({
      status: 'blocked',
      reason: 'dispatch-not-started',
    });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.controls.settleModelSpend).toHaveBeenCalledWith({
      reservationId: uuid(7),
      outcome: 'not-sent',
    });
  });
  it('keeps an uncertain no-send settlement held without provider dispatch', async () => {
    const f = fixture();
    f.controls.markModelDispatch.mockRejectedValueOnce(
      new Error('lost marker'),
    );
    f.controls.settleModelSpend.mockRejectedValueOnce(
      new Error('lost settlement'),
    );
    expect(await f.hook(f, f.controls)).toMatchObject({
      status: 'indeterminate',
      reason: 'not-sent-settlement-unverified',
    });
    expect(f.generate).not.toHaveBeenCalled();
  });
  it('does not dispatch if a delayed authority result arrives after lease expiry', async () => {
    let time = now;
    const f = fixture(() => time);
    f.controls.verifyAuthority
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => {
        time += 90000;
        return true;
      });
    expect(await f.hook(f, f.controls)).toMatchObject({
      status: 'blocked',
      reason: 'authority-revoked-before-dispatch',
    });
    expect(f.generate).not.toHaveBeenCalled();
  });
  it.each(['budget-exhausted', 'authority-revoked'])(
    'returns confirmed reservation denial %s without model dispatch',
    async (code) => {
      const f = fixture();
      const denial = Object.assign(new Error('Confirmed atomic denial'), {
        name: 'FinanceStandardizationReservationDenied',
        code,
      });
      f.controls.reserveModelSpend.mockRejectedValueOnce(denial);
      expect(await f.hook(f, f.controls)).toEqual({
        status: 'blocked',
        reason: code,
      });
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.controls.settleModelSpend).not.toHaveBeenCalled();
    },
  );
  it('keeps an unconfirmed reservation held without model dispatch or refund', async () => {
    const f = fixture();
    f.controls.reserveModelSpend.mockRejectedValueOnce(
      new Error('Connection lost after reserve'),
    );
    expect(await f.hook(f, f.controls)).toEqual({
      status: 'indeterminate',
      reason: 'reservation-result-unverified',
    });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.controls.settleModelSpend).not.toHaveBeenCalled();
  });
  it('rejects an expired claim before spending', async () => {
    const f = fixture();
    f.claim.leaseExpiresAt = new Date(now).toISOString();
    expect(await f.hook(f, f.controls)).toMatchObject({ status: 'blocked' });
    expect(f.generate).not.toHaveBeenCalled();
  });
});

function pdfFixture(
  text = 'Date Description Amount CAD\n' + 'synthetic 001.2300\n'.repeat(110),
) {
  const f = fixture();
  const facts = {
    status: 'extracted',
    format: 'pdf',
    totalPages: 9,
    issues: [],
    pages: Array.from({ length: 9 }, (_, index) => ({
      page: index + 1,
      textStatus: 'text-extracted',
      text: `${index + 1}\n${text}`,
      spans: Array.from({ length: 200 }, () => ({
        text: 'synthetic',
        metadata: 'x'.repeat(180),
      })),
    })),
  };
  f.extraction.kind = 'pdf-layout';
  f.extraction.complete = false;
  f.extraction.factsJson = JSON.stringify(facts);
  f.extraction.extractionDigest = createHash('sha256')
    .update(f.extraction.factsJson)
    .digest('hex');
  return { ...f, facts };
}

it('sends all PDF page text with a bound receipt persisted before dispatch and a PDF-only 64000 ceiling', async () => {
  const f = pdfFixture();
  const original = f.extraction.factsJson;
  expect(Buffer.byteLength(original)).toBeGreaterThan(262144);
  const result = await f.hook(f, f.controls);
  expect(result.status).toBe('proposed');
  if (result.status !== 'proposed') throw new Error(result.reason);
  const receipt = result.provenance.promptProjection!;
  expect(receipt).toMatchObject({
    kind: 'pdf-text.v1',
    extractionDigest: f.extraction.extractionDigest,
    pageCount: 9,
    spanCount: 1800,
    omittedPages: 0,
  });
  const generated = f.generate.mock.calls[0]![0];
  const projection = JSON.parse(generated.prompt).extraction.facts;
  expect(projection.pages).toEqual(
    f.facts.pages.map(({ page, textStatus, text }) => ({
      page,
      textStatus,
      text,
    })),
  );
  expect(projection.sourceDigest).toBe(f.claim.sourceDigest);
  expect(receipt).toHaveProperty(
    'projectionDigest',
    createHash('sha256').update(JSON.stringify(projection)).digest('hex'),
  );
  expect(
    Buffer.byteLength(generated.prompt + generated.instructions, 'utf8') +
      8192 +
      2048,
  ).toBeLessThanOrEqual(64000);
  expect(f.controls.reserveModelSpend).toHaveBeenCalledWith(
    expect.objectContaining({
      inputTokenCeiling: 64000,
      outputTokenCeiling: 4000,
      estimatedCadMinor: 720,
      lineage: expect.objectContaining({
        promptVersion: 'finance-standardization-proposal.v5',
        promptProjection: receipt,
      }),
    }),
  );
  expect(f.controls.reserveModelSpend.mock.invocationCallOrder[0]).toBeLessThan(
    f.generate.mock.invocationCallOrder[0]!,
  );
  expect(f.extraction.factsJson).toBe(original);
});

it('blocks a PDF whose complete text cannot fit without reserving spend or dispatching', async () => {
  const f = pdfFixture('é'.repeat(10000));
  expect(await f.hook(f, f.controls)).toEqual({
    status: 'blocked',
    reason: 'pdf-complete-text-exceeds-input-budget',
  });
  expect(f.controls.reserveModelSpend).not.toHaveBeenCalled();
  expect(f.generate).not.toHaveBeenCalled();
});

it('enforces PDF usage against its reserved 64000 ceiling', async () => {
  const f = pdfFixture();
  f.generate.mockResolvedValueOnce({
    proposal: f.proposal,
    providerResponseId: 'resp_pdf',
    model: 'gpt-6-astra',
    inputTokens: 64001,
    outputTokens: 200,
  });
  expect(await f.hook(f, f.controls)).toEqual({
    status: 'blocked',
    reason: 'provider-budget-exceeded',
  });
});
