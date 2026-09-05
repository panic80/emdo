import { describe, expect, it } from 'vitest';

import { financeDocumentOriginalAssociatedData } from './aad.js';

const scope = {
  householdId: 'a1000000-0000-4000-8000-000000000001',
  privateSpaceId: 'a1000000-0000-4000-8000-000000000002',
  ownerUserId: 'a1000000-0000-4000-8000-000000000003',
};

describe('Finance document original associated data', () => {
  it('is deterministic and changes across authenticated uploader scopes', () => {
    const first = financeDocumentOriginalAssociatedData(scope);
    const replay = financeDocumentOriginalAssociatedData({ ...scope });
    const otherOwner = financeDocumentOriginalAssociatedData({
      ...scope,
      ownerUserId: 'a1000000-0000-4000-8000-000000000004',
    });

    expect(Buffer.from(first)).toEqual(Buffer.from(replay));
    expect(Buffer.from(first)).not.toEqual(Buffer.from(otherOwner));
    expect(Buffer.from(first).toString('utf8')).not.toContain('filesystem');
  });

  it('rejects caller-selected non-UUID scope material', () => {
    expect(() =>
      financeDocumentOriginalAssociatedData({
        ...scope,
        privateSpaceId: '../public',
      }),
    ).toThrow();
  });
});
