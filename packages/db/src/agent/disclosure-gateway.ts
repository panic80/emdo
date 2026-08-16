import { createHash } from 'node:crypto';

import {
  DataDisclosureGrantSchema,
  DataClassSchema,
  IdentifierSchema,
  JsonValueSchema,
  OpaqueReferenceSchema,
  UuidSchema,
  deepFreeze,
  type DataDisclosureGrant,
  type JsonValue,
} from '@emdo/contracts';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import {
  firstResultRow,
  parseDurablePrincipal,
  withClaimedTransaction,
  type DurableRepositoryPrincipal,
} from '../durable/scoped-transaction.js';

const PhasePurposeSchema = z.enum([
  'manager-plan',
  'specialist-execution',
  'manager-synthesis',
]);
const DenialReasonSchema = z.enum([
  'grant-not-found',
  'grant-run-mismatch',
  'grant-household-mismatch',
  'grant-user-mismatch',
  'grant-agent-mismatch',
  'grant-purpose-mismatch',
  'grant-provider-mismatch',
  'grant-expired',
  'record-not-allowed',
  'field-not-allowed',
  'no-active-grant',
]);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const RecordAllowlistSchema = z
  .array(
    z.strictObject({
      dataClass: DataClassSchema,
      recordId: OpaqueReferenceSchema,
      fields: z.array(IdentifierSchema).min(1).max(128),
    }),
  )
  .min(1)
  .max(256)
  .superRefine((records, context) => {
    const bindings = new Set<string>();
    for (const [index, record] of records.entries()) {
      const binding = `${record.dataClass}\0${record.recordId}`;
      if (
        bindings.has(binding) ||
        new Set(record.fields).size !== record.fields.length
      ) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Disclosure allowlist contains a duplicate binding',
        });
      }
      bindings.add(binding);
    }
  });
const IssueGrantInputSchema = z.strictObject({
  requestId: UuidSchema,
  runId: UuidSchema,
  householdId: UuidSchema,
  userId: UuidSchema,
  spaceId: UuidSchema,
  spaceAccessGrantId: UuidSchema,
  agentId: IdentifierSchema,
  phasePurpose: PhasePurposeSchema,
  disclosurePurpose: z.string().trim().min(3).max(500),
  provider: z.literal('openai'),
  recordAllowlist: RecordAllowlistSchema,
});
const IssuedGrantRowSchema = z.looseObject({
  schema_version: z.literal(1),
  version: z.number().int().positive().safe(),
  grant_id: UuidSchema,
  household_id: UuidSchema,
  space_id: UuidSchema,
  original_owner_user_id: UuidSchema,
  run_id: UuidSchema,
  agent_id: IdentifierSchema,
  purpose: z.string().trim().min(3).max(500),
  phase_purpose: PhasePurposeSchema,
  provider: z.literal('openai'),
  record_allowlist: RecordAllowlistSchema,
  grant_hash: HashSchema,
  one_run_only: z.literal(true),
  created_at: z.coerce.date(),
  expires_at: z.coerce.date(),
  database_time: z.coerce.date(),
});
const ActiveGrantRowSchema = z.looseObject({
  status: z.literal('active'),
  schema_version: z.literal(1),
  version: z.number().int().safe().positive(),
  grant_id: UuidSchema,
  household_id: UuidSchema,
  space_id: UuidSchema,
  original_owner_user_id: UuidSchema,
  run_id: UuidSchema,
  agent_id: IdentifierSchema,
  purpose: z.string().trim().min(3).max(500),
  provider: z.literal('openai'),
  record_allowlist: RecordAllowlistSchema,
  grant_hash: HashSchema,
  created_at: z.coerce.date(),
  expires_at: z.coerce.date(),
  database_time: z.coerce.date(),
});
const DeniedGrantRowSchema = z.looseObject({
  status: DenialReasonSchema,
  grant_id: UuidSchema.nullish(),
});
const ResolutionRowSchema = z.discriminatedUnion('status', [
  ActiveGrantRowSchema,
  DeniedGrantRowSchema,
]);
const AuthorizationInputSchema = z
  .strictObject({
    requestId: UuidSchema,
    runId: UuidSchema,
    householdId: UuidSchema,
    userId: UuidSchema,
    spaceAccessGrantId: UuidSchema,
    agentId: IdentifierSchema,
    phasePurpose: PhasePurposeSchema,
    provider: z.literal('openai'),
    requestedGrantId: UuidSchema.optional(),
    requestedDataClasses: z.array(DataClassSchema).max(64),
    payload: JsonValueSchema,
  })
  .superRefine((value, context) => {
    if (
      new Set(value.requestedDataClasses).size !==
      value.requestedDataClasses.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['requestedDataClasses'],
        message: 'Requested data classes must be unique',
      });
    }
  });

