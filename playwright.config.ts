import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  // Keep clock-driven screenshots and live runtime journeys independent of host load.
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5178', headless: true, viewport: { width: 1440, height: 1000 } },
  webServer: { command: 'npm run dev -- --port 5178 --strictPort', url: 'http://127.0.0.1:5178', reuseExistingServer: true },
  reporter: 'list',
});
