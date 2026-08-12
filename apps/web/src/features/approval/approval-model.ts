import { z } from 'zod';

export type ProposalState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'prepared'
  | 'executing'
  | 'executed'
  | 'not-applied'
  | 'indeterminate'
  | 'expired'
  | 'failed';
export type ApprovalSource =
  'visual-control' | 'typed' | 'voice' | 'push' | 'email';

export interface ProposalField {
  readonly label: string;
  readonly value: string;
}

export interface ProposalListItem {
  readonly id: string;
  readonly version: number;
  readonly state: ProposalState;
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ProposalListResponse {
  readonly schemaVersion: 1;
  readonly items: readonly ProposalListItem[];
  readonly nextCursor?: string;
}

export interface ProposalView extends ProposalListItem {
  readonly schemaVersion: 1;
  readonly payloadHash: string;
  readonly approvalHash: string;
  readonly beforePreview: Readonly<{ summary: string }>;
  readonly afterPreview: Readonly<{ summary: string }>;
  readonly fields: readonly ProposalField[];
}

export interface VisualProof {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly payloadHash: string;
  readonly approvalHash: string;
  readonly proofToken: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly replayed: boolean;
}

export interface ActionDecisionReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly proposalId: string;
  readonly payloadHash: string;
  readonly approvalHash: string;
  readonly decision: 'approved' | 'rejected';
  readonly channel: 'authenticated-visual';
  readonly decidedAt: string;
  readonly idempotencyKey: string;
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const isoDateTimeSchema = z.string().datetime({ offset: true });
const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(200)
  .regex(/^[A-Za-z0-9:._-]+$/u);
const opaqueReferenceSchema = z
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
    'Opaque reference contains control characters',
  );

const hasForbiddenDisplayCodePoint = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });

const displayStringSchema = (maximumLength: number, required: boolean) =>
  z
    .string()
    .max(maximumLength)
    .refine((value) => !required || value.trim().length > 0, {
      message: 'Display text is empty',
    })
    .refine((value) => !hasForbiddenDisplayCodePoint(value), {
      message: 'Display text contains a forbidden control character',
    });
const proposalStateSchema = z.enum([
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
const proposalListItemSchema = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().positive().safe(),
    state: proposalStateSchema,
    kind: z
      .string()
      .min(2)
      .max(160)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u),
    title: displayStringSchema(200, true),
    summary: displayStringSchema(1_000, true),
    createdAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
  })
  .strict();
const proposalListResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    items: z.array(proposalListItemSchema).max(50),
    nextCursor: opaqueReferenceSchema.optional(),
  })
  .strict();
const proposalViewSchema = proposalListItemSchema
  .extend({
    schemaVersion: z.literal(1),
    payloadHash: sha256Schema,
    approvalHash: sha256Schema,
    beforePreview: z
      .object({ summary: displayStringSchema(2_000, false) })
      .strict(),
    afterPreview: z
      .object({ summary: displayStringSchema(2_000, false) })
      .strict(),
    fields: z
      .array(
        z
          .object({
            label: displayStringSchema(120, true),
            value: displayStringSchema(2_000, false),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
const visualProofSchema = z
  .object({
    schemaVersion: z.literal(1),
    proposalId: z.string().uuid(),
    proposalVersion: z.number().int().positive().safe(),
    payloadHash: sha256Schema,
    approvalHash: sha256Schema,
    proofToken: z
      .string()
      .min(32)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/u),
    issuedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    replayed: z.boolean(),
  })
  .strict()
  .refine(
    (proof) => {
      const lifetime = Date.parse(proof.expiresAt) - Date.parse(proof.issuedAt);
      return lifetime > 0 && lifetime <= 120_000;
    },
    { path: ['expiresAt'], message: 'Visual proof lifetime is invalid' },
  );
const actionDecisionReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    proposalId: z.string().uuid(),
    payloadHash: sha256Schema,
    approvalHash: sha256Schema,
    decision: z.enum(['approved', 'rejected']),
    channel: z.literal('authenticated-visual'),
    decidedAt: isoDateTimeSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>))
      deepFreeze(nested);
  }
  return value;
}

