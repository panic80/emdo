import { z } from 'zod';

import {
  CadMoneySchema,
  HttpsUrlSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  OpaqueReferenceSchema,
  SchemaVersionSchema,
  deepFreeze,
  type DeepReadonly,
} from './capability.js';

const MerchantSchema = z.strictObject({
  id: OpaqueReferenceSchema,
  name: z.string().trim().min(1).max(200),
});

const ProductSchema = z.strictObject({
  id: OpaqueReferenceSchema,
  title: z.string().trim().min(1).max(500),
});

const VariantSchema = z.strictObject({
  id: OpaqueReferenceSchema,
  title: z.string().trim().min(1).max(500),
});

const ShippingSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('known'),
    minorUnits: z.number().int().safe().nonnegative(),
    currency: z.literal('CAD'),
  }),
  z.strictObject({
    status: z.literal('unknown'),
    reason: z.string().trim().min(1).max(300),
  }),
]);

const AvailabilityScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('online') }),
  z.strictObject({
    kind: z.literal('postal-code'),
    postalCode: z
      .string()
      .regex(/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/, 'Expected a Canadian postal code'),
  }),
  z.strictObject({ kind: z.literal('store'), storeId: IdentifierSchema }),
]);

const CommerceOfferBaseSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    id: IdentifierSchema,
    version: z.number().int().positive(),
    provider: IdentifierSchema,
    merchant: MerchantSchema,
    product: ProductSchema,
    variant: VariantSchema,
    price: CadMoneySchema,
    shipping: ShippingSchema,
    availabilityScope: AvailabilityScopeSchema,
    sourceUrl: HttpsUrlSchema,
    upstreamAt: IsoDateTimeSchema,
    fetchedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    comparisonPermission: z.enum(['allowed', 'not-authorized', 'unavailable']),
  })
  .superRefine((value, context) => {
    const upstreamAt = Date.parse(value.upstreamAt);
    const fetchedAt = Date.parse(value.fetchedAt);
    const expiresAt = Date.parse(value.expiresAt);
    if (upstreamAt > fetchedAt || fetchedAt > expiresAt) {
      context.addIssue({
        code: 'custom',
        path: ['fetchedAt'],
        message: 'Offer freshness chronology is invalid',
      });
    }
  });

export const CommerceOfferSchema =
  CommerceOfferBaseSchema.transform(deepFreeze);
export type CommerceOffer = DeepReadonly<
  z.input<typeof CommerceOfferBaseSchema>
>;
