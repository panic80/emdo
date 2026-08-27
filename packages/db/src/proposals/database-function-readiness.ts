import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';

const firstRow = (
  rows: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined => rows[0];

/**
 * Probes only catalog visibility and the current login's EXECUTE privileges.
 * Readiness never installs claims, changes authority, or invokes a capability.
 */
export const checkDatabaseFunctionPrivileges = async (
  pool: DatabasePool,
  signatures: readonly string[],
): Promise<boolean> => {
  let client: DatabaseClient | undefined;
  try {
    client = await pool.connect();
    const result = await client.query(
      `select coalesce(
                pg_catalog.bool_and(
                  resolved.procedure_oid is not null
                  and pg_catalog.has_function_privilege(
                    current_user, resolved.procedure_oid, 'EXECUTE'
                  )
                ),
                false
              ) as ready
         from (
           select pg_catalog.to_regprocedure(required.signature)
                    as procedure_oid
             from pg_catalog.unnest($1::text[]) as required(signature)
         ) as resolved`,
      [signatures],
    );
    return firstRow(result.rows)?.ready === true;
  } catch {
    return false;
  } finally {
    client?.release();
  }
};