const SchedulerDisclosureGrantResolverScopeSchema = z.strictObject({
  runId: UuidSchema,
  householdId: UuidSchema,
  userId: UuidSchema,
  spaceAccessGrantId: UuidSchema,
  agentId: z.literal('scheduler'),
  phasePurpose: z.literal('specialist-execution'),
  provider: z.literal('openai'),
});
export type SchedulerDisclosureGrantResolverScope = z.output<
  typeof SchedulerDisclosureGrantResolverScopeSchema
>;

const CanonicalEnvelopeSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    records: z
      .array(
        z.strictObject({
          dataClass: DataClassSchema,
          recordId: OpaqueReferenceSchema,
          fields: z
            .record(IdentifierSchema, JsonValueSchema)
            .refine((value) => {
              const count = Object.keys(value).length;
              return count >= 1 && count <= 128;
            }),
        }),
      )
      .max(256),
  })
  .superRefine((value, context) => {
    const bindings = value.records.map(
      ({ dataClass, recordId }) => `${dataClass}\0${recordId}`,
    );
    if (new Set(bindings).size !== bindings.length) {
      context.addIssue({
        code: 'custom',
        path: ['records'],
        message: 'Canonical disclosure records must be unique',
      });
    }
  });

export type ModelDisclosureDenialReason = z.output<typeof DenialReasonSchema>;
type BoundModelDisclosureDenialReason = Exclude<
  ModelDisclosureDenialReason,
  'no-active-grant'
>;

export interface DisclosureFilterGrant {
  readonly recordAllowlist: readonly Readonly<{
    readonly dataClass: string;
    readonly recordId: string;
    readonly fields: readonly string[];
  }>[];
}

export type DisclosurePayloadFilterResult =
  | Readonly<{
      status: 'filtered';
      payload: JsonValue;
      records: readonly Readonly<{
        dataClass: string;
        recordId: string;
        fields: readonly string[];
      }>[];
    }>
  | Readonly<{
      status: 'denied';
      reason: 'record-not-allowed' | 'field-not-allowed';
    }>;

/** Domain-aware alternatives must be server-owned and may never pass through. */
export interface DisclosurePayloadFilter {
  filter(
    input: Readonly<{
      payload: JsonValue;
      requestedDataClasses: readonly string[];
      grant: DisclosureFilterGrant;
    }>,
  ): DisclosurePayloadFilterResult;
}

const snapshotJsonValue = (value: JsonValue): JsonValue => {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => snapshotJsonValue(entry));
  }
  const snapshot: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    const nested = value[key];
    if (nested !== undefined) {
      snapshot[key] = snapshotJsonValue(nested);
    }
  }
  return snapshot;
};

