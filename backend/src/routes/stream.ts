import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { encodeCursor, decodeCursor } from "../cursor.js";
import { z } from "zod";
import { authenticate, need } from "../http.js";
import { one, transaction } from "../db.js";
export function stream(app: FastifyInstance, pool: Pool) {
  const stops = new Set<() => void>();
  const counts = new Map<string, number>();
  app.addHook("preClose", async () => {
    for (const stop of stops) stop();
  });
  app.get("/api/v1/events/:eventId/stream", async (req, reply) => {
    const query = z
      .object({ afterEventId: z.string().max(110).optional() })
      .strict()
      .parse(req.query);
    const p = await authenticate(pool, req);
    need(p.event_id === (req.params as { eventId: string }).eventId);
    let cursor = decodeCursor(
      String(req.headers["last-event-id"] ?? query.afterEventId ?? "0"),
      p.cursor_secret,
    );
    need(
      ["onboarding", "admission_pending", "active"].includes(
        p.admission_status,
      ),
      403,
      "ACCOUNT_SUSPENDED",
    );
    need((counts.get(p.id) ?? 0) < 3, 429, "RATE_LIMITED");
    counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      stops.delete(stop);
      counts.set(p.id, Math.max(0, (counts.get(p.id) ?? 1) - 1));
      reply.raw.end();
    };
    stops.add(stop);
    reply.raw.on("close", stop);
    reply.raw.write(": connected\n\n");
    const poll = async () => {
      if (stopped) return;
      try {
        const batch = await transaction(pool, async (db) => {
          const current = await authenticate(db, req);
          need(
            ["onboarding", "admission_pending", "active"].includes(
              current.admission_status,
            ),
            403,
            "ACCOUNT_SUSPENDED",
          );
          const event = await one(db, "SELECT * FROM events WHERE id=$1", [
            p.event_id,
          ]);
          need(event);
          const rows = (
            await db.query(
              `SELECT o.* FROM outbox o WHERE o.event_id=$1 AND o.audience=$2 AND o.sequence>$3 ORDER BY o.sequence LIMIT 100`,
              [p.event_id, p.id, cursor],
            )
          ).rows;
          const visible = [];
          for (const o of rows) {
            if (o.conversation_id) {
              const r = await one(
                db,
                "SELECT * FROM conversations WHERE id=$1 AND event_id=$2 AND (a=$3 OR b=$3)",
                [o.conversation_id, p.event_id, p.id],
              );
              if (!r) continue;
              if (
                o.kind !== "conversation.closed" &&
                (current.admission_status !== "active" ||
                  r.status !== "active" ||
                  event.status !== "open" ||
                  new Date(event.chat_until).getTime() <= Date.now())
              )
                continue;
            }
            if (o.kind.startsWith("answer.")) {
              const a = await one(
                db,
                `SELECT a.id FROM answers a WHERE a.id=$1 AND a.event_id=$2 AND (a.owner_id=$3 OR a.sender_id=$3)
        AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.event_id=$2 AND ((b.owner_id=a.owner_id AND b.target_id=a.sender_id) OR (b.owner_id=a.sender_id AND b.target_id=a.owner_id)))`,
                [o.resource_id, p.event_id, p.id],
              );
              if (!a || current.admission_status !== "active") continue;
            }
            visible.push(o);
          }
          return { visible, last: rows.at(-1)?.sequence ?? cursor };
        });
        if (stopped) return;
        for (const o of batch.visible) {
          const data = {
            resourceId: o.resource_id,
            version: o.version,
            occurredAt: o.created_at,
            ...(o.conversation_id ? { conversationId: o.conversation_id } : {}),
          };
          if (
            !reply.raw.write(
              `id: ${encodeCursor(o.sequence, p.cursor_secret)}\nevent: ${o.kind}\ndata: ${JSON.stringify(data)}\n\n`,
            )
          ) {
            stop();
            return;
          }
        }
        cursor = batch.last;
        if (!reply.raw.write(": heartbeat\n\n")) {
          stop();
          return;
        }
      } catch {
        stop();
        return;
      }
      timer = setTimeout(poll, 1000);
      timer.unref();
    };
    await poll();
  });
}
