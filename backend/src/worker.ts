export { processChainJobs } from "./chain-jobs.js";
import type { Pool, PoolClient } from "pg";
import type { MidnightAdapter, Verification } from "./adapters/midnight.js";
import { one, transaction } from "./db.js";
import { emit, canonical } from "./http.js";
export async function applyVerification(
  db: PoolClient,
  operationId: string,
  v: Verification,
) {
  const initial = await one(
    db,
    "SELECT i.event_id FROM operations o JOIN chain_intents i ON i.id=o.intent_id WHERE o.id=$1",
    [operationId],
  );
  if (!initial) return;
  const event = await one(db, "SELECT * FROM events WHERE id=$1 FOR UPDATE", [
    initial.event_id,
  ]);
  const o = await one(
    db,
    "SELECT o.*,i.binding,i.binding_hash,i.prepared,i.expires_at,i.purpose,i.reveal_request_id FROM operations o JOIN chain_intents i ON i.id=o.intent_id WHERE o.id=$1 FOR UPDATE OF o",
    [operationId],
  );
  if (!o || !["submitted", "confirming", "reconciling"].includes(o.status))
    return;
  const currentScope = {
    network: event!.midnight_network,
    contractAddress: event!.midnight_contract_address,
    eventScope: event!.midnight_event_scope,
  };
  let status: string = v.status,
    code: string | null = "reasonCode" in v ? (v.reasonCode ?? null) : null,
    applied = false;
  if (new Date(o.expires_at).getTime() <= Date.now()) {
    status = "expired";
    code = "EXPIRED";
  } else if (v.status === "succeeded") {
    if (
      v.bindingHash !== o.binding_hash ||
      v.network !== o.prepared.network ||
      v.contractAddress !== o.prepared.contractAddress ||
      v.purpose !== o.purpose ||
      !v.evidenceRef ||
      o.prepared.network !== currentScope.network ||
      o.prepared.contractAddress !== currentScope.contractAddress
    ) {
      status = "failed";
      code = "INVALID_BINDING";
    } else {
      const p = await one(db, "SELECT * FROM participants WHERE id=$1", [
        o.owner_id,
      ]);
      const currentKey =
        p &&
        p.device_public_key === o.binding.devicePublicKey &&
        p.device_key_version === o.binding.deviceKeyVersion;
      if (!currentKey) {
        status = "failed";
        code = "INVALID_BINDING";
      } else if (o.purpose === "admission") {
        if (
          p!.ticket_status !== "issued" ||
          !p!.ticket_event ||
          canonical(p!.ticket_event) !== canonical(currentScope) ||
          event!.status !== "open" ||
          new Date(event!.join_until).getTime() <= Date.now() ||
          !["onboarding", "admission_pending"].includes(p!.admission_status)
        ) {
          status = "failed";
          code = "EXPIRED";
        } else {
          await db.query(
            "UPDATE participants SET admission_status='active' WHERE id=$1",
            [o.owner_id],
          );
          applied = true;
        }
      } else {
        const r = await one(
          db,
          "SELECT r.*,c.status AS room_status FROM reveal_requests r JOIN conversations c ON c.id=r.conversation_id WHERE r.id=$1 FOR UPDATE OF r",
          [o.reveal_request_id],
        );
        const peers = r
          ? await one(
              db,
              "SELECT count(*)::int AS n FROM participants WHERE id=ANY($1::text[]) AND event_id=$2 AND admission_status='active'",
              [[r.a, r.b], event!.id],
            )
          : undefined;
        if (
          !r ||
          !r.chain_event ||
          canonical(r.chain_event) !== canonical(currentScope) ||
          peers?.n !== 2 ||
          !["awaiting_chain", "authorized"].includes(r.status) ||
          r.room_status !== "active" ||
          new Date(r.expires_at).getTime() <= Date.now() ||
          new Date(event!.chat_until).getTime() <= Date.now() ||
          event!.status !== "open" ||
          r.decisions[o.owner_id] !== "accepted" ||
          r.transcript_hash !== o.binding.transcriptHash
        ) {
          status = "failed";
          code = "EXPIRED";
        } else {
          const verified = { ...r.verified, [o.owner_id]: true };
          await db.query(
            "UPDATE reveal_requests SET verified=$2,status=$3,version=version+1 WHERE id=$1",
            [
              r.id,
              JSON.stringify(verified),
              verified[r.a] && verified[r.b] ? "authorized" : "awaiting_chain",
            ],
          );
          applied = true;
          for (const u of [r.a, r.b])
            await emit(
              { db, event: event! },
              u,
              "reveal.status_changed",
              r.id,
              r.conversation_id,
              r.version + 1,
            );
        }
      }
    }
  }
  if (applied) {
    await db.query(
      "INSERT INTO processed_effects(binding_hash,operation_id,evidence_ref) VALUES($1,$2,$3)",
      [
        o.binding_hash,
        o.id,
        (v as Extract<Verification, { status: "succeeded" }>).evidenceRef,
      ],
    );
  }
  if (status === "pending") status = "confirming";
  await db.query(
    "UPDATE operations SET status=$2,failure_code=$3,effect_applied=$4,evidence_ref=$5,updated_at=now() WHERE id=$1",
    [
      o.id,
      status,
      code,
      applied,
      v.status === "succeeded" ? v.evidenceRef : null,
    ],
  );
  await emit({ db, event: event! }, o.owner_id, "operation.updated", o.id);
}
export async function reconcile(pool: Pool, adapter: MidnightAdapter) {
  const rows = (
    await pool.query(
      "SELECT o.*,i.purpose,i.binding_hash,i.prepared,i.expires_at FROM operations o JOIN chain_intents i ON i.id=o.intent_id WHERE o.status IN ('submitted','confirming','reconciling') AND i.mode=$1 ORDER BY o.updated_at LIMIT 50",
      [adapter.mode],
    )
  ).rows;
  for (const o of rows) {
    let verdict: Verification;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      verdict = await Promise.race([
        adapter.verify({
          ...o.prepared,
          intentId: o.intent_id,
          purpose: o.purpose,
          bindingHash: o.binding_hash,
          expiresAt: new Date(o.expires_at).toISOString(),
          transactionId: o.transaction_id,
        }),
        new Promise<Verification>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                status: "reconciling",
                reasonCode: "VERIFIER_TIMEOUT",
              }),
            10000,
          );
          timer.unref();
        }),
      ]);
    } catch {
      verdict = { status: "reconciling", reasonCode: "VERIFIER_UNAVAILABLE" };
    } finally {
      clearTimeout(timer);
    }
    await transaction(pool, (db) => applyVerification(db, o.id, verdict));
  }
  return rows.length;
}

