import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  ProposalQueryCursorCodec,
  ProposalQueryCursorCodecError,
  type ProposalQueryCursorHmacKey,
  type ProposalQueryCursorPreviousHmacKey,
} from './proposal-query-cursor-codec.js';

const ids = {
  user: '96000000-0000-4000-8000-000000000001',
  session: '96000000-0000-4000-8000-000000000002',
  household: '96000000-0000-4000-8000-000000000003',
  otherUser: '96000000-0000-4000-8000-000000000004',
  otherSession: '96000000-0000-4000-8000-000000000005',
  otherHousehold: '96000000-0000-4000-8000-000000000006',
  proposal: '96000000-0000-4000-8000-000000000007',
  otherProposal: '96000000-0000-4000-8000-000000000008',
} as const;

const now = new Date('2026-08-10T14:00:00.000Z');
const currentKey: ProposalQueryCursorHmacKey = {
  keyId: 'proposal-cursor-2026-08-b',
  secret: new Uint8Array(32).fill(2),
};
const previousKey: ProposalQueryCursorPreviousHmacKey = {
  keyId: 'proposal-cursor-2026-08-a',
  secret: new Uint8Array(32).fill(1),
  issueUntil: '2026-08-10T13:59:30.000Z',
  verifyUntil: '2026-08-10T14:05:00.000Z',
};
const scope = 'a'.repeat(64);
const binding = {
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  authorizationScopeFingerprint: scope,
  state: 'pending' as const,
  position: {
    createdAt: '2026-08-10T13:59:00.000Z',
    id: ids.proposal,
  },
};
const expectedBinding = {
  userId: binding.userId,
  sessionId: binding.sessionId,
  householdId: binding.householdId,
  authorizationScopeFingerprint: binding.authorizationScopeFingerprint,
  state: binding.state,
};

const codec = (
  overrides: {
    current?: ProposalQueryCursorHmacKey;
    previous?: readonly ProposalQueryCursorPreviousHmacKey[];
    clock?: () => Date;
    cursorLifetimeMs?: number;
  } = {},
) =>
  new ProposalQueryCursorCodec({
    current: overrides.current ?? currentKey,
    previous: overrides.previous ?? [previousKey],
    clock: overrides.clock ?? (() => now),
    cursorLifetimeMs: overrides.cursorLifetimeMs ?? 300_000,
  });

