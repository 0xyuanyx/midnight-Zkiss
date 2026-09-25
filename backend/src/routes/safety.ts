import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { one } from "../db.js";
import { router, result, need, id, blocked, room, type Ctx } from "../http.js";
import type { Config } from "../config.js";
import { closeRoom } from "./conversations.js";
const context = {
  contextType: z.enum(["profile", "answer", "conversation"]),
  contextId: z.string().min(1).max(200),
};
async function target(c: Ctx, b: { contextType: string; contextId: string }) {
  if (b.contextType === "conversation") {
    const r = await room(c, b.contextId);
    return r.a === c.uid ? r.b : r.a;
  }
  if (b.contextType === "answer") {
    const a = await one(
      c.db,
      "SELECT * FROM answers WHERE id=$1 AND event_id=$2 AND (owner_id=$3 OR sender_id=$3)",
      [b.contextId, c.event.id, c.uid],
    );
    need(a);
    return a.owner_id === c.uid ? a.sender_id : a.owner_id;
  }
  const p = await one(
    c.db,
    "SELECT * FROM participants WHERE id=$1 AND event_id=$2 AND profile_status='published'",
    [b.contextId, c.event.id],
  );
  need(p && p.id !== c.uid);
  return p!.id;
}
export function safety(app: FastifyInstance, pool: Pool, config: Config) {
  const route = router(app, pool, config),
    E = "/events/:eventId";
  route(
    "POST",
    E + "/blocks",
    async (c) => {
      const b = z.object(context).strict().parse(c.request.body);
      const peer = await target(c, b);
      await c.db.query(
        "INSERT INTO blocks(event_id,owner_id,target_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [c.event.id, c.uid, peer],
      );
      const rooms = (
        await c.db.query(
          "SELECT * FROM conversations WHERE event_id=$1 AND status='active' AND ((a=$2 AND b=$3) OR (a=$3 AND b=$2))",
          [c.event.id, c.uid, peer],
        )
      ).rows;
      for (const r of rooms) await closeRoom(c, r, "blocked");
      await c.db.query(
        "UPDATE answers SET status='expired',version=version+1 WHERE event_id=$1 AND status='pending' AND ((owner_id=$2 AND sender_id=$3) OR (owner_id=$3 AND sender_id=$2))",
        [c.event.id, c.uid, peer],
      );
      return result(null, 204);
    },
    { idempotent: true },
  );
  route(
    "POST",
    E + "/reports",
    async (c) => {
      const b = z
        .object({
          ...context,
          reason: z.enum(["harassment", "spam", "impersonation", "other"]),
          detail: z.string().max(1000).optional(),
          evidenceMessageIds: z
            .array(z.string().min(1).max(200))
            .max(20)
            .optional(),
        })
        .strict()
        .parse(c.request.body);
      await target(c, b);
      const ids = b.evidenceMessageIds ?? [];
      if (ids.length) {
        need(b.contextType === "conversation", 422, "VALIDATION_ERROR");
        const count = await one(
          c.db,
          "SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND id=ANY($2::text[])",
          [b.contextId, ids],
        );
        need(count!.n === new Set(ids).size, 404);
      }
      const r = await one(
        c.db,
        "INSERT INTO reports(id,event_id,reporter_id,context_type,context_id,reason,detail,evidence_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,created_at",
        [
          id("report"),
          c.event.id,
          c.uid,
          b.contextType,
          b.contextId,
          b.reason,
          b.detail ?? null,
          JSON.stringify(ids),
        ],
      );
      return result({ id: r!.id, createdAt: r!.created_at }, 201);
    },
    { idempotent: true },
  );
}
