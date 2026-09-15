import { z } from 'zod';

/** A reviewed mapping revision selects legal labels; amounts remain ledger-owned. */
export const FinanceFecExportRequestSchema = z
  .strictObject({
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
    mappingRevision: z.number().int().positive().max(2_147_483_647),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
  })
  .superRefine((value, context) => {
    if (value.startsOn > value.endsOn)
      context.addIssue({
        code: 'custom',
        path: ['endsOn'],
        message: 'The export end date must not precede its start date',
      });
  });

export type FinanceFecExportRequest = z.infer<
  typeof FinanceFecExportRequestSchema
>;

const FecText = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    // eslint-disable-next-line no-control-regex -- FEC text must reject control characters.
    .regex(/^[^\u0000-\u001f\u007f]*$/u);
const FecSource = z.strictObject({
  sourceReference: FecText(500),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
/** Reviewed legal metadata only. Reviewer identity/time and ledger values are server-owned. */
export const FinanceFecMappingCreateSchema = z
  .strictObject({
    expectedRevision: z.number().int().nonnegative().max(2_147_483_646),
    siren: z.string().regex(/^[0-9]{9}$/u),
    sirenSource: FecSource,
    openingBalances: z.strictObject({
      status: z.enum(['included', 'not-applicable']),
      source: FecSource,
    }),
    journals: z
      .array(
        z.strictObject({
          journalId: z.uuid(),
          entrySequence: z.number().int().positive().max(2_147_483_647),
          entryNumber: FecText(200),
          entryKind: z.enum(['opening', 'normal', 'inventory']),
          journalCode: FecText(200),
          journalLabel: FecText(500),
          pieceReference: FecText(500),
          pieceDate: z.iso.date(),
          entryLabel: FecText(2000),
          validationDate: z.iso.date(),
        }),
      )
      .max(10000),
    accounts: z
      .array(
        z.strictObject({
          accountId: z.uuid(),
          accountNumber: FecText(100).regex(/^[0-9]{3}/u),
          accountLabel: FecText(500),
          auxiliary: z
            .strictObject({ number: FecText(100), label: FecText(500) })
            .nullable(),
        }),
      )
      .max(10000),
  })
  .superRefine((value, context) => {
    for (const [field, identities] of [
      ['journals', value.journals.map((row) => row.journalId)],
      ['journals', value.journals.map((row) => String(row.entrySequence))],
      ['accounts', value.accounts.map((row) => row.accountId)],
    ] as const) {
      if (new Set(identities).size !== identities.length)
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Mapping identities and entry sequences must be unique',
        });
    }
  });
export type FinanceFecMappingCreate = z.infer<
  typeof FinanceFecMappingCreateSchema
>;
