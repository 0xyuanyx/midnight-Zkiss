import {test,expect} from 'vitest';
import {fixture,activeUser,call} from './helpers.js';
import {createDemoOperator,demoMidnight} from '../src/adapters/demo-midnight.js';
import {processChainJobs} from '../src/chain-jobs.js';
async function pair(f:any){
 const a=await activeUser(f),b=await activeUser(f);
 await call(f,a,'POST','/events/evt/likes',{targetProfileId:b.id});
 const room=(await call(f,b,'POST','/events/evt/likes',{targetProfileId:a.id})).json().data.conversationId;
 await f.pool.query("UPDATE participants SET contact='{}',contact_version=1 WHERE id=ANY($1::text[])",[[a.id,b.id]]);
 return {a,b,room};
}
const material=(n:number)=>({slot:String(n).repeat(64),roomPublicKey:Buffer.alloc(32,n).toString('base64'),keyCommit:'c'.repeat(64),contactCommit:String(n+2).repeat(64)});
test('preopens once, accepts before terms, preserves consent and rejects outsiders/slot changes',async()=>{
 const f=await fixture();const base=createDemoOperator();let opens=0;
 const op={...base,async openRoom(...args:Parameters<typeof base.openRoom>){opens++;return base.openRoom(...args);}};
 try {
  const {a,b,room}=await pair(f),third=await activeUser(f);
  const path=`/events/evt/conversations/${room}`;
  const context=(await call(f,a,'GET',path)).json().data.chainPreparation;
  expect(context.roomId).toHaveLength(64);
  expect((await call(f,third,'PUT',path+'/chain-slot',{slot:'1'.repeat(64)})).statusCode).toBe(404);
  for(const [u,n] of [[a,1],[b,2]] as const)expect((await call(f,u,'PUT',path+'/chain-slot',{slot:String(n).repeat(64)})).statusCode).toBe(200);
  expect((await call(f,a,'PUT',path+'/chain-slot',{slot:'3'.repeat(64)})).statusCode).toBe(409);
  await processChainJobs(f.pool,demoMidnight,op);await processChainJobs(f.pool,demoMidnight,op);
  expect(opens).toBe(1);
  expect((await call(f,a,'GET',path)).json().data.chainPreparation.status).toBe('open');
  let r=(await call(f,a,'POST',path+'/reveal-requests',{expectedVersion:1,ownContactVersion:1,consent:true})).json().data;
  const rp=`/events/evt/reveal-requests/${r.id}`;
  expect(r.chainRoomId).toBe(context.roomId);
  r=(await call(f,b,'POST',rp+'/decisions',{expectedVersion:r.version,transcriptHash:null,action:'accept'})).json().data;
  expect(r.status).toBe('collecting');
  expect((await call(f,b,'POST','/events/evt/chain-intents',{purpose:'reveal_approval',revealRequestId:r.id,transcriptHash:'f'.repeat(64)})).statusCode).toBe(409);
  for(const [u,n] of [[a,1],[b,2]] as const)expect((await call(f,u,'PUT',rp+'/room-material',material(n))).statusCode).toBe(200);
  await processChainJobs(f.pool,demoMidnight,op);
  expect(opens).toBe(1);
  const done=(await call(f,b,'GET',rp)).json().data;
  expect(done.status).toBe('awaiting_chain');expect(done.myDecision).toBe('accepted');expect(done.peerDecision).toBe('accepted');
 }finally{await f.close();}
});
test.each(['reject','expire','change'])('early consent cannot survive %s before terms completion',async(action)=>{
 const f=await fixture();try{
  const {a,b,room}=await pair(f),path=`/events/evt/conversations/${room}`;
  let r=(await call(f,a,'POST',path+'/reveal-requests',{expectedVersion:1,ownContactVersion:1,consent:true})).json().data;
  const rp=`/events/evt/reveal-requests/${r.id}`;
  for(const [u,n]of [[a,1],[b,2]]as const)await call(f,u,'PUT',rp+'/room-material',material(n));
  r=(await call(f,b,'GET',rp)).json().data;
  await call(f,b,'POST',rp+'/decisions',{expectedVersion:r.version,transcriptHash:null,action:action==='reject'?'reject':'accept'});
  if(action==='expire')await f.pool.query('UPDATE reveal_requests SET expires_at=now()-interval \'1 second\' WHERE id=$1',[r.id]);
  if(action==='change')await f.pool.query('UPDATE participants SET contact_version=contact_version+1 WHERE id=$1',[b.id]);
  await processChainJobs(f.pool,demoMidnight,createDemoOperator());
  const done=(await call(f,a,'GET',rp)).json().data;expect(['rejected','cancelled','expired']).toContain(done.status);expect(done.transcriptHash).toBeNull();
  expect((await call(f,a,'GET',path)).json().data.status).toBe('active');
 }finally{await f.close();}
});
test('거절과 느린 방 등록 완료가 겹쳐도 공개 조건을 만들지 않는다',async()=>{
 const f=await fixture(),base=createDemoOperator();let enter!:()=>void,finish!:()=>void;
 const started=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>finish=r);
 const op={...base,async openRoom(...args:Parameters<typeof base.openRoom>){enter();await gate;return base.openRoom(...args);}};
 let running:Promise<void>|undefined;
 try{
  const {a,b,room}=await pair(f);
  const r=(await call(f,a,'POST',`/events/evt/conversations/${room}/reveal-requests`,{expectedVersion:1,ownContactVersion:1,consent:true})).json().data;
  const path=`/events/evt/reveal-requests/${r.id}`;
  for(const [u,n]of [[a,1],[b,2]]as const)await call(f,u,'PUT',path+'/room-material',material(n));
  running=processChainJobs(f.pool,demoMidnight,op);await started;
  const fresh=(await call(f,b,'GET',path)).json().data;
  expect((await call(f,b,'POST',path+'/decisions',{expectedVersion:fresh.version,transcriptHash:null,action:'reject'})).statusCode).toBe(200);
  finish();await running;
  const done=(await call(f,a,'GET',path)).json().data;expect(done.status).toBe('rejected');expect(done.transcriptHash).toBeNull();
 }finally{finish?.();await running;await f.close();}
});
