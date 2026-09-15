import { webcrypto } from 'node:crypto';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { FinanceStandardization } from './finance-standardization.js';
import {
  downloadStandardizationOriginal,
  verifyStandardizationRun,
} from './finance-standardization-api.js';
import { saveMemoryFile } from '../../downloads/save-memory-file.js';
import {
  standardizationFixture,
  standardizationBookId,
  standardizationCsv,
  standardizationDigest,
  standardizationEvidenceId,
} from '../../../test/finance-standardization-fixture.js';

const auth = vi.hoisted(() => ({
  state: 'authenticated',
  sessionBinding: 'standardization-session',
  csrfToken: 'standard-csrf' as string | undefined,
}));
vi.mock('../auth/auth-context.js', () => ({ useAuth: () => auth }));
vi.mock('../../downloads/save-memory-file.js', () => ({
  saveMemoryFile: vi.fn(),
}));
beforeEach(() => {
  auth.state = 'authenticated';
  auth.sessionBinding = 'standardization-session';
  auth.csrfToken = 'standard-csrf';
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(saveMemoryFile).mockClear();
  vi.useRealTimers();
});
function setup(role = 'preparer') {
  const fixture = standardizationFixture();
  fixture.state.canManage = role !== 'viewer';
  const writes: Array<{
    path: string;
    body: Record<string, unknown>;
    key: string;
  }> = [];
  const fetcher = vi.fn<
    (path: string, init?: RequestInit) => Promise<Response>
  >(async (path, init) => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    if (init?.method === 'POST') {
      const headers = new Headers(init.headers);
      expect(headers.get('x-csrf-token')).toBe('standard-csrf');
      expect(headers.get('idempotency-key')).toMatch(/^[a-f0-9-]{36}$/u);
      writes.push({ path, body, key: headers.get('idempotency-key')! });
    }
    const result = fixture.handle(path, init?.method, body);
    return new Response(JSON.stringify(result.json), { status: result.status });
  });
  vi.stubGlobal('fetch', fetcher);
  const props = {
    bookId: standardizationBookId,
    role,
    sources: fixture.originals,
    onOriginalSaved: vi.fn(async () => {}),
    onOpenMapping: vi.fn(async () => {}),
    onReviewSource: vi.fn(async () => {}),
    onAccessUnavailable: vi.fn(),
  };
  return { ...fixture, writes, fetcher, props };
}
function file(name = 'activity.csv', content = standardizationCsv) {
  const value = new File([content], name, { type: 'text/csv' });
  Object.defineProperty(value, 'arrayBuffer', {
    value: async () => new TextEncoder().encode(content).buffer,
  });
  return value;
}
async function loaded() {
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Refresh saved analyses' }),
    ).not.toBeDisabled(),
  );
}
async function openRun(filename = 'activity.csv') {
  fireEvent.click(
    await screen.findByRole('button', {
      name: `Open saved analysis: ${filename}`,
    }),
  );
  return screen.findByRole('region', { name: 'Saved analysis detail' });
}
describe('saved report standardization lifecycle', () => {
  it('requires explicit background-analysis authorization and binds its start to the uploaded server fingerprint', async () => {
    const fixture = setup();
    render(<FinanceStandardization {...fixture.props} />);
    await loaded();
    fireEvent.change(screen.getByLabelText('Report or image original'), {
      target: { files: [file()] },
    });
    const start = screen.getByRole('button', {
      name: 'Save original and start analysis',
    });
    expect(start).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /Allow EMDO to inspect this saved original/u,
      }),
    );
    fireEvent.click(start);
    await screen.findByRole('region', { name: 'Saved analysis detail' });
    expect(fixture.writes.map((write) => write.path.split('/').pop())).toEqual([
      'evidence',
      'standardizations',
    ]);
    expect(fixture.writes[1]!.body).toEqual({
      evidenceId: standardizationEvidenceId,
      expectedSourceDigest: standardizationDigest,
    });
    expect(fixture.runs[0]).toMatchObject({
      status: 'queued',
      approval: 'not-granted',
      posting: 'not-performed',
    });
    expect(
      screen.queryByRole('button', { name: 'Open mapping review' }),
    ).not.toBeInTheDocument();
  });
  it('resumes an uncertain start after reload without reupload or duplicate analysis', async () => {
    const fixture = setup();
    fixture.state.loseStartResponse = true;
    const view = render(<FinanceStandardization {...fixture.props} />);
    await loaded();
    fireEvent.change(screen.getByLabelText('Report or image original'), {
      target: { files: [file()] },
    });
    fireEvent.click(
      screen.getByRole('checkbox', { name: /Allow EMDO to inspect/u }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Save original and start analysis' }),
    );
    await screen.findByText(/The last action needs a status check/u);
    expect(screen.getByText('activity.csv is saved')).toBeInTheDocument();
    expect(fixture.runs).toHaveLength(1);
    view.unmount();
    render(<FinanceStandardization {...fixture.props} />);
    const detail = await openRun();
    expect(within(detail).getByText('Waiting to start')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Analyze an existing saved original'));
    fireEvent.change(screen.getByLabelText('Saved original for analysis'), {
      target: { value: standardizationEvidenceId },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Review analysis request' }),
    );
    const confirmation = screen.getByRole('region', {
      name: 'Confirm saved analysis action',
    });
    fireEvent.click(within(confirmation).getByRole('checkbox'));
    fireEvent.click(
      within(confirmation).getByRole('button', {
        name: 'Start saved analysis',
      }),
    );
    await waitFor(() =>
      expect(
        fixture.writes.filter((write) =>
          write.path.endsWith('/standardizations'),
        ),
      ).toHaveLength(2),
    );
    expect(
      fixture.writes.filter((write) => write.path.endsWith('/evidence')),
    ).toHaveLength(1);
    expect(fixture.runs).toHaveLength(1);
  });
  it('keeps unavailable background analysis separate from usable manual original saving', async () => {
    const fixture = setup();
    fixture.state.ready = false;
    render(<FinanceStandardization {...fixture.props} />);
    await loaded();
    expect(
      screen.getByText('Background analysis is not available right now.'),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Report or image original'), {
      target: { files: [file()] },
    });
    expect(
      screen.getByRole('button', { name: 'Save original and start analysis' }),
    ).toBeDisabled();
    fireEvent.submit(
      screen
        .getByRole('button', { name: 'Save original report' })
        .closest('form')!,
    );
    await screen.findByText('activity.csv is saved');
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.runs).toHaveLength(0);
    fireEvent.click(screen.getByText('Format availability and limits'));
    expect(screen.getByText('PNG / JPEG / WEBP')).toBeInTheDocument();
    expect(screen.getAllByText('Manual review in Documents')).toHaveLength(2);
    expect(
      screen.getByText('Background analysis is not available right now.'),
    ).toBeInTheDocument();
  });
  it('rejects an unsupported file before sending or locking a mutation', async () => {
    const fixture = setup();
    render(<FinanceStandardization {...fixture.props} />);
    await loaded();
    fireEvent.change(screen.getByLabelText('Report or image original'), {
      target: { files: [file('scan.gif')] },
    });
    fireEvent.submit(
      screen
        .getByRole('button', { name: 'Save original report' })
        .closest('form')!,
    );
    await screen.findByText(/Choose CSV, XLSX, PDF, PNG, JPEG or WebP/u);
    expect(fixture.writes).toHaveLength(0);
    expect(
      screen.getByRole('button', { name: 'Save original report' }),
    ).not.toBeDisabled();
    expect(
      screen.queryByText(/The last action needs a status check/u),
    ).not.toBeInTheDocument();
  });
  it('opens a saved declarative XLSX proposal for fresh source review without claiming a registry mapping exists', async () => {
    const fixture = setup();
    const run = fixture.createRun('needs-review', 'xlsx');
    render(<FinanceStandardization {...fixture.props} />);
    const detail = await openRun('activity.xlsx');
    expect(
      within(detail).getByText(
        'Confirm whether positive amounts represent receipts.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open mapping review' }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(detail).getByRole('button', { name: 'Review original source' }),
    );
    await waitFor(() =>
      expect(fixture.props.onReviewSource).toHaveBeenCalledWith(run),
    );
    expect(fixture.writes).toHaveLength(0);
    expect(
      screen.queryByRole('button', { name: /approve|post financial/iu }),
    ).not.toBeInTheDocument();
  });
  it('reviews retry and cancellation against exact saved revisions and current server actions', async () => {
    const fixture = setup();
    const run = fixture.createRun('blocked');
    render(<FinanceStandardization {...fixture.props} />);
    await openRun();
    fireEvent.click(screen.getByRole('button', { name: 'Review retry' }));
    let confirmation = screen.getByRole('region', {
      name: 'Confirm saved analysis action',
    });
    expect(fixture.writes).toHaveLength(0);
    expect(
      within(confirmation).getByRole('button', {
        name: 'Retry saved analysis',
      }),
    ).toBeDisabled();
    fireEvent.click(within(confirmation).getByRole('checkbox'));
    fireEvent.click(
      within(confirmation).getByRole('button', {
        name: 'Retry saved analysis',
      }),
    );
    await screen.findByRole('button', { name: 'Review cancellation' });
    expect(fixture.writes[0]!.body).toEqual({ expectedRevision: 1 });
    expect(run).toMatchObject({ revision: 2, attempt: 1, status: 'queued' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Review cancellation' }),
    );
    confirmation = screen.getByRole('region', {
      name: 'Confirm saved analysis action',
    });
    fireEvent.click(within(confirmation).getByRole('checkbox'));
    fireEvent.click(
      within(confirmation).getByRole('button', {
        name: 'Cancel saved analysis',
      }),
    );
    await waitFor(() => expect(run.status).toBe('cancelled'));
    expect(fixture.writes[1]!.body).toEqual({ expectedRevision: 2 });
    expect(fixture.originals).toHaveLength(1);
  });
  it('preserves read-only mapping access without CSRF while withholding mutation controls', async () => {
    const fixture = setup('viewer');
    const run = fixture.createRun('needs-review');
    auth.csrfToken = undefined;
    render(<FinanceStandardization {...fixture.props} />);
    await openRun();
    expect(
      screen.queryByRole('button', { name: 'Save original report' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Review retry' }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Open mapping review' }),
    );
    await waitFor(() =>
      expect(fixture.props.onOpenMapping).toHaveBeenCalledWith(run),
    );
    expect(fixture.writes).toHaveLength(0);
  });
  it('clears forbidden detail and aborts a late original download across session changes', async () => {
    const fixture = setup();
    const run = fixture.createRun('needs-review');
    const original = fixture.fetcher.getMockImplementation()!;
    let finish: (() => void) | undefined;
    let signal: AbortSignal | null | undefined;
    fixture.fetcher.mockImplementation((path, init) =>
      path.endsWith(`/evidence/${standardizationEvidenceId}`)
        ? new Promise((resolve) => {
            signal = init?.signal;
            finish = () =>
              resolve(
                new Response(
                  JSON.stringify({
                    filename: run.filename,
                    format: 'csv',
                    sourceText: standardizationCsv,
                  }),
                ),
              );
          })
        : original(path, init),
    );
    const view = render(<FinanceStandardization {...fixture.props} />);
    await openRun();
    fireEvent.click(
      screen.getByRole('button', { name: 'Download analysis original' }),
    );
    await waitFor(() => expect(finish).toBeDefined());
    auth.state = 'anonymous';
    view.rerender(<FinanceStandardization {...fixture.props} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish!();
    });
    expect(saveMemoryFile).not.toHaveBeenCalled();
    auth.state = 'authenticated';
    fixture.state.readStatus = 403;
    view.rerender(<FinanceStandardization {...fixture.props} />);
    await waitFor(() =>
      expect(fixture.props.onAccessUnavailable).toHaveBeenCalled(),
    );
    expect(
      screen.queryByRole('region', { name: 'Saved analysis detail' }),
    ).not.toBeInTheDocument();
  });
  it('verifies source digest bindings and downloaded bytes rather than trusting filenames', async () => {
    const fixture = setup();
    const run = fixture.createRun('needs-review');
    expect(() =>
      verifyStandardizationRun(
        {
          ...run,
          extraction: { ...run.extraction, sourceDigest: 'f'.repeat(64) },
        },
        standardizationBookId,
      ),
    ).toThrow('could not be verified');
    await downloadStandardizationOriginal(run, new AbortController().signal);
    expect(saveMemoryFile).toHaveBeenCalledTimes(1);
    await expect(
      downloadStandardizationOriginal(
        { ...run, sourceDigest: 'f'.repeat(64) },
        new AbortController().signal,
      ),
    ).rejects.toThrow('No file was downloaded');
    expect(saveMemoryFile).toHaveBeenCalledTimes(1);
  });
  it('labels extraction-only completion without claiming a model proposal', async () => {
    const fixture = setup();
    const run = fixture.createRun('extracted');
    run.executionMode = 'extraction-only';
    run.proposal = null;
    run.modelProvenance = null;
    render(<FinanceStandardization {...fixture.props} />);
    await loaded();
    fireEvent.click(
      screen.getByRole('button', { name: 'Open saved analysis: activity.csv' }),
    );
    const detail = await screen.findByRole('region', {
      name: 'Saved analysis detail',
    });
    expect(detail).toHaveTextContent('Extraction saved');
    expect(detail).not.toHaveTextContent('Proposal saved');
    expect(
      within(detail).queryByRole('button', { name: 'Open mapping review' }),
    ).not.toBeInTheDocument();
  });
  it('does not present an unavailable list as an empty saved workflow', async () => {
    const fixture = setup();
    fixture.state.readStatus = 503;
    render(<FinanceStandardization {...fixture.props} />);
    await screen.findByText(
      /Saved report analysis is not available right now/u,
    );
    expect(
      screen.queryByText('No saved analyses on this page'),
    ).not.toBeInTheDocument();
  });
  it('refreshes active saved progress without stealing focus and stops polling after a terminal state', async () => {
    const fixture = setup();
    const run = fixture.createRun('queued');
    vi.useFakeTimers();
    await act(async () => {
      render(<FinanceStandardization {...fixture.props} />);
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Open saved analysis: activity.csv',
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    const detail = screen.getByRole('region', {
      name: 'Saved analysis detail',
    });
    const button = within(detail).getByRole('button', {
      name: 'Download analysis original',
    });
    button.focus();
    fixture.updateRun(run, 'proposing');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(detail).toHaveTextContent('Preparing proposal');
    expect(document.activeElement).toBe(button);
    fixture.updateRun(run, 'needs-review');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(detail).toHaveTextContent('Proposal saved');
    const requests = fixture.fetcher.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(fixture.fetcher.mock.calls).toHaveLength(requests);
  });
});
