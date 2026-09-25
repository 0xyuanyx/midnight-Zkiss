import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure' },
  projects: [
    { name: 'mobile-chromium', use: { browserName: 'chromium', viewport: { width: 402, height: 746 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } },
    { name: 'mobile-webkit', use: { browserName: 'webkit', viewport: { width: 390, height: 746 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } },
  ],
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5173', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI },
});
