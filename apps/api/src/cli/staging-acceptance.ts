import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { ApiReadinessHttpSuccessSchema } from '../readiness-contract.js';

const AcceptanceConfigurationSchema = z.strictObject({
  apiOrigin: z
    .url()
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol))
    .refine((value) => new URL(value).origin === value),
  clientId: z.uuid(),
  environment: z.literal('staging'),
  externalProvidersEnabled: z.literal('false'),
  ownerEmail: z.email().trim().toLowerCase().max(320),
  ownerPassword: z.string().min(12).max(128),
  publicOrigin: z
    .url()
    .refine((value) => new URL(value).protocol === 'https:')
    .refine((value) => new URL(value).origin === value),
  syntheticDataOnly: z.literal('true'),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/u),
  workflowRunId: z.string().regex(/^[1-9][0-9]{0,19}$/u),
});

const WriteScopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  endpoint: z.url({ protocol: /^https$/u }).max(2_048),
  token: z.string().min(16).max(32_768),
  expiresAt: z.iso.datetime({ offset: true }),
  writeScope: z.strictObject({
    clientId: z.uuid(),
    spaces: z
      .array(
        z.strictObject({
          id: z.uuid(),
          visibility: z.enum(['private', 'shared']),
          originalOwnerUserId: z.uuid(),
        }),
      )
      .min(1)
      .max(256),
  }),
});

const SyncClientRegistrationResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  clientId: z.uuid(),
  status: z.literal('registered'),
  replayed: z.boolean(),
});

const ProblemResponseSchema = z.object({
  type: z.literal('about:blank'),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  code: z.string().min(1),
  detail: z.string().min(1),
  requestId: z.uuid(),
});

const ACCEPTANCE_CLIENT_B = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fa0';
const ACCEPTANCE_PROPOSAL = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fa1';
const ACCEPTANCE_OPERATION_IDS = Object.freeze([
  '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fa2',
  '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fa3',
  '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fa4',
  '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fa5',
]);
const CREATED_AT = '2026-01-01T00:00:00.000Z';

type AcceptanceFetch = (request: Request) => Promise<Response>;

const requiredOpenApiOperations = Object.freeze({
  '/api/auth/get-session': ['get'],
  '/api/auth/sign-in/email': ['post'],
  '/api/auth/passkey/verify-authentication': ['post'],
  '/api/v1/auth/invitations/redeem': ['post'],
  '/api/v1/household/invitations': ['get', 'post'],
  '/api/v1/household/invitations/{id}/revoke': ['post'],
  '/api/v1/household/memberships': ['get'],
  '/api/v1/household/memberships/{id}/role': ['patch'],
  '/api/v1/household/memberships/{id}/deactivate': ['post'],
  '/api/v1/turns': ['post'],
  '/api/v1/runs/{id}/events': ['get'],
  '/api/v1/proposals': ['get'],
  '/api/v1/proposals/{id}': ['get'],
  '/api/v1/proposals/{id}/visual-proof': ['post'],
  '/api/v1/proposals/{id}/decision': ['post'],
  '/api/v1/sync/clients': ['post'],
  '/api/v1/sync/token': ['get'],
  '/api/v1/sync/ops': ['post'],
  '/api/v1/experience/today': ['get'],
  '/api/v1/experience/activity': ['get'],
  '/api/v1/experience/finance': ['get'],
  '/api/v1/experience/schedule': ['get'],
  '/api/v1/experience/settings': ['get'],
  '/api/v1/experience/shopping': ['get'],
  '/api/v1/experience/notification-preferences': ['get', 'put'],
  '/api/v1/voice/transcribe': ['post'],
  '/api/v1/voice/speak': ['post'],
  '/api/v1/connectors/google/authorize': ['post'],
} satisfies Readonly<Record<string, readonly string[]>>);

const parseJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    throw new Error('Staging acceptance received malformed JSON');
  }
};

const requireOkJson = async (response: Response): Promise<unknown> => {
  if (!response.ok) throw new Error('Staging acceptance HTTP gate failed');
  return parseJson(response);
};

