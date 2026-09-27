import type { Pool } from 'pg';
import type { MidnightOperator } from './adapters/midnight.js';

/** One sponsor worker per database. Persist the balanced bytes BEFORE broadcast;
 * on restart resubmit the same transaction, never create a second fee spend. */
export async function processRelayJobs(pool: Pool, operator: MidnightOperator) {
  if (!operator.prepareRelay || !operator.submitRelay) return;
  const lock = await pool.connect();
  let acquired = false;
  try {
    acquired = (await lock.query("SELECT pg_try_advisory_lock(hashtext(current_schema() || ':sns-relay')) AS locked")).rows[0].locked;
    if (!acquired) return;
    const jobs = (await pool.query(`SELECT j.*,i.prepared,i.expires_at,i.reveal_request_id,o.status AS operation_status
      FROM sns_relay_jobs j JOIN chain_intents i ON i.id=j.intent_id JOIN operations o ON o.intent_id=i.id
      WHERE j.status IN ('queued','prepared') ORDER BY j.created_at LIMIT 2`)).rows;
    for (const j of jobs) {
      try {
        if (j.operation_status === 'succeeded') {
          await pool.query("UPDATE sns_relay_jobs SET status='submitted' WHERE intent_id=$1", [j.intent_id]); continue;
        }
        if (new Date(j.expires_at).getTime() <= Date.now()) throw new Error('CONSENT_EXPIRED');
        const r = (await pool.query("SELECT status FROM reveal_requests WHERE id=$1", [j.reveal_request_id])).rows[0];
        if (r?.status !== 'awaiting_chain') throw new Error('REVEAL_NOT_READY');
        if (!j.balanced_transaction) {
          const started=Date.now();
          const prepared = await operator.prepareRelay(j.proven_transaction, j.prepared);
          await pool.query("UPDATE sns_relay_jobs SET balanced_transaction=$2,transaction_id=$3,status='prepared' WHERE intent_id=$1", [j.intent_id, prepared.transaction, prepared.transactionId]);
          console.log(JSON.stringify({metric:'sns.relay_prepare',durationMs:Date.now()-started}));
          j.balanced_transaction = prepared.transaction; j.transaction_id = prepared.transactionId;
        }
        await pool.query("UPDATE operations SET transaction_id=$2,status='submitted',updated_at=now() WHERE intent_id=$1 AND transaction_id IS NULL", [j.intent_id, j.transaction_id]);
        const submittedAt=Date.now();
        await operator.submitRelay(j.balanced_transaction);
        console.log(JSON.stringify({metric:'sns.relay_submit',durationMs:Date.now()-submittedAt}));
        await pool.query("UPDATE sns_relay_jobs SET status='submitted' WHERE intent_id=$1", [j.intent_id]);
      } catch (error) {
        // A broadcast timeout is ambiguous: keep prepared bytes and let readback/retry resolve it.
        if (j.balanced_transaction && new Date(j.expires_at).getTime() > Date.now()) continue;
        await pool.query("UPDATE sns_relay_jobs SET status='failed',failure_code='RELAY_FAILED' WHERE intent_id=$1", [j.intent_id]);
        await pool.query("UPDATE operations SET status='failed',failure_code='RELAY_FAILED',updated_at=now() WHERE intent_id=$1 AND status<>'succeeded'", [j.intent_id]);
      }
    }
  } finally {
    if (acquired) await lock.query("SELECT pg_advisory_unlock(hashtext(current_schema() || ':sns-relay'))");
    lock.release();
  }
}
