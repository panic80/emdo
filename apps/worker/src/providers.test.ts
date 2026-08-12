import { describe, expect, it } from 'vitest';

import type { InvitationDeliverySecretOpeningBoundary } from '@emdo/integrations/email';

import {
  checkWorkerProviderReadiness,
  createUnavailableWorkerProviderRuntime,
  normalizeWorkerProviderRuntime,
} from './providers.js';

const availableInvitationSecrets =
  (): InvitationDeliverySecretOpeningBoundary => ({
    async withOpenedSecret(_input, useSecret) {
      const secret = new TextEncoder().encode('A'.repeat(43));
      try {
        return await useSecret(secret);
      } finally {
        secret.fill(0);
      }
    },
  });

describe('worker provider runtime boundary', () => {
  it('ships honest unavailable adapters for every optional provider', async () => {
    const runtime = createUnavailableWorkerProviderRuntime();
    expect(runtime.status).toEqual({
      overall: 'degraded',
      email: 'unavailable',
      push: 'unavailable',
      calendar: 'unavailable',
      blockers: [
        'worker-email-adapter-unavailable',
        'worker-push-adapter-unavailable',
        'worker-calendar-broker-unavailable',
      ],
    });
    await expect(
      runtime.email.send(
        {
          schemaVersion: 1,
          deliveryId: 'notification:email:1',
          recipient: 'member@example.ca',
          subject: 'You have a new EMDO update',
          text: 'Open EMDO to view this update: https://emdo.example/activity',
          contentClassification: 'redacted-notification-preview',
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ status: 'not-applied' });
    await expect(
      runtime.push.send(
        {
          schemaVersion: 1,
          deliveryId: 'notification:push:1',
          subscriptionReference: 'subscription-reference',
          title: 'EMDO update',
          body: 'Open EMDO to view the latest update.',
          url: '/activity',
          tag: 'emdo-notification',
          contentClassification: 'redacted-notification-preview',
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ status: 'not-applied' });
    await expect(
      runtime.calendar.synchronize({
        jobAuthority: {
          jobName: 'emdo.calendar.sync.v1',
          operationId: 'calendar-sync:1',
          queueJobId: '11111111-1111-4111-8111-111111111111',
          payloadHash: 'a'.repeat(64),
          leaseToken: '22222222-2222-4222-8222-222222222222',
          leaseExpiresAt: '2026-08-10T14:00:00.000Z',
        },
        connectionAuthority: {
          providerId: 'google-calendar',
          connectionId: 'calendar-connection',
          householdId: '33333333-3333-4333-8333-333333333333',
          spaceId: '44444444-4444-4444-8444-444444444444',
          originalOwnerUserId: '55555555-5555-4555-8555-555555555555',
          syncGeneration: 1,
          sealedCursor: null,
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: 'provider-unavailable' });
    let secretCallbackCalls = 0;
    await expect(
      runtime.invitationSecrets.withOpenedSecret(
        {
          envelope: {
            schemaVersion: 1,
            algorithm: 'RSA-OAEP-256',
            keyId: 'unavailable-key',
            ciphertext: 'A'.repeat(342),
            bindingHash: 'a'.repeat(64),
          },
          binding: {
            invitationId: '11111111-1111-4111-8111-111111111111',
            normalizedRecipient: 'member@example.ca',
            role: 'member',
            tokenHash: 'b'.repeat(64),
            templateVersion: 'invitation-redemption.v1',
          },
        },
        async () => {
          secretCallbackCalls += 1;
        },
      ),
    ).rejects.toThrow('Invitation delivery secret opener is unavailable');
    expect(secretCallbackCalls).toBe(0);
  });

  it('captures configured runtime methods and rejects accessor boundaries', async () => {
    const configured = normalizeWorkerProviderRuntime({
      status: {
        overall: 'available',
        email: 'available',
        push: 'available',
        calendar: 'available',
        blockers: [],
      },
      email: {
        async send() {
          return { status: 'duplicate' };
        },
      },
      push: {
        async send() {
          return { status: 'duplicate' };
        },
      },
      calendar: {
        async synchronize() {
          return {};
        },
        async readBackAttempt() {
          return {};
        },
      },
      invitationSecrets: availableInvitationSecrets(),
      async checkEmailReadiness() {
        return { status: 'available' };
      },
      async checkPushReadiness() {
        return { status: 'available' };
      },
      async checkCalendarReadiness() {
        return { status: 'available' };
      },
      async close() {},
    });
    expect(configured.status.overall).toBe('available');

    let accessorCalls = 0;
    const unavailable = createUnavailableWorkerProviderRuntime();
    const hostileRuntime = Object.defineProperty(
      {
        status: unavailable.status,
        email: unavailable.email,
        push: unavailable.push,
        calendar: unavailable.calendar,
        invitationSecrets: unavailable.invitationSecrets,
        checkEmailReadiness: unavailable.checkEmailReadiness,
        checkPushReadiness: unavailable.checkPushReadiness,
        checkCalendarReadiness: unavailable.checkCalendarReadiness,
      },
      'close',
      {
        get() {
          accessorCalls += 1;
          throw new Error('must not execute');
        },
      },
    );
    expect(() => normalizeWorkerProviderRuntime(hostileRuntime)).toThrow(
      'Worker provider runtime is unavailable',
    );
    expect(accessorCalls).toBe(0);
  });

  it('hard-bounds real channel probes and reports only exact safe blocker codes', async () => {
    let calendarSignal: AbortSignal | undefined;
    const runtime = normalizeWorkerProviderRuntime({
      status: {
        overall: 'available',
        email: 'available',
        push: 'available',
        calendar: 'available',
        blockers: [],
      },
      email: {
        async send() {
          return { status: 'duplicate' };
        },
      },
      push: {
        async send() {
          return { status: 'duplicate' };
        },
      },
      calendar: {
        async synchronize() {
          return {};
        },
        async readBackAttempt() {
          return {};
        },
      },
      invitationSecrets: availableInvitationSecrets(),
      async checkEmailReadiness() {
        return { status: 'available' };
      },
      async checkPushReadiness() {
        return { status: 'available', providerDetail: 'must be rejected' };
      },
      async checkCalendarReadiness({ signal }: { signal: AbortSignal }) {
        calendarSignal = signal;
        return new Promise(() => undefined);
      },
      async close() {},
    });

    await expect(
      checkWorkerProviderReadiness(runtime, { timeoutMs: 25 }),
    ).resolves.toEqual({
      overall: 'degraded',
      email: 'available',
      push: 'unavailable',
      calendar: 'unavailable',
      blockers: [
        'worker-push-readiness-failed',
        'worker-calendar-readiness-failed',
      ],
    });
    expect(calendarSignal?.aborted).toBe(true);
  });

  it('preserves exact credential blockers without evaluating provider accessors', () => {
    const unavailable = createUnavailableWorkerProviderRuntime();
    expect(() =>
      normalizeWorkerProviderRuntime({
        ...unavailable,
        status: {
          overall: 'degraded',
          email: 'unavailable',
          push: 'available',
          calendar: 'available',
          blockers: ['worker-email-credentials-unavailable'],
        },
      }),
    ).not.toThrow();
    expect(() =>
      normalizeWorkerProviderRuntime({
        ...unavailable,
        status: {
          overall: 'unknown',
          email: 'available',
          push: 'available',
          calendar: 'available',
          blockers: [],
        },
      }),
    ).toThrow('Worker provider runtime is unavailable');
  });
});
