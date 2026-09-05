import { UuidSchema } from '@emdo/contracts';
import { z } from 'zod';

const FinanceDocumentOriginalScopeSchema = z.strictObject({
  householdId: UuidSchema,
  privateSpaceId: UuidSchema,
  ownerUserId: UuidSchema,
});

/**
 * Canonical caller AAD for encrypted originals. The storage leaf additionally
 * binds its opaque object name, so ciphertext cannot be moved to another
 * object or authenticated uploader scope.
 */
export const financeDocumentOriginalAssociatedData = (input: {
  readonly householdId: string;
  readonly privateSpaceId: string;
  readonly ownerUserId: string;
}): Uint8Array => {
  const scope = FinanceDocumentOriginalScopeSchema.parse(input);
  return Buffer.from(
    JSON.stringify({
      domain: 'emdo.finance-document.original.v1',
      householdId: scope.householdId,
      privateSpaceId: scope.privateSpaceId,
      ownerUserId: scope.ownerUserId,
    }),
    'utf8',
  );
};
