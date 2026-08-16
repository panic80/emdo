import { pathToFileURL } from 'node:url';

import {
  OWNER_BOOTSTRAP_CONFIRMATION,
  runOwnerBootstrapCommand,
  type BootstrapOwnerEnvironment,
} from '@emdo/db/deployment/bootstrap-owner-command';
import { z } from 'zod';

const SyntheticSeedConfigurationSchema = z.strictObject({
  apiOrigin: z
    .url()
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol))
    .refine((value) => new URL(value).origin === value),
  bootstrapDatabaseUrl: z
    .url()
    .refine((value) =>
      ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
    ),
  clientId: z.uuid(),
  environment: z.literal('staging'),
  externalProvidersEnabled: z.literal('false'),
  householdName: z.string().trim().min(1).max(100),
  householdSlug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  ownerEmail: z.email().trim().toLowerCase().max(320),
  ownerName: z.string().trim().min(1).max(100),
  ownerPassword: z.string().min(12).max(128),
  publicOrigin: z
    .url()
    .refine((value) => new URL(value).protocol === 'https:')
    .refine((value) => new URL(value).origin === value),
  syntheticDataOnly: z.literal('true'),
});

const SyncTokenResponseSchema = z.strictObject({
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

const CsrfResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  token: z.string().min(24).max(512),
});

const SyncClientRegistrationResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  clientId: z.uuid(),
  status: z.literal('registered'),
  replayed: z.boolean(),
});

const SyncResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  clientId: z.uuid(),
  results: z.array(
    z.discriminatedUnion('status', [
      z.strictObject({
        operationId: z.uuid(),
        status: z.literal('applied'),
        revision: z.number().int().positive(),
        resolution: z.enum([
          'created',
          'applied',
          'merged',
          'ignored',
          'duplicate',
        ]),
        conflicts: z.array(z.never()).max(0),
        replayed: z.boolean(),
      }),
      z.strictObject({
        operationId: z.uuid(),
        status: z.literal('conflict'),
        code: z.string(),
        disposition: z.enum(['terminal', 'retryable']),
        currentRevision: z.number().int().nonnegative().optional(),
        conflicts: z
          .array(
            z.strictObject({
              field: z.string().trim().min(1).max(200),
              material: z.boolean(),
            }),
          )
          .max(32),
        replayed: z.boolean(),
      }),
      z.strictObject({
        operationId: z.uuid(),
        status: z.literal('blocked'),
        code: z.string(),
        dependencyOperationId: z.uuid().optional(),
        disposition: z.enum(['terminal', 'retryable']),
        conflicts: z.array(z.never()).max(0),
        replayed: z.literal(false),
      }),
    ]),
  ),
});

const SYNTHETIC_OPERATION_IDS = Object.freeze([
  '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f81',
  '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f82',
  '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f83',
]);
const SYNTHETIC_CREATED_AT = '2026-01-01T00:00:00.000Z';

type SeedFetch = (request: Request) => Promise<Response>;
type BootstrapOwner = typeof runOwnerBootstrapCommand;

const json = async <Output>(response: Response, schema: z.ZodType<Output>) => {
  if (!response.ok) throw new Error('Synthetic seed API request failed');
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error('Synthetic seed API response is invalid');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new Error('Synthetic seed API response is invalid');
  return parsed.data;
};

const responseCookies = (response: Response): readonly string[] => {
  const cookies = response.headers.getSetCookie();
  if (cookies.length === 0) return [];
  return cookies.map((cookie) => cookie.split(';', 1)[0]!).filter(Boolean);
};

const operation = (input: {
  readonly clientId: string;
  readonly operationId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly spaceId: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly actorIntent: string;
  readonly createdAt: string;
}) => ({
  schemaVersion: 1 as const,
  clientId: input.clientId,
  operationId: input.operationId,
  entity: { type: input.entityType, id: input.entityId },
  mutation: {
    kind: 'create' as const,
    payload: { spaceId: input.spaceId, value: input.value },
  },
  baseRevision: 0,
  dependencies: [],
  actorIntent: input.actorIntent,
  createdAt: input.createdAt,
});

