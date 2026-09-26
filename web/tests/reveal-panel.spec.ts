import {test,expect} from '@playwright/test';
test('준비 중에도 수신자에게 개인화된 동의와 거절을 제공한다',async({page})=>{
 test.skip(Boolean(process.env.WEB_TEST_BASE_URL),'Local harness');
 for(const status of ['collecting','requested']){
  await page.goto(`/tests/reveal-panel.html?status=${status}`);
  await expect(page.getByText(/테스터님도 공개에 동의하면/)).toBeVisible();
  await page.getByRole('button',{name:'공개 동의',exact:true}).click();
  await expect(page.locator('#action')).toHaveText('accept-or-retry');
  await page.getByRole('button',{name:'공개 거절',exact:true}).click();
  await expect(page.locator('#action')).toHaveText('reject');
 }
});
test('동의 대기와 처리 단계를 구분하고 실패 후 재시도한다',async({page})=>{
 test.skip(Boolean(process.env.WEB_TEST_BASE_URL),'Local harness');
 await page.goto('/tests/reveal-panel.html?status=collecting&mine=1&peer=0');
 await expect(page.getByText(/상대방이 동의하면 서로의 SNS/)).toBeVisible();
 await expect(page.getByRole('button',{name:'공개 요청 취소하기'})).toBeVisible();
 await page.goto('/tests/reveal-panel.html?status=awaiting_chain&mine=1');
 await expect(page.locator('[aria-current="step"]')).toHaveText('안전하게 확인 중');
 await page.goto('/tests/reveal-panel.html?status=awaiting_chain&mine=1&failed=1');
 await page.getByRole('button',{name:'공개 준비 다시 시도'}).click();
 await expect(page.locator('#action')).toHaveText('accept-or-retry');
 await page.goto('/tests/reveal-panel.html?status=rejected');
 await expect(page.getByRole('button',{name:'SNS 공개 동의하기'})).toBeVisible();
});
