import {
  CanadaCorporate2025IntakeSchema,
  T2_2025_ADDITIONAL_SCHEDULE_TRIGGERS,
  T2_2025_EXPENSE_CODES,
  CORPORATE_PRIVATE_QUESTIONS,
  type CanadaCorporate2025Intake,
} from '@emdo/domains/finance';
export function corporateFixture(): CanadaCorporate2025Intake {
  return CanadaCorporate2025IntakeSchema.parse({
    schemaVersion: 1,
    currency: 'CAD',
    binding: {
      caseId: '55d9f01c-993c-4e3b-89d5-509c9cc1d430',
      snapshotRevision: 7,
      snapshotHash: 'a'.repeat(64),
    },
    sourceReferences: [
      { id: 'synthetic-financial-statements', sha256: 'b'.repeat(64) },
    ],
    identity: {
      legalName: 'Synthetic Review Services Inc.',
      legalNameContinuation: null,
      operatingName: 'Synthetic Review Services',
      businessNumber: '123456789RC0001',
      taxYearStart: '2025-01-01',
      taxYearEnd: '2025-12-31',
      province: 'ON',
      headOffice: {
        street: '1 Synthetic Street',
        city: 'Toronto',
        postalCode: 'M1A1A1',
      },
      addressesUnchangedAndSame: true,
      naics: '541611',
      activity: 'Management consulting services',
      principalActivityRevenuePercentage: '100',
      otherPrincipalActivities: [],
      shareholder: {
        name: 'Synthetic Owner',
        socialInsuranceNumber: '000000000',
        commonSharePercentage: '100',
        preferredSharePercentage: '0',
      },
      signingOfficer: {
        firstName: 'Synthetic',
        lastName: 'Owner',
        position: 'President',
        telephone: '4165550100',
        contactIsSigningOfficer: true,
      },
      correspondenceLanguage: 'en',
    },
    declarations: Object.fromEntries(
      Object.keys(CanadaCorporate2025IntakeSchema.shape.declarations.shape).map(
        (key) => [key, true],
      ),
    ),
    additionalInformation: {
      usesIfrs: false,
      taxExemptUnderSection149: false,
      quarterlyEligibilityCeasedOn: null,
      refundPreference: null,
      constructionIsMajorBusinessActivity: false,
      constructionSubcontractors: false,
      quarterlyInstalmentRemitterRequested: false,
    },
    attachmentAnswers: Object.fromEntries(
      Object.keys(T2_2025_ADDITIONAL_SCHEDULE_TRIGGERS).map((key) => [
        key,
        false,
      ]),
    ),
    priorYear: {
      refundableTaxHistory: {
        eligibleRdToh: '0',
        nonEligibleRdToh: '0',
        eligibleDividendRefund: '0',
        nonEligibleDividendRefund: '0',
        sourceReferenceId: 'synthetic-financial-statements',
      },
      taxableCapitalEmployedCanada: '100000',
      adjustedAggregateInvestmentIncome: '0',
      taxableIncome: '100000',
      businessLimit: '500000',
      federalSmallBusinessDeductionClaimed: true,
    },
    financialStatements: {
      incomeStatementActivity: 'non-farming',
      otherComprehensiveIncome: '0',
      costOfSales: { '8320': '0', '8340': '0', '8360': '0' },
      opening: {
        '1001': '10100',
        '1060': '0',
        '1483': '0',
        '2621': '0',
        '2680': '0',
        '3500': '100',
        '3600': '10000',
      },
      closing: {
        '1001': '110100',
        '1060': '0',
        '1483': '0',
        '2621': '0',
        '2680': '12200',
        '3500': '100',
        '3600': '97800',
      },
      tradeSales: '150000',
      operatingExpenses: {
        ...Object.fromEntries(T2_2025_EXPENSE_CODES.map((k) => [k, '0'])),
        '9060': '50000',
      },
      currentIncomeTaxProvision: '12200',
      notes: [
        'Synthetic fixture: ordinary accrual accounting; all amounts exclude recoverable HST.',
      ],
    },
    gifi141: {
      primaryPreparerIdentified: true,
      primaryPreparerAccountingDesignation: false,
      primaryPreparerConnected: true,
      involvement: ['304'],
      involvementOther: null,
      reservation: null,
      subsequentEvents: false,
      assetsRevalued: false,
      contingentLiabilities: false,
      commitments: false,
      jointVenturesOrPartnerships: false,
      impairmentOrFairValueChanges: false,
      financialInstrumentsDerecognized: false,
      hedgeAccountingApplied: false,
      hedgeAccountingDiscontinued: false,
      openingEquityAdjustment: false,
      returnPreparerIsPrimaryPreparer: true,
      returnPreparerAccountingDesignation: false,
      returnPreparerInputs: [],
      returnPreparerOther: null,
    },
    taxWithholding: { amount: '0', payments: '0', sourceReferenceId: null },
    taxInstalmentsPaid: '10000',
  });
}

export function corporateFixtureValues() {
  const fixture = corporateFixture();
  return CORPORATE_PRIVATE_QUESTIONS.map((q) => {
    const path = q.key.replace(/^corporate\./, '').split('.');
    let value: unknown = fixture;
    for (const part of path) value = (value as Record<string, unknown>)[part];
    return {
      key: q.key,
      value: {
        type: q.type,
        value:
          value === null
            ? 'none'
            : Array.isArray(value)
              ? JSON.stringify(value)
              : q.type === 'text'
                ? String(value)
                : value,
      },
    };
  });
}
