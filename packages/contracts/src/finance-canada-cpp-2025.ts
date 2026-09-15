import { z } from 'zod';
const amount = z.string().regex(/^(0|[1-9][0-9]{0,25})(\.[0-9]{1,2})?$/);
const signedAmount = z
  .string()
  .regex(/^-?(0|[1-9][0-9]{0,25})(\.[0-9]{1,2})?$/);
const month = z.number().int().min(1).max(12);
const electionChange = z.discriminatedUnion('channel', [
  z.strictObject({
    channel: z.literal('cpt30'),
    deliveredToEmployerDate: z.iso.date(),
    completedAndSentToCra: z.boolean(),
  }),
  z.strictObject({
    channel: z.literal('schedule8'),
    effectiveMonth: month,
    madeByJune152027: z.boolean(),
  }),
]);
/** Required source facts, not an invitation for a model to infer elections or pensionable earnings. */
export const FinanceCanadaCpp2025InputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  year: z.literal(2025),
  currency: z.literal('CAD'),
  residentProvinceOnDecember31: z.enum([
    'AB',
    'BC',
    'MB',
    'NB',
    'NL',
    'NS',
    'NT',
    'NU',
    'ON',
    'PE',
    'SK',
    'YT',
    'QC',
  ]),
  domesticCase: z.boolean(),
  hasQuebecEarnedIncome: z.boolean(),
  hasQppContributions: z.boolean(),
  dateOfBirth: z.iso.date(),
  dateOfDeath: z.iso.date().nullable(),
  disabilityPensionMonths: z
    .array(month)
    .max(12)
    .refine((value) => new Set(value).size === value.length),
  retirementPensionStartDate: z.iso.date().nullable(),
  election: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({ kind: z.literal('stop-in-2025'), change: electionChange }),
    z.strictObject({
      kind: z.literal('prior-stop'),
      priorElectionValid: z.boolean(),
      revocation: electionChange.nullable(),
    }),
  ]),
  basicExemption: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('published-table') }),
    z.strictObject({
      kind: z.literal('cra-determined'),
      amount,
      reference: z.string().trim().min(1).max(200),
    }),
  ]),
  t4Slips: z
    .array(
      z.strictObject({
        reference: z.string().trim().min(1).max(200),
        box14: amount,
        box26: amount.nullable(),
        box16: amount,
        box16A: amount,
      }),
    )
    .max(100),
  annualNetSelfEmploymentEarnings: signedAmount,
  otherEarningsElection: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({
      kind: z.literal('cpt20'),
      completed: z.boolean(),
      reference: z.string().trim().min(1).max(200),
      earningsNotOnT4: amount,
      earningsOnT4: amount,
    }),
  ]),
});
export type FinanceCanadaCpp2025Input = z.infer<
  typeof FinanceCanadaCpp2025InputSchema
>;
