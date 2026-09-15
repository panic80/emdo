import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinanceFec } from './finance-fec.js';
vi.mock('../auth/auth-context.js', () => ({
  useAuth: () => ({ sessionBinding: 'current', csrfToken: 'csrf' }),
}));
afterEach(() => vi.unstubAllGlobals());
const props = {
  bookId: '00000000-0000-4000-8000-000000000001',
  bookName: 'France',
  role: 'approver',
  accounts: [
    { id: '00000000-0000-4000-8000-000000000002', code: '1000', name: 'Cash' },
  ],
  journals: [],
};
describe('France FEC review screen', () => {
  it('starts with empty legal metadata and requires explicit review', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('null')));
    render(<FinanceFec {...props} />);
    await screen.findByText('No reviewed mapping has been saved.');
    expect(screen.getByLabelText('SIREN (9 digits)')).toHaveValue('');
    expect(
      screen.getByRole('button', { name: 'Save immutable revision' }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Add ledger account'), {
      target: { value: props.accounts[0]!.id },
    });
    expect(screen.getByLabelText('French account number')).toHaveValue('');
    expect(screen.getByLabelText('French account label')).toHaveValue('');
  });
  it('does not permit preparer mapping review', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('null')));
    render(<FinanceFec {...props} role="preparer" />);
    await screen.findByText('No reviewed mapping has been saved.');
    expect(
      screen.queryByRole('button', { name: 'Save immutable revision' }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('SIREN (9 digits)')).toBeDisabled();
  });
  it('shows unavailable service without a working export form', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 503 })),
    );
    render(<FinanceFec {...props} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'not enabled or ready',
    );
    expect(
      screen.queryByRole('button', { name: 'Validate and generate FEC' }),
    ).not.toBeInTheDocument();
  });
});

it('ignores a delayed response from a previously selected book', async () => {
  let resolveOld!: (response: Response) => void;
  const oldResponse = new Promise<Response>((resolve) => {
    resolveOld = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation((url: string) =>
        url.includes('/evidence?')
          ? Promise.resolve(
              new Response(JSON.stringify({ documents: [], nextOffset: null })),
            )
          : url.includes(props.bookId)
            ? oldResponse
            : Promise.resolve(new Response('null')),
      ),
  );
  const view = render(<FinanceFec {...props} />);
  view.rerender(
    <FinanceFec
      {...props}
      bookId="00000000-0000-4000-8000-000000000099"
      bookName="Second book"
    />,
  );
  await screen.findByText('No reviewed mapping has been saved.');
  const source = {
    sourceReference: 'old-book-evidence',
    sourceDigest: 'a'.repeat(64),
  };
  await act(async () => {
    resolveOld(
      new Response(
        JSON.stringify({
          bookId: props.bookId,
          revision: 1,
          reviewedBy: props.bookId,
          reviewedAt: '2026-09-14T12:00:00Z',
          mapping: {
            expectedRevision: 1,
            siren: '123456789',
            sirenSource: source,
            openingBalances: { status: 'included', source },
            journals: [],
            accounts: [],
          },
        }),
      ),
    );
    await oldResponse;
  });
  expect(screen.getByLabelText('SIREN (9 digits)')).toHaveValue('');
  expect(
    screen.getByText('No reviewed mapping has been saved.'),
  ).toBeInTheDocument();
});

it('selects uploaded document fingerprints and supports an explicit external source', async () => {
  const document = {
    id: '00000000-0000-4000-8000-000000000008',
    filename: 'Registration.pdf',
    format: 'pdf',
    sourceDigest: 'c'.repeat(64),
    byteSize: 123,
    createdAt: '2026-09-14T12:00:00Z',
  };
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              url.includes('/evidence?')
                ? { documents: [document], nextOffset: null }
                : null,
            ),
          ),
        ),
      ),
  );
  render(<FinanceFec {...props} />);
  await screen.findByText('1 uploaded book documents available as sources.');
  fireEvent.change(screen.getByLabelText('SIREN uploaded document'), {
    target: { value: document.id },
  });
  expect(screen.getByLabelText('SIREN source reference')).toHaveValue(
    `evidence:${document.id}`,
  );
  expect(screen.getByLabelText('SIREN source SHA-256')).toHaveValue(
    document.sourceDigest,
  );
  expect(screen.getByLabelText('SIREN source SHA-256')).toHaveAttribute(
    'readonly',
  );
  fireEvent.change(screen.getByLabelText('SIREN source type'), {
    target: { value: 'external' },
  });
  expect(screen.getByLabelText('SIREN source reference')).toHaveValue('');
  expect(screen.getByLabelText('SIREN source SHA-256')).not.toHaveAttribute(
    'readonly',
  );
});
