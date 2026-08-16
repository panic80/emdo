import { describe, expect, it, vi } from 'vitest';

import {
  PersistedRunEventBuffer,
  createTurn,
  parseEventStream,
  readRunEvents,
} from './sse-client.js';

describe('persisted run event streaming', () => {
  it('yields a complete event before the response stream closes', async () => {
    const encoder = new TextEncoder();
    let releaseSecondEvent = (): void => undefined;
    const secondEventGate = new Promise<void>((resolve) => {
      releaseSecondEvent = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'id: 1\nevent: assistant.delta\ndata: {"delta":"Hello"}\n\n',
          ),
        );
        void secondEventGate.then(() => {
          controller.enqueue(
            encoder.encode(
              'id: 2\nevent: assistant.delta\ndata: {"delta":" world"}\n\n',
            ),
          );
          controller.close();
        });
      },
    });
    const fetcher = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const events = readRunEvents('run-1', {
      fetcher,
    }) as unknown as AsyncIterable<{
      readonly id: string;
      readonly type: string;
      readonly data: unknown;
    }>;
    const iterator = events[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { id: '1', type: 'assistant.delta', data: { delta: 'Hello' } },
    });
    let secondSettled = false;
    const second = iterator.next().then((result) => {
      secondSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    releaseSecondEvent();
    await expect(second).resolves.toEqual({
      done: false,
      value: { id: '2', type: 'assistant.delta', data: { delta: ' world' } },
    });
  });

  it('parses chunked SSE frames, multiline data, and a final unterminated frame', async () => {
    const chunks = [
      'id: 1\nevent: run.started\ndata: {"runId":"run-1",',
      '\ndata: "status":"running"}\n\nid: 2\ndata: {"status":"done"}',
    ];

    const events = await parseEventStream(chunks);

    expect(events).toEqual([
      {
        id: '1',
        type: 'run.started',
        data: { runId: 'run-1', status: 'running' },
      },
      { id: '2', type: 'message', data: { status: 'done' } },
    ]);
  });

  it('preserves wire order when several events arrive across arbitrary chunk boundaries', async () => {
    const events = await parseEventStream([
      'id: 1\ndata: {"position":1}\n\nid: 2\nda',
      'ta: {"position":2}\n\nid: 3\ndata: {"position":3}\n\n',
    ]);

    expect(events.map(({ id, data }) => ({ id, data }))).toEqual([
      { id: '1', data: { position: 1 } },
      { id: '2', data: { position: 2 } },
      { id: '3', data: { position: 3 } },
    ]);
  });

  it('aborts a pending response read and cancels its stream promptly', async () => {
    let responseController:
      ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        responseController = controller;
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const controller = new AbortController();
    const iterator = readRunEvents('run-1', {
      fetcher,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    const pending = iterator.next();

    controller.abort();
    const outcome = await Promise.race([
      pending.then(
        () => 'resolved' as const,
        (error: unknown) => error,
      ),
      new Promise<'timed-out'>((resolve) => {
        setTimeout(() => resolve('timed-out'), 25);
      }),
    ]);
    if (outcome === 'timed-out') responseController?.close();

    expect(outcome).toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
  });

  it('rejects an event stream after the configured byte budget is exhausted', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(`id: 1\ndata: ${'x'.repeat(80)}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    await expect(async () => {
      for await (const event of readRunEvents('run-1', {
        fetcher,
        eventStreamLimits: { maxBytes: 64 },
      })) {
        void event;
      }
    }).rejects.toMatchObject({ code: 'event-stream-failed' });
  });

  it('rejects a single oversized SSE frame before parsing it', async () => {
    await expect(
      parseEventStream([`id: 1\ndata: ${'x'.repeat(80)}\n\n`], {
        maxBytes: 256,
        maxFrameBytes: 64,
      }),
    ).rejects.toMatchObject({ code: 'event-stream-failed' });
  });

  it('rejects additional events after the event-count budget is exhausted', async () => {
    await expect(
      parseEventStream(
        ['id: 1\ndata: 1\n\n', 'id: 2\ndata: 2\n\n', 'id: 3\ndata: 3\n\n'],
        { maxEvents: 2 },
      ),
    ).rejects.toMatchObject({ code: 'event-stream-failed' });
  });

  it('deduplicates replayed event IDs while preserving append order and resume cursor', () => {
    const buffer = new PersistedRunEventBuffer();
    buffer.append({ id: '2', type: 'delta', data: { text: 'there' } });
    buffer.append({ id: '1', type: 'delta', data: { text: 'hello ' } });
    buffer.append({ id: '2', type: 'delta', data: { text: 'tampered' } });

    expect(buffer.snapshot()).toEqual([
      { id: '2', type: 'delta', data: { text: 'there' } },
      { id: '1', type: 'delta', data: { text: 'hello ' } },
    ]);
    expect(buffer.lastEventId).toBe('1');
  });

  it('creates turns with same-origin credentials and an application-owned idempotency key', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            runId: 'run-1',
            status: 'accepted',
            replayed: false,
            eventsPath: '/api/v1/runs/run-1/events',
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        ),
    );

    const result = await createTurn(
      {
        message: 'Plan my afternoon',
        specialist: 'manager',
        idempotencyKey: 'turn-local-1',
        csrfToken: 'csrf-1',
      },
      { fetcher },
    );

    expect(result.runId).toBe('run-1');
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/turns',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: expect.objectContaining({
          'idempotency-key': 'turn-local-1',
          'x-csrf-token': 'csrf-1',
        }),
      }),
    );
    const [, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      schemaVersion: 1,
      message: 'Plan my afternoon',
    });
  });

  it('resumes persisted run events with Last-Event-ID and never uses a cache', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('id: 8\ndata: {"status":"done"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    const events = [];
    for await (const event of readRunEvents('run/unsafe', {
      fetcher,
      lastEventId: '7',
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/runs/run%2Funsafe/events',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'same-origin',
        headers: expect.objectContaining({ 'Last-Event-ID': '7' }),
      }),
    );
  });

  it('maps problem responses to a safe client error without reflecting server internals', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: 'https://internal/errors/db',
            title: 'Database password abc123 failed',
            status: 500,
            detail: 'postgres://secret',
          }),
          {
            status: 500,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
    );

    await expect(
      createTurn(
        {
          message: 'Hello',
          specialist: 'manager',
          idempotencyKey: 'turn-2',
          csrfToken: 'csrf-2',
        },
        { fetcher },
      ),
    ).rejects.toMatchObject({
      code: 'turn-request-failed',
      message: 'EMDO could not start that request. Please try again.',
      status: 500,
    });
  });
});
