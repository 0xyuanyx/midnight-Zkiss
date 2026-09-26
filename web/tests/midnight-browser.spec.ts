import { test, expect } from '@playwright/test';
const url = process.env.ZKISS_BROWSER_PROBE_URL;
test.skip(!url, 'Opt-in loopback synthetic Midnight diagnostic');
test('non-extractable X25519 key survives IndexedDB and reload', async ({ page }) => {
  await page.goto(url!);
  await page.getByRole('button', {name:'기기 키 저장 검증'}).click();
  await expect(page.locator('#key-status')).toContainText('"status":"passed"');
  await page.reload();
  await page.getByRole('button', {name:'기기 키 저장 검증'}).click();
  await expect(page.locator('#key-status')).toContainText('"restored":true');
  await expect(page.locator('#key-status')).toContainText('"extractable":false');
});
test('new ZKiss admission circuit proves in a browser worker without upload', async ({ page }) => {
  test.setTimeout(300_000);
  const uploads: string[] = [];
  page.on('request', req => { if (req.method() !== 'GET') uploads.push(req.url()); });
  await page.goto(url!);
  await page.getByRole('button', {name:'합성 참가 증명 검증'}).click();
  await expect(page.locator('#status')).not.toHaveText('ready', {timeout:5000});
  await expect(page.locator('#status')).toContainText(/"status":"(proved|failed)"/, {timeout:280_000});
  const result = JSON.parse((await page.locator('#status').textContent())!);
  expect(result, JSON.stringify(result)).toMatchObject({status:'proved'});
  expect(result.bytes).toBeGreaterThan(0);
  expect(uploads).toEqual([]);
  console.log(`BROWSER_PROOF ${test.info().project.name} ${result.ms}ms ${result.bytes} bytes`);
});
