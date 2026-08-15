import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { mockAuthenticatedSession } from './support.js';

const generatedWorkerPath = resolve(process.cwd(), 'dist/sw.js');
const generatedWorkerBackupPath = resolve(
  process.cwd(),
  'dist/.sw-update-evidence-original.js',
);

async function replaceGeneratedWorker(contents: string): Promise<void> {
  const temporaryPath = resolve(
    process.cwd(),
    'dist',
    `.sw-${randomUUID()}.tmp`,
  );
  await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temporaryPath, generatedWorkerPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function restoreGeneratedWorker(): Promise<void> {
  let original: string;
  try {
    original = await readFile(generatedWorkerBackupPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  await replaceGeneratedWorker(original);
  await unlink(generatedWorkerBackupPath);
}

test.afterEach(restoreGeneratedWorker);

async function installByteDistinctWorker(label: string): Promise<string> {
  const originalGeneratedWorker = await readFile(generatedWorkerPath, 'utf8');
  await writeFile(generatedWorkerBackupPath, originalGeneratedWorker, {
    encoding: 'utf8',
    flag: 'wx',
  });
  const marker = `${label}:${randomUUID()}`;
  const markerLiteral = JSON.stringify(marker);
  try {
    await replaceGeneratedWorker(
      `${originalGeneratedWorker}\nself.addEventListener("message",event=>{if(event.data?.type==="EMDO_EVIDENCE_VERSION")event.ports[0]?.postMessage(${markerLiteral})});\n`,
    );
  } catch (error) {
    await restoreGeneratedWorker();
    throw error;
  }
  return marker;
}

async function establishControlledClient(page: Page, path: string) {
  await page.goto(path);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (
    !(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
  ) {
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  await expect
    .poll(() =>
      page.evaluate(
        () => navigator.serviceWorker.controller?.scriptURL ?? null,
      ),
    )
    .not.toBeNull();
}

async function installWaitingWorker(
  page: Page,
  expectedMarker: string,
): Promise<{
  readonly controllerRemainedActive: boolean;
  readonly previousController: string;
  readonly waitingMarker: string;
}> {
  return page.evaluate(async (marker) => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const previousController = navigator.serviceWorker.controller?.scriptURL;
    if (!registration?.active || !previousController) {
      throw new Error('A controlled production client is required.');
    }

    const waitForWaitingWorker = new Promise<ServiceWorker>(
      (resolveWaiting, rejectWaiting) => {
        const timeout = window.setTimeout(
          () => rejectWaiting(new Error('The updated worker did not wait.')),
          30_000,
        );
        const settle = (worker: ServiceWorker | null): void => {
          if (!worker || worker.state !== 'installed') return;
          window.clearTimeout(timeout);
          resolveWaiting(worker);
        };
        settle(registration.waiting);
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          settle(worker);
          worker?.addEventListener('statechange', () => settle(worker));
        });
      },
    );

    await registration.update();
    const updatedRegistration =
      (await navigator.serviceWorker.getRegistration('/')) ?? registration;
    const waitingWorker =
      updatedRegistration.waiting ?? (await waitForWaitingWorker);
    const waitingMarker = await new Promise<string>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(
        () => reject(new Error('The waiting worker version is unavailable.')),
        5_000,
      );
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        window.clearTimeout(timeout);
        if (event.data !== marker) {
          reject(new Error('The waiting worker version is invalid.'));
          return;
        }
        resolve(event.data);
      };
      waitingWorker.postMessage({ type: 'EMDO_EVIDENCE_VERSION' }, [
        channel.port2,
      ]);
    });
    return {
      controllerRemainedActive:
        navigator.serviceWorker.controller === updatedRegistration.active,
      previousController,
      waitingMarker,
    };
  }, expectedMarker);
}

