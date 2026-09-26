import { test, expect } from '@playwright/test';
for (const legacy of [false,true]) test(`native X25519 없이 키 저장·복원·SNS 암복호화 legacy=${legacy}`,async({page})=>{
  test.skip(Boolean(process.env.WEB_TEST_BASE_URL),'local module test');
  await page.goto('/preview/entry');
  const result=await page.evaluate(async legacy=>{
    const path='/tests/crypto-compat-probe.ts';
    const module=await import(/* @vite-ignore */path);
    return module.probe(legacy);
  },legacy);
  expect(result).toEqual({nativeRejected:true,opened:true,stable:true,submitted:true});
});
