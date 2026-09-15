import { createHash, webcrypto } from 'node:crypto';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinanceCsvReview } from './finance-csv-review.js';
import {
  standardizationBookId,
  standardizationEvidenceId,
  standardizationDefinition,
  standardizationCsv,
  standardizationDigest,
} from '../../../test/finance-standardization-fixture.js';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function setup(source = standardizationCsv) {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          filename: 'activity.csv',
          format: 'csv',
          sourceText: source,
        }),
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const props = {
    bookId: standardizationBookId,
    evidenceId: standardizationEvidenceId,
    sourceDigest: standardizationDigest,
    filename: 'activity.csv',
    definition: standardizationDefinition,
    questions: ['Do positive amounts represent receipts?'],
    disabled: false,
    onSave: vi.fn<(payload: Record<string, unknown>) => Promise<void>>(
      async () => {},
    ),
    onClose: vi.fn(),
    onAccessUnavailable: vi.fn(),
  };
  return { props, fetcher };
}
describe('CSV original source review', () => {
  it('allows an omitted fee to be mapped explicitly, preserves required fields and shows all unmapped headings', async () => {
    const source =
      'Date,Memo,Amount,Currency,Fee\n2026-01-01,Receipt,10.00,CAD,0.25\n';
    const { props } = setup(source);
    props.sourceDigest = createHash('sha256').update(source).digest('hex');
    props.definition = {
      ...standardizationDefinition,
      headers: [...standardizationDefinition.headers, 'Fee'],
    };
    props.questions = [];
    render(<FinanceCsvReview {...props} />);
    await screen.findByLabelText('Original CSV text');
    expect(screen.getByText('Column 5: Fee')).toBeInTheDocument();
    expect(screen.queryByLabelText('Fee')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Remove Amount mapping' }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Optional financial field'), {
      target: { value: 'fee' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add financial field' }),
    );
    const select = screen.getByLabelText('Fee') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(document.activeElement).toBe(select);
    fireEvent.change(select, { target: { value: 'Fee' } });
    expect(screen.queryByText('Column 5: Fee')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Source review notes'), {
      target: {
        value:
          'Confirmed the fee column from the original and assigned its meaning explicitly.',
      },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.submit(
      screen
        .getByRole('button', { name: 'Save reviewed CSV candidate' })
        .closest('form')!,
    );
    await waitFor(() => expect(props.onSave).toHaveBeenCalledOnce());
    expect(props.onSave.mock.calls[0]![0]).toMatchObject({
      proposal: {
        definition: {
          bindings: expect.arrayContaining([
            { field: 'fee', column: 'Fee', context: null },
            ...standardizationDefinition.bindings,
          ]),
        },
      },
    });
  });
  it('removes an erroneous optional binding and makes the resulting source omission visible for fresh acknowledgement', async () => {
    const source =
      'Date,Memo,Amount,Currency,Reference\n2026-01-01,Receipt,10.00,CAD,REF25\n';
    const { props } = setup(source);
    props.sourceDigest = createHash('sha256').update(source).digest('hex');
    props.definition = {
      ...standardizationDefinition,
      headers: [...standardizationDefinition.headers, 'Reference'],
      bindings: [
        ...standardizationDefinition.bindings,
        { field: 'tax', column: 'Reference', context: null },
      ],
    };
    props.questions = [];
    render(<FinanceCsvReview {...props} />);
    await screen.findByLabelText('Original CSV text');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Tax mapping' }));
    expect(screen.getByText('Column 5: Reference')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save reviewed CSV candidate' }),
    ).toBeDisabled();
    expect(screen.queryByLabelText('Tax')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Source review notes'), {
      target: {
        value:
          'Reference is an unneeded nonfinancial source column; the proposed tax interpretation was incorrect.',
      },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.submit(
      screen
        .getByRole('button', { name: 'Save reviewed CSV candidate' })
        .closest('form')!,
    );
    await waitFor(() => expect(props.onSave).toHaveBeenCalledOnce());
    expect(props.onSave.mock.calls[0]![0]).toMatchObject({
      proposal: {
        definition: { bindings: standardizationDefinition.bindings },
      },
    });
  });
  it.each(['dd/mm/yyyy', 'dd.mm.yyyy', 'yyyy/mm/dd'] as const)(
    'shows exact original text and sends explicitly reviewed %s dates without rewriting the source',
    async (dateFormat) => {
      const { props } = setup();
      render(<FinanceCsvReview {...props} />);
      const original = await screen.findByLabelText('Original CSV text');
      expect(original.textContent).toBe(standardizationCsv);
      const save = screen.getByRole('button', {
        name: 'Save reviewed CSV candidate',
      });
      expect(save).toBeDisabled();
      fireEvent.change(
        screen.getByLabelText('Do positive amounts represent receipts?'),
        { target: { value: 'The source describes positive receipts.' } },
      );
      fireEvent.change(screen.getByLabelText('Source review notes'), {
        target: {
          value:
            'Checked every heading, source row, sign and date against the original.',
        },
      });
      fireEvent.click(screen.getByRole('checkbox'));
      expect(save).not.toBeDisabled();
      fireEvent.change(screen.getByLabelText('Date format'), {
        target: { value: dateFormat },
      });
      expect(save).toBeDisabled();
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.submit(save.closest('form')!);
      await waitFor(() => expect(props.onSave).toHaveBeenCalledOnce());
      const sent = props.onSave.mock.calls[0]![0];
      expect(sent).toMatchObject({
        evidenceId: standardizationEvidenceId,
        expectedSourceDigest: standardizationDigest,
        proposal: {
          definition: { dateFormat },
          unresolvedQuestions: [],
        },
      });
      expect(Object.keys(sent)).toEqual([
        'evidenceId',
        'expectedSourceDigest',
        'proposal',
      ]);
      expect(sent).not.toHaveProperty('example');
      expect(sent).not.toHaveProperty('decision');
    },
  );
  it('fails closed when returned original bytes do not match the saved source fingerprint', async () => {
    const { props } = setup('Changed original');
    render(<FinanceCsvReview {...props} />);
    await screen.findByRole('alert');
    expect(
      screen.queryByRole('button', { name: 'Save reviewed CSV candidate' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('Original CSV text'),
    ).not.toBeInTheDocument();
    expect(props.onSave).not.toHaveBeenCalled();
  });
  it('clears original access on current permission denial and aborts delayed original loads on unmount', async () => {
    const { props, fetcher } = setup();
    fetcher.mockResolvedValue(new Response('{}', { status: 403 }));
    const view = render(<FinanceCsvReview {...props} />);
    await waitFor(() =>
      expect(props.onAccessUnavailable).toHaveBeenCalledOnce(),
    );
    expect(
      screen.queryByLabelText('Original CSV text'),
    ).not.toBeInTheDocument();
    view.unmount();
    let finish!: (value: Response) => void;
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_path: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }),
    );
    const delayed = render(<FinanceCsvReview {...props} />);
    delayed.unmount();
    expect(signal?.aborted).toBe(true);
    finish(
      new Response(
        JSON.stringify({
          filename: 'activity.csv',
          format: 'csv',
          sourceText: standardizationCsv,
        }),
      ),
    );
  });
});
