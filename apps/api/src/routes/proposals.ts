import type { FastifyInstance } from 'fastify';

import {
  ApiProblem,
  serviceContractProblem,
  validationProblem,
} from '../problem.js';
import {
  parseRequest,
  parseServiceResponse,
  prepareAuthenticatedMutation,
  requirePrincipal,
  requireVisualProofToken,
  takePreparedMutation,
} from '../request-context.js';
import {
  ActionDecisionReceiptSchema,
  ActionDecisionRequestSchema,
  ProposalApprovalViewSchema,
  ProposalEmptyQuerySchema,
  ProposalListQuerySchema,
  ProposalListQueryResultSchema,
  ProposalListResponseSchema,
  ProposalParamsSchema,
  VisualProofIssueRequestSchema,
  VisualProofIssueResultSchema,
  VisualProposalDecisionResultSchema,
} from '../schemas.js';
import type { ApiServices } from '../services/contracts.js';

const proposalNotFound = () =>
  new ApiProblem({
    status: 404,
    code: 'proposal-not-found',
    title: 'Proposal not found',
    detail: 'The proposal is not available to this authenticated session.',
  });

const proposalCursorInvalid = () =>
  new ApiProblem({
    status: 400,
    code: 'proposal-cursor-invalid',
    title: 'Invalid proposal cursor',
    detail: 'Start again from the first proposal page.',
  });

const parseProposalListQuery = (input: unknown) => {
  const parsed = ProposalListQuerySchema.safeParse(input);
  if (parsed.success) return parsed.data;
  if (parsed.error.issues.some((issue) => issue.path[0] === 'cursor')) {
    throw proposalCursorInvalid();
  }
  throw validationProblem(parsed.error);
};

const proofIssueProblem = (status: string): ApiProblem => {
  if (status === 'proposal-not-found') return proposalNotFound();
  if (status === 'idempotency-conflict') {
    return new ApiProblem({
      status: 409,
      code: 'idempotency-key-conflict',
      title: 'Idempotency key conflict',
      detail: 'The idempotency key is already bound to another proof request.',
    });
  }
  if (status === 'proposal-expired') {
    return new ApiProblem({
      status: 409,
      code: 'proposal-expired',
      title: 'Proposal expired',
      detail: 'Refresh the proposal before making a decision.',
    });
  }
  if (status === 'proposal-not-pending') {
    return new ApiProblem({
      status: 409,
      code: 'proposal-not-pending',
      title: 'Proposal is not pending',
      detail: 'Only a current pending proposal can receive a visual proof.',
    });
  }
  return new ApiProblem({
    status: 409,
    code: 'proposal-not-current',
    title: 'Proposal changed',
    detail: 'Refresh and review the current proposal before deciding.',
  });
};

const decisionProblem = (status: string): ApiProblem => {
  if (status === 'proposal-not-found') return proposalNotFound();
  if (status === 'visual-proof-invalid') {
    return new ApiProblem({
      status: 403,
      code: 'visual-proof-invalid',
      title: 'Visual proof invalid',
      detail: 'Refresh and review the proposal before deciding.',
    });
  }
  const code =
    status === 'proposal-not-pending'
      ? 'proposal-not-pending'
      : status === 'proposal-expired'
        ? 'proposal-expired'
        : status === 'visual-proof-expired'
          ? 'visual-proof-expired'
          : status === 'visual-proof-consumed'
            ? 'visual-proof-consumed'
            : status === 'idempotency-conflict'
              ? 'idempotency-key-conflict'
              : 'proposal-not-current';
  return new ApiProblem({
    status: 409,
    code,
    title: 'Proposal decision not current',
    detail: 'Refresh and review the current proposal before deciding.',
  });
};

