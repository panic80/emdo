import { UuidSchema, deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import {
  DurableRepositoryError,
  firstResultRow,
  parseDurablePrincipal,
  withDurableTransaction,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';

const IdentifierSchema = z
  .string()
  .min(16)
  .max(200)
  .regex(/^[A-Za-z0-9:._-]+$/u);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const PeriodSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u);
const SafeMinorSchema = z.number().int().nonnegative().safe();

const ReservationRequestSchema = z.strictObject({
  authorizationHash: HashSchema,
  category: z.enum(['model', 'audio']),
  estimatedCadMinor: SafeMinorSchema.positive(),
  executionId: IdentifierSchema,
  householdId: UuidSchema,
  period: PeriodSchema,
  requestHash: HashSchema,
  reservationId: IdentifierSchema,
});

const ThresholdSchema = z.strictObject({
  warningCadMinor: z.literal(5_000),
  limitCadMinor: z.literal(7_500),
});

const ReservationActionSchema = z.strictObject({
  reservationId: IdentifierSchema,
  authorizationHash: HashSchema,
});
const SettlementSchema = z.strictObject({
  reservationId: IdentifierSchema,
  executionId: IdentifierSchema,
  actualCadMinor: SafeMinorSchema,
});

export interface PostgresSpendReservationRequest {
  readonly authorizationHash: string;
  readonly category: 'model' | 'audio';
  readonly estimatedCadMinor: number;
  readonly executionId: string;
  readonly householdId: string;
  readonly period: string;
  readonly requestHash: string;
  readonly reservationId: string;
}

export type PostgresSpendReservationResult = Readonly<
  | {
      status: 'reserved';
      warning: boolean;
      period: string;
      projectedCadMinor: number;
      reservationId: string;
    }
  | {
      status: 'blocked';
      warning: true;
      period: string;
      currentCadMinor: number;
      safeError: Readonly<{
        code: 'monthly-ai-spend-limit-reached';
        message: 'The monthly AI spend limit has been reached.';
        retryable: false;
      }>;
    }
  | {
      status: 'released' | 'dispatched';
      period: string;
      reservationId: string;
    }
  | {
      status: 'settled';
      period: string;
      reservationId: string;
      actualCadMinor: number;
      reservationExceeded: boolean;
    }
>;

interface SpendRow {
  readonly reservationId: string;
  readonly householdId: string;
  readonly period: string;
  readonly requestHash: string;
  readonly authorizationHash: string;
  readonly executionId: string;
  readonly estimatedCadMinor: number;
  readonly actualCadMinor?: number;
  readonly decisionCadMinor: number;
  readonly warning: boolean;
  readonly state:
    'blocked' | 'reserved' | 'dispatched' | 'released' | 'settled';
}

const safeIntegerFromDb = (value: unknown, name: string): number => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DurableRepositoryError(
      'invalid-result',
      `Database returned an invalid ${name}`,
    );
  }
  return parsed;
};

const parseSpendRow = (row: Record<string, unknown>): SpendRow => {
  const state = row.state;
  if (
    typeof row.reservation_id !== 'string' ||
    typeof row.household_id !== 'string' ||
    typeof row.period !== 'string' ||
    typeof row.request_hash !== 'string' ||
    typeof row.authorization_hash !== 'string' ||
    typeof row.execution_id !== 'string' ||
    typeof row.warning !== 'boolean' ||
    typeof state !== 'string' ||
    !['blocked', 'reserved', 'dispatched', 'released', 'settled'].includes(
      state,
    )
  ) {
    throw new DurableRepositoryError(
      'invalid-result',
      'Database returned a malformed spend reservation',
    );
  }
  return {
    reservationId: row.reservation_id,
    householdId: row.household_id,
    period: row.period,
    requestHash: row.request_hash,
    authorizationHash: row.authorization_hash,
    executionId: row.execution_id,
    estimatedCadMinor: safeIntegerFromDb(
      row.estimated_cad_minor,
      'estimated amount',
    ),
    ...(row.actual_cad_minor === null || row.actual_cad_minor === undefined
      ? {}
      : {
          actualCadMinor: safeIntegerFromDb(
            row.actual_cad_minor,
            'actual amount',
          ),
        }),
    decisionCadMinor: safeIntegerFromDb(
      row.decision_cad_minor,
      'decision total',
    ),
    warning: row.warning,
    state: state as SpendRow['state'],
  };
};

const resultFromRow = (row: SpendRow): PostgresSpendReservationResult => {
  if (row.state === 'blocked') {
    return deepFreeze({
      status: 'blocked' as const,
      warning: true as const,
      period: row.period,
      currentCadMinor: row.decisionCadMinor,
      safeError: {
        code: 'monthly-ai-spend-limit-reached' as const,
        message: 'The monthly AI spend limit has been reached.' as const,
        retryable: false as const,
      },
    });
  }
  if (row.state === 'reserved') {
    return deepFreeze({
      status: 'reserved' as const,
      warning: row.warning,
      period: row.period,
      projectedCadMinor: row.decisionCadMinor,
      reservationId: row.reservationId,
    });
  }
  if (row.state === 'settled') {
    if (row.actualCadMinor === undefined) {
      throw new DurableRepositoryError(
        'invalid-result',
        'Settled spend reservation has no actual amount',
      );
    }
    return deepFreeze({
      status: 'settled' as const,
      period: row.period,
      reservationId: row.reservationId,
      actualCadMinor: row.actualCadMinor,
      reservationExceeded: row.actualCadMinor > row.estimatedCadMinor,
    });
  }
  return deepFreeze({
    status: row.state,
    period: row.period,
    reservationId: row.reservationId,
  });
};

