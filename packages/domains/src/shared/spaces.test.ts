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
    expect(canReadSpace(space, { userId: 'owner-a', activeMember: true })).toBe(
      false,
    );
    expect(
      canReadSpace(space, { userId: 'member-a', activeMember: true }),
    ).toBe(true);
  });
});
