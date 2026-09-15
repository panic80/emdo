import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  provider: vi.fn(),
  hook: vi.fn(() => vi.fn()),
  check: vi.fn(async () => {}),
  dispose: vi.fn(),
  worker: vi.fn(() => vi.fn()),
  manifest: vi.fn(async () => ({ synthetic: 'approved-manifest' })),
  imageAdapter: vi.fn(() => ({ extract: vi.fn() })),
  pdfAdapter: vi.fn(() => ({ render: vi.fn() })),
}));
vi.mock('./finance-standardization-worker.js', () => ({
  createFinanceStandardizationWorker: mocks.worker,
}));
vi.mock('./finance-image-ocr-isolated.js', () => ({
  readFinanceImageOcrApprovedRuntimeManifest: mocks.manifest,
}));
vi.mock('./finance-image-ocr.js', () => ({
  createFinanceImageOcrWorkerAdapter: mocks.imageAdapter,
}));
vi.mock('./finance-pdf-render-isolated.js', () => ({
  createFinancePdfIsolatedRenderer: mocks.pdfAdapter,
}));
vi.mock('openai', () => ({
  default: class {
    constructor(options: unknown) {
      mocks.client(options);
    }
  },
}));
vi.mock('@openai/agents', () => ({
  OpenAIProvider: class {
    constructor(options: unknown) {
      mocks.provider(options);
    }
  },
}));
vi.mock('@emdo/agent-core', () => ({
  createDurableFinanceProposalProvider: vi.fn(() => ({})),
  createDurableFinanceStandardizationHook: mocks.hook,
}));
vi.mock('@emdo/integrations/finance-documents', () => ({
  createFinanceDocumentKeyProvider: () => ({ dispose: mocks.dispose }),
  FinanceBookEvidenceCrypto: class {},
  EncryptedFinanceBookEvidenceSchema: { parse: (v: unknown) => v },
}));
vi.mock('@emdo/db/worker', () => ({
  PostgresFinanceStandardizationExecutionRepository: class {
    checkReady = mocks.check;
  },
  PostgresFinanceStandardizationDeliveryRepository: class {
    checkReady = mocks.check;
  },
}));
import { createProductionFinanceStandardization } from './finance-standardization-production.js';
import type { EmdoWorkerDatabaseClient } from '@emdo/db/worker';
const environment = {
  EMDO_OPENAI_AGENT_API_KEY: 'synthetic',
  EMDO_FINANCE_DOCUMENT_KEYRING_B64URL: 'synthetic',
  EMDO_OPENAI_AGENT_PRICING_VERSION: 'configured-cad.v1',
  EMDO_OPENAI_AGENT_GPT_6_ASTRA_INPUT_CAD_MINOR_PER_MILLION_TOKENS: '100',
  EMDO_OPENAI_AGENT_GPT_6_ASTRA_OUTPUT_CAD_MINOR_PER_MILLION_TOKENS: '200',
};
const database = { scopedPool: {} } as EmdoWorkerDatabaseClient;
describe('durable Finance provider composition', () => {
  it('requires explicit configured CAD prices and disables hidden transport retries', async () => {
    const result = await createProductionFinanceStandardization({
      environment,
      executor: database,
      dispatcher: database,
    });
    expect(mocks.client).toHaveBeenCalledWith({
      apiKey: 'synthetic',
      maxRetries: 0,
      timeout: 90000,
    });
    expect(mocks.provider).toHaveBeenCalledWith(
      expect.objectContaining({
        useResponses: true,
        useResponsesWebSocket: false,
      }),
    );
    expect(mocks.hook).toHaveBeenCalledWith(
      expect.objectContaining({
        pricing: {
          version: 'configured-cad.v1',
          inputCadMinorPerMillionTokens: 100,
          outputCadMinorPerMillionTokens: 200,
        },
        registration: expect.objectContaining({
          allowedParents: ['manager'],
          allowedChildren: [],
        }),
      }),
    );
    await result.close();
    expect(mocks.dispose).toHaveBeenCalled();
  });
  it('loads the release manifest and selects only the fixed socket adapter when enabled', async () => {
    const result = await createProductionFinanceStandardization({
      environment: {
        ...environment,
        EMDO_FINANCE_IMAGE_OCR_TRANSPORT: 'unix-socket',
      },
      executor: database,
      dispatcher: database,
    });
    expect(mocks.imageAdapter).toHaveBeenLastCalledWith({
      isolatedHelper: { approvedManifest: { synthetic: 'approved-manifest' } },
    });
    expect(mocks.worker).toHaveBeenLastCalledWith(
      expect.objectContaining({
        imageOcr: mocks.imageAdapter.mock.results.at(-1)?.value,
      }),
    );
    await result.close();
  });
  it('fails closed on an invalid transport or missing approved manifest', async () => {
    mocks.client.mockClear();
    await expect(
      createProductionFinanceStandardization({
        environment: {
          ...environment,
          EMDO_FINANCE_IMAGE_OCR_TRANSPORT: 'local',
        },
        executor: database,
        dispatcher: database,
      }),
    ).rejects.toThrow();
    mocks.manifest.mockRejectedValueOnce(
      new Error('finance-image-ocr-manifest-unavailable'),
    );
    await expect(
      createProductionFinanceStandardization({
        environment: {
          ...environment,
          EMDO_FINANCE_IMAGE_OCR_TRANSPORT: 'unix-socket',
        },
        executor: database,
        dispatcher: database,
      }),
    ).rejects.toThrow('finance-image-ocr-manifest-unavailable');
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it('fails before provider construction if configured rates are absent', async () => {
    mocks.client.mockClear();
    await expect(
      createProductionFinanceStandardization({
        environment: {
          ...environment,
          EMDO_OPENAI_AGENT_GPT_6_ASTRA_OUTPUT_CAD_MINOR_PER_MILLION_TOKENS:
            undefined,
        },
        executor: database,
        dispatcher: database,
      }),
    ).rejects.toThrow();
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it('keeps PDF rendering disabled by default and requires both isolated socket transports', async () => {
    mocks.pdfAdapter.mockClear();
    const disabled = await createProductionFinanceStandardization({
      environment,
      executor: database,
      dispatcher: database,
    });
    expect(mocks.pdfAdapter).not.toHaveBeenCalled();
    expect(mocks.worker).toHaveBeenLastCalledWith(
      expect.objectContaining({ pdfRenderer: undefined }),
    );
    await disabled.close();
    await expect(
      createProductionFinanceStandardization({
        environment: {
          ...environment,
          EMDO_FINANCE_PDF_RENDER_TRANSPORT: 'unix-socket',
        },
        executor: database,
        dispatcher: database,
      }),
    ).rejects.toThrow('requires-isolated-image-ocr');
    await expect(
      createProductionFinanceStandardization({
        environment: {
          ...environment,
          EMDO_FINANCE_PDF_RENDER_TRANSPORT: 'process',
        },
        executor: database,
        dispatcher: database,
      }),
    ).rejects.toThrow();
    const enabled = await createProductionFinanceStandardization({
      environment: {
        ...environment,
        EMDO_FINANCE_PDF_RENDER_TRANSPORT: 'unix-socket',
        EMDO_FINANCE_IMAGE_OCR_TRANSPORT: 'unix-socket',
      },
      executor: database,
      dispatcher: database,
    });
    expect(mocks.pdfAdapter).toHaveBeenLastCalledWith({
      transport: 'unix-socket',
    });
    expect(mocks.worker).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pdfRenderer: mocks.pdfAdapter.mock.results.at(-1)?.value,
        imageOcr: mocks.imageAdapter.mock.results.at(-1)?.value,
      }),
    );
    await enabled.close();
  });
});