const canonicalJson = (value: JsonValue): string => {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(',')}}`;
};

export const hashDataDisclosureGrant = (grant: DataDisclosureGrant): string =>
  createHash('sha256')
    .update(canonicalJson(JsonValueSchema.parse(grant)))
    .digest('hex');

const normalizeRecordAllowlist = (
  records: z.output<typeof RecordAllowlistSchema>,
) =>
  records
    .map((record) => ({
      dataClass: record.dataClass,
      recordId: record.recordId,
      fields: [...record.fields].sort(),
    }))
    .sort((left, right) =>
      `${left.dataClass}\0${left.recordId}`.localeCompare(
        `${right.dataClass}\0${right.recordId}`,
      ),
    );

export class DataDisclosureGrantIssueError extends Error {
  constructor(
    readonly code: 'authorization-revoked' | 'invalid-input' | 'invalid-result',
    message: string,
  ) {
    super(message);
    this.name = 'DataDisclosureGrantIssueError';
  }
}

export class SchedulerDisclosureGrantResolverError extends Error {
  constructor(
    readonly code: 'invalid-input' | 'invalid-result',
    message: string,
  ) {
    super(message);
    this.name = 'SchedulerDisclosureGrantResolverError';
  }
}

export interface IssuedDataDisclosureGrant {
  readonly grant: DataDisclosureGrant;
  readonly grantHash: string;
  readonly phasePurpose: z.output<typeof PhasePurposeSchema>;
  readonly spaceId: string;
}

/** Issues one DB-clock-bound grant for an exact run/agent/phase authority tuple. */
export class PostgresDataDisclosureGrantIssuer {
  readonly #principal: Readonly<DurableRepositoryPrincipal>;

  constructor(
    private readonly pool: DatabasePool,
    principal: DurableRepositoryPrincipal,
  ) {
    this.#principal = parseDurablePrincipal(principal);
  }

  async issue(
    input: z.input<typeof IssueGrantInputSchema>,
  ): Promise<Readonly<IssuedDataDisclosureGrant>> {
    const parsed = IssueGrantInputSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.requestId !== this.#principal.requestId ||
      parsed.data.householdId !== this.#principal.householdId ||
      parsed.data.userId !== this.#principal.userId
    ) {
      throw new DataDisclosureGrantIssueError(
        'invalid-input',
        'Disclosure grant issuance is not bound to the active principal',
      );
    }
    const data = parsed.data;
    return withClaimedTransaction(
      this.pool,
      this.#principal,
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select * from emdo.issue_model_disclosure_grant(
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
           )`,
            [
              data.runId,
              data.householdId,
              data.userId,
              data.spaceId,
              data.spaceAccessGrantId,
              data.agentId,
              data.phasePurpose,
              data.disclosurePurpose,
              data.provider,
              JSON.stringify(data.recordAllowlist),
            ],
          ),
        );
        if (row === undefined) {
          throw new DataDisclosureGrantIssueError(
            'authorization-revoked',
            'Canonical disclosure authority could not issue this grant',
          );
        }
        const issued = IssuedGrantRowSchema.safeParse(row);
        if (!issued.success) {
          throw new DataDisclosureGrantIssueError(
            'invalid-result',
            'Database returned a malformed disclosure grant',
          );
        }
        const value = issued.data;
        const grantResult = DataDisclosureGrantSchema.safeParse({
          schemaVersion: value.schema_version,
          id: value.grant_id,
          version: value.version,
          userId: value.original_owner_user_id,
          householdId: value.household_id,
          agentId: value.agent_id,
          purpose: value.purpose,
          runId: value.run_id,
          recordAllowlist: value.record_allowlist,
          provider: value.provider,
          createdAt: value.created_at.toISOString(),
          expiresAt: value.expires_at.toISOString(),
          oneRunOnly: value.one_run_only,
        });
        const expectedAllowlist = normalizeRecordAllowlist(
          data.recordAllowlist,
        );
        if (
          !grantResult.success ||
          value.household_id !== data.householdId ||
          value.original_owner_user_id !== data.userId ||
          value.space_id !== data.spaceId ||
          value.run_id !== data.runId ||
          value.agent_id !== data.agentId ||
          value.phase_purpose !== data.phasePurpose ||
          value.purpose !== data.disclosurePurpose ||
          value.provider !== data.provider ||
          value.expires_at.getTime() - value.created_at.getTime() !== 600_000 ||
          value.database_time.getTime() < value.created_at.getTime() ||
          value.database_time.getTime() >= value.expires_at.getTime() ||
          JSON.stringify(value.record_allowlist) !==
            JSON.stringify(expectedAllowlist) ||
          hashDataDisclosureGrant(grantResult.data) !== value.grant_hash
        ) {
          throw new DataDisclosureGrantIssueError(
            'invalid-result',
            'Issued disclosure grant does not match its canonical binding',
          );
        }
        return deepFreeze({
          grant: grantResult.data,
          grantHash: value.grant_hash,
          phasePurpose: value.phase_purpose,
          spaceId: value.space_id,
        });
      },
    );
  }
}

/**
 * Curated, request-principal-bound resolution for the scheduler proposal
 * lifecycle. It reuses the sole disclosure aggregate without authorizing or
 * auditing any model disclosure.
 */
export class PostgresSchedulerDisclosureGrantResolver {
  readonly #principal: Readonly<DurableRepositoryPrincipal>;
  readonly #scope: Readonly<SchedulerDisclosureGrantResolverScope>;

