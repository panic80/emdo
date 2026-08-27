import { createFinanceDocumentKeyProvider } from '@emdo/integrations/finance-documents';

/** API compatibility name; the parser is shared with the extraction worker. */
export const createProductionFinanceDocumentKeyProvider = (
  encoded: string,
  forbiddenKeyMaterials: readonly Uint8Array[] = [],
) => {
  try {
    return createFinanceDocumentKeyProvider(encoded, forbiddenKeyMaterials);
  } catch {
    throw new Error('api-finance-document-keyring-invalid');
  }
};
