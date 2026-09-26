import { test, expect } from '@playwright/test';

test('피드의 인상 카드, 필터, 일방 호감과 전송 알림', async ({ page }) => {
  await page.goto('/preview/home');
  await expect(page.getByRole('button', { name: /DM/ })).toHaveCount(0);
  await expect(page.locator('.feed-profile')).toHaveCount(2);
  await expect(page.getByLabel('AI 인상 분석', { exact: true })).toHaveCount(2);
  await page.getByRole('tab', { name: '나에게 호감 보낸' }).click();
  await expect(page.getByRole('region', { name: '모카 프로필' })).toBeVisible();
  await expect(page.getByRole('region', { name: '라임 프로필' })).toHaveCount(0);
  await page.getByRole('tab', { name: '나와 비슷한' }).click();
  await expect(page.locator('.feed-profile')).toHaveCount(1);
  await page.getByRole('tab', { name: '전체', exact: true }).click();
  await page.getByRole('button', { name: '♡ 호감 보내기 · 라임' }).click();
  await expect(page.getByRole('status')).toHaveText('호감을 보냈어요!');
  await expect(page.getByRole('button', { name: '♥ 호감 보냄 · 라임' })).toBeDisabled();
  await expect(page.getByRole('link', { name: /대화 시작하기/ })).toHaveCount(0);
  await page.getByRole('link', { name: '호감', exact: true }).click();
  await page.getByRole('tab', { name: '보낸 호감 1' }).click();
  await expect(page.getByRole('article', { name: '라임 보낸 호감' })).toContainText('상대 응답 대기 중');
  await page.getByRole('link', { name: '피드에서 다시 보기' }).click();
  await expect(page).toHaveURL('/home?person=lime');
  await expect(page.getByRole('button', { name: '♥ 호감 보냄 · 라임' })).toBeDisabled();
  await page.getByRole('link', { name: '대화', exact: true }).click();
  await expect(page.getByRole('heading', { name: '첫 대화를 기다리고 있어요' })).toBeVisible();
});

test('받은 호감에 답해야 해당 상대의 대화만 열린다', async ({ page }) => {
  await page.goto('/preview/likes');
  await expect(page.getByRole('tab', { name: '받은 호감 1' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '♡ 호감 보내기 · 모카' }).click();
  await expect(page.getByRole('dialog')).toContainText('서로의 호감이 닿았어요!');
  await page.getByRole('dialog').getByRole('button', { name: '대화 시작하기' }).click();
  await expect(page).toHaveURL('/chats/mocha');
  await expect(page.getByRole('heading', { name: '모카', exact: true })).toBeVisible();
  for (const message of ['반가워요 모카님', '오늘 행사 어떠세요?', '저는 전시가 좋았어요.', '더 이야기하고 싶어요.']) {
    await page.getByRole('textbox', { name: '메시지', exact: true }).fill(message);
    await page.getByRole('button', { name: '메시지 보내기' }).click();
  }
  await expect(page.getByRole('log')).toContainText('반가워요 모카님');
  await page.getByRole('button', { name: 'SNS 공개 요청하기' }).click();
  await expect(page.getByRole('heading', { name: '상대방의 동의를 기다리고 있어요' })).toBeVisible();
  await page.evaluate(() => { history.pushState({}, '', '/chats/lime'); dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page).toHaveURL('/chats');
  await expect(page.locator('.conversation-row')).toHaveCount(1);
  await expect(page.locator('.conversation-row')).toContainText('모카');
  await page.getByRole('link', { name: /모카/ }).click();
  await expect(page.getByRole('log')).toContainText('반가워요 모카님');
  await page.evaluate(() => { history.pushState({}, '', '/chats/mocha/shared'); dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page).toHaveURL('/chats/mocha');
  await expect(page.getByText('서로 동의했어요')).toHaveCount(0);
});

test('여러 매칭의 메시지와 SNS 동의는 서로 섞이지 않는다', async ({ page }) => {
  await page.goto('/preview/shared');
  await page.getByRole('link', { name: '호감', exact: true }).click();
  await page.getByRole('button', { name: '♡ 호감 보내기 · 모카' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '대화 시작하기' }).click();
  await expect(page.getByRole('log')).toBeEmpty();
  await expect(page.getByRole('button', { name: 'SNS 공개 요청하기' })).toHaveCount(0);
  for (const message of ['안녕하세요!', '행사 즐기고 계신가요?', '반가워요.', '이야기 나눠요.']) {
    await page.getByRole('textbox', { name: '메시지', exact: true }).fill(message);
    await page.getByRole('button', { name: '메시지 보내기' }).click();
  }
  await expect(page.getByRole('button', { name: 'SNS 공개 요청하기' })).toBeVisible();
  await expect(page.getByText('서로 동의했어요')).toHaveCount(0);
  await page.getByRole('link', { name: '대화 목록으로' }).click();
  await expect(page.locator('.conversation-row')).toHaveCount(2);
  await page.getByRole('link', { name: /라임/ }).click();
  await expect(page).toHaveURL('/chats/lime/shared');
  await expect(page.getByText('서로 동의했어요')).toBeVisible();
});

test('호감 탭은 키보드로 전환하고 빈 상태에서도 피드로 이동할 수 있다', async ({ page }) => {
  await page.goto('/preview/likes-empty');
  await page.getByRole('tab', { name: '받은 호감 0' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '보낸 호감 0' })).toBeFocused();
  await expect(page.getByRole('heading', { name: '아직 보낸 호감이 없어요' })).toBeVisible();
  await page.getByRole('link', { name: '피드 둘러보기' }).click();
  await expect(page).toHaveURL('/home');
});

test('피드·받은 호감·보낸 호감은 320px에서도 잘리지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 746 });
  for (const scene of ['home', 'home-sent', 'likes', 'likes-sent']) {
    await page.goto(`/preview/${scene}`);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const card of await page.locator('.feed-impression').all()) {
      const geometry = await card.evaluate(el => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) }));
      // Layout engines round fractional line boxes to device-independent subpixels.
      expect(Math.abs(geometry.height - geometry.line * 4)).toBeLessThan(1);
    }
  }
});
