import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';

import {
  authPasskeys,
  authRateLimits,
  betterAuthOrganizationPluginSchema,
  betterAuthSchema,
} from './schema.js';

const householdId = '018f1f5e-6f47-7d61-a6dd-1e86f8b8f004';

describe('Better Auth 1.6.26 Drizzle schema compatibility', () => {
  it('executes core, passkey, rate-limit, and organization reads against exact model keys', async () => {
    expect(Object.keys(betterAuthSchema).sort()).toEqual([
      'account',
      'invitation',
      'member',
      'organization',
      'passkey',
      'rateLimit',
      'session',
      'user',
      'verification',
    ]);
    expect(getTableColumns(authPasskeys)).toHaveProperty('credentialID');
    expect(getTableColumns(authPasskeys)).not.toHaveProperty('credentialId');
    expect(getTableColumns(authRateLimits)).toMatchObject({
      count: expect.objectContaining({ name: 'count' }),
      key: expect.objectContaining({ name: 'key' }),
      lastRequest: expect.objectContaining({ name: 'last_request' }),
    });
    expect(betterAuthOrganizationPluginSchema).toEqual({
      session: {
        fields: { activeOrganizationId: 'activeHouseholdId' },
      },
    });

    const statements: string[] = [];
    const fakeClient = {
      query: vi.fn(async (query: string | { readonly text: string }) => {
        statements.push(typeof query === 'string' ? query : query.text);
        return { rowCount: 0, rows: [] };
      }),
    };
    const database = drizzle(fakeClient as never, {
      schema: betterAuthSchema,
    });
    const auth = betterAuth({
      appName: 'EMDO schema smoke test',
      baseURL: 'https://emdo.example.test',
      secret: 'test-only-secret-with-at-least-32-characters',
      database: drizzleAdapter(database, {
        provider: 'pg',
        schema: betterAuthSchema,
      }),
      advanced: {
        database: {
          generateId: () => crypto.randomUUID(),
        },
      },
      rateLimit: { enabled: true, storage: 'database' },
      plugins: [
        passkey({ rpID: 'emdo.example.test' }),
        organization({
          allowUserToCreateOrganization: false,
          dynamicAccessControl: { enabled: false },
          schema: betterAuthOrganizationPluginSchema,
        }),
      ],
    });

    const context = await auth.$context;
    expect(context).toMatchObject({
      adapter: expect.objectContaining({ id: expect.any(String) }),
    });

    await context.adapter.findOne({
      model: 'organization',
      where: [{ field: 'slug', value: 'home' }],
    });
    await context.adapter.findOne({
      model: 'member',
      where: [{ field: 'organizationId', value: householdId }],
    });
    await context.adapter.findOne({
      model: 'invitation',
      where: [{ field: 'organizationId', value: householdId }],
    });
    await context.adapter.findOne({
      model: 'passkey',
      where: [{ field: 'credentialID', value: 'credential-id' }],
    });
    await context.adapter.findOne({
      model: 'rateLimit',
      where: [{ field: 'key', value: '127.0.0.1' }],
    });
    await context.adapter.create({
      data: {
        count: 1,
        key: '127.0.0.1',
        lastRequest: 1_786_320_000_000,
      },
      model: 'rateLimit',
    });
    await context.adapter.update({
      model: 'session',
      update: { activeOrganizationId: householdId },
      where: [{ field: 'id', value: crypto.randomUUID() }],
    });

    expect(statements.join('\n')).toContain(
      '"emdo"."better_auth_organizations"',
    );
    expect(statements.join('\n')).toContain(
      '"emdo"."active_household_memberships"',
    );
    const invitationRead = statements.find((statement) =>
      statement.includes('"emdo"."better_auth_invitations"'),
    );
    expect(invitationRead).toBeDefined();
    expect(invitationRead).not.toContain('token_hash');
    expect(statements.join('\n')).toContain('"emdo"."auth_rate_limits"');
    expect(statements.join('\n')).toContain('"active_household_id"');
  });
});
