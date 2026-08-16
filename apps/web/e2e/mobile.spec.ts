import { devices, expect, test } from '@playwright/test';

import {
  expectNoSeriousAccessibilityViolations,
  mockAuthenticatedSession,
} from './support.js';

test.use({
  ...devices['Pixel 7'],
  // Match the accepted 852x1846 concept at a deterministic 2x scale in every
  // project that executes this semantic mobile contract.
  viewport: { width: 426, height: 923 },
  deviceScaleFactor: 2,
});

test.describe('EMDO touch mobile shell', () => {
  test.beforeEach(async ({ page }) => mockAuthenticatedSession(page));

  test('keeps every immutable approval field and visual action above mobile navigation', async ({
    page,
  }) => {
    await page.goto('/approvals');

    await expect(
      page.getByRole('heading', { name: 'Review approval' }),
    ).toBeVisible();
    for (const copy of [
      'Personal',
      'Tuesday, August 11',
      '2:30 PM–3:30 PM',
      'Leave by 1:55 PM',
      '225 King St W, Toronto',
      'Only the fields shown here are covered by this approval.',
      'Voice, typed replies, email, and notifications cannot approve this action.',
    ]) {
      await expect(page.getByText(copy, { exact: true })).toBeVisible();
    }

    const disclosureLocator = page.locator('.proposal-disclosure');
    const actionsLocator = page.locator('.approval-actions');
    for (let index = 0; index < 5; index += 1) {
      const [disclosureBox, actionsBox] = await Promise.all([
        disclosureLocator.boundingBox(),
        actionsLocator.boundingBox(),
      ]);
      if (
        disclosureBox &&
        actionsBox &&
        disclosureBox.y + disclosureBox.height <= actionsBox.y + 4
      ) {
        break;
      }
      await page.mouse.wheel(0, 250);
    }
    const disclosure = await disclosureLocator.boundingBox();
    const actions = await actionsLocator.boundingBox();
    const navigation = await page
      .getByRole('navigation', { name: 'Mobile primary' })
      .boundingBox();
    expect(disclosure).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(navigation).not.toBeNull();
    expect(
      (disclosure?.y ?? 0) + (disclosure?.height ?? 0),
    ).toBeLessThanOrEqual((actions?.y ?? 0) + 4);
    expect((actions?.y ?? 0) + (actions?.height ?? 0)).toBeLessThanOrEqual(
      (navigation?.y ?? 0) + 1,
    );

    await page.getByRole('button', { name: 'Approve action' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Approved. EMDO is verifying the provider write.',
    );
    await expect(
      page.getByRole('button', { name: 'More, current section: Approvals' }),
    ).toContainText('MoreApprovals');
    await expectNoSeriousAccessibilityViolations(page);
  });

  test('supports touch navigation and the narrow 320px viewport without overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/approvals');
    await expect(
      page.getByRole('heading', { name: 'Review approval' }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
});
