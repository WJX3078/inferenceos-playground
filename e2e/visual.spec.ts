import { expect, test } from '@playwright/test';

test('deterministic visual pass: compare, beginner and expert at desktop, tablet and mobile', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.clock.install({ time: new Date('2026-09-17T00:00:00Z') });
  await page.goto('/');
  await page.clock.pauseAt(new Date('2026-09-17T01:00:00Z'));
  await page.getByRole('button', { name: 'Pause simulation', exact: true }).click();
  const pass = process.env.VISUAL_PASS ?? 'final';
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await page.getByRole('button', { name: 'Run comparison', exact: true }).click();
  await page.clock.runFor(24000);
  await expect(page.getByTestId('comparison-status')).toContainText('COMPLETE');
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({ path: `artifacts/visual-${pass}-compare-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `compare width ${width}`).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Runtime', exact: true }).click();
  await page.getByLabel('Scenario', { exact: true }).selectOption('chunked');
  await page.getByRole('button', { name: 'Resume simulation', exact: true }).click();
  await page.clock.runFor(240);
  await page.getByRole('button', { name: 'Pause simulation', exact: true }).click();
  await page.screenshot({ path: `artifacts/visual-${pass}-expert.png`, fullPage: true });
  await page.getByRole('button', { name: 'Beginner', exact: true }).click();
  await page.screenshot({ path: `artifacts/visual-${pass}-beginner.png`, fullPage: true });
  expect(errors).toEqual([]);
});
