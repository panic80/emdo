import { z } from 'zod';

export const DEFAULT_API_LIMITS = Object.freeze({
  maximumJsonBodyBytes: 1_048_576,
  maximumAudioBytes: 16_777_216,
  maximumSpeechCharacters: 6_000,
  maximumTurnCharacters: 12_000,
});

const ApiLimitsSchema = z.strictObject({
  maximumJsonBodyBytes: z.number().int().positive().max(4_194_304),
  maximumAudioBytes: z.number().int().positive().max(26_214_400),
  maximumSpeechCharacters: z.number().int().positive().max(12_000),
  maximumTurnCharacters: z.number().int().positive().max(24_000),
});

export type ApiLimits = z.infer<typeof ApiLimitsSchema>;

export const resolveApiLimits = (
  overrides: Partial<ApiLimits> = {},
): ApiLimits =>
  Object.freeze(ApiLimitsSchema.parse({ ...DEFAULT_API_LIMITS, ...overrides }));
