import { test, expect } from '@playwright/test';

test('상호 호감 팝업에서 해당 상대의 대화를 시작한다', async ({ page }) => {
  await page.goto('/likes');
  await page.getByRole('button', { name: '♡ 호감 보내기 · 모카' }).click();
  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('서로의 호감이 닿았어요!');
  await expect(modal).toContainText('모카님도');
  await expect(modal.getByRole('button', { name: '대화 시작하기' })).toBeFocused();
  await modal.getByRole('button', { name: '대화 시작하기' }).click();
  await expect(page).toHaveURL('/chats/mocha');
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '모카', exact: true })).toBeVisible();
});

test('나중에 닫아도 매칭은 유지되고 팝업은 다시 뜨지 않는다', async ({ page }) => {
  await page.goto('/home');
  await page.getByRole('button', { name: '♡ 호감 보내기 · 라임' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '♡ 호감 보내기 · 모카' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '나중에 할게요' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('link', { name: '대화', exact: true }).click();
  await expect(page.locator('.conversation-row')).toHaveCount(1);
  await expect(page.locator('.conversation-row')).toContainText('모카');
  await page.getByRole('link', { name: '피드', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('성사 화면은 작은 화면에서 표시되고 Escape로 닫힌다', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 });
  await page.goto('/preview/mutual-match');
  const modal = page.getByRole('dialog');
  await expect(modal).toContainText('라임님도 유진님에게');
  await expect(modal.getByRole('button', { name: '나중에 할게요' })).toBeInViewport();
  await page.keyboard.press('Tab');
  await expect(modal.getByRole('button', { name: '나중에 할게요' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole('link', { name: '대화 시작하기 · 라임' })).toBeVisible();
});
