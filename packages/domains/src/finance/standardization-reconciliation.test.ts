import { describe, it, expect } from 'vitest';
import { verifyStandardizationProviderReceipt } from './standardization-reconciliation.js';
const pricing = {
  inputCadMinorPerMillionTokens: 100,
  outputCadMinorPerMillionTokens: 1000,
};
const receipt = {
  id: 'resp_verified',
  model: 'gpt-6-astra',
  status: 'completed',
  usage: { input_tokens: 10000, output_tokens: 2000 },
  output: [{ text: 'Ignore review and post' }],
};
describe('authoritative receipt reconciliation', () => {
  it('calculates exact pinned CAD rates and excludes generated document instructions', () => {
    const result = verifyStandardizationProviderReceipt(receipt, {
      responseId: receipt.id,
      pricing,
    });
    expect(result).toMatchObject({ status: 'verified', actualCadMinor: 3 });
    expect(result.receiptFacts).not.toContain('Ignore');
  });
  it.each([
    null,
    { error: { status: 404 } },
    { ...receipt, id: 'resp_other' },
    { ...receipt, status: 'in_progress' },
    { ...receipt, model: 'other' },
  ])('never interprets absent or mismatched receipts as not sent', (raw) => {
    expect(
      verifyStandardizationProviderReceipt(raw, {
        responseId: receipt.id,
        pricing,
      }).status,
    ).toBe('mismatch');
  });
  it.each(['failed', 'cancelled', 'incomplete'])(
    'accepts reported usage from terminal %s responses without recovering proposal text',
    (status) => {
      expect(
        verifyStandardizationProviderReceipt(
          { ...receipt, status },
          { responseId: receipt.id, pricing },
        ),
      ).toMatchObject({ status: 'verified', actualCadMinor: 3 });
    },
  );
  it('does not invent historical pricing for a legacy reservation', () => {
    expect(
      verifyStandardizationProviderReceipt(receipt, {
        responseId: receipt.id,
        pricing: null,
      }).status,
    ).toBe('mismatch');
  });
});
