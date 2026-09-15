import { expect, test } from '@playwright/test';

test('manual controls, scheduling, hardware and trace export work without browser errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'InferenceOS' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  const clock = await page.getByTestId('sim-time').textContent();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('sim-time')).toHaveText(clock!);
  await page.getByRole('button', { name: 'Step 20 milliseconds' }).click();
  await expect(page.getByTestId('sim-time')).not.toHaveText(clock!);
  await page.getByLabel('Prompt length').fill('128');
  await page.getByLabel('Output length').fill('32');
  await page.getByRole('button', { name: 'Add request', exact: true }).click();
  await expect(page.getByTestId('arrival-notice')).toContainText('queued');
  await page.getByRole('button', { name: 'Generate burst' }).click();
  await expect(page.getByTestId('arrival-notice')).toContainText('requests');
  await page.getByLabel('GPU count').selectOption('4');
  await page.getByLabel('Tensor parallel degree').selectOption('2');
  await page.getByRole('button', { name: 'Apply & restart' }).click();
  await expect(page.locator('[data-worker]')).toHaveCount(4);
  await page.getByRole('button', { name: 'Continuous batching', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continuous batching', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export trace' }).click();
  expect((await download).suggestedFilename()).toBe('inferenceos-trace.json');
  expect(errors).toEqual([]);
});

for (const scenario of ['static', 'continuous', 'prefix', 'pressure', 'long', 'tensor', 'speculative']) {
  test(`scenario ${scenario} runs and renders a live execution trace`, async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Scenario').selectOption(scenario);
    await page.waitForTimeout(700);
    await expect(page.getByTestId('sim-time')).not.toHaveText('0.00 s');
    await expect(page.locator('[data-worker]')).not.toHaveCount(0);
    await expect(page.getByTestId('timeline').locator('.timeline-span').first()).toBeVisible();
    await expect(page.locator('.scheduler-log')).toContainText('Replica');
  });
}

test('mobile layout stays within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Toggle control plane' }).click();
  await expect(page.getByLabel('Prompt length')).toBeVisible();
  await page.getByLabel('Prompt length').fill('96');
  await page.getByRole('button', { name: 'Add request', exact: true }).click();
  await expect(page.getByTestId('arrival-notice')).toContainText('queued');
  await page.getByRole('button', { name: 'Toggle control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Runtime overview' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
});
