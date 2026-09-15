import type { InvestmentReconciliationCase } from '@emdo/contracts/browser';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinanceInvestmentReconciliation } from './finance-investment-reconciliation.js';
import { investmentReconciliationApi } from './finance-investment-reconciliation-api.js';
const auth = vi.hoisted(() => ({
  state: 'authenticated',
  sessionBinding: 'session-one',
  csrfToken: 'csrf-current',
}));
vi.mock('../auth/auth-context.js', () => ({ useAuth: () => auth }));
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const comparison: InvestmentReconciliationCase['comparison'] = {
  valuationRunId: id(2),
  observedPositionId: id(3),
  comparisonHash: 'a'.repeat(64),
  valuationInputHash: 'b'.repeat(64),
  financialAccountId: id(4),
  instrumentId: id(5),
  asOf: '2026-09-01',
  evidenceId: id(6),
  sourceRow: 2,
  observedQuantity: '10.125',
  calculatedQuantity: '10',
  difference: '0.125',
  status: 'difference',
  sourceSnapshot: {},
};
const event: InvestmentReconciliationCase['history'][number] = {
  revision: 1,
  kind: 'created',
  comparison,
  resolution: null,
  evidenceSnapshots: [],
  correctiveRecordSnapshots: [],
  reason: null,
  createdBy: id(9),
  createdAt: '2026-09-15T00:00:00Z',
};
const saved: InvestmentReconciliationCase = {
  schemaVersion: 1,
  id: id(7),
  workspaceId: id(8),
  bookId: id(1),
  revision: 1,
  status: 'open',
  effectiveStatus: 'open',
  sourcesCurrent: true,
  comparison,
  history: [event],
  accountingEffect: 'none',
};
beforeEach(() => {
  auth.state = 'authenticated';
  auth.sessionBinding = 'session-one';
});
afterEach(() => vi.unstubAllGlobals());
function fixture(existing = false) {
  let current = structuredClone(saved),
    denied = false,
    lose = false;
  const writes: { path: string; body: Record<string, unknown>; key: string }[] =
    [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://localhost').pathname;
    if (denied) return new Response('{}', { status: 403 });
    let result: unknown;
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(new Headers(init.headers).get('x-csrf-token')).toBe(
        'csrf-current',
      );
      writes.push({
        path,
        body,
        key: new Headers(init.headers).get('idempotency-key')!,
      });
      if (lose) {
        lose = false;
        throw new Error('Lost response');
      }
      if (path.endsWith('/resolve'))
        current = {
          ...current,
          revision: 2,
          status: 'resolved',
          effectiveStatus: 'resolved',
          history: [
            event,
            {
              ...event,
              revision: 2,
              kind: 'resolved',
              resolution: body.resolution as never,
              evidenceSnapshots: [{ id: id(6), sourceDigest: 'd'.repeat(64) }],
              correctiveRecordSnapshots: [
                {
                  kind: 'movement',
                  id: id(10),
                  snapshot: {
                    quantity: '9007199254740993.123456789012',
                    quantity_delta: '-0.000000000001',
                  },
                },
              ],
            },
          ],
        };
      if (path.endsWith('/reopen'))
        current = {
          ...current,
          revision: 2,
          effectiveStatus: 'open',
          sourcesCurrent: true,
          comparison: {
            ...comparison,
            valuationRunId: id(12),
            comparisonHash: 'c'.repeat(64),
          },
          history: [
            event,
            {
              ...event,
              revision: 2,
              kind: 'reopened',
              reason: String(body.reason),
              comparison: {
                ...comparison,
                valuationRunId: id(12),
                comparisonHash: 'c'.repeat(64),
              },
            },
          ],
        };
      result = current;
    } else if (path.endsWith('/corrective-records'))
      result = {
        items: [
          {
            kind: 'movement',
            id: id(10),
            label: 'Broker correction · 0.125 shares',
            effectiveOn: '2026-09-01',
            evidenceIds: [id(6)],
          },
        ],
        offset: 0,
        limit: 50,
        total: 1,
      };
    else if (path.endsWith('/reconciliations/preview')) {
      const run = new URL(url, 'http://localhost').searchParams.get(
        'valuationRunId',
      );
      result = {
        bookId: id(1),
        workspaceId: id(8),
        sourcesCurrent: true,
        comparison: {
          ...comparison,
          valuationRunId: run,
          comparisonHash:
            run === id(12) ? 'c'.repeat(64) : comparison.comparisonHash,
        },
      };
    } else if (path.endsWith('/reconciliations'))
      result = {
        items: existing ? [current] : [],
        offset: 0,
        limit: 50,
        total: existing ? 1 : 0,
      };
    else if (path.endsWith(`/reconciliations/${id(7)}`)) result = current;
    else if (path.endsWith('/valuation-runs'))
      result = {
        runs: [
          {
            id: id(2),
            asOf: '2026-09-01',
            status: 'complete',
            calculationVersion: 'v1',
          },
          {
            id: id(12),
            asOf: '2026-09-02',
            status: 'complete',
            calculationVersion: 'v1',
          },
        ],
        nextOffset: null,
      };
    else if (path.includes('/valuation-runs/'))
      result = {
        id: path.split('/').at(-1),
        result: { reconciliations: [comparison] },
      };
    else if (path.endsWith('/investments'))
      result = {
        instruments: [{ id: id(5), name: 'Example shares' }],
        openings: [],
        observedPositions: [],
      };
    else if (path.endsWith('/evidence'))
      result = {
        documents: [
          { id: id(6), filename: 'Broker statement.pdf', format: 'pdf' },
        ],
        nextOffset: null,
      };
    else throw new Error(`Unexpected ${path}`);
    return new Response(JSON.stringify(result));
  });
  vi.stubGlobal('fetch', fetcher);
  return {
    writes,
    fetcher,
    lose: () => {
      lose = true;
    },
    deny: () => {
      denied = true;
    },
    stale: () => {
      current = {
        ...current,
        effectiveStatus: 'reopen-required',
        sourcesCurrent: false,
      };
    },
  };
}
async function open() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Open reconciliation review' }),
  );
  await screen.findByRole('combobox', { name: 'Saved valuation' });
}
async function preview(run = id(2)) {
  fireEvent.change(screen.getByLabelText('Saved valuation'), {
    target: { value: run },
  });
  await waitFor(() =>
    expect(
      screen
        .getByLabelText('Observed statement position')
        .querySelectorAll('option'),
    ).toHaveLength(2),
  );
  fireEvent.change(screen.getByLabelText('Observed statement position'), {
    target: { value: id(3) },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Preview saved comparison' }),
  );
  return screen.findByRole('region', { name: 'Reviewed comparison preview' });
}
describe('investment reconciliation review', () => {
  it('previews exact quantities, retries identical create, and saves a named existing correction without accounting writes', async () => {
    const f = fixture();
    render(<FinanceInvestmentReconciliation bookId={id(1)} role="preparer" />);
    await open();
    const p = await preview();
    expect(within(p).getByText('0.125')).toBeInTheDocument();
    expect(f.writes).toHaveLength(0);
    f.lose();
    fireEvent.click(
      screen.getByRole('button', { name: 'Create reconciliation case' }),
    );
    await screen.findByRole('alert');
    fireEvent.click(
      screen.getByRole('button', { name: 'Create reconciliation case' }),
    );
    await screen.findByRole('region', { name: 'Saved reconciliation detail' });
    expect(f.writes[0]).toEqual(f.writes[1]);
    expect(f.writes[0]!.body).toEqual({
      valuationRunId: id(2),
      observedPositionId: id(3),
      expectedComparisonHash: comparison.comparisonHash,
    });
    fireEvent.change(screen.getByLabelText('Resolution type'), {
      target: { value: 'corrective-records' },
    });
    fireEvent.change(screen.getByLabelText('Reviewed explanation'), {
      target: {
        value:
          'The saved broker movement corrects the reported fractional quantity.',
      },
    });
    fireEvent.click(screen.getByLabelText('Broker statement.pdf'));
    fireEvent.click(screen.getByLabelText(/Broker correction/));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save reviewed resolution' }),
    );
    await screen.findByText('Saved case · revision 2 · resolved');
    fireEvent.click(
      screen
        .getAllByText('Saved evidence and corrective record snapshots')
        .at(-1)!,
    );
    expect(screen.getByText('9007199254740993.123456789012')).toBeVisible();
    expect(screen.getByText('-0.000000000001')).toBeVisible();

    expect(f.writes[2]!.body).toMatchObject({
      expectedRevision: 1,
      expectedComparisonHash: comparison.comparisonHash,
      resolution: {
        kind: 'corrective-records',
        evidenceIds: [id(6)],
        correctiveRecords: [{ kind: 'movement', id: id(10) }],
      },
    });
    expect(
      f.writes.every((write) => write.path.includes('/reconciliations')),
    ).toBe(true);
  });
  it('requires explicit newer preview before reopening changed sources and retains history', async () => {
    const f = fixture(true);
    f.stale();
    render(<FinanceInvestmentReconciliation bookId={id(1)} role="preparer" />);
    await open();
    fireEvent.click(
      screen.getByRole('button', { name: /Example shares.*reopen-required/ }),
    );
    await screen.findByText(/Resolution is unavailable/);
    expect(
      screen.queryByRole('button', { name: 'Save reviewed resolution' }),
    ).not.toBeInTheDocument();
    await preview(id(12));
    fireEvent.change(screen.getByLabelText('Reason for reopening'), {
      target: {
        value: 'Reviewed the newer valuation after the source correction.',
      },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Reopen with reviewed valuation' }),
    );
    await screen.findByText('Saved case · revision 2 · open');
    expect(f.writes[0]!.body).toMatchObject({
      valuationRunId: id(12),
      expectedRevision: 1,
      expectedComparisonHash: 'c'.repeat(64),
    });
    expect(screen.getByText(/Revision 1 · created/)).toBeInTheDocument();
    expect(screen.getByText(/Revision 2 · reopened/)).toBeInTheDocument();
  });
  it('clears private comparison data on revoked access and authenticated-session changes', async () => {
    const f = fixture();
    const view = render(
      <FinanceInvestmentReconciliation bookId={id(1)} role="preparer" />,
    );
    await open();
    await preview();
    f.deny();
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh reconciliation sources' }),
    );
    await screen.findByRole('alert');
    expect(
      screen.queryByRole('region', { name: 'Reviewed comparison preview' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Broker statement.pdf')).not.toBeInTheDocument();
    auth.sessionBinding = 'session-two';
    view.rerender(
      <FinanceInvestmentReconciliation bookId={id(1)} role="preparer" />,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open reconciliation review' }),
    ).toBeInTheDocument();
  });
  it('requires supporting evidence for an explanation and does not imply corrective records', async () => {
    const f = fixture(true);
    render(<FinanceInvestmentReconciliation bookId={id(1)} role="preparer" />);
    await open();
    fireEvent.click(
      screen.getByRole('button', { name: /Example shares.*revision 1/ }),
    );
    await screen.findByLabelText('Resolution type');
    fireEvent.change(screen.getByLabelText('Resolution type'), {
      target: { value: 'reviewed-explanation' },
    });
    fireEvent.change(screen.getByLabelText('Reviewed explanation'), {
      target: {
        value:
          'The statement reports a different fractional entitlement convention.',
      },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save reviewed resolution' }),
    );
    await screen.findByRole('alert');
    expect(f.writes).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('Broker statement.pdf'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save reviewed resolution' }),
    );
    await screen.findByText('Saved case · revision 2 · resolved');
    expect(f.writes[0]!.body).toMatchObject({
      resolution: {
        kind: 'reviewed-explanation',
        correctiveRecords: [],
        evidenceIds: [id(6)],
      },
    });
  });
  it('rejects preview responses for a different book', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              bookId: id(99),
              workspaceId: id(8),
              sourcesCurrent: true,
              comparison,
            }),
          ),
      ),
    );
    await expect(
      investmentReconciliationApi(id(1), new AbortController().signal).preview({
        valuationRunId: id(2),
        observedPositionId: id(3),
      }),
    ).rejects.toThrow('does not match');
  });
});
