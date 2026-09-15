import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinanceStockSplitReview } from './finance-corporate-actions.js';

const auth = vi.hoisted(() => ({
  csrfToken: 'csrf-token',
  sessionBinding: 'session-binding',
}));
vi.mock('../auth/auth-context.js', () => ({ useAuth: () => auth }));

const bookId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const instrumentId = '00000000-0000-4000-8000-000000000003';
const evidenceId = '00000000-0000-4000-8000-000000000004';
const sourceLotId = '00000000-0000-4000-8000-000000000005';
const movementId = '00000000-0000-4000-8000-000000000006';
const successorLotId = '00000000-0000-4000-8000-000000000007';

const makeSource = (quantity = '10') => ({
  sourceRevision: 12,
  sourceSnapshotHash: 'b'.repeat(64),
  sourceAsOf: '2026-09-01',
  sourceBoundary: 'immediately-before-action' as const,
  sourceLots: [
    {
      id: sourceLotId,
      financialAccountId: accountId,
      instrumentId,
      acquiredOn: '2026-01-01',
      acquisitionSequence: 0,
      originalQuantity: quantity,
      disposedQuantity: '0',
      originalNativeCost: '100',
      allocatedNativeCost: '0',
      originalFunctionalCost: '100',
      allocatedFunctionalCost: '0',
      nativeCurrency: 'CAD',
      functionalCurrency: 'CAD',
      sourceReference: 'opening:broker:1',
    },
  ],
});

const currentLot = {
  id: successorLotId,
  movementId,
  financialAccountId: accountId,
  instrumentId,
  nativeCurrency: 'CAD',
  functionalCurrency: 'CAD',
  originalQuantity: '20',
  remainingQuantity: '20',
  originalNativeCost: '100',
  remainingNativeCost: '100',
  originalFunctionalCost: '100',
  remainingFunctionalCost: '100',
  acquiredOn: '2026-01-01',
  sourceReference: 'corporate-action:successor',
};

const commitResult = {
  actionId: '00000000-0000-4000-8000-000000000008',
  workspaceId: bookId,
  bookId,
  sourceRevision: 12,
  nextSourceRevision: 13,
  sourceSnapshotHash: 'b'.repeat(64),
  successorLotIds: [successorLotId],
  effectCount: 1,
  status: 'committed' as const,
  replayed: false,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function stubFinanceApi({
  quantity = '10',
  commitMode = 'success',
}: {
  quantity?: string;
  commitMode?: 'success' | 'network-once' | 'conflict';
} = {}) {
  let commitAttempts = 0;
  const source = makeSource(quantity);
  const fetcher = vi.fn(
    async (path: string, _init?: RequestInit): Promise<Response> => {
      void _init;
      if (path.endsWith('/financial-accounts'))
        return jsonResponse({
          accounts: [
            {
              id: accountId,
              name: 'Northstar Brokerage',
              kind: 'brokerage',
              currency: 'CAD',
              active: true,
            },
          ],
        });
      if (path.endsWith('/investments'))
        return jsonResponse({
          instruments: [
            { id: instrumentId, name: 'Northstar Fund', symbol: 'NST' },
          ],
          prices: [],
          fx: [],
          openings: [],
          observedPositions: [],
        });
      if (path.includes('/evidence?'))
        return jsonResponse({
          documents: [
            {
              id: evidenceId,
              filename: 'broker-notice.pdf',
              format: 'pdf',
              byteSize: 12_345,
              createdAt: '2026-08-20T10:00:00.000Z',
            },
          ],
          nextOffset: null,
        });
      if (path.endsWith('/stock-splits/source')) return jsonResponse(source);
      if (path.includes('/investments/lots?'))
        return jsonResponse({ lots: [currentLot], nextOffset: null });
      if (path.endsWith('/stock-splits/commit')) {
        commitAttempts += 1;
        if (commitMode === 'network-once' && commitAttempts === 1)
          throw new TypeError('Disconnected');
        if (commitMode === 'conflict')
          return jsonResponse({ error: 'source changed' }, 409);
        return jsonResponse(commitResult);
      }
      throw new Error(`Unexpected finance path ${path}`);
    },
  );
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, getCommitAttempts: () => commitAttempts };
}

