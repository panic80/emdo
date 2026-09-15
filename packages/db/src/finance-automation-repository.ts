import { FinanceV2PersistenceError } from './finance-v2-repository.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  FinanceAutomationCapabilitySchema,
  FinanceAutomationJournalDraftIntentSchema,
  FinanceAutomationExtractionIntentSchema,
  FinanceAutomationExtractionResultSchema,
  PrepareFinanceAutomationExtractionSchema,
  FinanceAutomationGrantSchema,
  FinanceAutomationLimitsSchema,
  FinanceAutomationPlanningIntentSchema,
  FinanceAutomationRunSchema,
  FinanceAutomationRunRecordSchema,
  FinanceCurrencySchema,
  FinanceMoneySchema,
  FinanceReportSelectionSchema,
  IsoDateTimeSchema,
  UuidSchema,
  WorkspaceContextSchema,
  isFinanceAutomationPlanningCapability,
  type WorkspaceContext,
} from '@emdo/contracts';
import { withDurableTransaction } from './durable/scoped-transaction.js';
import type { DatabaseClient, DatabasePool } from './scoped-repository.js';

export const CreateDurableFinanceAutomationGrantSchema = z.strictObject({
  id: UuidSchema.optional(),
  capabilities: FinanceAutomationGrantSchema.shape.allowedCapabilities,
  limits: FinanceAutomationLimitsSchema,
  validFrom: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
});
export const EnqueueDurableFinanceAutomationRunSchema = z
  .strictObject({
    operationId: UuidSchema,
    grantId: UuidSchema,
    capability: FinanceAutomationCapabilitySchema,
    targets: z.array(UuidSchema).min(1).max(10000),
    currency: FinanceCurrencySchema,
    amount: z.string().max(40),
    report: FinanceReportSelectionSchema.optional(),
    planning: FinanceAutomationPlanningIntentSchema.optional(),
    extraction: FinanceAutomationExtractionIntentSchema.optional(),
    journal: FinanceAutomationJournalDraftIntentSchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      (value.capability === 'finance.journals.draft') !==
        (value.journal !== undefined) ||
      (value.journal &&
        (value.targets.length !== 1 ||
          value.targets[0] !== value.journal.batchId ||
          value.report !== undefined ||
          value.planning !== undefined ||
          value.extraction !== undefined))
    )
      context.addIssue({
        code: 'custom',
        path: ['journal'],
        message:
          'Journal drafting requires one exact source and no other intent',
      });
    if (
      (value.capability === 'finance.documents.extract') !==
        (value.extraction !== undefined) ||
      (value.extraction &&
        (value.targets.length !== 1 ||
          value.targets[0] !== value.extraction.evidenceId ||
          !/^0(?:\.0+)?$/.test(value.amount) ||
          value.report !== undefined ||
          value.planning !== undefined))
    )
      context.addIssue({
        code: 'custom',
        path: ['extraction'],
        message: 'Extraction requires one exact source and zero amount',
      });
    const planning = isFinanceAutomationPlanningCapability(value.capability);
    if (planning !== (value.planning !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['planning'],
        message: planning
          ? 'Planning capability requires a versioned planning intent'
          : 'Planning intent is only valid for a planning capability',
      });
    }
    if (value.planning !== undefined) {
      if (value.planning.capability !== value.capability)
        context.addIssue({
          code: 'custom',
          path: ['planning', 'capability'],
          message: 'Planning capability does not match the run capability',
        });
      if (value.planning.currency !== value.currency)
        context.addIssue({
          code: 'custom',
          path: ['planning', 'currency'],
          message: 'Planning currency does not match the run currency',
        });
      if (
        value.targets.length !== 1 ||
        value.targets[0] !== value.planning.budgetId
      )
        context.addIssue({
          code: 'custom',
          path: ['targets'],
          message: 'Planning runs must target exactly the planning budget',
        });
      if (!/^0(?:\.0+)?$/.test(value.amount))
        context.addIssue({
          code: 'custom',
          path: ['amount'],
          message: 'Planning runs cannot reserve a nonzero amount',
        });
      if (value.report !== undefined)
        context.addIssue({
          code: 'custom',
          path: ['report'],
          message: 'Planning runs cannot carry a report selection',
        });
    }
  })
  .refine(
    (v) =>
      FinanceMoneySchema.safeParse({ currency: v.currency, amount: v.amount })
        .success && !v.amount.startsWith('-'),
    'Invalid currency amount',
  );

