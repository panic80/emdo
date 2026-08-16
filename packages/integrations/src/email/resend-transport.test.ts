import { describe, expect, it, vi } from 'vitest';

import { ResendTransactionalEmailTransport } from './resend-transport.js';

const API_KEY = `re_${'a'.repeat(40)}`;
const DELIVERY_ID = 'auth-email:018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f90';

const message = Object.freeze({
  schemaVersion: 1 as const,
  deliveryId: DELIVERY_ID,
  recipient: 'member@example.net',
  subject: 'Verify your EMDO email',
  text: 'Open https://emdo.example/api/auth/verify-email?token=redacted',
  contentClassification: 'authentication-action-link' as const,
});

describe('ResendTransactionalEmailTransport', () => {
  it('sends the exact bounded message with provider idempotency', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://api.resend.com/emails');
      expect(request.method).toBe('POST');
      expect(request.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
      expect(request.headers.get('idempotency-key')).toBe(DELIVERY_ID);
      expect(request.headers.get('content-type')).toBe('application/json');
      expect(await request.json()).toEqual({
        from: 'auth@updates.example.com',
        to: ['member@example.net'],
        subject: 'Verify your EMDO email',
        text: message.text,
      });
      return Response.json({ id: 'provider-message-1' });
    });
    const transport = new ResendTransactionalEmailTransport(
      {
        apiKey: API_KEY,
        fromEmail: 'auth@updates.example.com',
      },
      { fetch },
    );

    await expect(
      transport.send(message, { signal: new AbortController().signal }),
    ).resolves.toEqual({
      status: 'sent',
      providerMessageReference: 'provider-message-1',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [409, { name: 'invalid_idempotent_request' }, { status: 'not-applied' }],
    [
      409,
      { name: 'concurrent_idempotent_requests' },
      { status: 'indeterminate' },
    ],
    [429, { name: 'rate_limit_exceeded' }, { status: 'indeterminate' }],
    [400, { name: 'validation_error' }, { status: 'not-applied' }],
  ] as const)(
    'maps provider status %i without exposing provider detail',
    async (status, body, expected) => {
      const transport = new ResendTransactionalEmailTransport(
        { apiKey: API_KEY, fromEmail: 'auth@updates.example.com' },
        { fetch: vi.fn(async () => Response.json(body, { status })) },
      );
      await expect(
        transport.send(message, { signal: new AbortController().signal }),
      ).resolves.toEqual(expected);
    },
  );

  it('fails indeterminate for transport, malformed, and oversized responses', async () => {
    const failures = [
      vi.fn(async () => {
        throw new Error(`secret ${API_KEY}`);
      }),
      vi.fn(async () => new Response('{', { status: 200 })),
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: 'x'.repeat(20_000) }), {
            status: 200,
          }),
      ),
    ];
    for (const fetch of failures) {
      const transport = new ResendTransactionalEmailTransport(
        { apiKey: API_KEY, fromEmail: 'auth@updates.example.com' },
        { fetch },
      );
      await expect(
        transport.send(message, { signal: new AbortController().signal }),
      ).resolves.toEqual({ status: 'indeterminate' });
    }
  });

  it('probes the exact verified sending domain without sending mail', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://api.resend.com/domains?limit=100');
      expect(request.method).toBe('GET');
      expect(request.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
      return Response.json({
        object: 'list',
        has_more: false,
        data: [
          {
            id: 'domain-1',
            name: 'updates.example.com',
            status: 'verified',
            capabilities: { sending: 'enabled', receiving: 'disabled' },
          },
        ],
      });
    });
    const transport = new ResendTransactionalEmailTransport(
      { apiKey: API_KEY, fromEmail: 'auth@updates.example.com' },
      { fetch },
    );

    await expect(transport.checkReady()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('briefly caches a successful provider probe for request-path guards', async () => {
    let now = 1_000;
    const fetch = vi.fn(async () =>
      Response.json({
        object: 'list',
        has_more: false,
        data: [
          {
            id: 'domain-1',
            name: 'updates.example.com',
            status: 'verified',
            capabilities: { sending: 'enabled', receiving: 'disabled' },
          },
        ],
      }),
    );
    const transport = new ResendTransactionalEmailTransport(
      { apiKey: API_KEY, fromEmail: 'auth@updates.example.com' },
      {
        fetch,
        clock: () => now,
        readinessSuccessTtlMs: 100,
        readinessFailureTtlMs: 10,
      },
    );

    await expect(transport.checkReady()).resolves.toBe(true);
    await expect(transport.checkReady()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    now += 101;
    await expect(transport.checkReady()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports unready for the wrong domain, disabled sending, or provider failure', async () => {
    for (const response of [
      Response.json({
        object: 'list',
        has_more: false,
        data: [
          {
            id: 'domain-1',
            name: 'other.example.com',
            status: 'verified',
            capabilities: { sending: 'enabled', receiving: 'disabled' },
          },
        ],
      }),
      Response.json({
        object: 'list',
        has_more: false,
        data: [
          {
            id: 'domain-1',
            name: 'updates.example.com',
            status: 'pending',
            capabilities: { sending: 'enabled', receiving: 'disabled' },
          },
        ],
      }),
      Response.json({ name: 'restricted_api_key' }, { status: 403 }),
    ]) {
      const transport = new ResendTransactionalEmailTransport(
        { apiKey: API_KEY, fromEmail: 'auth@updates.example.com' },
        { fetch: vi.fn(async () => response.clone()) },
      );
      await expect(transport.checkReady()).resolves.toBe(false);
    }
  });

  it.each([
    { apiKey: 'not-a-key', fromEmail: 'auth@updates.example.com' },
    { apiKey: API_KEY, fromEmail: 'Auth <auth@updates.example.com>' },
    { apiKey: API_KEY, fromEmail: 'auth@localhost' },
  ])('rejects malformed configuration before fetch', (configuration) => {
    expect(
      () =>
        new ResendTransactionalEmailTransport(configuration, {
          fetch: vi.fn(),
        }),
    ).toThrow('Transactional email configuration is invalid');
  });
});
