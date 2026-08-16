import { Sha256Schema, UuidSchema, deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import { firstResultRow } from '../durable/scoped-transaction.js';
import {
  WORKER_JOB_NAMES,
  WorkerOperationIdSchema,
  WorkerPersistenceError,
  parseDurableWorkerExecutionContext,
  withWorkerOperationTransaction,
  type DurableWorkerExecutionContext,
} from './scope.js';

const DeliveryReferenceSchema = z.strictObject({
  operationId: WorkerOperationIdSchema,
  invitationId: UuidSchema,
  deliverySecretId: UuidSchema,
});
const SettlementInputSchema = DeliveryReferenceSchema.extend({
  disposition: z.enum(['confirmed', 'indeterminate', 'expired']),
});
const NormalizedEmailSchema = z
  .email()
  .max(320)
  .refine((value) => value === value.trim().toLowerCase());
const EnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  algorithm: z.literal('RSA-OAEP-256'),
  keyId: z.string().trim().min(1).max(128),
  ciphertext: z
    .string()
    .min(1)
    .max(32_768)
    .regex(/^[A-Za-z0-9_-]+$/u),
  bindingHash: Sha256Schema,
});
const CaptureResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    schemaVersion: z.literal(1),
    status: z.literal('active'),
    invitationId: UuidSchema,
    deliverySecretId: UuidSchema,
    recipient: NormalizedEmailSchema,
    role: z.enum(['owner', 'member']),
    tokenHash: Sha256Schema,
    templateVersion: z.literal('invitation-redemption.v1'),
    envelope: EnvelopeSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    status: z.literal('expired'),
    invitationId: UuidSchema,
    deliverySecretId: UuidSchema,
  }),
]);
const SettlementResultSchema = z.strictObject({
  status: z.enum(['settled', 'duplicate']),
});

export type PostgresInvitationDeliveryCapture = z.output<
  typeof CaptureResultSchema
>;
export type PostgresInvitationDeliverySettlement = z.output<
  typeof SettlementResultSchema
>;

/** Structurally matches the worker InvitationDeliveryRepository boundary. */
export class PostgresInvitationDeliveryRepository {
  constructor(private readonly pool: DatabasePool) {}

  async captureForDelivery(
    input: {
      readonly operationId: string;
      readonly invitationId: string;
      readonly deliverySecretId: string;
    },
    context: DurableWorkerExecutionContext,
  ): Promise<PostgresInvitationDeliveryCapture> {
    const request = DeliveryReferenceSchema.parse(input);
    const executionContext = parseDurableWorkerExecutionContext(context, {
      jobName: WORKER_JOB_NAMES.invitationDelivery,
      operationId: request.operationId,
    });
    return withWorkerOperationTransaction(
      this.pool,
      {
        execution: executionContext.execution,
        targetType: 'invitation',
        targetId: request.invitationId,
        targetRevision: 1,
      },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select emdo.capture_invitation_delivery_secret($1::uuid, $2::uuid)
                    as delivery`,
            [request.invitationId, request.deliverySecretId],
          ),
        );
        if (row === undefined) {
          throw new WorkerPersistenceError(
            'operation-unavailable',
            'Invitation delivery reference is unavailable',
          );
        }
        const parsed = CaptureResultSchema.safeParse(row.delivery);
        if (
          !parsed.success ||
          parsed.data.invitationId !== request.invitationId ||
          parsed.data.deliverySecretId !== request.deliverySecretId
        ) {
          throw new WorkerPersistenceError(
            'invalid-result',
            'Canonical invitation delivery result is malformed',
          );
        }
        return deepFreeze(parsed.data);
      },
    );
  }

  async settleDelivery(
    input: {
      readonly operationId: string;
      readonly invitationId: string;
      readonly deliverySecretId: string;
      readonly disposition: 'confirmed' | 'indeterminate' | 'expired';
    },
    context: DurableWorkerExecutionContext,
  ): Promise<PostgresInvitationDeliverySettlement> {
    const request = SettlementInputSchema.parse(input);
    const executionContext = parseDurableWorkerExecutionContext(context, {
      jobName: WORKER_JOB_NAMES.invitationDelivery,
      operationId: request.operationId,
    });
    return withWorkerOperationTransaction(
      this.pool,
      {
        execution: executionContext.execution,
        targetType: 'invitation',
        targetId: request.invitationId,
        targetRevision: 1,
      },
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select emdo.settle_invitation_delivery_secret($1::uuid, $2::uuid, $3::text)
                    as settlement`,
            [
              request.invitationId,
              request.deliverySecretId,
              request.disposition,
            ],
          ),
        );
        const parsed = SettlementResultSchema.safeParse(row?.settlement);
        if (!parsed.success) {
          throw new WorkerPersistenceError(
            'invalid-result',
            'Canonical invitation delivery settlement is malformed',
          );
        }
        return deepFreeze(parsed.data);
      },
    );
  }
}
