import { randomUUID } from 'node:crypto';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MEMORY_TEXT = 16_000;

export type ConversationMemoryRole = 'user' | 'assistant';

export interface ConversationMemoryEntry {
  readonly id: string;
  readonly conversationId: string;
  readonly householdId: string;
  readonly userId: string;
  readonly role: ConversationMemoryRole;
  readonly content: string;
  readonly createdAt: string;
}

export interface ConversationMemoryAppend extends ConversationMemoryEntry {
  readonly sourceAgentId: 'manager';
}

export interface ConversationMemoryRepository {
  retrieve(input: {
    readonly conversationId: string;
    readonly householdId: string;
    readonly userId: string;
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly ConversationMemoryEntry[]>;
  append(entry: ConversationMemoryAppend): Promise<void>;
}

export interface ManagerMemoryContext {
  readonly entries: readonly ConversationMemoryEntry[];
}

export interface ManagerConversationMemory {
  retrieveForManager(input: {
    readonly conversationId: string;
    readonly householdId: string;
    readonly userId: string;
    readonly query: string;
  }): Promise<ManagerMemoryContext>;
  appendManagerMessage(input: {
    readonly conversationId: string;
    readonly householdId: string;
    readonly userId: string;
    readonly role: ConversationMemoryRole;
    readonly content: string;
  }): Promise<ConversationMemoryEntry>;
}

const readExactObject = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> => {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    ) {
      throw new Error('invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      !ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    ) {
      throw new Error('invalid');
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        throw new Error('invalid');
      }
      result[key] = descriptor.value as unknown;
    }
    return Object.freeze(result);
  } catch {
    throw new Error('invalid-memory-request');
  }
};

const assertUuid = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error('invalid-memory-request');
  }
  return value;
};

const assertText = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_MEMORY_TEXT
  ) {
    throw new Error('invalid-memory-request');
  }
  return value;
};

const scopeFrom = (
  snapshot: Readonly<Record<string, unknown>>,
): Readonly<{
  conversationId: string;
  householdId: string;
  userId: string;
}> =>
  Object.freeze({
    conversationId: assertUuid(snapshot.conversationId),
    householdId: assertUuid(snapshot.householdId),
    userId: assertUuid(snapshot.userId),
  });

const snapshotEntry = (raw: unknown): ConversationMemoryEntry => {
  const snapshot = readExactObject(raw, [
    'id',
    'conversationId',
    'householdId',
    'userId',
    'role',
    'content',
    'createdAt',
  ]);
  if (snapshot.role !== 'user' && snapshot.role !== 'assistant') {
    throw new Error('invalid-memory-request');
  }
  if (
    typeof snapshot.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(snapshot.createdAt))
  ) {
    throw new Error('invalid-memory-request');
  }
  return Object.freeze({
    id: assertUuid(snapshot.id),
    ...scopeFrom(snapshot),
    role: snapshot.role,
    content: assertText(snapshot.content),
    createdAt: new Date(snapshot.createdAt).toISOString(),
  });
};

export class ConversationMemoryService implements ManagerConversationMemory {
  readonly #retrieve: ConversationMemoryRepository['retrieve'];
  readonly #append: ConversationMemoryRepository['append'];
  readonly #limit: number;
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(
    repository: ConversationMemoryRepository,
    limit = 12,
    clock: () => Date = () => new Date(),
    createId: () => string = randomUUID,
  ) {
    if (
      typeof repository?.retrieve !== 'function' ||
      typeof repository.append !== 'function' ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 64 ||
      typeof clock !== 'function' ||
      typeof createId !== 'function'
    ) {
      throw new Error('invalid-memory-dependency');
    }
    this.#retrieve = repository.retrieve.bind(repository);
    this.#append = repository.append.bind(repository);
    this.#limit = limit;
    this.#clock = clock;
    this.#createId = createId;
  }

  async retrieveForManager(input: {
    readonly conversationId: string;
    readonly householdId: string;
    readonly userId: string;
    readonly query: string;
  }): Promise<ManagerMemoryContext> {
    const snapshot = readExactObject(input, [
      'conversationId',
      'householdId',
      'userId',
      'query',
    ]);
    const scope = scopeFrom(snapshot);
    const query = assertText(snapshot.query);
    const rawEntries = await this.#retrieve({
      ...scope,
      query,
      limit: this.#limit,
    });
    if (!Array.isArray(rawEntries) || rawEntries.length > this.#limit) {
      throw new Error('invalid-memory-repository-result');
    }
    const entries = Object.freeze(rawEntries.map(snapshotEntry));
    for (const entry of entries) {
      if (
        entry.conversationId !== scope.conversationId ||
        entry.householdId !== scope.householdId ||
        entry.userId !== scope.userId
      ) {
        throw new Error('memory-scope-mismatch');
      }
    }
    return Object.freeze({ entries });
  }

  async appendManagerMessage(input: {
    readonly conversationId: string;
    readonly householdId: string;
    readonly userId: string;
    readonly role: ConversationMemoryRole;
    readonly content: string;
  }): Promise<ConversationMemoryEntry> {
    const snapshot = readExactObject(input, [
      'conversationId',
      'householdId',
      'userId',
      'role',
      'content',
    ]);
    const scope = scopeFrom(snapshot);
    if (snapshot.role !== 'user' && snapshot.role !== 'assistant') {
      throw new Error('invalid-memory-request');
    }
    const now = new Date(this.#clock());
    if (!Number.isFinite(now.getTime())) {
      throw new Error('invalid-memory-request');
    }
    const id = assertUuid(this.#createId());
    const entry: ConversationMemoryAppend = Object.freeze({
      id,
      ...scope,
      role: snapshot.role,
      content: assertText(snapshot.content),
      sourceAgentId: 'manager',
      createdAt: now.toISOString(),
    });
    await this.#append(entry);
    return Object.freeze({
      id: entry.id,
      conversationId: entry.conversationId,
      householdId: entry.householdId,
      userId: entry.userId,
      role: entry.role,
      content: entry.content,
      createdAt: entry.createdAt,
    });
  }
}