describe('ProposalQueryCursorCodec', () => {
  it('issues a bounded authenticated cursor and verifies its exact scope/filter/position', () => {
    const cursor = codec().issue(binding);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]{32,512}$/u);
    expect(codec().verify(cursor, expectedBinding)).toEqual({
      position: binding.position,
    });
  });

  it('serializes no principal, authorization-scope, or filter material', () => {
    const cursor = codec().issue(binding);
    const decodedText = Buffer.from(cursor, 'base64url').toString('utf8');

    for (const forbidden of [
      ids.user,
      ids.user.replaceAll('-', ''),
      ids.session,
      ids.session.replaceAll('-', ''),
      ids.household,
      ids.household.replaceAll('-', ''),
      scope,
      binding.state,
    ]) {
      expect(decodedText).not.toContain(forbidden);
    }
    expect(decodedText).toContain(ids.proposal.replaceAll('-', ''));
  });

  it('issues new cursors with the current key only', () => {
    const decoded = JSON.parse(
      Buffer.from(codec().issue(binding), 'base64url').toString('utf8'),
    ) as unknown[];

    expect(decoded[1]).toBe(currentKey.keyId);
    expect(decoded[1]).not.toBe(previousKey.keyId);
  });

  it('rejects tampering with the signed stable keyset tuple', () => {
    const cursor = codec().issue(binding);
    const decoded = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as unknown[];
    decoded[4] = ids.otherProposal.replaceAll('-', '');
    const tampered = Buffer.from(JSON.stringify(decoded)).toString('base64url');

    expect(() => codec().verify(tampered, expectedBinding)).toThrowError(
      expect.objectContaining<Partial<ProposalQueryCursorCodecError>>({
        code: 'integrity-check-failed',
      }),
    );
  });

  it.each([
    ['user', { userId: ids.otherUser }],
    ['session', { sessionId: ids.otherSession }],
    ['household', { householdId: ids.otherHousehold }],
    ['authorization scope', { authorizationScopeFingerprint: 'b'.repeat(64) }],
    ['state filter', { state: 'approved' as const }],
  ])('rejects cross-%s cursor replay', (_name, changed) => {
    const cursor = codec().issue(binding);

    expect(() =>
      codec().verify(cursor, { ...expectedBinding, ...changed }),
    ).toThrowError(
      expect.objectContaining<Partial<ProposalQueryCursorCodecError>>({
        code: 'integrity-check-failed',
      }),
    );
  });

  it('rejects an expired cursor before a database query can reuse it', () => {
    const cursor = codec().issue(binding);
    const expired = codec({
      previous: [],
      clock: () => new Date('2026-08-10T14:05:00.001Z'),
    });

    expect(() => expired.verify(cursor, expectedBinding)).toThrowError(
      expect.objectContaining<Partial<ProposalQueryCursorCodecError>>({
        code: 'expired',
      }),
    );
  });

  it('verifies a previous-key cursor through grace, then fails after retirement or with a wrong secret', () => {
    const oldCodec = codec({
      current: {
        keyId: previousKey.keyId,
        secret: previousKey.secret,
      },
      previous: [],
      clock: () => new Date(previousKey.issueUntil),
    });
    const cursor = oldCodec.issue(binding);

    expect(codec().verify(cursor, expectedBinding)).toEqual({
      position: binding.position,
    });
    expect(() =>
      codec({ previous: [] }).verify(cursor, expectedBinding),
    ).toThrowError(
      expect.objectContaining<Partial<ProposalQueryCursorCodecError>>({
        code: 'key-unavailable',
      }),
    );
    expect(() =>
      codec({
        current: {
          keyId: previousKey.keyId,
          secret: new Uint8Array(32).fill(9),
        },
        previous: [],
      }).verify(cursor, expectedBinding),
    ).toThrowError(
      expect.objectContaining<Partial<ProposalQueryCursorCodecError>>({
        code: 'integrity-check-failed',
      }),
    );
  });

  it('accepts a previous-key cursor issued at issueUntil and rejects one issued after it', () => {
    const oldCodecAt = (issuedAt: string) =>
      codec({
        current: {
          keyId: previousKey.keyId,
          secret: previousKey.secret,
        },
        previous: [],
        clock: () => new Date(issuedAt),
      });
    const atBoundary = oldCodecAt(previousKey.issueUntil).issue(binding);
    const afterBoundary = oldCodecAt('2026-08-10T13:59:30.001Z').issue(binding);

    expect(codec().verify(atBoundary, expectedBinding)).toEqual({
      position: binding.position,
    });
    expect(() => codec().verify(afterBoundary, expectedBinding)).toThrowError(
      expect.objectContaining<Partial<ProposalQueryCursorCodecError>>({
        code: 'key-unavailable',
      }),
    );
  });

  it('requires finite retirement bounds and full TTL plus clock-skew grace', () => {
    const invalidPrevious: readonly unknown[] = [
      { ...previousKey, issueUntil: undefined },
      { ...previousKey, issueUntil: 'not-a-date' },
      { ...previousKey, verifyUntil: 'not-a-date' },
      {
        ...previousKey,
        issueUntil: '2026-08-10T13:50:00.000Z',
        verifyUntil: '2026-08-10T14:00:00.000Z',
      },
      {
        ...previousKey,
        verifyUntil: '2026-08-10T14:04:59.999Z',
      },
    ];

    for (const candidate of invalidPrevious) {
      expect(
        () =>
          new ProposalQueryCursorCodec({
            current: currentKey,
            previous: [candidate as ProposalQueryCursorPreviousHmacKey],
            clock: () => now,
            cursorLifetimeMs: 300_000,
          }),
      ).toThrowError(
        expect.objectContaining<Partial<ProposalQueryCursorCodecError>>({
          code: 'invalid-config',
        }),
      );
    }

    expect(
      () =>
        new ProposalQueryCursorCodec({
          current: currentKey,
          previous: [previousKey],
          clock: () => now,
          cursorLifetimeMs: 300_000,
        }),
    ).not.toThrow();
    expect(
      () =>
        new ProposalQueryCursorCodec({
          current: currentKey,
          previous: [
            {
              ...previousKey,
              verifyUntil: '2026-08-10T14:01:00.000Z',
            },
          ],
          clock: () => now,
          cursorLifetimeMs: 60_000,
        }),
    ).not.toThrow();
  });

  it('fails closed when the runtime clock becomes non-finite', () => {
    for (const nonFiniteTime of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      let clockValue = now.getTime();
      const runtimeCodec = codec({
        previous: [],
        clock: () => ({ getTime: () => clockValue }) as Date,
      });
      const cursor = runtimeCodec.issue(binding);
      clockValue = nonFiniteTime;

      expect(() => runtimeCodec.issue(binding)).toThrow(
        ProposalQueryCursorCodecError,
      );
      expect(() => runtimeCodec.verify(cursor, expectedBinding)).toThrow(
        ProposalQueryCursorCodecError,
      );
    }
  });

  it('snapshots previous retirement bounds so runtime mutation cannot extend them', () => {
    const mutablePrevious = { ...previousKey };
    let clockValue = now.getTime();
    const rotatingCodec = codec({
      previous: [mutablePrevious],
      clock: () => new Date(clockValue),
    });
    const oldCursor = codec({
      current: {
        keyId: previousKey.keyId,
        secret: previousKey.secret,
      },
      previous: [],
      clock: () => new Date(previousKey.issueUntil),
    }).issue(binding);
    mutablePrevious.issueUntil = 'not-a-date';
    mutablePrevious.verifyUntil = '9999-12-31T23:59:59.999Z';
    clockValue = Date.parse(previousKey.verifyUntil);

    expect(() => rotatingCodec.verify(oldCursor, expectedBinding)).toThrowError(
      expect.objectContaining<Partial<ProposalQueryCursorCodecError>>({
        code: 'key-unavailable',
      }),
    );
  });

  it('rejects weak, ambiguous, oversized, and under-grace key rings', () => {
    const invalid = [
      {
        current: { ...currentKey, secret: new Uint8Array(31) },
        previous: [],
      },
      {
        current: currentKey,
        previous: [{ ...previousKey, keyId: currentKey.keyId }],
      },
      {
        current: currentKey,
        previous: [previousKey, previousKey, previousKey],
      },
      {
        current: currentKey,
        previous: [
          {
            ...previousKey,
            verifyUntil: '2026-08-10T14:04:59.999Z',
          },
        ],
      },
    ] as const;

    for (const options of invalid) {
      expect(
        () =>
          new ProposalQueryCursorCodec({
            ...options,
            clock: () => now,
            cursorLifetimeMs: 300_000,
          }),
      ).toThrow(ProposalQueryCursorCodecError);
    }
  });
});
