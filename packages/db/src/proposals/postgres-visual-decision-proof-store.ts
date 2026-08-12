import { createHash } from 'node:crypto';

import {
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
} from '@emdo/contracts';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import {
  firstResultRow,
  parseDurablePrincipal,
  withClaimedTransaction,
} from '../durable/scoped-transaction.js';
import {
  PostgresProposalApprovalError,
  type ProposalApiPrincipal,
} from './postgres-proposal-query-repository.js';
import {
  VisualDecisionProofTokenCodecError,
  type VisualDecisionProofTokenBinding,
  type VisualDecisionProofTokenCodec,
} from './visual-decision-proof-token-codec.js';
import { checkDatabaseFunctionPrivileges } from './database-function-readiness.js';

export { PostgresProposalApprovalError } from './postgres-proposal-query-repository.js';

const ProofTokenSchema = z
  .string()
  .min(32)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u);
const NonceSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const KeyIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);
const PrincipalSchema = z.object({
  userId: UuidSchema,
  sessionId: UuidSchema,
  householdId: UuidSchema,
  spaceAccessGrantId: UuidSchema,
});
const IssueInputSchema = z.strictObject({
  proposalId: UuidSchema,
  expectedProposalVersion: z.number().int().positive().safe(),
  expectedPayloadHash: Sha256Schema,
  expectedApprovalHash: Sha256Schema,
  principal: PrincipalSchema,
  requestId: UuidSchema,
  idempotencyKey: IdempotencyKeySchema,
});
const IssuedProofWithoutTokenSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    proposalId: UuidSchema,
    proposalVersion: z.number().int().positive().safe(),
    payloadHash: Sha256Schema,
    approvalHash: Sha256Schema,
    issuedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    replayed: z.boolean(),
  })
  .superRefine((value, context) => {
    const lifetime = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
    if (lifetime <= 0 || lifetime > 120_000) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Visual decision proof lifetime must be at most two minutes',
      });
    }
  });
const StableBindingSchema = z.strictObject({
  bindingVersion: z.literal(1),
  issuanceFingerprint: Sha256Schema,
  authorizationScopeFingerprint: Sha256Schema,
  initialRequestId: UuidSchema,
});
const TokenSeedSchema = z.strictObject({
  proofId: UuidSchema,
  nonce: NonceSchema,
  keyId: KeyIdSchema,
});
const StoredTokenMaterialSchema = TokenSeedSchema.extend({
  tokenHash: Sha256Schema,
});
const IssueDenialSchema = z.strictObject({
  status: z.enum([
    'proposal-not-found',
    'proposal-not-pending',
    'proposal-expired',
    'proposal-binding-mismatch',
    'idempotency-conflict',
  ]),
});
const PreparedResultSchema = z.union([
  z
    .strictObject({
      status: z.literal('prepared'),
      proof: IssuedProofWithoutTokenSchema,
      proposalExpiresAt: IsoDateTimeSchema,
      binding: StableBindingSchema,
      tokenMaterial: TokenSeedSchema.extend({
        tokenHash: Sha256Schema.optional(),
      }),
    })
    .superRefine((value, context) => {
      if (
        Date.parse(value.proof.expiresAt) >
          Date.parse(value.proposalExpiresAt) ||
        (value.proof.replayed && value.tokenMaterial.tokenHash === undefined) ||
        (!value.proof.replayed && value.tokenMaterial.tokenHash !== undefined)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['tokenMaterial'],
          message: 'Prepared visual proof material is inconsistent',
        });
      }
    }),
  IssueDenialSchema,
]);
const FinalizedResultSchema = z.strictObject({
  status: z.literal('issued'),
  proof: IssuedProofWithoutTokenSchema,
  tokenMaterial: StoredTokenMaterialSchema,
});

const VISUAL_DECISION_PROOF_FUNCTIONS = Object.freeze([
  'emdo.prepare_visual_decision_proof(uuid,uuid,uuid,integer,text,text,text,uuid,text,text)',
  'emdo.finalize_visual_decision_proof(uuid,uuid,uuid,text,uuid,text,text,integer,text,text,uuid,timestamptz,timestamptz,text)',
]);

export interface IssuedVisualDecisionProof {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly payloadHash: string;
  readonly approvalHash: string;
  readonly proofToken: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly replayed: boolean;
}

export type VisualDecisionProofIssueResult =
  | Readonly<{
      status: 'issued';
      proof: Readonly<IssuedVisualDecisionProof>;
    }>
  | Readonly<{
      status:
        | 'proposal-not-found'
        | 'proposal-not-pending'
        | 'proposal-expired'
        | 'proposal-binding-mismatch'
        | 'idempotency-conflict';
    }>;

