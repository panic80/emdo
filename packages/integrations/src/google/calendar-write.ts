import { createHash } from 'node:crypto';

import {
  JsonValueSchema,
  ProviderWriteApprovalBindingSchema,
  ProviderWriteAuthorizationSchema,
  ProviderWriteOperationScopeSchema,
  deepFreeze,
  type DeepReadonly,
  type JsonValue,
  type ProviderWriteApprovalBinding,
  type ProviderWriteAuthorization,
  type ProviderWriteOperationScope,
} from '@emdo/contracts';
import { z } from 'zod';

const ReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      }),
    'Reference contains control characters',
  );
const CreatedGoogleEventIdSchema = z
  .string()
  .min(5)
  .max(240)
  .regex(/^[0-9a-v]+$/);
const OpaqueGoogleEventIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      }),
    'Google event ID contains control characters',
  );
const VersionSchema = z.string().trim().min(1).max(512);
const EventTextSchema = z.string().trim().min(1).max(8_000);

const GoogleCalendarEventPayloadSchema = z
  .strictObject({
    eventId: OpaqueGoogleEventIdSchema,
    summary: EventTextSchema.max(2_000),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    timeZone: z.literal('America/Toronto'),
    location: EventTextSchema.max(2_000).optional(),
    description: EventTextSchema.optional(),
    attendees: z.array(z.email().max(320)).max(100).optional(),
    recurrence: z
      .strictObject({
        frequency: z.enum(['daily', 'weekly']),
        interval: z.number().int().safe().min(1).max(52),
        count: z.number().int().safe().min(1).max(366),
        disambiguation: z.enum(['reject', 'earlier', 'later']),
        byWeekday: z
          .array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']))
          .min(1)
          .max(7)
          .optional(),
      })
      .optional(),
  })
  .superRefine((event, context) => {
    if (Date.parse(event.end) <= Date.parse(event.start)) {
      context.addIssue({
        code: 'custom',
        path: ['end'],
        message: 'Event end must follow event start',
      });
    }
  });

const CommonCommandShape = {
  schemaVersion: z.literal(1),
  calendarId: ReferenceSchema,
  expectedCalendarVersion: VersionSchema,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/),
} as const;

export const GoogleCalendarWriteCommandSchema = z.discriminatedUnion(
  'operation',
  [
    z
      .strictObject({
        ...CommonCommandShape,
        operation: z.literal('create'),
        eventId: CreatedGoogleEventIdSchema,
        expectedEventVersion: z.literal('absent'),
        payload: GoogleCalendarEventPayloadSchema,
      })
      .superRefine((value, context) => {
        if (value.eventId !== value.payload.eventId) {
          context.addIssue({
            code: 'custom',
            path: ['payload', 'eventId'],
            message: 'Payload event ID must match command event ID',
          });
        }
      }),
    z
      .strictObject({
        ...CommonCommandShape,
        operation: z.literal('update'),
        eventId: OpaqueGoogleEventIdSchema,
        expectedEventVersion: VersionSchema,
        payload: GoogleCalendarEventPayloadSchema,
      })
      .superRefine((value, context) => {
        if (value.eventId !== value.payload.eventId) {
          context.addIssue({
            code: 'custom',
            path: ['payload', 'eventId'],
            message: 'Payload event ID must match command event ID',
          });
        }
      }),
    z.strictObject({
      ...CommonCommandShape,
      operation: z.literal('delete'),
      eventId: OpaqueGoogleEventIdSchema,
      expectedEventVersion: VersionSchema,
      payload: z.null(),
    }),
  ],
);

export type GoogleCalendarWriteCommand = z.infer<
  typeof GoogleCalendarWriteCommandSchema
>;

