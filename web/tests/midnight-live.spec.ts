import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
const target=process.env.ZKISS_MIDNIGHT_LIVE_URL;
test.skip(!target,'Requires isolated real Devnet browser-live harness');
const photo=await sharp({create:{width:16,height:16,channels:3,background:'#888888'}}).png().toBuffer();
async function onboard(page:Page,name:string,contact:string) {
  await page.goto(target!);
  await page.getByRole('button',{name:/행사 프로필 만들기/}).click();
  await page.getByRole('textbox',{name:'닉네임'}).fill(name);
  await page.getByRole('textbox',{name:'나이'}).fill('24');
  await page.getByRole('combobox',{name:'성별'}).selectOption('여성');
  await page.getByRole('button',{name:'다음'}).click();
  await page.getByLabel('AI 인상 분석용 사진').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:photo});
  await page.getByRole('button',{name:'AI 프로필 만들기'}).click();
  await expect(page.getByRole('heading',{name:'상대방에게 보일 내 프로필'})).toBeVisible({timeout:30000});
  await page.getByRole('button',{name:'이 프로필로 시작'}).click();
  const home=page.getByRole('heading',{name:'지금 만날 사람들'});
  await expect(home.or(page.locator('.api-error'))).toBeVisible({timeout:300000});
  if(await page.locator('.api-error').isVisible()) throw Error(await page.locator('.api-error').innerText());
  await expect(home).toBeVisible();
  await page.goto(target!+'/me');
  await page.getByRole('textbox',{name:'공개할 SNS 아이디'}).fill(contact);
  await page.getByRole('button',{name:'SNS 저장하기'}).click();
  await expect(page.getByRole('status').filter({hasText:'암호화된 SNS가 저장되어 있어요.'})).toBeVisible({timeout:30000});
}
test('two browsers prove admission and bilateral SNS approval, decrypt and restore',async({browser},testInfo)=>{
  test.setTimeout(1_200_000);
  const contexts=[await browser.newContext(),await browser.newContext()];
  const [a,b]=await Promise.all(contexts.map(c=>c.newPage()));
  const suffix=Date.now().toString().slice(-6),nameA='A'+suffix,nameB='B'+suffix,contactA='@alice.'+suffix,contactB='@bob.'+suffix;
  const submitted:string[]=[];
  for(const page of [a,b]) {
    page.on('pageerror',error=>console.log('BROWSER_ERROR',error.message));
    page.on('response',async response=>{
      if(response.url().includes('/relay/submit')&&response.ok())submitted.push((await response.json()).data.transactionId);
      if(response.status()>=400&&response.url().includes('/api/'))console.log('API_ERROR',response.status(),response.url(),await response.text());
    });
  }
  try{
    await onboard(a,nameA,contactA);await onboard(b,nameB,contactB);
    await a.goto(target!+'/home');
    await a.locator('.feed-profile').filter({hasText:nameB}).getByRole('button',{name:/호감 보내기/}).click();
    await b.goto(target!+'/likes');
    await b.getByRole('button',{name:new RegExp('호감 보내기.*'+nameA)}).click();
    await b.getByRole('button',{name:'대화 시작하기'}).click();
    await a.getByRole('button',{name:'대화 시작하기'}).click({timeout:30000});
    await expect(a.getByRole('button',{name:'상대방 동의 시뮬레이션'})).toHaveCount(0);
    await a.getByRole('button',{name:'SNS 공개 요청하기'}).click();
    await expect(b.getByRole('button',{name:'동의하고 승인 거래 제출하기'})).toBeVisible({timeout:120000});
    await expect(a.getByText(contactB,{exact:true})).toHaveCount(0);
    await expect(b.getByText(contactA,{exact:true})).toHaveCount(0);
    await b.getByRole('button',{name:'동의하고 승인 거래 제출하기'}).click();
    await expect(a.getByText(contactB,{exact:true})).toBeVisible({timeout:360000});
    await expect(b.getByText(contactA,{exact:true})).toBeVisible({timeout:360000});
    await a.reload();await b.reload();
    await expect(a.getByText(contactB,{exact:true})).toBeVisible({timeout:30000});
    await expect(b.getByText(contactA,{exact:true})).toBeVisible({timeout:30000});
    expect(new Set(submitted).size).toBe(4);
    await testInfo.attach('real-midnight-transactions',{body:JSON.stringify({transactions:submitted,network:'undeployed',syntheticAi:true}),contentType:'application/json'});
  }finally{await Promise.all(contexts.map(c=>c.close()));}
});
