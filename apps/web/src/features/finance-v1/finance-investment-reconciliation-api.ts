import { z } from 'zod';
import {
  UuidSchema,
  FinanceDecimalSchema,
  PreviewInvestmentReconciliationSchema,
  CreateInvestmentReconciliationSchema,
  ResolveInvestmentReconciliationSchema,
  ReopenInvestmentReconciliationSchema,
  InvestmentReconciliationPreviewSchema,
  InvestmentReconciliationCaseSchema,
  InvestmentReconciliationListSchema,
  InvestmentReconciliationCorrectiveRecordListSchema,
} from '@emdo/contracts/browser';
export class InvestmentReconciliationError extends Error {
  constructor(readonly status: number) {
    super(
      [401, 403].includes(status)
        ? 'Current book access no longer permits this reconciliation review.'
        : status === 409
          ? 'The comparison or case changed. Refresh and review the current saved evidence.'
          : 'The reconciliation request could not be confirmed. Retry the same request.',
    );
  }
}
const Record = z.object({ id: UuidSchema }).catchall(z.unknown());
const Run = z.object({
  id: UuidSchema,
  asOf: z.string(),
  status: z.string(),
  calculationVersion: z.string(),
});
const Comparison = z.object({
  observedPositionId: UuidSchema,
  evidenceId: UuidSchema,
  sourceRow: z.number().int(),
  observedQuantity: FinanceDecimalSchema,
});
export function investmentReconciliationApi(
  bookId: string,
  signal: AbortSignal,
) {
  UuidSchema.parse(bookId);
  const base = '/investments/reconciliations';
  async function request(
    path: string,
    mutation?: { body: unknown; csrf: string; key: string },
  ) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
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
    if (!response.ok) throw new InvestmentReconciliationError(response.status);
    const raw: unknown = await response.json();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return raw;
  }
  function scopedCase(raw: unknown, id?: string) {
    const value = InvestmentReconciliationCaseSchema.parse(raw);
    if (value.bookId !== bookId || (id && value.id !== id))
      throw new Error(
        'The saved case belongs to a different reconciliation scope.',
      );
    return value;
  }
  return {
    async list(offset = 0) {
      const value = InvestmentReconciliationListSchema.parse(
        await request(`${base}?offset=${offset}&limit=50`),
      );
      value.items.forEach((item) => scopedCase(item));
      return value;
    },
    async correctiveRecords(id: string, offset = 0) {
      UuidSchema.parse(id);
      return InvestmentReconciliationCorrectiveRecordListSchema.parse(
        await request(
          `${base}/${id}/corrective-records?offset=${offset}&limit=50`,
        ),
      );
    },
    async read(id: string) {
      UuidSchema.parse(id);
      return scopedCase(await request(`${base}/${id}`), id);
    },
    async preview(
      input: z.infer<typeof PreviewInvestmentReconciliationSchema>,
    ) {
      const data = PreviewInvestmentReconciliationSchema.parse(input);
      const value = InvestmentReconciliationPreviewSchema.parse(
        await request(`${base}/preview?${new URLSearchParams(data)}`),
      );
      if (
        value.bookId !== bookId ||
        value.comparison.valuationRunId !== data.valuationRunId ||
        value.comparison.observedPositionId !== data.observedPositionId
      )
        throw new Error(
          'The preview does not match the selected saved comparison.',
        );
      return value;
    },
    async save(
      kind: 'create' | 'resolve' | 'reopen',
      input: unknown,
      csrf: string,
      key: string,
      id?: string,
    ) {
      if (!csrf) throw new Error('A current session is required.');
      const data =
        kind === 'create'
          ? CreateInvestmentReconciliationSchema.parse(input)
          : kind === 'resolve'
            ? ResolveInvestmentReconciliationSchema.parse(input)
            : ReopenInvestmentReconciliationSchema.parse(input);
      const path =
        kind === 'create' ? base : `${base}/${UuidSchema.parse(id)}/${kind}`;
      const value = scopedCase(
        await request(path, { body: data, csrf, key }),
        id,
      );
      if (value.comparison.comparisonHash !== data.expectedComparisonHash)
        throw new Error(
          'The saved case does not match the reviewed comparison.',
        );
      return value;
    },
    async runs(offset = 0) {
      return z
        .object({ runs: z.array(Run), nextOffset: z.number().int().nullable() })
        .parse(
          await request(
            `/investments/valuation-runs?offset=${offset}&limit=50`,
          ),
        );
    },
    async run(id: string) {
      UuidSchema.parse(id);
      const value = z
        .object({
          id: UuidSchema,
          result: z.object({ reconciliations: z.array(Comparison) }),
        })
        .parse(await request(`/investments/valuation-runs/${id}`));
      if (value.id !== id)
        throw new Error('Saved valuation identity mismatch.');
      return value;
    },
    async catalog() {
      return z
        .object({
          instruments: z.array(Record),
          openings: z.array(Record),
          observedPositions: z.array(Record),
        })
        .parse(await request('/investments'));
    },
    async documents(offset = 0) {
      return z
        .object({
          documents: z.array(
            z.object({
              id: UuidSchema,
              filename: z.string(),
              format: z.string(),
            }),
          ),
          nextOffset: z.number().int().nullable(),
        })
        .parse(await request(`/evidence?offset=${offset}&limit=50`));
    },
  };
}
export type InvestmentReconciliationApi = ReturnType<
  typeof investmentReconciliationApi
>;
