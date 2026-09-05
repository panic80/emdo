import { createHash } from 'node:crypto';

import {
  EffectiveAuthorizationScopeFingerprintSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  Sha256Schema,
  UuidSchema,
  deepFreeze,
  type DeepReadonly,
  type EffectiveAuthorizationScopeFingerprint,
} from '@emdo/contracts';
import { z } from 'zod';

import type { DatabasePool } from '../scoped-repository.js';
import {
  firstResultRow,
  parseDurablePrincipal,
  withClaimedTransaction,
} from '../durable/scoped-transaction.js';
import {
  ProposalQueryCursorCodec,
  ProposalQueryCursorCodecError,
} from './proposal-query-cursor-codec.js';
import {
  PersistedProposalApprovalDisplaySchema,
  projectTrustedProposalApproval,
  TrustedProposalApprovalProjectionError,
} from './trusted-proposal-approval-projector.js';
import { checkDatabaseFunctionPrivileges } from './database-function-readiness.js';

const ProposalQueryStateSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'prepared',
  'executing',
  'executed',
  'not-applied',
  'indeterminate',
  'expired',
  'failed',
]);

const ApiPrincipalSchema = z.strictObject({
  userId: UuidSchema,
  sessionId: UuidSchema,
  householdId: UuidSchema,
  privateSpaceId: UuidSchema.optional(),
  role: z.enum(['owner', 'member']),
  emailVerified: z.literal(true),
  spaceAccessGrantId: UuidSchema,
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema,
});

// The cursor deliberately enters as unknown. Once every non-cursor request
// field has been validated, all cursor format/authentication failures collapse
// to the public invalid-cursor result before a database connection is opened.
const ProposalListInputSchema = z.strictObject({
  state: ProposalQueryStateSchema.optional(),
  cursor: z.unknown().optional(),
  limit: z.number().int().min(1).max(50),
  principal: ApiPrincipalSchema,
  requestId: UuidSchema,
});

const ProposalDetailInputSchema = z.strictObject({
  proposalId: UuidSchema,
  principal: ApiPrincipalSchema,
  requestId: UuidSchema,
});

const ProposalListItemSchema = z.strictObject({
  id: UuidSchema,
  version: z.number().int().positive().safe(),
  state: ProposalQueryStateSchema,
  kind: IdentifierSchema,
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(1_000),
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
});

const ProposalListPageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  items: z.array(ProposalListItemSchema).max(50),
  nextCursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,512}$/u)
    .optional(),
});

const ProposalApprovalViewSchema = ProposalListItemSchema.extend({
  schemaVersion: z.literal(1),
  payloadHash: Sha256Schema,
  approvalHash: Sha256Schema,
  beforePreview: z.strictObject({
    summary: z.string().max(2_000),
  }),
  afterPreview: z.strictObject({
    summary: z.string().max(2_000),
  }),
  fields: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(120),
        value: z.string().max(2_000),
      }),
    )
    .max(32),
});

// This is the complete database-to-adapter source envelope. Display bytes were
// constructed by the registered capability before provider interaction,
// persisted immutably, and included in approvalHash. Raw arguments, previews,
// provider records, grants, targets, and SDK identifiers are not query inputs.
const ProposalApprovalSourceSchema = z.strictObject({
  id: UuidSchema,
  version: z.number().int().positive().safe(),
  state: ProposalQueryStateSchema,
  capabilityId: IdentifierSchema,
  payloadHash: Sha256Schema,
  approvalHash: Sha256Schema,
  approvalDisplay: PersistedProposalApprovalDisplaySchema,
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
});

const ProposalListDatabaseResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('invalid-cursor') }),
  z.strictObject({
    status: z.literal('ok'),
    page: z.strictObject({
      schemaVersion: z.literal(1),
      authorizationScopeFingerprint: Sha256Schema,
      sources: z.array(ProposalApprovalSourceSchema).max(50),
      hasMore: z.boolean(),
    }),
  }),
]);

const ProposalDetailDatabaseResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('not-found') }),
  z.strictObject({
    status: z.literal('ok'),
    source: ProposalApprovalSourceSchema,
  }),
]);

const PROPOSAL_QUERY_FUNCTIONS = Object.freeze([
  'emdo.list_proposal_approval_sources(uuid,uuid,text,text,timestamptz,uuid,integer)',
  'emdo.get_proposal_approval_source(uuid,uuid,uuid)',
]);

export type ProposalQueryState = z.infer<typeof ProposalQueryStateSchema>;

const PROPOSAL_QUERY_SORT_SCHEMA = 'created-at-desc-id-desc-v1';
const PROPOSAL_QUERY_BINDING_DOMAIN = 'emdo.proposal-query.v1';

export const hashProposalQueryBinding = (input: {
  readonly authorizationScopeFingerprint: string;
  readonly state?: ProposalQueryState;
}): string => {
  const authorizationScopeFingerprint = Sha256Schema.parse(
    input.authorizationScopeFingerprint,
  );
  const state =
    input.state === undefined
      ? ''
      : ProposalQueryStateSchema.parse(input.state);
  return createHash('sha256')
    .update(`${PROPOSAL_QUERY_BINDING_DOMAIN}\0`, 'utf8')
    .update(authorizationScopeFingerprint, 'utf8')
    .update('\0', 'utf8')
    .update(state, 'utf8')
    .update('\0', 'utf8')
    .update(PROPOSAL_QUERY_SORT_SCHEMA, 'utf8')
    .digest('hex');
};
export type ProposalListItem = DeepReadonly<
  z.infer<typeof ProposalListItemSchema>
>;
export type ProposalListPage = DeepReadonly<
  z.infer<typeof ProposalListPageSchema>
>;
export type ProposalListQueryResult =
  | { readonly status: 'ok'; readonly page: ProposalListPage }
  | { readonly status: 'invalid-cursor' };
export type ProposalApprovalView = DeepReadonly<
  z.infer<typeof ProposalApprovalViewSchema>
>;

export interface ProposalApiPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly householdId: string;
  readonly privateSpaceId?: string;
  readonly role: 'owner' | 'member';
  readonly emailVerified: true;
  readonly spaceAccessGrantId: string;
  readonly collectionAuthorizationScopeFingerprint: EffectiveAuthorizationScopeFingerprint;
}

export class PostgresProposalApprovalError extends Error {
  constructor(
    readonly code: 'invalid-input' | 'invalid-result',
    message: string,
  ) {
    super(message);
    this.name = 'PostgresProposalApprovalError';
  }
}

const invalidInput = (message: string): never => {
  throw new PostgresProposalApprovalError('invalid-input', message);
};

const invalidResult = (message: string): never => {
  throw new PostgresProposalApprovalError('invalid-result', message);
};

const parseInput = <Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  message: string,
): z.output<Schema> => {
  const parsed = schema.safeParse(input);
  return parsed.success ? parsed.data : invalidInput(message);
};

const parseResult = <Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  message: string,
): z.output<Schema> => {
  const parsed = schema.safeParse(input);
  return parsed.success ? parsed.data : invalidResult(message);
};

const durablePrincipalFor = (input: {
  readonly principal: ProposalApiPrincipal;
  readonly requestId: string;
}) =>
  parseDurablePrincipal({
    userId: input.principal.userId,
    sessionId: input.principal.sessionId,
    requestId: input.requestId,
    householdId: input.principal.householdId,
  });

type ParsedSource = z.output<typeof ProposalApprovalSourceSchema>;
type VerifiedCursor = Readonly<{
  position: { readonly createdAt: string; readonly id: string };
}>;

const isStrictlyAfterPosition = (
  source: Pick<ParsedSource, 'createdAt' | 'id'>,
  position: { readonly createdAt: string; readonly id: string },
): boolean => {
  const sourceCreatedAt = Date.parse(source.createdAt);
  const positionCreatedAt = Date.parse(position.createdAt);
  return (
    sourceCreatedAt < positionCreatedAt ||
    (sourceCreatedAt === positionCreatedAt && source.id < position.id)
  );
};