  constructor(
    private readonly pool: DatabasePool,
    principal: DurableRepositoryPrincipal,
    scope: SchedulerDisclosureGrantResolverScope,
  ) {
    this.#principal = parseDurablePrincipal(principal);
    const parsedScope =
      SchedulerDisclosureGrantResolverScopeSchema.safeParse(scope);
    if (
      !parsedScope.success ||
      parsedScope.data.householdId !== this.#principal.householdId ||
      parsedScope.data.userId !== this.#principal.userId
    ) {
      throw new SchedulerDisclosureGrantResolverError(
        'invalid-input',
        'Scheduler disclosure resolver is not bound to the active principal',
      );
    }
    this.#scope = deepFreeze(parsedScope.data);
  }

  async resolve(
    disclosureGrantId: string,
  ): Promise<DataDisclosureGrant | undefined> {
    const grantId = UuidSchema.safeParse(disclosureGrantId);
    if (!grantId.success) return undefined;
    return withClaimedTransaction(
      this.pool,
      this.#principal,
      async (client) => {
        const row = firstResultRow(
          await client.query(
            `select * from emdo.resolve_model_disclosure_grant(
             $1, $2, $3, $4, $5, $6, $7, $8, $9
           )`,
            [
              grantId.data,
              this.#scope.runId,
              this.#scope.householdId,
              this.#scope.userId,
              this.#scope.spaceAccessGrantId,
              this.#scope.agentId,
              this.#scope.phasePurpose,
              this.#scope.provider,
              '[]',
            ],
          ),
        );
        if (row === undefined) return undefined;
        const resolution = ResolutionRowSchema.safeParse(row);
        if (!resolution.success) {
          throw new SchedulerDisclosureGrantResolverError(
            'invalid-result',
            'Database returned a malformed scheduler disclosure resolution',
          );
        }
        if (resolution.data.status !== 'active') return undefined;
        const active = resolution.data;
        const recordAllowlist = normalizeRecordAllowlist(
          active.record_allowlist,
        );
        const grant = DataDisclosureGrantSchema.safeParse({
          schemaVersion: active.schema_version,
          id: active.grant_id,
          version: active.version,
          userId: active.original_owner_user_id,
          householdId: active.household_id,
          agentId: active.agent_id,
          purpose: active.purpose,
          runId: active.run_id,
          recordAllowlist,
          provider: active.provider,
          createdAt: active.created_at.toISOString(),
          expiresAt: active.expires_at.toISOString(),
          oneRunOnly: true,
        });
        if (
          !grant.success ||
          active.grant_id !== grantId.data ||
          active.household_id !== this.#scope.householdId ||
          active.original_owner_user_id !== this.#scope.userId ||
          active.run_id !== this.#scope.runId ||
          active.agent_id !== this.#scope.agentId ||
          active.provider !== this.#scope.provider ||
          active.expires_at.getTime() <= active.database_time.getTime() ||
          JSON.stringify(active.record_allowlist) !==
            JSON.stringify(recordAllowlist) ||
          hashDataDisclosureGrant(grant.data) !== active.grant_hash
        ) {
          throw new SchedulerDisclosureGrantResolverError(
            'invalid-result',
            'Resolved scheduler disclosure grant does not match its binding',
          );
        }
        return grant.data;
      },
    );
  }
}

