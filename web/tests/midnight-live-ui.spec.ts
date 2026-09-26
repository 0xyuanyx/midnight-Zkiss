import { test, expect, type Page } from '@playwright/test';
async function setup(page: Page, initial = 'requested') {
  let status = initial, decision = initial === 'requested' ? 'pending' : 'accepted', requestId = 'reveal-one';
  const writes: { path: string; body: any }[] = [];
  const profile = { id: 'peer', nickname: '상대방', age: 24, intro: '소개', mbti: null, tags: [] };
  const room = () => ({ id: 'room', status: 'active', version: 1, origin: 'mutual_like', peer: { identity: 'public_profile', profile }, unreadCount: 0, revealRequestId: requestId, allowedActions: ['request_reveal'], chatUntil: new Date(Date.now() + 3600000).toISOString() });
  const record = () => ({ id: requestId, conversationId: 'room', version: 1, status, myDecision: decision, peerDecision: 'accepted', transcriptHash: 'a'.repeat(64), terms: 'terms', expiresAt: new Date(Date.now() + 600000).toISOString(), myMaterialReady: true, myEnvelopeReady: true, error: status === 'error' ? 'CONSENT_EXPIRED' : undefined });
  await page.route('**/src/midnight/runtime.ts*', route => route.fulfill({ contentType: 'application/javascript', body: `export async function createBrowserRuntime(){return {openPeer:async()=> '@verified-peer',submitApproval:async()=>{window.__proofStarted=true;await new Promise(resolve=>window.__finishProof=resolve);return {transactionId:'tx'};},saveContact:async(contact)=>{window.__contactInput=contact;return {commitment:'a'.repeat(64),ownerEnvelope:{ciphertext:'encrypted',enc:'public',suite:'hpke'}};}}}` }));
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') writes.push({ path, body: route.request().postDataJSON() });
    let data: unknown;
    if (path === '/api/v1/me') data = { eventId: 'evt_integration', participantId: 'me', csrfToken: 'csrf', admissionStatus: 'active', ticket: { leaf: 'leaf', status: 'issued' }, profile: { version: 1, status: 'published', nickname: '나', age: 24, intro: '내 소개' }, contact: { version: 1, configured: true } };
    else if (path.endsWith('/messages')) data = { items: [], nextAfterSequence: 0, hasMore: false };
    else if (path.endsWith('/feed') || path.endsWith('/likes')) data = { items: [], nextCursor: null };
    else if (path.endsWith('/conversations')) data = { items: [room()], nextCursor: null };
    else if (path.endsWith('/conversations/room')) data = room();
    else if (path.endsWith('/decisions')) { const action = route.request().postDataJSON().action; status = action === 'accept' ? 'awaiting_chain' : action === 'reject' ? 'rejected' : 'cancelled'; decision = action === 'accept' ? 'accepted' : status; data = record(); }
    else if (path.endsWith('/chain-intents')) data = {id:'intent',operationId:'op',mode:'real',expiresAt:record().expiresAt};
    else if (path.endsWith('/transactions')) data = {};
    else if (path.includes('/operations/')) data = {status:'succeeded',effectApplied:true};
    else if (path.includes('/reveal-requests/')) data = record();
    else if (path.endsWith('/contact-vault')) data = { version: 2, configured: true };
    else data = { name: '행사', mode: 'real', aiMode: 'real', aiReady: true, participantCount: 2, features: { snsReveal: true } };
    await route.fulfill({ json: { data } });
  });
  await page.goto('/');
  await page.evaluate(async () => { const m = await import(/* @vite-ignore */ '/tests/' + 'live-ui-harness.tsx'); m.mount('/chats/peer'); });
  return { writes, setRequest: () => { requestId = 'reveal-two'; status = 'requested'; decision = 'pending'; } };
}
test('real request requires consent and permits rejection without simulation', async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByRole('button', { name: '동의하고 승인 거래 제출하기' })).toBeVisible();
  await expect(page.getByRole('button', { name: '거절하기' })).toBeVisible();
  await expect(page.getByRole('button', { name: '상대방 동의 시뮬레이션' })).toHaveCount(0);
  await expect(page.getByLabel('SNS 상호 공개 완료')).toHaveCount(0);
  expect(state.writes).toEqual([]);
  await page.getByRole('button', { name: '거절하기' }).click();
  await expect(page.getByText('SNS 공개 요청을 거절했어요.')).toBeVisible();
  expect(state.writes.some(x => x.body.action === 'reject')).toBe(true);
});
test('new request removes the previously verified peer contact', async ({ page }) => {
  const state = await setup(page, 'released');
  await expect(page.getByText('@verified-peer')).toBeVisible();
  state.setRequest();
  await expect(page.getByRole('button', { name: '거절하기' })).toBeVisible({ timeout: 12000 });
  await expect(page.getByText('@verified-peer')).toHaveCount(0);
  await expect(page.getByLabel('SNS 상호 공개 완료')).toHaveCount(0);
});
test('SNS settings invoke encryption and send only the encrypted vault', async ({ page }) => {
  const state = await setup(page);
  await page.evaluate(() => { history.pushState(null, '', '/me'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.getByLabel('공개할 SNS 아이디').fill('@private-owner');
  await page.getByRole('button', { name: 'SNS 저장하기' }).click();
  await expect.poll(() => state.writes.filter(x => x.path.endsWith('/contact-vault')).length).toBe(1);
  expect(JSON.stringify(state.writes)).not.toContain('@private-owner');
  expect(await page.evaluate(() => (window as any).__contactInput)).toBe('@private-owner');
});

test('explicit approval shows cancellable progress while the proof is pending', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: '동의하고 승인 거래 제출하기' }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).__proofStarted)).toBe(true);
  await expect(page.getByText('1. 단말 증명')).toBeVisible();
  await expect(page.getByText('2. 거래 제출')).toBeVisible();
  await expect(page.getByText('3. 체인 확인')).toBeVisible();
  await expect(page.getByRole('button', { name: '공개 요청 취소하기' })).toBeEnabled();
  await page.getByRole('button', { name: '공개 요청 취소하기' }).click();
  await expect(page.getByText('SNS 공개 요청이 취소됐어요.')).toBeVisible();
  await page.evaluate(() => (window as any).__finishProof());
  await expect(page.getByLabel('SNS 상호 공개 완료')).toHaveCount(0);
  expect(state.writes.some(x => x.body.action === 'cancel')).toBe(true);
});

test('an expired reveal does not offer a retry that could create a new proof', async ({ page }) => {
  await setup(page, 'error');
  await expect(page.getByText('공개 요청이 만료되어 새 증명이나 자동 복구를 하지 않았어요.')).toBeVisible();
  await expect(page.getByRole('button', { name: '처리 상태 다시 확인하기' })).toHaveCount(0);
});
