import { createHash, randomUUID } from 'node:crypto';

const TRACE_TYPE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TRACE_REFERENCE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SECRET_FIELD_PATTERN =
  /(?:authorization|cookie|credential|password|secret|token|api.?key|serialized.?state|provider.?payload|raw.?content)/i;
const PRIVATE_IDENTIFIER_PATTERN =
  /^(?:user|household|conversation|request|run|spaceAccessGrant|disclosureGrant)Id$/i;
const MAX_TRACE_DEPTH = 8;
const MAX_TRACE_NODES = 1_024;
const MAX_TRACE_STRING_LENGTH = 2_048;

export type TraceValue =
  | null
  | boolean
  | number
  | string
  | readonly TraceValue[]
  | Readonly<{ [key: string]: TraceValue }>;

export interface LocalTraceEvent {
  readonly traceReference: string;
  readonly runReference: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly metadata: Readonly<Record<string, TraceValue>>;
}

export interface LocalTraceSink {
  append(event: LocalTraceEvent): Promise<void>;
}

export interface ActiveLocalTrace {
  readonly reference: string;
  record(
    type: string,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<void>;
}

const pseudonymize = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;

const sanitizeMetadata = (
  raw: unknown,
): Readonly<Record<string, TraceValue>> => {
  let nodes = 0;
  const seen = new WeakSet<object>();

  const sanitize = (
    value: unknown,
    depth: number,
    key?: string,
  ): TraceValue => {
    nodes += 1;
    if (nodes > MAX_TRACE_NODES || depth > MAX_TRACE_DEPTH) {
      throw new Error('trace-metadata-too-large');
    }
    if (key !== undefined && SECRET_FIELD_PATTERN.test(key)) {
      return '[redacted]';
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('invalid-trace-number');
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_TRACE_STRING_LENGTH) {
        throw new Error('trace-metadata-too-large');
      }
      return key !== undefined && PRIVATE_IDENTIFIER_PATTERN.test(key)
        ? pseudonymize(value)
        : value;
    }
    if (typeof value !== 'object') throw new Error('invalid-trace-value');
    if (seen.has(value)) throw new Error('cyclic-trace-value');
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 128) throw new Error('trace-metadata-too-large');
      return Object.freeze(value.map((entry) => sanitize(entry, depth + 1)));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('invalid-trace-object');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error('invalid-trace-object');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length > 128) throw new Error('trace-metadata-too-large');
    const result: Record<string, TraceValue> = {};
    for (const nestedKey of keys.sort()) {
      const descriptor = descriptors[nestedKey];
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !('value' in descriptor)
      ) {
        throw new Error('invalid-trace-object');
      }
      result[nestedKey] = sanitize(
        descriptor.value as unknown,
        depth + 1,
        nestedKey,
      );
    }
    return Object.freeze(result);
  };

  const sanitized = sanitize(raw, 0);
  if (
    Array.isArray(sanitized) ||
    sanitized === null ||
    typeof sanitized !== 'object'
  ) {
    throw new Error('invalid-trace-metadata');
  }
  return sanitized as Readonly<Record<string, TraceValue>>;
};

export const redactTraceMetadata = (
  metadata: unknown,
): Readonly<Record<string, TraceValue>> => {
  try {
    return sanitizeMetadata(metadata);
  } catch {
    return Object.freeze({ redaction: 'metadata-unavailable' });
  }
};

export class LocalTraceRecorder {
  readonly #append: LocalTraceSink['append'];
  readonly #clock: () => Date;
  readonly #createReference: () => string;

  constructor(
    sink: LocalTraceSink,
    clock: () => Date = () => new Date(),
    createReference: () => string = () => `trace-${randomUUID()}`,
  ) {
    if (
      typeof sink?.append !== 'function' ||
      typeof clock !== 'function' ||
      typeof createReference !== 'function'
    ) {
      throw new Error('invalid-trace-dependency');
    }
    this.#append = sink.append.bind(sink);
    this.#clock = clock;
    this.#createReference = createReference;
  }

  start(runId: string): ActiveLocalTrace {
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new Error('invalid-trace-run');
    }
    const reference = this.#createReference();
    if (
      typeof reference !== 'string' ||
      reference.length < 2 ||
      reference.length > 160 ||
      !TRACE_REFERENCE_PATTERN.test(reference)
    ) {
      throw new Error('invalid-trace-reference');
    }
    const runReference = pseudonymize(runId);
    const record = async (
      type: string,
      metadata: Readonly<Record<string, unknown>> = {},
    ): Promise<void> => {
      if (
        typeof type !== 'string' ||
        type.length < 2 ||
        type.length > 160 ||
        !TRACE_TYPE_PATTERN.test(type)
      ) {
        throw new Error('invalid-trace-event');
      }
      const now = new Date(this.#clock());
      if (!Number.isFinite(now.getTime())) {
        throw new Error('invalid-trace-clock');
      }
      const event: LocalTraceEvent = Object.freeze({
        traceReference: reference,
        runReference,
        type,
        occurredAt: now.toISOString(),
        metadata: redactTraceMetadata(metadata),
      });
      await this.#append(event);
    };
    return Object.freeze({ reference, record });
  }
}