export function createImmutableProposalView<T extends ProposalView>(
  proposal: T,
): Readonly<T> {
  return deepFreeze(structuredClone(proposal));
}

export type ApprovalUnavailableReason =
  | 'already-decided'
  | 'expired'
  | 'invalid-expiry'
  | 'authentication-required'
  | 'visual-confirmation-required';

export function getApprovalAvailability(
  proposal: ProposalView,
  context: {
    readonly now: Date;
    readonly authenticated: boolean;
    readonly visualSession: boolean;
  },
):
  | { readonly allowed: true; readonly remainingSeconds: number }
  | { readonly allowed: false; readonly reason: ApprovalUnavailableReason } {
  if (proposal.state !== 'pending')
    return { allowed: false, reason: 'already-decided' };
  if (!context.authenticated)
    return { allowed: false, reason: 'authentication-required' };
  if (!context.visualSession)
    return { allowed: false, reason: 'visual-confirmation-required' };

  const expiresAt = Date.parse(proposal.expiresAt);
  if (!Number.isFinite(expiresAt))
    return { allowed: false, reason: 'invalid-expiry' };
  const remainingSeconds = Math.ceil(
    (expiresAt - context.now.getTime()) / 1_000,
  );
  if (remainingSeconds <= 0) return { allowed: false, reason: 'expired' };
  return { allowed: true, remainingSeconds };
}

export type ApprovalClientErrorCode =
  | 'authentication-required'
  | 'visual-confirmation-required'
  | 'proposal-not-found'
  | 'proposal-not-current'
  | 'proposal-not-pending'
  | 'proposal-expired'
  | 'proposal-cursor-invalid'
  | 'idempotency-key-conflict'
  | 'request-failed'
  | 'proof-failed'
  | 'decision-failed'
  | 'invalid-response';

export class ApprovalClientError extends Error {
  public constructor(
    public readonly code: ApprovalClientErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ApprovalClientError';
  }
}

export interface ApprovalRequestDependencies {
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

function invalidResponse(message: string): ApprovalClientError {
  return new ApprovalClientError('invalid-response', message);
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw invalidResponse('EMDO returned an invalid approval response.');
  }
}

async function responseProblem(
  response: Response,
  fallbackCode: 'request-failed' | 'proof-failed' | 'decision-failed',
  fallbackMessage: string,
): Promise<ApprovalClientError> {
  let serverCode: string | undefined;
  try {
    const body = (await response.json()) as unknown;
    if (
      body &&
      typeof body === 'object' &&
      typeof (body as Record<string, unknown>).code === 'string'
    ) {
      serverCode = (body as Record<string, string>).code;
    }
  } catch {
    // A status-derived safe error is enough; never surface an untrusted body.
  }
  const mapped = {
    'proposal-not-found': [
      'proposal-not-found',
      'This proposal is no longer available.',
    ],
    'proposal-not-current': [
      'proposal-not-current',
      'This proposal changed. Refresh and review the current details before deciding.',
    ],
    'proposal-not-pending': [
      'proposal-not-pending',
      'This proposal is no longer pending. Refresh the approvals list.',
    ],
    'proposal-expired': [
      'proposal-expired',
      'This proposal expired. Refresh the approvals list.',
    ],
    'proposal-cursor-invalid': [
      'proposal-cursor-invalid',
      'This approvals page expired. Restarting from the first page.',
    ],
    'idempotency-key-conflict': [
      'idempotency-key-conflict',
      'The approval request could not be retried safely. Refresh before trying again.',
    ],
  } as const;
  const known = serverCode
    ? mapped[serverCode as keyof typeof mapped]
    : undefined;
  if (known)
    return new ApprovalClientError(known[0], known[1], response.status);
  if (response.status === 401) {
    return new ApprovalClientError(
      'authentication-required',
      'Sign in again before reviewing approvals.',
      response.status,
    );
  }
  return new ApprovalClientError(
    fallbackCode,
    fallbackMessage,
    response.status,
  );
}

