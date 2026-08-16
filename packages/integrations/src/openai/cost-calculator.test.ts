import { describe, expect, it } from 'vitest';

import {
  ProductionOpenAiAudioCostCalculator,
  parseOpenAiAudioPricing,
} from './cost-calculator.js';

const pricingDocument = Object.freeze({
  schemaVersion: 1 as const,
  pricingVersion: 'openai-cad-2026-08-15',
  transcriptionCadMicrosPerMinute: Object.freeze({
    'gpt-4o-mini-transcribe': 100_000,
    'gpt-4o-transcribe': 200_000,
  }),
  speechCadMicrosPerMillionCharacters: Object.freeze({
    'tts-1': 10_000_000,
    'tts-1-hd': 20_000_000,
    'gpt-4o-mini-tts': 30_000_000,
    'gpt-4o-mini-tts-2025-12-15': 40_000_000,
  }),
});

const encodePricing = (input: unknown = pricingDocument): string =>
  Buffer.from(JSON.stringify(input), 'utf8').toString('base64url');

describe('production OpenAI audio pricing', () => {
  it('parses only canonical strict versioned integer-CAD pricing', () => {
    const encoded = encodePricing();

    expect(parseOpenAiAudioPricing(encoded)).toEqual(pricingDocument);
    expect(() => parseOpenAiAudioPricing(`${encoded}=`)).toThrow(
      'invalid-openai-audio-pricing',
    );
    expect(() =>
      parseOpenAiAudioPricing(
        encodePricing({ ...pricingDocument, unexpected: 'fallback' }),
      ),
    ).toThrow('invalid-openai-audio-pricing');
    expect(() =>
      parseOpenAiAudioPricing(
        encodePricing({
          ...pricingDocument,
          transcriptionCadMicrosPerMinute: {
            ...pricingDocument.transcriptionCadMicrosPerMinute,
            'gpt-4o-mini-transcribe': 0,
          },
        }),
      ),
    ).toThrow('invalid-openai-audio-pricing');
    expect(() =>
      parseOpenAiAudioPricing(
        encodePricing({
          ...pricingDocument,
          speechCadMicrosPerMillionCharacters: {
            ...pricingDocument.speechCadMicrosPerMillionCharacters,
            'gpt-4o-tts': 1,
          },
        }),
      ),
    ).toThrow('invalid-openai-audio-pricing');
  });

  it('rejects malformed, oversized, unsafe, and incomplete pricing', () => {
    expect(() => parseOpenAiAudioPricing('not+base64')).toThrow(
      'invalid-openai-audio-pricing',
    );
    expect(() => parseOpenAiAudioPricing('A'.repeat(32_769))).toThrow(
      'invalid-openai-audio-pricing',
    );
    expect(() =>
      parseOpenAiAudioPricing(
        encodePricing({
          ...pricingDocument,
          pricingVersion: 'contains whitespace',
        }),
      ),
    ).toThrow('invalid-openai-audio-pricing');
    expect(() =>
      parseOpenAiAudioPricing(
        encodePricing({
          ...pricingDocument,
          transcriptionCadMicrosPerMinute: {
            'gpt-4o-mini-transcribe': Number.MAX_SAFE_INTEGER + 1,
            'gpt-4o-transcribe': 200_000,
          },
        }),
      ),
    ).toThrow('invalid-openai-audio-pricing');
    expect(() =>
      parseOpenAiAudioPricing({
        toString: () => encodePricing(),
      } as unknown as string),
    ).toThrow('invalid-openai-audio-pricing');
  });

  it('rounds every positive transcription estimate and actual cost up', async () => {
    const calculator = new ProductionOpenAiAudioCostCalculator(
      parseOpenAiAudioPricing(encodePricing()),
    );

    expect(calculator.version).toBe('openai-cad-2026-08-15');
    await expect(
      calculator.estimateCadMinor({
        operation: 'transcription',
        model: 'gpt-4o-mini-transcribe',
        durationMs: 1,
        inputBytes: 1,
      }),
    ).resolves.toBe(1);
    await expect(
      calculator.actualCadMinor({
        operation: 'transcription',
        model: 'gpt-4o-transcribe',
        durationMs: 60_000,
        inputBytes: 10,
        usage: {
          type: 'tokens',
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        },
      }),
    ).resolves.toBe(20);
  });

  it('uses exact speech-model rates and never rounds sub-cent spend down', async () => {
    const calculator = new ProductionOpenAiAudioCostCalculator(
      parseOpenAiAudioPricing(encodePricing()),
    );

    await expect(
      calculator.estimateCadMinor({
        operation: 'speech',
        model: 'tts-1',
        inputCharacters: 1,
        responseFormat: 'mp3',
      }),
    ).resolves.toBe(1);
    await expect(
      calculator.actualCadMinor({
        operation: 'speech',
        model: 'gpt-4o-mini-tts-2025-12-15',
        inputCharacters: 4_096,
        outputBytes: 1,
        responseFormat: 'mp3',
      }),
    ).resolves.toBe(17);
  });

  it('fails closed on invalid operation input or unsafe output', async () => {
    const calculator = new ProductionOpenAiAudioCostCalculator(
      parseOpenAiAudioPricing(encodePricing()),
    );

    await expect(
      calculator.estimateCadMinor({
        operation: 'transcription',
        model: 'gpt-4o-mini-transcribe',
        durationMs: 0,
        inputBytes: 1,
      }),
    ).rejects.toThrow('invalid-openai-audio-cost-input');
    expect(
      () =>
        new ProductionOpenAiAudioCostCalculator({
          ...pricingDocument,
          transcriptionCadMicrosPerMinute: {
            ...pricingDocument.transcriptionCadMicrosPerMinute,
            'gpt-4o-transcribe': Number.MAX_SAFE_INTEGER,
          },
        }),
    ).toThrow('invalid-openai-audio-pricing');
  });
});
