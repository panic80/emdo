import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinanceTaxWorkspace } from './finance-tax-workspace.js';
import { taxFixture } from '../../../test/finance-tax-fixture.js';
const entityId = '70000000-0000-4000-8000-000000000099';
vi.mock('../auth/auth-context.js', () => ({
  useAuth: () => ({
    state: 'authenticated',
    sessionBinding: 'entity-test',
    csrfToken: 'csrf-entity',
  }),
}));
afterEach(() => vi.unstubAllGlobals());
function setup(role: 'owner' | 'preparer' = 'owner', bound = false) {
  const fixture = taxFixture();
  fixture.detail.caseRole = role;
  fixture.detail.questionnaire.intake.scope.taxpayerType = 'corporation';
  fixture.detail.questionnaire.binding.scope.taxpayerType = 'corporation';
  fixture.detail.questionnaire.intake.legalEntityId = bound ? entityId : null;
  const state = { lose: false, status: 200, bookStatus: 200 };
  const writes: { body: unknown; key: string | null }[] = [];
  let receipt: unknown;
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const response = (json: unknown, status = 200) =>
      new Response(JSON.stringify(json), { status });
    if (path.endsWith('/legal-entity') && init?.method === 'POST') {
      writes.push({
        body: JSON.parse(String(init.body)),
        key: new Headers(init.headers).get('idempotency-key'),
      });
      expect(new Headers(init.headers).get('x-csrf-token')).toBe('csrf-entity');
      if (state.status !== 200) return response({}, state.status);
      if (!receipt) {
        fixture.detail.questionnaire.intake.legalEntityId = entityId;
        fixture.advance();
        receipt = fixture.receipt();
      }
      if (state.lose) {
        state.lose = false;
        throw new TypeError('Lost acknowledgement');
      }
      return response(receipt);
    }
    if (state.status === 403) return response({}, 403);
    if (path.includes('/tax/cases?'))
      return response({ cases: [fixture.summary()] });
    if (path.endsWith('/books') && state.bookStatus !== 200)
      return response({}, state.bookStatus);
    if (path.endsWith('/books'))
      return response({
        books: fixture.books.map((book) => ({
          ...book,
          name: 'Mexico corporation book',
          entityName: 'Synthetic corporation',
          legalEntityId: entityId,
        })),
      });
    if (path.endsWith('/assessment')) return response(fixture.assessment());
    if (path.endsWith('/declarations')) return response(fixture.declarations);
    return response(fixture.detail);
  });
  render(<FinanceTaxWorkspace />);
  return { ...fixture, state, writes };
}
async function open() {
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Open tax case 2025 · Personal income tax',
    }),
  );
  await screen.findByRole('heading', { name: 'Case setup' });
}
async function review() {
  const select = await screen.findByRole('combobox', {
    name: /Corporate legal entity/,
  });
  await screen.findByRole('option', {
    name: 'Synthetic corporation · Mexico corporation book',
  });
  expect(select).toHaveValue('');
  fireEvent.change(select, {
    target: { value: '70000000-0000-4000-8000-000000000003' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Review entity attachment' }),
  );
}
describe('existing corporate case entity attachment', () => {
  it('preserves the same case and declarations, retries a lost acknowledgement exactly, then hides attachment', async () => {
    const fixture = setup();
    const original = JSON.stringify(fixture.declarations);
    fixture.state.lose = true;
    await open();
    await review();
    expect(fixture.writes).toHaveLength(0);
    fireEvent.click(
      screen.getByRole('button', { name: 'Attach reviewed entity' }),
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Retry exact entity attachment',
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Attach corporate legal entity' }),
      ).not.toBeInTheDocument(),
    );
    expect(fixture.writes).toHaveLength(2);
    expect(fixture.writes[1]).toEqual(fixture.writes[0]);
    expect(fixture.writes[0]!.body).toEqual({
      expectedCaseRevision: 2,
      legalEntityId: entityId,
    });
    expect(fixture.detail.currentRevision).toBe(3);
    expect(JSON.stringify(fixture.declarations)).toBe(original);
    expect(fixture.detail.questionnaire.intake.sourceBooks).toEqual([]);
  });
  it.each([
    ['preparer', false],
    ['owner', true],
  ] as const)('offers no binding to %s when bound=%s', async (role, bound) => {
    setup(role, bound);
    await open();
    expect(
      screen.queryByRole('region', { name: 'Attach corporate legal entity' }),
    ).not.toBeInTheDocument();
  });
  it('requires refresh after stale revision and prevents a different attachment', async () => {
    const fixture = setup();
    await open();
    await review();
    fixture.state.status = 409;
    fireEvent.click(
      screen.getByRole('button', { name: 'Attach reviewed entity' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Retry exact entity attachment' }),
      ).toBeDisabled(),
    );
    expect(
      screen.getByRole('button', { name: 'Change entity choice' }),
    ).toBeDisabled();
  });
  it('clears the view when the entity catalog denies access without a reload loop', async () => {
    const fixture = setup();
    fixture.state.bookStatus = 403;
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Open tax case 2025 · Personal income tax',
      }),
    );
    await screen.findByText(
      'Current entity choices could not be authorized. Refresh this case before continuing.',
    );
    expect(
      screen.queryByRole('region', { name: 'Attach corporate legal entity' }),
    ).not.toBeInTheDocument();
  });
  it('clears private choices when current access is revoked', async () => {
    const fixture = setup();
    await open();
    await review();
    fixture.state.status = 403;
    fireEvent.click(
      screen.getByRole('button', { name: 'Attach reviewed entity' }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText('Synthetic corporation · Mexico corporation book'),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('region', { name: 'Attach corporate legal entity' }),
    ).not.toBeInTheDocument();
  });
});
