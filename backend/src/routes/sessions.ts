import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { one, transaction } from "../db.js";
import {
  hash,
  token,
  id,
  need,
  fail,
  result,
  envelope,
  authenticate,
  router,
} from "../http.js";
import { me } from "../dto.js";
import type { Config } from "../config.js";
export function sessions(
  app: FastifyInstance,
  pool: Pool,
  config: Config,
  revealReady = false,
) {
  const cookieName =
    config.mode === "real" ? "__Host-zkiss_session" : "zkiss_session";
  const route = router(app, pool, config);
  app.get("/api/v1/events/:eventId", async (req) => {
    const e = await one(pool, "SELECT * FROM events WHERE id=$1", [
      (req.params as { eventId: string }).eventId,
    ]);
    need(e);
    return envelope(
      {
        id: e.id,
        name: e.name,
        status: e.status,
        joinUntil: e.join_until,
        discoverUntil: e.discover_until,
        chatUntil: e.chat_until,
        connectionModes: e.modes,
        availableFilters: e.modes.includes("question_reply")
          ? ["all", "open_to_answers"]
          : ["all"],
        participantCount: (await one(
          pool,
          "SELECT count(*)::int AS n FROM participants WHERE event_id=$1 AND admission_status='active' AND profile_status='published'",
          [e.id],
        ))!.n,
        countUpdatedAt: new Date().toISOString(),
        policy: {
          minAge: 18,
          maxPhotoBytes: 5 * 1024 * 1024,
          freeChatSeconds: null,
        },
        features: {
          snsReveal: e.sns_reveal && revealReady,
          paidExtension: false,
        },
        policyVersion: e.policy_version,
        mode: config.mode,
      },
      req,
    );
  });
  app.post(
    "/api/v1/sessions",
    {
      config: {
        rateLimit: { max: config.sessionRateLimit, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const b = z
        .object({ eventId: z.string().min(1).max(200) })
        .strict()
        .parse(req.body);
      return transaction(pool, async (db) => {
        const e = await one(db, "SELECT * FROM events WHERE id=$1 FOR UPDATE", [
          b.eventId,
        ]);
        need(e);
        if (req.cookies[cookieName]) {
          const existing = await one(
            db,
            "SELECT p.*,s.csrf_token FROM sessions s JOIN participants p ON p.id=s.participant_id WHERE token_hash=$1 AND expires_at>now()",
            [hash(req.cookies[cookieName])],
          );
          if (existing) {
            if (existing.event_id !== b.eventId)
              fail(409, "EVENT_SESSION_CONFLICT");
            return envelope(me(existing, config), req);
          }
        }
        need(
          e.status === "open" && new Date(e.join_until).getTime() > Date.now(),
          409,
          "EVENT_CLOSED",
        );
        const participant = id("p"),
          secret = token(),
          csrf = token();
        const p = await one(
          db,
          "INSERT INTO participants(id,event_id) VALUES($1,$2) RETURNING *",
          [participant, b.eventId],
        );
        await db.query(
          "INSERT INTO sessions(token_hash,participant_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+($4*interval '1 hour'))",
          [hash(secret), participant, csrf, config.sessionHours],
        );
        reply.setCookie(cookieName, secret, {
          httpOnly: true,
          secure: config.mode === "real" || config.secureCookies,
          sameSite: "strict",
          path: "/",
          maxAge: config.sessionHours * 3600,
        });
        reply.code(201);
        return envelope(me({ ...p, csrf_token: csrf }, config), req);
      });
    },
  );
  route("GET", "/me", async (c) => result(me(c.p, config)), { active: false });
  route(
    "DELETE",
    "/sessions/current",
    async (c) => {
      await c.db.query("DELETE FROM sessions WHERE token_hash=$1", [
        c.p.token_hash,
      ]);
      c.reply.clearCookie(cookieName, {
        path: "/",
        secure: config.mode === "real" || config.secureCookies,
      });
      return result(null, 204);
    },
    { active: false },
  );
}
