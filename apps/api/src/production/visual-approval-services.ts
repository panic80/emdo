import { randomUUID } from 'node:crypto';

import {
  ActionDecisionRequestSchema,
  ProviderWriteOperationScopeSchema,
  UuidSchema,
} from '@emdo/contracts';
import {
  PostgresProposalRepository,
  checkPostgresVisualDecisionReadiness,
  type PostgresProposalRepositoryOptions,
  type ProposalRepository,
} from '@emdo/db/api';
import {
  ProposalDecisionService,
  ProposalError,
  type AuthenticatedVisualDecisionContext,
} from '@emdo/domains/server/provider-proposals';
import { z } from 'zod';

import { AuthenticatedPrincipalSchema } from '../schemas.js';
import type {
  VisualProposalDecisionGateway,
  VisualProposalDecisionResult,
} from '../services/contracts.js';

type DatabasePool = PostgresProposalRepositoryOptions['readPool'];
type DecisionService = Pick<ProposalDecisionService, 'decide'>;

interface VisualDecisionRepositoryInput {
  readonly readPool: DatabasePool;
  readonly decisionPool: DatabasePool;
  readonly principal: {
    readonly userId: string;
    readonly sessionId: string;
    readonly requestId: string;
    readonly householdId: string;
  };
  readonly currentSpaceAccessGrantId: string;
  readonly visualProofToken: string;
}

const VisualProofTokenSchema = z
  .string()
  .min(32)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u);
const DecisionGatewayInputSchema = z.strictObject({
  request: ActionDecisionRequestSchema,
  visualProofToken: VisualProofTokenSchema,
  principal: AuthenticatedPrincipalSchema,
  requestId: UuidSchema,
});

export interface VisualProposalDecisionGatewayDependencies {
  readonly checkReady: (
    readPool: DatabasePool,
    decisionPool: DatabasePool,
  ) => Promise<boolean>;
  readonly createDecisionId: () => string;
  readonly createDecisionService: (
    repository: ProposalRepository,
  ) => DecisionService;
  readonly createRepository: (
    input: VisualDecisionRepositoryInput,
  ) => ProposalRepository;
  readonly now: () => Date;
}

const defaultDependencies: VisualProposalDecisionGatewayDependencies =
  Object.freeze({
    checkReady: checkPostgresVisualDecisionReadiness,
    createDecisionId: randomUUID,
    createDecisionService: (repository: ProposalRepository) =>
      new ProposalDecisionService(repository),
    createRepository: (input: VisualDecisionRepositoryInput) =>
      new PostgresProposalRepository({
        readPool: input.readPool,
        workflowPool: input.decisionPool,
        principal: input.principal,
      }).withVisualDecisionProof(
        input.visualProofToken,
        input.currentSpaceAccessGrantId,
      ),
    now: () => new Date(),
  });

const mapProposalError = (
  error: ProposalError,
): Exclude<VisualProposalDecisionResult, { readonly status: 'decided' }> => {
  switch (error.code) {
    case 'proposal-not-found':
      return { status: 'proposal-not-found' };
    case 'proposal-not-pending':
      return { status: 'proposal-not-pending' };
    case 'proposal-expired':
      return { status: 'proposal-expired' };
    case 'proposal-idempotency-conflict':
      return { status: 'idempotency-conflict' };
    default:
      return { status: 'proposal-binding-mismatch' };
  }
};

/**
 * Request-scoped visual decision adapter. The collection cursor fingerprint is
 * intentionally ignored: the operation fingerprint is loaded from the durable
 * proposal, then the workflow aggregate independently re-derives it under the
 * request-current grant while consuming the proof and linking the resume job.
 */
export class PostgresVisualProposalDecisionGateway implements VisualProposalDecisionGateway {
  readonly #readPool: DatabasePool;
  readonly #decisionPool: DatabasePool;
  readonly #dependencies: VisualProposalDecisionGatewayDependencies;

  constructor(
    pools: {
      readonly readPool: DatabasePool;
      readonly decisionPool: DatabasePool;
    },
    dependencies: VisualProposalDecisionGatewayDependencies = defaultDependencies,
  ) {
    this.#readPool = pools.readPool;
    this.#decisionPool = pools.decisionPool;
    this.#dependencies = dependencies;
  }

  checkReady(): Promise<boolean> {
    return this.#dependencies.checkReady(this.#readPool, this.#decisionPool);
  }

  async decideWithVisualProof(
    rawInput: Parameters<
      VisualProposalDecisionGateway['decideWithVisualProof']
    >[0],
  ): Promise<VisualProposalDecisionResult> {
    const parsed = DecisionGatewayInputSchema.safeParse(rawInput);
    if (!parsed.success) return { status: 'visual-proof-invalid' };
    const input = parsed.data;
    const repository = this.#dependencies.createRepository({
      readPool: this.#readPool,
      decisionPool: this.#decisionPool,
      principal: {
        userId: input.principal.userId,
        sessionId: input.principal.sessionId,
        requestId: input.requestId,
        householdId: input.principal.householdId,
      },
      currentSpaceAccessGrantId: input.principal.spaceAccessGrantId,
      visualProofToken: input.visualProofToken,
    });
    const proposal = await repository.getProposal(input.request.proposalId);
    if (proposal === undefined) return { status: 'proposal-not-found' };
    const operationScope = ProviderWriteOperationScopeSchema.parse({
      requestId: input.requestId,
      sessionId: input.principal.sessionId,
      householdId: input.principal.householdId,
      userId: input.principal.userId,
      spaceAccessGrantId: input.principal.spaceAccessGrantId,
      authorizationScopeFingerprint: proposal.authorizationScopeFingerprint,
    });
    const context: AuthenticatedVisualDecisionContext = {
      decisionId: UuidSchema.parse(this.#dependencies.createDecisionId()),
      operationScope,
      channel: 'authenticated-visual',
      now: this.#dependencies.now(),
    };
    try {
      const decision = await this.#dependencies
        .createDecisionService(repository)
        .decide(input.request, context);
      return { status: 'decided', decision };
    } catch (error) {
      if (error instanceof ProposalError) return mapProposalError(error);
      throw error;
    }
  }
}
