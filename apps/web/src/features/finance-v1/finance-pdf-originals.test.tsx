import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinancePdfOriginals } from './finance-pdf-originals.js';
import { FinanceReportMappings } from './finance-report-mappings.js';
import {
  binaryBookOriginal,
  downloadBinaryBookOriginal,
} from './finance-book-evidence-files.js';
const auth = vi.hoisted(() => ({
  sessionBinding: 'current',
  csrfToken: 'test-csrf',
}));
const save = vi.hoisted(() => vi.fn());
vi.mock('../auth/auth-context.js', () => ({ useAuth: () => auth }));
vi.mock('../../downloads/save-memory-file.js', () => ({
  saveMemoryFile: save,
}));
const bookId = '00000000-0000-4000-8000-000000000001',
  evidenceId = '00000000-0000-4000-8000-000000000002';
const bytes = new Uint8Array([
  37, 80, 68, 70, 45, 49, 46, 55, 10, 255, 0, 13, 10,
]);
const base64 = btoa(String.fromCharCode(...bytes));
const evidence = { id: evidenceId, filename: 'statement.pdf', format: 'pdf' };
const original = { ...evidence, sourceBase64: base64 };
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
function file(name = 'statement.pdf', data = bytes) {
  const result = new File([data], name, { type: 'application/pdf' });
  Object.defineProperty(result, 'arrayBuffer', {
    value: async () => data.buffer,
  });
  return result;
}
async function expand() {
  fireEvent.click(screen.getByText('PDF originals'));
  await screen.findByRole('button', { name: 'Download statement.pdf' });
}
beforeEach(() => {
  auth.sessionBinding = 'current';
  save.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PDF originals and inspection', () => {
  it('uploads unchanged PDF bytes with CSRF and a stable retry key, then requests inspection only', async () => {
    let attempt = 0;
    const fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (++attempt === 1) throw new TypeError('Disconnected');
        return response({ id: evidenceId });
      }
      return response({ documents: [evidence], nextOffset: null });
    });
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(FormData.prototype, 'get').mockImplementation(() => file());
    const inspect = vi.fn(async () => true);
    const { container } = render(
      <FinancePdfOriginals
        bookId={bookId}
        role="preparer"
        onAnalyze={inspect}
      />,
    );
    await expand();
    fireEvent.submit(container.querySelector('form')!);
    await screen.findByRole('alert');
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'No import rows or financial records were created',
      ),
    );
    const posts = fetcher.mock.calls.filter(
      ([, options]) => options?.method === 'POST',
    );
    expect(posts).toHaveLength(2);
    expect(posts[0]![0]).toBe(`/api/v2/finance/books/${bookId}/evidence`);
    expect(JSON.parse(posts[0]![1]!.body as string)).toEqual({
      filename: 'statement.pdf',
      format: 'pdf',
      sourceBase64: base64,
    });
    expect(new Headers(posts[0]![1]!.headers).get('x-csrf-token')).toBe(
      'test-csrf',
    );
    expect(new Headers(posts[1]![1]!.headers).get('idempotency-key')).toBe(
      new Headers(posts[0]![1]!.headers).get('idempotency-key'),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Ask EMDO to inspect statement.pdf' }),
    );
    await waitFor(() =>
      expect(inspect).toHaveBeenCalledWith(bookId, evidenceId, 'inspect-pdf'),
    );
    expect(
      screen.queryByRole('button', { name: /commit|approve|import|mapping/i }),
    ).not.toBeInTheDocument();
  });
  it('rejects oversized, empty and non-PDF originals before sending bytes', async () => {
    await expect(
      binaryBookOriginal(file('statement.pdf', new Uint8Array(2097153)), 'pdf'),
    ).rejects.toThrow('2 MiB');
    await expect(
      binaryBookOriginal(file('empty.pdf', new Uint8Array()), 'pdf'),
    ).rejects.toThrow('nonempty');
    await expect(
      binaryBookOriginal(
        file('not.pdf', new TextEncoder().encode('plain text')),
        'pdf',
      ),
    ).rejects.toThrow('PDF header');
    expect(
      await binaryBookOriginal(
        file('book.xlsx', new Uint8Array([80, 75, 255, 0])),
        'xlsx',
      ),
    ).toMatchObject({ format: 'xlsx', sourceBase64: 'UEv/AA==' });
  });
  it('preserves binary original bytes and the PDF MIME type after an authorized read', async () => {
    const fetcher = vi.fn(async (path: string) =>
      response(
        path.includes('?')
          ? { documents: [evidence], nextOffset: null }
          : original,
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    render(<FinancePdfOriginals bookId={bookId} role="viewer" />);
    await expand();
    expect(
      screen.queryByRole('button', { name: 'Save PDF original' }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Download statement.pdf' }),
    );
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        'statement.pdf',
        bytes,
        'application/pdf',
      ),
    );
    expect(fetcher).toHaveBeenLastCalledWith(
      `/api/v2/finance/books/${bookId}/evidence/${evidenceId}`,
      expect.objectContaining({
        credentials: 'same-origin',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(screen.getByText(/Image-only pages need OCR/)).toBeInTheDocument();
  });
  it.each([403, 503])(
    'clears originals and blocks download when the server responds %s',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (path: string) =>
          path.includes('?')
            ? response({ documents: [evidence], nextOffset: null })
            : response({}, status),
        ),
      );
      render(<FinancePdfOriginals bookId={bookId} role="viewer" />);
      await expand();
      fireEvent.click(
        screen.getByRole('button', { name: 'Download statement.pdf' }),
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(
        status === 403 ? 'Current book access' : 'not available',
      );
      expect(
        screen.queryByRole('button', { name: 'Download statement.pdf' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText('No PDF originals on this page.'),
      ).not.toBeInTheDocument();
      expect(save).not.toHaveBeenCalled();
    },
  );
  it('does not download a late response after the session changes', async () => {
    let finish: (value: Response) => void = () => {};
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        if (path.includes('?'))
          return response({ documents: [evidence], nextOffset: null });
        signal = init?.signal as AbortSignal;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }),
    );
    const { rerender } = render(
      <FinancePdfOriginals bookId={bookId} role="viewer" />,
    );
    await expand();
    fireEvent.click(
      screen.getByRole('button', { name: 'Download statement.pdf' }),
    );
    auth.sessionBinding = 'changed';
    rerender(<FinancePdfOriginals bookId={bookId} role="viewer" />);
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(response(original)));
    expect(save).not.toHaveBeenCalled();
  });
  it('routes a PDF saved in Report standardization to inspection without proposing mappings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) =>
        response(
          path.includes('/evidence?')
            ? { documents: [evidence], nextOffset: null }
            : { mappings: [], nextOffset: null },
        ),
      ),
    );
    const inspect = vi.fn(async () => true);
    render(
      <FinanceReportMappings
        bookId={bookId}
        role="viewer"
        onAnalyze={inspect}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Open report standardization' }),
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Ask EMDO to inspect statement.pdf',
      }),
    );
    await waitFor(() =>
      expect(inspect).toHaveBeenCalledWith(bookId, evidenceId, 'inspect-pdf'),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'No mapping or import was requested',
    );
    expect(
      screen.queryByRole('button', { name: /approve|commit|reuse/i }),
    ).not.toBeInTheDocument();
  });
  it('rejects mismatched or malformed binary download responses', () => {
    expect(() =>
      downloadBinaryBookOriginal({ ...original, format: 'xlsx' }, 'pdf'),
    ).toThrow('format changed');
    expect(() =>
      downloadBinaryBookOriginal({ ...original, sourceBase64: '%' }, 'pdf'),
    ).toThrow();
    expect(save).not.toHaveBeenCalled();
  });
});