export const runSyntheticSeedCommand = async (input: {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly bootstrapOwner?: BootstrapOwner;
  readonly fetch?: SeedFetch;
}): Promise<{ readonly status: 'seeded'; readonly operationCount: 3 }> => {
  const configuration = SyntheticSeedConfigurationSchema.safeParse({
    apiOrigin: input.environment.EMDO_STAGING_API_ORIGIN,
    bootstrapDatabaseUrl: input.environment.EMDO_BOOTSTRAP_DATABASE_URL,
    clientId: input.environment.EMDO_SYNTHETIC_CLIENT_ID,
    environment: input.environment.EMDO_ENVIRONMENT,
    externalProvidersEnabled: input.environment.EMDO_EXTERNAL_PROVIDERS_ENABLED,
    householdName: input.environment.EMDO_BOOTSTRAP_HOUSEHOLD_NAME,
    householdSlug: input.environment.EMDO_BOOTSTRAP_HOUSEHOLD_SLUG,
    ownerEmail: input.environment.EMDO_SYNTHETIC_OWNER_EMAIL,
    ownerName: input.environment.EMDO_BOOTSTRAP_OWNER_NAME,
    ownerPassword: input.environment.EMDO_SYNTHETIC_OWNER_PASSWORD,
    publicOrigin: input.environment.EMDO_PUBLIC_ORIGIN,
    syntheticDataOnly: input.environment.EMDO_SYNTHETIC_DATA_ONLY,
  });
  if (
    input.argv.length !== 2 ||
    input.argv[0] !== '--fail-if-nonempty' ||
    input.argv[1] !== '--staging-only' ||
    !configuration.success
  ) {
    throw new Error('Synthetic seed configuration is invalid');
  }
  const config = configuration.data;
  const bootstrapEnvironment: BootstrapOwnerEnvironment = {
    EMDO_BOOTSTRAP_CONFIRM: OWNER_BOOTSTRAP_CONFIRMATION,
    EMDO_BOOTSTRAP_DATABASE_URL: config.bootstrapDatabaseUrl,
    EMDO_BOOTSTRAP_HOUSEHOLD_NAME: config.householdName,
    EMDO_BOOTSTRAP_HOUSEHOLD_SLUG: config.householdSlug,
    EMDO_BOOTSTRAP_OWNER_EMAIL: config.ownerEmail,
    EMDO_BOOTSTRAP_OWNER_NAME: config.ownerName,
    EMDO_BOOTSTRAP_OWNER_PASSWORD: config.ownerPassword,
  };
  const bootstrapStatus = await (
    input.bootstrapOwner ?? runOwnerBootstrapCommand
  )({
    environment: bootstrapEnvironment,
    logger: { error: () => undefined, info: () => undefined },
  });
  if (bootstrapStatus !== 0 && bootstrapStatus !== 2) {
    throw new Error('Synthetic owner bootstrap failed');
  }

  const request = input.fetch ?? ((value: Request) => globalThis.fetch(value));
  const signIn = await request(
    new Request(`${config.apiOrigin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: config.publicOrigin,
        'idempotency-key': 'synthetic-seed-sign-in-v1',
      },
      body: JSON.stringify({
        email: config.ownerEmail,
        password: config.ownerPassword,
      }),
      redirect: 'error',
    }),
  );
  if (!signIn.ok) throw new Error('Synthetic owner sign-in failed');
  const cookies = [...responseCookies(signIn)];
  if (
    !cookies.some((cookie) => cookie.startsWith('__Secure-emdo.session_token='))
  ) {
    throw new Error('Synthetic owner session was not issued');
  }

  const csrfResponse = await request(
    new Request(`${config.apiOrigin}/api/v1/auth/csrf`, {
      headers: { cookie: cookies.join('; '), origin: config.publicOrigin },
    }),
  );
  const csrf = await json(csrfResponse, CsrfResponseSchema);
  cookies.push(...responseCookies(csrfResponse));

  const registration = await json(
    await request(
      new Request(`${config.apiOrigin}/api/v1/sync/clients`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookies.join('; '),
          origin: config.publicOrigin,
          'x-csrf-token': csrf.token,
          'idempotency-key': 'synthetic-sync-client-registration-v1',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          clientId: config.clientId,
          displayName: 'EMDO synthetic staging seed',
        }),
      }),
    ),
    SyncClientRegistrationResponseSchema,
  );
  if (registration.clientId !== config.clientId) {
    throw new Error('Synthetic sync registration is invalid');
  }

  const token = await json(
    await request(
      new Request(
        `${config.apiOrigin}/api/v1/sync/token?clientId=${encodeURIComponent(config.clientId)}`,
        { headers: { cookie: cookies.join('; ') } },
      ),
    ),
    SyncTokenResponseSchema,
  );
  if (
    new URL(token.endpoint).origin !== config.publicOrigin ||
    token.writeScope.clientId !== config.clientId
  ) {
    throw new Error('Synthetic sync scope is invalid');
  }
  const privateSpaces = token.writeScope.spaces.filter(
    (space) =>
      space.visibility === 'private' && space.originalOwnerUserId.length > 0,
  );
  if (privateSpaces.length !== 1) {
    throw new Error('Synthetic private space is unavailable');
  }
  const spaceId = privateSpaces[0]!.id;
  const createdAt = SYNTHETIC_CREATED_AT;
  const operations = [
    operation({
      clientId: config.clientId,
      operationId: SYNTHETIC_OPERATION_IDS[0],
      entityType: 'scheduler.item',
      entityId: 'synthetic-scheduler-item-v1',
      spaceId,
      value: {
        id: 'synthetic-scheduler-item-v1',
        title: 'Synthetic household appointment preparation',
        notes: null,
        location: null,
        startsAt: '2026-01-02T09:00:00.000-05:00',
        endsAt: '2026-01-02T10:00:00.000-05:00',
        recurrence: null,
        attendees: [],
        completion: 'open',
      },
      actorIntent: 'Create the deterministic scheduler staging fixture',
      createdAt,
    }),
    operation({
      clientId: config.clientId,
      operationId: SYNTHETIC_OPERATION_IDS[1],
      entityType: 'finance.budget',
      entityId: 'synthetic-finance-budget-v1',
      spaceId,
      value: {
        id: 'synthetic-finance-budget-v1',
        currency: 'CAD',
        allocationsCadMinor: { groceries: 45_000 },
      },
      actorIntent: 'Create the deterministic finance staging fixture',
      createdAt,
    }),
    operation({
      clientId: config.clientId,
      operationId: SYNTHETIC_OPERATION_IDS[2],
      entityType: 'shopping.item',
      entityId: 'synthetic-shopping-item-v1',
      spaceId,
      value: {
        name: 'Milk',
        unit: 'each',
        quantityMinorUnits: 1_000,
      },
      actorIntent: 'Create the deterministic shopping staging fixture',
      createdAt,
    }),
  ] as const;
  const upload = await json(
    await request(
      new Request(`${config.apiOrigin}/api/v1/sync/ops`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookies.join('; '),
          origin: config.publicOrigin,
          'x-csrf-token': csrf.token,
          'idempotency-key': 'synthetic-domain-seed-v1',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          clientId: config.clientId,
          operations,
        }),
      }),
    ),
    SyncResultSchema,
  );
  if (
    upload.clientId !== config.clientId ||
    upload.results.length !== operations.length ||
    upload.results.some(
      (result, index) =>
        result.operationId !== operations[index]!.operationId ||
        result.status !== 'applied',
    )
  ) {
    throw new Error('Synthetic domain seed was not applied exactly');
  }
  return Object.freeze({
    status: 'seeded' as const,
    operationCount: 3 as const,
  });
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  void runSyntheticSeedCommand({
    argv: process.argv.slice(2),
    environment: process.env,
  })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write('Synthetic staging seed failed.\n');
      process.exitCode = 1;
    });
}