export const registerProposalRoutes = (
  app: FastifyInstance,
  services: ApiServices,
  maximumJsonBodyBytes: number,
): void => {
  app.get('/api/v1/proposals', async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    const query = parseProposalListQuery(request.query);
    const outcome = parseServiceResponse(
      ProposalListQueryResultSchema,
      await services.proposalQueries.list({
        state: query.state,
        cursor: query.cursor,
        limit: query.limit,
        principal,
        requestId: request.id,
      }),
    );
    if (outcome.status === 'invalid-cursor') {
      if (query.cursor === undefined) throw serviceContractProblem();
      throw proposalCursorInvalid();
    }
    const result = parseServiceResponse(
      ProposalListResponseSchema,
      outcome.page,
    );
    const proposalIds = new Set(result.items.map((item) => item.id));
    if (
      result.items.length > query.limit ||
      proposalIds.size !== result.items.length ||
      (query.state !== undefined &&
        result.items.some((item) => item.state !== query.state)) ||
      (query.cursor !== undefined && result.nextCursor === query.cursor)
    ) {
      throw serviceContractProblem();
    }
    return reply.header('cache-control', 'no-store').send(result);
  });

  app.get('/api/v1/proposals/:id', async (request, reply) => {
    const principal = await requirePrincipal(request, services);
    parseRequest(ProposalEmptyQuerySchema, request.query);
    const { id: proposalId } = parseRequest(
      ProposalParamsSchema,
      request.params,
    );
    const candidate = await services.proposalQueries.getDetail({
      proposalId,
      principal,
      requestId: request.id,
    });
    if (candidate === undefined) throw proposalNotFound();
    const proposal = parseServiceResponse(
      ProposalApprovalViewSchema,
      candidate,
    );
    if (proposal.id !== proposalId) throw serviceContractProblem();
    return reply.header('cache-control', 'no-store').send(proposal);
  });

  app.post(
    '/api/v1/proposals/:id/visual-proof',
    {
      bodyLimit: maximumJsonBodyBytes,
      onRequest: async (request) =>
        prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey } = takePreparedMutation(request);
      parseRequest(ProposalEmptyQuerySchema, request.query);
      const { id: proposalId } = parseRequest(
        ProposalParamsSchema,
        request.params,
      );
      const input = parseRequest(VisualProofIssueRequestSchema, request.body);
      const result = parseServiceResponse(
        VisualProofIssueResultSchema,
        await services.visualProofs.issue({
          proposalId,
          expectedProposalVersion: input.proposalVersion,
          expectedPayloadHash: input.payloadHash,
          expectedApprovalHash: input.approvalHash,
          principal,
          requestId: request.id,
          idempotencyKey,
        }),
      );
      if (result.status !== 'issued') throw proofIssueProblem(result.status);
      const now = Date.now();
      const proof = result.proof;
      if (
        proof.proposalId !== proposalId ||
        proof.proposalVersion !== input.proposalVersion ||
        proof.payloadHash !== input.payloadHash ||
        proof.approvalHash !== input.approvalHash ||
        Date.parse(proof.expiresAt) <= now ||
        Date.parse(proof.expiresAt) > now + 120_000 ||
        Date.parse(proof.issuedAt) > now + 30_000
      ) {
        throw serviceContractProblem();
      }
      return reply.header('cache-control', 'no-store').status(200).send(proof);
    },
  );

  app.post(
    '/api/v1/proposals/:id/decision',
    {
      bodyLimit: maximumJsonBodyBytes,
      onRequest: async (request) =>
        prepareAuthenticatedMutation(request, services),
    },
    async (request, reply) => {
      const { principal, idempotencyKey: headerIdempotencyKey } =
        takePreparedMutation(request);
      parseRequest(ProposalEmptyQuerySchema, request.query);
      const { id: proposalId } = parseRequest(
        ProposalParamsSchema,
        request.params,
      );
      const input = parseRequest(ActionDecisionRequestSchema, request.body);
      if (input.proposalId !== proposalId) {
        throw new ApiProblem({
          status: 409,
          code: 'proposal-binding-mismatch',
          title: 'Proposal binding mismatch',
          detail: 'The proposal path and decision body do not match.',
        });
      }
      if (input.idempotencyKey !== headerIdempotencyKey) {
        throw new ApiProblem({
          status: 409,
          code: 'idempotency-key-mismatch',
          title: 'Idempotency key mismatch',
          detail: 'The Idempotency-Key header and decision body do not match.',
        });
      }
      const visualProofToken = requireVisualProofToken(request);
      const result = parseServiceResponse(
        VisualProposalDecisionResultSchema,
        await services.proposals.decideWithVisualProof({
          request: input,
          visualProofToken,
          principal,
          requestId: request.id,
        }),
      );
      if (result.status !== 'decided') throw decisionProblem(result.status);
      const decision = result.decision;
      if (
        decision.proposalId !== input.proposalId ||
        decision.userId !== principal.userId ||
        decision.authenticatedSessionId !== principal.sessionId ||
        decision.payloadHash !== input.payloadHash ||
        decision.approvalHash !== input.approvalHash ||
        decision.decision !== input.decision ||
        decision.idempotencyKey !== input.idempotencyKey ||
        decision.channel !== 'authenticated-visual'
      ) {
        throw serviceContractProblem();
      }
      const receipt = parseServiceResponse(ActionDecisionReceiptSchema, {
        schemaVersion: decision.schemaVersion,
        id: decision.id,
        proposalId: decision.proposalId,
        payloadHash: decision.payloadHash,
        approvalHash: decision.approvalHash,
        decision: decision.decision,
        channel: decision.channel,
        decidedAt: decision.decidedAt,
        idempotencyKey: decision.idempotencyKey,
      });
      return reply
        .header('cache-control', 'no-store')
        .status(200)
        .send(receipt);
    },
  );
};
