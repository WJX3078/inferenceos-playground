import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Reuse a pre-installed Chromium when the pinned browser build is unavailable
// offline; CI installs the pinned build and leaves this override unused.
const localChromium = process.env.LOCALAPPDATA
  && join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1148', 'chrome-win', 'chrome.exe');
const executablePath = localChromium && existsSync(localChromium) ? localChromium : undefined;

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://127.0.0.1:5178', headless: true, viewport: { width: 1440, height: 1000 }, launchOptions: { executablePath } },
  webServer: { command: 'npm run dev -- --port 5178 --strictPort', url: 'http://127.0.0.1:5178', reuseExistingServer: true },
  reporter: 'list',
});

