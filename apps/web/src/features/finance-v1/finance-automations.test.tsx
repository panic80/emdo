import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinanceAutomationGrant } from '@emdo/contracts/browser';
import { FinanceAutomations } from './finance-automations.js';

const auth = vi.hoisted(() => ({
  sessionBinding: 'session-one',
  csrfToken: 'test-csrf' as string | undefined,
}));
vi.mock('../auth/auth-context.js', () => ({ useAuth: () => auth }));
const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const bookId = id(1);
const grant: FinanceAutomationGrant = {
  id: id(3),
  revision: 2,
  workspaceId: id(4),
  bookId,
  grantedByUserId: id(5),
  executor: 'emdo-managed',
  specialist: 'finance',
  status: 'active',
  allowedCapabilities: ['finance.documents.extract', 'finance.journals.draft'],
  authorityRevision: { membership: 1, bookAccess: 2, entitlement: 3 },
  limits: {
    maxRuns: 100,
    maxAttemptsPerRun: 3,
    maxItemsPerRun: 20,
    maxTotalItems: 1000,
    currency: 'CAD',
    maxAmountPerRun: '100.010000000000',
    maxTotalAmount: '99999999999999999999.99',
  },
  validFrom: '2026-09-13T00:00:00.000Z',
  expiresAt: '2999-10-01T00:00:00.000Z',
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const panel = (selected = bookId, role = 'administrator') => (
  <FinanceAutomations
    bookId={selected}
    bookName={selected === bookId ? 'Operations' : 'Personal'}
    role={role}
  />
);
beforeEach(() => {
  auth.sessionBinding = 'session-one';
  auth.csrfToken = 'test-csrf';
});
afterEach(() => vi.unstubAllGlobals());

describe('Finance automation grants', () => {
  it('renders exact scope, limits and timestamps without assuming execution readiness', async () => {
    const fetcher = vi.fn(async () => response({ grants: [grant] }));
    vi.stubGlobal('fetch', fetcher);
    render(panel());
    expect(
      await screen.findByText('99999999999999999999.99 CAD'),
    ).toBeInTheDocument();
    expect(screen.getByText('100.010000000000 CAD')).toBeInTheDocument();
    expect(screen.getByText(grant.validFrom)).toBeInTheDocument();
    expect(screen.getByText(grant.expiresAt)).toBeInTheDocument();
    expect(
      screen.getByText('Extract document information'),
    ).toBeInTheDocument();
    expect(screen.getByText('Prepare draft journals')).toBeInTheDocument();
    expect(
      screen.queryByText('Generate financial reports'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Checked at execution')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Authority details'));
    expect(screen.getByText(grant.workspaceId)).toBeInTheDocument();
    expect(screen.getByText(`Operations · ${bookId}`)).toBeInTheDocument();
    expect(
      screen.getByText(grant.allowedCapabilities.join(', ')),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /run now/i }),
    ).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v2/finance/books/${bookId}/automations/grants`,
      expect.objectContaining({
        credentials: 'same-origin',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('reviews a scoped grant and retries an uncertain creation with the same payload and key before readback', async () => {
    let created: FinanceAutomationGrant | undefined;
    let attempts = 0;
    const writes: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, options?: RequestInit) => {
        if (options?.method === 'POST') {
          writes.push(options);
          const input = JSON.parse(String(options.body));
          created = {
            ...grant,
            allowedCapabilities: input.capabilities,
            limits: input.limits,
            validFrom: input.validFrom,
            expiresAt: input.expiresAt,
          };
          if (++attempts === 1) throw new TypeError('Response lost');
          return response(created);
        }
        return response({ grants: created ? [created] : [] });
      }),
    );
    render(panel());
    fireEvent.click(
      await screen.findByRole('button', { name: 'Create automation grant' }),
    );
    fireEvent.click(screen.getByLabelText('Generate financial reports'));
    fireEvent.click(screen.getByRole('button', { name: 'Review grant' }));
    expect(writes).toHaveLength(0);
    expect(screen.getByLabelText('Review grant authority')).toHaveTextContent(
      'Review authority for Operations',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm grant creation' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Creation could not be confirmed',
    );
    expect(
      screen.getByRole('button', { name: 'Refresh grants' }),
    ).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Edit authority' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry confirmation' }));
    expect(
      await screen.findByText(/Grant created and confirmed/),
    ).toBeInTheDocument();
    expect(writes).toHaveLength(2);
    expect(writes[1]!.body).toBe(writes[0]!.body);
    expect(writes[1]!.headers).toEqual(writes[0]!.headers);
    expect(writes[0]!.headers).toMatchObject({
      'x-csrf-token': 'test-csrf',
      'idempotency-key': expect.any(String),
    });
    expect(
      screen.getByRole('article', { name: `Grant ${grant.id}` }),
    ).toHaveTextContent('Generate financial reports');
  });

  it('rejects empty capability selection and does not mislabel capability rejection as missing administrator access', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, options?: RequestInit) =>
        options?.method === 'POST'
          ? response({}, 403)
          : response({ grants: [] }),
      ),
    );
    render(panel());
    fireEvent.click(
      await screen.findByRole('button', { name: 'Create automation grant' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review grant' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Choose at least one operation',
    );
    fireEvent.click(screen.getByLabelText('Generate financial reports'));
    fireEvent.click(screen.getByRole('button', { name: 'Review grant' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm grant creation' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'entitlement and operation availability',
    );
    expect(
      screen.getByRole('button', { name: 'Edit authority' }),
    ).toBeEnabled();
  });

  it('requires an explicit revoke decision and retries with the same idempotency key', async () => {
    let attempts = 0;
    const fetcher = vi.fn(async (_path: string, options?: RequestInit) => {
      if (options?.method !== 'POST') return response({ grants: [grant] });
      attempts++;
      if (attempts === 1) throw new TypeError('Network disconnected');
      return response({ ...grant, status: 'revoked', revision: 3 });
    });
    vi.stubGlobal('fetch', fetcher);
    render(panel());
    fireEvent.click(
      await screen.findByRole('button', { name: 'Revoke grant' }),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    const confirm = screen.getByRole('button', { name: 'Confirm revocation' });
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'could not be confirmed',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Grant revoked.'),
    );
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Revoke grant' }),
    ).not.toBeInTheDocument();
    const first = fetcher.mock.calls[1]!,
      second = fetcher.mock.calls[2]!;
    expect(first[0]).toBe(
      `/api/v2/finance/books/${bookId}/automations/grants/${grant.id}/revoke`,
    );
    expect(first[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      body: '{}',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': 'test-csrf',
        'idempotency-key': expect.stringMatching(/^[a-f0-9-]{36}$/),
      },
    });
    expect(second[1]?.headers).toEqual(first[1]?.headers);
  });

  it.each([403, 503])(
    'clears previously loaded grants when refresh returns %s',
    async (status) => {
      let unavailable = false;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          unavailable ? response({}, status) : response({ grants: [grant] }),
        ),
      );
      render(panel());
      await screen.findByRole('button', { name: 'Revoke grant' });
      unavailable = true;
      fireEvent.click(screen.getByRole('button', { name: 'Refresh grants' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        status === 403 ? 'Administrator access' : 'not available',
      );
      expect(screen.queryByRole('article')).not.toBeInTheDocument();
      expect(
        screen.queryByText('No automation grants for this book'),
      ).not.toBeInTheDocument();
    },
  );

  it('removes revoke controls when the server rejects changed administrator access', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, options?: RequestInit) =>
        options?.method === 'POST'
          ? response({}, 403)
          : response({ grants: [grant] }),
      ),
    );
    render(panel());
    fireEvent.click(
      await screen.findByRole('button', { name: 'Revoke grant' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Administrator access',
    );
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('shows an honest empty state and makes no request for a non-administrator', async () => {
    const fetcher = vi.fn(async () => response({ grants: [] }));
    vi.stubGlobal('fetch', fetcher);
    const { rerender } = render(panel(bookId, 'viewer'));
    expect(
      screen.getByText(/Administrator access to this book/),
    ).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
    rerender(panel());
    expect(
      await screen.findByText('No automation grants for this book'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Revoke grant' }),
    ).not.toBeInTheDocument();
  });

  it('cannot revoke without a CSRF token', async () => {
    auth.csrfToken = undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ grants: [grant] })),
    );
    render(panel());
    expect(
      await screen.findByRole('button', { name: 'Revoke grant' }),
    ).toBeDisabled();
  });

  it('aborts old book and session requests and ignores their late results', async () => {
    const oldReads: {
      resolve: (value: Response) => void;
      signal: AbortSignal;
    }[] = [];
    const fetcher = vi.fn(
      (_path: string, options?: RequestInit) =>
        new Promise<Response>((resolve) =>
          oldReads.push({ resolve, signal: options!.signal as AbortSignal }),
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    const { rerender } = render(panel());
    rerender(panel(id(2)));
    expect(oldReads[0]!.signal.aborted).toBe(true);
    auth.sessionBinding = 'session-two';
    rerender(panel(id(2)));
    expect(oldReads[1]!.signal.aborted).toBe(true);
    await act(async () => {
      oldReads[2]!.resolve(response({ grants: [] }));
      oldReads[0]!.resolve(response({ grants: [grant] }));
      oldReads[1]!.resolve(response({ grants: [{ ...grant, bookId: id(2) }] }));
    });
    expect(
      await screen.findByText('No automation grants for this book'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('rejects records from a different book without rendering their authority', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ grants: [{ ...grant, bookId: id(2) }] })),
    );
    render(panel());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to load',
    );
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });
});
