export type AssistantSpecialist =
  'manager' | 'scheduler' | 'finance' | 'shopping';

export interface TurnRequest {
  readonly message: string;
  readonly specialist: AssistantSpecialist;
  readonly idempotencyKey: string;
  readonly csrfToken: string;
  readonly conversationId?: string;
}

export interface TurnAccepted {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly status: 'accepted';
  readonly replayed: boolean;
  readonly eventsPath: string;
}

export interface PersistedRunEvent {
  readonly id: string;
  readonly type: string;
  readonly data: unknown;
}

export interface HttpDependencies {
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly eventStreamLimits?: Partial<EventStreamLimits>;
}

export interface EventStreamLimits {
  readonly maxBytes: number;
  readonly maxEvents: number;
  readonly maxFrameBytes: number;
}

export const DEFAULT_EVENT_STREAM_LIMITS: EventStreamLimits = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxEvents: 4_096,
  maxFrameBytes: 256 * 1024,
});

export class ChatClientError extends Error {
  public constructor(
    public readonly code:
      'invalid-turn' | 'turn-request-failed' | 'event-stream-failed',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ChatClientError';
  }
}

function parseJsonRecord(value: string): unknown {
  if (value.length === 0) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseFrame(frame: string): PersistedRunEvent | undefined {
  let id = '';
  let type = 'message';
  const data: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? '' : line.slice(separator + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'id' && !value.includes('\0')) id = value;
    if (field === 'event' && value) type = value;
    if (field === 'data') data.push(value);
  }

  if (!id || data.length === 0) return undefined;
  return { id, type, data: parseJsonRecord(data.join('\n')) };
}

async function* toAsyncStrings(
  source: Iterable<string> | AsyncIterable<string>,
): AsyncGenerator<string> {
  for await (const chunk of source) yield chunk;
}

function eventStreamFailure(): ChatClientError {
  return new ChatClientError(
    'event-stream-failed',
    'EMDO lost the live response. Reconnect to continue.',
  );
}

function resolveEventStreamLimits(
  requested: Partial<EventStreamLimits> = {},
): EventStreamLimits {
  const resolveLimit = (value: number | undefined, maximum: number): number => {
    if (value === undefined) return maximum;
    if (!Number.isSafeInteger(value) || value < 1) throw eventStreamFailure();
    return Math.min(value, maximum);
  };
  return Object.freeze({
    maxBytes: resolveLimit(
      requested.maxBytes,
      DEFAULT_EVENT_STREAM_LIMITS.maxBytes,
    ),
    maxEvents: resolveLimit(
      requested.maxEvents,
      DEFAULT_EVENT_STREAM_LIMITS.maxEvents,
    ),
    maxFrameBytes: resolveLimit(
      requested.maxFrameBytes,
      DEFAULT_EVENT_STREAM_LIMITS.maxFrameBytes,
    ),
  });
}

async function* streamParsedEvents(
  chunks: Iterable<string> | AsyncIterable<string>,
  requestedLimits: Partial<EventStreamLimits> = {},
): AsyncGenerator<PersistedRunEvent> {
  const limits = resolveEventStreamLimits(requestedLimits);
  const encoder = new TextEncoder();
  let pending = '';
  let consumedBytes = 0;
  let eventCount = 0;

  const parseBoundedFrame = (frame: string): PersistedRunEvent | undefined => {
    if (encoder.encode(frame).byteLength > limits.maxFrameBytes) {
      throw eventStreamFailure();
    }
    const event = parseFrame(frame);
    if (event) {
      eventCount += 1;
      if (eventCount > limits.maxEvents) throw eventStreamFailure();
    }
    return event;
  };

  for await (const chunk of toAsyncStrings(chunks)) {
    consumedBytes += encoder.encode(chunk).byteLength;
    if (consumedBytes > limits.maxBytes) throw eventStreamFailure();
    pending += chunk.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    let boundary = pending.indexOf('\n\n');
    while (boundary >= 0) {
      const event = parseBoundedFrame(pending.slice(0, boundary));
      if (event) yield event;
      pending = pending.slice(boundary + 2);
      boundary = pending.indexOf('\n\n');
    }
    if (encoder.encode(pending).byteLength > limits.maxFrameBytes) {
      throw eventStreamFailure();
    }
  }

  const finalEvent = parseBoundedFrame(pending);
  if (finalEvent) yield finalEvent;
}