async function openAndPreview({ reverse = false } = {}) {
  fireEvent.click(screen.getByRole('button', { name: 'Review a stock split' }));
  await screen.findByLabelText('Action type');
  if (reverse) {
    fireEvent.change(screen.getByLabelText('Action type'), {
      target: { value: 'reverse-split' },
    });
    fireEvent.change(screen.getByLabelText('Split ratio numerator'), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByLabelText('Split ratio denominator'), {
      target: { value: '2' },
    });
  }
  fireEvent.change(screen.getByLabelText('Effective date'), {
    target: { value: '2026-09-01' },
  });
  fireEvent.change(screen.getByLabelText('Brokerage account'), {
    target: { value: accountId },
  });
  fireEvent.change(screen.getByLabelText('Instrument'), {
    target: { value: instrumentId },
  });
  fireEvent.change(screen.getByLabelText('Evidence document'), {
    target: { value: evidenceId },
  });
  fireEvent.change(screen.getByLabelText('Source reference'), {
    target: { value: 'broker:notice:2026-09-01' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Preview deterministic result' }),
  );
  await screen.findByText('Split preview');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FinanceStockSplitReview', () => {
  it('previews the exact source and commits after explicit review, then refreshes successor lots', async () => {
    const { fetcher } = stubFinanceApi();
    render(<FinanceStockSplitReview bookId={bookId} role="administrator" />);
    await openAndPreview();

    expect(screen.getByText('Ready to commit')).toBeInTheDocument();
    expect(screen.getByText('Account share entitlement')).toBeInTheDocument();
    expect(screen.getByText('20 shares')).toBeInTheDocument();
    expect(screen.getByText(/Snapshot 2026-09-01/)).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Commit reviewed stock split' }),
    ).toBeDisabled();

    fireEvent.click(
      screen.getByLabelText(
        'I reviewed the source snapshot and proposed successor lots.',
      ),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Commit reviewed stock split' }),
    );
    await screen.findByRole('button', { name: 'Stock split committed' });
    await screen.findByText('Current successor lots');
    expect(screen.getByText('Split preview')).toBeInTheDocument();
    expect(screen.getByText('Committed')).toBeInTheDocument();
    expect(screen.getAllByText('20', { selector: 'td' })).toHaveLength(2);

    const sourceCall = fetcher.mock.calls.find(([path]) =>
      path.endsWith('/stock-splits/source'),
    )!;
    const sourceInput = JSON.parse(String(sourceCall[1]?.body));
    expect(sourceInput).toMatchObject({
      actionType: 'split',
      numerator: '2',
      denominator: '1',
      effectiveOn: '2026-09-01',
      fractionalTreatment: 'unknown',
      evidenceId,
      cashInLieu: null,
    });
    const commitCall = fetcher.mock.calls.find(([path]) =>
      path.endsWith('/stock-splits/commit'),
    )!;
    const commitBody = JSON.parse(String(commitCall[1]?.body));
    const commitHeaders = new Headers(commitCall[1]?.headers);
    expect(commitBody.expectedSourceRevision).toBe(12);
    expect(commitHeaders.get('x-csrf-token')).toBe('csrf-token');
    expect(commitHeaders.get('idempotency-key')).toBe(
      commitBody.idempotencyKey,
    );
    expect(commitBody.sourceLots).toHaveLength(1);
    expect(
      fetcher.mock.calls.some(([path]) => path.includes('/investments/lots?')),
    ).toBe(true);
  });

  it('fails closed for unresolved fractional shares and never offers cash-in-lieu as ready', async () => {
    stubFinanceApi({ quantity: '1' });
    render(<FinanceStockSplitReview bookId={bookId} role="approver" />);
    await openAndPreview({ reverse: true });

    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('Commit remains blocked')).toBeInTheDocument();
    expect(
      screen.getByText(/Choose a supported fractional-share policy/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Commit reviewed stock split' }),
    ).toBeDisabled();
    expect(
      screen.getByText(/Cash-in-lieu can be reviewed/),
    ).toBeInTheDocument();
    expect(
      Array.from(
        (screen.getByLabelText('Fractional-share policy') as HTMLSelectElement)
          .options,
      ).some((option) => option.value === 'cash-in-lieu'),
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('Fractional-share policy'), {
      target: { value: 'cash-in-lieu' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Preview deterministic result' }),
    );
    expect(
      await screen.findByRole('region', {
        name: 'Cash-in-lieu settlement review',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Commit reviewed stock split' }),
    ).toBeDisabled();
  });

  it('keeps the same idempotency command for a network retry', async () => {
    const { fetcher, getCommitAttempts } = stubFinanceApi({
      commitMode: 'network-once',
    });
    render(<FinanceStockSplitReview bookId={bookId} role="administrator" />);
    await openAndPreview();
    fireEvent.click(
      screen.getByLabelText(
        'I reviewed the source snapshot and proposed successor lots.',
      ),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Commit reviewed stock split' }),
    );
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry commit' }));
    await screen.findByRole('button', { name: 'Stock split committed' });
    expect(getCommitAttempts()).toBe(2);
    const commits = fetcher.mock.calls.filter(([path]) =>
      path.endsWith('/stock-splits/commit'),
    );
    expect(commits).toHaveLength(2);
    expect(commits[0]![1]?.body).toBe(commits[1]![1]?.body);
    expect(new Headers(commits[0]![1]?.headers).get('idempotency-key')).toBe(
      new Headers(commits[1]![1]?.headers).get('idempotency-key'),
    );
  });

  it('preserves the review and asks for fresh sources after a revision conflict', async () => {
    stubFinanceApi({ commitMode: 'conflict' });
    render(<FinanceStockSplitReview bookId={bookId} role="administrator" />);
    await openAndPreview();
    fireEvent.click(
      screen.getByLabelText(
        'I reviewed the source snapshot and proposed successor lots.',
      ),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Commit reviewed stock split' }),
    );
    await screen.findByText(
      'The book changed while this review was open. Refresh sources before committing.',
    );
    expect(screen.getByText('Split preview')).toBeInTheDocument();
    const refreshButtons = screen.getAllByRole('button', {
      name: 'Refresh sources',
    });
    fireEvent.click(refreshButtons[refreshButtons.length - 1]!);
    await waitFor(() =>
      expect(screen.queryByText('Split preview')).not.toBeInTheDocument(),
    );
  });
});
