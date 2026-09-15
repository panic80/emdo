import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinanceStructuredInvoices } from './finance-structured-invoices.js';
import fixtures from '../../../test/finance-invoice-fixture.json';
import { StructuredInvoiceExtractionSchema } from '@emdo/contracts/browser';
vi.mock('../auth/auth-context.js', () => ({
  useAuth: () => ({ sessionBinding: 'current', csrfToken: 'csrf' }),
}));
const id = '00000000-0000-4000-8000-000000000001';
const source = StructuredInvoiceExtractionSchema.parse(fixtures.ubl.source);
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
function setup() {
  let stored: unknown = null,
    attempts = 0;
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/review-and-post')) {
      if (++attempts === 1) return response({}, 500);
      return response({
        id,
        journalId: id,
        evidenceId: id,
        total: '113.05',
        currency: 'EUR',
        sourceDigest: source.sourceDigest,
        adapterVersion: source.adapterVersion,
      });
    }
    if (path.endsWith('/review-draft')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        stored = {
          id,
          evidenceId: id,
          revision: body.expectedRevision + 1,
          draft: body.draft,
        };
        return response(stored);
      }
      return response({ review: stored, posting: null });
    }
    if (path.endsWith('/structured-invoice')) return response(source);
    if (path.endsWith('/commercial'))
      return response({
        parties: [
          { id, name: 'Seller', kind: 'organization', reference: 'seller' },
        ],
      });
    return response({
      documents: [{ id, filename: 'invoice.xml', format: 'ubl' }],
      nextOffset: null,
    });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
function mount(role = 'administrator') {
  return render(
    <FinanceStructuredInvoices
      bookId={id}
      currency="EUR"
      role={role}
      accounts={[{ id, code: '100', name: 'Account', kind: 'asset' }]}
      onSaved={() => {}}
    />,
  );
}
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Open invoice library' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'invoice.xml · UBL' }),
  );
  await screen.findByRole('heading', {
    name: `Invoice ${source.invoiceId?.value}`,
  });
}
afterEach(() => vi.unstubAllGlobals());
describe('durable structured invoice review', () => {
  it('saves partial mappings and restores them after component/session reload without browser storage', async () => {
    const fetcher = setup();
    const view = mount();
    await open();
    fireEvent.change(screen.getByLabelText('Existing counterparty'), {
      target: { value: id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save review' }));
    await screen.findByText(/Review revision 1 saved/);
    fireEvent.click(screen.getByRole('button', { name: 'Review posting' }));
    expect(
      screen.queryByRole('button', { name: 'Confirm and post invoice' }),
    ).not.toBeInTheDocument();
    view.unmount();
    mount();
    await open();
    expect(
      (screen.getByLabelText('Existing counterparty') as HTMLSelectElement)
        .value,
    ).toBe(id);
    expect(screen.getByText('Saved review revision 1')).toBeInTheDocument();
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1);
  });
  it('keeps unsaved mappings on source refresh and invalidates acknowledgements when mappings change', async () => {
    setup();
    mount();
    await open();
    const acknowledgement = screen.getByLabelText(
      /I verified the source seller/,
    );
    fireEvent.click(acknowledgement);
    expect(acknowledgement).toBeChecked();
    fireEvent.change(screen.getByLabelText('Existing counterparty'), {
      target: { value: id },
    });
    expect(acknowledgement).not.toBeChecked();
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh invoice source' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Refresh invoice source' }),
      ).not.toBeDisabled(),
    );
    expect(
      (screen.getByLabelText('Existing counterparty') as HTMLSelectElement)
        .value,
    ).toBe(id);
  });
  it('retries an unconfirmed posting with the same saved revision, body and idempotency key', async () => {
    const fetcher = setup();
    mount();
    await open();
    for (const label of [
      'Existing counterparty',
      'Payables / receivables control account',
      'Net account for group 1',
      'Tax account for group 1',
    ])
      fireEvent.change(screen.getByLabelText(label), { target: { value: id } });
    for (const label of [
      /I verified the source seller/,
      /I reviewed the exact amounts/,
      /I understand this extraction/,
    ])
      fireEvent.click(screen.getByLabelText(label));
    fireEvent.click(screen.getByRole('button', { name: 'Save review' }));
    await screen.findByText(/Review revision 1 saved/);
    fireEvent.click(screen.getByRole('button', { name: 'Review posting' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm and post invoice' }),
    );
    const retry = await screen.findByRole('button', {
      name: 'Retry same posting',
    });
    await waitFor(() => expect(retry).not.toBeDisabled());
    expect(screen.getByLabelText('Existing counterparty')).toBeDisabled();
    fireEvent.click(retry);
    await screen.findByRole('heading', { name: 'Posted 113.05 EUR' });
    const posts = fetcher.mock.calls.filter(([path]) =>
      path.endsWith('/review-and-post'),
    );
    expect(posts).toHaveLength(2);
    expect(posts[0]?.[1]?.body).toBe(posts[1]?.[1]?.body);
    expect(posts[0]?.[1]?.headers).toEqual(posts[1]?.[1]?.headers);
  });
  it('shows original facts but no upload or accounting mutation for a viewer', async () => {
    setup();
    mount('viewer');
    await open();
    expect(
      screen.queryByRole('button', { name: 'Save review' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Upload invoice original' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Original field provenance and source binding'),
    ).toBeInTheDocument();
  });
});
