import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ApiProblem, serviceContractProblem } from '../problem.js';
import {
  parseRequest,
  parseServiceResponse,
  prepareAuthenticatedMutation,
  requirePrincipal,
  takePreparedMutation,
} from '../request-context.js';
import {
  HouseholdInvitationIssueRequestSchema,
  HouseholdInvitationIssueResponseSchema,
  HouseholdInvitationListResponseSchema,
  HouseholdInvitationParamsSchema,
  HouseholdInvitationRevokeResponseSchema,
  HouseholdMembershipDeactivationResponseSchema,
  HouseholdMembershipListResponseSchema,
  HouseholdMembershipMutationResponseSchema,
  HouseholdMembershipParamsSchema,
  HouseholdMembershipRoleRequestSchema,
  HouseholdVersionedMutationRequestSchema,
} from '../schemas.js';
import type {
  ApiServices,
  AuthenticatedPrincipal,
} from '../services/contracts.js';

type HouseholdAdministrationErrorCode =
  | 'authorization-revoked'
  | 'conflict'
  | 'self-lockout'
  | 'last-owner-required'
  | 'invalid-input'
  | 'invalid-result';

const errorCode = (error: unknown): string | undefined =>
  error !== null &&
  typeof error === 'object' &&
  'code' in error &&
  typeof error.code === 'string'
    ? error.code
    : undefined;

const householdAdministrationProblem = (
  error: unknown,
): ApiProblem | undefined => {
  const code = errorCode(error) as HouseholdAdministrationErrorCode | undefined;
  switch (code) {
    case 'authorization-revoked':
      return new ApiProblem({
        status: 403,
        code,
        title: 'Owner authority unavailable',
        detail: 'Current household owner authority is required.',
      });
    case 'conflict':
      return new ApiProblem({
        status: 409,
        code,
        title: 'Household state changed',
        detail: 'Refresh the household state and try the operation again.',
      });
    case 'self-lockout':
      return new ApiProblem({
        status: 409,
        code,
        title: 'Owner lockout prevented',
        detail: 'The operation would remove your current owner authority.',
      });
    case 'last-owner-required':
      return new ApiProblem({
        status: 409,
        code,
        title: 'Active owner required',
        detail: 'The household must retain at least one active owner.',
      });
    case 'invalid-input':
      return new ApiProblem({
        status: 400,
        code,
        title: 'Invalid household operation',
        detail: 'The household administration request is invalid.',
      });
    case 'invalid-result':
      return new ApiProblem({
        status: 503,
        code,
        title: 'Household administration unavailable',
        detail: 'The household operation could not be completed safely.',
      });
    default:
      return undefined;
  }
};

const invokeHouseholdAdministration = async <Result>(
  operation: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    throw householdAdministrationProblem(error) ?? error;
  }
};

const requireOwner = (
  principal: AuthenticatedPrincipal,
): AuthenticatedPrincipal => {
  if (principal.role !== 'owner') {
    throw new ApiProblem({
      status: 403,
      code: 'household-owner-required',
      title: 'Household owner required',
      detail: 'Only a current household owner may administer the household.',
    });
  }
  return principal;
};

type HouseholdAdministrationPrincipal = Omit<
  AuthenticatedPrincipal,
  'privateSpaceId'
>;

const householdAdministrationPrincipal = (
  principal: AuthenticatedPrincipal,
): HouseholdAdministrationPrincipal =>
  Object.freeze({
    collectionAuthorizationScopeFingerprint:
      principal.collectionAuthorizationScopeFingerprint,
    emailVerified: principal.emailVerified,
    householdId: principal.householdId,
    role: principal.role,
    sessionId: principal.sessionId,
    spaceAccessGrantId: principal.spaceAccessGrantId,
    userId: principal.userId,
  });

