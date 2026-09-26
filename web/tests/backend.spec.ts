import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';

test('두 사용자가 실제 API로 프로필·호감·대화·SNS 상호 공개를 완료한다', async ({ browser }, testInfo) => {
  test.skip(process.env.ZKISS_LIVE_E2E !== '1', 'Local demo API, database and worker required');
  const actualChain = process.env.ZKISS_REAL_SNS === '1';
  test.setTimeout(actualChain ? 900_000 : 150_000);
  const aContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL, ignoreHTTPSErrors: !process.env.WEB_TEST_BASE_URL });
  const bContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL, ignoreHTTPSErrors: !process.env.WEB_TEST_BASE_URL });
  const a = await aContext.newPage();
  const b = await bContext.newPage();
  const suffix = Date.now().toString().slice(-7);
  const nameA = `가${suffix}`, nameB = `나${suffix}`;
  const errors: string[] = [];
  const leaked: string[] = [];
  const admissionRequests: string[] = [];
  const relayBytes: Buffer[] = [];
  for (const page of [a, b]) {
    await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; } } }); });
    if (actualChain) {
      await page.addInitScript(() => {
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          constructor(url: string | URL, opts?: WorkerOptions) { super(url, opts); this.addEventListener('message', e => { if (e.data?.stage) console.info('SNS_PROOF_STAGE', e.data.stage); if (e.data?.error) console.error('SNS_PROOF_ERROR', e.data.error); }); this.addEventListener('error', e => console.error('SNS_WORKER_ERROR', e.message)); }
        };
      });
      page.on('console', message => { if (message.text().startsWith('SNS_')) console.log(message.text()); });
    }
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().endsWith('/relay') && request.postData()) relayBytes.push(Buffer.from(JSON.parse(request.postData()!).transaction, 'base64')); if (request.url().endsWith('/midnight/ticket') || (request.postData() ?? '').includes('"purpose":"admission"')) admissionRequests.push(request.url()); if ((request.postData() ?? '').includes('@secret-')) leaked.push(request.url()); });
  }
  async function onboard(page: Page, name: string, sns: string) {
    await page.goto('/');
    await page.getByRole('button', { name: '행사 프로필 만들기' }).click();
    await expect(page).toHaveURL('/profile', { timeout: 20000 });
    await page.getByLabel('닉네임', { exact: true }).fill(name);
    await page.getByLabel('나이', { exact: true }).fill('24');
    await page.getByLabel('성별', { exact: true }).selectOption('여성');
    await page.getByRole('button', { name: '다음', exact: true }).click();
    await page.getByLabel('MBTI', { exact: true }).fill('ENFP');
    await page.getByLabel('SNS ID', { exact: true }).fill(sns);
    await page.getByLabel('간단한 자기소개', { exact: true }).fill('음악 이야기를 좋아해요');
    await page.getByLabel('분석용 사진 선택').setInputFiles(resolve('public/assets/feed-lime.png'));
    await page.getByRole('button', { name: 'AI 프로필 만들기' }).click();
    await expect(page).toHaveURL('/profile/preview', { timeout: process.env.ZKISS_REAL_AI === '1' ? 180000 : 20000 });
    if (process.env.ZKISS_EXPECT_GENERATED_IMAGES === '1') {
      await expect(page.getByRole('img', { name: 'AI가 생성한 프로필 이미지', exact: true })).toHaveAttribute('src', /\/api\/v1\/events\/.+\/profile-images\//);
      await expect.poll(() => page.locator('.impression-avatar').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    }
    await page.getByRole('button', { name: '이 프로필로 시작' }).click();
    await expect(page).toHaveURL('/home');
  }
  try {
    await onboard(a, nameA, '@secret-a');
    await onboard(b, nameB, '@secret-b');
    await a.reload();
    await expect(a.getByLabel(`${nameB} 프로필`, { exact: true })).toBeVisible({ timeout: 15000 });
    await a.getByLabel(`${nameB} 프로필`, { exact: true }).getByRole('button', { name: /호감 보내기/ }).click();
    await expect(a.getByRole('dialog')).toHaveCount(0);
    await b.getByLabel(`${nameA} 프로필`, { exact: true }).getByRole('button', { name: /호감 보내기/ }).click();
    await expect(b.getByRole('dialog')).toBeVisible();
    await b.getByRole('dialog').getByRole('button', { name: '대화 시작하기' }).click();
    await expect(a.getByRole('dialog')).toBeVisible({ timeout: 15000 });
    await a.getByRole('dialog').getByRole('button', { name: '대화 시작하기' }).click();
    for (let i = 0; i < 4; i++) {
      const sender = i % 2 ? b : a;
      await sender.getByRole('textbox', { name: '메시지', exact: true }).fill(`안녕하세요 ${i}`);
      await sender.getByRole('button', { name: '메시지 보내기' }).click();
      await expect(sender.getByRole('textbox', { name: '메시지', exact: true })).toHaveValue('');
    }
    await expect(a.getByRole('log')).toContainText('안녕하세요 3', { timeout: 15000 });
    await a.getByRole('button', { name: 'SNS 공개 요청하기' }).click();
    await expect(a.getByRole('heading', { name: '서로 동의했어요' })).toHaveCount(0);
    await b.bringToFront();
    await expect(b.getByRole('button', { name: 'SNS 공개 동의하기' })).toBeEnabled({ timeout: actualChain ? 180000 : 25000 });
    await b.getByRole('button', { name: 'SNS 공개 동의하기' }).click();
    await expect.poll(async () => {
      for (const page of [a,b]) { const alert = page.getByRole('alert'); if (await alert.count()) throw new Error(await alert.innerText()); }
      return a.getByRole('heading', { name: '서로 동의했어요' }).isVisible();
    }, { timeout: actualChain ? 600000 : 30000, intervals: [1000,2500] }).toBe(true);
    await expect(b.getByRole('heading', { name: '서로 동의했어요' })).toBeVisible({ timeout: actualChain ? 600000 : 30000 });
    await a.getByRole('button', { name: `${nameB} SNS ID 복사` }).click();
    await expect(a.getByRole('status')).toContainText('@secret-b');
    expect(await a.evaluate(() => (window as unknown as { copied: string }).copied)).toBe('@secret-b');
    await b.getByRole('button', { name: `${nameA} SNS ID 복사` }).click();
    await expect(b.getByRole('status')).toContainText('@secret-a');
    expect(await b.evaluate(() => (window as unknown as { copied: string }).copied)).toBe('@secret-a');
    await b.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied'); }; document.execCommand = () => false; });
    await b.getByRole('button', { name: `${nameA} SNS ID 복사` }).click();
    await expect(b.getByRole('status')).toContainText('복사하지 못했어요');
    await a.reload();
    await expect(a.getByRole('heading', { name: '서로 동의했어요' })).toBeVisible();
    expect(errors).toEqual([]);
    expect(leaked).toEqual([]);
    expect(admissionRequests).toEqual([]);
    if (actualChain) {
      await a.screenshot({ path: testInfo.outputPath('sns-shared.png'), fullPage: true });
      expect(relayBytes.length).toBeGreaterThanOrEqual(2);
      const secrets = await Promise.all([a, b].map(page => page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('zkiss.sns-device.v1:')).map(k => sessionStorage.getItem(k)!))));
      for (const raw of relayBytes) {
        for (const contact of ['@secret-a', '@secret-b']) expect(raw.includes(Buffer.from(contact))).toBe(false);
        for (const secret of secrets.flat()) expect(raw.includes(Buffer.from(secret, 'base64'))).toBe(false);
      }
    }
  } finally { await aContext.close(); await bContext.close(); }
});
