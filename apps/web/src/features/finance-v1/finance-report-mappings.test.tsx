import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { FinanceReportMappings } from './finance-report-mappings.js';
vi.mock('../auth/auth-context.js', () => ({
  useAuth: () => ({ csrfToken: 'test-token' }),
}));
afterEach(() => vi.unstubAllGlobals());
const bookId = '00000000-0000-4000-8000-000000000001',
  evidenceId = '00000000-0000-4000-8000-000000000002',
  mappingId = '00000000-0000-4000-8000-000000000003';
function fixture(questions: string[] = [], status = 'candidate') {
  const mapping = {
    id: mappingId,
    evidence_id: evidenceId,
    providerKey: 'Example',
    reportName: 'Activity',
    version: 1,
    revision: 1,
    status,
    validationStatus: 'normalized',
    proposed_by_model: 'gpt-6-astra',
    rationale: 'The source identifies currency separately.',
    unresolved_questions: questions,
    definition: {
      providerKey: 'Example',
      reportName: 'Activity',
      reportType: 'bank-transactions',
      layoutVersion: '1',
      headers: ['Date', 'Memo', 'Amount', 'Currency'],
      bindings: [
        { field: 'transactionDate', column: 'Date', context: null },
        { field: 'description', column: 'Memo', context: null },
        { field: 'amount', column: 'Amount', context: null },
        { field: 'currency', column: 'Currency', context: null },
      ],
      dateFormat: 'yyyy-mm-dd',
      decimalSeparator: '.',
      groupingSeparator: ',',
      quantityUnit: null,
      valuationMultiplier: null,
      identifierScheme: null,
      identifierNamespace: null,
    },
    example: {
      headers: ['Date', 'Memo', 'Amount', 'Currency'],
      rows: [
        {
          sourceRow: 2,
          cells: ['2026-01-01', 'Example payment', '10.00', 'CAD'],
        },
      ],
    },
    validation: {
      status: 'normalized',
      issues: [],
      rows: [
        {
          sourceRow: 2,
          fields: { amount: '10.00', currency: 'CAD' },
          issues: [],
        },
      ],
    },
  };
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/financial-accounts'))
      return new Response(
        JSON.stringify({
          accounts: [{ id: bookId, name: 'Bank', currency: 'CAD' }],
        }),
      );
    if (path.endsWith('/import'))
      return new Response(JSON.stringify({ id: evidenceId, status: 'review' }));
    if (init?.method === 'POST') {
      mapping.status = 'approved';
      mapping.revision = 2;
      return new Response('{}');
    }
    return new Response(
      JSON.stringify(
        path.includes('/evidence?')
          ? {
              documents: [
                { id: evidenceId, filename: 'unfamiliar.csv', format: 'csv' },
              ],
              nextOffset: null,
            }
          : path.includes('/report-mappings?')
            ? { mappings: [mapping], nextOffset: null }
            : { mapping, reviews: [] },
      ),
    );
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
async function openMapping(status = 'candidate') {
  fireEvent.click(
    screen.getByRole('button', { name: 'Open report standardization' }),
  );
  fireEvent.click(
    await screen.findByRole('button', {
      name: `Example · Activity · v1 · ${status}`,
    }),
  );
  await screen.findByRole('table', { name: 'Proposed field meanings' });
}
describe('dynamic report mapping review', () => {
  it('sends saved evidence references to EMDO without granting approval', async () => {
    const fetcher = fixture();
    const analyze = vi.fn(async () => true);
    render(
      <FinanceReportMappings
        bookId={bookId}
        role="preparer"
        onAnalyze={analyze}
      />,
    );
    await openMapping();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Ask EMDO to analyze unfamiliar.csv',
      }),
    );
    await waitFor(() =>
      expect(analyze).toHaveBeenCalledWith(bookId, evidenceId),
    );
    expect(screen.queryByLabelText('Mapping decision')).not.toBeInTheDocument();
    expect(
      fetcher.mock.calls.every(([, init]) => init?.method !== 'POST'),
    ).toBe(true);
  });
  it('shows source rows and submits an explicit revision-scoped approval', async () => {
    const fetcher = fixture();
    render(<FinanceReportMappings bookId={bookId} role="approver" />);
    await openMapping();
    expect(screen.getByText('Example payment')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Review reason'), {
      target: { value: 'Checked against source' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save mapping decision' }),
    );
    await screen.findByText(
      'Mapping decision saved. No financial records were posted.',
    );
    const call = fetcher.mock.calls.find(
      ([, init]) => init?.method === 'POST',
    )!;
    expect(call[0]).toBe(
      `/api/v2/finance/books/${bookId}/report-mappings/${mappingId}/review`,
    );
    expect(JSON.parse(call[1]!.body as string)).toEqual({
      expectedRevision: 1,
      decision: 'approve',
      reason: 'Checked against source',
    });
  });
  it('blocks approval while semantic questions remain', async () => {
    fixture(['Is Amount a net or gross amount?']);
    render(<FinanceReportMappings bookId={bookId} role="administrator" />);
    await openMapping();
    expect(
      screen.getByText('Is Amount a net or gross amount?'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: 'Approve this version' }),
    ).not.toBeInTheDocument();
  });
  it('reuses an approved mapping with explicit source/account selection and no automatic posting', async () => {
    const fetcher = fixture([], 'approved');
    render(<FinanceReportMappings bookId={bookId} role="preparer" />);
    await openMapping('approved');
    fireEvent.click(
      screen.getByRole('button', { name: 'Choose account for reuse' }),
    );
    await screen.findByLabelText('Report financial account');
    fireEvent.change(screen.getByLabelText('Saved report to standardize'), {
      target: { value: evidenceId },
    });
    fireEvent.change(screen.getByLabelText('Report financial account'), {
      target: { value: bookId },
    });
    fireEvent.change(screen.getByLabelText('Report provider'), {
      target: { value: 'Example' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Standardize for import review' }),
    );
    await screen.findByText(/Saved import reference:/);
    const writes = fetcher.mock.calls.filter(
      ([, init]) => init?.method === 'POST',
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe(
      `/api/v2/finance/books/${bookId}/report-mappings/${mappingId}/import`,
    );
    expect(JSON.parse(writes[0]![1]!.body as string)).toEqual({
      evidenceId,
      financialAccountId: bookId,
      expectedMappingVersion: 1,
      providerKey: 'Example',
    });
    expect(
      screen.getByRole('button', { name: 'Standardize for import review' }),
    ).toBeDisabled();
  });
});
