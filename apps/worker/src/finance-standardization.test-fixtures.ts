import { createHash } from 'node:crypto';
import {
  ProposedFinanceReportMappingSchema,
  FinanceStandardizationModelProvenanceSchema,
} from '@emdo/contracts';
export const standardizationCsv =
  'date,description,amount,currency\n2026-09-01,Payment fee included,12.50,CAD\n';
export const standardizationDigest = createHash('sha256')
  .update(standardizationCsv)
  .digest('hex');
export const standardizationProposal = ProposedFinanceReportMappingSchema.parse(
  {
    definition: {
      providerKey: 'test-bank',
      reportName: 'Bank CSV',
      reportType: 'bank-transactions',
      layoutVersion: '1',
      headers: ['date', 'description', 'amount', 'currency'],
      bindings: [
        { field: 'transactionDate', column: 'date', context: null },
        { field: 'description', column: 'description', context: null },
        { field: 'amount', column: 'amount', context: null },
        { field: 'currency', column: 'currency', context: null },
      ],
      dateFormat: 'yyyy-mm-dd',
      decimalSeparator: '.',
      groupingSeparator: '',
      quantityUnit: null,
      valuationMultiplier: null,
      identifierScheme: null,
      identifierNamespace: null,
    },
    rationale: 'The named source columns correspond to the proposed fields.',
    unresolvedQuestions: ['Confirm the source columns and date format.'],
  },
);
export const standardizationProvenance =
  FinanceStandardizationModelProvenanceSchema.parse({
    controller: 'emdo',
    orchestrationMode: 'registered-workflow',
    managerInvocationId: '00000000-0000-4000-8000-000000000005',
    financeInvocationId: '00000000-0000-4000-8000-000000000006',
    providerResponseId: 'response-test',
    model: 'gpt-6-astra',
    reasoningEffort: 'medium',
    promptVersion: 'finance-standardization-proposal.v1',
    completedAt: '2026-09-14T00:00:00Z',
  });
