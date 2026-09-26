import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';

const target = process.env.ZKISS_LIVE_URL;
test.skip(!target, 'Run with the isolated integration API and database');
const photo = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#888888' } }).png().toBuffer();

async function onboard(page: Page, name: string) {
  await page.goto(`${target}/`);
  await page.getByRole('button', { name: /행사 프로필 만들기/ }).click();
  await page.getByRole('textbox', { name: '닉네임' }).fill(name);
  await page.getByRole('textbox', { name: '나이' }).fill('24');
  await page.getByRole('combobox', { name: '성별' }).selectOption('여성');
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByLabel('AI 인상 분석용 사진').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: photo });
  await page.getByRole('button', { name: 'AI 프로필 만들기' }).click();
  await expect(page.getByRole('heading', { name: '상대방에게 보일 내 프로필' })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: '이 프로필로 시작' }).click();
  await expect(page.getByRole('heading', { name: '지금 만날 사람들' })).toBeVisible({ timeout: 30000 });
}

test('main screen flow uses API for profile, received likes, mutual match and chat', async ({ browser }) => {
  test.setTimeout(90000);
  const contexts = [await browser.newContext(), await browser.newContext()];
  const admissionKeys: string[] = [];
  for (const context of contexts) {
    await context.route('**/chain-intents', async route => {
      admissionKeys.push(route.request().postDataJSON().devicePublicKey);
      await route.continue();
    });
  }
  const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
  const suffix = Date.now().toString().slice(-6), nameA = `A${suffix}`, nameB = `B${suffix}`;
  try {
    await onboard(a, nameA); await onboard(b, nameB);
    expect(admissionKeys).toHaveLength(2);
    expect(admissionKeys[0]).not.toBe(admissionKeys[1]);
    await a.reload();
    await expect(a.getByRole('heading', { name: new RegExp(nameB) })).toBeVisible();
    await a.locator('.feed-profile').filter({ hasText: nameB }).getByRole('button', { name: /호감 보내기/ }).click();
    await a.getByRole('link', { name: '대화' }).click();
    await expect(a.getByText(/서로 호감을 보내면/)).toBeVisible();
    await b.getByRole('link', { name: '호감' }).click();
    await expect(b.getByRole('heading', { name: new RegExp(nameA) })).toBeVisible({ timeout: 10000 });
    await b.getByRole('button', { name: new RegExp(`호감 보내기.*${nameA}`) }).click();
    await expect(b.getByRole('dialog', { name: '서로의 호감이 닿았어요!' })).toBeVisible();
    await expect(a.getByRole('dialog', { name: '서로의 호감이 닿았어요!' })).toBeVisible({ timeout: 10000 });
    await a.getByRole('button', { name: '나중에 할게요' }).click();
    await b.getByRole('button', { name: '대화 시작하기' }).click();
    await b.getByRole('textbox', { name: '메시지' }).fill('연결된 대화');
    await b.getByRole('button', { name: '메시지 보내기' }).click({ timeout: 5000 });
    await expect(b.getByRole('log')).toContainText('연결된 대화');
    await b.reload();
    await expect(b.getByRole('log')).toContainText('연결된 대화');
    await a.getByRole('link', { name: new RegExp(nameB) }).click();
    await expect(a.getByRole('log')).toContainText('연결된 대화', { timeout: 10000 });
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
