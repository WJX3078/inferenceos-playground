import { expect, test } from '@playwright/test';

test('manual controls, scheduling, hardware and run export work without browser errors', async ({ page }) => {
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
  await page.getByLabel('Tensor parallel').selectOption('2');
  await page.getByRole('button', { name: 'Apply & restart' }).click();
  await expect(page.locator('[data-worker]')).toHaveCount(4);
  await page.getByRole('button', { name: 'Continuous batching', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continuous batching', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export run' }).click();
  expect((await download).suggestedFilename()).toBe('inferenceos-run.json');
  expect(errors).toEqual([]);
});

for (const scenario of ['static-batching', 'continuous-batching', 'prefix-heavy', 'kv-pressure', 'long-context',
  'tensor-parallel', 'speculative-high-acceptance', 'chunked-prefill', 'long-prefill-interference',
  'kv-thrashing', 'priority-inversion', 'slo-overload', 'burst-overload']) {
  test(`scenario ${scenario} runs and renders a live execution trace`, async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Scenario', { exact: true }).selectOption(scenario);
    // Cold vite transforms on CI can delay the first ticks; auto-retry generously.
    await expect(page.getByTestId('sim-time')).not.toHaveText('0.00 s', { timeout: 30000 });
    await expect(page.locator('[data-worker]').first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('timeline').locator('.timeline-span').first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('scenario-banner')).toContainText(/\w/);
  });
}

test('disaggregated topology shows P/D pools and KV transfer activity', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Scenario', { exact: true }).selectOption('disaggregated-balanced');
  await expect(page.locator('.replica-title', { hasText: 'PREFILL POOL' })).toHaveCount(4, { timeout: 30000 });
  await expect(page.locator('.replica-title', { hasText: 'DECODE POOL' })).toHaveCount(4, { timeout: 30000 });
  await expect(page.getByTestId('timeline').locator('.timeline-span.transfer_wait, .timeline-span.transferring, .timeline-span.decode_wait').first())
    .toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  await expect(page.locator('.submetrics')).toContainText('transfers');
});

test('scheduler policy, chunked prefill and preemption switches work live', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  await page.getByLabel('Scheduler policy').selectOption('priority');
  await expect(page.locator('.runtime-heading')).toContainText('PRIORITY');
  await page.getByLabel('Scheduler policy').selectOption('slo');
  await expect(page.locator('.runtime-heading')).toContainText('SLO');
  await page.getByLabel('Preemption', { exact: true }).selectOption('cost-aware');
  await page.getByLabel('Prefill chunk', { exact: true }).selectOption('64');
  await page.getByRole('button', { name: 'Resume simulation' }).click();
  await expect(page.getByTestId('sim-time')).not.toHaveText('0.00 s', { timeout: 15000 });
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  await expect(page.getByTestId('budget-bar')).toBeVisible();
});

test('SLO configuration drives goodput display and compare captures runs', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('TTFT SLO').fill('100');
  await expect(page.locator('.metrics-strip')).toContainText('GOODPUT');
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await page.getByRole('button', { name: 'Capture current run' }).click();
  await expect(page.getByTestId('compare').locator('tbody tr')).toHaveCount(20);
  await expect(page.getByTestId('compare')).toContainText('Run A');
});

test('scenario JSON can be exported and imported', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export scenario' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('inferenceos-scenario.json');
  const path = await file.path();
  await page.getByLabel('Import scenario').setInputFiles(path!);
  await expect(page.getByTestId('arrival-notice')).toContainText('Imported');
  await expect(page.locator('[data-worker]').first()).toBeVisible();
});

test('KV watermark pressure surfaces the watermark wait reason', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  await page.getByLabel('KV blocks / replica').fill('48');
  await page.getByLabel('KV watermark').fill('0.25');
  await page.getByRole('button', { name: 'Apply & restart' }).click();
  await page.getByRole('button', { name: 'Generate burst' }).click();
  // Assert while the simulation is running (a paused clock freezes reasons).
  await page.getByRole('button', { name: 'Resume simulation' }).click();
  await expect(page.locator('.request-table .phase-label[title*="watermark"]').first()).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Pause simulation' }).click();
});

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