const ApprovedCalendarCanonicalArgumentsSchema = z.discriminatedUnion(
  'operation',
  [
    z.strictObject({
      operation: z.literal('create'),
      calendarId: ReferenceSchema,
      expectedCalendarVersion: VersionSchema,
      event: GoogleCalendarEventPayloadSchema,
    }),
    z
      .strictObject({
        operation: z.literal('update'),
        calendarId: ReferenceSchema,
        eventId: OpaqueGoogleEventIdSchema,
        expectedCalendarVersion: VersionSchema,
        expectedEventVersion: VersionSchema,
        replacement: GoogleCalendarEventPayloadSchema,
      })
      .superRefine((value, context) => {
        if (value.eventId !== value.replacement.eventId) {
          context.addIssue({
            code: 'custom',
            path: ['replacement', 'eventId'],
            message: 'Replacement event ID must match the target event ID',
          });
        }
      }),
    z.strictObject({
      operation: z.literal('delete'),
      calendarId: ReferenceSchema,
      eventId: OpaqueGoogleEventIdSchema,
      expectedCalendarVersion: VersionSchema,
      expectedEventVersion: VersionSchema,
    }),
  ],
);

export type ApprovedCalendarCanonicalArguments = DeepReadonly<
  z.infer<typeof ApprovedCalendarCanonicalArgumentsSchema>
>;

const ProviderEventSchema = GoogleCalendarEventPayloadSchema.extend({
  eventVersion: VersionSchema,
});
const ProviderEventIdentitySchema = z.strictObject({
  eventId: OpaqueGoogleEventIdSchema,
  eventVersion: VersionSchema,
});
const ProviderStateSchema = z.strictObject({
  calendarId: ReferenceSchema,
  queriedEventId: OpaqueGoogleEventIdSchema,
  calendarVersion: VersionSchema,
  event: z.union([ProviderEventSchema, ProviderEventIdentitySchema]).nullable(),
});
export type GoogleCalendarProviderState = DeepReadonly<
  z.infer<typeof ProviderStateSchema>
>;

const ApplyResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('applied'),
    providerRequestId: ReferenceSchema,
  }),
  z.strictObject({
    status: z.literal('not-applied'),
    reason: z.enum(['conditional-rejected', 'provider-rejected']),
  }),
  z.strictObject({
    status: z.literal('indeterminate'),
    providerRequestId: ReferenceSchema,
  }),
]);
type ApplyResult = DeepReadonly<z.infer<typeof ApplyResultSchema>>;

const ApprovedCalendarWriteContextSchema = z.strictObject({
  approvedCanonicalArguments: ApprovedCalendarCanonicalArgumentsSchema,
  approvalBinding: ProviderWriteApprovalBindingSchema,
  providerWritePermit: ProviderWriteAuthorizationSchema,
  providerWriteOperationScope: ProviderWriteOperationScopeSchema,
});

export type CalendarWriteApprovalBinding = ProviderWriteApprovalBinding;

export interface ApprovedCalendarWriteContext {
  readonly approvedCanonicalArguments: ApprovedCalendarCanonicalArguments;
  readonly approvalBinding: CalendarWriteApprovalBinding;
  readonly providerWritePermit: ProviderWriteAuthorization;
  readonly providerWriteOperationScope: ProviderWriteOperationScope;
}

const isBoundedPlainData = (input: unknown): boolean => {
  const stack: Array<{ value: unknown; depth: number; exit?: true }> = [
    { value: input, depth: 0 },
  ];
  const active = new WeakSet<object>();
  let count = 0;
  try {
    while (stack.length > 0) {
      const item = stack.pop()!;
      count += 1;
      if (count > 50_000 || item.depth > 32) return false;
      if (item.exit) {
        if (item.value !== null && typeof item.value === 'object') {
          active.delete(item.value);
        }
        continue;
      }
      if (item.value === null || typeof item.value !== 'object') {
        if (
          item.value === undefined ||
          typeof item.value === 'function' ||
          typeof item.value === 'symbol' ||
          typeof item.value === 'bigint'
        ) {
          return false;
        }
        continue;
      }
      if (active.has(item.value)) return false;
      const prototype = Object.getPrototypeOf(item.value);
      if (
        !Array.isArray(item.value) &&
        prototype !== Object.prototype &&
        prototype !== null
      ) {
        return false;
      }
      active.add(item.value);
      stack.push({ value: item.value, depth: item.depth, exit: true });
      const descriptors = Object.getOwnPropertyDescriptors(item.value);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === 'symbol') return false;
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          return false;
        }
        stack.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    }
  } catch {
    return false;
  }
  return true;
};

