import {test,expect} from 'vitest';
import {fixture,activeUser,call} from './helpers.js';
test('proxy users have independent authenticated buckets; forged cookies cannot reset an IP bucket',async()=>{
 const f=await fixture();try{
  const a=await activeUser(f),b=await activeUser(f);
  let status=200;for(let i=0;i<305 && status!==429;i++)status=(await call(f,a,'GET','/me')).statusCode;
  expect(status).toBe(429);expect((await call(f,b,'GET','/me')).statusCode).toBe(200);
  for(let i=0;i<301;i++)await f.app.inject({method:'GET',url:'/api/v1/me'});
  expect((await f.app.inject({method:'GET',url:'/api/v1/me',headers:{cookie:'zkiss_session='+ 'x'.repeat(43)}})).statusCode).toBe(429);
 }finally{await f.close();}
});
