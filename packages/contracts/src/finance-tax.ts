import { z } from 'zod';
import { UuidSchema } from './primitives.js';

const Key = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Text = z.string().trim().min(1).max(2000);
export const FinanceTaxCountrySchema = z.enum([
  'CA',
  'US',
  'MX',
  'DE',
  'KR',
  'JP',
  'FR',
]);
export const FinanceTaxTaxpayerTypeSchema = z.enum([
  'individual',
  'sole-proprietor',
  'corporation',
]);

/** No wildcard, inferred subdivision, current-year default, or latest-form fallback. */
export const FinanceTaxScopeSchema = z.strictObject({
  country: z.string().regex(/^[A-Z]{2}$/),
  subdivision: Key,
  taxpayerType: FinanceTaxTaxpayerTypeSchema,
  year: z.number().int().min(1900).max(9999),
  regime: Key,
  formVersion: Key,
});
export const FinanceTaxValueSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('decimal'),
    value: z
      .string()
      .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/)
      .max(100),
  }),
  z.strictObject({ type: z.literal('text'), value: Text }),
  z.strictObject({ type: z.literal('boolean'), value: z.boolean() }),
  z.strictObject({ type: z.literal('date'), value: z.iso.date() }),
]);
export const FinanceTaxFactSchema = z.strictObject({
  key: Key,
  value: FinanceTaxValueSchema,
  reviewState: z.enum(['unreviewed', 'reviewed', 'disputed']),
  source: z.strictObject({
    kind: z.enum(['evidence', 'declaration', 'ledger-snapshot']),
    reference: Text,
    revision: z.number().int().positive(),
    contentHash: Hash,
    sourceBookId: UuidSchema.optional(),
  }),
});
export const FinanceTaxIntakeSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    caseId: UuidSchema,
    workspaceId: UuidSchema,
    taxSubjectId: UuidSchema,
    legalEntityId: UuidSchema.nullable(),
    /** Trusted persistence must authorize each book for this subject; membership alone grants nothing. */
    sourceBooks: z
      .array(
        z.strictObject({
          bookId: UuidSchema,
          snapshotRevision: z.number().int().positive(),
          snapshotHash: Hash,
        }),
      )
      .max(100),
    revision: z.number().int().positive(),
    scope: FinanceTaxScopeSchema.partial(),
    domesticResident: z.boolean().nullable(),
    hasCrossBorderActivity: z.boolean().nullable(),
    standaloneCorporation: z.boolean().nullable(),
    requestedFeatures: z
      .array(
        z.enum([
          'income-tax-return',
          'payroll',
          'electronic-filing',
          'consolidation',
        ]),
      )
      .min(1)
      .max(4),
    facts: z.array(FinanceTaxFactSchema).max(10000),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.sourceBooks.map((book) => book.bookId)).size !==
      value.sourceBooks.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['sourceBooks'],
        message: 'Book snapshots must be unique',
      });
    for (const [index, fact] of value.facts.entries()) {
      const book = value.sourceBooks.find(
        (entry) => entry.bookId === fact.source.sourceBookId,
      );
      if (fact.source.sourceBookId && !book)
        ctx.addIssue({
          code: 'custom',
          path: ['facts', index, 'source'],
          message:
            'Fact book is outside the explicitly selected source snapshots',
        });
      if (
        fact.source.kind === 'ledger-snapshot' &&
        (!book ||
          book.snapshotRevision !== fact.source.revision ||
          book.snapshotHash !== fact.source.contentHash)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['facts', index, 'source'],
          message: 'Ledger fact must pin an exact selected book snapshot',
        });
    }
    if (
      new Set(value.facts.map((fact) => fact.key)).size !== value.facts.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['facts'],
        message: 'Tax fact keys must be unique',
      });
    if (
      new Set(value.requestedFeatures).size !== value.requestedFeatures.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['requestedFeatures'],
        message: 'Requested features must be unique',
      });
  });

