import {
  readExtractionDocuments,
  prepareExtractionIntent,
  ExtractionAutomationError,
} from './finance-extraction-automation-api.js';
import {
  journalDraftApi,
  JournalDraftError,
} from './finance-journal-drafts-api.js';
import { z } from 'zod';
import {
  FinanceAutomationScheduleSchema,
  FinanceAutomationScheduleCursorSchema,
  FinanceAutomationScheduleDefinitionSchema,
} from '@emdo/contracts/browser';
export const ScheduleRecordSchema = z.strictObject({
  schedule: FinanceAutomationScheduleSchema,
  cursor: FinanceAutomationScheduleCursorSchema,
  nextDueAt: z.iso.datetime({ offset: true }).nullable(),
  blockedReason: z.string().max(500).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type ScheduleRecord = z.infer<typeof ScheduleRecordSchema>;
export const ScheduleDraftSchema = z
  .strictObject(FinanceAutomationScheduleDefinitionSchema.shape)
  .omit({ workspaceId: true, bookId: true });
export type ScheduleDraft = z.infer<typeof ScheduleDraftSchema>;
const base = (bookId: string) =>
  `/api/v2/finance/books/${bookId}/automations/schedules`;
export class ScheduleRequestError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 403
        ? 'Current administrator access and an eligible grant that you issued are required.'
        : status === 503
          ? 'Schedule management is unavailable in this environment.'
          : status === 409
            ? 'The schedule or its grant changed. Refresh before trying again.'
            : status === 400 || status === 422
              ? 'The schedule does not satisfy the grant or calendar requirements.'
              : 'The request could not be confirmed. Retry the same request or refresh to check its result.',
    );
  }
}
async function request(
  url: string,
  signal: AbortSignal,
  mutation?: { body: unknown; csrf: string; key: string },
) {
  const response = await fetch(url, {
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
  if (!response.ok) throw new ScheduleRequestError(response.status);
  return response.json() as Promise<unknown>;
}
function scoped(raw: unknown, bookId: string, id?: string) {
  const record = ScheduleRecordSchema.parse(raw);
  if (
    record.schedule.definition.bookId !== bookId ||
    record.cursor.scheduleId !== record.schedule.id ||
    record.cursor.definitionRevision !== record.schedule.definitionRevision ||
    (id && record.schedule.id !== id)
  )
    throw new Error('Unexpected schedule scope');
  return record;
}
export async function readSchedules(
  bookId: string,
  offset: number,
  signal: AbortSignal,
) {
  const [raw, options] = await Promise.all([
    request(`${base(bookId)}?offset=${offset}&limit=20`, signal),
    request(`${base(bookId)}/options`, signal),
  ]);
  const rows = z
    .union([
      z.array(z.unknown()),
      z.strictObject({ schedules: z.array(z.unknown()).max(20) }),
    ])
    .parse(raw);
  return {
    records: (Array.isArray(rows) ? rows : rows.schedules).map((row) =>
      scoped(row, bookId),
    ),
    ...z
      .strictObject({ tzdbVersion: z.string().min(1).max(40) })
      .parse(options),
  };
}
export async function createSchedule(
  bookId: string,
  draft: ScheduleDraft,
  csrf: string,
  key: string,
  signal: AbortSignal,
) {
  const result = scoped(
    await request(base(bookId), signal, {
      body: ScheduleDraftSchema.parse(draft),
      csrf,
      key,
    }),
    bookId,
  );
  const returnedDraft = Object.fromEntries(
    Object.entries(result.schedule.definition).filter(
      ([key]) => key !== 'workspaceId' && key !== 'bookId',
    ),
  );
  if (
    JSON.stringify(ScheduleDraftSchema.parse(returnedDraft)) !==
    JSON.stringify(ScheduleDraftSchema.parse(draft))
  )
    throw new Error('Unexpected schedule definition');
  return result;
}
export async function changeScheduleState(
  bookId: string,
  current: ScheduleRecord,
  status: 'active' | 'paused' | 'retired',
  csrf: string,
  key: string,
  signal: AbortSignal,
) {
  const result = scoped(
    await request(`${base(bookId)}/${current.schedule.id}/state`, signal, {
      body: { expectedStateRevision: current.schedule.stateRevision, status },
      csrf,
      key,
    }),
    bookId,
    current.schedule.id,
  );
  if (
    result.schedule.status !== status ||
    result.schedule.stateRevision !== current.schedule.stateRevision + 1 ||
    result.schedule.definition.workspaceId !==
      current.schedule.definition.workspaceId
  )
    throw new Error('Unexpected schedule revision');
  return result;
}

export type ScheduleSourceOption = {
  id: string;
  label: string;
  kind: 'extraction' | 'journal';
  sourceDigest?: string;
  format?: string;
  revision?: number;
};
export type PreparedScheduleSource =
  | {
      kind: 'extraction';
      label: string;
      extraction: import('@emdo/contracts/browser').FinanceAutomationExtractionIntent;
      money: { currency: string; amount: '0' };
      itemCount: 1;
    }
  | {
      kind: 'journal';
      label: string;
      journal: import('@emdo/contracts/browser').FinanceAutomationJournalDraftIntent;
      money: { currency: string; amount: string };
      itemCount: number;
    };
export async function readScheduleSources(
  bookId: string,
  kind: 'extraction' | 'journal',
  offset: number,
  signal: AbortSignal,
): Promise<{ options: ScheduleSourceOption[]; nextOffset: number | null }> {
  try {
    if (kind === 'extraction') {
      const result = await readExtractionDocuments(bookId, offset, signal);
      return {
        options: result.documents.map((document) => ({
          id: document.id,
          label: document.filename,
          kind,
          format: document.format,
          ...(document.sourceDigest
            ? { sourceDigest: document.sourceDigest }
            : {}),
        })),
        nextOffset: result.nextOffset,
      };
    }
    const result = await journalDraftApi(bookId, signal).sources();
    return {
      options: result.imports
        .filter((batch) => batch.status === 'review')
        .map((batch) => ({
          id: batch.id,
          label: batch.filename,
          kind,
          revision: batch.revision,
        })),
      nextOffset: null,
    };
  } catch (cause) {
    if (
      cause instanceof ExtractionAutomationError ||
      cause instanceof JournalDraftError
    )
      throw new ScheduleRequestError(cause.status);
    throw cause;
  }
}
export async function prepareScheduleSource(
  bookId: string,
  source: ScheduleSourceOption,
  currency: string,
  csrf: string,
  key: string,
  signal: AbortSignal,
): Promise<PreparedScheduleSource> {
  try {
    if (source.kind === 'extraction') {
      const extraction = await prepareExtractionIntent(
        bookId,
        {
          id: source.id,
          filename: source.label,
          format: source.format ?? '',
          ...(source.sourceDigest ? { sourceDigest: source.sourceDigest } : {}),
        },
        csrf,
        key,
        signal,
      );
      return {
        kind: 'extraction',
        label: source.label,
        extraction,
        money: { currency, amount: '0' },
        itemCount: 1,
      };
    }
    const prepared = await journalDraftApi(bookId, signal).prepare(
      source.id,
      csrf,
      key,
    );
    return {
      kind: 'journal',
      label: source.label,
      journal: prepared.journal,
      money: { currency: prepared.currency, amount: prepared.amount },
      itemCount: prepared.itemCount,
    };
  } catch (cause) {
    if (
      cause instanceof ExtractionAutomationError ||
      cause instanceof JournalDraftError
    )
      throw new ScheduleRequestError(cause.status);
    throw cause;
  }
}
