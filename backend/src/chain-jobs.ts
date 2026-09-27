import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { one, transaction, type Db, type Row } from "./db.js";
import { blocked, canonical, emit, providerCall } from "./http.js";
import { enqueueClose, eventChain } from "./chain-context.js";
import type { MidnightAdapter, MidnightOperator } from "./adapters/midnight.js";
const live = [
  "collecting",
  "requested",
  "awaiting_chain",
  "authorized",
  "ready",
];
async function webOpen(db: Db, c: Row, e: Row) {
  if (
    c.status !== "active" ||
    e.status !== "open" ||
    new Date(e.chat_until).getTime() <= Date.now()
  )
    return false;
  const peers = await one(
    db,
    "SELECT count(*)::int AS n FROM participants WHERE id=ANY($1::text[]) AND admission_status='active'",
    [[c.a, c.b]],
  );
  return peers?.n === 2 && !(await blocked(db, c.event_id, c.a, c.b));
}
async function currentRequest(db: Db, r: Row, e: Row, c: Row) {
  if (
    !(await webOpen(db, c, e)) ||
    new Date(r.expires_at).getTime() <= Date.now()
  )
    return false;
  if (canonical(eventChain(e)) !== canonical(r.chain_event)) return false;
  const peers = (
    await db.query("SELECT * FROM participants WHERE id=ANY($1::text[])", [
      [r.a, r.b],
    ])
  ).rows;
  return (
    peers.length === 2 &&
    peers.every(
      (p) =>
        p.contact_version === (p.id === r.a ? r.a_contact : r.b_contact) &&
        p.device_key_version === (p.id === r.a ? r.a_key : r.b_key),
    )
  );
}
async function notify(db: PoolClient, e: Row, r: Row) {
  for (const u of [r.a, r.b])
    await emit(
      { db, event: e },
      u,
      "reveal.status_changed",
      r.id,
      r.conversation_id,
      r.version,
    );
}
async function cancel(db: PoolClient, e: Row, r: Row) {
  if (!live.includes(r.status)) return;
  const updated = (await one(
    db,
    "UPDATE reveal_requests SET status='cancelled',version=version+1 WHERE id=$1 RETURNING *",
    [r.id],
  ))!;
  await notify(db, e, updated);
}
/** Also catches externally applied suspension, expiry and a close that raced an in-flight open. */
export async function queueClosedRooms(pool: Pool, mode: "real" | "demo") {
  const rows = (
    await pool.query(
      "SELECT * FROM conversations WHERE chain_room_id IS NOT NULL",
    )
  ).rows;
  for (const c of rows) {
    await transaction(pool, async (db) => {
      const e = (await one(db, "SELECT * FROM events WHERE id=$1 FOR UPDATE", [
        c.event_id,
      ]))!;
      const fresh = (await one(db, "SELECT * FROM conversations WHERE id=$1", [
        c.id,
      ]))!;
      if (await webOpen(db, fresh, e)) return;
      await enqueueClose(db, fresh, mode);
      const rs = (
        await db.query(
          "SELECT * FROM reveal_requests WHERE conversation_id=$1 AND status=ANY($2::text[])",
          [c.id, live],
        )
      ).rows;
      for (const r of rs) await cancel(db, e, r);
    });
  }
}
async function ticket(pool: Pool, j: Row, operator: MidnightOperator) {
  const p = await one(pool, "SELECT * FROM participants WHERE id=$1", [
    j.resource_id,
  ]);
  const e = (await one(pool, "SELECT * FROM events WHERE id=$1", [
    j.event_id,
  ]))!;
  if (
    !p ||
    !["onboarding", "admission_pending"].includes(p.admission_status) ||
    e.status !== "open" ||
    new Date(e.join_until).getTime() <= Date.now()
  ) {
    await transaction(pool, async (db) => {
      const event = (await one(
        db,
        "SELECT * FROM events WHERE id=$1 FOR UPDATE",
        [j.event_id],
      ))!;
      const failed = await one(
        db,
        "UPDATE participants SET ticket_status='failed' WHERE id=$1 AND ticket_status<>'issued' RETURNING id",
        [j.resource_id],
      );
      if (failed)
        await emit(
          { db, event },
          failed.id,
          "ticket.status_changed",
          failed.id,
        );
    });
    return;
  }
  if (canonical(eventChain(e)) !== canonical(j.chain_event))
    throw new Error("SCOPE_CHANGED");
  if (!(await operator.isTicketIssued(j.chain_event, p.ticket_leaf))) {
    const tx = await operator.issueTicket(j.chain_event, p.ticket_leaf);
    await pool.query("UPDATE chain_jobs SET transaction_id=$2 WHERE id=$1", [
      j.id,
      tx.transactionId,
    ]);
  }
  if (!(await operator.isTicketIssued(j.chain_event, p.ticket_leaf)))
    throw new Error("NOT_CONFIRMED");
  await transaction(pool, async (db) => {
    const event = (await one(
      db,
      "SELECT * FROM events WHERE id=$1 FOR UPDATE",
      [j.event_id],
    ))!;
    if (canonical(eventChain(event)) !== canonical(j.chain_event))
      throw new Error("SCOPE_CHANGED");
    const updated = await one(
      db,
      "UPDATE participants SET ticket_status='issued' WHERE id=$1 AND ticket_leaf=$2 AND admission_status IN ('onboarding','admission_pending') RETURNING *",
      [p.id, p.ticket_leaf],
    );
    if (updated) await emit({ db, event }, p.id, "ticket.status_changed", p.id);
  });
}
async function open(pool: Pool, j: Row, operator: MidnightOperator) {
  const c = await one(pool, 'SELECT * FROM conversations WHERE id=$1', [j.resource_id]);
  const e = (await one(pool, 'SELECT * FROM events WHERE id=$1', [j.event_id]))!;
  if (!c?.chain_room_id || !(await webOpen(pool,c,e))) return;
  if (canonical(eventChain(e)) !== canonical(j.chain_event)) throw new Error('SCOPE_CHANGED');
  const a=c.chain_slots[c.a], b=c.chain_slots[c.b];
  if (!a || !b) throw new Error('SLOTS_MISSING');
  let state=await operator.roomState(j.chain_event,c.chain_room_id);
  if (state==='absent') {
    const started=Date.now();
    const tx=await operator.openRoom(j.chain_event,{roomId:c.chain_room_id,slotA:a,slotB:b,expiresAt:new Date(Math.floor(new Date(e.chat_until).getTime()/1000)*1000).toISOString()});
    await pool.query('UPDATE chain_jobs SET transaction_id=$2 WHERE id=$1',[j.id,tx.transactionId]);
    console.log(JSON.stringify({metric:'sns.room_open',durationMs:Date.now()-started}));
    state=await operator.roomState(j.chain_event,c.chain_room_id);
  }
  if (state==='absent') throw new Error('NOT_CONFIRMED');
  await transaction(pool,async db=>{
    const event=(await one(db,'SELECT * FROM events WHERE id=$1 FOR UPDATE',[e.id]))!;
    const fresh=(await one(db,'SELECT * FROM conversations WHERE id=$1',[c.id]))!;
    if (!(await webOpen(db,fresh,event))) {await enqueueClose(db,fresh,j.mode);return;}
    if(fresh.chain_preparation_status!==state){
      await db.query('UPDATE conversations SET chain_preparation_status=$2 WHERE id=$1',[c.id,state]);
      for(const uid of [c.a,c.b]) await emit({db,event},uid,'conversation.preparation_changed',c.id,c.id,fresh.version);
    }
  });
}
async function terms(
  pool: Pool,
  j: Row,
  adapter: MidnightAdapter,
  operator: MidnightOperator,
) {
  const r = await one(pool, "SELECT * FROM reveal_requests WHERE id=$1", [
    j.resource_id,
  ]);
  if (!r || r.status !== "collecting") return;
  const c = (await one(pool, "SELECT * FROM conversations WHERE id=$1", [
    r.conversation_id,
  ]))!;
  const e = (await one(pool, "SELECT * FROM events WHERE id=$1", [
    j.event_id,
  ]))!;
  if (
    !adapter.capabilities.reveal ||
    (c.origin === "question_reply" && !adapter.capabilities.anonymousReveal)
  )
    throw new Error("FEATURE_NOT_READY");
  if (!(await currentRequest(pool, r, e, c))) {
    await transaction(pool, async (db) => {
      const ev = (await one(db, "SELECT * FROM events WHERE id=$1 FOR UPDATE", [
        e.id,
      ]))!;
      await cancel(db, ev, r);
    });
    return;
  }
  const a = r.room_material[r.a],
    b = r.room_material[r.b];
  if (!a || !b) throw new Error("MATERIAL_MISSING");
  let state = await operator.roomState(j.chain_event, c.chain_room_id);
  if (state === "absent") {
    const tx = await operator.openRoom(j.chain_event, {
      roomId: c.chain_room_id,
      slotA: a.slot,
      slotB: b.slot,
      expiresAt: new Date(
        Math.floor(new Date(e.chat_until).getTime() / 1000) * 1000,
      ).toISOString(),
    });
    await pool.query("UPDATE chain_jobs SET transaction_id=$2 WHERE id=$1", [
      j.id,
      tx.transactionId,
    ]);
    state = await operator.roomState(j.chain_event, c.chain_room_id);
  }
  if (state === "absent") throw new Error("NOT_CONFIRMED");
  const result =
    state === "open"
      ? z
          .object({
            transcriptHash: z.string().regex(/^[a-f0-9]{64}$/),
            terms: z
              .string()
              .min(1)
              .max(16384)
              .regex(/^[A-Za-z0-9_-]+$/),
          })
          .strict()
          .parse(
            await providerCall(() =>
              adapter.revealTerms({
                event: j.chain_event,
                roomId: c.chain_room_id,
                slots: [a.slot, b.slot],
                keyCommits: [a.keyCommit, b.keyCommit],
                contactCommits: [a.contactCommit, b.contactCommit],
                expiresAt: new Date(r.expires_at).toISOString(),
                policyVersion: r.policy_version,
              }),
            ),
          )
      : null;
  await transaction(pool, async (db) => {
    const ev = (await one(db, "SELECT * FROM events WHERE id=$1 FOR UPDATE", [
      e.id,
    ]))!;
    const fresh = (await one(db, "SELECT * FROM reveal_requests WHERE id=$1", [
      r.id,
    ]))!;
    const room = (await one(db, "SELECT * FROM conversations WHERE id=$1", [
      c.id,
    ]))!;
    if (!(await webOpen(db, room, ev))) await enqueueClose(db, room, j.mode);
    if (!result || !(await currentRequest(db, fresh, ev, room))) {
      await cancel(db, ev, fresh);
      return;
    }
    if (fresh.status !== "collecting") return;
    const keys = [a, b].map((m) => ({
      publicKey: m.roomPublicKey,
      version: 1,
      keyCommit: m.keyCommit,
    }));
    const updated = (await one(
      db,
      "UPDATE reveal_requests SET transcript_hash=$2,transcript_payload=$3,key_material=$4,status=$5,version=version+1 WHERE id=$1 RETURNING *",
      [r.id, result.transcriptHash, result.terms, JSON.stringify(keys), fresh.decisions[fresh.a] === "accepted" && fresh.decisions[fresh.b] === "accepted" ? "awaiting_chain" : "requested"],
    ))!;
    await notify(db, ev, updated);
  });
}
async function close(pool: Pool, j: Row, operator: MidnightOperator) {
  const c = await one(pool, "SELECT * FROM conversations WHERE id=$1", [
    j.resource_id,
  ]);
  if (!c?.chain_room_id) return;
  const state = await operator.roomState(j.chain_event, c.chain_room_id);
  if (state === "open") {
    const tx = await operator.closeRoom(j.chain_event, c.chain_room_id);
    await pool.query("UPDATE chain_jobs SET transaction_id=$2 WHERE id=$1", [
      j.id,
      tx.transactionId,
    ]);
    if ((await operator.roomState(j.chain_event, c.chain_room_id)) === "open")
      throw new Error("NOT_CONFIRMED");
  }
}
/** Release retries never fabricate a chain approval. External read happens before the final locked recheck. */
export async function releaseReady(pool: Pool, adapter: MidnightAdapter) {
  if (!adapter.capabilities.reveal) return;
  const rs = (
    await pool.query(
      "SELECT * FROM reveal_requests WHERE status='authorized' AND mode=$1 AND envelopes ? a AND envelopes ? b",
      [adapter.mode],
    )
  ).rows;
  for (const r of rs) {
    let status;
    try {
      status = await providerCall(() =>
        adapter.revealStatus(r.chain_event, r.transcript_hash),
      );
    } catch {
      continue;
    }
    if (!["authorized", "closed"].includes(status)) continue;
    await transaction(pool, async (db) => {
      const e = (await one(db, "SELECT * FROM events WHERE id=$1 FOR UPDATE", [
        r.event_id,
      ]))!;
      const fresh = (await one(
        db,
        "SELECT * FROM reveal_requests WHERE id=$1",
        [r.id],
      ))!;
      const c = (await one(db, "SELECT * FROM conversations WHERE id=$1", [
        r.conversation_id,
      ]))!;
      if (fresh.status !== "authorized" || fresh.version !== r.version) return;
      if (status === "closed" || !(await currentRequest(db, fresh, e, c))) {
        await cancel(db, e, fresh);
        return;
      }
      if (
        !fresh.verified[fresh.a] ||
        !fresh.verified[fresh.b] ||
        !fresh.envelopes[fresh.a] ||
        !fresh.envelopes[fresh.b] ||
        (c.origin === "question_reply" && !adapter.capabilities.anonymousReveal)
      )
        return;
      const updated = (await one(
        db,
        "UPDATE reveal_requests SET status='released',version=version+1 WHERE id=$1 RETURNING *",
        [r.id],
      ))!;
      await notify(db, e, updated);
    });
  }
}
/** Single operator lane across processes. No long chain call holds an event/row transaction lock.
 * Await mutations to settlement; a Promise timeout cannot cancel a submitted chain transaction.
 * On crash the DB session lock is released; retry MUST read back the effect before resubmitting.
 */