export const FinanceTaxAuthorityReferenceSchema = z.strictObject({
  id: Key,
  authority: Text,
  url: z
    .url()
    .refine(
      (url) => new URL(url).protocol === 'https:',
      'Authority URL must use HTTPS',
    ),
  title: Text,
  retrievedAt: z.iso.datetime(),
  documentHash: Hash,
  locator: Text,
});
/** Build-time source review policy; never an access grant from a return-intake payload. */
export const FinanceTaxAuthoritySourceSchema = z.strictObject({
  country: FinanceTaxCountrySchema,
  subdivision: Key,
  hostname: z
    .string()
    .toLowerCase()
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
  authority: Text,
  reviewedBy: Text,
  reviewedAt: z.iso.datetime(),
  rationale: Text,
});
const Condition = z.strictObject({
  factKey: Key,
  equals: z.union([z.string(), z.boolean()]),
});
const ValueType = z.enum(['decimal', 'text', 'boolean', 'date']);
export const FinanceTaxPackageManifestSchema = z.strictObject({
  packageId: Key,
  version: Key,
  scope: FinanceTaxScopeSchema,
  engineVersion: Key,
  implementationHash: Hash,
  coverage: z.literal('full-return'),
  references: z.array(FinanceTaxAuthorityReferenceSchema).min(1).max(1000),
  rules: z
    .array(z.strictObject({ id: Key, referenceIds: z.array(Key).min(1) }))
    .min(1)
    .max(10000),
  requiredFacts: z
    .array(
      z.strictObject({ key: Key, type: ValueType, when: Condition.optional() }),
    )
    .min(1)
    .max(10000),
  forms: z
    .array(
      z.strictObject({
        id: Key,
        version: Key,
        referenceIds: z.array(Key).min(1),
        when: Condition.optional(),
        fields: z
          .array(
            z.strictObject({
              key: Key,
              type: ValueType,
              ruleIds: z.array(Key).min(1),
            }),
          )
          .min(1)
          .max(10000),
      }),
    )
    .min(1)
    .max(1000),
  validation: z.strictObject({
    reviewedBy: Text,
    reviewedAt: z.iso.datetime(),
    fullReturnCoverageAttested: z.literal(true),
    reportHash: Hash,
    fixtureIds: z.array(Key).min(1),
  }),
});
export const FinanceTaxEvaluationSchema = z.strictObject({
  forms: z
    .array(
      z.strictObject({
        id: Key,
        version: Key,
        fields: z
          .array(
            z.strictObject({
              key: Key,
              value: FinanceTaxValueSchema,
              ruleIds: z.array(Key).min(1),
              sourceFactKeys: z.array(Key),
            }),
          )
          .max(10000),
      }),
    )
    .max(1000),
  issues: z.array(z.strictObject({ code: Key, message: Text })).max(1000),
});
export const FinanceTaxRunRequestSchema = z.strictObject({
  runId: UuidSchema,
  createdAt: z.iso.datetime(),
  packageId: Key,
  packageVersion: Key,
  intake: FinanceTaxIntakeSchema,
});
export type FinanceTaxCountry = z.infer<typeof FinanceTaxCountrySchema>;
export type FinanceTaxAuthoritySource = z.infer<
  typeof FinanceTaxAuthoritySourceSchema
>;
export type FinanceTaxScope = z.infer<typeof FinanceTaxScopeSchema>;
export type FinanceTaxValue = z.infer<typeof FinanceTaxValueSchema>;
export type FinanceTaxIntake = z.infer<typeof FinanceTaxIntakeSchema>;
export type FinanceTaxPackageManifest = z.infer<
  typeof FinanceTaxPackageManifestSchema
>;
export type FinanceTaxEvaluation = z.infer<typeof FinanceTaxEvaluationSchema>;
export type FinanceTaxRunRequest = z.infer<typeof FinanceTaxRunRequestSchema>;

