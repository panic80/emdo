import { z } from 'zod';
import {
  UuidSchema,
  FinanceMoneySchema,
  PrepareFinanceAutomationJournalDraftResultSchema,
  FinanceAutomationJournalDraftResultSchema,
  ReviewFinanceAutomationJournalDraftSchema,
  DiscardFinanceAutomationJournalDraftSchema,
  PostFinanceAutomationJournalDraftSchema,
  FinanceAutomationRunRecordSchema,
  type FinanceAutomationGrant,
  type PrepareFinanceAutomationJournalDraftResult,
} from '@emdo/contracts/browser';
export class JournalDraftError extends Error {
  constructor(readonly status: number) {
    super(
      [401, 403].includes(status)
        ? 'Current book access no longer permits journal draft review.'
        : status === 409
          ? 'The source or draft changed. Refresh and review the current saved facts.'
          : 'The request could not be confirmed. Retry the same request.',
    );
  }
}
export function journalDraftApi(bookId: string, signal: AbortSignal) {
  UuidSchema.parse(bookId);
  const base = '/automations/journal-drafts';
  async function request(
    path: string,
    mutation?: { body: unknown; csrf: string; key: string },
  ) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (mutation && !mutation.csrf)
      throw new Error('A current authenticated session is required.');
    const response = await fetch(`/api/v2/finance/books/${bookId}${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      ...(mutation
        ? {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-csrf-token': mutation.csrf,
              'idempotency-key': mutation.key,
            },
            body: JSON.stringify(mutation.body),
          }
        : {}),
    });
    if (!response.ok) throw new JournalDraftError(response.status);
    const raw: unknown = await response.json();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return raw;
  }
  function result(raw: unknown, id?: string) {
    const value = FinanceAutomationJournalDraftResultSchema.parse(raw);
    if (value.bookId !== bookId || (id && value.id !== id))
      throw new Error('Saved draft scope does not match this book or result.');
    return value;
  }
  function run(raw: unknown, id?: string) {
    const value = FinanceAutomationRunRecordSchema.parse(raw);
    if (
      value.run.request.bookId !== bookId ||
      value.run.request.capability !== 'finance.journals.draft' ||
      !value.run.request.journal ||
      (id && value.run.request.operationId !== id)
    )
      throw new Error('Saved run does not match this journal draft scope.');
    return value;
  }
  return {
    async sources() {
      return z
        .object({
          imports: z.array(
            z.object({
              id: UuidSchema,
              filename: z.string(),
              status: z.string(),
              revision: z.number().int(),
            }),
          ),
        })
        .parse(await request('/imports'));
    },
    async accounts() {
      return z
        .object({
          trialBalance: z.array(
            z.object({ id: UuidSchema, name: z.string(), code: z.string() }),
          ),
        })
        .parse(await request(''));
    },
    async list(offset = 0) {
      const value = z
        .object({
          items: z.array(FinanceAutomationJournalDraftResultSchema).max(100),
          offset: z.number().int(),
          limit: z.number().int(),
          total: z.number().int(),
        })
        .parse(await request(`${base}?offset=${offset}&limit=50`));
      if (
        value.offset !== offset ||
        value.limit !== 50 ||
        value.items.length > 50 ||
        new Set(value.items.map((item) => item.id)).size !== value.items.length
      )
        throw new Error('Saved draft page mismatch.');
      value.items.forEach((item) => result(item));
      return value;
    },
    async read(id: string) {
      UuidSchema.parse(id);
      return result(await request(`${base}/${id}`), id);
    },
    async prepare(batchId: string, csrf: string, key: string) {
      UuidSchema.parse(batchId);
      const value = PrepareFinanceAutomationJournalDraftResultSchema.parse(
        await request(`${base}/prepare`, { body: { batchId }, csrf, key }),
      );
      FinanceMoneySchema.parse({
        currency: value.currency,
        amount: value.amount,
      });
      if (value.journal.batchId !== batchId)
        throw new Error('Prepared draft refers to another import.');
      return value;
    },
    async enqueue(
      prepared: PrepareFinanceAutomationJournalDraftResult,
      grant: FinanceAutomationGrant,
      csrf: string,
      key: string,
    ) {
      const p =
        PrepareFinanceAutomationJournalDraftResultSchema.parse(prepared);
      if (
        grant.bookId !== bookId ||
        grant.status !== 'active' ||
        !grant.allowedCapabilities.includes('finance.journals.draft') ||
        Date.parse(grant.validFrom) > Date.now() ||
        Date.parse(grant.expiresAt) <= Date.now() ||
        grant.limits.currency !== p.currency
      )
        throw new Error(
          'Select a current journal draft grant for this currency.',
        );
      const value = run(
        await request('/automations/runs', {
          body: {
            grantId: grant.id,
            capability: 'finance.journals.draft',
            targets: [p.journal.batchId],
            currency: p.currency,
            amount: p.amount,
            journal: p.journal,
          },
          csrf,
          key,
        }),
      );
      const saved = value.run.request;
      if (
        saved.grantId !== grant.id ||
        saved.grantRevision !== grant.revision ||
        saved.itemCount !== p.itemCount ||
        saved.currency !== p.currency ||
        saved.amount !== p.amount ||
        JSON.stringify(saved.journal) !== JSON.stringify(p.journal)
      )
        throw new Error(
          'Queued draft does not match the authoritative prepared scope.',
        );
      return value;
    },
    async run(id: string) {
      UuidSchema.parse(id);
      return run(await request(`/automations/runs/${id}`), id);
    },
    async outcome(saved: z.infer<typeof FinanceAutomationRunRecordSchema>) {
      const bound = run(saved);
      if (bound.run.status !== 'completed' || !bound.run.outcomeReference)
        throw new Error('This run has no confirmed saved draft result.');
      const value = result(
        await request(
          `${base}/${UuidSchema.parse(bound.run.outcomeReference)}`,
        ),
        bound.run.outcomeReference,
      );
      const input = bound.run.request,
        journal = input.journal!;
      if (
        value.operationId !== input.operationId ||
        value.workspaceId !== input.workspaceId ||
        value.source.batchId !== journal.batchId ||
        value.source.batchRevision !== journal.expectedBatchRevision ||
        value.source.snapshotHash !== journal.expectedSnapshotHash ||
        value.itemCount !== input.itemCount ||
        value.currency !== input.currency ||
        value.amount !== input.amount
      )
        throw new Error(
          'Saved draft does not match the queued source snapshot.',
        );
      return value;
    },
    async update(
      id: string,
      operation: 'review' | 'discard' | 'post',
      input: unknown,
      csrf: string,
      key: string,
    ) {
      UuidSchema.parse(id);
      const body = (
        operation === 'review'
          ? ReviewFinanceAutomationJournalDraftSchema
          : operation === 'discard'
            ? DiscardFinanceAutomationJournalDraftSchema
            : PostFinanceAutomationJournalDraftSchema
      ).parse(input);
      return result(
        await request(`${base}/${id}/${operation}`, { body, csrf, key }),
        id,
      );
    },
  };
}
export type JournalDraftApi = ReturnType<typeof journalDraftApi>;
