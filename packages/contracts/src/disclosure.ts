import { z } from 'zod';

import {
  DataClassSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  SchemaVersionSchema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly,
} from './capability.js';

const DisclosureRecordSchema = z
  .strictObject({
    dataClass: DataClassSchema,
    recordId: OpaqueReferenceSchema,
    fields: z.array(IdentifierSchema).min(1).max(128),
  })
  .superRefine((value, context) => {
    if (new Set(value.fields).size !== value.fields.length) {
      context.addIssue({
        code: 'custom',
        path: ['fields'],
        message: 'Disclosure fields must not contain duplicates',
      });
    }
  });

const DataDisclosureGrantBaseSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    id: UuidSchema,
    version: z.number().int().positive(),
    userId: UuidSchema,
    householdId: UuidSchema,
    agentId: IdentifierSchema,
    purpose: z.string().trim().min(3).max(500),
    runId: UuidSchema,
    recordAllowlist: z.array(DisclosureRecordSchema).min(1).max(256),
    provider: IdentifierSchema,
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    oneRunOnly: z.literal(true),
  })
  .superRefine((value, context) => {
    const createdAt = Date.parse(value.createdAt);
    const expiresAt = Date.parse(value.expiresAt);
    if (expiresAt <= createdAt) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Disclosure expiry must be after creation',
      });
    }

    const recordKeys = value.recordAllowlist.map(
      (record) => `${record.dataClass}:${record.recordId}`,
    );
    if (new Set(recordKeys).size !== recordKeys.length) {
      context.addIssue({
        code: 'custom',
        path: ['recordAllowlist'],
        message: 'Disclosure record allowlist contains a duplicate',
      });
    }
  });

export const DataDisclosureGrantSchema =
  DataDisclosureGrantBaseSchema.transform(deepFreeze);

export type DataDisclosureGrant = DeepReadonly<
  z.input<typeof DataDisclosureGrantBaseSchema>
>;
