import { describe, expect, it, vi } from 'vitest';

import { createExperienceApiClient } from './experience-api.js';

describe('experience API client transport', () => {
  it('invokes an injected native-compatible fetch with the global receiver', async () => {
    const fetcher = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            date: '2026-08-10',
            timezone: 'America/Toronto',
            schedule: { status: 'available', items: [] },
            reminders: { status: 'available', items: [] },
            notifications: { status: 'available', items: [] },
            finance: {
              status: 'available',
              budgetCount: 0,
              transactionCount: 0,
            },
            shopping: {
              status: 'available',
              itemCount: 0,
              retailerCount: 0,
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    }) as unknown as typeof fetch;

    await expect(
      createExperienceApiClient({ fetcher }).readToday({ date: '2026-08-10' }),
    ).resolves.toMatchObject({ date: '2026-08-10' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
