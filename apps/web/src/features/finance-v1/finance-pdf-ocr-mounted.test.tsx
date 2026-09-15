import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FinancePdfOcrReview } from './finance-pdf-ocr-review.js';
import {
  imageReviewFixture,
  imageReviewCorrection,
} from '../../../test/finance-image-review-fixture.js';
const seams = vi.hoisted(() => ({ read: vi.fn(), render: vi.fn() }));
vi.mock('../auth/auth-context.js', () => ({
  useAuth: () => ({
    state: 'authenticated',
    sessionBinding: 'current',
    csrfToken: 'current-csrf',
  }),
}));
vi.mock('./finance-pdf-ocr-api.js', () => ({
  readFinancePdfOcrInspection: seams.read,
}));
vi.mock('./finance-pdf-ocr-render.js', () => ({
  renderPdfOcrReview: seams.render,
  loadPdfOcrOriginal: vi.fn(),
}));
function fixture() {
  const image = imageReviewFixture();
  const selection = image.definition.imageSelection!;
  const run = {
    ...image.run,
    format: 'pdf' as const,
    filename: 'original.pdf',
    extraction: { ...image.run.extraction!, kind: 'pdf-ocr' as const },
    proposal: {
      ...image.run.proposal!,
      definition: {
        ...image.definition,
        imageSelection: undefined,
        pdfOcrSelection: {
          expectedSourceDigest: image.run.sourceDigest,
          standardizationRunId: image.run.id,
          extractionRevision: image.run.extraction!.revision,
          expectedExtractionDigest: image.run.extraction!.extractionDigest,
          pageNumber: 2,
          acknowledgeOtherPages: true as const,
          imageSelection: selection,
        },
      },
    },
  };
  seams.read.mockResolvedValue({
    evidenceId: run.evidenceId,
    standardizationRunId: run.id,
    extractionRevision: run.extraction.revision,
    sourceDigest: run.sourceDigest,
    extractionDigest: run.extraction.extractionDigest,
    inventory: {
      sourceDigest: run.sourceDigest,
      pageCount: 2,
      complete: false,
      pages: [
        { kind: 'unresolved', pageNumber: 1, reason: 'render-failed' },
        {
          kind: 'ocr',
          pageNumber: 2,
          result: { render: { pageNumber: 2 }, ocr: image.inspection.facts },
        },
      ],
    },
  });
  seams.render.mockResolvedValue({
    inspection: image.inspection,
    original: {
      filename: 'image-statement.png',
      imageUrl: 'data:image/png;base64,AA==',
      mime: 'application/pdf',
      bytes: new Uint8Array([1]),
    },
  });
  const props = {
    run,
    role: 'preparer',
    disabled: false,
    onSave: vi.fn<(payload: unknown) => Promise<void>>(async () => {}),
    onClose: vi.fn(),
    onAccessUnavailable: vi.fn(),
  };
  return props;
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
describe('mounted PDF page cell correction workflow', () => {
  it('requires fresh confirmations and preserves PDF identity with exact correction', async () => {
    const props = fixture();
    render(<FinancePdfOcrReview {...props} />);
    await screen.findByText(
      'Page 1 omitted from this candidate: render-failed.',
    );
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /I acknowledge that this candidate/,
      }),
    );
    await ready();
    expect(screen.getByText('0 / 7')).toBeInTheDocument();
    await confirmCells();
    expect(props.onSave).not.toHaveBeenCalled();
    for (const name of [
      /I checked the selected text/u,
      /I checked the headings/u,
      /I reviewed unselected content/u,
    ])
      fireEvent.click(screen.getByLabelText(name));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save reviewed image candidate' }),
    );
    await waitFor(() => expect(props.onSave).toHaveBeenCalledOnce());
    const payload = props.onSave.mock.calls[0]![0];
    expect(payload).toMatchObject({
      evidenceId: props.run.evidenceId,
      proposal: {
        definition: {
          pdfOcrSelection: {
            expectedSourceDigest: props.run.sourceDigest,
            pageNumber: 2,
            acknowledgeOtherPages: true,
            imageSelection: {
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
      },
    });
    expect(payload).not.toHaveProperty('proposal.definition.imageSelection');
    expect(payload).not.toHaveProperty('example');
  });
});
