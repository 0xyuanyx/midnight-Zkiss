import { test, expect } from '@playwright/test';

const scenes = ['entry', 'profile', 'profile-ready', 'analysis', 'profile-preview', 'home', 'home-sent', 'likes', 'likes-sent', 'likes-empty', 'chats', 'matched', 'room', 'shared'];

for (const scene of scenes) {
  test(`화면 렌더링과 에셋: ${scene}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`/preview/${scene}`);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('.screen')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('img').evaluateAll(images => images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 && getComputedStyle(image).width === `${image.width}px`))).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${scene}.png`), fullPage: true });
  });
}

test('입력 검증부터 프로필 생성, 피드, 하단 탭까지 연결된다', async ({ page, baseURL }) => {
  const unexpectedRequests: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' || new URL(request.url()).origin !== new URL(baseURL!).origin) unexpectedRequests.push(request.url());
  });
  await page.goto('/preview/entry');
  await page.getByRole('button', { name: '행사 프로필 만들기' }).click();
  const next = page.getByRole('button', { name: '다음' });
  await expect(page.getByText('1/2', { exact: true })).toBeVisible();
  await expect(next).toBeDisabled();
  await page.getByLabel('닉네임', { exact: true }).fill('소다');
  await page.getByLabel('나이', { exact: true }).fill('17');
  await expect(page.getByText('18~100 사이의 나이를 입력해 주세요.')).toBeVisible();
  await page.getByLabel('나이', { exact: true }).fill('24');
  await page.getByLabel('성별', { exact: true }).selectOption('여성');
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page.getByText('2/2', { exact: true })).toBeVisible();
  const submit = page.getByRole('button', { name: 'AI 프로필 만들기' });
  await expect(submit).toBeDisabled();
  await page.getByLabel('MBTI', { exact: true }).fill('enfp');
  await page.getByLabel('SNS ID', { exact: true }).fill('@soda');
  await page.getByLabel('간단한 자기소개', { exact: true }).fill('전시와 음악을 좋아해요.');
  await expect(page.getByRole('note')).toContainText('상대방은 물론 관리자도 확인할 수 없어요.');
  await page.getByRole('button', { name: '사진 한 장 추가하기' }).click();
  await expect(page.getByText('사진이 준비되었어요!')).toBeVisible();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole('heading', { name: '첫인상을 만들고 있어요' })).toBeVisible();
  await expect(page).toHaveURL('/profile/preview');
  await expect(page.getByText('소다 · 24 · 여성')).toBeVisible();
  await expect(page.getByText('# ENFP')).toBeVisible();
  await expect(page.getByText('전시와 음악을 좋아해요.')).toBeVisible();
  await expect(page.getByRole('img', { name: 'AI가 생성한 프로필 이미지 예시' })).toBeVisible();
  await page.getByRole('button', { name: '이 프로필로 시작' }).click();
  await expect(page).toHaveURL('/home');
  await expect(page.getByRole('heading', { name: '지금 만날 사람들' })).toBeVisible();
  await page.getByRole('link', { name: '호감', exact: true }).click();
  await page.getByRole('tab', { name: /보낸 호감/ }).click();
  await expect(page.getByRole('heading', { name: '아직 보낸 호감이 없어요' })).toBeVisible();
  await page.getByRole('link', { name: '대화', exact: true }).click();
  await expect(page.getByRole('heading', { name: '첫 대화를 기다리고 있어요' })).toBeVisible();
  await page.getByRole('link', { name: '내 정보', exact: true }).click();
  await expect(page).toHaveURL('/me');
  await expect(page.getByRole('heading', { name: '내 프로필', exact: true })).toBeVisible();
  await expect(page.getByRole('main', { name: '내 정보 화면' })).not.toContainText('AI가 소개하는 매력');
  expect(unexpectedRequests).toEqual([]);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test('데모 사진 영역을 클릭하면 즉시 준비 상태가 된다', async ({ page }) => {
  await page.goto('/preview/profile');
  await page.getByLabel('닉네임', { exact: true }).fill('소다');
  await page.getByLabel('나이', { exact: true }).fill('24');
  await page.getByLabel('성별', { exact: true }).selectOption('여성');
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: '사진 한 장 추가하기' }).click();
  await expect(page.getByRole('button', { name: '사진이 준비되었어요!' })).toBeVisible();
});

test('성별은 여성 또는 남성만 선택할 수 있다', async ({ page }) => {
  await page.goto('/preview/profile');
  const options = await page.getByLabel('성별', { exact: true }).locator('option').allTextContents();
  expect(options).toEqual(['선택해 주세요', '여성', '남성']);
});