const safeParseBounded = <Output>(
  schema: z.ZodType<Output>,
  input: unknown,
): { success: true; data: Output } | { success: false } => {
  if (!isBoundedPlainData(input)) return { success: false };
  try {
    const parsed = schema.safeParse(input);
    return parsed.success
      ? { success: true, data: parsed.data }
      : { success: false };
  } catch {
    return { success: false };
  }
};

const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(',')}}`;
};

const hashJson = (input: unknown): string => {
  if (!isBoundedPlainData(input)) throw new Error('Unhashable input');
  const value = JsonValueSchema.parse(input);
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
};

export const hashGoogleCalendarPayload = (payload: unknown): string =>
  hashJson(payload);

const calendarTargetId = (calendarId: string, eventId: string): string =>
  `${calendarId.length}:${calendarId}${eventId.length}:${eventId}`;

const hashApprovalBinding = (binding: CalendarWriteApprovalBinding): string =>
  hashJson({
    domain: 'emdo.provider-write-approval-binding.v1',
    binding,
  });

const hashCalendarWriteAttempt = (
  command: GoogleCalendarWriteCommand,
  authorization: ApprovedCalendarWriteContext,
): string =>
  hashJson({
    command,
    approvedCanonicalArguments: authorization.approvedCanonicalArguments,
    approvalBinding: authorization.approvalBinding,
    providerWritePermit: authorization.providerWritePermit,
  });

const capabilityForOperation = {
  create: 'google-calendar.event.create',
  update: 'google-calendar.event.update',
  delete: 'google-calendar.event.delete',
} as const;

const commandMatchesCanonicalArguments = (
  command: GoogleCalendarWriteCommand,
  canonicalArguments: ApprovedCalendarCanonicalArguments,
): boolean => {
  if (
    command.operation !== canonicalArguments.operation ||
    command.calendarId !== canonicalArguments.calendarId ||
    command.expectedCalendarVersion !==
      canonicalArguments.expectedCalendarVersion
  ) {
    return false;
  }
  if (canonicalArguments.operation === 'create') {
    return (
      command.operation === 'create' &&
      command.expectedEventVersion === 'absent' &&
      command.eventId === canonicalArguments.event.eventId &&
      hashJson(command.payload) === hashJson(canonicalArguments.event)
    );
  }
  if (canonicalArguments.operation === 'update') {
    return (
      command.operation === 'update' &&
      command.eventId === canonicalArguments.eventId &&
      command.expectedEventVersion ===
        canonicalArguments.expectedEventVersion &&
      hashJson(command.payload) === hashJson(canonicalArguments.replacement)
    );
  }
  return (
    command.operation === 'delete' &&
    command.eventId === canonicalArguments.eventId &&
    command.expectedEventVersion === canonicalArguments.expectedEventVersion &&
    command.payload === null
  );
};

const authorizationMatchesCommand = (
  command: GoogleCalendarWriteCommand,
  authorization: ApprovedCalendarWriteContext,
): boolean => {
  const targetId = calendarTargetId(command.calendarId, command.eventId);
  const expectedTarget = [
    {
      kind: 'google-calendar.event',
      id: targetId,
      expectedVersion: command.expectedEventVersion,
    },
  ];
  const expectedPreconditions = [
    {
      kind: 'calendar-version',
      targetId: command.calendarId,
      expectedValue: command.expectedCalendarVersion,
    },
    {
      kind: command.operation === 'create' ? 'event-absence' : 'event-version',
      targetId,
      expectedValue: command.expectedEventVersion,
    },
  ];
  const binding = authorization.approvalBinding;
  const permit = authorization.providerWritePermit;
  const authority = binding.authorityBinding;
  const operationScope = authorization.providerWriteOperationScope;
  const canonicalArguments = authorization.approvedCanonicalArguments;
  return (
    binding.capabilityId === capabilityForOperation[command.operation] &&
    binding.agentId === 'scheduler' &&
    operationScope.userId === binding.userId &&
    operationScope.householdId === authority.householdId &&
    operationScope.authorizationScopeFingerprint ===
      authority.authorizationScopeFingerprint &&
    binding.capabilityFingerprint === permit.capabilityFingerprint &&
    binding.disclosureGrantId === permit.disclosureGrantId &&
    binding.payloadHash === hashJson(canonicalArguments) &&
    hashJson(binding) === hashJson(permit.approvalBinding) &&
    hashApprovalBinding(binding) === permit.approvalBindingHash &&
    Date.parse(permit.idempotencyExpiresAt) - Date.parse(permit.issuedAt) ===
      binding.idempotencyTtlMs &&
    permit.providerIdempotencyKey === command.idempotencyKey &&
    command.payloadHash === hashJson(command.payload) &&
    commandMatchesCanonicalArguments(command, canonicalArguments) &&
    hashJson(permit.targets) === hashJson(expectedTarget) &&
    hashJson(permit.providerPreconditions) === hashJson(expectedPreconditions)
  );
};

/**
 * Defense-in-depth check for production provider adapters. The executor calls
 * the same check before dispatch; exporting the predicate prevents an adapter
 * from accepting a context that was not bound to this exact command.
 */
export const isGoogleCalendarWriteAuthorized = (
  command: GoogleCalendarWriteCommand,
  authorization: ApprovedCalendarWriteContext,
): boolean => {
  try {
    return authorizationMatchesCommand(command, authorization);
  } catch {
    return false;
  }
};

const parseApprovedContext = (
  input: unknown,
): ApprovedCalendarWriteContext | null => {
  const parsed = safeParseBounded(ApprovedCalendarWriteContextSchema, input);
  return parsed.success ? deepFreeze(parsed.data) : null;
};

export interface GoogleCalendarConditionalGateway {
  readCurrent(
    command: GoogleCalendarWriteCommand,
    authorization: ApprovedCalendarWriteContext,
  ): Promise<unknown>;
  /** Adapter must bind the provider request to command.idempotencyKey. */
  applyConditionalExactlyOnce(
    command: GoogleCalendarWriteCommand,
    authorization: ApprovedCalendarWriteContext,
  ): Promise<unknown>;
  readBack(
    command: GoogleCalendarWriteCommand,
    authorization: ApprovedCalendarWriteContext,
  ): Promise<unknown>;
}

export type CalendarWriteSafeErrorCode =
  | 'calendar-command-invalid'
  | 'calendar-authorization-invalid'
  | 'calendar-idempotency-conflict'
  | 'calendar-payload-hash-mismatch'
  | 'calendar-precondition-failed'
  | 'calendar-provider-indeterminate'
  | 'calendar-provider-rejected'
  | 'calendar-readback-invalid'
  | 'calendar-readback-mismatch';

export interface CalendarWriteSafeError {
  readonly code: CalendarWriteSafeErrorCode;
  readonly message: string;
  readonly retryable: false;
}

export type CalendarWriteResult = DeepReadonly<
  | {
      status: 'applied';
      providerRequestId: string | null;
      reconciled: boolean;
      readbackCalendarVersion: string;
      readback: z.infer<typeof ProviderEventSchema> | null;
    }
  | {
      status: 'not-applied';
      safeError: CalendarWriteSafeError;
    }
  | {
      status: 'indeterminate';
      reconciliationRequired: true;
      safeError: CalendarWriteSafeError;
    }
>;

const CalendarWriteSafeErrorSchema = z.strictObject({
  code: z.enum([
    'calendar-command-invalid',
    'calendar-authorization-invalid',
    'calendar-idempotency-conflict',
    'calendar-payload-hash-mismatch',
    'calendar-precondition-failed',
    'calendar-provider-indeterminate',
    'calendar-provider-rejected',
    'calendar-readback-invalid',
    'calendar-readback-mismatch',
  ]),
  message: z.string().min(1).max(2_000),
  retryable: z.literal(false),
});

const CalendarWriteResultSchema: z.ZodType<CalendarWriteResult> =
  z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('applied'),
      providerRequestId: ReferenceSchema.nullable(),
      reconciled: z.boolean(),
      readbackCalendarVersion: VersionSchema,
      readback: ProviderEventSchema.nullable(),
    }),
    z.strictObject({
      status: z.literal('not-applied'),
      safeError: CalendarWriteSafeErrorSchema,
    }),
    z.strictObject({
      status: z.literal('indeterminate'),
      reconciliationRequired: z.literal(true),
      safeError: CalendarWriteSafeErrorSchema,
    }),
  ]);

const safeError = (
  code: CalendarWriteSafeErrorCode,
  message: string,
): CalendarWriteSafeError => deepFreeze({ code, message, retryable: false });

type ReceiptAcquisition =
  | { readonly status: 'acquired' }
  | { readonly status: 'pending' }
  | { readonly status: 'conflict' }
  | { readonly status: 'existing'; readonly result: CalendarWriteResult };

const ReceiptAcquisitionSchema: z.ZodType<ReceiptAcquisition> =
  z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('acquired') }),
    z.strictObject({ status: z.literal('pending') }),
    z.strictObject({ status: z.literal('conflict') }),
    z.strictObject({
      status: z.literal('existing'),
      result: CalendarWriteResultSchema,
    }),
  ]);

export interface CalendarWriteReceiptStore {
  acquire(
    idempotencyKey: string,
    commandHash: string,
  ): Promise<ReceiptAcquisition>;
  complete(
    idempotencyKey: string,
    commandHash: string,
    result: CalendarWriteResult,
  ): Promise<void>;
}

interface StoredReceipt {
  readonly commandHash: string;
  result?: CalendarWriteResult;
}

export class InMemoryCalendarWriteReceiptStore implements CalendarWriteReceiptStore {
  readonly #receipts = new Map<string, StoredReceipt>();

  async acquire(
    idempotencyKey: string,
    commandHash: string,
  ): Promise<ReceiptAcquisition> {
    const existing = this.#receipts.get(idempotencyKey);
    if (existing === undefined) {
      this.#receipts.set(idempotencyKey, { commandHash });
      return { status: 'acquired' };
    }
    if (existing.commandHash !== commandHash) return { status: 'conflict' };
    return existing.result === undefined
      ? { status: 'pending' }
      : { status: 'existing', result: existing.result };
  }

  async complete(
    idempotencyKey: string,
    commandHash: string,
    result: CalendarWriteResult,
  ): Promise<void> {
    const existing = this.#receipts.get(idempotencyKey);
    if (
      existing?.commandHash !== commandHash ||
      existing.result !== undefined
    ) {
      throw new Error('Calendar receipt completion mismatch');
    }
    existing.result = deepFreeze(result);
  }
}

const notApplied = (
  code: CalendarWriteSafeErrorCode,
  message: string,
): CalendarWriteResult =>
  deepFreeze({ status: 'not-applied', safeError: safeError(code, message) });

const indeterminate = (
  code: CalendarWriteSafeErrorCode,
  message: string,
): CalendarWriteResult =>
  deepFreeze({
    status: 'indeterminate',
    reconciliationRequired: true,
    safeError: safeError(code, message),
  });

const providerPayload = (
  event: DeepReadonly<z.infer<typeof ProviderEventSchema>>,
): DeepReadonly<z.infer<typeof GoogleCalendarEventPayloadSchema>> =>
  GoogleCalendarEventPayloadSchema.parse(
    Object.fromEntries(
      Object.entries(event).filter(([key]) => key !== 'eventVersion'),
    ),
  );

const preconditionsMatch = (
  command: GoogleCalendarWriteCommand,
  state: GoogleCalendarProviderState,
): boolean =>
  state.calendarId === command.calendarId &&
  state.queriedEventId === command.eventId &&
  state.calendarVersion === command.expectedCalendarVersion &&
  (command.operation === 'create'
    ? state.event === null
    : state.event !== null &&
      state.event.eventId === command.eventId &&
      state.event.eventVersion === command.expectedEventVersion);

const readbackMatches = (
  command: GoogleCalendarWriteCommand,
  state: GoogleCalendarProviderState,
): boolean => {
  if (
    state.calendarId !== command.calendarId ||
    state.queriedEventId !== command.eventId
  ) {
    return false;
  }
  if (command.operation === 'delete') return state.event === null;
  const fullEvent = ProviderEventSchema.safeParse(state.event);
  return (
    fullEvent.success &&
    hashJson(providerPayload(fullEvent.data)) === command.payloadHash
  );
};

const verifiedReadbackEvent = (
  command: GoogleCalendarWriteCommand,
  state: GoogleCalendarProviderState,
): z.infer<typeof ProviderEventSchema> | null | undefined => {
  if (command.operation === 'delete') {
    return state.event === null ? null : undefined;
  }
  const parsed = ProviderEventSchema.safeParse(state.event);
  return parsed.success ? parsed.data : undefined;
};

export class CalendarWriteExecutor {
  readonly #inFlight = new Map<
    string,
    {
      readonly commandHash: string;
      readonly result: Promise<CalendarWriteResult>;
    }
  >();

  constructor(
    private readonly gateway: GoogleCalendarConditionalGateway,
    private readonly receipts: CalendarWriteReceiptStore,
  ) {}

  execute(
    input: unknown,
    authorizationInput: unknown,
  ): Promise<CalendarWriteResult> {
    const parsed = safeParseBounded(GoogleCalendarWriteCommandSchema, input);
    if (!parsed.success) {
      return Promise.resolve(
        notApplied(
          'calendar-command-invalid',
          'The calendar write command is invalid.',
        ),
      );
    }
    const command = deepFreeze(parsed.data) as GoogleCalendarWriteCommand;
    if (hashGoogleCalendarPayload(command.payload) !== command.payloadHash) {
      return Promise.resolve(
        notApplied(
          'calendar-payload-hash-mismatch',
          'The calendar payload hash does not match the command.',
        ),
      );
    }
    const parsedAuthorization = parseApprovedContext(authorizationInput);
    if (
      parsedAuthorization === null ||
      !authorizationMatchesCommand(command, parsedAuthorization)
    ) {
      return Promise.resolve(
        notApplied(
          'calendar-authorization-invalid',
          'The calendar write is not bound to an approved target.',
        ),
      );
    }
    const authorization = parsedAuthorization;
    const authorityBinding = authorization.approvalBinding.authorityBinding;
    // The current request/session/grant sidecar proves this invocation but is
    // intentionally excluded from durable provider idempotency. An exact
    // recovery under a freshly re-resolved operation scope must identify the
    // same provider attempt rather than conflict or dispatch again.
    const commandHash = hashCalendarWriteAttempt(command, authorization);
    const receiptKey = hashJson({
      userId: authorization.approvalBinding.userId,
      authorityKind: authorityBinding.kind,
      householdId: authorityBinding.householdId,
      privateSpaceId: authorityBinding.privateSpaceId,
      authorizationScopeFingerprint:
        authorityBinding.authorizationScopeFingerprint,
      providerGrantReference: authorityBinding.providerGrantReference,
      authorizationEpoch: authorityBinding.authorizationEpoch,
      providerIdempotencyKey:
        authorization.providerWritePermit.providerIdempotencyKey,
    });
    const active = this.#inFlight.get(receiptKey);
    if (active !== undefined) {
      return active.commandHash === commandHash
        ? active.result
        : Promise.resolve(
            notApplied(
              'calendar-idempotency-conflict',
              'The idempotency key is already bound to another command.',
            ),
          );
    }

    const result = this.#executeValidated(
      command,
      authorization,
      receiptKey,
      commandHash,
    );
    this.#inFlight.set(receiptKey, { commandHash, result });
    const cleanup = (): void => {
      const current = this.#inFlight.get(receiptKey);
      if (current?.result === result) {
        this.#inFlight.delete(receiptKey);
      }
    };
    void result.then(cleanup, cleanup);
    return result;
  }

  async #executeValidated(
    command: GoogleCalendarWriteCommand,
    authorization: ApprovedCalendarWriteContext,
    receiptKey: string,
    commandHash: string,
  ): Promise<CalendarWriteResult> {
    let rawAcquisition: unknown;
    try {
      rawAcquisition = await this.receipts.acquire(receiptKey, commandHash);
    } catch {
      return indeterminate(
        'calendar-provider-indeterminate',
        'The durable calendar attempt could not be acquired.',
      );
    }
    const parsedAcquisition = safeParseBounded(
      ReceiptAcquisitionSchema,
      rawAcquisition,
    );
    if (!parsedAcquisition.success) {
      return indeterminate(
        'calendar-provider-indeterminate',
        'The durable calendar attempt state is invalid.',
      );
    }
    const acquisition = parsedAcquisition.data;
    if (acquisition.status === 'existing') {
      return deepFreeze(acquisition.result);
    }
    if (acquisition.status === 'conflict') {
      return notApplied(
        'calendar-idempotency-conflict',
        'The idempotency key is already bound to another command.',
      );
    }
    if (acquisition.status === 'pending') {
      const reconciled = await this.#reconcilePending(command, authorization);
      if (reconciled.status !== 'applied') return reconciled;
      try {
        await this.receipts.complete(receiptKey, commandHash, reconciled);
      } catch {
        return indeterminate(
          'calendar-provider-indeterminate',
          'The reconciled calendar attempt could not be finalized.',
        );
      }
      return reconciled;
    }

    let result: CalendarWriteResult;
    try {
      const current = safeParseBounded(
        ProviderStateSchema,
        await this.gateway.readCurrent(command, authorization),
      );
      if (!current.success) {
        result = indeterminate(
          'calendar-readback-invalid',
          'Current provider state could not be validated.',
        );
      } else if (!preconditionsMatch(command, current.data)) {
        result = notApplied(
          'calendar-precondition-failed',
          'The calendar changed before execution.',
        );
      } else {
        result = await this.#applyAndVerify(command, authorization);
      }
    } catch {
      result = indeterminate(
        'calendar-provider-indeterminate',
        'The provider outcome could not be determined.',
      );
    }
    try {
      await this.receipts.complete(receiptKey, commandHash, result);
    } catch {
      return indeterminate(
        'calendar-provider-indeterminate',
        'The calendar outcome could not be durably finalized.',
      );
    }
    return result;
  }

  async #applyAndVerify(
    command: GoogleCalendarWriteCommand,
    authorization: ApprovedCalendarWriteContext,
  ): Promise<CalendarWriteResult> {
    const applied = safeParseBounded(
      ApplyResultSchema,
      await this.gateway.applyConditionalExactlyOnce(command, authorization),
    );
    if (!applied.success) {
      return indeterminate(
        'calendar-provider-indeterminate',
        'The provider write response could not be validated.',
      );
    }
    if (applied.data.status === 'not-applied') {
      return notApplied(
        'calendar-provider-rejected',
        'The provider rejected the conditional write.',
      );
    }

    const readback = safeParseBounded(
      ProviderStateSchema,
      await this.gateway.readBack(command, authorization),
    );
    if (!readback.success) {
      return indeterminate(
        'calendar-readback-invalid',
        'Provider readback could not be validated.',
      );
    }
    if (!readbackMatches(command, readback.data)) {
      return indeterminate(
        'calendar-readback-mismatch',
        'Provider readback did not match the approved calendar action.',
      );
    }
    const verifiedEvent = verifiedReadbackEvent(command, readback.data);
    if (verifiedEvent === undefined) {
      return indeterminate(
        'calendar-readback-invalid',
        'Provider readback did not include the approved event payload.',
      );
    }
    return deepFreeze({
      status: 'applied' as const,
      providerRequestId: applied.data.providerRequestId,
      reconciled: false,
      readbackCalendarVersion: readback.data.calendarVersion,
      readback: verifiedEvent,
    });
  }

  async #reconcilePending(
    command: GoogleCalendarWriteCommand,
    authorization: ApprovedCalendarWriteContext,
  ): Promise<CalendarWriteResult> {
    try {
      const readback = safeParseBounded(
        ProviderStateSchema,
        await this.gateway.readBack(command, authorization),
      );
      if (!readback.success || !readbackMatches(command, readback.data)) {
        return indeterminate(
          'calendar-provider-indeterminate',
          'A prior calendar attempt still requires reconciliation.',
        );
      }
      const verifiedEvent = verifiedReadbackEvent(command, readback.data);
      if (verifiedEvent === undefined) {
        return indeterminate(
          'calendar-provider-indeterminate',
          'A prior calendar attempt still requires reconciliation.',
        );
      }
      return deepFreeze({
        status: 'applied' as const,
        providerRequestId: null,
        reconciled: true,
        readbackCalendarVersion: readback.data.calendarVersion,
        readback: verifiedEvent,
      });
    } catch {
      return indeterminate(
        'calendar-provider-indeterminate',
        'A prior calendar attempt still requires reconciliation.',
      );
    }
  }
}

const ProviderStateBodySchema = z.strictObject({
  calendarVersion: VersionSchema,
  event: ProviderEventSchema.nullable(),
});
const RecordedGatewayFixtureSchema = z.strictObject({
  binding: z.strictObject({
    calendarId: ReferenceSchema,
    eventId: OpaqueGoogleEventIdSchema,
    operation: z.enum(['create', 'update', 'delete']),
  }),
  before: ProviderStateBodySchema,
  apply: ApplyResultSchema,
  after: ProviderStateBodySchema,
});

/** No network transport: deterministic adapter over captured, synthetic data. */
export class RecordedGoogleCalendarGateway implements GoogleCalendarConditionalGateway {
  readonly #fixture: DeepReadonly<z.infer<typeof RecordedGatewayFixtureSchema>>;
  #current: DeepReadonly<z.infer<typeof ProviderStateBodySchema>>;
  #applyCount = 0;
  #readCurrentCount = 0;
  #readbackCount = 0;
  readonly #applications = new Map<
    string,
    { hash: string; result: ApplyResult }
  >();

  constructor(input: unknown) {
    const parsed = safeParseBounded(RecordedGatewayFixtureSchema, input);
    if (!parsed.success) throw new Error('Invalid recorded Calendar fixture');
    this.#fixture = deepFreeze(parsed.data);
    this.#current = this.#fixture.before;
  }

  get applyCount(): number {
    return this.#applyCount;
  }

  get readCurrentCount(): number {
    return this.#readCurrentCount;
  }

  get readbackCount(): number {
    return this.#readbackCount;
  }

  async readCurrent(
    command: GoogleCalendarWriteCommand,
    authorization: ApprovedCalendarWriteContext,
  ): Promise<GoogleCalendarProviderState> {
    if (!authorizationMatchesCommand(command, authorization)) {
      throw new Error('Recorded Calendar authorization mismatch');
    }
    this.#readCurrentCount += 1;
    return deepFreeze({
      calendarId: this.#fixture.binding.calendarId,
      queriedEventId: this.#fixture.binding.eventId,
      ...this.#current,
    });
  }

  async applyConditionalExactlyOnce(
    command: GoogleCalendarWriteCommand,
    authorization: ApprovedCalendarWriteContext,
  ): Promise<ApplyResult> {
    if (
      !authorizationMatchesCommand(command, authorization) ||
      command.calendarId !== this.#fixture.binding.calendarId ||
      command.eventId !== this.#fixture.binding.eventId ||
      command.operation !== this.#fixture.binding.operation
    ) {
      return deepFreeze({
        status: 'not-applied',
        reason: 'conditional-rejected',
      });
    }
    const fingerprint = hashCalendarWriteAttempt(command, authorization);
    const existing = this.#applications.get(command.idempotencyKey);
    if (existing !== undefined) {
      return existing.hash === fingerprint
        ? existing.result
        : deepFreeze({
            status: 'not-applied',
            reason: 'conditional-rejected',
          });
    }
    const current = deepFreeze({
      calendarId: this.#fixture.binding.calendarId,
      queriedEventId: this.#fixture.binding.eventId,
      ...this.#current,
    });
    if (!preconditionsMatch(command, current)) {
      const rejected = deepFreeze({
        status: 'not-applied' as const,
        reason: 'conditional-rejected' as const,
      });
      this.#applications.set(command.idempotencyKey, {
        hash: fingerprint,
        result: rejected,
      });
      return rejected;
    }
    this.#applyCount += 1;
    if (this.#fixture.apply.status !== 'not-applied') {
      this.#current = this.#fixture.after;
    }
    this.#applications.set(command.idempotencyKey, {
      hash: fingerprint,
      result: this.#fixture.apply,
    });
    return this.#fixture.apply;
  }

  async readBack(
    command: GoogleCalendarWriteCommand,
    authorization: ApprovedCalendarWriteContext,
  ): Promise<GoogleCalendarProviderState> {
    if (!authorizationMatchesCommand(command, authorization)) {
      throw new Error('Recorded Calendar authorization mismatch');
    }
    this.#readbackCount += 1;
    return deepFreeze({
      calendarId: this.#fixture.binding.calendarId,
      queriedEventId: this.#fixture.binding.eventId,
      ...this.#current,
    });
  }
}
