import { describe, expect, it } from 'vitest';

import {
  InvitationEmailSender,
  type InvitationDeliverySecretOpeningBoundary,
} from '@emdo/integrations/email';

import {
  createInvitationDeliveryService,
  type InvitationDeliveryRepository,
} from './invitations.js';
import type { WorkerExecutionContext } from './jobs.js';

const invitationId = '11111111-1111-4111-8111-111111111111';
const deliverySecretId = '22222222-2222-4222-8222-222222222222';
const operationId = 'invitation:11111111-1111-4111-8111-111111111111';
const token = 'A'.repeat(43);
const envelope = {
  schemaVersion: 1,
  algorithm: 'RSA-OAEP-256',
  keyId: 'invitation-delivery-key-2026-08',
  ciphertext: 'B'.repeat(342),
  bindingHash: 'b'.repeat(64),
} as const;
const activeRecord = {
  schemaVersion: 1,
  status: 'active',
  invitationId,
  deliverySecretId,
  recipient: 'member@example.ca',
  role: 'member',
  tokenHash: 'a'.repeat(64),
  templateVersion: 'invitation-redemption.v1',
  envelope,
} as const;
const request = { operationId, invitationId, deliverySecretId } as const;
const context: WorkerExecutionContext = {
  execution: {
    jobName: 'emdo.invitation.delivery.v1',
    operationId,
    queueJobId: '20000000-0000-8000-8000-000000000006',
    payloadHash: 'a'.repeat(64),
    leaseToken: '30000000-0000-4000-8000-000000000001',
    leaseExpiresAt: '2026-08-10T12:05:00.000Z',
  },
  signal: new AbortController().signal,
};

const opener = (
  calls: unknown[],
  openedBytes: Uint8Array[] = [],
): InvitationDeliverySecretOpeningBoundary => ({
  async withOpenedSecret(input, useSecret) {
    calls.push(input);
    const secret = new TextEncoder().encode(token);
    openedBytes.push(secret);
    try {
      return await useSecret(secret);
    } finally {
      secret.fill(0);
    }
  },
});