export const registerHouseholdAdministrationRoutes = (
  app: FastifyInstance,
  services: ApiServices,
  maximumJsonBodyBytes: number,
): void => {
  const prepareOwnerMutation = async (request: FastifyRequest) =>
    prepareAuthenticatedMutation(request, services);

  app.post(
    '/api/v1/household/invitations',
    {
      bodyLimit: maximumJsonBodyBytes,
      onRequest: prepareOwnerMutation,
    },
    async (request, reply) => {
      const prepared = takePreparedMutation(request);
      const principal = householdAdministrationPrincipal(
        requireOwner(prepared.principal),
      );
      const input = parseRequest(
        HouseholdInvitationIssueRequestSchema,
        request.body,
      );
      const result = parseServiceResponse(
        HouseholdInvitationIssueResponseSchema,
        await invokeHouseholdAdministration(() =>
          services.householdAdministration.issueInvitation({
            email: input.email,
            role: input.role,
            expiresInSeconds: input.expiresInSeconds,
            principal,
            requestId: request.id,
            idempotencyKey: prepared.idempotencyKey,
          }),
        ),
      );
      if (
        result.invitation.email !== input.email ||
        result.invitation.role !== input.role
      ) {
        throw serviceContractProblem();
      }
      return reply.status(201).send(result);
    },
  );

  app.get('/api/v1/household/invitations', async (request, reply) => {
    const principal = householdAdministrationPrincipal(
      requireOwner(await requirePrincipal(request, services)),
    );
    const result = parseServiceResponse(
      HouseholdInvitationListResponseSchema,
      await invokeHouseholdAdministration(() =>
        services.householdAdministration.listInvitations({
          principal,
          requestId: request.id,
        }),
      ),
    );
    return reply.send(result);
  });

  app.post(
    '/api/v1/household/invitations/:id/revoke',
    {
      bodyLimit: maximumJsonBodyBytes,
      onRequest: prepareOwnerMutation,
    },
    async (request, reply) => {
      const prepared = takePreparedMutation(request);
      const principal = householdAdministrationPrincipal(
        requireOwner(prepared.principal),
      );
      const { id: invitationId } = parseRequest(
        HouseholdInvitationParamsSchema,
        request.params,
      );
      const input = parseRequest(
        HouseholdVersionedMutationRequestSchema,
        request.body,
      );
      const result = parseServiceResponse(
        HouseholdInvitationRevokeResponseSchema,
        await invokeHouseholdAdministration(() =>
          services.householdAdministration.revokeInvitation({
            invitationId,
            expectedVersion: input.expectedVersion,
            principal,
            requestId: request.id,
            idempotencyKey: prepared.idempotencyKey,
          }),
        ),
      );
      if (
        result.invitation.id !== invitationId ||
        result.invitation.version !== input.expectedVersion + 1
      ) {
        throw serviceContractProblem();
      }
      return reply.send(result);
    },
  );

  app.get('/api/v1/household/memberships', async (request, reply) => {
    const principal = householdAdministrationPrincipal(
      requireOwner(await requirePrincipal(request, services)),
    );
    const result = parseServiceResponse(
      HouseholdMembershipListResponseSchema,
      await invokeHouseholdAdministration(() =>
        services.householdAdministration.listMemberships({
          principal,
          requestId: request.id,
        }),
      ),
    );
    return reply.send(result);
  });

  app.patch(
    '/api/v1/household/memberships/:id/role',
    {
      bodyLimit: maximumJsonBodyBytes,
      onRequest: prepareOwnerMutation,
    },
    async (request, reply) => {
      const prepared = takePreparedMutation(request);
      const principal = householdAdministrationPrincipal(
        requireOwner(prepared.principal),
      );
      const { id: membershipId } = parseRequest(
        HouseholdMembershipParamsSchema,
        request.params,
      );
      const input = parseRequest(
        HouseholdMembershipRoleRequestSchema,
        request.body,
      );
      const result = parseServiceResponse(
        HouseholdMembershipMutationResponseSchema,
        await invokeHouseholdAdministration(() =>
          services.householdAdministration.changeMembershipRole({
            membershipId,
            expectedVersion: input.expectedVersion,
            role: input.role,
            principal,
            requestId: request.id,
            idempotencyKey: prepared.idempotencyKey,
          }),
        ),
      );
      if (
        result.membership.id !== membershipId ||
        result.membership.role !== input.role ||
        result.membership.status !== 'active' ||
        result.membership.version !== input.expectedVersion + 1
      ) {
        throw serviceContractProblem();
      }
      return reply.send(result);
    },
  );

  app.post(
    '/api/v1/household/memberships/:id/deactivate',
    {
      bodyLimit: maximumJsonBodyBytes,
      onRequest: prepareOwnerMutation,
    },
    async (request, reply) => {
      const prepared = takePreparedMutation(request);
      const principal = householdAdministrationPrincipal(
        requireOwner(prepared.principal),
      );
      const { id: membershipId } = parseRequest(
        HouseholdMembershipParamsSchema,
        request.params,
      );
      const input = parseRequest(
        HouseholdVersionedMutationRequestSchema,
        request.body,
      );
      const result = parseServiceResponse(
        HouseholdMembershipDeactivationResponseSchema,
        await invokeHouseholdAdministration(() =>
          services.householdAdministration.deactivateMembership({
            membershipId,
            expectedVersion: input.expectedVersion,
            principal,
            requestId: request.id,
            idempotencyKey: prepared.idempotencyKey,
          }),
        ),
      );
      if (
        result.membership.id !== membershipId ||
        result.membership.version !== input.expectedVersion + 1
      ) {
        throw serviceContractProblem();
      }
      return reply.send(result);
    },
  );
};
