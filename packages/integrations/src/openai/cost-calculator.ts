import { z } from 'zod';

import {
  OPENAI_AUDIO_LIMITS,
  OPENAI_ENDPOINT_SPEECH_MODELS,
  OPENAI_SPEECH_FORMATS,
  OPENAI_TRANSCRIPTION_MODELS,
  type OpenAiAudioActualCostInput,
  type OpenAiAudioCostCalculator,
  type OpenAiAudioCostEstimateInput,
} from './contracts.js';

const MAX_ENCODED_PRICING_BYTES = 32_768;
const MAX_DECODED_PRICING_BYTES = 24_576;
const MAX_CAD_MICROS_RATE = 1_000_000_000_000;
const CAD_MICROS_PER_CENT = 10_000n;
const MILLISECONDS_PER_MINUTE = 60_000n;
const CHARACTERS_PER_MILLION = 1_000_000n;

const PositiveRateSchema = z
  .number()
  .int()
  .safe()
  .positive()
  .max(MAX_CAD_MICROS_RATE);

const OpenAiAudioPricingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  pricingVersion: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/u),
  transcriptionCadMicrosPerMinute: z.strictObject({
    'gpt-4o-mini-transcribe': PositiveRateSchema,
    'gpt-4o-transcribe': PositiveRateSchema,
  }),
  speechCadMicrosPerMillionCharacters: z.strictObject({
    'tts-1': PositiveRateSchema,
    'tts-1-hd': PositiveRateSchema,
    'gpt-4o-mini-tts': PositiveRateSchema,
    'gpt-4o-mini-tts-2025-12-15': PositiveRateSchema,
  }),
});

export type ProductionOpenAiAudioPricing = Readonly<
  z.output<typeof OpenAiAudioPricingSchema>
>;

const invalidPricing = (): Error => new Error('invalid-openai-audio-pricing');

const parsePricingObject = (input: unknown): ProductionOpenAiAudioPricing => {
  const parsed = OpenAiAudioPricingSchema.safeParse(input);
  if (!parsed.success) throw invalidPricing();
  return Object.freeze({
    schemaVersion: parsed.data.schemaVersion,
    pricingVersion: parsed.data.pricingVersion,
    transcriptionCadMicrosPerMinute: Object.freeze({
      ...parsed.data.transcriptionCadMicrosPerMinute,
    }),
    speechCadMicrosPerMillionCharacters: Object.freeze({
      ...parsed.data.speechCadMicrosPerMillionCharacters,
    }),
  });
};

export const parseOpenAiAudioPricing = (
  encodedInput: unknown,
): ProductionOpenAiAudioPricing => {
  if (
    typeof encodedInput !== 'string' ||
    encodedInput.length < 1 ||
    encodedInput.length > MAX_ENCODED_PRICING_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(encodedInput)
  ) {
    throw invalidPricing();
  }

  let decoded: Buffer | undefined;
  try {
    decoded = Buffer.from(encodedInput, 'base64url');
    if (
      decoded.byteLength < 2 ||
      decoded.byteLength > MAX_DECODED_PRICING_BYTES ||
      decoded.toString('base64url') !== encodedInput
    ) {
      throw invalidPricing();
    }
    return parsePricingObject(JSON.parse(decoded.toString('utf8')));
  } catch {
    throw invalidPricing();
  } finally {
    decoded?.fill(0);
  }
};

const TokenUsageSchema = z.strictObject({
  type: z.literal('tokens'),
  inputTokens: z.number().int().safe().nonnegative(),
  outputTokens: z.number().int().safe().nonnegative(),
  totalTokens: z.number().int().safe().nonnegative(),
  audioInputTokens: z.number().int().safe().nonnegative().optional(),
  textInputTokens: z.number().int().safe().nonnegative().optional(),
});

const DurationUsageSchema = z.strictObject({
  type: z.literal('duration'),
  seconds: z.number().finite().positive(),
});

const TranscriptionEstimateSchema = z.strictObject({
  operation: z.literal('transcription'),
  model: z.enum(OPENAI_TRANSCRIPTION_MODELS),
  durationMs: z
    .number()
    .int()
    .safe()
    .min(1)
    .max(OPENAI_AUDIO_LIMITS.maxTranscriptionDurationMs),
  inputBytes: z
    .number()
    .int()
    .safe()
    .min(1)
    .max(OPENAI_AUDIO_LIMITS.maxTranscriptionBytes),
});

const SpeechEstimateSchema = z.strictObject({
  operation: z.literal('speech'),
  model: z.enum(OPENAI_ENDPOINT_SPEECH_MODELS),
  inputCharacters: z
    .number()
    .int()
    .safe()
    .min(1)
    .max(OPENAI_AUDIO_LIMITS.maxSpeechCharacters),
  responseFormat: z.enum(OPENAI_SPEECH_FORMATS),
});

const EstimateSchema = z.discriminatedUnion('operation', [
  TranscriptionEstimateSchema,
  SpeechEstimateSchema,
]);

const ActualSchema = z.discriminatedUnion('operation', [
  TranscriptionEstimateSchema.extend({
    usage: z.union([TokenUsageSchema, DurationUsageSchema]),
  }),
  SpeechEstimateSchema.extend({
    outputBytes: z
      .number()
      .int()
      .safe()
      .min(1)
      .max(OPENAI_AUDIO_LIMITS.maxSpeechBytes),
  }),
]);

const ceilingMinorUnits = (numerator: bigint, denominator: bigint): number => {
  const result = (numerator + denominator - 1n) / denominator;
  if (result < 1n || result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('invalid-openai-audio-cost');
  }
  return Number(result);
};

export class ProductionOpenAiAudioCostCalculator implements OpenAiAudioCostCalculator {
  readonly #pricing: ProductionOpenAiAudioPricing;
  readonly version: string;

  constructor(pricingInput: unknown) {
    this.#pricing = parsePricingObject(pricingInput);
    // The hardened audio adapter deliberately accepts only data properties
    // for injected configuration. Keep this value immutable and accessor-free.
    this.version = this.#pricing.pricingVersion;
  }

  async estimateCadMinor(input: OpenAiAudioCostEstimateInput): Promise<number> {
    const parsed = EstimateSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error('invalid-openai-audio-cost-input');
    }
    return this.#cost(parsed.data);
  }

  async actualCadMinor(input: OpenAiAudioActualCostInput): Promise<number> {
    const parsed = ActualSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error('invalid-openai-audio-cost-input');
    }
    return this.#cost(parsed.data);
  }

  #cost(input: z.output<typeof EstimateSchema>): number {
    if (input.operation === 'transcription') {
      const rate = BigInt(
        this.#pricing.transcriptionCadMicrosPerMinute[input.model],
      );
      return ceilingMinorUnits(
        BigInt(input.durationMs) * rate,
        MILLISECONDS_PER_MINUTE * CAD_MICROS_PER_CENT,
      );
    }

    const rate = BigInt(
      this.#pricing.speechCadMicrosPerMillionCharacters[input.model],
    );
    return ceilingMinorUnits(
      BigInt(input.inputCharacters) * rate,
      CHARACTERS_PER_MILLION * CAD_MICROS_PER_CENT,
    );
  }
}