export async function processChainJobs(
  pool: Pool,
  adapter: MidnightAdapter,
  operator: MidnightOperator,
) {
  if (operator.mode !== adapter.mode) throw new Error("OPERATOR_MODE_MISMATCH");
  const lane = await pool.connect();
  let locked = false;
  try {
    locked = (await one(
      lane,
      "SELECT pg_try_advisory_lock(hashtext(current_schema() || ':zkiss:operator')) AS locked",
    ))!.locked;
    if (!locked) return;
    await queueClosedRooms(pool, adapter.mode);
    const jobs = (
      await pool.query(
        "SELECT * FROM chain_jobs WHERE status='pending' AND mode=$1 AND next_attempt_at<=now() ORDER BY CASE kind WHEN 'close' THEN 0 ELSE 1 END,id LIMIT 25",
        [adapter.mode],
      )
    ).rows;
    for (const j of jobs) {
      try {
        if (j.kind === "ticket") await ticket(pool, j, operator);
        else if (j.kind === "open") await open(pool, j, operator);
        else if (j.kind === "terms") await terms(pool, j, adapter, operator);
        else await close(pool, j, operator);
        await pool.query(
          "UPDATE chain_jobs SET status='done',failure_code=NULL WHERE id=$1",
          [j.id],
        );
      } catch {
        await pool.query(
          "UPDATE chain_jobs SET attempts=attempts+1,failure_code='CHAIN_JOB_RETRY',next_attempt_at=now()+(least(60,power(2,least(attempts,6)))*interval '1 second') WHERE id=$1",
          [j.id],
        );
        if (j.kind === "ticket")
          await transaction(pool, async (db) => {
            const event = (await one(
              db,
              "SELECT * FROM events WHERE id=$1 FOR UPDATE",
              [j.event_id],
            ))!;
            const p = await one(
              db,
              "UPDATE participants SET ticket_status='failed' WHERE id=$1 AND ticket_status<>'issued' RETURNING id",
              [j.resource_id],
            );
            if (p)
              await emit({ db, event }, p.id, "ticket.status_changed", p.id);
          });
      }
    }
    await releaseReady(pool, adapter);
  } finally {
    if (locked)
      await lane.query(
        "SELECT pg_advisory_unlock(hashtext(current_schema() || ':zkiss:operator'))",
      );
    lane.release();
  }
}
