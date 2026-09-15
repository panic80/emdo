import { z } from 'zod';
import {
  FinanceStandardizationClaimSchema,
  type FinanceStandardizationClaim,
  type FinancePromptProjectionReceiptSchema,
} from '@emdo/contracts';
import type { DatabasePool } from './scoped-repository.js';
export class PostgresFinanceStandardizationExecutionRepository {
  constructor(
    private readonly pool: DatabasePool,
    private readonly decrypt: (
      encrypted: unknown,
      scope: { workspaceId: string; bookId: string; documentId: string },
    ) => Promise<unknown>,
  ) {}
  private async query(sql: string, values: readonly unknown[] = []) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("set local statement_timeout='5s'");
      const result = await client.query(sql, values);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async checkReady() {
    const r = await this.query(
      "select current_user='emdo_worker_executor' and session_user='emdo_worker_executor_login' and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.claim_finance_standardization(uuid,integer)'),'EXECUTE'),false) and to_regprocedure('emdo.mark_standardization_dispatch(uuid,integer,uuid,uuid)') is not null and not has_table_privilege(current_user,'emdo.finance_standardization_runs','SELECT,INSERT,UPDATE,DELETE') as ready",
    );
    if (r.rows[0]?.ready !== true)
      throw new Error('standardization-executor-unavailable');
  }
  claim(runId: string, revision: number) {
    z.uuid().parse(runId);
    z.number().int().positive().parse(revision);
    return this.query(
      'select emdo.claim_finance_standardization($1,$2) as result',
      [runId, revision],
    ).then((r) => r.rows[0]?.result);
  }
  private scope(raw: FinanceStandardizationClaim) {
    const c = FinanceStandardizationClaimSchema.parse(raw);
    return [c.runId, c.revision, c.leaseToken];
  }
  async readOriginal(claim: FinanceStandardizationClaim) {
    const row = (
      await this.query(
        'select emdo.read_standardization_original($1,$2,$3) as original',
        this.scope(claim),
      )
    ).rows[0]?.original;
    const source = z
      .object({
        format: z.string(),
        sourceDigest: z.string(),
        encryptedOriginal: z.unknown(),
      })
      .parse(row);
    if (source.sourceDigest !== claim.sourceDigest)
      throw new Error('standardization-source-binding-mismatch');
    const decoded = await this.decrypt(source.encryptedOriginal, {
      workspaceId: claim.workspaceId,
      bookId: claim.bookId,
      documentId: claim.evidenceId,
    });
    const binary = ['pdf', 'xlsx', 'png', 'jpeg', 'webp'].includes(
      source.format,
    );
    const data = binary
      ? z.strictObject({ sourceBase64: z.string().max(2796204) }).parse(decoded)
      : z.strictObject({ sourceText: z.string().max(2097152) }).parse(decoded);
    const bytes =
      'sourceBase64' in data
        ? Buffer.from(data.sourceBase64, 'base64')
        : Buffer.from(data.sourceText, 'utf8');
    if (
      bytes.length === 0 ||
      bytes.length > 2097152 ||
      ('sourceBase64' in data && bytes.toString('base64') !== data.sourceBase64)
    )
      throw new Error('standardization-original-invalid');
    return { format: source.format, bytes };
  }
  async verifyAuthority(
    claim: FinanceStandardizationClaim,
    binding?: { extractionRevision: number; extractionDigest: string },
  ) {
    return (
      (
        await this.query(
          'select emdo.verify_standardization_claim($1,$2,$3,$4,$5) as allowed',
          [
            ...this.scope(claim),
            binding?.extractionRevision ?? null,
            binding?.extractionDigest ?? null,
          ],
        )
      ).rows[0]?.allowed === true
    );
  }
  async saveExtraction(
    claim: FinanceStandardizationClaim,
    summary: unknown,
    envelope: unknown,
  ) {
    await this.query(
      'select emdo.save_standardization_extraction($1,$2,$3,$4::jsonb,$5::jsonb)',
      [...this.scope(claim), JSON.stringify(summary), JSON.stringify(envelope)],
    );
  }
  async reserveModelSpend(
    claim: FinanceStandardizationClaim,
    input: {
      requestKey: string;
      inputTokenCeiling: number;
      outputTokenCeiling: number;
      estimatedCadMinor: number;
      pricingVersion: string;
      pricing: {
        inputCadMinorPerMillionTokens: number;
        outputCadMinorPerMillionTokens: number;
      };
      lineage: {
        managerInvocationId: string;
        financeInvocationId: string;
        orchestrationMode: 'registered-workflow';
        promptVersion:
          | 'finance-standardization-proposal.v1'
          | 'finance-standardization-proposal.v2'
          | 'finance-standardization-proposal.v3'
          | 'finance-standardization-proposal.v4'
          | 'finance-standardization-proposal.v5';
        promptProjection?: z.infer<typeof FinancePromptProjectionReceiptSchema>;
      };
    },
  ) {
    try {
      const r = await this.query(
        'select emdo.reserve_standardization_spend($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb) as id',
        [
          ...this.scope(claim),
          input.requestKey,
          input.inputTokenCeiling,
          input.outputTokenCeiling,
          input.estimatedCadMinor,
          input.pricingVersion,
          JSON.stringify(input.lineage),
          JSON.stringify(input.pricing),
        ],
      );
      return { reservationId: z.uuid().parse(r.rows[0]?.id) };
    } catch (cause) {
      const detail = cause as { code?: string; message?: string };
      if (
        detail.code === '42501' ||
        (detail.code === '23514' &&
          /standardization-(run|workspace)-budget-exhausted/.test(
            detail.message ?? '',
          ))
      ) {
        const error = new Error(
          'Saved analysis cannot reserve model spend.',
        ) as Error & { code: string };
        error.name = 'FinanceStandardizationReservationDenied';
        error.code =
          detail.code === '42501' ? 'authority-revoked' : 'budget-exhausted';
        throw error;
      }
      throw cause;
    }
  }
  async claimReceiptLookup() {
    return (
      await this.query(
        'select emdo.claim_standardization_receipt_lookup() as result',
      )
    ).rows[0]?.result;
  }
  async recordReceiptLookup(id: string, token: string, facts: unknown) {
    return (
      (
        await this.query(
          'select emdo.record_standardization_receipt_lookup($1,$2,$3::jsonb) as accepted',
          [z.uuid().parse(id), z.uuid().parse(token), JSON.stringify(facts)],
        )
      ).rows[0]?.accepted === true
    );
  }
  async markModelDispatch(
    claim: FinanceStandardizationClaim,
    input: { reservationId: string },
  ) {
    await this.query('select emdo.mark_standardization_dispatch($1,$2,$3,$4)', [
      ...this.scope(claim),
      z.uuid().parse(input.reservationId),
    ]);
  }
  async settleModelSpend(
    claim: FinanceStandardizationClaim,
    input: {
      reservationId: string;
      outcome: 'completed' | 'not-sent' | 'indeterminate';
      actualCadMinor?: number;
      providerResponseId?: string;
    },
  ) {
    const r = await this.query(
      'select emdo.settle_standardization_spend($1,$2,$3,$4,$5,$6,$7) as accepted',
      [
        ...this.scope(claim),
        input.reservationId,
        input.outcome,
        input.actualCadMinor ?? null,
        input.providerResponseId ?? null,
      ],
    );
    if (r.rows[0]?.accepted !== true)
      throw new Error('standardization-spend-settlement-unconfirmed');
  }
  async finish(
    claim: FinanceStandardizationClaim,
    result: unknown,
    candidate: unknown | null,
  ) {
    await this.query(
      'select emdo.finish_finance_standardization($1,$2,$3,$4::jsonb,$5::jsonb)',
      [
        ...this.scope(claim),
        JSON.stringify(result),
        candidate === null ? null : JSON.stringify(candidate),
      ],
    );
  }
  async block(
    claim: FinanceStandardizationClaim,
    status: 'blocked' | 'indeterminate' | 'authority-revoked',
    reason: string,
  ) {
    await this.query(
      'select emdo.block_finance_standardization($1,$2,$3,$4,$5)',
      [...this.scope(claim), status, reason],
    );
  }
}
export class PostgresFinanceStandardizationDeliveryRepository {
  constructor(private readonly pool: DatabasePool) {}
  private async query(sql: string, values: readonly unknown[] = []) {
    const client = await this.pool.connect();
    try {
      return await client.query(sql, values);
    } finally {
      client.release();
    }
  }
  async checkReady() {
    const r = await this.query(
      "select current_user='emdo_worker_dispatch_executor' and session_user='emdo_worker_dispatcher_login' and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.claim_standardization_deliveries(integer)'),'EXECUTE'),false) and to_regprocedure('emdo.mark_standardization_dispatch(uuid,integer,uuid,uuid)') is not null and not has_table_privilege(current_user,'emdo.finance_standardization_runs','SELECT,INSERT,UPDATE,DELETE') as ready",
    );
    if (r.rows[0]?.ready !== true)
      throw new Error('standardization-dispatch-unavailable');
  }
  async claim(limit = 10) {
    z.number().int().min(1).max(20).parse(limit);
    const r = await this.query(
      'select emdo.claim_standardization_deliveries($1) as delivery',
      [limit],
    );
    return r.rows.map((row) =>
      z
        .strictObject({
          runId: z.uuid(),
          deliveryRevision: z.number().int().positive(),
          token: z.uuid(),
        })
        .parse(row.delivery),
    );
  }
  async acknowledge(delivery: {
    runId: string;
    deliveryRevision: number;
    token: string;
  }) {
    return (
      (
        await this.query(
          'select emdo.ack_standardization_delivery($1,$2,$3) as accepted',
          [delivery.runId, delivery.deliveryRevision, delivery.token],
        )
      ).rows[0]?.accepted === true
    );
  }
}
