import { OpaqueReferenceSchema, deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

import {
  TransactionalEmailMessageSchema,
  type TransactionalEmailTransport,
} from './notification-email.js';

const RESEND_API_ORIGIN = 'https://api.resend.com';
const MAXIMUM_PROVIDER_RESPONSE_BYTES = 16_384;
const READINESS_TIMEOUT_MS = 1_500;
const DEFAULT_READINESS_SUCCESS_TTL_MS = 30_000;
const DEFAULT_READINESS_FAILURE_TTL_MS = 2_000;

const ConfigurationSchema = z.strictObject({
  apiKey: z
    .string()
    .min(23)
    .max(512)
    .regex(/^re_[A-Za-z0-9_-]+$/u),
  fromEmail: z
    .email()
    .max(320)
    .refine((value) => value === value.toLowerCase())
    .refine((value) => value.slice(value.lastIndexOf('@') + 1).includes('.')),
});
const SendSuccessSchema = z.strictObject({ id: OpaqueReferenceSchema });
const ProviderErrorSchema = z.object({ name: z.string().min(1).max(128) });
const DomainListSchema = z.strictObject({
  object: z.literal('list'),
  has_more: z.boolean(),
  data: z
    .array(
      z.object({
        id: z.string().min(1).max(1_024),
        name: z.string().min(1).max(253),
        status: z.string().min(1).max(64),
        capabilities: z.object({
          sending: z.string().min(1).max(64),
          receiving: z.string().min(1).max(64),
        }),
      }),
    )
    .max(100),
});

type Fetch = (request: Request) => Promise<Response>;

const readBoundedText = async (response: Response): Promise<string> => {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAXIMUM_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('provider-response-too-large');
      }
      chunks.push(next.value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } finally {
    reader.releaseLock();
  }
};

const readBoundedJson = async (response: Response): Promise<unknown> => {
  const text = await readBoundedText(response);
  return JSON.parse(text) as unknown;
};

const captureFetch = (candidate: unknown): Fetch => {
  if (typeof candidate !== 'function') {
    throw new Error('Transactional email configuration is invalid');
  }
  return (request: Request) =>
    Reflect.apply(candidate, globalThis, [request]) as Promise<Response>;
};

export class ResendTransactionalEmailTransport implements TransactionalEmailTransport {
  readonly #apiKey: string;
  readonly #clock: () => number;
  readonly #fetch: Fetch;
  readonly #fromEmail: string;
  readonly #readinessFailureTtlMs: number;
  readonly #readinessSuccessTtlMs: number;
  readonly #sendingDomain: string;
  #readinessCache:
    { readonly expiresAt: number; readonly ready: boolean } | undefined;
  #readinessInFlight: Promise<boolean> | undefined;