export const hashVisualDecisionProofToken = (token: string): string => {
  const parsed = ProofTokenSchema.safeParse(token);
  if (!parsed.success) {
    throw new PostgresProposalApprovalError(
      'invalid-input',
      'Visual decision proof token is malformed',
    );
  }
  return createHash('sha256').update(parsed.data).digest('hex');
};

const invalidDatabaseResult = (message: string): never => {
  throw new PostgresProposalApprovalError('invalid-result', message);
};

const parseIssueInput = (input: unknown): z.output<typeof IssueInputSchema> => {
  const parsed = IssueInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new PostgresProposalApprovalError(
      'invalid-input',
      'Visual decision proof issuance input is malformed',
    );
  }
  return parsed.data;
};

const parsePreparedResult = (
  input: unknown,
): z.output<typeof PreparedResultSchema> => {
  const parsed = PreparedResultSchema.safeParse(input);
  return parsed.success
    ? parsed.data
    : invalidDatabaseResult(
        'Database returned malformed visual proof preparation',
      );
};

const parseFinalizedResult = (
  input: unknown,
): z.output<typeof FinalizedResultSchema> => {
  const parsed = FinalizedResultSchema.safeParse(input);
  return parsed.success
    ? parsed.data
    : invalidDatabaseResult(
        'Database returned malformed visual proof finalization',
      );
};

const assertProofBinding = (
  proof: z.output<typeof IssuedProofWithoutTokenSchema>,
  input: z.output<typeof IssueInputSchema>,
): void => {
  if (
    proof.proposalId !== input.proposalId ||
    proof.proposalVersion !== input.expectedProposalVersion ||
    proof.payloadHash !== input.expectedPayloadHash ||
    proof.approvalHash !== input.expectedApprovalHash
  ) {
    invalidDatabaseResult(
      'Database returned a visual proof for a different proposal binding',
    );
  }
};

const exactProofResult = (
  left: z.output<typeof IssuedProofWithoutTokenSchema>,
  right: z.output<typeof IssuedProofWithoutTokenSchema>,
): boolean =>
  left.schemaVersion === right.schemaVersion &&
  left.proposalId === right.proposalId &&
  left.proposalVersion === right.proposalVersion &&
  left.payloadHash === right.payloadHash &&
  left.approvalHash === right.approvalHash &&
  left.issuedAt === right.issuedAt &&
  left.expiresAt === right.expiresAt &&
  left.replayed === right.replayed;

const exactStoredMaterial = (
  left: z.output<typeof StoredTokenMaterialSchema>,
  right: z.output<typeof StoredTokenMaterialSchema>,
): boolean =>
  left.proofId === right.proofId &&
  left.nonce === right.nonce &&
  left.keyId === right.keyId &&
  left.tokenHash === right.tokenHash;

/**
 * Two short SECURITY DEFINER calls run in one claimed transaction. PostgreSQL
 * first locks authority/proposal/idempotency and chooses immutable DB-clock
 * issuance fields. The application then HMAC-binds those fields and finalizes
 * only the digest. No bearer token or HMAC secret crosses the SQL boundary.
 */
export class PostgresVisualDecisionProofStore {
  constructor(
    private readonly pool: DatabasePool,
    private readonly tokenCodec: VisualDecisionProofTokenCodec,
  ) {}

  async check(): Promise<boolean> {
    return checkDatabaseFunctionPrivileges(
      this.pool,
      VISUAL_DECISION_PROOF_FUNCTIONS,
    );
  }