const requireResponseRequestId = (response: Response): string => {
  const parsed = z.uuid().safeParse(response.headers.get('x-request-id'));
  if (!parsed.success) {
    throw new Error('Staging acceptance response request ID is invalid');
  }
  return parsed.data;
};

const cookiesFrom = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0]!)
    .filter(Boolean);

const parseProblem = async (response: Response) => {
  if (
    response.headers.get('content-type')?.split(';', 1)[0]?.trim() !==
    'application/problem+json'
  ) {
    throw new Error('Staging acceptance problem response is invalid');
  }
  const headerRequestId = requireResponseRequestId(response);
  const parsed = ProblemResponseSchema.safeParse(await parseJson(response));
  if (
    !parsed.success ||
    parsed.data.status !== response.status ||
    parsed.data.requestId !== headerRequestId
  ) {
    throw new Error('Staging acceptance problem response is invalid');
  }
  return parsed.data;
};

const operation = (input: {
  readonly clientId: string;
  readonly operationId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly mutationKind: 'create' | 'update' | 'delta';
  readonly baseRevision: number;
  readonly spaceId: string;
  readonly value: Readonly<Record<string, unknown>>;
}) => ({
  schemaVersion: 1,
  clientId: input.clientId,
  operationId: input.operationId,
  entity: { type: input.entityType, id: input.entityId },
  mutation: {
    kind: input.mutationKind,
    payload:
      input.mutationKind === 'create'
        ? { spaceId: input.spaceId, value: input.value }
        : input.mutationKind === 'update'
          ? { spaceId: input.spaceId, patch: input.value }
          : { spaceId: input.spaceId, delta: input.value },
  },
  baseRevision: input.baseRevision,
  dependencies: [],
  actorIntent: 'Exercise the deterministic HTTP staging acceptance fixture',
  createdAt: CREATED_AT,
});

