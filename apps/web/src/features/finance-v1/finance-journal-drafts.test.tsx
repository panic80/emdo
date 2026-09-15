import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FinanceAutomationJournalDraftResultSchema,
  type FinanceAutomationGrant,
  type FinanceAutomationRunRecord,
} from '@emdo/contracts/browser';
import { FinanceJournalDrafts } from './finance-journal-drafts.js';
import { journalDraftApi } from './finance-journal-drafts-api.js';
const auth = vi.hoisted(() => ({
  state: 'authenticated',
  sessionBinding: 'draft-session',
}));
vi.mock('../auth/auth-context.js', () => ({ useAuth: () => auth }));
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const grant: FinanceAutomationGrant = {
  id: id(2),
  revision: 1,
  workspaceId: id(3),
  bookId: id(1),
  grantedByUserId: id(4),
  executor: 'emdo-managed',
  specialist: 'finance',
  status: 'active',
  allowedCapabilities: ['finance.journals.draft'],
  authorityRevision: { membership: 1, bookAccess: 1, entitlement: 1 },
  limits: {
    maxRuns: 10,
    maxAttemptsPerRun: 3,
    maxItemsPerRun: 100,
    maxTotalItems: 1000,
    currency: 'CAD',
    maxAmountPerRun: '1000',
    maxTotalAmount: '10000',
  },
  validFrom: '2026-01-01T00:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z',
};
const prepared = {
  journal: {
    schemaVersion: 1 as const,
    batchId: id(5),
    expectedBatchRevision: 3,
    expectedSnapshotHash: 'a'.repeat(64),
  },
  itemCount: 2,
  currency: 'CAD',
  amount: '12.50',
};
const queued: FinanceAutomationRunRecord = {
  run: {
    request: {
      operationId: id(6),
      grantId: grant.id,
      grantRevision: 1,
      workspaceId: grant.workspaceId,
      bookId: grant.bookId,
      capability: 'finance.journals.draft',
      requestHash: 'b'.repeat(64),
      itemCount: 2,
      currency: 'CAD',
      amount: '12.50',
      journal: prepared.journal,
    },
    revision: 1,
    attempts: 0,
    status: 'queued',
    outcomeReference: null,
  },
  createdAt: '2026-09-15T00:00:00Z',
  blockedReason: null,
};
const initial = FinanceAutomationJournalDraftResultSchema.parse({
  schemaVersion: 1,
  kind: 'finance-journal-draft',
  id: id(7),
  operationId: id(6),
  workspaceId: id(3),
  bookId: id(1),
  revision: 0,
  status: 'review_required',
  source: {
    batchId: id(5),
    batchRevision: 3,
    snapshotHash: 'a'.repeat(64),
    evidenceId: id(8),
    sourceDigest: 'c'.repeat(64),
    mappingHash: 'd'.repeat(64),
    rows: [{ rowId: id(9), sourceRow: 2, revision: 2, componentRevisions: [] }],
  },
  currency: 'CAD',
  itemCount: 2,
  amount: '12.50',
  proposal: {
    journals: [
      {
        effectiveOn: '2026-09-01',
        description: 'Reviewed bank payment',
        sourceReference: 'statement:row:2',
        lines: [
          {
            accountId: id(10),
            side: 'debit',
            amount: '12.50',
            currency: 'CAD',
            nativeAmount: '12.50',
            fxRate: '1',
            fxSource: 'same-currency',
            description: 'Payment',
          },
          {
            accountId: id(11),
            side: 'credit',
            amount: '12.50',
            currency: 'CAD',
            nativeAmount: '12.50',
            fxRate: '1',
            fxSource: 'same-currency',
            description: 'Payment',
          },
        ],
      },
    ],
  },
  review: null,
  postedJournalIds: [],
  posting: 'not-performed',
  events: [],
});
beforeEach(() => {
  auth.state = 'authenticated';
  auth.sessionBinding = 'draft-session';
});
afterEach(() => vi.unstubAllGlobals());
function setup(role = 'administrator', blockedReason?: string) {
  let current = structuredClone(initial),
    denied = false,
    lose = '';
  const writes: { path: string; body: Record<string, unknown>; key: string }[] =
    [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://localhost').pathname;
    if (denied) return new Response('{}', { status: 403 });
    let value: unknown;
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(new Headers(init.headers).get('x-csrf-token')).toBe('draft-csrf');
      writes.push({
        path,
        body,
        key: new Headers(init.headers).get('idempotency-key')!,
      });
      if (lose && path.endsWith(lose)) {
        lose = '';
        throw new Error('Lost response');
      }
      if (path.endsWith('/prepare')) value = prepared;
      else if (path.endsWith('/automations/runs'))
        value = blockedReason
          ? {
              ...queued,
              blockedReason,
              run: { ...queued.run, status: 'blocked' },
            }
          : queued;
      else if (path.endsWith('/review')) {
        const decision = body.decision as 'approved' | 'rejected';
        current = {
          ...current,
          status: decision,
          revision: 1,
          review: {
            decision,
            reason: String(body.reason),
            actorId: id(4),
            at: '2026-09-15T00:00:00Z',
          },
          events: [
            {
              kind: 'reviewed',
              revision: 1,
              decision,
              reason: String(body.reason),
              actorId: id(4),
              at: '2026-09-15T00:00:00Z',
            },
          ],
        };
        value = current;
      } else if (path.endsWith('/post')) {
        current = {
          ...current,
          status: 'posted',
          revision: 2,
          posting: 'performed',
          postedJournalIds: [id(12)],
          events: [
            ...current.events,
            {
              kind: 'posted',
              revision: 2,
              journalIds: [id(12)],
              actorId: id(4),
              at: '2026-09-15T00:01:00Z',
            },
          ],
        };
        value = current;
      } else if (path.endsWith('/discard')) {
        current = {
          ...current,
          status: 'discarded',
          revision: current.revision + 1,
          events: [
            ...current.events,
            {
              kind: 'discarded',
              revision: current.revision + 1,
              reason: String(body.reason),
              actorId: id(4),
              at: '2026-09-15T00:01:00Z',
            },
          ],
        };
        value = current;
      } else throw new Error(`Unexpected write ${path}`);
    } else if (path.endsWith('/imports'))
      value = {
        imports: [
          {
            id: id(5),
            filename: 'Reviewed bank.csv',
            status: 'review',
            revision: 3,
          },
        ],
      };
    else if (path.endsWith('/journal-drafts'))
      value = { items: [current], offset: 0, limit: 50, total: 1 };
    else if (path.endsWith(`/journal-drafts/${id(7)}`)) value = current;
    else if (path.endsWith(`/automations/runs/${id(6)}`))
      value = {
        ...queued,
        run: { ...queued.run, status: 'completed', outcomeReference: id(7) },
      };
    else if (path.endsWith(`/books/${id(1)}`))
      value = {
        trialBalance: [
          { id: id(10), name: 'Bank', code: '1000' },
          { id: id(11), name: 'Revenue', code: '4000' },
        ],
      };
    else throw new Error(`Unexpected read ${path}`);
    return new Response(JSON.stringify(value));
  });
  vi.stubGlobal('fetch', fetcher);
  const props = {
    bookId: id(1),
    bookName: 'Operations',
    role,
    grants: [grant],
    csrfToken: 'draft-csrf',
  };
  const view = render(<FinanceJournalDrafts {...props} />);
  return {
    writes,
    fetcher,
    props,
    view,
    deny: () => {
      denied = true;
    },
    lose: (suffix: string) => {
      lose = suffix;
    },
  };
}
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Open journal drafts' }));
  await screen.findByLabelText('Saved source import');
}
async function detail() {
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Reviewed bank.csv · review required · revision 0',
    }),
  );
  return screen.findByRole('region', { name: 'Saved journal draft detail' });
}
describe('journal draft automation', () => {
  it('shows current-source review guidance for a saved blocked draft run without retrying', async () => {
    const f = setup('administrator', 'journal-draft-source-invalid');
    await open();
    fireEvent.change(screen.getByLabelText('Saved source import'), {
      target: { value: id(5) },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Prepare journal scope' }),
    );
    await screen.findByRole('region', { name: 'Prepared journal scope' });
    fireEvent.change(screen.getByLabelText('Journal draft grant'), {
      target: { value: grant.id },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Queue reviewed journal draft' }),
    );
    await screen.findByText(
      /Review the current source, prepare a new request, and start a new run/,
    );
    expect(
      f.writes.filter((write) => write.path.endsWith('/automations/runs')),
    ).toHaveLength(1);
  });
  it('prepares inert server scope and retries exact enqueue, then reads the pinned completed result', async () => {
    const f = setup();
    await open();
    fireEvent.change(screen.getByLabelText('Saved source import'), {
      target: { value: id(5) },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Prepare journal scope' }),
    );
    const scope = await screen.findByRole('region', {
      name: 'Prepared journal scope',
    });
    expect(within(scope).getByText('12.50 CAD')).toBeInTheDocument();
    expect(f.writes).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Journal draft grant'), {
      target: { value: grant.id },
    });
    f.lose('/automations/runs');
    fireEvent.click(
      screen.getByRole('button', { name: 'Queue reviewed journal draft' }),
    );
    await screen.findByRole('alert');
    fireEvent.click(
      screen.getByRole('button', { name: 'Queue reviewed journal draft' }),
    );
    await screen.findByText('Saved draft run · queued');
    expect(f.writes[1]).toEqual(f.writes[2]);
    expect(f.writes[1]!.body).toEqual({
      grantId: grant.id,
      capability: 'finance.journals.draft',
      targets: [id(5)],
      currency: 'CAD',
      amount: '12.50',
      journal: prepared.journal,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh draft run' }));
    const saved = await screen.findByRole('region', {
      name: 'Saved journal draft detail',
    });
    expect(within(saved).getByText('Bank')).toBeInTheDocument();
    expect(
      within(saved).getByText(/Posting: Not performed/),
    ).toBeInTheDocument();
    expect(f.writes.every((item) => !item.path.endsWith('/post'))).toBe(true);
  });
  it('requires explicit review, then a separate confirmed posting request with identical retry', async () => {
    const f = setup('approver');
    await open();
    await detail();
    expect(
      screen.queryByRole('button', { name: 'Review posting action' }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Draft decision'), {
      target: { value: 'approved' },
    });
    fireEvent.change(screen.getByLabelText('Review reason'), {
      target: {
        value: 'Checked original evidence and every proposed journal line.',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft review' }));
    await screen.findByRole('button', { name: 'Review posting action' });
    expect(f.writes).toHaveLength(1);
    fireEvent.click(
      screen.getByRole('button', { name: 'Review posting action' }),
    );
    expect(f.writes).toHaveLength(1);
    fireEvent.click(screen.getByLabelText(/I reviewed the approved journals/));
    f.lose('/post');
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm and post approved draft' }),
    );
    await screen.findByRole('alert');
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm and post approved draft' }),
    );
    await screen.findByText(/Posting: Performed/);
    expect(f.writes[1]).toEqual(f.writes[2]);
    expect(f.writes[1]!.body).toEqual({ expectedRevision: 1 });
  });
  it('supports explicit rejection and reasoned discard without posting', async () => {
    const f = setup('approver');
    await open();
    await detail();
    fireEvent.change(screen.getByLabelText('Draft decision'), {
      target: { value: 'rejected' },
    });
    fireEvent.change(screen.getByLabelText('Review reason'), {
      target: { value: 'The source account selection requires correction.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft review' }));
    await screen.findByText('Reviewed bank.csv · rejected · revision 1');
    expect(
      screen.queryByRole('button', { name: 'Review posting action' }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Discard reason'), {
      target: {
        value: 'Discard rejected snapshot before correcting the source.',
      },
    });
    fireEvent.submit(screen.getByLabelText('Discard reason').closest('form')!);
    await screen.findByText('Reviewed bank.csv · discarded · revision 2');
    expect(f.writes[1]!.body).toMatchObject({
      expectedRevision: 1,
      reason: 'Discard rejected snapshot before correcting the source.',
    });
    expect(f.writes.every((item) => !item.path.endsWith('/post'))).toBe(true);
  });
  it('keeps approval unavailable to preparers and clears private data on revoked access and book changes', async () => {
    const f = setup('preparer');
    await open();
    await detail();
    expect(screen.queryByLabelText('Draft decision')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Review posting action' }),
    ).not.toBeInTheDocument();
    f.deny();
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh journal drafts' }),
    );
    await screen.findByRole('alert');
    expect(
      screen.queryByRole('region', { name: 'Saved journal draft detail' }),
    ).not.toBeInTheDocument();
    f.view.rerender(<FinanceJournalDrafts {...f.props} bookId={id(99)} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open journal drafts' }),
    ).toBeInTheDocument();
  });
  it('discards an unreviewed draft with an explicit reason without manufacturing review approval', async () => {
    const f = setup('preparer');
    await open();
    await detail();
    fireEvent.change(screen.getByLabelText('Discard reason'), {
      target: {
        value: 'The reviewed source needs correction before generation.',
      },
    });
    fireEvent.submit(screen.getByLabelText('Discard reason').closest('form')!);
    await screen.findByText('Reviewed bank.csv · discarded · revision 1');
    expect(screen.queryByText(/Saved review:/)).not.toBeInTheDocument();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.body).toEqual({
      expectedRevision: 0,
      reason: 'The reviewed source needs correction before generation.',
    });
    expect(f.writes[0]!.path).toMatch(/\/discard$/);
  });
  it('rejects a completed outcome with another source snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...initial,
              source: { ...initial.source, snapshotHash: 'f'.repeat(64) },
            }),
          ),
      ),
    );
    await expect(
      journalDraftApi(id(1), new AbortController().signal).outcome({
        ...queued,
        run: { ...queued.run, status: 'completed', outcomeReference: id(7) },
      }),
    ).rejects.toThrow('queued source snapshot');
  });
});
