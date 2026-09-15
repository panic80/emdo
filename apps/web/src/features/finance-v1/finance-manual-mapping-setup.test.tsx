import { webcrypto } from 'node:crypto';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinanceReportMappingDefinitionSchema } from '@emdo/contracts/browser';
import { FinanceManualMappingSetup } from './finance-manual-mapping-setup.js';

describe('manual source mapping setup', () => {
  it.each(['csv', 'xlsx'] as const)(
    'requires explicit %s report identity and leaves all field meanings unsaved and unmapped',
    (format) => {
      const onContinue = vi.fn(),
        onDownload = vi.fn();
      const { container } = render(
        <FinanceManualMappingSetup
          format={format}
          disabled={false}
          onContinue={onContinue}
          onDownload={onDownload}
        />,
      );
      expect(screen.getByLabelText('Report type')).toHaveValue('');
      fireEvent.click(
        screen.getByRole('button', { name: /Download original/ }),
      );
      expect(onDownload).toHaveBeenCalledOnce();
      fireEvent.submit(container.querySelector('form')!);
      expect(onContinue).not.toHaveBeenCalled();
      for (const [label, value] of [
        ['Provider name', 'My bank'],
        ['Report name', 'Activity'],
        ['Report type', 'bank-transactions'],
        ['Layout version', 'September 2026'],
        ['Exact source headings, one per line', 'Date\nMemo\nAmount\nCurrency'],
      ]) {
        fireEvent.change(screen.getByLabelText(label!), { target: { value } });
      }
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.submit(container.querySelector('form')!);
      expect(onContinue).toHaveBeenCalledOnce();
      const draft = onContinue.mock.calls[0]![0];
      expect(draft).toMatchObject({
        providerKey: 'My bank',
        reportName: 'Activity',
        headers: ['Date', 'Memo', 'Amount', 'Currency'],
      });
      expect(
        draft.bindings.every(
          (binding: { column: string; context: null }) =>
            binding.column === '' && binding.context === null,
        ),
      ).toBe(true);
      expect(
        FinanceReportMappingDefinitionSchema.safeParse(draft).success,
      ).toBe(false);
      expect(draft.proposedByModel).toBeUndefined();
    },
  );
});

it('preserves quoted CSV source headings without inferring meanings', async () => {
  const { readObservedCsvHeaders } =
    await import('./finance-manual-mapping-setup.js');
  expect(
    readObservedCsvHeaders(
      '\uFEFF"Date","Memo, source","Say ""yes""",Amount\r\n2026-01-01,test,x,1',
    ),
  ).toEqual(['Date', 'Memo, source', 'Say "yes"', 'Amount']);
  expect(() => readObservedCsvHeaders('Date,Date\n1,2')).toThrow();
  expect(() => readObservedCsvHeaders('"Open,Amount')).toThrow();
});

afterEach(() => vi.unstubAllGlobals());
it('blocks manual continuation when original CSV fingerprint verification fails', async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            filename: 'changed.csv',
            format: 'csv',
            sourceText: 'Changed,Headers\n1,2',
          }),
        ),
    ),
  );
  const onContinue = vi.fn();
  const { container } = render(
    <FinanceManualMappingSetup
      format="csv"
      csvSource={{
        bookId: '00000000-0000-4000-8000-000000000001',
        evidenceId: '00000000-0000-4000-8000-000000000002',
        sourceDigest: 'a'.repeat(64),
      }}
      disabled={false}
      onDownload={() => {}}
      onContinue={onContinue}
    />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'original CSV could not be verified',
  );
  expect(
    screen.getByRole('button', { name: 'Continue to field review' }),
  ).toBeDisabled();
  fireEvent.submit(container.querySelector('form')!);
  expect(onContinue).not.toHaveBeenCalled();
});
