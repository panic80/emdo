import { describe, expect, it, vi } from 'vitest';

import { InMemoryModelAvailability, ModelRouter } from './model-router.js';

const policy = Object.freeze({
  defaultModel: 'gpt-5.6-luna' as const,
  complexModel: 'gpt-5.6-terra' as const,
  escalationReasons: Object.freeze([
    'dependent-cross-domain',
    'failed-output-validation',
    'low-confidence-reconciliation',
    'luna-unavailable',
    'complex-reasoning',
  ] as const),
});

describe('ModelRouter', () => {
  it('uses Luna by default and records why it was selected', async () => {
    const router = new ModelRouter(
      new InMemoryModelAvailability({
        'gpt-5.6-luna': true,
        'gpt-5.6-terra': true,
      }),
    );

    await expect(router.resolve({ triggers: [], policy })).resolves.toEqual({
      status: 'resolved',
      requestedModel: 'gpt-5.6-luna',
      resolvedModel: 'gpt-5.6-luna',
      reason: 'default',
    });
  });

  it.each([
    'dependent-cross-domain',
    'failed-output-validation',
    'low-confidence-reconciliation',
    'complex-reasoning',
  ] as const)('routes %s work to Terra', async (trigger) => {
    const router = new ModelRouter(
      new InMemoryModelAvailability({
        'gpt-5.6-luna': true,
        'gpt-5.6-terra': true,
      }),
    );

    await expect(
      router.resolve({ triggers: [trigger], policy }),
    ).resolves.toEqual({
      status: 'resolved',
      requestedModel: 'gpt-5.6-terra',
      resolvedModel: 'gpt-5.6-terra',
      reason: trigger,
    });
  });

  it('falls back from unavailable Luna to Terra', async () => {
    const router = new ModelRouter(
      new InMemoryModelAvailability({
        'gpt-5.6-luna': false,
        'gpt-5.6-terra': true,
      }),
    );

    await expect(router.resolve({ triggers: [], policy })).resolves.toEqual({
      status: 'resolved',
      requestedModel: 'gpt-5.6-luna',
      resolvedModel: 'gpt-5.6-terra',
      reason: 'luna-unavailable',
    });
  });

  it('degrades ordinary complex reasoning to Luna while preserving the trigger', async () => {
    const router = new ModelRouter(
      new InMemoryModelAvailability({
        'gpt-5.6-luna': true,
        'gpt-5.6-terra': false,
      }),
    );

    await expect(
      router.resolve({ triggers: ['complex-reasoning'], policy }),
    ).resolves.toEqual({
      status: 'resolved',
      requestedModel: 'gpt-5.6-terra',
      resolvedModel: 'gpt-5.6-luna',
      reason: 'terra-unavailable',
      escalationTrigger: 'complex-reasoning',
    });
  });

  it('fails closed without provider I/O when the manifest policy does not allow the requested escalation', async () => {
    const availability = new InMemoryModelAvailability({
      'gpt-5.6-luna': true,
      'gpt-5.6-terra': true,
    });
    const router = new ModelRouter(availability);

    await expect(
      router.resolve({
        triggers: ['failed-output-validation'],
        policy: {
          ...policy,
          escalationReasons: ['complex-reasoning', 'luna-unavailable'],
        },
      }),
    ).resolves.toEqual({
      status: 'unavailable',
      requestedModel: 'gpt-5.6-terra',
      attemptedModels: [],
      reason: 'configured-model-escalation-not-allowed',
      escalationTrigger: 'failed-output-validation',
      safeError: {
        code: 'agent-model-escalation-not-allowed',
        message:
          'The active agent policy does not allow the required model escalation.',
        retryable: false,
      },
    });
    expect(availability.checkedModels()).toEqual([]);
  });

  it('records an unavailable nonretryable result when policy forbids Luna fallback', async () => {
    const availability = new InMemoryModelAvailability({
      'gpt-5.6-luna': false,
      'gpt-5.6-terra': true,
    });
    const router = new ModelRouter(availability);

    await expect(
      router.resolve({
        triggers: [],
        policy: {
          ...policy,
          escalationReasons: ['complex-reasoning'],
        },
      }),
    ).resolves.toEqual({
      status: 'unavailable',
      requestedModel: 'gpt-5.6-luna',
      attemptedModels: ['gpt-5.6-luna'],
      reason: 'configured-model-fallback-not-allowed',
      safeError: {
        code: 'agent-model-fallback-not-allowed',
        message: 'The active agent policy does not allow a model fallback.',
        retryable: false,
      },
    });
    expect(availability.checkedModels()).toEqual(['gpt-5.6-luna']);
  });

  it.each([
    'dependent-cross-domain',
    'failed-output-validation',
    'low-confidence-reconciliation',
  ] as const)(
    'fails closed when Terra is unavailable for %s',
    async (trigger) => {
      const availability = new InMemoryModelAvailability({
        'gpt-5.6-luna': true,
        'gpt-5.6-terra': false,
      });
      const router = new ModelRouter(availability);

      await expect(
        router.resolve({ triggers: [trigger], policy }),
      ).resolves.toEqual({
        status: 'unavailable',
        requestedModel: 'gpt-5.6-terra',
        attemptedModels: ['gpt-5.6-terra'],
        reason: 'required-complex-model-unavailable',
        escalationTrigger: trigger,
        safeError: {
          code: 'required-agent-model-unavailable',
          message:
            'The model required to complete this request safely is temporarily unavailable.',
          retryable: true,
        },
      });
      expect(availability.checkedModels()).toEqual(['gpt-5.6-terra']);
    },
  );

  it.each([
    ['complex-reasoning', 'failed-output-validation'],
    ['failed-output-validation', 'complex-reasoning'],
  ] as const)(
    'fails closed for mixed triggers in either order: %s then %s',
    async (first, second) => {
      const router = new ModelRouter(
        new InMemoryModelAvailability({
          'gpt-5.6-luna': true,
          'gpt-5.6-terra': false,
        }),
      );

      await expect(
        router.resolve({ triggers: [first, second], policy }),
      ).resolves.toMatchObject({
        status: 'unavailable',
        reason: 'required-complex-model-unavailable',
        escalationTrigger: 'failed-output-validation',
      });
    },
  );

  it('returns a safe unavailable result without inventing a resolved model', async () => {
    const router = new ModelRouter(
      new InMemoryModelAvailability({
        'gpt-5.6-luna': false,
        'gpt-5.6-terra': false,
      }),
    );

    await expect(router.resolve({ triggers: [], policy })).resolves.toEqual({
      status: 'unavailable',
      requestedModel: 'gpt-5.6-luna',
      attemptedModels: ['gpt-5.6-luna', 'gpt-5.6-terra'],
      reason: 'no-configured-model-available',
      safeError: {
        code: 'agent-model-unavailable',
        message: 'AI is temporarily unavailable. Local features still work.',
        retryable: true,
      },
    });
  });

  it('deduplicates availability checks and freezes returned results', async () => {
    const availability = new InMemoryModelAvailability({
      'gpt-5.6-luna': true,
      'gpt-5.6-terra': true,
    });
    const router = new ModelRouter(availability);
    const result = await router.resolve({
      triggers: ['complex-reasoning', 'complex-reasoning'],
      policy,
    });

    expect(availability.checkedModels()).toEqual(['gpt-5.6-terra']);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('fails closed on an unknown runtime escalation trigger', async () => {
    const router = new ModelRouter(
      new InMemoryModelAvailability({
        'gpt-5.6-luna': true,
        'gpt-5.6-terra': true,
      }),
    );

    await expect(
      router.resolve({
        triggers: ['model-supplied-override'] as never,
        policy,
      }),
    ).rejects.toThrow('invalid-model-routing-request');
  });

  it('treats availability probe failures as unavailable and still tries the fallback', async () => {
    const router = new ModelRouter({
      isAvailable: async (model) => {
        if (model === 'gpt-5.6-luna') throw new Error('probe failed');
        return true;
      },
    });

    await expect(
      router.resolve({ triggers: [], policy }),
    ).resolves.toMatchObject({
      status: 'resolved',
      requestedModel: 'gpt-5.6-luna',
      resolvedModel: 'gpt-5.6-terra',
      reason: 'luna-unavailable',
    });

    const unavailable = new ModelRouter({
      isAvailable: async () => {
        throw new Error('probe failed');
      },
    });
    await expect(
      unavailable.resolve({ triggers: [], policy }),
    ).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'no-configured-model-available',
    });
  });

  it('captures the availability probe at construction', async () => {
    const replacement = vi.fn(async () => false);
    const availability = {
      isAvailable: async () => true,
    };
    const router = new ModelRouter(availability);
    availability.isAvailable = replacement;

    await expect(
      router.resolve({ triggers: [], policy }),
    ).resolves.toMatchObject({
      status: 'resolved',
      resolvedModel: 'gpt-5.6-luna',
    });
    expect(replacement).not.toHaveBeenCalled();
  });

  it('rejects accessor-backed routing input before checking model availability', async () => {
    const availability = {
      isAvailable: vi.fn(async () => true),
    };
    const router = new ModelRouter(availability);
    const input = Object.defineProperty({}, 'triggers', {
      enumerable: true,
      get: () => [],
    });

    await expect(router.resolve(input as never)).rejects.toThrow(
      'invalid-model-routing-request',
    );
    expect(availability.isAvailable).not.toHaveBeenCalled();
  });
});
