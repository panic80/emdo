import { EffectiveAuthorizationScopeFingerprintSchema } from '@emdo/contracts';
import { describe, expect, it, vi } from 'vitest';

import { FetchGoogleCalendarConditionalGateway } from '../calendar-fetch.js';
import { createGoogleCalendarOAuthServerRuntime } from './server.js';

const actor = {
  userId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f005',
  householdId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f007',
  privateSpaceId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f008',
  sessionId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f009',
};
const authorizationScopeFingerprint =
  EffectiveAuthorizationScopeFingerprintSchema.parse('5'.repeat(64));

const createRuntime = () =>
  createGoogleCalendarOAuthServerRuntime({
    configuration: {
      calendarClientId: 'calendar-client-id',
      calendarClientSecret: 'calendar-client-secret',
      identityClientId: 'identity-client-id',
      redirectUri: 'https://app.example.test/api/v1/connectors/google/callback',
      stateSigningKey: new Uint8Array(32).fill(7),
    },
    flowStore: {} as never,
    authorizationEpochStore: {} as never,
    grantStore: {} as never,
    keyProvider: {} as never,
    transport: {} as never,
    calendarFetch: vi.fn(),
    audit: {} as never,
    grantLease: {} as never,
    clock: () => new Date('2026-08-09T12:00:00.000Z'),
    entropy: (length) => new Uint8Array(length).fill(3),
  });

describe('createGoogleCalendarOAuthServerRuntime', () => {
  it('constructs conditional writes from a trusted branded scope fingerprint', () => {
    const runtime = createRuntime();

    expect(
      runtime.calendar.createConditionalGateway({
        actor,
        authorizationScopeFingerprint,
      }),
    ).toBeInstanceOf(FetchGoogleCalendarConditionalGateway);
  });

  it('rejects the removed rotating-grant constructor seam', () => {
    const runtime = createRuntime();

    expect(() =>
      runtime.calendar.createConditionalGateway({
        actor,
        spaceAccessGrantId: '018f1f5e-6f47-7d61-a6dd-1e86f8b8f011',
      } as never),
    ).toThrow('invalid-google-calendar-conditional-gateway-scope');
  });

  it('rejects an unbranded scope fingerprint before gateway construction', () => {
    const runtime = createRuntime();

    expect(() =>
      runtime.calendar.createConditionalGateway({
        actor,
        authorizationScopeFingerprint: 'not-a-fingerprint',
      } as never),
    ).toThrow('invalid-google-calendar-conditional-gateway-scope');
  });
});
