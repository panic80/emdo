export type SpaceVisibility = 'private' | 'shared';

export interface Space {
  readonly id: string;
  readonly householdId: string;
  readonly originalOwnerUserId: string;
  readonly visibility: SpaceVisibility;
}

export interface SpaceAccessSubject {
  readonly userId: string;
  readonly householdId?: string;
  readonly activeMember: boolean;
}

const requireValue = (name: string, value: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
  return normalized;
};

export const createSpace = (input: Space): Space =>
  (() => {
    if (input.visibility !== 'private' && input.visibility !== 'shared') {
      throw new TypeError('space visibility is invalid');
    }
    return Object.freeze({
      id: requireValue('space id', input.id),
      householdId: requireValue('household id', input.householdId),
      originalOwnerUserId: requireValue(
        'original owner user id',
        input.originalOwnerUserId,
      ),
      visibility: input.visibility,
    });
  })();

/**
 * Application-level mirror of the database access rule. The role of the
 * subject is deliberately absent: household owners do not inherit access to a
 * member's private space.
 */
export const canReadSpace = (
  space: Space,
  subject: SpaceAccessSubject,
): boolean => {
  if (!subject.activeMember) {
    return false;
  }

  if (space.visibility === 'private') {
    return subject.userId === space.originalOwnerUserId;
  }

  return subject.householdId === space.householdId;
};