export async function parseEventStream(
  chunks: Iterable<string> | AsyncIterable<string>,
  limits: Partial<EventStreamLimits> = {},
): Promise<PersistedRunEvent[]> {
  const events: PersistedRunEvent[] = [];
  for await (const event of streamParsedEvents(chunks, limits))
    events.push(event);
  return events;
}

export class PersistedRunEventBuffer {
  readonly #events: PersistedRunEvent[] = [];
  readonly #ids = new Set<string>();
  #lastEventId?: string;

  public get lastEventId(): string | undefined {
    return this.#lastEventId;
  }

  public append(event: PersistedRunEvent): boolean {
    if (this.#ids.has(event.id)) return false;
    this.#ids.add(event.id);
    this.#events.push(structuredClone(event));
    this.#lastEventId = event.id;
    return true;
  }

  public snapshot(): readonly PersistedRunEvent[] {
    return structuredClone(this.#events);
  }
}

function assertTurnRequest(request: TurnRequest): void {
  if (!request.message.trim() || !request.idempotencyKey.trim()) {
    throw new ChatClientError(
      'invalid-turn',
      'Enter a request before sending.',
    );
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function isTurnAccepted(value: unknown): value is TurnAccepted {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.runId === 'string' &&
    record.status === 'accepted' &&
    typeof record.replayed === 'boolean' &&
    typeof record.eventsPath === 'string'
  );
}

export async function createTurn(
  request: TurnRequest,
  dependencies: HttpDependencies = {},
): Promise<TurnAccepted> {
  assertTurnRequest(request);
  const fetcher = dependencies.fetcher ?? fetch;
  const response = await fetcher('/api/v1/turns', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: dependencies.signal,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': request.idempotencyKey,
      'x-csrf-token': request.csrfToken,
    },
    body: JSON.stringify({
      schemaVersion: 1,
      message: request.message.trim(),
      ...(request.conversationId
        ? { conversationId: request.conversationId }
        : {}),
      ...(request.specialist === 'manager'
        ? {}
        : { routeHint: request.specialist }),
    }),
  });

  const body = await safeJson(response);
  if (!response.ok || !isTurnAccepted(body)) {
    throw new ChatClientError(
      'turn-request-failed',
      'EMDO could not start that request. Please try again.',
      response.status,
    );
  }
  return body;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

async function* responseTextChunks(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let completed = false;
  let cancellation: Promise<void> | undefined;
  try {
    while (true) {
      if (signal?.aborted) throw abortReason(signal);
      let removeAbortListener = (): void => undefined;
      const read = reader.read();
      const next = signal
        ? Promise.race([
            read,
            new Promise<never>((_resolve, reject) => {
              const onAbort = (): void => {
                const reason = abortReason(signal);
                reject(reason);
                cancellation = reader.cancel(reason).catch(() => undefined);
              };
              removeAbortListener = () =>
                signal.removeEventListener('abort', onAbort);
              signal.addEventListener('abort', onAbort, { once: true });
              if (signal.aborted) onAbort();
            }),
          ])
        : read;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await next;
      } finally {
        removeAbortListener();
      }
      if (result.done) {
        completed = true;
        break;
      }
      const { value } = result;
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    if (!completed && cancellation === undefined) {
      cancellation = reader.cancel().catch(() => undefined);
    }
    await cancellation;
    reader.releaseLock();
  }
}

export async function* readRunEvents(
  runId: string,
  dependencies: HttpDependencies & { readonly lastEventId?: string } = {},
): AsyncGenerator<PersistedRunEvent> {
  const fetcher = dependencies.fetcher ?? fetch;
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (dependencies.lastEventId)
    headers['Last-Event-ID'] = dependencies.lastEventId;

  const response = await fetcher(
    `/api/v1/runs/${encodeURIComponent(runId)}/events`,
    {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: dependencies.signal,
      headers,
    },
  );
  if (
    !response.ok ||
    !response.headers.get('content-type')?.includes('text/event-stream')
  ) {
    throw new ChatClientError(
      'event-stream-failed',
      'EMDO lost the live response. Reconnect to continue.',
      response.status,
    );
  }
  yield* streamParsedEvents(
    responseTextChunks(response, dependencies.signal),
    dependencies.eventStreamLimits,
  );
}
