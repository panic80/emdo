import { createHash } from 'node:crypto';
import { z } from 'zod';
import { verifyStandardizationProviderReceipt } from '@emdo/domains/finance';
const Claim = z.strictObject({
  id: z.uuid(),
  token: z.uuid(),
  providerResponseId: z.string().min(1).max(200),
  pricing: z.unknown(),
});
export function createStandardizationReceiptReconciler(input: {
  store: {
    claimReceiptLookup(): Promise<unknown>;
    recordReceiptLookup(
      id: string,
      token: string,
      facts: unknown,
    ): Promise<boolean>;
  };
  retrieve(responseId: string, signal: AbortSignal): Promise<unknown>;
}) {
  return async (signal: AbortSignal = new AbortController().signal) => {
    const raw = await input.store.claimReceiptLookup();
    if (!raw) return;
    const claim = Claim.parse(raw);
    let facts;
    try {
      const receipt = await input.retrieve(
        claim.providerResponseId,
        AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      );
      const { receiptFacts, ...verified } =
        verifyStandardizationProviderReceipt(receipt, {
          responseId: claim.providerResponseId,
          pricing: claim.pricing,
        });
      facts = {
        ...verified,
        receiptDigest: receiptFacts
          ? createHash('sha256').update(receiptFacts).digest('hex')
          : null,
        providerResponseId: claim.providerResponseId,
      };
    } catch {
      facts = {
        status: 'unavailable',
        receiptDigest: null,
        inputTokens: null,
        outputTokens: null,
        actualCadMinor: null,
        providerResponseId: claim.providerResponseId,
      };
    }
    if (signal.aborted) return;
    await input.store.recordReceiptLookup(claim.id, claim.token, facts);
  };
}
