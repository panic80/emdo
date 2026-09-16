import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinanceStandardizationReconciliation } from './finance-standardization-reconciliation.js';
import {
  cadMinorText,
  reconciliationChoices,
  verifyReconciliation,
} from './finance-standardization-reconciliation-api.js';
import { standardizationFixture } from '../../../test/finance-standardization-fixture.js';
import {
  reconciliationFixture,
  reservationId,
  receiptId,
} from '../../../test/finance-reconciliation-fixture.js';
const auth = vi.hoisted(() => ({
  state: 'authenticated',
  sessionBinding: 'reconciliation-session',
  csrfToken: 'reconciliation-csrf',
}));
vi.mock('../auth/auth-context.js', () => ({ useAuth: () => auth }));
beforeEach(() => {
  auth.state = 'authenticated';
  auth.sessionBinding = 'reconciliation-session';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function setup() {
  const runs = standardizationFixture(),
    run = runs.createRun('indeterminate');
  const fixture = reconciliationFixture(run),
    writes: Array<{ path: string; body: unknown; key: string }> = [];
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : {};
    if (init?.method === 'POST') {
      const headers = new Headers(init.headers);
      expect(headers.get('x-csrf-token')).toBe('reconciliation-csrf');
      const key = headers.get('idempotency-key')!;
      expect(key).toMatch(/^[a-f0-9-]{36}$/u);
      writes.push({ path, body, key });
    }
    const result = fixture.handle(init?.method, body, path);
    return new Response(JSON.stringify(result.json), { status: result.status });
  });
  vi.stubGlobal('fetch', fetcher);
  const props = {
    run,
    role: 'administrator',
    onUpdated: vi.fn(async () => {}),
  };
  return { ...fixture, props, writes, fetcher };
}
async function open() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Review outcome evidence' }),
  );
  await screen.findByText('Choose the saved attempt to review');
  fireEvent.click(screen.getByRole('radio', { name: /Attempt 1/u }));
}
describe('standardization outcome reconciliation', () => {
  it('keeps unavailable receipt evidence unresolved and preserves the reserved cost', async () => {
    const fixture = setup();
    fixture.addReceipt('unavailable');
    render(<FinanceStandardizationReconciliation {...fixture.props} />);
    await open();
    expect(
      screen.getByText(/This is not proof that no request was sent/u),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Review not-sent resolution' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Review recorded cost' }),
    ).not.toBeInTheDocument();
    expect(fixture.writes).toEqual([]);
    expect(fixture.record.spend[0]!.actualCadMinor).toBeNull();
  });
  it('requires explicit acknowledgment to retain the exact reserved cost and never retries automatically', async () => {
    const fixture = setup();
    fixture.record.spend[0]!.providerResponseId = null;
    const before = structuredClone(fixture.record.spend);
    render(<FinanceStandardizationReconciliation {...fixture.props} />);
    await open();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Retain CAD 0.50 for separate retry',
      }),
    );
    expect(
      screen.getByText('Keep the full CAD 0.50 reserved'),
    ).toBeInTheDocument();
    const save = screen.getByRole('button', {
      name: 'Save outcome resolution',
    });
    expect(save).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', { name: /actual charge is uncertain/u }),
    );
    fireEvent.click(save);
    await waitFor(() => expect(fixture.props.onUpdated).toHaveBeenCalledOnce());
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]!.path).toMatch(/\/resolve$/u);
    expect(fixture.writes[0]!.body).toEqual({
      expectedRevision: 1,
      reservationId,
      decision: 'retain-reserved-cost',
      receiptId: null,
      acknowledgeNoApproval: true,
    });
    expect(fixture.record.spend).toEqual(before);
    expect(fixture.record.status).toBe('blocked');
    expect(
      screen.getByText(
        'Retained full reserved cost; retry requires a separate action',
      ),
    ).toBeInTheDocument();
  });
  it('only offers retained cost review for the latest indeterminate attempt below the attempt limit', () => {
    const { record } = setup();
    const choices = () => reconciliationChoices(record, reservationId, '');
    expect(choices().canRetainReservation).toBe(true);
    record.hasLiveLease = true;
    expect(choices().canRetainReservation).toBe(false);
    record.hasLiveLease = false;
    record.spend[0]!.status = 'reserved';
    expect(choices().canRetainReservation).toBe(false);
    record.spend[0]!.status = 'indeterminate';
    record.spend[0]!.attempt = 3;
    expect(choices().canRetainReservation).toBe(false);
    record.spend[0]!.attempt = 1;
    record.canResolve = false;
    expect(choices().canRetainReservation).toBe(false);
  });
  it('requests a receipt and resumes an uncertain response from saved status without a second lookup', async () => {
    const fixture = setup();
    fixture.state.loseLookupResponse = true;
    render(<FinanceStandardizationReconciliation {...fixture.props} />);
    await open();
    fireEvent.click(
      screen.getByRole('button', { name: 'Request provider receipt' }),
    );
    await screen.findByText(/The last action needs a status check/u);
    expect(fixture.writes[0]!.body).toEqual({
      expectedRevision: 1,
      reservationId,
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh outcome evidence' }),
    );
    await screen.findByText('Receipt requested');
    expect(
      screen.queryByRole('button', { name: 'Request provider receipt' }),
    ).not.toBeInTheDocument();
    expect(fixture.writes).toHaveLength(1);
  });
  it('lets an administrator explicitly request new evidence after an unavailable receipt without clearing its history or resolving cost', async () => {
    const fixture = setup();
    fixture.addReceipt('unavailable');
    render(<FinanceStandardizationReconciliation {...fixture.props} />);
    await open();
    fireEvent.click(
      screen.getByRole('button', { name: 'Request another receipt lookup' }),
    );
    await screen.findByText('Receipt requested');
    expect(screen.getByText('Receipt unavailable')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Request another receipt lookup' }),
    ).not.toBeInTheDocument();
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.record.spend[0]!.actualCadMinor).toBeNull();
    expect(fixture.record.status).toBe('indeterminate');
    fixture.record.receipts = Array.from({ length: 30 }, (_, index) => ({
      ...fixture.record.receipts[0]!,
      id: `74000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
    }));
    expect(
      reconciliationChoices(fixture.record, reservationId, '')
        .canRequestReceipt,
    ).toBe(false);
  });
  it('requires review of an exact verified receipt and sends its current revision without any amount override', async () => {
    const fixture = setup();
    fixture.addReceipt('verified');
    render(<FinanceStandardizationReconciliation {...fixture.props} />);
    await open();
    fireEvent.click(
      screen.getByRole('radio', {
        name: 'Use this verified receipt for the cost review',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Review recorded cost' }),
    );
    const confirmation = screen.getByRole('region', {
      name: 'Confirm analysis outcome resolution',
    });
    expect(confirmation).toHaveTextContent('CAD 0.04');
    expect(
      within(confirmation).queryByRole('spinbutton'),
    ).not.toBeInTheDocument();
    expect(
      within(confirmation).getByRole('button', {
        name: 'Save outcome resolution',
      }),
    ).toBeDisabled();
    fireEvent.click(within(confirmation).getByRole('checkbox'));
    fireEvent.click(
      within(confirmation).getByRole('button', {
        name: 'Save outcome resolution',
      }),
    );
    await screen.findByText(/Outcome resolution saved/u);
    expect(fixture.writes[0]!.body).toEqual({
      expectedRevision: 1,
      reservationId,
      decision: 'accept-actual-cost',
      receiptId,
      acknowledgeNoApproval: true,
    });
    expect(fixture.record.status).toBe('blocked');
    expect(fixture.props.onUpdated).toHaveBeenCalledOnce();
    expect(fixture.writes).toHaveLength(1);
  });
  it('permits not-sent only for positive dispatch evidence, never unknown or an earlier attempt', () => {
    const fixture = setup(),
      record = fixture.record;
    record.spend[0]!.dispatchPhase = 'unknown';
    expect(
      reconciliationChoices(record, reservationId, '').canConfirmNotSent,
    ).toBe(false);
    record.spend[0]!.dispatchPhase = 'not-dispatched';
    expect(
      reconciliationChoices(record, reservationId, '').canConfirmNotSent,
    ).toBe(true);
    record.spend.push({
      ...record.spend[0]!,
      id: '74000000-0000-4000-8000-000000000099',
      attempt: 2,
      dispatchPhase: 'unknown',
    });
    expect(
      reconciliationChoices(record, reservationId, '').canConfirmNotSent,
    ).toBe(false);
    expect(
      reconciliationChoices(record, record.spend[1]!.id, '').canConfirmNotSent,
    ).toBe(false);
    record.spend = [];
    expect(reconciliationChoices(record, '', '').canConfirmNotSent).toBe(true);
    record.hasLiveLease = true;
    expect(reconciliationChoices(record, '', '').canConfirmNotSent).toBe(false);
  });
  it('restricts cost details to administrators and clears them after a current permission denial', async () => {
    const fixture = setup();
    const view = render(
      <FinanceStandardizationReconciliation {...fixture.props} role="viewer" />,
    );
    expect(fixture.fetcher).not.toHaveBeenCalled();
    expect(
      screen.getByText(/An administrator can review/u),
    ).toBeInTheDocument();
    view.rerender(<FinanceStandardizationReconciliation {...fixture.props} />);
    await open();
    fixture.state.readStatus = 403;
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh outcome evidence' }),
    );
    await screen.findByRole('alert');
    expect(
      screen.queryByText('Choose the saved attempt to review'),
    ).not.toBeInTheDocument();
  });
  it('rejects scope mismatches and preserves the exact CAD minor-unit amount at the safe integer boundary', () => {
    const fixture = setup();
    expect(() =>
      verifyReconciliation(
        { ...fixture.record, sourceDigest: 'a'.repeat(64) },
        fixture.props.run,
      ),
    ).toThrow('could not be verified');
    expect(cadMinorText(Number.MAX_SAFE_INTEGER)).toBe('CAD 90071992547409.91');
    expect(cadMinorText(null)).toBe('Not established');
  });
  it('aborts pending private reads when the authenticated session changes', async () => {
    const fixture = setup();
    let signal: AbortSignal | undefined, finish!: (response: Response) => void;
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
      <FinanceStandardizationReconciliation {...fixture.props} />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Review outcome evidence' }),
    );
    auth.state = 'unauthenticated';
    view.rerender(<FinanceStandardizationReconciliation {...fixture.props} />);
    expect(signal?.aborted).toBe(true);
    finish(new Response(JSON.stringify(fixture.record)));
    await waitFor(() =>
      expect(
        screen.queryByText('Choose the saved attempt to review'),
      ).not.toBeInTheDocument(),
    );
  });
});
