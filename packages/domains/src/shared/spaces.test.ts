import { describe, expect, it } from 'vitest';

import { canReadSpace, createSpace } from './spaces.js';

describe('space privacy', () => {
  it('does not let a household owner read another member private space', () => {
    const space = createSpace({
      id: 'space-1',
      householdId: 'household-a',
      originalOwnerUserId: 'member-a',
      visibility: 'private',
    });
    expect(
      canReadSpace(space, {
        userId: 'owner-a',
        householdId: 'household-a',
        activeMember: true,
      }),
    ).toBe(false);
    expect(
      canReadSpace(space, {
        userId: 'member-a',
        householdId: 'household-a',
        activeMember: true,
      }),
    ).toBe(true);
    expect(
      canReadSpace(space, {
        userId: 'member-a',
        householdId: 'household-b',
        activeMember: true,
      }),
    ).toBe(false);
  });

  it('requires an active same-household membership for shared spaces', () => {
    const space = createSpace({
      id: 'space-shared',
      householdId: 'household-a',
      originalOwnerUserId: 'member-a',
      visibility: 'shared',
    });
    expect(
      canReadSpace(space, {
        userId: 'member-b',
        householdId: 'household-a',
        activeMember: true,
      }),
    ).toBe(true);
    expect(
      canReadSpace(space, {
        userId: 'member-b',
        householdId: 'household-a',
        activeMember: false,
      }),
    ).toBe(false);
    expect(
      canReadSpace(space, {
        userId: 'member-b',
        householdId: 'household-b',
        activeMember: true,
      }),
    ).toBe(false);
  });

  it('fails closed for an invalid runtime visibility value', () => {
    expect(
      canReadSpace(
        {
          id: 'space-invalid',
          householdId: 'household-a',
          originalOwnerUserId: 'member-a',
          visibility: 'unknown' as 'shared',
        },
        {
          userId: 'member-b',
          householdId: 'household-a',
          activeMember: true,
        },
      ),
    ).toBe(false);
    expect(
      canReadSpace(
        {
          id: 'space-private',
          householdId: 'household-a',
          originalOwnerUserId: '',
          visibility: 'private',
        },
        {
          userId: '',
          householdId: 'household-a',
          activeMember: 'false' as never,
        },
      ),
    ).toBe(false);
  });
});
