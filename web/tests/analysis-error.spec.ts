import { test, expect } from '@playwright/test';
for (const [code, message] of [['INVALID_PHOTO','사진 파일을 읽을 수 없거나'], ['UNSUPPORTED_MEDIA_TYPE','지원하지 않는 사진 형식'], ['FILE_TOO_LARGE','사진 용량이 너무 커요']]) {
  test(`사진 접수 실패 ${code}는 진행 표시 대신 이유와 재시도를 보여준다`, async ({ page }) => {
    await page.goto(`/tests/analysis-error.html?code=${code}`);
    await expect(page.getByRole('heading', {name:'사진을 처리하지 못했어요'})).toBeVisible();
    await expect(page.getByText(message, {exact:false})).toBeVisible();
    await expect(page.locator('.scan-progress')).toHaveCount(0);
    await expect(page.getByRole('link', {name:'사진을 다시 선택해 재시도'})).toHaveAttribute('href','/profile?step=2');
  });
}
