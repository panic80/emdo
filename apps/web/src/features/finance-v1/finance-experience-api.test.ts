import { afterEach, describe, expect, it, vi } from 'vitest';

import { readFinanceExperience } from './finance-experience-api.js';

function experienceResponse(input: {
  readonly totalCount: number;
  readonly budgetCount: number;
  readonly labelLength?: number;
}): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
      locale: 'en-CA',
      connectivity: 'online',
      quota: {
        documentsUsed: 0,
        documentsLimit: 10_000,
        bytesUsed: 0,
        bytesLimit: 50 * 1024 * 1024 * 1024,
      },
      reviewedCadTotals: Array.from(
        { length: input.totalCount },
        (_value, index) => ({
          label:
            index === 0 && input.labelLength !== undefined
              ? 'x'.repeat(input.labelLength)
              : `Total ${index + 1}`,
          amountCadMinor: index,
        }),
      ),
      recentActivity: [],
      budgets: Array.from({ length: input.budgetCount }, (_value, index) => ({
        id: `budget-${index + 1}`,
        label:
          index === 0 && input.labelLength !== undefined
            ? 'x'.repeat(input.labelLength)
            : `Budget ${index + 1}`,
        allocatedCadMinor: index,
      })),
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Finance experience browser parser', () => {
  it('accepts the exact v1 response bound of one thousand totals and budgets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        experienceResponse({ totalCount: 1_000, budgetCount: 1_000 }),
      ),
    );

    const experience = await readFinanceExperience('en-CA');

    expect(experience.reviewedCadTotals).toHaveLength(1_000);
    expect(experience.budgets).toHaveLength(1_000);
  });

  it('accepts the shared 512-character category-label bound', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        experienceResponse({
          totalCount: 1,
          budgetCount: 1,
          labelLength: 512,
        }),
      ),
    );

    const experience = await readFinanceExperience('en-CA');

    expect(experience.reviewedCadTotals[0]?.label).toHaveLength(512);
    expect(experience.budgets[0]?.label).toHaveLength(512);
  });

  it.each([
    ['reviewed CAD totals', { totalCount: 1_001, budgetCount: 1_000 }],
    ['budgets', { totalCount: 1_000, budgetCount: 1_001 }],
  ])('rejects more than one thousand %s', async (_label, counts) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => experienceResponse(counts)),
    );

    await expect(readFinanceExperience('en-CA')).rejects.toThrow(
      'Finance experience is unavailable.',
    );
  });
});
