import { z } from 'zod';
import { deepFreeze, type FinanceTaxIntake } from '@emdo/contracts';
import {
  prepareUs2025ReviewBundle,
  usReviewContentHash,
} from '../review-bundle.js';
import { roundUsdLine, usdCents } from '../rounding.js';
import { NY_2025_SOURCES } from './sources.js';
import { NY_FIELD_CATALOG } from './physical-fields.js';
import { nyPhysicalFieldDecision } from './physical-fields.js';
export const NY_IT2_BINDING_VERSION = '2025.3-physical-wage-bindings';
const text = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => ![...value].some((char) => char.charCodeAt(0) < 32));
const amount = z.string().refine((value) => {
  try {
    usdCents(value);
    return true;
  } catch {
    return false;
  }
});
/** Server-resolved approved extraction fields from the SAME terminal wage artifact.
 * Nullable/empty groups are explicit; never infer missing W-2 fields as zero.
 */
export const NyReviewedWageSupplementSchema = z.strictObject({
  artifactId: z.uuid(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  reviewedBy: text,
  reviewedAt: z.iso.datetime(),
  employeeSsn: z.string().regex(/^\d{9}$/),
  employerEin: z.string().regex(/^\d{9}$/),
  employer: z.strictObject({
    name: text.max(138),
    street: text.max(60),
    city: text.max(22),
    state: z.string().regex(/^[A-Z]{2}$/),
    zip: z.string().regex(/^\d{5}(?:-\d{4})?$/),
    country: z.literal('US'),
  }),
  box8: amount,
  box10: amount,
  box11: amount,
  box12: z
    .array(z.strictObject({ code: z.string().regex(/^[A-Z]{1,2}$/), amount }))
    .max(40),
  box14: z.array(z.strictObject({ description: text.max(20), amount })).max(40),
  box13: z.strictObject({
    statutoryEmployee: z.boolean(),
    retirementPlan: z.boolean(),
    thirdPartySickPay: z.boolean(),
  }),
  newYork: z.strictObject({ wages: amount, withheld: amount }).nullable(),
  otherState: z
    .strictObject({
      state: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .refine((value) => value !== 'NY'),
      wages: amount,
      withheld: amount,
    })
    .nullable(),
  localities: z
    .array(
      z.strictObject({
        name: z.enum(['NYC', 'Yonkers']),
        wages: amount,
        withheld: amount,
      }),
    )
    .max(2),
});
export type NyReviewedWageSupplement = z.infer<
  typeof NyReviewedWageSupplementSchema
>;
/** Pure trusted-service composition: checks original bytes/scope via federal bundle,
 * then source-bound IT-2 copies. Server must authorize and approve supplement extraction;
 * fields supplied by a browser are not approved metadata merely by satisfying this schema.
 */
export function prepareNyIt2Bundle(
  intake: FinanceTaxIntake,
  trusted: Parameters<typeof prepareUs2025ReviewBundle>[1],
  artifacts: Parameters<typeof prepareUs2025ReviewBundle>[2],
  rawSupplements: readonly NyReviewedWageSupplement[],
) {
  const federal = prepareUs2025ReviewBundle(intake, trusted, artifacts);
  if (!federal.attachmentBindingsComplete)
    throw new Error('ny-it2-federal-evidence-unbound');
  const supplements = z
    .array(NyReviewedWageSupplementSchema)
    .max(100)
    .parse(rawSupplements);
  if (
    new Set(supplements.map((entry) => entry.artifactId)).size !==
    supplements.length
  )
    throw new Error('ny-it2-duplicate-supplement');
  if (
    supplements.length !== federal.effectiveWageArtifactIds.length ||
    supplements.some(
      (entry) => !federal.effectiveWageArtifactIds.includes(entry.artifactId),
    )
  )
    throw new Error('ny-it2-missing-or-unselected-artifact');
  const ssn = intake.facts.find((fact) => fact.key === 'identity.ssn')?.value
    .value;
  const records: {
    sourceArtifactId: string;
    sourceContentHash: string;
    sourceReview: { reviewedBy: string; reviewedAt: string };
    continuation: boolean;
    employeeSsn: string;
    employerEin: string;
    employer: NyReviewedWageSupplement['employer'];
    box12: NyReviewedWageSupplement['box12'];
    box14: NyReviewedWageSupplement['box14'];
    main: null | {
      box1: string;
      box8: string;
      box10: string;
      box11: string;
      box13: NyReviewedWageSupplement['box13'];
      corrected: boolean;
      newYork: NyReviewedWageSupplement['newYork'];
      otherState: NyReviewedWageSupplement['otherState'];
      localities: NyReviewedWageSupplement['localities'];
    };
  }[] = [];
  for (const id of federal.effectiveWageArtifactIds) {
    const document = federal.wageManifest.artifacts.find(
      (entry) => entry.artifactId === id,
    )!;
    const supplement = supplements.find((entry) => entry.artifactId === id)!;
    if (
      document.contentHash !== supplement.contentHash ||
      supplement.employeeSsn !== ssn
    )
      throw new Error('ny-it2-source-identity-mismatch');
    if (
      new Set(supplement.localities.map((entry) => entry.name)).size !==
      supplement.localities.length
    )
      throw new Error('ny-it2-duplicate-locality');
    const count = Math.max(
      1,
      Math.ceil(supplement.box12.length / 4),
      Math.ceil(supplement.box14.length / 4),
    );
    for (let index = 0; index < count; index++) {
      const row = {
        sourceArtifactId: id,
        sourceContentHash: document.contentHash,
        sourceReview: {
          reviewedBy: supplement.reviewedBy,
          reviewedAt: supplement.reviewedAt,
        },
        continuation: index > 0,
        employeeSsn: supplement.employeeSsn,
        employerEin: supplement.employerEin,
        employer: supplement.employer,
        box12: supplement.box12
          .slice(index * 4, index * 4 + 4)
          .map((item) => ({ ...item, amount: roundUsdLine([item.amount]) })),
        box14: supplement.box14
          .slice(index * 4, index * 4 + 4)
          .map((item) => ({ ...item, amount: roundUsdLine([item.amount]) })),
        main:
          index === 0
            ? {
                box1: roundUsdLine([document.boxes.box1]),
                box8: roundUsdLine([supplement.box8]),
                box10: roundUsdLine([supplement.box10]),
                box11: roundUsdLine([supplement.box11]),
                box13: supplement.box13,
                corrected: document.form === 'W-2c',
                newYork: supplement.newYork
                  ? {
                      wages: roundUsdLine([supplement.newYork.wages]),
                      withheld: roundUsdLine([supplement.newYork.withheld]),
                    }
                  : null,
                otherState: supplement.otherState
                  ? {
                      state: supplement.otherState.state,
                      wages: roundUsdLine([supplement.otherState.wages]),
                      withheld: roundUsdLine([supplement.otherState.withheld]),
                    }
                  : null,
                localities: supplement.localities.map((item) => ({
                  ...item,
                  wages: roundUsdLine([item.wages]),
                  withheld: roundUsdLine([item.withheld]),
                })),
              }
            : null,
      };
      records.push(row);
    }
  }
  const pages = [];
  for (let index = 0; index < records.length; index += 2)
    pages.push({
      page: pages.length + 1,
      records: records.slice(index, index + 2),
      physicalFields: NY_FIELD_CATALOG.filter(
        (field) => field.formId === 'IT-2',
      ).map((field) => {
        const match = /^(.*)\.([01])$/.exec(field.fieldId);
        const record = match ? records[index + Number(match[2])] : undefined;
        const key = match?.[1];
        const utility = /^(BT|WATERMARK|UF_|printlid|VERCTRL|PRINTCODE)/.test(
          field.fieldId,
        );
        if (utility)
          return nyPhysicalFieldDecision(
            'IT-2',
            field.fieldId,
            null,
            'Published renderer utility; not a taxpayer return datum',
          );
        if (!record)
          return nyPhysicalFieldDecision(
            'IT-2',
            field.fieldId,
            null,
            'Unused second record slot on this whole IT-2 page',
          );
        const values: Record<string, string | null> = {
          TP_SSN: record.employeeSsn,
          EMP_SSN: record.employerEin,
          EMP_NAME: record.employer.name,
          EMP_ADDRESS: record.employer.street,
          EMP_CITY: record.employer.city,
          EMP_STATE: record.employer.state,
          EMP_ZIP: record.employer.zip.replace('-', ''),
          EMP_COUNTRYCB: record.employer.country,
          LN1_AMT: record.main?.box1 ?? null,
          LN8_AMT: record.main?.box8 ?? null,
          LN10_AMT: record.main?.box10 ?? null,
          LN11_AMT: record.main?.box11 ?? null,
          LN13_0_CBX: record.main?.box13.statutoryEmployee ? 'X' : null,
          LN13_1_CBX: record.main?.box13.retirementPlan ? 'X' : null,
          LN13_2_CBX: record.main?.box13.thirdPartySickPay ? 'X' : null,
          W2c_CBX: record.main?.corrected ? 'X' : null,
          LN16a_AMT: record.main?.newYork?.wages ?? null,
          LN17a_AMT: record.main?.newYork?.withheld ?? null,
          LN15b_STATE: record.main?.otherState?.state ?? null,
          LN16b_AMT: record.main?.otherState?.wages ?? null,
          LN17b_AMT: record.main?.otherState?.withheld ?? null,
        };
        for (let item = 0; item < 4; item++) {
          const letter = 'abcd'[item]!;
          values[`LN12${letter}_AMT`] = record.box12[item]?.amount ?? null;
          values[`LN12${letter}_CODE`] = record.box12[item]?.code ?? null;
          values[`LN14${letter}_AMTNEG`] = record.box14[item]?.amount ?? null;
          values[`LN14${letter}_DESC`] =
            record.box14[item]?.description ?? null;
        }
        for (let item = 0; item < 2; item++) {
          const letter = 'ab'[item]!;
          values[`LN18${letter}_AMT`] =
            record.main?.localities[item]?.wages ?? null;
          values[`LN19${letter}_AMT`] =
            record.main?.localities[item]?.withheld ?? null;
          values[`LN20${letter}_DESC`] =
            record.main?.localities[item]?.name ?? null;
        }
        if (!key || !(key in values))
          throw new Error(`ny-it2-unmapped-field:${field.fieldId}`);
        return nyPhysicalFieldDecision(
          'IT-2',
          field.fieldId,
          values[key]!,
          values[key] === null
            ? record.continuation
              ? 'Continuation repeats identity and box12/14 overflow only; wages and withholding must not be duplicated'
              : 'Explicit reviewed absent group or unchecked box'
            : `Approved effective wage artifact ${record.sourceArtifactId}; ${record.continuation ? 'continuation' : 'primary'} record`,
        );
      }),
    });
  const totals = { state: 0n, NYC: 0n, Yonkers: 0n };
  for (const record of records)
    if (record.main) {
      totals.state += BigInt(record.main.newYork?.withheld ?? '0');
      for (const local of record.main.localities)
        totals[local.name] += BigInt(local.withheld);
    }
  const content = {
    version: NY_IT2_BINDING_VERSION,
    federalBundleHash: federal.bundleHash,
    binding: federal.snapshot,
    supplements,
    pages,
    totals: {
      stateWithholding: totals.state.toString(),
      cityWithholding: totals.NYC.toString(),
      yonkersWithholding: totals.Yonkers.toString(),
    },
    source: NY_2025_SOURCES.find((entry) => entry.id === 'ny-2025-it2')!,
    authorityLocator:
      'IT-2 front/back: one record per statement, continuation for >4 box12/14 items; do not repeat wage/withholding fields; 2records per whole page',
  };
  return deepFreeze({
    ...content,
    contentHash: usReviewContentHash(content),
    complete: false as const,
  });
}
