import { expect, test } from '@playwright/test';

import {
  authenticatedSession,
  expectNoSeriousAccessibilityViolations,
} from './support.js';

test.describe('invite-only authentication', () => {
  test('signs in through the cookie session and never offers public sign-up', async ({
    page,
  }) => {
    let signedIn = false;
    let signInBody: unknown;
    await page.route('**/api/auth/get-session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(signedIn ? authenticatedSession : null),
      });
    });
    await page.route('**/api/auth/sign-in/email', async (route) => {
      signInBody = route.request().postDataJSON();
      signedIn = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          token: 'ignored-by-browser',
          user: authenticatedSession.user,
        }),
      });
    });

    await page.goto('/today');
    await expect(page).toHaveURL(/\/sign-in$/u);
    await expect(
      page.getByRole('heading', { name: 'Welcome back' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: /sign up|create account/iu }),
    ).toHaveCount(0);
    await page.getByLabel('Email').fill('MEMBER@example.ca');
    await page.getByLabel('Password').fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/today$/u);
    await expect(
      page.getByRole('heading', { name: 'Good morning' }),
    ).toBeVisible();
    expect(signInBody).toEqual({
      email: 'member@example.ca',
      password: 'correct horse battery staple',
      rememberMe: false,
    });
  });

  test('surfaces authoritative session expiry and keeps Google identity separate', async ({
    page,
  }) => {
    await page.route('**/api/auth/get-session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...authenticatedSession,
          session: { id: 'expired', expiresAt: '2000-01-01T00:00:00.000Z' },
        }),
      });
    });
    await page.route('**/api/v1/auth/invitations/csrf', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          token: 'invitation-csrf-token-0123456789',
        }),
      });
    });

    await page.goto('/settings');

    await expect(page).toHaveURL(/\/sign-in$/u);
    await expect(page.getByRole('alert')).toContainText(
      'Your session expired.',
    );
    await expect(
      page.getByText('Google identity only · Calendar access stays separate.'),
    ).toBeVisible();
    await expectNoSeriousAccessibilityViolations(page);
  });

  test('redeems an email-bound invitation and requires a separate sign-in', async ({
    page,
  }) => {
    await page.route('**/api/auth/get-session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: 'null',
      });
    });
    await page.route('**/api/v1/auth/invitations/csrf', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store, private' },
        body: JSON.stringify({
          schemaVersion: 1,
          token: 'invitation-csrf-token-0123456789',
        }),
      });
    });
    let redemption: unknown;
    await page.route('**/api/v1/auth/invitations/redeem', async (route) => {
      redemption = route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          userId: '22222222-2222-4222-8222-222222222222',
          householdId: '33333333-3333-4333-8333-333333333333',
          role: 'member',
          emailVerified: true,
        }),
      });
    });

    await page.goto(
      '/invite?invitationId=11111111-1111-4111-8111-111111111111&token=single-use-secret-012345&email=member%40example.ca',
    );
    await page.getByLabel('Display name').fill('Household Member');
    await page
      .getByLabel('Create password')
      .fill('correct horse battery staple');
    await page
      .getByLabel('Confirm password')
      .fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Create invited account' }).click();

    await expect(page.getByRole('status')).toContainText(
      'Your invited account is ready. Sign in to continue.',
    );
    expect(redemption).toEqual({
      schemaVersion: 1,
      displayName: 'Household Member',
      email: 'member@example.ca',
      invitationId: '11111111-1111-4111-8111-111111111111',
      invitationToken: 'single-use-secret-012345',
      password: 'correct horse battery staple',
    });
  });
});
