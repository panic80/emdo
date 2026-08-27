import { Buffer } from 'node:buffer';

import { UuidSchema } from '@emdo/contracts';
import { z } from 'zod';

import type { InvitationDeliverySecretSealer } from '@emdo/db/api';

import type {
  AuthenticatedPrincipal,
  HouseholdAdministrationGateway,
} from '../services/contracts.js';

const SYNTHETIC_FINANCE_MEMBER_EMAIL = 'finance-staging-member@emdo.invalid';

const SyntheticFinanceStagingConfigurationSchema = z.strictObject({
  allowLoopbackApiIngress: z.literal('true'),
  environment: z.literal('staging'),
  financeSyntheticStaging: z.literal('true'),
  syntheticDataOnly: z.literal('true'),
});

const SyntheticMemberInvitationSchema = z.strictObject({
  email: z.literal(SYNTHETIC_FINANCE_MEMBER_EMAIL),
  role: z.literal('member'),
});

const SyntheticInvitationTokenSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u);

type HandoffRecord = Readonly<{
  readonly householdId: string;
  readonly sessionId: string;
  readonly tokenBytes: Uint8Array;
  readonly userId: string;
}>;

const sameOwnerSession = (
  record: HandoffRecord,
  principal: AuthenticatedPrincipal,
): boolean =>
  principal.role === 'owner' &&
  principal.userId === record.userId &&
  principal.sessionId === record.sessionId &&
  principal.householdId === record.householdId;

const isSyntheticMemberInvitation = (input: {
  readonly email: string;
  readonly role: 'owner' | 'member';
}): boolean => SyntheticMemberInvitationSchema.safeParse(input).success;

/**
 * A process-local handoff for the one Finance-staging synthetic invitation.
 * It is deliberately absent unless every staging gate is enabled, captures no
 * data durably, and destroys the token bytes before a second retrieval could
 * observe them.
 */
export interface SyntheticFinanceInvitationHandoff {
  readonly take: (input: {
    readonly invitationId: string;
    readonly principal: AuthenticatedPrincipal;
  }) => { readonly invitationToken: string } | undefined;
  readonly wrapHouseholdAdministration: (
    gateway: HouseholdAdministrationGateway,
  ) => HouseholdAdministrationGateway;
  readonly wrapSealer: (
    sealer: InvitationDeliverySecretSealer,
  ) => InvitationDeliverySecretSealer;
}

export const createSyntheticFinanceInvitationHandoff = (
  environment: Readonly<Record<string, string | undefined>>,
): SyntheticFinanceInvitationHandoff | undefined => {
  const configuration = SyntheticFinanceStagingConfigurationSchema.safeParse({
    allowLoopbackApiIngress: environment.EMDO_ALLOW_LOOPBACK_API_INGRESS,
    environment: environment.EMDO_ENVIRONMENT,
    financeSyntheticStaging: environment.EMDO_FINANCE_SYNTHETIC_STAGING,
    syntheticDataOnly: environment.EMDO_SYNTHETIC_DATA_ONLY,
  });
  if (!configuration.success) return undefined;

  const captured = new Map<string, Uint8Array>();
  const available = new Map<string, HandoffRecord>();

  const discard = (invitationId: string): void => {
    const capturedToken = captured.get(invitationId);
    captured.delete(invitationId);
    capturedToken?.fill(0);
    const availableRecord = available.get(invitationId);
    available.delete(invitationId);
    availableRecord?.tokenBytes.fill(0);
  };

  const wrapSealer: SyntheticFinanceInvitationHandoff['wrapSealer'] = (
    sealer,
  ) =>
    Object.freeze({
      seal: async (
        input: Parameters<InvitationDeliverySecretSealer['seal']>[0],
      ) => {
        const matchingInvitation = isSyntheticMemberInvitation({
          email: input.binding.recipient,
          role: input.binding.role,
        });
        let tokenBytes: Uint8Array | undefined;
        if (matchingInvitation) {
          tokenBytes = new Uint8Array(input.secret);
          const token = Buffer.from(tokenBytes).toString('ascii');
          if (!SyntheticInvitationTokenSchema.safeParse(token).success) {
            tokenBytes.fill(0);
            throw new Error('Synthetic invitation handoff token is invalid');
          }
          if (captured.size > 0 || available.size > 0) {
            tokenBytes.fill(0);
            throw new Error('Synthetic invitation handoff is already occupied');
          }
        }
        try {
          const envelope = await sealer.seal(input);
          if (tokenBytes !== undefined) {
            captured.set(input.binding.invitationId, tokenBytes);
            tokenBytes = undefined;
          }
          return envelope;
        } finally {
          tokenBytes?.fill(0);
        }
      },
    });

  const wrapHouseholdAdministration: SyntheticFinanceInvitationHandoff['wrapHouseholdAdministration'] =
    (gateway) =>
      Object.freeze({
        ...gateway,
        issueInvitation: async (
          input: Parameters<
            HouseholdAdministrationGateway['issueInvitation']
          >[0],
        ) => {
          const matchingInvitation = isSyntheticMemberInvitation({
            email: input.email,
            role: input.role,
          });
          let result: Awaited<
            ReturnType<HouseholdAdministrationGateway['issueInvitation']>
          >;
          try {
            result = await gateway.issueInvitation(input);
          } catch (error) {
            if (matchingInvitation) {
              for (const invitationId of captured.keys()) discard(invitationId);
            }
            throw error;
          }
          if (!matchingInvitation) return result;
          const invitationId = UuidSchema.parse(result.invitation.id);
          const tokenBytes = captured.get(invitationId);
          if (
            result.replayed ||
            result.invitation.email !== SYNTHETIC_FINANCE_MEMBER_EMAIL ||
            result.invitation.role !== 'member' ||
            tokenBytes === undefined
          ) {
            discard(invitationId);
            throw new Error(
              'Synthetic invitation handoff binding is unavailable',
            );
          }
          captured.delete(invitationId);
          available.set(
            invitationId,
            Object.freeze({
              householdId: input.principal.householdId,
              sessionId: input.principal.sessionId,
              tokenBytes,
              userId: input.principal.userId,
            }),
          );
          return result;
        },
      });

  return Object.freeze({
    take: (input: {
      readonly invitationId: string;
      readonly principal: AuthenticatedPrincipal;
    }) => {
      const invitationId = UuidSchema.safeParse(input.invitationId);
      if (!invitationId.success) return undefined;
      const record = available.get(invitationId.data);
      if (record === undefined || !sameOwnerSession(record, input.principal)) {
        return undefined;
      }
      // Delete and zero the durable reference before constructing the one
      // loopback response. A transport failure therefore cannot replay it.
      available.delete(invitationId.data);
      const invitationToken = Buffer.from(record.tokenBytes).toString('ascii');
      record.tokenBytes.fill(0);
      if (!SyntheticInvitationTokenSchema.safeParse(invitationToken).success) {
        return undefined;
      }
      return Object.freeze({ invitationToken });
    },
    wrapHouseholdAdministration,
    wrapSealer,
  });
};
