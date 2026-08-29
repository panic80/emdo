import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  EffectiveAuthorizationScopeFingerprintSchema,
  type ActivityPage,
  type FinancePage,
  type NotificationPreferencesView,
  type SchedulePage,
  type SettingsView,
  type ShoppingPage,
  type TodayView,
} from '@emdo/contracts';
import type { FinanceExperienceSnapshot } from '@emdo/domains/finance';

import * as databaseApi from '../api.js';
import type { DatabaseClient, DatabasePool } from '../scoped-repository.js';
import { ExperienceQueryCursorCodec } from './experience-query-cursor-codec.js';

const principal = {
  userId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f60',
  sessionId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f61',
  householdId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f62',
  role: 'owner' as const,
  emailVerified: true as const,
  spaceAccessGrantId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f63',
  collectionAuthorizationScopeFingerprint:
    EffectiveAuthorizationScopeFingerprintSchema.parse('a'.repeat(64)),
};
const privateFinancePrincipal = {
  ...principal,
  privateSpaceId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f68',
};

interface ExperienceGateways {
  readonly todayRead: {
    read(input: {
      readonly date: string;
      readonly principal: typeof principal;
      readonly requestId: string;
    }): Promise<TodayView>;
  };
  readonly activityRead: {
    list(input: {
      readonly cursor?: string;
      readonly limit: number;
      readonly principal: typeof principal;
      readonly requestId: string;
    }): Promise<ActivityPage>;
  };
  readonly scheduleRead: {
    list(input: {
      readonly from: string;
      readonly to: string;
      readonly cursor?: string;
      readonly limit: number;
      readonly principal: typeof principal;
      readonly requestId: string;
    }): Promise<SchedulePage>;
  };
  readonly settingsRead: {
    read(input: {
      readonly principal: typeof principal;
      readonly requestId: string;
    }): Promise<SettingsView>;
  };
  readonly financeRead: {
    list(input: {
      readonly cursor?: string;
      readonly limit: number;
      readonly principal: typeof principal;
      readonly requestId: string;
    }): Promise<FinancePage>;
    readSnapshot(input: {
      readonly principal: typeof privateFinancePrincipal;
      readonly requestId: string;
    }): Promise<FinanceExperienceSnapshot>;
  };
  readonly shoppingRead: {
    list(input: {
      readonly cursor?: string;
      readonly limit: number;
      readonly principal: typeof principal;
      readonly requestId: string;
    }): Promise<ShoppingPage>;
  };
  readonly notificationPreferences: {
    get(input: {
      readonly principal: typeof principal;
      readonly requestId: string;
    }): Promise<NotificationPreferencesView>;
    update(input: {
      readonly expectedVersion: number;
      readonly preferences: {
        readonly inApp: boolean;
        readonly push: boolean;
        readonly email: boolean;
        readonly spokenReplies: boolean;
      };
      readonly idempotencyKey: string;
      readonly principal: typeof principal;
      readonly requestId: string;
    }): Promise<NotificationPreferencesView>;
  };
}

type ExperienceFactory = (
  pool: DatabasePool,
  cursorCodec: ExperienceQueryCursorCodec,
) => ExperienceGateways;
type ReadinessCheck = (pool: DatabasePool) => Promise<boolean>;
interface ExperienceReadinessChecks {
  readonly todayRead: () => Promise<boolean>;
  readonly activityRead: () => Promise<boolean>;
  readonly scheduleRead: () => Promise<boolean>;
  readonly financeRead: () => Promise<boolean>;
  readonly shoppingRead: () => Promise<boolean>;
  readonly settingsRead: () => Promise<boolean>;
  readonly notificationPreferences: () => Promise<boolean>;
}
type ReadinessChecksFactory = (pool: DatabasePool) => ExperienceReadinessChecks;

const loadFactory = (): ExperienceFactory => {
  const candidate = (databaseApi as Record<string, unknown>)[
    'createPostgresExperienceReadGateways'
  ];
  expect(candidate).toBeTypeOf('function');
  return candidate as ExperienceFactory;
};

const gatewaysFor = (pool: DatabasePool): ExperienceGateways =>
  loadFactory()(
    pool,
    new ExperienceQueryCursorCodec({
      current: {
        keyId: 'experience-test-current',
        secret: new Uint8Array(32).fill(7),
      },
      clock: () => new Date('2026-08-10T14:00:00.000Z'),
    }),
  );

const loadReadinessCheck = (): ReadinessCheck => {
  const candidate = (databaseApi as Record<string, unknown>)[
    'checkPostgresExperienceReadiness'
  ];
  expect(candidate).toBeTypeOf('function');
  return candidate as ReadinessCheck;
};

const loadReadinessChecksFactory = (): ReadinessChecksFactory => {
  const candidate = (databaseApi as Record<string, unknown>)[
    'createPostgresExperienceReadinessChecks'
  ];
  expect(candidate).toBeTypeOf('function');
  return candidate as ReadinessChecksFactory;
};

const poolFor = (
  respond: (
    sql: string,
    values: readonly unknown[],
  ) => readonly Record<string, unknown>[],
) => {
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    const rows = respond(sql, values);
    return { rowCount: rows.length, rows };
  });
  const client: DatabaseClient = { query, release: vi.fn() };
  const pool: DatabasePool = { connect: vi.fn(async () => client) };
  return { pool, query, release: client.release };
};

