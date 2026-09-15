import OpenAI from 'openai';
import { createStandardizationReceiptReconciler } from './finance-standardization-reconciliation.js';
import { OpenAIProvider } from '@openai/agents';
import { z } from 'zod';
import {
  createDurableFinanceStandardizationHook,
  createDurableFinanceProposalProvider,
} from '@emdo/agent-core';
import { financeManifest } from '@emdo/agent-finance';
import {
  FinanceBookEvidenceCrypto,
  EncryptedFinanceBookEvidenceSchema,
  createFinanceDocumentKeyProvider,
} from '@emdo/integrations/finance-documents';
import {
  PostgresFinanceStandardizationExecutionRepository,
  PostgresFinanceStandardizationDeliveryRepository,
  type EmdoWorkerDatabaseClient,
} from '@emdo/db/worker';
import { createFinanceStandardizationWorker } from './finance-standardization-worker.js';
const Config = z.strictObject({
  imageOcr: z.enum(['disabled', 'unix-socket']).default('disabled'),
  pdfRender: z.enum(['disabled', 'unix-socket']).default('disabled'),
  apiKey: z.string().min(1),
  keyring: z.string().min(1),
  pricingVersion: z.string().min(1).max(128),
  inputRate: z.coerce.number().int().safe().positive(),
  outputRate: z.coerce.number().int().safe().positive(),
});
export async function createProductionFinanceStandardization(input: {
  environment: Readonly<Record<string, string | undefined>>;
  executor: EmdoWorkerDatabaseClient;
  dispatcher: EmdoWorkerDatabaseClient;
}) {
  const config = Config.parse({
    imageOcr: input.environment.EMDO_FINANCE_IMAGE_OCR_TRANSPORT,
    pdfRender: input.environment.EMDO_FINANCE_PDF_RENDER_TRANSPORT,
    apiKey: input.environment.EMDO_OPENAI_AGENT_API_KEY,
    keyring: input.environment.EMDO_FINANCE_DOCUMENT_KEYRING_B64URL,
    pricingVersion: input.environment.EMDO_OPENAI_AGENT_PRICING_VERSION,
    inputRate:
      input.environment
        .EMDO_OPENAI_AGENT_GPT_6_ASTRA_INPUT_CAD_MINOR_PER_MILLION_TOKENS,
    outputRate:
      input.environment
        .EMDO_OPENAI_AGENT_GPT_6_ASTRA_OUTPUT_CAD_MINOR_PER_MILLION_TOKENS,
  });
  if (config.pdfRender === 'unix-socket' && config.imageOcr !== 'unix-socket')
    throw new Error('finance-pdf-render-requires-isolated-image-ocr');
  const keys = createFinanceDocumentKeyProvider(config.keyring),
    cipher = new FinanceBookEvidenceCrypto(keys);
  try {
    const imageOcr =
      config.imageOcr === 'unix-socket'
        ? await (async () => {
            const { readFinanceImageOcrApprovedRuntimeManifest } =
              await import('./finance-image-ocr-isolated.js');
            const { createFinanceImageOcrWorkerAdapter } =
              await import('./finance-image-ocr.js');
            return createFinanceImageOcrWorkerAdapter({
              isolatedHelper: {
                approvedManifest:
                  await readFinanceImageOcrApprovedRuntimeManifest(),
              },
            });
          })()
        : {
            async extract(): Promise<never> {
              throw new Error('finance-image-ocr-transport-disabled');
            },
          };
    const pdfRenderer =
      config.pdfRender === 'unix-socket'
        ? (
            await import('./finance-pdf-render-isolated.js')
          ).createFinancePdfIsolatedRenderer({ transport: 'unix-socket' })
        : undefined;
    const store = new PostgresFinanceStandardizationExecutionRepository(
      input.executor.scopedPool,
      (encrypted, scope) =>
        cipher.decrypt(
          EncryptedFinanceBookEvidenceSchema.parse(encrypted),
          scope,
        ),
    );
    await store.checkReady();
    const deliveries = new PostgresFinanceStandardizationDeliveryRepository(
      input.dispatcher.scopedPool,
    );
    await deliveries.checkReady();
    const client = new OpenAI({
      apiKey: config.apiKey,
      maxRetries: 0,
      timeout: 90000,
    });
    const provider = new OpenAIProvider({
      openAIClient: client,
      useResponses: true,
      useResponsesWebSocket: false,
    });
    const hook = createDurableFinanceStandardizationHook({
      registration: {
        id: financeManifest.id,
        section: 'finance',
        allowedParents: ['manager'],
        allowedChildren: [],
        capabilities: financeManifest.capabilityAllowlist,
        readiness: async () => {
          try {
            await store.checkReady();
            return { status: 'ready' as const };
          } catch {
            return {
              status: 'unavailable' as const,
              reasonCode: 'standardization-executor-unavailable',
            };
          }
        },
      },
      provider: createDurableFinanceProposalProvider(provider),
      pricing: {
        version: config.pricingVersion,
        inputCadMinorPerMillionTokens: config.inputRate,
        outputCadMinorPerMillionTokens: config.outputRate,
      },
    });
    return {
      reconcileReceipts: createStandardizationReceiptReconciler({
        store,
        retrieve: (responseId, signal) =>
          client.responses.retrieve(
            responseId,
            {},
            { signal, maxRetries: 0, timeout: 10000 },
          ),
      }),
      dispatch: createFinanceStandardizationWorker({
        store,
        propose: hook,
        imageOcr,
        pdfRenderer,
      }),
      deliveries,
      async close() {
        keys.dispose();
      },
    };
  } catch (error) {
    keys.dispose();
    throw error;
  }
}
