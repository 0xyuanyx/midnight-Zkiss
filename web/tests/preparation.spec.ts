import {test,expect} from '@playwright/test';
test('여러 탭과 새로고침에서 동일한 영구 슬롯 비밀을 사용한다',async({context,page})=>{
 test.skip(Boolean(process.env.WEB_TEST_BASE_URL),'Local modules');
 const second=await context.newPage();
 await Promise.all([page,second].map(p=>p.goto('/preview')));
 const get=(p:typeof page)=>p.evaluate(async()=>{
  const {participantSecret}=await import(/* @vite-ignore */ '/src/midnight/' + 'device-store.ts');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await participantSecret('atomic-test'))));
 });
 const [a,b]=await Promise.all([get(page),get(second)]);expect(a).toEqual(b);
 await page.reload();expect(await get(page)).toEqual(a);
});
test('SSE 이벤트를 합치고 연결 실패와 재연결을 알린다',async({page})=>{
 test.skip(Boolean(process.env.WEB_TEST_BASE_URL),'Local modules');await page.goto('/preview');
 const result=await page.evaluate(async()=>{
  let instance:any;
  class Fake extends EventTarget{onopen:any;onerror:any;closed=false;constructor(){super();instance=this;}close(){this.closed=true;}}
  Object.defineProperty(window,'EventSource',{value:Fake});
  const {watchSession}=await import(/* @vite-ignore */ '/src/state/' + 'stream.ts');
  let calls=0;const states:boolean[]=[];
  const stop=watchSession('test',()=>calls++,(v:boolean)=>states.push(v));
  instance.onopen();for(let i=0;i<10;i++)instance.dispatchEvent(new Event('reveal.status_changed'));
  await new Promise(r=>setTimeout(r,150));
  instance.onerror();instance.onopen();stop();
  return {calls,states,closed:instance.closed};
 });
 expect(result).toEqual({calls:3,states:[true,false,true,false],closed:true});
});
test('예열 실패 후 복구하고 같은 Worker를 승인에 재사용한다',async({page})=>{
 test.skip(Boolean(process.env.WEB_TEST_BASE_URL),'Local modules');await page.goto('/preview');
 const result=await page.evaluate(async()=>{
  const instances:any[]=[];let fail=true;
  class FakeWorker {
   onmessage:any;onerror:any;messages:any[]=[];terminated=false;
   constructor(){instances.push(this);}
   postMessage(data:any){this.messages.push(data.type??'prove');queueMicrotask(()=>{
    if(fail){fail=false;this.onmessage({data:{error:'PROOF_ASSET_UNAVAILABLE'}});}
    else this.onmessage({data:data.type==='warm'?{warmed:true}:{transaction:'proven-test'}});
   });}
   terminate(){this.terminated=true;}
  }
  Object.defineProperty(window,'Worker',{value:FakeWorker});
  const {warmProof,prove}=await import(/* @vite-ignore */ '/src/midnight/'+'proof-runtime.ts');
  let rejected=false;try{await warmProof();}catch{rejected=true;}
  await warmProof();const result=await prove({intent:{}});
  return {rejected,result,workers:instances.length,firstTerminated:instances[0].terminated,messages:instances[1].messages};
 });
 expect(result).toEqual({rejected:true,result:'proven-test',workers:2,firstTerminated:true,messages:['warm','prove']});
});
test('준비 상태 갱신과 거절 클릭이 겹쳐도 같은 요청에만 재시도한다',async({page})=>{
 test.skip(Boolean(process.env.WEB_TEST_BASE_URL),'Local modules');await page.goto('/preview');
 const result=await page.evaluate(async()=>{
  const {probe}=await import(/* @vite-ignore */ '/tests/'+'decision-probe.ts');
  return probe();
 });
 expect(result).toEqual([
  {path:'/reveal-requests/same/decisions',method:'POST',body:{expectedVersion:3,transcriptHash:null,action:'reject'}},
  {path:'/reveal-requests/same',method:'GET'},
  {path:'/reveal-requests/same/decisions',method:'POST',body:{expectedVersion:4,transcriptHash:'current',action:'reject'}},
 ]);
});