function grantView(raw: unknown) {
  const row = z.record(z.string(), z.unknown()).parse(raw);
  return FinanceAutomationGrantSchema.parse({
    id: row.id,
    revision: row.revision,
    workspaceId: row.workspace_id,
    bookId: row.book_id,
    grantedByUserId: row.granted_by_user_id,
    executor: 'emdo-managed',
    specialist: 'finance',
    status: row.status,
    allowedCapabilities: row.capabilities,
    authorityRevision: {
      membership: row.authority_epoch,
      bookAccess: row.authority_epoch,
      entitlement: row.authority_epoch,
    },
    limits: row.limits,
    validFrom: new Date(String(row.valid_from)).toISOString(),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
  });
}
function runView(raw: unknown) {
  const row = z.record(z.string(), z.unknown()).parse(raw);
  const capability = FinanceAutomationCapabilitySchema.parse(row.capability);
  // Worker claims contain the full canonical intent. Read-history RPCs return
  // only safe top-level report/planning projections and intentionally redact
  // targets, planningReview, and lease data.
  const intent =
    row.intent === undefined || row.intent === null
      ? undefined
      : z.record(z.string(), z.unknown()).parse(row.intent);
  const request: Record<string, unknown> = {
    operationId: row.id,
    grantId: row.grant_id,
    grantRevision: row.grant_revision,
    workspaceId: row.workspace_id,
    bookId: row.book_id,
    capability,
    requestHash: row.request_hash,
    itemCount: row.item_count,
    currency: row.currency,
    amount: String(row.amount),
  };
  if (isFinanceAutomationPlanningCapability(capability)) {
    request.planning = FinanceAutomationPlanningIntentSchema.parse(
      intent?.planning ?? row.planning,
    );
  } else if (capability === 'finance.journals.draft') {
    request.journal = FinanceAutomationJournalDraftIntentSchema.parse(
      intent?.journal ?? row.journal,
    );
  } else if (capability === 'finance.documents.extract') {
    request.extraction = FinanceAutomationExtractionIntentSchema.parse(
      intent?.extraction ?? row.extraction,
    );
  } else {
    request.report = FinanceReportSelectionSchema.parse(
      intent?.report ?? row.report ?? { kind: 'posted-ledger-trial-balance' },
    );
  }
  return FinanceAutomationRunSchema.parse({
    request,
    revision: row.revision,
    attempts: row.attempts,
    status: row.status,
    outcomeReference: row.outcome_reference,
  });
}
function runRecordView(row: Record<string, unknown>) {
  return FinanceAutomationRunRecordSchema.parse({
    run: runView(row),
    createdAt: new Date(String(row.created_at)).toISOString(),
    blockedReason: row.blocked_reason,
  });
}
const rowResult = async (
  client: DatabaseClient,
  sql: string,
  values: unknown[],
) => (await client.query(sql, values)).rows[0]?.result;

