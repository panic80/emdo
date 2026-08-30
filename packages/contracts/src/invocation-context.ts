import { z } from 'zod';

import {
  IdentifierSchema,
  IsoDateTimeSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly,
} from './capability.js';
import { SupportedLocaleSchema } from './locale.js';

const ContextReferenceSchema = z.string().regex(/^context-ref-[a-f0-9]{64}$/);

const isSortedUnique = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || values[index - 1]! < value);

const AgentInvocationContextBaseSchema = z
  .strictObject({
    orchestrationRunId: UuidSchema,
    parentInvocationId: UuidSchema,
    agentInvocationId: UuidSchema,
    phaseInvocationId: UuidSchema,
    actorId: UuidSchema,
    locale: SupportedLocaleSchema,
    grantedCapabilities: z.array(IdentifierSchema).max(128),
    disclosedContextRefs: z.array(ContextReferenceSchema).max(256),
    deadline: IsoDateTimeSchema,
    idempotencyScope: Sha256Schema,
  })
  .superRefine((value, context) => {
    for (const [path, values] of [
      ['grantedCapabilities', value.grantedCapabilities],
      ['disclosedContextRefs', value.disclosedContextRefs],
    ] as const) {
      if (!isSortedUnique(values)) {
        context.addIssue({
          code: 'custom',
          path: [path],
          message: `${path} must be sorted and contain no duplicates`,
        });
      }
    }
    if (
      new Set([
        value.parentInvocationId,
        value.agentInvocationId,
        value.phaseInvocationId,
      ]).size !== 3
    ) {
      context.addIssue({
        code: 'custom',
        path: ['phaseInvocationId'],
        message: 'Invocation lineage identifiers must be distinct',
      });
    }
  });

/** Server-minted, bounded authority and lineage for one agent phase. */
export const AgentInvocationContextSchema =
  AgentInvocationContextBaseSchema.transform(deepFreeze);

export type AgentInvocationContext = DeepReadonly<
  z.output<typeof AgentInvocationContextBaseSchema>
>;