  async issue(input: {
    readonly proposalId: string;
    readonly expectedProposalVersion: number;
    readonly expectedPayloadHash: string;
    readonly expectedApprovalHash: string;
    readonly principal: ProposalApiPrincipal;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<VisualDecisionProofIssueResult> {
    const parsed = parseIssueInput(input);
    let candidateSeed;
    try {
      candidateSeed = this.tokenCodec.createSeed();
    } catch (error) {
      if (error instanceof VisualDecisionProofTokenCodecError) {
        throw new PostgresProposalApprovalError(
          'invalid-result',
          'Visual proof seed generation failed',
        );
      }
      throw error;
    }
    const principal = parseDurablePrincipal({
      userId: parsed.principal.userId,
      sessionId: parsed.principal.sessionId,
      requestId: parsed.requestId,
      householdId: parsed.principal.householdId,
    });

    return withClaimedTransaction(this.pool, principal, async (client) => {
      const preparedRow = firstResultRow(
        await client.query(
          `select emdo.prepare_visual_decision_proof($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as result`,
          [
            parsed.principal.householdId,
            parsed.principal.spaceAccessGrantId,
            parsed.proposalId,
            parsed.expectedProposalVersion,
            parsed.expectedPayloadHash,
            parsed.expectedApprovalHash,
            parsed.idempotencyKey,
            candidateSeed.proofId,
            candidateSeed.nonce,
            candidateSeed.keyId,
          ],
        ),
      );
      if (preparedRow === undefined) {
        return invalidDatabaseResult(
          'Database returned no visual proof preparation',
        );
      }
      const prepared = parsePreparedResult(preparedRow.result);
      if (prepared.status !== 'prepared') return deepFreeze(prepared);
      assertProofBinding(prepared.proof, parsed);
      if (
        !prepared.proof.replayed &&
        prepared.binding.initialRequestId !== parsed.requestId
      ) {
        return invalidDatabaseResult(
          'New visual proof preparation changed its initial request',
        );
      }
      if (
        !prepared.proof.replayed &&
        (prepared.tokenMaterial.proofId !== candidateSeed.proofId ||
          prepared.tokenMaterial.nonce !== candidateSeed.nonce ||
          prepared.tokenMaterial.keyId !== candidateSeed.keyId)
      ) {
        return invalidDatabaseResult(
          'New visual proof preparation changed its candidate seed',
        );
      }

      const tokenBinding: VisualDecisionProofTokenBinding = {
        ...prepared.binding,
        issuedAt: prepared.proof.issuedAt,
        expiresAt: prepared.proof.expiresAt,
        userId: parsed.principal.userId,
        sessionId: parsed.principal.sessionId,
        householdId: parsed.principal.householdId,
        proposalId: parsed.proposalId,
        proposalVersion: parsed.expectedProposalVersion,
        payloadHash: parsed.expectedPayloadHash,
        approvalHash: parsed.expectedApprovalHash,
        channel: 'authenticated-visual',
        idempotencyKey: parsed.idempotencyKey,
      };
      let proofToken: string;
      let storedMaterial: z.output<typeof StoredTokenMaterialSchema>;
      try {
        if (prepared.proof.replayed) {
          const replayMaterial = StoredTokenMaterialSchema.parse(
            prepared.tokenMaterial,
          );
          proofToken = this.tokenCodec.reproduce(replayMaterial, tokenBinding);
          storedMaterial = replayMaterial;
        } else {
          const created = this.tokenCodec.derive(
            prepared.tokenMaterial,
            tokenBinding,
          );
          proofToken = created.proofToken;
          storedMaterial = {
            proofId: created.proofId,
            nonce: created.nonce,
            keyId: created.keyId,
            tokenHash: created.tokenHash,
          };
        }
      } catch (error) {
        if (
          error instanceof VisualDecisionProofTokenCodecError ||
          error instanceof z.ZodError
        ) {
          return invalidDatabaseResult(
            'Prepared visual proof token material failed verification',
          );
        }
        throw error;
      }

      const finalizedRow = firstResultRow(
        await client.query(
          `select emdo.finalize_visual_decision_proof($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) as result`,
          [
            parsed.principal.householdId,
            parsed.principal.spaceAccessGrantId,
            parsed.proposalId,
            parsed.idempotencyKey,
            storedMaterial.proofId,
            storedMaterial.nonce,
            storedMaterial.keyId,
            prepared.binding.bindingVersion,
            prepared.binding.issuanceFingerprint,
            prepared.binding.authorizationScopeFingerprint,
            prepared.binding.initialRequestId,
            prepared.proof.issuedAt,
            prepared.proof.expiresAt,
            storedMaterial.tokenHash,
          ],
        ),
      );
      if (finalizedRow === undefined) {
        return invalidDatabaseResult(
          'Database returned no visual proof finalization',
        );
      }
      const finalized = parseFinalizedResult(finalizedRow.result);
      assertProofBinding(finalized.proof, parsed);
      if (
        !exactProofResult(finalized.proof, prepared.proof) ||
        !exactStoredMaterial(finalized.tokenMaterial, storedMaterial)
      ) {
        return invalidDatabaseResult(
          'Visual proof finalization changed immutable prepared material',
        );
      }
      return deepFreeze({
        status: 'issued' as const,
        proof: { ...finalized.proof, proofToken },
      });
    });
  }
}
