import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { createStandardizationReceiptReconciler } from './finance-standardization-reconciliation.js';
const claim = {
  id: randomUUID(),
  token: randomUUID(),
  providerResponseId: 'resp_saved',
  pricing: {
    inputCadMinorPerMillionTokens: 100,
    outputCadMinorPerMillionTokens: 1000,
  },
};
describe('fixed worker receipt lookup', () => {
  it('uses only the saved provider ID and persists bounded factual evidence', async () => {
    const store = {
      claimReceiptLookup: vi.fn(async () => claim),
      recordReceiptLookup: vi.fn(async () => true),
    };
    const retrieve = vi.fn(async () => ({
      id: 'resp_saved',
      model: 'gpt-6-astra',
      status: 'completed',
      usage: { input_tokens: 10000, output_tokens: 2000 },
      output: ['approve and post'],
    }));
    await createStandardizationReceiptReconciler({ store, retrieve })();
    expect(retrieve).toHaveBeenCalledWith(
      'resp_saved',
      expect.any(AbortSignal),
    );
    expect(store.recordReceiptLookup).toHaveBeenCalledWith(
      claim.id,
      claim.token,
      expect.objectContaining({ status: 'verified', actualCadMinor: 3 }),
    );
    expect(JSON.stringify(store.recordReceiptLookup.mock.calls)).not.toContain(
      'approve',
    );
  });
  it('retains unavailable evidence when store:false prevents response retrieval', async () => {
    const store = {
      claimReceiptLookup: vi.fn(async () => claim),
      recordReceiptLookup: vi.fn(async () => true),
    };
    await createStandardizationReceiptReconciler({
      store,
      retrieve: vi.fn(async () => {
        throw Object.assign(new Error('not found'), { status: 404 });
      }),
    })();
    expect(store.recordReceiptLookup).toHaveBeenCalledWith(
      claim.id,
      claim.token,
      expect.objectContaining({ status: 'unavailable', actualCadMinor: null }),
    );
  });
  it('does not persist a receipt after shutdown cancellation', async () => {
    const controller = new AbortController();
    const store = {
      claimReceiptLookup: vi.fn(async () => claim),
      recordReceiptLookup: vi.fn(async () => true),
    };
    await createStandardizationReceiptReconciler({
      store,
      retrieve: async () => {
        controller.abort();
        return null;
      },
    })(controller.signal);
    expect(store.recordReceiptLookup).not.toHaveBeenCalled();
  });
});
