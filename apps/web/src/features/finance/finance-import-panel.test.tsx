import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FinanceImportApi } from './finance-import-api.js';
import { FinanceImportPanel } from './finance-import-panel.js';
import { financeCopy } from '../finance-v1/finance-locales.js';

const rawStatement = 'DATE,DESC,AMOUNT\n2026-08-01,PRIVATE-COFFEE,-4.50';

function file(name: string, text = rawStatement, type = 'text/csv'): File {
  const statement = new File([text], name, { type });
  Object.defineProperty(statement, 'text', { value: async () => text });
  return statement;
}

function deferred<Value>() {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function deferredFile(
  name: string,
  pendingText: Promise<string>,
  type = 'text/csv',
): File {
  const statement = new File([], name, { type });
  Object.defineProperty(statement, 'text', { value: () => pendingText });
  Object.defineProperty(statement, 'size', { value: 1 });
  return statement;
}

function createApi(
  overrides: Partial<FinanceImportApi> = {},
): FinanceImportApi {
  return {
    listDestinations: vi.fn<FinanceImportApi['listDestinations']>(async () => ({
      schemaVersion: 1 as const,
      accounts: [
        { id: 'account-a', name: 'Daily account', accountKind: 'chequing' },
      ],
      categories: [{ id: 'category-a', name: 'Food', categoryKind: 'expense' }],
    })),
    preview: vi.fn<FinanceImportApi['preview']>(async () => ({
      schemaVersion: 1 as const,
      plan: {
        id: 'plan-a',
        sourceHash: 'a'.repeat(64),
        expiresAt: '2999-08-13T18:00:00.000Z',
        summary: { accepted: 2, rejected: 1, duplicates: 1 },
        rejectedRows: [{ sourceRow: 4, code: 'invalid-date' }],
        duplicateRows: [{ sourceRow: 3, reason: 'existing' }],
      },
    })),
    ...overrides,
  };
}

afterEach(cleanup);

describe('FinanceImportPanel', () => {
  it.each(['en-CA', 'fr-CA', 'ja-JP', 'ko-KR'] as const)(
    'uses the typed localized import catalog for %s',
    async (locale) => {
      const user = userEvent.setup();
      const copy = financeCopy[locale].importPanel;
      render(
        <FinanceImportPanel
          api={createApi()}
          copy={copy}
          online
          csrfToken="csrf-current"
          onCommitted={vi.fn()}
        />,
      );

      expect(screen.getByText(copy.description)).toBeVisible();
      await user.click(screen.getByRole('button', { name: copy.open }));
      expect(await screen.findByLabelText(copy.accountLabel)).toBeVisible();
      expect(screen.getByLabelText(copy.statementFileLabel)).toBeVisible();
      expect(screen.getByRole('button', { name: copy.preview })).toBeVisible();
      expect(screen.getByRole('button', { name: copy.cancel })).toBeVisible();
    },
  );

  it('fails closed while offline or without an in-memory CSRF proof', () => {
    const api = createApi();
    const { rerender } = render(
      <FinanceImportPanel
        api={api}
        online={false}
        csrfToken="csrf-current"
        onCommitted={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Statement import is available only while online.'),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Import statement' }),
    ).not.toBeInTheDocument();

    rerender(
      <FinanceImportPanel
        api={api}
        online
        csrfToken={undefined}
        onCommitted={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Statement import needs a current secure session.'),
    ).toBeVisible();
  });

  it('loads only server destinations and blocks an import with no account', async () => {
    const api = createApi({
      listDestinations: vi.fn<FinanceImportApi['listDestinations']>(
        async () => ({
          schemaVersion: 1 as const,
          accounts: [],
          categories: [],
        }),
      ),
    });
    const user = userEvent.setup();
    render(
      <FinanceImportPanel
        api={api}
        online
        csrfToken="csrf-current"
        onCommitted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Import statement' }));
    expect(
      await screen.findByText(
        'Add an active finance account before importing a statement.',
      ),
    ).toBeVisible();
    expect(api.listDestinations).toHaveBeenCalledOnce();
  });

  it('clears a conflicting debit or credit column before previewing a CSV', async () => {
    const api = createApi();
    const user = userEvent.setup();
    render(
      <FinanceImportPanel
        api={api}
        online
        csrfToken="csrf-current"
        onCommitted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Import statement' }));
    await user.selectOptions(
      await screen.findByLabelText('Import account'),
      'account-a',
    );
    await user.upload(
      screen.getByLabelText('Statement file'),
      file(
        'statement.csv',
        'Date,Payment Type,Total Price\n2026-08-01,Card,10.00',
      ),
    );
    await user.selectOptions(
      screen.getByLabelText('Posted date column'),
      'Date',
    );
    await user.selectOptions(
      screen.getByLabelText('Description column'),
      'Payment Type',
    );
    await user.selectOptions(
      screen.getByLabelText('Debit column'),
      'Total Price',
    );
    await user.selectOptions(
      screen.getByLabelText('Credit column'),
      'Total Price',
    );

    expect(
      (screen.getByLabelText('Debit column') as HTMLSelectElement).value,
    ).toBe('');
    expect(
      (screen.getByLabelText('Credit column') as HTMLSelectElement).value,
    ).toBe('Total Price');

    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    expect(
      screen.getByText(
        'Choose a date, description, and one signed amount or both debit and credit columns.',
      ),
    ).toBeVisible();
    expect(api.preview).not.toHaveBeenCalled();
  });

  it('keeps a CSV statement out of the DOM, previews bounded diagnostics, and commits after review', async () => {
    const api = createApi();
    const onRequestCommit = vi.fn(async () => true);
    const user = userEvent.setup();
    render(
      <FinanceImportPanel
        api={api}
        online
        csrfToken="csrf-current"
        onRequestCommit={onRequestCommit}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Import statement' }));
    await screen.findByLabelText('Import account');
    await user.selectOptions(
      screen.getByLabelText('Import account'),
      'account-a',
    );
    await user.upload(
      screen.getByLabelText('Statement file'),
      file('statement.csv'),
    );
    await user.selectOptions(
      screen.getByLabelText('Posted date column'),
      'DATE',
    );
    await user.selectOptions(
      screen.getByLabelText('Description column'),
      'DESC',
    );
    await user.selectOptions(
      screen.getByLabelText('Signed amount column'),
      'AMOUNT',
    );
    await user.click(screen.getByRole('button', { name: 'Preview import' }));

    await screen.findByRole('heading', { name: 'Review import' });
    expect(
      screen.getByText(
        (_, element) =>
          element?.textContent === '2 accepted · 1 rejected · 1 duplicates',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        (_, element) => element?.textContent === 'Row 4: invalid-date',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        (_, element) => element?.textContent === 'Row 3: existing',
      ),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain('PRIVATE-COFFEE');
    expect(api.preview).toHaveBeenCalledWith(
      expect.objectContaining({ sourceText: rawStatement, format: 'csv' }),
    );
    expect(
      screen.getByRole('button', { name: 'Commit 2 transactions' }),
    ).toBeDisabled();

    await user.click(
      screen.getByLabelText('I reviewed this import and want to commit it.'),
    );
    await user.click(
      screen.getByRole('button', { name: 'Commit 2 transactions' }),
    );
    await screen.findByText(/EMDO received the reviewed import request/u);
    expect(onRequestCommit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'plan-a' }),
    );
    expect(api).not.toHaveProperty('commit');
    expect(document.body.textContent).not.toContain('PRIVATE-COFFEE');
  });

  it('clears an uncommitted source on cancel and rejects unsupported files', async () => {
    const api = createApi();
    const user = userEvent.setup();
    render(
      <FinanceImportPanel
        api={api}
        online
        csrfToken="csrf-current"
        onCommitted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Import statement' }));
    await screen.findByLabelText('Statement file');
    await user.upload(
      screen.getByLabelText('Statement file'),
      file('statement.pdf'),
    );
    expect(
      screen.getByText('Choose a CSV or OFX statement file.'),
    ).toBeVisible();
    await user.upload(
      screen.getByLabelText('Statement file'),
      file('statement.csv'),
    );
    await user.click(screen.getByRole('button', { name: 'Cancel import' }));
    expect(
      screen.getByRole('button', { name: 'Import statement' }),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain('PRIVATE-COFFEE');
  });

  it('does not clear a reviewed statement or call a direct commit for a request', async () => {
    const api = createApi();
    const user = userEvent.setup();
    render(
      <FinanceImportPanel
        api={api}
        online
        csrfToken="csrf-current"
        onRequestCommit={vi.fn(async () => true)}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Import statement' }));
    await user.selectOptions(
      await screen.findByLabelText('Import account'),
      'account-a',
    );
    await user.upload(
      screen.getByLabelText('Statement file'),
      file('statement.ofx', '<OFX>', 'application/x-ofx'),
    );
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await user.click(
      await screen.findByLabelText(
        'I reviewed this import and want to commit it.',
      ),
    );
    await user.click(
      screen.getByRole('button', { name: 'Commit 2 transactions' }),
    );
    await screen.findByText(/EMDO received the reviewed import request/u);
    expect(api).not.toHaveProperty('commit');
    expect(screen.getByLabelText('Statement file')).toBeInTheDocument();
  });

  it('ignores a file read that resolves after cancel or replacement', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const user = userEvent.setup();
    render(
      <FinanceImportPanel
        api={createApi()}
        online
        csrfToken="csrf-current"
        onCommitted={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Import statement' }));
    await user.selectOptions(
      await screen.findByLabelText('Import account'),
      'account-a',
    );
    await user.upload(
      screen.getByLabelText('Statement file'),
      deferredFile('first.csv', first.promise),
    );
    await user.click(screen.getByRole('button', { name: 'Cancel import' }));
    first.resolve('DATE,DESC,AMOUNT\n2026-08-01,STALE,-1.00');
    await Promise.resolve();
    expect(screen.queryByText('CSV column mapping')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Import statement' }));
    await user.selectOptions(
      await screen.findByLabelText('Import account'),
      'account-a',
    );
    await user.upload(
      screen.getByLabelText('Statement file'),
      deferredFile('first.csv', first.promise),
    );
    await user.upload(
      screen.getByLabelText('Statement file'),
      deferredFile('second.csv', second.promise),
    );
    first.resolve('DATE,DESC,AMOUNT\n2026-08-01,STALE,-1.00');
    second.resolve('POSTED,MEMO,VALUE\n2026-08-01,CURRENT,-2.00');
    expect(
      (
        (await screen.findByLabelText(
          'Posted date column',
        )) as HTMLSelectElement
      ).value,
    ).toBe('POSTED');
  });

  it('ignores a preview that resolves after an account change or disconnect', async () => {
    const pendingPreview =
      deferred<Awaited<ReturnType<FinanceImportApi['preview']>>>();
    const api = createApi({ preview: vi.fn(() => pendingPreview.promise) });
    const user = userEvent.setup();
    render(
      <FinanceImportPanel
        api={api}
        online
        csrfToken="csrf-current"
        onCommitted={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Import statement' }));
    await user.selectOptions(
      await screen.findByLabelText('Import account'),
      'account-a',
    );
    await user.upload(
      screen.getByLabelText('Statement file'),
      file('statement.ofx', '<OFX>', 'application/x-ofx'),
    );
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await user.selectOptions(screen.getByLabelText('Import account'), '');
    pendingPreview.resolve(
      await createApi().preview({
        csrfToken: 'csrf-current',
        sourceText: '<OFX>',
        format: 'ofx',
        accountId: 'account-a',
        mapping: { defaultCategoryId: null },
      }),
    );
    await Promise.resolve();
    expect(
      screen.queryByRole('heading', { name: 'Review import' }),
    ).not.toBeInTheDocument();

    window.dispatchEvent(new Event('offline'));
    expect(
      await screen.findByText(
        'Statement import is available only while online.',
      ),
    ).toBeVisible();
  });

  it('does not let a stale EMDO request wipe a replacement statement', async () => {
    const pendingCommit = deferred<boolean>();
    const api = createApi();
    const user = userEvent.setup();
    render(
      <FinanceImportPanel
        api={api}
        online
        csrfToken="csrf-current"
        onRequestCommit={() => pendingCommit.promise}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Import statement' }));
    await user.selectOptions(
      await screen.findByLabelText('Import account'),
      'account-a',
    );
    await user.upload(
      screen.getByLabelText('Statement file'),
      file('first.ofx', '<OFX>first', 'application/x-ofx'),
    );
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await user.click(
      await screen.findByLabelText(
        'I reviewed this import and want to commit it.',
      ),
    );
    await user.click(
      screen.getByRole('button', { name: 'Commit 2 transactions' }),
    );
    await user.upload(
      screen.getByLabelText('Statement file'),
      file('second.ofx', '<OFX>second', 'application/x-ofx'),
    );
    pendingCommit.resolve(true);
    await Promise.resolve();
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await waitFor(() =>
      expect(api.preview).toHaveBeenLastCalledWith(
        expect.objectContaining({ sourceText: '<OFX>second' }),
      ),
    );
    expect(
      screen.queryByText('Imported 2 transactions.'),
    ).not.toBeInTheDocument();
  });

  it('invalidates a visible preview when mapping inputs change without wiping the source', async () => {
    const api = createApi();
    const user = userEvent.setup();
    render(
      <FinanceImportPanel
        api={api}
        online
        csrfToken="csrf-current"
        onCommitted={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Import statement' }));
    await user.selectOptions(
      await screen.findByLabelText('Import account'),
      'account-a',
    );
    await user.upload(
      screen.getByLabelText('Statement file'),
      file('statement.csv'),
    );
    await user.selectOptions(
      screen.getByLabelText('Description column'),
      'DESC',
    );
    await user.selectOptions(
      screen.getByLabelText('Signed amount column'),
      'AMOUNT',
    );
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByRole('heading', { name: 'Review import' });
    await user.click(
      screen.getByLabelText('I reviewed this import and want to commit it.'),
    );
    await user.selectOptions(
      screen.getByLabelText('Date format'),
      'mm/dd/yyyy',
    );
    expect(
      screen.queryByRole('heading', { name: 'Review import' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.preview).mock.calls[1]?.[0]).toMatchObject({
      sourceText: rawStatement,
      mapping: { dateFormat: 'mm/dd/yyyy' },
    });
  });

  it('ignores a late preview after category or CSV mapping changes', async () => {
    const pendingPreview =
      deferred<Awaited<ReturnType<FinanceImportApi['preview']>>>();
    const api = createApi({ preview: vi.fn(() => pendingPreview.promise) });
    const user = userEvent.setup();
    render(
      <FinanceImportPanel
        api={api}
        online
        csrfToken="csrf-current"
        onCommitted={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Import statement' }));
    await user.selectOptions(
      await screen.findByLabelText('Import account'),
      'account-a',
    );
    await user.upload(
      screen.getByLabelText('Statement file'),
      file('statement.csv'),
    );
    await user.selectOptions(
      screen.getByLabelText('Description column'),
      'DESC',
    );
    await user.selectOptions(
      screen.getByLabelText('Signed amount column'),
      'AMOUNT',
    );
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await user.selectOptions(
      screen.getByLabelText('Default category (optional)'),
      'category-a',
    );
    pendingPreview.resolve(
      await createApi().preview({
        csrfToken: 'csrf-current',
        sourceText: rawStatement,
        format: 'csv',
        accountId: 'account-a',
        mapping: {
          defaultCategoryId: null,
          dateFormat: 'yyyy-mm-dd',
          columns: { postedOn: 'DATE', description: 'DESC', amount: 'AMOUNT' },
        },
      }),
    );
    await Promise.resolve();
    expect(
      screen.queryByRole('heading', { name: 'Review import' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    await user.selectOptions(
      screen.getByLabelText('Description column'),
      'DATE',
    );
    await Promise.resolve();
    expect(
      screen.queryByRole('heading', { name: 'Review import' }),
    ).not.toBeInTheDocument();
    expect(vi.mocked(api.preview).mock.calls[1]?.[0]).toMatchObject({
      sourceText: rawStatement,
    });
  });
});