  constructor(
    configuration: { readonly apiKey: string; readonly fromEmail: string },
    dependencies: {
      readonly fetch?: Fetch;
      readonly clock?: () => number;
      readonly readinessSuccessTtlMs?: number;
      readonly readinessFailureTtlMs?: number;
    } = {},
  ) {
    const parsed = ConfigurationSchema.safeParse(configuration);
    if (!parsed.success) {
      throw new Error('Transactional email configuration is invalid');
    }
    this.#apiKey = parsed.data.apiKey;
    this.#fromEmail = parsed.data.fromEmail;
    this.#sendingDomain = parsed.data.fromEmail.slice(
      parsed.data.fromEmail.lastIndexOf('@') + 1,
    );
    this.#fetch = captureFetch(dependencies.fetch ?? globalThis.fetch);
    this.#clock = dependencies.clock ?? Date.now;
    this.#readinessSuccessTtlMs =
      dependencies.readinessSuccessTtlMs ?? DEFAULT_READINESS_SUCCESS_TTL_MS;
    this.#readinessFailureTtlMs =
      dependencies.readinessFailureTtlMs ?? DEFAULT_READINESS_FAILURE_TTL_MS;
    if (
      typeof this.#clock !== 'function' ||
      !Number.isSafeInteger(this.#readinessSuccessTtlMs) ||
      this.#readinessSuccessTtlMs < 1 ||
      this.#readinessSuccessTtlMs > 60_000 ||
      !Number.isSafeInteger(this.#readinessFailureTtlMs) ||
      this.#readinessFailureTtlMs < 1 ||
      this.#readinessFailureTtlMs > 60_000
    ) {
      throw new Error('Transactional email configuration is invalid');
    }
  }

  async send(
    input: unknown,
    context: { readonly signal: AbortSignal },
  ): Promise<unknown> {
    context.signal.throwIfAborted();
    const message = TransactionalEmailMessageSchema.safeParse(input);
    if (!message.success) {
      throw new Error('Transactional email message is invalid');
    }
    let response: Response;
    try {
      response = await this.#fetch(
        new Request(`${RESEND_API_ORIGIN}/emails`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${this.#apiKey}`,
            'content-type': 'application/json',
            'idempotency-key': message.data.deliveryId,
          },
          body: JSON.stringify({
            from: this.#fromEmail,
            to: [message.data.recipient],
            subject: message.data.subject,
            text: message.data.text,
          }),
          signal: context.signal,
        }),
      );
    } catch {
      return deepFreeze({ status: 'indeterminate' as const });
    }
    try {
      const raw = await readBoundedJson(response);
      if (response.ok) {
        const result = SendSuccessSchema.safeParse(raw);
        return result.success
          ? deepFreeze({
              status: 'sent' as const,
              providerMessageReference: result.data.id,
            })
          : deepFreeze({ status: 'indeterminate' as const });
      }
      const providerError = ProviderErrorSchema.safeParse(raw);
      if (
        response.status === 409 &&
        providerError.success &&
        providerError.data.name === 'invalid_idempotent_request'
      ) {
        return deepFreeze({ status: 'not-applied' as const });
      }
      if (
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500 ||
        (response.status === 409 &&
          providerError.success &&
          providerError.data.name === 'concurrent_idempotent_requests')
      ) {
        return deepFreeze({ status: 'indeterminate' as const });
      }
      return deepFreeze({ status: 'not-applied' as const });
    } catch {
      return deepFreeze({ status: 'indeterminate' as const });
    }
  }

  async checkReady(): Promise<boolean> {
    let now: number;
    try {
      now = this.#clock();
    } catch {
      return false;
    }
    if (!Number.isFinite(now)) return false;
    if (
      this.#readinessCache !== undefined &&
      now < this.#readinessCache.expiresAt
    ) {
      return this.#readinessCache.ready;
    }
    if (this.#readinessInFlight !== undefined) {
      return this.#readinessInFlight;
    }
    this.#readinessInFlight = this.#probeReadiness()
      .then((ready) => {
        let checkedAt: number;
        try {
          checkedAt = this.#clock();
        } catch {
          return false;
        }
        if (!Number.isFinite(checkedAt)) return false;
        this.#readinessCache = Object.freeze({
          ready,
          expiresAt:
            checkedAt +
            (ready ? this.#readinessSuccessTtlMs : this.#readinessFailureTtlMs),
        });
        return ready;
      })
      .finally(() => {
        this.#readinessInFlight = undefined;
      });
    return this.#readinessInFlight;
  }

  async #probeReadiness(): Promise<boolean> {
    try {
      const response = await this.#fetch(
        new Request(`${RESEND_API_ORIGIN}/domains?limit=100`, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${this.#apiKey}`,
          },
          cache: 'no-store',
          signal: AbortSignal.timeout(READINESS_TIMEOUT_MS),
        }),
      );
      if (!response.ok) return false;
      const domains = DomainListSchema.safeParse(
        await readBoundedJson(response),
      );
      return (
        domains.success &&
        domains.data.data.some(
          (domain) =>
            domain.name === this.#sendingDomain &&
            domain.status === 'verified' &&
            domain.capabilities.sending === 'enabled',
        )
      );
    } catch {
      return false;
    }
  }
}
