import { test, expect } from '@playwright/test';

test('inspect desktop, topology, cache, cancellation, trace and canvas pixels', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.stack ?? e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.getByLabel('Simulation speed').selectOption('4');
  // Wait for real simulation activity instead of a fixed timeout (cold CI machines).
  await expect(page.locator('.kv-block.decode, .kv-block.prefill, .kv-block.shared').first())
    .toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  await page.screenshot({ path: 'artifacts/desktop.png', fullPage: true });
  const canvasPixels = await page.locator('.chart-canvas').evaluate((el: HTMLCanvasElement) => {
    const data = el.getContext('2d')!.getImageData(0, 0, el.width, el.height).data;
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
    return painted;
  });
  expect(canvasPixels).toBeGreaterThan(100);
  const liveBlock = page.locator('.kv-block.decode, .kv-block.prefill, .kv-block.shared').first();
  await liveBlock.click();
  await expect(page.locator('.block-detail')).toBeVisible();
  await expect(page.locator('.page-entry').first()).toBeVisible();
  await page.getByRole('button', { name: /^Cancel R/ }).first().click();
  await expect(page.locator('.pipeline')).toContainText('1 cancelled');
  await page.getByRole('button', { name: 'Trace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Execution trace', exact: true })).toBeVisible();
  await page.getByLabel('Event filter').selectOption('admit');
  await expect(page.locator('.log-line').first()).toContainText('ADMIT');
  await page.getByLabel('Event filter').selectOption('chunk');
  await page.getByRole('button', { name: 'Runtime', exact: true }).click();
  await page.getByLabel('Scenario', { exact: true }).selectOption('tensor-parallel');
  await page.getByRole('button', { name: 'Resume simulation' }).click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  await expect(page.locator('.tp-ring')).toBeVisible();
  await expect(page.locator('[data-worker]')).toHaveCount(4);
  await page.screenshot({ path: 'artifacts/tensor-parallel.png', fullPage: true });
  // Back to 1x: at 4x a fixed wall-clock wait races the request lifecycle
  // (R001 may already be completed and absent from the live queue).
  await page.getByLabel('Simulation speed').selectOption('1');
  await page.getByLabel('Scenario', { exact: true }).selectOption('speculative-high-acceptance');
  await page.getByRole('button', { name: 'Resume simulation' }).click();
  // The History filter lists every request regardless of lifecycle state.
  await page.locator('.queue-section .segmented button', { hasText: 'History' }).click();
  await page.locator('.request-table').getByRole('button', { name: 'R001', exact: true }).click();
  await expect(page.locator('.spec-tokens')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  await page.screenshot({ path: 'artifacts/speculative.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('viewport matrix has no page-level overflow or clipped buttons', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  for (const width of [360, 390, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const problems = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      clipped: [...document.querySelectorAll('button')].filter(b => b.clientWidth > 0 && b.scrollWidth > b.clientWidth + 2).map(b => b.getAttribute('aria-label') || b.textContent),
    }));
    expect(problems, `viewport ${width}`).toEqual({ overflow: false, clipped: [] });
    if (width === 390) await page.screenshot({ path: 'artifacts/mobile-viewport.png' });
    if (width === 1440) await page.screenshot({ path: 'artifacts/desktop-viewport.png' });
  }
});

test('request selection follows its pool and hardware controls reach the engine', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  await page.locator('.request-table').getByRole('button', { name: 'R002', exact: true }).click();
  await expect(page.getByLabel('Cache replica')).toHaveValue('1');
  await page.getByRole('button', { name: 'Stream traffic', exact: true }).click();
  await page.getByRole('button', { name: 'Prefix caching', exact: true }).click();
  await page.getByRole('button', { name: 'Speculative decoding', exact: true }).click();
  await page.getByLabel('KV block size').selectOption('8');
  await page.getByLabel('KV blocks / replica').fill('16');
  await page.getByLabel('Max batch size').fill('2');
  await page.getByRole('button', { name: 'Apply & restart' }).click();
  await expect(page.locator('.kv-block')).toHaveCount(16);
  await page.getByLabel('Prompt length').fill('512');
  await page.getByLabel('Output length').fill('64');
  await page.getByRole('button', { name: 'Add request', exact: true }).click();
  await expect(page.getByTestId('arrival-notice')).toContainText('rejected');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export run' }).click();
  const stream = await (await downloaded).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk);
  const trace = JSON.parse(Buffer.concat(chunks).toString());
  expect(trace.config).toMatchObject({ blockSize: 8, numBlocks: 16, maxBatchSize: 2, prefixCaching: false, speculativeDecoding: true });
  expect(trace.metrics.rejected).toBeGreaterThan(0);
});

test('disaggregated pool layout responds to the P/D allocation controls', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  await page.getByLabel('GPU count').selectOption('8');
  await page.getByLabel('Serving topology').selectOption('disaggregated');
  await page.getByRole('button', { name: 'Apply & restart' }).click();
  await expect(page.locator('.replica-title').first()).toContainText('PREFILL POOL');
  await page.getByLabel('Prefill GPUs').selectOption('6');
  await expect(page.locator('.capacity', { hasText: 'Decode GPUs' })).toContainText('2');
  await page.getByLabel('Prefill TP').selectOption('2');
  await page.getByRole('button', { name: 'Apply & restart' }).click();
  await expect(page.locator('[data-worker]')).toHaveCount(8);
  await expect(page.locator('.replica-title', { hasText: 'PREFILL POOL' })).toHaveCount(3);
  await expect(page.locator('.replica-title', { hasText: 'DECODE POOL' })).toHaveCount(2);
});
