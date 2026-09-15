import { z } from 'zod';
import { FinanceStandardizationPricingSchema } from '@emdo/contracts';
/** Receipt verification never consumes generated text or treats 404 as no-send. */
export function verifyStandardizationProviderReceipt(
  raw: unknown,
  expected: { responseId: string; pricing: unknown },
) {
  const parsed = z
    .object({
      id: z.string(),
      model: z.string(),
      status: z.enum(['completed', 'failed', 'cancelled', 'incomplete']),
      usage: z.object({
        input_tokens: z.number().int().safe().nonnegative(),
        output_tokens: z.number().int().safe().nonnegative(),
      }),
    })
    .safeParse(raw);
  const pricing = FinanceStandardizationPricingSchema.safeParse(
    expected.pricing,
  );
  if (
    !parsed.success ||
    !pricing.success ||
    parsed.data.id !== expected.responseId ||
    parsed.data.model !== 'gpt-6-astra'
  )
    return {
      status: 'mismatch' as const,
      receiptFacts: null,
      inputTokens: null,
      outputTokens: null,
      actualCadMinor: null,
    };
  const receipt = parsed.data;
  const numerator =
    BigInt(receipt.usage.input_tokens) *
      BigInt(pricing.data.inputCadMinorPerMillionTokens) +
    BigInt(receipt.usage.output_tokens) *
      BigInt(pricing.data.outputCadMinorPerMillionTokens);
  const actual = (numerator + 999999n) / 1000000n;
  if (actual > 2147483647n) throw new Error('standardization-cost-overflow');
  const facts = {
    id: receipt.id,
    model: receipt.model,
    status: receipt.status,
    inputTokens: receipt.usage.input_tokens,
    outputTokens: receipt.usage.output_tokens,
  };
  return {
    status: 'verified' as const,
    receiptFacts: JSON.stringify(facts),
    inputTokens: facts.inputTokens,
    outputTokens: facts.outputTokens,
    actualCadMinor: Number(actual),
  };
}
