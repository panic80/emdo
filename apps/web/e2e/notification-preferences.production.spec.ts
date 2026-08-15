import { expect, test, type Page } from '@playwright/test';

import { mockAuthenticatedSession } from './support.js';

const csrfToken = 'e2e-csrf-token-01234567890123456789';
const preferenceIdempotencyKeyPattern =
  /^web\.notification-preferences\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type NotificationPreferences = Readonly<{
  schemaVersion: 1;
  version: number;
  inApp: boolean;
  push: boolean;
  email: boolean;
  spokenReplies: boolean;
  updatedAt: string;
}>;

async function installPreferenceMocks(page: Page): Promise<{
  readonly observations: {
    getRequests: number;
    putRequests: number;
    idempotencyKey: string | undefined;
    requestBody: unknown;
  };
}> {
  let preferences: NotificationPreferences = {
    schemaVersion: 1,
    version: 7,
    inApp: true,
    push: false,
    email: false,
    spokenReplies: false,
    updatedAt: '2026-08-15T12:00:00.000Z',
  };
  const observations: {
    getRequests: number;
    putRequests: number;
    idempotencyKey: string | undefined;
    requestBody: unknown;
  } = {
    getRequests: 0,
    putRequests: 0,
    idempotencyKey: undefined,
    requestBody: undefined,
  };

  await page.route('**/api/v1/experience/settings', async (route) => {
    const request = route.request();
    expect(request.method()).toBe('GET');
    expect(request.postData()).toBeNull();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store, private' },
      body: JSON.stringify({
        schemaVersion: 1,
        household: { name: 'Riverside household', role: 'member' },
        privateSpaces: [{ name: 'Personal' }],
        calendar: { status: 'disconnected' },
      }),
    });
  });
  await page.route(
    '**/api/v1/experience/notification-preferences',
    async (route) => {
      const request = route.request();
      expect(request.headers().accept).toContain('application/json');
      if (request.method() === 'GET') {
        expect(request.postData()).toBeNull();
        expect(request.headers()['idempotency-key']).toBeUndefined();
        expect(request.headers()['x-csrf-token']).toBeUndefined();
        observations.getRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'cache-control': 'no-store, private' },
          body: JSON.stringify(preferences),
        });
        return;
      }

      expect(request.method()).toBe('PUT');
      expect(request.headers()['content-type']).toContain('application/json');
      expect(request.headers()['x-csrf-token']).toBe(csrfToken);
      expect(request.headers()['idempotency-key']).toMatch(
        preferenceIdempotencyKeyPattern,
      );
      observations.putRequests += 1;
      observations.idempotencyKey = request.headers()['idempotency-key'];
      observations.requestBody = request.postDataJSON();
      expect(observations.requestBody).toEqual({
        schemaVersion: 1,
        expectedVersion: 7,
        preferences: {
          inApp: false,
          push: true,
          email: true,
          spokenReplies: true,
        },
      });
      preferences = {
        schemaVersion: 1,
        version: 8,
        inApp: false,
        push: true,
        email: true,
        spokenReplies: true,
        updatedAt: '2026-08-15T12:01:00.000Z',
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store, private' },
        body: JSON.stringify(preferences),
      });
    },
  );

  return { observations };
}

test('persists all notification preferences through the production bundle and rehydrates them after reload', async ({
  page,
}) => {
  await mockAuthenticatedSession(page);
  const { observations } = await installPreferenceMocks(page);

  await page.goto('/settings');
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible();

  const inApp = page.getByRole('checkbox', {
    name: /In-app notifications/u,
  });
  const push = page.getByRole('checkbox', { name: /Web Push/u });
  const email = page.getByRole('checkbox', { name: /Email reminders/u });
  const spoken = page.getByRole('checkbox', { name: /Spoken replies/u });
  await expect(inApp).toBeChecked();
  await expect(push).not.toBeChecked();
  await expect(email).not.toBeChecked();
  await expect(spoken).not.toBeChecked();

  await inApp.uncheck();
  await push.check();
  await email.check();
  await spoken.check();
  await page.getByRole('button', { name: 'Save preferences' }).click();

  await expect(
    page.getByText('Preferences saved.', { exact: true }),
  ).toBeVisible();
  expect(observations.putRequests).toBe(1);
  expect(observations.idempotencyKey).toMatch(preferenceIdempotencyKeyPattern);
  expect(observations.requestBody).toEqual({
    schemaVersion: 1,
    expectedVersion: 7,
    preferences: {
      inApp: false,
      push: true,
      email: true,
      spokenReplies: true,
    },
  });

  await page.reload();
  await expect.poll(() => observations.getRequests).toBeGreaterThanOrEqual(2);
  await expect(inApp).not.toBeChecked();
  await expect(push).toBeChecked();
  await expect(email).toBeChecked();
  await expect(spoken).toBeChecked();
  expect(observations.putRequests).toBe(1);
});