async function callApi(
  url: string,
  init: RequestInit,
  dependencies: ApprovalRequestDependencies,
): Promise<Response> {
  const fetcher = dependencies.fetcher ?? fetch;
  try {
    return await fetcher.call(globalThis, url, {
      ...init,
      signal: dependencies.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      throw error;
    throw new ApprovalClientError(
      'request-failed',
      'EMDO could not reach the approvals service. Try again when you are online.',
    );
  }
}

export async function fetchProposalList(
  request: {
    readonly state?: ProposalState;
    readonly cursor?: string;
    readonly limit?: number;
  } = {},
  dependencies: ApprovalRequestDependencies = {},
): Promise<ProposalListResponse> {
  const limit = request.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new ApprovalClientError(
      'request-failed',
      'The approvals page requested an invalid limit.',
    );
  }
  const query = new URLSearchParams();
  if (request.state) query.set('state', request.state);
  if (request.cursor) query.set('cursor', request.cursor);
  query.set('limit', String(limit));
  const response = await callApi(
    `/api/v1/proposals?${query.toString()}`,
    {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    },
    dependencies,
  );
  if (!response.ok) {
    throw await responseProblem(
      response,
      'request-failed',
      'EMDO could not load approvals. Refresh and try again.',
    );
  }
  const parsed = proposalListResponseSchema.safeParse(
    await parseJson(response),
  );
  if (
    !parsed.success ||
    new Set(parsed.data.items.map((item) => item.id)).size !==
      parsed.data.items.length
  ) {
    throw invalidResponse('EMDO returned an invalid approvals list.');
  }
  return deepFreeze(parsed.data);
}

export async function fetchProposalDetail(
  proposalId: string,
  dependencies: ApprovalRequestDependencies = {},
): Promise<ProposalView> {
  const response = await callApi(
    `/api/v1/proposals/${encodeURIComponent(proposalId)}`,
    {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    },
    dependencies,
  );
  if (!response.ok) {
    throw await responseProblem(
      response,
      'request-failed',
      'EMDO could not load this proposal. Refresh and try again.',
    );
  }
  const parsed = proposalViewSchema.safeParse(await parseJson(response));
  if (!parsed.success || parsed.data.id !== proposalId) {
    throw invalidResponse('EMDO returned an invalid proposal detail.');
  }
  return createImmutableProposalView(parsed.data);
}

export async function issueProposalVisualProof(
  request: {
    readonly proposal: ProposalView;
    readonly csrfToken: string;
    readonly idempotencyKey: string;
  },
  dependencies: ApprovalRequestDependencies = {},
): Promise<VisualProof> {
  if (!request.csrfToken) {
    throw new ApprovalClientError(
      'visual-confirmation-required',
      'Reconnect and refresh to obtain a current authenticated visual proof.',
    );
  }
  const response = await callApi(
    `/api/v1/proposals/${encodeURIComponent(request.proposal.id)}/visual-proof`,
    {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'idempotency-key': request.idempotencyKey,
        'x-csrf-token': request.csrfToken,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        proposalVersion: request.proposal.version,
        payloadHash: request.proposal.payloadHash,
        approvalHash: request.proposal.approvalHash,
      }),
    },
    dependencies,
  );
  if (!response.ok) {
    throw await responseProblem(
      response,
      'proof-failed',
      'EMDO could not obtain a current authenticated visual proof. Refresh before trying again.',
    );
  }
  const parsed = visualProofSchema.safeParse(await parseJson(response));
  const proof = parsed.success ? parsed.data : undefined;
  const now = (dependencies.now ?? (() => new Date()))().getTime();
  if (
    !proof ||
    proof.proposalId !== request.proposal.id ||
    proof.proposalVersion !== request.proposal.version ||
    proof.payloadHash !== request.proposal.payloadHash ||
    proof.approvalHash !== request.proposal.approvalHash ||
    Date.parse(proof.expiresAt) <= now ||
    Date.parse(proof.issuedAt) > now + 30_000
  ) {
    throw invalidResponse(
      'EMDO returned a visual proof that does not match the reviewed proposal.',
    );
  }
  return deepFreeze(proof);
}

