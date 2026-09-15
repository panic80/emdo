import { expect, it } from 'vitest';
import {
  durableFinanceProposalInstructions,
  financeProposalInputWithinBudget,
  DURABLE_FINANCE_PROPOSAL_SCHEMA_BYTE_CEILING,
} from './durable-finance-standardization.js';

it('requires structured proposals and reserves every source-review confirmation for humans', () => {
  expect(durableFinanceProposalInstructions).toContain(
    'Return one structured proposal object',
  );
  expect(durableFinanceProposalInstructions).toContain(
    'rationale must be a nonempty explanatory string',
  );
  expect(durableFinanceProposalInstructions).not.toContain('proposalJson');
  expect(durableFinanceProposalInstructions).toContain(
    'Never return xlsxSelection, pdfSelection, imageSelection or pdfOcrSelection fields, including null placeholders.',
  );
  expect(durableFinanceProposalInstructions).toContain(
    'A candidate is never approval.',
  );
});

it('reserves the bounded structured schema and SDK envelope without increasing token ceilings', () => {
  const available =
    20_000 -
    DURABLE_FINANCE_PROPOSAL_SCHEMA_BYTE_CEILING -
    2048 -
    Buffer.byteLength(durableFinanceProposalInstructions, 'utf8');
  expect(available).toBeGreaterThan(0);
  expect(financeProposalInputWithinBudget('x'.repeat(available))).toBe(true);
  expect(financeProposalInputWithinBudget('x'.repeat(available + 1))).toBe(
    false,
  );
  expect(
    financeProposalInputWithinBudget('x'.repeat(available - 1) + 'é'),
  ).toBe(false);
});
