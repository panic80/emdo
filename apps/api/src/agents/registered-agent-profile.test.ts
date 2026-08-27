import { describe, expect, it, vi } from 'vitest';

import {
  FINANCE_V1_REGISTERED_SPECIALIST_IDS,
  createAvailableRegisteredAgentProfile,
  createFinanceV1RegisteredAgentProfile,
} from './registered-agent-profile.js';

describe('Finance v1 registered-agent profile', () => {
  it('registers exactly Scheduler and Finance under EMDO', async () => {
    const schedulerReadiness = vi.fn(async () => ({
      status: 'ready' as const,
    }));
    const financeReadiness = vi.fn(async () => ({
      status: 'unavailable' as const,
      reasonCode: 'finance-document-store-unavailable',
    }));
    const profile = createFinanceV1RegisteredAgentProfile({
      schedulerReadiness,
      financeReadiness,
    });

    expect(FINANCE_V1_REGISTERED_SPECIALIST_IDS).toEqual([
      'scheduler',
      'finance',
    ]);
    expect(profile.manager.manifest.capabilityAllowlist).toEqual([
      'agent.scheduler.delegate',
      'agent.finance.delegate',
    ]);
    expect(profile.specialists.map(({ manifest }) => manifest.id)).toEqual([
      'scheduler',
      'finance',
    ]);
    expect(profile.registrations.map(({ id }) => id)).toEqual([
      'scheduler',
      'finance',
    ]);
    expect(profile.registrations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'shopping' })]),
    );
    for (const registration of profile.registrations) {
      expect(registration.allowedParents).toEqual(['manager']);
      expect(registration.allowedChildren).toEqual([]);
      expect(registration.disclosurePolicy).toMatchObject({
        mode: 'minimum-required',
        crossSpecialistSharing: 'manager-mediated-only',
      });
    }
    await expect(profile.registrations[0].readiness()).resolves.toEqual({
      status: 'ready',
    });
    await expect(profile.registrations[1].readiness()).resolves.toEqual({
      status: 'unavailable',
      reasonCode: 'finance-document-store-unavailable',
    });
  });

  it('exposes the exact bounded Finance v1 capability set', () => {
    const profile = createFinanceV1RegisteredAgentProfile({
      schedulerReadiness: async () => ({ status: 'ready' }),
      financeReadiness: async () => ({ status: 'ready' }),
    });
    expect(profile.registrations[0].capabilities).toEqual([
      'google-calendar.event.create',
    ]);
    expect(profile.registrations[1].capabilities).toEqual([
      'finance.records.read',
      'finance.records.write',
      'finance.statement.import',
      'finance.analytics.calculate',
      'finance.documents.search',
      'finance.documents.read',
      'finance.matches.read',
    ]);
  });

  it('rejects missing server-owned readiness checks', () => {
    expect(() =>
      createFinanceV1RegisteredAgentProfile({
        schedulerReadiness: undefined as never,
        financeReadiness: async () => ({ status: 'ready' }),
      }),
    ).toThrowError('api-registered-agent-readiness-missing');
  });

  it.each([
    {
      name: 'EMDO alone',
      input: {},
      agents: ['manager'],
      capabilities: [],
    },
    {
      name: 'EMDO plus Scheduler',
      input: {
        scheduler: { readiness: async () => ({ status: 'ready' as const }) },
      },
      agents: ['manager', 'scheduler'],
      capabilities: ['agent.scheduler.delegate'],
    },
    {
      name: 'EMDO plus Finance',
      input: {
        finance: { readiness: async () => ({ status: 'ready' as const }) },
      },
      agents: ['manager', 'finance'],
      capabilities: ['agent.finance.delegate'],
    },
    {
      name: 'EMDO plus Scheduler and Finance',
      input: {
        scheduler: { readiness: async () => ({ status: 'ready' as const }) },
        finance: { readiness: async () => ({ status: 'ready' as const }) },
      },
      agents: ['manager', 'scheduler', 'finance'],
      capabilities: ['agent.scheduler.delegate', 'agent.finance.delegate'],
    },
  ])(
    'builds the finite $name startup combination',
    ({ input, agents, capabilities }) => {
      const profile = createAvailableRegisteredAgentProfile(input);
      expect([
        profile.manager.manifest.id,
        ...profile.specialists.map(({ manifest }) => manifest.id),
      ]).toEqual(agents);
      expect(profile.manager.manifest.capabilityAllowlist).toEqual(
        capabilities,
      );
      expect(profile.registrations.map(({ id }) => id)).toEqual(
        agents.slice(1),
      );
    },
  );
});
