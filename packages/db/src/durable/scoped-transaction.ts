import { UuidSchema, deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

import type {
  DatabaseClient,
  DatabasePool,
  DatabaseQueryResult,
} from '../scoped-repository.js';

const DurablePrincipalSchema = z.strictObject({
  userId: UuidSchema,
  sessionId: UuidSchema,
  requestId: UuidSchema,
  householdId: UuidSchema,
});

export interface DurableRepositoryPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly householdId: string;
}

export class DurableRepositoryError extends Error {
  constructor(
    readonly code:
      'authorization-revoked' | 'conflict' | 'invalid-input' | 'invalid-result',
    message: string,
  ) {
    super(message);
    this.name = 'DurableRepositoryError';
  }
}

export const parseDurablePrincipal = (
  input: DurableRepositoryPrincipal,
): Readonly<DurableRepositoryPrincipal> => {
  const parsed = DurablePrincipalSchema.safeParse(input);
  if (!parsed.success) {
    throw new DurableRepositoryError(
      'invalid-input',
      'Durable repository principal is malformed',
    );
  }
  return deepFreeze(parsed.data);
};

export const firstResultRow = (
  result: DatabaseQueryResult,
): Record<string, unknown> | undefined => result.rows[0];

const rollbackQuietly = async (client: DatabaseClient) => {
  try {
    await client.query('rollback');
  } catch {
    // The original transaction failure remains authoritative.
  }
};

export const beginDurableTransaction = async (
  pool: DatabasePool,
  principal: Readonly<DurableRepositoryPrincipal>,
): Promise<DatabaseClient> => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Parameterized queries use PostgreSQL's extended protocol, where multiple
    // commands are invalid. Install each transaction setting separately before
    // setting the canonical request claims.
    await client.query('set local row_security = on');
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '5s'");
    await client.query(
      `select set_config('emdo.user_id', $1, true),
              set_config('emdo.session_id', $2, true),
              set_config('emdo.request_id', $3, true)`,
      [principal.userId, principal.sessionId, principal.requestId],
    );
    return client;
  } catch (error) {
    await rollbackQuietly(client);
    client.release();
    throw error;
  }
};

export const lockDurableScope = async (
  client: DatabaseClient,
  input: {
    readonly householdId: string;
    readonly spaceId?: string;
    readonly clientId?: string;
  },
): Promise<void> => {
  const householdId = UuidSchema.safeParse(input.householdId);
  const spaceId =
    input.spaceId === undefined
      ? { success: true as const, data: null }
      : UuidSchema.safeParse(input.spaceId);
  const clientId =
    input.clientId === undefined
      ? { success: true as const, data: null }
      : UuidSchema.safeParse(input.clientId);
  if (!householdId.success || !spaceId.success || !clientId.success) {
    throw new DurableRepositoryError(
      'invalid-input',
      'Durable repository scope is malformed',
    );
  }
  const row = firstResultRow(
    await client.query(
      `select emdo.lock_active_request_scope($1, $2, $3) as authorized`,
      [householdId.data, spaceId.data, clientId.data],
    ),
  );
  if (row?.authorized !== true) {
    throw new DurableRepositoryError(
      'authorization-revoked',
      'The canonical request scope is no longer active',
    );
  }
};

export const withDurableTransaction = async <Result>(
  pool: DatabasePool,
  principal: Readonly<DurableRepositoryPrincipal>,
  scope: {
    readonly householdId: string;
    readonly spaceId?: string;
    readonly clientId?: string;
  },
  work: (client: DatabaseClient) => Promise<Result>,
): Promise<Result> => {
  const client = await beginDurableTransaction(pool, principal);
  try {
    await lockDurableScope(client, scope);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
};

export const withClaimedTransaction = async <Result>(
  pool: DatabasePool,
  principal: Readonly<DurableRepositoryPrincipal>,
  work: (client: DatabaseClient) => Promise<Result>,
): Promise<Result> => {
  const client = await beginDurableTransaction(pool, principal);
  try {
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
};
