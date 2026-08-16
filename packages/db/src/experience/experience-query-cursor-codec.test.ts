import { describe, expect, it } from 'vitest';

import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';

import {
  ExperienceQueryCursorCodec,
  type ExperienceQueryCursorHmacKey,
} from './experience-query-cursor-codec.js';

const ids = {
  user: '97000000-0000-4000-8000-000000000001',
  session: '97000000-0000-4000-8000-000000000002',
  household: '97000000-0000-4000-8000-000000000003',
} as const;

const now = new Date('2026-08-12T14:00:00.000Z');
const currentKey: ExperienceQueryCursorHmacKey = {
  keyId: 'experience-cursor-2026-08-b',
  secret: new Uint8Array(32).fill(2),
};
const fingerprint = EffectiveAuthorizationScopeFingerprintSchema.parse(
  'a'.repeat(64),
);
const expectedActivity = {
  userId: ids.user,
  sessionId: ids.session,
  householdId: ids.household,
  collectionAuthorizationScopeFingerprint: fingerprint,
  kind: 'activity' as const,
};
const activityBinding = {
  ...expectedActivity,
  position: {
    occurredAt: '2026-08-12T13:59:00.000Z',
    id: 'activity-1',
  },
};

describe('ExperienceQueryCursorCodec', () => {
  it('issues a bounded authenticated Activity cursor and verifies its position', () => {
    const codec = new ExperienceQueryCursorCodec({
      current: currentKey,
      clock: () => now,
    });

    const cursor = codec.issue(activityBinding);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]{32,512}$/u);
    expect(codec.verify(cursor, expectedActivity)).toEqual({
      position: activityBinding.position,
    });
  });
});