const selectColumns = `reservation_id, household_id, period, request_hash,
  authorization_hash, execution_id, estimated_cad_minor, actual_cad_minor,
  decision_cad_minor, warning, state`;

export const checkPostgresAudioSpendReadiness = async (
  pool: DatabasePool,
): Promise<boolean> => {
  let client: Awaited<ReturnType<DatabasePool['connect']>> | undefined;
  try {
    client = await pool.connect();
    const result = await client.query(
      'select emdo.audio_spend_ready() as ready',
      [],
    );
    return result.rows.length === 1 && result.rows[0]?.ready === true;
  } catch {
    return false;
  } finally {
    client?.release();
  }
};

export class PostgresSpendLedger {
  readonly #principal: Readonly<DurableRepositoryPrincipal>;

  constructor(
    private readonly pool: DatabasePool,
    principal: DurableRepositoryPrincipal,
  ) {
    this.#principal = parseDurablePrincipal(principal);
  }

  async reserve(
    requestInput: PostgresSpendReservationRequest,
    thresholdInput: Readonly<{
      warningCadMinor: number;
      limitCadMinor: number;
    }>,
  ): Promise<PostgresSpendReservationResult> {
    const request = ReservationRequestSchema.parse(requestInput);
    const thresholds = ThresholdSchema.parse(thresholdInput);
    if (request.householdId !== this.#principal.householdId) {
      throw new DurableRepositoryError(
        'authorization-revoked',
        'Spend request household does not match the canonical principal',
      );
    }

    return withDurableTransaction(
      this.pool,
      this.#principal,
      { householdId: request.householdId },
      async (client) => {
        const reservation = firstResultRow(
          await client.query(
            `select ${selectColumns}
               from emdo.reserve_ai_spend(
                 $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
               )`,
            [
              request.reservationId,
              request.householdId,
              request.period,
              request.category,
              request.executionId,
              request.authorizationHash,
              request.requestHash,
              request.estimatedCadMinor,
              thresholds.warningCadMinor,
              thresholds.limitCadMinor,
            ],
          ),
        );
        if (reservation === undefined) {
          throw new DurableRepositoryError(
            'authorization-revoked',
            'Spend reservation could not be created in the active scope',
          );
        }
        return resultFromRow(parseSpendRow(reservation));
      },
    );
  }

  async markDispatched(input: {
    readonly reservationId: string;
    readonly authorizationHash: string;
  }): Promise<PostgresSpendReservationResult> {
    const parsed = ReservationActionSchema.parse(input);
    return this.#transitionReservation(parsed, 'dispatched');
  }

  async release(input: {
    readonly reservationId: string;
    readonly authorizationHash: string;
  }): Promise<PostgresSpendReservationResult> {
    const parsed = ReservationActionSchema.parse(input);
    return this.#transitionReservation(parsed, 'released');
  }

  async #transitionReservation(
    input: z.infer<typeof ReservationActionSchema>,
    transition: 'dispatched' | 'released',
  ): Promise<PostgresSpendReservationResult> {
    return withDurableTransaction(
      this.pool,
      this.#principal,
      { householdId: this.#principal.householdId },
      async (client) => {
        const updated = firstResultRow(
          await client.query(
            `select ${selectColumns}
               from emdo.transition_ai_spend($1, $2, $3)`,
            [input.reservationId, input.authorizationHash, transition],
          ),
        );
        if (updated === undefined) {
          throw new DurableRepositoryError(
            'conflict',
            'Spend reservation compare-and-set failed',
          );
        }
        return resultFromRow(parseSpendRow(updated));
      },
    );
  }

  async settle(input: {
    readonly reservationId: string;
    readonly executionId: string;
    readonly actualCadMinor: number;
  }): Promise<PostgresSpendReservationResult> {
    const parsed = SettlementSchema.parse(input);
    return withDurableTransaction(
      this.pool,
      this.#principal,
      { householdId: this.#principal.householdId },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select period, reservation_id, actual_cad_minor,
                  reservation_exceeded
             from emdo.settle_ai_spend($1, $2, $3)`,
            [parsed.reservationId, parsed.executionId, parsed.actualCadMinor],
          ),
        );
        if (
          row === undefined ||
          typeof row.period !== 'string' ||
          typeof row.reservation_id !== 'string' ||
          typeof row.reservation_exceeded !== 'boolean'
        ) {
          throw new DurableRepositoryError(
            'invalid-result',
            'Database returned a malformed spend settlement',
          );
        }
        return deepFreeze({
          status: 'settled' as const,
          period: row.period,
          reservationId: row.reservation_id,
          actualCadMinor: safeIntegerFromDb(
            row.actual_cad_minor,
            'actual amount',
          ),
          reservationExceeded: row.reservation_exceeded,
        });
      },
    );
  }
}
