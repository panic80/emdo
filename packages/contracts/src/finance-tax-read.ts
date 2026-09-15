import { z } from 'zod';
export const FinanceTaxReadInputSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    view: z.enum(['list', 'read', 'assess', 'runs', 'run']),
    caseId: z.uuid().nullable(),
    runId: z.uuid().nullable().optional(),
    revision: z.number().int().positive().max(2147483647).optional(),
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .refine((input) => (input.view === 'run') === (input.runId != null), {
    message: 'An explicit run ID is required only for a working-paper run read',
  })
  .refine((input) => (input.view === 'list') === (input.caseId === null), {
    message: 'Explicit private tax case required for read and assessment',
  })
  .refine((input) => input.revision === undefined || input.view === 'read', {
    message: 'Snapshot revision applies only to case reads',
  });
export const FinanceTaxReadOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  view: z.enum(['list', 'read', 'assess', 'runs', 'run']),
  caseId: z.uuid().nullable(),
  status: z.enum(['incomplete', 'ready-for-calculation']),
  complete: z.literal(false),
  records: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        kind: z.enum([
          'run-summary',
          'run-output',
          'run-issue',
          'run-blocker',
          'run-field',
          'run-review',
          'run-authority',
          'run-input-binding',
          'case-summary',
          'case',
          'question',
          'answer',
          'intake-fact',
          'declared-input',
          'withdrawn-answer',
          'related-party',
          'assessment-issue',
        ]),
        fields: z
          .array(
            z.strictObject({
              name: z.string().min(1),
              value: z.string().nullable(),
            }),
          )
          .max(64),
      }),
    )
    .max(100),
  nextOffset: z.number().int().min(0).max(100000).nullable(),
  truncated: z.boolean(),
  snapshotRevision: z.number().int().positive().nullable(),
  snapshotHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  sourceReferences: z.array(z.string()).max(100),
  coverage: z.enum(['private-tax-case-snapshot', 'private-tax-working-papers']),
});
