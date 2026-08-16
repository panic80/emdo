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

  it('projects strict canonical finance and shopping entities without ledger internals', async () => {
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
