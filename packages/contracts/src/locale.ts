import { z } from 'zod';

/** Exact response locales supported by the EMDO application. */
export const SupportedLocaleSchema = z.enum([
  'en-CA',
  'fr-CA',
  'ja-JP',
  'ko-KR',
]);

export type SupportedLocale = z.output<typeof SupportedLocaleSchema>;
