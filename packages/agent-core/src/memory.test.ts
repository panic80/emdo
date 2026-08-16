import { describe, expect, it, vi } from 'vitest';

import {
  ConversationMemoryService,
  type ConversationMemoryEntry,
} from './memory.js';

const ids = Object.freeze({
  conversationId: '018f1f5e-1111-7111-8111-111111111111',
  householdId: '018f1f5e-2222-7222-8222-222222222222',
  userId: '018f1f5e-3333-7333-8333-333333333333',
});

const memoryEntry = (
  overrides: Partial<ConversationMemoryEntry> = {},
): ConversationMemoryEntry =>
  Object.freeze({
    id: '018f1f5e-4444-7444-8444-444444444444',
    conversationId: ids.conversationId,
    householdId: ids.householdId,
    userId: ids.userId,
    role: 'assistant',
    content: 'The user prefers evening grocery pickup.',
    createdAt: '2026-08-09T20:00:00.000Z',
    ...overrides,
  });

describe('ConversationMemoryService', () => {
  it('retrieves a bounded frozen manager context from app-owned storage', async () => {
    const retrieve = vi.fn(async () => [memoryEntry()]);
    const append = vi.fn(async () => undefined);
    const service = new ConversationMemoryService({ append, retrieve }, 8);

    const context = await service.retrieveForManager({
      ...ids,
      query: 'Plan groceries for tonight',
    });

    expect(retrieve).toHaveBeenCalledWith({
      ...ids,
      query: 'Plan groceries for tonight',
      limit: 8,
    });
    expect(context).toEqual({ entries: [memoryEntry()] });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.entries)).toBe(true);
    expect(Object.isFrozen(context.entries[0])).toBe(true);
  });

  it('fails closed if the repository crosses conversation, household, or user scope', async () => {
    for (const override of [
      { conversationId: '018f1f5e-aaaa-7aaa-8aaa-aaaaaaaaaaaa' },
      { householdId: '018f1f5e-bbbb-7bbb-8bbb-bbbbbbbbbbbb' },
      { userId: '018f1f5e-cccc-7ccc-8ccc-cccccccccccc' },
    ]) {
      const service = new ConversationMemoryService({
        append: async () => undefined,
        retrieve: async () => [memoryEntry(override)],
      });

      await expect(
        service.retrieveForManager({
          ...ids,
          query: 'private household request',
        }),
      ).rejects.toThrow('memory-scope-mismatch');
    }
  });

  it('appends only manager-owned user and assistant conversation messages', async () => {
    const append = vi.fn(async () => undefined);
    const service = new ConversationMemoryService(
      { append, retrieve: async () => [] },
      12,
      () => new Date('2026-08-09T21:00:00.000Z'),
      () => '018f1f5e-5555-7555-8555-555555555555',
    );

    const userEntry = await service.appendManagerMessage({
      ...ids,
      role: 'user',
      content: 'Remember oat milk.',
    });
    const assistantEntry = await service.appendManagerMessage({
      ...ids,
      role: 'assistant',
      content: 'I added oat milk to the plan.',
    });

    expect(append).toHaveBeenNthCalledWith(1, {
      id: '018f1f5e-5555-7555-8555-555555555555',
      ...ids,
      role: 'user',
      content: 'Remember oat milk.',
      sourceAgentId: 'manager',
      createdAt: '2026-08-09T21:00:00.000Z',
    });
    expect(append).toHaveBeenNthCalledWith(2, {
      id: '018f1f5e-5555-7555-8555-555555555555',
      ...ids,
      role: 'assistant',
      content: 'I added oat milk to the plan.',
      sourceAgentId: 'manager',
      createdAt: '2026-08-09T21:00:00.000Z',
    });
    expect(userEntry).toEqual({
      id: '018f1f5e-5555-7555-8555-555555555555',
      ...ids,
      role: 'user',
      content: 'Remember oat milk.',
      createdAt: '2026-08-09T21:00:00.000Z',
    });
    expect(assistantEntry).toEqual({
      id: '018f1f5e-5555-7555-8555-555555555555',
      ...ids,
      role: 'assistant',
      content: 'I added oat milk to the plan.',
      createdAt: '2026-08-09T21:00:00.000Z',
    });
  });

  it('rejects unbounded, accessor-backed, or specialist-authored memory input', async () => {
    const service = new ConversationMemoryService({
      append: async () => undefined,
      retrieve: async () => [],
    });
    const accessor = Object.defineProperty(
      { ...ids, role: 'user' as const, content: 'safe' },
      'content',
      { enumerable: true, get: () => 'hidden' },
    );

    await expect(
      service.retrieveForManager({
        ...ids,
        query: 'x'.repeat(16_001),
      }),
    ).rejects.toThrow('invalid-memory-request');
    await expect(service.appendManagerMessage(accessor)).rejects.toThrow(
      'invalid-memory-request',
    );
    await expect(
      service.appendManagerMessage({
        ...ids,
        role: 'specialist' as never,
        content: 'write directly',
      }),
    ).rejects.toThrow('invalid-memory-request');
  });
});