export interface DecisionRequest {
  readonly proposalId: string;
  readonly decision: 'approve' | 'reject';
  readonly source: ApprovalSource;
  readonly payloadHash: string;
  readonly approvalHash: string;
  readonly idempotencyKey: string;
  readonly csrfToken: string;
  readonly visualConfirmationToken: string;
}

export async function submitProposalDecision(
  request: DecisionRequest,
  dependencies: ApprovalRequestDependencies = {},
): Promise<ActionDecisionReceipt> {
  if (request.decision === 'approve' && request.source !== 'visual-control') {
    throw new ApprovalClientError(
      'visual-confirmation-required',
      'Use the authenticated approval button to approve this action.',
    );
  }
  if (!request.csrfToken || !request.visualConfirmationToken) {
    throw new ApprovalClientError(
      'visual-confirmation-required',
      'Reconnect and refresh to obtain a current authenticated visual proof.',
    );
  }
  const expectedDecision =
    request.decision === 'approve' ? 'approved' : 'rejected';
  const response = await callApi(
    `/api/v1/proposals/${encodeURIComponent(request.proposalId)}/decision`,
    {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'idempotency-key': request.idempotencyKey,
        'x-csrf-token': request.csrfToken,
        'x-emdo-visual-confirmation': request.visualConfirmationToken,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        proposalId: request.proposalId,
        payloadHash: request.payloadHash,
        approvalHash: request.approvalHash,
        decision: expectedDecision,
        idempotencyKey: request.idempotencyKey,
      }),
    },
    dependencies,
  );
  if (!response.ok) {
    throw await responseProblem(
      response,
      'decision-failed',
      'EMDO could not record that decision. Refresh the proposal before trying again.',
    );
  }
  const parsed = actionDecisionReceiptSchema.safeParse(
    await parseJson(response),
  );
  const receipt = parsed.success ? parsed.data : undefined;
  if (
    !receipt ||
    receipt.proposalId !== request.proposalId ||
    receipt.payloadHash !== request.payloadHash ||
    receipt.approvalHash !== request.approvalHash ||
    receipt.decision !== expectedDecision ||
    receipt.idempotencyKey !== request.idempotencyKey
  ) {
    throw invalidResponse('EMDO returned an invalid decision receipt.');
  }
  return deepFreeze(receipt);
}

export async function submitAuthenticatedVisualDecision(
  request: {
    readonly proposal: ProposalView;
    readonly decision: 'approve' | 'reject';
    readonly csrfToken: string;
  },
  dependencies: ApprovalRequestDependencies = {},
): Promise<ActionDecisionReceipt> {
  const createId = dependencies.createId ?? (() => crypto.randomUUID());
  const proof = await issueProposalVisualProof(
    {
      proposal: request.proposal,
      csrfToken: request.csrfToken,
      idempotencyKey: `visual-proof:${createId()}`,
    },
    dependencies,
  );
  return submitProposalDecision(
    {
      proposalId: request.proposal.id,
      decision: request.decision,
      source: 'visual-control',
      payloadHash: request.proposal.payloadHash,
      approvalHash: request.proposal.approvalHash,
      idempotencyKey: `decision:${createId()}`,
      csrfToken: request.csrfToken,
      visualConfirmationToken: proof.proofToken,
    },
    dependencies,
  );
}

export interface ApprovalApiClient {
  readonly list: typeof fetchProposalList;
  readonly getDetail: typeof fetchProposalDetail;
  readonly decide: typeof submitAuthenticatedVisualDecision;
}

export const approvalApiClient: ApprovalApiClient = {
  list: fetchProposalList,
  getDetail: fetchProposalDetail,
  decide: submitAuthenticatedVisualDecision,
};