/** Permission checks also run in each route: scheduler delays never extend access. */
export async function maintain(pool: Pool) {
  const events = (await pool.query("SELECT id FROM events")).rows;
  for (const eventId of events)
    await transaction(pool, async (db) => {
      const event = (await one(
        db,
        "SELECT * FROM events WHERE id=$1 FOR UPDATE",
        [eventId.id],
      ))!;
      const expired = (
        await db.query(
          `UPDATE operations o SET status='expired',failure_code='EXPIRED',updated_at=now()
   FROM chain_intents i WHERE i.id=o.intent_id AND i.event_id=$1 AND i.expires_at<=now()
   AND o.status IN ('awaiting_submission','submitted','confirming','reconciling') RETURNING o.*`,
          [event.id],
        )
      ).rows;
      for (const o of expired)
        await emit({ db, event }, o.owner_id, "operation.updated", o.id);
      const reveals = (
        await db.query(
          `UPDATE reveal_requests SET status='expired',version=version+1 WHERE event_id=$1 AND status IN ('collecting','requested','awaiting_chain','authorized','ready') AND (expires_at<=now() OR $2<>'open' OR $3<=now()) RETURNING *`,
          [event.id, event.status, event.chat_until],
        )
      ).rows;
      for (const r of reveals)
        for (const u of [r.a, r.b])
          await emit(
            { db, event },
            u,
            "reveal.status_changed",
            r.id,
            r.conversation_id,
            r.version,
          );
      if (
        event.status !== "open" ||
        new Date(event.discover_until).getTime() <= Date.now()
      ) {
        const answers = (
          await db.query(
            "UPDATE answers SET status='expired',version=version+1 WHERE event_id=$1 AND status='pending' RETURNING *",
            [event.id],
          )
        ).rows;
        for (const a of answers)
          for (const u of [a.owner_id, a.sender_id])
            await emit(
              { db, event },
              u,
              "answer.status_changed",
              a.id,
              null,
              a.version,
            );
      }
      if (
        event.status !== "open" ||
        new Date(event.chat_until).getTime() <= Date.now()
      ) {
        const rooms = (
          await db.query(
            "UPDATE conversations SET status='expired',version=version+1 WHERE event_id=$1 AND status='active' RETURNING *",
            [event.id],
          )
        ).rows;
        for (const r of rooms)
          for (const u of [r.a, r.b])
            await emit(
              { db, event },
              u,
              "conversation.closed",
              r.id,
              r.id,
              r.version,
            );
      }
    });
  await pool.query(
    // Three 120-second Gemini attempts can outlive the old five-minute stale threshold.
    "UPDATE ai_jobs SET status='failed',failure_code='PROCESS_INTERRUPTED',cleanup_status='service_cleaned' WHERE status='processing' AND created_at<now()-interval '15 minutes'",
  );
  // Only operational records have fixed retention. Product and report deletion policy is external.
  await pool.query("DELETE FROM sessions WHERE expires_at<=now()");
  await pool.query(
    "DELETE FROM rate_buckets WHERE window_start<now()-interval '2 days'",
  );
  await pool.query(
    "DELETE FROM idempotency WHERE created_at<now()-interval '24 hours'",
  );
}