describe('PostgreSQL experience read gateways', () => {
  it('checks the exact API role, request-scope routine, RLS, and projection privileges', async () => {
    const { pool, query, release } = poolFor((sql) =>
      sql.includes('experience_read_ready') ? [{ ready: true }] : [],
    );

    await expect(loadReadinessCheck()(pool)).resolves.toBe(true);

    const readinessSql = query.mock.calls.find(([sql]) =>
      sql.includes('experience_read_ready'),
    )?.[0];
    expect(readinessSql).toContain("session_user = 'emdo_api_login'");
    expect(readinessSql).toContain("pg_has_role(session_user, 'emdo_app'");
    expect(readinessSql).toContain('not login_role.rolsuper');
    expect(readinessSql).toContain('not login_role.rolbypassrls');
    expect(readinessSql).toContain("parent.rolname <> 'emdo_app'");
    expect(readinessSql).toContain('membership.inherit_option');
    expect(readinessSql).toContain('membership.set_option');
    expect(readinessSql).toContain('not membership.admin_option');
    expect(readinessSql).toContain('lock_active_request_scope(uuid,uuid,uuid)');
    for (const relation of [
      'households',
      'household_memberships',
      'spaces',
      'audit_events',
      'scheduler_reminders',
      'notifications',
      'notification_deliveries',
      'calendar_sync_states',
      'calendar_maintenance_receipts',
      'sync_entities',
      'notification_preferences',
      'notification_preference_commands',
    ]) {
      expect(readinessSql).toContain(`emdo.${relation}`);
    }
    expect(readinessSql).toContain(
      'read_experience_notification_preferences(uuid)',
    );
    expect(readinessSql).toContain(
      'update_experience_notification_preferences(uuid,integer,boolean,boolean,boolean,boolean,text)',
    );
    expect(readinessSql).toContain('has_any_column_privilege');
    expect(release).toHaveBeenCalledOnce();

    const malformed = poolFor((sql) =>
      sql.includes('experience_read_ready') ? [{ ready: 'yes' }] : [],
    );
    await expect(loadReadinessCheck()(malformed.pool)).resolves.toBe(false);
    expect(malformed.release).toHaveBeenCalledOnce();
  });

  it('reports exact per-component readiness without cross-surface false negatives', async () => {
    const { pool, query } = poolFor((sql) =>
      sql.includes('experience_finance_read_ready')
        ? [{ ready: false }]
        : [{ ready: true }],
    );
    const checks = loadReadinessChecksFactory()(pool);

    await expect(checks.todayRead()).resolves.toBe(true);
    await expect(checks.activityRead()).resolves.toBe(true);
    await expect(checks.scheduleRead()).resolves.toBe(true);
    await expect(checks.financeRead()).resolves.toBe(false);
    await expect(checks.shoppingRead()).resolves.toBe(true);
    await expect(checks.settingsRead()).resolves.toBe(true);
    await expect(checks.notificationPreferences()).resolves.toBe(true);

    const sqlFor = (marker: string) =>
      query.mock.calls.find(([sql]) => sql.includes(marker))?.[0] ?? '';
    expect(sqlFor('experience_today_read_ready')).toContain(
      'emdo.scheduler_reminders',
    );
    for (const column of [
      'household_id',
      'original_owner_user_id',
      'tombstoned_at',
      'in_app',
      'payload',
    ]) {
      expect(sqlFor('experience_today_read_ready')).toContain(`'${column}'`);
    }
    expect(sqlFor('experience_activity_read_ready')).toContain(
      'emdo.audit_events',
    );
    expect(sqlFor('experience_activity_read_ready')).toContain(
      "'household_id'",
    );
    expect(sqlFor('experience_schedule_read_ready')).toContain(
      'emdo.calendar_sync_states',
    );
    for (const column of [
      'household_id',
      'original_owner_user_id',
      'connection_id',
      'updated_at',
    ]) {
      expect(sqlFor('experience_schedule_read_ready')).toContain(`'${column}'`);
    }
    expect(sqlFor('experience_finance_read_ready')).toContain(
      'emdo.sync_entities',
    );
    expect(sqlFor('experience_finance_read_ready')).not.toContain(
      'notification_preferences',
    );
    expect(sqlFor('experience_shopping_read_ready')).toContain(
      'emdo.sync_entities',
    );
    expect(sqlFor('experience_settings_read_ready')).toContain('emdo.spaces');
    for (const column of [
      'household_id',
      'original_owner_user_id',
      'connection_id',
      'updated_at',
    ]) {
      expect(sqlFor('experience_settings_read_ready')).toContain(`'${column}'`);
    }
    const preferencesSql = sqlFor('experience_preferences_ready');
    expect(preferencesSql).toContain('emdo.notification_preferences');
    expect(preferencesSql).toContain(
      'read_experience_notification_preferences(uuid)',
    );
    expect(preferencesSql).toContain(
      "owner.rolname = 'emdo_experience_preferences_executor'",
    );
    expect(preferencesSql).toContain('routine.prosecdef');
    expect(preferencesSql).toContain("acl.privilege_type = 'EXECUTE'");
    expect(preferencesSql).toContain("'row_security=on'");
    expect(preferencesSql).toContain("'search_path=pg_catalog, emdo'");
    expect(preferencesSql).not.toContain('emdo.sync_entities');
    expect(preferencesSql).toContain("'SELECT,INSERT,UPDATE,REFERENCES'");
    expect(preferencesSql).toContain(
      "'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'",
    );
    expect(preferencesSql).not.toContain("'SELECT,INSERT,UPDATE,DELETE'");
  });

  it('returns bounded normalized Today data and redacts sensitive titles', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('experience_today_reminders')) {
        return [
          {
            reminder_id: 'reminder-1',
            title: 'Dentist details',
            sensitivity: 'sensitive',
            due_at: new Date('2026-08-10T14:00:00.000Z'),
            state: 'scheduled',
          },
        ];
      }
      if (sql.includes('experience_today_notifications')) {
        return [
          {
            notification_id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f69',
            title: 'Private account detail',
            sensitivity: 'sensitive',
            created_at: new Date('2026-08-10T12:00:00.000Z'),
          },
        ];
      }
      if (sql.includes('experience_today_schedule')) return [];
      if (sql.includes('experience_today_finance_count')) {
        return [{ budget_count: 2, transaction_count: 4 }];
      }
      if (sql.includes('experience_today_shopping_count')) {
        return [{ item_count: 3, retailer_count: 2 }];
      }
      return [];
    });
    const gateways = gatewaysFor(pool);

    const result = await gateways.todayRead.read({
      date: '2026-08-10',
      principal,
      requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
    });

    expect(result).toMatchObject({
      schedule: { status: 'available', items: [] },
      reminders: {
        status: 'available',
        items: [{ title: 'Private reminder', sensitivity: 'sensitive' }],
      },
      notifications: {
        status: 'available',
        items: [{ title: 'Private notification', sensitivity: 'sensitive' }],
      },
      finance: { status: 'available', budgetCount: 2, transactionCount: 4 },
      shopping: { status: 'available', itemCount: 3, retailerCount: 2 },
    });
    const notificationSql = query.mock.calls
      .map(([sql]) => sql)
      .filter(
        (sql) =>
          sql.includes('experience_today_reminders') ||
          sql.includes('experience_today_notifications'),
      )
      .join('\n');
    expect(notificationSql).not.toMatch(
      /\b(?:body|email_recipient|push_subscription_reference|payload)\b/iu,
    );
    expect(query.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(
      /provider(?:_|\s)*(?:authority|grant|token|response)|sealed_cursor/iu,
    );
  });

  it('paginates a payload-free activity union with a server cursor', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('experience_activity')) {
        return [
          {
            id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70',
            category: 'audit',
            title: 'Activity recorded',
            kind: 'finance.import.completed',
            status: null,
            occurred_at: new Date('2026-08-10T12:00:02.000Z'),
          },
          {
            id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71',
            category: 'calendar',
            title: 'Calendar maintenance recorded',
            kind: 'calendar.sync',
            status: 'completed',
            occurred_at: new Date('2026-08-10T12:00:01.000Z'),
          },
          {
            id: 'delivery-0000000000000001',
            category: 'notification',
            title: 'Notification delivery recorded',
            kind: 'notification.delivery',
            status: 'sent',
            occurred_at: new Date('2026-08-10T12:00:00.000Z'),
          },
        ];
      }
      return [];
    });
    const gateways = gatewaysFor(pool);

    const first = await gateways.activityRead.list({
      limit: 2,
      principal,
      requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
    });

    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(first)).not.toMatch(
      /payload|sessionId|requestId|provider|hash|usage/iu,
    );
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes('experience_activity'),
      )?.[0],
    ).not.toContain('payload');
  });

  it('rejects tampered and cross-session experience cursors before querying durable rows', async () => {
    const firstPool = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('experience_activity')) {
        return [
          {
            id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70',
            category: 'audit',
            title: 'Activity recorded',
            kind: 'finance.import.completed',
            status: null,
            occurred_at: new Date('2026-08-10T12:00:02.000Z'),
          },
          {
            id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71',
            category: 'audit',
            title: 'Activity recorded',
            kind: 'finance.import.completed',
            status: null,
            occurred_at: new Date('2026-08-10T12:00:01.000Z'),
          },
        ];
      }
      return [];
    });
    const first = await gatewaysFor(firstPool.pool).activityRead.list({
      limit: 1,
      principal,
      requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    const tampered = `${first.nextCursor!.slice(0, -1)}${
      first.nextCursor!.endsWith('A') ? 'B' : 'A'
    }`;
    const deniedPool = poolFor(() => []);
    const gateway = gatewaysFor(deniedPool.pool).activityRead;
    await expect(
      gateway.list({
        cursor: tampered,
        limit: 1,
        principal,
        requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f65',
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(
      gateway.list({
        cursor: first.nextCursor,
        limit: 1,
        principal: {
          ...principal,
          sessionId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f66',
        },
        requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f67',
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(deniedPool.query).not.toHaveBeenCalled();
  });

  it('reports scheduler payloads unavailable while exposing only safe Calendar state', async () => {
    const { pool } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('experience_calendar_state')) {
        return [
          {
            state: 'ready',
            last_synced_at: new Date('2026-08-10T11:59:00.000Z'),
          },
        ];
      }
      if (sql.includes('experience_schedule_entities')) {
        return [
          {
            entity_id: 'appointment-1',
            payload: {
              id: 'appointment-1',
              title: 'Household planning',
              notes: null,
              location: null,
              startsAt: '2026-08-11T14:00:00.000-04:00',
              endsAt: '2026-08-11T15:00:00.000-04:00',
              recurrence: null,
              attendees: [],
              completion: 'open',
            },
            updated_at: new Date('2026-08-10T12:00:00.000Z'),
          },
        ];
      }
      return [];
    });
    const gateways = gatewaysFor(pool);

    await expect(
      gateways.scheduleRead.list({
        from: '2026-08-10',
        to: '2026-08-17',
        limit: 25,
        principal,
        requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
      }),
    ).resolves.toMatchObject({
      items: {
        status: 'available',
        items: [
          {
            id: 'appointment-1',
            title: 'Household planning',
            completion: 'pending',
          },
        ],
      },
      calendar: {
        status: 'connected',
        lastSyncedAt: '2026-08-10T11:59:00.000Z',
      },
    });
  });

  it('returns one owner-private Finance snapshot with exact over-page totals and all legacy and modern CAD budget allocations', async () => {
    const activeTransactions = Array.from({ length: 55 }, (_value, index) => ({
      entity_id: `transaction-${String(index).padStart(3, '0')}`,
      revision: 0,
      payload: {
        schemaVersion: 1,
        id: `transaction-${String(index).padStart(3, '0')}`,
        spaceId: privateFinancePrincipal.privateSpaceId,
        ownerUserId: privateFinancePrincipal.userId,
        createdAt: '2026-08-01T12:00:00.000Z',
        updatedAt: '2026-08-01T12:00:00.000Z',
        recordType: 'transaction',
        accountId: 'account-1',
        categoryId: `category-${String(index % 25).padStart(2, '0')}`,
        postedOn: '2026-08-01',
        description: `Reviewed transaction ${index}`,
        annotation: null,
        currency: 'CAD',
        originalAmountCadMinor: index + 1,
        effectiveAmountCadMinor: index + 1,
        adjustments: [],
        reversal: null,
        appliedOperationIds: [],
        source: { kind: 'manual' },
      },
    }));
    const excludedTransactions = [
      {
        entity_id: 'transaction-reversed',
        revision: 0,
        payload: {
          schemaVersion: 1,
          id: 'transaction-reversed',
          spaceId: privateFinancePrincipal.privateSpaceId,
          ownerUserId: privateFinancePrincipal.userId,
          createdAt: '2026-08-01T12:00:00.000Z',
          updatedAt: '2026-08-01T12:00:00.000Z',
          recordType: 'transaction',
          accountId: 'account-1',
          categoryId: 'category-reversed',
          postedOn: '2026-08-01',
          description: 'Reversed transaction',
          annotation: null,
          currency: 'CAD',
          originalAmountCadMinor: 2_000,
          effectiveAmountCadMinor: 0,
          adjustments: [],
          reversal: {
            operationId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f81',
            reason: 'Cancelled merchant charge',
          },
          appliedOperationIds: ['018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f81'],
          source: { kind: 'manual' },
        },
      },
      {
        entity_id: 'legacy-needs-review',
        revision: 0,
        payload: {
          recordType: 'transaction',
          id: 'legacy-needs-review',
          description: 'Needs review',
          category: 'category-needs-review',
          postedOn: '2026-08-01',
          source: 'manual',
          currency: 'CAD',
          originalAmountCadMinor: 3_000,
          effectiveAmountCadMinor: 3_000,
          amountConflict: true,
          adjustments: [],
          reversal: null,
          appliedOperationIds: [],
        },
      },
      {
        entity_id: 'non-cad-excluded',
        revision: 0,
        payload: {
          recordType: 'transaction',
          id: 'non-cad-excluded',
          description: 'USD source record',
          category: 'category-usd',
          postedOn: '2026-08-01',
          source: 'manual',
          currency: 'USD',
          originalAmountCadMinor: 4_000,
          effectiveAmountCadMinor: 4_000,
          amountConflict: false,
          adjustments: [],
          reversal: null,
          appliedOperationIds: [],
        },
      },
    ];
    const currentBudget = {
      entity_id: 'budget-2026-08',
      revision: 0,
      payload: {
        schemaVersion: 1,
        id: 'budget-2026-08',
        spaceId: privateFinancePrincipal.privateSpaceId,
        ownerUserId: privateFinancePrincipal.userId,
        createdAt: '2026-08-01T12:00:00.000Z',
        updatedAt: '2026-08-01T12:00:00.000Z',
        recordType: 'budget',
        month: '2026-08',
        currency: 'CAD',
        allocations: Array.from({ length: 101 }, (_value, index) => ({
          categoryId: `budget-category-${String(index).padStart(3, '0')}`,
          amountCadMinor: index,
        })),
        revision: 0,
      },
    };
    const legacyBudget = {
      entity_id: 'legacy-budget-2024-01',
      revision: 0,
      payload: {
        id: 'legacy-budget-2024-01',
        currency: 'CAD',
        allocationsCadMinor: {
          'legacy-groceries': 5_000,
          'legacy-transit': 2_500,
        },
      },
    };
    const pastModernBudget = {
      entity_id: 'budget-2024-12',
      revision: 0,
      payload: {
        schemaVersion: 1,
        id: 'budget-2024-12',
        spaceId: privateFinancePrincipal.privateSpaceId,
        ownerUserId: privateFinancePrincipal.userId,
        createdAt: '2026-08-01T12:00:00.000Z',
        updatedAt: '2026-08-01T12:00:00.000Z',
        recordType: 'budget',
        month: '2024-12',
        currency: 'CAD',
        allocations: [{ categoryId: 'category-00', amountCadMinor: 200 }],
        revision: 0,
      },
    };
    const category = (id: string, name: string) => ({
      entity_id: id,
      revision: 0,
      payload: {
        schemaVersion: 1,
        id,
        spaceId: privateFinancePrincipal.privateSpaceId,
        ownerUserId: privateFinancePrincipal.userId,
        createdAt: '2026-08-01T12:00:00.000Z',
        updatedAt: '2026-08-01T12:00:00.000Z',
        recordType: 'category',
        name,
        categoryKind: 'expense',
        parentCategoryId: null,
        active: true,
      },
    });
    const categories = [
      ...Array.from({ length: 25 }, (_value, index) =>
        category(
          `category-${String(index).padStart(2, '0')}`,
          index < 2
            ? 'Shared display name'
            : `Category ${String(index).padStart(2, '0')}`,
        ),
      ),
      ...Array.from({ length: 101 }, (_value, index) =>
        category(
          `budget-category-${String(index).padStart(3, '0')}`,
          `Budget Category ${String(index).padStart(3, '0')}`,
        ),
      ),
      category('category-reversed', 'Reversed category'),
    ];
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope')) {
        return [{ authorized: true }];
      }
      if (sql.includes('experience_finance_snapshot')) {
        return [
          {
            transactions: [...activeTransactions, ...excludedTransactions],
            budgets: [legacyBudget, pastModernBudget, currentBudget],
            categories,
          },
        ];
      }
      return [];
    });

    const result = await gatewaysFor(pool).financeRead.readSnapshot({
      principal: privateFinancePrincipal,
      requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
    });

    expect(result.reviewedCadTotals).toHaveLength(25);
    expect(
      result.reviewedCadTotals.reduce(
        (total, entry) => total + entry.amountCadMinor,
        0,
      ),
    ).toBe(1_540);
    expect(
      result.reviewedCadTotals.filter(
        (entry) => entry.label === 'Shared display name',
      ),
    ).toHaveLength(2);
    expect(result.reviewedCadTotals.map((entry) => entry.label)).not.toContain(
      'Reversed category',
    );
    expect(result.reviewedCadTotals.map((entry) => entry.label)).not.toContain(
      'category-needs-review',
    );
    expect(result.reviewedCadTotals.map((entry) => entry.label)).not.toContain(
      'category-usd',
    );
    expect(result.recentActivity).toHaveLength(50);
    expect(result.recentActivity).toContainEqual({
      id: 'transaction-054',
      label: 'Category 04: Reviewed transaction 54',
      occurredAt: '2026-08-01T12:00:00.000Z',
    });
    expect(result.recentActivity?.map((entry) => entry.id)).not.toContain(
      'non-cad-excluded',
    );
    expect(result.budgets).toHaveLength(104);
    expect(result.budgets).toContainEqual({
      id: 'budget-2026-08:budget-category-100',
      label: 'Budget Category 100',
      allocatedCadMinor: 100,
    });
    expect(result.budgets).toContainEqual({
      id: 'budget-2024-12:category-00',
      label: 'Shared display name',
      allocatedCadMinor: 200,
    });
    expect(result.budgets).toContainEqual({
      id: 'legacy-budget-2024-01:legacy-groceries',
      label: 'legacy-groceries',
      allocatedCadMinor: 5_000,
    });

    const snapshotCalls = query.mock.calls.filter(([sql]) =>
      sql.includes('experience_finance_snapshot'),
    );
    expect(snapshotCalls).toHaveLength(1);
    const [snapshotSql, snapshotValues] = snapshotCalls[0]!;
    expect(snapshotValues).toEqual([
      privateFinancePrincipal.householdId,
      privateFinancePrincipal.privateSpaceId,
      privateFinancePrincipal.userId,
    ]);
    expect(snapshotSql).toContain('entity.space_id = $2::uuid');
    expect(snapshotSql).toContain('entity.original_owner_user_id = $3::uuid');
    expect(snapshotSql).toContain("entity.entity_type = 'finance.category'");
    expect(snapshotSql).not.toContain("entity.payload ->> 'currency'");
    expect(snapshotSql).not.toContain("entity.payload ->> 'month'");
    expect(snapshotSql).not.toContain('America/Toronto');
    expect(snapshotSql).toContain('limit 100001');
    expect(snapshotSql.match(/limit 1001/g)).toHaveLength(2);
    expect(snapshotSql).not.toContain('offset');
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes('lock_active_request_scope'),
      )?.[1],
    ).toEqual([
      privateFinancePrincipal.householdId,
      privateFinancePrincipal.privateSpaceId,
      null,
    ]);
  });

  it('fails closed when a selected Finance row has a missing or malformed currency', async () => {
    for (const payload of [{}, { currency: 'cad' }]) {
      const { pool } = poolFor((sql) => {
        if (sql.includes('lock_active_request_scope')) {
          return [{ authorized: true }];
        }
        if (sql.includes('experience_finance_snapshot')) {
          return [
            {
              transactions: [
                {
                  entity_id: 'malformed-currency-transaction',
                  revision: 0,
                  payload,
                },
              ],
              budgets: [],
              categories: [],
            },
          ];
        }
        return [];
      });
      await expect(
        gatewaysFor(pool).financeRead.readSnapshot({
          principal: privateFinancePrincipal,
          requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
        }),
      ).rejects.toMatchObject({ code: 'invalid-result' });
    }
  });

  it('fails closed when a modern Finance transaction or budget references an unavailable category', async () => {
    const transaction = {
      entity_id: 'transaction-missing-category',
      revision: 1,
      payload: {
        schemaVersion: 1,
        id: 'transaction-missing-category',
        spaceId: privateFinancePrincipal.privateSpaceId,
        ownerUserId: privateFinancePrincipal.userId,
        createdAt: '2026-08-01T12:00:00.000Z',
        updatedAt: '2026-08-01T12:00:00.000Z',
        recordType: 'transaction',
        accountId: 'account-1',
        categoryId: 'missing-category',
        postedOn: '2026-08-01',
        description: 'Missing category reference',
        annotation: null,
        currency: 'CAD',
        originalAmountCadMinor: 1,
        effectiveAmountCadMinor: 1,
        adjustments: [],
        reversal: null,
        appliedOperationIds: [],
        source: { kind: 'manual' },
      },
    };
    const budget = {
      entity_id: 'budget-missing-category',
      revision: 1,
      payload: {
        schemaVersion: 1,
        id: 'budget-missing-category',
        spaceId: privateFinancePrincipal.privateSpaceId,
        ownerUserId: privateFinancePrincipal.userId,
        createdAt: '2026-08-01T12:00:00.000Z',
        updatedAt: '2026-08-01T12:00:00.000Z',
        recordType: 'budget',
        month: '2026-08',
        currency: 'CAD',
        allocations: [{ categoryId: 'missing-category', amountCadMinor: 1 }],
        revision: 1,
      },
    };
    for (const snapshot of [
      { transactions: [transaction], budgets: [], categories: [] },
      { transactions: [], budgets: [budget], categories: [] },
    ]) {
      const { pool } = poolFor((sql) => {
        if (sql.includes('lock_active_request_scope')) {
          return [{ authorized: true }];
        }
        return sql.includes('experience_finance_snapshot') ? [snapshot] : [];
      });
      await expect(
        gatewaysFor(pool).financeRead.readSnapshot({
          principal: privateFinancePrincipal,
          requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
        }),
      ).rejects.toMatchObject({ code: 'invalid-result' });
    }
  });

  it('fails rather than clipping owner-private Finance snapshot bounds', async () => {
    const oversizedTransactions = Array<Record<string, unknown>>(100_001).fill({
      entity_id: 'transaction-over-limit',
      revision: 0,
      payload: { currency: 'USD' },
    });
    const oversizedCategories = Array<Record<string, unknown>>(1_001).fill({
      entity_id: 'category-over-limit',
      revision: 0,
      payload: {},
    });
    const allocations = Object.fromEntries(
      Array.from({ length: 501 }, (_value, index) => [
        `legacy-allocation-${String(index).padStart(3, '0')}`,
        index,
      ]),
    );
    const budgetRows = ['legacy-budget-a', 'legacy-budget-b'].map((id) => ({
      entity_id: id,
      revision: 0,
      payload: {
        id,
        currency: 'CAD',
        allocationsCadMinor: allocations,
      },
    }));
    for (const snapshot of [
      { transactions: oversizedTransactions, budgets: [], categories: [] },
      { transactions: [], budgets: [], categories: oversizedCategories },
      { transactions: [], budgets: budgetRows, categories: [] },
    ]) {
      const { pool } = poolFor((sql) => {
        if (sql.includes('lock_active_request_scope')) {
          return [{ authorized: true }];
        }
        return sql.includes('experience_finance_snapshot') ? [snapshot] : [];
      });
      await expect(
        gatewaysFor(pool).financeRead.readSnapshot({
          principal: privateFinancePrincipal,
          requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
        }),
      ).rejects.toMatchObject({ code: 'invalid-result' });
    }
  });

  it('projects safe-written modern Finance transactions and budgets', async () => {
    const reversalOperationId = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f70';
    const opaqueCategoryId = 'Food & Dining';
    const derivedCategoryId = `category-${createHash('sha256')
      .update(opaqueCategoryId, 'utf8')
      .digest('hex')}`;
    const derivedCategoryProjection = `category-${createHash('sha256')
      .update(derivedCategoryId, 'utf8')
      .digest('hex')}`;
    const { pool } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (!sql.includes('experience_finance_entities')) return [];
      return [
        {
          entity_type: 'finance.transaction',
          entity_id: 'transaction-modern-1',
          payload: {
            schemaVersion: 1,
            id: 'transaction-modern-1',
            spaceId: privateFinancePrincipal.privateSpaceId,
            ownerUserId: principal.userId,
            createdAt: '2026-08-10T12:00:00.000Z',
            updatedAt: '2026-08-11T12:00:00.000Z',
            recordType: 'transaction',
            accountId: 'account-1',
            categoryId: opaqueCategoryId,
            postedOn: '2026-08-10',
            description: 'x'.repeat(161),
            annotation: null,
            currency: 'CAD',
            originalAmountCadMinor: -1_234,
            effectiveAmountCadMinor: 0,
            adjustments: [],
            reversal: { operationId: reversalOperationId, reason: 'Duplicate' },
            appliedOperationIds: [reversalOperationId],
            source: { kind: 'manual' },
            revision: 1,
          },
          updated_at: new Date('2026-08-11T12:00:00.000Z'),
        },
        {
          entity_type: 'finance.budget',
          entity_id: 'budget-modern-1',
          payload: {
            schemaVersion: 1,
            id: 'budget-modern-1',
            spaceId: privateFinancePrincipal.privateSpaceId,
            ownerUserId: principal.userId,
            createdAt: '2026-08-01T12:00:00.000Z',
            updatedAt: '2026-08-01T12:00:00.000Z',
            recordType: 'budget',
            month: '2026-08',
            currency: 'CAD',
            allocations: [
              { categoryId: opaqueCategoryId, amountCadMinor: 65_000 },
              { categoryId: derivedCategoryId, amountCadMinor: 10_000 },
            ],
            revision: 0,
          },
          updated_at: new Date('2026-08-10T11:00:00.000Z'),
        },
      ];
    });

    await expect(
      gatewaysFor(pool).financeRead.list({
        limit: 25,
        principal,
        requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
      }),
    ).resolves.toMatchObject({
      items: [
        {
          recordType: 'transaction',
          id: 'transaction-modern-1',
          description: 'x'.repeat(160),
          category: 'Food & Dining',
          amountCadMinor: 0,
          state: 'reversed',
        },
        {
          recordType: 'budget',
          id: 'budget-modern-1',
          allocationsCadMinor: {
            [derivedCategoryId]: 65_000,
            [derivedCategoryProjection]: 10_000,
          },
        },
      ],
    });
  });

  it('fails closed when a modern Finance page record is owned by another user', async () => {
    const { pool } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (!sql.includes('experience_finance_entities')) return [];
      return [
        {
          entity_type: 'finance.transaction',
          entity_id: 'transaction-modern-other-owner',
          payload: {
            schemaVersion: 1,
            id: 'transaction-modern-other-owner',
            spaceId: privateFinancePrincipal.privateSpaceId,
            ownerUserId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f71',
            createdAt: '2026-08-10T12:00:00.000Z',
            updatedAt: '2026-08-10T12:00:00.000Z',
            recordType: 'transaction',
            accountId: 'account-1',
            categoryId: null,
            postedOn: '2026-08-10',
            description: 'Other owner',
            currency: 'CAD',
            originalAmountCadMinor: -1,
            effectiveAmountCadMinor: -1,
            adjustments: [],
            reversal: null,
            appliedOperationIds: [],
            source: { kind: 'manual' },
            revision: 0,
          },
          updated_at: new Date('2026-08-10T12:00:00.000Z'),
        },
      ];
    });

    await expect(
      gatewaysFor(pool).financeRead.list({
        limit: 25,
        principal,
        requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
      }),
    ).rejects.toMatchObject({ code: 'invalid-result' });
  });

  it('fails closed for malformed modern Finance page payloads', async () => {
    const { pool } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (!sql.includes('experience_finance_entities')) return [];
      return [
        {
          entity_type: 'finance.budget',
          entity_id: 'budget-modern-malformed',
          payload: {
            schemaVersion: 1,
            id: 'budget-modern-malformed',
            spaceId: privateFinancePrincipal.privateSpaceId,
            ownerUserId: principal.userId,
            createdAt: '2026-08-01T12:00:00.000Z',
            updatedAt: '2026-08-01T12:00:00.000Z',
            recordType: 'budget',
            month: '2026-08',
            currency: 'CAD',
            allocations: [
              { categoryId: 'groceries', amountCadMinor: 20_000 },
              { categoryId: 'groceries', amountCadMinor: 30_000 },
            ],
            revision: 0,
          },
          updated_at: new Date('2026-08-10T12:00:00.000Z'),
        },
      ];
    });

    await expect(
      gatewaysFor(pool).financeRead.list({
        limit: 25,
        principal,
        requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
      }),
    ).rejects.toMatchObject({ code: 'invalid-result' });
  });

  it('fails closed when a modern Finance budget exceeds page allocation bounds', async () => {
    const allocations = Array.from({ length: 101 }, (_, index) => ({
      categoryId: `category-${String(index).padStart(3, '0')}`,
      amountCadMinor: index,
    }));
    const { pool } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (!sql.includes('experience_finance_entities')) return [];
      return [
        {
          entity_type: 'finance.budget',
          entity_id: 'budget-modern-unbounded',
          payload: {
            schemaVersion: 1,
            id: 'budget-modern-unbounded',
            spaceId: privateFinancePrincipal.privateSpaceId,
            ownerUserId: principal.userId,
            createdAt: '2026-08-01T12:00:00.000Z',
            updatedAt: '2026-08-01T12:00:00.000Z',
            recordType: 'budget',
            month: '2026-08',
            currency: 'CAD',
            allocations,
            revision: 0,
          },
          updated_at: new Date('2026-08-10T12:00:00.000Z'),
        },
      ];
    });

    await expect(
      gatewaysFor(pool).financeRead.list({
        limit: 25,
        principal,
        requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
      }),
    ).rejects.toMatchObject({ code: 'invalid-result' });
  });

  it('preserves legacy Finance projections alongside strict shopping entities', async () => {
    const { pool } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('experience_finance_entities')) {
        return [
          {
            entity_type: 'finance.transaction',
            entity_id: 'transaction-1',
            payload: {
              recordType: 'transaction',
              description: 'Farm Boy',
              category: 'groceries',
              postedOn: '2026-08-10',
              source: 'manual',
              id: 'transaction-1',
              currency: 'CAD',
              originalAmountCadMinor: 1_234,
              effectiveAmountCadMinor: 1_234,
              amountConflict: false,
              adjustments: [],
              reversal: null,
              appliedOperationIds: [],
            },
            updated_at: new Date('2026-08-10T12:00:00.000Z'),
          },
          {
            entity_type: 'finance.budget',
            entity_id: 'budget-1',
            payload: {
              id: 'budget-1',
              currency: 'CAD',
              allocationsCadMinor: { groceries: 65_000 },
            },
            updated_at: new Date('2026-08-10T11:00:00.000Z'),
          },
        ];
      }
      if (sql.includes('experience_shopping_entities')) {
        return [
          {
            entity_id: 'shopping-1',
            payload: {
              itemId: 'shopping-1',
              name: 'Milk',
              unit: 'carton',
              retailer: 'Market',
              quantityMinorUnits: 2_000,
              tombstoned: false,
              baseQuantityMinorUnits: 2_000,
              baseTombstoned: false,
              quantityConflict: false,
              appliedOperationIds: [],
              appliedOperations: [],
            },
            updated_at: new Date('2026-08-10T12:00:00.000Z'),
          },
        ];
      }
      return [];
    });
    const gateways = gatewaysFor(pool);

    await expect(
      gateways.financeRead.list({
        limit: 25,
        principal,
        requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
      }),
    ).resolves.toMatchObject({
      items: [
        {
          recordType: 'transaction',
          amountCadMinor: 1_234,
          state: 'active',
        },
        { recordType: 'budget', allocationsCadMinor: { groceries: 65_000 } },
      ],
    });
    await expect(
      gateways.shoppingRead.list({
        limit: 25,
        principal,
        requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
      }),
    ).resolves.toMatchObject({
      items: [
        {
          id: 'shopping-1',
          name: 'Milk',
          quantityMinorUnits: 2_000,
          state: 'active',
        },
      ],
    });
  });

  it('reads and CAS-updates durable notification preferences through narrow routines', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('read_experience_notification_preferences')) {
        return [
          {
            result: {
              schemaVersion: 1,
              version: 1,
              inApp: true,
              push: false,
              email: false,
              spokenReplies: false,
              updatedAt: '2026-08-10T12:00:00.000Z',
            },
          },
        ];
      }
      if (sql.includes('update_experience_notification_preferences')) {
        return [
          {
            result: {
              schemaVersion: 1,
              version: 2,
              inApp: true,
              push: true,
              email: false,
              spokenReplies: false,
              updatedAt: '2026-08-10T12:01:00.000Z',
            },
          },
        ];
      }
      return [];
    });
    const gateway = gatewaysFor(pool).notificationPreferences;

    await expect(
      gateway.get({
        principal,
        requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
      }),
    ).resolves.toMatchObject({ version: 1, inApp: true, push: false });
    await expect(
      gateway.update({
        expectedVersion: 1,
        preferences: {
          inApp: true,
          push: true,
          email: false,
          spokenReplies: false,
        },
        idempotencyKey: 'notification-preferences:2026-08-10:0001',
        principal,
        requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f65',
      }),
    ).resolves.toMatchObject({ version: 2, push: true });
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes('update_experience_notification_preferences'),
      )?.[1],
    ).toEqual([
      principal.householdId,
      1,
      true,
      true,
      false,
      false,
      'notification-preferences:2026-08-10:0001',
    ]);
  });

  it('maps preference version and idempotency failures to bounded conflicts', async () => {
    for (const message of [
      'EMDO:version-conflict',
      'EMDO:idempotency-conflict',
    ]) {
      const { pool } = poolFor((sql) => {
        if (sql.includes('lock_active_request_scope')) {
          return [{ authorized: true }];
        }
        if (sql.includes('update_experience_notification_preferences')) {
          throw new Error(message);
        }
        return [];
      });
      await expect(
        gatewaysFor(pool).notificationPreferences.update({
          expectedVersion: 1,
          preferences: {
            inApp: true,
            push: false,
            email: false,
            spokenReplies: false,
          },
          idempotencyKey: 'notification-preferences:2026-08-10:0002',
          principal,
          requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f66',
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
    }
  });

  it('returns household and private-space labels without provider authority material', async () => {
    const { pool, query } = poolFor((sql) => {
      if (sql.includes('lock_active_request_scope'))
        return [{ authorized: true }];
      if (sql.includes('experience_settings_household')) {
        return [{ household_name: 'Johnson household', role: 'owner' }];
      }
      if (sql.includes('experience_settings_private_spaces')) {
        return [{ name: 'My private space' }];
      }
      if (sql.includes('experience_calendar_state')) {
        return [{ state: 'disconnected', last_synced_at: null }];
      }
      return [];
    });
    const gateways = gatewaysFor(pool);

    const result = await gateways.settingsRead.read({
      principal,
      requestId: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f64',
    });

    expect(result).toEqual({
      schemaVersion: 1,
      household: { name: 'Johnson household', role: 'owner' },
      privateSpaces: [{ name: 'My private space' }],
      calendar: { status: 'disconnected' },
    });
    expect(query.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(
      /sealed_cursor|provider_version|evidence_hash|encrypted|token|payload/iu,
    );
  });
});
