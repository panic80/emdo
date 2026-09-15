import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { TaxWageEvidence } from './finance-tax-wage-evidence.js';
import type { TaxCaseOperation } from './finance-tax-workspace.js';
import type { TaxWorkingPreparation } from './finance-tax-working-model.js';
import type { TaxDeclaration } from './finance-tax-model.js';
const id = '10000000-0000-4000-8000-000000000001',
  book = '10000000-0000-4000-8000-000000000002',
  evidence = '10000000-0000-4000-8000-000000000003',
  sha = 'a'.repeat(64);
const preparation: TaxWorkingPreparation = {
  caseId: id,
  taxSubjectId: id,
  snapshotRevision: 3,
  snapshotHash: sha,
  workflowId: 'us-fed-2025-working-papers',
  packageVersion: '2025.4-federal-working-papers+private.2',
  packageHash: sha,
  complete: false,
  scopeSupported: true,
  supportedScopes: [],
  questions: [],
  inputReviews: [],
};
const source: TaxDeclaration = {
  sourceId: id,
  sourceRevision: 1,
  contentHash: sha,
  factKey: 'wageEvidence.documents',
  category: 'general',
  value: {
    type: 'text',
    value: JSON.stringify({
      schemaVersion: 1,
      documents: [
        {
          bookId: book,
          evidenceId: evidence,
          form: 'W-2',
          originalEvidenceId: null,
          boxes: {
            box1: '20000',
            box2: '1000',
            box3: '20000',
            box5: '20000',
            box6: '290',
            box7: '0',
          },
        },
      ],
    }),
  },
};
function setup(role: 'preparer' | 'reviewer' | 'viewer', reviewed = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            caseId: id,
            snapshotRevision: 3,
            snapshotHash: sha,
            documents: [
              {
                bookId: book,
                evidenceId: evidence,
                filename: 'Employer W2.pdf',
                format: 'pdf',
                contentHash: sha,
                byteSize: 100,
              },
            ],
            review: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ),
  );
  const operate = vi.fn(async (...args: unknown[]) => {
    void args;
    return {};
  });
  render(
    <TaxWageEvidence
      caseId={id}
      preparation={{
        ...preparation,
        inputReviews: reviewed
          ? [
              {
                sourceId: id,
                sourceRevision: 1,
                contentHash: sha,
                reviewedBy: id,
                reviewedAt: '2026-09-14T00:00:00Z',
              },
            ]
          : [],
      }}
      source={source}
      canEdit={role === 'preparer'}
      canReview={role === 'reviewer'}
      disabled={false}
      operate={operate as TaxCaseOperation}
    />,
  );
  return operate;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('private W-2 evidence controls', () => {
  it('collects explicit correction metadata with named retained documents', async () => {
    setup('preparer');
    await screen.findByRole('option', { name: 'Employer W2.pdf' });
    fireEvent.change(screen.getByLabelText('Document form'), {
      target: { value: 'W-2c' },
    });
    expect(screen.getByLabelText('Root original W-2')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Immediately previous document'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Correct Box 1'));
    fireEvent.change(screen.getByLabelText('Previously reported Box 1'), {
      target: { value: '19000' },
    });
    fireEvent.change(screen.getByLabelText('Correct amount Box 1'), {
      target: { value: '20000' },
    });
    expect(
      (screen.getByLabelText('Previously reported Box 1') as HTMLInputElement)
        .value,
    ).toBe('19000');
    expect(
      (screen.getByLabelText('Correct amount Box 1') as HTMLInputElement).value,
    ).toBe('20000');
    expect(screen.getByText(/identity-only correction/)).toBeInTheDocument();
  });
  it('shows filenames and structured box fields; saves an unreviewed exact extraction', async () => {
    const operate = setup('preparer');
    await screen.findByRole('option', { name: 'Employer W2.pdf' });
    fireEvent.change(screen.getByLabelText('Box 2'), {
      target: { value: '1200.25' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save document boxes' }),
    );
    await waitFor(() => expect(operate).toHaveBeenCalled());
    const payload = operate.mock.calls[0]![1] as unknown as {
      value: { value: string };
    };
    expect(JSON.parse(payload.value.value).documents[0].boxes.box2).toBe(
      '1200.25',
    );
    expect(screen.queryByRole('textbox', { name: /JSON|UUID/ })).toBeNull();
  });
  it('requires exact saved review before approving original evidence and submits no browser box authority', async () => {
    const operate = setup('reviewer', true);
    await screen.findByRole('option', { name: 'Employer W2.pdf' });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Approve original evidence binding' }),
    );
    await waitFor(() => expect(operate).toHaveBeenCalled());
    expect(operate.mock.calls[0]![0]).toBe(
      'working-papers/wage-evidence-reviews',
    );
    expect(operate.mock.calls[0]![1]).toEqual({
      ...{
        expectedCaseRevision: 3,
        expectedSnapshotHash: sha,
        workflowId: preparation.workflowId,
        expectedPackageVersion: preparation.packageVersion,
      },
      input: { sourceId: id, sourceRevision: 1, contentHash: sha },
      acknowledgement: 'verified-saved-boxes-against-original-documents',
    });
  });
  it('gives viewers original access without edit or approval controls', async () => {
    setup('viewer');
    await screen.findByRole('option', { name: 'Employer W2.pdf' });
    expect(
      screen.queryByRole('button', { name: 'Save document boxes' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: 'Approve original evidence binding',
      }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Download original W-2 1' }),
    ).toBeTruthy();
  });
});
