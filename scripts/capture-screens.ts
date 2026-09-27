// Capture documentation screenshots from the running dev server.
//
//   npm run dev -- --port 5178 &   (or let the script reuse a running server)
//   node scripts/capture-screens.ts
//
// Produces: docs/images/inferenceos-lab-hero.png (runtime),
//           docs/images/inferenceos-lab-compare.png (compare tab),
//           docs/images/inferenceos-lab-disaggregated.png (P/D pools).

import { chromium, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = 'http://127.0.0.1:5178';
const out = (name: string) => resolve(root, 'docs/images', name);

// Reuse a pre-installed Chromium when the pinned build is unavailable offline.
const localChromium = process.env.LOCALAPPDATA
  && join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1148', 'chrome-win', 'chrome.exe');
const executablePath = localChromium && existsSync(localChromium) ? localChromium : undefined;
const browser = await chromium.launch({ executablePath });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(base);
  await page.getByLabel('Scenario', { exact: true }).selectOption('long-prefill-interference');
  await expect(page.getByTestId('sim-time')).not.toHaveText('0.00 s', { timeout: 30000 });
  await page.waitForTimeout(9000); // let prefill + decode interleave visibly
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  await page.waitForTimeout(300);
  mkdirSync(dirname(out('hero.png')), { recursive: true });
  await page.screenshot({ path: out('inferenceos-lab-hero.png'), fullPage: false });

  // Compare view with two captured runs (A: current, B: chunked prefill on).
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await page.getByRole('button', { name: 'Capture current run' }).click();
  await page.getByRole('button', { name: 'Runtime', exact: true }).click();
  await page.getByLabel('Prefill chunk', { exact: true }).selectOption('64');
  await page.getByRole('button', { name: 'Resume simulation' }).click();
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await page.getByRole('button', { name: 'Capture current run' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: out('inferenceos-lab-compare.png'), fullPage: false });

  // Disaggregated pools.
  await page.goto(base);
  await page.getByLabel('Scenario', { exact: true }).selectOption('disaggregated-balanced');
  await expect(page.getByTestId('sim-time')).not.toHaveText('0.00 s', { timeout: 30000 });
  await page.waitForTimeout(8000);
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: out('inferenceos-lab-disaggregated.png'), fullPage: false });
  console.log('screenshots written to docs/images/');
} finally {
  await browser.close();
}
