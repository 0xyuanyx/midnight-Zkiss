import { describe, it, expect } from 'vitest';
import { fixture, user, headers } from './helpers.js';
const relay = { mode: 'real', async info() { return { coinPublicKey:'coin', encryptionPublicKey:'enc', indexerUrl:'http://localhost', indexerWsUrl:'ws://localhost' }; }, async balance() { return 'ZmluYWxpemVk'; }, async submit() { return 'tx-real'; } };
describe('participant transaction relay', () => {
  it('rejects unauthenticated and demo sponsorship', async () => {
    const f = await fixture('demo', { relay });
    try {
      expect((await f.app.inject({url:'/api/v1/events/evt/midnight/relay'})).statusCode).toBe(401);
      const u=await user(f);
      expect((await f.app.inject({url:'/api/v1/events/evt/midnight/relay',headers:headers(u)})).statusCode).toBe(503);
    } finally { await f.close(); }
  });
  it('requires CSRF and a server-owned pending intent before calling sponsor', async () => {
    let called=0;
    const f=await fixture('real',{relay:{...relay, async balance(){called++; return 'ZmluYWxpemVk';}}});
    try {
      const u=await user(f);
      const url='/api/v1/events/evt/midnight/relay/balance', payload={intentId:'foreign',transaction:'YWJj'};
      expect((await f.app.inject({method:'POST',url,payload,headers:{cookie:u.cookie}})).statusCode).toBe(403);
      expect((await f.app.inject({method:'POST',url,payload,headers:headers(u)})).statusCode).toBe(404);
      expect(called).toBe(0);
    } finally {await f.close();}
  });
  it('balances once, recovers exact finalized bytes, and rejects altered submissions', async () => {
    let balanced=0,submitted=0;
    const f=await fixture('real',{relay:{...relay,async balance(){balanced++;return 'ZmluYWxpemVk';},async submit(){submitted++;return 'tx-real';}}});
    try {
      const u=await user(f), other=await user(f);
      const prepared={network:'test',contractAddress:'a'.repeat(64),protocolVersion:'zkiss-midnight-v2',circuit:'admit',publicPayload:'payload'};
      await f.pool.query("INSERT INTO chain_intents(id,event_id,owner_id,purpose,binding,binding_hash,prepared,mode,expires_at) VALUES('intent','evt',$1,'admission','{}',$2,$3,'real',now()+interval '5 minutes')",[u.id,'c'.repeat(64),JSON.stringify(prepared)]);
      await f.pool.query("INSERT INTO operations(id,intent_id,owner_id) VALUES('op','intent',$1)",[u.id]);
      const url='/api/v1/events/evt/midnight/relay';
      const post=(action:string,transaction:string,who=u)=>f.app.inject({method:'POST',url:url+'/'+action,headers:headers(who),payload:{intentId:'intent',transaction}});
      expect((await post('balance','YWJj',other)).statusCode).toBe(404);
      expect((await post('balance','YWJj')).statusCode).toBe(200);
      expect((await post('balance','YWJj')).statusCode).toBe(200);
      expect(balanced).toBe(1);
      expect((await post('balance','YWRk')).statusCode).toBe(409);
      const recovery=await f.app.inject({url:url+'/intents/intent',headers:headers(u)});
      expect(recovery.json().data).toEqual({status:'balanced',transaction:'ZmluYWxpemVk'});
      expect((await post('submit','YWRk')).statusCode).toBe(409);
      expect((await post('submit','ZmluYWxpemVk')).json().data.transactionId).toBe('tx-real');
      expect((await post('submit','ZmluYWxpemVk')).json().data.transactionId).toBe('tx-real');
      expect(submitted).toBe(1);
    }finally{await f.close();}
  });

  it('does not leave a spend marker for rejected public validation', async () => {
    const f=await fixture('real',{relay:{...relay,async validate(){throw new Error('RELAY_BINDING_MISMATCH');}}});
    try {
      const u=await user(f);
      const prepared={network:'test',contractAddress:'a'.repeat(64),circuit:'admit',publicPayload:'payload'};
      await f.pool.query("INSERT INTO chain_intents(id,event_id,owner_id,purpose,binding,binding_hash,prepared,mode,expires_at) VALUES('intent','evt',$1,'admission','{}',$2,$3,'real',now()+interval '5 minutes')",[u.id,'c'.repeat(64),JSON.stringify(prepared)]);
      await f.pool.query("INSERT INTO operations(id,intent_id,owner_id) VALUES('op','intent',$1)",[u.id]);
      await f.app.inject({method:'POST',url:'/api/v1/events/evt/midnight/relay/balance',headers:headers(u),payload:{intentId:'intent',transaction:'YWJj'}});
      expect((await f.pool.query('SELECT * FROM browser_relay_transactions')).rows).toHaveLength(0);
    }finally{await f.close();}
  });

});
