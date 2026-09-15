import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinanceTaxWorkspace } from './finance-tax-workspace.js';
import {
  taxMutationRequest,
  TaxMutationSchema,
  verifyTaxCase,
} from './finance-tax-model.js';
import {
  taxFixture,
  taxCaseId,
  taxBookId,
  taxAuthorizationId,
  taxSecondAuthorizationId,
  taxSourceId,
  taxMemberId,
} from '../../../test/finance-tax-fixture.js';

const auth = vi.hoisted(() => ({
  sessionBinding: 'current-tax-session',
  state: 'authenticated',
  csrfToken: 'csrf-tax',
}));
vi.mock('../auth/auth-context.js', () => ({ useAuth: () => auth }));
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const base = '/api/v2/finance/tax/cases';
beforeEach(() => {
  auth.sessionBinding = 'current-tax-session';
  auth.state = 'authenticated';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(
  options: {
    role?: 'owner' | 'preparer' | 'reviewer' | 'viewer';
    empty?: boolean;
  } = {},
) {
  const fixture = taxFixture();
  fixture.detail.caseRole = options.role ?? 'owner';
  const state = {
    blocked: false,
    status: 200,
    listStatus: 200,
    empty: !!options.empty,
    authorizations: 0,
    conflict: false,
  };
  const writes: { path: string; body: Record<string, unknown>; key: string }[] =
    [];
  const fetcher = vi.fn<
    (path: string, init?: RequestInit) => Promise<Response>
  >(async (path, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const headers = new Headers(init.headers);
      expect(headers.get('x-csrf-token')).toBe('csrf-tax');
      writes.push({ path, body, key: headers.get('idempotency-key')! });
      if (state.conflict)
        return response({ code: 'finance-tax-conflict' }, 409);
      if (path === base) {
        state.empty = false;
        return response(fixture.receipt());
      }
      if (path.endsWith('/declarations')) {
        const declaration = {
          sourceId:
            typeof body.sourceId === 'string' ? body.sourceId : taxSourceId,
          sourceRevision: Number(body.expectedSourceRevision ?? 0) + 1,
          contentHash: 'e'.repeat(64),
          factKey: String(body.factKey),
          category:
            body.category as (typeof fixture.declarations)[number]['category'],
          value: body.value as (typeof fixture.declarations)[number]['value'],
          reviewState: 'unreviewed' as const,
        };
        fixture.declarations.splice(
          0,
          fixture.declarations.length,
          declaration,
        );
        fixture.detail.declaredInputs = [declaration];
        fixture.detail.questionnaire.declarationSourceBindings = [
          {
            sourceId: declaration.sourceId,
            sourceRevision: declaration.sourceRevision,
            contentHash: declaration.contentHash,
          },
        ];
        fixture.advance();
        return response(fixture.receipt());
      }
      if (path.endsWith('/book-sources')) {
        state.authorizations += 1;
        const binding = {
          bookId: taxBookId,
          snapshotRevision: state.authorizations,
          snapshotHash: 'f'.repeat(64),
          authorizationId:
            state.authorizations === 1
              ? taxAuthorizationId
              : taxSecondAuthorizationId,
          authorizationRevision: state.authorizations,
        };
        fixture.detail.questionnaire.sourceAuthorizationBindings = [binding];
        fixture.detail.questionnaire.intake.sourceBooks = [
          {
            bookId: taxBookId,
            snapshotRevision: binding.snapshotRevision,
            snapshotHash: binding.snapshotHash,
          },
        ];
        fixture.advance();
        return response({ ...fixture.receipt(), ...binding });
      }
      if (path.includes('/book-sources/') && path.endsWith('/revoke')) {
        state.blocked = true;
        return response({ caseId: taxCaseId, authorizationRevision: 2 });
      }
      if (path.endsWith('/reset-after-source-revocation')) {
        state.blocked = false;
        fixture.detail.declaredInputs = [];
        fixture.detail.questionnaire.declarationSourceBindings = [];
        fixture.detail.questionnaire.sourceAuthorizationBindings = [];
        fixture.detail.questionnaire.intake.sourceBooks = [];
        fixture.advance();
        return response(fixture.receipt());
      }
      if (path.endsWith('/grants/revoke')) {
        const item = fixture.grants.find(
          (grant) => grant.userId === body.userId,
        )!;
        item.status = 'revoked';
        item.revokedAt = '2026-09-13T12:00:00.000Z';
        item.revision++;
        return response({ caseId: taxCaseId, revision: item.revision });
      }
      if (path.endsWith('/grants')) {
        const item = fixture.grants.find(
          (grant) => grant.userId === body.userId,
        )!;
        item.role = String(body.role);
        item.revision++;
        return response({ caseId: taxCaseId, revision: item.revision });
      }
    }
    if (path.startsWith(`${base}?`))
      return state.listStatus === 200
        ? response({ cases: state.empty ? [] : [fixture.summary()] })
        : response({}, state.listStatus);
    if (path === '/api/v2/finance/books')
      return response({ books: fixture.books });
    if (path.endsWith('/grants')) return response(fixture.grants);
    if (path === '/api/v1/household/memberships') return response({}, 403);
    if (state.blocked)
      return response({ code: 'finance-tax-source-revoked' }, 409);
    if (state.status !== 200) return response({}, state.status);
    if (path.endsWith('/assessment')) return response(fixture.assessment());
    if (path.endsWith('/declarations')) return response(fixture.declarations);
    return response(fixture.detail);
  });
  vi.stubGlobal('fetch', fetcher);
  return {
    ...fixture,
    state,
    writes,
    fetcher,
    ...render(<FinanceTaxWorkspace />),
  };
}
async function openCase() {
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Open tax case 2025 · Personal income tax',
    }),
  );
  await screen.findByRole('button', { name: 'Saved inputs' });
}
const section = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name }));

