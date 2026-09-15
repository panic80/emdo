import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  FinanceStandardizationExtractionSchema,
  FinanceStandardizationExtractionEnvelopeSchema,
  FinanceAutomationExtractionIntentSchema,
  UuidSchema,
} from '@emdo/contracts';
import type { DatabasePool } from './scoped-repository.js';
export class FinanceExtractionNotAppliedError extends Error {}
export class PostgresFinanceExtractionExecutionRepository {
  constructor(
    private readonly pool: DatabasePool,
    private readonly decrypt: (
      encrypted: unknown,
      scope: { workspaceId: string; bookId: string; documentId: string },
    ) => Promise<unknown>,
  ) {}
  private async query(sql: string, values: unknown[]) {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const r = await c.query(sql, values);
      await c.query('commit');
      return r.rows[0]?.result;
    } catch (error) {
      await c.query('rollback').catch(() => {});
      if (
        ['23514', '42501', '22023'].includes(
          (error as { code?: string }).code ?? '',
        )
      )
        throw new FinanceExtractionNotAppliedError('extraction-not-applied');
      throw error;
    } finally {
      c.release();
    }
  }
  async checkReady() {
    const ready = await this.query(
      "select current_user='emdo_worker_executor' and session_user='emdo_worker_executor_login' and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.read_finance_automation_extraction_source(uuid,integer,uuid)'),'EXECUTE'),false) and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.save_finance_automation_extraction(uuid,integer,uuid,jsonb,jsonb)'),'EXECUTE'),false) and (select relrowsecurity and relforcerowsecurity from pg_class where oid=to_regclass('emdo.finance_automation_extraction_results')) and not has_table_privilege(current_user,'emdo.finance_automation_extraction_results','SELECT,INSERT,UPDATE,DELETE') as result",
      [],
    );
    if (ready !== true)
      throw new Error('finance-extraction-executor-unavailable');
  }
  async read(input: {
    operationId: string;
    expectedRevision: number;
    leaseToken: string;
    workspaceId: string;
    bookId: string;
    extraction: unknown;
  }) {
    const intent = FinanceAutomationExtractionIntentSchema.parse(
      input.extraction,
    );
    const source = z
      .object({
        format: z.string(),
        sourceDigest: z.string(),
        encryptedOriginal: z.unknown(),
        summary: FinanceStandardizationExtractionSchema.nullable(),
        envelope: FinanceStandardizationExtractionEnvelopeSchema.nullable(),
      })
      .parse(
        await this.query(
          'select emdo.read_finance_automation_extraction_source($1,$2,$3) as result',
          [input.operationId, input.expectedRevision, input.leaseToken],
        ),
      );
    if (source.sourceDigest !== intent.expectedSourceDigest)
      throw new FinanceExtractionNotAppliedError('extraction-source-binding');
    const original = z
      .union([
        z.strictObject({ sourceBase64: z.string() }),
        z.strictObject({ sourceText: z.string() }),
      ])
      .parse(
        await this.decrypt(source.encryptedOriginal, {
          workspaceId: input.workspaceId,
          bookId: input.bookId,
          documentId: intent.evidenceId,
        }),
      );
    const bytes =
      'sourceBase64' in original
        ? Buffer.from(original.sourceBase64, 'base64')
        : Buffer.from(original.sourceText, 'utf8');
    if (
      !bytes.length ||
      bytes.length > 2097152 ||
      ('sourceBase64' in original &&
        bytes.toString('base64') !== original.sourceBase64) ||
      createHash('sha256').update(bytes).digest('hex') !==
        intent.expectedSourceDigest
    )
      throw new FinanceExtractionNotAppliedError(
        'extraction-original-integrity',
      );
    return {
      format: source.format,
      bytes,
      summary: source.summary,
      envelope: source.envelope,
    };
  }
  async save(input: {
    operationId: string;
    expectedRevision: number;
    leaseToken: string;
    summary: unknown;
    envelope: unknown;
  }) {
    const summary = FinanceStandardizationExtractionSchema.parse(input.summary),
      envelope = FinanceStandardizationExtractionEnvelopeSchema.parse(
        input.envelope,
      );
    return {
      resultId: UuidSchema.parse(
        await this.query(
          'select emdo.save_finance_automation_extraction($1,$2,$3,$4::jsonb,$5::jsonb) as result',
          [
            input.operationId,
            input.expectedRevision,
            input.leaseToken,
            JSON.stringify(summary),
            JSON.stringify(envelope),
          ],
        ),
      ),
    };
  }
}
