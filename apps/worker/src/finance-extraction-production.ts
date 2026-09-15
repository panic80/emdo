import {
  PostgresFinanceExtractionExecutionRepository,
  type EmdoWorkerDatabaseClient,
} from '@emdo/db/worker';
import {
  createFinanceDocumentKeyProvider,
  FinanceBookEvidenceCrypto,
  EncryptedFinanceBookEvidenceSchema,
  createFinancePdfIsolatedRenderer,
} from '@emdo/integrations/finance-documents';
import { createFinanceImageOcrWorkerAdapter } from './finance-image-ocr.js';
import { readFinanceImageOcrApprovedRuntimeManifest } from './finance-image-ocr-isolated.js';
import { createFinanceExtractionLeaf } from './finance-extraction-leaf.js';
/** No provider or pricing dependency; operator capability readiness stays separate. */
export async function createProductionFinanceExtraction(input: {
  environment: Readonly<Record<string, string | undefined>>;
  executor: EmdoWorkerDatabaseClient;
}) {
  const keyring = input.environment.EMDO_FINANCE_DOCUMENT_KEYRING_B64URL;
  if (!keyring) return undefined;
  const imageMode =
      input.environment.EMDO_FINANCE_IMAGE_OCR_TRANSPORT ?? 'disabled',
    pdfMode = input.environment.EMDO_FINANCE_PDF_RENDER_TRANSPORT ?? 'disabled';
  if (
    !['disabled', 'unix-socket'].includes(imageMode) ||
    !['disabled', 'unix-socket'].includes(pdfMode) ||
    (pdfMode === 'unix-socket' && imageMode !== 'unix-socket')
  )
    throw Error('finance-extraction-isolated-transport-invalid');
  const keys = createFinanceDocumentKeyProvider(keyring),
    cipher = new FinanceBookEvidenceCrypto(keys);
  try {
    const imageOcr =
      imageMode === 'unix-socket'
        ? createFinanceImageOcrWorkerAdapter({
            isolatedHelper: {
              approvedManifest:
                await readFinanceImageOcrApprovedRuntimeManifest(),
            },
          })
        : undefined;
    const pdfRenderer =
      pdfMode === 'unix-socket'
        ? createFinancePdfIsolatedRenderer({ transport: 'unix-socket' })
        : undefined;
    const store = new PostgresFinanceExtractionExecutionRepository(
      input.executor.scopedPool,
      (encrypted, scope) =>
        cipher.decrypt(
          EncryptedFinanceBookEvidenceSchema.parse(encrypted),
          scope,
        ),
    );
    await store.checkReady();
    return {
      leaf: createFinanceExtractionLeaf(store, { imageOcr, pdfRenderer }),
      async close() {
        keys.dispose();
      },
    };
  } catch (error) {
    keys.dispose();
    throw error;
  }
}