describe('Private tax workspace', () => {
  it('creates only an explicitly reviewed intake case with no invented package identifiers', async () => {
    const { writes } = setup({ empty: true });
    await screen.findByText('No private cases on this page');
    section('New tax case');
    for (const [label, value] of [
      ['Case title', '2025 Personal'],
      ['Person or legal entity', 'Jordan Chen'],
      ['Taxpayer type', 'individual'],
      ['Country', 'CA'],
      ['Province, state or region code', 'CA-ON'],
      ['Tax year', '2025'],
      ['Return type', 'income-tax-return'],
      ['Form and version reference', 'T1-2025'],
    ])
      fireEvent.change(screen.getByLabelText(new RegExp(`^${label!}`)), {
        target: { value },
      });
    section('Review case setup');
    expect(writes).toHaveLength(0);
    expect(screen.getByLabelText('Review new tax case')).toHaveTextContent(
      'None authorized',
    );
    section('Create case · save inputs only');
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toMatchObject({
      mode: 'intake-only',
      domesticResident: null,
      hasCrossBorderActivity: null,
      standaloneCorporation: null,
      relatedParties: [],
    });
    expect(writes[0]!.body).not.toHaveProperty('packageId');
    expect(writes[0]!.body).not.toHaveProperty('packageVersion');
    expect(writes[0]!.key).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('saves reviewed exact decimal text and explicit source/case revisions without treating it as a reviewed answer', async () => {
    const { writes } = setup();
    await openCase();
    section('Saved inputs');
    section('Revise Employment income (CAD)');
    fireEvent.change(screen.getByLabelText(/^Declaration value/), {
      target: { value: '9007199254740993.1200' },
    });
    section('Review input');
    expect(writes).toHaveLength(0);
    section('Save unreviewed input');
    await screen.findByRole('table', {
      name: 'Inputs attached to this questionnaire',
    });
    expect(writes[0]!.body).toEqual({
      expectedCaseRevision: 2,
      expectedSourceRevision: 1,
      sourceId: taxSourceId,
      factKey: 'Employment income (CAD)',
      category: 'income',
      value: { type: 'decimal', value: '9007199254740993.1200' },
    });
    expect(screen.getByRole('table')).toHaveTextContent(
      '9007199254740993.1200',
    );
    expect(screen.getByRole('table')).toHaveTextContent('Unreviewed');
  });
  it.each(['preparer', 'reviewer', 'viewer'] as const)(
    'uses the actual %s case role for input and owner-only controls',
    async (role) => {
      const { fetcher } = setup({ role });
      await openCase();
      section('Saved inputs');
      expect(screen.queryByRole('button', { name: 'Add input' })).toBe(
        role === 'preparer'
          ? screen.getByRole('button', { name: 'Add input' })
          : null,
      );
      section('Sources & access');
      expect(
        screen.queryByRole('button', { name: 'Save case access' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText('Book to authorize'),
      ).not.toBeInTheDocument();
      expect(
        fetcher.mock.calls.some(([path]) => path.endsWith('/grants')),
      ).toBe(false);
    },
  );
  it('requires source removal and reset readbacks, retains source history and explicitly rebinds the same book', async () => {
    const { writes } = setup();
    await openCase();
    section('Sources & access');
    await waitFor(() =>
      expect(screen.getByLabelText('Book to authorize')).not.toBeDisabled(),
    );
    fireEvent.change(screen.getByLabelText('Book to authorize'), {
      target: { value: taxBookId },
    });
    fireEvent.click(
      screen.getByLabelText(
        'I authorize this book snapshot for this private tax case.',
      ),
    );
    section('Authorize book snapshot');
    await screen.findByText('Saved snapshot 1 · authorization revision 1');
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Review removal of Personal finances',
      }),
    );
    expect(
      screen.getByRole('button', { name: 'Remove source authorization' }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText(
        'I understand this will make the current questionnaire inputs unavailable.',
      ),
    );
    section('Remove source authorization');
    await screen.findByRole('button', { name: 'Review questionnaire reset' });
    expect(screen.queryByText('123456.7800')).not.toBeInTheDocument();
    section('Review questionnaire reset');
    expect(
      screen.getByRole('button', { name: 'Reset questionnaire inputs' }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText(
        'I understand which questionnaire inputs will be removed and that declaration sources will remain.',
      ),
    );
    section('Reset questionnaire inputs');
    await screen.findByRole('button', { name: 'Saved inputs' });
    section('Saved inputs');
    expect(
      screen.getByText('No inputs attached to this questionnaire'),
    ).toBeVisible();
    fireEvent.click(screen.getByText('Retained declaration sources (1)'));
    expect(screen.getByText('123456.7800')).toBeVisible();
    section('Sources & access');
    await waitFor(() =>
      expect(screen.getByLabelText('Book to authorize')).not.toBeDisabled(),
    );
    fireEvent.change(screen.getByLabelText('Book to authorize'), {
      target: { value: taxBookId },
    });
    fireEvent.click(
      screen.getByLabelText(
        'I authorize this book snapshot for this private tax case.',
      ),
    );
    section('Authorize book snapshot');
    await screen.findByText('Saved snapshot 2 · authorization revision 2');
    expect(writes.map((write) => write.body)).toEqual([
      { bookId: taxBookId, expectedCaseRevision: 2 },
      { expectedAuthorizationRevision: 1 },
      { expectedCaseRevision: 3 },
      { bookId: taxBookId, expectedCaseRevision: 4 },
    ]);
    expect(new Set(writes.map((write) => write.key)).size).toBe(4);
  });
  it('reviews grant changes and removal against exact current grant revisions', async () => {
    const { writes } = setup();
    await openCase();
    section('Sources & access');
    await screen.findByRole('button', { name: 'Change role' });
    section('Change role');
    fireEvent.change(screen.getByLabelText(/^Case role/), {
      target: { value: 'reviewer' },
    });
    section('Review case access');
    expect(writes).toHaveLength(0);
    section('Save case access');
    await screen.findByText('reviewer · active · grant revision 3');
    section('Review access removal');
    expect(writes).toHaveLength(1);
    section('Remove case access');
    await screen.findByText('reviewer · revoked · grant revision 4');
    expect(writes[0]!.body).toEqual({
      userId: taxMemberId,
      role: 'reviewer',
      expectedGrantRevision: 2,
    });
    expect(writes[1]!.body).toEqual({
      userId: taxMemberId,
      expectedGrantRevision: 3,
    });
  });
  it('clears revoked private inputs, denies recovery without fresh owner authority, and distinguishes service errors from empty cases', async () => {
    const { state, detail } = setup();
    await openCase();
    section('Saved inputs');
    expect(screen.getByRole('table')).toHaveTextContent('123456.7800');
    state.status = 403;
    detail.caseRole = 'viewer';
    section('Refresh tax case');
    await screen.findByText('Questionnaire inputs are unavailable');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Review questionnaire reset' }),
    ).not.toBeInTheDocument();
    state.listStatus = 503;
    section('All tax cases');
    await screen.findByRole('alert');
    expect(
      screen.queryByText('No private cases on this page'),
    ).not.toBeInTheDocument();
  });
  it('locks stale revision edits until a refresh and clears session-bound inputs on sign out', async () => {
    const result = setup();
    await openCase();
    section('Saved inputs');
    section('Revise Employment income (CAD)');
    section('Review input');
    result.state.conflict = true;
    section('Save unreviewed input');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save unreviewed input' }),
      ).toBeDisabled(),
    );
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('changed');
    auth.state = 'anonymous';
    result.rerender(<FinanceTaxWorkspace />);
    expect(screen.queryByText('123456.7800')).not.toBeInTheDocument();
    expect(
      screen.getByText('Connect and sign in to open private tax inputs.'),
    ).toBeVisible();
  });
  it('clears case content when an owner-only access recheck is forbidden', async () => {
    const result = setup();
    await openCase();
    const original = result.fetcher.getMockImplementation()!;
    result.fetcher.mockImplementation((path, init) =>
      path.endsWith('/grants')
        ? Promise.resolve(response({}, 403))
        : original(path, init),
    );
    section('Sources & access');
    await screen.findByText(
      'Current case access could not be confirmed. Private inputs have been cleared; refresh the case to check access.',
    );
    expect(screen.queryByText('Jordan Chen · 2025')).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('Book to authorize'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Saved inputs' }),
    ).not.toBeInTheDocument();
  });
  it('aborts a late private detail response when returning to the list', async () => {
    const result = setup();
    const original = result.fetcher.getMockImplementation()!;
    let finish: (() => void) | undefined, signal: AbortSignal | undefined;
    result.fetcher.mockImplementation(async (path, init) => {
      if (path === `${base}/${taxCaseId}`) {
        signal = init?.signal ?? undefined;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
      return original(path, init);
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Open tax case 2025 · Personal income tax',
      }),
    );
    await waitFor(() => expect(finish).toBeDefined());
    section('All tax cases');
    expect(signal?.aborted).toBe(true);
    await act(async () => finish!());
    expect(
      screen.queryByRole('button', { name: 'Saved inputs' }),
    ).not.toBeInTheDocument();
  });
});

