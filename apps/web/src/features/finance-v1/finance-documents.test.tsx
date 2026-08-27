import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  FinanceDocumentApi,
  FinanceDocumentReviewDraft,
  FinanceDocumentSummary,
} from './finance-document-api.js';
import { FinanceDocuments } from './finance-documents.js';

const summary: FinanceDocumentSummary = {
  schemaVersion: 1 as const,
  id: 'document-a',
  displayName: 'Receipt.pdf',
  mimeType: 'application/pdf' as const,
  byteSize: 1024,
  state: 'awaiting-review' as const,
  documentType: 'receipt' as const,
  plaintextSha256: 'a'.repeat(64),
  sourceLocale: 'en-CA' as const,
  currency: 'USD',
  extractionRevision: 1,
  createdAt: '2026-08-26T12:00:00.000Z',
  updatedAt: '2026-08-26T12:00:00.000Z',
};

function createApi(
  overrides: Partial<FinanceDocumentApi> = {},
): FinanceDocumentApi {
  const detail = {
    schemaVersion: 1 as const,
    document: summary,
    reviewAvailable: true,
    matchCount: 0,
  };
  return {
    list: vi.fn(async () => ({ schemaVersion: 1 as const, items: [] })),
    upload: vi.fn(async () => summary),
    readDetail: vi.fn(async () => detail),
    originalUrl: vi.fn(() => '/original'),
    readReview: async () => Promise.reject(new Error('not used')),
    updateReview: async () => Promise.reject(new Error('not used')),
    readMatches: vi.fn(async () => ({ schemaVersion: 1 as const, items: [] })),
    readEvidence: vi.fn(async () => ({ schemaVersion: 1 as const, items: [] })),
    retry: vi.fn(async () => detail),
    ...overrides,
  };
}

function reviewDraft(
  envelope: Record<string, unknown>,
): FinanceDocumentReviewDraft {
  return {
    schemaVersion: 1,
    documentId: summary.id,
    extractionRevision: 1,
    envelope: {
      schemaVersion: 1,
      documentType: 'receipt',
      sourceLocale: 'en-CA',
      currency: 'CAD',
      total: null,
      ...envelope,
    },
    payloadHash: 'b'.repeat(64),
    reviewToken: 'B'.repeat(43),
    expiresAt: '2026-08-27T12:00:00.000Z',
  };
}