/** Strict default format for payloads whose provenance is explicit per record. */
export class CanonicalRecordEnvelopeDisclosureFilter implements DisclosurePayloadFilter {
  filter(
    input: Readonly<{
      payload: JsonValue;
      requestedDataClasses: readonly string[];
      grant: DisclosureFilterGrant;
    }>,
  ): DisclosurePayloadFilterResult {
    const requested = new Set(input.requestedDataClasses);
    const allowedClasses = new Set(
      input.grant.recordAllowlist.map(({ dataClass }) => dataClass),
    );
    if ([...requested].some((dataClass) => !allowedClasses.has(dataClass))) {
      return deepFreeze({ status: 'denied', reason: 'record-not-allowed' });
    }
    const envelope = CanonicalEnvelopeSchema.safeParse(input.payload);
    if (!envelope.success) {
      return deepFreeze({ status: 'denied', reason: 'record-not-allowed' });
    }
    const filteredRecords: Array<{
      dataClass: string;
      recordId: string;
      fields: Record<string, JsonValue>;
    }> = [];
    const auditRecords: Array<{
      dataClass: string;
      recordId: string;
      fields: string[];
    }> = [];
    for (const record of envelope.data.records) {
      if (!requested.has(record.dataClass)) {
        return deepFreeze({ status: 'denied', reason: 'record-not-allowed' });
      }
      const allowlist = input.grant.recordAllowlist.find(
        (candidate) =>
          candidate.dataClass === record.dataClass &&
          candidate.recordId === record.recordId,
      );
      if (allowlist === undefined) {
        return deepFreeze({ status: 'denied', reason: 'record-not-allowed' });
      }
      const allowedFields = new Set(allowlist.fields);
      const fieldNames = Object.keys(record.fields).sort();
      if (fieldNames.some((field) => !allowedFields.has(field))) {
        return deepFreeze({ status: 'denied', reason: 'field-not-allowed' });
      }
      filteredRecords.push({
        dataClass: record.dataClass,
        recordId: record.recordId,
        fields: Object.fromEntries(
          fieldNames.map((field) => [field, record.fields[field] as JsonValue]),
        ),
      });
      auditRecords.push({
        dataClass: record.dataClass,
        recordId: record.recordId,
        fields: fieldNames,
      });
    }
    filteredRecords.sort((left, right) =>
      `${left.dataClass}\0${left.recordId}`.localeCompare(
        `${right.dataClass}\0${right.recordId}`,
      ),
    );
    auditRecords.sort((left, right) =>
      `${left.dataClass}\0${left.recordId}`.localeCompare(
        `${right.dataClass}\0${right.recordId}`,
      ),
    );
    const payload = snapshotJsonValue({
      schemaVersion: 1,
      records: filteredRecords,
    });
    return Object.freeze({
      status: 'filtered' as const,
      payload,
      records: deepFreeze(auditRecords),
    });
  }
}

export class ModelDisclosureGatewayError extends Error {
  constructor(
    readonly code: 'invalid-input' | 'invalid-result' | 'audit-failed',
    message: string,
  ) {
    super(message);
    this.name = 'ModelDisclosureGatewayError';
  }
}

/** Principal-bound PostgreSQL gateway; structurally matches agent-core's port. */
export class PostgresModelDisclosureGateway {
  readonly #principal: Readonly<DurableRepositoryPrincipal>;
  readonly #filter: DisclosurePayloadFilter['filter'];

  constructor(
    private readonly pool: DatabasePool,
    principal: DurableRepositoryPrincipal,
    filter: DisclosurePayloadFilter,
  ) {
    this.#principal = parseDurablePrincipal(principal);
    this.#filter = filter.filter.bind(filter);
  }

