import { StrictMode } from 'react';
import { FinanceAutomationRunRecordSchema } from '@emdo/contracts/browser';
import {
  prepareExtractionIntent,
  enqueueExtractionRun,
  readExtractionResult,
} from './finance-extraction-automation-api.js';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FinanceAutomationGrant } from '@emdo/contracts/browser';
import { FinanceExtractionAutomation } from './finance-extraction-automation.js';
const auth = vi.hoisted(() => ({
  state: 'authenticated',
  sessionBinding: 'current',
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
  allowedCapabilities: ['finance.documents.extract'],
  authorityRevision: { membership: 1, bookAccess: 1, entitlement: 1 },
  limits: {
    maxRuns: 10,
    maxAttemptsPerRun: 3,
    maxItemsPerRun: 1,
    maxTotalItems: 10,
    currency: 'CAD',
    maxAmountPerRun: '0',
    maxTotalAmount: '0',
  },
  validFrom: '2026-01-01T00:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z',
};
const document = {
  id: id(5),
  filename: 'September statement.pdf',
  format: 'pdf',
  sourceDigest: 'a'.repeat(64),
};
const intent = {
  schemaVersion: 1,
  evidenceId: document.id,
  expectedSourceDigest: document.sourceDigest,
  standardizationRunId: id(6),
  expectedRunRevision: 2,
  expectedExtractionRevision: 0,
};
const record = {
  run: {
    request: {
      operationId: id(7),
      grantId: grant.id,
      grantRevision: 1,
      workspaceId: grant.workspaceId,
      bookId: grant.bookId,
      capability: 'finance.documents.extract',
      requestHash: 'b'.repeat(64),
      itemCount: 1,
      currency: 'CAD',
      amount: '0',
      extraction: intent,
    },
    revision: 1,
    attempts: 0,
    status: 'queued',
    outcomeReference: null,
  },
  createdAt: '2026-09-15T00:00:00Z',
  blockedReason: null,
};
afterEach(() => {
  vi.unstubAllGlobals();
  auth.state = 'authenticated';
});
function setup(blockedReason?: string) {
  const savedRecord = blockedReason
    ? { ...record, blockedReason, run: { ...record.run, status: 'blocked' } }
    : record;
  let lose = false,
    denied = false;
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (denied) return new Response('{}', { status: 403 });
    if (path.includes('/evidence?'))
      return Response.json({ documents: [document], nextOffset: null });
    if (path.endsWith('/extractions/prepare')) return Response.json(intent);
    if (path.endsWith('/automations/runs') && init?.method === 'POST') {
      if (lose) {
        lose = false;
        throw new TypeError('Lost response');
      }
      return Response.json(savedRecord);
    }
    if (path.includes('/automations/runs?'))
      return Response.json({ runs: [], nextOffset: null });
    if (path.endsWith(`/automations/runs/${id(7)}`))
      return Response.json(savedRecord);
    throw new Error(path);
  });
  vi.stubGlobal('fetch', fetcher);
  const props = {
    bookId: id(1),
    bookName: 'Operations',
    grants: [grant],
    csrfToken: 'csrf-current',
  };
  const view = render(
    <StrictMode>
      <FinanceExtractionAutomation {...props} />
    </StrictMode>,
  );
  return {
    props,
    view,
    fetcher,
    lose: () => {
      lose = true;
    },
    deny: () => {
      denied = true;
    },
  };
}
async function prepare() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Open document extraction' }),
  );
  await screen.findByRole('option', { name: 'September statement.pdf · PDF' });
  fireEvent.change(screen.getByLabelText('Saved document'), {
    target: { value: document.id },
  });
  fireEvent.change(screen.getByLabelText('Extraction grant'), {
    target: { value: grant.id },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Prepare extraction scope' }),
  );
  await screen.findByRole('region', { name: 'Prepared extraction scope' });
}
describe('extraction automation response binding', () => {
  it('shows actionable isolated OCR guidance from the saved blocked run', async () => {
    const f = setup('finance-extraction-ocr-unavailable');
    await prepare();
    fireEvent.click(
      screen.getByRole('button', { name: 'Queue reviewed extraction' }),
    );
    await screen.findByText(
      /Ask an administrator to configure the isolated OCR service/,
    );
    expect(
      f.fetcher.mock.calls.filter(
        ([, init]) =>
          init?.method === 'POST' &&
          String(init.body).includes('finance.documents.extract'),
      ),
    ).toHaveLength(1);
  });

  it('rejects a prepared scope for a different document', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...intent, evidenceId: id(9) })),
    );
    await expect(
      prepareExtractionIntent(
        id(1),
        document,
        'csrf',
        'same-key',
        new AbortController().signal,
      ),
    ).rejects.toThrow('different original');
  });
  it('rejects a saved run whose reviewed extraction revision changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ...record,
          run: {
            ...record.run,
            request: {
              ...record.run.request,
              extraction: { ...intent, expectedRunRevision: 3 },
            },
          },
        }),
      ),
    );
    await expect(
      enqueueExtractionRun(
        id(1),
        grant,
        { ...intent, schemaVersion: 1 },
        'csrf',
        'same-key',
        new AbortController().signal,
      ),
    ).rejects.toThrow('does not match');
  });
});
describe('saved extraction outcome binding', () => {
  it.each([0, 2])(
    'reads exact result revision for expected extraction %s',
    async (expected) => {
      const revision = expected === 0 ? 1 : expected;
      const saved = FinanceAutomationRunRecordSchema.parse({
        ...record,
        run: {
          ...record.run,
          status: 'completed',
          outcomeReference: id(7),
          request: {
            ...record.run.request,
            extraction: { ...intent, expectedExtractionRevision: expected },
          },
        },
      });
      const result = {
        schemaVersion: 1,
        kind: 'finance-document-extraction',
        operationId: id(7),
        workspaceId: grant.workspaceId,
        bookId: grant.bookId,
        evidenceId: document.id,
        sourceDigest: document.sourceDigest,
        standardizationRunId: intent.standardizationRunId,
        extractionRevision: revision,
        extractionDigest: 'c'.repeat(64),
        summary: {
          revision,
          adapterId: 'finance.pdf-ocr',
          adapterVersion: '1',
          sourceDigest: document.sourceDigest,
          extractionDigest: 'c'.repeat(64),
          status: 'needs-source-review',
          tableCount: 0,
          sheetCount: 0,
          pageCount: 2,
          truncated: false,
          issues: ['Review original page regions'],
        },
        approval: 'not-granted',
        posting: 'not-performed',
      };
      const fetcher = vi.fn(async () => Response.json(result));
      vi.stubGlobal('fetch', fetcher);
      expect(
        await readExtractionResult(
          grant.bookId,
          saved,
          new AbortController().signal,
        ),
      ).toMatchObject({
        extractionRevision: revision,
        approval: 'not-granted',
        posting: 'not-performed',
      });
      result.extractionRevision = 3;
      result.summary.revision = 3;
      await expect(
        readExtractionResult(grant.bookId, saved, new AbortController().signal),
      ).rejects.toThrow('does not match');
    },
  );
});
describe('document extraction automation review', () => {
  it('prepares inert scope then retries exactly the same reviewed enqueue and reads saved run', async () => {
    const f = setup();
    await prepare();
    expect(
      f.fetcher.mock.calls.filter(
        ([p, i]) => p.endsWith('/automations/runs') && i?.method === 'POST',
      ),
    ).toHaveLength(0);
    expect(
      screen.getByText('Scope prepared. No extraction has been queued.'),
    ).toBeVisible();
    f.lose();
    fireEvent.click(
      screen.getByRole('button', { name: 'Queue reviewed extraction' }),
    );
    await screen.findByRole('alert');
    fireEvent.click(
      screen.getByRole('button', { name: 'Queue reviewed extraction' }),
    );
    await screen.findByText(
      'Extraction request saved. Check its status below.',
    );
    const calls = f.fetcher.mock.calls.filter(
      ([p, i]) => p.endsWith('/automations/runs') && i?.method === 'POST',
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]?.body).toEqual(calls[1]![1]?.body);
    expect(new Headers(calls[0]![1]?.headers).get('idempotency-key')).toEqual(
      new Headers(calls[1]![1]?.headers).get('idempotency-key'),
    );
    expect(new Headers(calls[0]![1]?.headers).get('x-csrf-token')).toBe(
      'csrf-current',
    );
    expect(JSON.parse(String(calls[0]![1]?.body))).toEqual({
      grantId: grant.id,
      capability: 'finance.documents.extract',
      targets: [document.id],
      currency: 'CAD',
      amount: '0',
      extraction: intent,
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh extraction result' }),
    );
    await waitFor(() =>
      expect(
        f.fetcher.mock.calls.some(([p]) =>
          p.endsWith(`/automations/runs/${id(7)}`),
        ),
      ).toBe(true),
    );
  });
  it('clears reviewed scope on document/grant change and access denial', async () => {
    const f = setup();
    await prepare();
    fireEvent.change(screen.getByLabelText('Extraction grant'), {
      target: { value: '' },
    });
    expect(
      screen.queryByRole('region', { name: 'Prepared extraction scope' }),
    ).toBeNull();
    f.deny();
    fireEvent.click(
      screen.getByRole('button', { name: 'Open document extraction' }),
    );
    await screen.findByRole('alert');
    expect(
      screen.queryByRole('option', { name: 'September statement.pdf · PDF' }),
    ).toBeNull();
  });
  it('discards private state and pending request on session and book changes', async () => {
    const f = setup();
    await prepare();
    const signal = f.fetcher.mock.calls[0]![1]!.signal!;
    f.view.rerender(
      <FinanceExtractionAutomation {...f.props} bookId={id(8)} />,
    );
    expect(signal.aborted).toBe(true);
    expect(
      screen.queryByRole('region', { name: 'Prepared extraction scope' }),
    ).toBeNull();
    auth.state = 'unauthenticated';
    f.view.rerender(<FinanceExtractionAutomation {...f.props} />);
    expect(
      screen.queryByRole('button', { name: 'Open document extraction' }),
    ).toBeNull();
  });
});
