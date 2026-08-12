import { z } from 'zod';

export const API_READINESS_SCHEMA_VERSION = 1 as const;

export const API_READINESS_GROUPS = Object.freeze({
  authority: Object.freeze([
    'authority.authentication',
    'authority.household-administration',
    'authority.proposal-queries',
    'authority.visual-decisions',
    'authority.visual-proof-issuance',
  ] as const),
  agents: Object.freeze(['agents.manager-turns', 'agents.run-events'] as const),
  experience: Object.freeze([
    'experience.activity-read',
    'experience.finance-read',
    'experience.notification-preferences',
    'experience.schedule-read',
    'experience.settings-read',
    'experience.shopping-read',
    'experience.today-read',
  ] as const),
  google: Object.freeze(['google.connector'] as const),
  sync: Object.freeze(['sync.gateway', 'sync.jwks'] as const),
  voice: Object.freeze(['voice.audio-requests', 'voice.provider'] as const),
});

export type ApiReadinessGroupName = keyof typeof API_READINESS_GROUPS;
export type ApiReadinessComponentName =
  (typeof API_READINESS_GROUPS)[ApiReadinessGroupName][number];
export type ApiReadinessCheckName =
  ApiReadinessGroupName | ApiReadinessComponentName;

export const API_READINESS_REQUIRED_CHECKS = Object.freeze([
  ...(Object.keys(API_READINESS_GROUPS) as ApiReadinessGroupName[]),
  ...Object.values(API_READINESS_GROUPS).flat(),
] as ApiReadinessCheckName[]);

export const ApiReadinessStatusSchema = z.enum(['ok', 'unavailable']);
export type ApiReadinessStatus = z.output<typeof ApiReadinessStatusSchema>;

const ApiReadinessCheckShape = Object.fromEntries(
  API_READINESS_REQUIRED_CHECKS.map((name) => [name, ApiReadinessStatusSchema]),
) as {
  readonly [Name in ApiReadinessCheckName]: typeof ApiReadinessStatusSchema;
};

export const ApiReadinessChecksSchema = z.strictObject(ApiReadinessCheckShape);

const groupsMatchComponents = (
  checks: Readonly<Record<ApiReadinessCheckName, ApiReadinessStatus>>,
): boolean =>
  Object.entries(API_READINESS_GROUPS).every(([group, components]) => {
    const expected = components.every((name) => checks[name] === 'ok')
      ? 'ok'
      : 'unavailable';
    return checks[group as ApiReadinessGroupName] === expected;
  });

export const ApiReadinessServiceResultSchema = z
  .strictObject({
    ready: z.boolean(),
    checks: ApiReadinessChecksSchema,
  })
  .refine(({ checks }) => groupsMatchComponents(checks), {
    message: 'Readiness groups do not match their components',
  })
  .refine(
    ({ ready, checks }) =>
      ready ===
      (Object.keys(API_READINESS_GROUPS) as ApiReadinessGroupName[]).every(
        (group) => checks[group] === 'ok',
      ),
    { message: 'Readiness status does not match its required groups' },
  );

export const ApiReadinessHttpSuccessSchema = z
  .strictObject({
    schemaVersion: z.literal(API_READINESS_SCHEMA_VERSION),
    status: z.literal('ready'),
    checks: ApiReadinessChecksSchema,
  })
  .refine(
    ({ checks }) =>
      groupsMatchComponents(checks) &&
      API_READINESS_REQUIRED_CHECKS.every((name) => checks[name] === 'ok'),
    { message: 'Required readiness check is unavailable' },
  );

export const ApiReadinessHttpUnavailableSchema = z.strictObject({
  type: z.literal('about:blank'),
  title: z.literal('Service not ready'),
  status: z.literal(503),
  detail: z.literal('One or more required dependencies are unavailable.'),
  instance: z.string().trim().min(1).max(500),
  requestId: z.string().trim().min(1).max(200),
  code: z.literal('service-not-ready'),
  extensions: z.strictObject({
    readinessSchemaVersion: z.literal(API_READINESS_SCHEMA_VERSION),
    checks: ApiReadinessChecksSchema,
  }),
});