describe('FinanceDocuments', () => {
  it('limits uploads to twenty with at most three concurrent requests and never uses browser persistence', async () => {
    const pending: (() => void)[] = [];
    let running = 0;
    let maximumRunning = 0;
    let uploaded = 0;
    const api = createApi({
      upload: vi.fn(async () => {
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);
        await new Promise<void>((resolve) => pending.push(resolve));
        running -= 1;
        uploaded += 1;
        return { ...summary, id: `document-${uploaded}` };
      }),
    });
    const storageGet = vi.spyOn(Storage.prototype, 'getItem');
    const storageSet = vi.spyOn(Storage.prototype, 'setItem');
    const indexedDbOpen = vi.fn();
    const cacheOpen = vi.fn();
    vi.stubGlobal('indexedDB', { open: indexedDbOpen });
    vi.stubGlobal('caches', { open: cacheOpen });
    const user = userEvent.setup();
    render(
      <FinanceDocuments
        api={api}
        locale="en-CA"
        online
        csrfToken="csrf-current"
        onRequestDeletion={vi.fn(() => true)}
        onRequestCommit={vi.fn(() => true)}
        onRequestMatchDecision={vi.fn(() => true)}
      />,
    );
    await screen.findByText('No documents have been added yet.');

    const files = Array.from(
      { length: 21 },
      (_, index) =>
        new File(['private-document-content'], `document-${index}.pdf`, {
          type: 'application/pdf',
        }),
    );
    await user.upload(screen.getByLabelText('Add documents'), files);
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(3));
    for (let batch = 0; batch < 7; batch += 1) {
      pending.splice(0).forEach((resolve) => resolve());
      await waitFor(() =>
        expect(api.upload).toHaveBeenCalledTimes(Math.min(20, (batch + 2) * 3)),
      );
    }
    while (pending.length > 0) pending.shift()?.();
    await waitFor(() =>
      expect(screen.getAllByText('Receipt.pdf').length).toBe(20),
    );

    expect(maximumRunning).toBeLessThanOrEqual(3);
    expect(storageGet).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
    expect(indexedDbOpen).not.toHaveBeenCalled();
    expect(cacheOpen).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('private-document-content');
    vi.unstubAllGlobals();
  });

  it('discloses localized data controls and excludes non-CAD documents from CAD totals', async () => {
    const api = createApi({
      list: vi.fn(async () => ({
        schemaVersion: 1 as const,
        items: [summary],
      })),
    });
    render(
      <FinanceDocuments
        api={api}
        locale="fr-CA"
        online
        csrfToken="csrf-current"
        onRequestDeletion={vi.fn(() => true)}
        onRequestCommit={vi.fn(() => true)}
        onRequestMatchDecision={vi.fn(() => true)}
      />,
    );
    expect(await screen.findByText('Receipt.pdf')).toBeVisible();
    expect(
      screen.getByText(/Les éléments dans une devise autre que le CAD/u),
    ).toBeVisible();
    expect(screen.getByText(/OpenAI n’utilise pas vos données/u)).toBeVisible();
    expect(
      screen.getByRole('link', { name: /OpenAI n’utilise pas vos données/u }),
    ).toHaveAttribute(
      'href',
      'https://developers.openai.com/api/docs/guides/your-data',
    );
    expect(
      screen.getByRole('link', { name: /OpenAI n’utilise pas vos données/u }),
    ).toHaveAttribute('rel', 'noopener noreferrer');
    expect(
      screen.getByRole('link', { name: 'Télécharger l’original' }),
    ).toHaveAttribute('download');
  });

  it('loads a bounded second document page and de-duplicates an overlapping item', async () => {
    const first = { ...summary, displayName: 'First.pdf' };
    const second = { ...summary, id: 'document-b', displayName: 'Second.pdf' };
    const list = vi.fn(async (options?: { readonly cursor?: string }) =>
      options?.cursor
        ? {
            schemaVersion: 1 as const,
            items: [{ ...first, displayName: 'First updated.pdf' }, second],
          }
        : {
            schemaVersion: 1 as const,
            items: [first],
            nextCursor: 'after-first',
          },
    );
    const api = createApi({ list });
    const user = userEvent.setup();
    render(
      <FinanceDocuments
        api={api}
        locale="en-CA"
        online
        csrfToken="csrf-current"
        onRequestDeletion={vi.fn(() => true)}
        onRequestCommit={vi.fn(() => true)}
        onRequestMatchDecision={vi.fn(() => true)}
      />,
    );

    expect(await screen.findByText('First.pdf')).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Load more documents' }),
    );
    expect(await screen.findByText('Second.pdf')).toBeVisible();
    expect(screen.getAllByText('First updated.pdf')).toHaveLength(1);
    expect(list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ limit: 50 }),
    );
    expect(list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: 'after-first', limit: 50 }),
    );
  });

  it('fails closed when a document cursor repeats instead of looping forever', async () => {
    const list = vi.fn(async (options?: { readonly cursor?: string }) => ({
      schemaVersion: 1 as const,
      items: options?.cursor ? [] : [summary],
      nextCursor: 'repeated-cursor',
    }));
    const api = createApi({ list });
    const user = userEvent.setup();
    render(
      <FinanceDocuments
        api={api}
        locale="en-CA"
        online
        csrfToken="csrf-current"
        onRequestDeletion={vi.fn(() => true)}
        onRequestCommit={vi.fn(() => true)}
        onRequestMatchDecision={vi.fn(() => true)}
      />,
    );

    await user.click(
      await screen.findByRole('button', { name: 'Load more documents' }),
    );

    expect(
      await screen.findByText(
        'Documents are unavailable. Try again while online.',
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Load more documents' }),
    ).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('renders every review collection in pages and saves all items after editing page two', async () => {
    const lineItems = Array.from({ length: 101 }, (_value, index) => ({
      description: `Item ${index + 1}`,
      quantity: 1,
      amount: null,
    }));
    const draft = reviewDraft({
      facts: [
        {
          field: 'total',
          confidence: 1,
          evidence: [
            {
              page: 1,
              excerpt: 'Total',
              characterStart: null,
              characterEnd: null,
            },
          ],
        },
      ],
      lineItems,
      transactions: [
        {
          postedOn: '2026-08-26',
          description: 'Transaction',
          amount: { currency: 'CAD', minorUnits: -1200 },
          reference: null,
        },
      ],
      boxes: [{ label: '14', value: '1200' }],
      holdings: [
        {
          symbol: 'EMDO',
          description: 'Holding',
          quantity: 1,
          marketValue: { currency: 'CAD', minorUnits: 1200 },
        },
      ],
      proposedRecord: {
        kind: 'expense',
        amount: { currency: 'CAD', minorUnits: 1200 },
        occurredOn: '2026-08-26',
        description: 'Receipt',
      },
    });
    const updateReview = vi.fn<FinanceDocumentApi['updateReview']>(
      async (input) => ({ ...draft, envelope: input.envelope }),
    );
    const api = createApi({
      list: vi.fn(async () => ({
        schemaVersion: 1 as const,
        items: [summary],
      })),
      readReview: vi.fn(async () => draft),
      updateReview,
    });
    const user = userEvent.setup();
    render(
      <FinanceDocuments
        api={api}
        locale="en-CA"
        online
        csrfToken="csrf-current"
        onRequestDeletion={vi.fn(() => true)}
        onRequestCommit={vi.fn(() => true)}
        onRequestMatchDecision={vi.fn(() => true)}
      />,
    );

    await user.click(
      await screen.findByRole('button', { name: 'Review extraction' }),
    );
    for (const label of [
      'Extracted facts',
      'Line items',
      'Transactions',
      'Tax slip boxes',
      'Holdings',
    ]) {
      expect(screen.getByRole('group', { name: label })).toBeVisible();
    }
    expect(
      screen.getByRole('textbox', { name: 'Proposed record' }),
    ).toBeVisible();

    const lineItemEditor = screen.getByRole('group', { name: 'Line items' });
    expect(
      within(lineItemEditor).getByText('Items 1–100 of 101'),
    ).toBeVisible();
    await user.click(
      within(lineItemEditor).getByRole('button', { name: 'Next' }),
    );
    const pageTwoItem = within(lineItemEditor).getByLabelText('Item 101');
    fireEvent.change(pageTwoItem, {
      target: {
        value: JSON.stringify({
          description: 'Corrected item',
          quantity: 1,
          amount: null,
        }),
      },
    });
    await user.click(
      screen.getByRole('button', { name: 'Save reviewed changes' }),
    );

    await waitFor(() => expect(updateReview).toHaveBeenCalledOnce());
    const saved = updateReview.mock.calls[0]?.[0].envelope as Record<
      string,
      unknown
    >;
    const savedLineItems = saved.lineItems as readonly Record<
      string,
      unknown
    >[];
    expect(savedLineItems).toHaveLength(101);
    expect(savedLineItems[0]?.description).toBe('Item 1');
    expect(savedLineItems[100]?.description).toBe('Corrected item');
    expect(saved.facts).toEqual(draft.envelope.facts);
    expect(saved.transactions).toEqual(draft.envelope.transactions);
    expect(saved.boxes).toEqual(draft.envelope.boxes);
    expect(saved.holdings).toEqual(draft.envelope.holdings);
    expect(saved.proposedRecord).toEqual(draft.envelope.proposedRecord);
  });

  it('blocks saving an invalid proposed record until it is corrected', async () => {
    const draft = reviewDraft({
      proposedRecord: { kind: 'expense', description: 'Original record' },
    });
    const updateReview = vi.fn<FinanceDocumentApi['updateReview']>(
      async (input) => ({ ...draft, envelope: input.envelope }),
    );
    const onRequestCommit = vi.fn(() => true);
    const api = createApi({
      list: vi.fn(async () => ({
        schemaVersion: 1 as const,
        items: [summary],
      })),
      readReview: vi.fn(async () => draft),
      updateReview,
    });
    const user = userEvent.setup();
    render(
      <FinanceDocuments
        api={api}
        locale="en-CA"
        online
        csrfToken="csrf-current"
        onRequestDeletion={vi.fn(() => true)}
        onRequestCommit={onRequestCommit}
        onRequestMatchDecision={vi.fn(() => true)}
      />,
    );

    await user.click(
      await screen.findByRole('button', { name: 'Review extraction' }),
    );
    const proposedRecord = screen.getByRole('textbox', {
      name: 'Proposed record',
    });
    fireEvent.change(proposedRecord, { target: { value: '{not valid JSON' } });

    await waitFor(() =>
      expect(
        screen.getByRole('textbox', { name: 'Proposed record' }),
      ).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(
      screen.getByText('Enter valid JSON before saving this review.'),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Save reviewed changes' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Commit reviewed document' }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole('button', { name: 'Save reviewed changes' }),
    );
    expect(updateReview).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole('button', { name: 'Commit reviewed document' }),
    );
    expect(onRequestCommit).not.toHaveBeenCalled();

    fireEvent.change(proposedRecord, {
      target: {
        value: JSON.stringify({ kind: 'expense', description: 'Fixed' }),
      },
    });

    expect(
      screen.queryByText('Enter valid JSON before saving this review.'),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Save reviewed changes' }),
    ).not.toHaveAttribute('disabled');
    expect(
      screen.getByRole('button', { name: 'Commit reviewed document' }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole('button', { name: 'Save reviewed changes' }),
    );
    await waitFor(() => expect(updateReview).toHaveBeenCalledOnce());
    expect(updateReview.mock.calls[0]?.[0].envelope.proposedRecord).toEqual({
      kind: 'expense',
      description: 'Fixed',
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Commit reviewed document' }),
      ).not.toBeDisabled(),
    );
    await user.click(
      screen.getByRole('button', { name: 'Commit reviewed document' }),
    );
    expect(onRequestCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          proposedRecord: { kind: 'expense', description: 'Fixed' },
        }),
      }),
    );
  });

  it('blocks saving an invalid collection item without discarding other items', async () => {
    const draft = reviewDraft({
      lineItems: [
        { description: 'First item', quantity: 1, amount: null },
        { description: 'Second item', quantity: 2, amount: null },
      ],
    });
    const updateReview = vi.fn<FinanceDocumentApi['updateReview']>(
      async (input) => ({ ...draft, envelope: input.envelope }),
    );
    const onRequestCommit = vi.fn(() => true);
    const api = createApi({
      list: vi.fn(async () => ({
        schemaVersion: 1 as const,
        items: [summary],
      })),
      readReview: vi.fn(async () => draft),
      updateReview,
    });
    const user = userEvent.setup();
    render(
      <FinanceDocuments
        api={api}
        locale="en-CA"
        online
        csrfToken="csrf-current"
        onRequestDeletion={vi.fn(() => true)}
        onRequestCommit={onRequestCommit}
        onRequestMatchDecision={vi.fn(() => true)}
      />,
    );

    await user.click(
      await screen.findByRole('button', { name: 'Review extraction' }),
    );
    const lineItems = screen.getByRole('group', { name: 'Line items' });
    const firstItem = within(lineItems).getByLabelText('Item 1');
    fireEvent.change(firstItem, { target: { value: '{not valid JSON' } });

    await waitFor(() =>
      expect(
        within(
          screen.getByRole('group', { name: 'Line items' }),
        ).getByLabelText('Item 1'),
      ).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(
      within(lineItems).getByText(
        'Enter valid JSON before saving this review.',
      ),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Save reviewed changes' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Commit reviewed document' }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole('button', { name: 'Save reviewed changes' }),
    );
    expect(updateReview).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole('button', { name: 'Commit reviewed document' }),
    );
    expect(onRequestCommit).not.toHaveBeenCalled();
  });

  it('resets invalid JSON editor state and draft text when the review draft is reopened', async () => {
    const draft = reviewDraft({
      proposedRecord: { kind: 'expense', description: 'Original record' },
    });
    const api = createApi({
      list: vi.fn(async () => ({
        schemaVersion: 1 as const,
        items: [summary],
      })),
      readReview: vi.fn(async () => ({
        ...draft,
        envelope: { ...draft.envelope },
      })),
    });
    const onRequestCommit = vi.fn(() => true);
    const user = userEvent.setup();
    render(
      <FinanceDocuments
        api={api}
        locale="en-CA"
        online
        csrfToken="csrf-current"
        onRequestDeletion={vi.fn(() => true)}
        onRequestCommit={onRequestCommit}
        onRequestMatchDecision={vi.fn(() => true)}
      />,
    );

    const reviewButton = await screen.findByRole('button', {
      name: 'Review extraction',
    });
    await user.click(reviewButton);
    const proposedRecord = screen.getByRole('textbox', {
      name: 'Proposed record',
    });
    fireEvent.change(proposedRecord, { target: { value: '{not valid JSON' } });
    expect(
      screen.getByText('Enter valid JSON before saving this review.'),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Commit reviewed document' }),
    ).toBeDisabled();

    await user.click(reviewButton);
    await waitFor(() =>
      expect(
        screen.queryByText('Enter valid JSON before saving this review.'),
      ).toBeNull(),
    );
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Proposed record',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe(JSON.stringify(draft.envelope.proposedRecord));
    expect(
      screen.getByRole('button', { name: 'Save reviewed changes' }),
    ).not.toHaveAttribute('disabled');
    expect(
      screen.getByRole('button', { name: 'Commit reviewed document' }),
    ).not.toBeDisabled();
  });

  it('shows, edits, and preserves an invoice payment status in the review update', async () => {
    const draft = reviewDraft({
      documentType: 'invoice',
      vendor: 'EMDO Utilities',
      invoiceNumber: 'INV-2026-08',
      paymentStatus: 'unpaid',
      dueOn: '2026-09-15',
      subtotal: { currency: 'CAD', minorUnits: 10000 },
      tax: { currency: 'CAD', minorUnits: 1300 },
      total: { currency: 'CAD', minorUnits: 11300 },
      lineItems: [
        {
          description: 'Monthly service',
          quantity: 1,
          amount: { currency: 'CAD', minorUnits: 10000 },
        },
      ],
      facts: [],
      proposedRecord: {
        kind: 'bill',
        amount: { currency: 'CAD', minorUnits: 11300 },
        occurredOn: '2026-08-27',
        description: 'August invoice',
      },
    });
    const updateReview = vi.fn<FinanceDocumentApi['updateReview']>(
      async (input) => ({ ...draft, envelope: input.envelope }),
    );
    const api = createApi({
      list: vi.fn(async () => ({
        schemaVersion: 1 as const,
        items: [summary],
      })),
      readReview: vi.fn(async () => draft),
      updateReview,
    });
    const user = userEvent.setup();
    render(
      <FinanceDocuments
        api={api}
        locale="en-CA"
        online
        csrfToken="csrf-current"
        onRequestDeletion={vi.fn(() => true)}
        onRequestCommit={vi.fn(() => true)}
        onRequestMatchDecision={vi.fn(() => true)}
      />,
    );

    await user.click(
      await screen.findByRole('button', { name: 'Review extraction' }),
    );
    const paymentStatus = screen.getByLabelText(
      'Payment status',
    ) as HTMLSelectElement;
    expect(paymentStatus.value).toBe('unpaid');
    await user.selectOptions(paymentStatus, 'paid');
    await user.click(
      screen.getByRole('button', { name: 'Save reviewed changes' }),
    );

    await waitFor(() => expect(updateReview).toHaveBeenCalledOnce());
    const saved = updateReview.mock.calls[0]?.[0].envelope;
    expect(saved).toEqual({ ...draft.envelope, paymentStatus: 'paid' });
  });

  it('renders localized review field and collection labels outside English', async () => {
    const api = createApi({
      list: vi.fn(async () => ({
        schemaVersion: 1 as const,
        items: [summary],
      })),
      readReview: vi.fn(async () =>
        reviewDraft({ issuer: 'Émetteur de test', facts: [] }),
      ),
    });
    const user = userEvent.setup();
    render(
      <FinanceDocuments
        api={api}
        locale="fr-CA"
        online
        csrfToken="csrf-current"
        onRequestDeletion={vi.fn(() => true)}
        onRequestCommit={vi.fn(() => true)}
        onRequestMatchDecision={vi.fn(() => true)}
      />,
    );

    await user.click(
      await screen.findByRole('button', { name: 'Réviser l’extraction' }),
    );
    expect((screen.getByLabelText('Émetteur') as HTMLInputElement).value).toBe(
      'Émetteur de test',
    );
    expect(screen.getByRole('group', { name: 'Faits extraits' })).toBeVisible();
    expect(screen.queryByText('Issuer')).not.toBeInTheDocument();
  });
});
