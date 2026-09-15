vi.mock('../auth/auth-context.js', () => ({
  useAuth: () => ({ state: 'authenticated', sessionBinding: 'current' }),
}));
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FinancePdfOcrReview } from './finance-pdf-ocr-review.js';
import { imageReviewFixture } from '../../../test/finance-image-review-fixture.js';
import { SaveReviewedFinanceImageMappingSchema } from '@emdo/contracts/browser';
const seams = vi.hoisted(() => ({
  read: vi.fn(),
  render: vi.fn(),
  save: vi.fn(),
  child: vi.fn(),
}));
vi.mock('./finance-pdf-ocr-api.js', () => ({
  readFinancePdfOcrInspection: seams.read,
}));
vi.mock('./finance-pdf-ocr-render.js', () => ({
  renderPdfOcrReview: seams.render,
  loadPdfOcrOriginal: vi.fn(),
}));
vi.mock('./finance-image-review.js', () => ({
  FinanceImageReview: (props: {
    disabled: boolean;
    onSave: (input: unknown) => Promise<void>;
  }) => {
    seams.child(props);
    return (
      <button
        disabled={props.disabled}
        onClick={() => {
          void props.onSave(seams.save());
        }}
      >
        Save selected regions
      </button>
    );
  },
}));
beforeEach(() => vi.clearAllMocks());
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
  seams.save.mockReturnValue(
    SaveReviewedFinanceImageMappingSchema.parse({
      evidenceId: run.evidenceId,
      proposal: {
        definition: image.definition,
        rationale: 'Reviewed original cells',
        unresolvedQuestions: [],
      },
    }),
  );
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
describe('mounted scanned PDF review adapter', () => {
  it('requires other-page acknowledgement and emits PDF-only source-bound selection', async () => {
    const props = fixture();
    render(<FinancePdfOcrReview {...props} />);
    await screen.findByText(
      'Page 1 omitted from this candidate: render-failed.',
    );
    expect(screen.getByRole('combobox')).toHaveValue('2');
    expect(
      screen.getByRole('button', { name: 'Save selected regions' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save selected regions' }),
    );
    await waitFor(() => expect(props.onSave).toHaveBeenCalledOnce());
    const payload = props.onSave.mock.calls[0]![0] as unknown as {
      proposal: { definition: Record<string, unknown> };
      evidenceId: string;
    };
    expect(payload.evidenceId).toBe(props.run.evidenceId);
    expect(payload.proposal.definition.imageSelection).toBeUndefined();
    expect(payload.proposal.definition.pdfSelection).toBeUndefined();
    expect(payload.proposal.definition.pdfOcrSelection).toEqual(
      props.run.proposal.definition.pdfOcrSelection,
    );
    expect(payload).not.toHaveProperty('example');
    expect(seams.child.mock.lastCall![0].run.format).toBe('pdf');
    expect(seams.child.mock.lastCall![0].sourceAdapter).toBeDefined();
  });
  it('mounts manual page review for a blocked run without a model proposal', async () => {
    const props = fixture();
    render(
      <FinancePdfOcrReview
        {...props}
        run={{ ...props.run, status: 'blocked', proposal: null }}
      />,
    );
    await screen.findByText(
      'Page 1 omitted from this candidate: render-failed.',
    );
    expect(screen.getByRole('combobox')).toHaveValue('2');
    expect(seams.child.mock.lastCall![0].run.proposal).toBeNull();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(
      screen.getByRole('button', { name: 'Save selected regions' }),
    ).toBeEnabled();
  });
  it('shows unavailable saved evidence without exposing an editor', async () => {
    const props = fixture();
    seams.read.mockRejectedValue(new Error('Current book access denied'));
    render(<FinancePdfOcrReview {...props} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Current book access denied',
    );
    expect(
      screen.queryByRole('button', { name: 'Save selected regions' }),
    ).toBeNull();
  });
});