  async authorize(input: z.input<typeof AuthorizationInputSchema>): Promise<
    | Readonly<{
        status: 'authorized';
        grantId: string;
        grantVersion: string;
        runId: string;
        householdId: string;
        userId: string;
        agentId: string;
        phasePurpose: z.output<typeof PhasePurposeSchema>;
        disclosurePurpose: string;
        provider: 'openai';
        expiresAt: string;
        records: readonly Readonly<{
          dataClass: string;
          recordId: string;
          fields: readonly string[];
        }>[];
        payload: JsonValue;
      }>
    | Readonly<{
        status: 'denied';
        grantId?: string;
        reason: 'no-active-grant';
      }>
    | Readonly<{
        status: 'denied';
        grantId: string;
        reason: BoundModelDisclosureDenialReason;
      }>
  > {
    const request = AuthorizationInputSchema.safeParse(input);
    if (
      !request.success ||
      request.data.requestId !== this.#principal.requestId ||
      request.data.runId.length === 0 ||
      request.data.householdId !== this.#principal.householdId ||
      request.data.userId !== this.#principal.userId
    ) {
      throw new ModelDisclosureGatewayError(
        'invalid-input',
        'Model disclosure request is not bound to the active principal',
      );
    }
    const data = request.data;
    return withClaimedTransaction(
      this.pool,
      this.#principal,
      async (client) => {
        const rawResolution = firstResultRow(
          await client.query(
            `select * from emdo.resolve_model_disclosure_grant(
             $1, $2, $3, $4, $5, $6, $7, $8, $9
           )`,
            [
              data.requestedGrantId ?? null,
              data.runId,
              data.householdId,
              data.userId,
              data.spaceAccessGrantId,
              data.agentId,
              data.phasePurpose,
              data.provider,
              JSON.stringify(data.requestedDataClasses),
            ],
          ),
        );
        if (rawResolution === undefined) {
          return Object.freeze({
            status: 'denied' as const,
            ...(data.requestedGrantId === undefined
              ? {}
              : { grantId: data.requestedGrantId }),
            reason: 'no-active-grant' as const,
          });
        }
        const resolution = ResolutionRowSchema.safeParse(rawResolution);
        if (!resolution.success) {
          throw new ModelDisclosureGatewayError(
            'invalid-result',
            'Database returned a malformed disclosure resolution',
          );
        }
        if (resolution.data.status !== 'active') {
          const resolvedGrantId =
            resolution.data.grant_id ?? data.requestedGrantId;
          if (resolution.data.status === 'no-active-grant') {
            return Object.freeze({
              status: 'denied' as const,
              ...(resolvedGrantId === undefined
                ? {}
                : { grantId: resolvedGrantId }),
              reason: resolution.data.status,
            });
          }
          if (resolvedGrantId === undefined) {
            throw new ModelDisclosureGatewayError(
              'invalid-result',
              'Database denial omitted its disclosure grant binding',
            );
          }
          return Object.freeze({
            status: 'denied' as const,
            grantId: resolvedGrantId,
            reason: resolution.data.status,
          });
        }
        const grant = resolution.data;
        if (
          grant.household_id !== data.householdId ||
          grant.original_owner_user_id !== data.userId ||
          grant.run_id !== data.runId ||
          grant.agent_id !== data.agentId ||
          grant.provider !== data.provider ||
          (data.requestedGrantId !== undefined &&
            grant.grant_id !== data.requestedGrantId) ||
          grant.expires_at.getTime() <= grant.database_time.getTime()
        ) {
          throw new ModelDisclosureGatewayError(
            'invalid-result',
            'Resolved disclosure grant does not match the request',
          );
        }
        const filtered = this.#filter({
          payload: data.payload,
          requestedDataClasses: data.requestedDataClasses,
          grant: { recordAllowlist: grant.record_allowlist },
        });
        if (filtered.status === 'denied') {
          const audit = firstResultRow(
            await client.query(
              `select emdo.record_model_disclosure_denial(
               $1, $2, $3, $4, $5, $6
             ) as recorded`,
              [
                grant.grant_id,
                grant.version,
                grant.grant_hash,
                data.spaceAccessGrantId,
                data.phasePurpose,
                filtered.reason,
              ],
            ),
          );
          if (audit?.recorded !== true) {
            throw new ModelDisclosureGatewayError(
              'audit-failed',
              'Disclosure denial audit could not be committed',
            );
          }
          return deepFreeze({
            status: 'denied' as const,
            grantId: grant.grant_id,
            reason: filtered.reason,
          });
        }
        const committed = firstResultRow(
          await client.query(
            `select committed, database_time, expires_at
             from emdo.commit_model_disclosure_authorization(
               $1, $2, $3, $4, $5, $6::jsonb
             )`,
            [
              grant.grant_id,
              grant.version,
              grant.grant_hash,
              data.spaceAccessGrantId,
              data.phasePurpose,
              JSON.stringify(filtered.records),
            ],
          ),
        );
        const commit = z
          .strictObject({
            committed: z.literal(true),
            database_time: z.coerce.date(),
            expires_at: z.coerce.date(),
          })
          .safeParse(committed);
        if (
          !commit.success ||
          commit.data.expires_at.getTime() !== grant.expires_at.getTime() ||
          commit.data.database_time.getTime() >=
            commit.data.expires_at.getTime()
        ) {
          return deepFreeze({
            status: 'denied' as const,
            grantId: grant.grant_id,
            reason: 'grant-expired' as const,
          });
        }
        return Object.freeze({
          status: 'authorized' as const,
          grantId: grant.grant_id,
          grantVersion: `${grant.version}.0.0`,
          runId: grant.run_id,
          householdId: grant.household_id,
          userId: grant.original_owner_user_id,
          agentId: grant.agent_id,
          phasePurpose: data.phasePurpose,
          disclosurePurpose: grant.purpose,
          provider: 'openai' as const,
          expiresAt: grant.expires_at.toISOString(),
          records: filtered.records,
          payload: snapshotJsonValue(filtered.payload),
        });
      },
    );
  }
}
