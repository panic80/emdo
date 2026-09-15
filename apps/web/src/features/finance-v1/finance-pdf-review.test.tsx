import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinancePdfReview } from './finance-pdf-review.js';
import {
  pdfPageLimitation,
  draftFromPdfSelection,
  verifiedPdfInspection,
  verifyPdfSelection,
} from './finance-pdf-review-model.js';
import {
  pdfBlankPageInspection,
  pdfReviewBookId as bookId,
  pdfReviewEvidenceId as evidenceId,
  pdfReviewFixture,
} from '../../../test/finance-pdf-review-fixture.js';

const auth = vi.hoisted(() => ({
  sessionBinding: 'current',
  csrfToken: 'csrf',
}));
vi.mock('../auth/auth-context.js', () => ({ useAuth: () => auth }));
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
beforeEach(() => {
  auth.sessionBinding = 'current';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(
  options: {
    proposed?: boolean;
    role?: string;
    questions?: string[];
    bankPair?: boolean;
    noCurrency?: boolean;
  } = {},
) {
  const fixture = pdfReviewFixture();
  if (options.bankPair) {
    const definition = fixture.definition;
    definition.headers.push('Closing total');
    definition.pdfSelection!.headerCells.push({
      spans: [fixture.inspection.selectedPage!.spans[9]!],
      joiner: '',
    });
    definition.pdfSelection!.rows[0]!.cells.push({
      spans: [],
      joiner: '',
      confirmedBlank: true,
    });
    definition.bindings = definition.bindings.filter(
      (binding) => binding.field !== 'amount',
    );
    definition.bindings.push(
      { field: 'debit', column: 'Amount', context: null },
      { field: 'credit', column: 'Closing total', context: null },
    );
    definition.dateFormat = 'mmm dd';
    definition.dateYear = 2026;
  }
  if (options.noCurrency)
    fixture.definition.pdfSelection!.context.currency = null;
  const fetcher = vi.fn<
    (path: string, init?: RequestInit) => Promise<Response>
  >(async (path) =>
    response(
      path.endsWith('page=2')
        ? pdfBlankPageInspection(fixture.inspection)
        : fixture.inspection,
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  const save = vi.fn<(payload: unknown) => Promise<void>>(
      async () => undefined,
    ),
    download = vi.fn(),
    close = vi.fn();
  const props = {
    bookId,
    evidenceId,
    filename: 'statement.pdf',
    role: options.role ?? 'preparer',
    disabled: false,
    onSave: save,
    onDownload: download,
    onClose: close,
    ...(options.proposed === false ? {} : { definition: fixture.definition }),
    ...(options.questions ? { questions: options.questions } : {}),
  };
  return {
    ...fixture,
    ...render(<FinancePdfReview {...props} />),
    props,
    save,
    download,
    close,
    fetcher,
  };
}
async function ready() {
  await screen.findByRole('table', { name: 'Explicitly selected PDF cells' });
}
function confirmReview() {
  fireEvent.change(screen.getByLabelText('PDF source review notes'), {
    target: {
      value: 'Checked all selected cells and omitted footer against the PDF.',
    },
  });
  fireEvent.click(screen.getByLabelText(/I checked every selected heading/));
  fireEvent.click(screen.getByLabelText(/I checked date and currency context/));
  fireEvent.click(screen.getByLabelText(/I reviewed the omitted pages/));
}
function submit(container: HTMLElement) {
  fireEvent.submit(container.querySelector('form')!);
}

describe('reviewed PDF source selections', () => {
  it('requires an explicit account currency entry when no currency source span exists', async () => {
    const { container, save } = setup({ noCurrency: true });
    await ready();
    expect(screen.getByLabelText('Confirmed account currency')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Confirmed account currency'), {
      target: { value: 'cad' },
    });
    fireEvent.change(screen.getByLabelText('Currency · required'), {
      target: { value: 'context' },
    });
    confirmReview();
    submit(container);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({
      proposal: {
        definition: {
          currencyCode: 'CAD',
          pdfSelection: { context: { currency: null } },
          bindings: expect.arrayContaining([
            { field: 'currency', column: null, context: 'currency' },
          ]),
        },
      },
    });
  });

  it('reviews separate debit/credit bindings and an explicit statement year, then can switch back to signed amounts', async () => {
    const { container, save } = setup({ bankPair: true });
    await ready();
    expect(screen.getByLabelText('Amount representation')).toHaveValue('pair');
    expect(screen.getByLabelText(/Debit \/ withdrawal/)).toHaveValue('2');
    expect(screen.getByLabelText(/Credit \/ deposit/)).toHaveValue('3');
    expect(
      screen.queryByLabelText('Amount · required'),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Date format'), {
      target: { value: 'yyyy-mm-dd' },
    });
    expect(
      screen.queryByRole('spinbutton', { name: /Statement year/ }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Date format'), {
      target: { value: 'mmm dd' },
    });
    fireEvent.change(
      screen.getByRole('spinbutton', { name: /Statement year/ }),
      { target: { value: '2025' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Select spans for row 1, column 4' }),
    );
    fireEvent.click(
      screen.getByLabelText('I checked the original: this data cell is blank'),
    );
    confirmReview();
    submit(container);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({
      proposal: {
        definition: {
          dateFormat: 'mmm dd',
          dateYear: 2025,
          bindings: expect.arrayContaining([
            { field: 'debit', column: 'Amount', context: null },
            { field: 'credit', column: 'Closing total', context: null },
          ]),
        },
      },
    });
    fireEvent.change(screen.getByLabelText('Amount representation'), {
      target: { value: 'signed' },
    });
    fireEvent.change(screen.getByLabelText('Amount · required'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('Date format'), {
      target: { value: 'yyyy-mm-dd' },
    });
    confirmReview();
    submit(container);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    const second = save.mock.calls[1]![0] as {
      proposal: {
        definition: { dateYear: number | null; bindings: { field: string }[] };
      };
    };
    expect(second.proposal.definition.dateYear).toBeNull();
    expect(
      second.proposal.definition.bindings.map((binding) => binding.field),
    ).toContain('amount');
    expect(
      second.proposal.definition.bindings.map((binding) => binding.field),
    ).not.toContain('debit');
  });

  it('offers blank confirmation only for data cells and clears it on source selection', async () => {
    setup();
    await screen.findByRole('button', { name: 'Add column' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Select spans for heading 1' }),
    );
    expect(
      screen.queryByLabelText(
        'I checked the original: this data cell is blank',
      ),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Select spans for row 1, column 1' }),
    );
    fireEvent.click(
      screen.getByLabelText('I checked the original: this data cell is blank'),
    );
    expect(
      screen.getByRole('button', { name: 'Select spans for row 1, column 1' }),
    ).toHaveTextContent('Confirmed blank');
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Source span 3: 2026-09-13' }),
    );
    expect(
      screen.getByLabelText('I checked the original: this data cell is blank'),
    ).not.toBeChecked();
    fireEvent.click(
      screen.getByRole('button', { name: 'Select spans for currency context' }),
    );
    expect(
      screen.queryByLabelText(
        'I checked the original: this data cell is blank',
      ),
    ).not.toBeInTheDocument();
  });

  it('never inherits proposed blank-cell confirmation as human review', () => {
    const { definition } = pdfReviewFixture();
    const selection = structuredClone(definition.pdfSelection!);
    selection.rows[0]!.cells[0] = {
      spans: [],
      joiner: '',
      confirmedBlank: true,
    };
    expect(draftFromPdfSelection(selection).rows[0]![0]).toEqual({
      spans: [],
      joiner: ' ',
    });
  });

  it('prepopulates only verified whole spans, requires fresh review, and sends a source-only candidate with exact decimal text', async () => {
    const { container, save, definition, fetcher } = setup({
      questions: ['Does the currency apply to this row?'],
    });
    await ready();
    expect(
      screen.getByText('Coffee beans', { exact: true }),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole('table', { name: 'Explicitly selected PDF cells' }),
      ).getByText('-12.3400', { exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/I checked every selected heading/),
    ).not.toBeChecked();
    expect(
      screen.getByLabelText(/I reviewed the omitted pages/),
    ).not.toBeChecked();
    submit(container);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Complete the source-cell and context reviews',
    );
    expect(save).not.toHaveBeenCalled();
    confirmReview();
    submit(container);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Resolve each open question',
    );
    fireEvent.change(
      screen.getByLabelText('Does the currency apply to this row?'),
      { target: { value: 'The original identifies CAD for this statement.' } },
    );
    submit(container);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const payload = save.mock.calls[0]![0] as {
      proposal: {
        definition: unknown;
        unresolvedQuestions: string[];
        rationale: string;
      };
    };
    expect(Object.keys(payload)).toEqual(['evidenceId', 'proposal']);
    expect(payload.proposal.definition).toEqual(definition);
    expect(payload.proposal.unresolvedQuestions).toEqual([]);
    expect(payload.proposal.rationale).toContain(
      'Resolution: The original identifies CAD',
    );
    expect(payload).not.toHaveProperty('example');
    expect(payload).not.toHaveProperty('decision');
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v2/finance/books/${bookId}/evidence/${evidenceId}/pdf-inspection?page=1`,
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'same-origin',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('supports explicit manual cells, prevents duplicate assignment, and resets confirmations when a selection changes', async () => {
    const { save } = setup({ proposed: false });
    await screen.findByRole('button', { name: 'Add column' });
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Source span 0: Date' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Select spans for row 1, column 1' }),
    );
    expect(
      screen.getByRole('checkbox', { name: 'Source span 0: Date' }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Source span 3: 2026-09-13' }),
    );
    fireEvent.click(screen.getByLabelText(/I checked every selected heading/));
    expect(
      screen.getByLabelText(/I checked every selected heading/),
    ).toBeChecked();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Source span 3: 2026-09-13' }),
    );
    expect(
      screen.getByLabelText(/I checked every selected heading/),
    ).not.toBeChecked();
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps the table and typed metadata when inspecting omitted OCR pages, then requires an explicit page reset', async () => {
    const { save } = setup();
    await ready();
    fireEvent.change(screen.getByLabelText('PDF report provider'), {
      target: { value: 'Reviewed provider' },
    });
    fireEvent.change(screen.getByLabelText('Inspect source page'), {
      target: { value: '2' },
    });
    await screen.findByText(/This page has no extractable text/);
    expect(
      (screen.getByLabelText('PDF report provider') as HTMLInputElement).value,
    ).toBe('Reviewed provider');
    expect(
      screen.getByRole('button', { name: 'Use page 2 for this table' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Save reviewed PDF candidate' }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Return to table page 1' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save reviewed PDF candidate' }),
      ).not.toBeDisabled(),
    );
    expect(
      screen.getByText('Coffee beans', { exact: true }),
    ).toBeInTheDocument();
    expect(
      (screen.getByLabelText('PDF report provider') as HTMLInputElement).value,
    ).toBe('Reviewed provider');
    expect(save).not.toHaveBeenCalled();
  });

  it('drops an unverified proposed selection and blocks unsupported source geometry and substring claims', async () => {
    const { inspection, definition } = pdfReviewFixture();
    const selection = structuredClone(definition.pdfSelection!);
    selection.rows[0]!.cells[1]!.spans[0]!.text = 'Coff';
    expect(() => verifyPdfSelection(selection, inspection)).toThrow(
      'does not exactly match',
    );
    selection.rows[0]!.cells[1]!.spans[0] = selection.headerCells[0]!.spans[0]!;
    expect(() => verifyPdfSelection(selection, inspection)).toThrow(
      'only one cell',
    );
    expect(() =>
      verifyPdfSelection(
        { ...definition.pdfSelection, acknowledgeUnselectedContent: false },
        inspection,
      ),
    ).toThrow('unselected pages');
    const moved = structuredClone(inspection);
    moved.selectedPage!.rotation = 90;
    expect(pdfPageLimitation(moved)).toContain('rotated');
    const fetcher = vi.fn(async () => response(inspection));
    vi.stubGlobal('fetch', fetcher);
    render(
      <FinancePdfReview
        bookId={bookId}
        evidenceId={evidenceId}
        filename="statement.pdf"
        role="preparer"
        definition={{ ...definition, pdfSelection: selection }}
        disabled={false}
        onSave={vi.fn()}
        onDownload={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText(/proposed spans could not be matched/);
    expect(
      within(
        screen.getByRole('table', { name: 'Explicitly selected PDF cells' }),
      ).queryByText('Coffee beans'),
    ).not.toBeInTheDocument();
  });

  it.each([401, 403, 503])(
    'clears prior source and review controls after access/service failure %i',
    async (status) => {
      const { fetcher } = setup();
      await ready();
      fetcher.mockImplementation(async () => response({}, status));
      fireEvent.click(
        screen.getByRole('button', { name: 'Refresh PDF inspection' }),
      );
      await screen.findByRole('alert');
      expect(
        screen.queryByRole('table', { name: 'Explicitly selected PDF cells' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Save reviewed PDF candidate' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText('Coffee beans', { exact: true }),
      ).not.toBeInTheDocument();
    },
  );

  it('aborts and ignores a late inspection when session access changes', async () => {
    const first = pdfReviewFixture();
    let finish: (value: Response) => void = () => undefined;
    const fetcher = vi.fn<
      (path: string, init?: RequestInit) => Promise<Response>
    >(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const props = {
      bookId,
      evidenceId,
      filename: 'statement.pdf',
      role: 'preparer',
      disabled: false,
      definition: first.definition,
      onSave: vi.fn(),
      onDownload: vi.fn(),
      onClose: vi.fn(),
    };
    const view = render(<FinancePdfReview {...props} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const signal = fetcher.mock.calls[0]![1]!.signal!;
    const oldFinish = finish;
    auth.sessionBinding = 'new-session';
    view.rerender(<FinancePdfReview {...props} role="viewer" />);
    expect(signal.aborted).toBe(true);
    await act(async () => {
      oldFinish(response(first.inspection));
    });
    expect(
      screen.queryByRole('button', { name: 'Save reviewed PDF candidate' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Coffee beans', { exact: true }),
    ).not.toBeInTheDocument();
  });

  it('rejects mismatched inspection scope, incomplete span text, and a changed source on refresh', async () => {
    const { inspection } = pdfReviewFixture();
    expect(() =>
      verifiedPdfInspection(
        { ...inspection, evidenceId: bookId },
        { bookId, evidenceId, page: 1 },
      ),
    ).toThrow('different book or original');
    const clipped = structuredClone(inspection);
    clipped.selectedPage!.spans[0]!.textLength = 1;
    expect(() =>
      verifiedPdfInspection(clipped, { bookId, evidenceId, page: 1 }),
    ).toThrow('could not be verified');
    const { fetcher } = setup();
    await ready();
    fetcher.mockImplementation(async () =>
      response({ ...inspection, sourceDigest: 'b'.repeat(64) }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh PDF inspection' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'original or its page inventory changed',
    );
    expect(
      screen.queryByRole('button', { name: 'Save reviewed PDF candidate' }),
    ).not.toBeInTheDocument();
  });

  it('explains bounded extraction unavailability and never presents a mapping form', async () => {
    const fixture = pdfReviewFixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({
          ...fixture.inspection,
          status: 'unavailable',
          reason: 'pages-limit',
          totalPages: null,
          pages: [],
          selectedPage: null,
        }),
      ),
    );
    render(
      <FinancePdfReview
        bookId={bookId}
        evidenceId={evidenceId}
        filename="statement.pdf"
        role="preparer"
        disabled={false}
        onSave={vi.fn()}
        onDownload={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText(
      'This PDF exceeds the 25-page text inspection limit.',
    );
    expect(
      screen.queryByRole('button', { name: 'Save reviewed PDF candidate' }),
    ).not.toBeInTheDocument();
  });
});