describe('invitation delivery service', () => {
  it('captures only a sealed reference, opens it in worker memory, sends, zeroizes, and then erases on confirmation', async () => {
    const events: string[] = [];
    const captures: unknown[] = [];
    const settlements: unknown[] = [];
    const openingCalls: unknown[] = [];
    const openedBytes: Uint8Array[] = [];
    const messages: unknown[] = [];
    const repository: InvitationDeliveryRepository = {
      async captureForDelivery(input, workerContext) {
        expect(workerContext).toBe(context);
        events.push('capture');
        captures.push(input);
        return activeRecord;
      },
      async settleDelivery(input, workerContext) {
        expect(workerContext.execution).toBe(context.execution);
        expect(workerContext.signal).not.toBe(context.signal);
        expect(workerContext.signal.aborted).toBe(false);
        events.push('settle');
        settlements.push(input);
        return { status: 'settled' };
      },
    };
    const email = new InvitationEmailSender(
      {
        async send(message) {
          events.push('provider');
          messages.push(message);
          return { status: 'sent', providerMessageReference: 'provider-42' };
        },
      },
      { applicationOrigin: 'https://emdo.example' },
    );
    const service = createInvitationDeliveryService({
      repository,
      opener: opener(openingCalls, openedBytes),
      email,
    });

    const result = await service.deliver(request, context);

    expect(result).toEqual({ status: 'delivered' });
    expect(captures).toEqual([request]);
    expect(JSON.stringify(captures)).not.toContain(token);
    expect(openingCalls).toEqual([
      {
        envelope,
        binding: {
          invitationId,
          normalizedRecipient: 'member@example.ca',
          role: 'member',
          tokenHash: 'a'.repeat(64),
          templateVersion: 'invitation-redemption.v1',
        },
      },
    ]);
    expect(messages).toEqual([
      expect.objectContaining({
        deliveryId: operationId,
        recipient: 'member@example.ca',
        contentClassification: 'invitation-redemption-link',
      }),
    ]);
    expect(settlements).toEqual([
      {
        operationId,
        invitationId,
        deliverySecretId,
        disposition: 'confirmed',
      },
    ]);
    expect(events).toEqual(['capture', 'provider', 'settle']);
    expect(openedBytes[0]?.every((value) => value === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/ciphertext|provider-42|token/u);
  });

  it('settles expired secrets without opening or calling the provider', async () => {
    const settlements: unknown[] = [];
    let openerCalls = 0;
    let providerCalls = 0;
    const service = createInvitationDeliveryService({
      repository: {
        async captureForDelivery() {
          return {
            schemaVersion: 1,
            status: 'expired',
            invitationId,
            deliverySecretId,
          };
        },
        async settleDelivery(input) {
          settlements.push(input);
          return { status: 'settled' };
        },
      },
      opener: {
        async withOpenedSecret() {
          openerCalls += 1;
          throw new Error('must not run');
        },
      },
      email: new InvitationEmailSender(
        {
          async send() {
            providerCalls += 1;
            throw new Error('must not run');
          },
        },
        { applicationOrigin: 'https://emdo.example' },
      ),
    });

    await expect(service.deliver(request, context)).resolves.toEqual({
      status: 'expired',
    });
    expect(settlements).toEqual([{ ...request, disposition: 'expired' }]);
    expect(openerCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  it('retains the sealed secret and records reconciliation on an indeterminate provider result', async () => {
    const settlements: unknown[] = [];
    const openedBytes: Uint8Array[] = [];
    const service = createInvitationDeliveryService({
      repository: {
        async captureForDelivery() {
          return activeRecord;
        },
        async settleDelivery(input) {
          settlements.push(input);
          return { status: 'settled' };
        },
      },
      opener: opener([], openedBytes),
      email: new InvitationEmailSender(
        {
          async send() {
            throw new Error(`${token}:private-provider-detail`);
          },
        },
        { applicationOrigin: 'https://emdo.example' },
      ),
    });

    await expect(service.deliver(request, context)).resolves.toEqual({
      status: 'requires-reconciliation',
    });
    expect(settlements).toEqual([{ ...request, disposition: 'indeterminate' }]);
    expect(openedBytes[0]?.every((value) => value === 0)).toBe(true);
  });

  it('uses an independent bounded signal to persist an indeterminate send after the job is aborted', async () => {
    const controller = new AbortController();
    const settlementSignals: AbortSignal[] = [];
    const settlements: unknown[] = [];
    const service = createInvitationDeliveryService({
      repository: {
        async captureForDelivery() {
          return activeRecord;
        },
        async settleDelivery(input, workerContext) {
          settlementSignals.push(workerContext.signal);
          settlements.push(input);
          workerContext.signal.throwIfAborted();
          return { status: 'settled' };
        },
      },
      opener: opener([]),
      email: new InvitationEmailSender(
        {
          async send() {
            controller.abort();
            throw new Error('provider acceptance unknown');
          },
        },
        { applicationOrigin: 'https://emdo.example' },
      ),
    });

    await expect(
      service.deliver(request, {
        ...context,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ status: 'requires-reconciliation' });
    expect(settlements).toEqual([{ ...request, disposition: 'indeterminate' }]);
    expect(settlementSignals).toHaveLength(1);
    expect(settlementSignals[0]).not.toBe(controller.signal);
    expect(settlementSignals[0]?.aborted).toBe(false);
  });

  it('retains the sealed secret and retries when the provider proves not-applied', async () => {
    let settlements = 0;
    const openedBytes: Uint8Array[] = [];
    const service = createInvitationDeliveryService({
      repository: {
        async captureForDelivery() {
          return activeRecord;
        },
        async settleDelivery() {
          settlements += 1;
          return { status: 'settled' };
        },
      },
      opener: opener([], openedBytes),
      email: new InvitationEmailSender(
        {
          async send() {
            return { status: 'not-applied' };
          },
        },
        { applicationOrigin: 'https://emdo.example' },
      ),
    });

    await expect(service.deliver(request, context)).rejects.toThrow(
      'Invitation delivery failed',
    );
    expect(settlements).toBe(0);
    expect(openedBytes[0]?.every((value) => value === 0)).toBe(true);
  });

  it('rejects mismatched or secret-bearing captures before opening or provider use', async () => {
    let openerCalls = 0;
    let providerCalls = 0;
    const email = new InvitationEmailSender(
      {
        async send() {
          providerCalls += 1;
          return { status: 'sent', providerMessageReference: 'provider-42' };
        },
      },
      { applicationOrigin: 'https://emdo.example' },
    );
    for (const captured of [
      undefined,
      { ...activeRecord, invitationId: '33333333-3333-4333-8333-333333333333' },
      {
        ...activeRecord,
        deliverySecretId: '33333333-3333-4333-8333-333333333333',
      },
      { ...activeRecord, recipient: 'not-an-email' },
      { ...activeRecord, invitationToken: token },
    ]) {
      const service = createInvitationDeliveryService({
        repository: {
          async captureForDelivery() {
            return captured;
          },
          async settleDelivery() {
            throw new Error('must not run');
          },
        },
        opener: {
          async withOpenedSecret() {
            openerCalls += 1;
            throw new Error('must not run');
          },
        },
        email,
      });
      await expect(service.deliver(request, context)).rejects.toThrow(
        'Invitation is unavailable for delivery',
      );
    }
    expect(openerCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  it('captures dependency methods without invoking accessors', () => {
    let accessorCalls = 0;
    const hostileRepository = Object.defineProperty({}, 'captureForDelivery', {
      get() {
        accessorCalls += 1;
        throw new Error(`${token}:private-detail`);
      },
    });
    expect(() =>
      createInvitationDeliveryService({
        repository: hostileRepository as InvitationDeliveryRepository,
        opener: opener([]),
        email: new InvitationEmailSender(
          {
            async send() {
              return { status: 'duplicate' };
            },
          },
          { applicationOrigin: 'https://emdo.example' },
        ),
      }),
    ).toThrow('Invitation delivery dependencies are invalid');
    expect(accessorCalls).toBe(0);
  });
});
