import { z } from 'zod';

import { OpaqueReferenceSchema, deepFreeze } from '@emdo/contracts';

export type SpaceVisibility = 'private' | 'shared';

const SpaceSchema = z
  .strictObject({
    id: OpaqueReferenceSchema,
    householdId: OpaqueReferenceSchema,
    originalOwnerUserId: OpaqueReferenceSchema,
    visibility: z.enum(['private', 'shared']),
  })
  .transform(deepFreeze);

const SpaceAccessSubjectSchema = z
  .strictObject({
    userId: OpaqueReferenceSchema,
    householdId: OpaqueReferenceSchema,
    activeMember: z.boolean(),
  })
  .transform(deepFreeze);

export type Space = z.input<typeof SpaceSchema>;
export type SpaceAccessSubject = z.input<typeof SpaceAccessSubjectSchema>;

export const createSpace = (input: Space): Space => SpaceSchema.parse(input);

/**
 * Application-level mirror of the database access rule. The role of the
 * subject is deliberately absent: household owners do not inherit access to a
 * member's private space.
 */
export const canReadSpace = (
  space: Space,
  subject: SpaceAccessSubject,
): boolean => {
  const parsedSpace = SpaceSchema.safeParse(space);
  const parsedSubject = SpaceAccessSubjectSchema.safeParse(subject);
  if (!parsedSpace.success || !parsedSubject.success) return false;
  const validatedSpace = parsedSpace.data;
  const validatedSubject = parsedSubject.data;

  if (
    !validatedSubject.activeMember ||
    validatedSubject.householdId !== validatedSpace.householdId
  ) {
    return false;
  }

  if (validatedSpace.visibility === 'private') {
    return validatedSubject.userId === validatedSpace.originalOwnerUserId;
  }

  if (validatedSpace.visibility === 'shared') {
    return true;
  }

  return false;
};
