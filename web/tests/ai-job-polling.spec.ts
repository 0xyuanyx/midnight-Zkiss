import { test, expect } from '@playwright/test';

test('one AI job keeps polling past the former two-minute limit until it succeeds', async ({ page }) => {
  await page.goto('/');
  const calls = await page.evaluate(async () => {
    const { waitForAiJob } = await import(/* @vite-ignore */ '/src/state/' + 'liveSession.tsx');
    let polls = 0;
    await waitForAiJob(async () => ({ status: ++polls > 120 ? 'succeeded' : 'processing' }), async () => {});
    return polls;
  });
  expect(calls).toBe(121);
});

test('one AI job only surfaces an error after the server marks it failed', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { waitForAiJob } = await import(/* @vite-ignore */ '/src/state/' + 'liveSession.tsx');
    let polls = 0;
    try {
      await waitForAiJob(async () => ({ status: ++polls === 3 ? 'failed' : 'processing' }), async () => {});
      return 'unexpected';
    } catch (error) {
      return `${(error as Error).message}:${polls}`;
    }
  });
  expect(result).toBe('AI_ANALYSIS_FAILED:3');
});