const assertListDatabaseBinding = (
  sources: readonly ParsedSource[],
  hasMore: boolean,
  authorizationScopeFingerprint: string,
  input: z.output<typeof ProposalListInputSchema>,
  cursor: VerifiedCursor | undefined,
): void => {
  const ids = new Set(sources.map((source) => source.id));
  const stateMismatch =
    input.state !== undefined &&
    sources.some((source) => source.state !== input.state);
  const orderMismatch = sources.some((source, index) => {
    const next = sources[index + 1];
    return next === undefined ? false : !isStrictlyAfterPosition(next, source);
  });
  const cursorPositionMismatch =
    cursor !== undefined &&
    sources.some((source) => !isStrictlyAfterPosition(source, cursor.position));
  if (
    sources.length > input.limit ||
    ids.size !== sources.length ||
    stateMismatch ||
    orderMismatch ||
    cursorPositionMismatch ||
    (hasMore && sources.length === 0) ||
    authorizationScopeFingerprint !==
      input.principal.collectionAuthorizationScopeFingerprint
  ) {
    invalidResult(
      'Database returned a proposal list outside its request binding',
    );
  }
};

const projectSource = (source: ParsedSource): ProposalListItem => {
  let projection: ReturnType<typeof projectTrustedProposalApproval>;
  try {
    projection = projectTrustedProposalApproval(source.approvalDisplay);
  } catch (error) {
    if (error instanceof TrustedProposalApprovalProjectionError) {
      return invalidResult(
        'Database returned a malformed persisted approval display',
      );
    }
    throw error;
  }
  return parseResult(
    ProposalListItemSchema,
    {
      id: source.id,
      version: source.version,
      state: source.state,
      kind: source.capabilityId,
      title: projection.title,
      summary: projection.summary,
      createdAt: source.createdAt,
      expiresAt: source.expiresAt,
    },
    'Approval projector returned a malformed proposal list item',
  );
};

/**
 * Reads only strict, immutable, approval-hash-bound display sources. Cursor
 * HMAC verification uses the trusted collection-scope fingerprint before a
 * connection is opened; SQL then locks the fresh grant and re-derives it.
 */
export class PostgresProposalQueryRepository {
  constructor(
    private readonly pool: DatabasePool,
    private readonly cursorCodec: ProposalQueryCursorCodec,
  ) {}

  async check(): Promise<boolean> {
    return checkDatabaseFunctionPrivileges(this.pool, PROPOSAL_QUERY_FUNCTIONS);
  }

