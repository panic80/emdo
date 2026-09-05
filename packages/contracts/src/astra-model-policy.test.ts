import { describe, expect, it } from 'vitest';

import { ModelIdSchema, ModelResolutionSchema } from './agent.js';

describe('Astra active model policy and historical result compatibility', () => {
  const astra = {
    status: 'resolved',
    requestedModel: 'gpt-6-astra',
    resolvedModel: 'gpt-6-astra',
    reason: 'default',
  };
  it('accepts only Astra as an active model and still reads legacy results', () => {
    expect(ModelIdSchema.parse('gpt-6-astra')).toBe('gpt-6-astra');
    expect(ModelResolutionSchema.parse(astra)).toEqual(astra);
    for (const model of ['gpt-5.6-luna', 'gpt-5.6-terra']) {
      expect(ModelIdSchema.safeParse(model).success).toBe(false);
      const legacy = { ...astra, requestedModel: model, resolvedModel: model };
      expect(ModelResolutionSchema.parse(legacy)).toEqual(legacy);
      expect(
        ModelResolutionSchema.safeParse({ ...astra, resolvedModel: model })
          .success,
      ).toBe(false);
    }
  });
  it('records a single Astra availability attempt and rejects legacy fallback metadata', () => {
    const unavailable = {
      status: 'unavailable',
      requestedModel: 'gpt-6-astra',
      attemptedModels: ['gpt-6-astra'],
      reason: 'no-configured-model-available',
      safeError: {
        code: 'agent-model-unavailable',
        message: 'AI is temporarily unavailable. Local features still work.',
        retryable: true,
      },
    };
    expect(ModelResolutionSchema.parse(unavailable)).toEqual(unavailable);
    expect(
      ModelResolutionSchema.safeParse({
        ...unavailable,
        attemptedModels: ['gpt-6-astra', 'gpt-5.6-luna'],
      }).success,
    ).toBe(false);
    expect(
      ModelResolutionSchema.safeParse({
        ...astra,
        reason: 'terra-unavailable',
        escalationTrigger: 'complex-reasoning',
      }).success,
    ).toBe(false);
  });
});