/** Authenticated management API repository; never passed into a specialist. */
export class PostgresFinanceAutomationRepository {
  constructor(private readonly pool: DatabasePool) {}
  async checkReady() {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "select to_regprocedure('emdo.create_finance_automation_grant(uuid,uuid,uuid,jsonb,jsonb,timestamp with time zone,timestamp with time zone)') is not null and to_regprocedure('emdo.read_finance_automation_runs(uuid,uuid,integer,integer,uuid)') is not null as ready,rolsuper,rolbypassrls from pg_roles where rolname=current_user",
      );
      const row = result.rows[0];
      return (
        row?.ready === true &&
        row.rolsuper === false &&
        row.rolbypassrls === false
      );
    } finally {
      client.release();
    }
  }
  private transaction<T>(
    raw: WorkspaceContext,
    work: (client: DatabaseClient) => Promise<T>,
  ) {
    const context = WorkspaceContextSchema.parse(raw);
    return withDurableTransaction(
      this.pool,
      { ...context, householdId: context.workspaceId },
      { householdId: context.workspaceId },
      work,
    ).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      const code = 'code' in error ? String(error.code) : '';
      if (code === '42501')
        throw new FinanceV2PersistenceError(
          'authorization-revoked',
          error.message,
        );
      if (['22023', '22P02', '23503'].includes(code))
        throw new FinanceV2PersistenceError('invalid-input', error.message);
      if (
        ['23505', '23514'].includes(code) ||
        error.message.startsWith('automation-')
      )
        throw new FinanceV2PersistenceError('conflict', error.message);
      throw error;
    });
  }
  async listRuns(
    context: WorkspaceContext,
    bookId: string,
    offset = 0,
    limit = 50,
  ) {
    UuidSchema.parse(bookId);
    z.number().int().min(0).max(1000000).parse(offset);
    z.number().int().min(1).max(100).parse(limit);
    return this.transaction(context, async (client) => {
      const rows = z
        .array(z.record(z.string(), z.unknown()))
        .max(limit + 1)
        .parse(
          await rowResult(
            client,
            'select emdo.read_finance_automation_runs($1,$2,$3,$4,NULL) as result',
            [context.workspaceId, bookId, offset, limit],
          ),
        );
      return {
        runs: rows.slice(0, limit).map(runRecordView),
        nextOffset: rows.length > limit ? offset + limit : null,
      };
    });
  }
  async getRun(context: WorkspaceContext, bookId: string, operationId: string) {
    UuidSchema.parse(bookId);
    UuidSchema.parse(operationId);
    return this.transaction(context, async (client) => {
      const rows = z
        .array(z.record(z.string(), z.unknown()))
        .max(1)
        .parse(
          await rowResult(
            client,
            'select emdo.read_finance_automation_runs($1,$2,0,1,$3) as result',
            [context.workspaceId, bookId, operationId],
          ),
        );
      return rows[0] ? runRecordView(rows[0]) : null;
    });
  }
  async createGrant(context: WorkspaceContext, bookId: string, raw: unknown) {
    const input = CreateDurableFinanceAutomationGrantSchema.parse(raw);
    UuidSchema.parse(bookId);
    return this.transaction(context, async (client) =>
      grantView(
        await rowResult(
          client,
          'select emdo.create_finance_automation_grant($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7) as result',
          [
            context.workspaceId,
            bookId,
            input.id ?? randomUUID(),
            JSON.stringify(input.capabilities),
            JSON.stringify(input.limits),
            input.validFrom,
            input.expiresAt,
          ],
        ),
      ),
    );
  }
  async revokeGrant(
    context: WorkspaceContext,
    bookId: string,
    grantId: string,
  ) {
    UuidSchema.parse(bookId);
    UuidSchema.parse(grantId);
    return this.transaction(context, async (client) =>
      grantView(
        await rowResult(
          client,
          'select emdo.revoke_finance_automation_grant($1,$2,$3) as result',
          [context.workspaceId, bookId, grantId],
        ),
      ),
    );
  }
  async listGrants(context: WorkspaceContext, bookId: string) {
    UuidSchema.parse(bookId);
    return this.transaction(context, async (client) =>
      z
        .array(z.unknown())
        .parse(
          await rowResult(
            client,
            'select emdo.list_finance_automation_grants($1,$2) as result',
            [context.workspaceId, bookId],
          ),
        )
        .map(grantView),
    );
  }
  async readExtractionResult(
    context: WorkspaceContext,
    bookId: string,
    resultId: string,
  ) {
    UuidSchema.parse(bookId);
    UuidSchema.parse(resultId);
    return this.transaction(context, async (client) =>
      FinanceAutomationExtractionResultSchema.parse(
        await rowResult(
          client,
          'select emdo.read_finance_automation_extraction_result($1,$2,$3) as result',
          [context.workspaceId, bookId, resultId],
        ),
      ),
    );
  }
  async prepareExtraction(
    context: WorkspaceContext,
    bookId: string,
    idempotencyKey: string,
    raw: unknown,
  ) {
    UuidSchema.parse(bookId);
    UuidSchema.parse(idempotencyKey);
    const input = PrepareFinanceAutomationExtractionSchema.parse(raw);
    return this.transaction(context, async (client) =>
      FinanceAutomationExtractionIntentSchema.parse(
        await rowResult(
          client,
          'select emdo.prepare_finance_automation_extraction($1,$2,$3,$4,$5) as result',
          [
            context.workspaceId,
            bookId,
            idempotencyKey,
            input.evidenceId,
            input.expectedSourceDigest,
          ],
        ),
      ),
    );
  }
  async enqueueRun(context: WorkspaceContext, bookId: string, raw: unknown) {
    UuidSchema.parse(bookId);
    const input = EnqueueDurableFinanceAutomationRunSchema.parse(raw);
    return this.transaction(context, async (client) =>
      runView(
        await rowResult(
          client,
          input.journal !== undefined
            ? 'select emdo.enqueue_finance_journal_draft_automation($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb) as result'
            : input.extraction !== undefined
              ? 'select emdo.enqueue_finance_extraction_automation($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb) as result'
              : input.planning !== undefined
                ? 'select emdo.enqueue_finance_automation_run($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10::jsonb) as result'
                : input.report === undefined
                  ? 'select emdo.enqueue_finance_automation_run($1,$2,$3,$4,$5,$6::jsonb,$7,$8) as result'
                  : 'select emdo.enqueue_finance_automation_run($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb) as result',
          [
            context.workspaceId,
            bookId,
            input.grantId,
            input.operationId,
            input.capability,
            JSON.stringify(input.targets),
            input.currency,
            input.amount,
            ...(input.journal !== undefined
              ? [JSON.stringify(input.journal)]
              : input.extraction !== undefined
                ? [JSON.stringify(input.extraction)]
                : input.planning !== undefined
                  ? [null, JSON.stringify(input.planning)]
                  : input.report === undefined
                    ? []
                    : [JSON.stringify(input.report)]),
          ],
        ),
      ),
    );
  }
}

