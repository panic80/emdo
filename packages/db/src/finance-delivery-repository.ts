import { z } from 'zod';
import type { DatabasePool } from './scoped-repository.js';
export const FinanceDeliverySchema = z.strictObject({
  id: z.uuid(),
  operationId: z.uuid(),
  deliveryRevision: z.number().int().positive().max(2147483647),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  leaseToken: z.uuid(),
});
export type FinanceDelivery = z.infer<typeof FinanceDeliverySchema>;
/** The dispatcher receives immutable references only, never a grant or a browser context. */
export class PostgresFinanceDeliveryRepository {
  constructor(private readonly pool: DatabasePool) {}
  private async query(sql: string, values: readonly unknown[] = []) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("set local statement_timeout='5s'");
      const result = await client.query(sql, values);
      await client.query('commit');
      return result;
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        /* Response may be lost. */
      }
      throw error;
    } finally {
      client.release();
    }
  }
  async checkReady(): Promise<void> {
    const result = await this
      .query(`select current_user='emdo_worker_dispatch_executor'
      and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.reconcile_stalled_finance_runs(integer)'),'EXECUTE'),false)
      and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.claim_finance_deliveries(integer)'),'EXECUTE'),false)
      and coalesce(has_function_privilege(current_user,to_regprocedure('emdo.ack_finance_delivery(uuid,uuid,text,text)'),'EXECUTE'),false)
      and not has_table_privilege(current_user,'emdo.finance_deliveries','SELECT,INSERT,UPDATE,DELETE')
      and exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='emdo' and c.relname='finance_deliveries' and c.relrowsecurity and c.relforcerowsecurity) as ready`);
    if (result.rows[0]?.ready !== true)
      throw new Error('Finance delivery dispatcher is unavailable');
  }
  async reconcileStalled(limit = 5): Promise<number> {
    z.number().int().min(1).max(20).parse(limit);
    const result = await this.query(
      'select emdo.reconcile_stalled_finance_runs($1) as recovered',
      [limit],
    );
    return z.number().int().min(0).max(limit).parse(result.rows[0]?.recovered);
  }
  async claim(limit = 20): Promise<FinanceDelivery[]> {
    z.number().int().min(1).max(100).parse(limit);
    const result = await this.query(
      'select emdo.claim_finance_deliveries($1) as delivery',
      [limit],
    );
    return result.rows.map((row) => FinanceDeliverySchema.parse(row.delivery));
  }
  async acknowledge(
    delivery: FinanceDelivery,
    disposition: 'enqueued' | 'quarantined',
  ): Promise<boolean> {
    const parsed = FinanceDeliverySchema.parse(delivery);
    z.enum(['enqueued', 'quarantined']).parse(disposition);
    const result = await this.query(
      'select emdo.ack_finance_delivery($1,$2,$3,$4) as accepted',
      [parsed.id, parsed.leaseToken, parsed.payloadHash, disposition],
    );
    return result.rows[0]?.accepted === true;
  }
}
