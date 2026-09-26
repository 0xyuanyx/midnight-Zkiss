import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { one, type Row } from "../db.js";
import {
  router,
  result,
  need,
  fail,
  id,
  hash,
  checkVersion,
  blocked,
  emit,
  limit,
  pagination,
  page,
  type Ctx,
} from "../http.js";
import type { Config } from "../config.js";
import { conversation, publicProfile } from "../dto.js";
function mode(c: Ctx, name: string) {
  need(c.event.modes.includes(name), 409, "FEATURE_DISABLED");
}
export async function newRoom(
  c: Ctx,
  a: string,
  b: string,
  origin: string,
  key: string,
  alias: string,
) {
  const existing = await one(
    c.db,
    "SELECT * FROM conversations WHERE event_id=$1 AND origin=$2 AND origin_key=$3",
    [c.event.id, origin, key],
  );
  if (existing) return existing;
  const r = (await one(
    c.db,
    "INSERT INTO conversations(id,event_id,a,b,origin,origin_key,alias) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
    [id("room"), c.event.id, a, b, origin, key, alias],
  ))!;
  for (const u of [a, b]) await emit(c, u, "conversation.created", r.id, r.id);
  return r;
}
const question = (q: Row) => ({
  id: q.id,
  body: q.text,
  version: q.version,
  status: q.status === "published" ? "open" : "closed",
  createdAt: q.created_at,
});
async function answerDto(c: Ctx, a: Row, received: boolean) {
  const base = {
    id: a.id,
    question: {
      id: a.question_id,
      body: a.question_text,
      version: a.question_version,
    },
    body: a.text,
    status:
      a.status === "pending" &&
      new Date(c.event.discover_until).getTime() <= Date.now()
        ? "expired"
        : a.status,
    version: a.version,
    createdAt: a.created_at,
    expiresAt: c.event.discover_until,
    conversationId: a.conversation_id,
  };
  return received
    ? { ...base, anonymousLabel: a.alias }
    : {
        ...base,
        target: publicProfile(
          (await one(c.db, "SELECT * FROM participants WHERE id=$1", [
            a.owner_id,
          ]))!,
        ),
      };
}
export function connections(app: FastifyInstance, pool: Pool, config: Config) {
  const route = router(app, pool, config),
    E = "/events/:eventId";
  route(
    "POST",
    E + "/likes",
    async (c) => {
      mode(c, "mutual_like");
      await limit(c, "likes", 10);
      const b = z
        .object({ targetProfileId: z.string().min(1).max(200) })
        .strict()
        .parse(c.request.body);
      need(b.targetProfileId !== c.uid, 422, "CANNOT_LIKE_SELF");
      const peer = await one(
        c.db,
        "SELECT * FROM participants WHERE id=$1 AND event_id=$2 AND admission_status='active' AND profile_status='published'",
        [b.targetProfileId, c.event.id],
      );
      need(peer);
      need(c.p.profile_status === "published", 409, "PROFILE_REQUIRED");
      need(!(await blocked(c.db, c.event.id, c.uid, peer.id)));
      await c.db.query(
        "INSERT INTO likes(event_id,sender_id,recipient_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [c.event.id, c.uid, peer.id],
      );
      const mutual = await one(
        c.db,
        "SELECT 1 FROM likes WHERE event_id=$1 AND sender_id=$2 AND recipient_id=$3",
        [c.event.id, peer.id, c.uid],
      );
      const pair = [c.uid, peer.id].sort();
      const r = mutual
        ? await newRoom(c, pair[0], pair[1], "mutual_like", pair.join("|"), "")
        : null;
      return result({
        id: hash(`${c.event.id}:${c.uid}:${peer.id}`),
        state: r ? "matched" : "sent",
        conversationId: r?.id ?? null,
      });
    },
    { phase: "discover", idempotent: true },
  );
  route("GET", E + "/me/likes", async (c) => {
    mode(c, "mutual_like");
    const { cursor, limit: n } = pagination(c);
    const direction = z.enum(["sent", "received"]).default("sent").parse(c.query.direction);
    const received = direction === "received";
    const rows = (
      await c.db.query(
        `SELECT p.*,l.created_at AS liked_at FROM likes l JOIN participants p ON p.id=l.${received ? "sender_id" : "recipient_id"} WHERE l.event_id=$1 AND l.${received ? "recipient_id" : "sender_id"}=$2 AND p.profile_status='published' AND p.admission_status='active' AND ($3::text IS NULL OR p.id>$3) AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.event_id=$1 AND ((b.owner_id=$2 AND b.target_id=p.id) OR (b.target_id=$2 AND b.owner_id=p.id))) ORDER BY p.id LIMIT $4`,
        [c.event.id, c.uid, cursor ?? null, n + 1],
      )
    ).rows;
    const out = page(rows, n),
      items = [];
    for (const p of out.items) {
      const r = await one(
        c.db,
        "SELECT id FROM conversations WHERE event_id=$1 AND origin='mutual_like' AND origin_key=$2",
        [c.event.id, [c.uid, p.id].sort().join("|")],
      );
      items.push({
        id: p.id,
        ...(received ? { source: publicProfile(p) } : { target: publicProfile(p) }),
        state: r ? "matched" : received ? "received" : "sent",
        conversationId: r?.id ?? null,
        createdAt: p.liked_at,
      });
    }
    return result({ ...out, items });
  });
  route("GET", E + "/me/question", async (c) => {
    mode(c, "question_reply");
    const q = await one(
      c.db,
      "SELECT * FROM questions WHERE owner_id=$1 AND status='published'",
      [c.uid],
    );
    return result(q ? question(q) : null);
  });
  route(
    "PUT",
    E + "/me/question",
    async (c) => {
      mode(c, "question_reply");
      need(c.p.profile_status === "published", 409, "PROFILE_REQUIRED");
      const b = z
        .object({
          expectedVersion: z.number().int().min(0),
          body: z.string().trim().min(1).max(200),
        })
        .strict()
        .parse(c.request.body);
      const old = await one(c.db, "SELECT * FROM questions WHERE owner_id=$1", [
        c.uid,
      ]);
      checkVersion(old?.version ?? 0, b.expectedVersion);
      const q = await one(
        c.db,
        "INSERT INTO questions(id,event_id,owner_id,text) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id) DO UPDATE SET text=$4,status='published',version=questions.version+1 RETURNING *",
        [id("q"), c.event.id, c.uid, b.body],
      );
      return result(question(q!));
    },
    { phase: "discover" },
  );
  route("DELETE", E + "/me/question", async (c) => {
    mode(c, "question_reply");
    const v = z.coerce.number().int().positive().parse(c.query.version);
    const q = await one(c.db, "SELECT * FROM questions WHERE owner_id=$1", [
      c.uid,
    ]);
    need(q);
    checkVersion(q.version, v);
    await c.db.query(
      "UPDATE questions SET status='closed',version=version+1 WHERE id=$1",
      [q.id],
    );
    return result(null, 204);
  });
  route(
    "POST",
    E + "/questions/:questionId/answers",
    async (c) => {
      mode(c, "question_reply");
      await limit(c, "answers", 5);
      const b = z
        .object({
          expectedQuestionVersion: z.number().int().positive(),
          body: z.string().trim().min(1).max(500),
        })
        .strict()
        .parse(c.request.body);
      const q = await one(
        c.db,
        "SELECT q.* FROM questions q JOIN participants p ON p.id=q.owner_id WHERE q.id=$1 AND q.event_id=$2 AND q.status='published' AND p.profile_status='published' AND p.admission_status='active'",
        [c.params.questionId, c.event.id],
      );
      need(q);
      need(q.owner_id !== c.uid, 422, "CANNOT_ANSWER_SELF");
      need(!(await blocked(c.db, c.event.id, c.uid, q.owner_id)));
      checkVersion(q.version, b.expectedQuestionVersion);
      need(
        !(await one(
          c.db,
          "SELECT 1 FROM answers WHERE question_id=$1 AND sender_id=$2",
          [q.id, c.uid],
        )),
        409,
        "ALREADY_ANSWERED",
      );
      const a = await one(
        c.db,
        "INSERT INTO answers(id,event_id,question_id,owner_id,sender_id,question_version,question_text,text,alias) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [
          id("answer"),
          c.event.id,
          q.id,
          q.owner_id,
          c.uid,
          q.version,
          q.text,
          b.body,
          "익명 " + id("alias").slice(-8),
        ],
      );
      await emit(c, q.owner_id, "answer.received", a!.id);
      await emit(c, c.uid, "answer.status_changed", a!.id);
      return result(await answerDto(c, a!, false), 201);
    },
    { phase: "discover", idempotent: true },
  );
  route("GET", E + "/me/answers", async (c) => {
    mode(c, "question_reply");
    const direction = z.enum(["sent", "received"]).parse(c.query.direction);
    const { cursor, limit: n } = pagination(c);
    const rows = (
      await c.db.query(
        `SELECT a.* FROM answers a WHERE a.event_id=$1 AND a.${direction === "sent" ? "sender_id" : "owner_id"}=$2 AND ($3::text IS NULL OR a.id>$3) AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.event_id=$1 AND ((b.owner_id=a.owner_id AND b.target_id=a.sender_id) OR (b.target_id=a.owner_id AND b.owner_id=a.sender_id))) ORDER BY a.id LIMIT $4`,
        [c.event.id, c.uid, cursor ?? null, n + 1],
      )
    ).rows;
    const out = page(rows, n);
    return result({
      ...out,
      items: await Promise.all(
        out.items.map((a) => answerDto(c, a, direction === "received")),
      ),
    });
  });
  route(
    "POST",
    E + "/answers/:answerId/decision",
    async (c) => {
      mode(c, "question_reply");
      const b = z
        .discriminatedUnion("action", [
          z
            .object({
              action: z.literal("accept"),
              reply: z.string().trim().min(1).max(500),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
          z
            .object({
              action: z.literal("decline"),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
        ])
        .parse(c.request.body);
      const a = await one(
        c.db,
        "SELECT * FROM answers WHERE id=$1 AND owner_id=$2 AND event_id=$3 FOR UPDATE",
        [c.params.answerId, c.uid, c.event.id],
      );
      need(a);
      need(!(await blocked(c.db, c.event.id, c.uid, a.sender_id)));
      checkVersion(a.version, b.expectedVersion);
      need(a.status === "pending", 409, "ANSWER_NOT_PENDING");
      let r: Row | null = null;
      if (b.action === "accept") {
        r = await newRoom(
          c,
          a.owner_id,
          a.sender_id,
          "question_reply",
          a.id,
          a.alias,
        );
        await c.db.query(
          "INSERT INTO messages(id,conversation_id,sender_id,client_message_id,sequence,text) VALUES($1,$2,$3,$4,1,$5),($6,$2,$7,$8,2,$9)",
          [
            id("msg"),
            r.id,
            a.sender_id,
            "answer:" + a.id,
            a.text,
            id("msg"),
            a.owner_id,
            "reply:" + a.id,
            b.reply,
          ],
        );
      }
      const status = b.action === "accept" ? "accepted" : "declined";
      await c.db.query(
        "UPDATE answers SET status=$2,version=version+1,conversation_id=$3 WHERE id=$1",
        [a.id, status, r?.id ?? null],
      );
      for (const u of [a.owner_id, a.sender_id])
        await emit(
          c,
          u,
          "answer.status_changed",
          a.id,
          r?.id ?? null,
          a.version + 1,
        );
      return result({
        answerId: a.id,
        status,
        conversation: r
          ? await conversation(c.db, r, c.uid, c.revealCapabilities)
          : null,
      });
    },
    { phase: "discover", idempotent: true },
  );
}
