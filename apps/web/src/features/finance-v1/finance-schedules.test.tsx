import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FinanceAutomationGrant } from '@emdo/contracts/browser';
import { FinanceSchedules } from './finance-schedules.js';
const id = '00000000-0000-4000-8000-000000000001',
  workspace = '00000000-0000-4000-8000-000000000002';
const grant: FinanceAutomationGrant = {
  id,
  workspaceId: workspace,
  bookId: id,
  revision: 1,
  grantedByUserId: id,
  executor: 'emdo-managed',
  specialist: 'finance',
  status: 'active',
  allowedCapabilities: ['finance.reports.generate'],
  authorityRevision: { membership: 1, bookAccess: 1, entitlement: 1 },
  limits: {
    maxRuns: 10,
    maxAttemptsPerRun: 2,
    maxItemsPerRun: 1,
    maxTotalItems: 10,
    currency: 'CAD',
    maxAmountPerRun: '0',
    maxTotalAmount: '0',
  },
  validFrom: '2020-01-01T00:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z',
};
const definition = {
  workspaceId: workspace,
  bookId: id,
  grantId: id,
  grantRevision: 1,
  capability: 'finance.reports.generate',
  targets: [id],
  money: { currency: 'CAD', amount: '0' },
  startAt: '2026-10-01T00:00:00Z',
  endAt: null,
  cadence: {
    kind: 'monthly',
    anchorMonth: '2026-10',
    dayOfMonth: 31,
    everyMonths: 1,
    shortMonthPolicy: 'last-day',
    timeZone: 'America/Toronto',
    localTime: '09:00:00',
    gapPolicy: 'skip',
    overlapPolicy: 'later',
    tzdbVersion: '2026a',
  },
  misfire: { policy: 'coalesce-latest', maxLatenessSeconds: 3600 },
  concurrency: { policy: 'forbid', onBusy: 'defer' },
};
const row = {
  schedule: {
    id,
    definitionRevision: 1,
    stateRevision: 1,
    status: 'active',
    definition,
  },
  cursor: { scheduleId: id, definitionRevision: 1, nextOrdinal: 0 },
  nextDueAt: '2026-10-31T13:00:00Z',
  blockedReason: null,
  createdAt: '2026-09-13T00:00:00Z',
  updatedAt: '2026-09-13T00:00:00Z',
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
function setup(rows: unknown[] = []) {
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/options')) return response({ tzdbVersion: '2026a' });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return response(
        path.endsWith('/state')
          ? {
              ...row,
              schedule: {
                ...row.schedule,
                status: body.status,
                stateRevision: body.expectedStateRevision + 1,
              },
            }
          : {
              ...row,
              schedule: {
                ...row.schedule,
                definition: { ...body, workspaceId: workspace, bookId: id },
              },
            },
      );
    }
    return response(rows);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<FinanceSchedules bookId={id} grants={[grant]} csrfToken="csrf" />);
  fireEvent.click(screen.getByRole('button', { name: 'Load schedules' }));
  return fetcher;
}
afterEach(() => vi.unstubAllGlobals());
describe('Recurring report schedule controls', () => {
  it('saves explicit monthly policies with trusted calendar metadata and canonical report target', async () => {
    const fetcher = setup();
    fireEvent.click(
      await screen.findByRole('button', { name: 'New report schedule' }),
    );
    fireEvent.change(screen.getByLabelText('Day of month'), {
      target: { value: '31' },
    });
    fireEvent.change(
      screen.getByLabelText('When the clock repeats this time'),
      { target: { value: 'later' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await screen.findByText(/Schedule saved/);
    const call = fetcher.mock.calls.find(
      ([, init]) => init?.method === 'POST',
    )!;
    const body = JSON.parse(String(call[1]?.body));
    expect(body).toMatchObject({
      targets: [id],
      money: { amount: '0', currency: 'CAD' },
      cadence: {
        kind: 'monthly',
        dayOfMonth: 31,
        shortMonthPolicy: 'last-day',
        gapPolicy: 'skip',
        overlapPolicy: 'later',
        tzdbVersion: '2026a',
      },
      concurrency: { policy: 'forbid', onBusy: 'defer' },
    });
    expect(body.workspaceId).toBeUndefined();
    expect(call[1]?.headers).toMatchObject({
      'x-csrf-token': 'csrf',
      'idempotency-key': expect.any(String),
    });
  });

  it('creates a planning schedule bound to the selected budget revision and zero amount', async () => {
    const planningGrant: FinanceAutomationGrant = {
      ...grant,
      id: '00000000-0000-4000-8000-000000000003',
      allowedCapabilities: ['finance.planning.budget-vs-actuals'],
    };
    const planning = {
      schemaVersion: 1 as const,
      capability: 'finance.planning.budget-vs-actuals' as const,
      budgetId: id,
      budgetRevision: 4,
      asOf: null,
      currency: 'CAD' as const,
      itemCount: 3,
    };
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/options')) return response({ tzdbVersion: '2026a' });
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return response({
          ...row,
          schedule: {
            ...row.schedule,
            definition: { ...body, workspaceId: workspace, bookId: id },
          },
        });
      }
      return response({ schedules: [] });
    });
    vi.stubGlobal('fetch', fetcher);
    render(
      <FinanceSchedules
        bookId={id}
        grants={[planningGrant]}
        csrfToken="csrf"
        planningOnly
        planningOptions={[
          {
            id: 'budget:budget:4',
            label: 'Operating plan · revision 4',
            capability: planning.capability,
          },
        ]}
        resolvePlanningIntent={async () => planning}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load schedules' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'New planning schedule' }),
    );
    fireEvent.change(screen.getByLabelText('Planning revision'), {
      target: { value: 'budget:budget:4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await screen.findByText(/Schedule saved/);
    const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
    const body = JSON.parse(String(post?.[1]?.body));
    expect(body).toMatchObject({
      capability: planning.capability,
      targets: [id],
      money: { amount: '0', currency: 'CAD' },
      planning,
    });
  });
  it('requires retirement confirmation and sends the exact displayed revision', async () => {
    const fetcher = setup([row]);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Retire schedule' }),
    );
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm retirement' }));
    await screen.findByText(/Schedule retired permanently/);
    const call = fetcher.mock.calls.find(
      ([, init]) => init?.method === 'POST',
    )!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      expectedStateRevision: 1,
      status: 'retired',
    });
    expect(
      screen.queryByRole('button', { name: 'Resume schedule' }),
    ).not.toBeInTheDocument();
  });
  it('pauses before allowing an edit as a replacement', async () => {
    setup([row]);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Pause schedule' }),
    );
    await screen.findByText(/Schedule paused/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit as replacement' }),
    );
    expect(
      (screen.getByLabelText('Day of month') as HTMLInputElement).value,
    ).toBe('31');
    expect(
      (
        screen.getByLabelText(
          'When the clock repeats this time',
        ) as HTMLSelectElement
      ).value,
    ).toBe('later');
    expect(
      screen.getByRole('button', { name: 'Save replacement' }),
    ).toBeInTheDocument();
  });
  it('rejects invalid IANA zone without sending a mutation', async () => {
    const fetcher = setup();
    fireEvent.click(
      await screen.findByRole('button', { name: 'New report schedule' }),
    );
    fireEvent.change(screen.getByLabelText('IANA time zone'), {
      target: { value: 'invented/zone' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await screen.findByRole('alert');
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(0);
  });
  it('reuses the same key after an unconfirmed create', async () => {
    const fetcher = setup();
    fireEvent.click(
      await screen.findByRole('button', { name: 'New report schedule' }),
    );
    fetcher.mockRejectedValueOnce(new Error('Connection lost'));
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await screen.findByText(/Schedule saved/);
    const calls = fetcher.mock.calls.filter(
      ([, init]) => init?.method === 'POST',
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]?.headers).toEqual(calls[1]?.[1]?.headers);
  });
  it('fails closed on another book and on unavailable options', async () => {
    const fetcher = setup([
      {
        ...row,
        schedule: {
          ...row.schedule,
          definition: { ...definition, bookId: workspace },
        },
      },
    ]);
    await screen.findByRole('alert');
    expect(
      screen.queryByRole('button', { name: 'New report schedule' }),
    ).not.toBeInTheDocument();
    fetcher.mockImplementation(async () => response({}, 503));
    fireEvent.click(screen.getByRole('button', { name: 'Load schedules' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('unavailable'),
    );
  });
});

const sourceId = '00000000-0000-4000-8000-000000000003';
const extraction = {
  schemaVersion: 1,
  evidenceId: sourceId,
  expectedSourceDigest: 'a'.repeat(64),
  standardizationRunId: '00000000-0000-4000-8000-000000000004',
  expectedRunRevision: 2,
  expectedExtractionRevision: 1,
};
const journal = {
  schemaVersion: 1,
  batchId: sourceId,
  expectedBatchRevision: 7,
  expectedSnapshotHash: 'b'.repeat(64),
};
function sourceSetup(kind: 'extraction' | 'journal', replacement = false) {
  const capability =
    kind === 'extraction'
      ? 'finance.documents.extract'
      : 'finance.journals.draft';
  const sourceGrant: FinanceAutomationGrant = {
    ...grant,
    allowedCapabilities: [capability],
    limits: {
      ...grant.limits,
      maxItemsPerRun: 10,
      maxAmountPerRun: '1000',
      maxTotalAmount: '10000',
    },
  };
  const saved = {
    ...row,
    schedule: {
      ...row.schedule,
      status: 'paused',
      definition: {
        ...definition,
        capability,
        targets: [sourceId],
        money: { currency: 'CAD', amount: kind === 'journal' ? '12.50' : '0' },
        ...(kind === 'extraction' ? { extraction } : { journal }),
      },
    },
  };
  let lose = false,
    denied = false;
  const writes: Array<{
    path: string;
    body: Record<string, unknown>;
    key: string | null;
  }> = [];
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (denied) return response({}, 403);
    if (path.endsWith('/options')) return response({ tzdbVersion: '2026a' });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const headers = new Headers(init.headers);
      expect(headers.get('x-csrf-token')).toBe('csrf');
      writes.push({ path, body, key: headers.get('idempotency-key') });
      if (path.endsWith('/extractions/prepare')) return response(extraction);
      if (path.endsWith('/journal-drafts/prepare'))
        return response({
          journal,
          itemCount: 2,
          currency: 'CAD',
          amount: '12.50',
        });
      if (lose) {
        lose = false;
        throw new Error('Lost schedule acknowledgement');
      }
      return response({
        ...row,
        schedule: {
          ...row.schedule,
          definition: { ...body, workspaceId: workspace, bookId: id },
        },
      });
    }
    if (path.includes('/evidence?'))
      return response({
        documents: [
          {
            id: sourceId,
            filename: 'Saved statement.pdf',
            format: 'pdf',
            sourceDigest: extraction.expectedSourceDigest,
          },
        ],
        nextOffset: null,
      });
    if (path.endsWith('/imports'))
      return response({
        imports: [
          {
            id: sourceId,
            filename: 'Reviewed statement.csv',
            status: 'review',
            revision: 7,
          },
        ],
      });
    return response(replacement ? [saved] : []);
  });
  vi.stubGlobal('fetch', fetcher);
  const view = render(
    <FinanceSchedules bookId={id} grants={[sourceGrant]} csrfToken="csrf" />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Load schedules' }));
  return {
    writes,
    view,
    sourceGrant,
    lose: () => {
      lose = true;
    },
    deny: () => {
      denied = true;
    },
  };
}
async function chooseSource(
  kind: 'extraction' | 'journal',
  replacement = false,
) {
  fireEvent.click(
    await screen.findByRole('button', {
      name: replacement
        ? 'Edit as replacement'
        : 'New source or report schedule',
    }),
  );
  if (!replacement)
    fireEvent.change(screen.getByLabelText('Scheduled operation'), {
      target: { value: kind },
    });
  fireEvent.click(
    screen.getByRole('button', { name: 'Load saved source choices' }),
  );
  const select = screen.getByLabelText(
    kind === 'extraction' ? 'Saved document' : 'Reviewed source import',
  );
  await waitFor(() =>
    expect(select.querySelectorAll('option')).toHaveLength(2),
  );
  fireEvent.change(select, { target: { value: sourceId } });
}
describe('recurring fixed-source workflows', () => {
  it.each(['extraction', 'journal'] as const)(
    'labels saved %s schedules by their operation',
    async (kind) => {
      sourceSetup(kind, true);
      expect(
        await screen.findByRole('heading', {
          name:
            kind === 'extraction'
              ? 'Fixed-document extraction'
              : 'Reviewed-import journal drafts',
        }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { name: 'Posted trial balance' }),
      ).not.toBeInTheDocument();
    },
  );
  it.each(['extraction', 'journal'] as const)(
    'preserves exact prepared %s scope and retries the same schedule without defaulting to report',
    async (kind) => {
      const f = sourceSetup(kind);
      await chooseSource(kind);
      fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Prepare and review',
      );
      expect(f.writes).toHaveLength(0);
      fireEvent.click(
        screen.getByRole('button', { name: 'Prepare scheduled source' }),
      );
      await screen.findByLabelText('Prepared schedule source');
      expect(
        screen.getByText(
          kind === 'journal'
            ? 'Reviewed statement.csv · 2 proposed journal lines · 12.50 CAD'
            : 'Saved statement.pdf · 1 document · 0 CAD',
        ),
      ).toBeInTheDocument();
      f.lose();
      fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
      await screen.findByText('Lost schedule acknowledgement');
      fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
      await screen.findByText(/Schedule saved/);
      expect(f.writes[1]).toEqual(f.writes[2]);
      expect(f.writes[1]!.body).toMatchObject({
        capability:
          kind === 'journal'
            ? 'finance.journals.draft'
            : 'finance.documents.extract',
        targets: [sourceId],
        money: { currency: 'CAD', amount: kind === 'journal' ? '12.50' : '0' },
        ...(kind === 'journal' ? { journal } : { extraction }),
      });
      expect(f.writes[1]!.body).not.toHaveProperty('planning');
    },
  );
  it.each(['extraction', 'journal'] as const)(
    'requires explicit reprepare for a paused %s replacement while preserving the saved pin',
    async (kind) => {
      const f = sourceSetup(kind, true);
      await chooseSource(kind, true);
      expect(screen.getByLabelText('Scheduled operation')).toHaveValue(kind);
      expect(screen.getByText(/Saved pin:/)).toHaveTextContent(
        kind === 'journal'
          ? journal.expectedSnapshotHash
          : extraction.expectedSourceDigest,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save replacement' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Prepare and review',
      );
      expect(f.writes).toHaveLength(0);
      fireEvent.click(
        screen.getByRole('button', { name: 'Prepare scheduled source' }),
      );
      await screen.findByLabelText('Prepared schedule source');
      fireEvent.click(screen.getByRole('button', { name: 'Save replacement' }));
      await screen.findByText(/Replacement saved/);
      expect(f.writes[1]!.body).toHaveProperty(
        kind,
        kind === 'journal' ? journal : extraction,
      );
    },
  );
  it('clears prepared source pins on source access revocation and book change', async () => {
    const f = sourceSetup('journal');
    await chooseSource('journal');
    fireEvent.click(
      screen.getByRole('button', { name: 'Prepare scheduled source' }),
    );
    await screen.findByLabelText('Prepared schedule source');
    f.deny();
    fireEvent.click(
      screen.getByRole('button', { name: 'Load saved source choices' }),
    );
    await screen.findByRole('alert');
    expect(
      screen.queryByLabelText('Prepared schedule source'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('Reviewed source import'),
    ).not.toBeInTheDocument();
    f.view.rerender(
      <FinanceSchedules
        bookId={workspace}
        grants={[f.sourceGrant]}
        csrfToken="csrf"
      />,
    );
    expect(screen.queryByText(/Saved pin:/)).not.toBeInTheDocument();
  });
});
