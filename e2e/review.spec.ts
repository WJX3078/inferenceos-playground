import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-17T00:00:00Z') });
  await page.goto('/');
  await page.clock.pauseAt(new Date('2026-09-17T01:00:00Z'));
  await page.getByRole('button', { name: 'Pause simulation', exact: true }).click();
});

test('navigation preserves unapplied Runtime config and mobile Compare remains operable', async ({ page }) => {
  await page.getByLabel('Token budget', { exact: true }).fill('127');
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await page.getByRole('button', { name: 'Runtime', exact: true }).click();
  await expect(page.getByLabel('Token budget', { exact: true })).toHaveValue('127');
  await expect(page.getByRole('button', { name: 'Apply & restart', exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole('button', { name: 'Toggle control plane' }).click();
  await page.getByLabel('Scenario').selectOption('compare');
  await expect(page.getByTestId('comparison-status')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Toggle control plane' })).toBeHidden();
  await page.getByRole('button', { name: 'Workload settings · Edit', exact: true }).click();
  await expect(page.getByLabel('Request count', { exact: true })).toBeVisible();
});

test('prefix lookup remains pending until admission, then exposes measured results', async ({ page }) => {
  await page.getByLabel('Scenario').selectOption('shared-system');
  const prefix = page.locator('.prefix-inspector');
  await expect(prefix).toContainText('Lookup pending admission');
  await expect(prefix.getByRole('button', { name: /Prefix block \d+: MISS/ })).toHaveCount(0);
  await expect(prefix.getByRole('button', { name: /Prefix block \d+: PENDING/ })).toHaveCount(32);
  await page.getByRole('button', { name: 'Step 20 milliseconds', exact: true }).click();
  await expect(prefix.getByRole('button', { name: /Prefix block \d+: MISS/ })).toHaveCount(32);
});

test('cancelled preempted requests show terminal status in History', async ({ page }) => {
  await page.getByLabel('Scenario').selectOption('preemption');
  await page.getByRole('button', { name: 'Resume simulation', exact: true }).click();
  await page.clock.runFor(400);
  await page.getByRole('button', { name: 'Pause simulation', exact: true }).click();
  await page.getByRole('button', { name: 'Step 20 milliseconds', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel R001', exact: true }).click();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const row = page.locator('.request-table tbody tr').filter({ has: page.getByRole('button', { name: 'R001', exact: true }) });
  await expect(row.locator('.phase-label')).toHaveText('cancelled');
});
