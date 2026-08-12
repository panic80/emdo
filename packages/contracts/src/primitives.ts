import { z } from 'zod';

export type DeepReadonly<T> = T extends
  null | undefined | string | number | boolean | bigint | symbol
  ? T
  : T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

export const deepFreeze = <T>(value: T): DeepReadonly<T> => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }

  return value as DeepReadonly<T>;
};

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const SchemaVersionSchema = z.literal(1);

export const IdentifierSchema = z
  .string()
  .min(2)
  .max(160)
  .regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    'Identifier must contain only lowercase segments',
  );

export const OpaqueReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      }),
    'Opaque reference contains control characters',
  );

export const SemanticVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Expected a semantic version');

export const UuidSchema = z.uuid();

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA-256 digest');

export const IdempotencyKeySchema = z
  .string()
  .min(16)
  .max(200)
  .regex(/^[A-Za-z0-9:._-]+$/, 'Invalid idempotency key');

export const HttpsUrlSchema = z
  .url()
  .refine(
    (value) => new URL(value).protocol === 'https:',
    'Expected an HTTPS URL',
  );

export const VersionedSchemaReferenceSchema = z
  .strictObject({
    id: IdentifierSchema,
    version: SemanticVersionSchema,
  })
  .transform(deepFreeze);

export type VersionedSchemaReference = DeepReadonly<
  z.input<typeof VersionedSchemaReferenceSchema>
>;
