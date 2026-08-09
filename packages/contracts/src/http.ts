import { z } from 'zod';

import {
  HttpsUrlSchema,
  IdentifierSchema,
  JsonValueSchema,
  deepFreeze,
  type DeepReadonly,
} from './capability.js';

const ProblemDetailsBaseSchema = z.strictObject({
  type: z.union([HttpsUrlSchema, z.literal('about:blank')]),
  title: z.string().trim().min(1).max(200),
  status: z.number().int().min(400).max(599),
  detail: z.string().trim().min(1).max(2000),
  instance: z.string().trim().min(1).max(500),
  requestId: IdentifierSchema,
  code: IdentifierSchema,
  extensions: z.record(z.string(), JsonValueSchema),
});

export const ProblemDetailsSchema =
  ProblemDetailsBaseSchema.transform(deepFreeze);
export type ProblemDetails = DeepReadonly<
  z.input<typeof ProblemDetailsBaseSchema>
>;
