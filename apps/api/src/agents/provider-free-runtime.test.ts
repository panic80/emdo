import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedPrincipal } from '../services/contracts.js';
import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import {
  createProviderFreeMvpRuntime,
  type ProviderFreeShoppingCreatePort,
} from './provider-free-runtime.js';

const ids = Object.freeze({
  request: '018f1f5e-2000-7000-8000-000000000001',
  run: '018f1f5e-2000-7000-8000-000000000002',
  conversation: '018f1f5e-2000-7000-8000-000000000003',
  user: '018f1f5e-2000-7000-8000-000000000004',
  session: '018f1f5e-2000-7000-8000-000000000005',
  household: '018f1f5e-2000-7000-8000-000000000006',
  grant: '018f1f5e-2000-7000-8000-000000000007',
  privateSpace: '018f1f5e-2000-7000-8000-000000000008',
});

const principal: AuthenticatedPrincipal = Object.freeze({
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  privateSpaceId: ids.privateSpace,
  role: 'owner',
  emailVerified: true,
  spaceAccessGrantId: ids.grant,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('f'.repeat(64)),
});

const createPort = (
  result: Awaited<ReturnType<ProviderFreeShoppingCreatePort['create']>> = {
    status: 'applied',
    item: {
      id: 'shopping-item-1',
      name: 'apples',
      quantityMinorUnits: 2_000,
      unit: 'each',
    },
    revision: 1,
    updatedAt: '2026-08-15T12:00:00.000Z',
  },
): ProviderFreeShoppingCreatePort => ({
  create: vi.fn(async () => result),
});

describe('provider-free MVP runtime', () => {
  it('routes the bounded shopping command to exactly one deterministic create port without model calls', async () => {
    const shopping = createPort();
    const runtime = createProviderFreeMvpRuntime({ shopping, principal });

    const result = await runtime.orchestrator.runTurn({
      requestId: ids.request,
      runId: ids.run,
      householdId: ids.household,
      userId: ids.user,
      authenticatedSessionId: ids.session,
      conversationId: ids.conversation,
      spaceAccessGrantId: ids.grant,
      authorizationScopeFingerprint: 'e'.repeat(64),
      message: 'add 2 each apples to shopping list',
      escalationTriggers: [],
      abortSignal: new AbortController().signal,
    });

    expect(shopping.create).toHaveBeenCalledOnce();
    expect(shopping.create).toHaveBeenCalledWith({
      principal,
      requestId: ids.request,
      privateSpaceId: ids.privateSpace,
      runId: ids.run,
      item: {
        id: expect.stringMatching(/^shopping-[a-f0-9]{64}$/u),
        name: 'apples',
        quantityMinorUnits: 2_000,
        unit: 'each',
      },
    });
    expect(result).toMatchObject({
      status: 'completed',
      output: {
        summary: 'Added 2 each apples to the shopping list.',
        shoppingItem: { quantityMinorUnits: 2_000 },
      },
      executionResolution: {
        status: 'provider-free',
        profile: 'shopping-list-v1',
        reason: 'provider-free-mvp',
      },
      specialistOutcomes: [
        expect.objectContaining({
          delegationId: 'shopping.create',
          specialistId: 'shopping',
          status: 'completed',
          output: expect.objectContaining({ status: 'applied' }),
        }),
      ],
    });
    expect(result).not.toHaveProperty('modelResolution');
    expect(runtime.orchestrator).not.toHaveProperty('proposalGateway');
  });

  it('rejects unsupported or ambiguous input before persistence', async () => {
    const shopping = createPort();
    const runtime = createProviderFreeMvpRuntime({ shopping, principal });

    const result = await runtime.orchestrator.runTurn({
      requestId: ids.request,
      runId: ids.run,
      householdId: ids.household,
      userId: ids.user,
      authenticatedSessionId: ids.session,
      conversationId: ids.conversation,
      spaceAccessGrantId: ids.grant,
      authorizationScopeFingerprint: 'e'.repeat(64),
      message: 'please get some apples',
      escalationTriggers: [],
      abortSignal: new AbortController().signal,
    });

    expect(shopping.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'failed',
      safeError: {
        code: 'provider-free-command-unsupported',
        retryable: false,
      },
    });
    expect(result).not.toHaveProperty('executionResolution');
  });

  it('fails closed for resume and never exposes proposal binding', async () => {
    const runtime = createProviderFreeMvpRuntime({
      shopping: createPort(),
      principal,
    });

    await expect(runtime.orchestrator.resumeTurn({} as never)).rejects.toThrow(
      'provider-free-resume-unavailable',
    );
  });
});