  async list(input: {
    readonly state?: ProposalQueryState;
    readonly cursor?: string;
    readonly limit: number;
    readonly principal: ProposalApiPrincipal;
    readonly requestId: string;
  }): Promise<ProposalListQueryResult> {
    const parsed = parseInput(
      ProposalListInputSchema,
      input,
      'Proposal list input is malformed',
    );
    let verifiedCursor: VerifiedCursor | undefined;
    if (parsed.cursor !== undefined) {
      if (typeof parsed.cursor !== 'string') {
        return deepFreeze({ status: 'invalid-cursor' as const });
      }
      try {
        verifiedCursor = this.cursorCodec.verify(parsed.cursor, {
          userId: parsed.principal.userId,
          sessionId: parsed.principal.sessionId,
          householdId: parsed.principal.householdId,
          authorizationScopeFingerprint:
            parsed.principal.collectionAuthorizationScopeFingerprint,
          ...(parsed.state === undefined ? {} : { state: parsed.state }),
        });
      } catch (error) {
        if (error instanceof ProposalQueryCursorCodecError) {
          return deepFreeze({ status: 'invalid-cursor' as const });
        }
        throw error;
      }
    }
    const principal = durablePrincipalFor(parsed);

    return withClaimedTransaction(this.pool, principal, async (client) => {
      const row = firstResultRow(
        await client.query(
          `select emdo.list_proposal_approval_sources($1, $2, $3, $4, $5, $6, $7) as result`,
          [
            parsed.principal.householdId,
            parsed.principal.spaceAccessGrantId,
            parsed.state ?? null,
            hashProposalQueryBinding({
              authorizationScopeFingerprint:
                parsed.principal.collectionAuthorizationScopeFingerprint,
              ...(parsed.state === undefined ? {} : { state: parsed.state }),
            }),
            verifiedCursor?.position.createdAt ?? null,
            verifiedCursor?.position.id ?? null,
            parsed.limit,
          ],
        ),
      );
      if (row === undefined) {
        return invalidResult('Database returned no proposal list result');
      }
      const result = parseResult(
        ProposalListDatabaseResultSchema,
        row.result,
        'Database returned a malformed proposal list source',
      );
      if (result.status === 'invalid-cursor') {
        if (verifiedCursor === undefined) {
          return invalidResult(
            'Database returned invalid-cursor without a cursor binding',
          );
        }
        return deepFreeze({ status: 'invalid-cursor' as const });
      }
      assertListDatabaseBinding(
        result.page.sources,
        result.page.hasMore,
        result.page.authorizationScopeFingerprint,
        parsed,
        verifiedCursor,
      );
      const items = result.page.sources.map(projectSource);
      const lastSource = result.page.sources.at(-1);
      const nextCursor =
        result.page.hasMore && lastSource !== undefined
          ? this.cursorCodec.issue({
              userId: parsed.principal.userId,
              sessionId: parsed.principal.sessionId,
              householdId: parsed.principal.householdId,
              authorizationScopeFingerprint:
                parsed.principal.collectionAuthorizationScopeFingerprint,
              ...(parsed.state === undefined ? {} : { state: parsed.state }),
              position: {
                createdAt: lastSource.createdAt,
                id: lastSource.id,
              },
            })
          : undefined;
      const page = parseResult(
        ProposalListPageSchema,
        {
          schemaVersion: 1,
          items,
          nextCursor,
        },
        'Approval projection produced a malformed proposal list page',
      );
      return deepFreeze({ status: 'ok' as const, page });
    });
  }

  async getDetail(input: {
    readonly proposalId: string;
    readonly principal: ProposalApiPrincipal;
    readonly requestId: string;
  }): Promise<ProposalApprovalView | undefined> {
    const parsed = parseInput(
      ProposalDetailInputSchema,
      input,
      'Proposal detail input is malformed',
    );
    const principal = durablePrincipalFor(parsed);

    return withClaimedTransaction(this.pool, principal, async (client) => {
      const row = firstResultRow(
        await client.query(
          `select emdo.get_proposal_approval_source($1, $2, $3) as result`,
          [
            parsed.principal.householdId,
            parsed.principal.spaceAccessGrantId,
            parsed.proposalId,
          ],
        ),
      );
      if (row === undefined) {
        return invalidResult('Database returned no proposal detail result');
      }
      const result = parseResult(
        ProposalDetailDatabaseResultSchema,
        row.result,
        'Database returned a malformed proposal detail source',
      );
      if (result.status === 'not-found') return undefined;
      const item = projectSource(result.source);
      let projection: ReturnType<typeof projectTrustedProposalApproval>;
      try {
        projection = projectTrustedProposalApproval(
          result.source.approvalDisplay,
        );
      } catch (error) {
        if (error instanceof TrustedProposalApprovalProjectionError) {
          return invalidResult(
            'Database returned a malformed persisted approval display',
          );
        }
        throw error;
      }
      return deepFreeze(
        parseResult(
          ProposalApprovalViewSchema,
          {
            ...item,
            schemaVersion: 1,
            payloadHash: result.source.payloadHash,
            approvalHash: result.source.approvalHash,
            beforePreview: { summary: projection.beforeSummary },
            afterPreview: { summary: projection.afterSummary },
            fields: projection.fields,
          },
          'Approval projection produced a malformed proposal detail',
        ),
      );
    });
  }
}
