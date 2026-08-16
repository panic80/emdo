import { UuidSchema, deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

import { SyncTokenService } from './token.js';

const SyncStreamRequestSchema = z
  .strictObject({
    resource: z.enum(['global', 'household-metadata', 'space-records']),
    spaceId: UuidSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.resource === 'space-records' && value.spaceId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['spaceId'],
        message: 'A space stream requires a space ID',
      });
    }
    if (value.resource !== 'space-records' && value.spaceId !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['spaceId'],
        message: 'This stream cannot select a space',
      });
    }
  });

export type SyncStreamErrorCode =
  'invalid-stream-request' | 'global-stream-denied' | 'space-not-readable';

export class SyncStreamError extends Error {
  constructor(
    readonly code: SyncStreamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SyncStreamError';
  }
}

export interface AuthorizedSyncStream {
  readonly streamName: string;
  readonly resource: 'household-metadata' | 'space-records';
  readonly householdId: string;
  readonly spaceId?: string;
  readonly predicate: {
    readonly sql: string;
    readonly parameters: readonly string[];
  };
}

export class SyncStreamAuthorizer {
  constructor(private readonly tokens: SyncTokenService) {}

  authorize(token: string, request: unknown): AuthorizedSyncStream {
    const parsed = SyncStreamRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new SyncStreamError(
        'invalid-stream-request',
        'Sync stream request is malformed',
      );
    }
    if (parsed.data.resource === 'global') {
      throw new SyncStreamError(
        'global-stream-denied',
        'Global synchronization streams are unavailable',
      );
    }

    const claims = this.tokens.verify(token);
    if (parsed.data.resource === 'household-metadata') {
      return deepFreeze({
        streamName: `household:${claims.householdId}:metadata`,
        resource: 'household-metadata' as const,
        householdId: claims.householdId,
        predicate: {
          sql: 'household_id = $1',
          parameters: [claims.householdId],
        },
      });
    }

    const spaceId = parsed.data.spaceId;
    const space = claims.spaces.find((candidate) => candidate.id === spaceId);
    if (space === undefined) {
      throw new SyncStreamError(
        'space-not-readable',
        'The requested space is not readable in this sync scope',
      );
    }
    const isPrivate = space.visibility === 'private';
    return deepFreeze({
      streamName: `household:${claims.householdId}:space:${space.id}`,
      resource: 'space-records' as const,
      householdId: claims.householdId,
      spaceId: space.id,
      predicate: isPrivate
        ? {
            sql: 'household_id = $1 AND space_id = $2 AND original_owner_user_id = $3',
            parameters: [claims.householdId, space.id, claims.userId],
          }
        : {
            sql: 'household_id = $1 AND space_id = $2',
            parameters: [claims.householdId, space.id],
          },
    });
  }
}
