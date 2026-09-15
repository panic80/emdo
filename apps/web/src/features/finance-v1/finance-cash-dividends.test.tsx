import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinanceCashDividends } from './finance-cash-dividends.js';
import {
  dividendApi,
  savedDividendMatchesCommit,
  verifySavedDividend,
} from './finance-cash-dividend-api.js';
import {
  dividendDraftFromReview,
  dividendFunctionalAmount,
  emptyDividendReview,
} from './finance-cash-dividend-fields.js';
import {
  dividendCsrf,
  dividendFixture,
  dividendIds,
} from '../../../test/finance-dividend-fixture.js';
import { CommitInvestmentCashDividendSchema } from '@emdo/contracts/browser';

const auth = vi.hoisted(() => ({
  state: 'authenticated',
  sessionBinding: 'dividend-session',
  csrfToken: 'e2e-csrf-token-01234567890123456789',
}));
vi.mock('../auth/auth-context.js', () => ({ useAuth: () => auth }));
vi.mock('../../downloads/save-memory-file.js', () => ({
  saveMemoryFile: vi.fn(),
}));
beforeEach(() => {
  auth.state = 'authenticated';
  auth.sessionBinding = 'dividend-session';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function setup(role = 'administrator') {
  const fixture = dividendFixture();
  fixture.state.role = role;
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers),
      body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
    if (path.endsWith('/commit')) {
      expect(headers.get('x-csrf-token')).toBe(dividendCsrf);
      expect(headers.get('idempotency-key')).toMatch(/^[a-f0-9-]{36}$/u);
    }
    const result = fixture.handle(
      init?.method ?? 'GET',
      path,
      body,
      headers.get('idempotency-key') ?? '',
    );
    return new Response(JSON.stringify(result.json), { status: result.status });
  });
  vi.stubGlobal('fetch', fetcher);
  const props = { bookId: dividendIds.book, role };
  return { fixture, fetcher, props };
}
async function openSource() {
  fireEvent.click(screen.getByRole('button', { name: 'Open cash dividends' }));
  await screen.findByRole('button', { name: 'Review a cash dividend' });
  fireEvent.click(
    screen.getByRole('button', { name: 'Review a cash dividend' }),
  );
  await screen.findByRole('combobox', { name: 'Saved statement' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Saved statement' }), {
    target: { value: dividendIds.batch },
  });
  await screen.findByRole('combobox', { name: 'Statement receipt row' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Investment' }), {
    target: { value: dividendIds.instrument },
  });
  fireEvent.change(
    screen.getByRole('combobox', { name: 'Statement receipt row' }),
    { target: { value: dividendIds.row } },
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Load current dividend source' }),
  );
  await screen.findByRole('heading', { name: 'Prepare a cash dividend' });
}
function fill(gross = '100.00', tax = '15.00') {
  fireEvent.change(screen.getByLabelText('Declared date'), {
    target: { value: '2026-07-20' },
  });
  fireEvent.change(screen.getByLabelText('Ex-dividend date · optional'), {
    target: { value: '2026-07-21' },
  });
  fireEvent.change(screen.getByLabelText('Dividend reference'), {
    target: { value: 'ACME · August 2026 dividend' },
  });
  fireEvent.change(
    screen.getByRole('combobox', { name: 'Dividend income account' }),
    { target: { value: dividendIds.income } },
  );
  fireEvent.change(
    screen.getByRole('combobox', { name: 'Withholding account' }),
    { target: { value: dividendIds.tax } },
  );
  fireEvent.change(screen.getByLabelText('Source review notes'), {
    target: {
      value:
        'Checked gross, withholding, and the net receipt against the original statement.',
    },
  });
  for (const [name, value, column] of [
    ['Gross dividend', gross, 'Gross'],
    ['Withholding tax', tax, 'Tax'],
    ['Net cash received', '85.00', 'Net'],
  ]) {
    const group = within(screen.getByRole('group', { name }));
    if (name !== 'Net cash received') {
      fireEvent.change(
        group.getByRole('textbox', { name: 'Original currency amount' }),
        { target: { value } },
      );
      if (value)
        fireEvent.change(
          group.getByRole('combobox', { name: 'Original currency' }),
          { target: { value: 'CAD' } },
        );
    }
    if (value) {
      fireEvent.change(
        group.getByRole('textbox', { name: 'Exact value as printed' }),
        { target: { value } },
      );
      fireEvent.change(
        group.getByRole('textbox', { name: 'Exact source column heading' }),
        { target: { value: column } },
      );
    }
  }
}
async function preview() {
  fireEvent.submit(
    screen
      .getByRole('button', { name: 'Preview dividend journal' })
      .closest('form')!,
  );
  await screen.findByRole('heading', { name: 'Review the dividend journal' });
}
function approve() {
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(
    screen.getByRole('button', { name: 'Post reviewed dividend' }),
  );
}
describe('reviewed cash dividends', () => {
  it('requires all three source amounts and a separate posting confirmation bound to the server preview', async () => {
    const { fixture, props } = setup();
    render(<FinanceCashDividends {...props} />);
    await openSource();
    expect(
      (
        within(screen.getByRole('group', { name: 'Gross dividend' })).getByRole(
          'textbox',
          { name: 'Original currency amount' },
        ) as HTMLInputElement
      ).value,
    ).toBe('');
    expect(
      (
        within(
          screen.getByRole('group', { name: 'Withholding tax' }),
        ).getByRole('textbox', {
          name: 'Original currency amount',
        }) as HTMLInputElement
      ).value,
    ).toBe('');
    fill();
    await preview();
    expect(
      fixture.writes.find((write) => write.path.endsWith('/preview'))?.body,
    ).toMatchObject({
      expectedSourceRevision: 3,
      sourceSnapshotHash: 'a'.repeat(64),
      action: {
        gross: {
          nativeAmount: '100.00',
          provenance: { sourceRow: 8, raw: '100.00', column: 'Gross' },
        },
        withholding: { nativeAmount: '15.00' },
        net: { nativeAmount: '85.00' },
      },
    });
    expect(
      fixture.writes.find((write) => write.path.endsWith('/preview'))?.body,
    ).not.toHaveProperty('source');
    expect(
      screen.getByRole('button', { name: 'Post reviewed dividend' }),
    ).toBeDisabled();
    approve();
    await screen.findByRole('heading', { name: 'Dividend posting confirmed' });
    expect(fixture.actions).toHaveLength(1);
    const commit = fixture.writes.find((write) =>
      write.path.endsWith('/commit'),
    )!;
    expect(commit.key).toBe(commit.body.idempotencyKey);
    expect(commit.body).toMatchObject({
      expectedSourceRevision: 3,
      sourceSnapshotHash: 'a'.repeat(64),
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'View saved dividend and evidence' }),
    );
    await screen.findByRole('region', { name: 'Saved cash dividend' });
    expect(screen.getAllByText('100 CAD').length).toBeGreaterThan(0);
  });
  it('keeps omitted withholding unavailable and returns actionable server blockers without offering posting', async () => {
    const { fixture, props } = setup();
    render(<FinanceCashDividends {...props} />);
    await openSource();
    fill('100.00', '');
    await preview();
    expect(
      screen.getByText(
        'Enter withholding tax explicitly, including a supported zero.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Post reviewed dividend' }),
    ).not.toBeInTheDocument();
    expect(
      fixture.writes.filter((write) => write.path.endsWith('/commit')),
    ).toHaveLength(0);
  });
  it('retains an explicitly reviewed zero without inventing a zero journal line', async () => {
    const { fixture, props } = setup();
    render(<FinanceCashDividends {...props} />);
    await openSource();
    fill('85.00', '0.00');
    await preview();
    approve();
    await screen.findByRole('heading', { name: 'Dividend posting confirmed' });
    expect(fixture.actions[0]?.withholding).toMatchObject({
      nativeAmount: '0',
      journalLineNumber: null,
      provenance: { raw: '0.00', column: 'Tax' },
    });
  });
  it('recovers a lost posting response through saved readback without posting again, including normalized numeric strings', async () => {
    const { fixture, props } = setup();
    fixture.state.loseCommitResponse = true;
    render(<FinanceCashDividends {...props} />);
    await openSource();
    fill();
    await preview();
    approve();
    await screen.findByRole('heading', { name: 'Check this posting outcome' });
    expect(
      screen.queryByRole('button', { name: 'Post reviewed dividend' }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Check saved dividend' }),
    );
    await screen.findByRole('region', { name: 'Saved cash dividend' });
    expect(
      fixture.writes.filter((write) => write.path.endsWith('/commit')),
    ).toHaveLength(1);
  });
  it('retries only the identical command and request key after a saved-status check finds no action', async () => {
    const { fixture, props } = setup();
    fixture.state.skipCommitOnce = true;
    render(<FinanceCashDividends {...props} />);
    await openSource();
    fill();
    await preview();
    approve();
    await screen.findByRole('heading', { name: 'Check this posting outcome' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Check saved dividend' }),
    );
    await screen.findByRole('button', { name: 'Retry exact posting' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry exact posting' }),
    );
    await screen.findByRole('heading', { name: 'Dividend posting confirmed' });
    const writes = fixture.writes.filter((write) =>
      write.path.endsWith('/commit'),
    );
    expect(writes).toHaveLength(2);
    expect(writes[0]!.key).toBe(writes[1]!.key);
    expect(writes[0]!.body).toEqual(writes[1]!.body);
    expect(fixture.actions).toHaveLength(1);
  });
  it('blocks a stale source preview and a mismatched returned source without making a posting', async () => {
    const { fixture, props } = setup();
    render(<FinanceCashDividends {...props} />);
    await openSource();
    fill();
    fixture.source.sourceRevision++;
    fireEvent.submit(
      screen
        .getByRole('button', { name: 'Preview dividend journal' })
        .closest('form')!,
    );
    await screen.findByRole('button', { name: 'Refresh statement source' });
    expect(
      screen.queryByRole('button', { name: 'Post reviewed dividend' }),
    ).not.toBeInTheDocument();
    fixture.state.previewMismatch = true;
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh statement source' }),
    );
    await screen.findByRole('heading', { name: 'Prepare a cash dividend' });
    fill();
    fireEvent.submit(
      screen
        .getByRole('button', { name: 'Preview dividend journal' })
        .closest('form')!,
    );
    await screen.findByText(/preview does not match/u);
    expect(
      fixture.writes.filter((write) => write.path.endsWith('/commit')),
    ).toHaveLength(0);
  });
  it('clears private source and draft details after a current permission denial', async () => {
    const { fixture, props } = setup();
    render(<FinanceCashDividends {...props} />);
    await openSource();
    fill();
    fixture.state.previewStatus = 403;
    fireEvent.submit(
      screen
        .getByRole('button', { name: 'Preview dividend journal' })
        .closest('form')!,
    );
    await screen.findByRole('alert');
    expect(
      screen.queryByRole('region', { name: 'Cash dividend review' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('85.00 CAD')).not.toBeInTheDocument();
  });
  it('keeps viewers read-only and hides review controls when the dividend capability is unavailable', async () => {
    const { fixture, props } = setup('viewer');
    const view = render(<FinanceCashDividends {...props} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Open cash dividends' }),
    );
    await screen.findByText(/No saved dividends/u);
    expect(
      screen.queryByRole('button', { name: 'Review a cash dividend' }),
    ).not.toBeInTheDocument();
    view.unmount();
    fixture.state.listStatus = 503;
    render(
      <FinanceCashDividends bookId={dividendIds.book} role="administrator" />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Open cash dividends' }),
    );
    await screen.findByRole('alert');
    expect(
      screen.queryByRole('button', { name: 'Review a cash dividend' }),
    ).not.toBeInTheDocument();
    expect(fixture.writes).toEqual([]);
  });
  it('lets a preparer preview while keeping posting reserved for an approver or administrator', async () => {
    const { props } = setup('preparer');
    render(<FinanceCashDividends {...props} />);
    await openSource();
    fill();
    await preview();
    expect(
      screen.getByText(
        'An administrator or approver must review and post this dividend.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Post reviewed dividend' }),
    ).not.toBeInTheDocument();
  });
  it('aborts a pending read when the authenticated session changes', async () => {
    setup();
    let signal: AbortSignal | undefined;
    let finish: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_path: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }),
    );
    const view = render(
      <FinanceCashDividends bookId={dividendIds.book} role="administrator" />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Open cash dividends' }),
    );
    auth.sessionBinding = 'new-dividend-session';
    view.rerender(
      <FinanceCashDividends bookId={dividendIds.book} role="administrator" />,
    );
    expect(signal?.aborted).toBe(true);
    finish!(new Response(JSON.stringify({ actions: [], nextOffset: null })));
    await waitFor(() =>
      expect(screen.queryByText(/No saved dividends/u)).not.toBeInTheDocument(),
    );
  });
  it('compares saved amounts exactly without floating-point conversion and rejects a different book', async () => {
    const { fixture } = setup();
    const entry = emptyDividendReview(fixture.source);
    Object.assign(entry, {
      declaredOn: '2026-07-20',
      sourceReference: 'Exact test',
      reviewReason: 'Original checked',
      incomeAccountId: dividendIds.income,
      withholdingAccountId: dividendIds.tax,
    });
    for (const [kind, amount] of [
      ['gross', '100.00'],
      ['withholding', '15.00'],
      ['net', '85.00'],
    ] as const)
      Object.assign(entry.amounts[kind], {
        nativeAmount: amount,
        currency: 'CAD',
        fxRate: '1',
        fxSource: 'identity',
        raw: amount,
        location: kind,
      });
    const input = CommitInvestmentCashDividendSchema.parse({
      action: dividendDraftFromReview(
        entry,
        fixture.source,
        crypto.randomUUID(),
      ),
      expectedSourceRevision: 3,
      sourceSnapshotHash: 'a'.repeat(64),
      idempotencyKey: crypto.randomUUID(),
    });
    expect(
      dividendFunctionalAmount(
        { ...entry.amounts.gross, nativeAmount: '9007199254740993.01' },
        'CAD',
      ),
    ).toBe('9007199254740993.01');
    await dividendApi.commit(
      dividendIds.book,
      input,
      dividendCsrf,
      new AbortController().signal,
    );
    const saved = fixture.actions[0]!;
    expect(savedDividendMatchesCommit(saved, input)).toBe(true);
    expect(() =>
      verifySavedDividend(
        { ...saved, bookId: dividendIds.account },
        dividendIds.book,
      ),
    ).toThrow('do not match');
    saved.gross.nativeAmount = '100.000000000001';
    expect(savedDividendMatchesCommit(saved, input)).toBe(false);
  });
});