export type DurableFinanceAutomationClaim =
  | { status: 'unavailable' }
  | { status: 'denied'; reason: string }
  | { status: 'duplicate'; outcomeReference: string }
  | {
      status: 'claimed';
      run: ReturnType<typeof runView>;
      intent: Readonly<Record<string, unknown>>;
      leaseToken: string;
      leaseExpiresAt: string;
    };
/** Session-free worker persistence only. Must be composed with a restricted
 * emdo_worker pool. No leaf dispatcher or pg-boss registration is installed.
 * Claim only immediately before a registered bounded leaf dispatch; on lease
 * loss/unknown effects reconcile instead of replaying. Queue payload contains only operation UUID and delivery revision.
 */
export class PostgresFinanceAutomationExecutionRepository {
  constructor(private readonly pool: DatabasePool) {}
  private async call(sql: string, values: unknown[]) {
    const client = await this.pool.connect();
    try {
      return await rowResult(client, sql, values);
    } finally {
      client.release();
    }
  }
  async claim(operationId: string): Promise<DurableFinanceAutomationClaim> {
    UuidSchema.parse(operationId);
    return this.parseClaim(
      await this.call(
        'select emdo.claim_finance_automation_run($1) as result',
        [operationId],
      ),
    );
  }
  /** Required for queued delivery: rejects stale/future references atomically
   * before incrementing attempts or reserving grant usage. */
  async claimDelivery(
    operationId: string,
    deliveryRevision: number,
  ): Promise<DurableFinanceAutomationClaim> {
    UuidSchema.parse(operationId);
    z.number().int().min(1).max(2147483647).parse(deliveryRevision);
    return this.parseClaim(
      await this.call(
        'select emdo.claim_finance_automation_delivery($1,$2) as result',
        [operationId, deliveryRevision],
      ),
    );
  }
  private parseClaim(raw: unknown): DurableFinanceAutomationClaim {
    const value = z.record(z.string(), z.unknown()).parse(raw);
    if (value.status === 'unavailable') return { status: 'unavailable' };
    if (value.status === 'denied')
      return { status: 'denied', reason: z.string().parse(value.reason) };
    if (value.status === 'duplicate')
      return {
        status: 'duplicate',
        outcomeReference: UuidSchema.parse(value.outcomeReference),
      };
    if (value.status !== 'claimed') throw new Error('automation-invalid-claim');
    const row = z.record(z.string(), z.unknown()).parse(value.run);
    return {
      status: 'claimed',
      run: runView(row),
      intent: z.record(z.string(), z.unknown()).parse(row.intent),
      leaseToken: UuidSchema.parse(row.lease_token),
      leaseExpiresAt: new Date(String(row.lease_expires_at)).toISOString(),
    };
  }
  async settle(input: {
    operationId: string;
    expectedRevision: number;
    leaseToken: string;
    result: 'applied' | 'not-applied' | 'indeterminate' | 'blocked';
    outcomeReference?: string;
    blockedReason?: string;
  }) {
    const v = z
      .strictObject({
        operationId: UuidSchema,
        expectedRevision: z.number().int().positive(),
        leaseToken: UuidSchema,
        result: z.enum(['applied', 'not-applied', 'indeterminate', 'blocked']),
        outcomeReference: UuidSchema.optional(),
        blockedReason: z.string().trim().min(1).max(200).optional(),
      })
      .parse(input);
    return runView(
      await this.call(
        'select emdo.settle_finance_automation_run($1,$2,$3,$4,$5,$6) as result',
        [
          v.operationId,
          v.expectedRevision,
          v.leaseToken,
          v.result,
          v.outcomeReference ?? null,
          v.blockedReason ?? null,
        ],
      ),
    );
  }
}
