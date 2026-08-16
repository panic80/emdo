import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { ApiSyntheticHttpSubsetReadinessSuccessSchema } from '../readiness-contract.js';
import {
  RunEventSchema,
  ShoppingPageSchema,
  TurnAcceptanceSchema,
} from '../schemas.js';

const AcceptanceConfigurationSchema = z.strictObject({
  apiOrigin: z
    .url()
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol))
    .refine((value) => new URL(value).origin === value),
  environment: z.literal('staging'),
  workerProvidersEnabled: z.literal('false'),
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

const ProblemResponseSchema = z.object({
  type: z.literal('about:blank'),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  code: z.string().min(1),
  detail: z.string().min(1),
  requestId: z.uuid(),
});

const ACCEPTANCE_PROPOSAL = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5fa1';

type AcceptanceFetch = (request: Request) => Promise<Response>;

const requiredOpenApiOperations = Object.freeze({
  '/api/auth/get-session': ['get'],
  '/api/auth/sign-in/email': ['post'],
  '/api/v1/auth/csrf': ['get'],
  '/api/v1/turns': ['post'],
  '/api/v1/runs/{id}/events': ['get'],
  '/api/v1/proposals/{id}/decision': ['post'],
  '/api/v1/experience/shopping': ['get'],
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

const ProviderFreeShoppingResultSchema = z.object({
  status: z.literal('completed'),
  runId: z.uuid(),
  output: z.object({
    shoppingItem: z.object({
      id: z.string().trim().min(1),
      name: z.literal('Acceptance milk'),
      unit: z.literal('each'),
      quantityMinorUnits: z.literal(2_000),
    }),
  }),
  executionResolution: z.strictObject({
    status: z.literal('provider-free'),
    profile: z.literal('shopping-list-v1'),
    reason: z.literal('provider-free-mvp'),
  }),
});
const ProviderFreeShoppingCompletedEventSchema = RunEventSchema.extend({
  type: z.literal('run.completed'),
  data: ProviderFreeShoppingResultSchema,
});

const readCompletedRun = async (response: Response, runId: string) => {
  if (
    !response.ok ||
    !response.headers.get('content-type')?.startsWith('text/event-stream')
  ) {
    throw new Error('Provider-free run event stream failed');
  }
  const completed = (await response.text())
    .split(/\n\n+/u)
    .map((frame) => {
      const event = /^event: ([^\n]+)$/mu.exec(frame)?.[1];
      const data = /^data: (.+)$/mu.exec(frame)?.[1];
      if (event !== 'run.completed' || data === undefined) return undefined;
      try {
        return ProviderFreeShoppingCompletedEventSchema.parse(JSON.parse(data));
      } catch {
        return undefined;
      }
    })
    .filter(
      (
        value,
      ): value is z.output<typeof ProviderFreeShoppingCompletedEventSchema> =>
        value !== undefined,
    );
  if (
    completed.length !== 1 ||
    completed[0]!.runId !== runId ||
    completed[0]!.data.runId !== runId
  ) {
    throw new Error(
      'Provider-free run did not complete with the exact shopping result',
    );
  }
  return completed[0]!.data;
};

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
    readonly syntheticHttpSubsetReadiness: 'passed';
    readonly authenticatedManagerShoppingFlow: 'passed';
    readonly protectedMetrics: 'passed';
    readonly requestIds: 'passed';
    readonly problemJson: 'passed';
  };
}> => {
  const configuration = AcceptanceConfigurationSchema.safeParse({
    apiOrigin: input.environment.EMDO_STAGING_API_ORIGIN,
    environment: input.environment.EMDO_ENVIRONMENT,
    workerProvidersEnabled: input.environment.EMDO_EXTERNAL_PROVIDERS_ENABLED,
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
    input.argv[2] !== '--forbid-worker-provider-execution' ||
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
  const readinessResponse = await send('/synthetic-staging/readyz');
  requireResponseRequestId(readinessResponse);
  const readiness = ApiSyntheticHttpSubsetReadinessSuccessSchema.safeParse(
    await requireOkJson(readinessResponse),
  );
  if (!readiness.success) {
    throw new Error(
      'Readiness checks do not match synthetic HTTP subset contract version 1',
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

  const turnResponse = await send('/api/v1/turns', {
    method: 'POST',
    headers: {
      ...mutationHeaders,
      'idempotency-key': 'staging-provider-free-shopping-v1',
    },
    body: JSON.stringify({
      schemaVersion: 1,
      message: 'add 2 each Acceptance milk to shopping list',
      routeHint: 'shopping',
    }),
  });
  if (turnResponse.status !== 202) {
    throw new Error('Provider-free manager turn was not accepted');
  }
  const turn = TurnAcceptanceSchema.parse(await requireOkJson(turnResponse));
  const completed = await readCompletedRun(
    await send(turn.eventsPath, {
      headers: {
        cookie: cookies.join('; '),
        accept: 'text/event-stream',
      },
    }),
    turn.runId,
  );
  const shopping = ShoppingPageSchema.parse(
    await requireOkJson(
      await send('/api/v1/experience/shopping?limit=50', {
        headers: { cookie: cookies.join('; ') },
      }),
    ),
  );
  const item = shopping.items.find(
    (candidate) => candidate.id === completed.output.shoppingItem.id,
  );
  if (
    item === undefined ||
    item.name !== 'Acceptance milk' ||
    item.unit !== 'each' ||
    item.quantityMinorUnits !== 2_000 ||
    item.state !== 'active'
  ) {
    throw new Error(
      'Provider-free shopping readback did not match the completed result',
    );
  }

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
      syntheticHttpSubsetReadiness: 'passed' as const,
      authenticatedManagerShoppingFlow: 'passed' as const,
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
