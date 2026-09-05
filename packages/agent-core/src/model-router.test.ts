import { describe, expect, it, vi } from 'vitest';

import { InMemoryModelAvailability, ModelRouter } from './model-router.js';

const policy = Object.freeze({
  defaultModel: 'gpt-6-astra' as const,
  complexModel: 'gpt-6-astra' as const,
  escalationReasons: Object.freeze([
    'dependent-cross-domain',
    'failed-output-validation',
    'low-confidence-reconciliation',
    'model-execution-failed',
    'complex-reasoning',
  ] as const),
});

describe('ModelRouter', () => {
  it('uses Astra by default and records why it was selected', async () => {
    const router = new ModelRouter(
      new InMemoryModelAvailability({
        'gpt-6-astra': true,
      }),
    );

    await expect(router.resolve({ triggers: [], policy })).resolves.toEqual({
      status: 'resolved',
      requestedModel: 'gpt-6-astra',
      resolvedModel: 'gpt-6-astra',
      reason: 'default',
    });
  });

  it.each([
    'dependent-cross-domain',
    'failed-output-validation',
    'low-confidence-reconciliation',
    'complex-reasoning',
  ] as const)('routes %s work to Astra', async (trigger) => {
    const router = new ModelRouter(
      new InMemoryModelAvailability({
        'gpt-6-astra': true,
      }),
    );

    await expect(
      router.resolve({ triggers: [trigger], policy }),
    ).resolves.toEqual({
      status: 'resolved',
      requestedModel: 'gpt-6-astra',
      resolvedModel: 'gpt-6-astra',
      reason: trigger,
    });
  });

  it('fails closed without provider I/O when the manifest policy does not allow the requested escalation', async () => {
    const availability = new InMemoryModelAvailability({
      'gpt-6-astra': true,
    });
    const router = new ModelRouter(availability);

    await expect(
      router.resolve({
        triggers: ['failed-output-validation'],
        policy: {
          ...policy,
          escalationReasons: ['complex-reasoning', 'model-execution-failed'],
        },
      }),
    ).resolves.toEqual({
      status: 'unavailable',
      requestedModel: 'gpt-6-astra',
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

  it.each([
    'dependent-cross-domain',
    'failed-output-validation',
    'low-confidence-reconciliation',
  ] as const)(
    'fails closed when Astra is unavailable for %s',
    async (trigger) => {
      const availability = new InMemoryModelAvailability({
        'gpt-6-astra': false,
      });
      const router = new ModelRouter(availability);

      await expect(
        router.resolve({ triggers: [trigger], policy }),
      ).resolves.toEqual({
        status: 'unavailable',
        requestedModel: 'gpt-6-astra',
        attemptedModels: ['gpt-6-astra'],
        reason: 'required-complex-model-unavailable',
        escalationTrigger: trigger,
        safeError: {
          code: 'required-agent-model-unavailable',
          message:
            'The model required to complete this request safely is temporarily unavailable.',
          retryable: true,
        },
      });
      expect(availability.checkedModels()).toEqual(['gpt-6-astra']);
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
          'gpt-6-astra': false,
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
        'gpt-6-astra': false,
      }),
    );

    await expect(router.resolve({ triggers: [], policy })).resolves.toEqual({
      status: 'unavailable',
      requestedModel: 'gpt-6-astra',
      attemptedModels: ['gpt-6-astra'],
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
      'gpt-6-astra': true,
    });
    const router = new ModelRouter(availability);
    const result = await router.resolve({
      triggers: ['complex-reasoning', 'complex-reasoning'],
      policy,
    });

    expect(availability.checkedModels()).toEqual(['gpt-6-astra']);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('fails closed on an unknown runtime escalation trigger', async () => {
    const router = new ModelRouter(
      new InMemoryModelAvailability({
        'gpt-6-astra': true,
      }),
    );

    await expect(
      router.resolve({
        triggers: ['model-supplied-override'] as never,
        policy,
      }),
    ).rejects.toThrow('invalid-model-routing-request');
  });

  it('fails closed on probe errors without trying any legacy model', async () => {
    const isAvailable = vi.fn(async () => {
      throw new Error('probe failed');
    });
    const router = new ModelRouter({ isAvailable });
    await expect(
      router.resolve({ triggers: [], policy }),
    ).resolves.toMatchObject({
      status: 'unavailable',
      requestedModel: 'gpt-6-astra',
      attemptedModels: ['gpt-6-astra'],
      reason: 'no-configured-model-available',
    });
    expect(isAvailable.mock.calls).toEqual([['gpt-6-astra']]);
  });

  it.each(['gpt-5.6-luna', 'gpt-5.6-terra'])(
    'rejects legacy active model %s',
    async (model) => {
      const isAvailable = vi.fn(async () => true);
      const router = new ModelRouter({ isAvailable });
      await expect(
        router.resolve({
          triggers: [],
          policy: { ...policy, defaultModel: model } as never,
        }),
      ).rejects.toThrow('invalid-model-routing-request');
      expect(isAvailable).not.toHaveBeenCalled();
    },
  );

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
      resolvedModel: 'gpt-6-astra',
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
