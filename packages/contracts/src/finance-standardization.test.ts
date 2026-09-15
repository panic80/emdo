import { describe, expect, it } from 'vitest';
import { FinanceStandardizationModelProvenanceSchema } from './finance-standardization.js';
const provenance = {
  controller: 'emdo',
  orchestrationMode: 'registered-workflow',
  managerInvocationId: '10000000-0000-4000-8000-000000000001',
  financeInvocationId: '10000000-0000-4000-8000-000000000002',
  providerResponseId: 'resp_verified',
  model: 'gpt-6-astra',
  reasoningEffort: 'medium',
  completedAt: '2026-09-15T00:00:00Z',
};
describe('Finance standardization provenance versions', () => {
  it.each(['v1', 'v2', 'v3', 'v4', 'v5', 'v6'])(
    'reads %s provenance without upgrading historical receipts',
    (version) => {
      const promptVersion = `finance-standardization-proposal.${version}`;
      expect(
        FinanceStandardizationModelProvenanceSchema.parse({
          ...provenance,
          promptVersion,
        }).promptVersion,
      ).toBe(promptVersion);
    },
  );
  it('rejects unknown prompt versions', () => {
    expect(
      FinanceStandardizationModelProvenanceSchema.safeParse({
        ...provenance,
        promptVersion: 'finance-standardization-proposal.v7',
      }).success,
    ).toBe(false);
  });
});
