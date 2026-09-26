import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate, equal, envelope, hash, need } from '../http.js';
import { one } from '../db.js';
import { eventChain } from '../chain-context.js';
import type { Config } from '../config.js';
import type { MidnightRelay } from '../adapters/relay.js';

export function midnightRelay(app: FastifyInstance, pool: Pool, config: Config, relay?: MidnightRelay) {
  const E='/api/v1/events/:eventId/midnight/relay';
  const body=z.object({intentId:z.string().min(1).max(200),transaction:z.string().min(4).max(1_400_000).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict();
  app.get(E, async req=>{
    const p=await authenticate(pool,req);
    need(p.event_id===(req.params as any).eventId);
    need(config.mode==='real' && relay?.mode==='real',503,'RELAY_UNAVAILABLE');
    const event=(await one(pool,'SELECT * FROM events WHERE id=$1',[p.event_id]))!;
    const chain=eventChain(event);
    return envelope({...chain,...await relay.info(chain)},req);
  });
  app.get(E+'/intents/:intentId', async req => {
    const p=await authenticate(pool,req);
    const params=req.params as {eventId:string;intentId:string};
    need(p.event_id===params.eventId);
    need(config.mode==='real' && relay?.mode==='real',503,'RELAY_UNAVAILABLE');
    const i=await one(pool,'SELECT id FROM chain_intents WHERE id=$1 AND owner_id=$2 AND event_id=$3',[params.intentId,p.id,p.event_id]);
    need(i);
    const db=await pool.connect();
    try {
      const locked=await one(db,'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',['relay:'+i.id]);
      need(locked?.acquired,409,'MIDNIGHT_OPERATION_IN_PROGRESS');
      const saved=await one(db,'SELECT * FROM browser_relay_transactions WHERE intent_id=$1',[i.id]);
      return envelope({status: !saved?'absent':saved.transaction_id?'submitted':saved.finalized_transaction?'balanced':'balancing', ...(saved?.transaction_id?{transactionId:saved.transaction_id}:{}), ...(saved?.finalized_transaction?{transaction:saved.finalized_transaction}:{})},req);
    } finally {
      try { await db.query('SELECT pg_advisory_unlock(hashtext($1))',['relay:'+i.id]); } finally { db.release(); }
    }
  });
  for(const action of ['balance','submit'] as const) app.post(E+'/'+action, {bodyLimit:1_500_000,config:{rateLimit:{max:12,timeWindow:'1 minute'}}}, async req=>{
    let p=await authenticate(pool,req);
    need(equal(p.csrf_token,String(req.headers['x-csrf-token']??'')),403,'CSRF_INVALID');
    need(p.event_id===(req.params as any).eventId);
    need(config.mode==='real' && relay?.mode==='real',503,'RELAY_UNAVAILABLE');
    const b=body.parse(req.body);
    // A session advisory lock serializes this intent without blocking the event/worker transaction.
    const db=await pool.connect();
    try {
      const locked=await one(db,'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',['relay:'+b.intentId]);
      need(locked?.acquired,409,'MIDNIGHT_OPERATION_IN_PROGRESS');
      p=await authenticate(db,req);
      need(['onboarding','admission_pending','active'].includes(p.admission_status),403,'ACCOUNT_SUSPENDED');
      const i=await one(db,'SELECT i.*,o.status AS operation_status FROM chain_intents i JOIN operations o ON o.intent_id=i.id WHERE i.id=$1 AND i.owner_id=$2 AND i.event_id=$3',[b.intentId,p.id,p.event_id]);
      need(i);
      const cached=await one(db,'SELECT * FROM browser_relay_transactions WHERE intent_id=$1',[i.id]);
      if(action==='submit' && cached?.transaction_id) {
        need(cached.finalized_transaction===b.transaction,409,'RELAY_TRANSACTION_CHANGED');
        return envelope({transactionId:cached.transaction_id},req);
      }
      need(i.mode==='real' && new Date(i.expires_at).getTime()>Date.now(),409,'INTENT_EXPIRED');
      need(!['succeeded','failed','partial_failure'].includes(i.operation_status),409,'INTENT_FINISHED');
      const e=(await one(db,'SELECT * FROM events WHERE id=$1',[p.event_id]))!;
      need(e.status==='open' && new Date(i.purpose==='admission'?e.join_until:e.chat_until).getTime()>Date.now(),409,'EVENT_CLOSED');
      const chain=eventChain(e);
      need(chain.network===i.prepared.network && chain.contractAddress===i.prepared.contractAddress,409,'CHAIN_SCOPE_CHANGED');
      if(i.purpose==='reveal_approval') {
        const r=await one(db,"SELECT r.* FROM reveal_requests r JOIN conversations c ON c.id=r.conversation_id WHERE r.id=$1 AND c.status='active'",[i.reveal_request_id]);
        need(r && r.status==='awaiting_chain' && r.decisions[p.id]==='accepted' && r.transcript_hash===i.binding.transcriptHash,409,'REVEAL_NOT_READY');
      }
      if(action==='balance') {
        if(cached) {
          need(cached.input_hash===hash(b.transaction),409,'RELAY_TRANSACTION_CHANGED');
          need(cached.finalized_transaction,409,'RELAY_RECOVERY_REQUIRED');
          return envelope({transaction:cached.finalized_transaction},req);
        }
        const input={...i.prepared,intentId:i.id,purpose:i.purpose,bindingHash:i.binding_hash,expiresAt:i.expires_at.toISOString(),transactionId:''};
        await relay.validate?.(b.transaction,input,chain);
        await db.query('INSERT INTO browser_relay_transactions(intent_id,input_hash) VALUES($1,$2)',[i.id,hash(b.transaction)]);
        let finalized: string;
        try { finalized=await relay.balance(b.transaction,input,chain); }
        catch(error) {
          // Only trusted provider validation errors may clear a marker. Wallet failures stay ambiguous.
          if(error instanceof Error && (error as Error & {safeToRetry?:boolean}).safeToRetry===true) await db.query('DELETE FROM browser_relay_transactions WHERE intent_id=$1 AND finalized_transaction IS NULL',[i.id]);
          throw error;
        }
        await db.query('UPDATE browser_relay_transactions SET finalized_transaction=$2 WHERE intent_id=$1',[i.id,finalized]);
        return envelope({transaction:finalized},req);
      }
      need(cached?.finalized_transaction===b.transaction,409,'RELAY_TRANSACTION_CHANGED');
      const transactionId=await relay.submit(b.transaction);
      await db.query('UPDATE browser_relay_transactions SET transaction_id=$2 WHERE intent_id=$1',[i.id,transactionId]);
      return envelope({transactionId},req);
    } finally {
      try { await db.query('SELECT pg_advisory_unlock(hashtext($1))',['relay:'+b.intentId]); } finally { db.release(); }
    }
  });
}
