import { z } from 'zod';

import { UuidSchema } from './primitives.js';

export const WorkspaceTypeSchema = z.enum([
  'personal',
  'household',
  'organization',
]);
export const WorkspaceSchema = z.strictObject({
  id: UuidSchema,
  name: z.string().trim().min(1).max(200),
  usageType: WorkspaceTypeSchema,
  tierCode: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  timezone: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }),
  locale: z.string().min(2).max(35),
  revision: z.number().int().nonnegative(),
});
export const WorkspaceMembershipSchema = z.strictObject({
  workspaceId: UuidSchema,
  userId: UuidSchema,
  role: z.enum(['owner', 'member']),
  status: z.enum(['active', 'inactive']),
  revision: z.number().int().positive(),
});
export const WorkspaceContextSchema = z.strictObject({
  workspaceId: UuidSchema,
  userId: UuidSchema,
  sessionId: UuidSchema,
  requestId: UuidSchema,
});
export const WorkspaceEntitlementSchema = z.strictObject({
  capability: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
  enabled: z.boolean(),
  limit: z.number().int().nonnegative().nullable(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type WorkspaceMembership = z.infer<typeof WorkspaceMembershipSchema>;
export type WorkspaceContext = z.infer<typeof WorkspaceContextSchema>;
export type WorkspaceEntitlement = z.infer<typeof WorkspaceEntitlementSchema>;

/** Only adapt a server-authenticated principal, never a request body. */
export function workspaceContextFromLegacyPrincipal(
  principal: {
    householdId: string;
    userId: string;
    sessionId: string;
  },
  requestId: string,
): WorkspaceContext {
  return WorkspaceContextSchema.parse({
    workspaceId: principal.householdId,
    userId: principal.userId,
    sessionId: principal.sessionId,
    requestId,
  });
}

/** Read/export access is governed by permissions, never a paid entitlement. */
export function permitsWorkspaceCapability(
  entitlements: readonly WorkspaceEntitlement[],
  capability: string,
  currentCount = 0,
): boolean {
  if (!Number.isSafeInteger(currentCount) || currentCount < 0) return false;
  const matches = entitlements.filter(
    (entry) => entry.capability === capability,
  );
  if (matches.length !== 1) return false;
  const entry = WorkspaceEntitlementSchema.safeParse(matches[0]);
  return (
    entry.success &&
    entry.data.enabled &&
    (entry.data.limit === null || currentCount < entry.data.limit)
  );
}
