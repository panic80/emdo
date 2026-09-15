import { createHash, webcrypto } from 'node:crypto';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinanceImageReview } from './finance-image-review.js';
import { readImageReview } from './finance-image-review-api.js';
import {
  imageCellFromWords,
  imageCellIssue,
  imageDraftFromSelection,
  imageMappingPayload,
  imageMappingSettings,
  imageRegionCell,
  imageSelectionFromDraft,
  verifyImageSelection,
} from './finance-image-review-model.js';
import {
  imageReviewFixture,
  imageReviewCorrection,
  imageReviewIds,
} from '../../../test/finance-image-review-fixture.js';
import { standardizationUpload } from './finance-standardization-api.js';

const auth = vi.hoisted(() => ({
  sessionBinding: 'current',
  csrfToken: 'image-csrf',
  state: 'authenticated',
}));
vi.mock('../auth/auth-context.js', () => ({ useAuth: () => auth }));
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  auth.sessionBinding = 'current';
  auth.state = 'authenticated';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function setup() {
  const fixture = imageReviewFixture();
  const fetcher = vi.fn<
    (path: string, init?: RequestInit) => Promise<Response>
  >(async (path, init) => {
    const result = fixture.handle(
      path,
      init?.method ?? 'GET',
      init?.body ? JSON.parse(String(init.body)) : {},
      new Headers(init?.headers).get('idempotency-key') ?? '',
    );
    return new Response(JSON.stringify(result.json), { status: result.status });
  });
  vi.stubGlobal('fetch', fetcher);
  const props = {
    run: fixture.run,
    role: 'preparer',
    disabled: false,
    onSave: vi.fn<(value: unknown) => Promise<void>>(async () => {}),
    onClose: vi.fn(),
    onAccessUnavailable: vi.fn(),
  };
  return { ...fixture, fetcher, props };
}
function showOriginal() {
  const original = screen.getByRole('img', {
    name: 'Original image: image-statement.png',
  });
  Object.defineProperties(original, {
    naturalWidth: { configurable: true, value: 1100 },
    naturalHeight: { configurable: true, value: 160 },
  });
  fireEvent.load(original);
}
async function ready() {
  await screen.findByRole('table', {
    name: 'Selected source cells · confirmations are individual',
  });
}
async function confirmCells() {
  for (const name of [
    'Heading 1: Date',
    'Heading 2: Description',
    'Heading 3: Amount',
    'Row 1, column 1: 2026-09-01',
    'Row 1, column 2: Coffee',
    'Row 1, column 3: 12.5O',
    'Currency context: CAD',
  ]) {
    fireEvent.click(screen.getByRole('button', { name: `Review ${name}` }));
    showOriginal();
    if (name.includes('12.5O')) {
      fireEvent.change(screen.getByLabelText('Text visible in this region'), {
        target: { value: '12.50' },
      });
      expect(
        screen.getByLabelText(
          'I checked this region and its exact text against the original image.',
        ),
      ).toBeDisabled();
      fireEvent.change(
        screen.getByLabelText(/Correction or missed-text explanation/u),
        { target: { value: imageReviewCorrection } },
      );
    }
    fireEvent.click(
      screen.getByLabelText(
        'I checked this region and its exact text against the original image.',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use reviewed cell' }));
  }
  fireEvent.click(
    screen.getByRole('button', { name: 'Continue to field meanings' }),
  );
  fireEvent.change(screen.getByLabelText(/Image source review notes/u), {
    target: {
      value:
        'Verified all cells, date and decimal conventions, and omitted Currency heading against the image.',
    },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Preview selected transcription' }),
  );
  await screen.findByRole('button', { name: 'Save reviewed image candidate' });
}
describe('image source binding and visual-review rules', () => {
  it('copies a proposed selection without inheriting any human confirmations', () => {
    const fixture = imageReviewFixture(),
      draft = imageDraftFromSelection(fixture.definition.imageSelection!);
    expect(draft.headers.every((cell) => !cell.confirmed)).toBe(true);
    expect(() => imageSelectionFromDraft(draft, fixture.inspection)).toThrow(
      /Confirm every selected cell/u,
    );
  });
  it('includes geometrically intersecting whole words without assigning their meaning', () => {
    const fixture = imageReviewFixture();
    expect(
      imageCellFromWords(['word-1', 'word-3'], fixture.inspection).wordIds,
    ).toEqual(['word-1', 'word-2', 'word-3']);
    expect(() =>
      imageRegionCell(
        { x: 21, y: 24, width: 73, height: 26 },
        fixture.inspection,
      ),
    ).toThrow(/cuts through/u);
  });
  it('preserves exact corrected strings and requires a reason for a visible OCR-missed region', () => {
    const fixture = imageReviewFixture();
    fixture.inspection.facts.words = fixture.inspection.facts.words.filter(
      (word) => word.id !== 'word-8',
    );
    const missed = imageRegionCell(
      { x: 740, y: 83, width: 58, height: 28 },
      fixture.inspection,
    );
    expect(missed.wordIds).toEqual([]);
    missed.reviewedText = 'CAD';
    expect(imageCellIssue(missed, fixture.inspection)).toMatch(/Explain/u);
    missed.correctionReason =
      'CAD is visible in the original but absent from the OCR inventory.';
    expect(imageCellIssue(missed, fixture.inspection)).toBeUndefined();
  });
  it.each([
    'digest',
    'run',
    'revision',
    'inventory',
    'word',
    'overlap',
    'hidden-word',
    'correction',
  ] as const)('rejects changed %s source proof', (kind) => {
    const fixture = imageReviewFixture(),
      selection = structuredClone(fixture.definition.imageSelection!);
    if (kind === 'digest') selection.expectedSourceDigest = 'a'.repeat(64);
    if (kind === 'run') selection.standardizationRunId = imageReviewIds.book;
    if (kind === 'revision') selection.extractionRevision = 2;
    if (kind === 'inventory')
      selection.reviewedWordInventoryDigest = 'a'.repeat(64);
    if (kind === 'word') selection.headerCells[0]!.words[0]!.text = 'Changed';
    if (kind === 'overlap')
      selection.rows[0]!.cells[0] = selection.headerCells[0]!;
    if (kind === 'hidden-word') selection.headerCells[0]!.words = [];
    if (kind === 'correction')
      selection.rows[0]!.cells[2]!.reviewedText = '12.50';
    expect(() => verifyImageSelection(selection, fixture.inspection)).toThrow();
  });
  it('does not silently omit required canonical fields or assign an optional field twice', () => {
    const fixture = imageReviewFixture(),
      draft = imageDraftFromSelection(fixture.definition.imageSelection!);
    for (const cell of [
      ...draft.headers,
      ...draft.rows.flat(),
      draft.context.currency!,
    ])
      cell.confirmed = true;
    const input = {
      evidenceId: imageReviewIds.evidence,
      inspection: fixture.inspection,
      draft,
      settings: imageMappingSettings(fixture.definition),
      notes: 'Reviewed original.',
      questions: [],
      bindings: {
        transactionDate: '0',
        description: '1',
        amount: '2',
        currency: 'context',
      },
    };
    expect(imageMappingPayload(input).proposal.definition.headers).toEqual([
      'Date',
      'Description',
      'Amount',
    ]);
    expect(() =>
      imageMappingPayload({
        ...input,
        bindings: { ...input.bindings, currency: '' },
      }),
    ).toThrow(/Required canonical fields/u);
    expect(() =>
      imageMappingPayload({
        ...input,
        bindings: { ...input.bindings, fee: '2' },
      }),
    ).toThrow(/different financial meanings/u);
  });
});
describe('image review interface and authorized reads', () => {
  it('requires fresh source confirmation and correction reasons before separate candidate saving', async () => {
    const fixture = setup();
    render(<FinanceImageReview {...fixture.props} />);
    await ready();
    expect(screen.getByText('0 / 7')).toBeInTheDocument();
    await confirmCells();
    expect(fixture.props.onSave).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Save reviewed image candidate' }),
    ).toBeDisabled();
    for (const name of [
      /I checked the selected text/u,
      /I checked the headings/u,
      /I reviewed unselected content/u,
    ])
      fireEvent.click(screen.getByLabelText(name));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save reviewed image candidate' }),
    );
    await waitFor(() => expect(fixture.props.onSave).toHaveBeenCalledOnce());
    const payload = fixture.props.onSave.mock.calls[0]![0];
    expect(payload).toMatchObject({
      evidenceId: imageReviewIds.evidence,
      proposal: {
        definition: {
          imageSelection: {
            expectedSourceDigest: fixture.inspection.sourceDigest,
            expectedExtractionDigest: fixture.inspection.extractionDigest,
            reviewedWordInventoryDigest: fixture.inspection.wordInventoryDigest,
            rows: [
              {
                cells: [
                  {},
                  {},
                  {
                    reviewedText: '12.50',
                    correctionReason: imageReviewCorrection,
                    words: [{ text: '12.5O' }],
                  },
                ],
              },
            ],
          },
        },
      },
    });
    expect(payload).not.toHaveProperty('example');
    expect(payload).not.toHaveProperty('decision');
    expect(
      fixture.fetcher.mock.calls.every(
        ([, init]) =>
          init?.cache === 'no-store' && init.credentials === 'same-origin',
      ),
    ).toBe(true);
  });
  it('resets a cell confirmation after text changes and exposes optional and unmapped field choices', async () => {
    const fixture = setup();
    render(<FinanceImageReview {...fixture.props} />);
    await ready();
    fireEvent.click(
      screen.getByRole('button', { name: 'Review Heading 1: Date' }),
    );
    showOriginal();
    const confirmation = screen.getByLabelText(
      'I checked this region and its exact text against the original image.',
    );
    fireEvent.click(confirmation);
    expect(confirmation).toBeChecked();
    fireEvent.change(screen.getByLabelText('Text visible in this region'), {
      target: { value: 'Changed' },
    });
    expect(confirmation).not.toBeChecked();
    fireEvent.click(
      screen.getByRole('button', { name: 'Back to selected table' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue to field meanings' }),
    );
    expect(screen.getByLabelText('Image mapping: Fee')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Image mapping: Amount'), {
      target: { value: '' },
    });
    expect(
      within(
        screen.getByText('Unmapped selected headings').parentElement!,
      ).getByText('Amount'),
    ).toBeInTheDocument();
  });
  it('supports an OCR-missed region through explicit keyboard pixel bounds with no invented word facts', async () => {
    const fixture = setup();
    fixture.run.proposal = null;
    fixture.run.status = 'blocked';
    fixture.run.modelProvenance = null;
    fixture.inspection.facts.status = 'no-text';
    fixture.inspection.facts.words = [];
    fixture.inspection.facts.text = '';
    fixture.inspection.facts.qualityStatus = 'unreadable';
    fixture.inspection.wordInventoryDigest = hash('[]');
    fixture.inspection.extractionDigest = hash(
      JSON.stringify(fixture.inspection.facts),
    );
    fixture.run.extraction!.extractionDigest =
      fixture.inspection.extractionDigest;
    render(<FinanceImageReview {...fixture.props} />);
    await screen.findByText(/OCR found no readable words/u);
    fireEvent.click(screen.getByRole('button', { name: 'Add source column' }));
    showOriginal();
    for (const [name, value] of [
      ['Left · px', '20'],
      ['Top · px', '24'],
      ['Width · px', '74'],
      ['Height · px', '26'],
    ])
      fireEvent.change(screen.getByLabelText(name!), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Use pixel region' }));
    fireEvent.change(screen.getByLabelText('Text visible in this region'), {
      target: { value: 'Date' },
    });
    expect(
      screen.getByLabelText(
        'I checked this region and its exact text against the original image.',
      ),
    ).toBeDisabled();
    fireEvent.change(
      screen.getByLabelText(/Correction or missed-text explanation/u),
      {
        target: {
          value:
            'The Date heading is visible in this original region. OCR missed it.',
        },
      },
    );
    fireEvent.click(
      screen.getByLabelText(
        'I checked this region and its exact text against the original image.',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use reviewed cell' }));
    expect(
      screen.getByRole('button', { name: 'Review Heading 1: Date' }),
    ).toHaveTextContent('Visually confirmed');
    expect(fixture.props.onSave).not.toHaveBeenCalled();
  });
  it.each([403, 503])(
    'handles current %s inspection failure without revealing a review or save action',
    async (status) => {
      const fixture = setup();
      fixture.state.inspectionStatus = status;
      render(<FinanceImageReview {...fixture.props} />);
      await screen.findByRole('alert');
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      expect(fixture.props.onSave).not.toHaveBeenCalled();
      if (status === 403)
        expect(fixture.props.onAccessUnavailable).toHaveBeenCalledOnce();
    },
  );
  it('aborts and clears the private original when the session changes', async () => {
    const fixture = setup();
    const rendered = render(<FinanceImageReview {...fixture.props} />);
    await ready();
    const oldSignal = fixture.fetcher.mock.calls[0]![1]!.signal;
    auth.sessionBinding = 'replaced';
    fixture.state.inspectionStatus = 403;
    await act(async () =>
      rendered.rerender(<FinanceImageReview {...fixture.props} />),
    );
    await screen.findByRole('alert');
    expect(oldSignal?.aborted).toBe(true);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
  it('does not enable source changes for a viewer or copy a mismatched proposal', async () => {
    const fixture = setup();
    fixture.props.role = 'viewer';
    render(<FinanceImageReview {...fixture.props} />);
    await ready();
    expect(
      screen.getByRole('button', { name: 'Review Heading 1: Date' }),
    ).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Save reviewed image candidate' }),
    ).not.toBeInTheDocument();
  });
  it('rejects a returned wrong source or changed inventory before displaying original bytes', async () => {
    const fixture = setup();
    fixture.inspection.standardizationRunId = imageReviewIds.book;
    await expect(
      readImageReview(fixture.source, new AbortController().signal),
    ).rejects.toThrow(/does not match/u);
  });
  it('preserves binary original upload bytes and rejects unsupported or oversized images', async () => {
    const fixture = imageReviewFixture(),
      bytes = Buffer.from(fixture.original.sourceBase64, 'base64');
    const file = {
      name: 'image-statement.png',
      size: bytes.length,
      arrayBuffer: async () => Uint8Array.from(bytes).buffer,
    } as File;
    await expect(standardizationUpload(file)).resolves.toEqual(
      fixture.original,
    );
    await expect(
      standardizationUpload({ ...file, size: 2097153 }),
    ).rejects.toThrow(/2 MiB/u);
    await expect(
      standardizationUpload({ ...file, name: 'statement.gif' }),
    ).rejects.toThrow(/Choose CSV/u);
  });
});
