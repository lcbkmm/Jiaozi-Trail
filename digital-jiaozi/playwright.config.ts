import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', fullyParallel: false, workers: 1, timeout: 45_000,
  expect: { timeout: 8_000 }, reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173', channel: process.env.DJ_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
    viewport: { width: 375, height: 812 }, deviceScaleFactor: 1, hasTouch: true,
    screenshot: 'only-on-failure', trace: 'retain-on-failure'
  },
  webServer: { command: 'node tests/browser/server.mjs', url: 'http://127.0.0.1:4173/preview/', reuseExistingServer: false, timeout: 15_000 }
});