async function readControllerMarker(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const controller = navigator.serviceWorker.controller;
        if (!controller) {
          reject(new Error('The recovered client has no controller.'));
          return;
        }
        const channel = new MessageChannel();
        const timeout = window.setTimeout(
          () => reject(new Error('The controller version is unavailable.')),
          5_000,
        );
        channel.port1.onmessage = (event: MessageEvent<unknown>) => {
          window.clearTimeout(timeout);
          if (typeof event.data !== 'string') {
            reject(new Error('The controller version is invalid.'));
            return;
          }
          resolve(event.data);
        };
        controller.postMessage({ type: 'EMDO_EVIDENCE_VERSION' }, [
          channel.port2,
        ]);
      }),
  );
}

async function createOfflineFinanceEdit(page: Page): Promise<void> {
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Add transaction' }).click();
  await page.getByLabel('Description').fill('Update-safe transit pass');
  await page.getByLabel('Category').fill('Transport');
  await page.getByLabel('Amount (CAD)').fill('24.50');
  await page.getByLabel('Date').fill('2026-08-10');
  await page.getByRole('button', { name: 'Save transaction' }).click();
  await expect(
    page.getByText('1 local change waiting to sync', { exact: true }).first(),
  ).toBeVisible();
  await page.context().setOffline(false);
}

test.beforeEach(async ({ page }) => {
  // A retry after a worker-process crash first restores the production bytes.
  await restoreGeneratedWorker();
  await mockAuthenticatedSession(page);
});

test('defers a real service worker update while an offline edit is pending', async ({
  page,
}) => {
  await establishControlledClient(page, '/finance');
  await expect(page.getByRole('heading', { name: 'Finance' })).toBeVisible();
  await createOfflineFinanceEdit(page);

  const nextWorker = await installByteDistinctWorker('pending-edit');
  const update = await installWaitingWorker(page, nextWorker);

  const updateButton = page.getByRole('button', { name: 'Update EMDO' });
  await expect(updateButton.locator('..')).toContainText(
    'An EMDO update is ready. Sync or discard 1 local change',
  );
  await expect(updateButton).toBeDisabled();
  expect(update.waitingMarker).toBe(nextWorker);
  expect(update.controllerRemainedActive).toBe(true);
  expect(
    await page.evaluate(
      () => navigator.serviceWorker.controller?.scriptURL ?? null,
    ),
  ).toBe(update.previousController);
  await expect(
    page
      .getByRole('table', { name: 'Recent manual transactions' })
      .getByRole('row')
      .getByRole('cell'),
  ).toHaveText(['08-10', 'Update-safe transit pass', 'Transport', '$24.50']);
  await expect(
    page.getByText('1 local change waiting to sync', { exact: true }).first(),
  ).toBeVisible();
});

test('activates a real waiting service worker and reloads a clean client', async ({
  page,
}) => {
  await establishControlledClient(page, '/today');
  await expect(
    page.getByRole('heading', { name: 'Good morning' }),
  ).toBeVisible();

  const nextWorker = await installByteDistinctWorker('clean-client');
  const update = await installWaitingWorker(page, nextWorker);
  const updateButton = page.getByRole('button', { name: 'Update EMDO' });
  await expect(updateButton.locator('..')).toContainText(
    'An EMDO update is ready.',
  );
  await expect(updateButton).toBeEnabled();

  const reloaded = page.waitForEvent(
    'framenavigated',
    (frame) => frame === page.mainFrame() && frame.url().includes('/today'),
  );
  await updateButton.click();
  await reloaded;

  await expect(
    page.getByRole('heading', { name: 'Good morning' }),
  ).toBeVisible();
  await expect.poll(() => readControllerMarker(page)).toBe(nextWorker);
  expect(update.waitingMarker).toBe(nextWorker);
  expect(update.controllerRemainedActive).toBe(true);
  expect(
    await page.evaluate(
      () => navigator.serviceWorker.controller?.scriptURL ?? null,
    ),
  ).toBe(update.previousController);
  await expect(page.getByRole('button', { name: 'Update EMDO' })).toHaveCount(
    0,
  );
});
