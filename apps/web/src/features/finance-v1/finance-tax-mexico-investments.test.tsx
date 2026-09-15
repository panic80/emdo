import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  MexicoInvestmentRows,
  TaxMexicoInvestmentsEditor,
} from './finance-tax-mexico-investments.js';
const row = {
  assetId: 'computer_1',
  assetClass: 'computer-equipment',
  acquisitionDate: '2025-01-01',
  firstUseDate: '2025-01-01',
  originalInvestment: '12000.00',
};
const source = (value: string) => ({
  sourceId: '70000000-0000-4000-8000-000000000001',
  sourceRevision: 3,
  contentHash: 'a'.repeat(64),
  factKey: 'corporation.investments.rows',
  category: 'general' as const,
  reviewState: 'reviewed' as const,
  value: { type: 'text' as const, value },
});
describe('Mexico investment source editor', () => {
  it('preserves exact saved strings and revision bindings through explicit review and save', async () => {
    const save = vi.fn<(input: unknown) => Promise<void>>(async () => {});
    render(
      <TaxMexicoInvestmentsEditor
        source={source(JSON.stringify([row]))}
        revision={7}
        disabled={false}
        onCancel={() => {}}
        onSave={save}
      />,
    );
    expect(screen.getByLabelText('Original investment (MXN)')).toHaveValue(
      '12000.00',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review asset rows' }));
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Save assets as unreviewed input' }),
    );
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      expectedCaseRevision: 7,
      expectedSourceRevision: 3,
      sourceId: source('').sourceId,
      value: { type: 'text', value: JSON.stringify([row]) },
    });
  });
  it('requires an explicit no-assets choice rather than silently saving an empty list', async () => {
    const save = vi.fn<(input: unknown) => Promise<void>>(async () => {});
    render(
      <TaxMexicoInvestmentsEditor
        revision={1}
        disabled={false}
        onCancel={() => {}}
        onSave={save}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review asset rows' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Review asset rows' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save assets as unreviewed input' }),
    );
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      expectedSourceRevision: null,
      value: { type: 'text', value: '[]' },
    });
  });
  it.each([
    'bad',
    JSON.stringify([{ ...row, unknown: true }]),
    JSON.stringify([{ ...row, originalInvestment: 12000 }]),
  ])('blocks malformed saved source without discarding fields', (value) => {
    render(
      <TaxMexicoInvestmentsEditor
        source={source(value)}
        revision={4}
        disabled={false}
        onCancel={() => {}}
        onSave={async () => {}}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'No rows have been discarded',
    );
    expect(
      screen.queryByRole('button', { name: 'Review asset rows' }),
    ).not.toBeInTheDocument();
  });
  it('rejects unsupported row facts while accepting the exact supported row', () => {
    expect(MexicoInvestmentRows.safeParse([row]).success).toBe(true);
    for (const rows of [
      [{ ...row, firstUseDate: '2025-12-01' }],
      [{ ...row, firstUseDate: '2025-01-02' }],
      [{ ...row, originalInvestment: '0.00' }],
      [{ ...row, originalInvestment: '1.001' }],
      [row, row],
      [{ ...row, acquisitionDate: '2025-02-01' }],
    ])
      expect(MexicoInvestmentRows.safeParse(rows).success).toBe(false);
  });
});
