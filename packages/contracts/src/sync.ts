import { z } from 'zod';

import {
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  OpaqueReferenceSchema,
  SchemaVersionSchema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly,
} from './primitives.js';

const SyncMutationSchema = z.strictObject({
  kind: z.enum(['create', 'update', 'delete', 'delta']),
  payload: JsonValueSchema,
});

const SyncOperationBaseSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  clientId: UuidSchema,
  operationId: UuidSchema,
  entity: z.strictObject({
    type: IdentifierSchema,
    id: OpaqueReferenceSchema,
  }),
  mutation: SyncMutationSchema,
  baseRevision: z.number().int().nonnegative(),
  dependencies: z.array(UuidSchema).max(128),
  actorIntent: z.string().trim().min(3).max(1000),
  createdAt: IsoDateTimeSchema,
});

export const SyncOperationSchema =
  SyncOperationBaseSchema.transform(deepFreeze);
export type SyncOperation = DeepReadonly<
  z.input<typeof SyncOperationBaseSchema>
>;
