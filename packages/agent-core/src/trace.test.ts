import { describe, expect, it, vi } from 'vitest';

import {
  LocalTraceRecorder,
  redactTraceMetadata,
  type LocalTraceEvent,
} from './trace.js';

describe('LocalTraceRecorder', () => {
  it('records frozen local events with secrets redacted and private IDs pseudonymized', async () => {
    const recorded: LocalTraceEvent[] = [];
    const append = vi.fn(async (event: LocalTraceEvent) => {
      recorded.push(event);
    });
    const recorder = new LocalTraceRecorder(
      { append },
      () => new Date('2026-08-09T22:00:00.000Z'),
      () => 'trace-018f1f5e-1111-7111-8111-111111111111',
    );
    const trace = recorder.start('018f1f5e-2222-7222-8222-222222222222');

    await trace.record('model.resolved', {
      userId: '018f1f5e-3333-7333-8333-333333333333',
      householdId: '018f1f5e-4444-7444-8444-444444444444',
      agentId: 'scheduler',
      model: 'gpt-5.6-luna',
      apiKey: 'sk-do-not-log',
      authorization: 'Bearer do-not-log',
      nested: { credential: 'hidden', latencyMs: 42 },
    });

    expect(trace.reference).toBe('trace-018f1f5e-1111-7111-8111-111111111111');
    expect(append).toHaveBeenCalledOnce();
    const event = recorded[0]!;
    expect(event).toMatchObject({
      traceReference: trace.reference,
      type: 'model.resolved',
      occurredAt: '2026-08-09T22:00:00.000Z',
      metadata: {
        agentId: 'scheduler',
        model: 'gpt-5.6-luna',
        apiKey: '[redacted]',
        authorization: '[redacted]',
        nested: { credential: '[redacted]', latencyMs: 42 },
      },
    });
    expect(event.runReference).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(event.metadata.userId).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(event.metadata.householdId).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.metadata)).toBe(true);
    expect(Object.isFrozen(event.metadata.nested)).toBe(true);
  });

  it('never evaluates accessors while sanitizing untrusted metadata', () => {
    const getter = vi.fn(() => 'secret');
    const metadata = Object.defineProperty(
      { safe: 'value' },
      'providerPayload',
      {
        enumerable: true,
        get: getter,
      },
    );

    expect(redactTraceMetadata(metadata)).toEqual({
      redaction: 'metadata-unavailable',
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it('bounds deeply nested and oversized metadata without exposing raw values', () => {
    const metadata: Record<string, unknown> = { value: 'x'.repeat(4_000) };
    let cursor = metadata;
    for (let depth = 0; depth < 12; depth += 1) {
      const nested: Record<string, unknown> = {};
      cursor.nested = nested;
      cursor = nested;
    }

    expect(redactTraceMetadata(metadata)).toEqual({
      redaction: 'metadata-unavailable',
    });
  });
});