const Canada2025NonnegativeCad = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,14})(?:\.\d{1,2})?$/);
/** Development components only: this contract cannot request a full return or a different tax year. */
export const FinanceCanadaOntario2025ComponentInputSchema = z.strictObject({
  scope: z.strictObject({
    country: z.literal('CA'),
    subdivision: z.literal('CA-ON'),
    taxpayerType: z.literal('individual'),
    year: z.literal(2025),
    regime: z.literal('income-tax-return'),
    formVersion: z.literal('5006-R-E-25_5006-C-E-25'),
  }),
  fullYearCanadianResident: z.literal(true),
  ontarioResidentOnDecember31: z.literal(true),
  hasPermanentEstablishmentOutsideOntario: z.literal(false),
  taxableIncomeLine26000: Canada2025NonnegativeCad,
  /** The already-determined ON428 inputs, not taxable income or tax before credits. */
  ontarioSurtaxInputs: z
    .strictObject({
      line62: Canada2025NonnegativeCad,
      taxOnSplitIncomeLine54: Canada2025NonnegativeCad,
    })
    .optional(),
});
export type FinanceCanadaOntario2025ComponentInput = z.infer<
  typeof FinanceCanadaOntario2025ComponentInputSchema
>;

const Canada2025CreditContext =
  FinanceCanadaOntario2025ComponentInputSchema.pick({
    scope: true,
    fullYearCanadianResident: true,
    ontarioResidentOnDecember31: true,
    hasPermanentEstablishmentOutsideOntario: true,
  });
/** Eligible inputs must be established by their own schedules; this contract grants no eligibility. */
export const FinanceCanadaOntario2025CreditInputSchema =
  Canada2025CreditContext.extend({
    netIncomeLine23600: Canada2025NonnegativeCad,
    eligibleFederalAmountsExcludingBasicPersonalAmount:
      Canada2025NonnegativeCad,
    federalDonationsAndGiftsLine34900: Canada2025NonnegativeCad,
    federalSchedule9Line22: Canada2025NonnegativeCad,
    eligibleOntarioAmountsExcludingBasicPersonalAmount:
      Canada2025NonnegativeCad,
    ontarioDonationsAndGiftsLine58969: Canada2025NonnegativeCad,
    eligibleInputsReviewed: z.literal(true),
  });
export const FinanceCanadaOntario2025ReductionInputSchema =
  Canada2025CreditContext.extend({
    netIncomeLine23600: Canada2025NonnegativeCad,
    spouseNetIncomeLine23600: Canada2025NonnegativeCad.nullable(),
    ontarioTaxBeforeReductionLine73: Canada2025NonnegativeCad,
    additionalTaxForMinimumTaxPurposesLine72: Canada2025NonnegativeCad,
    bankruptAnyTimeDuringYear: z.boolean(),
    returnFiledByTrusteeInBankruptcy: z.boolean(),
    electsOntarioTaxReduction: z.boolean(),
    eligibleChildrenBorn2007OrLater: z.number().int().min(0).max(1000),
    eligibleDependantsWithImpairment: z.number().int().min(0).max(1000),
    /** Eligibility includes the CRA dependency tests and exclusion of claims by another person. */
    dependantEligibilityAndExclusiveClaimsReviewed: z.literal(true),
  }).superRefine((value, ctx) => {
    const cents = (amount: string) => {
      const [whole, fraction = ''] = amount.split('.');
      return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
    };
    if (
      cents(value.additionalTaxForMinimumTaxPurposesLine72) >
      cents(value.ontarioTaxBeforeReductionLine73)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['additionalTaxForMinimumTaxPurposesLine72'],
        message: 'ON428 line 73 includes line 72 and cannot be lower',
      });
  });
export type FinanceCanadaOntario2025CreditInput = z.infer<
  typeof FinanceCanadaOntario2025CreditInputSchema
>;
export type FinanceCanadaOntario2025ReductionInput = z.infer<
  typeof FinanceCanadaOntario2025ReductionInputSchema
>;
