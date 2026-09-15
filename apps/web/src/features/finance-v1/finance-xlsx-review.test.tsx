import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FinanceReportMappingDefinitionSchema } from '@emdo/contracts/browser';
import { FinanceXlsxReview } from './finance-xlsx-review.js';

const definition = FinanceReportMappingDefinitionSchema.parse({
  providerKey: 'Bank',
  reportName: 'Activity',
  reportType: 'bank-transactions',
  layoutVersion: '1',
  headers: ['Date', 'Memo', 'Amount', 'Currency'],
  bindings: ['transactionDate', 'description', 'amount', 'currency'].map(
    (field, index) => ({
      field,
      column: ['Date', 'Memo', 'Amount', 'Currency'][index],
      context: null,
    }),
  ),
  dateFormat: 'yyyy-mm-dd',
  decimalSeparator: '.',
  groupingSeparator: '',
  quantityUnit: null,
  valuationMultiplier: null,
  identifierScheme: null,
  identifierNamespace: null,
  xlsxSelection: {
    sheet: 'Statement',
    headerRow: 1,
    firstColumn: 1,
    lastColumn: 4,
    firstDataRow: 2,
    lastDataRow: 3,
    dateColumns: [1],
    confirmedHeaderAndDataRange: true,
    confirmedDateSystem: '1904',
    acknowledgeCachedFormulaValues: false,
    acknowledgeHiddenContent: false,
  },
});
function setup(disabled = false) {
  const onSave = vi.fn<(input: unknown) => Promise<void>>(async () => {}),
    onDownload = vi.fn();
  const rendered = render(
    <FinanceXlsxReview
      evidenceId="00000000-0000-4000-8000-000000000002"
      definition={definition}
      questions={['Are amounts CAD?']}
      disabled={disabled}
      onSave={onSave}
      onDownload={onDownload}
    />,
  );
  return { ...rendered, onSave, onDownload };
}
function confirm() {
  fireEvent.change(screen.getByLabelText('Are amounts CAD?'), {
    target: { value: 'Yes, the original currency column says CAD.' },
  });
  fireEvent.change(screen.getByLabelText('Source review notes'), {
    target: { value: 'Checked both data rows and the workbook date setting.' },
  });
  fireEvent.click(screen.getByLabelText(/I checked the range, currency/));
}
describe('Reviewed XLSX source choices', () => {
  it('requires explicit source confirmation and answers before creating a candidate', async () => {
    const { container, onSave } = setup();
    fireEvent.submit(container.querySelector('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Confirm the original range',
    );
    expect(onSave).not.toHaveBeenCalled();
    confirm();
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      proposal: {
        definition: {
          xlsxSelection: {
            sheet: 'Statement',
            firstDataRow: 2,
            lastDataRow: 3,
            dateColumns: [1],
            confirmedDateSystem: '1904',
            acknowledgeCachedFormulaValues: false,
          },
        },
        unresolvedQuestions: [],
        rationale: expect.stringContaining(
          'the original currency column says CAD',
        ),
      },
    });
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty('decision');
  });
  it('rejects an invalid date interpretation without sending a request', async () => {
    const { container, onSave } = setup();
    confirm();
    fireEvent.change(screen.getByLabelText('Date format'), {
      target: { value: 'dd/mm/yyyy' },
    });
    fireEvent.submit(container.querySelector('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'requires yyyy-mm-dd',
    );
    expect(onSave).not.toHaveBeenCalled();
  });
  it('disables review mutations while the parent is saving', () => {
    const { onSave } = setup(true);
    expect(
      screen.getByRole('button', {
        name: 'Save revised XLSX candidate',
        hidden: true,
      }),
    ).toBeDisabled();
    expect(screen.getByLabelText('Worksheet name')).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });
});

it('does not silently select the first workbook heading for a blank manual binding', async () => {
  const onSave = vi.fn(async () => {});
  const { container } = render(
    <FinanceXlsxReview
      evidenceId="00000000-0000-4000-8000-000000000002"
      definition={{
        ...definition,
        bindings: definition.bindings.map((binding) => ({
          ...binding,
          column: '',
          context: null,
        })),
      }}
      questions={[]}
      disabled={false}
      onSave={onSave}
      onDownload={() => {}}
    />,
  );
  expect(screen.getByLabelText('transactionDate')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Source review notes'), {
    target: { value: 'Checked the exact original range.' },
  });
  fireEvent.click(screen.getByLabelText(/I checked the range, currency/));
  fireEvent.submit(container.querySelector('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Select a source heading',
  );
  expect(onSave).not.toHaveBeenCalled();
  for (const [index, binding] of definition.bindings.entries())
    fireEvent.change(screen.getByLabelText(binding.field), {
      target: { value: String(index) },
    });
  fireEvent.submit(container.querySelector('form')!);
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
});
