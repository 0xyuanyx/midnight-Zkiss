import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';

test('두 사용자가 실제 API로 프로필·호감·대화·SNS 상호 공개를 완료한다', async ({ browser }, testInfo) => {
  test.skip(process.env.ZKISS_LIVE_E2E !== '1', 'Local demo API, database and worker required');
  const actualChain = process.env.ZKISS_REAL_SNS === '1';
  test.setTimeout(actualChain ? 900_000 : 150_000);
  const contextOptions = { baseURL: testInfo.project.use.baseURL, ignoreHTTPSErrors: !process.env.WEB_TEST_BASE_URL,
    viewport: testInfo.project.use.viewport, isMobile: testInfo.project.use.isMobile, hasTouch: testInfo.project.use.hasTouch };
  const aContext = await browser.newContext(contextOptions);
  const bContext = await browser.newContext(contextOptions);
  const a = await aContext.newPage();
  const b = await bContext.newPage();
  const suffix = Date.now().toString().slice(-7);
  const nameA = `테스트하늘${suffix}`, nameB = `테스트바다${suffix}`;
  console.log('SNS_TEST_PROFILES', nameA, nameB);
  const errors: string[] = [];
  const leaked: string[] = [];
  const admissionRequests: string[] = [];
  const relayBytes: Buffer[] = [];
  for (const page of [a, b]) {
    if (process.env.ZKISS_NO_NATIVE_X25519 === '1') {
      await page.addInitScript(() => {
        for (const method of ['generateKey', 'importKey', 'deriveBits'] as const) {
          const original = (crypto.subtle[method] as Function).bind(crypto.subtle);
          Object.defineProperty(crypto.subtle, method, { configurable: true, value: (...args: any[]) => {
            const algorithm = args[method === 'importKey' ? 2 : 0];
            if ((typeof algorithm === 'string' ? algorithm : algorithm?.name) === 'X25519') return Promise.reject(new DOMException('Unsupported X25519', 'NotSupportedError'));
            return original(...args);
          } });
        }
      });
    }
    await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; } } }); });
    if (actualChain) {
      if (process.env.ZKISS_TEST_PROOF_RECOVERY === '1') {
        await page.addInitScript(() => {
          const NativeWorker = window.Worker;
          let failed = false;
          window.Worker = class extends NativeWorker {
            postMessage(data: any, options?: any) {
              if (!failed) {
                failed = true;
                queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { error: 'PROOF_ASSET_UNAVAILABLE' } })));
                return;
              }
              super.postMessage(data, options);
            }
          };
        });
        // First asset response fails too: the real Worker must retry without dropping approval.
        let interrupted = false;
        await page.route('**/zk/sns/keys/approveReveal.prover', async route => {
          if (!interrupted) { interrupted = true; await route.fulfill({ status: 503, body: 'temporary test failure' }); }
          else await route.continue();
        });
      }
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
    await page.getByLabel('분석용 사진 선택').setInputFiles(resolve(name === nameA ? 'public/assets/feed-lime.png' : 'public/assets/feed-mocha.png'));
    await page.getByRole('button', { name: 'AI 프로필 만들기' }).click();
    await expect(page).toHaveURL('/profile/preview', { timeout: process.env.ZKISS_REAL_AI === '1' ? 180000 : 20000 });
    if (process.env.ZKISS_EXPECT_GENERATED_IMAGES === '1') {
      await expect(page.getByRole('img', { name: 'AI가 생성한 프로필 이미지', exact: true })).toHaveAttribute('src', /\/api\/v1\/events\/.+\/profile-images\//);
      await expect.poll(() => page.locator('.impression-avatar').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    }
    await page.screenshot({path:testInfo.outputPath(name === nameA ? '01-profile-a.png' : '02-profile-b.png'),fullPage:true});
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
      await sender.getByRole('textbox', { name: '메시지', exact: true }).fill(['안녕하세요! 오늘 행사 재미있네요.', '안녕하세요! 저도 즐겁게 둘러보고 있어요.', '괜찮으시면 SNS도 서로 공개할까요?', '좋아요! 공개 요청 보내주시면 동의할게요.'][i]);
      await sender.getByRole('button', { name: '메시지 보내기' }).click();
      await expect(sender.getByRole('textbox', { name: '메시지', exact: true })).toHaveValue('');
    }
    await expect(a.getByRole('log')).toContainText('좋아요! 공개 요청 보내주시면 동의할게요.', { timeout: 15000 });
    await a.screenshot({path:testInfo.outputPath('03-conversation.png'),fullPage:true});
    if(process.env.ZKISS_WAIT_ROOM==='1'){
      await expect.poll(async()=>a.evaluate(async()=>{
        const me=(await (await fetch('/api/v1/me')).json()).data;
        const list=(await (await fetch(`/api/v1/events/${me.eventId}/conversations`)).json()).data.items;
        return list.some((r:any)=>r.chainPreparation?.status==='open');
      }),{timeout:180000}).toBe(true);
      console.log('SNS_PREOPEN_CONFIRMED');
    }
    if(process.env.ZKISS_TEST_REJECT==='1'){
      await a.getByRole('button',{name:'SNS 공개 동의하기',exact:true}).click();
      await b.getByRole('button',{name:'공개 거절',exact:true}).click();
      await expect(a.getByText('이번 공개 요청은 종료됐어요. 대화는 계속할 수 있어요.')).toBeVisible();
    }
    const revealStart=Date.now();
    await a.getByRole('button', { name: process.env.ZKISS_BASELINE_UI ? 'SNS 공개 요청하기' : 'SNS 공개 동의하기' }).click();
    await expect(a.getByRole('heading', { name: '서로 동의했어요' })).toHaveCount(0);
    await b.bringToFront();
    await expect(b.getByRole('button', { name: process.env.ZKISS_BASELINE_UI ? 'SNS 공개 동의하기' : '공개 동의', exact: true })).toBeEnabled({ timeout: actualChain ? 180000 : 25000 });
    console.log('SNS_TIMING request_to_consent_ms',Date.now()-revealStart);
    await a.screenshot({path:testInfo.outputPath('04-requester-waiting.png'),fullPage:true});
    await b.screenshot({path:testInfo.outputPath('05-recipient-consent.png'),fullPage:true});
    await b.getByRole('button', { name: process.env.ZKISS_BASELINE_UI ? 'SNS 공개 동의하기' : '공개 동의', exact: true }).click();
    const consentAt=Date.now();
    await expect(b.getByRole('heading',{name:'SNS 공개를 안전하게 준비하고 있어요'})).toBeVisible({timeout:30000});
    await b.screenshot({path:testInfo.outputPath('06-both-consented-processing.png'),fullPage:true});
    if (process.env.ZKISS_TEST_PROOF_RECOVERY === '1') {
      for (const page of [a, b]) {
        await expect(page.getByRole('button', { name: '공개 준비 다시 시도' })).toBeVisible({ timeout: 30000 });
        await page.getByRole('button', { name: '공개 준비 다시 시도' }).click();
      }
    }
    await expect.poll(async () => {
      for (const page of [a,b]) { const alert = page.getByRole('alert'); if (await alert.count()) throw new Error(await alert.innerText()); }
      return a.getByRole('heading', { name: '서로 동의했어요' }).isVisible();
    }, { timeout: actualChain ? 600000 : 30000, intervals: [1000,2500] }).toBe(true);
    await expect(b.getByRole('heading', { name: '서로 동의했어요' })).toBeVisible({ timeout: actualChain ? 600000 : 30000 });
    console.log('SNS_TIMING consent_to_release_ms',Date.now()-consentAt);
    await a.screenshot({path:testInfo.outputPath('07-released-a.png'),fullPage:true});
    await b.screenshot({path:testInfo.outputPath('08-released-b.png'),fullPage:true});
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
      const secrets = await Promise.all([a, b].map(page => page.evaluate(async () => {
        const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('zkiss-sns-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
        const records=await new Promise<any[]>((resolve,reject)=>{const r=db.transaction('rooms').objectStore('rooms').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();
        const values:string[]=[];
        for(const r of records) if(r.version===4){const bytes=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:r.iv},r.wrappingKey,r.sealed));values.push(btoa(String.fromCharCode(...bytes)));bytes.fill(0);}
        return [...values,...Object.keys(sessionStorage).filter(k=>k.startsWith('zkiss.sns-device.v1:')).map(k=>sessionStorage.getItem(k)!)];
      })));
      for (const raw of relayBytes) {
        for (const contact of ['@secret-a', '@secret-b']) expect(raw.includes(Buffer.from(contact))).toBe(false);
        for (const secret of secrets.flat()) expect(raw.includes(Buffer.from(secret, 'base64'))).toBe(false);
      }
    }
  } finally { await aContext.close(); await bContext.close(); }
});
