import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

import * as contracts from './index.js';

const schema = (name: string): ZodType => {
  const candidate = (contracts as Record<string, unknown>)[name];
  expect(candidate, `${name} must be exported`).toBeDefined();
  return candidate as ZodType;
};

const scheduleItem = {
  id: 'scheduler-item-1',
  title: 'Household planning',
  startsAt: '2026-08-10T13:00:00.000-04:00',
  endsAt: '2026-08-10T13:45:00.000-04:00',
  completion: 'pending',
} as const;

describe('experience read contracts', () => {
  it('exports strict bounded Today, Activity, Schedule, Settings and preference schemas', () => {
    for (const name of [
      'TodayViewSchema',
      'ActivityPageSchema',
      'SchedulePageSchema',
      'FinancePageSchema',
      'ShoppingPageSchema',
      'SettingsViewSchema',
      'NotificationPreferencesViewSchema',
      'NotificationPreferencesUpdateRequestSchema',
    ]) {
      expect(schema(name)).toBeDefined();
    }
  });

  it('bounds finance and shopping pages to safe display projections', () => {
    const finance = schema('FinancePageSchema');
    const shopping = schema('ShoppingPageSchema');
    const transaction = {
      recordType: 'transaction',
      id: 'transaction-1',
      description: 'Farm Boy',
      category: 'groceries',
      postedOn: '2026-08-10',
      currency: 'CAD',
      amountCadMinor: 1_234,
      state: 'active',
    } as const;
    const item = {
      id: 'shopping-1',
      name: 'Milk',
      unit: 'carton',
      retailer: 'Market',
      quantityMinorUnits: 2_000,
      state: 'active',
    } as const;

    expect(
      finance.parse({ schemaVersion: 1, items: [transaction] }),
    ).toBeDefined();
    expect(shopping.parse({ schemaVersion: 1, items: [item] })).toBeDefined();
    expect(() =>
      finance.parse({
        schemaVersion: 1,
        items: [{ ...transaction, providerTransaction: { raw: true } }],
      }),
    ).toThrow();
    expect(() =>
      shopping.parse({
        schemaVersion: 1,
        items: [{ ...item, providerAuthority: 'forbidden' }],
      }),
    ).toThrow();
    expect(() =>
      shopping.parse({
        schemaVersion: 1,
        items: Array.from({ length: 51 }, (_, index) => ({
          ...item,
          id: `shopping-${index}`,
        })),
      }),
    ).toThrow();
  });

  it('accepts an empty truthful Today projection and rejects raw authority data', () => {
    const today = schema('TodayViewSchema');
    const value = {
      schemaVersion: 1,
      date: '2026-08-10',
      timezone: 'America/Toronto',
      schedule: { status: 'available', items: [scheduleItem] },
      reminders: { status: 'available', items: [] },
      notifications: { status: 'available', items: [] },
      finance: { status: 'available', budgetCount: 0, transactionCount: 0 },
      shopping: { status: 'available', itemCount: 0, retailerCount: 0 },
    };

    expect(today.parse(value)).toMatchObject(value);
    expect(() =>
      today.parse({
        ...value,
        schedule: {
          ...value.schedule,
          items: [
            {
              ...scheduleItem,
              providerGrantReference: 'must-never-cross-the-read-boundary',
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('requires sensitive notifications to use the fixed private title', () => {
    const today = schema('TodayViewSchema');
    const base = {
      schemaVersion: 1,
      date: '2026-08-10',
      timezone: 'America/Toronto',
      schedule: { status: 'available', items: [] },
      reminders: { status: 'available', items: [] },
      finance: { status: 'available', budgetCount: 0, transactionCount: 0 },
      shopping: { status: 'available', itemCount: 0, retailerCount: 0 },
    };

    expect(() =>
      today.parse({
        ...base,
        notifications: {
          status: 'available',
          items: [
            {
              id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f60',
              title: 'Dentist appointment details',
              sensitivity: 'sensitive',
              createdAt: '2026-08-10T12:00:00.000Z',
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      today.parse({
        ...base,
        notifications: {
          status: 'available',
          items: [
            {
              id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f60',
              title: 'Private notification',
              sensitivity: 'sensitive',
              createdAt: '2026-08-10T12:00:00.000Z',
            },
          ],
        },
      }),
    ).not.toThrow();
  });

  it('bounds pagination and rejects provider payloads from activity and schedule', () => {
    const activity = schema('ActivityPageSchema');
    const schedule = schema('SchedulePageSchema');

    expect(() =>
      activity.parse({
        schemaVersion: 1,
        items: Array.from({ length: 51 }, (_, index) => ({
          id: `activity-${index}`,
          category: 'audit',
          title: 'Activity recorded',
          occurredAt: '2026-08-10T12:00:00.000Z',
        })),
      }),
    ).toThrow();
    expect(() =>
      schedule.parse({
        schemaVersion: 1,
        timezone: 'America/Toronto',
        from: '2026-08-10',
        to: '2026-08-17',
        items: {
          status: 'available',
          items: [{ ...scheduleItem, providerResponse: { raw: true } }],
        },
        calendar: { status: 'unavailable' },
      }),
    ).toThrow();
    expect(() =>
      schedule.parse({
        schemaVersion: 1,
        timezone: 'America/Toronto',
        from: '2026-08-10',
        to: '2026-08-17',
        items: { status: 'unavailable', items: [] },
        calendar: { status: 'unavailable' },
      }),
    ).not.toThrow();
  });

  it('keeps settings and notification preferences purpose-built and versioned', () => {
    const settings = schema('SettingsViewSchema');
    const preferences = schema('NotificationPreferencesViewSchema');
    const update = schema('NotificationPreferencesUpdateRequestSchema');

    expect(
      settings.parse({
        schemaVersion: 1,
        household: { name: 'Johnson household', role: 'owner' },
        privateSpaces: [{ name: 'My private space' }],
        calendar: { status: 'disconnected' },
      }),
    ).toBeDefined();
    expect(() =>
      settings.parse({
        schemaVersion: 1,
        household: { name: 'Johnson household', role: 'owner' },
        privateSpaces: [],
        calendar: {
          status: 'connected',
          refreshToken: 'must-never-cross-the-read-boundary',
        },
      }),
    ).toThrow();

    const value = {
      schemaVersion: 1,
      version: 3,
      inApp: true,
      push: false,
      email: true,
      spokenReplies: false,
      updatedAt: '2026-08-10T12:00:00.000Z',
    };
    expect(preferences.parse(value)).toMatchObject(value);
    expect(
      update.parse({
        schemaVersion: 1,
        expectedVersion: 3,
        preferences: {
          inApp: true,
          push: true,
          email: false,
          spokenReplies: false,
        },
      }),
    ).toBeDefined();
  });
});
