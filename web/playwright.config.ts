import { defineConfig } from '@playwright/test';
const protocol = process.env.WEB_TEST_HTTPS === '1' ? 'https' : 'http';
const port = Number(process.env.WEB_TEST_PORT ?? 5173);
const remoteBaseURL = process.env.WEB_TEST_BASE_URL;
export default defineConfig({
  testDir: './tests', fullyParallel: true, workers: process.env.ZKISS_LIVE_E2E === '1' ? 1 : 2, timeout: 30_000,
  reporter: [['list']],
  use: { ignoreHTTPSErrors: !remoteBaseURL && protocol === 'https', baseURL: remoteBaseURL ?? `${protocol}://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'mobile-chromium', use: { browserName: 'chromium', viewport: { width: 402, height: 746 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } },
    { name: 'mobile-webkit', use: { browserName: 'webkit', viewport: { width: 390, height: 746 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } },
  ],
  webServer: remoteBaseURL ? undefined : { command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`, url: `${protocol}://127.0.0.1:${port}`, ignoreHTTPSErrors: protocol === 'https', reuseExistingServer: !process.env.CI },
});
