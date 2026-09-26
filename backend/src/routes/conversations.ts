import { enqueueClose, enqueue, roomChainContext, eventChain } from "../chain-context.js";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { one } from "../db.js";
import {
  router,
  result,
  need,
  fail,
  id,
  checkVersion,
  canonical,
  emit,
  limit,
  pagination,
  page,
  room,
  versionInput,
  type Ctx,
} from "../http.js";
import type { Config } from "../config.js";
import { conversation, message } from "../dto.js";
export async function closeRoom(
  c: Ctx,
  r: Record<string, any>,
  status = "closed",
) {
  await c.db.query(
    "UPDATE conversations SET status=$2,version=version+1 WHERE id=$1",
    [r.id, status],
  );
  await c.db.query(
    "UPDATE reveal_requests SET status='cancelled',version=version+1 WHERE conversation_id=$1 AND status IN ('collecting','requested','awaiting_chain','authorized','ready')",
    [r.id],
  );
  await enqueueClose(c.db, r, c.config.mode);
  for (const u of [r.a, r.b])
    await emit(c, u, "conversation.closed", r.id, r.id, r.version + 1);
}
export function conversations(
  app: FastifyInstance,
  pool: Pool,
  config: Config,
) {
  const route = router(app, pool, config),
    E = "/events/:eventId/conversations";
  const visibleStatus = (
    c: Ctx,
    r: Record<string, any>,
  ): Record<string, any> => ({
    ...r,
    status:
      r.status === "active" &&
      (c.event.status !== "open" ||
        new Date(c.event.chat_until).getTime() <= Date.now())
        ? "expired"
        : r.status,
  });
  route("GET", E, async (c) => {
    const { cursor, limit: n } = pagination(c);
    const rows = (
      await c.db.query(
        "SELECT * FROM conversations WHERE event_id=$1 AND (a=$2 OR b=$2) AND ($3::text IS NULL OR id>$3) ORDER BY id LIMIT $4",
        [c.event.id, c.uid, cursor ?? null, n + 1],
      )
    ).rows;
    const out = page(rows, n);
    return result({
      ...out,
      items: await Promise.all(
        out.items.map((r) =>
          conversation(c.db, visibleStatus(c, r), c.uid, c.revealCapabilities),
        ),
      ),
    });
  });
  route("GET", E + "/:conversationId", async (c) =>
    result(
      await conversation(
        c.db,
        visibleStatus(c, await room(c)),
        c.uid,
        c.revealCapabilities,
      ),
    ),
  );
  route("PUT", E + "/:conversationId/chain-slot", async c => {
    const r = await room(c, undefined, true);
    need(c.event.sns_reveal && c.revealCapabilities.reveal && (r.origin !== 'question_reply' || c.revealCapabilities.anonymousReveal), 409, 'FEATURE_NOT_READY');
    const { slot } = z.object({ slot: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(c.request.body);
    const context = roomChainContext(r, c.event);
    need(!r.chain_event || canonical(r.chain_event) === canonical(eventChain(c.event)), 409, 'CHAIN_SCOPE_CHANGED');
    need(!r.chain_slots[c.uid] || r.chain_slots[c.uid] === slot, 409, 'SLOT_CHANGED');
    const peer = r.a === c.uid ? r.b : r.a;
    need(r.chain_slots[peer] !== slot, 409, 'SLOTS_MUST_DIFFER');
    const slots = { ...r.chain_slots, [c.uid]: slot };
    const ready = Boolean(slots[r.a] && slots[r.b]);
    const updated = (await one(c.db, `UPDATE conversations SET chain_room_id=$2,chain_event=$3,chain_slots=$4,
      chain_preparation_status=CASE WHEN chain_preparation_status='open' THEN 'open' WHEN $5 THEN 'preparing' ELSE 'waiting' END
      WHERE id=$1 RETURNING *`, [r.id, context.roomId, JSON.stringify(eventChain(c.event)), JSON.stringify(slots), ready]))!;
    if (ready) await enqueue(c.db, c.event.id, 'open', r.id, config.mode, eventChain(c.event));
    if (!r.chain_slots[c.uid]) for (const uid of [r.a,r.b]) await emit(c,uid,'conversation.preparation_changed',r.id,r.id,r.version);
    return result(await conversation(c.db,updated,c.uid,c.revealCapabilities));
  }, { phase: 'chat', freshResponse: true });
  route("GET", E + "/:conversationId/messages", async (c) => {
    const r = visibleStatus(c, await room(c));
    need(r.status === "active");
    const q = z
      .object({
        afterSequence: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict()
      .parse(c.query);
    const rows = (
      await c.db.query(
        "SELECT * FROM messages WHERE conversation_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3",
        [r.id, q.afterSequence, q.limit + 1],
      )
    ).rows;
    const items = rows.slice(0, q.limit);
    return result({
      items: items.map((m) => message(m, c.uid)),
      nextAfterSequence: items.at(-1)?.sequence ?? q.afterSequence,
      hasMore: rows.length > q.limit,
    });
  });
  route(
    "POST",
    E + "/:conversationId/messages",
    async (c) => {
      const r = await room(c, undefined, true);
      await limit(c, "messages", 30);
      const b = z
        .object({
          clientMessageId: z.string().min(1).max(100),
          text: z.string().trim().min(1).max(2000),
        })
        .strict()
        .parse(c.request.body);
      const old = await one(
        c.db,
        "SELECT * FROM messages WHERE conversation_id=$1 AND sender_id=$2 AND client_message_id=$3",
        [r.id, c.uid, b.clientMessageId],
      );
      if (old) {
        if (old.text !== b.text) fail(409, "IDEMPOTENCY_CONFLICT");
        return result(message(old, c.uid));
      }
      const m = await one(
        c.db,
        "INSERT INTO messages(id,conversation_id,sender_id,client_message_id,sequence,text) SELECT $1,$2,$3,$4,coalesce(max(sequence),0)+1,$5 FROM messages WHERE conversation_id=$2 RETURNING *",
        [id("msg"), r.id, c.uid, b.clientMessageId, b.text],
      );
      for (const u of [r.a, r.b])
        await emit(c, u, "message.created", m!.id, r.id, m!.sequence);
      return result(message(m!, c.uid), 201);
    },
    { phase: "chat", idempotent: true },
  );
  route("PUT", E + "/:conversationId/read", async (c) => {
    const r = await room(c, undefined, true);
    const b = z
      .object({ throughSequence: z.number().int().min(0) })
      .strict()
      .parse(c.request.body);
    const last = await one(
      c.db,
      "SELECT coalesce(max(sequence),0) AS seq FROM messages WHERE conversation_id=$1",
      [r.id],
    );
    need(b.throughSequence <= last!.seq, 422, "VALIDATION_ERROR");
    const row = await one(
      c.db,
      "INSERT INTO read_states(conversation_id,participant_id,sequence) VALUES($1,$2,$3) ON CONFLICT(conversation_id,participant_id) DO UPDATE SET sequence=greatest(read_states.sequence,$3) RETURNING sequence",
      [r.id, c.uid, b.throughSequence],
    );
    return result({ throughSequence: row!.sequence });
  });
  route(
    "POST",
    E + "/:conversationId/leave",
    async (c) => {
      const b = versionInput.parse(c.request.body),
        r = await room(c);
      checkVersion(r.version, b.expectedVersion);
      if (r.status === "active") await closeRoom(c, r);
      return result(
        await conversation(c.db, await room(c), c.uid, c.revealCapabilities),
      );
    },
    { idempotent: true },
  );
}
