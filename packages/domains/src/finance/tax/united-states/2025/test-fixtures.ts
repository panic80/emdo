/** Synthetic reviewed test data only; never a production intake default. */
import type { FinanceTaxIntake } from '@emdo/contracts';
import { US_2025_REQUIRED_FACTS, US_2025_CANDIDATE } from './workflow.js';
export function us2025TestFixture(
  overrides: Record<string, string | boolean> = {},
): FinanceTaxIntake {
  overrides = {
    'identity.firstAndMiddleName': 'Alex Q',
    'identity.lastName': 'Example',
    'identity.ssn': '123456789',
    'identity.street': '100 Example St',
    'identity.apartment': 'none',
    'identity.city': 'Albany',
    'identity.state': 'NY',
    'identity.zip': '12207',
    'identity.occupation': 'Consultant',
    'identity.phone': 'none',
    'identity.email': 'none',
    'identity.ipPin': 'none',
    'identity.birthDate': '1990-06-15',
    'business.description': 'Management consulting',
    'business.code': '541600',
    'business.separateName': 'none',
    'business.ein': 'none',
    'business.street': '100 Example St',
    'business.cityStateZip': 'Albany NY12207',
    'refund.method': 'no-direct-deposit',
    'refund.routing': 'none',
    'refund.account': 'none',
    'penalty.returnFiledOn': 'not-filed',
    'penalty.paymentLedger': JSON.stringify(
      overrides['payments.estimatedAndPriorYearApplied'] &&
        overrides['payments.estimatedAndPriorYearApplied'] !== '0'
        ? [
            {
              date: '2025-04-15',
              amount: overrides['payments.estimatedAndPriorYearApplied'],
              kind: 'estimated',
            },
          ]
        : [],
    ),
    ...overrides,
  };
  return {
    schemaVersion: 1,
    caseId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    taxSubjectId: '00000000-0000-4000-8000-000000000003',
    legalEntityId: null,
    revision: 1,
    sourceBooks: [],
    scope: { ...US_2025_CANDIDATE.scope },
    domesticResident: true,
    hasCrossBorderActivity: false,
    standaloneCorporation: null,
    requestedFeatures: ['income-tax-return'],
    facts: US_2025_REQUIRED_FACTS.map((fact) => ({
      key: fact.key,
      reviewState: 'reviewed',
      value: {
        type: fact.type,
        value:
          overrides[fact.key] ??
          ('equals' in fact
            ? fact.equals
            : fact.key === 'eic.ageBand'
              ? '25-to-64'
              : fact.type === 'boolean'
                ? true
                : '0'),
      } as FinanceTaxIntake['facts'][number]['value'],
      source: {
        kind: 'declaration',
        reference: 'Independently reviewed fixture',
        revision: 1,
        contentHash: 'a'.repeat(64),
      },
    })),
  };
}