export const runStagingAcceptanceCommand = async (input: {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly fetch?: AcceptanceFetch;
  readonly now?: () => Date;
}): Promise<{
  readonly schemaVersion: 1;
  readonly evidenceClass: 'staging-http-subset-probe';
  readonly releaseEligible: false;
  readonly environment: 'staging';
  readonly sourceSha: string;
  readonly observedAt: string;
  readonly execution: {
    readonly workflow: '.github/workflows/staging.yml';
    readonly runId: string;
    readonly event: 'workflow_dispatch';
  };
  readonly proof: {
    readonly healthz: 'passed';
    readonly readyz: 'passed';
    readonly protectedMetrics: 'passed';
    readonly requestIds: 'passed';
    readonly problemJson: 'passed';
  };
}> => {
  const configuration = AcceptanceConfigurationSchema.safeParse({
    apiOrigin: input.environment.EMDO_STAGING_API_ORIGIN,
    clientId: input.environment.EMDO_SYNTHETIC_CLIENT_ID,
    environment: input.environment.EMDO_ENVIRONMENT,
    externalProvidersEnabled: input.environment.EMDO_EXTERNAL_PROVIDERS_ENABLED,
    ownerEmail: input.environment.EMDO_SYNTHETIC_OWNER_EMAIL,
    ownerPassword: input.environment.EMDO_SYNTHETIC_OWNER_PASSWORD,
    publicOrigin: input.environment.EMDO_PUBLIC_ORIGIN,
    sourceSha: input.environment.EMDO_STAGING_SOURCE_SHA,
    syntheticDataOnly: input.environment.EMDO_SYNTHETIC_DATA_ONLY,
    workflowRunId: input.environment.EMDO_STAGING_WORKFLOW_RUN_ID,
  });
  if (
    input.argv.length !== 3 ||
    input.argv[0] !== '--all-mvp-gates' ||
    input.argv[1] !== '--require-synthetic' ||
    input.argv[2] !== '--forbid-external-providers' ||
    !configuration.success
  ) {
    throw new Error('Staging acceptance configuration is invalid');
  }
  const config = configuration.data;
  const fetchRequest =
    input.fetch ?? ((request: Request) => globalThis.fetch(request));
  const send = async (path: string, init: RequestInit = {}) => {
    const url = new URL(path, `${config.apiOrigin}/`);
    if (url.origin !== config.apiOrigin) {
      throw new Error('External network access is forbidden during acceptance');
    }
    return fetchRequest(
      new Request(url, {
        ...init,
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(15_000),
      }),
    );
  };

  const healthResponse = await send('/healthz');
  requireResponseRequestId(healthResponse);
  const health = z
    .strictObject({ status: z.literal('ok') })
    .parse(await requireOkJson(healthResponse));
  if (health.status !== 'ok') throw new Error('Liveness gate failed');
  const readinessResponse = await send('/readyz');
  requireResponseRequestId(readinessResponse);
  const readiness = ApiReadinessHttpSuccessSchema.safeParse(
    await requireOkJson(readinessResponse),
  );
  if (!readiness.success) {
    throw new Error(
      'Readiness checks do not match API readiness contract version 1',
    );
  }
  const metrics = await send('/metrics');
  const metricsProblem = await parseProblem(metrics);
  if (
    metrics.status !== 401 ||
    metricsProblem.code !== 'metrics-auth-required'
  ) {
    throw new Error('Protected metrics gate failed');
  }
  const openapi = z
    .object({
      openapi: z.literal('3.1.0'),
      paths: z.record(z.string(), z.unknown()),
    })
    .parse(await requireOkJson(await send('/openapi.json')));
  if (
    Object.entries(requiredOpenApiOperations).some(([path, methods]) => {
      const pathItem = openapi.paths[path];
      return (
        pathItem === null ||
        typeof pathItem !== 'object' ||
        methods.some(
          (method) =>
            !Object.hasOwn(
              pathItem as Readonly<Record<string, unknown>>,
              method,
            ),
        )
      );
    }) ||
    Object.hasOwn(openapi.paths, '/api/auth/sign-up/email')
  ) {
    throw new Error('Browser/API contract gate failed');
  }

  const signIn = await send('/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: config.publicOrigin,
      'idempotency-key': 'staging-acceptance-sign-in-v1',
    },
    body: JSON.stringify({
      email: config.ownerEmail,
      password: config.ownerPassword,
    }),
  });
  if (!signIn.ok) throw new Error('Synthetic acceptance sign-in failed');
  const cookies = [...cookiesFrom(signIn)];
  if (
    !cookies.some((cookie) => cookie.startsWith('__Secure-emdo.session_token='))
  ) {
    throw new Error('Synthetic acceptance session was not issued');
  }
  await requireOkJson(
    await send('/api/auth/get-session', {
      headers: { cookie: cookies.join('; ') },
    }),
  );
  const csrfResponse = await send('/api/v1/auth/csrf', {
    headers: { cookie: cookies.join('; ') },
  });
  const csrf = z
    .strictObject({ schemaVersion: z.literal(1), token: z.string().min(24) })
    .parse(await requireOkJson(csrfResponse));
  cookies.push(...cookiesFrom(csrfResponse));
  const mutationHeaders = {
    'content-type': 'application/json',
    cookie: cookies.join('; '),
    origin: config.publicOrigin,
    'x-csrf-token': csrf.token,
  };

  const registerClient = async (clientId: string, displayName: string) => {
    const response = SyncClientRegistrationResponseSchema.parse(
      await requireOkJson(
        await send('/api/v1/sync/clients', {
          method: 'POST',
          headers: {
            ...mutationHeaders,
            'idempotency-key': `staging-sync-client:${clientId}`,
          },
          body: JSON.stringify({
            schemaVersion: 1,
            clientId,
            displayName,
          }),
        }),
      ),
    );
    if (response.clientId !== clientId) {
      throw new Error('Sync client registration binding failed');
    }
  };

  await Promise.all([
    registerClient(config.clientId, 'EMDO staging acceptance device A'),
    registerClient(ACCEPTANCE_CLIENT_B, 'EMDO staging acceptance device B'),
  ]);

  const issueScope = async (clientId: string) => {
    const response = WriteScopeSchema.parse(
      await requireOkJson(
        await send(
          `/api/v1/sync/token?clientId=${encodeURIComponent(clientId)}`,
          { headers: { cookie: cookies.join('; ') } },
        ),
      ),
    );
    if (
      new URL(response.endpoint).origin !== config.publicOrigin ||
      response.writeScope.clientId !== clientId
    ) {
      throw new Error('Sync client scope binding failed');
    }
    return response.writeScope;
  };
  const [clientA, clientB] = await Promise.all([
    issueScope(config.clientId),
    issueScope(ACCEPTANCE_CLIENT_B),
  ]);
  const privateA = clientA.spaces.find(
    (space) => space.visibility === 'private',
  );
  const privateB = clientB.spaces.find(
    (space) => space.visibility === 'private',
  );
  if (privateA === undefined || privateB?.id !== privateA.id) {
    throw new Error('Two-device private scope gate failed');
  }

  const createOperations = [
    operation({
      clientId: config.clientId,
      operationId: ACCEPTANCE_OPERATION_IDS[0],
      entityType: 'scheduler.item',
      entityId: 'acceptance-scheduler-item-v1',
      mutationKind: 'create',
      baseRevision: 0,
      spaceId: privateA.id,
      value: {
        id: 'acceptance-scheduler-item-v1',
        title: 'Acceptance task',
        notes: null,
        location: null,
        startsAt: '2026-01-02T09:00:00.000-05:00',
        endsAt: '2026-01-02T10:00:00.000-05:00',
        recurrence: null,
        attendees: [],
        completion: 'open',
      },
    }),
    operation({
      clientId: config.clientId,
      operationId: ACCEPTANCE_OPERATION_IDS[1],
      entityType: 'finance.budget',
      entityId: 'acceptance-finance-budget-v1',
      mutationKind: 'create',
      baseRevision: 0,
      spaceId: privateA.id,
      value: {
        id: 'acceptance-finance-budget-v1',
        currency: 'CAD',
        allocationsCadMinor: { groceries: 45_000 },
      },
    }),
    operation({
      clientId: config.clientId,
      operationId: ACCEPTANCE_OPERATION_IDS[2],
      entityType: 'shopping.item',
      entityId: 'acceptance-shopping-item-v1',
      mutationKind: 'create',
      baseRevision: 0,
      spaceId: privateA.id,
      value: {
        name: 'Acceptance milk',
        unit: 'each',
        quantityMinorUnits: 1_000,
      },
    }),
  ] as const;
  const apply = async (
    clientId: string,
    operations: readonly ReturnType<typeof operation>[],
    idempotencyKey: string,
    expectedRevision: number,
  ) => {
    const response = z
      .object({
        schemaVersion: z.literal(1),
        clientId: z.uuid(),
        results: z.array(
          z
            .object({
              operationId: z.uuid(),
              status: z.string(),
              revision: z.number().int().positive(),
            })
            .passthrough(),
        ),
      })
      .parse(
        await requireOkJson(
          await send('/api/v1/sync/ops', {
            method: 'POST',
            headers: { ...mutationHeaders, 'idempotency-key': idempotencyKey },
            body: JSON.stringify({ schemaVersion: 1, clientId, operations }),
          }),
        ),
      );
    if (
      response.clientId !== clientId ||
      response.results.length !== operations.length ||
      response.results.some(
        (result, index) =>
          result.operationId !== operations[index]!.operationId ||
          result.status !== 'applied' ||
          result.revision !== expectedRevision,
      )
    ) {
      throw new Error('Domain sync acceptance failed');
    }
  };
  await apply(config.clientId, createOperations, 'staging-domain-create-v1', 1);
  await apply(
    ACCEPTANCE_CLIENT_B,
    [
      operation({
        clientId: ACCEPTANCE_CLIENT_B,
        operationId: ACCEPTANCE_OPERATION_IDS[3],
        entityType: 'shopping.item',
        entityId: 'acceptance-shopping-item-v1',
        mutationKind: 'delta',
        baseRevision: 1,
        spaceId: privateA.id,
        value: { quantityMinorUnits: 1_000 },
      }),
    ],
    'staging-two-device-update-v1',
    2,
  );

  const decisionKey = 'staging-visual-defense-v1';
  const decision = await send(
    `/api/v1/proposals/${ACCEPTANCE_PROPOSAL}/decision`,
    {
      method: 'POST',
      headers: { ...mutationHeaders, 'idempotency-key': decisionKey },
      body: JSON.stringify({
        schemaVersion: 1,
        proposalId: ACCEPTANCE_PROPOSAL,
        payloadHash: 'a'.repeat(64),
        approvalHash: 'b'.repeat(64),
        decision: 'approved',
        idempotencyKey: decisionKey,
      }),
    },
  );
  if (
    decision.status !== 403 ||
    (await parseProblem(decision)).code !== 'visual-approval-required'
  ) {
    throw new Error('Visual approval defense gate failed');
  }

  const speech = await send('/api/v1/voice/speak', {
    method: 'POST',
    headers: {
      ...mutationHeaders,
      'idempotency-key': 'staging-disabled-speech-v1',
    },
    body: JSON.stringify({ schemaVersion: 1, voice: 'alloy', text: 'Test' }),
  });
  if (
    speech.status !== 503 ||
    (await parseProblem(speech)).code !== 'audio-provider-unavailable'
  ) {
    throw new Error('Audio provider disablement gate failed');
  }
  const google = await send('/api/v1/connectors/google/authorize', {
    method: 'POST',
    headers: {
      ...mutationHeaders,
      'idempotency-key': 'staging-disabled-google-v1',
    },
    body: JSON.stringify({ schemaVersion: 1, returnTo: '/settings' }),
  });
  if (
    google.status !== 503 ||
    (await parseProblem(google)).code !== 'connector-unavailable'
  ) {
    throw new Error('Google provider disablement gate failed');
  }

  const turn = z
    .strictObject({
      schemaVersion: z.literal(1),
      runId: z.uuid(),
      status: z.literal('accepted'),
      replayed: z.boolean(),
      eventsPath: z.string(),
    })
    .parse(
      await requireOkJson(
        await send('/api/v1/turns', {
          method: 'POST',
          headers: {
            ...mutationHeaders,
            'idempotency-key': 'staging-manager-fail-safe-v1',
          },
          body: JSON.stringify({
            schemaVersion: 1,
            message: 'Provide a safe staging status.',
          }),
        }),
      ),
    );
  if (turn.eventsPath !== `/api/v1/runs/${turn.runId}/events`) {
    throw new Error('Manager event binding gate failed');
  }
  const events = await send(turn.eventsPath, {
    headers: { cookie: cookies.join('; ') },
  });
  if (
    !events.ok ||
    !events.headers.get('content-type')?.includes('text/event-stream') ||
    !(await events.text()).includes('event: run.failed')
  ) {
    throw new Error('Manager fail-safe event gate failed');
  }

  const observedAt = (input.now?.() ?? new Date()).toISOString();
  return Object.freeze({
    schemaVersion: 1 as const,
    evidenceClass: 'staging-http-subset-probe' as const,
    releaseEligible: false as const,
    environment: 'staging' as const,
    sourceSha: config.sourceSha,
    observedAt,
    execution: Object.freeze({
      workflow: '.github/workflows/staging.yml' as const,
      runId: config.workflowRunId,
      event: 'workflow_dispatch' as const,
    }),
    proof: Object.freeze({
      healthz: 'passed' as const,
      readyz: 'passed' as const,
      protectedMetrics: 'passed' as const,
      requestIds: 'passed' as const,
      problemJson: 'passed' as const,
    }),
  });
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  void runStagingAcceptanceCommand({
    argv: process.argv.slice(2),
    environment: process.env,
  })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write('Staging acceptance failed.\n');
      process.exitCode = 1;
    });
}
