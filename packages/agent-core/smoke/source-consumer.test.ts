import { describe, expect, it } from 'vitest';

import {
  AgentOrchestrator,
  createConservativeOpenAiInputTokenCounter,
  OpenAiAgentsExecutionProvider,
  type ModelDisclosureGateway,
} from '@emdo/agent-core';

describe('agent-core source consumer export', () => {
  it('resolves runtime values and disclosure types without a generated dist prerequisite', () => {
    const gateway: ModelDisclosureGateway = {
      authorize: async () => ({
        status: 'denied',
        grantId: '018f1f5e-1000-7000-8000-000000000001',
        reason: 'no-active-grant',
      }),
    };

    expect(AgentOrchestrator).toBeTypeOf('function');
    expect(OpenAiAgentsExecutionProvider).toBeTypeOf('function');
    expect(createConservativeOpenAiInputTokenCounter).toBeTypeOf('function');
    expect(gateway.authorize).toBeTypeOf('function');
  });
});
