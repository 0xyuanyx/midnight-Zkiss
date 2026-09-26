import { test, expect, type Locator } from '@playwright/test';

async function reachable(control: Locator) {
  await control.evaluate(element => element.scrollIntoView({ block: 'center' }));
  await expect(control).toBeInViewport({ ratio: 1 });
  // A visible bounding box alone does not detect clipping or a fixed nav covering it.
  expect(await control.evaluate(element => {
    const r = element.getBoundingClientRect();
    return [0.2, 0.8].every(y => element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height * y)));
  }), await control.innerText()).toBe(true);
}

for (const viewport of [{ width: 390, height: 600 }, { width: 320, height: 480 }, { width: 667, height: 320 }]) {
  test(`작은 화면에서 프로필 사진 선택 후 이전·생성 버튼 접근 ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/preview/profile-preview');
    await page.getByRole('link', { name: '수정', exact: true }).click();
    await page.getByLabel('간단한 자기소개', { exact: true }).fill('새로운 사람과 이야기해요.');
    await page.getByRole('button', { name: '사진이 준비되었어요!' }).click();
    expect(await page.locator('.profile-page').evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
    await reachable(page.getByRole('button', { name: '이전', exact: true }));
    const create = page.getByRole('button', { name: 'AI 프로필 만들기' });
    await reachable(create);
    await page.screenshot({ path: testInfo.outputPath('profile-actions.png') });
    await create.click();
    await expect(page).toHaveURL('/profile/preview');
  });

  test(`전체 화면의 하단 액션과 탐색 접근 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const scene of ['entry', 'profile', 'analysis', 'profile-preview', 'home', 'home-sent', 'likes', 'likes-sent', 'likes-empty', 'chats', 'matched', 'room', 'shared', 'mutual-match']) {
      await page.goto(`/preview/${scene}`);
      await expect(page.locator('.screen')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), scene).toBe(true);
      const dialog = page.getByRole('dialog');
      const scope = await dialog.count() ? dialog : page.locator('.screen');
      const actions = scope.locator('button:visible:not(:disabled), a:visible');
      for (const action of await actions.all()) await reachable(action);
    }
    await page.goto('/preview/home');
    await page.getByRole('link', { name: '내 정보', exact: true }).click();
    await reachable(page.getByRole('link', { name: '수정하기', exact: true }));
  });
}
