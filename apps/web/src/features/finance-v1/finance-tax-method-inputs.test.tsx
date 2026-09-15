import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaxDeclarationEditor } from './finance-tax-inputs.js';

describe('reviewed business method declarations', () => {
  it.each([
    ['business.incomeKind', 'commission'],
    ['business.reportingMethod', 'cash'],
    ['business.reportingMethod', 'accrual'],
  ])(
    'requires an explicit %s selection and saves %s only after review',
    async (key, value) => {
      const save = vi.fn().mockResolvedValue(undefined);
      render(
        <TaxDeclarationEditor
          question={{
            key,
            type: 'text',
            label: 'Select business treatment',
            required: true,
            locator: 'T2125',
          }}
          revision={1}
          disabled={false}
          onCancel={() => {}}
          onSave={save}
        />,
      );
      const select = screen.getByRole('combobox', {
        name: /Declaration value/,
      });
      expect(select).toHaveValue('');
      expect(select).toBeInvalid();
      fireEvent.change(select, { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Review input' }));
      expect(save).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole('button', { name: 'Save unreviewed input' }),
      );
      await waitFor(() =>
        expect(save).toHaveBeenCalledWith(
          expect.objectContaining({
            factKey: key,
            value: { type: 'text', value },
            expectedCaseRevision: 1,
          }),
        ),
      );
    },
  );
});
