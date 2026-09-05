import { z } from 'zod';

import type { FinanceExperienceV1 } from '@emdo/domains/finance';

import { financeLocale, type FinanceLocale } from './finance-document-api.js';

export type FinanceExperience = FinanceExperienceV1;

// See finance-document-api: the public finance barrel is not browser-safe yet.
const FinanceExperienceV1Schema = z.object({
  schemaVersion: z.literal(1),
  locale: z.enum(['en-CA', 'fr-CA', 'ja-JP', 'ko-KR']),
  connectivity: z.enum(['online', 'offline', 'unavailable']),
  quota: z.object({
    documentsUsed: z.number().int().nonnegative().max(10_000),
    documentsLimit: z.literal(10_000),
    bytesUsed: z
      .number()
      .int()
      .nonnegative()
      .max(50 * 1024 * 1024 * 1024),
    bytesLimit: z.literal(50 * 1024 * 1024 * 1024),
  }),
  reviewedCadTotals: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(512),
        amountCadMinor: z.number().int().safe(),
      }),
    )
    .max(1_000),
  recentActivity: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(512),
        label: z.string().trim().min(1).max(500),
        occurredAt: z.iso.datetime({ offset: true }),
      }),
    )
    .max(50),
  budgets: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(512),
        label: z.string().trim().min(1).max(512),
        allocatedCadMinor: z.number().int().safe(),
      }),
    )
    .max(1_000),
});

export async function readFinanceExperience(
  locale: FinanceLocale,
  signal?: AbortSignal,
): Promise<FinanceExperience> {
  const response = await fetch('/api/v1/experience/finance', {
    credentials: 'include',
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      'accept-language': locale,
    },
    ...(signal ? { signal } : {}),
  });
  if (
    !response.ok ||
    !response.headers.get('content-type')?.includes('application/json')
  ) {
    throw new Error('Finance experience is unavailable.');
  }
  const parsed = FinanceExperienceV1Schema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Finance experience is unavailable.');
  return parsed.data as FinanceExperience;
}

export function experienceLocale(
  experience: FinanceExperience | undefined,
  fallback: FinanceLocale,
): FinanceLocale {
  return financeLocale(experience?.locale) ?? fallback;
}