test('프로필에 MBTI, 비공개 SNS ID, 20자 자기소개를 입력할 수 있다', async ({ page }) => {
  await page.goto('/preview/profile');
  await page.getByLabel('닉네임', { exact: true }).fill('소다');
  await page.getByLabel('나이', { exact: true }).fill('24');
  await page.getByLabel('성별', { exact: true }).selectOption('여성');
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByLabel('MBTI', { exact: true }).fill('intj');
  await expect(page.getByLabel('MBTI', { exact: true })).toHaveValue('INTJ');
  await page.getByLabel('SNS ID', { exact: true }).fill('@zkiss');
  await page.getByLabel('간단한 자기소개', { exact: true }).fill('새로운 사람과 이야기해요.');
  await expect(page.getByText(/\/20$/)).toBeVisible();
  await expect(page.getByRole('note')).toContainText('상대방은 물론 관리자도 확인할 수 없어요.');
  expect(await page.locator('.profile-page').evaluate(node => node.scrollHeight <= node.clientHeight)).toBe(true);
});

test('프로필 미리보기에서 수정하면 상세 입력 단계로 돌아간다', async ({ page }) => {
  await page.goto('/preview/profile-preview');
  await expect(page.locator('.profile-preview-page .progress')).toHaveCount(0);
  await page.getByRole('link', { name: '수정', exact: true }).click();
  await expect(page).toHaveURL('/profile?step=2');
  await expect(page.getByText('2/2', { exact: true })).toBeVisible();
  await expect(page.getByLabel('MBTI', { exact: true })).toBeVisible();
});

test('메시지 전송과 목록 이동 후 상태가 유지된다', async ({ page }) => {
  await page.goto('/preview/matched');
  await page.getByRole('link', { name: /라임/ }).click();
  const send = page.getByRole('button', { name: '메시지 보내기' });
  await expect(send).toBeDisabled();
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('  ');
  await expect(send).toBeDisabled();
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('반가워요!');
  await send.click();
  await expect(page.getByRole('log')).toContainText('반가워요!');
  await expect(page.getByRole('textbox', { name: '메시지', exact: true })).toHaveValue('');
  await page.getByRole('link', { name: '대화 목록으로' }).click();
  await expect(page.locator('.conversation-copy')).toContainText('반가워요!');
  await page.getByRole('link', { name: /라임/ }).click();
  await expect(page.getByRole('log')).toContainText('반가워요!');
});

test('한쪽 요청은 SNS 공개가 아니며 취소할 수 있다', async ({ page }) => {
  await page.goto('/preview/room');
  await expect(page.getByRole('button', { name: 'SNS 공개 요청하기' })).toHaveCount(0);
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('반가워요!');
  await page.getByRole('button', { name: '메시지 보내기' }).click();
  await page.getByRole('button', { name: 'SNS 공개 요청하기' }).click();
  await expect(page.getByRole('heading', { name: '상대방의 동의를 기다리고 있어요' })).toBeVisible();
  await expect(page.getByRole('button', { name: '상대방 동의 시뮬레이션' })).toBeVisible();
  await expect(page.getByRole('button', { name: /SNS ID 복사/ })).toHaveCount(0);
  await expect(page.getByText('서로 동의했어요')).toHaveCount(0);
  await page.getByRole('button', { name: '공개 요청 취소하기' }).click();
  await expect(page.getByRole('button', { name: 'SNS 공개 요청하기' })).toBeVisible();
  await page.getByRole('button', { name: 'SNS 공개 요청하기' }).click();
  await page.getByRole('button', { name: '상대방 동의 시뮬레이션' }).click();
  await expect(page.getByRole('heading', { name: '서로 동의했어요' })).toBeVisible();
});

test('SNS 완료 주소를 직접 열어도 미동의 상태에서는 공개되지 않는다', async ({ page }) => {
  await page.goto('/chats/lime/shared');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('button', { name: /SNS ID 복사/ })).toHaveCount(0);
  await expect(page.getByText('서로 동의했어요')).toHaveCount(0);
});

test('상호 동의 예시만 완료 화면을 보여준다', async ({ page }) => {
  await page.goto('/preview/shared');
  await expect(page.getByRole('heading', { name: '서로 동의했어요' })).toBeVisible();
  await page.getByRole('button', { name: '라임 SNS ID 복사' }).click();
  await expect(page.getByRole('status')).toContainText('미리보기에서는 SNS ID를 복사하지 않아요.');
});

test('좁은 모바일과 데스크톱에서 가로 스크롤 없이 표시된다', async ({ page }) => {
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    for (const scene of ['profile', 'profile-preview', 'room', 'shared']) {
      await page.goto(`/preview/${scene}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${scene} at ${width}px`).toBe(true);
      const screen = await page.locator('.screen').boundingBox();
      expect(screen!.width).toBeLessThanOrEqual(402);
    }
  }
});