describe('Tax source verification and uncertain retries', () => {
  it('rejects mismatched snapshot bindings and never infers current declarations from legacy history', () => {
    const fixture = taxFixture();
    fixture.detail.declaredInputs[0]!.sourceRevision = 2;
    expect(() =>
      verifyTaxCase(
        fixture.detail,
        fixture.declarations,
        fixture.assessment(),
        taxCaseId,
      ),
    ).toThrow('do not match');
    delete fixture.detail.questionnaire.declarationSourceBindings;
    fixture.detail.declarationBindingStatus = 'legacy-unbound';
    fixture.detail.declaredInputs = [];
    const value = verifyTaxCase(
      fixture.detail,
      fixture.declarations,
      fixture.assessment(),
      taxCaseId,
    );
    expect(value.detail.declaredInputs).toEqual([]);
    expect(value.declarations).toHaveLength(1);
  });
  it('retains an idempotency key after an uncertain response and sends no write after abort', async () => {
    const fixture = taxFixture();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network disconnected'))
      .mockResolvedValue(response(fixture.receipt()));
    vi.stubGlobal('fetch', fetcher);
    const post = taxMutationRequest(),
      control = new AbortController();
    const payload = { expectedCaseRevision: 2 };
    await expect(
      post(
        `${base}/${taxCaseId}/reset-after-source-revocation`,
        payload,
        TaxMutationSchema,
        control.signal,
        'csrf',
      ),
    ).rejects.toThrow('disconnected');
    await post(
      `${base}/${taxCaseId}/reset-after-source-revocation`,
      payload,
      TaxMutationSchema,
      control.signal,
      'csrf',
    );
    expect(fetcher.mock.calls[0]![1].headers['idempotency-key']).toBe(
      fetcher.mock.calls[1]![1].headers['idempotency-key'],
    );
    control.abort();
    await expect(
      post('not-sent', {}, TaxMutationSchema, control.signal, 'csrf'),
    ).rejects.toThrow('aborted');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
